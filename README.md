# 尘龙 ChenLong

[![CI](https://github.com/TSS-Small-sunshine/ChenLong/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TSS-Small-sunshine/ChenLong/actions/workflows/ci.yml)

> 一个 AI 助手网站：原生 HTML/CSS/JS 前端 + Node.js/Express 后端 + SQLite 存储。
> 当前进度：**阶段 6 基本完成**（阶段 1–5 全部完成；限流 / CSRF / SSRF / 安全响应头 / 会话失效 / 流式空闲超时已落地）。
> 工程知识库见 [docs/knowledge-base/](docs/knowledge-base/README.md)：架构、数据库、API、前端、安全、运维与现状差距。
> GitHub 仓库：<https://github.com/TSS-Small-sunshine/ChenLong>（public，`main` 分支；首次提交 2026-11-15）

---

## 技术栈

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 前端 | 原生 HTML5 / CSS3 / ES6+ | — | 无框架、无构建工具、无 CDN，双击即可打开 |
| 后端 | Node.js + Express | 24 / 5.3.0 | CommonJS |
| 数据库 | SQLite（better-sqlite3） | 13.1.1 | 同步 API，WAL 模式 |
| 密码 | bcryptjs | 3.0.3 | 10 轮 |
| 会话 | express-session | 1.19.0 | httpOnly Cookie，7 天，**会话存 SQLite（重启不掉登录）** |
| 加密 | Node crypto（AES-256-GCM） | 内置 | 格式 `v1:iv:tag:cipher` |
| 配置 | dotenv | 18.0.10 | 读项目根目录 `.env` |

---

## 快速开始

```bash
cd D:\ICT\ChenLong
cp .env.example .env        # 建议填 SESSION_SECRET / ENCRYPTION_KEY / ADMIN_PASSWORD
npm install
npm start                   # → http://localhost:3000
npm run dev                 # 开发模式（node --watch，改后端自动重启）
npm run init-db             # 只初始化数据库（幂等）
npm test                    # 运行 node:test 测试套件（83 个用例）
npm run backup              # 一致性备份数据库 → data/backups/
```

* 首次启动自动建表（7 张）并写入默认系统设置（6 条，幂等）。
* 只有当 `users` 表里**没有任何 admin** 时，才会用 `.env` 里的 `ADMIN_USERNAME/ADMIN_PASSWORD` 创建一次管理员；日志不打印密码。已有管理员后再改这两个变量不会改库。
* 开发环境缺 `SESSION_SECRET` / `ENCRYPTION_KEY` 时：生成一次并存进 `data/.dev-secrets.json`，之后**复用它**（所以重启不会掉登录、也不会让已加密的 API Key 解不开）。该文件已被 `.gitignore` 忽略，但**是明文的**。
* 生产环境（`NODE_ENV=production`）缺密钥或 `.dev-secrets.json` 损坏 → 直接退出，绝不覆盖。
* **启动自检**：启动时对 `ENCRYPTION_KEY` 做一次「加密→解密」哨兵自检，密钥不可用直接 `[FATAL]` 退出，避免「服务能启动、首次保存 API Key 才 500」。
* **会话失效**：管理员重置他人密码会立即踢掉目标用户全部已登录会话；用户自助改密会踢掉其它设备会话、保留当前会话。

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 目录结构

```
ChenLong/
├─ server/                     后端（CommonJS）
│  ├─ app.js                   入口：密钥解析与自检、会话、中间件装配、路由挂载、静态目录、/api/health、错误处理
│  ├─ database/
│  │  ├─ db.js                 打开 SQLite（WAL + 外键 + busy_timeout）、导出单例
│  │  └─ init.js               建表（7 张）+ 索引 + 默认设置 + 播种管理员（幂等）
│  ├─ services/
│  │  ├─ encryption.js         AES-256-GCM 加解密 API Key + 启动哨兵自检
│  │  ├─ session-store.js      SqliteSessionStore（含按用户失效会话）
│  │  ├─ dev-secrets.js        开发密钥生成/复用（原子写入，损坏即报错退出）
│  │  ├─ validation.js         用户名/密码/昵称校验与错误文案
│  │  ├─ provider-client.js    上游模型发现：URL 归一化、10 秒超时、重定向拒绝、中文错误映射
│  │  ├─ upstream-guard.js     上游 SSRF 防护（内网/保留段 + DNS 全记录校验）
│  │  ├─ rate-limit.js         内存滑动窗口限流
│  │  ├─ key-mask.js           API Key 掩码（前 3 位 + … + 后 4 位）
│  │  ├─ settings-store.js     系统设置的读写、布尔转换、默认值兜底
│  │  ├─ chat-store.js         会话/消息读写、最近 20 条上下文、自动标题
│  │  └─ chat-client.js        调上游 chat/completions + SSE 帧解析 + 流空闲超时
│  ├─ middleware/
│  │  ├─ auth.js               把 session 里的用户挂到 req.user / requireAuth
│  │  ├─ admin.js              要求 req.user.role === 'admin'
│  │  ├─ csrf.js               Session + X-CSRF-Token 双校验（timingSafeEqual）
│  │  └─ security-headers.js   CSP / HSTS / nosniff / Referrer-Policy 等安全响应头
│  └─ routes/                  auth / profile / users / providers / models / chat / settings / admin（全部已实现）
├─ public/                     前端（由 Express 静态托管）
│  ├─ index.html               首页
│  ├─ chat.html                聊天页（流式对话 + 会话列表）
│  ├─ login.html / register.html / user.html
│  ├─ admin/                   后台六页：admin / api / models / users / data / settings
│  ├─ css/                     common.css（设计变量与组件）+ home / chat / admin
│  ├─ js/                      app.js（公共库 CL + fetchJSON + CL.settings）、auth.js、guard.js、chat.js、
│  │                           api.js、models.js、admin.js、admin-users.js、admin-data.js、
│  │                           admin-settings.js、admin-dashboard.js
│  └─ assets/                  mascot/logo.png（原创小图）、icons/、images/
├─ test/                       node:test 测试套件（core 单元 + features 特性/集成）
├─ scripts/backup-db.js        一致性数据库备份脚本（WAL 安全，npm run backup）
├─ docs/knowledge-base/        工程知识库（架构/数据库/API/前端/安全/运维/现状差距）
├─ data/
│  ├─ chenlong.db              SQLite 数据文件（.gitignore 忽略；伴随 -wal/-shm）
│  ├─ backups/                 数据库备份输出目录（.gitignore 忽略）
│  └─ .dev-secrets.json        开发密钥（.gitignore 忽略，明文，勿提交）
├─ .env.example                环境变量样例
├─ package.json
└─ README.md
```

---

## 页面清单

| 路径 | 页面 | 状态 |
|---|---|---|
| `/` | 首页 | 完成（游客/已登录双态导航；站名/副标题/logo/公告随系统设置变化） |
| `/chat.html` | 聊天 | ✅ 已接后端：SSE 逐字输出、停止生成、会话列表/新建/切换/重命名/删除、模型下拉；游客点发送跳登录；`allowChat=false` 时禁用输入并提示 |
| `/login.html` `/register.html` | 登录 / 注册 | ✅ 已接后端，支持 `?redirect=` 回跳；`allowRegister=false` 时注册表单被锁并提示 |
| `/user.html` | 个人中心 | ✅ 需登录：改昵称、改密码、查看注册时间 |
| `/admin/admin.html` | 后台仪表盘 | ✅ 需管理员：用户/会话/消息/服务四个数字 + 最近添加 API + 最近使用模型 + 系统状态 |
| `/admin/api.html` | API 管理 | ✅ 需管理员：增删改、启停、测试连接、刷新模型（都走真上游） |
| `/admin/models.html` | 模型管理 | ✅ 需管理员：筛选、增删改、启停、设默认（全局唯一）、从 API 同步 |
| `/admin/users.html` | 用户管理 | ✅ 需管理员：搜索/状态筛选/分页、详情、启停、改角色、重置密码（不含硬删除） |
| `/admin/data.html` | 聊天数据 | ✅ 需管理员：会话列表 + 关键词/用户筛选 + 分页 + 消息抽屉（只读，不可删） |
| `/admin/settings.html` | 系统设置 | ✅ 需管理员：站点名/副标题/logo/公告/注册开关/聊天开关，保存即生效 |

前端设计系统：`public/css/common.css` 里 49 个 `--cl-*` 变量（颜色 / 玻璃 / 渐变 / 圆角 / 阴影 / 字体 / 布局 / 按钮等；分类明细与组件约定见 [知识库 05](docs/knowledge-base/05-frontend.md)）。
品牌色：`#65BFFF` `#A99BFF` `#F6F8FF` `#101B43` `#35D5FF`。
页面守卫：`body[data-guard="auth"]` / `[data-guard="admin"]`，由 `public/js/guard.js` 调 `GET /api/auth/me` 判定后跳转 `login.html?redirect=<当前路径>`。聊天页不用静态守卫，由 `public/js/chat.js` 在写操作前检查登录态（游客仍可看界面）。

---

## 接口现状

| 接口 | 状态 |
|---|---|
| `GET /api/health` | ✅ 返回 `{status, uptime, db, version}`；数据库异常时 503 |
| `GET /api/csrf-token` | ✅ 公开：返回 `{token}`；**所有非 GET/HEAD/OPTIONS 的 `/api` 写请求必须带 `X-CSRF-Token`**（登录/注册/登出也不例外） |
| `POST /api/auth/register` | ✅ 201，注册即建立会话；用户名/密码校验，重名 409；`allowRegister=false` 时 403 `REGISTER_DISABLED` |
| `POST /api/auth/login` | ✅ 200；先 regenerate 会话防固定；用户名或密码错误统一 401；账号被禁用 403 |
| `POST /api/auth/logout` | ✅ 204（销毁会话 + 清 Cookie） |
| `GET /api/auth/me` | ✅ 200 当前用户；未登录 401 |
| `PATCH /api/user/profile` | ✅ 改昵称（trim 后 1–20 字） |
| `PATCH /api/user/password` | ✅ 校验旧密码；改完保留当前会话、让其它设备会话失效（响应带 `revokedSessions`） |
| `GET /api/users` | ✅ 仅管理员：`?keyword=&status=&role=&page=&pageSize=` → `{items, total, page, pageSize}`，每行带 `conversationCount` |
| `GET /api/users/:id` | ✅ 仅管理员：单用户详情（多一个 `messageCount`） |
| `PATCH /api/users/:id` | ✅ 仅管理员：`{nickname?, role?, status?}`；改自己 400 `CANNOT_MODIFY_SELF`；把最后一个启用管理员降级/禁用 400 `LAST_ADMIN` |
| `POST /api/users/:id/password` | ✅ 仅管理员：重置密码 204，不要求旧密码；**会踢掉目标用户全部已登录会话** |
| `/api/providers` | ✅ 仅管理员：列表/详情只返回 `keyMasked`，编辑时 `apiKey` 留空＝不改；`POST /:id/test` 与 `POST /:id/refresh-models` 带解密后的 Key 调上游 |
| `/api/models` | ✅ 仅管理员：`?providerId=&keyword=&status=` 筛选；增删改、`PATCH /:id/status`、`PATCH /:id/default`（全局唯一，禁用模型设默认报 400） |
| `GET /api/admin/stats` | ✅ 仅管理员：`{stats:{userCount,conversationCount,messageCount,providerCount}, recentProviders, recentModels, system:{version,nodeVersion,uptimeSeconds,dbSizeBytes}}` |
| `GET /api/admin/conversations` | ✅ 仅管理员：`?keyword=&userId=&page=&pageSize=`，带用户昵称、模型名、消息数 |
| `GET /api/admin/conversations/:id/messages` | ✅ 仅管理员：消息按 id 升序分页（`pageSize` 1–100），带会话概要 |
| `GET /api/settings` | ✅ 公开：`{items:{siteName,siteSubtitle,allowRegister,allowChat,announcement,logo}}` |
| `PATCH /api/settings` | ✅ 仅管理员：任意子集更新；siteName 1–40、siteSubtitle ≤60、announcement ≤200、logo 必须以 `/` 或 `http(s)://` 开头 |
| `GET /api/chat/models` | ✅ 需登录：只列已启用模型，默认模型排首位 |
| `/api/chat/conversations` | ✅ 需登录：`GET`（`?keyword=` 搜索，带 messageCount）/ `POST`；`GET /:id/messages`、`PATCH /:id`（标题 1–40 字）、`DELETE /:id`；**他人会话一律 404** |
| `POST /api/chat/completions` | ✅ 需登录：`{conversationId, modelId, message, stream}`；`stream:true` 走 SSE，`stream:false` 返回整段 JSON；响应带 `conversationId`；`allowChat=false` 时 403 `CHAT_DISABLED`；流空闲超时（默认 60 秒）与上游重定向会以 error 帧返回 |

错误信封统一为：

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "用户名或密码错误" } }
```

所有 `/api` 响应带 `Cache-Control: no-store`；写请求超过限流阈值返回 429 `RATE_LIMITED` 与 `Retry-After` / `X-RateLimit-*` 响应头。

上游行为：拉取模型会先试 `{Base URL}/models`，Base URL 不以 `/v1` 结尾再试 `{Base URL}/v1/models`（404 才回退）；超时 10 秒。拉到的模型**全部入库但默认禁用**，重复拉取幂等、不覆盖已改的启停与默认。上游不可达时 `test` 返回 200 `{ok:false, message}`，`refresh-models` 返回 502 `UPSTREAM_ERROR`。上游重定向一律拒绝（SSRF 防护，`fetch` 使用 `redirect:'error'`），错误信息会提示改填最终地址。

### 聊天与 SSE

* 模型解析顺序：请求里的 `modelId` → 全局默认模型 → 第一个已启用模型 → 都没有则 400 `NO_AVAILABLE_MODEL`；指定模型不存在或已禁用 → 400 `MODEL_NOT_AVAILABLE`。
* SSE 帧统一为 `data: {"type":"start|delta|done|error",...}`，正常结束再补一帧 `data: [DONE]`。`start` 回传 `conversationId`（首条消息时会话已建好），`delta` 带增量 `content`，`done` 带完整 `content` 与 `assistantMessageId`。
* 空闲超时：上游建连后 60 秒无数据会自动中断并发 `error` 帧，已收到的内容仍会落库；可用 `CHAT_STREAM_IDLE_TIMEOUT_MS` 调整。
* 上下文：取该会话最近 20 条消息 + 一条 system 提示；首条消息前 20 字作为会话标题。
* 客户端断开时：**已收到的非空内容仍会落库**，服务端日志记 `[chat] 客户端断开，已保存部分回复…`；前端停止生成后不再二次对齐。

### 系统设置

6 个键全部可在后台编辑，保存即生效：

* 前台页面加载后调 `GET /api/settings`，由 `CL.settings` 渲染站名、副标题、logo 与公告条（公告可关闭，用 `sessionStorage` 记本次会话内已读）。
* `allowRegister=false` → 注册接口 403 `REGISTER_DISABLED`「管理员已关闭注册」，前端锁住注册表单并提示。
* `allowChat=false` → 聊天接口 403 `CHAT_DISABLED`「管理员已暂停聊天服务」，前端禁用输入框与发送按钮并提示。
* `GET /api/settings` 不可用时前端回落到内置默认值，界面与接入前一致。

---

## 数据库

`users` · `api_providers` · `models` · `conversations` · `messages` · `settings` · `sessions`（另有若干索引）

* 外键约束已开启（`PRAGMA foreign_keys = ON`），WAL 模式。
* 时间字段统一存 ISO 字符串。
* 密码列 `password_hash` 为 bcrypt，形如 `$2b$10$…`（60 字符），任何接口都不返回。
* `settings` 表为 `setting_key / setting_value / updated_at`，布尔值存 `'1'`/`'0'`。
* `sessions` 表由 `SqliteSessionStore` 维护：过期会话在读写时清理，另有每 15 分钟定时清理；支持按用户批量失效（改密/管理员重置密码）。
* 一致性备份用 `npm run backup`（`scripts/backup-db.js`）：基于 SQLite Online Backup API，WAL 中未 checkpoint 的数据也会进入备份，并做 `quick_check` 校验。
* `conversations` 按 `user_id` 归属，`messages` 通过 `conversation_id` 级联删除（删会话即删消息）。

---

## 安全约定

1. **API Key 只加密存库**（AES-256-GCM），任何接口都不返回明文，日志不打印。
2. **会话 Cookie** 为 `httpOnly + sameSite=lax`，生产环境自动加 `secure`；登录成功先 `session.regenerate()` 再写入用户，防会话固定。
3. **登录不泄露账号是否存在**：用户不存在时也执行一次 bcrypt 比对（抹平时间差），错误文案统一「用户名或密码错误」；被封禁账号（`status !== 'active'`）返回 403。
4. **生产环境缺 `SESSION_SECRET` / `ENCRYPTION_KEY` 直接拒绝启动**；开发密钥落在 `data/.dev-secrets.json`，已 gitignore，文件损坏时退出而不是覆盖。
5. 前端不直连任何 AI 服务，全部经后端转发（避免 Key 暴露在浏览器）。
6. 登录后回跳只接受站内相对路径（`public/js/auth.js` 的 `safeRedirect`），拒绝 `//host`、含 `:`、含 `\` 与登录页自身，防开放重定向。
7. 聊天接口 `router.use(requireAuth)`；会话归属校验放在每个 id 操作里，非本人会话一律 404（不泄露存在性）。
8. 后台接口统一 `requireAuth + requireAdmin`；管理员**不能改自己的角色/状态**，也**不能把最后一个启用的管理员降级或禁用**。
9. `keyword` 搜索统一转义 `%` 与 `_`（`LIKE … ESCAPE '\'`），避免被当通配符。
10. 请求体限制 1 MB；全局错误处理在生产环境不返回堆栈。
11. **CSRF**：所有非 GET/HEAD/OPTIONS 的 `/api` 写请求校验 `X-CSRF-Token`（token 存 session、`timingSafeEqual` 比较；登录/注册成功后轮换并回传新 token）。
12. **限流**：全局写 300 次/分/IP；登录 10 次/5 分/IP；注册 5 次/10 分/IP；聊天 20 次/分/用户；管理员重置密码 10 次/分/操作者；生产环境强制开启。
13. **SSRF 上游防护**：保存与调用前校验内网/回环/保留地址与 DNS 全记录；上游 `fetch` 使用 `redirect:'error'` 拒绝重定向。
14. **安全响应头**：CSP、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、X-XSS-Protection:0；HTTPS 下加 HSTS；`/api` 响应统一 `Cache-Control: no-store`。
15. **会话失效**：管理员重置密码 → 目标用户全部会话失效；用户自助改密 → 其它设备会话失效、当前会话保留。
16. **密钥启动自检**：启动时对 `ENCRYPTION_KEY` 做 encrypt→decrypt 哨兵验证，失败即拒绝启动。

