> 知识库整理于 2026-11-15，基于代码现状；与 README 冲突时以代码为准。

# 09 现状与差距（README 偏差 · 运行核查 · 阶段完成度 · 风险）

> 本章回答：**根目录 README 现在哪些说法与代码不符？项目在本机真的能跑吗？数据库里现在有什么？阶段 1–7 到底做到哪一步？上线前最该补什么？**
> 证据口径：源码逐文件阅读（路径:行号）+ 真实 SQLite 只读查询 + 临时库/临时端口冒烟测试；未取得证据的内容标注「待核实」。
> 与根 README 的关系：根 README.md 共 216 行，部分结论停留在“阶段 5 完成”。本章逐节核对，**以代码与运行结果为准**。
> **【2026-11-15 第三批更新 · PostgreSQL 迁移】** 本章 §1–§7 是 **SQLite 时代**的第一/第二批快照（保留作历史证据）；本分支（feat/postgres-migration）已把运行时数据库迁移到 **PostgreSQL**，数据层/备份/部署/CI 均已切换。**当前状态以 §8、[03](03-database.md)、[08](08-config-and-ops.md)、[11-changes.md](11-changes.md) §8 为准**；§3 的 WAL/SQLite 文件数据、§7.5 的 dbSize/备份结论不再代表现状。

## 0. 结论速览

| # | 结论 | 关键证据 |
|---|---|---|
| 1 | 根 README 的「阶段 6 未开始 / 限流、CSRF、SSRF 未实现」已过时：三者连同安全响应头全部落地并接入 `app.js` | `server/services/rate-limit.js`、`server/middleware/csrf.js`、`server/middleware/security-headers.js`、`server/services/upstream-guard.js`；接入点 `server/app.js:11-13,115,117,155-176` |
| 2 | 接口层新增了 README 未记录的关键约定：所有非安全方法先过 CSRF；新增 `GET /api/csrf-token`；登录/注册响应额外返回 `csrfToken`；写接口命中限流返回 429 | `server/app.js:158-176`、`server/routes/auth.js:30-40,77-78,104-105` |
| 3 | 项目可运行：临时库 + 3100 端口冒烟通过（健康检查/设置/CSRF/401/403/204/404/安全头均符合代码）；真实库全程未被写入 | 第 2 节、第 6 节原始输出 |
| 4 | 真实库是「刚初始化完的空壳」：仅 1 个 admin、1 条会话、6 条默认设置，0 服务/模型/会话/消息；WAL 230 KB 未 checkpoint，主库 mtime 落后于最新写入 | 第 3 节只读查询 |
| 5 | 阶段 6 属「大部分完成」，仍缺：SSE 流式 idle timeout、跨进程限流、SSRF 的 DNS 重绑定/重定向残余面、改密/重置密码后旧会话不失效 | 第 4、5 节 |
| 6 | 最高优先级风险是**数据与密钥资产**：`data/.dev-secrets.json`（或 `.env` 密钥）丢失=已存 API Key 永久解不开；库无备份机制，且直接复制 `chenlong.db` 会漏 WAL 数据 | `server/services/dev-secrets.js:16-24,99-127`、`server/services/encryption.js:29-36`、第 3 节、第 5 节 P0-1/P0-2 |
| 7 | 工程化短板：无 `.git`、无测试、无 CI、无 lint、无 DB migration，README 与代码已出现明显漂移 | `package.json:7-11`、本机文件统计（第 6.1 节） |

> **【2026-11-15 更新 · 第二批改进】** 在本章第一轮审计之后，项目又完成了一批改动：启动 `ENCRYPTION_KEY` 自检、上游重定向拒绝、SSE 空闲超时、会话失效、`/api` no-store、测试套件（83 用例）、一致性备份脚本、前端一致性与根 README 刷新。**§0 第 5/7 条、§4.2、§5 中部分 P0/P1 已修复**，最新状态以 **§7「第二批改进（2026-11-15）与状态更新」** 为准；根 README 已从 216 行刷新为 259 行。

---

## 1. README 偏差审计

### 1.1 核对方法

- 逐节阅读 `README.md`（1–216 行），对每一条结论到代码里找实现或反证；无法在代码中确认 UI/观感的标注「待核实」。
- 接口清单以路由文件为准：`server/routes/*.js` + `server/app.js` 内 2 个端点 + `/api` 404 兜底，实际 **40 个**端点。
- 版本以 `npm ls --depth=0` 实测（见 6.1），不是只看 `package.json` 声明范围。

### 1.2 过时 / 错误 / 不准确清单（按严重度）

| # | README 位置 | README 的说法 | 代码事实 | 证据 |
|---|---|---|---|---|
| A1 | `README.md:4`、`:215` | 「当前进度：阶段 5 完成」「阶段 6 安全加固：待开始」 | 阶段 6 的核心项（限流/CSRF/安全头/SSRF/TRUST_PROXY）已实现并接入 | `server/app.js:11-13,115,117,155-176`；`server/middleware/csrf.js:29-35`；`server/services/rate-limit.js:15-64`；`server/services/upstream-guard.js:135-171` |
| A2 | `README.md:190` | 「频率限制 / CSRF token / Base URL 的 SSRF 校验尚未实现（阶段 6）。目前会话 Cookie 为 sameSite=lax 已挡住跨站 POST」 | 三项均已实现；防 CSRF 不再依赖 lax。限流 5 类规则、CSRF 用 session 令牌 + `X-CSRF-Token` 头 + `timingSafeEqual`、SSRF 校验内网/保留段并在写库前拦截 | `server/services/rate-limit.js:15-64`、`server/middleware/csrf.js:20-35`、`server/services/upstream-guard.js:7-47,135-171`、`server/routes/providers.js:31-39,136-139,190-197` |
| A3 | `README.md:173-184`（安全约定 1–10） | 只写了 bcrypt/会话/AES/同源/redirect/归属校验/1 MB，未提 CSRF、限流、CSP/HSTS、SSRF、TRUST_PROXY、禁用账号会话失效 | 新增安全面全部未记录 | `server/middleware/security-headers.js:1-24`；`server/middleware/auth.js:20-22`（disabled → destroy session） |
| A4 | `README.md:53-66`（目录结构） | `middleware/` 只列 auth.js、admin.js；`services/` 未列 rate-limit.js、upstream-guard.js | 实际 26 个后端 JS；middleware 有 4 个、services 有 11 个 | glob server/**/*.js = 26；`server/middleware/csrf.js`、`security-headers.js`、`server/services/rate-limit.js`、`upstream-guard.js` |
| A5 | `README.md:110-132`（接口现状） | 未记录 `GET /api/csrf-token`；未说明所有 POST/PATCH/DELETE 需 CSRF；未记录 429/限流头；未记录登录/注册响应里的 `csrfToken` | 均为现行契约 | `server/app.js:158-176`；`server/routes/auth.js:36-37,77-78,104-105`；`server/services/rate-limit.js:48-62` |
| A6 | `README.md:124`（models 接口） | 只写「增删改、启停、设默认」 | 还有一个 README 未列的 `POST /api/models/:id/test`（单模型可用性测试，写 `last_tested_at/status`） | `server/routes/models.js:281-326` |
| A7 | `README.md:145`（SSE 帧） | `done` 帧带「完整 content 与 messageId」 | 实际字段名是 `assistantMessageId`；另有 `start` 帧的 `userMessageId/modelName`、`error` 帧 `{type,code,message}`、结束补 `data: [DONE]` | `server/routes/chat.js:76,79-83,118-120`；前端解析 `public/js/chat.js:141-181` |
| A8 | `README.md:112`（health） | 返回 `{status, db, version}` | 200/503 都还有 `uptime`；503 body 为 `{status:"degraded",uptime,db:"disconnected",version}` | `server/app.js:140-153` |
| A9 | `README.md:34` | 「生产环境缺密钥或 `.dev-secrets.json` 损坏 → 直接退出」 | 生产只检查环境变量，**从不读取** `.dev-secrets.json`；开发环境该文件损坏才拒绝启动 | `server/app.js:71-90`、`server/services/dev-secrets.js:33-61` |
| A10 | `README.md:168` | 「过期会话在读写时清理」 | 除读写时清理外，还有 **每 15 分钟**定时清理 | `server/services/session-store.js:6,32-39,129-131` |
| A11 | `README.md:22-29`（快速开始） | 只写 `npm start`；未提 `npm run dev`、`npm run init-db`；未提 `PORT/NODE_ENV/DB_PATH` 可配 | 三个脚本都在；`.env.example` 含 PORT/NODE_ENV/DB_PATH，但缺 TRUST_PROXY 等开关（见 A12） | `package.json:7-11`；`server/app.js:18-20`；`server/database/db.js:9-13` |
| A12 | `README.md:33` + `.env.example` | 密钥只提 SESSION_SECRET/ENCRYPTION_KEY/ADMIN_PASSWORD | 另有 3 个未文档化开关：`TRUST_PROXY`、`RATE_LIMIT_ENABLED`（开发可关限流）、`ALLOW_PRIVATE_UPSTREAM`（开发放行内网上游） | `server/app.js:32-35,115`；`server/services/rate-limit.js:4-9`；`server/services/upstream-guard.js:42-47`；`.env.example:1-25` 无这三项 |

