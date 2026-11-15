# Docker 部署指南（PostgreSQL）

> 目标：用容器在 Linux 上跑「尘龙 ChenLong」：**Node 应用容器 + PostgreSQL 17 数据库容器**。镜像多阶段构建、非 root 运行、内置健康检查；数据库数据落在宿主机 `./pgdata` 卷，应用备份落在 `./data/backups`。
> 第三批迁移后数据库是 PostgreSQL，不再是 SQLite 单文件。**建议单副本运行**（限流仍是进程内存态）；PostgreSQL 本身支持并发写，但多实例前请先把限流换成共享存储。

## 1. 文件与结构

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 多阶段构建：deps（生产依赖，纯 JS 的 pg/express，无需编译 SQLite）→ runtime（非 root `node` 用户，**内置 postgresql-client-17 供 pg_dump 备份**） |
| `docker-compose.yml` | 两个服务：`app`（Node）+ `db`（`postgres:17`）；环境变量、`./pgdata` 数据卷、`pg_isready` healthcheck、`app` 的 `depends_on: db: condition: service_healthy`、日志轮转、安全选项 |
| `.dockerignore` | 排除 `node_modules`、`data`、`pgdata`、`.git`、`test`、`docs`、`.env*` 等，减小构建上下文 |

镜像内包含：`server/`、`public/`、`scripts/`、`package.json`、`node_modules`（生产依赖）。**不包含** `.env`、`data/`、`pgdata/`、测试与文档。

## 2. 前置条件

- Docker Engine 24+ / Docker Compose v2（Windows 可开发，但生产建议 Linux 主机）；
- 无需在宿主机安装 Node.js 或 PostgreSQL（镜像内自带 Node 24 与 PG 17）；
- 一个可写的数据目录（默认 `./data`，用于备份）与 PG 数据目录（默认 `./pgdata`）。

## 3. 快速开始

```bash
# 1) 准备生产配置（务必使用真实随机值）
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 生成 SESSION_SECRET / ENCRYPTION_KEY
# 编辑 .env：SESSION_SECRET / ENCRYPTION_KEY / ADMIN_USERNAME / ADMIN_PASSWORD /
#          POSTGRES_PASSWORD（必填，compose 未设置会直接报错）/ POSTGRES_USER / POSTGRES_DB
#          （DATABASE_URL 由 compose 注入 app；POSTGRES_PASSWORD 与其中的密码必须一致）

# 2) 备份目录（Linux 宿主机需要让容器内 node 用户 uid=1000 可写）
mkdir -p data data/backups
sudo chown -R 1000:1000 data

# 3) 构建并启动（会先起 db，等 pg_isready 健康后再起 app）
docker compose up -d --build

# 4) 验证
docker compose ps
curl -s http://127.0.0.1:3000/api/health     # 期望 {"status":"ok","db":"connected",...}
docker compose logs -f app
```

浏览器访问：本机 `http://127.0.0.1:3000`；公网访问请先按第 6 节配置反向代理 + HTTPS。

## 4. 环境变量

| 变量 | 说明 |
|---|---|
| `SESSION_SECRET` | **生产必填**，会话签名密钥 |
| `ENCRYPTION_KEY` | **生产必填**，32 字节（64 位 hex 或 base64）；丢失将导致已存 API Key 永久无法解密 |
| `ADMIN_USERNAME / ADMIN_PASSWORD` | 首次启动且库中无 admin 时播种管理员（之后修改无效） |
| `POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB` | compose 的 `db` 服务初始化 PG 时使用；生产必须改强密码 |
| `DATABASE_URL` | app 连接串；compose 内指向 `db:5432`（如 `postgres://chenlong:密码@db:5432/chenlong`）。在 compose 的 `environment` 里拼装，避免宿主机误用 127.0.0.1 |
| `PG_POOL_MAX` | 可选，pg 连接池上限（默认 10） |
| `NODE_ENV` | 镜像默认 `production` |
| `PORT` | 镜像内固定 3000（compose 映射到 `127.0.0.1:3000`） |
| `TRUST_PROXY` | 仅在可信反代后开启（`1`），否则限流按代理 IP 计、HSTS 不生效；直接暴露时**不要**开 |
| `CHAT_STREAM_IDLE_TIMEOUT_MS` | 可选，聊天流空闲超时（默认 60000） |
| `RATE_LIMIT_ENABLED / ALLOW_PRIVATE_UPSTREAM` | 生产环境强制忽略，仅供开发 |

> 容器内**不要**放 `data/.dev-secrets.json`：生产必须显式提供 `SESSION_SECRET` 与 `ENCRYPTION_KEY`，否则启动会直接 `[FATAL]` 退出。
> 旧版 `DB_PATH` 已移除，不要再配。

## 5. 数据、备份与恢复

- PostgreSQL 数据目录 `./pgdata` 挂载到 `db` 容器的 `/var/lib/postgresql/data`；**这个目录就是全部业务数据**，删掉即丢库；
- 应用侧备份目录 `./data/backups` 挂载到 app 容器的 `/app/data/backups`；
- **备份（二选一，推荐方式 A）**：

