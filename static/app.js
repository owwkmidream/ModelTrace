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

function configs() {
  return readStore(CONFIG_KEY);
}

// 按 base_url + api_key 匹配存档，取其名字作为历史记录的备注
function configNameFor(baseUrl, apiKey) {
  const hit = configs().find((item) => item.base_url === baseUrl && item.api_key === apiKey);
  return hit ? hit.name : "";
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
  // 只展示有概率的候选，过滤掉 0 值行以免噪音
  const winners = payload.results.filter((item) => item.probability > 0);
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

function renderResult(payload) {
  byId("result").innerHTML = renderResultHtml(payload);
  byId("result").hidden = false;
  byId("result").scrollIntoView({ behavior: "smooth", block: "start" });
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

function renderApiProgress(states, status) {
  const valid = states.filter((state) => state === "done").length;
  const attempted = states.filter((state) => ["done", "invalid", "error"].includes(state)).length;
  const target = 3;
  byId("api-test-progress").hidden = false;
  byId("api-progress-status").textContent = status;
  byId("api-progress-count").textContent = `有效 ${valid}/${target} · 已尝试 ${attempted}/${states.length}`;
  byId("api-progress-fill").style.width = `${(valid / target) * 100}%`;
  byId("api-progress-steps").innerHTML = states.map((state, index) => {
    const labels = { pending: "等待", working: "请求中", done: "有效", invalid: "数字不足", error: "接口失败", skipped: "无需调用" };
    return `<span class="progress-step ${state}"><b>${index + 1}</b>挑战 ${index + 1} · ${labels[state]}</span>`;
  }).join("");
}

async function testViaApi(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  byId("result").hidden = true;
  setMessage(byId("test-message"), "");

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
  renderApiProgress(states, "已生成独立挑战，准备调用模型");

  for (let index = 0; index < challenges.length && outputs.length < target; index += 1) {
    states[index] = "working";
    renderApiProgress(states, `正在进行第 ${index + 1} 次尝试，等待模型完整输出……`);
    try {
      const response = await fetch("/api/test/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...configuration,
          prompt: challenges[index].prompt,
          expected_count: challenges[index].expected_count,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        failures.push({
          attempt: index + 1,
          status: payload.status || response.status,
          body: payload.body || payload.error || "",
        });
        throw new Error(payload.error || "接口请求失败");
      }
      if (payload.accepted) {
        outputs.push({ text: payload.text, expected_count: challenges[index].expected_count });
        states[index] = "done";
      } else {
        errors.push(`尝试 ${index + 1}: 有效数字 ${payload.parsed_numbers}/${payload.minimum_numbers}`);
        states[index] = "invalid";
      }
    } catch (error) {
      errors.push(`尝试 ${index + 1}: ${error.message}`);
      states[index] = "error";
    }
    renderApiProgress(states, `当前已有 ${outputs.length}/${target} 份有效回答`);
  }

  if (outputs.length === target) {
    states.forEach((state, index) => { if (state === "pending") states[index] = "skipped"; });
  }

  if (!outputs.length) {
    renderApiProgress(states, "六次尝试后仍没有可用回答");
    setMessage(byId("test-message"), `没有获得可分析输出。${errors[0] || ""}`, "error");
    appendHistory({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      base_url: configuration.base_url,
      api_key: configuration.api_key,
      api_model: configuration.api_model,
      temperature: configuration.temperature,
      note: configNameFor(configuration.base_url, configuration.api_key),
      accepted: 0,
      attempted: states.filter((state) => ["done", "invalid", "error"].includes(state)).length,
      failures,
      latency_ms: Date.now() - startedAt,
      result: null,
    });
    renderHistory();
    button.disabled = false;
    return;
  }

  renderApiProgress(states, "模型回答已收齐，正在计算归因概率……");
  const analysisResponse = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputs }),
  });
  const result = await analysisResponse.json();
  if (analysisResponse.ok) {
    const attempted = states.filter((state) => ["done", "invalid", "error"].includes(state)).length;
    result.api_test = { requested: target, attempted, max_attempts: challenges.length, received: outputs.length, errors };
    renderApiProgress(states, `测试完成：${outputs.length}/${target} 份有效回答进入归因`);
    renderResult(result);
    appendHistory({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      base_url: configuration.base_url,
      api_key: configuration.api_key,
      api_model: configuration.api_model,
      temperature: configuration.temperature,
      note: configNameFor(configuration.base_url, configuration.api_key),
      accepted: outputs.length,
      attempted,
      failures,
      latency_ms: Date.now() - startedAt,
      result,
    });
  } else {
    setMessage(byId("test-message"), result.error || "API 自动测试失败。", "error");
    appendHistory({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      base_url: configuration.base_url,
      api_key: configuration.api_key,
      api_model: configuration.api_model,
      temperature: configuration.temperature,
      note: configNameFor(configuration.base_url, configuration.api_key),
      accepted: outputs.length,
      attempted: states.filter((state) => ["done", "invalid", "error"].includes(state)).length,
      failures: [...failures, { attempt: 0, status: analysisResponse.status, body: result.error || "" }],
      latency_ms: Date.now() - startedAt,
      result: null,
    });
  }
  renderHistory();
  button.disabled = false;
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
function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function historyMatches(entry, keyword) {
  if (!keyword) return true;
  const haystack = [
    entry.note, entry.api_model, entry.base_url,
    entry.result ? entry.result.prediction_name : "",
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

function renderHistory() {
  const keyword = byId("history-search").value.trim();
  const all = history();
  const list = all.filter((entry) => historyMatches(entry, keyword));
  byId("history-count").textContent = keyword
    ? `${list.length} / ${all.length} 条`
    : `${all.length} 条`;

  if (!list.length) {
    byId("history-list").innerHTML = `<p class="empty-inventory">${all.length ? "没有匹配的记录" : "暂无历史记录，跑一次 API 自动测试试试"}</p>`;
    return;
  }

  byId("history-list").innerHTML = list.map((entry) => {
    const prediction = entry.result ? entry.result.prediction_name : "未产生结果";
    const probability = entry.result ? ` · ${percent(entry.result.probability)}` : "";
    const failures = entry.failures && entry.failures.length
      ? entry.failures.map((item) => `
          <li><code>#${item.attempt} HTTP ${item.status}</code> <span>${escapeHtml(String(item.body).slice(0, 400))}</span></li>
        `).join("")
      : "";
    return `
      <details class="history-item">
        <summary>
          <span class="history-time">${escapeHtml(formatTime(entry.at))}</span>
          <span class="history-model">${escapeHtml(entry.api_model)}</span>
          <span class="history-outcome">${escapeHtml(prediction)}${probability} · ${entry.accepted}/${entry.attempted} 有效</span>
          ${entry.note ? `<span class="history-note">${escapeHtml(entry.note)}</span>` : ""}
        </summary>
        <div class="history-detail">
          <dl class="history-meta">
            <div><dt>地址</dt><dd>${escapeHtml(entry.base_url)}</dd></div>
            <div><dt>密钥</dt><dd class="history-secret" data-secret="${escapeHtml(entry.api_key)}">${escapeHtml(maskKey(entry.api_key))}</dd></div>
            <div><dt>模型名</dt><dd>${escapeHtml(entry.api_model)}</dd></div>
            <div><dt>温度</dt><dd>${entry.temperature === null || entry.temperature === undefined ? "接口默认" : escapeHtml(String(entry.temperature))}</dd></div>
            <div><dt>耗时</dt><dd>${(entry.latency_ms / 1000).toFixed(1)} 秒</dd></div>
            <div><dt>备注</dt><dd><input class="history-note-input" data-note="${entry.id}" value="${escapeHtml(entry.note || "")}" placeholder="给这次记录起个名字"></dd></div>
          </dl>
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
  activeConfigId = hit.id;
  renderConfigList();
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

function renderModelMenu(filter) {
  const menu = byId("model-menu");
  const keyword = (filter || "").trim().toLowerCase();
  const list = keyword
    ? modelOptions.filter((id) => id.toLowerCase().includes(keyword))
    : modelOptions;
  if (!list.length) {
    menu.innerHTML = `<div class="combo-empty">${modelOptions.length ? "没有匹配的模型" : "暂无模型，可手动输入"}</div>`;
    return;
  }
  menu.innerHTML = list.map((id) => `
    <button class="combo-option" type="button" role="option" data-model-option="${escapeHtml(id)}">${escapeHtml(id)}</button>
  `).join("");
  document.querySelectorAll("[data-model-option]").forEach((node) => {
    node.addEventListener("click", () => {
      byId("test-api-model").value = node.dataset.modelOption;
      closeModelMenu();
    });
  });
}

function openModelMenu() {
  renderModelMenu(byId("test-api-model").value);
  byId("model-menu").hidden = false;
  byId("test-api-model").setAttribute("aria-expanded", "true");
}

function closeModelMenu() {
  byId("model-menu").hidden = true;
  byId("test-api-model").setAttribute("aria-expanded", "false");
}

function probeModels() {
  window.clearTimeout(modelProbeTimer);
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
  const token = ++modelProbeToken;   // 防止旧请求覆盖新结果
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
}

document.querySelectorAll("[data-workspace]").forEach((button) => button.addEventListener("click", () => activateWorkspace(button.dataset.workspace)));
document.querySelectorAll("[data-test-mode]").forEach((button) => button.addEventListener("click", () => activateMode("test", button.dataset.testMode)));
byId("bank-select").addEventListener("change", (event) => selectBank(event.target.value));
byId("regenerate").addEventListener("click", loadChallenges);
byId("analyze").addEventListener("click", analyzeManual);
byId("api-test-form").addEventListener("submit", testViaApi);
byId("auto-enrollment").addEventListener("submit", enrollAutomatically);
byId("show-create-bank").addEventListener("click", () => { byId("create-bank-form").hidden = !byId("create-bank-form").hidden; });
byId("create-bank-form").addEventListener("submit", createBank);

byId("config-save").addEventListener("click", saveConfig);
byId("test-api-base").addEventListener("input", probeModels);
byId("test-api-key").addEventListener("input", probeModels);

// 模型下拉：点击展开、输入过滤、失焦/点击外部关闭
byId("test-api-model").addEventListener("focus", openModelMenu);
byId("test-api-model").addEventListener("input", openModelMenu);
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
byId("history-clear").addEventListener("click", () => {
  if (!history().length) return;
  if (!window.confirm("确定清空全部历史记录？该操作不可撤销。")) return;
  writeStore(HISTORY_KEY, []);
  renderHistory();
});

renderConfigList();
renderHistory();
renderInventory();
loadChallenges();