### 1.3 README 完全遗漏的新能力（建议补写进 README）

| 能力 | 事实 | 证据 |
|---|---|---|
| CSRF 防护 | 除 GET/HEAD/OPTIONS 外全部 `/api` 写请求校验 `X-CSRF-Token`；令牌存在 session、登录/注册重建会话后轮换并由响应体下发 | `server/middleware/csrf.js:3-35`、`server/routes/auth.js:30-40` |
| 限流 | 全局写 300 次/分/IP；登录 10 次/5 分/IP；注册 5 次/10 分/IP；管理员重置密码 10 次/分/操作者；聊天 20 次/分/用户；超限 429 + `Retry-After/X-RateLimit-*` | `server/app.js:26-30,37-61,155,169-176`、`server/services/rate-limit.js:48-62` |
| 安全响应头 | CSP（script-src 'self' 等 10 条）、nosniff、SAMEORIGIN、Referrer-Policy、`X-XSS-Protection: 0`；HTTPS 时加 HSTS `max-age=15552000`（180 天） | `server/middleware/security-headers.js:1-24`；`server/app.js:117` |
| SSRF 上游防护 | 新增/修改 Base URL 前校验：IPv4/IPv6 内网、回环、云元数据、保留、组播段 + 域名 DNS 全部 A/AAAA 记录；开发可 `ALLOW_PRIVATE_UPSTREAM=1` 放行 | `server/services/upstream-guard.js:7-34,135-171`、`server/routes/providers.js:30-39`、`server/services/provider-client.js:86-94`、`server/services/chat-client.js:94-102` |
| 反向代理支持 | `TRUST_PROXY=1/true/yes/on` 时 `app.set('trust proxy', 1)`，使 `req.ip`、`req.secure`（HSTS）、限流 key 正确 | `server/app.js:32-35,115` |
| 禁用账号即时失效 | 每请求 `attachUser` 发现用户不存在或非 active 时销毁会话（不只是登录时拒绝 403） | `server/middleware/auth.js:8-26` |
| 管理员重置密码规则 | 8–32 位且必须同时含字母与数字（与注册的 6–64 位不一致，见 P2-5） | `server/routes/users.js:16-17,206-213` |

### 1.4 经核对仍然准确的部分（避免误改 README）

- 技术栈版本与实际安装一致：express 5.3.0 / better-sqlite3 13.1.1 / bcryptjs 3.0.3 / dotenv 18.0.10 / express-session 1.19.0；Node `>=24`（本机 v24.19.0）。
- 7 张表、6 条默认设置、首次启动幂等建表 + 条件播种管理员：`server/database/init.js:5-131`，真实库行数一致（第 3 节）。
- bcrypt cost=10、AES-256-GCM `v1:iv:tag:cipher`、Key 只回掩码（<12 字符全掩码）、错误信封 `{error:{code,message}}`：`server/services/encryption.js:54-73`、`server/services/key-mask.js:1-7`、`server/app.js:187-201`。
- 49 个 `--cl-*` CSS 变量、后台六页、logo 256×256、页面/守卫清单、SSE 逐字/停止生成/会话管理、最近 20 条上下文、自动标题 20 字、关键词 `%`/`_` 转义、后台数据页只读、管理员不能改自己角色/状态、`LAST_ADMIN` 保护 HTTP 层不可达、dbSize 只算主库、忘记密码无流程等：均在代码中确认（对应 `public/css/common.css`、`server/services/chat-store.js:3-8,77-94,152-172`、`server/routes/users.js:156-187`、`server/routes/admin.js:64-70`）。

> 结论：README 的偏差集中在**阶段 6 与安全/接口约定**；业务功能描述仍大体可信。建议 README 保持“功能说明”定位，安全与接口细节引用本知识库 04/07/08 章。

---

## 2. 可运行性验证（2026-11-15，有限度、可回退、不污染真实数据）

### 2.1 前提：端口审计

- 用 `Get-NetTCPConnection -LocalPort 3000` 检查：**无监听**（当时 3000 空闲，服务未启动），因此按预案走「临时库 + 临时端口 3100」冒烟，不在 3000 上起服务。
- 3100 亦空闲；`node -v` = v24.19.0，`npm -v` = 11.17.0；`.env` 已含 SESSION_SECRET/ENCRYPTION_KEY（长度 64），故不会触发开发密钥生成。
- 覆盖环境变量：`DB_PATH=data/.kb-verify.db`、`PORT=3100`、`NODE_ENV=development`、`TRUST_PROXY=1`；其余配置沿用 `.env`（dotenv 不覆盖已存在的环境变量，`server/app.js:3`）。

### 2.2 冒烟结果

| 检查项 | 实测结果 | 结论 |
|---|---|---|
| 启动 | 日志 `已创建初始管理员 admin…`、`[db] 已写入默认设置 6 条`、`尘龙 ChenLong v0.1.0 已启动：http://127.0.0.1:3100 (development)`；stderr 为空 | ✅ 冷启动可用 |
| `GET /api/health` | 200 `{"status":"ok","uptime":0.99,"db":"connected","version":"0.1.0"}` | ✅ |
| `GET /api/settings` | 200，6 个键均为默认值（allowRegister/allowChat=true） | ✅ |
| 安全头（所有响应） | CSP 10 条、`x-content-type-options: nosniff`、`x-frame-options: SAMEORIGIN`、`referrer-policy: strict-origin-when-cross-origin`、`x-xss-protection: 0` | ✅ 静态页与 API 一致 |
| HSTS | 不带 `X-Forwarded-Proto` 时**无** HSTS；带 `X-Forwarded-Proto: https`（TRUST_PROXY=1）出现 `strict-transport-security: max-age=15552000` | ✅ 印证 `security-headers.js:22` + TRUST_PROXY 分支 |
| `GET /api/csrf-token` | 200，token 长度 64（hex），Set-Cookie `chenlong.sid=<hidden>; Path=/; Expires=+7d; HttpOnly; SameSite=Lax`（开发环境无 Secure） | ✅ 与 `app.js:129-134` 一致 |
| 未登录 `GET /api/auth/me` | 401 `{"error":{"code":"UNAUTHORIZED","message":"请先登录"}}` | ✅ |
| 未登录 `GET /api/chat/models` | 401 同信封（`router.use(requireAuth)`） | ✅ |
| 无 CSRF `POST /api/auth/logout` | 403 `{"error":{"code":"CSRF_INVALID","message":"页面已过期，请刷新后重试"}}`；带 `X-RateLimit-Limit: 300 / Remaining: 299` | ✅ 写请求先过全局限流、再过 CSRF |
| 无 CSRF `POST /api/auth/login`、`POST /api/auth/register` | 均 403 `CSRF_INVALID`（请求未进入业务路由） | ✅ 登录/注册同样受 CSRF 保护 |
| 携带有效 CSRF `POST /api/auth/logout` | 204，并下发过期 Cookie；该请求 `X-RateLimit-Remaining: 297` | ✅ CSRF 校验通过后业务可达 |
| `GET /`（静态首页） | 200 text/html，带完整 CSP 等安全头 | ✅ 静态资源也覆盖 |
| `GET /api/no-such-endpoint` | 404 `{"error":{"code":"NOT_FOUND","message":"接口不存在：GET /api/no-such-endpoint"}}` | ✅ 兜底信封 |
| 清理 | 真实库 mtime 前后一致；`data/.kb-verify*` 残留 0；端口 3100 监听 0；无新增 node 进程（仅环境自带 1 个与本项目无关进程） | ✅ 无污染、无残留 |

