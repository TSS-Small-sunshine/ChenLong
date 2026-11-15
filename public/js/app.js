/* ============================================================
   尘龙 ChenLong · 通用前端工具 app.js（阶段 1）
   暴露 window.CL：
     qs / qsa / el        选择器与 DOM 助手
     formatTime           时间格式化（相对时间 / 绝对时间）
     toast                轻提示
     confirmDialog        二次确认（Promise<boolean>）
     fetchJSON            JSON 请求封装（解包 {error:{code,message}}、401 跳登录）
     flash                跨页提示（登录 / 登出后落地页 toast）
     url                  站内绝对路径解析
   另有导航/抽屉/弹窗/输入框自适应等纯前端交互初始化。
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var BASE = resolveBase();

  /* ---------- 基础助手 ---------- */
  function resolveBase() {
    var cs = document.currentScript;
    if (cs && cs.src) return rootOf(cs.src);
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || '';
      if (/\/js\/app\.js(\?|$)/.test(src)) return rootOf(src);
    }
    return './';
  }

  function rootOf(src) {
    var base = src.replace(/js\/app\.js[^/]*$/, '');
    return base || './';
  }

  function qs(selector, scope) {
    if (selector && typeof selector !== 'string') return selector;
    return (scope || document).querySelector(selector);
  }

  function qsa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') {
          Object.keys(value).forEach(function (k) {
            node.setAttribute('data-' + k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }), value[k]);
          });
        } else node.setAttribute(key, value === true ? '' : value);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  /* ---------- 站内路径 ---------- */
  CL.root = BASE;
  CL.url = function (path) {
    return BASE + String(path || '').replace(/^\.?\//, '');
  };
  CL.go = function (path) {
    window.location.assign(CL.url(path));
  };

  /* ---------- 时间格式化 ---------- */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function toDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === 'number') return new Date(value);
    if (typeof value === 'string') {
      var text = value.trim();
      if (!text) return null;
      var parsed = new Date(text);
      if (!isNaN(parsed.getTime())) return parsed;
      // 兼容 "2025-01-02 03:04:05"：部分环境只认斜杠格式
      if (/^\d{4}-\d{2}-\d{2}[ T]/.test(text)) {
        parsed = new Date(text.replace(/-/g, '/'));
        if (!isNaN(parsed.getTime())) return parsed;
      }
      return null;
    }
    return null;
  }

  function formatTime(value, mode) {
    var date = toDate(value);
    if (!date) return '—';
    mode = mode || 'auto';
    var stamp = date.getTime();
    var diff = Date.now() - stamp;
    var y = date.getFullYear();

    if (mode === 'auto') {
      if (diff >= 0 && diff < 60 * 1000) return '刚刚';
      if (diff >= 0 && diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
      if (diff >= 0 && diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
      if (diff >= 0 && diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
      mode = 'datetime';
    }
    if (mode === 'time') return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    if (mode === 'date') return y + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    if (mode === 'month-day') return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    return y + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  /* ---------- Toast ---------- */
  var TOAST_TYPES = { info: true, success: true, error: true, warning: true };

  function toast(message, type, duration) {
    if (!TOAST_TYPES[type]) type = 'info';
    var host = qs('#cl-toasts');
    if (!host) {
      host = el('div', { id: 'cl-toasts', class: 'cl-toasts', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(host);
    }
    var node = el('div', { class: 'cl-toast cl-toast--' + type });
    node.appendChild(el('div', { class: 'cl-toast__text', text: String(message === null || message === undefined ? '' : message) }));
    host.appendChild(node);

    var timer = window.setTimeout(dismiss, typeof duration === 'number' ? duration : 3200);
    node.addEventListener('click', dismiss);

    function dismiss() {
      window.clearTimeout(timer);
      if (node.classList.contains('is-leaving')) return;
      node.classList.add('is-leaving');
      window.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 240);
    }
    return node;
  }

  /* ---------- 滚动锁 ---------- */
  var lockCount = 0;
  function lockScroll() {
    lockCount += 1;
    document.body.classList.add('cl-modal-open');
  }
  function unlockScroll() {
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) document.body.classList.remove('cl-modal-open');
  }

  /* ---------- 二次确认 ---------- */
  function confirmDialog(message, options) {
    options = options || {};
    return new Promise(function (resolve) {
      var lastFocus = document.activeElement;
      var settled = false;
      var modal = el('div', { class: 'cl-modal cl-confirm', role: 'dialog', 'aria-modal': 'true' });
      var panel = el('div', { class: 'cl-modal__panel cl-confirm__panel' });
      var icon = el('div', { class: 'cl-confirm__icon' + (options.danger ? ' cl-confirm__icon--danger' : '') });
      var head = el('div', { class: 'cl-modal__head' }, [
        el('div', {}, [icon, el('h3', { class: 'cl-modal__title', text: options.title || '请确认' })])
      ]);
      var body = el('div', { class: 'cl-modal__body' }, [
        el('p', { text: String(message || '确定要执行该操作吗？') })
      ]);
      var cancelBtn = el('button', { type: 'button', class: 'cl-btn cl-btn--ghost', text: options.cancelText || '取消' });
      var okBtn = el('button', {
        type: 'button',
        class: 'cl-btn ' + (options.danger ? 'cl-btn--danger' : 'cl-btn--primary'),
        text: options.confirmText || '确定'
      });
      var foot = el('div', { class: 'cl-modal__foot' }, [cancelBtn, okBtn]);

      panel.appendChild(head);
      panel.appendChild(body);
      panel.appendChild(foot);
      modal.appendChild(el('div', { class: 'cl-modal__backdrop' }));
      modal.appendChild(panel);
      document.body.appendChild(modal);
      lockScroll();
      window.requestAnimationFrame(function () { modal.classList.add('is-open'); });

      function close(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        modal.classList.remove('is-open');
        unlockScroll();
        window.setTimeout(function () {
          if (modal.parentNode) modal.parentNode.removeChild(modal);
        }, 240);
        if (lastFocus && typeof lastFocus.focus === 'function') {
          try { lastFocus.focus(); } catch (err) { /* 忽略失焦元素 */ }
        }
        resolve(result);
      }

      function onKey(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          close(false);
          return;
        }
        if (ev.key === 'Tab') {
          var items = [cancelBtn, okBtn];
          var index = items.indexOf(document.activeElement);
          ev.preventDefault();
          if (index === -1) items[0].focus();
          else items[(index + (ev.shiftKey ? items.length - 1 : 1)) % items.length].focus();
        }
      }

      cancelBtn.addEventListener('click', function () { close(false); });
      okBtn.addEventListener('click', function () { close(true); });
      qs('.cl-modal__backdrop', modal).addEventListener('click', function () { close(false); });
      document.addEventListener('keydown', onKey, true);
      okBtn.focus();
    });
  }

  /* ---------- 登录跳转 ---------- */
  function redirectToLogin() {
    if (CL._redirecting) return;
    var path = window.location.pathname || '';
    if (/\/login\.html$/.test(path) || /\/register\.html$/.test(path)) return;
    CL._redirecting = true;
    var next = path + (window.location.search || '');
    window.location.assign(CL.url('login.html?redirect=' + encodeURIComponent(next)));
  }

  /* ---------- 跨页提示（跳转后仍能看到的那条 toast） ---------- */
  var FLASH_KEY = 'cl:flash';

  function flash(message, type) {
    try {
      window.sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message: String(message || ''), type: type || 'success' }));
    } catch (err) { /* 隐私模式下 sessionStorage 可能不可用，忽略 */ }
  }

  function flushFlash() {
    var raw = null;
    try {
      raw = window.sessionStorage.getItem(FLASH_KEY);
      if (raw) window.sessionStorage.removeItem(FLASH_KEY);
    } catch (err) { return; }
    if (!raw) return;
    var payload = null;
    try { payload = JSON.parse(raw); } catch (err) { return; }
    if (payload && payload.message) toast(payload.message, payload.type);
  }

  /* ---------- 后端错误信封解析 ----------
     后端统一返回 { error: { code, message } }；兼容旧的 data.message / data.msg。 */
  function parseErrorPayload(data) {
    var parsed = { code: '', message: '' };
    if (data && typeof data === 'object') {
      var envelope = data.error;
      if (envelope && typeof envelope === 'object') {
        if (typeof envelope.message === 'string') parsed.message = envelope.message;
        if (typeof envelope.code === 'string') parsed.code = envelope.code;
      } else if (typeof envelope === 'string') {
        parsed.message = envelope;
      }
      if (!parsed.message && typeof data.message === 'string') parsed.message = data.message;
      if (!parsed.message && typeof data.msg === 'string') parsed.message = data.msg;
      if (!parsed.code && typeof data.code === 'string') parsed.code = data.code;
    } else if (typeof data === 'string') {
      parsed.message = data.slice(0, 200);
    }
    return parsed;
  }

  /* ---------- CSRF 令牌 ----------
     服务端对 /api 下的非安全方法（POST/PUT/PATCH/DELETE）校验 X-CSRF-Token；
     token 只放内存，绝不写 localStorage / URL。 */
  var csrfToken = null;
  var csrfPending = null;

  function csrfEnsure() {
    if (csrfToken) return Promise.resolve(csrfToken);
    if (csrfPending) return csrfPending;
    // 并发调用共享同一个请求；结束（成功或失败）后清空占位，失败时下次重新获取
    csrfPending = fetch(CL.url('/api/csrf-token'), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('无法获取安全令牌（HTTP ' + response.status + '）');
      return response.json();
    }).then(function (data) {
      var token = data && typeof data.token === 'string' ? data.token : '';
      if (!token) throw new Error('无法获取安全令牌');
      return token;
    });
    csrfPending = csrfPending.then(function (token) {
      csrfPending = null;
      csrfToken = token;
      return token;
    }, function (err) {
      csrfPending = null;
      throw err;
    });
    return csrfPending;
  }

  var csrf = {
    /* 取 token：有缓存直接返回，并发只发一次 GET /api/csrf-token */
    ensure: csrfEnsure,
    /* 同步读缓存，没有则为 null */
    get: function () { return csrfToken; },
    /* 登录 / 注册后写入服务端下发的新 token */
    set: function (token) {
      csrfToken = typeof token === 'string' && token ? token : null;
      return csrfToken;
    },
    clear: function () {
      csrfToken = null;
      csrfPending = null;
    }
  };

  /* ---------- fetchJSON ---------- */
  async function fetchJSON(url, options) {
    var opts = Object.assign({}, options || {});
    var noAuthRedirect = opts.noAuthRedirect === true;
    delete opts.noAuthRedirect;
    var headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    var body = opts.body;
    var isForm = typeof window.FormData !== 'undefined' && body instanceof window.FormData;
    var isBlob = typeof window.Blob !== 'undefined' && body instanceof window.Blob;
    if (body !== undefined && body !== null && !isForm && !isBlob && typeof body !== 'string') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      opts.body = JSON.stringify(body);
    }
    opts.headers = headers;
    opts.credentials = opts.credentials || 'same-origin';
    if (!opts.method) opts.method = 'GET';

    // 非安全方法先拿 token：GET / HEAD 不需要
    var withCsrf = needsCsrfToken(opts.method);
    if (withCsrf) await attachCsrfToken(opts);

    var attempt = await sendJSON(url, opts);
    if (!attempt.response.ok) {
      var details = parseErrorPayload(attempt.data);
      // 页面 token 与会话不同步（会话重建 / 页面放太久）：重取一次 + 只重试一次
      if (withCsrf && attempt.response.status === 403 && details.code === 'CSRF_INVALID') {
        csrf.clear();
        await attachCsrfToken(opts);
        attempt = await sendJSON(url, opts);
        details = parseErrorPayload(attempt.data);
      }
      if (!attempt.response.ok) {
        // 游客页（首页 / 对话页）用 noAuthRedirect 读取 me()，401 不能被踢去登录页
        if (attempt.response.status === 401 && !noAuthRedirect) redirectToLogin();
        var httpError = new Error(details.message || '请求失败（HTTP ' + attempt.response.status + '）');
        httpError.status = attempt.response.status;
        httpError.code = details.code;
        httpError.data = attempt.data;
        httpError.url = url;
        throw httpError;
      }
    }
    return attempt.data;
  }

  function needsCsrfToken(method) {
    var verb = String(method || 'GET').toUpperCase();
    return verb !== 'GET' && verb !== 'HEAD';
  }

  async function attachCsrfToken(opts) {
    var token = await csrf.ensure();
    opts.headers['X-CSRF-Token'] = token;
    return token;
  }

  /* 单次发送 + 解析响应体；403 重试时复用同一份 opts（body 已序列化） */
  async function sendJSON(url, opts) {
    var response;
    try {
      response = await fetch(url, opts);
    } catch (networkError) {
      var netErr = new Error('无法连接服务器，请确认后端服务已启动');
      netErr.status = 0;
      netErr.cause = networkError;
      throw netErr;
    }

    var text = await response.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (parseError) { data = text; }
    }
    return { response: response, data: data };
  }

  /* ---------- 前台设置（GET /api/settings） ----------
     公开接口，但可能失败、可能字段缺失：一律静默回退默认值，
     绝不阻塞渲染、绝不用错误弹窗打扰用户。 */
  var SETTING_DEFAULTS = {
    siteName: '尘龙 ChenLong',
    siteSubtitle: 'Your Little AI Companion',
    allowRegister: true,
    allowChat: true,
    announcement: '',
    logo: '/assets/mascot/logo.png'
  };
  var ANNOUNCE_KEY = 'cl:announce-dismissed';
  var settingsData = null;
  var settingsPromise = null;

  function settingText(value, fallback) {
    if (typeof value !== 'string') return fallback;
    var text = value.trim();
    return text || fallback;
  }

  function settingBool(value, fallback) {
    if (value === false || value === 0 || value === 'false' || value === '0') return false;
    if (value === true || value === 1 || value === 'true' || value === '1') return true;
    return fallback;
  }

  /* 只接受站内路径（/ 开头且不是 //）与 http(s) 绝对地址：
     拒绝 javascript:/data: 等其他 scheme 与协议相对地址，避免设置把页面请求带走。 */
  function settingLogo(value) {
    if (typeof value !== 'string') return SETTING_DEFAULTS.logo;
    var url = value.trim();
    if (!url) return SETTING_DEFAULTS.logo;
    if (url.charAt(0) === '/' && url.charAt(1) !== '/') return url;
    if (/^https?:\/\//i.test(url)) return url;
    return SETTING_DEFAULTS.logo;
  }

  function normalizeSettings(raw) {
    var items = raw && typeof raw === 'object' ? (raw.items || raw.data) : null;
    if (!items || typeof items !== 'object') items = {};
    return {
      siteName: settingText(items.siteName, SETTING_DEFAULTS.siteName),
      siteSubtitle: settingText(items.siteSubtitle, SETTING_DEFAULTS.siteSubtitle),
      allowRegister: settingBool(items.allowRegister, SETTING_DEFAULTS.allowRegister),
      allowChat: settingBool(items.allowChat, SETTING_DEFAULTS.allowChat),
      announcement: typeof items.announcement === 'string' ? items.announcement.trim() : SETTING_DEFAULTS.announcement,
      logo: settingLogo(items.logo)
    };
  }

  /* 站点名沿用「主行 + em 副行」的原版式：按首个空格拆成两行 */
  function paintSiteName(node, name) {
    var em = node.querySelector('em');
    if (!em) {
      node.textContent = name;
      return;
    }
    var at = name.indexOf(' ');
    var head = at === -1 ? name : name.slice(0, at);
    var tail = at === -1 ? '' : name.slice(at + 1).trim();
    var first = node.firstChild;
    if (first && first.nodeType === 3) first.nodeValue = head;
    else node.insertBefore(document.createTextNode(head), node.firstChild);
    em.textContent = tail;
    em.hidden = !tail;
  }

  /* http(s) 绝对地址原样使用；站内路径补全站点根，避免被 CL.url 二次拼接 */
  function logoSrc(src) {
    if (/^https?:\/\//i.test(src)) return src;
    return src.charAt(0) === '/' ? src : CL.url(src);
  }

  /* logo 加载成功才显示；失败就保持 CSS 绘制的占位，绝不出现破图 */
  function paintSiteLogo(img, src) {
    if (!src) return;
    var mark = img.parentNode;
    img.addEventListener('load', function () {
      img.hidden = false;
      if (mark && mark.classList) mark.classList.add('has-img');
    });
    img.addEventListener('error', function () {
      img.hidden = true;
      img.removeAttribute('src');
    });
    img.hidden = true;
    img.setAttribute('src', logoSrc(src));
  }

  function announceDismissed() {
    try { return window.sessionStorage.getItem(ANNOUNCE_KEY) === '1'; } catch (err) { return false; }
  }

  /* 公告条插在页头下方：站点头部 → 对话顶栏 → 登录/注册页品牌区之后（卡片之前） */
  function announceSlot() {
    var header = qs('.cl-header');
    if (header && header.parentNode) return { parent: header.parentNode, before: header.nextSibling };
    var topbar = qs('.chat-topbar');
    if (topbar && topbar.parentNode) return { parent: topbar.parentNode, before: topbar.nextSibling };
    var card = qs('.auth .cl-card');
    if (card && card.parentNode) return { parent: card.parentNode, before: card };
    var logo = qs('.auth .cl-logo') || qs('.cl-logo');
    if (logo && logo.parentNode) return { parent: logo.parentNode, before: logo.nextSibling };
    var main = qs('main');
    if (main) return { parent: main, before: main.firstChild };
    return null;
  }

  function renderAnnouncement(text) {
    if (!text || announceDismissed() || qs('.cl-announce')) return;
    var slot = announceSlot();
    if (!slot) return;
    var close = el('button', { type: 'button', class: 'cl-announce__close', 'aria-label': '关闭公告', text: '×' });
    var bar = el('div', { class: 'cl-announce', role: 'status' }, [
      el('span', { class: 'cl-announce__text', text: text }),
      close
    ]);
    close.addEventListener('click', function () {
      try { window.sessionStorage.setItem(ANNOUNCE_KEY, '1'); } catch (err) { /* 隐私模式忽略 */ }
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });
    slot.parent.insertBefore(bar, slot.before);
  }

  function applySettings(data) {
    try {
      qsa('[data-site-name]').forEach(function (node) { paintSiteName(node, data.siteName); });
      qsa('[data-site-subtitle]').forEach(function (node) { node.textContent = data.siteSubtitle; });
      qsa('img[data-site-logo]').forEach(function (img) { paintSiteLogo(img, data.logo); });
      renderAnnouncement(data.announcement);
    } catch (err) { /* 渲染失败不影响页面其余部分 */ }
  }

  /* 同一页面只发一次请求；失败回退默认值，Promise 永不 reject */
  function loadSettings() {
    if (settingsPromise) return settingsPromise;
    settingsPromise = fetchJSON(CL.url('/api/settings'), { noAuthRedirect: true })
      .then(function (data) { return normalizeSettings(data); }, function () { return normalizeSettings(null); })
      .then(function (data) {
        settingsData = data;
        applySettings(data);
        return data;
      });
    return settingsPromise;
  }

  function currentSettings() {
    return settingsData || SETTING_DEFAULTS;
  }

  /* ---------- 弹窗（data-modal-open / data-modal-close） ---------- */
  function openModal(modal) {
    if (!modal || !isElement(modal)) return;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    lockScroll();
    var focusTarget = qs('[data-autofocus]', modal) || qs('input:not([type=hidden]),select,textarea,button', modal);
    if (focusTarget) window.setTimeout(function () { focusTarget.focus(); }, 60);
  }

  function closeModal(modal) {
    if (!modal || !isElement(modal)) return;
    if (!modal.classList.contains('is-open')) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    unlockScroll();
  }

  function initModals() {
    document.addEventListener('click', function (ev) {
      if (!isElement(ev.target)) return;
      var opener = ev.target.closest('[data-modal-open]');
      if (opener) {
        ev.preventDefault();
        openModal(qs(opener.getAttribute('data-modal-open')));
        return;
      }
      var closer = ev.target.closest('[data-modal-close]');
      if (closer) {
        ev.preventDefault();
        closeModal(closer.closest('.cl-modal'));
        return;
      }
      if (ev.target.classList.contains('cl-modal__backdrop')) closeModal(ev.target.closest('.cl-modal'));
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var opened = qs('.cl-modal.is-open');
      if (opened) closeModal(opened);
    });
  }

  /* ---------- 导航 ---------- */
  function initHeaderNav() {
    qsa('.cl-header').forEach(function (header) {
      var burger = qs('.cl-burger', header);
      var nav = qs('.cl-nav', header);
      if (!burger || !nav) return;
      function close() {
        header.classList.remove('is-nav-open');
        burger.setAttribute('aria-expanded', 'false');
      }
      burger.addEventListener('click', function () {
        var open = header.classList.toggle('is-nav-open');
        burger.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          var first = qs('a,button', nav);
          if (first) first.focus();
        }
      });
      nav.addEventListener('click', function (ev) {
        if (isElement(ev.target) && ev.target.closest('a')) close();
      });
      document.addEventListener('click', function (ev) {
        if (!isElement(ev.target) || !header.contains(ev.target)) close();
      });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') close();
      });
    });
  }

  /* ---------- 后台抽屉 ---------- */
  function initAdminDrawer() {
    var nav = qs('.admin-nav');
    if (!nav) return;
    var backdrop = qs('.admin-nav-backdrop');
    var toggles = qsa('[data-admin-toggle]');
    if (!backdrop) {
      backdrop = el('div', { class: 'admin-nav-backdrop' });
      document.body.appendChild(backdrop);
    }
    function setOpen(open) {
      nav.classList.toggle('is-open', open);
      backdrop.classList.toggle('is-open', open);
      toggles.forEach(function (btn) { btn.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    }
    toggles.forEach(function (btn) {
      btn.addEventListener('click', function () {
        setOpen(!nav.classList.contains('is-open'));
      });
    });
    backdrop.addEventListener('click', function () { setOpen(false); });
    nav.addEventListener('click', function (ev) {
      if (isElement(ev.target) && ev.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') setOpen(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900) setOpen(false);
    });
  }

  /* ---------- 待接入接口的按钮 ---------- */
  function initPendingActions() {
    document.addEventListener('click', function (ev) {
      if (!isElement(ev.target)) return;
      var btn = ev.target.closest('[data-pending]');
      if (!btn) return;
      ev.preventDefault();
      var label = btn.getAttribute('data-pending') || btn.textContent.trim() || '该操作';
      toast(label + '：该功能尚未开放', 'info');
    });
  }

  /* ---------- 输入联想填充 ---------- */
  function initSuggestions() {
    document.addEventListener('click', function (ev) {
      if (!isElement(ev.target)) return;
      var chip = ev.target.closest('[data-suggest]');
      if (!chip) return;
      var target = qs(chip.getAttribute('data-suggest-target') || '#hero-input');
      if (!target) return;
      target.value = chip.getAttribute('data-suggest') || chip.textContent.trim();
      target.focus();
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  /* ---------- 进入对话页 ---------- */
  function initChatEntry() {
    qsa('[data-chat-entry]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        var selector = btn.getAttribute('data-chat-entry');
        if (!selector) return;
        ev.preventDefault();
        var input = qs(selector);
        var value = input && input.value ? input.value.trim() : '';
        var url = CL.url('chat.html');
        if (value) url += '?q=' + encodeURIComponent(value);
        window.location.assign(url);
      });
    });
  }

  /* ---------- 文本域自适应高度 ---------- */
  function initAutosize() {
    function resize(node) {
      node.style.height = 'auto';
      var max = parseInt(window.getComputedStyle(node).maxHeight, 10);
      var next = node.scrollHeight;
      if (!isNaN(max) && next > max) next = max;
      node.style.height = next + 'px';
    }
    document.addEventListener('input', function (ev) {
      if (isElement(ev.target) && ev.target.matches('[data-autosize], .chat-composer textarea')) resize(ev.target);
    });
    qsa('[data-autosize], .chat-composer textarea').forEach(resize);
  }

  /* ---------- 对话页会话栏抽屉 ---------- */
  function initChatDrawer() {
    var sidebar = qs('.chat-sidebar');
    if (!sidebar) return;
    var backdrop = qs('[data-chat-sidebar-backdrop]');
    var toggles = qsa('[data-chat-sidebar-toggle]');
    var closers = qsa('[data-chat-sidebar-close]');
    function setOpen(open) {
      sidebar.classList.toggle('is-open', open);
      if (backdrop) backdrop.classList.toggle('is-open', open);
      toggles.forEach(function (btn) { btn.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    }
    toggles.forEach(function (btn) {
      btn.addEventListener('click', function () { setOpen(!sidebar.classList.contains('is-open')); });
    });
    closers.forEach(function (btn) { btn.addEventListener('click', function () { setOpen(false); }); });
    if (backdrop) backdrop.addEventListener('click', function () { setOpen(false); });
    sidebar.addEventListener('click', function (ev) {
      if (isElement(ev.target) && ev.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') setOpen(false);
    });
  }

  /* ---------- 尚未接入接口的表单 ---------- */
  function initPendingForms() {
    qsa('[data-pending-form]').forEach(function (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var label = form.getAttribute('data-pending-form') || '该操作';
        toast(label + '：该功能尚未开放', 'info');
      });
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    initHeaderNav();
    initChatDrawer();
    initPendingForms();
    initAdminDrawer();
    initModals();
    initPendingActions();
    initSuggestions();
    initChatEntry();
    initAutosize();
    flushFlash();
  }

  /* 设置接口：ready 是「取回并渲染完成」的 Promise，get() 永远返回可用对象 */
  CL.settings = {
    defaults: SETTING_DEFAULTS,
    load: loadSettings,
    get: currentSettings,
    ready: loadSettings()
  };

  CL.qs = qs;
  CL.qsa = qsa;
  CL.el = el;
  CL.formatTime = formatTime;
  CL.toast = toast;
  CL.confirmDialog = confirmDialog;
  CL.csrf = csrf;
  CL.fetchJSON = fetchJSON;
  CL.flash = flash;
  CL.openModal = openModal;
  CL.closeModal = closeModal;
  CL.init = init;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window, document);
