# 04 API 参考

> 本章是**接口契约**：共 **40 个端点**。所有结论来自 `server/app.js` 与 `server/routes/*.js` 的实际实现。
> 聊天流式协议单独在 [06 聊天与 SSE 流程](06-chat-flow.md) 展开；前端如何调用见 [05 前端架构](05-frontend.md)。

## 1. 通用约定

### 1.1 基址与格式

- 基址：`http://<host>:<PORT>/api`（默认 PORT=3000），同源部署；
- 请求/响应体均为 JSON（`Content-Type: application/json`），请求体上限 **1 MB**；
- 例外：`POST /api/chat/completions` 在 `stream:true` 时返回 `text/event-stream`；
- 所有 `/api` 响应都带 `Cache-Control: no-store`（敏感 JSON 不进入浏览器/代理缓存）；静态资源不受影响；
- 未匹配的 `/api/*` 一律 `404 {"error":{"code":"NOT_FOUND",...}}`。

### 1.2 鉴权方式

基于 **Cookie 会话**（`chenlong.sid`，httpOnly + sameSite=lax + 7 天），不是 Bearer Token：

| 级别 | 含义 |
|---|---|
| 公开 | 无需登录（`/api/health`、`/api/csrf-token`、`GET /api/settings`、`POST /api/auth/register`、`POST /api/auth/login`） |
| 登录用户 | 需要有效会话；未登录 `401 UNAUTHORIZED` |
| 管理员 | 登录用户且 `role === 'admin'`；否则 `403 FORBIDDEN` |

### 1.3 CSRF（所有写请求必读）

**所有** `/api` 下非 `GET/HEAD/OPTIONS` 的请求（包括登录、注册、登出）都必须带请求头 `X-CSRF-Token`：

```text
1) GET  /api/csrf-token          → 200 {"token":"<64位hex>"}   （同时下发 session cookie）
2) 后续写请求带上请求头：X-CSRF-Token: <token>
3) 登录/注册成功后 session 会 regenerate，旧 token 失效，
   响应里会返回新的 csrfToken，前端必须用它覆盖本地缓存。
```

失败响应（403）：`{"error":{"code":"CSRF_INVALID","message":"页面已过期，请刷新后重试"}}`
实现：token 存 session，`timingSafeEqual` 定长比较（middleware/csrf.js:3–37）。前端 `fetchJSON` 会自动处理"取 token / 403 后清缓存重试"，见 [05](05-frontend.md)。

### 1.4 限流

| 范围 | 规则 | 维度 | 说明 |
|---|---|---|---|
| 全局限流 | 300 次 / 60 秒 | IP | **只统计写请求**（GET/HEAD/OPTIONS 不计） |
| `POST /api/auth/login` | 10 次 / 5 分钟 | IP | — |
| `POST /api/auth/register` | 5 次 / 10 分钟 | IP | — |
| `POST /api/users/:id/password` | 10 次 / 60 秒 | 当前管理员 | 仅该路径 |
| `POST /api/chat/completions` | 20 次 / 60 秒 | 登录用户 | — |

- 超限返回 `429` + `{"error":{"code":"RATE_LIMITED","message":"请求太频繁，请稍后再试"}}`；
- 响应头：`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`（秒级时间戳）、超限时额外 `Retry-After`（秒）；
- 开发环境可用 `RATE_LIMIT_ENABLED=0` 关闭；**生产环境强制开启**（rate-limit.js:5–9）。

### 1.5 统一错误与错误码

