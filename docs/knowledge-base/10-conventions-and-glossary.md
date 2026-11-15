# 10 约定与术语

> 本章是**给贡献者看的**：术语怎么说、常量在哪、代码怎么组织、已知不一致有哪些、加功能要动哪里。

## 1. 术语表

| 术语 | 含义 | 易混淆点 |
|---|---|---|
| 尘龙 / ChenLong | 本项目名（AI 助手网站） | — |
| 前台 / 后台 | 前台 = 首页/聊天/登录/个人中心；后台 = `public/admin/*` 六个管理页 | "后台"不是管理 API 的统称 |
| **conversation**（会话） | 一场聊天，存 `conversations` + `messages` | 与 **session** 完全不同 |
| **session**（登录会话） | 浏览器登录态，存 `sessions` 表 + Cookie `chenlong.sid` | 中文都叫"会话"，代码/文档里必须靠上下文区分 |
| message | 一条消息（user / assistant），system 提示不落库 | — |
| API 服务 / provider | 一组上游配置：Base URL + Key + 类型（`api_providers`） | 不是"接口"的意思 |
| 上游 | 真正提供模型能力的外部服务（OpenAI 兼容） | — |
| 模型 model | 库里的 `models` 行；`id` 是内部主键，`model_id` 是上游模型名 | 请求里传的 `modelId` 是内部主键 |
| 默认模型 | `is_default=1` 的已启用模型，全局唯一（应用层保证） | — |
| 掩码 / keyMasked | 前 3 位 + "`…`（U+2026）" + 后 4 位；短 Key 统一 `••••` | 不是脱敏后仍可用的 Key |
| 播种 seeding | 首次启动写入默认设置和管理员 | 幂等：已有则不写 |
| 错误信封 | `{"error":{"code","message"}}` | 成功响应不会带 `error` |
| 守卫 guard | 前端 `body[data-guard="auth|admin"]` + `public/js/guard.js` 的页面级跳转保护 | 不是服务端鉴权 |
| CL | 前端全局公共库（`public/js/app.js` 暴露 `window.CL`） | — |
| SSE | Server-Sent Events，本项目的流式聊天协议 | 帧是"服务端自定义 JSON"，不是 OpenAI 原始事件 |
| WAL | SQLite 预写日志模式，`-wal`/`-shm` 文件 | 备份时容易漏 |
| dev-secrets | `data/.dev-secrets.json`，开发环境自动生成的密钥文件（明文） | 生产禁用 |
| 迁移 migration | 表结构版本化变更脚本 | **本项目没有**，改表靠手工 |

## 2. 常量与"魔法数字"总表

