# 08 配置与运维（PostgreSQL）

> 本章回答：**有哪些配置、密钥怎么解析、PostgreSQL 怎么连、怎么启动/部署/备份/迁移/排错。**
> 涉及文件：`.env.example`、`server/app.js`、`server/database/db.js`、`server/database/init.js`、`server/services/dev-secrets.js`、`server/services/session-store.js`、`scripts/backup-db.js`、`docker-compose.yml`。
> 第三批迁移后运行时**不再依赖 SQLite**：数据库是独立的 PostgreSQL 服务；原来的 `DB_PATH` / `data/chenlong.db` / WAL 全部移除。

## 1. 环境变量总表

| 变量 | 必需性 | 默认值 | 作用 | 读取位置 |
|---|---|---|---|---|
| `PORT` | 可选 | 3000 | HTTP 监听端口 | app.js:19 |
| `NODE_ENV` | 可选 | `development` | 运行环境；决定安全 Cookie / 强制限流 / 错误细节 / 缺密钥行为 | app.js:20 |
| `SESSION_SECRET` | **生产必需** | 开发自动生成 | 会话 Cookie 签名密钥 | app.js:74,140 |
| `ENCRYPTION_KEY` | **生产必需** | 开发自动生成 | AES-256-GCM 主密钥（32 字节，64 位 hex 或 base64） | encryption.js |
| `ADMIN_USERNAME` | 首次启动可选 | 无 | 播种初始管理员用户名（仅当无 admin 时） | init.js:104–133 |
| `ADMIN_PASSWORD` | 首次启动可选 | 无 | 播种初始管理员密码（不打印日志） | 同上 |
| `DATABASE_URL` | **必需（二选一）** | 无 | PostgreSQL 连接串，如 `postgres://user:pass@127.0.0.1:5432/chenlong` | db.js:10–12 |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | 备用（`DATABASE_URL` 为空时） | 127.0.0.1 / 5432 / postgres / 空 / chenlong | 标准 PG 变量 | db.js:13–20 |
| `PG_POOL_MAX` | 可选 | 10 | pg 连接池上限 | db.js:11 |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Docker 部署必需 | 见 `.env.example` | 仅 `docker compose` 初始化 PostgreSQL 容器使用；生产必须改成强密码 | docker-compose.yml（db 服务） |
| `TRUST_PROXY` | 可选 | 关闭 | 为 1/true/yes/on 时 `app.set('trust proxy', 1)`，让 `req.ip`/`req.secure` 采信一层反代 | app.js:130 |
| `RATE_LIMIT_ENABLED` | 可选 | 开启 | 仅开发环境可用 0/false 关闭限流；生产强制开启 | rate-limit.js:4–9 |
| `ALLOW_PRIVATE_UPSTREAM` | 可选 | 关闭 | 仅开发环境可放行内网/回环上游地址（SSRF 校验白名单开关） | upstream-guard.js:42–47 |
| `CHAT_STREAM_IDLE_TIMEOUT_MS` | 可选 | 60000 | 聊天流空闲超时（毫秒）：上游建连后多久无数据即中断 | chat-client.js:11–18 |

> **已移除**：`DB_PATH`。迁移前指向 SQLite 文件的配置项不再被任何代码读取；如果 `.env` 里还留着它，请删除以免误以为仍生效。
> **`.env.example` 已同步**：`DATABASE_URL` / PG 变量 / `PG_POOL_MAX` / `POSTGRES_*` 都已写入样例文件，敏感值留空或写占位符。

## 2. 密钥解析优先级

```text
真实环境变量 / .env      ← 最高优先（dotenv 不覆盖已存在的环境变量）
        │ 缺失
        ▼
data/.dev-secrets.json   ← 仅开发环境；只补缺失项，复用已有值
        │ 缺失
        ▼
自动生成并写入该文件      ← 仅开发环境；原子排他写（0600、fsync、硬链接）
        │
        ▼
生产环境若仍缺失 → [FATAL] + exit(1)
```

细节（`dev-secrets.js`）：

- 文件内容两键：`sessionSecret` / `encryptionKey`（各 64 位 hex）；文件损坏/字段非法 → **不覆盖**，直接报错退出（避免让已加密 Key 永久解不开）；
- 并发启动：先写临时文件 fsync，再硬链接到目标（原子排他），另一个进程会读到完整文件；
- 文件损坏时的正确处置：手工修复；确认不再需要其中密钥后可删除再启动（**删除后既有会话与已加密 API Key 都会失效**）；
- 启动后还有 `verifyKey()` 哨兵自检（encrypt→decrypt 固定串），失败 `[FATAL]` exit(1)（app.js:112–124）。