### 2.3 未验证项（及原因）

| 项 | 原因 |
|---|---|
| 登录/注册/聊天/SSE 全链路 | 任务约束不写入真实业务数据；临时库验证会引入真实账号与上游 Key，超出“有限度”范围 |
| 429 限流实测 | 需连续 11 次登录尝试或 301 次写请求；本轮只做代码核对 + 限流头观测（`X-RateLimit-*` 正常） |
| `/api/health` 503 分支 | 需制造 DB 故障；代码路径已读（`server/app.js:140-153`） |
| 生产 `secure` Cookie / 真实 TLS HSTS | 需 HTTPS 部署；本轮以 `X-Forwarded-Proto` 验证分支 |
| 上游不可达/超时/SSE 中断 | 需外部网络与可配置上游；错误映射已逐行核对（`provider-client.js:30-36,48-79`、`chat-client.js:11-17,128-147`） |
| 仪表盘/后台页面视觉与交互 | 属联调/视觉范畴，未在本轮范围 |

---

## 3. 数据库真实状态（只读，`readonly:true` 打开 `data/chenlong.db`）

### 3.1 文件与 WAL

| 文件 | 大小 | mtime（本机 +08） | 备注 |
|---|---|---|---|
| `data/chenlong.db` | 86,016 B | 2026-11-15 12:19:47 | 主库 |
| `data/chenlong.db-wal` | 230,752 B | 2026-11-15 14:06:55 | 未 checkpoint |
| `data/chenlong.db-shm` | 32,768 B | 2026-11-15 15:54:15 | WAL 索引 |
| 合计实际占用 | **349,536 B** | — | 主库仅占 ~24.6%；仪表盘 `dbSizeBytes` 只报 86,016（见 P2-3） |

- SQLite 3.54.1，page_size=4096，`PRAGMA quick_check` = **ok**。
- 关键佐证：`users` 最新行的 `created_at=2026-11-15T04:33:49.019Z`（12:33:49）晚于主库 mtime（12:19:47）→ **最新数据在 WAL 里**，直接复制 `chenlong.db` 会丢数据（见 P0-2）。

### 3.2 表、行数、索引

| 表 | 行数 | 说明 |
|---|---|---|
| `users` | 1 | 1 个 admin / active |
| `api_providers` | 0 | 未配置任何上游 |
| `models` | 0 | 无模型 |
| `conversations` | 0 | 无会话 |
| `messages` | 0 | 无消息 |
| `settings` | 6 | 全部默认值 |
| `sessions` | 1 | 1 条未过期会话（expire=2026-11-22T05:12:10.058Z） |

- 索引 5 个：`idx_api_providers_enabled`、`idx_conversations_user_id`、`idx_messages_conversation_id`、`idx_models_provider_id`、`idx_sessions_expire`（`server/database/init.js:72-76`）。

### 3.3 settings / users / 时间

| setting_key | setting_value | updated_at(UTC) |
|---|---|---|
| site_name | 尘龙 ChenLong | 2026-11-12T12:46:22.113Z |
| site_subtitle | Your Little AI Companion | 2026-11-12T12:46:22.113Z |
| allow_register | 1 | 2026-11-12T12:46:22.113Z |
| allow_chat | 1 | 2026-11-12T12:46:22.113Z |
| announcement | （空） | 2026-11-12T12:46:22.113Z |
| logo | /assets/mascot/logo.png | 2026-11-12T12:46:22.113Z |

- 用户分布：`admin/active` = 1，`user` = 0，disabled = 0；唯一用户创建于 2026-11-15T04:33:49.019Z。
- 会话：1 条、无过期；`conversations`/`messages` 无任何数据（最近会话/消息时间不存在）。

### 3.4 含义

1. 本机是**未配置上游的空壳**：登录后台之外无业务可验证，聊天必须先按 01-overview 7.3 配置 API 服务并启用模型。
2. 数据库健康（quick_check ok、WAL 正常），但 **WAL 未 checkpoint**，对备份/迁移是真实风险而非理论问题。
3. `dbSizeBytes`/README 的“库大小”若只看主库会显著低估（约 1/4），运维监控需按三件套合计或 `PRAGMA page_count*page_size` + WAL 大小。

---

## 4. 阶段完成度评估（1–7）

| 阶段 | README 标注（`README.md:208-216`） | 核查结论 | 证据 | 差距/备注 |
|---|---|---|---|---|
| 1 目录+DB+骨架+前端壳 | ✅ 完成 | ✅ 完成 | `server/app.js:111-138`、`server/database/init.js:5-131`、`public/*.html` | 无 |
| 2 用户系统+后台鉴权 | ✅ 完成 | ✅ 完成 | `server/routes/auth.js`、`profile.js`、`users.js`、`middleware/auth.js`、`admin.js`、`public/js/guard.js` | 无 |
| 3 API 管理+Key 加密+模型发现 | ✅ 完成 | ✅ 完成 | `server/routes/providers.js`、`models.js`、`services/encryption.js`、`provider-client.js`、`key-mask.js` | 无 |
| 4 聊天+SSE+持久化 | ✅ 完成 | ✅ 完成（功能面） | `server/routes/chat.js`、`services/chat-client.js`、`chat-store.js`、`public/js/chat.js` | 流式 idle timeout 缺失（P1-1） |
| 5 后台接真实数据+系统设置 | ✅ 完成 | ✅ 完成 | `server/routes/admin.js`、`settings.js`、`services/settings-store.js`、后台六页脚本 | 无 |
| 6 安全加固（限流/CSRF/SSRF） | ❌ 待开始 | 🟡 **大部分完成** | 见下表 4.1 | 见 4.2 缺口 |
| 7 联调/视觉/文档收尾 | ❌ 待开始 | 🟡 部分进行 | 本知识库 10 篇文档在写；运行冒烟已做 | 无测试/CI/lint、README 未刷新、无 `.git` |

### 4.1 阶段 6 已实现明细

