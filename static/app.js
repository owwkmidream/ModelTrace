const state = {
  challenges: [],
  bankId: window.DEFAULT_BANK_ID,
  bank: window.BANK_SUMMARIES[window.DEFAULT_BANK_ID],
  unified: window.UNIFIED_SUMMARY,
};

const byId = (id) => document.getElementById(id);

// ── 本地存档与历史记录（localStorage，纯前端，不上传）──
const CONFIG_KEY = "modeltrace.configs";
const HISTORY_KEY = "modeltrace.history";
const HISTORY_LIMIT = 200;
// 主题键与 templates/index.html 头部脚本共用，两处必须一致
const THEME_KEY = "modeltrace.theme";

function readStore(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function maskKey(key) {
  if (!key) return "";
  return key.length <= 12 ? key : `${key.slice(0, 6)}…${key.slice(-5)}`;
}

// 折叠态徽章用的短地址：去掉协议头，过长时保留域名 + 末段
function shortUrl(url) {
  const text = String(url || "").replace(/^https?:\/\//, "");
  if (!text) return "未填地址";
  if (text.length <= 46) return text;
  const parts = text.split("/");
  return `${parts[0]}/…/${parts[parts.length - 1]}`;
}

function configs() {
  return readStore(CONFIG_KEY);
}

// 按 base_url + api_key 精确匹配存档，取其名字作为历史记录的「配置」徽章。
// 精确匹配天然处理了「载入配置后改了 URL/Key」：改完就不再匹配，徽章回落为地址。
function configNameFor(baseUrl, apiKey) {
  const hit = configs().find((item) => item.base_url === baseUrl && item.api_key === apiKey);
  return hit ? hit.name : "";
}

// 历史记录条目统一构造。config 是保存时按 URL/Key 匹配到的配置名快照，note 是用户自己写的备注。
function historyEntry(configuration, startedAt, extra) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    base_url: configuration.base_url,
    api_key: configuration.api_key,
    api_model: configuration.api_model,
    temperature: configuration.temperature,
    config: configNameFor(configuration.base_url, configuration.api_key),
    note: "",
    latency_ms: Date.now() - startedAt,
    ...extra,
  };
}

function history() {
  return readStore(HISTORY_KEY);
}

function appendHistory(entry) {
  const list = history();
  list.unshift(entry);
  writeStore(HISTORY_KEY, list.slice(0, HISTORY_LIMIT));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

// 概率显示阈值：低于该值的候选渲染出来就是 0.0%，属于纯噪声，直接折叠
const PROBABILITY_DISPLAY_FLOOR = 0.0005;

function optionalNumber(id) {
  const value = byId(id).value.trim();
  return value === "" ? null : Number(value);
}

function setMessage(element, text, type = "error") {
  element.textContent = text;
  element.className = `message ${type}`;
  element.hidden = !text;
}

function activateWorkspace(name) {
  document.querySelectorAll(".workspace").forEach((item) => item.classList.toggle("active", item.id === `workspace-${name}`));
  document.querySelectorAll("[data-workspace]").forEach((item) => item.classList.toggle("active", item.dataset.workspace === name));
}

function activateMode(group, name) {
  document.querySelectorAll(`[data-${group}-mode]`).forEach((item) => item.classList.toggle("active", item.dataset[`${group}Mode`] === name));
  document.querySelectorAll(`#workspace-${group === "test" ? "test" : "library"} .mode-panel`).forEach((item) => {
    item.classList.toggle("active", item.id === `${group}-${name}` || item.id === `library-${name}`);
  });
}

async function loadChallenges() {
  byId("regenerate").disabled = true;
  byId("result").hidden = true;
  setMessage(byId("test-message"), "");
  const response = await fetch("/api/challenges");
  state.challenges = (await response.json()).challenges;
  renderChallenges();
  byId("regenerate").disabled = false;
}

function renderChallenges() {
  byId("challenge-list").innerHTML = state.challenges.map((challenge, index) => `
    <article class="challenge-item">
      <div class="challenge-header">
        <strong>挑战 ${index + 1}</strong>
        <span>${challenge.expected_count} 个数字</span>
        <button type="button" data-copy="${index}">复制提示词</button>
      </div>
      <div class="challenge-columns">
        <div><label>发送给待测模型</label><pre>${escapeHtml(challenge.prompt)}</pre></div>
        <div><label for="output-${index}">粘贴完整输出</label><textarea id="output-${index}" spellcheck="false" placeholder="保留文字、标点、代码块和完整数字序列"></textarea></div>
      </div>
    </article>
  `).join("");
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(state.challenges[Number(button.dataset.copy)].prompt);
      button.textContent = "已复制";
      window.setTimeout(() => { button.textContent = "复制提示词"; }, 1000);
    });
  });
}