## 3. PostgreSQL 准备（本地开发与生产）

### 3.1 本地开发（推荐 Docker）

```bash
# 仓库根目录：只起 pg 服务（compose 中 db 服务，镜像 postgres:17，数据卷 ./pgdata）
docker compose up -d db

# 等待健康（compose healthcheck 用 pg_isready；也可手动查）
docker compose ps
docker compose logs -f db

# .env 中配置连接串（密码与 POSTGRES_PASSWORD 一致）
# DATABASE_URL=postgres://chenlong:change_me_in_env@127.0.0.1:5432/chenlong
npm start
```

- compose 中 `app` 服务的 `DATABASE_URL` 指向 `db:5432`（容器网络内主机名 `db`），并 `depends_on: db: condition: service_healthy`；
- 数据库数据落在宿主机 `./pgdata`（不要随手删除；删除 = 数据全丢）；
- compose 把 db 端口映射到 `127.0.0.1:5432`（仅本机回环，便于宿主机 `psql`/一次性迁移脚本连接）；生产可删除该映射，让 PG 只在 compose 网络内可见；
- **compose 强制要求 `POSTGRES_PASSWORD`**（未设置时 `docker compose` 直接报错，避免用默认弱口令初始化数据库）；`POSTGRES_USER/DB` 也有默认值。

### 3.2 外部/生产 PostgreSQL

- 使用托管 PG 或独立实例；给应用单独数据库与最小权限账号（建表权限仅初始化阶段需要，长期可收回 DDL 权限）；
- 连接串建议启用 TLS：`DATABASE_URL=postgres://user:pass@host:5432/chenlong?sslmode=require`；
- PG 端口不要暴露公网；应用与 DB 走私网/容器网络；
- 连接数：多实例部署时 `实例数 × PG_POOL_MAX` 不能超过 PG `max_connections`（默认常为 100）。

### 3.3 初始化数据库

`initDatabase()` **不会自动建 database**（PostgreSQL 语义）：先由 compose 的 `POSTGRES_DB` 或 `createdb` 建库，随后：

- 首次启动应用会自动建表/补设置/播种管理员；
- 也可手动 `npm run init-db`（同 `npm run db:init`）；幂等，可重复执行。

## 4. 启动、初始化与验证

### 4.1 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | `node server/app.js`，前台运行（启动时 `await initDatabase()`） |
| `npm run dev` | `node --watch server/app.js`，改后端自动重启 |
| `npm run init-db` / `npm run db:init` | 只执行建表/补设置/播种管理员，打印表清单后退出 |
| `npm run migrate:sqlite-to-pg` | **一次性**把旧 SQLite 数据搬到 PostgreSQL（见 §7） |
| `npm run backup` | `pg_dump` 一致性备份到 `data/backups/*.sql` |
| `npm test` | node:test 全量；**需要可达的 PostgreSQL**（CI 用 service 容器，本地用 compose db） |

### 4.2 启动时发生了什么

1. 读 `.env` → 解析/补齐密钥（见 §2）→ `verifyKey()` 自检；
2. 建 Express 应用、装配中间件、挂 8 组路由；
3. `await initDatabase()`：连 PG 建表（幂等）→ 补 6 条默认设置（`ON CONFLICT DO NOTHING`）→ 条件播种管理员；**PG 连不上则 `[FATAL]` 数据库初始化失败并 exit(1)**；
4. `listen(PORT)`，打印 `尘龙 ChenLong v0.1.0 已启动：http://127.0.0.1:<port> (development)`；
5. 端口被占用 → `[FATAL] 端口 <port> 已被占用` 并 exit(1)；退出时 `await closeDb()` 关闭连接池。

### 4.3 启动后验证清单

```powershell
# 1) 健康检查（内部会 await ping() 查一次 PG）
Invoke-RestMethod http://127.0.0.1:3000/api/health
# 2) 设置可读（来自 PG settings 表）
Invoke-RestMethod http://127.0.0.1:3000/api/settings
# 3) CSRF 可用（会在 sessions 表建匿名会话）
Invoke-RestMethod http://127.0.0.1:3000/api/csrf-token
# 4) 未登录访问受限接口应为 401
try { Invoke-RestMethod http://127.0.0.1:3000/api/auth/me } catch { $_.Exception.Response.StatusCode.value__ }
```

