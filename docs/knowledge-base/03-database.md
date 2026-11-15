# 03 数据库设计（PostgreSQL）

> 本章回答：**数据存在哪、7 张表长什么样、关系与索引是什么、怎么初始化、怎么备份、怎么从 SQLite 迁过来、有哪些坑。**
> 结构以 `server/database/init.js` 为准；运行时数据层 `server/database/db.js` 基于 `pg` 连接池、**全异步**。第三批迁移后项目不再使用 SQLite 作为运行时数据库（better-sqlite3 仅保留在 devDependencies，供一次性数据迁移脚本读取旧库）。
> 迁移前后的背景与变更清单见 [11-changes.md](11-changes.md) 的「第三批」与 [09-status-and-gaps.md](09-status-and-gaps.md) §8。

## 1. 连接、连接池与运行参数

| 项目 | 值 / 行为 | 出处 |
|---|---|---|
| 首选连接方式 | 环境变量 `DATABASE_URL`（如 `postgres://user:pass@host:5432/chenlong`） | db.js:9–12 |
| 备用连接方式 | `DATABASE_URL` 为空时用标准 PG 变量：`PGHOST`（默认 127.0.0.1）、`PGPORT`（5432）、`PGUSER`（postgres）、`PGPASSWORD`（空）、`PGDATABASE`（chenlong） | db.js:13–20 |
| 连接池上限 | `PG_POOL_MAX`，默认 10 | db.js:11 |
| 打开方式 | `pg.Pool` 单例（惰性创建，首次 `getDb()` / `query()` 时建立） | db.js:23–33, 126–130 |
| 连接池异常 | `pool.on('error')` 打印 `[db] PostgreSQL 连接池异常`，不退出进程 | db.js:26–31 |
| 错误处理 | 连接失败会体现在具体查询 `await` 的 catch 分支（启动时 `initDatabase()` 失败 → `[FATAL]` exit(1)） | app.js:224–233 |
| 关闭 | `await closeDb()`（连接池 `end()`）；启动失败/端口占用/优雅退出时调用 | db.js:108–114；app.js:239–263 |
| 健康检查 | `await ping()` 执行 `SELECT 1`，失败返回 503 | db.js:116–119；app.js:161–174 |
| 库大小 | `await databaseSizeBytes()` 执行 `SELECT pg_database_size(current_database())` | db.js:121–124；admin.js:126–131 |
| 大整数处理 | 注册 pg 的 int8（OID 20）解析器为 `Number`，所以 `COUNT(*)` 直接是 number | db.js:3–4 |

**不再存在的旧机制**：`DB_PATH`、`data/chenlong.db`、`-wal/-shm`、WAL/checkpoint、`busy_timeout`、`better-sqlite3` 同步 API。运行时不依赖任何本地数据库文件；数据库是**独立进程/服务**（本机 docker 或远程 PG）。

> 连接串与 PG 密码属于敏感配置：只放在 `.env` / 部署 Secret 中，不要写进文档或提交仓库（`.env` 已被 gitignore + Secret Scanning 保护）。

## 2. 表清单与字段（PostgreSQL）

所有表由 `init.js` 的 `SCHEMA_SQL` 创建（`CREATE TABLE IF NOT EXISTS`）。类型策略：**时间为 ISO 字符串 `TEXT`、布尔为 `INTEGER` 0/1、主键为 `INTEGER GENERATED ALWAYS AS IDENTITY`**（沿用原 SQLite 语义，应用层无需改字段映射）。

### 2.1 `users` —— 账号（init.js:7–16）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, GENERATED ALWAYS AS IDENTITY | 用户 ID（插入无需给值；需要时用 `RETURNING id`） |
| username | TEXT | NOT NULL UNIQUE | 登录名，3–24 位字母数字下划线 |
| password_hash | TEXT | NOT NULL | bcrypt（cost 10，`$2b$10$…` 60 字符） |
| nickname | TEXT | NULL | 显示名，1–20 字 |
| avatar | TEXT | NULL | 头像（前端未使用，预留） |
| role | TEXT | NOT NULL DEFAULT `'user'` | `user` / `admin` |
| status | TEXT | NOT NULL DEFAULT `'active'` | `active` / `disabled` |
| created_at | TEXT | NOT NULL | ISO 时间字符串 |

