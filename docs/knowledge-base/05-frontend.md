> 知识库整理于 2026-11-15（已同步第二批前端/后端修复），基于代码现状；与 README 冲突时以代码为准。

# 05 · 前端（public/）：页面、脚本、设计系统与接口

## 目录

1. 页面清单与文件映射
2. public/js 模块职责
3. 公共库 CL（app.js）
4. 鉴权与页面守卫（guard.js / auth.js）
5. 聊天页（chat.html + chat.js）
6. 后台各页脚本与代码模式
7. 设计系统（common.css 与页面级 CSS）
8. 前后端接口调用对照表
9. 前端已知限制与坑

---

## 1. 页面清单与文件映射

全站 11 个 HTML、11 个 JS、4 个 CSS；无框架、无构建工具、无 CDN、**无任何内联 `<script>` 与 `onclick=` 属性**（全量 grep 结果为 0），事件全部 `addEventListener` 绑定，符合服务端 CSP `script-src 'self'`。

| 路径 | 标题/用途 | CSS | JS（按加载顺序） | body 守卫 | 游客可见 |
|---|---|---|---|---|
| `public/index.html:1` | "尘龙 ChenLong · 你的小小 AI 伙伴"，营销首页（hero/能力卡/角色/FAQ/CTA） | `css/common.css:9` `css/home.css:10` | app/auth/guard（274-276） | 无 `data-guard` | ✅ 双态导航 |
| `public/chat.html:1` | "对话 · 尘龙 ChenLong"，SSE 聊天 | `css/common.css:9` `css/chat.css:10` | app/auth/guard/chat（136-139） | 无 `data-guard` | ✅ 可看不可发 |
| `public/login.html:1` | "登录 · 尘龙 ChenLong" | `css/common.css:9` | app/auth（66-67） | 无 | ✅ |
| `public/register.html:1` | "注册 · 尘龙 ChenLong" | `css/common.css:9` | app/auth（75-76） | 无 | ✅ |
| `public/user.html:1` | "用户中心"，改昵称/改密码/资料卡；两处头图 logo 已接 `data-site-logo`（`user.html:21,197`） | `css/common.css:9` | app/auth/guard（228-230） | `auth`（`user.html:11`） | ❌ 未登录跳登录页 |
| `public/admin/admin.html` | 仪表盘 | common+admin（9-10） | app/auth/guard/admin/admin-dashboard（180-184） | `admin`（12） | ❌ |
| `public/admin/api.html` | API 管理 | 同上 | …/admin/api.js（176-180） | `admin`（12） | ❌ |
| `public/admin/models.html` | 模型管理 | 同上 | …/admin/api.js/models.js（182-187，**api.js 必须先于 models.js**） | `admin`（12） | ❌ |
| `public/admin/users.html` | 用户管理 | 同上 | …/admin/admin-users.js（213-217） | `admin`（12） | ❌ |
| `public/admin/data.html` | 聊天数据（只读） | 同上 | …/admin/admin-data.js（148-152） | `admin`（12） | ❌ |
| `public/admin/settings.html` | 系统设置 | 同上 | …/admin/admin-settings.js（202-206） | `admin`（12） | ❌ |

* 页面类型差异：`index/chat/login/register` 无静态守卫；`user` 用 `data-guard="auth"`；6 个后台页用 `data-guard="admin"`。
* **脚本契约**：`app.js` 必须最先加载（提供 CL）；`auth.js` 次之（guard.js 依赖 `CL.auth.me`，见 `guard.js:3`）；`guard.js` 再次；页面脚本最后。
* 登录态 UI 由 `[data-guest-only]` / `[data-auth-only]` 控制（`guard.js:42-43`），CSS 兜底 `common.css:581-582`（`[hidden]{display:none!important}` 与 `is-guard-pending` 期间 `visibility:hidden` 防闪烁）。
* 后台页没有 `.cl-header`，改用 `.admin-shell/.admin-nav/.admin-main/.admin-topbar/.admin-content`（`admin.html:13-62`），这一结构差异直接导致公告条需要"打补丁"（见 §6.5、§9）。
* 登录/注册页**不加载 guard.js**，已登录用户访问登录页不会被弹回（`auth.js` 只处理表单提交）。

---

## 2. public/js 模块职责

| 文件 | 类型 | 暴露 | 职责 | 关键依赖/证据 |
|---|---|---|---|---|
| `app.js` | 公共库（全站） | `window.CL`（16 个成员） | DOM 助手、时间格式化、toast、确认框、fetchJSON、CSRF、设置渲染、导航/抽屉/弹窗/自适应等交互 | 导出清单 `app.js:780-791` |
| `auth.js` | 公共库（全站） | `CL.auth` | 登录/注册/登出/资料/改密接口 + 表单校验 + 注册开关 + 回跳规则 | `auth.js:441-445`；依赖 `CL.fetchJSON/CL.csrf/CL.guard` |
| `guard.js` | 公共库（除登录/注册页） | `CL.guard` | 读 `body[data-guard]`，调 `GET /api/auth/me` 判定，渲染 `data-user-*`，跳登录 | `guard.js:110-124` |
| `chat.js` | 页面脚本（chat.html） | `CL.chat`（接口封装导出） | 聊天状态机、SSE 解析、会话 CRUD、游客视图 | `chat.js:228`；依赖 `CL.guard.ready`（`chat.js:982`） |
| `api.js` | 页面脚本（api.html，并供 models.html） | `CL.api` | `/api/providers` 接口封装 + api.html 页面控制 | `api.js:85` |
| `models.js` | 页面脚本（models.html） | `CL.models` | `/api/models` 接口封装 + 页面控制；**运行时调用 `CL.api.list()`** `models.js:433-434` |
| `admin.js` | 死代码骨架 | `CL.admin` | 全部方法是 `throw new Error('尚未接入后端…')`，无任何页面调用 | `admin.js:12-14, 81`；全站 grep 只有自身引用 |
| `admin-dashboard.js` | 页面脚本 | `CL.statsApi` | `GET /api/admin/stats` + 仪表盘渲染 | `admin-dashboard.js:294` |
| `admin-users.js` | 页面脚本 | `CL.usersApi` | `/api/users` 列表/详情/改角色/重置密码 + 3 个弹窗 | `admin-users.js:573` |
| `admin-data.js` | 页面脚本 | `CL.conversationsApi` | `/api/admin/conversations` 列表 + 消息抽屉 | `admin-data.js:478` |
| `admin-settings.js` | 页面脚本 | `CL.settingsApi` | `GET/PATCH /api/settings` + 差量保存 | `admin-settings.js:296` |