---

## 测试与备份

```bash
npm test            # 全部测试（node:test，83 个用例，约 5s）
npm run test:core   # 只跑单元测试（65 个用例）
npm run backup      # 备份到 data/backups/chenlong-YYYYMMDD-HHmmss.db（WAL 安全 + quick_check 校验）
node scripts/backup-db.js --help   # 查看备份脚本参数（--out / --db / --force）
```

* 测试全部使用 `os.tmpdir()` 下的临时数据库与随机端口，**不会写入** `data/chenlong.db`；覆盖 CSRF、限流、加密、SSRF、会话存储、聊天模型解析、SSE 解析、改密会话失效与应用层 HTTP 集成。
* **CI**：`.github/workflows/ci.yml` 在 push / PR 时于 Node 24 上执行 `npm ci && npm test`；改动后看仓库 Actions 页面即可。
* 备份脚本使用 SQLite Online Backup API，自动包含 WAL 中尚未 checkpoint 的数据；恢复时停服后用备份替换 `data/chenlong.db`（同时删除旧的 `-wal`/`-shm`），并确保 `ENCRYPTION_KEY` 与备份时一致。
* 备份目录 `data/backups/` 已被 `.gitignore` 忽略；**`ENCRYPTION_KEY` 必须与备份分开离线保管**，否则已加密的 API Key 永久无法解密。