运行核查结果与真实响应样例见 [09 现状与差距](09-status-and-gaps.md)（其中数据库部分为迁移前 SQLite 快照，见 §8）。

## 5. 开发环境 vs 生产环境

| 行为 | development | production |
|---|---|---|
| 缺 `SESSION_SECRET/ENCRYPTION_KEY` | 生成/复用 `data/.dev-secrets.json`，打印 WARN 横幅 | **拒绝启动**（exit 1） |
| Cookie `secure` | false | true（要求 HTTPS，否则登录态不生效） |
| 限流 | 可用 `RATE_LIMIT_ENABLED=0` 关 | **强制开启** |
| 500 错误消息 | 返回 `err.message` | 固定"服务器内部错误" |
| HSTS | 仅 `req.secure` 时发送（本机 http 不发） | 同上，需反代传递 `X-Forwarded-Proto` + `TRUST_PROXY=1` |
| 上游内网地址 | 可用 `ALLOW_PRIVATE_UPSTREAM=1` 放行 | 一律拒绝（开关被忽略） |
| 错误堆栈日志 | 打印 | 打印（但响应不含） |
| 数据库 | 本地 PG（compose db） | 独立/托管 PG，TLS 连接，账号最小权限 |

## 6. 部署建议

### 6.1 拓扑

```text
Internet ──▶ Nginx/Caddy (TLS, 反代) ──▶ node server/app.js (127.0.0.1:3000) ──▶ PostgreSQL (127.0.0.1:5432 / db:5432)
```

