/**
 * ModelTrace Worker 薄代理的测试。
 *
 * 重点验证三件事：
 *   1. 三种格式的端点拼接与探测顺序（最容易写错、且错了就打不到上游）
 *   2. 每次尝试都会推 SSE 事件，且事件形状与 Flask 版一致（前端共用一套渲染）
 *   3. CORS 与 User-Agent 确实被设置（这个方案存在的理由）
 *
 * 通过 stub 掉 globalThis.fetch 来捕获 Worker 发出的上游请求，不真的联网。
 */

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const UA_EXPECTED = "codex-tui/0.156.1 (Windows 10.0.19044; x86_64) WindowsTerminal (codex-tui; 0.156.1)";
// 单次退避上限 1s * attempt(3) + 抖动，给足余量
const RETRY_BUDGET_MS = 5000;

/** 收集 Worker 产生的上游请求；responder 决定每个请求怎么回 */
function withUpstream(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function sseResponse(frames) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 读出 SSE 响应里的全部事件 */
async function readEvents(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5).trim()));
}

function probeRequest(body) {
  return new Request("https://worker.test/api/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_url: "https://relay.example",
      api_key: "sk-test",
      api_model: "gpt-x",
      prompt: "list numbers",
      expected_count: 100,
      ...body,
    }),
  });
}

test("端点拼接：三种格式各自的路径规则", async () => {
  const cases = [
    ["https://relay.example", "openai", "https://relay.example/v1/chat/completions"],
    ["https://relay.example/v1", "openai", "https://relay.example/v1/chat/completions"],
    ["https://relay.example/v1/chat/completions", "openai", "https://relay.example/v1/chat/completions"],
    ["https://relay.example", "anthropic", "https://relay.example/v1/messages"],
    ["https://relay.example/v1", "anthropic", "https://relay.example/v1/messages"],
    ["https://relay.example/v1/messages", "anthropic", "https://relay.example/v1/messages"],
    // Codex 的 Responses 端点不带 /v1（实测 /v1/responses 一律 403）
    ["https://relay.example", "responses", "https://relay.example/responses"],
    ["https://relay.example/v1", "responses", "https://relay.example/v1/responses"],
    ["https://relay.example/responses", "responses", "https://relay.example/responses"],
    // 末尾 # = 用户已给出完整端点，原样使用
    ["https://relay.example/custom#", "openai", "https://relay.example/custom"],
  ];
  for (const [base, format, expected] of cases) {
    const upstream = withUpstream(() => new Response(
      JSON.stringify({ choices: [{ message: { content: "1 2 3" }, finish_reason: "stop" }] }),
      { status: 200 },
    ));
    try {
      const response = await worker.fetch(probeRequest({
        base_url: base,
        preferred_format: format,
      }), {});
      await response.text();
      const hit = upstream.calls.find((call) => call.url.includes("relay.example"));
      assert.equal(hit.url, expected, `${base} + ${format}`);
    } finally {
      upstream.restore();
    }
  }
});

test("探测顺序：默认 Responses > Anthropic > Chat", async () => {
  const upstream = withUpstream(() => new Response("nope", { status: 404 }));
  try {
    const response = await worker.fetch(probeRequest(), {});
    const events = await readEvents(response);
    const started = events.filter((event) => event.phase === "probe_start").map((event) => event.api_format);
    assert.deepEqual(started, ["responses", "anthropic", "openai"]);
  } finally {
    upstream.restore();
  }
});

test("preferred_format 提到最前，避免每个挑战重探三个端点", async () => {
  const upstream = withUpstream(() => new Response("nope", { status: 404 }));
  try {
    const response = await worker.fetch(probeRequest({ preferred_format: "anthropic" }), {});
    const events = await readEvents(response);
    const started = events.filter((event) => event.phase === "probe_start").map((event) => event.api_format);
    assert.deepEqual(started, ["anthropic", "responses", "openai"]);
  } finally {
    upstream.restore();
  }
});

