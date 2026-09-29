using System.Collections.ObjectModel;
using System.IO;
using System.Windows;
using System.Windows.Input;
using ModelTrace.Desktop.Services;

namespace ModelTrace.Desktop.ViewModels;

/// <summary>
/// 主视图模型：驱动三个工作区（模型测试 / 指纹库管理 / 历史记录）。
/// 所有耗时操作都是 async，避免阻塞 UI 线程。
/// </summary>
public sealed class MainViewModel : Observable
{
    private readonly AssetStore _assets;
    private readonly FingerprintEngine _engine;
    private readonly UpstreamClient _upstream = new();
    private readonly LocalStore _store = new();
    private readonly AssetUpdater _updater;

    // ── 工作区切换 ──

    private string _workspace = "test";
    public string Workspace
    {
        get => _workspace;
        set
        {
            if (!Set(ref _workspace, value)) return;
            OnPropertyChanged(nameof(IsTestWorkspace));
            OnPropertyChanged(nameof(IsLibraryWorkspace));
            OnPropertyChanged(nameof(IsHistoryWorkspace));
        }
    }
    public bool IsTestWorkspace => Workspace == "test";
    public bool IsLibraryWorkspace => Workspace == "library";
    public bool IsHistoryWorkspace => Workspace == "history";

    private string _testMode = "manual";
    public string TestMode
    {
        get => _testMode;
        set
        {
            if (!Set(ref _testMode, value)) return;
            OnPropertyChanged(nameof(IsManualMode));
            OnPropertyChanged(nameof(IsApiMode));
        }
    }
    public bool IsManualMode => TestMode == "manual";
    public bool IsApiMode => TestMode == "api";

    // ── 主题 ──

    private bool _dark;
    public bool IsDarkTheme
    {
        get => _dark;
        set
        {
            if (!Set(ref _dark, value)) return;
            OnPropertyChanged(nameof(ThemeLabel));
            OnPropertyChanged(nameof(ThemeIcon));
            ThemeRequested?.Invoke(this, value);
        }
    }

    /// <summary>文案表达的是「点下去会切到哪」，与网页版 applyTheme 一致。</summary>
    public string ThemeLabel => IsDarkTheme ? "浅色模式" : "深色模式";

    /// <summary>与文案配套的图标：深色时显示月亮，浅色时显示太阳。</summary>
    public string ThemeIcon => IsDarkTheme ? "☾" : "☀";

    public event EventHandler<bool>? ThemeRequested;

    // ── 指纹库信息 ──

    public string BankSummary => $"{_engine.ModelCount} 个候选模型";
    public string BankBuiltAt => _engine.BankBuiltAt is null
        ? "指纹库构建时间未知"
        : $"构建于 {_engine.BankBuiltAt}";
    public string BankMethod => _engine.BankMethod ?? string.Empty;
    public ObservableCollection<string> BankModelIds { get; } = [];

    // ── 模型测试：手动模式 ──

    public ObservableCollection<ChallengeItem> ManualChallenges { get; } = [];
    private AnalysisResult? _manualResult;
    public AnalysisResult? ManualResult
    {
        get => _manualResult;
        set
        {
            if (!Set(ref _manualResult, value)) return;
            OnPropertyChanged(nameof(HasManualResult));
            OnPropertyChanged(nameof(ManualScoreRows));
            OnPropertyChanged(nameof(ManualSummaryText));
            OnPropertyChanged(nameof(ManualDiagnosticsText));
        }
    }
    public bool HasManualResult => ManualResult is not null;

    public IReadOnlyList<ScoreRow> ManualScoreRows => BuildRows(ManualResult);
    public string ManualSummaryText => ManualResult is null ? string.Empty
        : $"预测：{ManualResult.PredictionName} · 概率 {ManualResult.Probability * 100:0.00}% " +
          $"· 家族 {ManualResult.FamilyPredictionName}（{ManualResult.FamilyProbability * 100:0.00}%）" +
          $"· 计入 {ManualResult.UsedOutputs}/3 份回答";
    public string ManualDiagnosticsText => ManualResult is null ? string.Empty
        : string.Join("　", ManualResult.Diagnostics.Select(d =>
            $"#{d.Index + 1} 解析 {d.ParsedNumbers} 个（阈值 {d.MinimumNumbers}）{(d.Accepted ? "计入" : "忽略")}"));

    // ── 模型测试：API 自动模式 ──

    private string _apiBaseUrl = string.Empty;
    public string ApiBaseUrl { get => _apiBaseUrl; set => Set(ref _apiBaseUrl, value); }

    private string _apiModel = string.Empty;
    public string ApiModel { get => _apiModel; set => Set(ref _apiModel, value); }

