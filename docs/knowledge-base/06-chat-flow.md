# 06 聊天与 SSE 流程

> 本章回答：**一条消息从浏览器到上游模型再回到浏览器，中间发生了什么；流式帧长什么样；失败/断连时数据怎么处理。**
> 相关代码：`server/routes/chat.js`（225 行）、`server/services/chat-client.js`（216 行）、`server/services/chat-store.js`（198 行）。

## 1. 职责切分

| 模块 | 职责 |
|---|---|
| `routes/chat.js` | 参数校验、模型/会话解析、SSE 输出、断连处理、错误帧 |
| `services/chat-store.js` | 会话/消息 CRUD、上下文构造、自动标题、模型解析 |
| `services/chat-client.js` | 调上游 `/chat/completions`、解析上游 SSE、错误映射 |
| `services/provider-client.js` | 复用 `normalizeBaseUrl` 与 10 秒超时常量 |
| `services/upstream-guard.js` | 调用上游前的 SSRF 地址校验 |
| `services/encryption.js` | 解密 `api_key_encrypted` |
| `services/settings-store.js` | `allowChat` 开关 |

## 2. 端到端时序

```text
浏览器                          routes/chat.js                 services                上游 AI
  │                                 │                            │                     │
  ├─ POST /api/chat/completions ───▶│                            │                     │
  │  (Cookie + X-CSRF-Token)        │ 1. isChatAllowed?          │                     │
  │                                 │ 2. message 校验(≤4000)     │                     │
  │                                 │ 3. resolveModel(modelId)   │                     │
  │                                 │ 4. resolveConversation ───▶│ createConversation  │
  │                                 │ 5. appendMessage(user) ───▶│ INSERT user 消息    │
  │                                 │ 6. conversationHistory ───▶│ 取最近 20 条+system │
  │                                 │ 7. complete():             │                     │
  │                                 │    decrypt apiKey ────────▶│ AES-256-GCM         │
  │  ◀── 200 text/event-stream ─────┤    flushHeaders            │                     │
  │  ◀── data: {"type":"start"} ────┤                            │                     │
  │                                 │    POST {base}/chat/completions ─────────────────▶│
  │                                 │    (stream:true, Bearer)   │                     │
  │  ◀── data: {"type":"delta"} ────┤    ◀── SSE chunks ──────────────────────────────┤
  │  ◀── ... (多次 delta) ...       │                            │                     │
  │                                 │    appendMessage(assistant)│ INSERT assistant    │
  │  ◀── data: {"type":"done"} ─────┤                            │                     │
  │  ◀── data: [DONE] + 连接关闭 ───┤                            │                     │
```

非流式（`stream:false` 或未传）：跳过 SSE 头与帧，直接返回一段 JSON；**上游请求永远用 `stream:true` 发起**（服务端自己聚合）。

## 3. 模型解析顺序（chat-store.js:77–96）

| 优先级 | 条件 | 结果 |
|---|---|---|
| 1 | 请求带 `modelId` | 查 `models.id = ? AND enabled = 1`（join provider）；找不到 → 400 `MODEL_NOT_AVAILABLE` |
| 2 | 未带/空 | 取"启用的模型中 `is_default DESC, id ASC` 第一个"（即全局默认模型） |
| 3 | 仍没有 | 400 `NO_AVAILABLE_MODEL`（"还没有可用模型，请先在后台启用并设置默认模型"） |

要点：

- 请求里的 `modelId` 是 **models 表主键**（内部 id），不是上游模型名；上游名取自 `model_id` 列；
- 会 join `api_providers` 拿到 `base_url` 与 `api_key_encrypted`；
- **不会读取 `conversations.model_id`**：换会话后不会自动沿用上次模型（根 README 已列为已知限制，现状仍然如此）；`touchConversation` 只是把本次模型记到会话上供展示。

## 4. 会话解析与标题

| 输入 | 行为 |
|---|---|
| `conversationId` 为空/0/缺省 | 自动新建会话，标题 = `autoTitle(message)`：去掉换行、trim 后取前 **20 个码位**，空则"新的对话"；创建时若带 `modelId` 且模型已启用则写入 `model_id` |
| 非空 | `parseId` + 归属校验；会话不存在/不属于当前用户 → **404**（不泄露存在性） |
| 标题重命名 | `PATCH /api/chat/conversations/:id`，1–40 字 |

