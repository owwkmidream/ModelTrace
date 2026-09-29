using System.Security.Cryptography;
using System.Text;
using Jint;
using Jint.Native;
using Jint.Native.Array;

// 冒烟验证：确认 Jint 能直接执行现有的 fingerprint-core.js。
// 重点验证三处风险：
//   1. /\p{L}/u 这类 Unicode 属性转义正则
//   2. String.prototype.matchAll
//   3. analyzeGlobalOutputs 端到端评分
// 任一处不通，就需要退回「C# 重写 parseNumbers」的退路。

var repo = FindRepoRoot();
Console.WriteLine($"仓库根目录: {repo}");

var staticDir = Path.Combine(repo, "static");
var bankPath = Path.Combine(repo, "data", "unified_bank.json");
if (!File.Exists(Path.Combine(staticDir, "fingerprint-core.js")))
    throw new FileNotFoundException("找不到 fingerprint-core.js", staticDir);

var engine = new Engine(options => options
    .EnableModules(staticDir)
    .Strict(false));

// ── 风险点 1 & 2：直接调用 parseNumbers，观察 \p{L} 与 matchAll ──
var fp = engine.Modules.Import("./fingerprint-core.js");
var parseNumbers = fp.Get("parseNumbers");

// 关键判据：字母 alpha 前后的数字必须被切成两段，再取较长的一段。
// 若 /\p{L}/u 不被支持，分隔符不会被识别为“字母”，整串会保留为一段，
// 结果就会是长度 5 的 [10,20,30,40,50] 而不是长度 3 的 [10,20,30]。
var direct = parseNumbers.Call("10 20 30 alpha 40 50");
var directList = direct.AsArray().Select(v => v.AsNumber()).ToArray();
Console.WriteLine($"[风险点 1/2] parseNumbers 结果 = [{string.Join(", ", directList)}]");

var expected = new double[] { 10, 20, 30 };
if (!directList.SequenceEqual(expected))
    throw new InvalidOperationException(
        $"Unicode 属性转义或 matchAll 行为不一致：期望 [{string.Join(",", expected)}]，实际 [{string.Join(",", directList)}]");

// 再验一次“取最长段”，排除上例只是碰巧
var pickLongest = parseNumbers.Call("1 2 alpha 10 20 30 alpha 7").AsArray().Select(v => v.AsNumber()).ToArray();
if (!pickLongest.SequenceEqual(new double[] { 10, 20, 30 }))
    throw new InvalidOperationException($"未取最长数字段：实际 [{string.Join(",", pickLongest)}]");

Console.WriteLine("          ✓ Unicode 属性转义（\\p{L}）与 matchAll 均正常，且切段取最长语义正确");

// ── 风险点 3：端到端评分 ──
var bankJson = File.ReadAllText(bankPath, Encoding.UTF8);
engine.SetValue("__bankJson", bankJson);
var bank = engine.Evaluate("JSON.parse(__bankJson)");

// 用确定性随机数造三份合法回答，避免每次结果漂移
var random = new Random(20240927);
var outputs = new List<object>();
for (var i = 0; i < 3; i++)
{
    const int count = 300;
    var numbers = new int[count];
    for (var j = 0; j < count; j++) numbers[j] = random.Next(1, 356);
    outputs.Add(new
    {
        expected_count = count,
        text = string.Join(" ", numbers),
    });
}

var outputsJson = System.Text.Json.JsonSerializer.Serialize(outputs);
engine.SetValue("__outputsJson", outputsJson);
var outputsJs = engine.Evaluate("JSON.parse(__outputsJson)");

var analyze = fp.Get("analyzeGlobalOutputs");
var result = analyze.Call(outputsJs, bank);
engine.SetValue("__result", result);
var resultJson = engine.Evaluate("JSON.stringify(__result, null, 2)").AsString();

Console.WriteLine();
Console.WriteLine("[风险点 3] analyzeGlobalOutputs 输出：");
Console.WriteLine(resultJson);
Console.WriteLine();
Console.WriteLine("冒烟验证通过：Jint 可以直接执行 fingerprint-core.js，无需移植到 C#。");

static string FindRepoRoot()
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        if (File.Exists(Path.Combine(dir.FullName, "static", "fingerprint-core.js")))
            return dir.FullName;
        dir = dir.Parent;
    }
    throw new DirectoryNotFoundException("向上查找未找到包含 static/fingerprint-core.js 的仓库根目录");
}
