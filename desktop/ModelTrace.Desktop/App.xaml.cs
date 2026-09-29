using System.IO;
using System.Windows;
using ModelTrace.Desktop.ViewModels;

namespace ModelTrace.Desktop;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // 命令行开关：供安装脚本或用户手动注册/注销开始菜单项
        if (e.Args.Contains("--register-start-menu"))
        {
            try { Services.StartMenuShortcut.Register(); }
            catch (Exception error) { MessageBox.Show($"注册开始菜单项失败：{error.Message}"); }
            Shutdown();
            return;
        }
        if (e.Args.Contains("--unregister-start-menu"))
        {
            try { Services.StartMenuShortcut.Unregister(); }
            catch (Exception error) { MessageBox.Show($"移除开始菜单项失败：{error.Message}"); }
            Shutdown();
            return;
        }

        // 开发期：离屏渲染界面样张（窗口移到屏幕外、不激活、不碰键鼠）
        if (e.Args.Contains("--screenshot"))
        {
            // 必须在创建第一个窗口之前切换关闭模式：
            // 每张图渲染完要关掉窗口，若沿用 OnMainWindowClose，第一张之后应用就会开始退出。
            ShutdownMode = ShutdownMode.OnExplicitShutdown;

            var outDir = e.Args.SkipWhile(a => a != "--screenshot").Skip(1).FirstOrDefault()
                ?? Path.Combine(AppContext.BaseDirectory, "shots");
            try
            {
                CaptureShots(outDir);
                Console.Error.WriteLine($"样张已输出到 {outDir}");
            }
            catch (Exception error)
            {
                // 截图模式必须保持无界面：错误只写标准错误，绝不弹窗干扰用户桌面
                Console.Error.WriteLine($"渲染样张失败：{error}");
                Environment.ExitCode = 1;
            }
            Shutdown();
            return;
        }

        var window = new MainWindow { DataContext = new MainViewModel() };
        window.Show();
    }

    /// <summary>
    /// 逐个工作区渲染样张。
    /// 窗口会被移到屏幕外并以不激活方式显示，用户桌面上看不到、也不抢焦点，
    /// 每张图渲染完立即关闭窗口。
    /// </summary>
    private static void CaptureShots(string outDir)
    {
        const int width = 1280;
        const int height = 880;

        void Shot(MainViewModel viewModel, string name)
        {
            var window = new MainWindow { DataContext = viewModel };
            Services.OffscreenRenderer.Render(window, width, height, Path.Combine(outDir, name));
        }

        // 每次渲染用独立 ViewModel，避免上一个窗口关闭后绑定失效。
        // 主题必须显式指定：ViewModel 构造时会从设置文件读入上次的偏好，
        // 若不覆盖，浅色样张会被渲染成深色。
        var light = new MainViewModel { IsDarkTheme = false, Workspace = "test", TestMode = "api" };
        Shot(light, "01-test-light.png");

        light.TestMode = "manual";
        Shot(light, "02-manual-light.png");

        light.Workspace = "library";
        Shot(light, "03-library-light.png");

        light.Workspace = "history";
        Shot(light, "04-history-light.png");

        var dark = new MainViewModel { IsDarkTheme = true, Workspace = "test", TestMode = "api" };
        Shot(dark, "05-test-dark.png");

        dark.Workspace = "library";
        Shot(dark, "06-library-dark.png");
    }
}