## 5. 上下文构造（chat-store.js:152–158）

```js
// 实际上就是这一句拼装
[
  { role: 'system', content: '你是尘龙，一个温柔、简洁的中文 AI 助手。' },
  ...最近 20 条消息（含刚写入的这条用户消息）
]
```

- 取法：`SELECT role, content ... ORDER BY id DESC LIMIT 20`，再 `reverse()` 恢复正序；
- **没有 token 预算控制**：只按条数截断。极端情况下 20 条 × 4000 字可能超出上游上下文窗口，结果是上游返回错误 → SSE `error` 帧；
- 没有摘要/压缩，没有可配置 system prompt，没有多轮附件。

## 6. SSE 帧协议（本项目自定义）

响应头（chat.js:69–74）：

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

每帧格式：`data: <JSON>\n\n`（最后补一帧 `data: [DONE]` 后关闭连接）。

| 帧 type | 字段 | 时机 |
|---|---|---|
| `start` | `conversationId`、`userMessageId`、`modelName` | 响应头 flush 后立即发（此时用户消息已落库） |
| `delta` | `content`（增量文本） | 每收到上游一段增量就发一次 |
| `done` | `conversationId`、`assistantMessageId`、`content`（完整文本） | 上游正常结束且助手消息已落库后 |
| `error` | `code`、`message` | 上游/解密/地址策略等失败；发完接 `[DONE]` |

原始流示例：

```text
data: {"type":"start","conversationId":7,"userMessageId":21,"modelName":"gpt-4o-mini"}

data: {"type":"delta","content":"你"}

data: {"type":"delta","content":"好"}

data: {"type":"done","conversationId":7,"assistantMessageId":22,"content":"你好"}

data: [DONE]
```

> 没有心跳注释帧（`: ping`）：上游或反代如果长时间静默，连接可能被中间层掐断。生产部署时注意反代 idle timeout 要大于最长生成时间。

## 7. 上游客户端细节（chat-client.js）

| 项目 | 行为 | 位置 |
|---|---|---|
| 请求 URL | `{baseUrl}/chat/completions`（baseUrl 已去尾斜杠） | chat-client.js:104 |
| **没有 `/v1` 回退** | 模型发现会试 `/models` 与 `/v1/models`，但聊天固定拼 `/chat/completions` → **Base URL 必须自己带 `/v1`（如果上游需要）** | chat-client.js:104 |
| 请求头 | `Authorization: Bearer <key>`、`Content-Type: application/json` | — |
| 请求体 | `{model, messages, stream:true}` | chat-client.js:124–126 |
| 建连超时 | 10 秒（`AbortSignal` + 定时器），**只管到响应头返回** | chat-client.js:4,129 |
| 读取空闲超时 | 建连后若 **60 秒**没有收到任何数据即中断（`CHAT_STREAM_IDLE_TIMEOUT_MS` 可覆盖）；返回 error 帧并保留已收到内容 | chat-client.js:11–18,169–251 |
| 重定向 | `fetch` 使用 `redirect:'error'`，上游 3xx 一律拒绝（防公网地址 302 到内网），错误信息"上游地址发生了重定向…" | chat-client.js:9,20–25,146–155 |
| SSE 解析 | 按行切、只处理 `data:` 开头、忽略注释/空行、遇到 `[DONE]` 停 | createSseParser（49–90） |
| 增量字段 | `choices[0].delta.content` → `message.content` → `text` 依次尝试 | contentFromPayload（22–31） |
| 上游错误帧 | `payload.error`（string / message / messages[0].message）即中断并作为错误返回 | errorFromPayload（33–45） |
| 兜底 | 若整段没有 delta，把 RAW 文本当 JSON 再解析一次（兼容忽略 stream 的上游）；原文最多保留 200 KB | chat-client.js:200–212 |
| 空内容 | 返回 `UPSTREAM_ERROR`："上游未返回内容" | chat-client.js:212 |
| 调用方取消 | 返回 `{aborted:true, content:部分内容}`，不抛异常 | chat-client.js:130/192 |

## 8. 客户端断连处理（chat.js:48–56, 100–110）