* 只有 `app.js / auth.js / guard.js` 是真正的公共库；其余都是"IIFE + 立即接管 DOM"的页面脚本（入口统一为 `DOMContentLoaded` 或立即执行，如 `api.js:532-533`）。
* 后台 6 个页面脚本都直接 `CL.fetchJSON`，没有统一的 admin 请求层；`admin.js` 的 `CL.admin` 是历史骨架，**未被任何页面使用，但仍被 6 个后台页加载**（见 §9-14）。

---

## 3. 公共库 CL（app.js，795 行）

### 3.1 初始化时序

1. IIFE 执行：`resolveBase()` 定位站点根（`app.js:20-34`，优先 `document.currentScript.src`，兜底扫描 `/js/app.js`）→ `CL.url/CL.go`（`73-78`）。
2. 定义全部工具函数与组件。
3. **立刻**发起 `GET /api/settings`：`CL.settings.ready = loadSettings()`（`app.js:773-778`），此时 DOMContentLoaded 可能尚未触发。
4. DOM 就绪后执行 `init()`（`793-794`），顺序为 `initHeaderNav → initChatDrawer → initPendingForms → initAdminDrawer → initModals → initPendingActions → initSuggestions → initChatEntry → initAutosize → flushFlash`（`app.js:759-770`）。
5. 因此每个页面首屏至少有 **2 个并发请求**：`/api/settings`（`app.js:777`）与 `/api/auth/me`（`guard.js:121` / `auth.js:50`）。

### 3.2 CL.settings 与设置渲染

* 内置默认值 `SETTING_DEFAULTS`：`siteName 尘龙 ChenLong`、`siteSubtitle Your Little AI Companion`、`allowRegister/allowChat true`、`announcement ''`、`logo '/assets/mascot/logo.png'`（`app.js:413-420`）。
* `normalizeSettings()` 兼容 `{items}`/`{data}` 两种信封、字段缺失/类型不对一律回退默认值（`448-459`）；`settingBool` 兼容 `true/1/'1'/'true'`（`431-435`）。
* **`paintSiteName` 按第一个空格拆两行**：`head = name.slice(0,at)`、`tail = name.slice(at+1)`，写入首个文本节点与 `node.querySelector('em')`（`462-476`）。这就是 README「站点名含空格会被拆成主标题+副标题」的代码根源；页脚 `<span data-site-name>` 无 `em`，于是整串直出（`index.html:268`）。
* `settingLogo()` **放行两类地址**：`/` 开头且不是 `//` 的站内路径、`http(s)://` 绝对地址；其它 scheme 与协议相对地址一律回退默认 logo（`439-446`）。后台设置页（`admin-settings.js:15`）与后端（`server/services/settings-store.js:18`）同样放行 http(s)，因此外链 logo 现在可以生效（§9-1 已修复），而 `javascript:`/`data:` 等仍被拒绝。
* `logoSrc()` 决定 `<img src>`：`http(s)://` 原样使用、`/` 开头原样使用、其余补 `CL.url`（`479-482`），避免外链被 CL.url 二次拼接；`paintSiteLogo` 先 `hidden=true`，`load` 成功才显示并给 `.cl-logo__mark` 加 `has-img`，`error` 时移除 src（`485-498`）；CSS 对应 `common.css:597-599`。
* 公告：`announceSlot()` 五级回退定位插入点（`.cl-header` → `.chat-topbar` → `.auth .cl-card` → `.cl-logo` → `main.firstChild`，`505-517`）；插入后渲染 `.cl-announce`，关闭写 `sessionStorage['cl:announce-dismissed']`（`519-533`）。后台页没有 header/chat-topbar，于是落进侧栏品牌链接（见 §6.5）。
* 渲染失败被 `try/catch` 吞掉，不影响页面其余部分（`535-542`）；`loadSettings` 失败也 `resolve` 默认值，**Promise 永不 reject**（`545-555`），所以各页只需 `CL.settings.ready.then(...)`。

### 3.3 fetchJSON 封装（app.js:335-377）

| 关注点 | 实现 | 位置 |
|---|---|---|
| 请求体 | 非 FormData/Blob/string 自动 `JSON.stringify` 并补 `Content-Type` | 343-346 |
| 凭据 | `credentials: 'same-origin'`（Cookie 会话） | 348 |
| CSRF | 非 GET/HEAD 前先 `await attachCsrfToken` 加 `X-CSRF-Token` | 351-353, 379-388 |
| 403 重试 | 仅 `CSRF_INVALID` 时清 token、重取、**重放同一份 opts，只重试一次** | 358-364 |
| 错误信封 | `parseErrorPayload` 解 `{error:{code,message}}`，兼容 `data.message/msg/code`、纯字符串 | 266-283 |
| 401 | 默认跳登录；`noAuthRedirect:true` 时不跳（游客页/me()） | 365-374 |
| 网络错误 | 包成 `status=0` 的中文错误「无法连接服务器…」 | 391-400 |
| 响应解析 | 先 `response.text()` 再 `JSON.parse`，失败则保留文本 | 402-407 |

* 抛出的 Error 附带 `status / code / data / url` 四个字段（`368-373`），页面脚本据此分支（如 `chat.js:578` 的 `err.status === 401`）。
* CSRF 令牌**只存内存**（`287`），并发共享同一 Promise（`291-316`），登录/注册成功后用响应里的新 token 覆盖（`auth.js:62,75`），登出时清空（`auth.js:85`）。服务端接口 `GET /api/csrf-token`（`server/app.js:180-186`），校验逻辑 `server/middleware/csrf.js:29-35`。

### 3.4 工具与交互组件清单

| 能力 | 函数 | 位置 | 备注 |
|---|---|---|---|
| 选择器/DOM | `CL.qs/qsa/el` | 36-65 | `el` 支持 `class/text/dataset` 与子节点 |
| 时间格式化 | `formatTime(value, mode)` | 103-122 | auto/ datetime/date/time/month-day；兼容 `YYYY-MM-DD HH:mm:ss` |
| Toast | `toast(msg,type,duration)` | 127-150 | 4 类型；自动建 `#cl-toasts`；默认 3200ms；点击关闭 |
| 二次确认 | `confirmDialog(msg, opts)` → Promise<boolean> | 164-231 | Esc/背景取消、焦点陷阱 Tab、恢复焦点、滚动锁 |
| 弹窗 | `openModal/closeModal/initModals` | 562-601 | 委托 `[data-modal-open]/[data-modal-close]/.cl-modal__backdrop` + Esc |
| 跨页提示 | `flash/flushFlash` | 246-262 | `sessionStorage['cl:flash']`，供登录/登出后落地页展示 |
| 滚动锁 | `lockScroll/unlockScroll` | 152-161 | 计数式，`body.cl-modal-open` |
| 头图导航 | `initHeaderNav` | 604-631 | 汉堡按钮、点外部/Esc 关闭 |
| 后台抽屉 | `initAdminDrawer` | 634-663 | >900px 自动收起 |
| 聊天会话栏 | `initChatDrawer` | 723-745 | 与 chat.js 共用 backdrop |
| 输入联想 | `initSuggestions` | 678-691 | `[data-suggest]` → `[data-suggest-target]` |
| 进聊天页 | `initChatEntry` | 692-707 | `[data-chat-entry]` → `chat.html?q=` |
| 文本域自适应 | `initAutosize` | 708-720 | `maxHeight` 截断 |
| 占位功能 | `initPendingActions/initPendingForms` | 666-677, 748-756 | 点击 toast「该功能尚未开放」 |