| 能力 | 实现位置 | 行为要点 |
|---|---|---|
| 内存滑动窗口限流 | `server/services/rate-limit.js:15-64`；装配 `server/app.js:26-30,37-61,155,169-176` | 5 类规则；429 + `Retry-After` + `X-RateLimit-*`；生产强制开启，开发可用 `RATE_LIMIT_ENABLED=0/false` 关闭；GET/HEAD/OPTIONS 不计全局限流 |
| CSRF | `server/middleware/csrf.js:3-35`；装配 `server/app.js:158-167` | session 绑定令牌、`X-CSRF-Token` 头、`timingSafeEqual`；GET 令牌端点豁免；登录/注册 regenerate 会话并回传新 token |
| 安全响应头 | `server/middleware/security-headers.js:1-24`；装配 `server/app.js:117` | CSP 10 条 + nosniff + SAMEORIGIN + Referrer-Policy + X-XSS-Protection:0；`req.secure` 时 HSTS 180 天 |
| SSRF 上游防护 | `server/services/upstream-guard.js:135-171`；接入 `providers.js:30-39,190-197`、`provider-client.js:86-94`、`chat-client.js:94-102` | 内网/回环/元数据/保留/组播网段 + 域名全解析记录；localhost/数字/十六进制主机名拦截；开发 `ALLOW_PRIVATE_UPSTREAM` 放行 |
| TRUST_PROXY | `server/app.js:32-35,115` | 让反代后的 `req.ip/req.secure` 正确（限流与 HSTS 依赖） |

### 4.2 阶段 6 仍缺 / 建议收尾项

> **更新（2026-11-15）**：本节的 1（SSE 空闲超时）、3 的重定向部分、4（会话失效）已在第二批修复；2（跨进程限流）与 3 的 DNS 重绑定残余仍在。详见 §7。

1. **SSE 流式 idle timeout**：仅有 10 秒建连超时（`chat-client.js:112-136` 建连后即 `clearTimeout`），流已建立但上游不吐字会无限等待（用户只能手动停止）。
2. **限流是单进程内存实现**：多实例/Cluster 下每个进程独立计数，实际额度 ×N；重启归零（`rate-limit.js:21-30`）。
3. **SSRF 残余面**：校验函数已落地（`upstream-guard.js:135-171`），但校验与真实请求之间存在 DNS 重绑定窗口；Node `fetch` 默认跟随重定向，公开 Base URL 可 302 到内网（`provider-client.js:52-56`、`chat-client.js:122-127` 未设 `redirect:'error'`）。
4. **会话失效策略**：管理员重置密码/用户改密后，目标用户其它已登录会话仍有效（`users.js:215-217`、`profile.js:52-53` 只改 hash）。
5. **反向代理/HSTS 文档缺失**：安全头支持 TRUST_PROXY，但 README 与 `.env.example` 均未说明；不配 TRUST_PROXY 时反代后 HSTS 不会下发、限流按代理 IP 计数。
6. **可观测性**：登录失败、限流命中、SSRF 拦截等只有 console 日志，无审计/指标。

---

## 5. 风险与下一步建议（P0 / P1 / P2）

> **更新（2026-11-15）**：以下 P0/P1/P2 为**第一轮快照**。第二批已关闭/缓解 P0-2、P1-1、P1-2（重定向部分）、P1-4、P1-5、P1-6（测试部分）、P2-9；仍未闭合项及其映射见 §7.4/§7.5。

> 说明：本机的现状是“可运行的空壳”，所以风险按**上线/长期运行**视角排序。每条给“理由 → 落点文件 → 验收标准”。

### 5.1 P0（上线前必须处理，否则可能造成不可恢复损失或直接不可用）

| # | 风险 | 理由与证据 | 落点文件 | 验收标准 |
|---|---|---|---|---|
| P0-1 | **密钥丢失=所有 API Key 永久无法解密** | `.dev-secrets.json`（或 `.env` 里的 ENCRYPTION_KEY）是唯一密钥；丢失/损坏/误删都会让库中 `api_key_encrypted` 永远解不开；当前无轮换/重加密工具，且密钥为明文文件。`dev-secrets.js:16-24,65-97,99-127`、`encryption.js:29-36`、`.gitignore:6` | `server/services/dev-secrets.js`、`server/services/encryption.js`、新建运维脚本/08 文档 | ① 08 文档给出“密钥备份清单+恢复演练步骤”；② 启动时用哨兵值试解密（见 P1-5）并打印密钥来源；③ 备份 `.env` + `data/.dev-secrets.json`（离线）并演练一次恢复 |
| P0-2 | **数据库无备份机制，直接复制主库会漏 WAL** | 无备份任务/保留策略；主库 mtime 落后于最新写入（真实数据在 230 KB WAL 中）；仪表盘只统计主库（`admin.js:64-70`）。停服直接 copy `chenlong.db` 会丢失未 checkpoint 事务 | 新建运维脚本（`.backup` / `VACUUM INTO`）、`server/routes/admin.js:64-70`、08 文档 | ① 提供“停服拍三件套”或 `sqlite3 .backup`/`VACUUM INTO` 脚本并在临时目录演练成功；② 备份含 `-wal/-shm` 或先 checkpoint；③ 仪表盘库大小口径修正（P2-3） |

### 5.2 P1（影响安全/稳定性/可运维性，尽快排期）

| # | 风险 | 理由与证据 | 落点文件 | 验收标准 |
|---|---|---|---|---|
| P1-1 | **SSE 无 idle timeout** | 建连超时 10 s 后计时器即清除；响应体读取循环无“两帧最大间隔”保护，上游挂起→连接与浏览器一起干等（`chat-client.js:112-136,172-189`） | `server/services/chat-client.js` | 连续 N 秒（建议 60 s）无数据则 abort，回 `{type:"error",code:"STREAM_IDLE_TIMEOUT"}`；已收到内容照旧落库；加可控常量与单测 |
| P1-2 | **SSRF 残余（校验已实现，仍有绕过面）：重定向与 DNS 重绑定** | 只校验解析结果，不约束后续 fetch 的连接地址；fetch 默认 follow redirect；DNS 校验与真实连接之间可被重绑定。`upstream-guard.js:135-171`、`provider-client.js:52-56`、`chat-client.js:122-127` | `server/services/upstream-guard.js`、`provider-client.js`、`chat-client.js` | ① `redirect:'error'`（或手动逐跳校验）；② 连接目标二次校验/固定 IP（undici dispatcher）；③ 用“302→127.0.0.1”的本地测试上游验证被拒 |
| P1-3 | **多进程/多实例部署限制未声明** | 限流 Map 在进程内；dev-secrets 原子创建只解决同机并发；SQLite 单写者。生产若 PM2 cluster/多容器，限流形同虚设、写并发受限 | `server/services/rate-limit.js:21-30`、08 配置与运维文档、部署脚本 | ① 文档明确“当前仅支持单进程部署”；② 或把限流落 SQLite/Redis 并验证跨进程；③ 给出反代+XFF 的 `TRUST_PROXY` 配置矩阵 |
| P1-4 | **重置/修改密码不踢旧会话** | 只更新 `password_hash`；`sessions.sess` 里仍有该 userId，旧 Cookie 继续可用（`users.js:196-221`、`profile.js:36-58`） | `server/routes/users.js`、`profile.js`、`server/services/session-store.js`（新增 `destroyByUserId`） | 管理员重置密码后该用户其它会话下一次请求 401；本人改密可保留当前会话（或明确踢出策略）并在 07 文档写明 |
| P1-5 | **ENCRYPTION_KEY 启动不校验** | `ensureSecrets` 只查环境变量是否存在；`encryption.getKey()` 惰性解析。密钥格式错误时服务能正常启动，首次保存/使用 Key 才 500（`app.js:71-107`、`encryption.js:29-36`） | `server/app.js`（启动自检）、`encryption.js`（导出 `isConfigured`/probe） | 启动时 encrypt→decrypt 哨兵值，失败即 FATAL 退出并给出“ENCRYPTION_KEY 无效”提示 |
| P1-6 | **无版本控制/测试/CI** | 无 `.git`；`package.json:7-11` 无 test/lint 脚本；无测试文件。重构/安全修复无法回归 | 项目根、新建 `test/` | ① `git init` 并提交基线；② 用 `node:test` 覆盖 CSRF/限流/加密/模型解析/权限；③ 至少本地 `npm test` 可跑通 |
| P1-7 | **TRUST_PROXY/XFF 配置错误会削弱限流** | `trust proxy=1` 后若服务仍可被直连，攻击者可伪造 `X-Forwarded-For` 轮换限流 key；不配置则反代后所有用户共享代理 IP，登录 10 次/5 分可能误伤全站 | `server/app.js:115`、`.env.example`、08 文档 | 部署文档明确“只有可信反代才能开 TRUST_PROXY”；或校验代理来源并给出安全默认 |

