using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jint;
using Jint.Native;

namespace ModelTrace.Desktop.Services;

/// <summary>一条挑战。</summary>
public sealed record Challenge(string Id, int ExpectedCount, string Prompt);

/// <summary>单份回答的解析诊断。</summary>
public sealed record OutputDiagnostic(int Index, int ParsedNumbers, int MinimumNumbers, bool Accepted);

/// <summary>单个模型的归因结果。</summary>
public sealed record ModelScore(
    string Model,
    string DisplayName,
    double Probability,
    double ProfileSimilarity,
    double Score,
    string Family,
    string FamilyName,
    double ConditionalProbability);

/// <summary>完整归因结果。</summary>
public sealed record AnalysisResult(
    string Prediction,
    string PredictionName,
    double Probability,
    int UsedOutputs,
    IReadOnlyList<ModelScore> Results,
    IReadOnlyList<OutputDiagnostic> Diagnostics,
    string FamilyPrediction,
    string FamilyPredictionName,
    double FamilyProbability,
    IReadOnlyList<(string DisplayName, double Probability)> FamilyProbabilities);

/// <summary>
/// 指纹评分引擎。
///
/// 关键设计：直接把现有的 static/fingerprint-core.js 交给 Jint 执行，而不是翻译成 C#。
/// 这样上游若调整评分算法或指纹库，客户端只需替换外部资产文件，
/// 无需同步修改 C# 代码并重新发版 —— 算法始终只有一份真相。
///
/// Jint 引擎是单线程的，所有调用通过 _gate 串行化。
/// </summary>
public sealed class FingerprintEngine : IDisposable
{
    private readonly AssetStore _store;
    private readonly Lock _gate = new();
    private Engine? _engine;
    private JsValue? _analyzeFn;
    private JsValue? _generateFn;
    private JsValue? _bank;

    public FingerprintEngine(AssetStore store) => _store = store;

    /// <summary>当前加载的指纹库概览。</summary>
    public int ModelCount { get; private set; }
    public string? BankBuiltAt { get; private set; }
    public string? BankMethod { get; private set; }
    public IReadOnlyList<string> ModelIds { get; private set; } = [];

    /// <summary>加载或重新加载引擎。替换指纹库后调用即可生效，无需重启进程。</summary>
    public void Reload()
    {
        lock (_gate)
        {
            DisposeEngine();

            var engine = new Engine(options => options
                .TimeoutInterval(TimeSpan.FromSeconds(30))
                // 评分是确定性数值计算，关闭严格模式与浏览器一致
                .Strict(false));

            InstallCryptoShim(engine);

            // 用模块方式加载，保留原文件的 export 语义，避免正则改写源码
            engine.Modules.Add("fingerprint-core", _store.ReadScorerJs());
            engine.Modules.Add("challenge-browser", _store.ReadChallengeJs());

            var scorer = engine.Modules.Import("fingerprint-core");
            var challenges = engine.Modules.Import("challenge-browser");

            // 指纹库在 JS 侧解析成对象，供评分函数直接使用
            engine.SetValue("__bankJson", _store.ReadBankJson());
            var bank = engine.Evaluate("JSON.parse(__bankJson)");

            _analyzeFn = scorer.Get("analyzeGlobalOutputs");
            _generateFn = challenges.Get("generateChallenges");
            _bank = bank;
            _engine = engine;

            RefreshBankInfo(engine, bank);
        }
    }

