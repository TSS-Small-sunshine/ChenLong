# 07 安全机制

> 本章回答：**这个项目在安全上做了什么、没做什么、部署时还要补什么。**
> 结论依据：`server/middleware/`、`server/services/`、`server/routes/` 的实际实现 + 运行核查（见 [09](09-status-and-gaps.md)）。

## 1. 威胁模型与边界

- 部署形态：单体、同源、私有部署，管理员是最高权限（可配置上游、看全站聊天、管用户）；
- 主要威胁：未授权访问、越权（普通用户拿管理员能力/看他人会话）、CSRF、撞库与暴力破解、XSS（前端渲染用户内容）、API Key 泄露、SSRF（管理员被诱导配置内网地址）、会话劫持；
- **不在防护范围**：DDoS、供应链攻击、物理安全、主机失陷、恶意管理员（管理员权限本身就是完全信任）、多租户隔离。

## 2. 认证与会话

| 措施 | 实现 | 位置 |
|---|---|---|
| 密码哈希 | bcrypt cost=10 | auth.js:16、profile.js、users.js |
| 会话固定防护 | 登录/注册成功先 `session.regenerate()` 再写 userId | auth.js:30–40 |
| 账号枚举防护 | 用户不存在时也跑一次 bcrypt 比对（`burnPasswordCompare`）抹平时间差；错误文案统一"用户名或密码错误" | auth.js:20–24, 96–101 |
| Cookie 属性 | `httpOnly`、`sameSite=lax`、7 天；生产环境自动 `secure` | app.js:129–134 |
| 会话存储 | SQLite（`sessions` 表），重启不掉线 | services/session-store.js |
| 每请求校验 | `attachUser` 每次按 session.userId 查库；用户被禁用/删除 → 销毁 session，按匿名继续 | middleware/auth.js:8–26 |
| 登出 | 销毁会话 + 清 Cookie | auth.js:111–119 |

**弱点与边界**：

- 没有绝对会话超时（只有 7 天滑动过期）、没有"登出全部设备"、没有会话列表管理；
- **管理员重置密码不会踢掉目标用户已登录会话**（他还能用旧会话直到过期）；
- 管理员禁用账号是**下一次请求才生效**（attachUser 销毁会话），不会立刻断开在途 SSE；
- 没有登录失败次数锁定（只有 IP 限流 10 次/5 分钟），分布式/慢速撞库仍可能；
- 没有 MFA、没有邮箱验证、没有找回密码流程。

## 3. 授权与越权防护

| 规则 | 实现 |
|---|---|
| 后台接口必须管理员 | 各路由 `router.use(requireAdmin)`；`requireAdmin` 未登录 401、非管理员 403（middleware/admin.js） |
| 会话归属 | 聊天路由所有 `:id` 操作都带 `AND user_id = ?`，非本人一律 **404**（不泄露存在性） | 
| 管理员不能自改角色/状态 | 400 `CANNOT_MODIFY_SELF`（users.js:157,163） |
| 不能移除最后一个启用管理员 | 400 `LAST_ADMIN`（users.js:169–179） |
| 管理接口限流 | 重置密码 10 次/分钟/管理员（防批量改密） |
| 用户管理不做硬删除 | 只有禁用/改角色，降低误删风险 |

**实现级注意**：`LAST_ADMIN` 保护在 HTTP 层实际不可达（管理员改自己会先被 `CANNOT_MODIFY_SELF` 拦住），只剩数据库脚本层有意义——这不是漏洞，是防御冗余。

## 4. CSRF

双重条件：**token 存 session** + **请求头 `X-CSRF-Token` 与 session 中 token 定长比较**（`timingSafeEqual`）：

- 适用：`/api` 下所有非 `GET/HEAD/OPTIONS` 方法，**包括登录、注册、登出**；
- 获取：`GET /api/csrf-token`（该端点自身必须在 CSRF 校验之前挂载，否则首屏取不到 token）；
- 失效：登录/注册后 session 重建 → 旧 token 失效，响应返回新 token；前端 `fetchJSON` 收到 403 `CSRF_INVALID` 会清缓存、重取、**自动重试一次**；
- 为什么用请求头：跨站表单无法自定义请求头；配合 `sameSite=lax` Cookie 形成双保险。