- 应用 `app.listen(PORT)` **监听所有网卡**（没有 HOST 配置项）→ 生产建议用防火墙限制，或反代同机访问；
- 反代关键配置（Nginx 示例）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;   # 大于最长流式生成时间
    proxy_buffering off;       # SSE 必须关闭缓冲
}
```

  Node 侧记得 `TRUST_PROXY=1`、`NODE_ENV=production`，否则 Cookie `secure` 与限流 IP 都会出错。

### 6.2 进程守护

- Linux：systemd unit（`ExecStart=/usr/bin/node server/app.js`，`Restart=always`，`WorkingDirectory` 指向项目根，`EnvironmentFile=.env`）；
- Windows：NSSM / WinSw 注册为服务；
- 注意：`server.close()` 会等待活动连接（含 SSE）结束，最长 5 秒后强退——重启时正在聊天的用户会被断开；退出时会 `await closeDb()` 释放 PG 连接。

### 6.3 Docker 部署（推荐）

- 仓库自带 `Dockerfile` + `docker-compose.yml`：多阶段构建、非 root（`node` 用户）、内置 healthcheck、日志轮转；**运行镜像内置 `postgresql-client-17`（pg_dump）**，可直接在 app 容器内执行备份；
- compose 现在是**两个服务**：`app` + `db`（`postgres:17`，数据卷 `./pgdata`，`pg_isready` healthcheck，`app` 通过 `depends_on` 等 db 健康后再启动，`DATABASE_URL` 指向 `db:5432`）；
- 快速：`cp .env.example .env` 填生产密钥与 `POSTGRES_PASSWORD` → `docker compose up -d --build` → `curl 127.0.0.1:3000/api/health`；
- 容器默认只把 3000 绑到 `127.0.0.1`，由反代提供 HTTPS；反代后需 `TRUST_PROXY=1`，否则 secure Cookie/HSTS/限流 IP 都会有问题；
- **仍建议单实例**：限流是进程内存态（数据库本身支持并发写，不再是单写者约束）；多实例前先把限流换成共享存储；
- CI 的 `Docker image` job 会用 compose 起 `db+app` 做健康检查冒烟，并执行一次 `npm run backup` 验证容器内 `pg_dump` 可用；
- 完整命令、备份/恢复、升级与排错见仓库根 [docs/DEPLOY-DOCKER.md](../DEPLOY-DOCKER.md)。

### 6.4 升级流程

`npm ci` → 备份数据库（`npm run backup`，产物是 `.sql`）→ 如涉及表结构变更，按 [03](03-database.md) 手工 `ALTER` 并先在备份库演练 → `npm test`（需 PG）通过 → 重启进程（启动时 `await initDatabase()` 幂等补建）→ 验证 §4.3。
**仍没有 migration 框架**：跨版本表结构变更必须手工迁移，升级前先在备份库上演练。

## 7. 从 SQLite 迁移到 PostgreSQL（一次性）

迁移分支的完整步骤与注意事项见 [03 数据库设计 §9](03-database.md)。运维视角的要点：

1. **先备份再迁移**：旧 `data/chenlong.db` + `-wal/-shm` 与 `ENCRYPTION_KEY` 一起归档；迁移不能替代备份；
2. 准备 PG（compose db 或外部实例）并配置 `DATABASE_URL`；
3. 先 dry-run：`node scripts/migrate-sqlite-to-pg.js --dry-run`（`--sqlite` 指定旧库、`--database-url` 指定目标库；默认读 `DB_PATH`/`data/chenlong.db` 与 `DATABASE_URL`）；确认每表行数后再正式执行；目标库 `users` 非空时脚本默认拒绝（需 `--allow-existing`）；
4. 脚本会保留原始 id 并用 `setval` 对齐 IDENTITY 序列；迁移后仍建议做**插入冒烟**（注册/建会话）确认主键正常；
5. `sessions` 不迁移（用户需重新登录）；从 `.env` 删除 `DB_PATH`、补 `DATABASE_URL`；启动并逐项验证（登录、后台、聊天）；
6. 确认稳定运行后再归档/删除旧 SQLite 文件（删除前确认备份可用）。

## 8. 数据、备份与测试（要点，详见 03）

- **备份**：`npm run backup`（`scripts/backup-db.js`）→ 默认 `data/backups/chenlong-YYYYMMDD-HHmmss.sql`；基于 `pg_dump --format=plain --no-owner --no-privileges`，并校验输出文件头；
- **依赖 `pg_dump`**：宿主机装 `postgresql-client`，或在容器内执行；`PG_DUMP` 可指定可执行文件；
- 备份是**明文 SQL**（含聊天记录/密文 Key）：离线或加密存储，禁止提交 Git（`data/backups/` 已 gitignore）；
- **`ENCRYPTION_KEY` 必须与数据库一起备份且分开保管**，否则 `api_providers` 里的 Key 永久解不开；
- 恢复：停服 → 用 `psql "$DATABASE_URL" -f <备份>.sql` 恢复到空库 → 确认密钥一致 → 启动；
- 清库重置：停应用 → 重建 database/schema → 启动自动建表（管理员需 .env 里仍有 `ADMIN_*`）；
- 测试：`npm test` 需要**可达的 PostgreSQL**（CI 的 test job 用 `postgres:17` service 容器提供）；本机没有 PG 时测试不可用，可 `docker compose up -d db` 后跑；测试应使用独立库/临时 schema，**不要连生产库**。

## 9. 排错手册

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 启动即退出，日志 `[FATAL] 生产环境缺少必需环境变量` | production 下没配 `SESSION_SECRET/ENCRYPTION_KEY` | 补齐环境变量；不要依赖 .dev-secrets.json |
| 启动即退出，日志 `[FATAL] 数据库初始化失败：connect ECONNREFUSED` | PG 未启动 / `DATABASE_URL` 主机端口错 / 容器网络不通 | `docker compose ps` 看 db 是否 healthy；检查 `DATABASE_URL`、PG 端口与防火墙 |
| 日志 `password authentication failed` / `role ... does not exist` | 连接串账号/密码/库名不对，或 `POSTGRES_*` 与 `DATABASE_URL` 不一致 | 对齐 compose 的 `POSTGRES_USER/PASSWORD/DB` 与连接串；重建 pgdata 前先想清楚数据 |
| 日志 `database "chenlong" does not exist` | PG 实例存在但目标库没建 | compose 用 `POSTGRES_DB` 自动建；外部 PG 用 `createdb` |
| 日志 `relation "users" does not exist` | 跳过初始化/连到了别的库 | 确认启动日志无"数据库初始化失败"；手动 `npm run init-db`；核对 `current_database()` |
| `[FATAL] 端口 3000 已被占用` | 已有进程占用 | `Get-NetTCPConnection -LocalPort 3000` 找 PID 结束，或改 `PORT` |
| `[FATAL] ENCRYPTION_KEY 不可用` | 密钥不是合法 32 字节（64 位 hex 或 base64），或密钥被更换 | 用正确密钥重新启动；更换密钥前先确认旧 Key 可弃（否则已存 API Key 永久解不开） |
| 上游测试/聊天报"上游地址发生了重定向" | 上游返回 3xx，出于 SSRF 防护被拒绝 | 在后台把 Base URL 改成最终地址（通常形如 `https://host/v1`） |
| 聊天中途报"上游长时间没有返回数据，已中断" | 上游超过 60 秒无数据（或 `CHAT_STREAM_IDLE_TIMEOUT_MS` 配得过小） | 检查上游可用性；必要时调大该环境变量 |
| `data/.dev-secrets.json 不是合法的 JSON / 字段无效` | 文件被改坏 | 修复 JSON 与 64 位 hex 字段；或（确认旧 Key 可弃）删除后重启 |
| 生产环境登录后立刻"掉线" | HTTP 下 Cookie `secure` 不生效，或反代没传 X-Forwarded-Proto | 上 HTTPS + `TRUST_PROXY=1` |
| 改 `SESSION_SECRET` 后全员掉线 | 会话签名密钥变了（sessions 表里的旧 cookie 签名失效） | 预期行为；需要保留登录就固定密钥 |
| 写请求全部 403 `CSRF_INVALID` | 没带 `X-CSRF-Token` / token 过期（session 重建） | 重新 `GET /api/csrf-token`；前端 `fetchJSON` 已自动处理一次 |
| 接口返回 429 `RATE_LIMITED` | 触发限流 | 看 `Retry-After`；开发可 `RATE_LIMIT_ENABLED=0`；生产别关 |
| 保存 API 服务返回 400 `UPSTREAM_BLOCKED` | Base URL 是内网/回环 | 用公网地址；本机调试可 `ALLOW_PRIVATE_UPSTREAM=1`（仅 dev） |
| `npm run backup` 报"无法执行 pg_dump" | 宿主机没装 PostgreSQL 客户端 | 安装 `postgresql-client`，或 `PG_DUMP` 指向可用路径；或在含 pg_dump 的容器内执行 |
| 备份/恢复后 API Key 全部解不开 | `ENCRYPTION_KEY` 与备份时不一致或丢失 | 找回原密钥；否则只能在后台重新录入所有上游 Key |
| 注册报 500（日志含 duplicate key value violates unique constraint） | 迁移后 IDENTITY 序列未与数据对齐 | 迁移脚本应 `setval`；手工修复：`SELECT setval(pg_get_serial_sequence('users','id'), max(id)) FROM users;`（各表同理） |
| 静态页面 404 | 请求路径/大小写；`public/` 位置 | 用 Express 访问，不要双击文件 |

