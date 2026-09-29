using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using ModelTrace.Desktop.Services;

namespace ModelTrace.Desktop.ViewModels;

/// <summary>极简的命令实现，避免引入 MVVM 框架依赖。</summary>
public sealed class RelayCommand(Action<object?> execute, Func<object?, bool>? canExecute = null) : ICommand
{
    public event EventHandler? CanExecuteChanged;
    public bool CanExecute(object? parameter) => canExecute?.Invoke(parameter) ?? true;
    public void Execute(object? parameter) => execute(parameter);
    public void RaiseCanExecuteChanged() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}

public abstract class Observable : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    protected void OnPropertyChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    protected bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        OnPropertyChanged(name);
        return true;
    }
}

/// <summary>界面上一条挑战。</summary>
public sealed class ChallengeItem : Observable
{
    private string _output = string.Empty;
    private string _diagnostic = string.Empty;

    public required string Id { get; init; }
    public required int ExpectedCount { get; init; }
    public required string Prompt { get; init; }

    public string Output
    {
        get => _output;
        set => Set(ref _output, value);
    }

    public string Diagnostic
    {
        get => _diagnostic;
        set => Set(ref _diagnostic, value);
    }
}

/// <summary>界面上一个模型得分。</summary>
public sealed class ScoreRow
{
    public required string DisplayName { get; init; }
    public required double Probability { get; init; }
    public required string FamilyName { get; init; }
    public required double ConditionalProbability { get; init; }
    public required double ProfileSimilarity { get; init; }
    public required double Score { get; init; }
    public required bool IsTop { get; init; }

    public string ProbabilityText => $"{Probability * 100:0.00}%";
    public string ConditionalText => $"{ConditionalProbability * 100:0.00}%";
    public string SimilarityText => ProfileSimilarity.ToString("0.0000");
    public string ScoreText => Score.ToString("0.0000");
    public double BarWidth => Math.Max(0, Math.Min(1, Probability)) * 160;
}

/// <summary>界面上的一个端点尝试卡片。</summary>
public sealed class EndpointCard : Observable
{
    private string _status = "等待";
    private string _body = string.Empty;
    private bool _ok;

    public required string ApiFormat { get; init; }
    public required int Attempt { get; init; }
    public bool Stream { get; init; }

    public string Title => $"{FormatLabel(ApiFormat)} · 第 {Attempt} 次{(Stream ? "（流式）" : string.Empty)}";

    public string Status
    {
        get => _status;
        set { if (Set(ref _status, value)) OnPropertyChanged(nameof(StatusBrush)); }
    }

    public string Body
    {
        get => _body;
        set => Set(ref _body, value);
    }

    public bool Ok
    {
        get => _ok;
        set { if (Set(ref _ok, value)) OnPropertyChanged(nameof(StatusBrush)); }
    }

    public Brush StatusBrush => Ok
        ? new SolidColorBrush(Color.FromRgb(0x16, 0x79, 0x4B))
        : new SolidColorBrush(Color.FromRgb(0xB4, 0x23, 0x18));

    private static string FormatLabel(string apiFormat) => apiFormat switch
    {
        "responses" => "Responses",
        "anthropic" => "Anthropic",
        _ => "Chat",
    };
}