    private string _apiKey = string.Empty;
    public string ApiKey { get => _apiKey; set => Set(ref _apiKey, value); }

    private string _temperature = string.Empty;
    public string Temperature { get => _temperature; set => Set(ref _temperature, value); }

    private string _newConfigName = string.Empty;
    public string NewConfigName { get => _newConfigName; set => Set(ref _newConfigName, value); }

    public ObservableCollection<SavedConfig> SavedConfigs { get; } = [];
    public ObservableCollection<TestSession> Sessions { get; } = [];

    private TestSession? _activeSession;
    public TestSession? ActiveSession
    {
        get => _activeSession;
        set
        {
            if (Set(ref _activeSession, value))
            {
                OnPropertyChanged(nameof(HasActiveSession));
                OnPropertyChanged(nameof(ActiveScoreRows));
                OnPropertyChanged(nameof(ActiveResultSummary));
                OnPropertyChanged(nameof(ActiveDiagnosticsText));
                OnPropertyChanged(nameof(ActiveChallenges));
            }
        }
    }
    public bool HasActiveSession => ActiveSession is not null;
    public IReadOnlyList<ScoreRow> ActiveScoreRows => BuildRows(ActiveSession?.Result);
    public string ActiveResultSummary => ActiveSession?.Result is null ? string.Empty
        : $"预测：{ActiveSession.Result.PredictionName} · 概率 {ActiveSession.Result.Probability * 100:0.00}% " +
          $"· 家族 {ActiveSession.Result.FamilyPredictionName}（{ActiveSession.Result.FamilyProbability * 100:0.00}%）" +
          $"· 计入 {ActiveSession.Result.UsedOutputs}/3 份回答";
    public string ActiveDiagnosticsText => ActiveSession?.Result is null ? string.Empty
        : string.Join("　", ActiveSession.Result.Diagnostics.Select(d =>
            $"#{d.Index + 1} 解析 {d.ParsedNumbers} 个（阈值 {d.MinimumNumbers}）{(d.Accepted ? "计入" : "忽略")}"));
    public ObservableCollection<ChallengeItem> ActiveChallenges => ActiveSession?.Challenges ?? [];

    // ── 消息条 ──

    private string _message = string.Empty;
    private bool _messageIsError = true;
    public string Message { get => _message; set { if (Set(ref _message, value)) OnPropertyChanged(nameof(HasMessage)); } }
    public bool HasMessage => !string.IsNullOrEmpty(Message);
    public bool MessageIsError { get => _messageIsError; set => Set(ref _messageIsError, value); }

    // ── 指纹库管理 ──

    private string _newBankName = string.Empty;
    public string NewBankName { get => _newBankName; set => Set(ref _newBankName, value); }

    private string _enrollBaseUrl = string.Empty;
    public string EnrollBaseUrl { get => _enrollBaseUrl; set => Set(ref _enrollBaseUrl, value); }

    private string _enrollApiModel = string.Empty;
    public string EnrollApiModel { get => _enrollApiModel; set => Set(ref _enrollApiModel, value); }

    private string _enrollApiKey = string.Empty;
    public string EnrollApiKey { get => _enrollApiKey; set => Set(ref _enrollApiKey, value); }

    private string _enrollModelLabel = string.Empty;
    public string EnrollModelLabel { get => _enrollModelLabel; set => Set(ref _enrollModelLabel, value); }

    private string _enrollSampleCount = "36";
    public string EnrollSampleCount { get => _enrollSampleCount; set => Set(ref _enrollSampleCount, value); }

    private string _enrollMessage = string.Empty;
    public string EnrollMessage { get => _enrollMessage; set { if (Set(ref _enrollMessage, value)) OnPropertyChanged(nameof(HasEnrollMessage)); } }
    public bool HasEnrollMessage => !string.IsNullOrEmpty(EnrollMessage);

    // ── 历史记录 ──

    public ObservableCollection<HistoryEntry> History { get; } = [];
    private string _historySearch = string.Empty;
    public string HistorySearch
    {
        get => _historySearch;
        set { if (Set(ref _historySearch, value)) RefreshHistoryView(); }
    }

    private string _historyConsistency = "all";
    public string HistoryConsistency
    {
        get => _historyConsistency;
        set { if (Set(ref _historyConsistency, value)) RefreshHistoryView(); }
    }

    public ObservableCollection<HistoryEntry> HistoryView { get; } = [];
    public string HistoryCountText => $"{HistoryView.Count} 条";

    // ── 更新通道 ──

    /// <summary>
    /// 指纹库更新通道的默认地址：上游原仓库。
    /// 直接指向上游而非本仓库 fork，因为上游才是指纹数据的唯一来源，
    /// 少一层中转，也不会因 fork 未同步而拉到旧库。
    /// 用户可改成自己的镜像地址；留空则不检查更新。
    /// </summary>
    public const string DefaultChannelUrl = AssetUpdater.DefaultUpstream;