### 5.3 P2（体验/质量/观测，排期可后置）

| # | 风险/差距 | 理由与证据 | 落点文件 | 验收标准 |
|---|---|---|---|---|
| P2-1 | **会话模型不沿用** | 请求未传 `modelId` 时只按“默认模型”解析，不读该会话上次模型；且每轮 `touchConversation` 会把 `conversations.model_id` 覆盖成“本次解析结果”。前端切换会话时也不回填下拉框。`chat-store.js:77-94,160-164`、`public/js/chat.js:621-650,756-800` | `server/services/chat-store.js`、`routes/chat.js`、`public/js/chat.js` | 未传 `modelId` 时优先会话最近模型（仍启用），否则回落默认；打开会话时下拉同步；构造两个会话用不同模型验证互不串 |
| P2-2 | **忘记密码/邮件缺失** | 无找回密码接口/邮件设施；登录页“忘记密码？”只是 `data-pending` 占位（`public/login.html:42`、`public/js/app.js:657-667`） | 新建 auth reset 流程 + 邮件/管理员重置说明；07/README | 登录页给出明确说明或实现“管理员重置”引导；若做自助找回，需一次性 token 表 + 有效期 + 限流 |
| P2-3 | **dbSize 统计不含 WAL/SHM** | 实测主库 86,016 B，实际三件套 349,536 B（约 4 倍）；主库只占 ~24.6%。`admin.js:64-70` | `server/routes/admin.js` | 口径改为 `db+wal+shm` 合计，或 `PRAGMA page_count*page_size` + WAL 大小；前端文案注明 |
| P2-4 | **无 DB migration 框架** | `init.js` 只有 `CREATE TABLE IF NOT EXISTS`，无 `PRAGMA user_version`/ALTER；未来加字段不会应用到已有库（`init.js:5-77`） | `server/database/init.js`、新建 migrations | 引入版本号+迁移脚本；空库与旧库都能升级到同版本 |
| P2-5 | **密码策略不一致** | 注册/改密 6–64 位无复杂度（`validation.js:2-5,20-27`）；管理员重置 8–32 位且必须含字母+数字（`users.js:16-17,206-213`） | `server/services/validation.js`、`routes/users.js` | 统一为一套策略并写入 07/04；前端提示同步 |
| P2-6 | **dev-secrets 混合 env 场景隐患** | 若只缺一个密钥，生成的 `.dev-secrets.json` 会包含一把**当前未使用**的随机 ENCRYPTION_KEY；日后移除环境变量改用该文件，已加密 Key 解不开 | `server/services/dev-secrets.js:99-127`、`app.js:92-107` | 启动日志明确每个密钥来源；混合场景给出 WARN 或拒绝；08 文档写明“二选一，不要混用” |
| P2-7 | **settings-store 默认值靠未导出的常量兜底** | `settings-store.js:2` 引入 `SETTINGS_DEFAULTS`，但 `init.js:133` 未导出 → 永远走 `FALLBACK_DEFAULTS`（值目前相同）。改 init 默认值不会自动同步 | `server/database/init.js`、`services/settings-store.js` | init 导出 SETTINGS_DEFAULTS 并让 store 直接使用；或删除重复兜底 |
| P2-8 | **CSP 仍较宽 / 无报告** | `img-src 'self' data: http: https:` 允许任意远端图片；`style-src` 含 `'unsafe-inline'`；无 report-to/report-uri（`security-headers.js:1-12`） | `server/middleware/security-headers.js` | 收紧 img-src（logo 外链改为白名单/代理）；可选加 CSP 报告端点 |
| P2-9 | **API 响应无缓存控制** | `/api` 下敏感 JSON（用户、设置、会话）无 `Cache-Control: no-store` / `Vary`；部分浏览器/代理可能缓存 | `server/app.js:155-191` | 对 `/api` 统一加 `Cache-Control: no-store`（静态资源另行配置） |
| P2-10 | **管理页 HTML 静态可访问** | `express.static` 先于鉴权（`app.js:138`），`/admin/*.html` 可被匿名读取（数据 API 仍受 requireAdmin 保护）；仅靠前端 guard 跳转 | `server/app.js`、可选新建 middleware | 明确接受（文档化）或对 `/admin/` 加服务端守卫（不破坏静态资源加载） |
| P2-11 | **无审计日志/指标** | 登录失败、限流命中、SSRF 拦截、管理员改动仅 console；出问题无法追溯 | `server/app.js`、`rate-limit.js`、`providers.js` | 至少结构化安全日志（时间/来源/IP/事件/结果），可选接入日志文件 |
| P2-12 | **数据只增不减** | 会话/消息/会话表无保留或归档策略；后台只读不可删，磁盘会持续增长 | 新建清理脚本或管理接口、03/08 文档 | 给出保留策略（如 N 天/按用户）与手动清理命令；执行前有备份 |

### 5.4 建议实施顺序（两周视角）

1. **第 1 周**：P0-1/P0-2（密钥备份演练 + 数据库备份脚本/文档）→ P1-5（启动校验）→ P1-1（idle timeout）→ P1-6（git init + 最小测试）。
2. **第 2 周**：P1-2（SSRF 重定向/二次校验）→ P1-4（会话失效）→ P1-7/P1-3（部署约束文档）→ P2-3/P2-4（统计口径 + migration）→ 刷新根 README 与 08 文档。

---

## 6. 附录：核对命令与原始输出摘录

### 6.1 环境与代码规模实测

```text
node -v                                  → v24.19.0
npm -v                                   → 11.17.0
npm ls --depth=0                         → express@5.3.0 better-sqlite3@13.1.1 bcryptjs@3.0.3
                                           dotenv@18.0.10 express-session@1.19.0
server/**/*.js                           → 26 个
public/js/**/*.js                        → 11 个
public/css/**/*.css                      → 4 个
public/**/*.html                         → 11 个
源码合计                                 → 52 个文件 / 490,691 B（约 479 KB）
git 仓库                                 → 不存在（只有 .gitignore）
logo.png                                 → PNG 256×256 / 12,091 B
--cl-* 变量（common.css）                 → 49 个
```

> 整合记录：知识库索引 `docs/knowledge-base/README.md` 的代码规模统计已按本节实测口径修正为「server 26 JS + public 11 HTML / 11 JS / 4 CSS = 52 文件 / 490,691 B」；数据库行数与本节一致。

### 6.2 端口审计

```powershell
Get-NetTCPConnection -LocalPort 3000   # 无对象 → 3000 空闲
Get-NetTCPConnection -LocalPort 3100   # 无对象 → 3100 空闲
```

### 6.3 冒烟启动命令（临时库/临时端口，已清理）

```powershell
$env:DB_PATH="data/.kb-verify.db"; $env:PORT="3100"; $env:NODE_ENV="development"; $env:TRUST_PROXY="1"
node server/app.js
# 清理：Stop-Process -Id <pid> -Force；删除 data/.kb-verify.db*；确认 3100 无监听
```

