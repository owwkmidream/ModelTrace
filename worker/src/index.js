/**
 * ModelTrace API 代理 Worker
 *
 * 存在的唯一理由：浏览器是"客户端"，有两件事做不到，只能由服务端代劳：
 *   1. 设置 User-Agent —— Fetch 规范把它列为 forbidden header，脚本改不了；
 *      而上游 WAF 见到浏览器/Python 的 UA 会直接 403（见 enrollment.py 的说明）。
 *   2. 跨域读响应 —— 上游不返回 Access-Control-Allow-Origin，fetch 拿不到响应体。
 *
 * 因此这里刻意只做"薄代理"：转发探测请求、透传 SSE、补 CORS 头。
 * 归因评分、历史记录、指纹库都留在浏览器（fingerprint-core.js 已与 Python 版对齐），
 * 避免把算法实现再抄成第三份。
 */

const DEFAULT_UPSTREAM_USER_AGENT =
  "codex-tui/0.156.1 (Windows 10.0.19044; x86_64) WindowsTerminal (codex-tui; 0.156.1)";
const DEFAULT_ORIGINATOR = "codex-tui";
const DEFAULT_CODEX_VERSION = "0.156.1";
const CODEX_BETA_FEATURES = "prevent_idle_sleep,remote_compaction_v2";

// 只有这些状态码值得重试；404/403 一类确定性错误立刻换下一种格式
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

// ── 端点拼接与探测顺序：与 enrollment.py 保持一致 ──

function isAbsoluteEndpoint(normalized) {
  return normalized.endsWith("#");
}

function completionUrl(baseUrl, apiFormat) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (isAbsoluteEndpoint(normalized)) return normalized.slice(0, -1);
  if (apiFormat === "anthropic") {
    if (normalized.endsWith("/messages")) return normalized;
    if (normalized.endsWith("/v1")) return `${normalized}/messages`;
    return `${normalized}/v1/messages`;
  }
  if (apiFormat === "responses") {
    // Codex 的端点是 {base}/responses，不带 /v1（实测 /v1/responses 一律 403）
    if (normalized.endsWith("/responses")) return normalized;
    return `${normalized}/responses`;
  }
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function autoFormats(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (isAbsoluteEndpoint(normalized)) return [];
  if (normalized.endsWith("/messages")) return ["anthropic", "responses", "openai"];
  // 默认顺序 Responses > Anthropic > Chat
  return ["responses", "anthropic", "openai"];
}

function modelsUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/#$/, "");
  const stripped = normalized.endsWith("/responses") ? normalized.slice(0, -"/responses".length) : normalized;
  return stripped.endsWith("/v1") ? `${stripped}/models` : `${stripped}/v1/models`;
}

// ── 请求体构造：三种格式各自的字段要求 ──

function buildRequest(apiFormat, apiModel, prompt, temperature, systemPrompt) {
  if (apiFormat === "anthropic") {
    const body = {
      model: apiModel,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    };
    if (systemPrompt) body.system = systemPrompt;
    return {
      body,
      headers: {
        "x-api-key": "",   // 由调用方填入
        "anthropic-version": "2023-06-01",
      },
    };
  }
  if (apiFormat === "responses") {
    // Codex 的 Responses 端点会校验请求是否来自真实客户端，缺 client_metadata 时
    // 一律返回 codex_access_restricted 403。身份值用随机 UUID 即可。
    const sessionId = crypto.randomUUID();
    const body = {
      model: apiModel,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      client_metadata: {
        "x-codex-installation-id": crypto.randomUUID(),
        "x-codex-window-id": `${sessionId}:0`,
        session_id: sessionId,
        thread_id: sessionId,
        turn_id: crypto.randomUUID(),
      },
    };
    if (systemPrompt) body.instructions = systemPrompt;
    return {
      body,
      headers: {
        originator: DEFAULT_ORIGINATOR,
        version: DEFAULT_CODEX_VERSION,
        "x-codex-beta-features": CODEX_BETA_FEATURES,
      },
    };
  }
  const body = { model: apiModel, messages: [] };
  if (systemPrompt) body.messages.push({ role: "system", content: systemPrompt });
  body.messages.push({ role: "user", content: prompt });
  return { body, headers: {} };
}

// ── 响应体解析：Responses 端点即使 stream=false 也可能回 SSE 帧 ──