| 值 | 含义 | 位置 | 详见 |
|---|---|---|---|
| 7 天 | 会话有效期 | app.js:22、session-store.js:5 | [07](07-security.md) |
| bcrypt cost 10 | 密码哈希强度 | auth.js:16、profile.js、users.js | — |
| 300 / 60s / IP | 全局限流（仅写请求） | app.js:26 | [04](04-api.md) |
| 10 / 5min / IP | 登录限流 | app.js:27 | 同上 |
| 5 / 10min / IP | 注册限流 | app.js:28 | 同上 |
| 10 / 60s / 管理员 | 重置密码限流 | app.js:29 | 同上 |
| 20 / 60s / 用户 | 聊天限流 | app.js:30 | 同上 |
| 1 MB | 请求体上限 | app.js:119–120 | — |
| 20 条 | 聊天上下文消息数 | chat-store.js:4 | [06](06-chat-flow.md) |
| 4000 字 | 单条用户消息上限 | chat-store.js:8 | — |
| 40 字 / 20 码位 | 会话标题上限 / 自动标题截取 | chat-store.js:6–7 | — |
| 10 秒 | 上游建连超时 | provider-client.js:3 | [06](06-chat-flow.md) |
| 60 秒 | 聊天流空闲超时（可用 `CHAT_STREAM_IDLE_TIMEOUT_MS` 覆盖） | chat-client.js:11–18 | [06](06-chat-flow.md) |
| 200 KB | 上游原文兜底保留上限 | chat-client.js:9 | 同上 |
| 20 / 100 | 列表分页默认/上限 | users.js:14–15、admin.js | [04](04-api.md) |
| 50 / 100 | 消息分页默认/上限 | admin.js:16 | 同上 |
| 5 | 仪表盘"最近"列表长度 | admin.js:17 | — |
| 40 / 60 / 200 / 200 | 站点名/副标题/公告/Logo 长度上限 | settings-store.js:14–18 | [03](03-database.md) |
| 50 / 200 / 512 / 50 | 服务名/描述/Key/API 类型长度上限 | providers.js:14–19 | — |
| 100 / 100 | 上游模型名/显示名长度上限 | models.js:9–10 | — |
| 8–32 + 字母数字 | 管理员重置他人密码的规则 | users.js:16–17,208–212 | 见 §4 不一致 |
| 6–64 | 注册 / 自助改密的密码规则 | validation.js | 见 §4 |
| 640 / 760 px | 表格最小宽度（小屏/桌面） | common.css:309,529 | [05](05-frontend.md) |
| 49 | `--cl-*` CSS 变量总数 | common.css:8–69 | [05](05-frontend.md) |
| max-age=15552000 | HSTS（180 天） | security-headers.js:14 | [07](07-security.md) |

## 3. 代码约定

### 3.1 后端（server/）

| 约定 | 说明 |
|---|---|
| 模块 | CommonJS（`require/module.exports`），无 ESM、无 TS、无构建 |
| 文件命名 | 单词文件用单词（`auth.js`），多词用 kebab-case（`session-store.js`、`provider-client.js`、`security-headers.js`） |
| 分层 | routes 只做 HTTP/校验；业务与存储进 services；SQL 不进 routes（少数统计 SQL 例外：admin.js） |
| 响应字段 | JSON 一律 camelCase（`conversationId`），数据库列 snake_case（`conversation_id`），用 `toXxx()` 转换 |
| 校验风格 | `readXxx()` 返回 `{ok:true,value}` 或 `{ok:false,message}`；路由开头集中校验 |
| 错误返回 | 本文件内 `fail(res, status, code, message)`（8 个 routes 各有一份，重复但一致） |
| 日志前缀 | `[chat]` / `[db]` / `[error]` / `[WARN]` / `[FATAL]` / `[session-store]` / `[upstream-guard]` / `[provider-client]` / `[chat-client]`；文案中文 |
| 事务 | 多条关联写必须 `db.transaction` |
| 时间 | `new Date().toISOString()`（UTC ISO 字符串） |
| 布尔 | 库内 0/1，接口层 boolean |
| 参数化 | 禁止字符串拼接 SQL/用户输入；LIKE 需 `escapeLike` + `ESCAPE '\'` |
| 单例 | 数据库连接、加密 key 缓存、限流 Map、session store 均进程级单例；无 DI 容器 |
| 未使用的代码 | `server/routes/settings.js` 里的 `readBody` 等小工具是局部实现；没有 lint 配置 |

### 3.2 前端（public/）

| 约定 | 说明 |
|---|---|
| 全局命名空间 | 所有公共能力挂 `window.CL`（`CL.fetchJSON`、`CL.csrf`、`CL.settings`、`CL.toast`、`CL.modal` 等） |
| 加载方式 | 每页按顺序 `<script>` 引入（common 在前、页面脚本在后）；**禁止内联脚本**（CSP script-src 'self'） |
| 请求 | 统一用 `CL.fetchJSON`（自动 CSRF、错误信封解析、401 跳转） |
| 守卫 | `<body data-guard="auth|admin">` + `guard.js`；守卫失败跳 `login.html?redirect=<当前路径>` |
| 样式 | 类名 `cl-*` 前缀；颜色/圆角/阴影用 `--cl-*` 变量；页面级样式放对应 css |
| 文案 | 中文；错误提示直接用后端 `message` 或固定兜底文案 |
| 无构建 | 不能 `import`/`export`；复用靠全局对象 |
| 兼容 | 使用 ES6+（`async/await`、模板串、可选链较少），面向现代浏览器 |

