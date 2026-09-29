using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace ModelTrace.Desktop.Services;

/// <summary>
/// 开始菜单项注册。
///
/// 这是本次需求的核心：用户希望「打开开始菜单点一下就能启动，不用开浏览器」。
/// 实现方式是在开始菜单里写一个 .lnk 快捷方式，指向当前 exe。
/// 不写注册表、不装服务，纯用户级文件操作，卸载时删掉快捷方式即可。
/// </summary>
public static class StartMenuShortcut
{
    private const string ShortcutName = "ModelTrace.lnk";

    /// <summary>开始菜单 Programs 目录。</summary>
    private static string ProgramsDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Microsoft", "Windows", "Start Menu", "Programs");

    /// <summary>当前快捷方式路径。</summary>
    public static string ShortcutPath => Path.Combine(ProgramsDirectory, ShortcutName);

    public static bool IsRegistered => File.Exists(ShortcutPath);

    /// <summary>当前进程的 exe 路径。单文件发布下即用户点击启动的目标。</summary>
    public static string ExecutablePath
    {
        get
        {
            var path = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(path)) return path;
            return Process.GetCurrentProcess().MainModule?.FileName
                ?? throw new InvalidOperationException("无法确定当前可执行文件路径");
        }
    }

    /// <summary>创建或刷新开始菜单项。重复调用是幂等的。</summary>
    public static void Register()
    {
        Directory.CreateDirectory(ProgramsDirectory);
        var exe = ExecutablePath;

        // 用 Windows Script Host 创建 .lnk，避免引入 COM 互操作依赖
        var script = new StringBuilder();
        script.AppendLine("$ErrorActionPreference = 'Stop'");
        script.AppendLine("$ws = New-Object -ComObject WScript.Shell");
        script.AppendLine($"$lnk = $ws.CreateShortcut('{Escape(ShortcutPath)}')");
        script.AppendLine($"$lnk.TargetPath = '{Escape(exe)}'");
        script.AppendLine($"$lnk.WorkingDirectory = '{Escape(Path.GetDirectoryName(exe) ?? string.Empty)}'");
        script.AppendLine("$lnk.Description = 'ModelTrace 模型归因工具'");
        script.AppendLine("$lnk.IconLocation = '" + Escape(exe) + ",0'");
        script.AppendLine("$lnk.Save()");

        RunPowerShell(script.ToString());
    }

    /// <summary>删除开始菜单项。</summary>
    public static void Unregister()
    {
        if (File.Exists(ShortcutPath)) File.Delete(ShortcutPath);
    }

    /// <summary>
    /// 运行一段 PowerShell。
    /// 通过 -EncodedCommand 传递，绕开引号与中文在命令行上的转义问题。
    /// </summary>
    private static void RunPowerShell(string script)
    {
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded}",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动 PowerShell 创建快捷方式");
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"创建开始菜单项失败：{stderr.Trim()}");
    }

    /// <summary>PowerShell 单引号字符串中，单引号本身要写成两个。</summary>
    private static string Escape(string value) => value.Replace("'", "''");
}
