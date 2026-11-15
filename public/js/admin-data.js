/* ============================================================
   尘龙 ChenLong · 聊天数据（阶段 5：真实接口，管理员只读）
   接口：GET /api/admin/conversations?keyword=&userId=&page=&pageSize=
        GET /api/admin/conversations/:id/messages?page=&pageSize=
   页面：public/admin/data.html（存在 [data-conv-rows] 时接管）
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var BASE = '/api/admin/conversations';
  var PAGE_SIZE = 20;
  var MESSAGE_PAGE_SIZE = 50;
  var ROLE_TEXT = { user: '用户', assistant: '助手', system: '系统' };

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
  var conversationsApi = {
    base: BASE,

    /* GET /api/admin/conversations */
    async list(filters) {
      var f = filters || {};
      var params = [
        'page=' + encodeURIComponent(String(f.page || 1)),
        'pageSize=' + encodeURIComponent(String(f.pageSize || PAGE_SIZE))
      ];
      if (f.keyword) params.push('keyword=' + encodeURIComponent(f.keyword));
      if (f.userId !== undefined && f.userId !== null && f.userId !== '') {
        params.push('userId=' + encodeURIComponent(String(f.userId)));
      }
      return CL.fetchJSON(endpoint('?' + params.join('&')));
    },

    /* GET /api/admin/conversations/:id/messages */
    async messages(id, page, pageSize) {
      var params = [
        'page=' + encodeURIComponent(String(page || 1)),
        'pageSize=' + encodeURIComponent(String(pageSize || MESSAGE_PAGE_SIZE))
      ];
      return CL.fetchJSON(endpoint(itemPath(id, '/messages') + '?' + params.join('&')));
    }
  };

  /* ---------- 页面控制（data.html） ---------- */
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
    var tbody = CL.qs('[data-conv-rows]');
    if (!tbody) return;

    var countTag = CL.qs('[data-conv-count]');
    var keywordInput = CL.qs('[data-conv-keyword]');
    var pagerInfo = CL.qs('[data-conv-pageinfo]');
    var prevBtn = CL.qs('[data-conv-prev]');
    var nextBtn = CL.qs('[data-conv-next]');
    var refreshBtn = CL.qs('[data-conv-refresh]');

    var drawer = CL.qs('#conv-drawer');
    var drawerTitle = CL.qs('[data-drawer-title]');
    var drawerSub = CL.qs('[data-drawer-sub]');
    var drawerMessages = CL.qs('[data-drawer-messages]');
    var drawerPageInfo = CL.qs('[data-drawer-pageinfo]');
    var drawerPrev = CL.qs('[data-drawer-prev]');
    var drawerNext = CL.qs('[data-drawer-next]');

    var state = {
      items: [],
      total: 0,
      page: 1,
      pageSize: PAGE_SIZE,
      keyword: '',
      seq: 0
    };

    var drawerState = {
      open: false,
      conversation: null,
      page: 1,
      pageSize: MESSAGE_PAGE_SIZE,
      total: 0,
      seq: 0
    };

    var searchTimer = null;

    /* ---------- 小工具 ---------- */
    function pages() {
      return Math.max(1, Math.ceil(state.total / state.pageSize));
    }

    function messagePages() {
      return Math.max(1, Math.ceil(drawerState.total / drawerState.pageSize));
    }

    function textOf(value) {
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    }

    function countOf(value) {
      var n = Number(value);
      return isFinite(n) ? String(n) : '—';
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

    /* ---------- 列表渲染 ---------- */
    function stateRow(content) {
      return CL.el('tr', { class: 'cl-table__empty' }, [
        CL.el('td', { colspan: '7' }, [content])
      ]);
    }

    function messageRow(text) {
      return stateRow(CL.el('div', { class: 'admin-table-state', text: text }));
    }

    function emptyRow() {
      var filtered = !!state.keyword;
      return stateRow(CL.el('div', { class: 'cl-empty cl-empty--compact' }, [
        CL.el('div', { class: 'cl-empty__art', 'aria-hidden': 'true' }),
        CL.el('h3', {
          class: 'cl-empty__title',
          text: filtered ? '没有匹配的会话' : '还没有聊天数据'
        }),
        CL.el('p', {
          class: 'cl-empty__desc',
          text: filtered
            ? '换个关键词再试试。'
            : '当用户开始对话后，会话概况会出现在这里。'
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

    function userLabel(item) {
      var nickname = item.nickname ? String(item.nickname) : '';
      var username = item.username ? String(item.username) : '';
      if (nickname && username) return nickname + '（' + username + '）';
      return nickname || username || '—';
    }

    function buildRow(item) {
      var viewBtn = CL.el('button', {
        type: 'button',
        class: 'cl-btn cl-btn--soft cl-btn--xs',
        dataset: { action: 'view', id: String(item.id) },
        text: '查看'
      });

      return CL.el('tr', { class: 'admin-row--clickable', dataset: { id: String(item.id) }, tabindex: '0' }, [
        CL.el('td', { text: textOf(item.title) }),
        CL.el('td', { text: userLabel(item) }),
        CL.el('td', { text: countOf(item.messageCount) }),
        CL.el('td', { text: textOf(item.modelName) }),
        CL.el('td', { text: CL.formatTime(item.createdAt, 'datetime') }),
        CL.el('td', { text: CL.formatTime(item.updatedAt, 'datetime') }),
        CL.el('td', {}, [CL.el('div', { class: 'cl-table-actions' }, [viewBtn])])
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
        countTag.textContent = state.total + ' 个会话';
        countTag.className = 'cl-tag ' + (state.total ? 'cl-tag--ok' : 'cl-tag--off');
      }
      renderPager();
    }

    function load() {
      var seq = ++state.seq;
      tbody.textContent = '';
      tbody.appendChild(messageRow('正在加载会话…'));
      if (countTag) {
        countTag.textContent = '加载中…';
        countTag.className = 'cl-tag cl-tag--off';
      }

      return conversationsApi.list({
        keyword: state.keyword,
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

    /* ---------- 消息抽屉 ---------- */
    function drawerPager() {
      var totalPages = messagePages();
      if (drawerPageInfo) {
        drawerPageInfo.textContent = '第 ' + drawerState.page + '/' + totalPages + ' 页 · 共 ' + drawerState.total + ' 条消息';
      }
      if (drawerPrev) drawerPrev.disabled = drawerState.page <= 1;
      if (drawerNext) drawerNext.disabled = drawerState.page >= totalPages;
    }

    function messageNode(item) {
      var role = item.role === 'user' ? 'user' : (item.role === 'assistant' ? 'assistant' : 'other');
      var head = CL.el('div', { class: 'admin-msg__head' }, [
        CL.el('span', { class: 'admin-msg__role', text: ROLE_TEXT[item.role] || textOf(item.role) }),
        CL.el('span', { class: 'admin-msg__id', text: '#' + textOf(item.id) }),
        CL.el('span', { class: 'admin-msg__time', text: CL.formatTime(item.createdAt, 'datetime') })
      ]);
      return CL.el('article', { class: 'admin-msg admin-msg--' + role }, [
        head,
        CL.el('div', { class: 'admin-msg__body', text: item.content === null || item.content === undefined ? '' : String(item.content) })
      ]);
    }

    function renderMessages(data) {
      if (!drawerMessages) return;
      drawerMessages.textContent = '';
      var items = (data && Array.isArray(data.items)) ? data.items : [];
      if (!items.length) {
        drawerMessages.appendChild(CL.el('div', { class: 'cl-empty cl-empty--compact' }, [
          CL.el('div', { class: 'cl-empty__art', 'aria-hidden': 'true' }),
          CL.el('h3', { class: 'cl-empty__title', text: '这个会话还没有消息' }),
          CL.el('p', { class: 'cl-empty__desc', text: '用户发送第一条消息后，这里会按时间顺序显示。' })
        ]));
        return;
      }
      items.forEach(function (item) { drawerMessages.appendChild(messageNode(item)); });
    }

    function loadMessages() {
      var conversation = drawerState.conversation;
      if (!conversation) return;
      var seq = ++drawerState.seq;

      if (drawerMessages) {
        drawerMessages.textContent = '';
        drawerMessages.appendChild(CL.el('div', { class: 'admin-table-state', text: '正在加载消息…' }));
      }

      return conversationsApi.messages(conversation.id, drawerState.page, drawerState.pageSize).then(function (data) {
        if (seq !== drawerState.seq) return;
        var conv = (data && data.conversation) || conversation;
        if (data && typeof data.total === 'number') drawerState.total = data.total;
        if (data && typeof data.page === 'number' && data.page > 0) drawerState.page = data.page;
        if (data && typeof data.pageSize === 'number' && data.pageSize > 0) drawerState.pageSize = data.pageSize;
        if (drawerState.page > messagePages()) {
          drawerState.page = messagePages();
          return loadMessages();
        }
        if (drawerTitle) drawerTitle.textContent = textOf(conv.title);
        if (drawerSub) {
          drawerSub.textContent = userLabel(conv) + ' · 会话总数 ' + countOf(conv.messageCount) + ' 条 · 创建于 '
            + CL.formatTime(conv.createdAt, 'datetime');
        }
        renderMessages(data);
        drawerPager();
      }).catch(function (err) {
        if (seq !== drawerState.seq) return;
        drawerState.total = 0;
        if (drawerMessages) {
          drawerMessages.textContent = '';
          drawerMessages.appendChild(CL.el('div', { class: 'admin-table-state admin-table-state--error', text: messageOf(err) }));
        }
        drawerPager();
        CL.toast(messageOf(err), 'error');
      });
    }

    function openDrawer(item) {
      if (!drawer) return;
      drawerState.conversation = item;
      drawerState.page = 1;
      drawerState.total = 0;
      drawerState.open = true;

      if (drawerTitle) drawerTitle.textContent = textOf(item.title);
      if (drawerSub) drawerSub.textContent = userLabel(item) + ' · 正在加载消息…';
      if (drawerMessages) drawerMessages.textContent = '';
      drawerPager();
      CL.openModal(drawer);
      loadMessages();
    }

    /* ---------- 事件 ---------- */
    function rowOf(node) {
      return node && node.closest ? node.closest('tr[data-id]') : null;
    }

    function findItem(id) {
      var found = null;
      state.items.forEach(function (item) {
        if (String(item.id) === String(id)) found = item;
      });
      return found;
    }

    function activate(node) {
      var row = rowOf(node);
      if (!row) return;
      var item = findItem(row.getAttribute('data-id'));
      if (item) openDrawer(item);
    }

    tbody.addEventListener('click', function (ev) {
      var button = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
      if (button) {
        activate(button);
        return;
      }
      activate(ev.target);
    });

    tbody.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var row = rowOf(ev.target);
      if (!row || ev.target !== row) return;
      ev.preventDefault();
      activate(row);
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

    if (drawerPrev) {
      drawerPrev.addEventListener('click', function () {
        if (drawerState.page <= 1) return;
        drawerState.page -= 1;
        loadMessages();
      });
    }
    if (drawerNext) {
      drawerNext.addEventListener('click', function () {
        if (drawerState.page >= messagePages()) return;
        drawerState.page += 1;
        loadMessages();
      });
    }

    if (drawer) {
      drawer.addEventListener('click', function (ev) {
        var target = ev.target;
        var closer = target && target.closest ? target.closest('[data-modal-close]') : null;
        if (closer) {
          drawerState.open = false;
          CL.closeModal(drawer);
        }
      });
      document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape' || !drawerState.open) return;
        drawerState.open = false;
      });
    }

    load();
  }

  CL.conversationsApi = conversationsApi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})(window, document);
