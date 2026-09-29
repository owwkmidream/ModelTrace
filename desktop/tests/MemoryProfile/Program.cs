using System.Diagnostics;
using System.Text;
using Jint;

// 内存分解测量：区分「Jint + 指纹库」与「.NET 运行时基线」各占多少。
// 目的是给「客户端内存占用」一个可信的数字，而不是靠猜。

var workingSetStart = Process.GetCurrentProcess().WorkingSet64;
Console.WriteLine($"① 进程刚启动           : {Mb(workingSetStart)}");

// 加载脚本（不解析指纹库）
var repo = FindRepoRoot();
var staticDir = Path.Combine(repo, "static");
var engine = new Engine(options => options.EnableModules(staticDir).Strict(false));

engine.SetValue("__randomUint32", new Func<double>(() => 0));
engine.SetValue("__randomUuid", new Func<string>(() => Guid.NewGuid().ToString()));
engine.Execute("""
    globalThis.crypto = {
      getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = __randomUint32(); return a; },
      randomUUID() { return __randomUuid(); },
    };
""");
engine.Modules.Add("fp", File.ReadAllText(Path.Combine(staticDir, "fingerprint-core.js")));
engine.Modules.Add("ch", File.ReadAllText(Path.Combine(staticDir, "challenge-browser.js")));
engine.Modules.Import("fp");
engine.Modules.Import("ch");
var afterScripts = Process.GetCurrentProcess().WorkingSet64;
Console.WriteLine($"② 加载 JS 脚本后        : {Mb(afterScripts)}  (增加 {Mb(afterScripts - workingSetStart)})");

// 解析指纹库
var bankPath = Path.Combine(repo, "data", "unified_bank.json");
var bankJson = File.ReadAllText(bankPath, Encoding.UTF8);
Console.WriteLine($"   指纹库 JSON 体积      : {bankJson.Length / 1024.0:0.0} KB");
engine.SetValue("__bankJson", bankJson);
engine.Evaluate("globalThis.__bank = JSON.parse(__bankJson)");
var afterBank = Process.GetCurrentProcess().WorkingSet64;
Console.WriteLine($"③ 解析指纹库后          : {Mb(afterBank)}  (增加 {Mb(afterBank - afterScripts)})");

// 统计指纹库里的数值总量，用于解释内存去向
var numbers = engine.Evaluate("""
    (() => {
      let total = 0, arrays = 0;
      const walk = (v) => {
        if (Array.isArray(v)) { arrays++; total += v.length; v.forEach(walk); }
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(__bank);
      return { numbers: total, arrays };
    })()
""");
Console.WriteLine($"   指纹库内数值元素总数  : {numbers.Get("numbers").AsNumber():N0} 个（数组 {numbers.Get("arrays").AsNumber():N0} 个）");

// 跑一次评分
var analyze = engine.Modules.Import("fp").Get("analyzeGlobalOutputs");
var random = new Random(7);
var outputs = new List<object>();
for (var i = 0; i < 3; i++)
{
    var nums = Enumerable.Range(0, 300).Select(_ => random.Next(1, 356));
    outputs.Add(new { expected_count = 300, text = string.Join(" ", nums) });
}
engine.SetValue("__o", System.Text.Json.JsonSerializer.Serialize(outputs));
analyze.Call(engine.Evaluate("JSON.parse(__o)"), engine.Evaluate("__bank"));
var afterAnalyze = Process.GetCurrentProcess().WorkingSet64;
Console.WriteLine($"④ 完成一次归因评分后    : {Mb(afterAnalyze)}  (增加 {Mb(afterAnalyze - afterBank)})");
Console.WriteLine();
Console.WriteLine($"Jint + 指纹库 合计峰值  : {Mb(afterAnalyze - workingSetStart)}");
Console.WriteLine($"进程工作集总计          : {Mb(afterAnalyze)}");

static string Mb(long bytes) => $"{bytes / 1024.0 / 1024.0,8:0.0} MB";

static string FindRepoRoot()
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        if (File.Exists(Path.Combine(dir.FullName, "static", "fingerprint-core.js"))) return dir.FullName;
        dir = dir.Parent;
    }
    throw new DirectoryNotFoundException("未找到仓库根目录");
}
