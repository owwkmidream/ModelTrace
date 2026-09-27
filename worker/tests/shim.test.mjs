/**
 * 浏览器垫片的测试。
 *
 * 垫片负责把 app.js 的 Flask 式调用接到"本地算 + Worker 代理"上，
 * 出错方式都很隐蔽（帧被 chunk 切坏、缓存键冲突、501 被当成成功），
 * 所以用桩把它的行为钉死。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { installApiShim, formatCacheKey } from "../assets/api-shim.js";

/** 最小 localStorage 桩 */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map,
  };
}

const BANK = {
  models: [
    { id: "gpt-a", display_name: "gpt-a", family: "gpt", family_name: "GPT", response_count: 3, valid_number_count: 100 },
    { id: "claude-b", display_name: "claude-b", family: "claude", family_name: "Claude", response_count: 3, valid_number_count: 100 },
  ],
  calibration: {},
  robust: {},
};

function makeWin({ upstream = async () => new Response("{}", { status: 200 }) } = {}) {
  return {
    localStorage: fakeStorage(),
    fetch: upstream,
  };
}

/** 造一个 SSE 响应，frames 为事件数组 */
function sseResponse(frames) {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function readEvents(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.includes("data:"))
    .map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5).trim()));
}

function setup(options = {}) {
  const deps = {
    win: makeWin(options),
    analyzeGlobalOutputs: options.analyzeGlobalOutputs || (() => ({ prediction_name: "gpt-a", results: [] })),
    parseNumbers: options.parseNumbers || ((text) => String(text).match(/\d+/g) || []),
    generateChallenges: options.generateChallenges || (() => [{ id: "c1", expected_count: 100, prompt: "p" }]),
    bank: options.bank || BANK,
    bankSummary: options.bankSummary || (() => ({ id: "unified", model_count: 2 })),
  };
  installApiShim(deps);
  return deps;
}

test("本地接口不出网络：challenges 与 analyze 都在浏览器算", async () => {
  let networkCalls = 0;
  const deps = setup({ upstream: async () => { networkCalls += 1; return new Response("{}"); } });

  const challenges = await deps.win.fetch("/api/challenges");
  assert.equal((await challenges.json()).challenges.length, 1);

  const analyzed = await deps.win.fetch("/api/analyze", {
    method: "POST",
    body: JSON.stringify({ outputs: [] }),
  });
  assert.equal((await analyzed.json()).prediction_name, "gpt-a");

  assert.equal(networkCalls, 0, "本地能算的接口不应发出网络请求");
});

test("analyze 失败返回 400 与错误文本", async () => {
  const deps = setup({
    analyzeGlobalOutputs: () => { throw new Error("没有可用回答"); },
  });
  const response = await deps.win.fetch("/api/analyze", { method: "POST", body: JSON.stringify({ outputs: [] }) });
  assert.equal(response.status, 400);
  assert.ok((await response.json()).error.includes("没有可用回答"));
});

test("需要服务端存储的接口明确回 501，不假装成功", async () => {
  const deps = setup();
  const enroll = await deps.win.fetch("/api/enroll/auto", { method: "POST", body: "{}" });
  assert.equal(enroll.status, 501, "采集指纹必须如实告知不支持");
  assert.ok((await enroll.json()).error.includes("自托管"));

  const createBank = await deps.win.fetch("/api/banks", { method: "POST", body: JSON.stringify({ label: "x" }) });
  assert.equal(createBank.status, 501);
});

test("探测请求转发给 Worker 并带上 base_url/api_key", async () => {
  let seen = null;
  const deps = setup({
    upstream: async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body), method: init.method };
      return sseResponse([{ phase: "result", text: "1 2 3", api_format: "openai" }]);
    },
  });
  await deps.win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example", api_key: "k", api_model: "m", prompt: "p", expected_count: 100 }),
  });
  assert.equal(seen.url, "/api/probe");
  assert.equal(seen.method, "POST");
  assert.equal(seen.body.base_url, "https://r.example");
  assert.equal(seen.body.api_key, "k");
});

test("result 帧补上验收字段：有效数字、阈值、是否计入", async () => {
  const deps = setup();
  const deps2 = { ...deps };
  // 120 个数字，expected 100 -> 阈值 80，应计入
  const text = Array.from({ length: 120 }, (_, i) => (i % 355) + 1).join(" ");
  const win = makeWin({
    upstream: async () => sseResponse([{ phase: "result", text, api_format: "openai" }]),
  });
  installApiShim({ ...deps2, win });
  const response = await win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example", api_key: "k", api_model: "m", prompt: "p", expected_count: 100 }),
  });
  const events = await readEvents(response);
  const result = events.find((event) => event.phase === "result");
  assert.equal(result.parsed_numbers, 120);
  assert.equal(result.minimum_numbers, 80);
  assert.equal(result.accepted, true);
});

