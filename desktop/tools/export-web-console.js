/**
 * 网页版数据导出脚本（浏览器控制台用）
 * ============================================================
 *
 * 用途：把网页版存在 localStorage 里的「已存配置」和「历史记录」导出成一个 JSON 文件，
 *      该文件可直接被桌面版 ModelTrace 导入（桌面版「指纹库与设置」页有导入按钮）。
 *
 * 为什么需要转换：两端字段命名不同。
 *   网页版：base_url / api_key / at / api_model / config / result ...
 *   桌面版：BaseUrl / ApiKey / StartedAt / RequestedModel / PredictedName ...
 *   脚本在浏览器里就完成转换，导出的文件桌面版可直接读，不需要中间步骤。
 *
 * ── 用法 ──
 * 1. 在浏览器打开 ModelTrace 网页版（GitHub Pages / Worker / 本地 Flask 任一版本）；
 * 2. 按 F12 打开开发者工具，切到 Console（控制台）；
 * 3. 把本文件全部内容粘贴进去，回车；
 * 4. 浏览器会下载 modeltrace-export-<日期>.json；
 * 5. 在桌面版「指纹库与设置 → 导入网页版数据」里选择该文件。
 *
 * 说明：本站页面可能设置了 CSP，若控制台拒绝执行，请改用「Sources → Snippets」新建片段运行。
 * 本脚本只读取本页 localStorage，不发起任何网络请求，不会外传数据。
 */

(() => {
  'use strict';

  const CONFIG_KEY = 'modeltrace.configs';
  const HISTORY_KEY = 'modeltrace.history';
  const THEME_KEY = 'modeltrace.theme';

  /** 安全读取 localStorage 里的数组；内容损坏时按空处理，与网页版行为一致。 */
  function readStore(key) {
    try {
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn(`[导出] ${key} 解析失败，按空处理：`, error);
      return [];
    }
  }

  /** 统一的 RFC3339 时间串，缺失时用当前时间兜底，避免桌面版读入空值。 */
  function toIso(value) {
    if (!value) return new Date().toISOString();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  /**
   * 配置：网页版 {id, name, base_url, api_key} → 桌面版 {Id, Name, BaseUrl, ApiKey, CreatedAt}。
   * 桌面版要求 Id 非空，缺失时补一个，否则批量导入会因主键冲突互相覆盖。
   */
  function convertConfigs(items) {
    return items
      .filter((item) => item && (item.base_url || item.api_key))
      .map((item, index) => ({
        Id: String(item.id || `web-config-${index}-${Date.now()}`),
        Name: String(item.name || `未命名配置 ${index + 1}`),
        BaseUrl: String(item.base_url || ''),
        ApiKey: String(item.api_key || ''),
        // 网页版没记录配置创建时间，用导出时刻，避免出现空字段
        CreatedAt: new Date().toISOString(),
      }));
  }

  /**
   * 历史：网页版条目字段多且 result 是嵌套结构，逐项映射到桌面版形状。
   * 判定「模型一致」的规则与网页版一致：请求名包含预测名即视为一致。
   */
  function convertHistory(items) {
    return items
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => {
        const result = item.result || null;
        const predictedModel = result ? result.prediction || null : null;
        const predictedName = result ? result.prediction_name || predictedModel : null;
        const requested = String(item.api_model || '');

        // 请求名与预测名不一致时标红，与网页版 isModelMismatch 保持同一判据
        const mismatch = Boolean(predictedModel) &&
          !requested.toLowerCase().includes(String(predictedModel).toLowerCase());

        let status;
        if (!result) status = '未得出结论';
        else if (mismatch) status = '模型不一致';
        else status = '模型一致';

        // failures 是失败响应留档，映射成桌面版的 Responses
        const failures = Array.isArray(item.failures) ? item.failures : [];
        const responses = failures.map((failure, failureIndex) => ({
          ApiFormat: String(item.api_format || 'auto'),
          Attempt: Number(failure && failure.attempt) || failureIndex + 1,
          Status: Number(failure && failure.status) || 0,
          Ok: false,
          Body: String((failure && (failure.body || failure.error)) || ''),
        }));

        return {
          Id: String(item.id || `web-history-${index}-${Date.now()}`),
          StartedAt: toIso(item.at),
          Mode: 'api',
          BaseUrl: String(item.base_url || ''),
          RequestedModel: requested,
          PredictedModel: predictedModel,
          PredictedName: predictedName,
          Probability: result && typeof result.probability === 'number' ? result.probability : null,
          UsedOutputs: Number(item.accepted) || 0,
          Status: status,
          // 备注与配置名都保留：配置名拼进备注，避免这条信息在迁移后丢失
          Note: [item.note, item.config ? `配置：${item.config}` : '']
            .filter(Boolean)
            .join(' · ') || null,
          Responses: responses,
        };
      });
  }

  // ── 执行导出 ──

  const rawConfigs = readStore(CONFIG_KEY);
  const rawHistory = readStore(HISTORY_KEY);
  const theme = (() => {
    try { return window.localStorage.getItem(THEME_KEY) || null; } catch { return null; }
  })();

  const payload = {
    schema: 'modeltrace-web-export/1',
    exported_at: new Date().toISOString(),
    source: window.location.origin + window.location.pathname,
    theme: theme,
    configs: convertConfigs(rawConfigs),
    history: convertHistory(rawHistory),
  };

  if (!payload.configs.length && !payload.history.length) {
    console.warn('[导出] 本页 localStorage 里没有找到配置或历史记录。');
    console.warn(`[导出] 已检查的键：${CONFIG_KEY}（${rawConfigs.length} 条）、${HISTORY_KEY}（${rawHistory.length} 条）。`);
    console.warn('[导出] 请确认：1) 当前是原来保存过数据的那个域名；2) 未使用无痕模式。');
    return;
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const link = document.createElement('a');
  link.href = url;
  link.download = `modeltrace-export-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 交给浏览器读完再释放，立即 revoke 在部分浏览器上会导致下载失败
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  console.log(
    `[导出] 完成：配置 ${payload.configs.length} 条，历史 ${payload.history.length} 条。\n` +
    `[导出] 文件名 modeltrace-export-${stamp}.json，可在桌面版「指纹库与设置 → 导入网页版数据」导入。`
  );
})();
