/**
 * Worker 版页面入口。
 *
 * app.js 是普通脚本（无 import），它调用 /api/* 时期望这些接口已经可用。
 * 因此顺序是：先装垫片 → 再动态加载 app.js。这样 app.js 与 Flask 版共用同一份，
 * 不需要为 Worker 版维护第二套 UI 逻辑。
 */

import { installApiShim } from "./api-shim.js";
import { analyzeGlobalOutputs, parseNumbers } from "./fingerprint-core.js";
import { generateChallenges } from "./challenge-browser.js";

const bank = await fetch("./data/unified_bank.json", { cache: "no-cache" }).then((response) => {
  if (!response.ok) throw new Error(`指纹库加载失败（HTTP ${response.status}）`);
  return response.json();
});

// bankSummary 复刻 Flask 版 summarized_bank 的形状，供垫片与库存面板使用。
// window.BANK_SUMMARIES / UNIFIED_SUMMARY 已由 build.mjs 注入完整模型清单，这里不再覆盖。
function bankSummary() {
  return {
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
  };
}

installApiShim({
  win: window,
  analyzeGlobalOutputs,
  parseNumbers,
  generateChallenges,
  bank,
  bankSummary,
});

// 垫片就绪后再加载 app.js：它是普通脚本，加载时会立即绑定 DOM 事件
await import("./app.js");
