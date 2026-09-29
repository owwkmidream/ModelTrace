using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace ModelTrace.Desktop.ViewModels;

/// <summary>bool 到 Visibility 的转换：true 显示，false 折叠。</summary>
public sealed class BoolToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true ? Visibility.Visible : Visibility.Collapsed;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is Visibility.Visible;
}

/// <summary>
/// 字符串与固定目标值相等时返回 true，用于分段控件的选中态。
/// 用独立子类而不是 ConverterParameter，是为了让 XAML 侧无需再写参数、也不易写错。
/// </summary>
public abstract class StringMatchConverter(string target) : IValueConverter
{
    private readonly string _target = target;

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        string.Equals(value as string, _target, StringComparison.Ordinal);

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true ? _target : Binding.DoNothing;
}

public sealed class IsAllConverter() : StringMatchConverter("all");
public sealed class IsSameConverter() : StringMatchConverter("same");
public sealed class IsDiffConverter() : StringMatchConverter("diff");
public sealed class IsManualConverter() : StringMatchConverter("manual");
public sealed class IsApiConverter() : StringMatchConverter("api");