错误响应统一为：

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "用户名或密码错误" } }
```

**错误码总表**：

| code | HTTP | 触发场景 | 主要出处 |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | 参数不合法（各接口的字段校验） | 各 routes |
| `INVALID_JSON` | 400 | 请求体不是合法 JSON | app.js:198 |
| `BAD_REQUEST` | 4xx | 其他 4xx 的兜底 code（如 413 请求体过大） | app.js:198 |
| `UNAUTHORIZED` | 401 | 未登录 / 会话失效 | middleware/auth.js:4–6、auth.js:122 |
| `INVALID_CREDENTIALS` | 401 | 用户名或密码错误（用户不存在也返回这个） | auth.js:97,101 |
| `ACCOUNT_DISABLED` | 403 | 账号被管理员禁用 | auth.js:102 |
| `FORBIDDEN` | 403 | 已登录但不是管理员 | middleware/admin.js:6 |
| `REGISTER_DISABLED` | 403 | 管理员关闭了注册 | auth.js:44 |
| `CHAT_DISABLED` | 403 | 管理员暂停了聊天服务 | chat.js:195 |
| `CSRF_INVALID` | 403 | 写请求缺少/错误的 CSRF token | middleware/csrf.js:5 |
| `CANNOT_MODIFY_SELF` | 400 | 管理员试图改自己的角色/状态 | users.js:157,163 |
| `LAST_ADMIN` | 400 | 不能降级/禁用最后一个启用的管理员 | users.js:177 |
| `USERNAME_TAKEN` | 409 | 注册用户名已存在 | auth.js:58,71 |
| `MODEL_EXISTS` | 409 | 同一 API 服务下模型名重复 | models.js:147,173,201 |
| `MODEL_NOT_AVAILABLE` | 400 | 指定 modelId 不存在或未启用 | chat-store.js:82 |
| `NO_AVAILABLE_MODEL` | 400 | 没有任何已启用模型 | chat-store.js:89 |
| `NOT_FOUND` | 404 | 资源不存在 / 接口不存在 / 他人会话（不泄露存在性） | 各 routes、app.js:188 |
| `UPSTREAM_BLOCKED` | 400 | 上游地址指向内网/保留地址（SSRF 防护） | providers.js:139,194 |
| `UPSTREAM_ERROR` | 502 | 上游失败（刷新模型；SSE 里改为 error 帧） | providers.js:309,313 |
| `RATE_LIMITED` | 429 | 触发限流 | rate-limit.js:56 |
| `INTERNAL_ERROR` | 500 | 未预期异常（生产不返回细节） | app.js:198 |

> 注意：**没有**对外暴露的 `ABORTED` 错误码——客户端断开时服务端不返回响应（连接已断），仅落库部分内容并打日志。

### 1.6 分页、枚举与常用查询参数

- 分页：`page`（默认 1，正整数）+ `pageSize`（默认 20，1–100；消息分页默认 50）；响应统一 `{items, total, page, pageSize}`；
- 用户筛选：`status` ∈ `active/disabled`，`role` ∈ `user/admin`，非法枚举 → 400；
- 模型筛选：`providerId`（正整数）、`keyword`（匹配 display_name/model_id）、`status` ∈ `enabled/disabled`；
- 关键词搜索的 `%@@/`_` 会被转义（LIKE ... ESCAPE），可放心传特殊字符；
- 时间字段一律 ISO 8601 UTC 字符串（如 `2026-11-15T07:52:39.000Z`）。

## 2. 健康检查与 CSRF

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/health | 公开 | 服务自检：`200 {"status":"ok","uptime":<秒>,"db":"connected","version":"0.1.0"}`；数据库异常 `503 {"status":"degraded","db":"disconnected",...}`。位置在限流/鉴权/CSRF 之前，适合探活 |
| GET | /api/csrf-token | 公开 | `200 {"token":"<64 hex>"}`；session 里没有才生成，多标签页共用一个 token |

## 3. 认证 /api/auth

| 方法 | 路径 | 鉴权 | 限流 |
|---|---|---|---|
| POST | /api/auth/register | 公开（受 allowRegister 开关） | 5 次 / 10 分钟 / IP |
| POST | /api/auth/login | 公开 | 10 次 / 5 分钟 / IP |
| POST | /api/auth/logout | 登录（Cookie） | 全局限流 |
| GET | /api/auth/me | 登录 | 全局限流（GET 不计） |

### POST /api/auth/register

请求：`{"username":"alice_01","nickname":"爱丽丝","password":"secret123"}`
校验：username 3–24 位 `[A-Za-z0-9_]`；password 6–64 位；nickname trim 后 1–20 字。
成功 `201 {"user":{...},"csrfToken":"..."}`（**注册即登录**，建立新会话）。
错误：400 `VALIDATION_ERROR`；409 `USERNAME_TAKEN`；403 `REGISTER_DISABLED`（"管理员已关闭注册"）。

### POST /api/auth/login

请求：`{"username":"admin","password":"..."}`（都 trim/非空校验）
成功 `200 {"user":{id,username,nickname,role,created_at},"csrfToken":"..."}`
错误：400 `VALIDATION_ERROR`；401 `INVALID_CREDENTIALS`（统一文案，不泄露账号是否存在）；403 `ACCOUNT_DISABLED`。
行为：先 `session.regenerate()` 再写 userId，防会话固定；同时重建 CSRF token。

### POST /api/auth/logout

无请求体；成功 `204`（销毁会话 + 清 Cookie）。**需要 CSRF 头**。

### GET /api/auth/me

成功 `200 {"user":{...}}`；未登录 `401 {"error":{"code":"UNAUTHORIZED","message":"请先登录"}}`。