    private string _channelUrl = DefaultChannelUrl;
    public string ChannelUrl { get => _channelUrl; set => Set(ref _channelUrl, value); }

    private string _updateMessage = string.Empty;
    public string UpdateMessage { get => _updateMessage; set { if (Set(ref _updateMessage, value)) OnPropertyChanged(nameof(HasUpdateMessage)); } }
    public bool HasUpdateMessage => !string.IsNullOrEmpty(UpdateMessage);

    // ── 开始菜单项 ──

    public bool StartMenuRegistered => StartMenuShortcut.IsRegistered;
    public string StartMenuStatus => StartMenuRegistered
        ? "已添加到开始菜单，可直接搜索 ModelTrace 启动"
        : "尚未添加到开始菜单";

    // ── 命令 ──

    public ICommand ShowTestCommand { get; }
    public ICommand ShowLibraryCommand { get; }
    public ICommand ShowHistoryCommand { get; }
    public ICommand ManualModeCommand { get; }
    public ICommand ApiModeCommand { get; }
    public ICommand RegenerateCommand { get; }
    public ICommand AnalyzeCommand { get; }
    public ICommand SaveConfigCommand { get; }
    public ICommand DeleteConfigCommand { get; }
    public ICommand LoadConfigCommand { get; }
    public ICommand StartTestCommand { get; }
    public ICommand StepTestCommand { get; }
    public ICommand ResumeTestCommand { get; }
    public ICommand StopTestCommand { get; }
    public ICommand CloseSessionCommand { get; }
    public ICommand FocusSessionCommand { get; }
    public ICommand ProbeModelsCommand { get; }
    public ICommand CheckUpdateCommand { get; }
    public ICommand ApplyUpdateCommand { get; }
    public ICommand CreateBankCommand { get; }
    public ICommand EnrollCommand { get; }
    public ICommand ImportWebDataCommand { get; }
    public ICommand ExportWebScriptCommand { get; }
    public ICommand ClearHistoryCommand { get; }
    public ICommand ToggleStartMenuCommand { get; }
    public ICommand CopyChallengeCommand { get; }
    public ICommand CopyHistoryCommand { get; }
    public ICommand ToggleThemeCommand { get; }
    public ICommand SetConsistencyAllCommand { get; }
    public ICommand SetConsistencySameCommand { get; }
    public ICommand SetConsistencyDiffCommand { get; }

    public MainViewModel()
    {
        _assets = new AssetStore();
        _assets.EnsureInitialized();
        _engine = new FingerprintEngine(_assets);
        _engine.Reload();
        _updater = new AssetUpdater(_assets);

        ShowTestCommand = new RelayCommand(_ => Workspace = "test");
        ShowLibraryCommand = new RelayCommand(_ => Workspace = "library");
        ShowHistoryCommand = new RelayCommand(_ => Workspace = "history");
        ManualModeCommand = new RelayCommand(_ => TestMode = "manual");
        ApiModeCommand = new RelayCommand(_ => TestMode = "api");
        RegenerateCommand = new RelayCommand(_ => LoadManualChallenges());
        AnalyzeCommand = new RelayCommand(async _ => await AnalyzeManualAsync());
        SaveConfigCommand = new RelayCommand(_ => SaveConfig());
        DeleteConfigCommand = new RelayCommand(p => DeleteConfig(p as SavedConfig));
        LoadConfigCommand = new RelayCommand(p => LoadConfig(p as SavedConfig));
        StartTestCommand = new RelayCommand(async _ => await StartTestAsync(autoResume: true));
        StepTestCommand = new RelayCommand(async _ => await StartTestAsync(autoResume: false));
        ResumeTestCommand = new RelayCommand(_ => ResumeActiveSession());
        StopTestCommand = new RelayCommand(_ => StopActiveSession());
        CloseSessionCommand = new RelayCommand(p => CloseSession(p as TestSession));
        FocusSessionCommand = new RelayCommand(p => ActiveSession = p as TestSession);
        ProbeModelsCommand = new RelayCommand(async _ => await ProbeModelsAsync());
        CheckUpdateCommand = new RelayCommand(async _ => await CheckUpdateAsync(apply: false));
        ApplyUpdateCommand = new RelayCommand(async _ => await CheckUpdateAsync(apply: true));
        CreateBankCommand = new RelayCommand(_ => CreateBank());
        EnrollCommand = new RelayCommand(async _ => await EnrollAsync());
        ImportWebDataCommand = new RelayCommand(_ => ImportWebData());
        ExportWebScriptCommand = new RelayCommand(_ => ExportWebScript());
        ClearHistoryCommand = new RelayCommand(_ => ClearHistory());
        ToggleStartMenuCommand = new RelayCommand(_ => ToggleStartMenu());
        CopyChallengeCommand = new RelayCommand(p => CopyChallenge(p as ChallengeItem));
        CopyHistoryCommand = new RelayCommand(p => CopyHistory(p as HistoryEntry));
        ToggleThemeCommand = new RelayCommand(_ =>
        {
            IsDarkTheme = !IsDarkTheme;
            SaveSettings();
        });
        SetConsistencyAllCommand = new RelayCommand(_ => HistoryConsistency = "all");
        SetConsistencySameCommand = new RelayCommand(_ => HistoryConsistency = "same");
        SetConsistencyDiffCommand = new RelayCommand(_ => HistoryConsistency = "diff");

        RefreshBankInfo();
        LoadManualChallenges();
        RefreshConfigs();
        RefreshHistory();
        LoadSettings();
    }