## 10. 配置变更的影响

| 变更 | 影响 |
|---|---|
| 改 `ENCRYPTION_KEY` | 已存 API Key 全部解不开（无轮换机制）；必须先在后台重存所有 Key |
| 改 `SESSION_SECRET` | 所有用户会话签名失效（需重新登录；sessions 表里的行可清理） |
| 改 `ADMIN_USERNAME/ADMIN_PASSWORD` | 已存在 admin 时**无影响**（只在无 admin 时播种） |
| 改 `DATABASE_URL` | 指向另一个 PG 库；旧数据仍在旧库（注意别误删） |
| 改 `PG_POOL_MAX` | 连接池上限变化；多实例时注意 PG `max_connections` |
| 改 `PORT` | 反代/防火墙同步改 |
| 关 `ALLOW_PRIVATE_UPSTREAM` | 已保存的内网上游调用会报 `UPSTREAM_ERROR`（地址被拒），需改回公网地址 |
| 升级 Node 大版本 | 不再需要编译 better-sqlite3（运行时依赖是纯 JS 的 pg/express）；仍建议升级前备份并跑测试 |

## 11. 本次核查到的配置事实（2026-11-15）

- 第三批迁移分支的代码事实：`package.json` 运行时依赖为 `pg@^8.23.1`，`better-sqlite3` 仅在 `devDependencies`（供迁移脚本）；`.env.example` 已含 `DATABASE_URL` / `PG*` / `POSTGRES_*`，**不再有 `DB_PATH`**；
- `npm run backup` 已改为 `pg_dump`（产物 `.sql`），`npm run migrate:sqlite-to-pg` 为一次性迁移入口；
- 旧 `data/chenlong.db` 与 `data/backups/` 目录是迁移前/历史产物；迁移后新备份是 `.sql`，不要混放；
- 本机**没有 PostgreSQL**（本轮文档更新未能做 PG 实物启动核查，相关运行结论以 CI/维护者验证为准——待核实）；
- 项目已初始化 git 并推送 GitHub 公开仓库；`.env`、PG 数据目录（`pgdata/`）、`data/backups/` 均不应提交（`.gitignore` 与 PR Guard 已覆盖 .env/备份目录/数据库文件）。
