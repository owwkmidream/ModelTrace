/**
 * 组装 Worker 站点。
 *
 * 页面不是手抄的，而是从 templates/index.html 生成：Flask 模板里头一直是完整 UI
 * （端点卡片、停止按钮、历史记录）的唯一真相，手抄一份必然随时间漂移。
 * 这里只把 Jinja 占位符换成静态值，并把脚本入口换成 boot.js（先装垫片再跑 app.js）。
 *
 * 用法：node worker/build.mjs
 */

import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(HERE, "public");
const SRC = join(HERE, "assets");
const DATA = join(REPO, "data");

// Flask 版在用的静态资源：原样复制，两版行为保持一致
const SHARED_ASSETS = [
  "styles.css",
  "repository-link.css",
  "app.js",
  "fingerprint-core.js",
  "challenge-browser.js",
];
// Worker 版独有：垫片 + 引导脚本，只有 Worker 版需要（Flask 版不需要遮 fetch）
const WORKER_ASSETS = ["api-shim.js", "boot.js"];
// 从 Flask 版静态资源目录复制这些
const FROM_STATIC = new Set(SHARED_ASSETS);

function summarize(bank, id, label) {
  return {
    id,
    label,
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

/** 占位符替换：缺失就报错，避免静默生成半成品页面 */
function replaceOnce(text, needle, value, what) {
  if (!text.includes(needle)) throw new Error(`模板中找不到 ${what}（${needle.slice(0, 60)}）`);
  return text.split(needle).join(value);
}

/** 用正则替换一块结构，匹配不到就报错 */
function replaceBlock(text, pattern, value, what) {
  if (!pattern.test(text)) throw new Error(`模板中找不到 ${what}`);
  return text.replace(pattern, value);
}

async function main() {
  await mkdir(join(OUT, "data"), { recursive: true });

  const bank = JSON.parse(await readFile(join(DATA, "unified_bank.json"), "utf8"));
  const label = "全部指纹";
  const summary = summarize(bank, "unified", label);
  const families = [...new Set(bank.models.map((model) => model.family || "models"))];
  const unified = {
    id: "unified",
    label,
    model_count: summary.model_count,
    response_count: summary.response_count,
    family_count: families.length,
    families: families.map((family) => ({
      id: family,
      label: family,
      model_count: bank.models.filter((model) => (model.family || "models") === family).length,
    })),
  };
  const banks = { unified: summary };

  for (const name of [...SHARED_ASSETS, ...WORKER_ASSETS]) {
    const from = FROM_STATIC.has(name) ? join(REPO, "static", name) : join(SRC, name);
    await copyFile(from, join(OUT, name));
  }
  await copyFile(join(DATA, "unified_bank.json"), join(OUT, "data", "unified_bank.json"));

  let html = await readFile(join(REPO, "templates", "index.html"), "utf8");
  html = replaceOnce(html, "{{ url_for('static', filename='styles.css') }}", "./styles.css", "styles.css");
  html = replaceOnce(html, "{{ url_for('static', filename='repository-link.css') }}", "./repository-link.css", "repository-link.css");
  html = replaceOnce(html, "{{ url_for('static', filename='app.js') }}", "./app.js", "app.js");
  html = html.split("{{ unified.model_count }}").join(String(unified.model_count));
  html = replaceOnce(html, "{{ bank.label }}", label, "bank.label");

  // Worker 版只有统一指纹库，没有多库切换
  html = replaceBlock(
    html,
    /<select id="bank-select">[\s\S]*?<\/select>/,
    `<select id="bank-select"><option value="unified" selected>${label}</option></select>`,
    "bank-select",
  );
  html = replaceBlock(
    html,
    /<datalist id="model-options">[\s\S]*?<\/datalist>/,
    `<datalist id="model-options">${bank.models.map((model) => `<option value="${model.id}">`).join("")}</datalist>`,
    "model-options datalist",
  );

  const globals = `window.BANK_SUMMARIES = ${JSON.stringify(banks)};`
    + ` window.UNIFIED_SUMMARY = ${JSON.stringify(unified)};`
    + ` window.DEFAULT_BANK_ID = "unified";`;
  html = replaceBlock(html, /<script>window\.BANK_SUMMARIES[\s\S]*?<\/script>/, `<script>${globals}</script>`, "全局变量脚本");
  // 垫片必须先于 app.js 安装：交给模块入口按顺序装配
  html = replaceBlock(html, /<script src="\.\/app\.js"><\/script>/, `<script type="module" src="./boot.js"></script>`, "app.js 脚本标签");

  await writeFile(join(OUT, "index.html"), html, "utf8");
  process.stdout.write(`worker/public 已生成：${summary.model_count} 个模型，${summary.response_count} 条指纹\n`);
}

main().catch((error) => {
  process.stderr.write(`构建失败：${error.message}\n`);
  process.exit(1);
});
