/* ============================================================
   尘龙 ChenLong · 用户管理（阶段 5：真实接口）
   接口：GET   /api/users?keyword=&status=&role=&page=&pageSize=
        GET   /api/users/:id          详情（含 messageCount）
        PATCH /api/users/:id          { nickname?, role?, status? }
        POST  /api/users/:id/password { password } → 204
   页面：public/admin/users.html（存在 [data-users-rows] 时接管）
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var BASE = '/api/users';
  var PAGE_SIZE = 20;
  var ROLE_TEXT = { admin: '管理员', user: '普通用户' };
  var STATUS_TEXT = { active: '正常', disabled: '已禁用' };

  function endpoint(suffix) {
    return CL.url(BASE + (suffix || ''));
  }

  function itemPath(id, suffix) {
    return '/' + encodeURIComponent(String(id)) + (suffix || '');
  }

  function messageOf(err) {
    return (err && err.message) || '操作失败，请稍后重试';
  }

  /* ---------- 接口封装 ---------- */
  var usersApi = {
    base: BASE,

    /* GET /api/users?keyword=&status=&role=&page=&pageSize= */
    async list(filters) {
      var f = filters || {};
      var params = [
        'page=' + encodeURIComponent(String(f.page || 1)),
        'pageSize=' + encodeURIComponent(String(f.pageSize || PAGE_SIZE))
      ];
      if (f.keyword) params.push('keyword=' + encodeURIComponent(f.keyword));
      if (f.status) params.push('status=' + encodeURIComponent(f.status));
      if (f.role) params.push('role=' + encodeURIComponent(f.role));
      return CL.fetchJSON(endpoint('?' + params.join('&')));
    },

    /* GET /api/users/:id */
    async get(id) {
      var data = await CL.fetchJSON(endpoint(itemPath(id)));
      return (data && data.item) || null;
    },

    /* PATCH /api/users/:id */
    async update(id, payload) {
      var data = await CL.fetchJSON(endpoint(itemPath(id)), { method: 'PATCH', body: payload });
      return (data && data.item) || null;
    },

    /* POST /api/users/:id/password → 204 */
    async resetPassword(id, password) {
      await CL.fetchJSON(endpoint(itemPath(id, '/password')), {
        method: 'POST',
        body: { password: password }
      });
    }
  };

  /* ---------- 页面控制（users.html） ---------- */
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
    var tbody = CL.qs('[data-users-rows]');
    if (!tbody) return;

    var countTag = CL.qs('[data-users-count]');
    var keywordInput = CL.qs('[data-users-keyword]');
    var statusSelect = CL.qs('[data-users-status]');
    var roleSelect = CL.qs('[data-users-role]');
    var pagerInfo = CL.qs('[data-users-pageinfo]');
    var prevBtn = CL.qs('[data-users-prev]');
    var nextBtn = CL.qs('[data-users-next]');
    var refreshBtn = CL.qs('[data-users-refresh]');

    var detailModal = CL.qs('#user-detail-modal');
    var detailBody = CL.qs('[data-detail-body]');
    var detailSub = CL.qs('[data-detail-sub]');

    var roleModal = CL.qs('#user-role-modal');
    var roleForm = CL.qs('[data-role-form]');
    var roleSelectEl = CL.qs('[data-role-select]');
    var roleSub = CL.qs('[data-role-sub]');
    var roleError = CL.qs('[data-role-error]');
    var roleSubmit = CL.qs('[data-role-submit]');

    var passwordModal = CL.qs('#user-password-modal');
    var passwordForm = CL.qs('[data-admin-password-form]');
    var passwordNew = CL.qs('[data-password-new]');
    var passwordConfirm = CL.qs('[data-password-confirm]');
    var passwordError = CL.qs('[data-password-error]');
    var passwordSub = CL.qs('[data-password-sub]');
    var passwordSubmit = CL.qs('[data-password-submit]');

    var state = {
      items: [],
      total: 0,
      page: 1,
      pageSize: PAGE_SIZE,
      keyword: '',
      status: '',
      role: '',
      me: null,
      seq: 0,
      target: null
    };

    var searchTimer = null;

    /* ---------- 小工具 ---------- */
    function pages() {
      return Math.max(1, Math.ceil(state.total / state.pageSize));
    }

    function textOf(value) {
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    }

    function countOf(value) {
      var n = Number(value);
      return isFinite(n) ? String(n) : '—';
    }

    function showHint(node, text) {
      if (!node) return;
      node.textContent = text;
      node.hidden = false;
      node.classList.add('is-error');
    }

    function hideHint(node) {
      if (!node) return;
      node.textContent = '';
      node.hidden = true;
      node.classList.remove('is-error');
    }

    function setBusy(btn, busy, busyText) {
      if (!btn) return;
      if (busy) {
        if (!btn.getAttribute('data-idle-text')) {
          btn.setAttribute('data-idle-text', btn.textContent);
        }
        btn.disabled = true;
        btn.textContent = busyText || '处理中…';
        return;
      }
      var idle = btn.getAttribute('data-idle-text');
      btn.disabled = false;
      if (idle) btn.textContent = idle;
    }

    /* ---------- 表格状态行 ---------- */
    function stateRow(content) {
      return CL.el('tr', { class: 'cl-table__empty' }, [
        CL.el('td', { colspan: '8' }, [content])
      ]);
    }

    function messageRow(text) {
      return stateRow(CL.el('div', { class: 'admin-table-state', text: text }));
    }

    function emptyRow() {
      var filtered = !!(state.keyword || state.status || state.role);
      return stateRow(CL.el('div', { class: 'cl-empty cl-empty--compact' }, [
        CL.el('div', { class: 'cl-empty__art', 'aria-hidden': 'true' }),
        CL.el('h3', {
          class: 'cl-empty__title',
          text: filtered ? '没有匹配的用户' : '还没有注册用户'
        }),
        CL.el('p', {
          class: 'cl-empty__desc',
          text: filtered
            ? '换个关键词或筛选条件再试试。'
            : '开放注册后，用户会按注册时间出现在这里。'
        })
      ]));
    }

    function errorRow(err) {
      var retry = CL.el('button', { type: 'button', class: 'cl-btn cl-btn--ghost cl-btn--xs', text: '重试' });
      retry.addEventListener('click', function () { load(); });
      return stateRow(CL.el('div', { class: 'admin-table-state admin-table-state--error' }, [
        CL.el('p', { text: messageOf(err) }),
        CL.el('div', { class: 'admin-table-state__actions' }, [retry])
      ]));
    }

    /* ---------- 渲染 ---------- */
    function actionButton(label, action, item, className, extra) {
      var attrs = {
        type: 'button',
        class: className,
        dataset: { action: action, id: String(item.id) },
        text: label
      };
      if (extra && extra.disabled) attrs.disabled = true;
      if (extra && extra.title) attrs.title = extra.title;
      return CL.el('button', attrs);
    }

    function buildRow(item) {
      var isSelf = !!(state.me && String(state.me.id) === String(item.id));
      var active = item.status === 'active';
      var selfTitle = '不能修改自己的角色或状态';

      var actions = CL.el('div', { class: 'cl-table-actions' }, [
        actionButton('查看资料', 'detail', item, 'cl-btn cl-btn--soft cl-btn--xs'),
        actionButton(active ? '禁用' : '启用', 'toggle', item,
          'cl-btn cl-btn--xs ' + (active ? 'cl-btn--danger-ghost' : 'cl-btn--ghost'),
          { disabled: isSelf, title: isSelf ? selfTitle : (active ? '禁用后该账号无法登录' : '启用后该账号可以重新登录') }),
        actionButton('改角色', 'role', item, 'cl-btn cl-btn--ghost cl-btn--xs',
          { disabled: isSelf, title: isSelf ? selfTitle : '修改该用户的角色' }),
        actionButton('重置密码', 'password', item, 'cl-btn cl-btn--ghost cl-btn--xs')
      ]);

      return CL.el('tr', { dataset: { id: String(item.id) } }, [
        CL.el('td', { text: textOf(item.id) }),
        CL.el('td', { text: textOf(item.nickname) }),
        CL.el('td', { text: textOf(item.username) }),
        CL.el('td', {}, [CL.el('span', {
          class: 'cl-tag ' + (item.role === 'admin' ? 'cl-tag--violet' : 'cl-tag--off'),
          text: ROLE_TEXT[item.role] || textOf(item.role)
        })]),
        CL.el('td', {}, [CL.el('span', {
          class: 'cl-tag ' + (active ? 'cl-tag--ok' : 'cl-tag--off'),
          text: STATUS_TEXT[item.status] || textOf(item.status)
        })]),
        CL.el('td', { text: CL.formatTime(item.createdAt, 'datetime') }),
        CL.el('td', { text: countOf(item.conversationCount) }),
        CL.el('td', {}, [actions])
      ]);
    }

    function renderPager() {
      var totalPages = pages();
      if (pagerInfo) {
        pagerInfo.textContent = '第 ' + state.page + '/' + totalPages + ' 页 · 共 ' + state.total + ' 条';
      }
      if (prevBtn) prevBtn.disabled = state.page <= 1;
      if (nextBtn) nextBtn.disabled = state.page >= totalPages;
    }

    function render() {
      tbody.textContent = '';
      if (!state.items.length) tbody.appendChild(emptyRow());
      else state.items.forEach(function (item) { tbody.appendChild(buildRow(item)); });

      if (countTag) {
        countTag.textContent = state.total + ' 位用户';
        countTag.className = 'cl-tag ' + (state.total ? 'cl-tag--ok' : 'cl-tag--off');
      }
      renderPager();
    }

    /* ---------- 列表加载 ---------- */
    function load() {
      var seq = ++state.seq;
      tbody.textContent = '';
      tbody.appendChild(messageRow('正在加载用户…'));
      if (countTag) {
        countTag.textContent = '加载中…';
        countTag.className = 'cl-tag cl-tag--off';
      }

      return usersApi.list({
        keyword: state.keyword,
        status: state.status,
        role: state.role,
        page: state.page,
        pageSize: state.pageSize
      }).then(function (data) {
        if (seq !== state.seq) return;
        state.items = (data && Array.isArray(data.items)) ? data.items : [];
        state.total = (data && typeof data.total === 'number') ? data.total : state.items.length;
        if (data && typeof data.page === 'number' && data.page > 0) state.page = data.page;
        if (data && typeof data.pageSize === 'number' && data.pageSize > 0) state.pageSize = data.pageSize;
        if (state.page > pages()) {
          state.page = pages();
          return load();
        }
        render();
      }).catch(function (err) {
        if (seq !== state.seq) return;
        state.items = [];
        state.total = 0;
        tbody.textContent = '';
        tbody.appendChild(errorRow(err));
        renderPager();
        if (countTag) {
          countTag.textContent = '加载失败';
          countTag.className = 'cl-tag cl-tag--danger';
        }
        CL.toast(messageOf(err), 'error');
      });
    }

    /* ---------- 详情弹窗 ---------- */
    function detailRow(label, value) {
      return [CL.el('dt', { text: label }), CL.el('dd', { text: value })];
    }

    function paintDetail(detail) {
      var dl = CL.el('dl', { class: 'admin-kv' });
      detailRow('ID', textOf(detail.id)).forEach(function (node) { dl.appendChild(node); });
      detailRow('用户名', textOf(detail.username)).forEach(function (node) { dl.appendChild(node); });
      detailRow('昵称', textOf(detail.nickname)).forEach(function (node) { dl.appendChild(node); });
      detailRow('角色', ROLE_TEXT[detail.role] || textOf(detail.role)).forEach(function (node) { dl.appendChild(node); });
      detailRow('状态', STATUS_TEXT[detail.status] || textOf(detail.status)).forEach(function (node) { dl.appendChild(node); });
      detailRow('注册时间', CL.formatTime(detail.createdAt, 'datetime')).forEach(function (node) { dl.appendChild(node); });
      detailRow('会话数', countOf(detail.conversationCount)).forEach(function (node) { dl.appendChild(node); });
      detailRow('消息数', countOf(detail.messageCount)).forEach(function (node) { dl.appendChild(node); });
      return dl;
    }

    function openDetail(item) {
      if (detailSub) detailSub.textContent = '用户：' + textOf(item.nickname) + '（' + textOf(item.username) + '）';
      if (detailBody) {
        detailBody.textContent = '';
        detailBody.appendChild(CL.el('p', { class: 'admin-table-state', text: '正在加载资料…' }));
      }
      CL.openModal(detailModal);
      usersApi.get(item.id).then(function (detail) {
        if (!detailBody) return;
        detailBody.textContent = '';
        if (!detail) {
          detailBody.appendChild(CL.el('p', { class: 'admin-table-state admin-table-state--error', text: '没有获取到该用户的资料' }));
          return;
        }
        detailBody.appendChild(paintDetail(detail));
      }).catch(function (err) {
        if (!detailBody) return;
        detailBody.textContent = '';
        detailBody.appendChild(CL.el('p', { class: 'admin-table-state admin-table-state--error', text: messageOf(err) }));
        CL.toast(messageOf(err), 'error');
      });
    }

    /* ---------- 启用 / 禁用 ---------- */
    function toggleStatus(item, btn) {
      var active = item.status === 'active';
      var label = active ? '禁用' : '启用';
      var question = active
        ? '确定要禁用「' + textOf(item.nickname) + '」吗？禁用后该账号将无法登录，历史数据保留。'
        : '确定要启用「' + textOf(item.nickname) + '」吗？启用后该账号可以重新登录。';

      CL.confirmDialog(question, {
        title: label + '账号',
        danger: active,
        confirmText: '确认' + label
      }).then(function (ok) {
        if (!ok) return;
        setBusy(btn, true, '处理中…');
        return usersApi.update(item.id, { status: active ? 'disabled' : 'active' }).then(function (updated) {
          var name = textOf((updated && updated.nickname) || item.nickname);
          CL.toast('已' + label + '「' + name + '」', 'success');
          return load();
        }).catch(function (err) {
          CL.toast(messageOf(err), 'error');
        }).then(function () {
          setBusy(btn, false);
        });
      });
    }

    /* ---------- 改角色 ---------- */
    function openRoleModal(item) {
      state.target = item;
      if (roleSub) roleSub.textContent = '用户：' + textOf(item.nickname) + '（' + textOf(item.username) + '）';
      if (roleSelectEl) roleSelectEl.value = item.role === 'admin' ? 'admin' : 'user';
      hideHint(roleError);
      CL.openModal(roleModal);
    }

    function submitRole(ev) {
      if (ev) ev.preventDefault();
      var item = state.target;
      if (!item) return;
      var role = roleSelectEl ? roleSelectEl.value : '';
      if (role !== 'admin' && role !== 'user') {
        showHint(roleError, '请选择角色');
        return;
      }
      if (role === item.role) {
        CL.toast('角色没有变化', 'info');
        return;
      }

      CL.confirmDialog('确定将「' + textOf(item.nickname) + '」的角色改为「' + ROLE_TEXT[role] + '」吗？', {
        title: '修改角色',
        danger: role === 'user',
        confirmText: '确认修改'
      }).then(function (ok) {
        if (!ok) return;
        setBusy(roleSubmit, true, '保存中…');
        return usersApi.update(item.id, { role: role }).then(function () {
          CL.closeModal(roleModal);
          state.target = null;
          CL.toast('角色已更新为「' + ROLE_TEXT[role] + '」', 'success');
          return load();
        }).catch(function (err) {
          showHint(roleError, messageOf(err));
          CL.toast(messageOf(err), 'error');
        }).then(function () {
          setBusy(roleSubmit, false);
        });
      });
    }

    /* ---------- 重置密码 ---------- */
    function openPasswordModal(item) {
      state.target = item;
      if (passwordSub) passwordSub.textContent = '用户：' + textOf(item.nickname) + '（' + textOf(item.username) + '）';
      if (passwordNew) passwordNew.value = '';
      if (passwordConfirm) passwordConfirm.value = '';
      hideHint(passwordError);
      CL.openModal(passwordModal);
    }

    function submitPassword(ev) {
      if (ev) ev.preventDefault();
      var item = state.target;
      if (!item) return;
      var pwd = passwordNew ? passwordNew.value : '';
      var confirm = passwordConfirm ? passwordConfirm.value : '';
      var problem = '';

      if (!pwd) problem = '请填写新密码';
      else if (pwd.length < 8 || pwd.length > 32) problem = '密码长度需为 8–32 位';
      else if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) problem = '密码需同时包含字母与数字';
      else if (pwd !== confirm) problem = '两次输入的新密码不一致';

      if (problem) {
        showHint(passwordError, problem);
        CL.toast(problem, 'warning');
        return;
      }

      setBusy(passwordSubmit, true, '重置中…');
      usersApi.resetPassword(item.id, pwd).then(function () {
        CL.closeModal(passwordModal);
        CL.toast('已重置「' + textOf(item.nickname) + '」的密码', 'success');
        state.target = null;
      }).catch(function (err) {
        showHint(passwordError, messageOf(err));
        CL.toast(messageOf(err), 'error');
      }).then(function () {
        setBusy(passwordSubmit, false);
      });
    }

    /* ---------- 事件绑定 ---------- */
    tbody.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
      if (!btn || btn.disabled) return;
      var id = btn.getAttribute('data-id');
      var item = null;
      state.items.forEach(function (candidate) {
        if (String(candidate.id) === String(id)) item = candidate;
      });
      if (!item) return;

      var action = btn.getAttribute('data-action');
      if (action === 'detail') openDetail(item);
      else if (action === 'toggle') toggleStatus(item, btn);
      else if (action === 'role') openRoleModal(item);
      else if (action === 'password') openPasswordModal(item);
    });

    function searchNow() {
      state.keyword = keywordInput ? keywordInput.value.trim() : '';
      state.page = 1;
      load();
    }

    if (keywordInput) {
      keywordInput.addEventListener('input', function () {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(searchNow, 300);
      });
      keywordInput.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        window.clearTimeout(searchTimer);
        searchNow();
      });
    }

    function bindFilter(node, key) {
      if (!node) return;
      node.addEventListener('change', function () {
        state[key] = node.value;
        state.page = 1;
        load();
      });
    }
    bindFilter(statusSelect, 'status');
    bindFilter(roleSelect, 'role');

    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (state.page <= 1) return;
        state.page -= 1;
        load();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        if (state.page >= pages()) return;
        state.page += 1;
        load();
      });
    }
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        setBusy(refreshBtn, true, '刷新中…');
        load().then(function () { setBusy(refreshBtn, false); });
      });
    }

    if (roleForm) roleForm.addEventListener('submit', submitRole);
    if (passwordForm) passwordForm.addEventListener('submit', submitPassword);

    /* ---------- 启动（等登录态就绪后再取 me，用于自我保护） ---------- */
    function boot() {
      var ready = CL.guard && CL.guard.ready;
      if (ready && typeof ready.then === 'function') {
        ready.then(function (me) {
          state.me = me || null;
          load();
        }, function () {
          load();
        });
        return;
      }
      load();
    }

    boot();
  }

  CL.usersApi = usersApi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})(window, document);