### 3.3 新增功能的检查清单

**加一个 API 接口**

1. 在对应 `server/routes/xxx.js` 加 handler（校验 → 业务 → 统一信封）；
2. 需要鉴权就 `router.use(requireAuth)` / `requireAdmin`；敏感写接口考虑限流；
3. 是否在 `server/app.js` 挂载（已有模块内新增不用改）；
4. 更新 [04](04-api.md) 的端点表与错误码；
5. 前端用 `CL.fetchJSON` 调用（写请求自动带 CSRF）。

**加一张表 / 改表**

1. 改 `server/database/init.js` 的 `SCHEMA_SQL`（`CREATE TABLE IF NOT EXISTS` 只对新库生效）；
2. 老库需手写迁移（`ALTER TABLE` / 重建表），并更新 [03](03-database.md)；
3. 补索引；检查级联删除语义；备份后演练。

**加一个环境变量**

1. 在读取处做默认值与合法性校验（参考 `isTruthyEnv` / `isRateLimitEnabled`）；
2. 生产/开发语义差异要显式（参考 `ALLOW_PRIVATE_UPSTREAM` 生产强制关闭）；
3. 更新 `.env.example` 与 [08](08-config-and-ops.md)。

**加一个后台页面**

1. 复制现有 `admin/xxx.html` 结构（侧栏、公告、`data-guard="admin"`）；
2. 页面脚本沿用 `CL.fetchJSON` + 表格渲染 + 分页模式；
3. 记得处理公告条（6 个后台页已统一 `hoistAnnouncement`，新增页面照抄该模式，见 §4）；

### 3.4 测试、备份与质量门禁

| 命令 | 说明 |
|---|---|
| `npm test` | node:test 全量（core 65 + features 18 = 83 个用例，约 5s） |
| `npm run test:core` | 只跑单元测试 |
| `npm run backup`（`node scripts/backup-db.js`） | 一致性备份到 `data/backups/`（WAL 安全 + `quick_check` 校验；支持 `--out/--db/--force`） |
| `node --check <file>` | 单文件语法检查（本项目仍无 lint 脚本） |

- 新功能/修 bug 至少补一个测试；测试必须使用 `os.tmpdir()` 临时库与随机端口，**禁止读写真实 `data/chenlong.db`**；
- 备份目录 `data/backups/` 已 gitignore；`ENCRYPTION_KEY` 必须与备份分开离线保管。

## 4. 已知不一致与坑（跨文档汇总）

### 4.1 前后端/文档不一致（2026-11-15 第二批改进后状态）

> 本表已按第二批改进更新：✅ = 已修复，⚠️ = 仍存在。完整改动见 [11](11-changes.md)。