---

## 4. 鉴权与页面守卫

### 4.1 guard.js 判定流程（125 行）

1. 读 `LEVEL = body[data-guard]`（`guard.js:20`）；立即给 body 加 `is-guard-pending`，4 秒后兜底移除（`23-26`）。
2. `session()` 对 `CL.auth.me()` 做单例缓存；`err.status===401` 归一为 `null`（`64-74`）。
3. `run()`（`81-108`）：`auth`/`admin` 且无用户 → `redirectToLogin()`；`admin` 且 `role!=='admin'` → `CL.flash('需要管理员权限…')` + 跳登录；否则 `paint(user)`。
4. 异常分支：有守卫的页面 `flash` 后跳登录；无守卫页面只 toast（`98-106`）。
5. `paint()`（`40-62`）：切换 `[data-guest-only]`/`[data-auth-only]` 的 hidden；填充 `[data-user-nickname/username/avatar/role/id/created]`；头像取昵称首字大写，空则"尘"（`35-38`）；同步 `#profile-nickname-hint` 的默认文案。
6. `CL.guard = { level, session, paint, redirectToLogin, ready }`（`110-118`），`ready` 在 DOM 就绪时启动（`120-124`）——页面脚本可用 `CL.guard.ready` 复用同一次 `/api/auth/me`（`chat.js:981-989`、`admin-users.js:556-568`）。
7. `redirectToLogin()`（`28-33`）：`login.html?redirect=<pathname+search>`，已在 login.html 则不跳；用 `location.replace`。

### 4.2 auth.js（449 行）

| 能力 | 实现 | 证据 |
|---|---|---|
| 端点表 | me/login/register/logout/profile/password | `auth.js:14-21` |
| 登录 | POST → 写回 `csrfToken` → `location.assign(safeRedirect(redirectParam(), '/user.html'))` | `55-65` |
| 注册 | POST → 写回 token → 固定跳 `/user.html`（不消费 redirect） | `68-79` |
| 登出 | POST → `CL.csrf.clear()` → flash → 跳 `/` | `82-88` |
| 资料/改密 | PATCH `/api/user/profile`、`/api/user/password` | `90-102` |
| 回跳安全 | `safeRedirect`：必须 `/` 开头；含 `//`、`:`、`\` 一律拒绝；拒绝 `/login.html`、`/register.html` | `29-36` |
| 前端校验 | username 3–24、password 6–64、nickname 1–20；注册校验两次密码；`input` 事件清错 | `133-207, 329-331, 359-361` |
| 后端错误映射 | `USERNAME_TAKEN/INVALID_CREDENTIALS/REGISTER_DISABLED/VALIDATION_ERROR` → 落到对应字段 `.cl-hint`，定位不到才 toast | `214-242` |
| 防连点 | `submitOnce`：`dataset.busy` 锁按钮，文案"处理中…"，收尾恢复；`dataset.locked` 的按钮不重新启用 | `244-264` |
| 注册开关 | `CL.settings.ready` 且 `allowRegister===false` → 顶部插 `#cl-register-notice`、禁用全部字段 | `273-311` |
| 密码可见 | `[data-toggle-password]` 切换 input.type + `aria-pressed` | `426-436` |
| 退出登录 | 所有 `[data-logout]` 走 `CL.confirmDialog` 后调用 | `410-424` |

* `me()` 使用 `noAuthRedirect:true`，游客页（首页/聊天页）用它判断登录态而不会被 401 踢走（`auth.js:48-52`）。

### 4.3 游客与登录态差异

| 位置 | 游客 | 已登录 |
|---|---|---|
| 首页/用户中心头图 | `[data-guest-only]` 显示登录/注册（`index.html:33-46`） | `[data-auth-only]` 显示昵称+头像+退出（`index.html:35-46`） |
| user.html | 守卫直接跳登录页 | 渲染资料卡、改昵称/改密表单 |
| chat.html | 可看界面：模型下拉 `disabled`（`chat.js:343`）、提示"登录后即可发送消息"（`348`）；写操作先 `requireLogin()` 跳 `login.html?redirect=%2Fchat.html`（`chat.js:22, 301-312`） | 加载模型/会话/消息 |
| 后台 6 页 | 跳登录；`role!=='admin'` 也跳登录并 flash 提示（`guard.js:89-93`） | 正常渲染；侧栏 `.admin-nav__foot` 有统一「退出登录」按钮（`admin.html:37-39` 等 6 页，`admin.css:47-48` 定宽度），由 `auth.js:410-424` 绑定，退出后回首页 |
| 注册页 | 正常表单 | 仍显示表单（无守卫） |

---

## 5. 聊天页（chat.html 141 行 + chat.js 1017 行）

### 5.1 DOM 结构（chat.html）

| 区域 | 关键节点 | 行 |
|---|---|---|
| 左栏 `.chat-sidebar` | `#chat-sidebar`、新建 `[data-chat-new]`、搜索 `#chat-search`、历史 `#chat-history-list`、空态 `#chat-history-empty`/`#chat-history-noresult`、用户块 `[data-user-*]` | 14-56 |
| 主区 `.chat-main` | `.chat-topbar` 标题/副标题（62-63）、游客登录注册（66-67）、登录用户 chip+退出（68-72） | 58-75 |
| 消息区 | `#chat-messages` > `#chat-thread`（79）+ `.chat-empty` 欢迎态含 4 个 `[data-suggest]` 气泡（80-93） | 77-95 |
| 输入区 | `form.chat-composer`、`#chat-input[data-autosize]`、`#chat-model`、`.chat-stop`、`.chat-send`、`.chat-composer__hint` | 97-111 |
| 右栏 `.chat-aside` | `[data-chat-info=model|count|created|status]`、`[data-chat-dot]` | 114-131 |
| 移动端 | `[data-chat-sidebar-backdrop]` | 133 |