### 6.4 /api/health 与安全头摘录

```http
HTTP/1.1 200 OK
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: http: https:; font-src 'self' data:; connect-src 'self';
  frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'
x-content-type-options: nosniff
x-frame-options: SAMEORIGIN
referrer-policy: strict-origin-when-cross-origin
x-xss-protection: 0

{"status":"ok","uptime":0.9873901,"db":"connected","version":"0.1.0"}

# 仅当 X-Forwarded-Proto: https（TRUST_PROXY=1）时追加：
strict-transport-security: max-age=15552000
```

### 6.5 CSRF / 未登录信封摘录

```http
GET /api/auth/me                            → 401 {"error":{"code":"UNAUTHORIZED","message":"请先登录"}}
POST /api/auth/logout（无 token）            → 403 {"error":{"code":"CSRF_INVALID","message":"页面已过期，请刷新后重试"}}
                                             响应头：X-RateLimit-Limit: 300 / X-RateLimit-Remaining: 299
POST /api/auth/login（无 token）             → 403 CSRF_INVALID（未进入业务路由）
POST /api/auth/logout（有效 token + Cookie）  → 204，Set-Cookie 过期
GET /api/no-such-endpoint                    → 404 {"error":{"code":"NOT_FOUND","message":"接口不存在：GET /api/no-such-endpoint"}}
GET /api/csrf-token                          → 200 {"token":"<64 位 hex>"}；Set-Cookie: chenlong.sid=…
                                                 Path=/; Expires=+7d; HttpOnly; SameSite=Lax（开发无 Secure）
```

### 6.6 数据库只读查询脚本（Node + better-sqlite3）

```js
const db = require('better-sqlite3')('data/chenlong.db', { readonly: true, fileMustExist: true });
// 表清单 / 每表 COUNT(*) / settings / users 角色分布 / sessions expire / recent 时间 / quick_check
```

关键输出（2026-11-15）：

```text
sqlite 3.54.1, page_size=4096, quick_check=ok
tables: users(1), api_providers(0), models(0), conversations(0), messages(0), settings(6), sessions(1)
users: admin/active=1；created_at=2026-11-15T04:33:49.019Z
sessions: 1 条未过期；expire=2026-11-22T05:12:10.058Z
files: chenlong.db=86016B, -wal=230752B, -shm=32768B
```

### 6.7 清理与无污染确认

```text
real-db-mtime-before = 2026-11-15T12:19:47.8019174+08:00
real-db-mtime-after  = 2026-11-15T12:19:47.8019174+08:00   → 未改动
temp-db-left = 0
port3100-listeners = 0
node-processes = 1（环境自带、与本项目无关的 node，命令行 dist/index.mjs）
temp-dir-exists = False
```

### 6.8 待核实 / 不在本轮范围

- 生产 HTTPS 下 Cookie `Secure` 与真实 HSTS 行为（需 TLS 部署环境）。
- 上游厂商实际响应差异、429 行为、SSE 中断后的上游侧计费/断连语义。
- 后台页面视觉、窄屏表格、吉祥物立绘等 UI 观感（属联调/视觉范围）。
- `docs/knowledge-base/README.md:66` 的代码规模统计口径（待其作者按 6.1 修订）。

## 7. 第二批改进（2026-11-15）与状态更新

> 本节覆盖 §1–§6 第一轮审计之后落地的第二批改动（后端安全补全 + 前端一致性 + 工程化）。**与前面章节冲突时以本节为准**；第一轮内容保留作历史快照。
> 本批改动明细、完整验证命令与复核步骤另见 [11-changes.md](11-changes.md)。

### 7.1 一句话结论

- **阶段 6 从「大部分完成」推进到「基本完成」**：启动密钥自检、上游重定向拒绝、SSE 空闲超时、会话失效、`/api` no-store 全部落地；残余只有 DNS 重绑定窗口与跨进程限流。
- **工程化首次具备回归能力**：`test/` 15 个文件、83 个用例全绿（本机实测 5.49 s）；`npm run backup` 提供 WAL 安全的一致性备份。
- **前端一致性与过时文案清理完成**：后台 6 页退出按钮、公告条 hoist、logo 外链修复、能力卡/页脚/© 年份更新。
- **根 README 已刷新**（216 → 259 行）：阶段 6 基本完成、API/安全/测试/备份章节补齐，§1.2 的偏差大部分关闭。

> **补充（2026-11-15 晚）**：仓库已完成 `git init` + 基线提交并推送到公开仓库 `TSS-Small-sunshine/ChenLong`（main）；随后接入 GitHub Actions CI（`.github/workflows/ci.yml`，Node 24 跑 `npm test`）。因此本节及 §4.2/§5 中「无 `.git`」「无 CI」相关表述已过时——git 与 CI 部分关闭，其余（migration 等）保持不变。

### 7.2 已修复项（落点文件 + 行为 + 验证）