```bash
# 方式 A（推荐）：app 镜像内置 pg_dump 17，直接跑项目脚本（产物在挂载的 ./data/backups）
docker compose exec -T app node scripts/backup-db.js

# 方式 B：在 db 容器内手工 pg_dump 到宿主机（不依赖 app 镜像）
mkdir -p data/backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain --no-owner --no-privileges' \
  > "data/backups/chenlong-$(date +%Y%m%d-%H%M%S).sql"

# 方式 C：宿主机安装 postgresql-client 后，用项目脚本连 127.0.0.1:5432
DATABASE_URL="postgres://chenlong:密码@127.0.0.1:5432/chenlong" npm run backup
```

- 备份产物是**明文 SQL**（含聊天记录与加密后的 API Key）：必须离线/加密保管，禁止提交 Git（`data/backups/` 已 gitignore）；
- **`ENCRYPTION_KEY` 必须与备份分开离线保存**（否则恢复后已加密的 API Key 无法解密）；
- **恢复**：

```bash
docker compose down                       # 先停应用（db 可保留）
# 恢复到当前库（或先建一个空库演练）
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < data/backups/chenlong-20261115-120000.sql
# 确认 .env 中 ENCRYPTION_KEY 与备份时一致
docker compose up -d
```

- 升级：`git pull` → 先备份 → `docker compose up -d --build` → 验证健康检查；启动时 `await initDatabase()` 会幂等补建表/设置，但**表结构变更仍需手工迁移**（见知识库 03）；
- 从旧 SQLite 迁移：先备份旧 `data/chenlong.db*` 与密钥 → 起 db 服务/建好目标库 → 先 `node scripts/migrate-sqlite-to-pg.js --dry-run` 统计 → 正式执行（支持 `--sqlite/--database-url/--allow-existing`；保留 id+setval，sessions 不迁移）→ 插入冒烟校验 IDENTITY → 归档旧文件。

## 6. 反向代理与 HTTPS（必需）

容器只把 `3000` 绑定到 `127.0.0.1`，公网访问请在前面放 Caddy/Nginx（应用端口不变；数据库 5432 不要暴露公网）：

**Caddy（自动 HTTPS，最简单）**

```caddy
chenlong.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

**Nginx**

```nginx
server {
    listen 443 ssl http2;
    server_name chenlong.example.com;
    # ssl_certificate / ssl_certificate_key ...
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
}
```

反代后需要在 `.env` 设置 `TRUST_PROXY=1` 并重启容器，否则 `req.secure` 为 false：`secure` Cookie 不生效（登录后立刻掉线）、HSTS 不下发、限流按代理 IP 计数。

## 7. 安全说明

- 镜像以非 root 的 `node` 用户运行；compose 设置 `no-new-privileges` 与 `cap_drop: ALL`；
- 不要挂载 `/var/run/docker.sock`，不要给容器 privileged；
- `.env` 权限收紧（`chmod 600 .env`），不入库（已 gitignore + Secret Scanning）；`DATABASE_URL`/PG 密码属敏感配置，不要出现在命令行历史/日志；
- `pgdata` 与 `data/backups` 目录仅运行用户可读；PG 不对公网暴露，容器网络内互通即可（跨主机请用内网 + TLS）；
- 端口默认只绑 `127.0.0.1:3000`；公网只经反代暴露 HTTPS；
- **建议单副本**；不要 `docker compose scale`（限流内存态，多实例额度翻倍）；
- 容器日志按 10MB×3 轮转，避免占满磁盘。

## 8. 排错

| 症状 | 可能原因 | 处理 |
|---|---|---|
| app 反复重启，日志 `[FATAL] 数据库初始化失败` | db 未健康 / `DATABASE_URL` 主机名/密码错 | `docker compose ps` 看 db；`docker compose logs db`；确认 app 的 `DATABASE_URL` 指向 `db:5432` 且密码与 `POSTGRES_PASSWORD` 一致 |
| db 容器起不来 / `pgdata` 权限错误 | 宿主机目录属主不是容器内 postgres uid（通常 999） | `sudo chown -R 999:999 pgdata`（或改 compose 的 user/volume 方案）；不要在运行中删目录 |
| healthcheck unhealthy | 应用启动失败、30 秒内未就绪，或 db 未健康 | 查 `docker compose logs app`；确认 `depends_on` 与 db healthcheck 生效 |
| 缺 `SESSION_SECRET/ENCRYPTION_KEY` | 未填 `.env` | 补全后 `docker compose up -d`；生产不会自动生成密钥 |
| 登录后立刻掉线 | 未配 HTTPS 或未设 `TRUST_PROXY=1` | 上反代 HTTPS，按第 6 节配置 |
| 聊天流式输出中断 | 反代缓冲/超时过短 | `proxy_buffering off`，`proxy_read_timeout` 调大 |
| 备份报 `pg_dump: command not found` | 用了方式 B 但宿主机没装客户端 | 安装 `postgresql-client`，或改用方式 A（`docker compose exec db pg_dump`） |
| 恢复后 API Key 解不开 | `ENCRYPTION_KEY` 与备份时不一致/丢失 | 找回原密钥；否则只能在后台重新录入所有 Key |

## 9. CI 中的容器验证

GitHub Actions 的 `CI` 工作流现在包含：

- `Test (Node 24)` job：启动 `postgres:17` **service 容器**（`pg_isready` healthcheck），注入 `DATABASE_URL` 后跑 `npm test`；
- `Docker image` job（Linux runner，非必需检查）：`docker compose` 起 **db + app** 两个服务 → 等 db 健康 → 检查 `/api/health` 与首页 200 → 输出容器日志。

该 Docker job 每次 PR 都会运行，用于提前发现镜像/启动/PG 连通问题。