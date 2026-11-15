# 08 配置与运维

> 本章回答：**有哪些配置、密钥怎么解析、怎么启动/部署/备份/排错。**
> 涉及文件：`.env.example`、`server/app.js`、`server/services/dev-secrets.js`、`server/database/db.js`、`server/services/rate-limit.js`、`server/services/upstream-guard.js`。

## 1. 环境变量总表

| 变量 | 必需性 | 默认值 | 作用 | 读取位置 |
|---|---|---|---|---|
| `PORT` | 可选 | 3000 | HTTP 监听端口 | app.js:18 |
| `NODE_ENV` | 可选 | `development` | 运行环境；决定安全 Cookie / 强制限流 / 错误细节 / 缺密钥行为 | app.js:19 |
| `SESSION_SECRET` | **生产必需** | 开发自动生成 | 会话 Cookie 签名密钥 | app.js:123–135 |
| `ENCRYPTION_KEY` | **生产必需** | 开发自动生成 | AES-256-GCM 主密钥（32 字节，64 位 hex 或 base64） | encryption.js |
| `ADMIN_USERNAME` | 首次启动可选 | 无 | 播种初始管理员用户名（仅当无 admin 时） | init.js:100–123 |
| `ADMIN_PASSWORD` | 首次启动可选 | 无 | 播种初始管理员密码（不打印日志） | 同上 |
| `DB_PATH` | 可选 | `./data/chenlong.db` | SQLite 文件路径（相对项目根） | db.js:8–13 |
| `TRUST_PROXY` | 可选 | 关闭 | 为 1/true/yes/on 时 `app.set('trust proxy', 1)`，让 `req.ip`/`req.secure` 采信一层反代 | app.js:115 |
| `RATE_LIMIT_ENABLED` | 可选 | 开启 | 仅开发环境可用 0/false 关闭限流；生产强制开启 | rate-limit.js:5–9 |
| `ALLOW_PRIVATE_UPSTREAM` | 可选 | 关闭 | 仅开发环境可放行内网/回环上游地址（SSRF 校验白名单开关） | upstream-guard.js:44–48 |
| `CHAT_STREAM_IDLE_TIMEOUT_MS` | 可选 | 60000 | 聊天流空闲超时（毫秒）：上游建连后多久无数据即中断 | chat-client.js:11–18 |

> **文档状态**：`TRUST_PROXY`、`RATE_LIMIT_ENABLED`、`ALLOW_PRIVATE_UPSTREAM`、`CHAT_STREAM_IDLE_TIMEOUT_MS` 已补进 `.env.example`（默认注释掉）；生产部署时按需取消注释并确认语义。

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
- 文件损坏时的正确处置：手工修复；确认不再需要其中密钥后可删除再启动（**删除后既有会话与已加密 API Key 都会失效**）。

## 3. 启动、初始化与验证

### 3.1 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | `node server/app.js`，前台运行 |
| `npm run dev` | `node --watch server/app.js`，改后端自动重启 |
| `npm run init-db` | 只执行建表/补设置/播种管理员，打印表清单，然后退出 |

### 3.2 启动时发生了什么

1. 读 `.env` → 解析/补齐密钥（见 §2）；
2. 建 Express 应用、装配中间件、挂 8 组路由；
3. `initDatabase()`：建表（幂等）→ 补 6 条默认设置（幂等）→ 条件播种管理员；
4. `listen(PORT)`，打印 `尘龙 ChenLong v0.1.0 已启动：http://127.0.0.1:<port> (development)`；
5. 端口被占用 → 打印 `[FATAL] 端口 <port> 已被占用` 并 exit(1)。

### 3.3 启动后验证清单

```powershell
# 1) 健康检查
Invoke-RestMethod http://127.0.0.1:3000/api/health
# 2) 设置可读
Invoke-RestMethod http://127.0.0.1:3000/api/settings
# 3) CSRF 可用
Invoke-RestMethod http://127.0.0.1:3000/api/csrf-token
# 4) 未登录访问受限接口应为 401
try { Invoke-RestMethod http://127.0.0.1:3000/api/auth/me } catch { $_.Exception.Response.StatusCode.value__ }
```

运行核查结果与真实响应样例见 [09 现状与差距](09-status-and-gaps.md)。

## 4. 开发环境 vs 生产环境

