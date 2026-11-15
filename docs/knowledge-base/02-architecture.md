# 02 架构总览

> 本章回答：**进程怎么起、请求怎么流、代码怎么分层、错误怎么回、常量在哪。**
> 入口文件只有一个：`server/app.js`（251 行），先读它再读别的。

## 1. 部署形态

- **单进程 Node.js + Express 5**：同一个端口同时提供静态页面（`public/`）与 `/api` 接口；
- **SQLite 单文件**数据库，WAL 模式，同机同进程访问（没有独立数据库服务）；
- 上游 AI 服务由后端 `fetch` 直连（OpenAI 兼容），浏览器不直连；
- 不内置 HTTPS、反向代理、进程守护——生产需要自行套 Nginx/Caddy + systemd/PM2/NSSM（见 [08](08-config-and-ops.md)）。

```text
浏览器 ──HTTP──▶ Express 进程
                 │
                 ├─ 静态中间件 ──▶ public/ 下的 html/css/js
                 │
                 └─ /api 中间件链 ──▶ routes/* ──▶ services/* ──┬─▶ SQLite (data/chenlong.db)
                                                              └─▶ 上游 AI 服务 (fetch, SSE)
```

## 2. 启动流程（server/app.js）

按执行顺序：

| # | 步骤 | 位置 | 说明 |
|---|---|---|---|
| 1 | 加载 `.env` | app.js:3 | `dotenv.config({ path: ../.env, quiet: true })` |
| 2 | 定义常量 | app.js:18–30 | 端口、环境、版本、会话时长、5 组限流规则 |
| 3 | 构造 5 个限流器 | app.js:36–62 | 全局(写)/登录/注册/改密/聊天；`countWritesOnly` 包装全局器(64–69) |
| 4 | `ensureSecrets()` | app.js:71–109 | 生产缺密钥直接 exit(1)；开发走 `data/.dev-secrets.json` 兜底 |
| 4.5 | `assertEncryptionKey()` | app.js:112–124 | 启动哨兵自检（encrypt→decrypt）；`ENCRYPTION_KEY` 不可用即 `[FATAL]` exit(1) |
| 5 | 创建 app | app.js:111–115 | 关闭 `x-powered-by`；`TRUST_PROXY=1/true/yes/on` 时信任一层代理 |
| 6 | 全局中间件 | app.js:117–138 | 安全头 → body 解析(1 MB) → session → 静态目录 |
| 7 | 健康检查 | app.js:140–153 | `GET /api/health`，在限流/鉴权之前 |
| 8 | /api 链 | app.js:155–176 | 全局限流(仅写) → attachUser → CSRF token 端点 → CSRF 校验 → 专项限流 |
| 9 | 挂载路由 | app.js:178–185 | auth/chat/providers/models/user/users/admin/settings |
| 10 | 兜底 | app.js:187–201 | `/api` 404 + 全局错误处理器 |
| 11 | `start()` | app.js:203–246 | initDatabase → listen → 错误处理 → 优雅退出 |
| 12 | 导出 | app.js:248–249 | `module.exports = app; module.exports.start = start` |

> 注意：**require 这个模块不会建库**。数据库初始化只发生在 `start()` 里；但路由/服务里的 `getDb()` 是惰性打开连接，所以被外部托管时也应先确保调过 `initDatabase()`。

启动日志关键行：`尘龙 ChenLong v0.1.0 已启动：http://127.0.0.1:3000 (development)`；端口占用则输出 `[FATAL] 端口 xxx 已被占用` 并退出。

## 3. 中间件执行顺序（核心）

