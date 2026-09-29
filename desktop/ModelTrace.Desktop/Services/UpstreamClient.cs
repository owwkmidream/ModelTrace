using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ModelTrace.Desktop.Services;

/// <summary>上游返回了错误。Status=0 表示连接层失败。</summary>
public sealed class UpstreamException : Exception
{
    public UpstreamException(string message, int status = 0, string body = "") : base(message)
    {
        Status = status;
        Body = body;
    }

    public int Status { get; }
    public string Body { get; }
}

/// <summary>一次格式尝试的进度事件，供界面实时渲染端点卡片。</summary>
public sealed record ProbeAttempt(
    string ApiFormat, int Attempt, int Status, string Body, bool Ok, bool Done, bool Stream);

/// <summary>一次探测的最终结果。</summary>
public sealed record ProbeResult(string Text, string ApiFormat);

/// <summary>
/// 上游 API 客户端。
///
/// 这是 worker/src/index.js 的 C# 移植。之所以能在桌面端直连上游而不需要 Worker：
/// Worker 存在的两条理由都是「浏览器的限制」，桌面程序都不受约束 ——
///   1. Fetch 规范禁止脚本设置 User-Agent；HttpClient 可以自由设置。
///   2. 浏览器受 CORS 限制读不到跨域响应；桌面程序没有 CORS 概念。
/// 因此客户端可直接请求上游，少一跳、无需部署 Worker，且离线也能跑。
/// </summary>
public sealed class UpstreamClient
{
    // 上游 WAF 见到浏览器/Python 的 UA 会直接 403，必须伪装成 Codex 客户端
    private const string DefaultUserAgent =
        "codex-tui/0.156.1 (Windows 10.0.19044; x86_64) WindowsTerminal (codex-tui; 0.156.1)";
    private const string DefaultOriginator = "codex-tui";
    private const string DefaultCodexVersion = "0.156.1";
    private const string CodexBetaFeatures = "prevent_idle_sleep,remote_compaction_v2";

    // 只有这些状态码值得重试；403/404 一类确定性错误立刻换下一种格式
    private static readonly HashSet<int> RetryableStatus = [408, 429, 500, 502, 503, 504];
    // 400/422 表示「参数被拒」：中转站拒绝非流式请求时用这两个码，升级为流式再试
    private static readonly HashSet<int> StreamRequiredStatus = [400, 422];
    private const int MaxAttempts = 3;
    private const int RetryBaseDelayMs = 1000;

    private readonly HttpClient _http;