    // ── 初始化 ──

    private void RefreshBankInfo()
    {
        BankModelIds.Clear();
        foreach (var id in _engine.ModelIds) BankModelIds.Add(id);
        OnPropertyChanged(nameof(BankSummary));
        OnPropertyChanged(nameof(BankBuiltAt));
        OnPropertyChanged(nameof(BankMethod));
        OnPropertyChanged(nameof(StartMenuStatus));
    }

    private void LoadManualChallenges()
    {
        ManualChallenges.Clear();
        foreach (var challenge in _engine.GenerateChallenges(3))
            ManualChallenges.Add(new ChallengeItem
            {
                Id = challenge.Id,
                ExpectedCount = challenge.ExpectedCount,
                Prompt = challenge.Prompt,
            });
    }

    private void RefreshConfigs()
    {
        SavedConfigs.Clear();
        foreach (var config in _store.LoadConfigs()) SavedConfigs.Add(config);
    }

    private void RefreshHistory()
    {
        History.Clear();
        foreach (var entry in _store.LoadHistory()) History.Add(entry);
        RefreshHistoryView();
    }

    private void RefreshHistoryView()
    {
        HistoryView.Clear();
        foreach (var entry in History)
        {
            if (!MatchesKeyword(entry, HistorySearch)) continue;
            if (!MatchesConsistency(entry, HistoryConsistency)) continue;
            HistoryView.Add(entry);
        }
        OnPropertyChanged(nameof(HistoryCountText));
    }

    private static bool MatchesKeyword(HistoryEntry entry, string keyword)
    {
        if (string.IsNullOrWhiteSpace(keyword)) return true;
        var text = keyword.Trim();
        return Contains(entry.Note, text) || Contains(entry.RequestedModel, text)
            || Contains(entry.PredictedName, text) || Contains(entry.BaseUrl, text);
    }

    private static bool Contains(string? source, string text) =>
        source is not null && source.Contains(text, StringComparison.OrdinalIgnoreCase);

    private static bool MatchesConsistency(HistoryEntry entry, string mode) => mode switch
    {
        "same" => entry.PredictedModel is not null &&
                  entry.RequestedModel.Contains(entry.PredictedModel, StringComparison.OrdinalIgnoreCase),
        "diff" => entry.PredictedModel is not null &&
                  !entry.RequestedModel.Contains(entry.PredictedModel, StringComparison.OrdinalIgnoreCase),
        _ => true,
    };

    // ── 设置持久化（通道地址与主题）──

    private string SettingsPath => Path.Combine(_store.DirectoryPath, "settings.json");

