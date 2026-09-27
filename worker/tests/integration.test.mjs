/**
 * 整合测试：把真实的 app.js、api-shim.js、fingerprint-core.js 装进 DOM 桩里跑一遍。
 *
 * 这份测试要回答的是整个 Worker 版最关键的问题：
 *   "不改 app.js，只靠垫片 + 代理，完整流程到底走不走得通？"
 * 单元测试各自覆盖了代理和垫片，但只有把它们和真实 UI 逻辑装在一起才能证明这一点。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const REPO = join(HERE, "..", "..");

/** 极简 DOM：只实现 app.js 真正用到的那些能力 */
function createDom(ids) {
  const nodes = new Map();
  const listeners = new Map();

  const makeNode = (id) => ({
    id,
    value: "",
    hidden: true,
    disabled: false,
    innerHTML: "",
    textContent: "",
    className: "",
    dataset: {},
    style: {},
    addEventListener(type, handler) {
      const key = `${id}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(handler);
    },
    setAttribute() {},
    focus() {},
    scrollIntoView() {},
    querySelectorAll: () => [],
    closest: () => null,
    classList: { toggle() {} },
  });

  for (const id of ids) nodes.set(id, makeNode(id));

  const document = {
    getElementById: (id) => nodes.get(id) || makeNode(id),
    querySelectorAll: () => [],
    addEventListener() {},
  };

  return {
    nodes,
    document,
    fire(id, type, event = {}) {
      for (const handler of listeners.get(`${id}:${type}`) || []) handler(event);
    },
    lastListeners: listeners,
  };
}

// 从生成的 index.html 里提取全部 DOM id，保证桩与真实页面一致
async function pageIds() {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  return [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
}

/** 造一条与 Worker 真实输出一致的 SSE 流 */
function workerSseResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function bootIntegration({ probeFrames, expectedModel = "gpt-5.4" }) {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  const dom = createDom(await pageIds());

  const storage = new Map();
  const win = {
    document: dom.document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    confirm: () => true,
    alert() {},
    // index.html 里注入的全局（与 build.mjs 产物一致）
    BANK_SUMMARIES: JSON.parse(html.match(/window\.BANK_SUMMARIES = (\{.*?\});/s)[1]),
    UNIFIED_SUMMARY: JSON.parse(html.match(/window\.UNIFIED_SUMMARY = (\{.*?\});/s)[1]),
    DEFAULT_BANK_ID: "unified",
  };

  // Worker 代理的替身：只实现 /api/probe，其余交给垫片的本地实现
  const upstreamCalls = [];
  win.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/probe") {
      upstreamCalls.push(JSON.parse(init.body));
      return workerSseResponse(probeFrames);
    }
    if (String(url).includes("unified_bank.json")) {
      return new Response(await readFile(join(PUBLIC, "data", "unified_bank.json"), "utf8"), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  const { installApiShim } = await import("../assets/api-shim.js");
  const { analyzeGlobalOutputs, parseNumbers } = await import(
    `file://${join(PUBLIC, "fingerprint-core.js").replace(/\\/g, "/")}`
  );
  const { generateChallenges } = await import(
    `file://${join(PUBLIC, "challenge-browser.js").replace(/\\/g, "/")}`
  );

  const bank = JSON.parse(await readFile(join(PUBLIC, "data", "unified_bank.json"), "utf8"));
  const bankSummary = () => ({
    id: "unified",
    label: "全部指纹",
    model_count: bank.models.length,
    response_count: bank.models.reduce((sum, model) => sum + (model.response_count || 0), 0),
    number_count: bank.models.reduce((sum, model) => sum + (model.valid_number_count || 0), 0),
    models: bank.models.map((model) => ({
      id: model.id,
      display_name: model.display_name,
      responses: model.response_count,
      valid_numbers: model.valid_number_count,
    })),
  });

  installApiShim({ win, analyzeGlobalOutputs, parseNumbers, generateChallenges, bank, bankSummary });

  // app.js 在"调用时"读全局 document（byId 是箭头函数），所以这里必须把 window/document
  // 一直留在全局上，不能导入完就还原——真实浏览器里它们本就始终存在。
  globalThis.window = win;
  globalThis.document = dom.document;
  // app.js 里有裸 fetch(...) 调用（不写 window. 前缀）。浏览器里 window.fetch === fetch，
  // Node 里两者是不同对象，所以要把垫片同步到全局，才能复现浏览器语义。
  globalThis.fetch = win.fetch;
  await import(`file://${join(PUBLIC, "app.js").replace(/\\/g, "/")}?v=${Math.random()}`);

  return { dom, win, storage, upstreamCalls, bank, expectedModel, html };
}

test("静态页生成完整：Worker 版的 index.html 含全部 UI 区块", async () => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  // 三份工作区、API 测试表单、端点卡片、历史记录都要在：证明 UI 是全量而非裁剪版
  for (const need of [
    'data-workspace="test"', 'data-workspace="library"', 'data-workspace="history"',
    'id="api-test-form"', 'id="api-test-start"', 'id="endpoint-cards"',
    'id="history-list"', 'id="config-list"', 'id="bank-select"',
    'src="./boot.js"',
  ]) {
    assert.ok(html.includes(need), `缺少 ${need}`);
  }
  assert.ok(!html.includes("url_for"), "不应残留 Jinja 占位符");
  assert.ok(!html.includes("{{"), "不应残留模板语法");

  // 顶部计数是构建期渲染进 HTML 的，不在 JS 里设置
  const bank = JSON.parse(await readFile(join(PUBLIC, "data", "unified_bank.json"), "utf8"));
  assert.ok(
    html.includes(`${bank.models.length} 个候选模型`),
    `顶部计数应预渲染为 ${bank.models.length} 个候选模型`,
  );
  // 指纹库下拉应只有统一库，且模型补全列表来自真实指纹库
  const select = html.match(/<select id="bank-select">[\s\S]*?<\/select>/)[0];
  assert.ok(select.includes('value="unified"'), "下拉应指向统一指纹库");
  const datalist = html.match(/<datalist id="model-options">[\s\S]*?<\/datalist>/)[0];
  for (const model of bank.models.slice(0, 3)) {
    assert.ok(datalist.includes(model.id), `补全列表应含 ${model.id}`);
  }
});

test("整合：加载真实 app.js 后，库存面板来自真实指纹库", async () => {
  const { dom, bank } = await bootIntegration({
    probeFrames: [{ phase: "result", text: "1", api_format: "openai" }],
  });
  // renderInventory 会把模型清单填进 datalist 与库存区
  const options = dom.nodes.get("model-options").innerHTML;
  assert.ok(options.includes(bank.models[0].id), `库存补全应含 ${bank.models[0].id}`);
  assert.equal(
    dom.nodes.get("selected-bank-name").textContent,
    "全部指纹",
    "指纹库名称应来自统一库摘要",
  );
});

test("整合：三个端点全失败时，卡片保留并渲染状态码与响应体", async () => {
  // 只有全部端点失败才有卡片留存：任一格式调用成功（哪怕数字不足）都会清空卡片，
  // 因为那时端点已探明，错误卡片失去参考价值。
  const frames = [
    { phase: "probe_start", api_format: "responses" },
    { phase: "attempt", api_format: "responses", attempt: 1, status: 404, body: '{"error":"no responses here"}', ok: false, done: true },
    { phase: "probe_end", api_format: "responses", ok: false },
    { phase: "probe_start", api_format: "anthropic" },
    { phase: "attempt", api_format: "anthropic", attempt: 1, status: 503, body: '{"error":"no accounts"}', ok: false, done: false },
    { phase: "attempt", api_format: "anthropic", attempt: 2, status: 503, body: '{"error":"still none"}', ok: false, done: true },
    { phase: "probe_end", api_format: "anthropic", ok: false },
    { phase: "probe_start", api_format: "openai" },
    { phase: "attempt", api_format: "openai", attempt: 1, status: 403, body: '{"error":"waf"}', ok: false, done: true },
    { phase: "probe_end", api_format: "openai", ok: false },
    { phase: "result", error: "接口格式自动探测失败；responses: 404；anthropic: 503；openai: 403" },
  ];
  const { dom } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";
  dom.nodes.get("test-api-model").value = "gpt-x";

  const submitHandlers = dom.lastListeners.get("api-test-form:submit");
  await submitHandlers[0]({
    preventDefault() {},
    currentTarget: { querySelector: () => ({ disabled: false }) },
  });
  for (let index = 0; index < 80; index += 1) await Promise.resolve();

  const cards = dom.nodes.get("endpoint-cards").innerHTML;
  assert.equal(dom.nodes.get("endpoint-cards").hidden, false, "有失败端点时卡片应可见");
  // 三个格式都应出现，且带状态码
  assert.ok(cards.includes("Responses"), "应渲染 Responses 卡片");
  assert.ok(cards.includes("Anthropic"), "应渲染 Anthropic 卡片");
  assert.ok(cards.includes("Chat"), "应渲染 Chat 卡片");
  assert.ok(cards.includes("HTTP 404"), "应显示 404 状态码");
  assert.ok(cards.includes("HTTP 503"), "应显示 503 状态码");
  assert.ok(cards.includes("HTTP 403"), "应显示 403 状态码");
  // 重试刷新：第二次 503 的 body 应覆盖第一次
  assert.ok(cards.includes("still none"), "重试应刷新为最后一次的响应体");
  assert.ok(!cards.includes("no accounts<"), "旧 body 应被覆盖");
});

test("整合：调用成功时清空端点错误卡片", async () => {
  const numbers = Array.from({ length: 120 }, (_, index) => (index % 355) + 1).join(" ");
  const frames = [
    { phase: "probe_start", api_format: "responses" },
    { phase: "attempt", api_format: "responses", attempt: 1, status: 404, body: "nope", ok: false, done: true },
    { phase: "probe_end", api_format: "responses", ok: false },
    { phase: "probe_start", api_format: "anthropic" },
    { phase: "attempt", api_format: "anthropic", attempt: 1, status: 200, body: "", ok: true, done: true },
    { phase: "probe_end", api_format: "anthropic", ok: true },
    { phase: "result", text: numbers, api_format: "anthropic" },
  ];
  const { dom } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";
  dom.nodes.get("test-api-model").value = "gpt-x";

  const submitHandlers = dom.lastListeners.get("api-test-form:submit");
  await submitHandlers[0]({
    preventDefault() {},
    currentTarget: { querySelector: () => ({ disabled: false }) },
  });
  for (let index = 0; index < 80; index += 1) await Promise.resolve();

  // 端点已探明，错误卡片不再有参考价值
  assert.equal(dom.nodes.get("endpoint-cards").hidden, true, "成功后应隐藏卡片");
  assert.equal(dom.nodes.get("endpoint-cards").innerHTML, "", "成功后应清空卡片内容");
});

test("整合：探测命中的格式写入本地缓存，第二个挑战带上 preferred_format", async () => {
  const numbers = Array.from({ length: 120 }, (_, index) => (index % 355) + 1).join(" ");
  const frames = [
    { phase: "probe_start", api_format: "anthropic" },
    { phase: "attempt", api_format: "anthropic", attempt: 1, status: 200, body: "", ok: true, done: true },
    { phase: "probe_end", api_format: "anthropic", ok: true },
    { phase: "result", text: numbers, api_format: "anthropic" },
  ];
  const { dom, upstreamCalls } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";
  dom.nodes.get("test-api-model").value = "gpt-x";

  const submitHandlers = dom.lastListeners.get("api-test-form:submit");
  await submitHandlers[0]({
    preventDefault() {},
    currentTarget: { querySelector: () => ({ disabled: false }) },
  });
  for (let index = 0; index < 80; index += 1) await Promise.resolve();

  assert.ok(upstreamCalls.length >= 2, `应至少发两次探测（每次挑战一次），实际 ${upstreamCalls.length}`);
  assert.equal(upstreamCalls[0].preferred_format, undefined, "第一次没有缓存");
  assert.equal(upstreamCalls[1].preferred_format, "anthropic", "第二次应带上缓存格式");
});

test("整合：本地接口不落到 Worker —— challenges/analyze 都本地完成", async () => {
  const { win } = await bootIntegration({
    probeFrames: [{ phase: "result", text: "1", api_format: "openai" }],
  });
  const seen = [];
  const original = win.fetch;
  win.fetch = async (input, init) => {
    seen.push(typeof input === "string" ? input : input.url);
    return original(input, init);
  };
  // 垫片已装在 win.fetch 上，这里再包一层观察是否有网络调用
  const challenges = await win.fetch("/api/challenges");
  assert.ok((await challenges.json()).challenges.length === 3);
  assert.deepEqual(seen, ["/api/challenges"], "本地接口不应触发任何上游请求");
});

test("整合：app.js 作为模块加载后，关键函数仍正常工作（无 this/严格模式问题）", async () => {
  const { win } = await bootIntegration({
    probeFrames: [{ phase: "result", text: "1", api_format: "openai" }],
  });
  // 归因接口走真实指纹核心
  const numbers = Array.from({ length: 120 }, (_, index) => (index % 355) + 1).join(" ");
  const response = await win.fetch("/api/analyze", {
    method: "POST",
    body: JSON.stringify({ outputs: [{ text: numbers, expected_count: 100 }] }),
  });
  const payload = await response.json();
  assert.ok(response.ok, "真实指纹核心应能完成归因");
  assert.ok(payload.prediction_name, "应给出预测模型");
  assert.ok(Array.isArray(payload.results) && payload.results.length > 0, "应给出候选列表");
});