| 顺序 | 中间件 | 作用域 | 作用 | 为什么在这个位置 |
|---|---|---|---|---|
| 1 | `security-headers` | 全站 | CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、HSTS(仅 https) | 必须最早，覆盖所有响应包括错误页 |
| 2 | `express.json / urlencoded` | 全站 | 解析 JSON/表单，上限 1 MB | 后面所有 handler 都要 `req.body` |
| 3 | `session` | 全站 | Cookie `chenlong.sid` + SqliteSessionStore，7 天 | CSRF/登录态都依赖 session |
| 4 | `express.static(public)` | 全站 | 静态页面直出 | 在 API 之前，避免被 API 404 吞掉；命中后不再走后面 |
| 5 | `GET /api/health` | /api | 数据库连通性自检 | 故意避开限流与 CSRF，供探活使用 |
| 6 | 全局限流（写请求） | /api 非 GET/HEAD/OPTIONS | 300 次/分钟/IP | GET 全部放行，避免刷页面被误伤 |
| 7 | `attachUser` | /api | 从 session.userId 查 users，挂 `req.user`；用户被禁用/不存在则销毁会话并继续（匿名） | 鉴权判断的前置数据 |
| 8 | `GET /api/csrf-token` | /api | 首次访问生成并返回 session 里的 token | **必须在 CSRF 校验之前**，否则首屏拿不到 token |
| 9 | `requireCsrf` | /api 非 GET/HEAD/OPTIONS | 校验 `X-CSRF-Token`（timingSafeEqual） | 所有写操作统一防跨站 |
| 10 | 专项限流 | 具体路径 | 登录 10 次/5 分钟/IP；注册 5 次/10 分钟/IP；重置密码 10 次/分钟/管理员；聊天 20 次/分钟/用户 | 放在 CSRF 之后，避免攻击者用无效请求触发限流计数 |
| 11 | 业务路由 | 各 `/api/*` | auth/chat/providers/models/user/users/admin/settings | — |
| 12 | `/api` 404 | /api 未匹配 | 统一 `NOT_FOUND` 信封 | 保证接口错误格式一致 |
| 13 | 全局错误处理 | 全站 | 状态码透传、生产隐藏 5xx 细节、统一 code | 最后一道兜底 |

> 实现细节：`attachUser` 对"已禁用用户"的处理是 **销毁 session 后继续**（`middleware/auth.js:20-21`），不会直接 401；后续依赖 `requireAuth` 的接口会返回 401，而公开接口（如 `/api/settings`）正常返回匿名数据。这是一种温和降级，不是漏洞。

## 4. 三个典型请求的完整路径

### 4.1 静态页面 `GET /chat.html`

安全头 → body 解析(空) → session → **静态命中** → 返回 HTML（ETag/Last-Modified 由 Express 默认处理）。页面鉴权在前端 `guard.js` 里做，服务端不拦 HTML。

### 4.2 登录 `POST /api/auth/login`

安全头 → JSON 解析 → session → 静态未命中 → 全局限流(写) → attachUser → requireCsrf（校验 `X-CSRF-Token`）→ 登录限流(10/5min/IP) → 路由：
1. 校验用户名/密码非空；
2. 查用户；**用户不存在时也执行一次 bcrypt 比对**（`burnPasswordCompare`，auth.js:20–24，抹平时间差）；
3. 比对密码、检查 `status==='active'`；
4. `startSession`：`session.regenerate()` → 写 `userId` → 重新生成 CSRF token → `session.save()`（防会话固定，且旧 token 失效）；
5. `200 { user, csrfToken }`（前端要把新 token 存起来，见 [05](05-frontend.md)）。

### 4.3 聊天 `POST /api/chat/completions`（SSE）

前 9 步同上 → 聊天限流(20/分钟/用户) → 路由内：`isChatAllowed` → 校验消息 → 解析模型 → 解析/创建会话 → **先落库用户消息** → 构造上下文 → `complete()`：
- 解密 API Key → 刷新 SSE 响应头并 flush → 发 `start` 帧 → 调上游流式接口 → 每个增量发 `delta` 帧 → 成功后落库助手消息 → 发 `done` 帧 → 发 `data: [DONE]` 并结束响应；
- 上游失败 → `error` 帧 + `[DONE]`；客户端断开 → abort 上游，**已收到的非空内容仍落库**。

详细时序与帧协议见 [06 聊天与 SSE 流程](06-chat-flow.md)。