- 只监听 `res.on('close')`（Node 24 里 `req` 的 close 会在请求体读完就触发，不可靠——代码注释已说明）；
- 断连 → `clientGone = true` → `controller.abort()` → 上游 reader cancel；
- 若已收到**非空**内容：**照样落库**为 assistant 消息，并 `touchConversation`，日志：
  `[chat] 客户端断开，已保存部分回复：conversation=<id> message=<id> 字数=<n>`；
- 若无内容：不落库；
- 断连后不再写任何帧（连接已断）。

## 9. 错误映射

| 场景 | 流式 | 非流式 |
|---|---|---|
| `allowChat=false` | HTTP 403 `CHAT_DISABLED`（在 SSE 之前拦下） | 同左 |
| 无可用模型/模型不可用 | 400 `MODEL_NOT_AVAILABLE` / `NO_AVAILABLE_MODEL` | 同左 |
| 会话不存在 | 404 | 同左 |
| API Key 解密失败 | error 帧 `UPSTREAM_ERROR` + [DONE] | 502 |
| 上游地址被 SSRF 拦截 | error 帧（"该地址指向内网或保留地址，已拒绝"） | 502 |
| 上游 401/403 | error 帧"密钥无效或无权限" | 502 |
| 上游 404 | error 帧"接口地址不存在，请检查 Base URL" | 502 |
| 上游 429 | error 帧"上游限流，请稍后再试" | 502 |
| 上游 5xx | error 帧"上游服务异常（HTTP xxx）" | 502 |
| 建连超时 | error 帧"连接超时（10 秒）" | 502 |
| 上游重定向 | error 帧"上游地址发生了重定向，出于安全考虑已拒绝，请直接填写最终地址" | 502 |
| 流空闲超时 | error 帧"上游长时间没有返回数据，已中断（60 秒无数据）"，已收到内容保留 | 502 |
| 连不上（DNS/拒绝连接） | error 帧"无法连接该地址，请检查 Base URL 与网络" | 502 |
| 读流中断 | error 帧"上游连接中断，请稍后再试" | 502 |
| 上游空内容 | error 帧"上游未返回内容" | 502 |
| 上游 error payload | error 帧带上游 message | 502 |

> 流式失败时 HTTP 状态已经是 200（响应头早早发出），**错误只能靠 `type:"error"` 帧表达**——前端必须处理该帧，不能只看 HTTP 状态。

## 10. 数据一致性

1. **用户消息先落库**再调上游：上游失败时，用户消息与会话仍然存在（"发了但没回"），刷新页面能看到；
2. 助手消息只在**成功**或**断连且有部分内容**时落库；失败不落；
3. `conversations.updated_at` 与 `model_id` 只在成功/断连部分落库时更新（`touchConversation`）；
4. 用户消息与助手消息是两条独立 INSERT，**没有包在一个事务里**；进程在校验后崩溃会留下"半个回合"（可接受，数据库一致）；

> 第三批起持久化在 **PostgreSQL**（`messages` 表，IDENTITY 主键）；INSERT 使用 `RETURNING id` 取新消息 id，所有 DB 调用都是 async/await。
5. 重试同一请求会**再写一条用户消息**（接口无幂等键）——前端不要盲目自动重试聊天请求（CSRF 403 的重试发生在写入之前，是安全的）。

## 11. 已知限制与改进建议

1. **流空闲超时已实现**（默认 60 秒无数据即中断，`CHAT_STREAM_IDLE_TIMEOUT_MS` 可调）；仍缺：上游以极慢速率持续吐字时不会触发（按"无数据"计），也没有自动重试/退避；
2. **没有 token 预算与上下文压缩**：仅按 20 条截断，长消息组合可能超上游上下文；
3. **没有使用量统计**：不记录 prompt/completion tokens、耗时、finish_reason，无法做成本分析；
4. **没有模型回退**：默认模型挂了不会自动切备用模型；
5. **没有重试/退避**：429/5xx 直接失败，用户需手动重发；
6. **没有可配置 system prompt / 站点级人格**（当前硬编码在 chat-store.js:3）；
7. **Base URL 必须自带 `/v1`（聊天路径无回退）**，这是配置时最常见的坑；
8. 只支持文本消息，不支持图片/工具调用/结构化输出；
9. 停止生成后前端与后端状态可能不同步：前端丢弃本地流，后端可能已保存部分回复（重新拉消息列表即可对齐，见 [05](05-frontend.md)）。