| 行为 | development | production |
|---|---|---|
| 缺 `SESSION_SECRET/ENCRYPTION_KEY` | 生成/复用 `data/.dev-secrets.json`，打印 WARN 横幅 | **拒绝启动**（exit 1） |
| Cookie `secure` | false | true（要求 HTTPS，否则登录态不生效） |
| 限流 | 可用 `RATE_LIMIT_ENABLED=0` 关 | **强制开启** |
| 500 错误消息 | 返回 `err.message` | 固定"服务器内部错误" |
| HSTS | 仅 `req.secure` 时发送（本机 http 不发） | 同上，需反代传递 `X-Forwarded-Proto` + `TRUST_PROXY=1` |
| 上游内网地址 | 可用 `ALLOW_PRIVATE_UPSTREAM=1` 放行 | 一律拒绝（开关被忽略） |
| 错误堆栈日志 | 打印 | 打印（但响应不含） |

## 5. 部署建议

### 5.1 拓扑

```text
Internet ──▶ Nginx/Caddy (TLS, 反代) ──▶ node server/app.js (127.0.0.1:3000) ──▶ data/chenlong.db
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

### 5.2 进程守护

- Linux：systemd unit（`ExecStart=/usr/bin/node server/app.js`，`Restart=always`，`WorkingDirectory` 指向项目根，`EnvironmentFile=.env`）；
- Windows：NSSM / WinSw 注册为服务；
- 注意：`server.close()` 会等待活动连接（含 SSE）结束，最长 5 秒后强退——重启时正在聊天的用户会被断开。

### 5.3 升级流程

`npm install`（或 `npm ci`）→ 备份数据库（`npm run backup`）→ 改表则 `npm run init-db` → `npm test` 通过 → 重启进程 → 验证 §3.3。  
**没有 migration 框架**：跨版本改表必须手工迁移，升级前先在备份库上演练。

## 6. 数据、备份与测试（要点，详见 03）

- **推荐备份方式**：`npm run backup`（`scripts/backup-db.js`），基于 SQLite Online Backup API，WAL 中未 checkpoint 的数据也会进入备份，默认输出 `data/backups/chenlong-YYYYMMDD-HHmmss.db` 并做 `quick_check`；
- 也可停服复制三件套（`.db/-wal/-shm`）或使用 `VACUUM INTO`；只复制主库会丢最新写入；
- **`ENCRYPTION_KEY` 必须与数据库一起备份**，否则 api_providers 里的 Key 永久解不开；
- 恢复：停服 → 用备份替换 `data/chenlong.db`（删除旧 `-wal/-shm`）→ 确认密钥一致 → 启动；
- 清库重置：停服删 `data/chenlong.db*` → 启动自动重建（管理员需 .env 里仍有 ADMIN 配置）；
- 测试：`npm test`（83 用例，使用临时库与随机端口，不碰真实库）；服务启动前建议先跑测试。

## 7. 排错手册

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 启动即退出，日志 `[FATAL] 生产环境缺少必需环境变量` | production 下没配 `SESSION_SECRET/ENCRYPTION_KEY` | 补齐环境变量；不要依赖 .dev-secrets.json |
| `[FATAL] 端口 3000 已被占用` | 已有进程占用 | `Get-NetTCPConnection -LocalPort 3000` 找 PID 结束，或改 `PORT` |
| 启动即退出，日志 `[FATAL] ENCRYPTION_KEY 不可用` | 密钥不是合法 32 字节（64 位 hex 或 base64），或密钥被更换 | 用正确密钥重新启动；更换密钥前先确认旧 Key 可弃（否则已存 API Key 永久解不开） |
| 上游测试/聊天报"上游地址发生了重定向" | 上游返回 3xx，出于 SSRF 防护被拒绝 | 在后台把 Base URL 改成最终地址（通常形如 `https://host/v1`） |
| 聊天中途报"上游长时间没有返回数据，已中断" | 上游超过 60 秒无数据（或 `CHAT_STREAM_IDLE_TIMEOUT_MS` 配得过小） | 检查上游可用性；必要时调大该环境变量 |
| `data/.dev-secrets.json 不是合法的 JSON / 字段无效` | 文件被改坏 | 修复 JSON 与 64 位 hex 字段；或（确认旧 Key 可弃）删除后重启 |
| 生产环境登录后立刻"掉线" | HTTP 下 Cookie `secure` 不生效，或反代没传 X-Forwarded-Proto | 上 HTTPS + `TRUST_PROXY=1` |
| 改 `SESSION_SECRET` 后全员掉线 | 会话签名密钥变了 | 预期行为；需要保留登录就固定密钥 |
| 写请求全部 403 `CSRF_INVALID` | 没带 `X-CSRF-Token` / token 过期（session 重建） | 重新 `GET /api/csrf-token`；前端 `fetchJSON` 已自动处理一次 |
| 接口返回 429 `RATE_LIMITED` | 触发限流 | 看 `Retry-After`；开发可 `RATE_LIMIT_ENABLED=0`；生产别关 |
| 保存 API 服务返回 400 `UPSTREAM_BLOCKED` | Base URL 是内网/回环 | 用公网地址；本机调试可 `ALLOW_PRIVATE_UPSTREAM=1`（仅 dev） |
| 测试连接 ok:false "密钥无效或无权限" | 上游 401/403 | 重存 Key；确认上游账户可用 |
| 测试连接 ok:false "接口地址不存在" | Base URL 路径不对 | 模型发现会试 `/models` 与 `/v1/models`；聊天固定 `{base}/chat/completions`，通常 Base URL 要带 `/v1` |
| 聊天报"还没有可用模型" | 没启用任何模型/没设默认 | 后台模型管理启用并设默认 |
| 聊天发出后短暂转圈后报"上游长时间没有返回数据，已中断" | 上游连上后 60 秒内无数据 | 检查上游可用性；可用 `CHAT_STREAM_IDLE_TIMEOUT_MS` 调整阈值 |
| 后台配置的外链 Logo 不显示 | 地址不是 http(s) 绝对地址或图片加载失败，前端回退默认图 | 用 `https://` 开头的完整地址或站内路径（如 `/assets/mascot/logo.png`）；查看浏览器网络面板 |
| 静态页面 404 | 请求路径/大小写；`public/` 位置 | 用 Express 访问，不要双击文件 |
| `Cannot find module better-sqlite3` / ABI 错误 | Node 版本与预编译包不匹配（要求 >=24） | 切回 Node 24 后重装依赖 |
| 数据库 `SQLITE_BUSY` | 并发写锁超 5 秒 | 检查是否有长事务/外部进程占用库文件 |

