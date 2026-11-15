# Docker 部署指南

> 目标：用容器在 Linux 上跑「尘龙 ChenLong」（单进程 Node + SQLite）。镜像多阶段构建、非 root 运行、内置健康检查，数据通过卷持久化。
> 本项目**不适合多副本**：SQLite 单写者 + 限流是进程内存态，请始终只运行 1 个容器。

## 1. 文件与结构

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 多阶段构建：deps（编译 better-sqlite3 备用工具链）→ runtime（仅运行时依赖，非 root） |
| `docker-compose.yml` | 生产编排：环境变量、`./data` 卷、健康检查、日志轮转、安全选项 |
| `.dockerignore` | 排除 `node_modules`、`data`、`.git`、`test`、`docs`、`.env*` 等，减小构建上下文 |

镜像内包含：`server/`、`public/`、`scripts/`、`package.json`、`node_modules`（生产依赖）。**不包含** `.env`、`data/`、测试与文档。

## 2. 前置条件

- Docker Engine 24+ / Docker Desktop（Windows 可开发，但生产建议 Linux 主机）；
- 无需在宿主机安装 Node.js（镜像内自带 Node 24）；
- 一个可写的数据目录（默认 `./data`）。

## 3. 快速开始

```bash
# 1) 准备生产配置（务必使用真实随机值）
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 生成 SESSION_SECRET / ENCRYPTION_KEY
# 编辑 .env：SESSION_SECRET / ENCRYPTION_KEY / ADMIN_USERNAME / ADMIN_PASSWORD

# 2) 数据目录（Linux 宿主机需要让容器内 node 用户 uid=1000 可写）
mkdir -p data
sudo chown -R 1000:1000 data

# 3) 构建并启动
docker compose up -d --build

# 4) 验证
docker compose ps
curl -s http://127.0.0.1:3000/api/health
docker compose logs -f app
```

浏览器访问：本机 `http://127.0.0.1:3000`；公网访问请先按第 6 节配置反向代理 + HTTPS。

## 4. 环境变量

| 变量 | 说明 |
|---|---|
| `SESSION_SECRET` | **生产必填**，会话签名密钥 |
| `ENCRYPTION_KEY` | **生产必填**，32 字节（64 位 hex 或 base64）；丢失将导致已存 API Key 永久无法解密 |
| `ADMIN_USERNAME / ADMIN_PASSWORD` | 首次启动且库中无 admin 时播种管理员（之后修改无效） |
| `NODE_ENV` | 镜像已固定为 `production`（compose 中再次覆盖） |
| `PORT / DB_PATH` | 镜像内固定 `3000` / `/app/data/chenlong.db`；`DB_PATH` 指向卷内路径 |
| `TRUST_PROXY` | 仅在可信反代后开启（`1`），否则限流按代理 IP 计、HSTS 不生效；直接暴露时**不要**开 |
| `CHAT_STREAM_IDLE_TIMEOUT_MS` | 可选，聊天流空闲超时（默认 60000） |
| `RATE_LIMIT_ENABLED / ALLOW_PRIVATE_UPSTREAM` | 生产环境强制忽略，仅供开发 |

> 容器内**不要**放 `data/.dev-secrets.json`：生产必须显式提供 `SESSION_SECRET` 与 `ENCRYPTION_KEY`，否则启动会直接 `[FATAL]` 退出。

## 5. 数据、备份与恢复

- 数据目录 `./data` 挂载到容器 `/app/data`，其中包含 `chenlong.db`（含 `-wal/-shm`）与 `backups/`；
- **备份（推荐容器内执行，落在宿主机 `data/backups/`）**：

```bash
docker compose exec app node scripts/backup-db.js
ls -lh data/backups/
```

- 也可以停服后直接复制 `./data/chenlong.db*`（三件套一起）；
- **`ENCRYPTION_KEY` 必须与备份分开离线保存**（否则恢复后已加密的 API Key 无法解密）；
- 恢复：`docker compose down` → 用备份替换 `data/chenlong.db`（同时删除旧 `-wal/-shm`）→ 确认 `.env` 中 `ENCRYPTION_KEY` 与备份时一致 → `docker compose up -d`；
- 升级：`git pull` → 先备份 → `docker compose up -d --build` → 验证健康检查；表结构变更仍按知识库 03 手工迁移。

## 6. 反向代理与 HTTPS（必需）

容器只把 `3000` 绑定到 `127.0.0.1`，公网访问请在前面放 Caddy/Nginx：

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
- `.env` 权限收紧（`chmod 600 .env`），不入库（已 gitignore + Secret Scanning）；
- 端口默认只绑 `127.0.0.1`；公网只经反代暴露 HTTPS；
- 保持单副本；不要 `docker compose scale`；
- 容器日志按 10MB×3 轮转，避免占满磁盘。

## 8. 排错

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 容器反复重启 | 缺 `SESSION_SECRET/ENCRYPTION_KEY`、密钥格式非法、端口占用 | `docker compose logs app`；补全 `.env`；改宿主机端口映射 |
| healthcheck unhealthy | 应用启动失败或 30 秒内未就绪 | 查日志；确认数据目录可写 |
| `EACCES / permission denied` 写库 | 宿主机 `data` 属主不是 uid 1000 | `sudo chown -R 1000:1000 data` 后重启 |
| 登录后立刻掉线 | 未配 HTTPS 或未设 `TRUST_PROXY=1` | 上反代 HTTPS，按第 6 节配置 |
| 聊天流式输出中断 | 反代缓冲/超时过短 | `proxy_buffering off`，`proxy_read_timeout` 调大 |
| 构建很慢 | better-sqlite3 走本地编译 / 拉取基础镜像慢 | 正常现象；可配置镜像加速或构建缓存 |
| 多副本后写冲突 | 违反单副本约束 | 只跑一个容器 |

## 9. CI 中的容器验证

GitHub Actions 的 `CI` 工作流包含 `Docker image` job（Linux runner）：构建镜像 → 以生产模式启动容器 → 检查 `/api/health` 与首页 200 → 输出容器日志。该 job 目前是**非必需检查**（不阻塞合并），但每次 PR 都会运行，用于提前发现镜像/启动问题。
