/* ============================================================
   尘龙 ChenLong · 对话接口与页面逻辑 chat.js（阶段 4）
   接口契约（冻结）：
     GET    /api/chat/models                         → { items:[{id,displayName,modelId,providerName,isDefault}] }
     GET    /api/chat/conversations?keyword=          → { items:[{id,title,modelId,modelName,messageCount,createdAt,updatedAt}] }
     POST   /api/chat/conversations                  → 201 { item }
     PATCH  /api/chat/conversations/:id              → 200 { item }
     DELETE /api/chat/conversations/:id              → 204
     GET    /api/chat/conversations/:id/messages     → { items:[{id,role,content,createdAt}] }
     POST   /api/chat/completions                    → text/event-stream（start / delta / done / error + [DONE]）
   SSE 用 fetch + response.body.getReader() 自行解析：POST 与 Cookie 请求不需要 EventSource。
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var qs = CL.qs;
  var qsa = CL.qsa;
  var el = CL.el;

  var BASE = '/api/chat';
  var LOGIN_PATH = 'login.html?redirect=' + encodeURIComponent('/chat.html');
  var SEARCH_DELAY = 300;

  /* ---------- 请求 ---------- */
  function request(path, options) {
    return CL.fetchJSON(CL.url(BASE + path), options);
  }

  /* 数值型主键按数字提交，字符串主键原样提交 */
  function toId(value) {
    if (value === null || value === undefined || value === '') return undefined;
    var num = Number(value);
    return isNaN(num) ? value : num;
  }

  /* ---------- 接口封装 ---------- */
  var chat = {
    base: BASE,

    async listModels() {
      var data = await request('/models');
      return (data && data.items) || [];
    },

    async listConversations(keyword) {
      var value = typeof keyword === 'string' ? keyword.trim() : '';
      var query = value ? '?keyword=' + encodeURIComponent(value) : '';
      var data = await request('/conversations' + query);
      return (data && data.items) || [];
    },

    async createConversation(payload) {
      var body = payload || {};
      var data = await request('/conversations', { method: 'POST', body: body });
      return (data && data.item) || null;
    },

    async renameConversation(id, title) {
      var data = await request('/conversations/' + encodeURIComponent(id), { method: 'PATCH', body: { title: title } });
      return (data && data.item) || null;
    },

    async deleteConversation(id) {
      return request('/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    async listMessages(conversationId) {
      var data = await request('/conversations/' + encodeURIComponent(conversationId) + '/messages');
      return (data && data.items) || [];
    },

    /* POST /api/chat/completions（stream=true）
       逐帧解析 "data: <json>\n\n"，[DONE] 结束。
       返回 { conversationId, assistantMessageId, modelName, content, done } */
    async streamCompletion(options) {
      var opts = options || {};
      var payload = { message: opts.message, stream: true };
      var conversationId = toId(opts.conversationId);
      var modelId = toId(opts.modelId);
      if (conversationId !== undefined) payload.conversationId = conversationId;
      if (modelId !== undefined) payload.modelId = modelId;

      /* 流式请求同样要带 CSRF 头；403 CSRF_INVALID 时重取 token 后原样重试一次。
         重试发生在解析流之前，调用方的用户气泡不会被重复插入。 */
      var response = null;
      var token = await CL.csrf.ensure();
      var retried = false;
      for (;;) {
        try {
          response = await window.fetch(CL.url(BASE + '/completions'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              'X-CSRF-Token': token
            },
            body: JSON.stringify(payload),
            signal: opts.signal
          });
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          var netErr = new Error('无法连接服务器，请确认后端服务已启动');
          netErr.status = 0;
          throw netErr;
        }

        if (response.ok) break;

        var raw = await response.text();
        var envelope = null;
        try { envelope = JSON.parse(raw); } catch (parseErr) { envelope = null; }
        var details = (envelope && envelope.error) || envelope || {};
        if (response.status === 403 && details.code === 'CSRF_INVALID' && !retried) {
          retried = true;
          CL.csrf.clear();
          token = await CL.csrf.ensure();
          continue;
        }
        var httpErr = new Error(details.message || '请求失败（HTTP ' + response.status + '）');
        httpErr.status = response.status;
        httpErr.code = details.code || '';
        throw httpErr;
      }

      var result = {
        conversationId: conversationId === undefined ? null : conversationId,
        assistantMessageId: null,
        modelName: '',
        content: '',
        done: false
      };
      var buffer = '';
      var ended = false;

      function emit(event) {
        if (typeof opts.onEvent === 'function') opts.onEvent(event, result);
      }

      function dispatch(event) {
        if (!event || typeof event !== 'object') return false;
        if (event.type === 'error') {
          var streamErr = new Error(event.message || '生成失败，请稍后重试');
          streamErr.code = event.code || 'UPSTREAM_ERROR';
          streamErr.sse = true;
          throw streamErr;
        }
        if (event.type === 'start') {
          if (event.conversationId !== undefined && event.conversationId !== null) result.conversationId = event.conversationId;
          if (typeof event.modelName === 'string') result.modelName = event.modelName;
        } else if (event.type === 'delta') {
          if (typeof event.content === 'string') result.content += event.content;
        } else if (event.type === 'done') {
          if (event.conversationId !== undefined && event.conversationId !== null) result.conversationId = event.conversationId;
          if (event.assistantMessageId !== undefined) result.assistantMessageId = event.assistantMessageId;
          if (typeof event.content === 'string') result.content = event.content;
          result.done = true;
        } else {
          return false;
        }
        emit(event);
        return result.done;
      }

      /* 解析一个事件块；返回 true 表示流已结束 */
      function handleBlock(block) {
        var lines = String(block || '').split(/\r?\n/);
        var parts = [];
        for (var i = 0; i < lines.length; i += 1) {
          if (lines[i].indexOf('data:') !== 0) continue;
          parts.push(lines[i].slice(5).replace(/^ /, ''));
        }
        if (!parts.length) return false;
        var body = parts.join('\n').trim();
        if (!body) return false;
        if (body === '[DONE]') return true;
        var event = null;
        try { event = JSON.parse(body); } catch (parseErr) { return false; }
        return dispatch(event);
      }

      /* 把新收到的文本并入缓冲，按空行切帧 */
      function pump(text) {
        buffer += text;
        var blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop();
        for (var i = 0; i < blocks.length; i += 1) {
          if (handleBlock(blocks[i])) return true;
        }
        return false;
      }

      try {
        if (!response.body || typeof response.body.getReader !== 'function') {
          pump(await response.text());
          pump('\n\n');
          return result;
        }
        var reader = response.body.getReader();
        var decoder = new window.TextDecoder('utf-8');
        try {
          while (!ended) {
            var chunk = await reader.read();
            if (chunk.done) break;
            ended = pump(decoder.decode(chunk.value, { stream: true }));
          }
          if (!ended) {
            pump(decoder.decode());
            pump('\n\n');
          }
        } finally {
          try { Promise.resolve(reader.cancel()).catch(function () { /* 流已关闭 */ }); } catch (cancelErr) { /* 流已关闭 */ }
        }
      } catch (err) {
        if ((opts.signal && opts.signal.aborted) || (err && err.name === 'AbortError')) {
          var stopErr = new Error('已停止生成');
          stopErr.name = 'AbortError';
          stopErr.stopped = true;
          throw stopErr;
        }
        throw err;
      }
      return result;
    }
  };

  CL.chat = chat;

  /* ============================================================
     页面状态与 DOM
     ============================================================ */
  var state = {
    user: null,
    models: [],
    modelId: '',
    conversations: [],
    activeId: null,
    activeTitle: '',
    activeModelName: '',
    activeCreated: '',
    messages: [],
    keyword: '',
    streaming: false,
    chatDisabled: false,
    controller: null,
    follow: true,
    searchTimer: 0,
    loadToken: 0
  };

  var dom = {};

  var CHAT_DISABLED_TEXT = '管理员已暂停聊天服务';

  /* 聊天开关（GET /api/settings 的 allowChat）：关闭时禁用输入与发送 */
  function applyChatSwitch(settings) {
    state.chatDisabled = !!(settings && settings.allowChat === false);
    if (dom.input && state.chatDisabled) dom.input.disabled = true;
    updateComposer();
  }

  /* 设置接口不可用或字段缺失时保持原样（allowChat 兜底为 true） */
  function watchChatSwitch() {
    if (!CL.settings || typeof CL.settings.ready !== 'object') return;
    CL.settings.ready.then(function (settings) {
      applyChatSwitch(settings);
    }, function () { /* 静默：前台按默认值继续工作 */ });
  }

  function cacheDom() {
    dom.messages = qs('#chat-messages');
    dom.thread = qs('#chat-thread');
    dom.welcome = qs('.chat-empty');
    dom.form = qs('.chat-composer');
    dom.input = qs('#chat-input');
    dom.model = qs('#chat-model');
    dom.send = qs('.chat-send');
    dom.stop = qs('.chat-stop');
    dom.hint = qs('.chat-composer__hint');
    dom.search = qs('#chat-search');
    dom.history = qs('#chat-history-list');
    dom.historyEmpty = qs('#chat-history-empty');
    dom.historyNote = qs('[data-chat-history-note]');
    dom.noResult = qs('#chat-history-noresult');
    dom.historyCount = qs('#chat-history-count');
    dom.title = qs('.chat-topbar__title');
    dom.sub = qs('.chat-topbar__sub');
    dom.infoModel = qs('[data-chat-info="model"]');
    dom.infoCount = qs('[data-chat-info="count"]');
    dom.infoCreated = qs('[data-chat-info="created"]');
    dom.infoStatus = qs('[data-chat-info="status"]');
    dom.infoDot = qs('[data-chat-dot]');
  }

  /* ---------- 登录态 ---------- */
  function isGuest() {
    return !state.user;
  }

  function goLogin() {
    if (CL._redirecting) return;
    CL._redirecting = true;
    window.location.assign(CL.url(LOGIN_PATH));
  }

  /* 写操作统一入口：游客先跳登录页 */
  function requireLogin() {
    if (!isGuest()) return true;
    goLogin();
    return false;
  }

  /* ============================================================
     状态渲染
     ============================================================ */
  function modelLabel(id) {
    for (var i = 0; i < state.models.length; i += 1) {
      if (String(state.models[i].id) === String(id)) {
        return state.models[i].displayName || state.models[i].modelId || ('模型 ' + state.models[i].id);
      }
    }
    return '—';
  }

  function setStatus(kind) {
    if (!dom.infoStatus) return;
    var map = {
      idle: { text: '未连接', dot: 'cl-dot cl-dot--idle' },
      busy: { text: '生成中', dot: 'cl-dot cl-dot--warn cl-dot--live' },
      online: { text: '已连接', dot: 'cl-dot' }
    };
    var picked = map[kind] || map.idle;
    dom.infoStatus.textContent = picked.text;
    if (dom.infoDot) dom.infoDot.className = picked.dot;
  }

  function updateComposer() {
    if (!dom.send) return;
    var noModel = state.models.length === 0;
    dom.send.disabled = state.chatDisabled || state.streaming || (!isGuest() && noModel);
    if (dom.stop) dom.stop.disabled = !state.streaming;
    if (dom.model) dom.model.disabled = isGuest() || noModel || state.streaming;
    if (dom.input && state.chatDisabled) dom.input.disabled = true;
    if (!dom.hint) return;
    dom.hint.classList.toggle('is-warning', state.chatDisabled);
    if (state.chatDisabled) dom.hint.textContent = CHAT_DISABLED_TEXT;
    else if (isGuest()) dom.hint.textContent = '登录后即可发送消息，历史对话会保存在你的账号下。';
    else if (noModel) dom.hint.textContent = '暂无可用的模型，请前往后台「模型管理」启用模型后再来聊天。';
    else dom.hint.textContent = '尘龙也可能会犯错，重要信息请自行核实 · 生成中可随时停止';
  }

  function paintInfo() {
    if (dom.infoModel) dom.infoModel.textContent = state.modelId ? modelLabel(state.modelId) : '—';
    if (dom.infoCount) dom.infoCount.textContent = String(state.messages.length);
    if (dom.infoCreated) dom.infoCreated.textContent = state.activeCreated ? CL.formatTime(state.activeCreated, 'datetime') : '—';
  }

  function paintTopbar() {
    if (dom.title) dom.title.textContent = state.activeTitle || '新的对话';
    if (dom.sub) {
      var model = state.activeModelName || (state.activeId ? modelLabel(state.modelId) : '');
      dom.sub.textContent = state.activeId && model ? model : '尘龙 · 随时在这里';
    }
  }

  function showWelcome(visible) {
    if (dom.welcome) dom.welcome.hidden = !visible;
  }

  function clearThread() {
    if (dom.thread) dom.thread.innerHTML = '';
  }

  /* ============================================================
     会话列表
     ============================================================ */
  function findConversation(id) {
    var found = null;
    state.conversations.forEach(function (item) {
      if (String(item.id) === String(id)) found = item;
    });
    return found;
  }

  function conversationMeta(item) {
    var count = Number(item.messageCount) || 0;
    return CL.formatTime(item.updatedAt) + ' · ' + count + ' 条消息';
  }

  function threadItemNode(item) {
    var id = String(item.id);
    var title = item.title || '未命名对话';
    var active = state.activeId !== null && String(state.activeId) === id;
    var node = el('div', { class: 'chat-thread-item' + (active ? ' is-active' : ''), dataset: { conversationId: id } });
    var open = el('button', { type: 'button', class: 'chat-thread__open', dataset: { chatOpen: id } }, [
      el('span', { class: 'chat-thread__title', text: title }),
      el('span', { class: 'chat-thread__meta', text: conversationMeta(item) })
    ]);
    var actions = el('div', { class: 'chat-thread__actions' }, [
      el('button', {
        type: 'button',
        class: 'chat-thread__act',
        dataset: { chatRename: id },
        title: '重命名',
        'aria-label': '重命名会话「' + title + '」',
        text: '重命名'
      }),
      el('button', {
        type: 'button',
        class: 'chat-thread__act chat-thread__act--danger',
        dataset: { chatDelete: id },
        title: '删除',
        'aria-label': '删除会话「' + title + '」',
        text: '删除'
      })
    ]);
    node.appendChild(open);
    node.appendChild(actions);
    return node;
  }

  function renderConversations() {
    if (!dom.history) return;
    dom.history.innerHTML = '';
    state.conversations.forEach(function (item) {
      dom.history.appendChild(threadItemNode(item));
    });
    if (dom.historyCount) dom.historyCount.textContent = state.conversations.length + ' 个会话';
    var empty = state.conversations.length === 0;
    if (dom.historyEmpty) dom.historyEmpty.hidden = !empty || !!state.keyword;
    if (dom.noResult) dom.noResult.hidden = !(empty && !!state.keyword);
  }

  /* ============================================================
     消息渲染
     ============================================================ */
  function initialOfUser() {
    var name = String((state.user && (state.user.nickname || state.user.username)) || '').trim();
    return name ? name.charAt(0).toUpperCase() : '我';
  }

  function timeLabel(value) {
    return value ? CL.formatTime(value, 'time') : '';
  }

  function bubbleOf(role, content) {
    var isUser = role === 'user';
    var avatar = el('span', { class: 'chat-msg__avatar' + (isUser ? '' : ' chat-msg__avatar--bot'), 'aria-hidden': 'true' });
    if (isUser) avatar.textContent = initialOfUser();
    var text = el('p', { class: 'chat-msg__text' });
    text.textContent = content || '';
    var bubble = el('div', { class: 'chat-msg__bubble' }, [
      text,
      el('span', { class: 'chat-msg__caret', 'aria-hidden': 'true' })
    ]);
    var time = el('span', { class: 'chat-msg__time' });
    var node = el('article', {
      class: 'chat-msg chat-msg--' + (isUser ? 'user' : 'assistant'),
      dataset: { role: isUser ? 'user' : 'assistant' }
    }, [avatar, el('div', { class: 'chat-msg__body' }, [bubble, time])]);
    return { node: node, text: text, bubble: bubble, time: time };
  }

  /* assistant 文本一律走 textContent，绝不解析 HTML */
  function appendMessage(message) {
    var role = message.role === 'assistant' ? 'assistant' : 'user';
    var parts = bubbleOf(role, message.content);
    parts.time.textContent = timeLabel(message.createdAt);
    if (dom.thread) dom.thread.appendChild(parts.node);
    showWelcome(false);
    return parts;
  }

  function addNote(parts, text, kind) {
    var body = qs('.chat-msg__body', parts.node);
    if (!body) return;
    body.appendChild(el('span', {
      class: 'chat-msg__note' + (kind === 'error' ? ' chat-msg__note--error' : ''),
      text: text
    }));
  }

  function renderMessages(items) {
    clearThread();
    state.messages = items.slice();
    if (!items.length) {
      showWelcome(true);
      paintInfo();
      return;
    }
    items.forEach(function (item) { appendMessage(item); });
    showWelcome(false);
    paintInfo();
    state.follow = true;
    window.requestAnimationFrame(function () { stickToBottom(true); });
  }

  function nearBottom() {
    if (!dom.messages) return true;
    return dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight < 72;
  }

  /* 用户手动上滚后不抢滚动 */
  function stickToBottom(force) {
    if (!dom.messages) return;
    if (!force && !state.follow) return;
    dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  /* ============================================================
     数据加载
     ============================================================ */
  function fillModelSelect() {
    if (!dom.model) return;
    dom.model.innerHTML = '';
    if (isGuest()) {
      dom.model.appendChild(el('option', { value: '', text: '登录后可选择模型' }));
      state.modelId = '';
      return;
    }
    if (!state.models.length) {
      dom.model.appendChild(el('option', { value: '', text: '暂无可用模型' }));
      state.modelId = '';
      return;
    }
    var preferred = null;
    var keep = null;
    state.models.forEach(function (model) {
      if (!preferred && model.isDefault) preferred = model;
      if (state.modelId && String(model.id) === String(state.modelId)) keep = model;
      dom.model.appendChild(el('option', {
        value: String(model.id),
        text: model.displayName || model.modelId || ('模型 ' + model.id)
      }));
    });
    var picked = keep || preferred || state.models[0];
    state.modelId = String(picked.id);
    dom.model.value = state.modelId;
  }

  async function loadModels() {
    try {
      var items = await chat.listModels();
      state.models = items.filter(function (item) { return item && item.id !== undefined && item.id !== null; });
    } catch (err) {
      state.models = [];
      if (err.status !== 401) CL.toast(err.message || '模型列表加载失败', 'error');
    }
    fillModelSelect();
    updateComposer();
    paintInfo();
  }

  async function loadConversations() {
    if (isGuest()) {
      state.conversations = [];
      renderConversations();
      return;
    }
    try {
      var items = await chat.listConversations(state.keyword);
      state.conversations = items;
      if (state.activeId !== null) {
        var active = findConversation(state.activeId);
        if (active) {
          state.activeTitle = active.title || state.activeTitle;
          state.activeModelName = active.modelName || state.activeModelName;
          state.activeCreated = active.createdAt || state.activeCreated;
          paintTopbar();
          paintInfo();
        }
      }
      renderConversations();
      if (!state.streaming) setStatus('online');
    } catch (err) {
      if (!state.streaming) setStatus('idle');
      if (err.status === 401) {
        state.user = null;
        renderGuestView();
        return;
      }
      CL.toast(err.message || '会话列表加载失败', 'error');
    }
  }

  /* ============================================================
     会话操作
     ============================================================ */
  function resetToEmpty() {
    state.activeId = null;
    state.activeTitle = '';
    state.activeModelName = '';
    state.activeCreated = '';
    state.messages = [];
    clearThread();
    showWelcome(true);
    paintTopbar();
    paintInfo();
    renderConversations();
  }

  function closeSidebarOnNarrow() {
    if (window.innerWidth > 900) return;
    var sidebar = qs('.chat-sidebar');
    var backdrop = qs('[data-chat-sidebar-backdrop]');
    if (sidebar) sidebar.classList.remove('is-open');
    if (backdrop) backdrop.classList.remove('is-open');
    qsa('[data-chat-sidebar-toggle]').forEach(function (btn) { btn.setAttribute('aria-expanded', 'false'); });
  }

  function newConversation() {
    if (!requireLogin()) return;
    if (state.streaming) stopStreaming();
    state.loadToken += 1;
    resetToEmpty();
    closeSidebarOnNarrow();
    if (dom.input) dom.input.focus();
  }

  async function openConversation(id) {
    if (!requireLogin()) return;
    if (state.streaming) stopStreaming();
    var target = String(id);
    var item = findConversation(target);
    state.activeId = target;
    state.activeTitle = item ? (item.title || '') : '';
    state.activeModelName = item ? (item.modelName || '') : '';
    state.activeCreated = item ? (item.createdAt || '') : '';
    state.messages = [];
    clearThread();
    showWelcome(false);
    paintTopbar();
    paintInfo();
    renderConversations();
    closeSidebarOnNarrow();

    var token = (state.loadToken += 1);
    try {
      var items = await chat.listMessages(target);
      if (token !== state.loadToken || String(state.activeId) !== target) return;
      renderMessages(items);
      if (!state.streaming) setStatus('online');
    } catch (err) {
      if (token !== state.loadToken) return;
      renderMessages([]);
      setStatus('idle');
      CL.toast(err.message || '历史消息加载失败', 'error');
    }
  }

  function startRename(id) {
    if (!requireLogin()) return;
    if (!dom.history) return;
    var node = qs('[data-conversation-id="' + id + '"]', dom.history);
    if (!node || qs('.chat-thread__editor', node)) return;
    var item = findConversation(id);
    if (!item) return;
    var open = qs('.chat-thread__open', node);
    var input = el('input', {
      class: 'cl-input chat-thread__input',
      type: 'text',
      maxlength: '40',
      value: item.title || '',
      'aria-label': '会话标题'
    });
    var saveBtn = el('button', { type: 'button', class: 'chat-thread__act chat-thread__act--save', text: '保存' });
    var cancelBtn = el('button', { type: 'button', class: 'chat-thread__act', text: '取消' });
    var editor = el('div', { class: 'chat-thread__editor' }, [input, saveBtn, cancelBtn]);
    if (open) open.hidden = true;
    node.appendChild(editor);
    input.focus();
    input.select();

    async function commit() {
      var value = input.value.trim();
      if (!value) {
        CL.toast('会话标题不能为空', 'warning');
        input.focus();
        return;
      }
      if (value === (item.title || '')) {
        renderConversations();
        return;
      }
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中';
      try {
        var updated = await chat.renameConversation(item.id, value);
        item.title = (updated && updated.title) || value;
        if (String(state.activeId) === String(item.id)) {
          state.activeTitle = item.title;
          paintTopbar();
        }
        CL.toast('会话已重命名', 'success');
        renderConversations();
      } catch (err) {
        CL.toast(err.message || '重命名失败', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    }

    input.addEventListener('keydown', function (ev) {
      if (ev.isComposing) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        renderConversations();
      }
    });
    saveBtn.addEventListener('click', function (ev) { ev.preventDefault(); commit(); });
    cancelBtn.addEventListener('click', function (ev) { ev.preventDefault(); renderConversations(); });
  }

  async function removeConversation(id) {
    if (!requireLogin()) return;
    var item = findConversation(id);
    if (!item) return;
    var title = item.title || '未命名对话';
    var count = Number(item.messageCount) || 0;
    var ok = await CL.confirmDialog(
      '「' + title + '」及其中的 ' + count + ' 条消息将被永久删除，且无法恢复。',
      { title: '删除会话', confirmText: '删除', cancelText: '取消', danger: true }
    );
    if (!ok) return;
    try {
      await chat.deleteConversation(item.id);
      CL.toast('会话已删除', 'success');
      state.conversations = state.conversations.filter(function (entry) {
        return String(entry.id) !== String(item.id);
      });
      if (String(state.activeId) === String(item.id)) {
        state.loadToken += 1;
        resetToEmpty();
      } else {
        renderConversations();
      }
      await loadConversations();
    } catch (err) {
      CL.toast(err.message || '删除失败', 'error');
    }
  }

  /* ============================================================
     发送 / 流式接收
     ============================================================ */
  function stopStreaming() {
    if (!state.controller) return;
    try { state.controller.abort(); } catch (err) { /* 已中止 */ }
  }

  async function sendMessage() {
    if (!requireLogin()) return;
    if (state.chatDisabled) {
      CL.toast(CHAT_DISABLED_TEXT, 'warning');
      return;
    }
    if (state.streaming) return;
    var text = dom.input ? dom.input.value.trim() : '';
    if (!text) {
      CL.toast('请输入消息内容', 'warning');
      if (dom.input) dom.input.focus();
      return;
    }
    if (!state.models.length || !state.modelId) {
      CL.toast('暂无可用模型，请联系管理员在后台启用模型', 'warning');
      return;
    }

    dom.input.value = '';
    dom.input.style.height = 'auto';
    state.follow = true;

    var userMessage = { id: null, role: 'user', content: text, createdAt: new Date().toISOString() };
    state.messages.push(userMessage);
    appendMessage(userMessage);
    paintInfo();
    stickToBottom(true);

    var reply = appendMessage({ role: 'assistant', content: '', createdAt: null });
    reply.node.classList.add('is-streaming');
    stickToBottom(true);

    state.streaming = true;
    state.controller = new window.AbortController();
    updateComposer();
    setStatus('busy');

    var assembled = '';
    var conversationId = state.activeId;
    var failure = null;

    try {
      var result = await chat.streamCompletion({
        conversationId: conversationId,
        modelId: state.modelId,
        message: text,
        signal: state.controller.signal,
        onEvent: function (event) {
          if (event.type === 'start') {
            if (event.conversationId !== undefined && event.conversationId !== null && state.activeId === null) {
              state.activeId = String(event.conversationId);
              paintTopbar();
            }
            if (typeof event.modelName === 'string' && event.modelName) {
              state.activeModelName = event.modelName;
              paintTopbar();
            }
            return;
          }
          if (event.type === 'delta') {
            assembled += typeof event.content === 'string' ? event.content : '';
            reply.text.textContent = assembled;
            stickToBottom();
            return;
          }
          if (event.type === 'done') {
            if (typeof event.content === 'string' && event.content) {
              assembled = event.content;
              reply.text.textContent = assembled;
            }
            if (event.assistantMessageId !== undefined && event.assistantMessageId !== null) {
              reply.node.dataset.messageId = String(event.assistantMessageId);
            }
          }
        }
      });
      reply.node.classList.remove('is-streaming');
      reply.node.classList.add('is-done');
      reply.text.textContent = assembled;
      reply.time.textContent = timeLabel(new Date());
      state.messages.push({
        id: result.assistantMessageId,
        role: 'assistant',
        content: assembled,
        createdAt: new Date().toISOString()
      });
    } catch (err) {
      reply.node.classList.remove('is-streaming');
      reply.text.textContent = assembled;
      reply.time.textContent = timeLabel(new Date());
      if (err && (err.name === 'AbortError' || err.stopped)) {
        reply.node.classList.add('is-stopped');
        addNote(reply, '已停止生成', 'note');
        CL.toast('已停止生成', 'info');
      } else if (err && err.code === 'CHAT_DISABLED') {
        failure = err;
        reply.node.classList.add('is-error');
        addNote(reply, CHAT_DISABLED_TEXT, 'error');
        CL.toast(CHAT_DISABLED_TEXT, 'warning');
        state.chatDisabled = true;
        if (dom.input) dom.input.disabled = true;
      } else {
        failure = err;
        reply.node.classList.add('is-error');
        addNote(reply, '生成失败：' + ((err && err.message) || '请稍后重试'), 'error');
        CL.toast((err && err.message) || '发送失败，请稍后重试', 'error');
      }
      if (assembled) {
        state.messages.push({
          id: null,
          role: 'assistant',
          content: assembled,
          createdAt: new Date().toISOString()
        });
      }
    } finally {
      state.streaming = false;
      state.controller = null;
      updateComposer();
      paintInfo();
      if (!isGuest() && state.models.length) setStatus('online');
      await loadConversations();
      paintTopbar();
    }
    void failure;
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindEvents() {
    if (dom.form) {
      dom.form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        sendMessage();
      });
    }

    if (dom.input) {
      dom.input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' || ev.shiftKey) return;
        if (ev.isComposing || ev.keyCode === 229) return;
        ev.preventDefault();
        sendMessage();
      });
    }

    if (dom.stop) dom.stop.addEventListener('click', function () { stopStreaming(); });

    if (dom.model) {
      dom.model.addEventListener('change', function () {
        state.modelId = dom.model.value;
        paintInfo();
        updateComposer();
      });
    }

    if (dom.messages) {
      dom.messages.addEventListener('scroll', function () { state.follow = nearBottom(); }, { passive: true });
    }

    /* 搜索防抖 300ms */
    if (dom.search) {
      dom.search.addEventListener('input', function () {
        window.clearTimeout(state.searchTimer);
        state.searchTimer = window.setTimeout(function () {
          state.keyword = dom.search.value.trim();
          loadConversations();
        }, SEARCH_DELAY);
      });
    }

    var newBtn = qs('[data-chat-new]');
    if (newBtn) {
      newBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        newConversation();
      });
    }

    document.addEventListener('click', function (ev) {
      if (!ev.target || typeof ev.target.closest !== 'function') return;
      var openBtn = ev.target.closest('[data-chat-open]');
      if (openBtn) {
        ev.preventDefault();
        openConversation(openBtn.getAttribute('data-chat-open'));
        return;
      }
      var renameBtn = ev.target.closest('[data-chat-rename]');
      if (renameBtn) {
        ev.preventDefault();
        startRename(renameBtn.getAttribute('data-chat-rename'));
        return;
      }
      var deleteBtn = ev.target.closest('[data-chat-delete]');
      if (deleteBtn) {
        ev.preventDefault();
        removeConversation(deleteBtn.getAttribute('data-chat-delete'));
      }
    });
  }

  /* ---------- 游客视图 ---------- */
  function renderGuestView() {
    state.models = [];
    state.conversations = [];
    state.modelId = '';
    fillModelSelect();
    renderConversations();
    if (dom.historyNote) dom.historyNote.textContent = '登录后这里会列出你的历史对话。';
    updateComposer();
    paintInfo();
    setStatus('idle');
  }

  function prefillFromQuery() {
    if (!dom.input) return;
    var q = '';
    try { q = new URLSearchParams(window.location.search).get('q') || ''; } catch (err) { q = ''; }
    if (!q.trim()) return;
    dom.input.value = q.trim();
    dom.input.dispatchEvent(new Event('input', { bubbles: true }));
    dom.input.focus();
  }

  async function readSession() {
    if (CL.guard && CL.guard.ready) {
      try { return await CL.guard.ready; } catch (err) { return null; }
    }
    if (CL.auth && CL.auth.me) {
      try { return await CL.auth.me(); } catch (err) { return null; }
    }
    return null;
  }

  async function init() {
    cacheDom();
    if (!dom.messages || !dom.thread) return;
    bindEvents();
    paintInfo();
    paintTopbar();
    updateComposer();
    setStatus('idle');
    watchChatSwitch();

    state.user = (await readSession()) || null;
    if (isGuest()) {
      renderGuestView();
      return;
    }

    if (dom.model) {
      dom.model.innerHTML = '';
      dom.model.appendChild(el('option', { value: '', text: '模型加载中…' }));
    }
    await Promise.all([loadModels(), loadConversations()]);
    prefillFromQuery();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
