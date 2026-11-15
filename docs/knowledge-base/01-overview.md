# 01 项目概览

> 本章回答：**这是什么、有什么、目录怎么放、怎么跑起来、想改东西该去哪。**
> 更细的机制看 [02 架构](02-architecture.md)，接口看 [04 API](04-api.md)。

## 1. 项目定位

尘龙（ChenLong）是一个**自托管式 AI 助手网站**，定位"自己的小 AI 伙伴"：

- 前端是**手写的原生 HTML/CSS/JS**，没有框架、没有构建工具、没有 CDN 依赖，`public/` 直接可被双击打开（数据接口除外）；
- 后端是一个 **Express 5 单体应用**，既托管静态页面，也提供 `/api` 接口；
- 数据落 **PostgreSQL**（独立数据库服务，`pg` 连接池、全异步 SQL；运行时不再使用 SQLite）；
- 用户可以是普通用户（聊天）或管理员（管用户、管上游 API Key、管模型、管站点设置）；
- 上游模型服务通过"OpenAI 兼容"的 `Base URL + API Key` 接入，**Key 只在服务端加密存储、浏览器永不接触**。

一句话：**一个可私有部署的、带完整账号体系与运营后台的最小 AI 聊天网站。**

## 2. 功能地图

### 2.1 前台（游客 / 普通用户）

| 能力 | 说明 | 状态 |
|---|---|---|
| 站点展示 | 站名、副标题、logo、公告条，全部来自后台设置，保存即生效 | ✅ |
| 注册 | 用户名 3–24 位字母数字下划线，密码 6–64 位，昵称 1–20 字；可被管理员全局关闭 | ✅ |
| 登录 / 登出 | 登录成功重建会话（防会话固定），支持 `?redirect=` 站内回跳 | ✅ |
| 聊天 | SSE 流式输出、停止生成、会话列表/新建/切换/重命名/删除、模型下拉选择、游客点发送跳登录 | ✅ |
| 个人中心 | 改昵称、改密码（校验旧密码，改完保持当前会话） | ✅ |
| 公告 | 公告条可关闭，关闭状态记在 `sessionStorage`（本次会话有效） | ✅ |

### 2.2 后台（管理员）

| 页面 | 能力 | 状态 |
|---|---|---|
| 仪表盘 | 用户/会话/消息/服务四个计数、最近 API 服务、最近使用模型、系统状态（版本、Node、运行时长、库大小） | ✅ |
| API 管理 | API 服务增删改、启停、测试连接、刷新模型（都走真实上游） | ✅ |
| 模型管理 | 筛选、增删改、启停、设默认（全局唯一）、从 API 同步、单模型测试 | ✅ |
| 用户管理 | 搜索/筛选/分页、详情、启停、改角色、重置密码（**不做硬删除**） | ✅ |
| 聊天数据 | 会话列表 + 关键词/用户筛选 + 分页 + 消息抽屉（只读） | ✅ |
| 系统设置 | 站点名/副标题/logo/公告/注册开关/聊天开关，6 个键 | ✅ |

### 2.3 系统级能力

- 会话持久化：`express-session` + 自研 `PgSessionStore`（会话存 PostgreSQL，重启不掉登录，过期在读/写时清理 + 定时清理）；
- 加密：`services/encryption.js`，AES-256-GCM，格式 `v1:iv:tag:cipher`；
- 安全：CSRF 双校验、IP/用户维度限流、上游 SSRF 防护、CSP/HSTS 等安全头；
- 健壮性：异步 ping PostgreSQL 的 `/api/health`、EADDRINUSE 明确报错、SIGINT/SIGTERM 优雅退出、1 MB 请求体上限、统一错误信封。

## 3. 技术栈

| 层 | 选型 | 版本（package.json） | 说明 |
|---|---|---|---|
| 运行时 | Node.js | `>=24`（本机 v24.19.0） | 使用内置 fetch、AbortSignal.timeout |
| Web 框架 | Express | ^5.3.0 | CommonJS；app.js 里手动装配中间件 |
| 数据库 | PostgreSQL + pg | 17 / ^8.23.1 | 独立数据库服务；`pg` 连接池、全异步；better-sqlite3 仅 devDependency 供一次性迁移脚本 |
| 密码 | bcryptjs | ^3.0.3 | cost=10 |
| 会话 | express-session | ^1.19.0 | Cookie `chenlong.sid`，7 天，存 PostgreSQL `sessions` 表 |
| 配置 | dotenv | ^18.0.10 | 读项目根 `.env` |
| 加密 | Node `crypto` | 内置 | AES-256-GCM |
| 前端 | 原生 HTML5/CSS3/ES6+ | — | 无框架、无构建、无 CDN |