function renderResultHtml(payload) {
  const diagnostics = payload.diagnostics.map((item, index) => `
    <span class="diagnostic ${item.accepted ? "accepted" : "rejected"}">挑战 ${index + 1}: ${item.parsed_numbers} 个数字 · ${item.accepted ? "计入" : "忽略"}</span>
  `).join("");
  // 只展示有实际概率的候选。softmax 永远输出正数（尾部分布低到 1e-12），
  // 所以按“显示成 0.0%”的粒度截断，否则每个候选都会渲染成一行噪声。
  const winners = payload.results.filter((item) => item.probability >= PROBABILITY_DISPLAY_FLOOR);
  if (!winners.length) winners.push(payload.results[0]);   // 极端情况下至少保留首行
  const rows = winners.map((item, index) => `
    <tr class="${index === 0 ? "winner" : ""}">
      <td>${index + 1}</td><td><strong>${escapeHtml(item.display_name)}</strong></td><td>${escapeHtml(item.family_name)}</td>
      <td><div class="probability-cell"><span><i style="width:${item.probability * 100}%"></i></span><strong>${percent(item.probability)}</strong></div></td>
      <td>${percent(item.profile_similarity)}</td>
    </tr>
  `).join("");
  const apiNote = payload.api_test
    ? `<span>API 获得 ${payload.api_test.received}/${payload.api_test.requested} 份有效回答，实际尝试 ${payload.api_test.attempted}/${payload.api_test.max_attempts}${payload.api_test.errors.length ? `，${payload.api_test.errors.length} 次未采用` : ""}</span>`
    : "";
  const hidden = payload.results.length - winners.length;
  return `
    <div class="result-summary">
      <div><span>最可能模型</span><strong>${escapeHtml(payload.prediction_name)}</strong></div>
      <div><span>统一库概率</span><strong>${percent(payload.probability)}</strong></div>
      <div><span>自动识别家族</span><strong>${escapeHtml(payload.family_prediction_name)} · ${percent(payload.family_probability)}</strong></div>
      <div><span>有效查询</span><strong>${payload.used_outputs}/3</strong></div>
    </div>
    <div class="diagnostics">${diagnostics}</div>
    <div class="table-wrap"><table><thead><tr><th>排序</th><th>候选模型</th><th>家族</th><th>归因概率</th><th>分布相似度</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${hidden ? `<div class="result-note"><span>另有 ${hidden} 个候选概率为 0，已折叠</span></div>` : ""}
    ${apiNote ? `<div class="result-note">${apiNote}</div>` : ""}
    <div class="result-guidance" role="note" aria-label="结果说明">
      <p>本工具仅对指纹库内的模型进行归因；若待测模型不在指纹库中，得到任何结果都有可能。</p>
      <p>Claude Code 的系统提示词会影响模型偏好，测试结果存在较大偏差，建议不要在 Claude Code 中测试。</p>
    </div>
  `;
}

// scroll=false 供实时刷新使用：只更新内容，不抢用户的滚动位置
function renderResult(payload, { scroll = true } = {}) {
  byId("result").innerHTML = renderResultHtml(payload);
  byId("result").hidden = false;
  if (scroll) byId("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function analyzeManual() {
  const button = byId("analyze");
  button.disabled = true;
  setMessage(byId("test-message"), "正在计算……", "working");
  const outputs = state.challenges.map((challenge, index) => ({
    text: byId(`output-${index}`).value,
    expected_count: challenge.expected_count,
  }));
  const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ outputs }) });
  const payload = await response.json();
  if (response.ok) {
    setMessage(byId("test-message"), "");
    renderResult(payload);
  } else {
    setMessage(byId("test-message"), payload.error || "无法完成归因。", "error");
    byId("result").hidden = true;
  }
  button.disabled = false;
}

const FORMAT_LABELS = { responses: "Responses", anthropic: "Anthropic", openai: "Chat" };

// ── 端点探测卡片：一行 3 张，对应探测顺序 Responses → Anthropic → Chat ──
// 每次尝试都就地刷新对应卡片（HTTP 状态码 + body），端点结束后固定。
// 探测成功时这些卡片没有参考价值，直接清空。
let endpointProbes = new Map();   // api_format -> {attempt, status, body, ok, done}

function resetEndpointCards() {
  endpointProbes = new Map();
  byId("endpoint-cards").innerHTML = "";
  byId("endpoint-cards").hidden = true;
}

function applyProbeEvent(event) {
  if (event.phase === "probe_start") {
    if (!endpointProbes.has(event.api_format)) {
      endpointProbes.set(event.api_format, { attempt: 0, status: null, body: "", ok: false, done: false, fresh: true, stream: false });
    }
    renderEndpointCards();
    return;
  }
  if (event.phase !== "attempt") return;
  const previous = endpointProbes.get(event.api_format) || {};
  endpointProbes.set(event.api_format, {
    attempt: event.attempt,
    status: event.status,
    body: event.body || "",
    ok: Boolean(event.ok),
    done: Boolean(event.done),
    fresh: false,
    stream: Boolean(event.stream),
  });
  renderEndpointCards();
}

function renderEndpointCards() {
  const container = byId("endpoint-cards");
  if (!endpointProbes.size) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  container.innerHTML = [...endpointProbes.entries()].map(([apiFormat, probe]) => {
    const state = probe.ok ? "ok" : probe.status ? "fail" : "pending";
    const status = probe.ok ? "HTTP 200 成功" : probe.status ? `HTTP ${probe.status}` : "连接失败";
    const attempt = probe.attempt ? `第 ${probe.attempt}/${3} 次尝试` : "准备请求";
    // 升级为流式后标一下，便于分辨"这次换的是请求形态"而不是普通重试
    const streamTag = probe.stream ? " · 流式" : "";
    const tail = probe.done ? "" : probe.attempt ? " · 等待重试" : " · 探测中";
    const body = probe.body ? `<pre>${escapeHtml(probe.body.slice(0, 600))}</pre>` : "";
    return `
      <article class="endpoint-card ${state}${probe.fresh ? " fresh" : ""}">
        <header><strong>${FORMAT_LABELS[apiFormat] || apiFormat}</strong><span>${status}</span></header>
        <small>${attempt}${streamTag}${tail}</small>
        ${body}
      </article>
    `;
  }).join("");
}