| # | 事项（对应第一轮） | 落点与实现 | 行为 / 验证 |
|---|---|---|---|
| 1 | 启动密钥自检（P1-5） | `server/services/encryption.js:75-89`（`verifyKey()` 对哨兵串 encrypt→decrypt）；`server/app.js:16,112-124`（`assertEncryptionKey()`，成功打印 `[key] ENCRYPTION_KEY 自检通过`，失败 `[FATAL]` + `process.exit(1)`） | 实测无效 `ENCRYPTION_KEY` 启动：输出两行 FATAL、退出码 **1**、未创建数据库；正常启动日志含 `[key] 自检通过` |
| 2 | 数据库一致性备份（P0-2） | `scripts/backup-db.js:120-207`（better-sqlite3 `db.backup()` 只读打开源库，自动包含 WAL；备份后 `journal_mode=DELETE` + 两次 `quick_check`）；`package.json:13`（`npm run backup`）；`.gitignore:7`（忽略 `data/backups/`） | 实测备份到临时目录：源 84.0 KB → 备份 86,016 B，`quick_check=ok`，exit 0；真实库 mtime 前后一致 |
| 3 | SSE 空闲超时（P1-1） | `server/services/chat-client.js:11-18`（`DEFAULT_IDLE_TIMEOUT_MS=60000`，可用 `CHAT_STREAM_IDLE_TIMEOUT_MS` 覆盖）、`:173-189`（收到数据即重置计时）、`:210-251`（超时 abort → `UPSTREAM_ERROR`，文案「上游长时间没有返回数据，已中断（N 秒无数据）」，已收内容保留） | 单测 `test/features/chat-stream.test.js:80`；本轮冒烟正常流未受影响 |
| 4 | 上游重定向拒绝（P1-2 重定向部分） | `server/services/provider-client.js:6,9-14,61-75`、`server/services/chat-client.js:9,20-25,138-155`：两处 `fetch` 统一 `redirect:'error'`，3xx 不再跟随，错误文案「上游地址发生了重定向，出于安全考虑已拒绝，请直接填写最终地址」 | 单测 `test/features/provider-redirect.test.js:47`、`chat-stream.test.js:62`；**DNS 重绑定窗口仍存在**（见 7.5） |
| 5 | 会话失效（P1-4） | `server/services/session-store.js:100-129`（`_destroyMatching` / `destroyByUserId` / `destroyOthersByUserId`）；`server/routes/users.js:218-228`（管理员重置 → 目标用户全部会话失效；重置自己保留当前会话）；`server/routes/profile.js:55-68`（本人改密 → 踢其它设备、保留当前，响应 `{ok:true, revokedSessions:N}`） | 单测 `test/features/session-revoke.test.js`、`test/features/app-http.test.js:203,253`；lead 端到端验证：旧会话 401、新密码可登录 |
| 6 | `/api` 缓存控制（P2-9） | `server/app.js:155-159`：`express.static` 之后对 `/api` 统一 `Cache-Control: no-store`（静态资源不受影响） | 实测 `/api/health`、`/api/settings`、`/api/csrf-token` 均 `no-store`；`/` 为 `public, max-age=0` |
| 7 | 测试体系（P1-6 测试部分） | `test/` 15 文件（`helpers/temp-db.js` + `core/` 9 + `features/` 5）；`package.json:11-12`（`test` / `test:core`）；测试用 `os.tmpdir()` 临时库 + 随机端口，不碰真实库 | 本机实测 `npm test`：`tests 83 / pass 83 / fail 0 / duration 5491.8ms`，exit 0 |
| 8 | 环境变量文档（A12） | `.env.example:27-39` 以注释形式补齐 `TRUST_PROXY`、`RATE_LIMIT_ENABLED`、`ALLOW_PRIVATE_UPSTREAM`、`CHAT_STREAM_IDLE_TIMEOUT_MS` | 与代码读取点一致：`app.js:130`、`rate-limit.js:4-9`、`upstream-guard.js:42-47`、`chat-client.js:15-18` |
| 9 | 前端 logo 外链修复 | `public/js/app.js:437-446`（`settingLogo`：只放行站内 `/`（非 `//`）与 `http(s)` 绝对地址，拒绝其它 scheme）、`:478-482`（`logoSrc()` 避免外链被 `CL.url` 二次拼接）、`:485-498`（加载成功才显示） | `public/user.html:21,197` 补 `<img data-site-logo>`；后台保存校验（`admin-settings.js`）本就放行 http(s) |
| 10 | 前端一致性/文案 | `public/js/chat.js:663` 重命名 `maxlength 60→40`（对齐后端 `TITLE_MAX`）；6 个后台页 `public/admin/*.html:39` 增加 `data-logout`（`auth.js` 自动绑定）；`public/css/admin.css:47-48`；`public/js/api.js:90-111`、`models.js:89-110` 补 `hoistAnnouncement/watchAnnouncement`；`public/index.html:113-131,240,268-269` 能力卡「已接入（01–03）/暂未支持（04）」+ 页脚 + ©2026；`public/user.html:222-223` 文案与 ©2026 | UI/文案类，无自动化覆盖，建议浏览器抽查 |
| 11 | 根 README 刷新 | `README.md:1-259`：阶段 6 基本完成（:4）、快速开始 5 条命令（:30-33）、启动自检/会话失效说明（:40-41）、目录补 `test/`/`scripts/`（:88-90）、API 表补 csrf/会话失效/空闲超时/no-store（:127-148,156-158）、安全约定 11–16（:205-210）、测试与备份章节（:214-225）、已知限制重写（:229-245）、路线图（:249-259）、知识库链接（:5） | 见 7.3 的 A1–A12 关闭情况 |

### 7.3 第一轮 README 偏差审计（§1.2）关闭情况

| 编号 | 第一轮问题 | 第二批后状态 |
|---|---|---|
| A1 | 进度/阶段 6 标注过时 | 🟢 已关闭：`README.md:4,258` 改为「阶段 6 基本完成」并列出残余 |
| A2 | 「已知限制」称限流/CSRF/SSRF 未实现 | 🟢 已关闭：`README.md:231-245` 重写，改为真实残余（DNS 重绑定、跨进程限流等） |
| A3 | 安全约定缺 CSRF/限流/安全头/SSRF 等 | 🟢 已关闭：`README.md:205-210` 新增安全约定 11–16 |
| A4 | 目录结构缺新文件 | 🟢 已关闭：`README.md:56-97` 补 csrf/security-headers/rate-limit/upstream-guard/test/scripts |
| A5 | 接口表缺 csrf-token/CSRF 要求/429/csrfToken/会话失效 | 🟢 已关闭：`README.md:127-128,134,138,148,156` |
| A6 | 未记录 `POST /api/models/:id/test` | 🔴 未关闭：`README.md:140` 仍未列该端点（低优先） |
| A7 | SSE done 帧字段名写错 | 🟢 已关闭：`README.md:163` 改为 `assistantMessageId`，并补 error 帧/空闲超时（:164） |
| A8 | health 返回字段不完整 | 🟢 已关闭：`README.md:127` 补 `uptime` |
| A9 | 生产环境 `.dev-secrets.json` 措辞不准确 | 🔴 未关闭：`README.md:39` 仍写「生产环境缺密钥或 .dev-secrets.json 损坏 → 退出」（生产其实不读该文件；属措辞问题） |
| A10 | 过期会话清理描述不全 | 🟢 已关闭：`README.md:187` 补每 15 分钟定时清理与按用户失效 |
| A11 | 快速开始缺 dev/init-db/test/backup | 🟢 已关闭：`README.md:30-33` |
| A12 | 环境变量开关未文档化 | 🟢 已关闭：`.env.example:27-39`（README 未直接列，但引用了样例文件） |

### 7.4 第一轮 §5 风险清单关闭映射

| 第一轮编号 | 风险 | 第二批后状态 | 说明 |
|---|---|---|---|
| P0-1 | 密钥丢失导致 API Key 永久不可解密 | 🟡 部分缓解 | 新增启动自检 + `README.md:225` 要求「ENCRYPTION_KEY 与备份分开离线保管」；仍无密钥轮换工具/恢复演练脚本 |
| P0-2 | 无备份、直接复制漏 WAL | 🟢 基本关闭 | `npm run backup` 一致性备份（WAL 安全 + quick_check）；仍无定时任务/异地/保留策略 |
| P1-1 | SSE 无 idle timeout | 🟢 关闭 | 默认 60 s，可环境变量覆盖，内容保留 |
| P1-2 | SSRF 残余 | 🟡 部分关闭 | 重定向已拒绝；DNS 重绑定窗口仍在（见 7.5） |
| P1-3 | 多进程限流 | 🔴 保持 | 仍为进程内存态；`README.md:244` 已声明仅适合单进程 |
| P1-4 | 改密/重置不踢会话 | 🟢 关闭 | 本人改密踢其它；管理员重置踢全部 |
| P1-5 | 密钥启动不校验 | 🟢 关闭 | `[key]` 自检 + FATAL exit(1)（实测） |
| P1-6 | 无测试/CI/git | 🟡 部分关闭 | 83 用例已落地；`.git` 与 CI 仍无 |
| P1-7 | TRUST_PROXY/XFF 配置风险 | 🟡 部分缓解 | `.env.example:27-30` 已写明风险与用法；部署文档仍待 08 章补全 |
| P2-9 | `/api` 无缓存控制 | 🟢 关闭 | `app.js:155-159` |
| P2-1/2/3/4/5/6/7/8/10/11/12 | 会话模型、忘记密码、dbSize、migration、密码策略、dev-secrets 混合、settings 兜底、CSP、管理页静态可访问、审计日志、数据保留 | 🔴 保持 | 见 7.5 与根 README 已知限制（`README.md:229-245`） |

### 7.5 第二批仍未完成 / 新遗留

