> 变更记录整理于 2026-11-15，依据：本机 `D:\ICT\ChenLong` 第二批改动后的代码（逐文件阅读并标注行号）、`npm test` 实测（83 通过）、`npm run backup` 实测、临时库 + 3100 端口冒烟与无效密钥启动测试。与 [09-status-and-gaps.md](09-status-and-gaps.md) 第一轮审计对应；两者冲突时以本记录与 09 §7 为准。

# 11 变更记录（第二批：2026-11-15）

> 本章回答：**第二批改了什么？改在哪些文件？怎么验证的？还剩什么没做？以后如何复核？**
> 范围：后端安全补全（密钥自检、重定向拒绝、SSE 空闲超时、会话失效、no-store）+ 前端一致性/文案 + 测试与备份工程化 + 根 README 刷新。**不含**业务功能新增（未改数据库结构、未加业务接口）。

## 0. 本批概览

| 类别 | 关键改动 | 证据 |
|---|---|---|
| 后端安全 | `ENCRYPTION_KEY` 启动自检；上游 `fetch` 拒绝重定向；SSE 流空闲超时（默认 60 s）；改密/重置密码按用户失效会话；`/api` 统一 `Cache-Control: no-store` | 09 §7.2；代码行号见下文 |
| 前端一致性 | logo 外链修复；后台 6 页退出按钮；公告条 hoist 补齐 2 页；重命名长度 60→40；user.html logo；首页/用户中心过时文案与 © 年份 | public/* 行号见 2 节 |
| 工程化 | `test/` 15 文件 / 83 用例（node:test）；`npm test`/`test:core`；`scripts/backup-db.js`（WAL 安全备份）；`.gitignore` 加 `data/backups/` | 实测：83 pass / 0 fail；备份 quick_check=ok |
| 文档 | 根 README 216→259 行刷新；09 增加 §7「第二批改进与状态更新」；新增本文件 11-changes.md | `README.md:1-259`、09 §7 |
| 未做 | DB migration、DNS 重绑定、跨进程限流、dbSize 口径、会话模型沿用、忘记密码等（`.git` 与 CI 已于 2026-11-15 补齐） | 见第 5 节 |

---

## 1. 后端改动清单

### 1.1 启动与加密

| 文件 | 改动 | 行为 |
|---|---|---|
| `server/services/encryption.js:75-89` | 新增 `verifyKey()`：对固定哨兵串 `chenlong-encryption-key-self-check` 执行 `encrypt()` → `decrypt()`，结果不一致即抛错；导出 `verifyKey` | 把「密钥可用性」从首次使用提前到启动时验证 |
| `server/app.js:16,112-124` | 新增 `assertEncryptionKey()` 并在 `ensureSecrets()` 之后调用：成功打印 `[key] ENCRYPTION_KEY 自检通过`；失败打印两行 `[FATAL]` 并 `process.exit(1)` | 无效密钥时服务**拒绝启动**，不再出现「服务正常、首次保存 API Key 才 500」 |

### 1.2 上游调用（SSRF 重定向 + 流空闲超时）

| 文件 | 改动 | 行为 |
|---|---|---|
| `server/services/provider-client.js:6,9-14,61-75` | 新增 `REDIRECT_MESSAGE` 与 `isRedirectError()`；`fetch` 增加 `redirect:'error'`，catch 分支识别重定向 | 模型发现请求遇到 3xx 直接失败，返回 `{ok:false,message:"上游地址发生了重定向，出于安全考虑已拒绝，请直接填写最终地址"}` |
| `server/services/chat-client.js:9,20-25,138-155` | 同上：`redirect:'error'` + 重定向错误识别 | 聊天上游 3xx 不再跟随，回 `UPSTREAM_ERROR` + 中文文案 |
| `server/services/chat-client.js:11-18` | 新增 `DEFAULT_IDLE_TIMEOUT_MS = 60000` 与 `resolveIdleTimeoutMs()`，支持环境变量 `CHAT_STREAM_IDLE_TIMEOUT_MS` 覆盖 | 空闲超时可配置，便于测试与调优 |
| `server/services/chat-client.js:173-189,210-251` | 建连成功后启动空闲计时器，每次读到数据重置；超时 `controller.abort()`，返回 `UPSTREAM_ERROR` +「上游长时间没有返回数据，已中断（N 秒无数据）」，`content` 保留 | 上游挂起不再无限等待；已收到内容仍可落库 |
| `server/services/chat-client.js:270` | 导出增加 `DEFAULT_IDLE_TIMEOUT_MS` | 供测试/文档引用 |

### 1.3 会话与密码

| 文件 | 改动 | 行为 |
|---|---|---|
| `server/services/session-store.js:100-129` | 新增 `_destroyMatching(predicate, keepSid)`、`destroyByUserId(userId)`、`destroyOthersByUserId(userId, keepSid)`；遍历 `sessions` 表按 `sess.userId` 匹配删除，返回删除条数；会话 JSON 损坏则跳过 | 支持按用户批量失效会话，不再依赖遍历全表的外部脚本 |
| `server/routes/users.js:218-228` | 管理员重置密码成功后调用会话失效：重置**他人** → `destroyByUserId` 踢全部；重置**自己** → `destroyOthersByUserId` 保留当前 | 旧凭据立即失效；响应仍为 204（日志记录失效条数） |
| `server/routes/profile.js:55-68` | 本人改密成功后调用 `destroyOthersByUserId(id, req.sessionID)`，响应从 `{ok:true}` 变为 `{ok:true, revokedSessions:N}` | 改密后其它设备下线、当前会话保留 |

### 1.4 应用层 HTTP 与配置

| 文件 | 改动 | 行为 |
|---|---|---|
| `server/app.js:155-159` | 在 `express.static` 之后新增 `app.use('/api', ...)` 中间件，统一设置 `Cache-Control: no-store` | `/api` 响应不被浏览器/代理缓存；静态资源不受影响 |
| `.env.example:27-39` | 以注释形式补齐 `TRUST_PROXY`（含 XFF 伪造风险说明）、`RATE_LIMIT_ENABLED`、`ALLOW_PRIVATE_UPSTREAM`、`CHAT_STREAM_IDLE_TIMEOUT_MS` | 环境变量与代码读取点一致（`app.js:130`、`rate-limit.js:4-9`、`upstream-guard.js:42-47`、`chat-client.js:15-18`） |

> 未改动：数据库表结构（仍是 7 张表）、路由挂载顺序/鉴权模型、限流实现（仍为进程内存态）、SSRF 的 DNS 解析校验逻辑（仅新增重定向拒绝）。

---

## 2. 前端改动清单

| 文件 | 改动 | 行为/备注 |
|---|---|---|
| `public/js/app.js:437-446` | `settingLogo()` 重写：放行站内路径（`/` 开头且非 `//`）与 `http(s)://` 绝对地址，拒绝其它 scheme 与协议相对地址 | 后台可配置外部 logo，但不会引入 `javascript:` 等危险 scheme |
| `public/js/app.js:478-482,485-498` | 新增 `logoSrc()`：http(s) 原样使用，站内路径直接使用，其它才走 `CL.url`；`paintSiteLogo` 改用 `logoSrc` | 避免外链被 `CL.url` 二次拼接成错误地址 |
| `public/js/chat.js:663` | 会话重命名输入框 `maxlength: '60'` → `'40'` | 与后端 `TITLE_MAX=40` 对齐（原先前端允许 60 会触发 400） |
| `public/admin/admin.html:39`、`api.html:39`、`models.html:39`、`users.html:39`、`data.html:39`、`settings.html:39` | 6 个后台页侧栏 `.admin-nav__foot` 增加 `data-logout`「退出登录」按钮 | 复用 `public/js/auth.js:410-424` 的全局 `[data-logout]` 绑定 |
| `public/css/admin.css:47-48` | `.admin-nav__foot` 布局 + `.admin-nav__foot .cl-btn{width:100%;justify-content:center}` | 退出按钮与侧栏同宽 |
| `public/js/api.js:90-111`、`public/js/models.js:89-110` | 补 `hoistAnnouncement()` / `watchAnnouncement()` 并在 `initPage` 调用 | 与 users/data/settings 页一致，公告条搬到内容区顶部 |
| `public/user.html:21,197` | 顶栏与页脚两处 `.cl-logo__mark` 增加 `<img class="cl-logo__img" data-site-logo hidden>` | 个人中心页头也能显示后台上传的 logo |
| `public/index.html:113-131,240,268-269` | 能力卡 01–03 改 `cl-tag--ok`「已接入」、04 改 `cl-tag--off`「暂未支持」；Hero/页脚文案更新；`© 2025`→`© 2026` | 与当前功能一致（多模态未支持） |
| `public/user.html:222-223` | 页脚「© 2025」→「© 2026」，补充「账号系统已接入 · AI 对话已上线」 | 文案对齐首页 |

> 未改动：聊天页交互逻辑（除 maxlength）、登录/注册流程、后台表格/表单结构；「记住我」「忘记密码」仍是 UI/占位（见第 5 节）。

---

## 3. 工程化改动

### 3.1 测试套件（node:test）

新增 `test/` 共 **15 个文件**：

| 目录 | 文件 | 覆盖点 |
|---|---|---|
| helpers | `test/helpers/temp-db.js` | 临时库安装（`os.tmpdir()`）、测试固定密钥、清理工具 |
| core（9） | `validation.test.js`、`csrf.test.js`、`encryption.test.js`、`rate-limit.test.js`、`chat-client.test.js`、`upstream-guard.test.js`、`chat-store.test.js`、`session-store.test.js`、`backup-script.test.js` | 校验/CSRF/加解密/限流/SSE 解析/SSRF/模型解析/会话存储/备份脚本单元 |
| features（5） | `encryption-verify-key.test.js`、`chat-stream.test.js`、`provider-redirect.test.js`、`session-revoke.test.js`、`app-http.test.js` | 密钥自检、SSE 空闲超时与重定向、按用户失效会话、应用层 HTTP（no-store/注册/双会话改密/管理员重置） |

`package.json:11-12` 新增 `test`（全部）与 `test:core`（仅单元）脚本；测试全部使用 `os.tmpdir()` 临时数据库与随机端口，**不写真实库**（`test/helpers/temp-db.js:26-39`）。

### 3.2 一致性备份脚本

| 项 | 内容 |
|---|---|
| 文件 | `scripts/backup-db.js`（268 行，`#!/usr/bin/env node`） |
| 命令 | `npm run backup`（`package.json:13`）或 `node scripts/backup-db.js [--out <目录>] [--db <文件>] [--force] [--help]` |
| 原理 | better-sqlite3 `db.backup()`（SQLite Online Backup API）；源库以 `readonly:true` 打开（`backup-db.js:139-141`），WAL 中未 checkpoint 数据一并进入备份 |
| 产物 | 默认 `data/backups/chenlong-YYYYMMDD-HHmmss.db`；备份后 `journal_mode=DELETE` 收敛为单文件 |
| 校验 | 备份后 `PRAGMA quick_check` 两次（可读写打开 + 只读独立打开），非 `ok` 删除并报错（`backup-db.js:160-198`） |
| 安全 | 目标已存在默认拒绝，`--force` 覆盖；`data/backups/` 已加入 `.gitignore:7` |
| 退出码 | 0 成功 / 1 运行失败 / 2 参数错误 |

### 3.3 文档与其他

- `.gitignore:7` 新增 `data/backups/`。
- `README.md` 刷新为 259 行：阶段 6「基本完成」、快速开始补 `npm test`/`npm run backup`、API 表补 `/api/csrf-token`/会话失效/空闲超时/no-store、安全约定扩充到 11–16、新增「测试与备份」章节、已知限制重写、路线图更新、知识库链接。
- `docs/knowledge-base/09-status-and-gaps.md`：§0 增加更新提示、§4.2/§5 增加「已修复」提示、新增 §7 本章对应的完整状态更新。
- 未改动数据库结构、未新增依赖（`node:test` 为 Node 内置）。

---

## 4. 验证证据（2026-11-15 本机实测）

### 4.1 `npm test`

```text
$ npm test
ℹ tests 83
ℹ suites 0
ℹ pass 83
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5491.8479
NPM_TEST_EXIT=0
```

### 4.2 `npm run backup`（用临时输出目录验证，未污染 `data/backups/`）

```text
$ node scripts/backup-db.js --out %TEMP%\chenlong-kb-backup-verify
[backup] 源数据库：D:\ICT\ChenLong\data\chenlong.db（84.0 KB）
[backup] 备份文件：...chenlong-20261115-161738.db（84.0 KB）
[backup] 一致性校验：PRAGMA quick_check = ok
[backup] 完成。恢复时请先停止服务，再用备份文件替换 chenlong.db（并删除同目录 -wal/-shm）。
BACKUP_EXIT=0
BACKUP_FILES=1（chenlong-20261115-161738.db 86016B）
REAL_DB_UNCHANGED=True
```

### 4.3 无效 `ENCRYPTION_KEY` 启动

```text
$ $env:ENCRYPTION_KEY='bad-key'; node server/app.js
[FATAL] ENCRYPTION_KEY 不可用：ENCRYPTION_KEY 无效：需要 32 字节密钥（64 位 hex 或 base64 编码的 32 字节）...
[FATAL] 服务已终止启动。请配置正确的 32 字节密钥；更换密钥会导致已保存的上游 API Key 永久无法解密。
EXIT=1
TEMP_DB_AFTER_BAD_START=0   # 未创建数据库
```

### 4.4 临时库 + 3100 端口冒烟

```text
启动日志：
  [key] ENCRYPTION_KEY 自检通过
  已创建初始管理员 admin，请登录后立即修改密码
  [db] 已写入默认设置 6 条
  尘龙 ChenLong v0.1.0 已启动：http://127.0.0.1:3100 (development)

GET /api/health        → 200  cache-control=no-store  body={"status":"ok","uptime":0.76,"db":"connected","version":"0.1.0"}
GET /api/settings      → 200  cache-control=no-store
GET /api/csrf-token    → 200  cache-control=no-store  token_len=64
GET /                 → 200  cache-control=public, max-age=0  content-type=text/html
GET /api/auth/me      → 401（未登录信封）
POST /api/auth/logout → 403（无 CSRF；验收 CSRF 仍生效）
清理：temp_db_left=0，port3100=0，node_processes=1（环境自带、与本项目无关）
```

> 说明：本批冒烟只做只读 GET + 一个无 token 的 403 写请求，**未做登录/注册/聊天**，不触碰真实业务数据。

### 4.5 真实数据无污染

- 冒烟前后 `data/chenlong.db` mtime 均为 `2026-11-15T12:19:47.8019174+08:00`，未变化。
- 备份脚本只读打开源库，同样未改 mtime；临时备份目录与临时库文件均已删除。
- `npm test` 全部使用 `os.tmpdir()` 临时库。

### 4.6 lead 独立验证（转述）

lead 另行执行：`npm test` 83 pass / 0 fail；临时库 + 3100 端口端到端 14 项通过（no-store、静态非 no-store、登录、注册、双会话、本人改密踢其它、管理员重置踢全部、新密码登录）；无效 ENCRYPTION_KEY 启动 exit(1) 且输出 `[FATAL]`；真实 `data/chenlong.db` 前后大小一致；端口 3000/3100 均无监听。

---

## 5. 仍未完成项与建议下一步

| # | 事项 | 现状/证据 | 建议 |
|---|---|---|---|
| 1 | SSRF DNS 重绑定窗口 | `upstream-guard.js:135-171` 校验与真实连接之间可被重绑定；重定向面已关闭 | 连接层固定 IP（undici dispatcher）或连接后二次校验 |
| 2 | 限流单进程内存态 | `rate-limit.js:21-30`；多实例额度 ×N、重启清零 | 明确单进程部署，或改 SQLite/Redis 共享计数 |
| 3 | ~~无 CI~~（已解决 2026-11-15） | 新增 `.github/workflows/ci.yml`：push / PR 时在 Node 24 上 `npm ci && npm test`；远端仓库已就绪（main、公开） | 后续可加 lint 与多平台矩阵（Windows） |
| 4 | 无 DB migration 框架 | `database/init.js` 仅 `CREATE TABLE IF NOT EXISTS` | `PRAGMA user_version` + 迁移脚本 |
| 5 | `dbSizeBytes` 不含 WAL/SHM | `routes/admin.js:64-70`；第一轮实测主库 86,016 B vs 三件套 349,536 B | 合计三件套或 `page_count*page_size` + WAL |
| 6 | 会话模型不沿用 | `chat-store.js:77-94` 未传 `modelId` 只取默认；`touchConversation` 覆盖 `model_id` | 优先读会话最近模型再回落默认；前端切换会话时回填下拉框 |
| 7 | 忘记密码 / 记住我 | 登录页「忘记密码？」是 `data-pending` 占位（`public/login.html:42`）；「记住我」仅 UI | 一次性 token + 邮件，或明确「管理员重置」引导 |
| 8 | 密码策略两套 | 注册/改密 6–64 位无复杂度；管理员重置 8–32 位 + 字母数字（`users.js:16-17,206-213`） | 统一策略并同步 04/07 文档 |
| 9 | `public/js/admin.js` 死代码 | 6 个后台页仍加载（如 `public/admin/admin.html:183`） | 删除引用与文件，或复用 |
| 10 | user.html「历史对话」静态空态 | `public/user.html:153`；未接会话 API | 接 `GET /api/chat/conversations` 或移除 |
| 11 | 多模态能力卡「暂未支持」 | `public/index.html:131` | 产品规划项，维持标签 |
| 12 | 审计日志 / 数据保留 | 仅 console 日志；无保留/归档策略 | 结构化安全日志 + 清理归档脚本 |
| 13 | README 两处残留措辞 | `README.md:39`（生产 dev-secrets 措辞）、`:140`（未列 `POST /api/models/:id/test`） | 直接改 README |

---

## 6. 如何复核

### 6.1 一键命令

```powershell
cd D:\ICT\ChenLong
npm test                 # 期望：pass 83 / fail 0
npm run test:core        # 期望：只跑 core 单元（65 用例）
npm run backup           # 期望：输出 PRAGMA quick_check = ok，产物在 data/backups/
node scripts/backup-db.js --help   # 查看 --out/--db/--force 参数
```

### 6.2 临时库 + 临时端口冒烟（不碰真实数据）

```powershell
$env:DB_PATH="data/.kb-verify.db"; $env:PORT="3100"; $env:NODE_ENV="development"
node server/app.js                     # 另开窗口或后台运行
# 断言 1：启动日志含 [key] ENCRYPTION_KEY 自检通过
# 断言 2：GET /api/health → 200，Cache-Control: no-store
# 断言 3：GET / → 200，Cache-Control: public, max-age=0
# 断言 4：GET /api/csrf-token → 200 token_len=64，no-store
# 断言 5：GET /api/auth/me → 401；POST /api/auth/logout（无 CSRF）→ 403
$env:ENCRYPTION_KEY="bad-key"; node server/app.js   # 断言 6：[FATAL] + 退出码 1
# 清理：Stop-Process 掉 node；删除 data/.kb-verify.db*；确认 3100 无监听
```

### 6.3 复核注意事项

- **不要**用真实库跑写操作（登录/注册/聊天/改设置）；写路径请用临时库。
- 测试固定密钥在 `test/helpers/temp-db.js:9-11`，不读取真实 `.env` 密钥。
- 备份脚本只读打开源库；恢复时必须停服并删除旧 `-wal/-shm`，且 `ENCRYPTION_KEY` 必须与备份时一致。
- 若 `npm test` 在 Windows 上偶发文件占用，测试 helper 已带删除重试（`test/helpers/temp-db.js:17-19`）。
- 行号会随代码漂移；语义/符号名是主要依据。

---

## 7. 相关文档

- 状态与风险总表：[09-status-and-gaps.md](09-status-and-gaps.md)（第一轮审计 + §7 第二批更新）
- 安全机制细节：[07-security.md](07-security.md)；配置与备份：[08-config-and-ops.md](08-config-and-ops.md)
- 接口契约：[04-api.md](04-api.md)；聊天/SSE：[06-chat-flow.md](06-chat-flow.md)