> 无 `updated_at`、无最后登录时间、无软删除字段。

### 2.2 `api_providers` —— 上游 API 服务（init.js:18–28）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, IDENTITY | — |
| name | TEXT | NOT NULL | 服务名，≤50 字 |
| base_url | TEXT | NOT NULL | 上游根地址（去尾斜杠），已验证协议且非内网 |
| api_key_encrypted | TEXT | NOT NULL | AES-256-GCM 密文 `v1:iv:tag:cipher` |
| api_type | TEXT | NOT NULL DEFAULT `'openai-compatible'` | 预留多协议，目前无分支逻辑 |
| enabled | INTEGER | NOT NULL DEFAULT 1 | 0/1 |
| description | TEXT | NULL | ≤200 字 |
| created_at / updated_at | TEXT | NOT NULL | ISO |

### 2.3 `models` —— 模型（init.js:30–41）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, IDENTITY | 内部 ID（聊天请求用这个） |
| provider_id | INTEGER | NOT NULL, FK → api_providers(id) ON DELETE CASCADE | 所属服务 |
| model_id | TEXT | NOT NULL | 上游模型名（如 `gpt-4o-mini`） |
| display_name | TEXT | NULL | 展示名（空则回落 model_id） |
| enabled | INTEGER | NOT NULL DEFAULT 1 | 0/1；刷新模型默认入库为 **0** |
| is_default | INTEGER | NOT NULL DEFAULT 0 | 全局唯一默认（应用层保证，无 DB 唯一约束） |
| last_tested_at | TEXT | NULL | 最近测试时间 |
| status | TEXT | NOT NULL DEFAULT `'discovered'` | `discovered` / `available` / `unavailable` |
| created_at | TEXT | NOT NULL | — |
| — | UNIQUE(provider_id, model_id) | — | 同一服务下模型名唯一（冲突错误码 PG **23505**） |

### 2.4 `conversations` —— 会话（init.js:43–50）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, IDENTITY | — |
| user_id | INTEGER | NOT NULL, FK → users(id) ON DELETE CASCADE | 归属者 |
| title | TEXT | NULL | 自动取首条消息前 20 码位；可重命名 1–40 字 |
| model_id | INTEGER | FK → models(id) ON DELETE SET NULL | **仅记录**最近使用的模型，不参与解析 |
| created_at / updated_at | TEXT | NOT NULL | 列表按 updated_at 倒序 |

### 2.5 `messages` —— 消息（init.js:52–58）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, IDENTITY | 自增即时间序 |
| conversation_id | INTEGER | NOT NULL, FK → conversations(id) ON DELETE CASCADE | 删会话级联删消息 |
| role | TEXT | NOT NULL | `user` / `assistant`（system 提示不落库） |
| content | TEXT | NOT NULL | 消息正文（用户侧接口限 4000 字；DB 无长度约束） |
| created_at | TEXT | NOT NULL | ISO |

### 2.6 `settings` —— 系统设置（init.js:60–65）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, IDENTITY | — |
| setting_key | TEXT | NOT NULL UNIQUE | 见下方 6 个键 |
| setting_value | TEXT | NULL | 布尔存 `'1'`/`'0'` |
| updated_at | TEXT | NOT NULL | — |

默认 6 个键（init.js:80–87）：`site_name`、`site_subtitle`、`allow_register`、`allow_chat`、`announcement`、`logo`。

### 2.7 `sessions` —— 登录会话（init.js:67–71）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| sid | TEXT | PK | express-session 的会话 ID（Cookie 值） |
| sess | TEXT | NOT NULL | 序列化的 session JSON（含 `userId`、`csrfToken`、cookie 等） |
| expire | **BIGINT** | NOT NULL | 过期时间（毫秒时间戳；pg 返回后按 `Number()` 使用） |