### 5.2 状态机（chat.js:233-250）

`state = { user, models[], modelId, conversations[], activeId, activeTitle, activeModelName, activeCreated, messages[], keyword, streaming, chatDisabled, controller, follow, searchTimer, loadToken }`。
`dom` 在 `cacheDom()` 一次性抓取（`271-294`）。`init()`（`991-1013`）：cacheDom → bindEvents → paintInfo/paintTopbar/updateComposer/setStatus('idle') → `watchChatSwitch()` → `readSession()`（优先 `CL.guard.ready`）→ 游客走 `renderGuestView()` 结束；否则 `Promise.all([loadModels(), loadConversations()])` → `prefillFromQuery()`（读 `?q=`，配合首页 `data-chat-entry`）。

### 5.3 SSE 帧读取与渲染（chat.js:76-225）

* 不用 `EventSource`，改 `fetch` + `response.body.getReader()` + `TextDecoder`（`200-214`），因为 POST 与 Cookie 场景 EventSource 不适用（注释 `chat.js:11`）。
* 请求体 `{ message, stream:true, conversationId?, modelId? }`，id 经 `toId` 数字归一（`30-35, 78-82`）。
* 流式请求同样手工带 `X-CSRF-Token`；`403 CSRF_INVALID` 时清 token 重取并**在解析流之前**重试一次，避免用户气泡重复插入（`84-125`）。
* 解析：`handleBlock` 取 `data:` 行、多行拼接、`[DONE]` 结束、JSON 解析失败静默丢弃（`167-181`）；`pump` 以空行切帧（`184-192`）；结尾补 `pump('\n\n')` 冲刷残帧（`209-211`）。
* 事件分发 `dispatch`（`141-164`）：`start` → 记录 conversationId/modelName；`delta` → 累积 content；`done` → 覆盖完整 content 与 assistantMessageId；`error` → 抛 `sse=true` 的 Error；未知 type 返回 false。
* 不支持流的环境降级为整体 `response.text()`（`194-199`）。

### 5.4 发送、停止与渲染

* `sendMessage()`（`756-881`）：登录→开关→streaming 互斥→非空→有模型；先 push 用户消息并追加气泡，再追加空 assistant 气泡加 `is-streaming`；`AbortController` 存 `state.controller`；`onEvent` 中 `delta` 实时写 `reply.text.textContent`（`815-819`），`done` 写入 messageId；成功补齐 `state.messages`。
* 失败分支（`842-870`）：`AbortError/stopped` → 气泡 `is-stopped` + 备注"已停止生成"；`CHAT_DISABLED` → 气泡 `is-error` + 置 `state.chatDisabled` + 禁用输入；其它 → 气泡备注"生成失败：…"；**已有部分内容仍 push 进 `state.messages`（id:null）**。
* `finally`（`871-879`）：复位 streaming/controller、`updateComposer()`、`paintInfo()`、状态回 `online`、`await loadConversations()`、`paintTopbar()`。
* `stopStreaming()` 仅 `controller.abort()`（`751-754`）；`updateComposer()` 统一计算 send/stop/model/input 的 disabled 与 hint 文案（`338-351`）。
* 自动滚动：`nearBottom()` 72px 阈值，用户上滚后 `state.follow=false` 不再抢滚动（`499-509, 913-915`）。

### 5.5 会话列表 CRUD 与模型下拉

| 动作 | 实现 | 证据 |
|---|---|---|
| 列表 | `GET /api/chat/conversations?keyword=`，按 keyword 过滤；空态区分"无会话"与"无匹配" | `555-585, 423-433` |
| 新建 | 纯前端清空（不建库），首条消息时后端建会话 | `612-619` |
| 打开 | `loadToken` 递增做竞态防护；加载失败也渲染空态并 toast | `621-650` |
| 重命名 | 行内 input（`maxlength 40`，与后端 `TITLE_MAX=40` 一致）+ 保存/取消；Enter 提交（`isComposing` 跳过输入法）、Esc 取消 | `652-717` |
| 删除 | `CL.confirmDialog`（danger）→ DELETE → 本地移除 + 若为当前会话则 reset | `719-746` |
| 模型下拉 | 游客显示"登录后可选择模型"；否则默认模型优先，保持已选；无模型显示"暂无可用模型" | `514-540` |
| 搜索 | 300ms 防抖后重新拉列表 | `23, 917-926` |
| 会话信息| `[data-chat-info=count/created/status]`，状态 idle/busy/online 三档 | `326-336, 353-357` |

### 5.6 异常路径汇总

| 场景 | 处理 | 证据 |
|---|---|---|
| 游客发送 | `requireLogin()` → `login.html?redirect=%2Fchat.html` | `301-312` |
| 空消息 | toast「请输入消息内容」并聚焦 | `763-768` |
| 无可用模型 | toast「暂无可用模型…」 | `769-772` |
| 回复中用户切换会话 | `stopStreaming()` 先中止 | `614, 623` |
| 会话列表 401 | 清空 user、切游客视图（不跳转，页面本就可游客浏览） | `576-582` |
| 模型列表 401 | 静默置空，不 toast | `546-549` |
| SSE error 帧 | 抛错进入失败分支，气泡标红 | `143-148, 857-862` |
| SSE 空闲超时 | 后端默认 60 秒无数据中断并发 error 帧（文案含「N 秒无数据」），前端走通用失败分支，已收内容保留 | `server/services/chat-client.js:12-17,234-243`；前端 `chat.js:857-870` |
| 上游重定向 | providers/chat 上游请求 `redirect:'error'` 拒绝 3xx，前端直接 toast 服务端文案 | `server/services/provider-client.js:66`、`server/services/chat-client.js:144` |
| 流中 CSRF 失效 | 仅重试一次，失败后按普通错误处理 | `115-124` |

---

## 6. 后台各页脚本与代码模式

### 6.1 共用骨架

6 个后台页结构完全一致：`.admin-shell > .admin-nav + .admin-main`，`.admin-main > .admin-topbar + main.admin-content`（`admin.html:13-62`）；导航项写死 6 个链接 + 返回前台 + **退出登录**（`users.html:23-40`，按钮在 `.admin-nav__foot`，`users.html:37-39`，6 页统一）；顶栏右侧仍只有"返回前台"+ 头像（`admin.html:57-60`）；用户信息在侧栏 `[data-user-nickname]/[data-user-role]`（`admin.html:43-44`）。
后台页普遍采用"**面板 + 内联表单 + 表格**"布局：页头 `.admin-page-head`（标题/描述/动作按钮）→ `.cl-panel`（表格 + `.admin-toolbar` 筛选 + `.admin-pager` 分页）；api/models 的编辑表单内联在 `.cl-panel` 中直接 `scrollIntoView`（`api.js:406`），users/data 才用 `.cl-modal`。

