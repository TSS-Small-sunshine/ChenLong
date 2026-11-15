# 03 数据库设计

> 本章回答：**数据存在哪、7 张表长什么样、关系与索引是什么、怎么初始化、怎么备份、有哪些坑。**
> 所有结构以 `server/database/init.js` 为准（SQLite 无 migration，会随代码演进）。

## 1. 文件、连接与运行参数

| 项目 | 值 / 行为 | 出处 |
|---|---|---|
| 默认文件 | `<项目根>/data/chenlong.db` | db.js:5 |
| 自定义路径 | 环境变量 `DB_PATH`，相对路径按**项目根**解析 | db.js:8–13 |
| 打开方式 | better-sqlite3 单例（惰性），进程内共享 | db.js:15–27 |
| 日志模式 | `journal_mode = WAL` | db.js:21 |
| 外键 | `foreign_keys = ON` | db.js:22 |
| 锁等待 | `busy_timeout = 5000`（5 秒） | db.js:23 |
| 关闭 | `closeDb()`（仅优雅退出时调用） | db.js:29–35 |
| 磁盘文件 | `chenlong.db` + `-wal` + `-shm`（WAL 模式必然伴随） | — |

**本机实际大小（2026-11-15）**：主库 86,016 B；`-wal` 230,752 B；`-shm` 32,768 B。WAL 偏大不代表数据多，通常是尚未 checkpoint（空闲/关闭时会自动回收）。

> **没有 migration 框架**：`init.js` 只有 `CREATE TABLE IF NOT EXISTS`。改表结构 = 手写迁移（新增列用 `ALTER TABLE ADD COLUMN`；删列可用 `ALTER TABLE ... DROP COLUMN`，本机 SQLite 3.54.1 支持；但改列类型/改约束仍需建新表 → 搬数据 → 换名）。别指望重启自动升级 schema。

## 2. 表清单与字段

### 2.1 `users` —— 账号（init.js:6–15）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 用户 ID |
| username | TEXT | NOT NULL UNIQUE | 登录名，3–24 位字母数字下划线 |
| password_hash | TEXT | NOT NULL | bcrypt（cost 10，`"$2b$10$..."` 60 字符） |
| nickname | TEXT | NULL | 显示名，1–20 字 |
| avatar | TEXT | NULL | 头像（当前前端未使用，预留） |
| role | TEXT | NOT NULL DEFAULT `'user'` | `user` / `admin` |
| status | TEXT | NOT NULL DEFAULT `'active'` | `active` / `disabled` |
| created_at | TEXT | NOT NULL | ISO 时间字符串 |

> 无 `updated_at`、无最后登录时间、无软删除字段。

### 2.2 `api_providers` —— 上游 API 服务（init.js:17–27）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK | — |
| name | TEXT | NOT NULL | 服务名，≤50 字 |
| base_url | TEXT | NOT NULL | 上游根地址（去尾斜杠），已验证协议且非内网 |
| api_key_encrypted | TEXT | NOT NULL | AES-256-GCM 密文 `v1:iv:tag:cipher` |
| api_type | TEXT | NOT NULL DEFAULT `'openai-compatible'` | 预留多协议，目前无分支逻辑 |
| enabled | INTEGER | NOT NULL DEFAULT 1 | 0/1 |
| description | TEXT | NULL | ≤200 字 |
| created_at / updated_at | TEXT | NOT NULL | ISO |

