using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ModelTrace.Desktop.Services;

/// <summary>一次更新检查的结果。</summary>
public sealed record UpdateCheckResult(
    bool HasUpdate,
    string? RemoteBankBuiltAt,
    string? LocalBankBuiltAt,
    string Message);

/// <summary>
/// 指纹库更新器：从上游仓库直接拉取最新的指纹库与评分器。
///
/// 设计取舍：默认通道指向**上游原仓库**，而不是本仓库的 fork。
/// 理由是上游才是指纹数据的唯一来源；指向 fork 会多一层中转和延迟，
/// 且 fork 若长时间未同步，客户端就会一直拉到旧库。
///
/// 上游仓库没有 manifest.json，只有固定路径的两个文件：
///     data/unified_bank.json     指纹库
///     static/fingerprint-core.js 评分器
/// 因此这里不依赖清单文件：指纹库用 built_at 字段比对新旧，
/// 评分器用 SHA-256 比对（算法变化时提醒升级程序，而不是静默替换）。
/// </summary>
public sealed class AssetUpdater
{
    private readonly AssetStore _store;
    private readonly HttpClient _http;

    /// <summary>上游仓库默认地址。</summary>
    public const string DefaultUpstream =
        "https://raw.githubusercontent.com/xqy2006/ModelTrace/main";