function parseResponsesBody(raw) {
  const text = raw.replace(/^\s+/, "");
  if (text.startsWith("{")) return JSON.parse(text);
  let fallback = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "response.completed") return event.response;
    if (event.response && Array.isArray(event.response.output) && event.response.output.length) {
      fallback = event.response;
    }
  }
  if (fallback) return fallback;
  throw new Error(`上游返回的不是可解析的 Responses 响应：${raw.slice(0, 300)}`);
}

/** 从 200 响应里取正文。形状不符或回答被截断时抛错，交由上层换下一种格式。 */
function extractText(apiFormat, payload) {
  if (apiFormat === "anthropic") {
    const blocks = payload && payload.content;
    if (!Array.isArray(blocks) || !blocks.length) throw new Error("上游返回中没有 content");
    const stop = payload.stop_reason;
    if (stop === "refusal") throw new Error("模型拒绝生成，本次回答不计入");
    if (stop === "max_tokens") throw new Error("回答因 max_tokens 截断，本次回答不计入");
    return blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
  }
  if (apiFormat === "responses") {
    if (payload && payload.status === "incomplete") {
      const reason = (payload.incomplete_details || {}).reason || "上游返回不完整";
      throw new Error(`回答未正常完成（${reason}），本次回答不计入`);
    }
    const content = (payload && payload.output ? payload.output : [])
      .filter((b) => b && b.type === "message")
      .flatMap((b) => b.content || [])
      .filter((b) => b && b.type === "output_text")
      .map((b) => b.text || "")
      .join("");
    if (!content) throw new Error("上游返回中没有文本内容");
    return content;
  }
  const choices = payload && payload.choices;
  if (!Array.isArray(choices) || !choices.length) throw new Error("上游返回中没有 choices");
  const choice = choices[0];
  let content = choice.message ? choice.message.content : "";
  if (Array.isArray(content)) content = content.map((p) => (p && p.text) || "").join("");
  if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") {
    throw new Error(`回答未正常完成（${choice.finish_reason}），本次回答不计入`);
  }
  return String(content);
}

function compactError(status, details) {
  const text = String(details || "").trim();
  if (!text) return `上游接口返回错误（HTTP ${status}）`;
  const lowered = text.toLowerCase();
  if (["cloudflare", "just a moment", "cf-ray", "access denied", "attention required"].some((m) => lowered.includes(m))) {
    return "请求被上游网关拦截（Cloudflare/WAF 拦截页）。请确认 base_url 指向 API 端点而非网页地址。";
  }
  try {
    const payload = JSON.parse(text);
    if (payload && payload.error) {
      if (typeof payload.error === "object") return String(payload.error.message || JSON.stringify(payload.error));
      return String(payload.error);
    }
  } catch {
    /* 非 JSON，退回截断文本 */
  }
  return text.slice(0, 500);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 单次格式尝试，带重试。通过 emit 把每次尝试的进度推给 SSE 消费端。
 * 返回正文；失败时抛 Error（带 status/body 供前端留档）。
 */
async function attemptFormat(apiFormat, options, emit) {
  const { baseUrl, apiKey, apiModel, prompt, temperature, systemPrompt } = options;
  const { body, headers: extraHeaders } = buildRequest(
    apiFormat, apiModel, prompt, temperature, systemPrompt,
  );
  if (temperature !== null && temperature !== undefined) body.temperature = temperature;

  const url = completionUrl(baseUrl, apiFormat);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    // 关键：Worker 是服务端，才能设得动这个头
    "User-Agent": DEFAULT_UPSTREAM_USER_AGENT,
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };
  if (apiFormat === "anthropic") headers["x-api-key"] = apiKey;
  const payloadText = JSON.stringify(body);

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body: payloadText });
    } catch (error) {
      const willRetry = attempt < MAX_ATTEMPTS;
      emit({ phase: "attempt", api_format: apiFormat, attempt, status: 0,
        body: String(error && error.message || error), ok: false, done: !willRetry });
      lastError = new Error(`无法连接接口：${error && error.message || error}`);
      lastError.status = 0;
      lastError.body = String(error && error.message || error);
      if (willRetry) { await sleep(RETRY_BASE_DELAY_MS * attempt); continue; }
      throw lastError;
    }

    const raw = await response.text();
    if (!response.ok) {
      const message = compactError(response.status, raw);
      const willRetry = attempt < MAX_ATTEMPTS && RETRYABLE_STATUS.has(response.status);
      emit({ phase: "attempt", api_format: apiFormat, attempt, status: response.status,
        body: raw.slice(0, 2000), ok: false, done: !willRetry });
      lastError = new Error(`HTTP ${response.status}: ${message}`);
      lastError.status = response.status;
      lastError.body = raw;
      if (willRetry) { await sleep(RETRY_BASE_DELAY_MS * attempt); continue; }
      throw lastError;
    }

    emit({ phase: "attempt", api_format: apiFormat, attempt, status: response.status,
      body: "", ok: true, done: true });
    const payload = apiFormat === "responses" ? parseResponsesBody(raw) : JSON.parse(raw);
    return extractText(apiFormat, payload);
  }
  throw lastError || new Error("上游请求失败");
}