### 6.2 各页数据加载

| 页面/脚本 | 接口封装 | 首屏加载 | 交互后刷新 | 特有模式 |
|---|---|---|---|---|
| 仪表盘 `admin-dashboard.js` | `statsApi.get`（`32-39`） | `load(false)`（`291`） | 刷新按钮 `load(true)`（`284-289`） | `seq` 防竞态（`74, 244-249`）；`setBadge`；`formatUptime/formatSize`（`103-116`）；空态区块带跳转按钮（`125-137`） |
| API 管理 `api.js` | `CL.api` 8 个方法（`33-83`） | `loadList()`（`530`） | 每次增删改/启停/刷新模型后 `loadList` | 无分页、一次拉全量；`emptyTemplate` 克隆兜底（`138-169`）；`current` 保存后才有测试/刷新按钮（`491-522`） |
| 模型管理 `models.js` | `CL.models` 8 个方法（`26-82`） | `loadProviders()` + `loadList()`（`702-705`） | 筛选/搜索即查；同步后重载 | 筛选三条件（`148`）；搜索 300ms 防抖 + Enter（`573-595`）；`loadSeq` 防竞态（`448-466`）；`syncAll` 串行遍历启用服务（`537-562`） |
| 用户管理 `admin-users.js` | `usersApi` 4 个方法（`31-66`） | `boot()` 等 `CL.guard.ready` 后 `load()`（`555-570`） | 操作后 `load()` | `PAGE_SIZE=20`（`14`）；上/下页 + 页码钳制（`266-273, 309-312`）；3 个弹窗；自我操作保护（`234-246`） |
| 聊天数据 `admin-data.js` | `conversationsApi` 2 个方法（`29-54`） | `load()`（`475`） | 刷新/翻页 | `PAGE_SIZE=20`、消息 `MESSAGE_PAGE_SIZE=50`（`12-13`）；行可点击 + Enter/Space 打开抽屉（`197-214, 388-403`）；只读无删除 |
| 系统设置 `admin-settings.js` | `settingsApi`（`33-47`） | `load()`（`293`） | 保存后回填服务端返回值 | 差量 PATCH：`snapshot()` 对比 `state.saved`，只提交变化字段（`166-179, 215-226`）；无改动直接提示（`242-246`）；撤销按钮（`269-279`）；logo 预览写内联 `style.backgroundImage`（`142-150`） |

### 6.3 表格/筛选/分页/弹窗的重复实现

* **分页逻辑存在两份近似拷贝**：users（`pages() 140-142、renderPager 266-273、load 288-327`）与 data（`pages()/messagePages() 120-126、renderPager 216-223、load 237-274`），连"页码越界回退到最后一页再 load"都复制了一遍（`users.js:309-312` vs `data.js:256-259`）。
* **表格状态行三件套**（`stateRow/messageRow/errorRow`）在 users（`184-218`）与 data（`154-188`）各写一份；`colspan` 硬编码 8 / 7，与表头列数一致（`users.html:103-111`、`data.html:100-108`）。
* **按钮忙碌态**有 4 套：`auth.js submitOnce`（`244-264`）、`api.js withButton`（`338-354`）、`models.js withButton`（`413-429`）、admin-* 的 `setBusy`（dashboard `82-95`、settings `108-121`、users `168-181`、data `138-151`），实现几乎相同。
* **搜索防抖 300ms** 三份：models `573-580`、users `507-518`、data `411-422`。
* 行内操作统一走 `tbody` 事件委托 + `data-action`/`data-id`（`api.js:439-445`、`models.js:565-571`、`users.js:484-499`）。
* 弹窗模式：users 页面 HTML 预置 3 个 `.cl-modal`（`users.html:135/152/182`），JS 用 `CL.openModal/CL.closeModal`（`users.js:353, 403, 428, 448, 472`）；data 的抽屉同样复用 `.cl-modal`（`data.html:123`、`data.js:364, 466`）。

### 6.4 各页接口封装一览

| 脚本 | BASE | 方法 → 端点 |
|---|---|---|
| dashboard | `/api/admin/stats` | `get → GET` |
| api.js | `/api/providers` | list/get/create/update/remove/toggle(`PATCH :id/status`)/test(`POST :id/test`)/refreshModels(`POST :id/refresh-models`) |
| models.js | `/api/models` | list(query)/get/create/update/remove/setDefault(`PATCH :id/default`)/toggle(`PATCH :id/status`)/test(`POST :id/test`)；同步复用 `CL.api.refreshModels`（`models.js:547, 685`） |
| admin-users.js | `/api/users` | list(page/pageSize/keyword/status/role)/get/update(`PATCH`)/resetPassword(`POST :id/password`) |
| admin-data.js | `/api/admin/conversations` | list(page/pageSize/keyword)/messages(id,page,pageSize) |
| admin-settings.js | `/api/settings` | get/save(`PATCH`，任意子集) |

### 6.5 补丁式做法：`hoistAnnouncement`

app.js 的公告槽位在后台页会落到 `.cl-logo`（侧栏品牌链接内，`app.js:512-513`；`admin.html:16-19` 的 `.cl-logo` 在 `<a class="admin-nav__brand">` 里），被压成竖排。于是**6 个后台脚本各自复制了同一段补丁**（第二批修复已把 api/models 补齐）：

```js
// admin-dashboard.js:44-51 / admin-users.js:71-78 / admin-data.js:59-66 /
// admin-settings.js:52-59 / api.js:90-97 / models.js:89-96
function hoistAnnouncement() {
  var bar = CL.qs('.cl-announce'); var main = CL.qs('main');
  if (!bar || !main || bar.parentNode === main) return;
  if (!CL.qs('.admin-shell')) return;
  bar.classList.add('admin-announce');
  main.insertBefore(bar, main.firstChild);
}
// 配合 MutationObserver 监听 .admin-nav，4 秒后断开并再搬一次
```

配套 CSS `admin.css:260-261`（`.admin-content > .admin-announce`）。6 个后台页都在 `initPage()` 开头调用 `watchAnnouncement()`（如 `api.js:110-111`、`models.js:109-110`），公告条现已被统一搬到内容区顶部；这仍是绕开公共 `app.js` 槽位逻辑的补丁（README:239 已记录）。

---

## 7. 设计系统

### 7.1 `--cl-*` 变量（`common.css:8-69`，共 49 个）