test("数字不足时 accepted 为 false", async () => {
  const deps = setup();
  const win = makeWin({
    upstream: async () => sseResponse([{ phase: "result", text: "1 2 3", api_format: "openai" }]),
  });
  installApiShim({ ...deps, win });
  const response = await win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example", api_key: "k", api_model: "m", prompt: "p", expected_count: 100 }),
  });
  const result = (await readEvents(response)).find((event) => event.phase === "result");
  assert.equal(result.accepted, false);
  assert.equal(result.minimum_numbers, 80);
});

test("attempt 事件原样透传，前端才能实时刷新端点卡片", async () => {
  const deps = setup();
  const win = makeWin({
    upstream: async () => sseResponse([
      { phase: "probe_start", api_format: "responses" },
      { phase: "attempt", api_format: "responses", attempt: 1, status: 503, body: "boom", ok: false, done: false },
      { phase: "attempt", api_format: "responses", attempt: 2, status: 200, ok: true, done: true },
      { phase: "probe_end", api_format: "responses", ok: true },
      { phase: "result", text: "1", api_format: "responses" },
    ]),
  });
  installApiShim({ ...deps, win });
  const response = await win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example", api_key: "k", api_model: "m", prompt: "p", expected_count: 100 }),
  });
  const events = await readEvents(response);
  assert.deepEqual(events.map((event) => event.phase), [
    "probe_start", "attempt", "attempt", "probe_end", "result",
  ]);
  assert.equal(events[1].status, 503);
  assert.equal(events[1].body, "boom");
});

test("命中的 api_format 写入本地缓存，下次探测带上 preferred_format", async () => {
  const deps = setup();
  const win = makeWin({
    upstream: async () => sseResponse([{ phase: "result", text: "1", api_format: "anthropic" }]),
  });
  installApiShim({ ...deps, win });
  const request = () => win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example", api_key: "k", api_model: "m", prompt: "p", expected_count: 100 }),
  });
  await readEvents(await request());

  const key = formatCacheKey("https://r.example", "k");
  assert.equal(win.localStorage.getItem(key), "anthropic", "应记住命中的格式");

  let second = null;
  win.fetch = (async (url, init) => {
    second = JSON.parse(init.body);
    return sseResponse([{ phase: "result", text: "1", api_format: "anthropic" }]);
  });
  // 重新装一次垫片，让它用新的上游桩
  installApiShim({ ...deps, win });
  await readEvents(await request());
  assert.equal(second.preferred_format, "anthropic", "第二次应带上缓存的格式");
});

test("缓存键不含 API Key 明文", async () => {
  const key = formatCacheKey("https://r.example", "sk-super-secret");
  assert.ok(!key.includes("sk-super-secret"), "本地缓存键不得泄漏密钥");
  assert.notEqual(key, formatCacheKey("https://r.example", "sk-other"), "不同密钥应得到不同键");
});

test("SSE 帧被 chunk 边界切开也能正确解析", async () => {
  const deps = setup();
  const frame = `data: ${JSON.stringify({ phase: "result", text: "42", api_format: "openai" })}\n\n`;
  const bytes = new TextEncoder().encode(frame);
  // 故意在 JSON 中间切开，模拟网络分片
  const splitAt = Math.floor(bytes.length / 2);
  const win = makeWin({
    upstream: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    }), { status: 200 }),
  });
  installApiShim({ ...deps, win });
  const response = await win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example", api_key: "k", api_model: "m", prompt: "p", expected_count: 100 }),
  });
  const events = await readEvents(response);
  assert.equal(events.length, 1, "切开的一帧应被重新拼好");
  assert.equal(events[0].text, "42");
});

test("缺少 base_url/api_key/api_model 直接报错，不发网络请求", async () => {
  let networkCalls = 0;
  const deps = setup({ upstream: async () => { networkCalls += 1; return new Response("{}"); } });
  const response = await deps.win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example" }),
  });
  const events = await readEvents(response);
  assert.ok(events[0].error.includes("缺少"));
  assert.equal(networkCalls, 0);
});

test("Worker 返回非 2xx 时给前端一个可读的 result 错误", async () => {
  const deps = setup({ upstream: async () => new Response("{}", { status: 500 }) });
  const response = await deps.win.fetch("/api/test/probe/stream", {
    method: "POST",
    body: JSON.stringify({ base_url: "https://r.example", api_key: "k", api_model: "m", prompt: "p", expected_count: 100 }),
  });
  const events = await readEvents(response);
  assert.ok(events[0].error.includes("500"));
});