> 该表在 `init.js` 与 `services/session-store.js:8–15` 中各有一份 `CREATE IF NOT EXISTS`，**幂等冗余**，谁先建都行。

## 3. 表关系

```text
users (1) ──< conversations (1) ──< messages
                  │
                  └── model_id ──> models (N) ──> api_providers (1)

settings       独立键值表（无外键）
sessions       独立表（express-session 专用，无外键）
api_providers ──< models
```

级联行为（PostgreSQL 外键，语义与旧版一致）：

| 操作 | 连带效果 |
|---|---|
| 删除用户（当前没有接口，仅脚本层可能） | 其 `conversations` 级联删除 → 其 `messages` 级联删除（会话行不删 session） |
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

**索引缺口（数据量大后的优化点，与旧版相同）**：

- `conversations` 列表按 `updated_at DESC, id DESC` 排序，无对应索引；
- `users` 后台按 `status`/`role` 筛选无索引（主键排序有隐式索引，问题不大）；
- `messages` 按 `created_at` 无索引（实际按 id 排序，够用）；
- `sessions` 按用户失效会话（改密/重置密码）目前是**全表读取 `sess` JSON 再逐条删**（见 §12），会话量大时需加 `user_id` 列或 JSONB 索引。

## 5. 初始化与播种

`init.js` 的 `initDatabase()`（init.js:135–141）三件事，**必须 `await`**：

1. `await db.query(SCHEMA_SQL)`：建 7 表 + 5 索引（全部 `IF NOT EXISTS`，幂等）；
2. `await seedSettings(db)`：6 条默认设置，SQL 为 `INSERT ... ON CONFLICT (setting_key) DO NOTHING`（只补缺失键，不覆盖已改值）；
3. `await seedAdmin(db)`：**仅当 users 里没有任何 admin** 时，用 `ADMIN_USERNAME/ADMIN_PASSWORD` 创建一次管理员（bcrypt 10）；两者缺一则跳过并打印 WARN；创建后日志提示"请登录后立即修改密码"（**不打印密码**）。

触发时机：

- 服务启动 `start()` 内自动执行（`await initDatabase()`，app.js:224–233；失败 `[FATAL]` exit(1)）；
- 或手动 `npm run init-db` / `npm run db:init`：执行后打印"数据库初始化完成：7 张表 [...]，新增设置项 N 条"，随后 `await closeDb()` 退出（init.js:145–164）。

> 修改 `.env` 里的 `ADMIN_USERNAME/ADMIN_PASSWORD` 之后重启**不会**改已有管理员密码——这是设计而非 bug。要改密码请用后台或 `/api/user/password`。
> PostgreSQL 下 `initDatabase()` 需要数据库已存在（PG 不会自动建库）：先用 `createdb` / compose 的 `POSTGRES_DB` 建好库，再启动应用。

## 6. 设置表读写模型

- 映射常量 `FIELDS`（settings-store.js:5–12）：接口 camelCase ↔ `setting_key` snake_case，并声明布尔字段；
- 读取：`await readSettings()` 每次查库（查询很小），缺键回落默认值（默认来自 init.js 的 `SETTINGS_DEFAULTS`，且有本地 fallback），不会 500；
- 写入：`await updateSettings(body)` 只处理请求体里出现的键，未知键忽略；校验规则：siteName 1–40、siteSubtitle ≤60、announcement ≤200、logo ≤200 且必须以 `/` 或 `http(s)://` 开头、两个布尔键必须是 boolean；批量 upsert 在 `await getDb().transaction(async (tx) => { ... })` 里完成（settings-store.js:130–143）；
- 生效方式：保存即生效，无需重启——前台每次加载调 `GET /api/settings`；
- 开关读取 `isRegistrationAllowed()` / `isChatAllowed()` 也是 async（内部 `await` 查 settings），**调用方必须 `await`**（auth.js / chat.js 路由已改）。

## 7. 会话表与 PgSessionStore