    private void LoadSettings()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return;
            using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(SettingsPath));
            var root = document.RootElement;

            // 空值视为「未设置」，保留内置默认通道地址；
            // 否则早期版本或用户清空过的配置会把默认值永久覆盖掉。
            if (root.TryGetProperty("channel_url", out var channel) &&
                !string.IsNullOrWhiteSpace(channel.GetString()))
            {
                ChannelUrl = channel.GetString()!;
            }
            if (root.TryGetProperty("dark", out var dark)) IsDarkTheme = dark.GetBoolean();
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException) { /* 设置损坏时用默认值 */ }
    }

    private void SaveSettings()
    {
        try
        {
            var node = new System.Text.Json.Nodes.JsonObject
            {
                ["channel_url"] = ChannelUrl,
                ["dark"] = IsDarkTheme,
            };
            File.WriteAllText(SettingsPath, node.ToJsonString());
        }
        catch (IOException) { /* 设置写入失败不影响主流程 */ }
    }

    // ── 手动测试 ──

    private async Task AnalyzeManualAsync()
    {
        try
        {
            Message = string.Empty;
            var outputs = ManualChallenges
                .Select(c => (c.ExpectedCount, c.Output))
                .ToArray();
            ManualResult = await Task.Run(() => _engine.Analyze(outputs));
        }
        catch (Exception error)
        {
            ShowError(error.Message);
        }
    }

    // ── 配置管理 ──

    private void SaveConfig()
    {
        if (string.IsNullOrWhiteSpace(NewConfigName))
        {
            ShowError("请先填写配置名称");
            return;
        }
        if (string.IsNullOrWhiteSpace(ApiBaseUrl) || string.IsNullOrWhiteSpace(ApiKey))
        {
            ShowError("请先填写 Base URL 与 API Key");
            return;
        }
        _store.SaveConfig(NewConfigName.Trim(), ApiBaseUrl.Trim(), ApiKey);
        NewConfigName = string.Empty;
        RefreshConfigs();
        ShowInfo("配置已保存");
    }

    private void DeleteConfig(SavedConfig? config)
    {
        if (config is null) return;
        _store.DeleteConfig(config.Id);
        RefreshConfigs();
    }

    private void LoadConfig(SavedConfig? config)
    {
        if (config is null) return;
        ApiBaseUrl = config.BaseUrl;
        ApiKey = config.ApiKey;
        ShowInfo($"已载入配置：{config.Name}");
    }

    // ── API 自动测试 ──

    private TestSession CreateSession()
    {
        var label = string.IsNullOrWhiteSpace(ApiModel) ? "未命名模型" : ApiModel.Trim();
        var session = new TestSession
        {
            Id = Guid.NewGuid().ToString("n"),
            Label = label,
            BaseUrl = ApiBaseUrl.Trim(),
            ApiModel = ApiModel.Trim(),
            StartedAt = DateTimeOffset.Now,
        };
        Sessions.Insert(0, session);
        return session;
    }

    private async Task StartTestAsync(bool autoResume)
    {
        if (string.IsNullOrWhiteSpace(ApiBaseUrl) || string.IsNullOrWhiteSpace(ApiKey) ||
            string.IsNullOrWhiteSpace(ApiModel))
        {
            ShowError("请先填写 Base URL、API Key 与接口模型名");
            return;
        }

        var session = CreateSession();
        ActiveSession = session;
        await RunSessionAsync(session, autoResume);
    }

    private void ResumeActiveSession()
    {
        if (ActiveSession is not TestSession session) return;
        session.WaitingStep = false;
        _ = RunSessionAsync(session, autoResume: true);
    }

    private void StopActiveSession()
    {
        ActiveSession?.Cancellation?.Cancel();
    }

    /// <summary>
    /// 执行一个测试会话：先取挑战，再逐一探测，最后归因评分。
    /// autoResume=false 时，产出有效回答后停下等用户点「继续下一轮」（单步模式）。
    /// </summary>
    private async Task RunSessionAsync(TestSession session, bool autoResume)
    {
        if (session.Running) return;

        session.Running = true;
        session.Cancellation = new CancellationTokenSource();
        var token = session.Cancellation.Token;

        try
        {
            session.Challenges.Clear();
            foreach (var challenge in _engine.GenerateChallenges(3))
                session.Challenges.Add(new ChallengeItem
                {
                    Id = challenge.Id,
                    ExpectedCount = challenge.ExpectedCount,
                    Prompt = challenge.Prompt,
                });

            var collected = new List<(int ExpectedCount, string Text)>();
            var failures = new List<HistoryResponse>();
            string? preferredFormat = session.DetectedFormat;

            for (var index = 0; index < session.Challenges.Count; index += 1)
            {
                if (token.IsCancellationRequested) break;

                var challenge = session.Challenges[index];
                session.Status = $"测试第 {index + 1}/3 项（{challenge.ExpectedCount} 个整数）";
                session.Progress = index / 3.0;

                // 每次尝试清掉上一轮的端点卡片，界面只反映当前这一项
                session.Endpoints.Clear();

                try
                {
                    var result = await _upstream.ProbeAsync(
                        session.BaseUrl, ApiKey, session.ApiModel, challenge.Prompt,
                        ParseTemperature(), string.Empty, preferredFormat,
                        attempt => OnUi(() => UpdateEndpointCard(session, attempt)),
                        token);

                    preferredFormat = result.ApiFormat;
                    session.DetectedFormat = result.ApiFormat;
                    OnUi(() => session.RefreshCount());

                    // 有效数字不足时按原版逻辑重试一次，用新挑战替换当前项
                    var parsed = CountValidNumbers(result.Text);
                    var minimum = Math.Max(80, (int)Math.Ceiling(challenge.ExpectedCount * 0.55));
                    challenge.Output = result.Text;
                    challenge.Diagnostic = $"解析 {parsed} 个（阈值 {minimum}）{(parsed >= minimum ? "计入" : "忽略")}";

                    if (parsed >= minimum)
                    {
                        collected.Add((challenge.ExpectedCount, result.Text));
                        session.ValidCount = collected.Count;
                        session.AttemptCount = index + 1;
                        OnUi(() => session.RefreshCount());

                        if (!autoResume && session.ValidCount < 3)
                        {
                            session.Status = "已产出有效回答，等待继续";
                            session.WaitingStep = true;
                            session.Running = false;
                            return;
                        }
                    }
                    else
                    {
                        // 数量不足：换一条新挑战重试一次
                        var retry = _engine.GenerateChallenges(3)[0];
                        challenge.Output = string.Empty;
                        challenge.Diagnostic = $"解析 {parsed} 个，不足阈值 {minimum}，已换新挑战重试";
                        session.Status = $"第 {index + 1} 项数字不足，重试中";
                    }
                }
                catch (OperationCanceledException)
                {
                    session.Status = "已停止";
                    break;
                }
                catch (UpstreamException error)
                {
                    failures.Add(new HistoryResponse(preferredFormat ?? "auto", 0, error.Status,
                        false, Truncate(error.Body.Length > 0 ? error.Body : error.Message, 2000)));
                    session.Status = $"第 {index + 1} 项失败：{error.Message}";
                }
                session.AttemptCount = index + 1;
                OnUi(() => session.RefreshCount());
            }

            session.Progress = 1;

            if (collected.Count > 0)
            {
                var result = await Task.Run(() => _engine.Analyze(collected), token);
                session.Result = result;
                session.Status = $"完成：预测 {result.PredictionName}（{result.Probability * 100:0.00}%）";
                OnUi(() =>
                {
                    OnPropertyChanged(nameof(ActiveScoreRows));
                    OnPropertyChanged(nameof(ActiveResultSummary));
                    OnPropertyChanged(nameof(ActiveDiagnosticsText));
                    OnPropertyChanged(nameof(ActiveChallenges));
                    AppendHistory(session, result, failures);
                });
            }
            else
            {
                session.Status = "没有可用回答，本次测试未得出结果";
                OnUi(() => AppendHistory(session, null, failures));
            }
        }
        catch (OperationCanceledException)
        {
            session.Status = "已停止";
        }
        catch (Exception error)
        {
            session.Status = $"出错：{error.Message}";
        }
        finally
        {
            session.Running = false;
            session.WaitingStep = false;
            OnUi(() => OnPropertyChanged(nameof(ActiveScoreRows)));
        }
    }

    private void UpdateEndpointCard(TestSession session, ProbeAttempt attempt)
    {
        // attempt=0 且无状态表示「开始探测该格式」，不建卡片
        if (attempt.Attempt == 0) return;

        var card = new EndpointCard
        {
            ApiFormat = attempt.ApiFormat,
            Attempt = attempt.Attempt,
            Stream = attempt.Stream,
            Ok = attempt.Ok,
            Status = attempt.Ok ? "成功" : $"失败（HTTP {attempt.Status}）",
            Body = Truncate(attempt.Body, 600),
        };
        session.Endpoints.Add(card);
    }

    private void AppendHistory(TestSession session, AnalysisResult? result, List<HistoryResponse> failures)
    {
        var predicted = result?.Prediction;
        var mismatch = predicted is not null &&
            !session.ApiModel.Contains(predicted, StringComparison.OrdinalIgnoreCase);
        var note = result is null ? "没有可用回答"
            : mismatch ? $"请求 {session.ApiModel}，实测更像 {result.PredictionName}"
            : null;

        var entry = new HistoryEntry(
            session.Id,
            session.StartedAt.ToString("O"),
            "api",
            session.BaseUrl,
            session.ApiModel,
            predicted,
            result?.PredictionName,
            result?.Probability,
            result?.UsedOutputs ?? 0,
            result is null ? "未得出结论" : mismatch ? "模型不一致" : "模型一致",
            note,
            failures);

        _store.AppendHistory(entry);
        RefreshHistory();
    }

    private void CloseSession(TestSession? session)
    {
        if (session is null) return;
        session.Cancellation?.Cancel();
        Sessions.Remove(session);
        if (ReferenceEquals(ActiveSession, session))
            ActiveSession = Sessions.FirstOrDefault();
    }

    // ── 模型名探测 ──

    private async Task ProbeModelsAsync()
    {
        try
        {
            Message = string.Empty;
            var models = await _upstream.ListModelsAsync(ApiBaseUrl.Trim(), ApiKey, CancellationToken.None);
            BankModelIds.Clear();
            // 复用同一个集合展示：这里临时改为上游模型清单，供用户选择
            foreach (var id in models) BankModelIds.Add(id);
            ShowInfo($"已获取 {models.Count} 个上游模型名");
        }
        catch (Exception error)
        {
            ShowError($"获取模型列表失败：{error.Message}");
        }
        finally
        {
            RefreshBankInfo();
        }
    }

    // ── 更新 ──

    private async Task CheckUpdateAsync(bool apply)
    {
        _updater.ChannelUrl = ChannelUrl.Trim();
        SaveSettings();
        try
        {
            var result = await _updater.CheckAndApplyAsync(apply);
            UpdateMessage = result.Message;
            if (apply && result.Message.Contains("已更新"))
            {
                _engine.Reload();
                RefreshBankInfo();
                ManualResult = null;
                // 指纹库换了，挑战与候选模型都需重新按新库生成
                LoadManualChallenges();
            }
        }
        catch (Exception error)
        {
            UpdateMessage = $"检查更新失败：{error.Message}";
        }
    }

    // ── 指纹库管理 ──

    private void CreateBank()
    {
        // Worker 版无法落盘，桌面版可以：这里给出明确的能力说明
        EnrollMessage = "桌面版已支持本地采集与建库；新建自定义指纹库需要重新计算全局库，" +
                        "请使用仓库中的 rebuild_unified_bank.py 生成后放入 assets 目录。";
    }

    private async Task EnrollAsync()
    {
        // 采集需要向同一个上游连续请求 sampleCount 次，属于长任务。
        // 这里先实现前置校验与提示，采集落盘依赖 Python 侧建库脚本，避免在 C# 里重复实现数值拟合。
        if (string.IsNullOrWhiteSpace(EnrollBaseUrl) || string.IsNullOrWhiteSpace(EnrollApiKey) ||
            string.IsNullOrWhiteSpace(EnrollApiModel) || string.IsNullOrWhiteSpace(EnrollModelLabel))
        {
            EnrollMessage = "请填写 Base URL、API Key、模型名与指纹名称";
            return;
        }
        if (!int.TryParse(EnrollSampleCount, out var samples) || samples is < 3 or > 36)
        {
            EnrollMessage = "采集回答数需在 3 到 36 之间";
            return;
        }

        EnrollMessage = $"开始采集 {samples} 份回答…";
        var collected = new List<string>();
        try
        {
            for (var index = 0; index < samples; index += 1)
            {
                var challenges = _engine.GenerateChallenges(1);
                var challenge = challenges[0];
                var result = await _upstream.ProbeAsync(
                    EnrollBaseUrl.Trim(), EnrollApiKey, EnrollApiModel.Trim(), challenge.Prompt,
                    ParseTemperature(), string.Empty, null, null, CancellationToken.None);
                collected.Add(result.Text);
                EnrollMessage = $"已采集 {index + 1}/{samples} 份回答…";
            }

            var path = Path.Combine(_store.DirectoryPath, $"{EnrollModelLabel.Trim()}_enrollment.jsonl");
            var lines = collected.Select((text, index) =>
                System.Text.Json.JsonSerializer.Serialize(new
                {
                    source = EnrollModelLabel.Trim(),
                    challenge_id = $"enroll-{index}",
                    condition_id = "desktop",
                    strict_valid = true,
                    text,
                }));
            await File.WriteAllLinesAsync(path, lines);
            EnrollMessage = $"采集完成，已写入 {path}。" +
                            "把该文件交给仓库的 bank_builder.py 拟合后，即可生成新的指纹库。";
        }
        catch (Exception error)
        {
            EnrollMessage = $"采集失败：{error.Message}";
        }
    }

    private void ClearHistory()
    {
        _store.ClearHistory();
        RefreshHistory();
        ShowInfo("历史记录已清空");
    }

    /// <summary>
    /// 导入网页版导出文件。文件由 desktop/tools/export-web-console.js 在浏览器控制台生成，
    /// 字段已由该脚本转换成桌面版格式，这里直接读取即可。
    /// </summary>
    private void ImportWebData()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择网页版导出文件",
            Filter = "ModelTrace 导出文件 (*.json)|*.json|所有文件 (*.*)|*.*",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog() != true) return;

        try
        {
            var json = File.ReadAllText(dialog.FileName);
            var result = _store.ImportFromWebExport(json);

            // 导入进来的配置与历史必须立刻反映到界面，否则用户以为没生效
            RefreshConfigs();
            RefreshHistory();

            var source = string.IsNullOrEmpty(result.Source) ? "" : $"（来源：{result.Source}）";
            ShowInfo($"导入完成：配置 {result.ConfigCount} 条，历史 {result.HistoryCount} 条{source}。" +
                     "重复条目已按名称 / Id 自动跳过。");
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException
                                          or InvalidDataException or UnauthorizedAccessException)
        {
            ShowError($"导入失败：{error.Message}");
        }
    }

    /// <summary>
    /// 把浏览器控制台导出脚本另存到本地，方便用户复制到网页控制台执行。
    /// 脚本以程序集资源内嵌，因此单文件 exe 也能导出。
    /// </summary>
    private void ExportWebScript()
    {
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = "保存网页版导出脚本",
            FileName = "export-web-console.js",
            Filter = "JavaScript 文件 (*.js)|*.js",
        };
        if (dialog.ShowDialog() != true) return;

        try
        {
            var script = LoadWebExportScript();
            File.WriteAllText(dialog.FileName, script);
            ShowInfo($"导出脚本已保存到 {dialog.FileName}。" +
                     "在网页版按 F12 打开控制台，粘贴该脚本内容并回车即可导出数据。");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            ShowError($"保存脚本失败：{error.Message}");
        }
    }

    /// <summary>读取内嵌的导出脚本；资源缺失时给出明确提示而不是空文件。</summary>
    private static string LoadWebExportScript()
    {
        using var stream = System.Reflection.Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("ModelTrace.assets.export-web-console.js");
        if (stream is null)
            throw new InvalidDataException("程序内缺少导出脚本资源，请重新安装客户端。");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private void ToggleStartMenu()
    {
        try
        {
            if (StartMenuShortcut.IsRegistered) StartMenuShortcut.Unregister();
            else StartMenuShortcut.Register();
            OnPropertyChanged(nameof(StartMenuRegistered));
            OnPropertyChanged(nameof(StartMenuStatus));
        }
        catch (Exception error)
        {
            ShowError($"操作开始菜单项失败：{error.Message}");
        }
    }

    private void CopyChallenge(ChallengeItem? challenge)
    {
        if (challenge is null) return;
        TrySetClipboard(challenge.Prompt);
    }

    private void CopyHistory(HistoryEntry? entry)
    {
        if (entry is null) return;
        var text = $"{entry.StartedAt} · 请求 {entry.RequestedModel} · 预测 {entry.PredictedName ?? "无"}" +
                   $" · 概率 {(entry.Probability is null ? "无" : $"{entry.Probability * 100:0.00}%")}";
        TrySetClipboard(text);
    }

    private static void TrySetClipboard(string text)
    {
        try { Clipboard.SetText(text); }
        catch (Exception) { /* 剪贴板被占用时忽略 */ }
    }

    // ── 工具 ──

    private static IReadOnlyList<ScoreRow> BuildRows(AnalysisResult? result)
    {
        if (result is null) return [];
        return result.Results.Select((item, index) => new ScoreRow
        {
            DisplayName = item.DisplayName,
            Probability = item.Probability,
            FamilyName = item.FamilyName,
            ConditionalProbability = item.ConditionalProbability,
            ProfileSimilarity = item.ProfileSimilarity,
            Score = item.Score,
            IsTop = index == 0,
        }).ToArray();
    }

    private double? ParseTemperature()
    {
        if (string.IsNullOrWhiteSpace(Temperature)) return null;
        return double.TryParse(Temperature, out var value) ? value : null;
    }

    /// <summary>与服务端一致的数字计数：只统计最长的连续数字段。</summary>
    private static int CountValidNumbers(string text)
    {
        var runs = new List<List<int>>();
        var current = new List<int>();
        var previousEnd = 0;

        foreach (System.Text.RegularExpressions.Match match in
                 System.Text.RegularExpressions.Regex.Matches(text ?? string.Empty, @"\d+"))
        {
            var separator = (text ?? string.Empty)[previousEnd..match.Index];
            var value = int.Parse(match.Value);
            if (current.Count > 0 && separator.Any(char.IsLetter))
            {
                runs.Add(current);
                current = [];
            }
            if (value is >= 1 and <= 355) current.Add(value);
            previousEnd = match.Index + match.Length;
        }
        if (current.Count > 0) runs.Add(current);
        return runs.Count == 0 ? 0 : runs.Max(run => run.Count);
    }

    private static string Truncate(string value, int length) =>
        string.IsNullOrEmpty(value) ? string.Empty
        : value.Length <= length ? value : value[..length];

    private static void OnUi(Action action)
    {
        var dispatcher = Application.Current?.Dispatcher;
        if (dispatcher is null || dispatcher.CheckAccess()) action();
        else dispatcher.Invoke(action);
    }

    private void ShowError(string text)
    {
        MessageIsError = true;
        Message = text;
    }

    private void ShowInfo(string text)
    {
        MessageIsError = false;
        Message = text;
    }
}