**为什么没有 TypeScript / 构建链？** 项目明确走"零构建、双击可开"的路线（根 README 技术栈表已声明）。代价是：无静态类型、无打包（所有 JS 逐个 `<script>` 引入）、无模块化（全局 `CL` 命名空间）。贡献者需接受这一点，别中途引入框架。

## 4. 当前完成度（摘要）

| 阶段 | 内容 | 状态（本知识库核查结论） |
|---|---|---|
| 1 | 目录结构 + 数据库初始化 + 后端骨架 + 前端壳 | ✅ 完成 |
| 2 | 用户系统 + 角色鉴权 + 会话持久化 | ✅ 完成 |
| 3 | API 管理 + Key 加密 + 模型发现 | ✅ 完成 |
| 4 | 聊天 + SSE + 会话持久化 | ✅ 完成 |
| 5 | 后台接真实数据 + 系统设置生效 | ✅ 完成 |
| 6 | 安全加固（限流 / CSRF / SSRF / 安全头 / 会话失效 / 流空闲超时 / 密钥自检） | ✅ **基本完成**（残余：DNS 重绑定窗口、跨进程限流；见 [09](09-status-and-gaps.md)） |
| 7 | 联调、视觉打磨、文档收尾 | 🟡 进行中（测试套件、知识库、前端一致性修复已落地；CI 与视觉打磨待做） |
| 8 | 数据库迁移 PostgreSQL（pg 连接池/异步数据层、pg_dump 备份、compose PG、CI PG service） | ✅ 完成（迁移脚本落地与数据演练待核实） |

> 详细偏差清单、运行验证与下一步建议见 [09 现状与差距](09-status-and-gaps.md)。

## 5. 目录结构（真实）

```text
ChenLong/
├─ server/                        后端（CommonJS，全部 .js）
│  ├─ app.js                      入口：dotenv、密钥解析、中间件装配、路由挂载、错误处理、start()
│  ├─ database/
│  │  ├─ db.js                    PostgreSQL 连接池（pg Pool，全异步），导出 getDb/closeDb/ping/transaction/databaseSizeBytes
│  │  └─ init.js                  建表 7 张 + 索引 + 默认设置（幂等）+ 条件播种管理员（async）
│  ├─ middleware/
│  │  ├─ auth.js                  attachUser（每请求加载用户）+ requireAuth
│  │  ├─ admin.js                 requireAdmin（role === 'admin'）
│  │  ├─ csrf.js                  Session + X-CSRF-Token 双校验（timingSafeEqual）
│  │  └─ security-headers.js      CSP / HSTS / nosniff / Referrer-Policy 等
│  ├─ services/
│  │  ├─ encryption.js            AES-256-GCM 加解密（v1:iv:tag:cipher）
│  │  ├─ dev-secrets.js           开发密钥生成/复用（原子写、损坏即拒绝启动）
│  │  ├─ session-store.js         PgSessionStore（express-session 的 PostgreSQL 存储实现）
│  │  ├─ validation.js            用户名/密码/昵称校验与公共用户对象
│  │  ├─ provider-client.js       上游模型发现（URL 归一化、10s 超时、中文错误映射）
│  │  ├─ upstream-guard.js        上游地址 SSRF 防护（内网/保留段黑名单 + DNS 解析校验）
│  │  ├─ chat-client.js           调上游 /chat/completions 并解析 SSE
│  │  ├─ chat-store.js            会话/消息读写、最近 20 条上下文、自动标题、模型解析
│  │  ├─ settings-store.js        系统设置读写、布尔转换、默认值兜底
│  │  ├─ rate-limit.js            内存滑动窗口限流中间件
│  │  └─ key-mask.js              API Key 掩码（前 3 + … + 后 4）
│  └─ routes/                     auth / profile / users / providers / models / chat / settings / admin
├─ public/                        前端（Express 静态托管）
│  ├─ index.html                  首页（游客/登录双态导航、公告、站点信息）
│  ├─ chat.html                   聊天页
│  ├─ login.html / register.html / user.html
│  ├─ admin/                      后台六页：admin / api / models / users / data / settings
│  ├─ css/                        common.css（设计变量与组件）+ home / chat / admin
│  ├─ js/                         app.js（公共库 CL）、auth.js、guard.js、chat.js、api.js、models.js、
│  │                              admin.js、admin-users.js、admin-data.js、admin-settings.js、admin-dashboard.js
│  └─ assets/                     mascot/logo.png（原创小图）、icons/、images/ 占位
├─ data/                          备份与开发密钥目录（.gitignore 忽略 backups 与 dev-secrets；PG 数据不在这里）
│  ├─ backups/                     pg_dump 输出（*.sql；迁移后新备份）
│  ├─ chenlong.db (+ -wal / -shm)  迁移前的旧 SQLite 文件（历史遗留，仅作迁移源/归档）
│  └─ .dev-secrets.json           开发密钥（明文，仅开发环境使用）
├─ pgdata/                        Docker 部署时 PostgreSQL 数据卷（compose 挂载；不进 Git）
├─ docs/knowledge-base/           本知识库
├─ .env / .env.example            运行配置（.env 被 gitignore）
├─ .gitignore
├─ package.json / package-lock.json
└─ README.md                      项目根 README（部分内容已过时，见 09）
```