| 行为 | 实现 |
|---|---|
| 存储 | `sessions(sid, sess, expire)`，sess 为 JSON 字符串；expire 为 BIGINT 毫秒时间戳 |
| 实现类 | `server/services/session-store.js` 的 `PgSessionStore`（`module.exports = PgSessionStore`；app.js:14,141 使用） |
| 表初始化 | 首次使用时 `_ensureSchema()` 执行 `CREATE TABLE IF NOT EXISTS`（并发只跑一次，失败可重试；session-store.js:56–65） |
| TTL | 7 天（`DEFAULT_TTL_MS`，session-store.js:5）；以 Cookie 的 expires 为准，否则 now+TTL |
| 写入 | `INSERT INTO sessions ... ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire` |
| 过期 | 读取时发现 `Number(expire) <= Date.now()` 立即删除并返回空；另有每 15 分钟一次 `cleanup()`（`unref` 定时器，返回 Promise；session-store.js:38–49, 139–144） |
| 按用户失效 | `destroyByUserId(userId)` / `destroyOthersByUserId(userId, keepSid)` **均返回 Promise<number>**（session-store.js:146–171）；管理员重置密码踢全部、本人改密踢其它设备 |
| 全量操作 | 实现 `all/clear/length`（express-session 接口完整性），生产路径基本不用 |
| 登出 | `destroy(sid)` + 前端清 Cookie（异步回调风格） |

> express-session 的 Store 接口是回调风格，`PgSessionStore` 内部全部用 Promise 包一层再 `callback()`。不要把它当同步存储用。
> 匿名访客首屏请求 `/api/csrf-token` 时也会生成一条 session（`csrfToken` 写进 session 即视为"已修改"），因此 `sessions` 表里有 1 条不代表有人登录。

## 8. 数据访问约定（贡献者必读，PostgreSQL 版）

数据层 `server/database/db.js` 对上层暴露与旧版**同名但异步**的 API：

```js
const { getDb } = require('../database/db');

const row  = await getDb().prepare('SELECT ... WHERE id = ?').get(...params); // 行或 null
const rows = await getDb().prepare('SELECT ...').all(...params);               // 数组
const info = await getDb().prepare('UPDATE ...').run(...params);               // { changes, rowCount, rows }

// 需要新插入行的 id：SQL 末尾加 RETURNING id
const { rows } = await getDb()
  .prepare('INSERT INTO users (...) VALUES (...) RETURNING id')
  .run(...params);
const id = rows[0].id;

// 事务：回调内用 tx（等待所有语句，自动 BEGIN/COMMIT/ROLLBACK/释放连接）
await getDb().transaction(async (tx) => {
  await tx.run('UPDATE models SET is_default = 0 WHERE is_default = 1');
  await tx.run('UPDATE models SET is_default = 1 WHERE id = ?', id);
});
```

| 约定 | 说明 | 例子 |
|---|---|---|
| 全异步 | 路由 handler 改 `async`，DB 调用前加 `await`；保留 `try/catch + next(err)` | 全部 routes/services |
| SQL 占位符 | **统一写 `?`**，由 `toPgSql()` 自动转 `$1..$n`；**不要手写 `$1`** | db.js:35–39 |
| 参数 | 变参或单数组均可（`normalizeParams` 支持 `.run([a,b])`）；`undefined` 自动转 `null` | db.js:41–44 |
| INSERT id | SQL 末尾加 `RETURNING id`，从 `run()` 返回的 `rows[0].id` 取；不再有 `lastInsertRowid` | 注册、建会话、建消息等 |
| 唯一冲突 | PG 错误码 `23505`（不再是 `SQLITE_CONSTRAINT`） | auth.js 重名注册、models 唯一键 |
| upsert | `INSERT ... ON CONFLICT (col) DO NOTHING/DO UPDATE`（替代 `INSERT OR IGNORE`） | 默认设置、会话写入 |
| 计数 | `COUNT(*)` 已由 int8 解析器转为 number，无需额外转换 | db.js:3–4 |
| 事务 | 旧的同步 `db.transaction(fn)()` 必须替换为 `await getDb().transaction(async (tx) => ...)`；事务内**所有**语句都要 await | settings-store.js:130–143；models/providers/chat 路由 |
| 时间 | 统一 `new Date().toISOString()`（UTC ISO 字符串），字符串排序可当时间序用 | 所有插入/更新 |
| 布尔 | 库内 `0/1`，接口层转 boolean | 各 `toXxx` 映射 |
| 参数化 / LIKE | 禁止拼接 SQL；LIKE 先用 `escapeLike` + `LIKE ? ESCAPE '\'` | chat-store/users/admin/models |
| 连接池 | 不要自己 `new Pool`；用 `getDb()`/`getPool()` 单例；事务用完自动 release | db.js |
| 关闭 | 进程退出前 `await closeDb()`；单测/脚本结束也要关 | app.js:239–263；init.js CLI |

