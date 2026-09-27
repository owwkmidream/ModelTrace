/**
 * 浏览器端 API 垫片
 *
 * app.js 原本对着 Flask 的 /api/* 说事。在 Worker 版里不能让整套 UI 逻辑再抄一遍，
 * 所以这里拦住 fetch，把接口分成三类处理：
 *   1. 浏览器能自己算的（生成挑战、归因评分、读指纹库）→ 本地直接算，不发出网络请求
 *   2. 只能服务端做的（设 User-Agent、绕 CORS）→ 转发给 Worker 的 /api/probe
 *   3. 依赖可写存储的（采集指纹、新建指纹库）→ 明确回 501，不假装成功
 *
 * installApiShim 接收依赖而非直接引用全局，方便在 Node 里用桩测试。
 */

/** FNV-1a：仅作本地缓存键，避免把 API Key 再存一份明文 */
export function formatCacheKey(baseUrl, apiKey) {
  const text = `${baseUrl}|${apiKey}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `modeltrace.format.${hash.toString(16)}`;
}

export function installApiShim(deps) {
  const {
    win = globalThis,
    analyzeGlobalOutputs,
    parseNumbers,
    generateChallenges,
    bank,
    bankSummary,
  } = deps;

  const nativeFetch = win.fetch.bind(win);

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  /**
   * 单帧 SSE 响应。
   * app.js 的读取器只认 SSE 帧，所以"探测失败"这类结论也必须走 SSE 通道，
   * 否则错误会退化成"探测流意外结束"，把上游真实原因吞掉。
   */
  function resultFrame(payload) {
    const event = { phase: "result", ...payload };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }

  function readFormatCache(key) {
    try {
      return win.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeFormatCache(key, value) {
    try {
      win.localStorage.setItem(key, value);
    } catch {
      /* 隐私模式等场景下写入失败，只是失去缓存，不影响本次测试 */
    }
  }

  /**
   * 转写 Worker 的 SSE 流：
   *   - 给 result 帧补上 app.js 期望的验收字段（有效数字、阈值、是否计入）
   *   - 顺手把命中的 api_format 记进本地缓存，下一次挑战就不用重新探测
   * 按 "\n\n" 分帧，残缺尾段留在 buffer 里等下一片，避免 JSON 被 chunk 边界切断。
   */
  function rewriteProbeStream(response, expectedCount, cacheStoreKey) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const minimum = Math.max(80, Math.ceil(expectedCount * 0.55));
    let buffer = "";

    const emitEvent = (controller, event) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    const parseFrame = (frame) => {
      const line = frame.split("\n").find((item) => item.startsWith("data:"));
      if (!line) return null;
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return null;   // 残缺帧直接丢弃，流式渲染不需要它
      }
    };

    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop();
        for (const frame of frames) {
          let event = parseFrame(frame);
          if (!event) continue;
          if (event.phase === "result") {
            if (event.api_format) writeFormatCache(cacheStoreKey, event.api_format);
            if (typeof event.text === "string") {
              const parsed = parseNumbers(event.text).length;
              event = {
                ...event,
                parsed_numbers: parsed,
                minimum_numbers: minimum,
                accepted: parsed >= minimum,
              };
            }
          }
          emitEvent(controller, event);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        for (const frame of buffer.split("\n\n")) {
          const event = parseFrame(frame);
          if (event) emitEvent(controller, event);
        }
      },
    }));

    return new Response(stream, {
      status: response.status,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }

  async function callProbe(body, signal) {
    const cacheStoreKey = formatCacheKey(body.base_url, body.api_key);
    const response = await nativeFetch("/api/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        ...body,
        // 带上上次探测成功的格式，Worker 优先用它，避免每次重探三个端点
        preferred_format: readFormatCache(cacheStoreKey) || undefined,
      }),
    });
    if (!response.ok || !response.body) {
      return resultFrame({ error: `探测接口返回 ${response.status}` });
    }
    return rewriteProbeStream(response, Number(body.expected_count) || 0, cacheStoreKey);
  }

  async function handleProbeStream(init) {
    const body = JSON.parse(init.body || "{}");
    if (!body.base_url || !body.api_key || !body.api_model) {
      return resultFrame({ error: "缺少 base_url / api_key / api_model" });
    }
    return callProbe(body, init.signal);
  }

  win.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];

    if (path === "/api/challenges") {
      return jsonResponse({ challenges: generateChallenges(3) });
    }

    if (path === "/api/analyze") {
      try {
        const outputs = JSON.parse(init.body).outputs;
        const result = analyzeGlobalOutputs(outputs, bank);
        return jsonResponse({ ...result, bank: bankSummary() });
      } catch (error) {
        return jsonResponse({ error: String((error && error.message) || error) }, 400);
      }
    }

    if (path === "/api/bank") {
      return jsonResponse(bankSummary());
    }

    if (path === "/api/banks") {
      // 新建指纹库要落盘，纯前端做不到；如实告知而不是假装成功
      if (method === "POST") {
        return jsonResponse({ error: "Worker 版不支持新建指纹库，请使用自托管版本" }, 501);
      }
      return jsonResponse({ unified: bankSummary() });
    }

    if (path === "/api/enroll/auto") {
      return jsonResponse({ error: "Worker 版不支持采集指纹：写入指纹库需要服务端存储，请使用自托管版本" }, 501);
    }

    if (path === "/api/test/probe/stream") {
      return handleProbeStream(init);
    }

    // /api/models 等其余请求按原样发出（User-Agent 由 Worker 补上）
    return nativeFetch(input, init);
  };

  return { formatCacheKey };
}