| 分类 | 数量 | 变量（行） |
|---|---|---|
| 品牌色 | 14 | `--cl-primary #65BFFF`(10)、`-primary-deep #3498E8`、`-primary-soft #DCEEFF`、`-secondary #A99BFF`、`-secondary-deep #8474F0`、`-secondary-soft #EDE9FF`、`-accent #35D5FF`、`-bg #F6F8FF`、`-ink #101B43`、`-ink-2 #3B4670`、`-ink-3 #7C86A9`、`-white`、`-line`、`-line-strong`（10-23） |
| 语义色 | 6 | danger/danger-soft/success/success-soft/warning/warning-soft（26-31） |
| 玻璃 | 3 | `--cl-glass` `.62`、`-glass-strong` `.84`、`-glass-border`（34-36） |
| 渐变 | 4 | sky / brand / accent / card（37-40） |
| 圆角 | 6 | xs 10 / sm 14 / 16 / lg 20 / xl 24 / pill 999（43-48） |
| 阴影 | 6 | xs / sm / / lg / glow / inner（51-56） |
| 字体 | 2 | `--cl-font` 系统栈含 PingFang/雅黑、`--cl-mono`（59-60） |
| 模糊/缓动 | 3 | `--cl-blur blur(18px)`、`--cl-ease`、`--cl-ease-out`（61-63） |
| 布局 | 3 | `--cl-header-h 72px`、`--cl-admin-nav-w 248px`、`--cl-container 1200px`（66-68） |
| 按钮 | 2 | 组件内局部变量 `--cl-btn-bg/--cl-btn-fg`（162-163） |

> 注：README:117 的分组是"圆角 7 / 布局 5"，与代码实际（圆角 6、布局 3 + 模糊缓动 3）不符，总数 49 正确。

### 7.2 核心组件类（common.css）

| 区块 | 代表类 | 行 |
|---|---|---|
| 布局工具 | `.cl-container/.cl-section/.cl-stack/.cl-row/.cl-grid--2~4/.cl-mt-*` | 103-124 |
| 文字 | `.cl-eyebrow/.cl-title/.cl-display/.cl-lead/.cl-muted/.cl-gradient-text/.cl-sr-only` | 126-140 |
| 装饰背景 | `.cl-sky` + 3 个 `.cl-sky__blob--n`（固定背景 + 模糊圆斑） | 142-158 |
| 按钮 | `.cl-btn` + `--primary/--ghost/--soft/--violet/--danger/--danger-ghost/--sm/--xs/--lg/--block/--icon` | 160-197 |
| 卡片/面板 | `.cl-card/-–glass/--flat/--hover/.cl-panel__head/__body` | 199-220 |
| 表单 | `.cl-form/.cl-field/.cl-label/.cl-input/.cl-select/.cl-textarea/.cl-hint/.cl-check/.cl-switch` | 222-278 |
| 徽标 | `.cl-tag（--violet/pending/off/ok/danger）/.cl-dot（--idle/--warn/--live）/.cl-avatar（--lg/--sm）/.cl-user-chip` | 280-305, 583-591 |
| 表格 | `.cl-table-wrap/.cl-table/.cl-table-actions`（`min-width:760px`，600px 断点降到 640px） | 307-321, 529 |
| 空状态/骨架 | `.cl-empty（--compact）/.cl-skeleton` | 323-353 |
| Toast | `.cl-toasts/.cl-toast--{success,error,warning}` | 355-372 |
| 弹窗 | `.cl-modal/.cl-modal__{backdrop,panel,head,body,foot,close}/.cl-confirm__*` | 374-401 |
| 导航 | `.cl-header/.cl-logo（__mark/__img/__text em）/.cl-nav/.cl-burger` | 403-437 |
| 页脚 | `.cl-footer__grid/__col/__bottom` | 439-447 |
| 认证页/用户中心 | `.auth-page/.auth/.auth__card/.cl-pw-toggle/.account-hero/.account-grid/.account-meta` | 534-578 |
| 登录态/公告 | `[data-guest-only][hidden]` 规则、`.is-guard-pending`、`.cl-announce`、`.cl-notice` | 580-612 |

### 7.3 页面级 CSS 分工与"追加式补丁"

| 文件 | 行数 | 负责 | 特征 |
|---|---|---|---|
| `common.css` | 612 | 变量/重置/组件/导航/认证页/响应式 | 末尾 593-612 是"阶段 5 追加"块（注释明说"不改动上方既有规则"），含 `.cl-logo__img/.auth__brand-sub/.cl-announce/.cl-notice` |
| `home.css` | 259 | 首页：Hero、CSS 吉祥物占位、能力卡、角色、优势、FAQ、CTA | 222/230/242 三个断点 |
| `chat.css` | 276 | 聊天三栏布局、消息气泡、会话列表 | 204-276 是"阶段 4 追加"块（真实消息气泡/列表/行内编辑） |
| `admin.css` | 261 | 后台侧栏/主区/统计卡/工具栏/设置页/抽屉 | 182-261 是"阶段 3/5 追加"块，260-261 即公告条补丁样式 |

* 结果：同名/近似选择器重复出现（如 `.cl-userchip` 302-305 与 `.cl-user-chip` 583-591 是两套类名，HTML 只用后者，前者为死代码）。
* 断点：`1200 / 900 / 600`（common `463/474/503`；home `222/230/242`；chat `161/166/181/199/271`；admin `144/153/166` + 抽屉专用 `720` `admin.css:254`）；另有 `prefers-reduced-motion`（`common.css:98-101`）与 900px 后台抽屉自动收起（`app.js:634-663`）。

### 7.4 CSP 对前端写法的约束

服务端在每个响应（含静态 HTML，中间件在 `express.static` 之前，`server/app.js:132,153`）注入：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: http: https:; font-src 'self' data:; connect-src 'self';
frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'
```
（`server/middleware/security-headers.js:1-12`；另有 nosniff、X-Frame-Options SAMEORIGIN、Referrer-Policy、`req.secure` 时 HSTS，`16-24`）

| 约束 | 对前端的影响 | 证据 |
|---|---|---|
| `script-src 'self'` | 禁止内联脚本与 `javascript:`；所有页面确实无内联 script / 事件属性 | 全量 grep = 0 |
| `style-src 'self' 'unsafe-inline'` | 允许 JS 写内联 style（logo 预览）与 HTML `style` 属性（实际 HTML 无 style 属性） | `admin-settings.js:148` |
| `img-src ... http: https:` | 允许外链图片；`settingLogo()` 现也放行 `http(s)://`，外链 logo 可用（仅拒绝其它 scheme） | `app.js:439-446`、`admin-settings.js:15` |
| `connect-src 'self'` | 前端不能直连 AI 或 CDN，只能同源 `fetch`；SSE 用同源 fetch，无需额外白名单 | `chat.js:91` |
| `form-action 'self'` | 表单只能提交本站（首页 hero 表单 `action="chat.html"` 走 GET） | `index.html:59` |
| 无 `'unsafe-eval'` | 无动态 `eval`/new Function 依赖（原生实现） | 全量 grep 无 |