## 6. 页面清单

| 路径 | 页面 | 守卫 | 主要脚本 | 说明 |
|---|---|---|---|---|
| `/index.html`、`/` | 首页 | 无 | `app.js` + 页内脚本 | 游客/已登录双态导航；站名/副标题/logo/公告随设置变化 |
| `/chat.html` | 聊天 | 前端在写操作前检查登录（游客可看界面） | `app.js` + `chat.js` | SSE 流式、会话管理、模型选择 |
| `/login.html` `/register.html` | 登录 / 注册 | 无（已登录访问会被引导） | `app.js` + `auth.js` | 支持 `?redirect=`（仅站内相对路径） |
| `/user.html` | 个人中心 | `data-guard="auth"` | `app.js` + `auth.js` | 改昵称、改密码、查看注册时间 |
| `/admin/admin.html` | 仪表盘 | `data-guard="admin"` | `admin.js` + `admin-dashboard.js` | 四个计数 + 最近数据 + 系统状态 |
| `/admin/api.html` | API 管理 | `data-guard="admin"` | `admin.js` + `api.js` | 服务 CRUD、测试、刷新模型 |
| `/admin/models.html` | 模型管理 | `data-guard="admin"` | `admin.js` + `models.js` | 模型 CRUD、启停、设默认、同步 |
| `/admin/users.html` | 用户管理 | `data-guard="admin"` | `admin.js` + `admin-users.js` | 搜索/筛选/分页/编辑/重置密码 |
| `/admin/data.html` | 聊天数据 | `data-guard="admin"` | `admin.js` + `admin-data.js` | 会话列表 + 消息抽屉（只读） |
| `/admin/settings.html` | 系统设置 | `data-guard="admin"` | `admin.js` + `admin-settings.js` | 6 个设置键，保存即生效 |

布局与守卫的细节见 [05 前端架构](05-frontend.md)。

## 7. 快速开始

### 7.1 环境要求

- Node.js **>= 24**（本机 v24.19.0）；
- PostgreSQL 17（或兼容版本）：本地用 `docker compose up -d db`，或连接外部实例；需要可达的 `DATABASE_URL`；
- 备份脚本依赖 `pg_dump`（postgresql-client）；
- Windows/Linux/macOS 均可（本项目在 Windows 上开发）；
- 运行时依赖都是纯 JS（pg/express），不再需要编译 better-sqlite3 的构建链；node_modules 已就位时可跳过 `npm install`。

### 7.2 三步启动

```powershell
cd D:\ICT\ChenLong
Copy-Item .env.example .env      # 填 SESSION_SECRET / ENCRYPTION_KEY / ADMIN_PASSWORD / DATABASE_URL 等
docker compose up -d db          # 本地起 PostgreSQL 17（数据卷 ./pgdata）
npm install                      # node_modules 已存在时可跳过
npm start                        # → http://127.0.0.1:3000
```

- 首次启动自动建表（7 张）并写入默认设置（6 条，`INSERT ... ON CONFLICT DO NOTHING` 幂等）；
- 首次启动会尝试用 `ADMIN_USERNAME / ADMIN_PASSWORD` 播种管理员——**仅当 users 表里没有任何 admin 时执行一次**，之后改 .env 无效；
- 开发环境缺 `SESSION_SECRET / ENCRYPTION_KEY` 时自动生成到 `data/.dev-secrets.json` 并复用；生产环境缺失则**拒绝启动**；
- **启动自检**：启动时对 `ENCRYPTION_KEY` 做 encrypt→decrypt 哨兵验证，不可用即 `[FATAL]` 退出；
- **会话失效**：管理员重置他人密码会踢掉目标用户全部会话；用户自助改密保留当前会话、踢掉其它设备会话。

