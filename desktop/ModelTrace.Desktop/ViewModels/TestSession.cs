using System.Collections.ObjectModel;
using System.Windows;
using ModelTrace.Desktop.Services;

namespace ModelTrace.Desktop.ViewModels;

/// <summary>测试任务会话：一个标签页对应一次完整的 API 自动测试。</summary>
public sealed class TestSession : Observable
{
    private string _status = "准备测试";
    private double _progress;
    private int _validCount;
    private int _attemptCount;
    private bool _running;
    private bool _waitingStep;

    public required string Id { get; init; }
    public required string Label { get; init; }
    public string BaseUrl { get; init; } = string.Empty;
    public string ApiModel { get; init; } = string.Empty;
    public required DateTimeOffset StartedAt { get; init; }

    public string Status { get => _status; set => Set(ref _status, value); }
    public double Progress { get => _progress; set => Set(ref _progress, value); }
    public int ValidCount { get => _validCount; set => Set(ref _validCount, value); }
    public int AttemptCount { get => _attemptCount; set => Set(ref _attemptCount, value); }
    public bool Running { get => _running; set => Set(ref _running, value); }
    public bool WaitingStep { get => _waitingStep; set => Set(ref _waitingStep, value); }

    public string CountText => $"有效 {ValidCount}/3 · 已尝试 {AttemptCount}/6";
    public ObservableCollection<EndpointCard> Endpoints { get; } = [];
    public ObservableCollection<ChallengeItem> Challenges { get; } = [];
    public AnalysisResult? Result { get; set; }

    private string? _detectedFormat;
    public string? DetectedFormat
    {
        get => _detectedFormat;
        set { if (Set(ref _detectedFormat, value)) OnPropertyChanged(nameof(TabLabel)); }
    }

    public CancellationTokenSource? Cancellation { get; set; }

    /// <summary>标签标题：带上实测到的格式，便于多任务区分。</summary>
    public string TabLabel => DetectedFormat is null ? Label : $"{Label} · {DetectedFormat}";

    public void RefreshCount() => OnPropertyChanged(nameof(CountText));
}
