using System.Security.Cryptography;
using Jint;
using Jint.Native;

// 冒烟验证 2：crypto 垫片。
//
// challenge-browser.js 依赖浏览器 Web Crypto 的两个 API：
//   crypto.getRandomValues(typedArray) —— 无偏取样长度
//   crypto.randomUUID()                —— 生成挑战 id
// Jint 是纯 JS 解释器，不带任何宿主 API，必须在 C# 侧注入。
//
// 实现策略：类型细节交给 JS 处理（TypedArray 的 view 语义由引擎自己保证），
// C# 只提供一个「把随机字节写进给定 Uint8Array」的原语，避免在 C# 里猜元素位宽。

var repo = FindRepoRoot();
var staticDir = Path.Combine(repo, "static");

var engine = new Engine(options => options.EnableModules(staticDir).Strict(false));

// 原语：用一个 32 位随机值填满目标数组。
// challenge-browser.js 只用 Uint32Array，直接按 32 位无符号写入即可。
engine.SetValue("__randomUint32", new Func<double>(() =>
{
    Span<byte> bytes = stackalloc byte[4];
    RandomNumberGenerator.Fill(bytes);
    return (double)BitConverter.ToUInt32(bytes);
}));

engine.SetValue("__randomUuid", new Func<string>(() =>
{
    Span<byte> bytes = stackalloc byte[16];
    RandomNumberGenerator.Fill(bytes);
    bytes[6] = (byte)((bytes[6] & 0x0F) | 0x40);   // 版本位 v4
    bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);   // 变体位 10xx
    return new Guid(bytes, bigEndian: true).ToString().ToLowerInvariant();
}));

// 垫片本体。与浏览器一致：原地填充并返回同一个对象。
engine.Execute("""
    globalThis.crypto = {
      getRandomValues(array) {
        if (!ArrayBuffer.isView(array)) {
          throw new TypeError('crypto.getRandomValues 需要一个 TypedArray');
        }
        for (let i = 0; i < array.length; i += 1) array[i] = __randomUint32();
        return array;
      },
      randomUUID() {
        return __randomUuid();
      },
    };
""");

// ── 验证 1：getRandomValues 原地填充且值域正确 ──
var filled = engine.Evaluate("""
    (() => {
      const buffer = new Uint32Array(8);
      const returned = crypto.getRandomValues(buffer);
      return {
        sameReference: returned === buffer,
        length: buffer.length,
        distinct: new Set(buffer).size,
        allUnsigned: buffer.every(v => Number.isInteger(v) && v >= 0 && v <= 4294967295),
      };
    })()
""");

var sameReference = filled.Get("sameReference").AsBoolean();
var length = (int)filled.Get("length").AsNumber();
var distinct = (int)filled.Get("distinct").AsNumber();
var allUnsigned = filled.Get("allUnsigned").AsBoolean();
Console.WriteLine($"[getRandomValues] 原地返回={sameReference}, 长度={length}, 去重后={distinct}, 值域合法={allUnsigned}");
if (!sameReference || length != 8 || !allUnsigned)
    throw new InvalidOperationException("getRandomValues 语义与浏览器不一致");
Console.WriteLine("          OK getRandomValues 语义与浏览器一致");

// ── 验证 2：randomUUID 格式（RFC 4122 v4）──
var uuids = engine.Evaluate("""
    (() => { const list = []; for (let i = 0; i < 500; i += 1) list.push(crypto.randomUUID()); return list; })()
""").AsArray().Select(v => v.AsString()).ToArray();

var uuidPattern = new System.Text.RegularExpressions.Regex(
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
var badUuid = uuids.FirstOrDefault(u => !uuidPattern.IsMatch(u));
if (badUuid is not null) throw new InvalidOperationException($"randomUUID 格式非法：{badUuid}");
if (uuids.Distinct().Count() != uuids.Length) throw new InvalidOperationException("randomUUID 出现重复值");
Console.WriteLine($"[randomUUID] 生成 {uuids.Length} 个，全部符合 v4 格式且无重复");
Console.WriteLine("          OK randomUUID 语义与浏览器一致");

// ── 验证 3：真正加载 challenge-browser.js 端到端生成挑战 ──
var challenges = engine.Modules.Import("./challenge-browser.js");
var generated = challenges.Get("generateChallenges").Call(3).AsArray();

Console.WriteLine();
Console.WriteLine("[generateChallenges] 生成 3 条挑战：");
var counts = new List<long>();
foreach (var item in generated)
{
    var id = item.Get("id").AsString();
    var expectedCount = (int)item.Get("expected_count").AsNumber();
    var prompt = item.Get("prompt").AsString();
    counts.Add(expectedCount);

    // id 形如 probe-N-<uuid>，UUID 定长 36 字符，直接取尾部
    var uuidPart = id.Length >= 36 ? id[^36..] : id;
    if (!uuidPattern.IsMatch(uuidPart))
        throw new InvalidOperationException($"挑战 id 中的 UUID 非法：{id}");
    if (expectedCount is < 292 or > 332)
        throw new InvalidOperationException($"expected_count 越界：{expectedCount}");
    if (!prompt.Contains($"{expectedCount} 个 1 到 355"))
        throw new InvalidOperationException("挑战正文与 expected_count 不匹配");

    Console.WriteLine($"  id={id}");
    Console.WriteLine($"  expected_count={expectedCount}");
    Console.WriteLine($"  prompt 前 64 字：{prompt[..Math.Min(64, prompt.Length)]}...");
}

if (counts.Distinct().Count() != counts.Count)
    throw new InvalidOperationException("三条挑战的 expected_count 出现重复，取样去重失效");

Console.WriteLine();
Console.WriteLine("步骤 2 冒烟验证通过：crypto 垫片可用，challenge-browser.js 可直接运行。");

static string FindRepoRoot()
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir is not null)
    {
        if (File.Exists(Path.Combine(dir.FullName, "static", "fingerprint-core.js")))
            return dir.FullName;
        dir = dir.Parent;
    }
    throw new DirectoryNotFoundException("向上查找未找到仓库根目录");
}