---

## 8. 前后端接口调用对照表

统一约定：错误信封 `{error:{code,message}}`；写方法需 `X-CSRF-Token`；限定错误码有专门前端分支。

| 触发点（页面/脚本） | 接口与时机 | 用途/前端落点 |
|---|---|---|
| 所有页 `app.js:777` | `GET /api/settings`（首屏，无凭证要求） | 站名/副标题/logo/公告/开关；失败静默回退默认值 |
| 所有页 `guard.js:68`/`auth.js:50` | `GET /api/auth/me`（首屏，`noAuthRedirect`） | 登录态判定、`data-user-*` 渲染 |
| 任一写操作首次 `app.js:295` | `GET /api/csrf-token`（懒加载一次，令牌会话级） | 之后写请求带 `X-CSRF-Token` |
| 登录页 `auth.js:56` | `POST /api/auth/login` | 写回 csrf → 跳 `redirect` 或 `/user.html` |
| 注册页 `auth.js:69` | `POST /api/auth/register` | 写回 csrf → 跳 `/user.html`；403 `REGISTER_DISABLED` 锁表单 |
| 任意页 `[data-logout]` | `POST /api/auth/logout`（确认框后） | 清 csrf → flash → 跳 `/` |
| user.html `auth.js:92` | `PATCH /api/user/profile` | 更新昵称并 `CL.guard.paint(user)` 即时重绘 |
| user.html `auth.js:98` | `PATCH /api/user/password` | 改密后清空表单；后端返回 `{ok,revokedSessions}`：当前会话保留、其它设备会话失效 |
| chat 首屏 `chat.js:544` | `GET /api/chat/models` | 模型下拉（默认模型优先） |
| chat 首屏/搜索 `chat.js:562` | `GET /api/chat/conversations?keyword=` | 左侧历史列表 + 空态 |
| chat 发送 `chat.js:91` | `POST /api/chat/completions`（SSE） | 逐字气泡；`start` 回填新会话 id |
| chat 打开会话 `chat.js:640` | `GET /api/chat/conversations/:id/messages` | 渲染历史消息 |
| chat 重命名/删除 `chat.js:690/731` | `PATCH` / `DELETE /api/chat/conversations/:id` | 行内改名、删除确认 |
| 后台仪表盘 `admin-dashboard.js:248` | `GET /api/admin/stats` | 4 个统计卡 + 系统状态 + 最近服务/模型 |
| api.html `api.js:38` | `GET /api/providers` | 服务表格（无分页） |
| api.html 保存 `api.js:463/460` | `POST /api/providers` / `PATCH /api/providers/:id` | 内联表单新增/编辑；Key 留空不改 |
| api.html 行操作 `api.js:421-427` | `PATCH :id/status`、`POST :id/test`、`POST :id/refresh-models`、`DELETE :id` | 启停/测试/刷新模型/删除 |
| models.html `models.js:448-466` | `GET /api/models?providerId&keyword&status` | 模型表格（无分页） |
| models.html 保存/操作 `models.js:625/634, 517-525` | `POST /api/models`、`PATCH :id`、`PATCH :id/default`、`PATCH :id/status`、`POST :id/test`、`DELETE :id` | 增删改/设默认/启停/测试 |
| models.html 同步 `models.js:547` | 逐个启用服务 `POST /api/providers/:id/refresh-models` | 汇总成功/失败数 toast |
| users.html `admin-users.js:297` | `GET /api/users?…&page&pageSize=?（联动筛选）` | 用户表格 + 分页 |
| users.html 详情/改角色/改密 | `GET /api/users/:id`、`PATCH /api/users/:id`、`POST /api/users/:id/password` | 3 个弹窗；管理员重置后目标用户全部会话失效（自重置保留当前会话） |
| data.html `admin-data.js:246` | `GET /api/admin/conversations` | 会话表格 + 分页 |
| data.html 抽屉 `admin-data.js:324` | `GET /api/admin/conversations/:id/messages?page&pageSize` | 只读消息列表（再分页 50） |
| settings.html `admin-settings.js:188/250` | `GET /api/settings` / `PATCH /api/settings`（差量） | 回填 / 保存即生效 |
| （无页面调用） | `server/app.js:161` `GET /api/health` | 部署健康检查，前端未接 |

* 前端对外部上游（AI 服务）**零直连**：所有 providers/models/chat 请求都先到自家后端；CSP `connect-src 'self'` 也禁止了外连。
* 401/403/429 前端处理：401 → 默认跳登录（`app.js:365-374`）；403 `CSRF_INVALID` → 重取令牌重试一次（`app.js:358-364`、`chat.js:115-124`）；403 `CHAT_DISABLED`/`REGISTER_DISABLED` → 专门 UI 分支（`chat.js:850-856`、`auth.js:356`）；429 `RATE_LIMITED` 无专属文案，直接 toast 服务端 message。
* 服务端对 `/api` 统一 `Cache-Control: no-store`（`server/app.js:153-158`），前端每次 fetch 都真实走网络；上游 3xx 被 `redirect:'error'` 拒绝（`server/services/provider-client.js:66`、`chat-client.js:144`），错误文案直接由 toast 展示。
* 聊天流空闲超时（默认 60 秒无数据）由后端发 `error` 帧终止（`server/services/chat-client.js:12-17,234-243`），前端无需计时器。

---

## 9. 前端已知限制与坑

