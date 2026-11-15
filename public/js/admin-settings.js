/* ============================================================
   尘龙 ChenLong · 系统设置（阶段 5：真实接口）
   接口：GET   /api/settings   → { items:{ siteName, siteSubtitle, allowRegister, allowChat, announcement, logo } }
        PATCH /api/settings   body 任意子集 → { items }
   页面：public/admin/settings.html（存在 [data-settings-form] 时接管）
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var BASE = '/api/settings';
  var TEXT_FIELDS = ['siteName', 'siteSubtitle', 'logo', 'announcement'];
  var SWITCH_FIELDS = ['allowRegister', 'allowChat'];
  var LINK_RE = /^(https?):\/\//i;
  var LOGO_RE = /^(\/|(https?):\/\/)/i;

  function endpoint() {
    return CL.url(BASE);
  }

  function messageOf(err) {
    return (err && err.message) || '操作失败，请稍后重试';
  }

  function toBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
    return false;
  }

  /* ---------- 接口封装 ---------- */
  var settingsApi = {
    base: BASE,

    /* GET /api/settings（公开接口，无需登录） */
    async get() {
      var data = await CL.fetchJSON(endpoint());
      return (data && data.items) || null;
    },

    /* PATCH /api/settings */
    async save(patch) {
      var data = await CL.fetchJSON(endpoint(), { method: 'PATCH', body: patch });
      return (data && data.items) || null;
    }
  };

  /* ---------- 页面控制（settings.html） ---------- */
  /* 公告条：app.js 把公告插在首个 .cl-logo 之后，后台会落进侧边栏品牌链接里被压成竖排；
     这里把它搬到内容区顶部，保持「页头下方」的原意。 */
  function hoistAnnouncement() {
    var bar = CL.qs('.cl-announce');
    var main = CL.qs('main');
    if (!bar || !main || bar.parentNode === main) return;
    if (!CL.qs('.admin-shell')) return;
    bar.classList.add('admin-announce');
    main.insertBefore(bar, main.firstChild);
  }

  function watchAnnouncement() {
    var nav = CL.qs('.admin-nav');
    var shell = CL.qs('.admin-shell');
    if (!shell) return;
    hoistAnnouncement();
    if (!nav || !window.MutationObserver) return;
    var observer = new window.MutationObserver(hoistAnnouncement);
    observer.observe(nav, { childList: true, subtree: true });
    window.setTimeout(function () { observer.disconnect(); hoistAnnouncement(); }, 4000);
  }

  function initPage() {
    watchAnnouncement();
    var form = CL.qs('[data-settings-form]');
    if (!form) return;

    var status = CL.qs('[data-settings-status]');
    var badge = CL.qs('[data-settings-badge]');
    var submitBtn = CL.qs('[data-settings-submit]');
    var resetBtn = CL.qs('[data-settings-reset]');
    var logoPath = CL.qs('[data-logo-path]');
    var logoPreview = CL.qs('[data-logo-preview]');
    var registerState = CL.qs('[data-register-state]');
    var chatState = CL.qs('[data-chat-state]');

    var fields = {
      siteName: CL.qs('[name="siteName"]', form),
      siteSubtitle: CL.qs('[name="siteSubtitle"]', form),
      logo: CL.qs('[name="logo"]', form),
      announcement: CL.qs('[name="announcement"]', form),
      allowRegister: CL.qs('[name="allowRegister"]', form),
      allowChat: CL.qs('[name="allowChat"]', form)
    };

    var state = {
      saved: null,
      loading: false
    };

    /* ---------- 小工具 ---------- */
    function showStatus(text, isError) {
      if (!status) return;
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('is-error', !!isError);
    }

    function setBusy(btn, busy, busyText) {
      if (!btn) return;
      if (busy) {
        if (!btn.getAttribute('data-idle-text')) {
          btn.setAttribute('data-idle-text', btn.textContent);
        }
        btn.disabled = true;
        btn.textContent = busyText || '保存中…';
        return;
      }
      var idle = btn.getAttribute('data-idle-text');
      btn.disabled = false;
      if (idle) btn.textContent = idle;
    }

    function setBadge(text, tone) {
      if (!badge) return;
      badge.textContent = text;
      badge.className = 'cl-tag ' + (tone || 'cl-tag--off');
    }

    function paintSwitchState() {
      if (registerState) {
        registerState.textContent = fields.allowRegister && fields.allowRegister.checked
          ? '允许注册：已开启，新账号可以自助注册'
          : '允许注册：已关闭，注册接口会拒绝新账号';
      }
      if (chatState) {
        chatState.textContent = fields.allowChat && fields.allowChat.checked
          ? '允许聊天：已开启，用户可以正常对话'
          : '允许聊天：已关闭，前台会提示暂停聊天服务';
      }
    }

    function paintLogoPreview() {
      var value = fields.logo ? fields.logo.value.trim() : '';
      if (logoPath) logoPath.textContent = value || '尚未设置 Logo 路径';
      if (!logoPreview) return;
      var usable = value && (value.charAt(0) === '/' || LINK_RE.test(value));
      logoPreview.classList.toggle('has-image', !!usable);
      if (usable) logoPreview.style.backgroundImage = 'url("' + value.replace(/"/g, '%22') + '")';
      else logoPreview.style.backgroundImage = '';
    }

    /* ---------- 回填 ---------- */
    function fill(items) {
      var data = items || {};
      if (fields.siteName) fields.siteName.value = data.siteName === null || data.siteName === undefined ? '' : String(data.siteName);
      if (fields.siteSubtitle) fields.siteSubtitle.value = data.siteSubtitle === null || data.siteSubtitle === undefined ? '' : String(data.siteSubtitle);
      if (fields.logo) fields.logo.value = data.logo === null || data.logo === undefined ? '' : String(data.logo);
      if (fields.announcement) fields.announcement.value = data.announcement === null || data.announcement === undefined ? '' : String(data.announcement);
      if (fields.allowRegister) fields.allowRegister.checked = toBool(data.allowRegister);
      if (fields.allowChat) fields.allowChat.checked = toBool(data.allowChat);

      paintSwitchState();
      paintLogoPreview();
    }

    function snapshot() {
      return {
        siteName: fields.siteName ? fields.siteName.value : '',
        siteSubtitle: fields.siteSubtitle ? fields.siteSubtitle.value : '',
        logo: fields.logo ? fields.logo.value : '',
        announcement: fields.announcement ? fields.announcement.value : '',
        allowRegister: fields.allowRegister ? !!fields.allowRegister.checked : false,
        allowChat: fields.allowChat ? !!fields.allowChat.checked : false
      };
    }

    function rememberSaved() {
      state.saved = snapshot();
    }

    /* ---------- 加载 ---------- */
    function load() {
      state.loading = true;
      setBadge('加载中…', 'cl-tag--off');
      showStatus('');
      if (submitBtn) submitBtn.disabled = true;

      return settingsApi.get().then(function (items) {
        fill(items);
        rememberSaved();
        setBadge('已同步', 'cl-tag--ok');
        showStatus('');
      }).catch(function (err) {
        setBadge('加载失败', 'cl-tag--danger');
        showStatus('读取系统设置失败：' + messageOf(err), true);
        CL.toast(messageOf(err), 'error');
      }).then(function () {
        state.loading = false;
        if (submitBtn) submitBtn.disabled = false;
      });
    }

    /* ---------- 校验 ---------- */
    function validate(values) {
      var siteName = values.siteName.trim();
      if (siteName.length < 1 || siteName.length > 40) return '网站名称需为 1–40 个字符';
      if (values.siteSubtitle.length > 60) return '副标题最多 60 个字符';
      if (values.announcement.length > 200) return '公告最多 200 个字符';
      var logo = values.logo.trim();
      if (logo.length > 200) return 'Logo 路径最多 200 个字符';
      if (logo && logo.charAt(0) !== '/' && !LINK_RE.test(logo)) return 'Logo 路径需以 / 开头，或以 http(s) 开头的完整地址';
      return '';
    }

    function buildPatch(values) {
      var patch = {};
      if (!state.saved) return values;
      TEXT_FIELDS.forEach(function (key) {
        var next = key === 'siteName' || key === 'logo' ? values[key].trim() : values[key];
        if (next !== state.saved[key]) patch[key] = next;
      });
      SWITCH_FIELDS.forEach(function (key) {
        if (values[key] !== state.saved[key]) patch[key] = values[key];
      });
      return patch;
    }

    /* ---------- 保存 ---------- */
    function submit(ev) {
      if (ev) ev.preventDefault();
      if (state.loading) return;

      var values = snapshot();
      var problem = validate(values);
      if (problem) {
        showStatus(problem, true);
        CL.toast(problem, 'warning');
        return;
      }

      var patch = buildPatch(values);
      if (!Object.keys(patch).length) {
        showStatus('设置没有改动，无需保存', false);
        CL.toast('设置没有改动', 'info');
        return;
      }

      showStatus('');
      setBusy(submitBtn, true, '保存中…');
      settingsApi.save(patch).then(function (items) {
        if (items) fill(items);
        else fill(values);
        rememberSaved();
        setBadge('已同步', 'cl-tag--ok');
        showStatus('');
        CL.toast('设置已保存', 'success');
      }).catch(function (err) {
        showStatus(messageOf(err), true);
        setBadge('保存失败', 'cl-tag--danger');
        CL.toast(messageOf(err), 'error');
      }).then(function () {
        setBusy(submitBtn, false);
      });
    }

    /* ---------- 事件 ---------- */
    if (form) form.addEventListener('submit', submit);

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (!state.saved) {
          CL.toast('还没有读取到服务端设置', 'warning');
          return;
        }
        fill(state.saved);
        showStatus('已恢复为最近一次保存的值', false);
        CL.toast('已撤销未保存的修改', 'info');
      });
    }

    if (fields.logo) {
      fields.logo.addEventListener('input', paintLogoPreview);
    }
    if (fields.allowRegister) {
      fields.allowRegister.addEventListener('change', paintSwitchState);
    }
    if (fields.allowChat) {
      fields.allowChat.addEventListener('change', paintSwitchState);
    }

    paintSwitchState();
    paintLogoPreview();
    load();
  }

  CL.settingsApi = settingsApi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})(window, document);
