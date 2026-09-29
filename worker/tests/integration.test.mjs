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
    attributes: {},
    style: {},
    addEventListener(type, handler) {
      const key = `${id}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(handler);
    },
    // 主题按钮靠 setAttribute 写 aria-pressed / aria-label，桩要留痕才能断言
    setAttribute(name, value) { this.attributes[name] = String(value); },
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
    // app.js 的主题逻辑读写 documentElement.dataset.theme 与 classList，桩必须提供
    documentElement: {
      dataset: {},
      classes: new Set(),
      classList: {
        add(name) { document.documentElement.classes.add(name); },
        remove(name) { document.documentElement.classes.delete(name); },
        contains(name) { return document.documentElement.classes.has(name); },
      },
    },
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

/**
 * 一份"必然被计入"的回答：挑战的 expected_count 是 292~332，验收阈值是它的 55%
 * （约 161~183），所以固定产出 300 个数字才能稳定越过所有挑战的阈值。
 * 用 120 之类的小样本会被判为"数字不足"，让自动模式跑满 6 轮而不是 3 轮。
 */
function acceptedNumbers() {
  return Array.from({ length: 300 }, (_, index) => (index % 355) + 1).join(" ");
}

async function bootIntegration({ probeFrames, expectedModel = "gpt-5.4" }) {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  const dom = createDom(await pageIds());

  const storage = new Map();
  // 定时器不立即执行：主题切换要"先挂过渡类、动画结束后再摘"，需要能观察到中间态
  const timers = [];
  const win = {
    document: dom.document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      keys: () => [...storage.keys()],
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id > 0) timers[id - 1] = null; },
    setInterval: () => 0,
    clearInterval() {},
    confirm: () => true,
    alert() {},
    runTimers: () => timers.splice(0).forEach((fn) => fn && fn()),
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
      // probeFrames 可以是固定帧数组，也可以是 (第几次调用, 从 0 起) 取帧的函数，
      // 后者用来复现"前一轮失败、后一轮成功"这类跨轮次不同的上游响应
      const call = upstreamCalls.length;
      upstreamCalls.push(JSON.parse(init.body));
      return workerSseResponse(typeof probeFrames === "function" ? probeFrames(call) : probeFrames);
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

test("整合：单步模式每次点击只发一轮，不会在结果渲染前抢跑下一轮", async () => {
  // 存在的意义：自动模式拿到第 1 份有效回答后会立刻发第 2 轮（归因往返只要几十毫秒），
  // 用户看到结果再点停止时第 2 次上游调用已经发出去了。单步必须保证"点一次只打一轮"。
  const numbers = acceptedNumbers();
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

  const stepHandlers = dom.lastListeners.get("api-test-step:click");
  assert.ok(stepHandlers && stepHandlers.length, "单步按钮应绑定点击处理");

  // 第一次点：建会话，只跑第 1 轮
  await stepHandlers[0]({ preventDefault() {} });
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
  assert.equal(upstreamCalls.length, 1, `单步第一次点击应只发 1 次探测，实际 ${upstreamCalls.length}`);
  // 派发按钮文案固定不变，继续入口在标签页里（挂起时出现）
  assert.equal(dom.nodes.get("api-test-step").textContent, "单步测试", "派发按钮文案不应随会话状态变脸");
  assert.equal(dom.nodes.get("api-test-step").disabled, false, "派发按钮应始终可点，才能再派发下一个任务");
  assert.equal(dom.nodes.get("api-test-resume").hidden, false, "挂起时标签页应出现「继续下一轮」");
  assert.equal(dom.nodes.get("api-test-stop").hidden, true, "挂起时不需要停止按钮");
  // 关键回归：挂起期间绝不能自行抢跑第 2 轮
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
  assert.equal(upstreamCalls.length, 1, "挂起期间不应再发探测");

  // 第二次点：从标签页的「继续下一轮」唤醒循环，发第 2 轮
  const resumeHandlers = dom.lastListeners.get("api-test-resume:click");
  await resumeHandlers[0]();
  // 唤醒后继续按钮必须立刻收掉：循环恢复要等一个微任务，
  // 不在这里重绘的话，按钮会停在整个请求期间都显示成可点的外观。
  assert.equal(dom.nodes.get("api-test-resume").hidden, true, "唤醒后应立刻收起继续按钮");
  assert.equal(dom.nodes.get("api-test-stop").hidden, false, "请求在飞时应显示停止按钮");
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
  assert.equal(upstreamCalls.length, 2, `第二次点击应发第 2 轮，实际 ${upstreamCalls.length}`);
});

test("整合：单步模式下首轮数字不足时自动续跑，直到真正产出有效回答才停", async () => {
  // 回归：门原本开在 index > 0，只要"不是第一轮"就挂起，
  // 于是首轮报错或数字不足时也会停下等点击——用户点一次单步只换来一次失败。
  // 预期是单步只在"产出了有效回答"之后才停，失败轮次应当自动继续。
  const good = acceptedNumbers();
  const frames = (call) => (call === 0
    // 第 1 轮：接口正常但数字不足（"invalid"），没有产出
    ? [{ phase: "result", text: "1 2 3", api_format: "anthropic" }]
    // 第 2 轮：足量数字，产出有效回答
    : [{ phase: "result", text: good, api_format: "anthropic" }]);
  const { dom, upstreamCalls } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";
  dom.nodes.get("test-api-model").value = "gpt-x";

  const stepHandlers = dom.lastListeners.get("api-test-step:click");
  await stepHandlers[0]({ preventDefault() {} });
  for (let index = 0; index < 120; index += 1) await Promise.resolve();

  assert.equal(upstreamCalls.length, 2, `首轮无产出应自动续跑第 2 轮，实际发了 ${upstreamCalls.length} 次`);
  assert.equal(dom.nodes.get("api-test-resume").hidden, false, "产出有效回答后才应出现「继续下一轮」");

  // 停在这里等用户：不会再自行抢跑
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
  assert.equal(upstreamCalls.length, 2, "等待期间不应再发探测");
});

test("整合：单步模式下接口报错时同样自动续跑", async () => {
  // 与数字不足同源：报错轮次也没有产出，不该占用单步的一次停顿
  const good = acceptedNumbers();
  const frames = (call) => (call === 0
    ? [{ phase: "result", error: "接口格式自动探测失败；responses: 404", status: 404, body: "" }]
    : [{ phase: "result", text: good, api_format: "anthropic" }]);
  const { dom, upstreamCalls } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";
  dom.nodes.get("test-api-model").value = "gpt-x";

  const stepHandlers = dom.lastListeners.get("api-test-step:click");
  await stepHandlers[0]({ preventDefault() {} });
  for (let index = 0; index < 120; index += 1) await Promise.resolve();

  assert.equal(upstreamCalls.length, 2, `首轮报错应自动续跑第 2 轮，实际发了 ${upstreamCalls.length} 次`);
  assert.equal(dom.nodes.get("api-test-resume").hidden, false, "产出有效回答后才应出现「继续下一轮」");
});

test("整合：单步产出 1 份结果后切走再切回，结果仍要恢复", async () => {
  // 回归：latestResult 原本只是 runTestSession 的局部变量，只有收尾才写进 session。
  // 于是"1 份有效回答已出结果 → 切到别的标签 → 切回来"会读不到结果，面板被隐藏，
  // 表现为结果凭空消失。判定是每收到一份有效回答就立刻做，所以这份结果必须可恢复。
  const numbers = acceptedNumbers();
  const frames = [
    { phase: "probe_start", api_format: "anthropic" },
    { phase: "attempt", api_format: "anthropic", attempt: 1, status: 200, body: "", ok: true, done: true },
    { phase: "probe_end", api_format: "anthropic", ok: true },
    { phase: "result", text: numbers, api_format: "anthropic" },
  ];
  const { dom } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";

  // 任务 A：单步跑 1 轮，拿到结果后停在门上
  dom.nodes.get("test-api-model").value = "model-a";
  const stepHandlers = dom.lastListeners.get("api-test-step:click");
  await stepHandlers[0]({ preventDefault() {} });
  for (let index = 0; index < 120; index += 1) await Promise.resolve();
  assert.equal(dom.nodes.get("result").hidden, false, "任务 A 出 1 份结果后应显示结果面板");
  const resultHtml = dom.nodes.get("result").innerHTML;
  assert.ok(resultHtml.length > 0, "结果面板应有内容");

  // 派发任务 B 接走焦点，A 的结果面板被 B 取代
  dom.nodes.get("test-api-model").value = "model-b";
  const submitHandlers = dom.lastListeners.get("api-test-form:submit");
  await submitHandlers[0]({
    preventDefault() {},
    currentTarget: { querySelector: () => ({ disabled: false }) },
  });
  for (let index = 0; index < 60; index += 1) await Promise.resolve();

  // 切回 A：那份中途产出的结果必须还在
  const ids = [...dom.nodes.get("session-tabs").innerHTML.matchAll(/data-session="(s\d+)"/g)]
    .map((match) => match[1]);
  assert.equal(ids.length, 2, "应有两个会话标签");
  dom.fire("session-tabs", "click", {
    target: { closest: (selector) => (selector === "[data-session]" ? { dataset: { session: ids[0] } } : null) },
  });
  assert.equal(dom.nodes.get("result").hidden, false, "切回任务 A 后结果面板不应被隐藏");
  assert.equal(dom.nodes.get("result").innerHTML, resultHtml, "切回后应恢复同一份结果");
});

test("整合：自动模式仍然连发，一测到底拿满 3 份", async () => {
  // 单步是新增分支，自动模式的既有行为不能被改坏
  const numbers = acceptedNumbers();
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
  for (let index = 0; index < 200; index += 1) await Promise.resolve();

  assert.equal(upstreamCalls.length, 3, `自动模式应连发到拿满 3 份，实际 ${upstreamCalls.length}`);
  assert.equal(dom.nodes.get("api-test-step").textContent, "单步测试", "结束后单步按钮应复位");
  assert.equal(dom.nodes.get("api-test-start").textContent, "开始测试", "结束后开始按钮应复位");
});

test("样式：按钮禁用态必须排除 hover 且显式换色，否则分不出可点与不可点", async () => {
  // 回归：`.button.secondary:hover`(0,3,0) 优先级高于 `button:disabled`(0,1,1)，
  // 不禁用 hover 的话禁用按钮照样会变色，看起来仍可点。深色下 --control-bg 与
  // --surface-soft 本就几乎同色，只靠全局 opacity 降透明度也分辨不出来。
  const css = await readFile(join(PUBLIC, "styles.css"), "utf8");

  const hoverRules = [...css.matchAll(/\.button\.[a-z-]+:hover[^{]*/g)].map((match) => match[0]);
  assert.ok(hoverRules.length >= 3, `应有 primary/secondary/danger 三条 hover 规则，实际 ${hoverRules.length}`);
  for (const rule of hoverRules) {
    assert.ok(
      rule.includes(":not(:disabled)"),
      `按钮 hover 必须排除禁用态，否则禁用按钮仍会变色：${rule.trim()}`,
    );
  }

  // 禁用态要显式给出底色与文字色，不能只依赖全局的 opacity
  const disabledBlock = css.match(/\.button:disabled\s*\{[^}]*\}/);
  assert.ok(disabledBlock, "应有 .button:disabled 规则");
  assert.ok(disabledBlock[0].includes("background:"), "禁用态应显式设置背景色");
  assert.ok(disabledBlock[0].includes("color:"), "禁用态应显式设置文字色");
});

test("整合：并行提交两个任务互不阻塞，只有 2 个会话时才出现标签条", async () => {
  // 核心并发回归：改造前 runActive 是全局互斥，跑着 A 时提交 B 会被直接 return 丢掉。
  const numbers = acceptedNumbers();
  const frames = [
    { phase: "probe_start", api_format: "anthropic" },
    { phase: "attempt", api_format: "anthropic", attempt: 1, status: 200, body: "", ok: true, done: true },
    { phase: "probe_end", api_format: "anthropic", ok: true },
    { phase: "result", text: numbers, api_format: "anthropic" },
  ];
  const { dom, upstreamCalls } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";

  const submitHandlers = dom.lastListeners.get("api-test-form:submit");
  const submit = () => submitHandlers[0]({
    preventDefault() {},
    currentTarget: { querySelector: () => ({ disabled: false }) },
  });

  // 第一个任务：单步，先停在挂起门上，模拟"一个任务还开着"
  dom.nodes.get("test-api-model").value = "gpt-x";
  const stepHandlers = dom.lastListeners.get("api-test-step:click");
  await stepHandlers[0]({ preventDefault() {} });
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
  assert.equal(upstreamCalls.length, 1, "第一个任务应先跑完 1 轮");
  assert.equal(dom.nodes.get("session-tabs").hidden, true, "只有 1 个会话时不应显示标签条");

  // 第二个任务：换模型直接提交，不能被第一个任务挡住
  dom.nodes.get("test-api-model").value = "claude-y";
  await submit();
  for (let index = 0; index < 80; index += 1) await Promise.resolve();

  const tabs = dom.nodes.get("session-tabs");
  assert.equal(tabs.hidden, false, "出现多个会话时应显示标签条");
  const html = tabs.innerHTML;
  assert.ok(html.includes("gpt-x"), "标签应含第一个任务的模型名");
  assert.ok(html.includes("claude-y"), "标签应含第二个任务的模型名");
  assert.equal((html.match(/class="session-tab/g) || []).length, 2, "应渲染 2 个标签");
  // 标签里的色块数量对齐 6 次尝试
  const cells = (html.match(/class="tab-cell /g) || []).length;
  assert.ok(cells >= 6, `每个标签应有对应尝试轮次的色块，实际 ${cells}`);
});

test("整合：并行时各会话的进度互相独立，新提交的任务接管焦点", async () => {
  // 两个不变量：
  //   1. 新提交的任务成为焦点（用户点下去就想看它）
  //   2. 焦点切走后，原任务的进度仍留在自己的标签里，不被后来的任务冲掉
  const numbers = acceptedNumbers();
  const frames = [
    { phase: "probe_start", api_format: "anthropic" },
    { phase: "attempt", api_format: "anthropic", attempt: 1, status: 200, body: "", ok: true, done: true },
    { phase: "probe_end", api_format: "anthropic", ok: true },
    { phase: "result", text: numbers, api_format: "anthropic" },
  ];
  const { dom } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";

  // 任务 A 单步，只跑 1 轮就挂起
  dom.nodes.get("test-api-model").value = "model-a";
  const stepHandlers = dom.lastListeners.get("api-test-step:click");
  await stepHandlers[0]({ preventDefault() {} });
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
  assert.ok(dom.nodes.get("api-progress-count").textContent.includes("有效 1/3"),
    "任务 A 应停在 1 份有效回答");

  // 任务 B 自动跑满，接管焦点
  dom.nodes.get("test-api-model").value = "model-b";
  const submitHandlers = dom.lastListeners.get("api-test-form:submit");
  await submitHandlers[0]({
    preventDefault() {},
    currentTarget: { querySelector: () => ({ disabled: false }) },
  });
  for (let index = 0; index < 200; index += 1) await Promise.resolve();
  assert.ok(dom.nodes.get("api-progress-count").textContent.includes("有效 3/3"),
    "新提交的任务应接管焦点并显示自己的进度");

  // 关键：两个标签各自记住自己的尝试进度，B 的完成没有覆盖 A 的。
  // 标签上的 "已尝试数" 已移除（它只是色块非灰格数的重复），所以这里直接数各标签的色块：
  // A 单步只产出 1 份有效回答 → 1 个绿格；B 自动跑满 → 3 个绿格。
  const tabs = dom.nodes.get("session-tabs").innerHTML;
  const blocks = tabs.split('<div class="session-tab').slice(1);
  assert.equal(blocks.length, 2, "应有两个会话标签");
  const doneCounts = blocks.map((block) => (block.match(/tab-cell done/g) || []).length);
  assert.deepEqual(doneCounts, [1, 3], `两个标签的有效回答数应各自独立，实际 ${doneCounts}`);
});

test("整合：切换标签把对应会话的进度投影回主面板", async () => {
  const numbers = acceptedNumbers();
  const frames = [
    { phase: "probe_start", api_format: "anthropic" },
    { phase: "attempt", api_format: "anthropic", attempt: 1, status: 200, body: "", ok: true, done: true },
    { phase: "probe_end", api_format: "anthropic", ok: true },
    { phase: "result", text: numbers, api_format: "anthropic" },
  ];
  const { dom } = await bootIntegration({ probeFrames: frames });
  dom.nodes.get("test-api-base").value = "https://relay.example";
  dom.nodes.get("test-api-key").value = "sk-test";

  // 任务 A：单步只跑 1 轮，停在「有效 1/3」
  dom.nodes.get("test-api-model").value = "model-a";
  const stepHandlers = dom.lastListeners.get("api-test-step:click");
  await stepHandlers[0]({ preventDefault() {} });
  for (let index = 0; index < 80; index += 1) await Promise.resolve();
  assert.ok(dom.nodes.get("api-progress-count").textContent.includes("有效 1/3"),
    "任务 A 应停在 1 份有效回答");

  // 任务 B：自动模式跑满 3 份，成为新焦点
  dom.nodes.get("test-api-model").value = "model-b";
  const submitHandlers = dom.lastListeners.get("api-test-form:submit");
  await submitHandlers[0]({
    preventDefault() {},
    currentTarget: { querySelector: () => ({ disabled: false }) },
  });
  for (let index = 0; index < 200; index += 1) await Promise.resolve();
  assert.ok(dom.nodes.get("api-progress-count").textContent.includes("有效 3/3"),
    "任务 B 应跑满 3 份有效回答");

  // 切回任务 A：主面板要还原成 A 的进度，而不是继续显示 B 的
  const ids = [...dom.nodes.get("session-tabs").innerHTML.matchAll(/data-session="(s\d+)"/g)]
    .map((match) => match[1]);
  assert.equal(ids.length, 2, "应有两个会话标签");
  dom.fire("session-tabs", "click", {
    target: { closest: (selector) => (selector === "[data-session]" ? { dataset: { session: ids[0] } } : null) },
  });
  assert.ok(dom.nodes.get("api-progress-count").textContent.includes("有效 1/3"),
    `切回任务 A 后应显示 A 的进度，实际 ${dom.nodes.get("api-progress-count").textContent}`);
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

test("整合：主题切换写入 data-theme 与 localStorage，按钮文案随状态反转", async () => {
  const { dom, win } = await bootIntegration({
    probeFrames: [{ phase: "result", text: "1", api_format: "openai" }],
  });

  // 无存储值时按浅色起步，按钮提示「切到深色」
  assert.equal(dom.document.documentElement.dataset.theme, "light", "默认应为浅色");
  assert.equal(dom.nodes.get("theme-toggle-label").textContent, "深色模式");
  assert.equal(dom.nodes.get("theme-toggle-icon").textContent, "☀");
  assert.equal(dom.nodes.get("theme-toggle").attributes["aria-pressed"], "false");

  // 点一次切到深色：data-theme、按钮外观、持久化都要跟上
  dom.fire("theme-toggle", "click");
  assert.equal(dom.document.documentElement.dataset.theme, "dark", "点击后应切到深色");
  assert.equal(dom.nodes.get("theme-toggle-label").textContent, "浅色模式");
  assert.equal(dom.nodes.get("theme-toggle-icon").textContent, "☾");
  assert.equal(dom.nodes.get("theme-toggle").attributes["aria-pressed"], "true");
  assert.equal(win.localStorage.getItem("modeltrace.theme"), "dark", "主题应被持久化");

  // 切换期间挂过渡类让换色平滑，动画结束后必须摘掉，否则会拖慢常驻交互
  assert.ok(dom.document.documentElement.classList.contains("theme-switching"), "切换时应挂上过渡类");
  win.runTimers();
  assert.ok(!dom.document.documentElement.classList.contains("theme-switching"), "动画结束后应摘掉过渡类");

  // 再点一次切回浅色
  dom.fire("theme-toggle", "click");
  assert.equal(dom.document.documentElement.dataset.theme, "light", "再次点击应切回浅色");
  assert.equal(win.localStorage.getItem("modeltrace.theme"), "light");
});

test("整合：历史徽章只输出 data-tone 色号，颜色交给 CSS 按主题决定", async () => {
  const { dom, win } = await bootIntegration({
    probeFrames: [{ phase: "result", text: "1", api_format: "openai" }],
  });
  // 造两条历史：一条带配置名，一条只有地址，两条都要能被染色
  // result 需带完整形状：历史详情展开时会渲染诊断与结果表
  const resultFor = (name, probability) => ({
    prediction_name: name, probability,
    family_prediction_name: "GPT", family_probability: 0.99,
    used_outputs: 1,
    diagnostics: [{ accepted: true, parsed_numbers: 300 }],
    results: [{ display_name: name, family_name: "GPT", probability, profile_similarity: 0.7 }],
  });
  win.localStorage.setItem("modeltrace.history", JSON.stringify([
    {
      id: "1", at: "2026-01-01T00:00:00.000Z", base_url: "https://a.example/v1", api_key: "k",
      api_model: "gpt-x", config: "线路甲", note: "", latency_ms: 100,
      accepted: 3, attempted: 3, result: resultFor("gpt-x", 0.9),
    },
    {
      id: "2", at: "2026-01-01T00:01:00.000Z", base_url: "https://b.example/v1", api_key: "k",
      api_model: "gpt-y", config: "", note: "", latency_ms: 100,
      accepted: 1, attempted: 2, result: resultFor("gpt-y", 0.8),
    },
  ]));
  dom.fire("history-search", "input");

  const html = dom.nodes.get("history-list").innerHTML;
  const tones = [...html.matchAll(/class="history-badge (?:config|url)" data-tone="(\d)"/g)];
  assert.equal(tones.length, 2, "两条历史都应渲染带 data-tone 的徽章");
  for (const [, tone] of tones) {
    assert.ok(Number(tone) >= 0 && Number(tone) < 8, `色号应在 0~7 之间，实际 ${tone}`);
  }
  // 关键回归：颜色不能再由内联 style 写死，否则深色主题下会变成刺眼白块
  assert.ok(!/history-badge[^>]*style=/.test(html), "徽章不应再带内联颜色");
});
