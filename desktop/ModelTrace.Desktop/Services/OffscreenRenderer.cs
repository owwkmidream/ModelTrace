using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace ModelTrace.Desktop.Services;

/// <summary>
/// 离屏渲染：把窗口内容渲染成 PNG。
///
/// 为什么必须真正 Show 一次：WPF 的 ControlTemplate 与绑定是在窗口加载完成后
/// 才实例化的，仅 Measure/Arrange 会得到空白图。
/// 因此这里把窗口移到屏幕可视区域之外（左上角负坐标），并以 NoActivate 显示：
///   - 用户桌面上看不到任何窗口
///   - 不激活、不抢焦点、不动鼠标键盘
/// 取图后再立即关闭。
/// </summary>
public static class OffscreenRenderer
{
    public static void Render(Window window, int width, int height, string path)
    {
        // 关键：移出所有显示器的可视范围，并按需布局尺寸
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Left = -32000;
        window.Top = -32000;
        window.Width = width;
        window.Height = height;
        // ShowActivated=false 保证显示时不激活、不抢焦点
        window.ShowActivated = false;
        window.ShowInTaskbar = false;
        window.Topmost = false;

        window.Show();
        // 等待布局、模板与绑定全部就绪
        window.Dispatcher.Invoke(() => { }, System.Windows.Threading.DispatcherPriority.ContextIdle);
        window.UpdateLayout();
        window.Dispatcher.Invoke(() => { }, System.Windows.Threading.DispatcherPriority.Loaded);

        var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(window);

        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using (var stream = File.Create(path)) encoder.Save(stream);

        window.Close();
    }
}