| # | 现象 | 证据 | 状态 / 影响 |
|---|---|---|---|
| 1 | 会话重命名输入框曾允许 **60** 字，后端只接受 **40** 字 | ✅ `chat.js` 的 `maxlength` 已改 40 | 已修复 |
| 2 | 外链 Logo 永不显示（前端回退默认图，后端允许 `http(s)://`） | ✅ `app.js` 的 `settingLogo` 放行站内路径与 http(s) 绝对地址、新增 `logoSrc`；仍拒绝 `javascript:` 等 scheme 与协议相对 `//` | 已修复（失败仍回退默认图） |
| 3 | 密码规则按入口不同：注册/自助改密 **6–64 位**（无复杂度）；管理员重置 **8–32 位且含字母+数字** | validation.js vs users.js:16–17,208–212；admin-users.js:460–461 | ⚠️ 仍存在（设计选择）：管理员被强制更严格规则 |
| 4 | 后台 6 个页面曾无"退出登录"入口 | ✅ 6 页侧栏已加 `data-logout`（auth.js 自动绑定） | 已修复 |
| 5 | `hoistAnnouncement` 曾在 `api`/`models` 两页缺失 | ✅ 两页已补齐（现 6 页一致） | 已修复 |
| 6 | `public/js/admin.js` 是**阶段 1 骨架**（方法全部 `pending()` 抛错），仍被 6 个后台页引入 | admin.js 全文 + 各后台 html 的 script 标签 | ⚠️ 仍存在：死代码，实际请求由各页 admin-*.js 直接发 |
| 7 | 首页/用户中心曾有"待接入接口""对话接口待接入"文案 | ✅ 已改为现状描述（能力卡 01–03「已接入」、04「暂未支持」） | 已修复 |
| 8 | 后台表格最小宽度：README 曾写 640 px，实际桌面 760 px | ✅ 根 README 已更新为 760/640 表述 | 已修复 |
| 9 | 根 README 的阶段 6/接口/环境变量描述滞后 | ✅ 根 README 已刷新（阶段 6 基本完成、补 csrf-token/限流/SSRF/会话失效/测试与备份） | 已修复 |
| 10 | README 曾称 `--cl-*` 变量 49 个但分组数字不准 | ✅ 根 README 已不再写错误分组；总数 49 属实，分组以 [05](05-frontend.md) 为准 | 已修复 |

### 4.2 工程/架构级坑（2026-11-15 第二批改进后状态）

| # | 坑 | 影响 | 状态 / 缓解 |
|---|---|---|---|
| 1 | **没有 `.git` 仓库**（只有 .gitignore） | 无版本回滚、无法追溯 | ✅ 已解决（2026-11-15）：已 `git init`、提交并推送到 GitHub 公开仓库；`data/backups/` 已在 .gitignore |
| 2 | 没有测试 / lint / CI | 改动无自动验证 | 部分缓解：已补 `node:test` 83 个用例；仍无 lint 与 CI |
| 3 | 没有 migration 框架 | 表结构升级易出错 | ⚠️ 仍存在：手工迁移 + 备份演练 |
| 4 | 限流是进程内存态 | 多实例部署额度翻倍；重启清零 | ⚠️ 仍存在：单实例部署或换共享存储 |
| 5 | 聊天无流式 idle 超时 | 上游卡住时请求挂着 | ✅ 已修复：默认 60 秒无数据中断（`CHAT_STREAM_IDLE_TIMEOUT_MS` 可调） |
| 6 | Base URL 若不带 `/v1`，聊天路径没有回退 | 聊天 404"接口地址不存在" | ⚠️ 仍存在：配置时把 `/v1` 写进 Base URL |
| 7 | 聊天接口无幂等 | 重发会写两条用户消息 | ⚠️ 仍存在：前端不要自动重试 |
| 8 | 管理员重置密码/改角色不踢会话 | 旧会话可继续用 | 部分修复：**重置密码已踢掉全部会话**；改角色/禁用仍在下次请求生效 |
| 9 | 匿名取 CSRF token 会产生 `sessions` 行 | 表里 1 条会话 ≠ 有人登录 | ⚠️ 预期行为，排查时别误判 |
| 10 | `dbSizeBytes` 不含 WAL/SHM | 仪表盘低估占用 | ⚠️ 仍存在：用文件系统统计 |

## 5. 文档维护约定

1. 改代码 → 改对应文档（映射见 [README](README.md#维护约定)）；
2. 行号会漂移：引用行号时同时描述语义，便于失效后仍可定位；
3. 发现新的不一致：先补进本章 §4，再在代码修复后移除；
4. 不记录任何真实密钥/密码/Token；
5. 若某结论变成"待核实"，明确标注而不是猜测。