## 5. 分层与依赖

| 层 | 目录 | 职责 | 允许依赖 |
|---|---|---|---|
| 入口/装配 | `server/app.js` | 中间件顺序、路由挂载、错误处理、启动/退出 | middleware / services / routes / database |
| 横切 | `server/middleware/` | 认证、鉴权、CSRF、安全头 | database、session |
| 接口层 | `server/routes/` | 参数校验、组装响应、错误码 | services、middleware |
| 服务层 | `server/services/` | 业务规则、上游调用、存储读写、加密、限流 | database、其他 services（有限） |
| 数据层 | `server/database/` | 连接单例、建表/索引/播种 | 无 |

```text
app.js
 ├─ middleware/{auth,admin,csrf,security-headers}
 ├─ services/{session-store,dev-secrets,rate-limit}
 └─ routes/{auth,profile,users,providers,models,chat,settings,admin}
        ├─ services/{validation,settings-store,encryption,key-mask,chat-store}
        ├─ services/provider-client ──▶ services/upstream-guard
        ├─ services/chat-client     ──▶ services/upstream-guard + provider-client(normalizeBaseUrl)
        └─ database/db
```

- **没有依赖注入容器**，全部 `require` 单例：数据库连接（`db.js` 的 `instance`）、设置默认值缓存、加密 key 缓存（按 ENCRYPTION_KEY 原文缓存）、限流命中表（`Map`）。
- 唯一的"反向依赖"是 `settings-store `require` database/init` 的 `SETTINGS_DEFAULTS`（有 fallback 兜底，settings-store.js:20–46）。

## 6. 错误处理约定

- 业务路由普遍用本文件内的 `fail(res, status, code, message)` 小助手直接返回统一信封；该 helper 在每个 routes 文件里各自重复实现（可考虑抽公共模块）；
- 全局错误处理器（app.js:192–201）：
  - 状态码：`err.status` 为 400–599 之间整数则透传，否则 500；
  - code 规则：≥500 → `INTERNAL_ERROR`；JSON 解析失败 → `INVALID_JSON`；其余 4xx → `BAD_REQUEST`；
  - 消息：生产环境 5xx 一律"服务器内部错误"，开发环境带 `err.message`；
  - `res.headersSent` 为真时交给 Express 默认处理（对 SSE 尤其重要）；
  - 仅 ≥500 打印堆栈到日志。
