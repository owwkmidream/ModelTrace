using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ModelTrace.Desktop.Services;

/// <summary>单个外部资产的元信息。</summary>
public sealed record AssetInfo(string Name, string Sha256, long Size, string? Version);

/// <summary>外部资产目录清单，用于指纹库热更新时的版本比对。</summary>
public sealed record AssetManifest(string BankSha256, string ScorerSha256, string? BankBuiltAt, int ModelCount);

/// <summary>
/// 资产仓库：负责定位、落盘与读取「指纹库 + 评分器」这两类可热更新资产。
///
/// 设计要点：这些资产刻意放在 exe 同级的 assets/ 目录，而不是编进程序集。
/// 上游更新指纹库时，客户端只需替换 assets/unified_bank.json，
/// 无需重新编译或重新分发 exe —— 这是本项目对「指纹库持续更新」的核心诉求。
/// 程序集内也内嵌了一份首发版本，仅在外部文件缺失时用于初始化。
/// </summary>
public sealed class AssetStore
{
    private const string BankName = "unified_bank.json";
    private const string ScorerName = "fingerprint-core.js";
    private const string ChallengeName = "challenge-browser.js";

    private readonly string _assetDir;
    private readonly IReadOnlyDictionary<string, string> _embedded;

    public AssetStore(string? assetDir = null)
    {
        _assetDir = assetDir ?? Path.Combine(AppContext.BaseDirectory, "assets");
        _embedded = new Dictionary<string, string>
        {
            [BankName] = "ModelTrace.assets.unified_bank.json",
            [ScorerName] = "ModelTrace.assets.fingerprint-core.js",
            [ChallengeName] = "ModelTrace.assets.challenge-browser.js",
        };
    }

    public string AssetDirectory => _assetDir;
    public string BankPath => Path.Combine(_assetDir, BankName);
    public string ScorerPath => Path.Combine(_assetDir, ScorerName);
    public string ChallengePath => Path.Combine(_assetDir, ChallengeName);

    /// <summary>
    /// 确保外部资产存在。首次运行或用户误删时，用内嵌版本铺开一份。
    /// 已存在的文件不覆盖，避免把用户后续热更新的结果冲掉。
    /// </summary>
    public void EnsureInitialized()
    {
        Directory.CreateDirectory(_assetDir);
        foreach (var (name, logicalName) in _embedded)
        {
            var target = Path.Combine(_assetDir, name);
            if (File.Exists(target)) continue;
            WriteEmbedded(logicalName, target);
        }
    }

    /// <summary>读取评分器与挑战生成器的 JS 源码。</summary>
    public string ReadScorerJs() => File.ReadAllText(ScorerPath);
    public string ReadChallengeJs() => File.ReadAllText(ChallengePath);
    public string ReadBankJson() => File.ReadAllText(BankPath);

    /// <summary>
    /// 计算当前外部资产的指纹，用于与远端 manifest 比对。
    /// 关键：先把换行统一为 LF 再算 SHA-256。
    /// Windows 检出与 Linux CI 产出的同一份文件，原始字节可能只差换行符，
    /// 若不归一化会让客户端把「无变化」误判为「有更新」，反复下载同一份指纹库。
    /// 该规则与 desktop/make-manifest.mjs 的 canonicalize 必须保持一致。
    /// </summary>
    public AssetManifest ComputeManifest()
    {
        var bankJson = ReadBankJson();
        using var document = JsonDocument.Parse(bankJson);
        var root = document.RootElement;

        var modelCount = root.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Array
            ? models.GetArrayLength()
            : 0;
        var builtAt = root.TryGetProperty("built_at", out var built) ? built.GetString() : null;

        return new AssetManifest(
            Sha256OfCanonical(File.ReadAllText(BankPath)),
            Sha256OfCanonical(File.ReadAllText(ScorerPath)),
            builtAt,
            modelCount);
    }

    /// <summary>用新的指纹库替换本地文件。写入前先备份，便于回滚。</summary>
    public void ReplaceBank(string json)
    {
        // 校验是合法 JSON 且形状正确，避免把半截内容写进去导致程序无法启动
        using (var document = JsonDocument.Parse(json))
        {
            if (!document.RootElement.TryGetProperty("models", out var models) ||
                models.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("新的指纹库缺少 models 数组，拒绝写入");
            }
        }

        if (File.Exists(BankPath))
        {
            var backup = BankPath + ".bak";
            File.Copy(BankPath, backup, overwrite: true);
        }
        // 先用临时文件写全再原子替换，避免写入中断留下损坏的指纹库
        var temp = BankPath + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, BankPath, overwrite: true);
    }

    /// <summary>把给定的模型清单写入 manifest.json，供客户端记录当前资产版本。</summary>
    public void WriteManifest(AssetManifest manifest)
    {
        var node = new JsonObject
        {
            ["bank_sha256"] = manifest.BankSha256,
            ["scorer_sha256"] = manifest.ScorerSha256,
            ["bank_built_at"] = manifest.BankBuiltAt,
            ["model_count"] = manifest.ModelCount,
            ["updated_at"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        File.WriteAllText(
            Path.Combine(_assetDir, "manifest.json"),
            node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    /// <summary>把换行统一为 LF 后计算 SHA-256，理由见 ComputeManifest。</summary>
    public static string Sha256OfCanonical(string text)
    {
        var normalized = text.Replace("\r\n", "\n");
        return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(normalized)))
            .ToLowerInvariant();
    }

    private static void WriteEmbedded(string logicalName, string target)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(logicalName)
            ?? throw new InvalidOperationException($"内嵌资源缺失：{logicalName}");
        using var output = File.Create(target);
        stream.CopyTo(output);
    }
}