| # | 事项 | 现状与证据 | 建议落点 |
|---|---|---|---|
| 1 | SSRF DNS 重绑定窗口 | `upstream-guard.js:135-171` 只校验解析结果，与真实 `fetch` 连接之间存在 TOCTOU；重定向面已关闭 | 连接层固定 IP（如 undici dispatcher）或连接后二次校验；`provider-client.js`/`chat-client.js` |
| 2 | 限流单进程内存态 | `rate-limit.js:21-30` Map；多实例额度 ×N、重启清零；README:244 已声明 | 明确单进程部署，或改 SQLite/Redis 共享计数 |
| 3 | 无 `.git` / CI | 实测 `NO_GIT`；无 CI 配置 | `git init` + 基线提交 + CI 跑 `npm test` |
| 4 | 无 DB migration | `server/database/init.js:5-77` 仅 `CREATE TABLE IF NOT EXISTS`，无 `user_version` | 版本号 + 迁移脚本 |
| 5 | dbSize 不含 WAL/SHM | `server/routes/admin.js:64-70` 只 stat 主库；第一轮实测主库 86,016 B vs 三件套 349,536 B | 合计 db+wal+shm 或 `page_count*page_size` + WAL |
| 6 | 会话模型不沿用 | `chat-store.js:77-94` 未传 `modelId` 只取默认；`touchConversation` 会覆盖 `model_id` | 优先读会话最近模型（仍启用）再回落默认 |
| 7 | 忘记密码 / 记住我 | 登录页「忘记密码？」是 `data-pending` 占位（`public/login.html:42`）；「记住我」仅 UI | 一次性 token + 邮件，或明确「联系管理员重置」引导 |
| 8 | 密码策略两套 | 注册/改密 6–64 位无复杂度（`validation.js:2-5`）；管理员重置 8–32 位且含字母+数字（`users.js:16-17,206-213`） | 统一策略并写入 07/04；README:243 已记录 |
| 9 | `public/js/admin.js` 死代码 | 6 个后台页仍加载（如 `public/admin/admin.html:183`），属阶段 1 遗留 | 删除引用与文件，或复用为公共后台逻辑 |
| 10 | user.html「历史对话」静态空态 | `public/user.html:153` 有卡片标题，未接会话 API | 接 `GET /api/chat/conversations` 或移除该卡片 |
| 11 | 多模态能力卡「暂未支持」 | `public/index.html:131` 04 卡片标注 `cl-tag--off` | 产品规划项，维持标签即可 |
| 12 | 审计日志 / 数据保留 | 登录失败、限流、SSRF 拦截仅 console；无归档/保留策略 | 结构化安全日志 + 清理/归档脚本 |
| 13 | 根 README 两个残留措辞 | A6（模型 test 端点未列）、A9（生产 dev-secrets 措辞） | 直接改 `README.md:39,140` |

### 7.6 复核方式（本节结论的验证入口）

```powershell
npm test                 # 83 用例，实测 5.49 s 全绿（不写真实库）
npm run backup           # 输出 PRAGMA quick_check = ok，产物在 data/backups/
# 临时库 + 3100 端口冒烟：启动日志应含 [key] ENCRYPTION_KEY 自检通过
#   /api/* → Cache-Control: no-store；/ → public, max-age=0；无 CSRF 写请求 403
# 无效密钥启动：输出 [FATAL] 且退出码 1（见 server/app.js:112-124）
```

### 7.7 结论

- **阶段 6 可标记「基本完成」**，阶段 7「进行中」；本批修复使 §4.2 的 1/3/4 与 §5 的多个 P0/P1 关闭或缓解。
- 后续优先级：DNS 重绑定（P1）→ 跨进程限流（P1）→ `.git`+CI（P1）→ dbSize 口径/会话模型沿用/忘记密码与密码策略（P2）。
- 与第一轮口径一致：本批复核仍未对真实库执行登录/注册/聊天等写操作（所有写测试均在临时库完成）。
---

## 8. 第三批：PostgreSQL 迁移后的状态（2026-11-15）

> 本节覆盖第三批（feat/postgres-migration）。§1–§7 的 SQLite 结论保留作历史，不再代表现状。

### 8.1 数据层现状

- 运行时：**PostgreSQL + `pg` 连接池**（`server/database/db.js`），全异步；`DB_PATH`/WAL/SQLite 文件机制已移除；better-sqlite3 仅 devDependencies（供一次性迁移脚本）；
- 表结构：7 张表语义不变，主键改 `GENERATED ALWAYS AS IDENTITY`，`sessions.expire` 为 `BIGINT`；初始化 `await initDatabase()` 幂等；
- 会话：`PgSessionStore`（表 `sessions`），改密/重置密码按用户失效会话（功能沿用第二批）；
- 备份：`npm run backup` → `pg_dump` 明文 SQL `data/backups/chenlong-*.sql`；恢复 `psql -f`；**`ENCRYPTION_KEY` 仍必须与备份分开离线保管**；
- 健康检查：`/api/health` 内部 `await ping()`；
- 部署：compose 增加 `postgres:17` db 服务、`./pgdata` 卷、`pg_isready` healthcheck、`app depends_on db healthy`；
- CI：test job 增加 PostgreSQL service 容器；Docker job 用 compose 起 db+app 冒烟。

### 8.2 对前文风险的更新（相对 §5 与 §7.5）

| 第一/二轮风险 | 迁移后状态 |
|---|---|
| P0-2 备份漏 WAL | 🟢 关闭（换 PG）：`pg_dump` 一致性备份；不再有 WAL 三件套问题；新风险转为备份明文/密钥保管（见 03 §10、08 §8） |
| P1-3 多进程/单写者限制 | 🟡 部分缓解：PG 支持并发写，SQLite 单写者约束消失；但**限流仍是进程内存态**，多实例前仍要换共享存储 |
| P2-3 dbSize 不含 WAL | 🟢 关闭：改为 `pg_database_size()`（含索引/TOAST）；口径变为"不等于业务数据量" |
| 备份脚本/P0-2 相关文档 | 🟢 由 pg_dump 文档取代（03 §10、08 §6.4/§8、DEPLOY-DOCKER §5） |
| 测试"随时可跑" | 🟡 变化：`npm test` 需要可达的 PostgreSQL（CI service / 本地 compose db）；本机无 PG 不可跑 |
| SQLite 相关历史结论（§3 数据快照、§6 附录命令） | 📜 历史快照；迁移后数据以 PG 为准，本机未做 PG 实物核查（待核实） |

### 8.3 新增风险与待办（PostgreSQL 专属）

1. **迁移脚本已落地、尚未演练**：`scripts/migrate-sqlite-to-pg.js` 支持 `--dry-run`/`--allow-existing`、保留原始 id 并用 `setval` 对齐 IDENTITY 序列、`sessions` 不迁移；真实 PG 上的行数核对与密文解密验证待 CI/维护者执行（本机无 PG，待核实）；
2. **会话按用户失效是全表扫描**：`SELECT sid, sess FROM sessions` 后逐条删，会话量大时性能差；建议加 `user_id` 列/索引；
3. **PG 备份治理**：pg_dump 明文含聊天记录；备份加密、保留策略、异地/定时任务仍缺；
4. **连接池与多实例**：`PG_POOL_MAX=10` 默认，多实例 × 池上限需小于 PG `max_connections`；长事务会占连接；
5. **无 migration 框架**：PG 下改表风险更高（DDL 锁表），仍需版本化迁移；
6. **本地开发前置变化**：没有 PG 时 `npm test` 不可用；本地需 `docker compose up -d db` + `DATABASE_URL`（见 08/CONTRIBUTING）；
7. **旧 SQLite 文件与旧备份**：迁移完成后应归档（含历史备份 `.db`），避免与新 `.sql` 备份混放；历史文件含明文聊天记录，按敏感数据处理。

### 8.4 文档同步

本轮已同步：README（技术栈/快速开始/测试备份/已知限制/目录树/CI）、CONTRIBUTING（本地 PG 前置）、SECURITY（PG 备份/凭据）、DEPLOY-DOCKER（db 服务/pgdata/备份恢复/排错）、03（重写）、08（重写）、01/02/07/10/12（异步数据层与 CI）、11（§8 第三批记录）、知识库索引 README（索引/速查卡/快照）。历史章节中的 SQLite 表述保留但已标注为迁移前快照。