## 8. 配置变更的影响

| 变更 | 影响 |
|---|---|
| 改 `ENCRYPTION_KEY` | 已存 API Key 全部解不开（无轮换机制）；必须先在后台重存所有 Key |
| 改 `SESSION_SECRET` | 所有用户会话失效（需重新登录） |
| 改 `ADMIN_USERNAME/ADMIN_PASSWORD` | 已存在 admin 时**无影响**（只在无 admin 时播种） |
| 改 `DB_PATH` | 指向新的空库；旧数据仍在旧文件里（注意别误删） |
| 改 `PORT` | 反代/防火墙同步改 |
| 关 `ALLOW_PRIVATE_UPSTREAM` | 已保存的内网上游调用会报 `UPSTREAM_ERROR`（地址被拒），需改回公网地址 |
| 升级 Node 大版本 | better-sqlite3 需重装/重编译；升级前备份 |

## 9. 本次核查到的配置事实（2026-11-15）

- 项目根 **`.env` 存在**，7 个键（PORT/NODE_ENV/SESSION_SECRET/ENCRYPTION_KEY/ADMIN_USERNAME/ADMIN_PASSWORD/DB_PATH）均已填写（文档不记录具体值）；
- **`data/.dev-secrets.json` 也存在**（177 B）：由于 .env 已提供两个密钥，该文件当前**不会被使用**，属历史遗留；别把它当唯一密钥来源，也别误删后以为没事（若哪天 .env 丢失而依赖它，删了就无法恢复）；
- 项目根**已初始化 `.git`** 并推送到 GitHub 公开仓库（`TSS-Small-sunshine/ChenLong`）；首次提交前已用 `git check-ignore` 验证 `.env`、`data/*.db*`、`data/.dev-secrets.json`、`data/backups/` 均被忽略（远端 contents 查询同样 404）；
- 服务默认监听 0.0.0.0:3000，核查时端口空闲；
- 第二批改进后：`.env.example` 已补充 `TRUST_PROXY` / `RATE_LIMIT_ENABLED` / `ALLOW_PRIVATE_UPSTREAM` / `CHAT_STREAM_IDLE_TIMEOUT_MS` 四个可选开关；新增 `npm test` / `npm run test:core` / `npm run backup` 脚本与 `test/`、`scripts/backup-db.js`；`.gitignore` 已忽略 `data/backups/`。