**边界**：token 只防跨站写请求；XSS 一旦发生可直接读页面内存/发同源请求，CSRF 帮不上。

## 5. 限流

内存滑动窗口（`Map<key, 时间戳数组>`），超限 429 + `Retry-After` + `X-RateLimit-*`：

| 范围 | 上限 | 维度 |
|---|---|---|
| 全局写请求 | 300/分钟 | IP |
| 登录 | 10/5 分钟 | IP |
| 注册 | 5/10 分钟 | IP |
| 管理员重置密码 | 10/分钟 | 管理员用户 |
| 聊天补全 | 20/分钟 | 登录用户（未登录用 IP 兜底） |

- 生产强制开启（`isRateLimitEnabled` 判断 `NODE_ENV=production` 直接 true）；
- 开发可用 `RATE_LIMIT_ENABLED=0/false` 关闭；
- 清理：定时淘汰过期 key（`unref`，不阻止退出）。

**局限**：内存态、按进程计数——多实例部署时额度会被放大 N 倍；重启即清零；没有基于账号的锁定。

## 6. 密钥与 API Key 管理

| 项目 | 设计 |
|---|---|
| 上游 API Key | 落库前用 **AES-256-GCM** 加密，格式 `v1:<iv b64>:<tag b64>:<cipher b64>`；任何接口只返回掩码 `sk-…abcd`（key-mask.js） |
| 密钥来源 | `ENCRYPTION_KEY`：32 字节，接受 64 位 hex 或 base64；格式错误抛明确错误 |
| 会话密钥 | `SESSION_SECRET`：任意足够长的随机串 |
| 开发兜底 | 缺密钥时生成到 `data/.dev-secrets.json`（**明文**、已 gitignore、权限 0600、原子写入、损坏则不覆盖直接退出） |
| 生产行为 | 缺任一密钥 → `[FATAL]` 并 exit(1)，绝不自动生成 |
| 解密失败 | 不泄露细节，返回"API Key 解密失败，请重新保存该服务的密钥"，管理员在后台重存即可 |
| 日志 | 不打印 Key、密码、Cookie；上游报错只记 URL/状态/前 300 字符响应 |

- **启动自检（已实现）**：`ensureSecrets` 之后执行 `encryption.verifyKey()` 哨兵自检（encrypt→decrypt 固定值）；密钥格式错误/不可用时 `[FATAL]` 并 exit(1)，不会再出现"服务正常启动、首次保存 Key 才 500"；

**最关键的运维事实**：**`ENCRYPTION_KEY` 丢失 = 所有已存 API Key 永久不可解密**（没有 key 轮换/恢复机制）。备份数据库时必须一并备份密钥。

## 7. SSRF 防护（上游地址）

`services/upstream-guard.js` 在两处生效：保存/修改 API 服务时（providers.js）与每次真实调用上游前（provider-client / chat-client）。

| 检查 | 内容 |
|---|---|
| 协议 | 只允许 `http://` / `https://`（normalizeBaseUrl） |
| IP 字面量 | 命中内网/保留/组播/回环段 → 拒绝（`BLOCKED_V4`/`BLOCKED_V6` 黑名单：0.0.0.0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.2/24、192.88.99/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、224/4、240/4、::、::1、64:ff9b::/96、2001:db8::/32、fc00::/7、fe80::/10、ff00::/8；IPv4 内嵌 IPv6 也检查） |
| 主机名 | `localhost`、`*.localhost`、纯数字/0x 十六进制主机名 → 拒绝 |
| 域名 | DNS 解析**全部**记录，任一条命中内网段即拒绝；解析失败放行（真实请求也会失败，交给上游错误路径） |
| 开发放行 | `ALLOW_PRIVATE_UPSTREAM=1/true` 可放行内网（**生产环境强制忽略此开关**） |
| 错误 | 400 `UPSTREAM_BLOCKED`"该地址指向内网或保留地址，已拒绝" |

### 残余风险（重要）

- ✅ **HTTP 重定向（已修复）**：上游 `fetch` 已改为 `redirect: 'error'`（`provider-client.js`、`chat-client.js`），3xx 一律拒绝并返回明确错误，堵住"公网地址 302 到内网"的绕过；
- ⚠️ **DNS rebinding / TOCTOU（残余）**：校验时解析一次、真正 `fetch` 时再解析一次，攻击者可用响应变化的 DNS 绕过（概率低但存在）；
- ⚠️ **域名解析失败时放行**（依赖后续请求失败）属可接受的降级。