test("每次尝试推一条 attempt 事件，可重试状态码会重试到上限", async (t) => {
  // 重试之间有退避 sleep：用假定时器跳过等待，避免测试真的耗上 9 秒
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // 429 属于可重试状态码：responses 应该重试满 3 次后才换下一个格式
  const upstream = withUpstream(() => new Response('{"error":"rate limited"}', { status: 429 }));
  try {
    const pending = worker.fetch(probeRequest(), {}).then((response) => readEvents(response));
    // 反复推进定时器，直到退避 sleep 全部走完、Promise 落定
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let index = 0; index < 50 && !settled; index += 1) {
      t.mock.timers.tick(RETRY_BUDGET_MS);
      await Promise.resolve();
    }
    const events = await pending;
    const responses = events.filter(
      (event) => event.phase === "attempt" && event.api_format === "responses",
    );
    assert.equal(responses.length, 3, "429 应重试满 3 次");
    assert.deepEqual(responses.map((event) => event.attempt), [1, 2, 3]);
    assert.equal(responses[0].done, false, "前两次未终结");
    assert.equal(responses[2].done, true, "最后一次终结");
    assert.ok(responses.every((event) => event.status === 429));
    assert.ok(responses.every((event) => event.body.includes("rate limited")), "保留响应体供前端留档");
  } finally {
    upstream.restore();
    t.mock.timers.reset();
  }
});

test("确定性错误不重试：404 只试一次就换下一种格式", async () => {
  const upstream = withUpstream(() => new Response('{"error":"no such route"}', { status: 404 }));
  try {
    const response = await worker.fetch(probeRequest(), {});
    const events = await readEvents(response);
    const responses = events.filter(
      (event) => event.phase === "attempt" && event.api_format === "responses",
    );
    assert.equal(responses.length, 1, "404 不应重试");
    assert.equal(responses[0].done, true);
  } finally {
    upstream.restore();
  }
});

test("首个成功的格式胜出，并给出 result 帧", async () => {
  const upstream = withUpstream((url) => {
    if (url.includes("/responses")) return new Response("nope", { status: 404 });
    // Anthropic 命中
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "7 8 9" }],
      stop_reason: "end_turn",
    }), { status: 200 });
  });
  try {
    const response = await worker.fetch(probeRequest(), {});
    const events = await readEvents(response);
    const result = events.find((event) => event.phase === "result");
    assert.equal(result.api_format, "anthropic");
    assert.equal(result.text, "7 8 9");
    // 命中后不应再试 Chat
    const started = events.filter((event) => event.phase === "probe_start").map((event) => event.api_format);
    assert.deepEqual(started, ["responses", "anthropic"]);
  } finally {
    upstream.restore();
  }
});

test("全部失败时 result 帧带错误与逐格式原因", async () => {
  const upstream = withUpstream(() => new Response('{"error":"boom"}', { status: 403 }));
  try {
    const response = await worker.fetch(probeRequest(), {});
    const events = await readEvents(response);
    const result = events.find((event) => event.phase === "result");
    assert.ok(result.error.includes("接口格式自动探测失败"));
    assert.ok(result.error.includes("responses"));
    assert.ok(result.error.includes("anthropic"));
    assert.ok(result.error.includes("openai"));
  } finally {
    upstream.restore();
  }
});

test("上游请求带上伪装 User-Agent 与各格式的必需头", async () => {
  const upstream = withUpstream(() => new Response("nope", { status: 404 }));
  try {
    await (await worker.fetch(probeRequest({ preferred_format: "responses" }), {})).text();
    const headers = new Headers(upstream.calls[0].init.headers);
    assert.equal(headers.get("User-Agent"), UA_EXPECTED, "必须伪装 UA，否则上游 WAF 403");
    assert.equal(headers.get("originator"), "codex-tui");
    assert.equal(headers.get("Authorization"), "Bearer sk-test");
  } finally {
    upstream.restore();
  }
});