    /// <summary>生成 count 条挑战。</summary>
    public IReadOnlyList<Challenge> GenerateChallenges(int count = 3)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var raw = _generateFn!.Call(count).AsArray();
            var list = new List<Challenge>();
            foreach (var item in raw)
            {
                list.Add(new Challenge(
                    item.Get("id").AsString(),
                    (int)item.Get("expected_count").AsNumber(),
                    item.Get("prompt").AsString()));
            }
            return list;
        }
    }

    /// <summary>对若干份回答做归因评分。outputs 中每项是 (expectedCount, text)。</summary>
    public AnalysisResult Analyze(IReadOnlyList<(int ExpectedCount, string Text)> outputs)
    {
        lock (_gate)
        {
            EnsureLoaded();

            var payload = JsonSerializer.Serialize(outputs.Select(o => new
            {
                expected_count = o.ExpectedCount,
                text = o.Text,
            }));

            _engine!.SetValue("__outputsJson", payload);
            var outputsJs = _engine.Evaluate("JSON.parse(__outputsJson)");

            JsValue result;
            try
            {
                result = _analyzeFn!.Call(outputsJs, _bank!);
            }
            catch (Jint.Runtime.JavaScriptException error)
            {
                // 例如「没有可用回答」这类业务校验，原样把中文提示带回界面
                throw new InvalidOperationException(error.Message, error);
            }

            _engine.SetValue("__result", result);
            var json = _engine.Evaluate("JSON.stringify(__result)").AsString()!;
            return ParseResult(json);
        }
    }

    private static AnalysisResult ParseResult(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        var results = new List<ModelScore>();
        foreach (var item in root.GetProperty("results").EnumerateArray())
        {
            results.Add(new ModelScore(
                item.GetProperty("model").GetString()!,
                item.GetProperty("display_name").GetString()!,
                item.GetProperty("probability").GetDouble(),
                item.GetProperty("profile_similarity").GetDouble(),
                item.GetProperty("score").GetDouble(),
                item.GetProperty("family").GetString()!,
                item.GetProperty("family_name").GetString()!,
                item.GetProperty("conditional_probability").GetDouble()));
        }

        var diagnostics = new List<OutputDiagnostic>();
        foreach (var item in root.GetProperty("diagnostics").EnumerateArray())
        {
            diagnostics.Add(new OutputDiagnostic(
                item.GetProperty("index").GetInt32(),
                item.GetProperty("parsed_numbers").GetInt32(),
                item.GetProperty("minimum_numbers").GetInt32(),
                item.GetProperty("accepted").GetBoolean()));
        }

        var families = new List<(string, double)>();
        foreach (var item in root.GetProperty("family_probabilities").EnumerateArray())
        {
            families.Add((item.GetProperty("display_name").GetString()!,
                item.GetProperty("probability").GetDouble()));
        }

        return new AnalysisResult(
            root.GetProperty("prediction").GetString()!,
            root.GetProperty("prediction_name").GetString()!,
            root.GetProperty("probability").GetDouble(),
            root.GetProperty("used_outputs").GetInt32(),
            results,
            diagnostics,
            root.GetProperty("family_prediction").GetString()!,
            root.GetProperty("family_prediction_name").GetString()!,
            root.GetProperty("family_probability").GetDouble(),
            families);
    }

    private void RefreshBankInfo(Engine engine, JsValue bank)
    {
        engine.SetValue("__bank", bank);
        var meta = engine.Evaluate("""
            JSON.stringify({
              count: __bank.models.length,
              built_at: __bank.built_at || null,
              method: (__bank.method && __bank.method.name) || null,
              ids: __bank.models.map(m => m.id),
            })
        """).AsString()!;

        using var document = JsonDocument.Parse(meta);
        var root = document.RootElement;
        ModelCount = root.GetProperty("count").GetInt32();
        BankBuiltAt = root.GetProperty("built_at").ValueKind == JsonValueKind.Null
            ? null : root.GetProperty("built_at").GetString();
        BankMethod = root.GetProperty("method").ValueKind == JsonValueKind.Null
            ? null : root.GetProperty("method").GetString();
        ModelIds = root.GetProperty("ids").EnumerateArray().Select(x => x.GetString()!).ToArray();
    }

    /// <summary>
    /// 注入 Web Crypto 垫片。
    /// Jint 是纯 JS 解释器，不提供任何宿主 API，而 challenge-browser.js
    /// 依赖 crypto.getRandomValues 与 crypto.randomUUID。
    /// 类型细节交给 JS 处理，C# 只提供随机数原语，避免在托管侧猜元素位宽。
    /// </summary>
    private static void InstallCryptoShim(Engine engine)
    {
        engine.SetValue("__randomUint32", new Func<double>(() =>
        {
            Span<byte> bytes = stackalloc byte[4];
            RandomNumberGenerator.Fill(bytes);
            return BitConverter.ToUInt32(bytes);
        }));

        engine.SetValue("__randomUuid", new Func<string>(() =>
        {
            Span<byte> bytes = stackalloc byte[16];
            RandomNumberGenerator.Fill(bytes);
            bytes[6] = (byte)((bytes[6] & 0x0F) | 0x40);   // 版本位 v4
            bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);   // 变体位 10xx
            return new Guid(bytes, bigEndian: true).ToString().ToLowerInvariant();
        }));

        engine.Execute("""
            globalThis.crypto = {
              getRandomValues(array) {
                if (!ArrayBuffer.isView(array)) {
                  throw new TypeError('crypto.getRandomValues 需要一个 TypedArray');
                }
                for (let i = 0; i < array.length; i += 1) array[i] = __randomUint32();
                return array;
              },
              randomUUID() { return __randomUuid(); },
            };
        """);
    }

    private void EnsureLoaded()
    {
        if (_engine is null) throw new InvalidOperationException("指纹引擎尚未加载");
    }

    private void DisposeEngine()
    {
        _engine?.Dispose();
        _engine = null;
        _analyzeFn = null;
        _generateFn = null;
        _bank = null;
    }

    public void Dispose()
    {
        lock (_gate) DisposeEngine();
        GC.SuppressFinalize(this);
    }
}
