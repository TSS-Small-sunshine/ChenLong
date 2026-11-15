# 尘龙 ChenLong 知识库

> 整理时间：2026-11-15（第三批 PostgreSQL 迁移后已同步）｜ 依据：本机 `D:\ICT\ChenLong` 的实际代码（v0.1.0，feat/postgres-migration）、迁移前的 SQLite 只读快照与历史运行核查；PG 运行时结论以 CI/维护者环境为准（本机无 PostgreSQL）。
> 与根目录 README.md 冲突时，**以本知识库（即代码现状）为准**；根 README 已在第二/三批改进中刷新。最近一批（PostgreSQL 迁移）清单见 [11-changes.md](11-changes.md) §8，当前状态见 [09-status-and-gaps.md](09-status-and-gaps.md) §8，历史差距审计保留在 09 §1–§7。
> GitHub 公开仓库：<https://github.com/TSS-Small-sunshine/ChenLong>（`main` 分支，首次提交 2026-11-15）。

## 这是什么

本目录把散落在 README、源码、数据库和运行行为里的信息，整理成一套可检索、可核对、可维护的工程知识库。适合：新人接手、后端/前端开发、运维部署、安全审查与代码评审。

## 30 秒看懂

- **尘龙 = AI 助手网站**：原生 HTML/CSS/JS 前端（无框架、无构建、无 CDN）+ Node.js 24 / Express 5 后端 + **PostgreSQL**（`pg` 连接池、全异步 SQL）。单进程应用、独立数据库服务、前后端同源；better-sqlite3 仅 devDependency（一次性迁移旧 SQLite 数据）。
- **三大能力域**：
  1. 用户系统：注册 / 登录 / 会话（存 PostgreSQL `sessions` 表，重启不掉线）/ 个人中心 / 角色与状态管理；
  2. AI 接入管理：API 服务（Key 用 AES-256-GCM 加密入库、接口只回掩码）+ 模型发现与开关 + 全局唯一默认模型；
  3. 流式聊天：SSE 逐字输出、停止生成、会话与消息持久化、最近 20 条上下文。
- **后台六页**：仪表盘 / API 管理 / 模型管理 / 用户管理 / 聊天数据 / 系统设置。
- **安全基线**：bcrypt、PostgreSQL 会话、CSRF 双校验（Session + Header）、内存滑动窗口限流、SSRF 防护（内网/保留段 + DNS 全记录 + 拒绝上游重定向）、CSP 等安全头、`/api` 响应 `no-store`、启动密钥自检、改密/重置密码会话失效均已落地。
- **本机数据现状是空壳**：数据库仅 1 个管理员，0 个 API 服务 / 模型 / 会话；想真正聊天，必须先在后台配置 API 服务并启用模型。
- **工程化现状**：已补 `node:test` 测试套件（83 个用例，`npm test` 全绿）与 `npm run backup` 一致性备份脚本；已初始化 git 并推送到 GitHub 公开仓库（`TSS-Small-sunshine/ChenLong`），接入 CI / CodeQL / 依赖审查 / PR 审查机器人，main 受分支保护、所有改动走 PR（详见 [12](12-pr-workflow-and-bots.md)）；仍缺数据库 migration 框架。

## 文档索引

| # | 文档 | 内容一句话 | 主要读者 |
|---|---|---|---|
| 01 | [项目概览](01-overview.md) | 定位、功能地图、技术栈、目录结构、页面清单、快速开始 | 所有人（先读） |
| 02 | [架构总览](02-architecture.md) | 启动流程、中间件顺序、请求生命周期、分层与依赖、错误处理 | 后端 / 评审 |
| 03 | [数据库设计](03-database.md) | PostgreSQL 7 张表字段、关系/索引、异步数据层、PgSessionStore、初始化、pg_dump 备份、SQLite→PG 迁移 | 后端 / 运维 |
| 04 | [API 参考](04-api.md) | 40 个 HTTP 端点、鉴权/CSRF/限流、参数、响应、错误码总表 | 前端 / 对接方 |
| 05 | [前端架构](05-frontend.md) | 页面与脚本映射、CL 公共库、守卫、聊天页状态机、设计系统 | 前端 |
| 06 | [聊天与 SSE 流程](06-chat-flow.md) | 端到端时序、模型解析、上下文、SSE 帧协议、上游错误映射、断连处理 | 后端 / 排障 |
| 07 | [安全机制](07-security.md) | 认证会话、CSRF、限流、密钥与 API Key、SSRF、安全头、残余风险 | 安全 / 运维 |
| 08 | [配置与运维](08-config-and-ops.md) | DATABASE_URL/PG* 环境变量、密钥解析、PostgreSQL 准备、Docker（app+db）、迁移、pg_dump 备份、排错 | 运维 / 部署 |
| 09 | [现状与差距](09-status-and-gaps.md) | README 偏差审计、运行验证结果、阶段完成度、风险与下一步建议 | 负责人 / 评审 |
| 10 | [约定与术语](10-conventions-and-glossary.md) | 术语表、常量总表、代码/接口约定、已知不一致、扩展检查清单 | 贡献者 |
| 11 | [变更记录](11-changes.md) | 第二批改进清单、验证证据、仍未完成项、复核方法；§8 为第三批 PostgreSQL 迁移记录 | 负责人 / 评审 |
| 12 | [协作与自动审查](12-pr-workflow-and-bots.md) | 分支保护规则、必需检查、PR 机器人矩阵、Fork PR 行为、AI 审查接入与操作手册 | 维护者 / 贡献者 |