/**
 * 探测流：按顺序尝试各种格式，第一个成功的胜出。
 * 事件形状与 Flask 版 /api/test/probe/stream 完全一致，前端可以共用一套渲染逻辑。
 */
function probeStream(payload, writer) {
  const encoder = new TextEncoder();
  const emit = (event) => writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  const options = {
    baseUrl: payload.base_url,
    apiKey: payload.api_key,
    apiModel: payload.api_model,
    prompt: payload.prompt,
    temperature: payload.temperature === "" || payload.temperature === undefined ? null : payload.temperature,
    systemPrompt: payload.system_prompt || "",
  };

  return (async () => {
    // 前端会把上次探测成功的格式带上来：把它提到最前，避免每个挑战重探三个端点
    const ordered = autoFormats(options.baseUrl);
    const preferred = payload.preferred_format;
    const formats = preferred && ordered.includes(preferred)
      ? [preferred, ...ordered.filter((item) => item !== preferred)]
      : ordered;
    if (!formats.length) {
      // 末尾带 # = 用户已给出完整端点，只按 OpenAI 兼容格式请求一次
      try {
        const text = await attemptFormat("openai", options, emit);
        emit({ phase: "result", text, api_format: "openai" });
      } catch (error) {
        emit({ phase: "result", error: String(error.message), status: error.status ?? 0, body: error.body || "" });
      }
      return;
    }

    const errors = [];
    for (const apiFormat of formats) {
      emit({ phase: "probe_start", api_format: apiFormat });
      try {
        const text = await attemptFormat(apiFormat, options, emit);
        emit({ phase: "probe_end", api_format: apiFormat, ok: true });
        emit({ phase: "result", text, api_format: apiFormat });
        return;
      } catch (error) {
        errors.push(`${apiFormat}: ${error.message}`);
        emit({ phase: "probe_end", api_format: apiFormat, ok: false });
      }
    }
    emit({ phase: "result", error: `接口格式自动探测失败；${errors.join("；")}`, status: 0, body: "" });
  })()
    .catch((error) => {
      emit({ phase: "result", error: String(error && error.message || error), status: 0, body: "" });
    })
    .finally(() => writer.close());
}

async function handleProbe(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }
  if (!payload.base_url || !payload.api_key || !payload.api_model || !payload.prompt) {
    return json({ error: "缺少 base_url / api_key / api_model / prompt" }, 400);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  // 不 await：流式响应必须立刻返回，工作在线程里持续推进
  probeStream(payload, writer);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

async function handleModels(request) {
  const url = new URL(request.url);
  const baseUrl = (url.searchParams.get("base_url") || "").trim();
  const apiKey = url.searchParams.get("api_key") || "";
  if (!baseUrl) return json({ error: "请先填写 Base URL", models: [] }, 400);
  try {
    const response = await fetch(modelsUrl(baseUrl), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": DEFAULT_UPSTREAM_USER_AGENT,
      },
    });
    const raw = await response.text();
    if (!response.ok) {
      return json({ error: `HTTP ${response.status}: ${compactError(response.status, raw)}`, status: response.status, body: raw, models: [] }, 502);
    }
    const payload = JSON.parse(raw);
    const items = payload.data ?? payload.models;
    if (!Array.isArray(items)) {
      return json({ error: "上游返回中没有模型列表", models: [] }, 502);
    }
    const models = items
      .map((item) => (item && (item.id || item.name)) || null)
      .filter(Boolean)
      .map(String)
      .sort();
    return json({ models });
  } catch (error) {
    return json({ error: `无法连接接口：${error && error.message || error}`, models: [] }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/api/probe") {
      if (request.method !== "POST") return json({ error: "请用 POST" }, 405);
      return handleProbe(request);
    }
    if (url.pathname === "/api/models") {
      return handleModels(request);
    }
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "modeltrace-proxy" });
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "未知接口" }, 404);
    }
    // 其余交给静态资源：同一个 Worker 同时托管页面与代理
    return env.ASSETS.fetch(request);
  },
};