// 流式读取 SSE：每个 data: 行是一条事件，边到边刷新卡片
async function probeViaStream(configuration, challenge, onEvent, signal) {
  const response = await fetch("/api/test/probe/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...configuration, prompt: challenge.prompt, expected_count: challenge.expected_count }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`探测接口返回 ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行分隔事件；残留不完整的一段留在 buffer 里等下一片
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim());
      if (event.phase === "result") final = event;
      else onEvent(event);
    }
  }
  if (!final) throw new Error("探测流意外结束");
  return final;
}

function renderApiProgress(states, status) {
  const valid = states.filter((state) => state === "done").length;
  const attempted = states.filter((state) => ["done", "invalid", "error"].includes(state)).length;
  const target = 3;
  byId("api-test-progress").hidden = false;
  byId("api-progress-status").textContent = status;
  byId("api-progress-count").textContent = `有效 ${valid}/${target} · 已尝试 ${attempted}/${states.length}`;
  byId("api-progress-fill").style.width = `${(valid / target) * 100}%`;
  byId("api-progress-steps").innerHTML = states.map((state, index) => {
    const labels = { pending: "等待", working: "请求中", done: "有效", invalid: "数字不足", error: "接口失败", skipped: "已停止" };
    return `<span class="progress-step ${state}"><b>${index + 1}</b>挑战 ${index + 1} · ${labels[state]}</span>`;
  }).join("");
}

// 测试运行状态：开始/停止复用同一个按钮
let runAbort = null;
let runActive = false;
let runStopped = false;

// 一个按钮两种身份：空闲时是「开始测试」，运行中变成「停止测试」
function setTestRunning(running) {
  runActive = running;
  const button = byId("api-test-start");
  button.textContent = running ? "停止测试" : "开始测试";
  button.className = `button ${running ? "danger" : "primary"}`;
  button.disabled = false;
  if (running) byId("api-test-progress").hidden = false;
}

function stopTest() {
  if (!runActive) return;
  runStopped = true;
  byId("api-test-start").disabled = true;   // 中断期间防重复点击，收尾时统一恢复
  if (runAbort) runAbort.abort();
}

async function testViaApi(event) {
  event.preventDefault();
  if (runActive) return;   // 运行中再次提交（回车等）不重入
  byId("result").hidden = true;
  setMessage(byId("test-message"), "");
  runStopped = false;
  runAbort = new AbortController();
  setTestRunning(true);

  const startedAt = Date.now();
  const challengeResponse = await fetch("/api/challenges");
  const firstBatch = (await challengeResponse.json()).challenges;
  const retryResponse = await fetch("/api/challenges");
  const challenges = firstBatch.concat((await retryResponse.json()).challenges);
  const states = challenges.map(() => "pending");
  const outputs = [];
  const errors = [];        // 展示用文本
  const failures = [];      // 结构化失败信息（status + body），写入历史
  const target = 3;
  const configuration = {
    base_url: byId("test-api-base").value,
    api_key: byId("test-api-key").value,
    api_model: byId("test-api-model").value,
    temperature: optionalNumber("test-temperature"),
  };
  resetEndpointCards();
  renderApiProgress(states, "已生成独立挑战，准备调用模型");

  /**
   * 用当前已收集的有效回答算一次归因并就地渲染。
   * 每收到一份有效回答就调用：1 份即可出结果，后续份数覆盖更新。
   * scroll 只在首次展示时给 true，避免后续刷新抢走用户的滚动位置。
   * 归因失败返回 null，由调用方统一提示，不打断后续挑战的收集。
   */
  async function updateResult(scroll) {
    let response;
    try {
      response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputs }),
      });
    } catch (error) {
      // 软停止会中断在途请求：这不是归因失败，也不该把已计入的回答标成错误
      if (runStopped || error.name === "AbortError") return null;
      errors.push(`归因失败：${error.message}`);
      return null;
    }
    const payload = await response.json();
    if (!response.ok) {
      errors.push(`归因失败：${payload.error || "无法完成归因"}`);
      return null;
    }
    renderResult(payload, { scroll });
    return payload;
  }

  let latestResult = null;   // 最近一次成功的归因，收尾时补上统计信息直接复用

  for (let index = 0; index < challenges.length && outputs.length < target; index += 1) {
    if (runStopped) break;
    states[index] = "working";
    renderApiProgress(states, `正在进行第 ${index + 1} 次尝试，等待模型完整输出……`);
    try {
      const payload = await probeViaStream(
        configuration,
        challenges[index],
        applyProbeEvent,
        runAbort.signal,
      );
      if (payload.error) {
        failures.push({ attempt: index + 1, status: payload.status || 0, body: payload.body || payload.error });
        throw new Error(payload.error);
      }
      // 接口调用成功即说明端点已探明，错误卡片失去参考价值，无论数字是否达标都清空
      resetEndpointCards();
      if (payload.accepted) {
        outputs.push({ text: payload.text, expected_count: challenges[index].expected_count });
        states[index] = "done";
        // 收到即归因：让概率表随着有效回答的份数逐份生长，而不是等满 3 份才出现
        renderApiProgress(states, `已获得 ${outputs.length} 份有效回答，正在更新归因概率……`);
        const result = await updateResult(outputs.length === 1);
        if (result) latestResult = result;
      } else {
        errors.push(`尝试 ${index + 1}: 有效数字 ${payload.parsed_numbers}/${payload.minimum_numbers}`);
        states[index] = "invalid";
      }
    } catch (error) {
      if (runStopped || error.name === "AbortError") {
        states[index] = "error";
        break;
      }
      errors.push(`尝试 ${index + 1}: ${error.message}`);
      states[index] = "error";
    }
    renderApiProgress(states, `当前已有 ${outputs.length}/${target} 份有效回答`);
  }

  setTestRunning(false);
  if (runStopped) {
    // 软停止：前端放弃后续挑战，后端最多跑完当前这一次请求
    states.forEach((state, stateIndex) => { if (state === "pending") states[stateIndex] = "skipped"; });
    renderApiProgress(states, `已手动停止：${outputs.length}/${target} 份有效回答`);
  } else if (outputs.length === target) {
    states.forEach((state, index) => { if (state === "pending") states[index] = "skipped"; });
  }

  if (!outputs.length) {
    if (!runStopped) renderApiProgress(states, "六次尝试后仍没有可用回答");
    setMessage(byId("test-message"), runStopped ? "已手动停止，没有收集到可用回答。" : `没有获得可分析输出。${errors[0] || ""}`, "error");
    // 没有归因结果的失败测试不入历史：列表里只剩能从摘要一眼看懂的有效记录
    return;
  }

  // 最后一份的归因若也失败，结果会落后于已收集份数，补算一次让展示与历史一致
  if (!latestResult || latestResult.used_outputs !== outputs.length) {
    latestResult = (await updateResult(false)) || latestResult;
  }
  if (!latestResult) {
    // 归因接口失败同样不入历史
    setMessage(byId("test-message"), errors[errors.length - 1] || "API 自动测试失败。", "error");
    return;
  }

  const attempted = states.filter((state) => ["done", "invalid", "error"].includes(state)).length;
  latestResult.api_test = { requested: target, attempted, max_attempts: challenges.length, received: outputs.length, errors };
  renderApiProgress(states, `测试完成：${outputs.length}/${target} 份有效回答进入归因`);
  renderResult(latestResult, { scroll: false });   // 收尾只补统计信息，不再抢滚动
  appendHistory(historyEntry(configuration, startedAt, {
    accepted: outputs.length,
    attempted,
    failures,
    result: latestResult,
  }));
  renderHistory();
}