- 统一信封：`{ "error": { "code": "...", "message": "..." } }`，完整错误码表见 [04 API 参考](04-api.md#15-统一错误与错误码)。

## 7. 静态资源与前端约束

- `express.static` 位于 API 之前；目录默认页是 `public/index.html`；
- **HTML 不做服务端鉴权**：未登录也能下载 `/admin/*.html`，权限完全由 API 层的 `requireAdmin` 兜底（页面级只是引导体验）；
- CSP（`middleware/security-headers.js:3-13`）限制前端写法：`script-src 'self'`（**不能写内联 `<script>`**）、`style-src 'self' 'unsafe-inline'`、`img-src 'self' data: http: https:`；
- 无 `compression` 中间件：静态资源与 JSON 均不 gzip，局域网/本机无感，公网部署建议前置反代开启压缩；
- 静态文件走 Express 默认（ETag/Last-Modified）；`/api` 响应统一带 `Cache-Control: no-store`（敏感 JSON 不缓存）。

## 8. 生命周期与退出

| 事件 | 行为 |
|---|---|
| 启动 | `initDatabase()`（建表/播种，失败 exit(1)）→ `app.listen(PORT)` |
| 端口占用 | `EADDRINUSE` → 明确提示"端口已被占用，请先关闭占用进程或修改 PORT" → `closeDb()` → exit(1) |
| SIGINT / SIGTERM | `server.close()` → 等连接自然结束 → `closeDb()` → exit(0)；5 秒后强制 finish（`unref` 定时器） |
| 定时器 | 会话清理（15 分钟，`session-store.js:6,38`）、限流 Map 清理、上游连接超时定时器——都 `unref()`，不阻止进程退出 |
| 未捕获异常 | **没有** `uncaughtException/unhandledRejection` 处理器，进程会按 Node 默认行为退出（生产建议加进程守护） |

## 9. 并发、性能与扩展性

- **better-sqlite3 是同步 API**：单个查询/事务会阻塞事件循环。当前所有查询都有索引或小表，问题不大；但用户/消息量增长后，后台分页的 `COUNT(*)` 与列表查询会变慢；
- **WAL** 提供读写并发，仍是单写者；`busy_timeout=5000` 可容忍短时锁竞争；
- **限流是进程内存态**：多进程/多实例部署时各算各的额度（实际额度被放大）；`/api/csrf-token`、会话存 DB 可跨进程共享；
- **SSE 长连接**：每个聊天连接占用一个 socket 和一条上游连接；上游建连 10 秒超时，但**没有流式 idle 超时**（见 [06](06-chat-flow.md)）；
- 静态资源体量：`public/css` 约 84 KB、`public/js` 约 184 KB（未压缩），无 CDN；
- 无 clustering、无 worker、无 PM2 配置；单进程足够当前规模。

## 10. 关键常量总表

| 常量 | 值 | 位置 | 含义 |
|---|---|---|---|
| `SESSION_MAX_AGE` | 7 天 | app.js:22 | 会话 Cookie 与 DB 过期时间 |
| `RATE_LIMIT_GLOBAL` | 300 / 60s / IP | app.js:26 | 仅 `/api` 写请求 |
| `RATE_LIMIT_LOGIN` | 10 / 5min / IP | app.js:27 | 登录 |
| `RATE_LIMIT_REGISTER` | 5 / 10min / IP | app.js:28 | 注册 |
| `RATE_LIMIT_PASSWORD` | 10 / 60s / 管理员 | app.js:29 | 管理员重置他人密码 |
| `RATE_LIMIT_CHAT` | 20 / 60s / 用户 | app.js:30 | 聊天补全 |
| `REQUEST_TIMEOUT_MS` | 10000 ms | provider-client.js:3 | 上游建连/模型列表超时 |
| `DEFAULT_IDLE_TIMEOUT_MS` | 60000 ms | chat-client.js:12 | 聊天流空闲超时（`CHAT_STREAM_IDLE_TIMEOUT_MS` 可覆盖） |
| `HISTORY_LIMIT` | 20 条 | chat-store.js:4 | 上下文消息数 |
| `MESSAGE_MAX` | 4000 字 | chat-store.js:8 | 单条用户消息上限 |
| `TITLE_MAX` / `AUTO_TITLE_MAX` | 40 / 20 | chat-store.js:6–7 | 会话标题上限 / 自动标题截取 |
| `RAW_KEEP_MAX` | 200 KB | chat-client.js:9 | 为兜底解析保留的上游原文上限 |
| `PAGE_SIZE_DEFAULT/MAX` | 20 / 100 | users.js:14–15、admin.js:14–16 | 分页 |
| `MESSAGE_PAGE_SIZE_DEFAULT` | 50 | admin.js:16 | 消息抽屉分页 |
| `RECENT_LIMIT` | 5 | admin.js:17 | 仪表盘"最近"列表 |
| `BCRYPT_COST` | 10 | auth.js:16、profile.js、users.js | 密码哈希成本 |
| `HSTS` | max-age=15552000 | security-headers.js:14 | 180 天，仅 https 响应 |

## 11. 架构层面的改进建议（详见 09）

1. 抽出共享的 `fail()` / 分页 / LIKE 转义工具，消除 8 个 routes 文件里的重复实现；
2. 引入 `compression` 与静态缓存策略（生产前置反代也可）；
3. 前端静态按页面拆成更小的 CSS/JS（当前每页共享 common.css 36 KB）；
4. 若要多实例部署，限流需换共享存储（Redis/SQLite 表）或粘性会话；
5. 增加进程级异常兜底与优雅退出时限（避免 SSE 连接拖住关闭）。