---

## 已知限制

* **SSRF 残余面**：已实现内网/保留段 + DNS 全记录校验并拒绝上游重定向，但校验与真实连接之间仍存在 DNS 重绑定窗口（概率低，见 [知识库 07](docs/knowledge-base/07-security.md)）。
* **流空闲超时已实现**（默认 60 秒无数据即中断，`CHAT_STREAM_IDLE_TIMEOUT_MS` 可调）；但上游以极慢速率持续吐字时不会触发。
* 聊天请求未传 `modelId` 时按「默认模型」解析，**不会沿用该会话上次用的模型**；会话表的 `model_id` 字段暂不参与解析。
* 站点名含空格时会被拆成「主标题 + 既有副标题」两截渲染（`paintSiteName` 按第一个空格切分），后台改站点名时建议不要带空格。
* **会话失效**：管理员重置他人密码会立即踢下线；禁用账号在下一次请求生效，在途 SSE 不会被立即断开。
* 最后一个启用管理员保护在 HTTP 层不可达（改自己会先被 `CANNOT_MODIFY_SELF` 拦住），只在数据库层脚本中成立。
* 仪表盘的 `dbSizeBytes` 只统计主库文件，不含 `-wal`/`-shm`。
* 后台「聊天数据」的关键词只匹配会话标题与用户昵称/用户名，不搜消息正文；管理员不可删除会话。
* 后台公告条由各页脚本 `hoistAnnouncement` 搬移（6 页已统一），属绕开公共 `app.js` 的补丁。
* 登录页「记住我」只有 UI；「忘记密码」仍是占位（管理员可在用户管理页重置密码）。
* 后台表格窄屏横向滚动（桌面 `min-width:760px`，600px 断点降为 640px），未做卡片式重排。
* 吉祥物完整立绘仍为 CSS 占位；页头 logo 使用原创小图（256×256）。
* **密码策略两套**：注册/自助改密 6–64 位无复杂度；管理员重置 8–32 位且必须含字母+数字（前端弹窗与后端一致）。
* **限流是进程内存态**：多实例部署时额度按实例放大，重启清零；当前仅适合单进程部署。
* **工程化**：已有 GitHub 公开仓库 [`TSS-Small-sunshine/ChenLong`](https://github.com/TSS-Small-sunshine/ChenLong) 与本地 git（main），并接入 GitHub Actions CI（push/PR 自动 `npm test`）；仍无数据库 migration 框架；用户中心「历史对话」仍为静态空态；`public/js/admin.js` 是阶段 1 死代码（6 个后台页仍加载）。

---

## 开发路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 目录结构 + 数据库初始化 + 后端骨架 + 前端壳 | ✅ 完成 |
| 2 | 用户系统（注册/登录/会话/个人中心）+ 后台角色鉴权 | ✅ 完成 |
| 3 | API 管理与 Key 加密存储 + 模型自动发现 | ✅ 完成 |
| 4 | 聊天接口 + SSE 流式 + 会话持久化 | ✅ 完成 |
| 5 | 后台数据页（用户/聊天/设置/仪表盘）接真实数据 + 系统设置生效 | ✅ 完成 |
| 6 | 安全加固（限流 / CSRF / SSRF / 安全响应头 / 会话失效 / 流空闲超时） | ✅ 基本完成（残余：DNS 重绑定窗口、跨进程限流；见知识库 09） |
| 7 | 联调、视觉打磨、文档收尾 | 🟡 进行中（测试套件、知识库、前端一致性修复已落地；CI 与视觉打磨待做） |