    public AssetUpdater(AssetStore store)
    {
        _store = store;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "ModelTrace-Desktop");
    }

    /// <summary>更新通道基地址；默认指向上游原仓库。</summary>
    public string ChannelUrl { get; set; } = DefaultUpstream;

    /// <summary>
    /// 解析某个资产的下载地址。
    /// 优先使用清单里声明的路径（若该通道提供 manifest.json），
    /// 否则回落到上游的固定相对路径，从而同时兼容两种通道布局。
    /// </summary>
    private string ResolveUrl(JsonObject? manifest, string manifestKey, string upstreamRelativePath)
    {
        var declared = manifest?[manifestKey]?.GetValue<string>();
        if (!string.IsNullOrWhiteSpace(declared))
        {
            // 绝对地址直接用，相对路径基于通道基地址解析
            return Uri.TryCreate(declared, UriKind.Absolute, out _)
                ? declared
                : $"{ChannelUrl.TrimEnd('/')}/{declared.TrimStart('.', '/')}";
        }
        return $"{ChannelUrl.TrimEnd('/')}/{upstreamRelativePath}";
    }

    /// <summary>
    /// 检查并可选地应用更新。
    /// 校验策略：指纹库先解析确认结构合法再落盘，评分器变化只提示不静默替换。
    /// </summary>
    public async Task<UpdateCheckResult> CheckAndApplyAsync(
        bool apply, CancellationToken cancellation = default)
    {
        if (string.IsNullOrWhiteSpace(ChannelUrl))
            return new UpdateCheckResult(false, null, null, "未设置更新通道，跳过检查。");

        var local = _store.ComputeManifest();

        // 清单是可选的：上游没有，本仓库发布的 dist 有
        var manifest = await TryFetchManifestAsync(cancellation).ConfigureAwait(false);
        var usingManifest = manifest is not null;

        var bankUrl = ResolveUrl(manifest, "bank_url", "data/unified_bank.json");
        var scorerUrl = ResolveUrl(manifest, "scorer_url", "static/fingerprint-core.js");

        // ── 先看评分器有没有变 ──
        // 算法变化会影响结果可比性，不应静默替换，交由用户升级程序。
        try
        {
            var remoteScorer = await _http.GetStringAsync(scorerUrl, cancellation).ConfigureAwait(false);
            var remoteScorerSha = AssetStore.Sha256OfCanonical(remoteScorer);
            if (remoteScorerSha != local.ScorerSha256)
            {
                return new UpdateCheckResult(false, null, local.BankBuiltAt,
                    "评分算法有变化，为保证结果可比，请更新客户端程序本身（指纹库仍可单独更新）。");
            }
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            return new UpdateCheckResult(false, null, local.BankBuiltAt,
                $"无法读取上游评分器：{error.Message}");
        }

        // ── 再取指纹库 ──
        string remoteBankJson;
        try
        {
            remoteBankJson = await _http.GetStringAsync(bankUrl, cancellation).ConfigureAwait(false);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            return new UpdateCheckResult(false, null, local.BankBuiltAt,
                $"无法读取上游指纹库：{error.Message}");
        }

        // 结构校验：缺 models 数组说明拉到的不是指纹库（可能是错误页）
        string? remoteBuiltAt;
        int remoteModelCount;
        try
        {
            using var document = JsonDocument.Parse(remoteBankJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("models", out var models) ||
                models.ValueKind != JsonValueKind.Array)
            {
                return new UpdateCheckResult(false, null, local.BankBuiltAt,
                    "上游返回的内容不是有效的指纹库（缺少 models 数组）。");
            }
            remoteModelCount = models.GetArrayLength();
            remoteBuiltAt = root.TryGetProperty("built_at", out var built) ? built.GetString() : null;
        }
        catch (JsonException)
        {
            return new UpdateCheckResult(false, null, local.BankBuiltAt,
                "上游返回的指纹库不是合法 JSON。");
        }

        // 新旧判定：有清单时以 SHA 为准（最可靠）；否则比对 built_at。
        // 上游没有清单，因此 built_at 是主判据。
        var remoteSha = AssetStore.Sha256OfCanonical(remoteBankJson);
        var isNewer = usingManifest
            ? IsManifestNewer(manifest!, remoteSha)
            : IsBuiltAtNewer(remoteBuiltAt, local.BankBuiltAt);

        if (!isNewer)
        {
            return new UpdateCheckResult(false, remoteBuiltAt, local.BankBuiltAt,
                $"指纹库已是最新（{local.ModelCount} 个模型，构建于 {FormatTime(local.BankBuiltAt)}）。");
        }

        var description = $"上游 {remoteModelCount} 个模型，构建于 {FormatTime(remoteBuiltAt)}" +
                          $"；本地 {local.ModelCount} 个，构建于 {FormatTime(local.BankBuiltAt)}。";

        if (!apply)
            return new UpdateCheckResult(true, remoteBuiltAt, local.BankBuiltAt, $"发现新的指纹库：{description}");

        try
        {
            _store.ReplaceBank(remoteBankJson);
            _store.WriteManifest(_store.ComputeManifest());
        }
        catch (Exception error) when (error is IOException or InvalidDataException or JsonException)
        {
            return new UpdateCheckResult(true, remoteBuiltAt, local.BankBuiltAt,
                $"写入新指纹库失败：{error.Message}");
        }

        return new UpdateCheckResult(true, remoteBuiltAt, local.BankBuiltAt,
            $"指纹库已更新：{description}");
    }

    /// <summary>读取通道根目录的 manifest.json；不存在时返回 null（上游就没有）。</summary>
    private async Task<JsonObject?> TryFetchManifestAsync(CancellationToken cancellation)
    {
        try
        {
            var raw = await _http.GetStringAsync(
                $"{ChannelUrl.TrimEnd('/')}/manifest.json", cancellation).ConfigureAwait(false);
            return JsonNode.Parse(raw)?.AsObject();
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException)
        {
            // 没有清单是正常情况（上游即如此），不视为错误
            return null;
        }
    }

    private static bool IsManifestNewer(JsonObject manifest, string remoteSha)
    {
        var declared = manifest["bank_sha256"]?.GetValue<string>();
        return !string.IsNullOrEmpty(declared) &&
               !string.Equals(declared, remoteSha, StringComparison.OrdinalIgnoreCase)
            ? true
            : false;
    }

    /// <summary>
    /// 用 built_at 判断新旧。时间串无法解析时保守地视为「有更新」，
    /// 让用户有机会手动更新，而不是因为格式异常就永远拉不到新库。
    /// </summary>
    private static bool IsBuiltAtNewer(string? remoteBuiltAt, string? localBuiltAt)
    {
        if (string.IsNullOrWhiteSpace(remoteBuiltAt)) return false;
        if (string.IsNullOrWhiteSpace(localBuiltAt)) return true;

        if (DateTimeOffset.TryParse(remoteBuiltAt, out var remote) &&
            DateTimeOffset.TryParse(localBuiltAt, out var localDate))
        {
            return remote > localDate;
        }
        // 解析失败：内容不同即视为需要更新
        return !string.Equals(remoteBuiltAt, localBuiltAt, StringComparison.Ordinal);
    }

    private static string FormatTime(string? value) =>
        string.IsNullOrWhiteSpace(value) ? "未知时间" : value;
}