### 2.3 `models` —— 模型（init.js:29–40）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK | 内部 ID（聊天请求用这个） |
| provider_id | INTEGER | NOT NULL, FK → api_providers(id) ON DELETE CASCADE | 所属服务 |
| model_id | TEXT | NOT NULL | 上游模型名（如 `gpt-4o-mini`） |
| display_name | TEXT | NULL | 展示名（空则回落 model_id） |
| enabled | INTEGER | NOT NULL DEFAULT 1 | 0/1；刷新模型默认入库为 **0** |
| is_default | INTEGER | NOT NULL DEFAULT 0 | 全局唯一默认（应用层保证，无 DB 唯一约束） |
| last_tested_at | TEXT | NULL | 最近测试时间 |
| status | TEXT | NOT NULL DEFAULT `'discovered'` | `discovered` / `available` / `unavailable` |
| created_at | TEXT | NOT NULL | — |
| —— | UNIQUE(provider_id, model_id) | — | 同一服务下模型名幂等 |

### 2.4 `conversations` —— 会话（init.js:42–49）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK | — |
| user_id | INTEGER | NOT NULL, FK → users(id) ON DELETE CASCADE | 归属者 |
| title | TEXT | NULL | 自动取首条消息前 20 码位；可重命名 1–40 字 |
| model_id | INTEGER | FK → models(id) ON DELETE SET NULL | **仅记录**最近使用的模型，不参与解析 |
| created_at / updated_at | TEXT | NOT NULL | 列表按 updated_at 倒序 |

### 2.5 `messages` —— 消息（init.js:51–57）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK | 自增即时间序 |
| conversation_id | INTEGER | NOT NULL, FK → conversations(id) ON DELETE CASCADE | 删会话级联删消息 |
| role | TEXT | NOT NULL | `user` / `assistant`（system 提示不落库） |
| content | TEXT | NOT NULL | 消息正文（用户侧接口限 4000 字；DB 无长度约束） |
| created_at | TEXT | NOT NULL | ISO |

### 2.6 `settings` —— 系统设置（init.js:59–64）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK | — |
| setting_key | TEXT | NOT NULL UNIQUE | 见下方 6 个键 |
| setting_value | TEXT | NULL | 布尔存 `'1'`/`'0'` |
| updated_at | TEXT | NOT NULL | — |

默认 6 个键（init.js:79–86）：`site_name`、`site_subtitle`、`allow_register`、`allow_chat`、`announcement`、`logo`。

### 2.7 `sessions` —— 登录会话（init.js:66–70）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| sid | TEXT | PK | express-session 的会话 ID（Cookie 值） |
| sess | TEXT | NOT NULL | 序列化的 session JSON（含 `userId`、`csrfToken`、cookie 等） |
| expire | INTEGER | NOT NULL | 过期时间（毫秒时间戳） |

> 该表在 `init.js` 与 `services/session-store.js:8–16` 中各有一份 `CREATE IF NOT EXISTS`，**幂等冗余**，谁先建都行。

## 3. 表关系

```text
users (1) ──< conversations (1) ──< messages
                  │
                  └── model_id ──> models (N) ──> api_providers (1)

settings       独立键值表（无外键）
sessions       独立表（express-session 专用，无外键）
api_providers ──< models
```

级联行为：

| 操作 | 连带效果 |
|---|---|
| 删除用户（当前没有接口，仅脚本层可能） | 其 `conversations` 级联删除 → 其 `messages` 级联删除（会话本身不删 session 行） |
| 删除 API 服务 | 其 `models` 级联删除；引用这些模型的 `conversations.model_id` 置 NULL |
| 删除模型 | 引用它的 `conversations.model_id` 置 NULL（会话与消息保留） |
| 删除会话 | 其 `messages` 级联删除 |

## 4. 索引

| 索引 | 表.列 | 服务的查询 |
|---|---|---|
| `idx_messages_conversation_id` | messages.conversation_id | 会话消息列表、计数子查询、级联删除 |
| `idx_conversations_user_id` | conversations.user_id | 我的会话列表、后台按用户筛 |
| `idx_models_provider_id` | models.provider_id | 按服务筛模型、刷新模型计数 |
| `idx_api_providers_enabled` | api_providers.enabled | 预留（当前列表查询未按 enabled 过滤） |
| `idx_sessions_expire` | sessions.expire | 过期清理 DELETE |

