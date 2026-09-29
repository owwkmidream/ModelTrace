using System.Windows;
using ModelTrace.Desktop.ViewModels;

namespace ModelTrace.Desktop;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        // 主题切换：替换合并字典里的最后一个覆盖层。
        // 注意：ViewModel 在窗口构造前就可能已从设置里读出深色偏好，
        // 那时订阅尚未建立，因此这里必须在加载后按当前值主动同步一次，
        // 否则「上次退出时是深色」的状态在重启后会丢失。
        Loaded += (_, _) =>
        {
            if (DataContext is not MainViewModel viewModel) return;
            viewModel.ThemeRequested += OnThemeRequested;
            ApplyTheme(viewModel.IsDarkTheme);
        };
        Closed += (_, _) =>
        {
            if (DataContext is MainViewModel viewModel)
                viewModel.ThemeRequested -= OnThemeRequested;
        };
    }

    private void OnThemeRequested(object? sender, bool dark) => ApplyTheme(dark);

    private void ApplyTheme(bool dark)
    {
        var source = dark ? "Themes/Dark.xaml" : "Themes/Light.xaml";
        var dictionaries = Application.Current.Resources.MergedDictionaries;
        var target = new ResourceDictionary
        {
            Source = new Uri(source, UriKind.Relative),
        };

        // 覆盖层固定为最后一项：先移除旧的，再追加新的
        if (dictionaries.Count > 0) dictionaries.RemoveAt(dictionaries.Count - 1);
        dictionaries.Add(target);
    }
}