function updateUnifiedSummary(summary) {
  state.unified = summary;
  byId("topbar-bank-count").textContent = `${summary.model_count} 个候选模型`;
  byId("active-bank-badge").textContent = `${summary.model_count} 个候选模型`;
}

function renderInventory() {
  byId("selected-bank-name").textContent = state.bank.label;
  byId("model-options").innerHTML = state.bank.models.map((model) => `<option value="${escapeHtml(model.id)}"></option>`).join("");
  byId("bank-inventory").innerHTML = state.bank.models.length
    ? state.bank.models.map((model) => `<span class="fingerprint-item">${escapeHtml(model.display_name)}</span>`).join("")
    : `<span class="empty-inventory">暂无指纹</span>`;
}

async function refreshBank() {
  const response = await fetch(`/api/bank?bank_id=${encodeURIComponent(state.bankId)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "无法读取指纹库");
  state.bank = payload;
  renderInventory();
}

async function selectBank(bankId) {
  state.bankId = bankId;
  await refreshBank();
}

async function enrollAutomatically(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  const requested = Number(byId("sample-count").value);
  const started = Date.now();
  const progressTimer = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    setMessage(byId("enrollment-message"), `正在自动识别协议并采集 ${requested} 份回答 · 已等待 ${seconds} 秒`, "working");
  }, 1000);
  setMessage(byId("enrollment-message"), `正在自动识别协议并采集 ${requested} 份回答`, "working");
  let response;
  try {
    response = await fetch("/api/enroll/auto", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: byId("api-base").value,
        api_key: byId("api-key").value,
        api_model: byId("api-model").value,
        bank_id: state.bankId,
        model_label: byId("auto-model").value,
        sample_count: requested,
        temperature: optionalNumber("temperature"),
      }),
    });
  } catch (error) {
    window.clearInterval(progressTimer);
    setMessage(byId("enrollment-message"), error.message, "error");
    button.disabled = false;
    return;
  }
  window.clearInterval(progressTimer);
  const payload = await response.json();
  if (response.ok) {
    state.bank = payload.bank;
    updateUnifiedSummary(payload.unified);
    renderInventory();
    setMessage(byId("enrollment-message"), `采集完成：收到 ${payload.received}/${payload.requested} 份，${payload.accepted} 份进入指纹库，${payload.rejected} 份无效，${payload.errors.length} 次接口错误。`, "success");
  } else {
    setMessage(byId("enrollment-message"), payload.error || "自动采集失败。", "error");
  }
  button.disabled = false;
}

function renderBankOptions(summaries, selected) {
  byId("bank-select").innerHTML = Object.entries(summaries)
    .map(([bankId, bank]) => `<option value="${escapeHtml(bankId)}"${bankId === selected ? " selected" : ""}>${escapeHtml(bank.label)}</option>`)
    .join("");
}

async function createBank(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  const response = await fetch("/api/banks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: byId("new-bank-name").value }),
  });
  const payload = await response.json();
  if (response.ok) {
    window.BANK_SUMMARIES = payload.banks;
    state.bankId = payload.bank.id;
    state.bank = payload.bank;
    updateUnifiedSummary(payload.unified);
    renderBankOptions(payload.banks, state.bankId);
    renderInventory();
    byId("new-bank-name").value = "";
    byId("create-bank-form").hidden = true;
    setMessage(byId("enrollment-message"), `已创建 ${payload.bank.label}`, "success");
  } else {
    setMessage(byId("enrollment-message"), payload.error || "创建失败。", "error");
  }
  button.disabled = false;
}

// ── 历史记录 ──
// 当前的一致性筛选：all 全部 / same 实测一致 / diff 实测不一致
let historyConsistency = "all";

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 历史记录折叠栏尾部的耗时：毫秒转秒，保留一位小数
function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "";
  return `${(Number(ms) / 1000).toFixed(1)} 秒`;
}

// 实测归因结果与请求时填的模型名对不上即视为"不一致"。没有结果的记录不参与一致性判定。
function isModelMismatch(entry) {
  return Boolean(entry.result && entry.result.prediction_name !== entry.api_model);
}

// 折叠摘要徽章的染色：按配置名 hash 取一个固定色号。
// 用 hash 而不是真随机，保证同一个配置每次渲染、每次刷新都是同一种颜色，便于横向比对分类。
const BADGE_PALETTE = [
  { color: "#1d4ed8", background: "#eff6ff", border: "#c9dcff" },
  { color: "#0f766e", background: "#effcf9", border: "#bfe9e0" },
  { color: "#a15c07", background: "#fff7e6", border: "#f0dcb0" },
  { color: "#7c3aed", background: "#f6f1ff", border: "#ded0fb" },
  { color: "#be185d", background: "#fef1f7", border: "#f8cadf" },
  { color: "#0e7490", background: "#eefaff", border: "#c2e6f2" },
  { color: "#4d7c0f", background: "#f5fce9", border: "#d8ecb4" },
  { color: "#b45309", background: "#fff5ed", border: "#f5d7bc" },
];

function badgePaletteFor(text) {
  const value = String(text || "");
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100000007;   // 乘 31 滚动，取模防止溢出
  }
  return BADGE_PALETTE[hash % BADGE_PALETTE.length];
}

function historyMatches(entry, keyword) {
  if (!keyword) return true;
  const haystack = [
    entry.note, entry.config, entry.api_model, entry.base_url,
    entry.result ? entry.result.prediction_name : "",
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

// 一致性筛选：all 全部；same 实测与请求模型名一致；diff 不一致。
// 没有归因结果的记录无从判定一致性，只在「全部」里出现。
function historyMatchesConsistency(entry, mode) {
  if (mode === "same") return Boolean(entry.result) && !isModelMismatch(entry);
  if (mode === "diff") return isModelMismatch(entry);
  return true;
}

function renderHistory() {
  const keyword = byId("history-search").value.trim();
  const all = history();
  const list = all.filter((entry) => (
    historyMatches(entry, keyword) && historyMatchesConsistency(entry, historyConsistency)
  ));
  byId("history-count").textContent = keyword || historyConsistency !== "all"
    ? `${list.length} / ${all.length} 条`
    : `${all.length} 条`;

  if (!list.length) {
    byId("history-list").innerHTML = `<p class="empty-inventory">${all.length ? "没有匹配的记录" : "暂无历史记录，跑一次 API 自动测试试试"}</p>`;
    return;
  }

  byId("history-list").innerHTML = list.map((entry) => {
    const prediction = entry.result ? entry.result.prediction_name : "未产生结果";
    const probability = entry.result ? ` · ${percent(entry.result.probability)}` : "";
    // 成功的记录也可能夹着失败尝试（前面几次报错、后几次收集够数），留档便于复盘
    const failures = entry.failures && entry.failures.length
      ? entry.failures.map((item) => `
          <li><code>#${item.attempt} HTTP ${item.status}</code> <span>${escapeHtml(String(item.body).slice(0, 400))}</span></li>
        `).join("")
      : "";
    // 折叠态徽章：有配置就显示配置名，否则回落显示地址（谁也不属于时至少能看出是哪家）。
    // 颜色按配置名/地址 hash 稳定分配，同名同色，便于在长列表里按线路做视觉分类。
    const badgeText = entry.config || shortUrl(entry.base_url);
    const palette = badgePaletteFor(badgeText);
    const badgeStyle = `color:${palette.color};background:${palette.background};border-color:${palette.border};`;
    const badge = entry.config
      ? `<span class="history-badge config" style="${badgeStyle}">${escapeHtml(entry.config)}</span>`
      : `<span class="history-badge url" style="${badgeStyle}">${escapeHtml(shortUrl(entry.base_url))}</span>`;
    // 实测归因结果与请求时填的模型名对不上时标红。中继站常给模型起别名，
    // 所以这里的含义是"名字对不上、值得看一眼"，而不是"测错了"，因此用低饱和红。
    const mismatch = isModelMismatch(entry);
    const modelTitle = mismatch
      ? ` title="请求模型名 ${escapeHtml(entry.api_model)}，实测更接近 ${escapeHtml(entry.result.prediction_name)}"`
      : "";
    return `
      <details class="history-item">
        <summary>
          <span class="history-time">${escapeHtml(formatTime(entry.at))}</span>
          ${badge}
          <span class="history-model${mismatch ? " mismatch" : ""}"${modelTitle}>${escapeHtml(entry.api_model)}</span>
          <span class="history-outcome">${escapeHtml(prediction)}${probability} · ${entry.accepted}/${entry.attempted} 有效</span>
          ${entry.note ? `<span class="history-note">${escapeHtml(entry.note)}</span>` : ""}
          <span class="history-duration" title="本次测试总耗时">${escapeHtml(formatDuration(entry.latency_ms))}</span>
        </summary>
        <div class="history-detail">
          <div class="history-hero">
            <div class="history-hero-col">
              <span class="history-hero-label">模型名</span>
              <strong class="history-hero-value">${escapeHtml(entry.api_model)}</strong>
              <span class="history-hero-sub">温度 ${entry.temperature === null || entry.temperature === undefined ? "接口默认" : escapeHtml(String(entry.temperature))} · 耗时 ${(entry.latency_ms / 1000).toFixed(1)} 秒</span>
            </div>
            <div class="history-hero-col">
              <span class="history-hero-label">地址</span>
              <strong class="history-hero-value mono">${escapeHtml(entry.base_url)}</strong>
              <span class="history-hero-sub">密钥 <span class="history-secret mono" data-secret="${escapeHtml(entry.api_key)}" title="点击展开/收起">${escapeHtml(maskKey(entry.api_key))}</span></span>
            </div>
            <label class="history-hero-col history-note-field">
              <span class="history-hero-label">备注</span>
              <textarea class="history-note-input" data-note="${entry.id}" rows="2" placeholder="给这次记录起个名字，方便回头找">${escapeHtml(entry.note || "")}</textarea>
            </label>
          </div>
          ${failures ? `<div class="history-failures"><strong>失败响应</strong><ul>${failures}</ul></div>` : ""}
          <div class="history-result">${entry.result ? renderResultHtml(entry.result) : `<p class="empty-inventory">本次测试没有产生归因结果</p>`}</div>
          <div class="action-row"><button class="button secondary" type="button" data-delete-history="${entry.id}">删除这条记录</button></div>
        </div>
      </details>
    `;
  }).join("");

  // 密钥点击展开/收起
  document.querySelectorAll(".history-secret").forEach((node) => {
    node.addEventListener("click", () => {
      const full = node.dataset.secret;
      const hidden = node.textContent.includes("…");
      node.textContent = hidden ? full : maskKey(full);
    });
  });
  // 备注就地编辑
  document.querySelectorAll("[data-note]").forEach((node) => {
    node.addEventListener("change", () => {
      const store = history();
      const hit = store.find((item) => item.id === node.dataset.note);
      if (hit) {
        hit.note = node.value.trim();
        writeStore(HISTORY_KEY, store);
        renderHistory();   // 折叠态也要显示备注徽章，改完立即重渲染
      }
    });
  });
  // 删除单条
  document.querySelectorAll("[data-delete-history]").forEach((node) => {
    node.addEventListener("click", () => {
      writeStore(HISTORY_KEY, history().filter((item) => item.id !== node.dataset.deleteHistory));
      renderHistory();
    });
  });
}

// ── 配置存档（Base URL + API Key）──
let activeConfigId = "";

function configChipHtml(item) {
  const active = item.id === activeConfigId;
  return `
    <div class="config-chip${active ? " active" : ""}" data-config="${escapeHtml(item.id)}">
      <button class="config-chip-main" type="button" data-config-load="${escapeHtml(item.id)}" title="${escapeHtml(item.base_url)}">
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.base_url)}</small>
      </button>
      <button class="config-chip-delete" type="button" data-delete-config="${escapeHtml(item.id)}" aria-label="删除配置 ${escapeHtml(item.name)}" title="删除">×</button>
    </div>
  `;
}

// URL/Key 一旦和当前高亮配置不一致，就取消高亮：
// 载入配置后手动改了地址或密钥，输入框里已不再是那条配置的内容，active 必须同步消失。
function syncActiveConfig() {
  if (!activeConfigId) return;
  const hit = configs().find((item) => item.id === activeConfigId);
  const changed = !hit
    || hit.base_url !== byId("test-api-base").value
    || hit.api_key !== byId("test-api-key").value;
  if (changed) {
    activeConfigId = "";
    renderConfigList();
  }
}

function renderConfigList() {
  const list = configs();
  byId("config-list").innerHTML = list.length
    ? list.map(configChipHtml).join("")
    : `<span class="empty-inventory">还没有保存的配置</span>`;

  // 点胶囊本体 = 载入
  document.querySelectorAll("[data-config-load]").forEach((node) => {
    node.addEventListener("click", () => applyConfig(node.dataset.configLoad));
  });
  // 点尾部删除图标 = 删掉该条
  document.querySelectorAll("[data-delete-config]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      const hit = configs().find((item) => item.id === node.dataset.deleteConfig);
      if (!hit) return;
      if (!window.confirm(`删除配置「${hit.name}」？`)) return;
      deleteConfig(node.dataset.deleteConfig);
    });
  });
}

function applyConfig(id) {
  const hit = configs().find((item) => item.id === id);
  if (!hit) return;
  byId("test-api-base").value = hit.base_url;
  byId("test-api-key").value = hit.api_key;
  byId("config-name").value = hit.name;   // 回填名字，方便改 URL/Key 后同名覆盖
  syncConfigNameClear();
  activeConfigId = hit.id;
  renderConfigList();
  // 先清空旧列表：新配置的模型要等探测返回（防抖 500ms + 网络往返），
  // 这段窗口里若沿用上一个配置的 modelOptions，展开下拉就会选到别人的模型。
  modelOptions = [];
  modelMenuFilter = "";   // 上一个配置残留的过滤词对新列表没有意义
  if (!byId("model-menu").hidden) renderModelMenu();
  probeModels();
  setMessage(byId("config-message"), `已载入「${hit.name}」`, "success");
}

function saveConfig() {
  const baseUrl = byId("test-api-base").value.trim();
  const apiKey = byId("test-api-key").value;
  const name = byId("config-name").value.trim();
  if (!baseUrl || !apiKey) {
    setMessage(byId("config-message"), "先填好 Base URL 和 API Key 再保存。", "error");
    return;
  }
  if (!name) {
    setMessage(byId("config-message"), "给这个配置起个名字。", "error");
    return;
  }
  const list = configs();
  // 保存语义只看名字：同名覆盖，不同名新建（改名 = 新建后删掉旧的）
  const hit = list.find((item) => item.name === name);
  if (hit) {
    Object.assign(hit, { base_url: baseUrl, api_key: apiKey });
    activeConfigId = hit.id;
  } else {
    const created = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name, base_url: baseUrl, api_key: apiKey,
    };
    list.push(created);
    activeConfigId = created.id;
  }
  writeStore(CONFIG_KEY, list);
  renderConfigList();
  setMessage(byId("config-message"), hit ? `已覆盖「${name}」` : `已新建「${name}」`, "success");
}

function deleteConfig(id) {
  const hit = configs().find((item) => item.id === id);
  if (!hit) return;
  writeStore(CONFIG_KEY, configs().filter((item) => item.id !== id));
  if (activeConfigId === id) activeConfigId = "";
  renderConfigList();
  setMessage(byId("config-message"), `已删除「${hit.name}」`, "success");
}

// ── 模型名自动探测（防抖）──
let modelProbeTimer = null;
let modelProbeToken = 0;
let modelOptions = [];

// 输入时按子串过滤（打 sol 就能匹配 gpt-6-sol），但过滤是临时状态：
// 焦点进入或点开列表时展示完整列表，选中一项后也恢复全量。
// 这样既好找模型，又不会像早期"持续过滤"那样——选中一个名字后列表只剩它自己，
// 想换模型必须先用 × 清空。
let modelMenuFilter = "";

function renderModelMenu() {
  const menu = byId("model-menu");
  if (!modelOptions.length) {
    menu.innerHTML = `<div class="combo-empty">暂无模型，可手动输入</div>`;
    return;
  }
  const keyword = modelMenuFilter.trim().toLowerCase();
  const list = keyword
    ? modelOptions.filter((id) => id.toLowerCase().includes(keyword))
    : modelOptions;
  if (!list.length) {
    menu.innerHTML = `<div class="combo-empty">无匹配模型，可手动输入</div>`;
    return;
  }
  menu.innerHTML = list.map((id) => `
    <button class="combo-option${byId("test-api-model").value === id ? " active" : ""}" type="button" role="option" data-model-option="${escapeHtml(id)}">${escapeHtml(id)}</button>
  `).join("");
  document.querySelectorAll("[data-model-option]").forEach((node) => {
    node.addEventListener("click", () => {
      byId("test-api-model").value = node.dataset.modelOption;
      modelMenuFilter = "";   // 选中后恢复全量：下次展开能看到别的模型
      closeModelMenu();
    });
  });
}

function openModelMenu(filter) {
  modelMenuFilter = typeof filter === "string" ? filter : "";
  renderModelMenu();
  byId("model-menu").hidden = false;
  byId("test-api-model").setAttribute("aria-expanded", "true");
}

function closeModelMenu() {
  byId("model-menu").hidden = true;
  byId("test-api-model").setAttribute("aria-expanded", "false");
}

function probeModels() {
  window.clearTimeout(modelProbeTimer);
  // 立即让在途请求失效：token 若等到 runModelProbe 才自增，切换配置后的防抖窗口内
  // 旧配置的响应仍会通过校验并把旧模型列表写回来。
  modelProbeToken += 1;
  modelProbeTimer = window.setTimeout(runModelProbe, 500);   // 防抖：停止输入 500ms 后才发请求
}

async function runModelProbe() {
  const baseUrl = byId("test-api-base").value.trim();
  const apiKey = byId("test-api-key").value;
  if (!baseUrl || !apiKey) {
    modelOptions = [];
    closeModelMenu();
    return;
  }
  const token = modelProbeToken;   // 取调度时已自增的 token，旧请求据此失效
  try {
    const query = new URLSearchParams({ base_url: baseUrl, api_key: apiKey });
    const response = await fetch(`/api/models?${query}`);
    if (token !== modelProbeToken) return;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "探测失败");
    modelOptions = payload.models || [];
    setMessage(byId("model-probe-message"), modelOptions.length ? `探测到 ${modelOptions.length} 个模型` : "未探测到模型，请手动填写", modelOptions.length ? "success" : "working");
  } catch (error) {
    if (token !== modelProbeToken) return;
    modelOptions = [];
    setMessage(byId("model-probe-message"), `模型探测失败：${error.message}`, "working");
  }
  // 焦点仍在输入框里时不会再触发 focus 事件，下拉已展开就必须就地刷新，
  // 否则探测前显示的“暂无模型”会一直留着，要手动失焦再聚焦才更新。
  if (!byId("model-menu").hidden) renderModelMenu();
}

document.querySelectorAll("[data-workspace]").forEach((button) => button.addEventListener("click", () => activateWorkspace(button.dataset.workspace)));
document.querySelectorAll("[data-test-mode]").forEach((button) => button.addEventListener("click", () => activateMode("test", button.dataset.testMode)));
byId("bank-select").addEventListener("change", (event) => selectBank(event.target.value));
byId("regenerate").addEventListener("click", loadChallenges);
byId("analyze").addEventListener("click", analyzeManual);
byId("api-test-form").addEventListener("submit", testViaApi);
// 开始/停止共用同一个按钮：运行中点击即中断当前请求并放弃后续挑战（软停止）
byId("api-test-start").addEventListener("click", (event) => {
  if (!runActive) return;   // 空闲时交给表单 submit，避免重复触发
  event.preventDefault();
  stopTest();
});
byId("auto-enrollment").addEventListener("submit", enrollAutomatically);
byId("show-create-bank").addEventListener("click", () => { byId("create-bank-form").hidden = !byId("create-bank-form").hidden; });
byId("create-bank-form").addEventListener("submit", createBank);

// 配置名清空图标：有内容才显示，点了立即清空并聚焦，方便直接输入新名字
function syncConfigNameClear() {
  byId("config-name-clear").hidden = !byId("config-name").value;
}

byId("config-save").addEventListener("click", saveConfig);
byId("test-api-base").addEventListener("input", () => { probeModels(); syncActiveConfig(); });
byId("test-api-key").addEventListener("input", () => { probeModels(); syncActiveConfig(); });
byId("config-name").addEventListener("input", syncConfigNameClear);
byId("config-name-clear").addEventListener("click", () => {
  byId("config-name").value = "";
  syncConfigNameClear();
  byId("config-name").focus();
});

// 模型下拉：聚焦时展示完整列表，输入时按当前内容过滤；失焦/点击外部关闭
byId("test-api-model").addEventListener("focus", () => openModelMenu());
byId("test-api-model").addEventListener("input", () => openModelMenu(byId("test-api-model").value));
// 一键清空模型名，方便直接重选
byId("model-clear").addEventListener("click", () => {
  byId("test-api-model").value = "";
  byId("test-api-model").focus();
  openModelMenu();
});
byId("model-combo-toggle").addEventListener("click", () => {
  if (byId("model-menu").hidden) {
    byId("test-api-model").focus();
    openModelMenu();
  } else {
    closeModelMenu();
  }
});
byId("model-combo").addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModelMenu();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#model-combo")) closeModelMenu();
});
byId("history-search").addEventListener("input", renderHistory);
// 一致性筛选：互斥的圆角矩形按钮组，点谁谁选中
document.querySelectorAll("[data-model-consistency]").forEach((node) => {
  node.addEventListener("click", () => {
    historyConsistency = node.dataset.modelConsistency;
    document.querySelectorAll("[data-model-consistency]").forEach((item) => {
      const selected = item === node;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-checked", String(selected));
    });
    renderHistory();
  });
});
byId("history-clear").addEventListener("click", () => {
  if (!history().length) return;
  if (!window.confirm("确定清空全部历史记录？该操作不可撤销。")) return;
  writeStore(HISTORY_KEY, []);
  renderHistory();
});

// ── 主题切换 ──
// 首帧主题已由 templates/index.html 头部脚本写入 data-theme（避免深色偏好下闪一帧浅色），
// 这里只负责同步按钮外观、处理点击后的切换与持久化，避免两处各写一套判断。
function applyTheme(theme) {
  const dark = theme === "dark";
  // 测试桩没有 documentElement，线上恒有；统一按可选处理以免抛错
  const root = document.documentElement;
  if (root) root.dataset.theme = dark ? "dark" : "light";
  // 图标与文案表达的是「点下去会切到哪」，不是当前状态
  byId("theme-toggle-icon").textContent = dark ? "☾" : "☀";
  byId("theme-toggle-label").textContent = dark ? "浅色模式" : "深色模式";
  const button = byId("theme-toggle");
  button.setAttribute("aria-pressed", String(dark));
  button.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
}

function currentTheme() {
  const root = document.documentElement;
  return root && root.dataset.theme === "dark" ? "dark" : "light";
}

byId("theme-toggle").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch (error) {
    // 无痕模式等场景 localStorage 可能不可写：主题当次仍生效，不影响其它功能
  }
});

applyTheme(currentTheme());

renderConfigList();
renderHistory();
renderInventory();
loadChallenges();