## 9. 从 SQLite 迁移数据（一次性，第三批）

运行时已经切到 PostgreSQL，但旧 `data/chenlong.db`（及 `-wal/-shm`）里的历史数据需要一次性搬运：

1. **先备份**旧 SQLite 三件套与 `ENCRYPTION_KEY`（见 §10；密钥丢了迁移后 API Key 仍是密文垃圾）；
2. 准备好 PostgreSQL（本地 `docker compose up -d db`，或远程实例），建库并配置 `DATABASE_URL`；
3. 先 **dry-run 统计**再写入：`node scripts/migrate-sqlite-to-pg.js --dry-run`（参数：`--sqlite <旧库路径>`、`--database-url <连接串>`、`--dry-run`、`--allow-existing`；默认读 `DB_PATH` 或 `data/chenlong.db`）；确认行数后去掉 `--dry-run` 正式执行。脚本以 `better-sqlite3` **只读**打开旧库，写入 users/api_providers/models/conversations/messages/settings 六张表，**保留原始 id** 并用 `OVERRIDING SYSTEM VALUE` 插入、随后 `setval(pg_get_serial_sequence(...))` 对齐 IDENTITY 序列（migrate-sqlite-to-pg.js:139–152）；
4. 校验：脚本会打印每表搬运行数；逐表 `SELECT COUNT(*)` 对比，抽查 `api_key_encrypted` 是否原样搬运（密文不变，`ENCRYPTION_KEY` 不变即可解密）。**`sessions` 不迁移**——登录会话需重新登录，这是脚本的明确取舍（migrate-sqlite-to-pg.js:8–10）；
5. 切换 `.env`：填 `DATABASE_URL`（移除 `DB_PATH`）；
6. 启动应用（自动完成 `initDatabase()` 幂等建表/补设置），登录后台逐项验证；迁移完成后旧 SQLite 文件归档离线保存，确认无误后才考虑删除。

> **安全默认**：目标库 `users` 表已有数据时脚本默认拒绝写入（退出码 2），确认要合并才加 `--allow-existing`。
> 迁移只搬数据、不改表结构：目标库需先由 `initDatabase()`（启动应用或 `npm run init-db`）建好 7 张表；迁移后旧 SQLite 文件只读保留，确认无误后再归档。

## 10. 备份、恢复、清库（pg_dump / psql）

### 10.1 备份（统一用 pg_dump）

```bash
# 推荐：项目脚本（默认 pg_dump plain SQL，输出 data/backups/chenlong-YYYYMMDD-HHmmss.sql）
npm run backup
# 等价：node scripts/backup-db.js --out data/backups
# 指定连接串 / 覆盖同名文件：
node scripts/backup-db.js --database-url "postgres://..." --force

# 没有项目脚本时的等价 pg_dump 命令（不推荐在生产手工拼密码）
pg_dump "$DATABASE_URL" --format=plain --no-owner --no-privileges > data/backups/chenlong-manual.sql
```

- 脚本把 `DATABASE_URL` 拆成 `PG*` 环境变量交给 `pg_dump`（密码不进命令行/历史），并校验输出文件头是 `PostgreSQL database dump`（backup-db.js:92–174）；
- **依赖 `pg_dump`**：宿主机需安装 `postgresql-client`（或在与 PG 版本匹配的容器内执行）；`PG_DUMP` 环境变量可指定可执行文件路径；
- 备份文件是**明文 SQL**（含聊天记录与加密后的 API Key），必须按敏感数据保管：离线/加密存储、不要把备份提交到 Git；`data/backups/` 已 gitignore。

