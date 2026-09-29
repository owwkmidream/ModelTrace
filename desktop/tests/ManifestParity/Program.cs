using System.IO;
using ModelTrace.Desktop.Services;

// 端到端一致性验证：确认 C# 与 make-manifest.mjs 对同一份资产算出相同的 SHA-256。
// 这是「指纹库热更新」能否工作的关键——若两端换行归一化规则不一致，
// 客户端会把「无变化」永远误判为「有更新」，反复下载同一个文件。

var manifestPath = args.Length > 0
    ? args[0]
    : Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "dist", "manifest.json");

manifestPath = Path.GetFullPath(manifestPath);
Console.WriteLine($"读取 manifest: {manifestPath}");

if (!File.Exists(manifestPath))
{
    Console.Error.WriteLine("找不到 manifest.json，请先运行 node desktop/make-manifest.mjs desktop/dist");
    return 1;
}

var manifestJson = File.ReadAllText(manifestPath);
using var document = System.Text.Json.JsonDocument.Parse(manifestJson);
var root = document.RootElement;
var expectedBank = root.GetProperty("bank_sha256").GetString()!;
var expectedScorer = root.GetProperty("scorer_sha256").GetString()!;

// 用 JS 生成的同一批资产作为待校验输入
var distDir = Path.GetDirectoryName(manifestPath)!;
var assets = new AssetStore(distDir);
var actual = assets.ComputeManifest();

Console.WriteLine();
Console.WriteLine($"指纹库   JS={expectedBank}");
Console.WriteLine($"         C#={actual.BankSha256}");
Console.WriteLine($"         结果：{(actual.BankSha256 == expectedBank ? "一致 ✓" : "不一致 ✗")}");
Console.WriteLine();
Console.WriteLine($"评分器   JS={expectedScorer}");
Console.WriteLine($"         C#={actual.ScorerSha256}");
Console.WriteLine($"         结果：{(actual.ScorerSha256 == expectedScorer ? "一致 ✓" : "不一致 ✗")}");
Console.WriteLine();
Console.WriteLine($"指纹库模型数：{actual.ModelCount}（manifest 声明 {root.GetProperty("model_count").GetInt32()}）");

var ok = actual.BankSha256 == expectedBank
         && actual.ScorerSha256 == expectedScorer
         && actual.ModelCount == root.GetProperty("model_count").GetInt32();

Console.WriteLine();
Console.WriteLine(ok ? "一致性验证通过：C# 与 JS 的资产指纹一致，热更新可用。" : "一致性验证失败！");
return ok ? 0 : 1;
