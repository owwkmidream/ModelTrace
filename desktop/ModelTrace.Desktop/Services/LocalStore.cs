using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ModelTrace.Desktop.Services;

/// <summary>一条已保存的连接配置（Base URL + API Key）。</summary>
public sealed record SavedConfig(string Id, string Name, string BaseUrl, string ApiKey, string CreatedAt)
{
    /// <summary>界面展示用：隐去 Key 中段。</summary>
    public string MaskedKey => ApiKey.Length <= 8
        ? new string('*', ApiKey.Length)
        : $"{ApiKey[..4]}{new string('*', Math.Max(4, ApiKey.Length - 8))}{ApiKey[^4..]}";
}

/// <summary>一条历史记录。</summary>
public sealed record HistoryEntry(
    string Id,
    string StartedAt,
    string Mode,
    string BaseUrl,
    string RequestedModel,
    string? PredictedModel,
    string? PredictedName,
    double? Probability,
    int UsedOutputs,
    string? Status,
    string? Note,
    IReadOnlyList<HistoryResponse> Responses);

public sealed record HistoryResponse(string ApiFormat, int Attempt, int Status, bool Ok, string Body);

/// <summary>
/// 本地存储：配置与历史。
/// 对应原网页版的 localStorage，改为落到 %APPDATA%/ModelTrace 下的 JSON 文件，
/// 存在性与可备份性都强于浏览器存储。
/// </summary>
public sealed class LocalStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly string _dir;
    private readonly Lock _gate = new();

    public LocalStore()
    {
        _dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ModelTrace");
        Directory.CreateDirectory(_dir);
    }

    public string DirectoryPath => _dir;
    private string ConfigPath => Path.Combine(_dir, "configs.json");
    private string HistoryPath => Path.Combine(_dir, "history.json");

    // ── 配置 ──

    public IReadOnlyList<SavedConfig> LoadConfigs()
    {
        lock (_gate) return ReadList<SavedConfig>(ConfigPath);
    }

    /// <summary>保存配置，同名则覆盖（与原网页版语义一致）。</summary>
    public IReadOnlyList<SavedConfig> SaveConfig(string name, string baseUrl, string apiKey)
    {
        lock (_gate)
        {
            var list = ReadList<SavedConfig>(ConfigPath).ToList();
            list.RemoveAll(item => string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase));
            list.Insert(0, new SavedConfig(
                Guid.NewGuid().ToString("n"), name, baseUrl, apiKey,
                DateTimeOffset.Now.ToString("O")));
            WriteList(ConfigPath, list);
            return list;
        }
    }

    public IReadOnlyList<SavedConfig> DeleteConfig(string id)
    {
        lock (_gate)
        {
            var list = ReadList<SavedConfig>(ConfigPath).ToList();
            list.RemoveAll(item => item.Id == id);
            WriteList(ConfigPath, list);
            return list;
        }
    }

    // ── 历史记录 ──

    private const int HistoryLimit = 200;

    public IReadOnlyList<HistoryEntry> LoadHistory()
    {
        lock (_gate) return ReadList<HistoryEntry>(HistoryPath);
    }

    public IReadOnlyList<HistoryEntry> AppendHistory(HistoryEntry entry)
    {
        lock (_gate)
        {
            var list = ReadList<HistoryEntry>(HistoryPath).ToList();
            list.Insert(0, entry);
            // 与原网页版一致：只保留最近 200 条
            if (list.Count > HistoryLimit) list.RemoveRange(HistoryLimit, list.Count - HistoryLimit);
            WriteList(HistoryPath, list);
            return list;
        }
    }

    public IReadOnlyList<HistoryEntry> ClearHistory()
    {
        lock (_gate)
        {
            WriteList<HistoryEntry>(HistoryPath, []);
            return [];
        }
    }

    // ── 从网页版迁移 ──

    /// <summary>导入结果，用于向用户交代到底进来了多少条。</summary>
    public sealed record ImportResult(int ConfigCount, int HistoryCount, string? Source);

    /// <summary>
    /// 导入网页版导出文件（由 desktop/tools/export-web-console.js 生成）。
    ///
    /// 合并语义：配置按「名称」去重、历史按「Id」去重，避免重复导入同一份文件
    /// 造成条目翻倍。已存在的条目保留本地版本，不覆盖用户后来的修改。
    /// </summary>
    public ImportResult ImportFromWebExport(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        if (!root.TryGetProperty("schema", out var schema) ||
            !schema.GetString()!.StartsWith("modeltrace-web-export", StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                "这不是网页版导出文件（缺少 schema 标识）。请用 desktop/tools/export-web-console.js 导出。");
        }

        var source = root.TryGetProperty("source", out var sourceNode) ? sourceNode.GetString() : null;

        // 导出文件的字段名与桌面版一致（脚本已转换），因此可直接反序列化。
        // 注意 Deserialize<T> 返回的是 List<T>，所以 T 传元素类型而不是列表类型。
        var incomingConfigs = root.TryGetProperty("configs", out var configsNode)
            ? Deserialize<SavedConfig>(configsNode)
            : [];
        var incomingHistory = root.TryGetProperty("history", out var historyNode)
            ? Deserialize<HistoryEntry>(historyNode)
            : [];

        lock (_gate)
        {
            var configList = ReadList<SavedConfig>(ConfigPath).ToList();
            var existingNames = configList.Select(item => item.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var addedConfigs = 0;
            foreach (var item in incomingConfigs)
            {
                if (string.IsNullOrWhiteSpace(item.Name) || !existingNames.Add(item.Name)) continue;
                configList.Add(item);
                addedConfigs += 1;
            }
            WriteList(ConfigPath, configList);

            var historyList = ReadList<HistoryEntry>(HistoryPath).ToList();
            var existingIds = historyList.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
            var addedHistory = 0;
            foreach (var item in incomingHistory)
            {
                if (string.IsNullOrWhiteSpace(item.Id) || !existingIds.Add(item.Id)) continue;
                historyList.Add(item);
                addedHistory += 1;
            }
            // 与网页版一致的条数上限，导入后同样裁剪
            historyList = historyList
                .OrderByDescending(item => item.StartedAt, StringComparer.Ordinal)
                .Take(HistoryLimit)
                .ToList();
            WriteList(HistoryPath, historyList);

            return new ImportResult(addedConfigs, addedHistory, source);
        }
    }

    /// <summary>把已解析的 JSON 元素反序列化成目标类型，供导入复用同一套命名策略。</summary>
    private static List<T> Deserialize<T>(JsonElement element) =>
        element.Deserialize<List<T>>(Options) ?? [];

    // ── 通用读写 ──

    private static List<T> ReadList<T>(string path)
    {
        if (!File.Exists(path)) return [];
        try
        {
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<List<T>>(json, Options) ?? [];
        }
        catch (JsonException)
        {
            // 存储文件损坏时返回空集合，而不是让程序无法启动
            return [];
        }
        catch (IOException)
        {
            return [];
        }
    }

    private static void WriteList<T>(string path, List<T> list) =>
        File.WriteAllText(path, JsonSerializer.Serialize(list, Options));
}