### 10.2 密钥必须一起备份

`ENCRYPTION_KEY`（或 `data/.dev-secrets.json`）**丢失 = api_providers.api_key_encrypted 永久无法解密**，所有上游 Key 需要重新录入。备份数据库时请同时离线保管密钥（不要和备份放在同一公开位置）。`pg_dump` 不会备份密钥——密钥在环境变量/密钥文件里。

### 10.3 恢复

```bash
# 1) 停应用（docker compose down 或停止 node 进程）
# 2) 恢复到一个空库（推荐新建库，避免残留数据）
psql "$DATABASE_URL" -f data/backups/chenlong-20261115-120000.sql
# 3) 确认 ENCRYPTION_KEY 与备份时一致
# 4) 启动应用并验证 /api/health 与登录
```

> 恢复前建议先用 `createdb` 建一个独立库做演练；直接恢复覆盖现有库前必须再次备份当前库。

### 10.4 清库重置

停止应用 → 删除/重建目标库（例如 `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` 或重建 database）→ 启动应用（自动建表/补设置/播种管理员）→ 如需管理员确保 `.env` 里 `ADMIN_USERNAME/ADMIN_PASSWORD` 已填。

## 11. 数据快照

| 时期 | 说明 |
|---|---|
| 2026-11-15 迁移前（SQLite） | 7 张表；users=1（admin）、sessions=1、其余业务表全 0；settings=6 条默认值。主库 86 KB + WAL 231 KB（历史记录，见 [09](09-status-and-gaps.md) §3） |
| 迁移到 PostgreSQL 后 | 行数取决于迁移执行结果；**本机没有 PostgreSQL，本轮文档未做 PG 实物核查（待核实）**。确认方式：连库执行 `SELECT COUNT(*) FROM users;` 等，或登录后台看仪表盘计数 |

## 12. 风险与待改进

1. **无 migration / schema 版本表**：`init.js` 仍只有 `CREATE TABLE IF NOT EXISTS`；PG 下加列可用 `ALTER TABLE ... ADD COLUMN`，但版本化迁移仍缺失，建议加 `schema_migrations` 表 + 迁移脚本目录；
2. **`sessions` 按用户失效是全表扫描**：`_destroyMatching` 先 `SELECT sid, sess FROM sessions` 全量读、再逐条 `DELETE`（session-store.js:146–159）。会话量大时是 O(n) + n 次往返，建议给 `sessions` 加 `user_id` 列/索引，或改用 JSONB 查询；
3. **`is_default` 无 DB 级唯一约束**：靠应用事务保证，脚本/手工改库可能造出两个默认模型（解析时按 `is_default DESC, id ASC` 取第一个，不会崩但行为不直观）；
4. **`dbSizeBytes` 现在是 `pg_database_size()`**（整个数据库含索引/TOAST），比旧版"只算主库"更准；但会随索引与死元组（dead tuples）波动，**不等于有效数据量**；需要精确业务量请逐表 `pg_total_relation_size`；
5. **无定期 VACUUM/autovacuum 调参**：默认 autovacuum 可覆盖常规更新，消息表持续增长时建议关注膨胀与归档；
6. **`messages.content` 无 DB 级长度约束**：绕过接口（脚本直插）可写入超长内容；
7. **无审计与软删除**：管理员看得到全部会话，但没有操作审计日志；删会话/改模型不可追溯；
8. **PG 连接数/长事务**：`PG_POOL_MAX` 默认 10，多实例部署时注意 PG `max_connections` 与连接池乘积；SSE 长连接本身不占 PG 连接（查询都很短），但事务里禁止做长时间操作；
9. **`users.avatar` / `api_providers.api_type` / `models.status`** 属于预留字段，当前业务未充分使用，清理/扩展时注意兼容。