## 4. 个人资料 /api/user（需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| PATCH | /api/user/profile | 改昵称：`{"nickname":"新昵称"}`（1–20 字）→ `200 {"user":{...}}` |
| PATCH | /api/user/password | 改密码：`{"currentPassword":"旧","newPassword":"新"}`（新密码 6–64 位）→ `200 {"ok":true,"revokedSessions":N}`；旧密码错误 400 `VALIDATION_ERROR`。改完**保持当前会话**，同时让该用户其它已登录会话失效（N 为失效条数，见 [07](07-security.md)） |

## 5. 用户管理 /api/users（需管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/users | 列表：`?keyword=&status=&role=&page=&pageSize=`；keyword 匹配 username/nickname；每行带 `conversationCount` |
| GET | /api/users/:id | 详情：额外带 `messageCount`（跨所有会话） |
| PATCH | /api/users/:id | 更新 `{nickname?, role?, status?}`；改自己角色/状态 → 400 `CANNOT_MODIFY_SELF`；移除最后一个启用管理员 → 400 `LAST_ADMIN` |
| POST | /api/users/:id/password | 重置他人密码：`{"password":"..."}` → `204`。**规则与注册不同**：8–32 位且必须同时含字母与数字；不要求旧密码；**会踢掉目标用户全部已登录会话**（管理员重置自己的密码时保留当前会话） |

## 6. API 服务管理 /api/providers（需管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/providers | 列表（按 id 倒序），每项含 `keyMasked`（如 `sk-…ab12`）与 `modelCount` |
| GET | /api/providers/:id | 详情（同样只回掩码） |
| POST | /api/providers | 新建：`{name, baseUrl, apiKey, apiType?, description?, enabled?}` → 201。**baseUrl 会做协议与 SSRF 校验**，key 加密入库，明文不回 |
| PATCH | /api/providers/:id | 局部更新；`apiKey` **留空字符串/缺省表示不改**；换 baseUrl 会重新做 SSRF 校验 |
| DELETE | /api/providers/:id | 204；级联删除其下所有模型 |
| PATCH | /api/providers/:id/status | `{"enabled":true|false}` |
| POST | /api/providers/:id/test | 用解密后的 Key 真实请求上游 /models；**总是 200**，响应 `{ok, latencyMs, modelCount, message}`（连不上也 200 + ok:false） |
| POST | /api/providers/:id/refresh-models | 拉取上游模型并入库：**新模型全部 enabled=0**、已存在的幂等跳过（不覆盖启停/默认）→ `200 {ok:true, added, total, message}`；上游失败 502 `UPSTREAM_ERROR` |

字段限制：name ≤50、description ≤200、apiKey ≤512、apiType ≤50（默认 `openai-compatible`，目前无多协议分支）。
上游发现顺序：先试 `{baseUrl}/models`，**仅当返回 404** 才再试 `{baseUrl}/v1/models`；建连超时 10 秒。

## 7. 模型管理 /api/models（需管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/models | `?providerId=&keyword=&status=enabled\|disabled`；按 id 倒序 |
| GET | /api/models/:id | 详情 |
| POST | /api/models | 新建：`{providerId, modelId, displayName?, enabled?, isDefault?}`；isDefault=true 需 enabled=true；同服务下 modelId 重复 409 `MODEL_EXISTS` |
| PATCH | /api/models/:id | 更新 modelId/displayName/enabled；禁用会自动清 is_default |
| DELETE | /api/models/:id | 204 |
| PATCH | /api/models/:id/default | 设为全局默认（先清后设，事务）；模型未启用 → 400 |
| PATCH | /api/models/:id/status | `{"enabled":bool}`；禁用同时清默认 |
| POST | /api/models/:id/test | 真实请求上游模型列表，判断该 model_id 是否存在；更新 `last_tested_at` 与 `status`（available/unavailable）；返回 `200 {ok, latencyMs, message}` |

## 8. 聊天 /api/chat（需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/chat/models | 只列 **已启用** 模型，默认模型排第一：`[{id,displayName,modelId,providerName,isDefault}]` |
| GET | /api/chat/conversations | 我的会话（按 updated_at 倒序），`?keyword=` 匹配标题；每项带 messageCount |
| POST | /api/chat/conversations | 新建：`{title?, modelId?}` → 201；title 缺省"新的对话"，1–40 字；modelId 仅接受已启用模型（否则存 NULL） |
| PATCH | /api/chat/conversations/:id | 重命名：`{title}`（1–40 字）→ 200 |
| DELETE | /api/chat/conversations/:id | 204（级联删消息） |
| GET | /api/chat/conversations/:id/messages | 该会话全部消息（按 id 升序）`{items:[{id,role,content,createdAt}]}` |
| POST | /api/chat/completions | 核心接口：`{conversationId?, modelId?, message, stream?}`，详见下节 |

