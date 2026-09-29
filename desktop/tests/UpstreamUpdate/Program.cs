using System.IO;
using ModelTrace.Desktop.Services;

// 端到端验证：客户端能否真的从上游仓库拉到指纹库。
//
// 这是「指纹库热更新」这条链路唯一的真实联网验证：
// 前几个测试只证明脚本能跑、哈希算法一致，但都没证明网络层能取到东西。
// 本测试在临时目录里造一份干净的资产环境，然后走一遍 AssetUpdater 的真实代码路径。
//
// 网络不可用时会明确报告「跳过」而不是假成功 —— 联网失败不等于功能有问题。

var upstream = AssetUpdater.DefaultUpstream;
Console.WriteLine($"上游通道: {upstream}");
Console.WriteLine();

// 在临时目录准备一套初始资产，避免污染用户真实的 %APPDATA% 数据
var tempDir = Path.Combine(Path.GetTempPath(), "modeltrace-upstream-test-" + Guid.NewGuid().ToString("n")[..8]);
Directory.CreateDirectory(tempDir);

try
{
    var store = new AssetStore(tempDir);
    store.EnsureInitialized();

    var local = store.ComputeManifest();
    Console.WriteLine($"本地初始指纹库: {local.ModelCount} 个模型，构建于 {local.BankBuiltAt}");
    Console.WriteLine();

    var updater = new AssetUpdater(store) { ChannelUrl = upstream };

    // ── 第一次：只检查，不应用 ──
    Console.WriteLine("── 检查更新（不应用）──");
    var check = await updater.CheckAndApplyAsync(apply: false);
    Console.WriteLine($"  有更新: {check.HasUpdate}");
    Console.WriteLine($"  上游 built_at: {check.RemoteBankBuiltAt ?? "(未取到)"}");
    Console.WriteLine($"  本地 built_at: {check.LocalBankBuiltAt ?? "(无)"}");
    Console.WriteLine($"  消息: {check.Message}");
    Console.WriteLine();

    // 判断是否成功连上了上游：只要能报出上游的 built_at 或明确的“已是最新”，就算连通
    var connected = check.RemoteBankBuiltAt is not null
                    || check.Message.Contains("已是最新")
                    || check.HasUpdate;

    if (!connected)
    {
        Console.WriteLine("结论：无法连接上游（可能是网络受限）。");
        Console.WriteLine("      本测试跳过，不判定为失败。");
        return 2;
    }

    Console.WriteLine("结论：已成功连接上游，读取到指纹库元信息。");
    Console.WriteLine();

    // ── 第二次：把本地指纹库改成一个更旧的样子，验证「有更新 → 应用」路径 ──
    Console.WriteLine("── 模拟本地指纹库过期，验证应用更新 ──");
    var current = store.ReadBankJson();
    // 只把 built_at 改早，其余内容不动：这样能精确验证「按 built_at 判新旧」的逻辑
    var stale = System.Text.RegularExpressions.Regex.Replace(
        current,
        "\"built_at\"\\s*:\\s*\"[^\"]*\"",
        "\"built_at\": \"2000-01-01T00:00:00+00:00\"",
        System.Text.RegularExpressions.RegexOptions.None);
    if (stale == current)
        throw new InvalidOperationException("未能改写 built_at，无法构造过期场景");
    store.ReplaceBank(stale);

    var staleManifest = store.ComputeManifest();
    Console.WriteLine($"  本地已改为: 构建于 {staleManifest.BankBuiltAt}");

    var staleCheck = await updater.CheckAndApplyAsync(apply: false);
    Console.WriteLine($"  检测到更新: {staleCheck.HasUpdate}");
    if (!staleCheck.HasUpdate)
        throw new InvalidOperationException("本地指纹库时间更旧时未能检测到更新");

    var applied = await updater.CheckAndApplyAsync(apply: true);
    Console.WriteLine($"  应用结果: {applied.Message}");
    Console.WriteLine($"  备份文件存在: {File.Exists(store.BankPath + ".bak")}");

    var restored = store.ComputeManifest();
    Console.WriteLine($"  更新后本地: {restored.ModelCount} 个模型，构建于 {restored.BankBuiltAt}");
    if (restored.ModelCount == 0)
        throw new InvalidOperationException("更新后本地指纹库为空，说明写入失败");
    if (restored.BankBuiltAt == "2000-01-01T00:00:00+00:00")
        throw new InvalidOperationException("更新后 built_at 仍是旧值，说明没有真正覆盖");

    // 再次检查应报告「已是最新」，证明覆盖后判新旧逻辑自洽
    Console.WriteLine();
    Console.WriteLine("── 再次检查（应报告已是最新）──");
    var again = await updater.CheckAndApplyAsync(apply: false);
    Console.WriteLine($"  有更新: {again.HasUpdate}");
    Console.WriteLine($"  消息: {again.Message}");
    if (again.HasUpdate)
        throw new InvalidOperationException("更新后仍报告有更新：built_at 比对逻辑有误");

    Console.WriteLine();
    Console.WriteLine("上游更新链路验证通过（含检测与应用更新）。");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine($"验证失败: {error.GetType().Name}: {error.Message}");
    return 1;
}
finally
{
    try { Directory.Delete(tempDir, recursive: true); } catch { /* 清理失败不影响结论 */ }
}