### 7.3 让"聊天"真正可用（本机当前是空壳）

1. 用管理员登录 → 后台「API 管理」新增一个 API 服务：填名称、Base URL（**要能拼出 {BaseURL}/chat/completions，通常应带 /v1**）、API Key（OpenAI 兼容）；
2. 点「测试连接」确认可达 → 点「刷新模型」把上游模型拉进库（**默认全部禁用**）；
3. 到「模型管理」启用至少一个模型，并「设为默认」；
4. 回前台 `/chat.html` 即可对话。

> 注意：上游地址若是内网/回环地址会被 SSRF 防护拒绝（开发环境可设 `ALLOW_PRIVATE_UPSTREAM=1` 放行，仅限本机调试）。细节见 [07 安全机制](07-security.md)。

### 7.4 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 前台启动服务 |
| `npm run dev` | `node --watch server/app.js`，改后端自动重启 |
| `npm run init-db` | 只跑数据库初始化（建表/补设置/播种管理员），打印表清单 |
| `npm test` / `npm run test:core` | node:test 全量（83 用例）/ 仅单元（65 用例）；**需要可达的 PostgreSQL**（CI 用 service 容器；本地先 `docker compose up -d db`） |
| `npm run backup` | `pg_dump` 一致性备份到 `data/backups/chenlong-*.sql` |
| `node --check server/xxx.js` | 语法检查（本项目仍无 lint 脚本） |

## 8. 数据现状

- 迁移前 SQLite 快照（历史，2026-11-15）：`users`=1（admin）、`sessions`=1、`settings`=6 条默认值，其余业务表全 0；
- 迁移到 PostgreSQL 后：数据来自一次性迁移脚本（`npm run migrate:sqlite-to-pg`）；**本机没有 PostgreSQL，本轮未做 PG 实物核查（待核实）**；确认方式：登录后台看仪表盘计数，或连库 `SELECT COUNT(*) FROM users;` 等。

结论：旧库本身是"刚初始化完"的空壳；迁移后若未搬运历史数据，PG 里也应只有迁移脚本写入的内容。想验证聊天链路必须先按 7.3 配置上游。

## 9. "我想改 X，该去哪"

| 需求 | 入口文件 | 相关文档 |
|---|---|---|
| 加一个 API 接口 | `server/routes/*.js` + `server/app.js` 挂载 | [02](02-architecture.md) [04](04-api.md) |
| 改表结构 | `server/database/init.js`（注意：无 migration，需手写 ALTER/重建） | [03](03-database.md) |
| 改登录/注册规则 | `server/routes/auth.js` + `server/services/validation.js` | [04](04-api.md) [07](07-security.md) |
| 改聊天行为/上下文 | `server/services/chat-store.js`（上下文/标题）、`server/services/chat-client.js`（上游） | [06](06-chat-flow.md) |
| 改前端页面/交互 | `public/` 对应 html + js；公共逻辑在 `public/js/app.js` | [05](05-frontend.md) |
| 加环境变量 | `.env.example` + `server/app.js`（读取与校验） | [08](08-config-and-ops.md) |
| 调安全策略 | `server/middleware/`、`server/services/rate-limit.js`、`upstream-guard.js` | [07](07-security.md) |

## 10. 已知的"第一眼坑"

- 根 README 已在第二批改进中刷新（阶段 6 基本完成、接口/安全/限制同步）；历史差距见 [09](09-status-and-gaps.md)；
- `public/` 页面是"裸 HTML"，直接双击打开时 API 请求会指向 `file://` 而失败，**必须经 Express 访问**；
- 站点名若含空格会被前端拆成"主标题 + 副标题"两截渲染（`paintSiteName` 的既有行为），建议站点名不带空格；
- 管理员重置密码的规则（8–32 位、必须含字母和数字）与注册密码规则（6–64 位）**不一致**，见 [10 约定与术语](10-conventions-and-glossary.md)；
- 项目已初始化 git 并推送 GitHub 公开仓库（`TSS-Small-sunshine/ChenLong`，main），并接入 GitHub Actions CI（push/PR 跑 `npm test`）；改动前建议本地提交或先用 `npm run backup` 备份数据库；
- 聊天的 Base URL 通常要带 `/v1`（聊天路径固定 `{base}/chat/completions`，只有模型发现会回退 `/v1/models`）；
- 数据库已切到 PostgreSQL：备份用 `npm run backup`（`pg_dump`，产物 `.sql`）；不要再依赖 `data/chenlong.db` 或直接复制数据库文件；迁移/备份细节见 [03](03-database.md)。