test("Responses 请求体带 client_metadata，否则上游返回 403", async () => {
  const upstream = withUpstream(() => new Response("nope", { status: 404 }));
  try {
    await (await worker.fetch(probeRequest({ preferred_format: "responses" }), {})).text();
    const body = JSON.parse(upstream.calls[0].init.body);
    assert.ok(body.client_metadata, "缺 client_metadata 会拿到 codex_access_restricted");
    assert.ok(body.client_metadata["x-codex-installation-id"]);
    assert.equal(body.client_metadata.session_id, body.client_metadata.thread_id);
    assert.equal(body.input[0].content[0].type, "input_text");
  } finally {
    upstream.restore();
  }
});

test("Responses 端点的 SSE 帧也能解析出正文", async () => {
  const upstream = withUpstream(() => new Response(
    'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"4 5 6"}]}]}}\n\n',
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  ));
  try {
    const response = await worker.fetch(probeRequest({ preferred_format: "responses" }), {});
    const events = await readEvents(response);
    const result = events.find((event) => event.phase === "result");
    assert.equal(result.text, "4 5 6");
  } finally {
    upstream.restore();
  }
});

test("回答被截断时不计入，并继续尝试下一种格式", async () => {
  const upstream = withUpstream((url) => {
    if (url.includes("/responses")) {
      return new Response(JSON.stringify({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "1 1 1" }],
      stop_reason: "end_turn",
    }), { status: 200 });
  });
  try {
    const response = await worker.fetch(probeRequest(), {});
    const events = await readEvents(response);
    const result = events.find((event) => event.phase === "result");
    assert.equal(result.api_format, "anthropic", "截断的 responses 应被跳过");
  } finally {
    upstream.restore();
  }
});

test("CORS 预检返回 204 且带允许头", async () => {
  const response = await worker.fetch(new Request("https://worker.test/api/probe", { method: "OPTIONS" }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.ok(response.headers.get("Access-Control-Allow-Headers").includes("Content-Type"));
});

test("探测响应带 CORS 头，浏览器才能读流", async () => {
  const upstream = withUpstream(() => new Response("nope", { status: 404 }));
  try {
    const response = await worker.fetch(probeRequest(), {});
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.ok(response.headers.get("Content-Type").includes("text/event-stream"));
    await response.text();
  } finally {
    upstream.restore();
  }
});

test("缺少必填字段返回 400", async () => {
  const response = await worker.fetch(new Request("https://worker.test/api/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: "https://relay.example" }),
  }), {});
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.error.includes("缺少"));
});

test("/api/models 拉取模型列表并排序", async () => {
  const upstream = withUpstream(() => new Response(
    JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { name: "m-model" }] }),
    { status: 200 },
  ));
  try {
    const response = await worker.fetch(
      new Request("https://worker.test/api/models?base_url=https://relay.example/v1&api_key=k"),
      {},
    );
    const payload = await response.json();
    assert.deepEqual(payload.models, ["a-model", "m-model", "z-model"]);
  } finally {
    upstream.restore();
  }
});

test("/api/models 对上错误返回 502 并带响应体", async () => {
  const upstream = withUpstream(() => new Response('{"error":"invalid key"}', { status: 401 }));
  try {
    const response = await worker.fetch(
      new Request("https://worker.test/api/models?base_url=https://relay.example&api_key=bad"),
      {},
    );
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.status, 401);
    assert.ok(payload.body.includes("invalid key"));
    assert.deepEqual(payload.models, []);
  } finally {
    upstream.restore();
  }
});

test("静态资源交给 ASSETS 绑定，未知 /api 返回 404", async () => {
  let assetsHit = null;
  const env = {
    ASSETS: { fetch: async (request) => { assetsHit = request.url; return new Response("page"); } },
  };
  const page = await worker.fetch(new Request("https://worker.test/"), env);
  assert.equal(await page.text(), "page");
  assert.ok(assetsHit.endsWith("/"));

  const missing = await worker.fetch(new Request("https://worker.test/api/nope"), env);
  assert.equal(missing.status, 404);
  assert.equal(assetsHit.endsWith("/"), true, "未知 /api 不应落到静态资源");
});