**归属校验**：所有 `:id` 操作都会校验 `user_id`，非本人会话一律 404（不泄露存在性）。

### POST /api/chat/completions

- `message`：必填，trim 后 1–4000 字；
- `conversationId`：可空（空/0/缺省 → **自动新建会话**，标题取消息前 20 码位）；
- `modelId`：可空（空 → 全局默认 → 第一个已启用模型 → 400 `NO_AVAILABLE_MODEL`）；
- `stream`：`true` 或字符串 `"true"` 或数字 1 → SSE；否则返回整段 JSON；
- `allowChat=false` → 403 `CHAT_DISABLED`；
- 上游重定向（`redirect:'error'`）或流空闲超时（默认 60 秒无数据，`CHAT_STREAM_IDLE_TIMEOUT_MS` 可调）会以 SSE `error` 帧返回 `UPSTREAM_ERROR`（非流式则 502），详见 [06](06-chat-flow.md)。

非流式成功响应：

```json
{ "conversationId": 12, "assistantMessageId": 34, "content": "……", "modelName": "gpt-4o-mini" }
```

流式 SSE 帧协议、断连与错误行为见 [06 聊天与 SSE 流程](06-chat-flow.md)。

## 9. 后台数据 /api/admin（需管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/admin/stats | 仪表盘：`{stats:{userCount,conversationCount,messageCount,providerCount}, recentProviders:[{id,name,baseUrl,modelCount,createdAt}], recentModels:[{id,modelId,displayName,providerName,enabled,lastUsedAt}], system:{version,nodeVersion,uptimeSeconds,dbSizeBytes}}` |
| GET | /api/admin/conversations | 全站会话：`?keyword=&userId=&page=&pageSize=`；keyword 匹配标题/用户名/昵称；带 username/nickname/modelName/messageCount |
| GET | /api/admin/conversations/:id/messages | 会话概要 + 消息分页：`{conversation:{...}, items:[...], total, page, pageSize}`（pageSize 默认 50，1–100，按 id 升序） |

## 10. 系统设置 /api/settings

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/settings | 公开 | `{items:{siteName,siteSubtitle,allowRegister,allowChat,announcement,logo}}` |
| PATCH | /api/settings | 管理员 | 任意子集更新，返回更新后的完整 `items`；校验：siteName 1–40、siteSubtitle ≤60、announcement ≤200、logo ≤200 且以 / 或 http(s):// 开头、两个开关必须是 boolean |

## 11. 完整调用示例（PowerShell）

```powershell
$base = 'http://127.0.0.1:3000'
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# 1) 取 CSRF token（同时获得 session cookie）
$t = Invoke-RestMethod "$base/api/csrf-token" -WebSession $s
$h = @{ 'X-CSRF-Token' = $t.token }

# 2) 登录（响应里有新 token，要覆盖旧值）
$body = '{"username":"admin","password":"<密码>"}'
$login = Invoke-RestMethod "$base/api/auth/login" -Method Post -WebSession $s -Headers $h -ContentType 'application/json' -Body $body
$h = @{ 'X-CSRF-Token' = $login.csrfToken }

# 3) 公开接口
Invoke-RestMethod "$base/api/settings" -WebSession $s

# 4) 管理员接口
Invoke-RestMethod "$base/api/admin/stats" -WebSession $s

# 5) 非流式聊天
$chat = '{"message":"你好","stream":false}'
Invoke-RestMethod "$base/api/chat/completions" -Method Post -WebSession $s -Headers $h -ContentType 'application/json' -Body $chat
```

## 12. 接口层注意事项

1. **登录/注册也要 CSRF**：很多对照实现会把它们排除，本项目没有——先取 token 再登录；
2. **登录成功后必须换用响应里的 `csrfToken`**：旧 token 随 session 重建失效，否则下一个写请求 403；
3. **`POST /api/providers/:id/test` 与 `POST /api/models/:id/test` 成功/失败都返回 200**，要判 `ok` 字段而不是看 HTTP 状态；
4. **刷新模型不会覆盖已有模型的启停/默认**，新模型默认禁用，需要手工启用；
5. **API Key 永不出现在任何响应**，只有掩码 `keyMasked`；更新时传空字符串等于"不修改"；
6. 角色/状态只有 `user|admin` 与 `active|disabled` 两组枚举，传其他值 400；
7. **没有 CORS 头**：接口设计为同源使用；如需跨域调用要自行加反代或改代码；
8. **没有接口版本号**（没有 /v2、没有 Accept-Version），变更靠文档与代码；
9. 后台接口**没有审计日志**：管理员的重置密码、改角色等操作事后不可追溯（见 [09](09-status-and-gaps.md)）。