**索引缺口（数据量大后的优化点）**：

- `conversations` 列表按 `updated_at DESC, id DESC` 排序，无对应索引；
- `users` 后台按 `status`/`role` 筛选无索引（uid 主键排序有隐式索引，问题不大）；
- `messages` 按 `created_at` 无索引（实际按 id 排序，够用）。

## 5. 初始化与播种

`init.js` 的 `initDatabase()`（init.js:125–131）三件事：

1. `db.exec(SCHEMA_SQL)`：建 7 表 + 5 索引（全部 `IF NOT EXISTS`，幂等）；
2. `seedSettings()`：6 条默认设置 `INSERT OR IGNORE`（只补缺失键，不覆盖已改值）；
3. `seedAdmin()`：**仅当 users 里没有任何 admin** 时，用 `ADMIN_USERNAME/ADMIN_PASSWORD` 创建一次管理员（bcrypt 10）；两者缺一则跳过并打印 WARN；创建后日志提示"请登录后立即修改密码"（**不打印密码**）。

触发时机：

- 服务启动 `start()` 内自动执行（app.js:205）；
- 或手动 `npm run init-db`：执行后打印"数据库初始化完成：7 张表 [...]，新增设置项 N 条"。

> 修改 .env 里的 `ADMIN_USERNAME/ADMIN_PASSWORD` 之后重启**不会**改已有管理员密码——这是设计而非 bug（防止误覆盖）。要改密码请用后台或 `/api/user/password`。

## 6. 设置表读写模型

- 映射常量 `FIELDS`（settings-store.js:5–12）：接口 camelCase ↔ `setting_key` snake_case，并声明布尔字段；
- 读取：每次直接查库（SQLite 很快），缺键回落默认值（默认来自 init.js 的 `SETTINGS_DEFAULTS`，且有本地 fallback），不会 500；
- 写入：只处理请求体里出现的键，未知键忽略；校验规则：siteName 1–40、siteSubtitle ≤60、announcement ≤200、logo ≤200 且必须以 `/` 或 `http(s)://` 开头、两个布尔键必须是 boolean（字符串会被拒）；批量 upsert 在一个事务里完成；
- 生效方式：保存即生效，无需重启——前台每次加载调 `GET /api/settings`。

## 7. 会话表与 SqliteSessionStore

| 行为 | 实现 |
|---|---|
| 存储 | `sessions(sid, sess, expire)`，sess 为 JSON 字符串 |
| TTL | 7 天（`DEFAULT_TTL_MS`，session-store.js:5）；以 Cookie 的 expires 为准，否则 now+TTL |
| 写入 | `INSERT ... ON CONFLICT(sid) DO UPDATE` |
| 过期 | 读取时发现 `expire <= Date.now()` 立即删除并返回空；另有每 15 分钟一次的 `cleanup()`（`unref` 定时器） |
| 全量操作 | 实现 `all/clear/length`（express-session 接口完整性），生产路径基本不用 |
| 登出 | `destroy(sid)` + 前端清 Cookie |

> 匿名访客首屏请求 `/api/csrf-token` 时也会生成一条 session（`csrfToken` 写进 session 即视为"已修改"），因此 `sessions` 表里有 1 条不代表有人登录。

## 8. 数据访问约定（贡献者必读）

| 约定 | 说明 | 例子 |
|---|---|---|
| 参数化查询 | 一律 `prepare(...).run/get/all(参数)`，禁止拼接用户输入 | 全部 routes/services |
| LIKE 转义 | 关键词搜索先 `escapeLike`（转义 `\ % _`），SQL 用 `LIKE ? ESCAPE '\'` | chat-store.js:20–22、users.js:59–61、admin.js:51–53、models.js:56–58 |
| ID 解析 | 只接受正整数数字串，防 `NaN`/注入 | 各文件 `parseId` |
| 时间 | 统一 `new Date().toISOString()`（UTC ISO），字符串排序可当时间序用 | 所有插入/更新 |
| 布尔 | 库内 `0/1`，接口层转 boolean | 各 `toXxx` 映射 |
| 事务 | 多条写必须事务（先清后设默认、批量插入模型、设置批量 upsert） | models.js:159–171、providers.js:320–330 |
| 计数 | 列表接口用子查询算 `message_count`/`conversation_count` | chat-store.js:33–40、admin.js |