## 推荐阅读路径

- **新人首日（约 30 分钟）**：[01 概览](01-overview.md) → [02 架构](02-architecture.md) → [04 API](04-api.md) 的"通用约定"一节 → [05 前端](05-frontend.md) 的"页面清单"一节。
- **改后端逻辑**：[02 架构](02-architecture.md) → [03 数据库](03-database.md) → [06 聊天流程](06-chat-flow.md) → [07 安全](07-security.md)。
- **要上线 / 交付**：[08 配置与运维](08-config-and-ops.md) → [09 现状与差距](09-status-and-gaps.md)。
- **做安全审查**：[07 安全机制](07-security.md) → [09 现状与差距](09-status-and-gaps.md) 的"风险与建议"。
- **查接口**：直接看 [04 API 参考](04-api.md) 的端点总表，按模块索引。

## 速查卡

| 事项 | 值 / 命令 |
|---|---|
| 启动（前台） | `npm start` → `http://127.0.0.1:3000`（端口由 `.env` 的 `PORT` 决定） |
| 开发热重启 | `npm run dev`（`node --watch`） |
| 手动初始化数据库 | `npm run init-db`（幂等：建表 + 补默认设置 + 条件播种管理员） |
| 测试 | `npm test`（node:test，83 用例）／`npm run test:core`（65 用例）；**需要可达的 PostgreSQL**（CI service / 本地 `docker compose up -d db`） |
| 备份数据库 | `npm run backup` → `data/backups/chenlong-YYYYMMDD-HHmmss.sql`（`pg_dump`，需要 postgresql-client） |
| 健康检查 | `GET /api/health` → `{status,uptime,db,version}`，数据库异常 503 |
| 后端入口 | `server/app.js`（业务装配与启动都在这里，`module.exports = app` 便于托管） |
| 数据库 | PostgreSQL（`DATABASE_URL` 优先，或 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`；连接池 `PG_POOL_MAX`）；Docker 数据卷 `./pgdata` |
| 加密密钥 | `ENCRYPTION_KEY`（32 字节 hex/base64）；开发缺省时落 `data/.dev-secrets.json`（明文、已 gitignore） |
| 会话 Cookie | `chenlong.sid`，httpOnly + sameSite=lax，7 天，存 `sessions` 表 |
| 鉴权方式 | 同源 Cookie 会话；非安全方法还要 `X-CSRF-Token`（先 `GET /api/csrf-token`） |
| API 根 | `/api`，错误统一信封 `{"error":{"code","message"}}` |
| 前端静态根 | `public/`（Express 托管，无构建步骤） |

## 本次核查快照（2026-11-15）

| 项目 | 结果 |
|---|---|
| 运行环境 | Node v24.19.0 / npm 11.17.0 / win32 x64 |
| 代码规模 | 源码约 68+ 个文件：server 26 JS + public 11 HTML / 11 JS / 4 CSS + test 15 JS + scripts（backup + 迁移脚本；迁移脚本落地后以实际为准） |
| 数据库 | 迁移后为 PostgreSQL 7 张表（行数取决于一次性迁移，本机无 PG 未实测）；迁移前 SQLite 快照：`users`=1（admin）、`api_providers`=0、`models`=0、`conversations`=0、`messages`=0、`settings`=6、`sessions`=1 |
| 数据文件 | 历史 SQLite：`chenlong.db` 86 KB + `-wal` 231 KB + `-shm` 33 KB（迁移前归档）；PostgreSQL 数据在 `./pgdata`（Docker）或外部实例，备份为 `data/backups/*.sql` |
| 版本控制 | **GitHub 公开仓库** `TSS-Small-sunshine/ChenLong`（main，首次提交 2026-11-15）；本地 `.git` 已初始化 |
| 测试 / CI | ✅ node:test 测试套件（core 65 + features 18 = 83 用例）+ GitHub Actions CI（`.github/workflows/ci.yml`：Node 24 + PostgreSQL 17 service；Docker job 用 compose 起 db+app） |
| 端口 | 核查时 3000 端口空闲（服务未启动）；冒烟测试见 [09](09-status-and-gaps.md) |

## 证据与置信度

- 代码类结论均可在文内 `路径:行号` 处复核；数据库结论：迁移前为 SQLite 只读查询（历史快照），迁移后以 PostgreSQL 代码/文档为准（本机无 PG，运行时结论待 CI/维护者验证）；运行类结论来自历史临时库 + 临时端口冒烟测试（不触碰真实数据）。
- 标注「待核实」的内容表示本次未取得直接证据（例如上游厂商的具体行为差异），工程判断已注明是推断。
- 知识库不记录任何真实密钥、密码或 API Key 明文。

## 维护约定

1. 代码改动后，按"改动类型 → 对应文档"更新：路由/接口 → 04；表结构/数据库 → 03；中间件/启动 → 02；安全策略 → 07；环境变量/部署/迁移/备份 → 08；前端 → 05；本批变更 → 11。
2. 文档内行号会随代码变动漂移，**行号仅用于辅助定位**，语义描述才是主要依据。
3. 每次阶段性交付后，重跑 [09](09-status-and-gaps.md) 的核对清单，避免 README/知识库再次与代码脱节。