    public UpstreamClient()
    {
        // 单次请求上限与 Flask 版一致（240s），交给 CancellationToken 控制
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(4) };
    }

    // ── 端点拼接与探测顺序：与 enrollment.py / worker 保持一致 ──

    private static bool IsAbsoluteEndpoint(string normalized) => normalized.EndsWith('#');

    private static string Normalize(string baseUrl) => (baseUrl ?? string.Empty).Trim().TrimEnd('/');

    public static string CompletionUrl(string baseUrl, string apiFormat)
    {
        var normalized = Normalize(baseUrl);
        if (IsAbsoluteEndpoint(normalized)) return normalized[..^1];
        return apiFormat switch
        {
            "anthropic" => normalized.EndsWith("/messages") ? normalized
                : normalized.EndsWith("/v1") ? $"{normalized}/messages"
                : $"{normalized}/v1/messages",
            // Codex 的端点是 {base}/responses，不带 /v1（实测 /v1/responses 一律 403）
            "responses" => normalized.EndsWith("/responses") ? normalized : $"{normalized}/responses",
            _ => normalized.EndsWith("/chat/completions") ? normalized
                : normalized.EndsWith("/v1") ? $"{normalized}/chat/completions"
                : $"{normalized}/v1/chat/completions",
        };
    }

    /// <summary>自动探测顺序：默认 Responses &gt; Anthropic &gt; Chat。</summary>
    public static IReadOnlyList<string> AutoFormats(string baseUrl)
    {
        var normalized = Normalize(baseUrl);
        if (IsAbsoluteEndpoint(normalized)) return [];
        if (normalized.EndsWith("/messages")) return ["anthropic", "responses", "openai"];
        return ["responses", "anthropic", "openai"];
    }

    public static string ModelsUrl(string baseUrl)
    {
        var normalized = Normalize(baseUrl).TrimEnd('#');
        var stripped = normalized.EndsWith("/responses")
            ? normalized[..^"/responses".Length]
            : normalized;
        return stripped.EndsWith("/v1") ? $"{stripped}/models" : $"{stripped}/v1/models";
    }

    // ── 请求体构造：三种格式各自的字段要求 ──

    private static (JsonObject Body, Dictionary<string, string> Headers) BuildRequest(
        string apiFormat, string apiModel, string prompt, double? temperature, string systemPrompt)
    {
        var headers = new Dictionary<string, string>();
        JsonObject body;

        switch (apiFormat)
        {
            case "anthropic":
                body = new JsonObject
                {
                    ["model"] = apiModel,
                    ["max_tokens"] = 4096,
                    ["messages"] = new JsonArray
                    {
                        new JsonObject { ["role"] = "user", ["content"] = prompt },
                    },
                };
                if (!string.IsNullOrEmpty(systemPrompt)) body["system"] = systemPrompt;
                headers["anthropic-version"] = "2023-06-01";
                break;

            case "responses":
                // Codex 的 Responses 端点会校验请求是否来自真实客户端，
                // 缺 client_metadata 时一律返回 codex_access_restricted 403。身份值用随机 UUID 即可。
                var sessionId = Guid.NewGuid().ToString();
                body = new JsonObject
                {
                    ["model"] = apiModel,
                    ["input"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "user",
                            ["content"] = new JsonArray
                            {
                                new JsonObject { ["type"] = "input_text", ["text"] = prompt },
                            },
                        },
                    },
                    ["client_metadata"] = new JsonObject
                    {
                        ["x-codex-installation-id"] = Guid.NewGuid().ToString(),
                        ["x-codex-window-id"] = $"{sessionId}:0",
                        ["session_id"] = sessionId,
                        ["thread_id"] = sessionId,
                        ["turn_id"] = Guid.NewGuid().ToString(),
                    },
                };
                if (!string.IsNullOrEmpty(systemPrompt)) body["instructions"] = systemPrompt;
                headers["originator"] = DefaultOriginator;
                headers["version"] = DefaultCodexVersion;
                headers["x-codex-beta-features"] = CodexBetaFeatures;
                break;

            default:
                var messages = new JsonArray();
                if (!string.IsNullOrEmpty(systemPrompt))
                    messages.Add(new JsonObject { ["role"] = "system", ["content"] = systemPrompt });
                messages.Add(new JsonObject { ["role"] = "user", ["content"] = prompt });
                body = new JsonObject { ["model"] = apiModel, ["messages"] = messages };
                break;
        }

        if (temperature is not null) body["temperature"] = temperature.Value;
        return (body, headers);
    }

    // ── 响应体解析：非流式回整包 JSON，流式回 SSE 帧，两种都要能取 ──

    private static IEnumerable<JsonNode?> IterSseEvents(string raw)
    {
        foreach (var line in raw.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("data:")) continue;
            var data = trimmed[5..].Trim();
            if (data.Length == 0 || data == "[DONE]") continue;
            JsonNode? node;
            try { node = JsonNode.Parse(data); }
            catch (JsonException) { continue; }
            if (node is JsonObject) yield return node;
        }
    }

    /// <summary>把 Responses 的 SSE 帧聚合成一个完整响应对象。</summary>
    private static JsonObject? AggregateResponsesSse(string text)
    {
        JsonObject? fallback = null;
        var deltas = new StringBuilder();
        JsonObject? failure = null;

        foreach (var eventNode in IterSseEvents(text))
        {
            var item = eventNode!.AsObject();
            var type = item["type"]?.GetValue<string>();
            if (type == "response.completed" && item["response"] is JsonObject completed) return completed;
            if (type is "response.failed" or "error" || item["error"] is not null) failure = item;
            if (item["response"] is JsonObject response &&
                response["output"] is JsonArray output && output.Count > 0)
            {
                fallback = response;
            }
            if (type == "response.output_text.delta" && item["delta"] is not null)
                deltas.Append(item["delta"]!.GetValue<string>());
        }

        if (fallback is not null) return fallback;
        if (deltas.Length > 0)
        {
            return new JsonObject
            {
                ["status"] = "completed",
                ["output"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["type"] = "message",
                        ["content"] = new JsonArray
                        {
                            new JsonObject { ["type"] = "output_text", ["text"] = deltas.ToString() },
                        },
                    },
                },
            };
        }
        if (failure is not null)
        {
            var detail = failure["error"] ?? failure;
            var message = detail is JsonObject obj
                ? obj["message"]?.GetValue<string>() ?? detail.ToJsonString()
                : detail.ToJsonString();
            throw new UpstreamException($"上游在流中返回错误：{message}");
        }
        return null;
    }

    /// <summary>聚合 Anthropic 的 SSE 帧。</summary>
    private static JsonObject? AggregateAnthropicSse(string text)
    {
        var parts = new StringBuilder();
        string? stopReason = null;
        var seen = false;

        foreach (var eventNode in IterSseEvents(text))
        {
            var item = eventNode!.AsObject();
            seen = true;
            var type = item["type"]?.GetValue<string>();
            if (type == "error")
            {
                var detail = item["error"];
                var message = detail is JsonObject obj
                    ? obj["message"]?.GetValue<string>() ?? item.ToJsonString()
                    : detail?.ToJsonString() ?? item.ToJsonString();
                throw new UpstreamException($"上游在流中返回错误：{message}");
            }
            if (type == "content_block_delta" && item["delta"] is JsonObject delta &&
                delta["text"] is not null)
            {
                parts.Append(delta["text"]!.GetValue<string>());
            }
            if (type == "message_delta" && item["delta"] is JsonObject messageDelta &&
                messageDelta["stop_reason"] is not null)
            {
                stopReason = messageDelta["stop_reason"]!.GetValue<string>();
            }
        }

        if (!seen) return null;
        // 保留 stop_reason，截断样本才会被 ExtractText 拒收
        var payload = new JsonObject
        {
            ["content"] = new JsonArray
            {
                new JsonObject { ["type"] = "text", ["text"] = parts.ToString() },
            },
        };
        if (stopReason is not null) payload["stop_reason"] = stopReason;
        return payload;
    }

    /// <summary>聚合 OpenAI Chat 的 SSE 帧。</summary>
    private static JsonObject? AggregateOpenAiSse(string text)
    {
        var parts = new StringBuilder();
        string? finishReason = null;
        var seen = false;

        foreach (var eventNode in IterSseEvents(text))
        {
            var item = eventNode!.AsObject();
            seen = true;
            if (item["error"] is not null)
            {
                var detail = item["error"];
                var message = detail is JsonObject obj
                    ? obj["message"]?.GetValue<string>() ?? item.ToJsonString()
                    : detail!.ToJsonString();
                throw new UpstreamException($"上游在流中返回错误：{message}");
            }
            if (item["choices"] is not JsonArray choices || choices.Count == 0) continue;
            if (choices[0] is not JsonObject choice) continue;
            if (choice["delta"] is JsonObject delta && delta["content"] is not null)
                parts.Append(delta["content"]!.GetValue<string>());
            if (choice["finish_reason"] is not null)
                finishReason = choice["finish_reason"]!.GetValue<string>();
        }

        if (!seen) return null;
        var choiceObject = new JsonObject
        {
            ["message"] = new JsonObject { ["content"] = parts.ToString() },
        };
        // 保留 finish_reason，length/content_filter 仍会被 ExtractText 拒收
        if (finishReason is not null) choiceObject["finish_reason"] = finishReason;
        return new JsonObject { ["choices"] = new JsonArray { choiceObject } };
    }

    /// <summary>按响应形态决定解析方式：SSE 走聚合器，整包 JSON 直接解析。</summary>
    private static JsonObject ParseCompletionPayload(string apiFormat, string raw, string? contentType)
    {
        var text = raw.TrimStart();
        if (text.StartsWith('{')) return JsonNode.Parse(text)!.AsObject();

        var header = (contentType ?? string.Empty).ToLowerInvariant();
        if (header.Contains("text/event-stream") || text.StartsWith("data:") || text.StartsWith("event:"))
        {
            var aggregated = apiFormat switch
            {
                "responses" => AggregateResponsesSse(text),
                "anthropic" => AggregateAnthropicSse(text),
                _ => AggregateOpenAiSse(text),
            };
            if (aggregated is not null) return aggregated;
            throw new UpstreamException($"上游返回的流中没有可用事件：{Truncate(raw, 300)}");
        }

        throw new UpstreamException($"上游返回的不是可解析的响应：{Truncate(raw, 300)}");
    }

    /// <summary>从 200 响应里取正文。形状不符或回答被截断时抛错，交由上层换下一种格式。</summary>
    private static string ExtractText(string apiFormat, JsonObject payload)
    {
        switch (apiFormat)
        {
            case "anthropic":
            {
                if (payload["content"] is not JsonArray blocks || blocks.Count == 0)
                    throw new UpstreamException("上游返回中没有 content");
                var stop = payload["stop_reason"]?.GetValue<string>();
                if (stop == "refusal") throw new UpstreamException("模型拒绝生成，本次回答不计入");
                if (stop == "max_tokens") throw new UpstreamException("回答因 max_tokens 截断，本次回答不计入");
                return string.Concat(blocks
                    .OfType<JsonObject>()
                    .Where(b => b["type"]?.GetValue<string>() == "text")
                    .Select(b => b["text"]?.GetValue<string>() ?? string.Empty));
            }

            case "responses":
            {
                if (payload["status"]?.GetValue<string>() == "incomplete")
                {
                    var reason = (payload["incomplete_details"] as JsonObject)?["reason"]?.GetValue<string>()
                        ?? "上游返回不完整";
                    throw new UpstreamException($"回答未正常完成（{reason}），本次回答不计入");
                }
                var content = string.Concat(
                    (payload["output"] as JsonArray ?? [])
                    .OfType<JsonObject>()
                    .Where(b => b["type"]?.GetValue<string>() == "message")
                    .SelectMany(b => (b["content"] as JsonArray ?? []).OfType<JsonObject>())
                    .Where(b => b["type"]?.GetValue<string>() == "output_text")
                    .Select(b => b["text"]?.GetValue<string>() ?? string.Empty));
                if (string.IsNullOrEmpty(content)) throw new UpstreamException("上游返回中没有文本内容");
                return content;
            }

            default:
            {
                if (payload["choices"] is not JsonArray choices || choices.Count == 0)
                    throw new UpstreamException("上游返回中没有 choices");
                var choice = (JsonObject)choices[0]!;
                var content = choice["message"]?["content"];
                var text = content is JsonArray parts
                    ? string.Concat(parts.OfType<JsonObject>().Select(p => p["text"]?.GetValue<string>() ?? string.Empty))
                    : content?.GetValue<string>() ?? string.Empty;
                var finish = choice["finish_reason"]?.GetValue<string>();
                if (finish is "length" or "content_filter")
                    throw new UpstreamException($"回答未正常完成（{finish}），本次回答不计入");
                return text;
            }
        }
    }

    private static string CompactError(int status, string details)
    {
        var text = (details ?? string.Empty).Trim();
        if (text.Length == 0) return $"上游接口返回错误（HTTP {status}）";
        var lowered = text.ToLowerInvariant();
        string[] wafMarkers = ["cloudflare", "just a moment", "cf-ray", "access denied", "attention required"];
        if (wafMarkers.Any(lowered.Contains))
            return "请求被上游网关拦截（Cloudflare/WAF 拦截页）。请确认 base_url 指向 API 端点而非网页地址。";

        try
        {
            var payload = JsonNode.Parse(text)?.AsObject();
            if (payload?["error"] is JsonNode error)
            {
                if (error is JsonObject obj)
                    return obj["message"]?.GetValue<string>() ?? error.ToJsonString();
                return error.GetValue<string>();
            }
        }
        catch (JsonException) { /* 非 JSON，退回截断文本 */ }

        return Truncate(text, 500);
    }

    private static string Truncate(string value, int length) =>
        value.Length <= length ? value : value[..length];

    private static void Log(string message) =>
        System.Diagnostics.Debug.WriteLine($"[UpstreamClient] {message}");

    // ── 单次格式尝试，带重试 ──

    private async Task<string> AttemptFormatAsync(
        string apiFormat,
        string baseUrl, string apiKey, string apiModel, string prompt,
        double? temperature, string systemPrompt,
        Action<ProbeAttempt>? onEvent, CancellationToken cancellation)
    {
        var (body, extraHeaders) = BuildRequest(apiFormat, apiModel, prompt, temperature, systemPrompt);
        var url = CompletionUrl(baseUrl, apiFormat);

        UpstreamException? lastError = null;
        // 是否已升级为流式请求：400/422 或 200+空体说明该站拒绝非流式
        var streaming = false;

        for (var attempt = 1; attempt <= MaxAttempts; attempt += 1)
        {
            // 第 3 次无条件走流式兜底
            if (attempt >= MaxAttempts) streaming = true;
            body["stream"] = streaming;

            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            // 关键：桌面程序可以自由设置 User-Agent，这正是无需 Worker 的原因
            request.Headers.TryAddWithoutValidation("User-Agent", DefaultUserAgent);
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {apiKey}");
            foreach (var (key, value) in extraHeaders)
                request.Headers.TryAddWithoutValidation(key, value);
            if (apiFormat == "anthropic")
                request.Headers.TryAddWithoutValidation("x-api-key", apiKey);

            HttpResponseMessage response;
            try
            {
                response = await _http.SendAsync(request, cancellation).ConfigureAwait(false);
            }
            catch (HttpRequestException error)
            {
                var willRetry = attempt < MaxAttempts;
                var detail = error.Message;
                onEvent?.Invoke(new ProbeAttempt(apiFormat, attempt, 0, detail, false, !willRetry, streaming));
                lastError = new UpstreamException($"无法连接接口：{detail}", 0, detail);
                if (willRetry)
                {
                    await Task.Delay(RetryBaseDelayMs * attempt, cancellation).ConfigureAwait(false);
                    continue;
                }
                throw lastError;
            }
            catch (TaskCanceledException) when (!cancellation.IsCancellationRequested)
            {
                // 超时（而非用户主动取消）
                var willRetry = attempt < MaxAttempts;
                onEvent?.Invoke(new ProbeAttempt(apiFormat, attempt, 0, "请求超时", false, !willRetry, streaming));
                lastError = new UpstreamException("无法连接接口：请求超时");
                if (willRetry)
                {
                    await Task.Delay(RetryBaseDelayMs * attempt, cancellation).ConfigureAwait(false);
                    continue;
                }
                throw lastError;
            }

            using (response)
            {
                var status = (int)response.StatusCode;
                var raw = await response.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false);

                if (!response.IsSuccessStatusCode)
                {
                    var message = CompactError(status, raw);
                    // 400/422 视为「拒绝当前请求形态」：升级为流式重试，而不是立刻换格式
                    var upgrade = !streaming && StreamRequiredStatus.Contains(status) && attempt < MaxAttempts;
                    var willRetry = attempt < MaxAttempts && RetryableStatus.Contains(status);
                    onEvent?.Invoke(new ProbeAttempt(apiFormat, attempt, status, Truncate(raw, 2000),
                        false, !(willRetry || upgrade), streaming));
                    lastError = new UpstreamException($"HTTP {status}: {message}", status, raw);
                    if (upgrade || willRetry)
                    {
                        if (upgrade) streaming = true;
                        await Task.Delay(RetryBaseDelayMs * attempt, cancellation).ConfigureAwait(false);
                        continue;
                    }
                    throw lastError;
                }

                JsonObject payload;
                try
                {
                    payload = ParseCompletionPayload(apiFormat, raw, response.Content.Headers.ContentType?.MediaType);
                }
                catch (UpstreamException error)
                {
                    // 200 也可能是网关的「非流式不支持」回落（空体或 HTML）。升级为流式再试。
                    if (!streaming && attempt < MaxAttempts)
                    {
                        onEvent?.Invoke(new ProbeAttempt(apiFormat, attempt, status, Truncate(raw, 2000),
                            false, false, streaming));
                        streaming = true;
                        await Task.Delay(RetryBaseDelayMs * attempt, cancellation).ConfigureAwait(false);
                        continue;
                    }
                    onEvent?.Invoke(new ProbeAttempt(apiFormat, attempt, status, Truncate(raw, 2000),
                        false, true, streaming));
                    throw new UpstreamException(error.Message, status, raw);
                }

                // ok 事件在拿到可解析正文后才推，避免「200 但空体」被当作成功
                var text = ExtractText(apiFormat, payload);
                onEvent?.Invoke(new ProbeAttempt(apiFormat, attempt, status, string.Empty, true, true, streaming));
                return text;
            }
        }

        throw lastError ?? new UpstreamException("上游请求失败");
    }

    /// <summary>
    /// 探测：按顺序尝试各种格式，第一个成功的胜出。
    /// preferredFormat 由调用方带入上次成功的格式，避免每个挑战重探三个端点。
    /// </summary>
    public async Task<ProbeResult> ProbeAsync(
        string baseUrl, string apiKey, string apiModel, string prompt,
        double? temperature, string systemPrompt,
        string? preferredFormat, Action<ProbeAttempt>? onEvent,
        CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(apiKey) ||
            string.IsNullOrWhiteSpace(apiModel))
        {
            throw new UpstreamException("缺少 base_url / api_key / api_model");
        }

        var ordered = AutoFormats(baseUrl);
        var formats = preferredFormat is not null && ordered.Contains(preferredFormat)
            ? new[] { preferredFormat }.Concat(ordered.Where(f => f != preferredFormat)).ToArray()
            : ordered.ToArray();

        if (formats.Length == 0)
        {
            // 末尾带 # = 用户已给出完整端点，只按 OpenAI 兼容格式请求一次
            var text = await AttemptFormatAsync("openai", baseUrl, apiKey, apiModel, prompt,
                temperature, systemPrompt, onEvent, cancellation).ConfigureAwait(false);
            return new ProbeResult(text, "openai");
        }

        var errors = new List<string>();
        foreach (var apiFormat in formats)
        {
            onEvent?.Invoke(new ProbeAttempt(apiFormat, 0, 0, string.Empty, false, false, false));
            try
            {
                var text = await AttemptFormatAsync(apiFormat, baseUrl, apiKey, apiModel, prompt,
                    temperature, systemPrompt, onEvent, cancellation).ConfigureAwait(false);
                return new ProbeResult(text, apiFormat);
            }
            catch (UpstreamException error)
            {
                errors.Add($"{apiFormat}: {error.Message}");
            }
        }

        throw new UpstreamException($"接口格式自动探测失败；{string.Join("；", errors)}");
    }

    /// <summary>拉取上游模型列表，供模型名自动补全。</summary>
    public async Task<IReadOnlyList<string>> ListModelsAsync(
        string baseUrl, string apiKey, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) throw new UpstreamException("请先填写 Base URL");

        using var request = new HttpRequestMessage(HttpMethod.Get, ModelsUrl(baseUrl));
        request.Headers.TryAddWithoutValidation("User-Agent", DefaultUserAgent);
        request.Headers.TryAddWithoutValidation("Accept", "application/json");
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {apiKey}");

        using var response = await _http.SendAsync(request, cancellation).ConfigureAwait(false);
        var raw = await response.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new UpstreamException($"HTTP {(int)response.StatusCode}: {CompactError((int)response.StatusCode, raw)}",
                (int)response.StatusCode, raw);

        var payload = JsonNode.Parse(raw)?.AsObject();
        var items = payload?["data"] as JsonArray ?? payload?["models"] as JsonArray;
        if (items is null) throw new UpstreamException("上游返回中没有模型列表");

        return items
            .Select(item => item is JsonObject obj
                ? obj["id"]?.GetValue<string>() ?? obj["name"]?.GetValue<string>()
                : null)
            .Where(id => !string.IsNullOrEmpty(id))
            .Select(id => id!)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();
    }
}