## 9. 当前数据快照（2026-11-15 只读查询）

| 表 | 行数 | 备注 |
|---|---|---|
| users | 1 | 1 个 `admin/active` |
| api_providers | 0 | 未配置任何上游 |
| models | 0 | — |
| conversations | 0 | — |
| messages | 0 | — |
| settings | 6 | 全部默认值，updated_at=2026-11-12T12:46:22Z |
| sessions | 1 | 极可能是取 CSRF token 产生的匿名会话 |

结论：本地库为**初始化后的空壳**（见 [01](01-overview.md) §8）。

## 10. 备份、恢复、清库

### 10.1 备份（WAL 模式必须注意）

```powershell
# 方式 0（推荐）：项目自带脚本，WAL 安全且自动 quick_check
npm run backup
# 等价命令：node scripts/backup-db.js --out data/backups

# 方式 A：停服务后复制三件套（最稳）
Stop-Process -Name node -ErrorAction SilentlyContinue   # 或先 Ctrl+C 优雅停止
Copy-Item data\chenlong.db* D:\backup\ -Force

# 方式 B：在线一致备份（better-sqlite3 的 backup API，不需要停服）
node -e "const D=require('better-sqlite3');const db=new D('data/chenlong.db');db.backup('data/backup.dot.db').then(()=>{db.close();console.log('backup ok')})"

# 方式 C：有 sqlite3 CLI 时
sqlite3 data/chenlong.db ".backup data/backup.db"
```

**只复制 `chenlong.db` 会丢最新数据**（最新写入可能还在 `-wal` 里），这是最常见的事故。

### 10.2 密钥必须一起备份

`ENCRYPTION_KEY`（或 `data/.dev-secrets.json`）**丢失 = api_providers.api_key_encrypted 永久无法解密**，所有上游 Key 需要重新录入。备份数据库时请同时离线保管密钥（不要和备份放在同一公开位置）。

### 10.3 恢复

停止服务 → 用备份替换 `data/chenlong.db`（同时删除旧 `-wal/-shm`）→ 确保 `ENCRYPTION_KEY` 与备份时一致 → 启动。

### 10.4 清库重置

停止服务 → 删除 `data/chenlong.db `*（以及可选 `.dev-secrets.json`，但删它会让旧 Key 无法解密）→ 启动（自动建表）→ 如需管理员确保 .env 里 `ADMIN_USERNAME/ADMIN_PASSWORD` 已填。

## 11. 风险与待改进

1. **无 migration / schema 版本表**：升级易出错，建议加 `schema_migrations` 表与迁移脚本目录；
2. **`is_default` 无 DB 级唯一约束**：靠应用事务保证，脚本/手工改库可能造出两个默认模型（解析时按 `is_default DESC, id ASC` 取第一个，不会崩但行为不直观）；
3. **`dbSizeBytes` 只统计主库**（admin.js:65–72），不含 WAL/SHM，仪表盘数字会低估真实占用；
4. **无定期 `VACUUM` / checkpoint**：WAL 长期不 checkpoint 会膨胀（本机已 231 KB）；
5. **`messages.content` 无 DB 级长度约束**：绕过接口（脚本直插）可写入超长内容；
6. **无审计与软删除**：管理员看得到全部会话，但没有操作审计日志；删会话/改模型不可追溯；
7. **`users.avatar` / `api_providers.api_type` / `models.status`** 属于预留字段，当前业务未充分使用，清理/扩展时注意兼容。