## 8. 浏览器侧防护

| 措施 | 值 |
|---|---|
| CSP | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'` |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `SAMEORIGIN`（与 CSP frame-ancestors 双保险，防点击劫持） |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| X-XSS-Protection | `0`（现代浏览器应关闭旧过滤器，依赖 CSP） |
| HSTS | `max-age=15552000`（180 天），**仅当 `req.secure` 为真时发送** |
| x-powered-by | 关闭（不暴露 Express） |
| CORS | 未开启（同源设计，天然拒绝跨域读取） |

- **API 响应已统一加 `Cache-Control: no-store`**（`app.js` 的 `/api` 中间件）：用户/会话/设置等敏感 JSON 不进入浏览器/代理缓存；静态资源保持默认缓存策略。

配套前端约束：CSP 禁止内联脚本，所以页面里不能写 `<script>...</script>` 内联逻辑（必须外部 JS）；样式允许内联（`style="..."` 与 `<style>` 可用）。

## 9. 输入校验与数据安全

| 维度 | 规则 |
|---|---|
| 用户名 | `^[A-Za-z0-9_]{3,24}$` |
| 密码（注册/自助改） | 6–64 字符（仅长度，无复杂度要求） |
| 密码（管理员重置） | **8–32 字符且必须同时含字母与数字**（与上面的规则不一致，见 [10](10-conventions-and-glossary.md)） |
| 昵称 | trim 后 1–20 字 |
| 消息 | trim 后 1–4000 字 |
| 会话标题 | 1–40 字 |
| 站点设置 | siteName≤40、subtitle≤60、announcement≤200、logo≤200 且前缀白名单 |
| 请求体 | 1 MB；非法 JSON 400 `INVALID_JSON` |
| SQL 注入 | 全部参数化；LIKE 搜索转义 `% _ \` |
| 响应泄露 | 400/401/403/404 只回文案；500 生产不回堆栈；密码哈希/加密 Key 永不出现在响应 |
| 404 防枚举 | 他人会话、不存在的 id 统一 404（后台则区分"会话不存在"与"用户不存在"，管理员可见） |

> 明文内容（聊天消息、站点设置）直接落 SQLite，**没有字段级加密**；数据库文件被拿走 = 聊天内容全部泄露（但 Key 仍安全）。

## 10. 日志与可观测性

- 日志全部走 `console`（stdout/stderr），无结构化日志、无请求 ID；
- 会记录：启动/关闭、DB 失败、上游失败（URL/状态/耗时/错误码）、断连部分保存、限流清理异常；
- **不记录**：密码、Key、Cookie、消息正文；
- 没有访问日志、没有审计日志（谁改了谁、谁重置了密码、谁删了会话都无记录）；
- 建议（见 [09](09-status-and-gaps.md)）：加请求 ID + 访问日志 + 管理操作审计表。

## 11. 生产部署安全清单

- [ ] `NODE_ENV=production`（强制安全 Cookie + 强制限流 + 隐藏错误细节）
- [ ] `SESSION_SECRET` 与 `ENCRYPTION_KEY` 用真正随机值写入环境变量（不是 .dev-secrets.json）
- [ ] 前置 HTTPS（Nginx/Caddy/ALB），并设置 `TRUST_PROXY=1` 让 `req.secure` 与 `req.ip` 正确（否则 HSTS 不生效、限流按代理 IP 计数）
- [ ] `ADMIN_PASSWORD` 首次启动后立即修改；不要保留默认弱口令
- [ ] 数据库文件与备份目录仅运行用户可读；`.env` 权限收紧
- [ ] 备份数据库**同时**备份 `ENCRYPTION_KEY`，并验证恢复流程
- [ ] 进程守护（systemd/PM2/NSSM）+ 崩溃自动重启；监听 127.0.0.1 由反代对外
- [ ] 反向代理设置合理的 idle/read timeout（大于最长流式生成时间），并关闭对 SSE 的缓冲（`proxy_buffering off`；应用已发 `X-Accel-Buffering: no`）
- [ ] 监控 `/api/health`；日志集中收集
- [ ] 定期升级依赖（当前锁定 express 5.x / better-sqlite3 13.x，无自动更新流程）