| # | 现象/缺陷 | 证据 | 影响与备注 |
|---|---|---|---|
| 1 | ✅ **已修复**（外链 Logo 永不显示）：`settingLogo` 现放行 `/` 开头站内路径与 `http(s)://` 绝对地址，并新增 `logoSrc()` 避免外链被 `CL.url` 二次拼接 | `app.js:439-446, 479-482, 485-498`；后台 `admin-settings.js:15`；服务端 `server/services/settings-store.js:18,120` | 后台填 http(s) logo 已能在前台显示；`javascript:`/`data:` 等仍被拒绝 |
| 2 | ✅ **已修复**（重命名超长）：行内输入框 `maxlength` 60→40，与后端 `TITLE_MAX=40` 一致 | `chat.js:663` vs `server/services/chat-store.js:6`（`routes/chat.js:26` 校验） | 不会再出现「输入 41–60 字被后端 400」 |
| 3 | **重置密码规则与注册/自助改密策略不一致**（不是 bug，但易误解）：管理员重置要求 **8–32 位且必须含字母+数字**，前端弹窗与后端一致；而注册/自助改密只要求 **6–64 位、无复杂度** | `admin-users.js:459-462`、`server/routes/users.js:16-17,206-213` vs `server/services/validation.js:2-5` | 管理员被强制更严格规则；两套提示文案容易让用户混淆 |
| 4 | ✅ **已修复**（公告条补丁不完整）：api.js / models.js 也补齐 `hoistAnnouncement/watchAnnouncement`，6 个后台页统一搬移 | `admin-dashboard.js:44-62`、`admin-users.js:71-89`、`admin-data.js:59-77`、`admin-settings.js:52-70`、`api.js:90-108`、`models.js:89-107`；槽位 `app.js:512-513`（`.cl-logo`）、`admin.html:16-19` | `/admin/api.html`、`/admin/models.html` 的公告不再落进侧栏品牌 `<a>` 内 |
| 5 | ✅ **已修复**（后台无退出入口）：6 个后台页侧栏 `.admin-nav__foot` 增加 `data-logout` 按钮（顶栏仍只有返回前台+头像） | `admin.html:37-39`、`api.html:37-39` 等 6 页；`auth.js:410-424` 自动绑定；`admin.css:47-48` 定宽 | 管理员可在后台直接退出，退出后回首页 |
| 6 | ✅ **已修复**（过时文案）：首页能力卡 01–03 改「已接入」、04 改「暂未支持」，FAQ/页脚/© 年份同步；用户中心页脚改为「AI 对话已上线」 | `index.html:71,113-131,198,240,268-269`；`user.html:223` | 文案已与「聊天/后台均已上线」的现状一致 |
| 7 | **用户中心"历史对话"是静态空状态** | `user.html:158-167` 为写死 `.cl-empty`，user.html 只加载 app/auth/guard（`228-230`），无任何会话请求 | 有会话也永远显示"还没有对话记录" |
| 8 | ✅ **已修复**（用户中心 logo 不随设置变化）：顶栏与页脚 `.cl-logo__mark` 都补了 `<img data-site-logo>` | `user.html:21,197` | 设置 logo 在用户中心也生效 |
| 9 | **"记住我"只有 UI**；"忘记密码"是占位 | `login.html:51-54` 的 checkbox 无 JS 引用；`login.html:42` `data-pending="找回密码"` → `app.js:666-677` 只 toast | 与 README:240 一致 |
| 10 | **重命名/删除/新建按钮在流式生成中会先中止当前回复** | `chat.js:614, 623` 直接 `stopStreaming()`，无二次确认 | 已生成内容会保留（`863-870` 有兜底），但用户可能误触 |
| 11 | **`state.messages` 与后端可能短暂不一致** | 失败时把部分内容以 `id:null` 入数组（`chat.js:863-870`），随后 `loadConversations()` 只刷新列表不刷新消息（`877`） | 消息数角标/信息栏计数可能偏大，刷新页面才对齐 |
| 12 | **模型选择不跟随会话**：打开历史会话不读取该会话的 `modelId`，下拉仍停在全局默认/上次选择 | `chat.js:621-650` 只取 title/modelName/createdAt；`564-573` 同理；`fillModelSelect` 527-540 | 与 README「不沿用会话上次模型」一致，属设计取舍 |
| 13 | **`models.js` 隐式依赖 `api.js`** | `models.js:433-434` 调 `CL.api.list()`；脚本顺序 `models.html:186-187` | 若单独复用 models.js 会 TypeError，无运行时保护 |
| 14 | **`admin.js` 死代码** | 全部方法 throw（`admin.js:12-14, 18-78`），全站无 `CL.admin` 调用；6 页仍加载它（`admin.html:183` 等） | 每页多一个无请求的脚本 |
| 15 | **两套 user-chip 类名**：`.cl-userchip`（302-305）从未被 HTML 使用，真实类名是 `.cl-user-chip`（583-591） | `common.css:302-305, 583-591` | 死 CSS，后续改样式容易改错地方 |
| 16 | **表格窄屏体验**：桌面 `min-width:760px` 横向滚动，600px 断点降为 640px；README 只提 640 | `common.css:309, 529` | 未做卡片式重排，窄屏需横向拖动 |
| 17 | **`is-guard-pending` 只隐藏带 data 属性的节点**，页面其余登录相关文案（如 chat 侧栏"未登录访客"）仍会先闪一下 | `common.css:581-582`；`chat.html:47-48` | 视觉小抖动，非功能问题 |
| 18 | ✅ **已同步**（README 与代码冲突）：根 README 已刷新为「阶段 6 基本完成」，补 CSRF/限流/SSRF/安全头/会话失效/空闲超时、测试与备份章节 | README:123-158, 193-210, 214-225, 257-259；对照 `server/app.js:132,153-158,176-188`、`middleware/csrf.js`、`services/rate-limit.js`、`security-headers.js`、`chat-client.js:12-17,234-243` | 安全口径已一致；残余限制（DNS 重绑定窗口、跨进程限流）README:231-232,244 亦有记录 |
| 19 | **README 设计系统分组偏差**：称 49 变量中"圆角 7 / 布局 5" | README:117 vs `common.css:8-69`（圆角 6、布局 3、模糊/缓动 3） | 总数 49 正确，分类需以本表为准 |
| 20 | **首屏固定两次并发请求**（settings + me），且 chat 页实际只靠 guard 的 me 结果 | `app.js:777`、`guard.js:121`、`chat.js:981-989` | 轻微多一次请求；`/api/chat/models` 等要等 guard.ready 之后才发（串行） |
| 21 | **改密/重置后的会话失效在前端无可见反馈**：改密成功只 toast 固定文案，不显示后端返回的 `revokedSessions` 数量 | `auth.js:266-271`（MESSAGES.password）、`server/routes/profile.js:56-68`；管理员重置同理（`users.js:218-229`） | 用户不知道其它设备已被踢下线，客服排查时需查日志 |

### 行为备注（非缺陷）

* **SSE 断流无自动重连**：前端只处理 Abort 与普通网络/流错误（`chat.js:102-107, 215-223`），不做重连；后端空闲超时会发 `error` 帧（`server/services/chat-client.js:12-17,234-243`），前端按通用失败展示并保留已收内容。
* **429 限流无专属 UI**：前端无 `RATE_LIMITED` 分支，直接 toast 服务端 message；限流为进程内存态（README:244），多实例部署时额度按实例放大。
* **测试未覆盖前端**：`npm test` 的 83 个用例均为后端（Node 内置 `node:test`，需要 PostgreSQL），前端仅经浏览器 + 临时环境端到端手工验证（见根 README 的测试与备份章节）。
