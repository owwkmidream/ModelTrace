# ModelTrace Worker 版

把 ModelTrace 部署到 Cloudflare Workers：同一个 Worker 既托管页面，又充当上游 API 的薄代理。

## 为什么需要 Worker

静态版（`static/`，部署在 GitHub Pages）只支持手动测试。要让浏览器直接调上游 API，有两件事在浏览器里做不到：

| 卡点 | 原因 | Worker 如何解决 |
| --- | --- | --- |
| 设置 `User-Agent` | Fetch 规范把它列为 forbidden header，脚本改不了；上游 WAF 见到浏览器/Python UA 会直接 403 | Worker 是服务端，可自由设置（已实测生效） |
| 读跨域响应 | 上游不返回 `Access-Control-Allow-Origin`，`fetch` 拿不到响应体 | Worker 补 CORS 头后再回给浏览器 |

归因评分不经过 Worker：浏览器本地跑 `fingerprint-core.js`（已与 Python 版对齐，CI 有 parity 校验）。

## 结构

```
worker/
├── src/index.js        代理：端点探测、UA 伪装、SSE 透传、CORS
├── assets/api-shim.js  浏览器垫片：本地接口就地算，其余转发给 Worker
├── assets/boot.js      页面入口：先装垫片，再加载 app.js
├── build.mjs           从 templates/index.html 生成 public/
├── public/             构建产物（已提交，CI 校验与源码一致）
└── tests/              代理、垫片、整合三层测试
```

页面不是另抄一份：`build.mjs` 从 Flask 的 `templates/index.html` 生成，静态资源和 `app.js` 也直接取自 `static/`，因此两版 UI 只有一处真相。

## 本地开发

```bash
cd worker
npm install
npm run dev      # 生成站点并起 wrangler dev
npm test         # 运行全部测试
```

## 部署

推送到 `main` 时由 `.github/workflows/worker.yml` 自动部署，需在仓库 Secrets 配置：

- `CLOUDFLARE_API_TOKEN`（需要 Workers Scripts:Edit 权限）
- `CLOUDFLARE_ACCOUNT_ID`

也可手动部署：

```bash
cd worker
npm run deploy
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/probe` | 探测流（SSE）。依次尝试 Responses → Anthropic → Chat，每试一次推一条事件 |
| GET | `/api/models` | 转发上游模型列表 |
| GET | `/api/health` | 存活检查 |

`/api/probe` 的 SSE 事件形状与 Flask 版 `/api/test/probe/stream` 完全一致，前端共用一套渲染逻辑：

```
probe_start  { phase, api_format }
attempt      { phase, api_format, attempt, status, body, ok, done }
probe_end    { phase, api_format, ok }
result       { phase, text, api_format }  或  { phase, error, status, body }
```

请求体可带 `preferred_format`，Worker 会把它提到探测顺序最前，避免每个挑战重探三个端点。

## 与自托管版的差异

纯前端没有可写存储，以下功能会明确返回 501 而不是假装成功：

- 采集并写入新指纹（`/api/enroll/auto`）
- 新建指纹库（`POST /api/banks`）

手头没有运行 Flask 版服务时用 Worker 版，需要采集/多指纹库时用自托管版。
