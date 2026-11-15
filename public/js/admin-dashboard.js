/* ============================================================
   尘龙 ChenLong · 仪表盘（阶段 5：真实接口）
   接口：GET /api/admin/stats
        → { stats:{ userCount, conversationCount, messageCount, providerCount },
            recentProviders:[{ id, name, baseUrl, modelCount, createdAt }],
            recentModels:[{ id, modelId, displayName, providerName, enabled, lastUsedAt }],
            system:{ version, nodeVersion, uptimeSeconds, dbSizeBytes } }
   页面：public/admin/admin.html（存在 [data-stat] 时接管）
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var BASE = '/api/admin/stats';
  var STAT_KEYS = ['userCount', 'conversationCount', 'messageCount', 'providerCount'];
  var STAT_FOOT = {
    userCount: '已注册账号',
    conversationCount: '全部会话',
    messageCount: '全部消息',
    providerCount: '已配置服务'
  };

  function endpoint() {
    return CL.url(BASE);
  }

  function messageOf(err) {
    return (err && err.message) || '操作失败，请稍后重试';
  }

  /* ---------- 接口封装 ---------- */
  var statsApi = {
    base: BASE,

    /* GET /api/admin/stats */
    async get() {
      return CL.fetchJSON(endpoint());
    }
  };

  /* ---------- 页面控制（admin.html） ---------- */
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
    var probe = CL.qs('[data-stat]');
    if (!probe) return;

    var refreshBtn = CL.qs('[data-stats-refresh]');
    var updatedHint = CL.qs('[data-stats-updated]');
    var sysBadge = CL.qs('[data-sys-badge]');
    var providersBox = CL.qs('[data-recent-providers]');
    var modelsBox = CL.qs('[data-recent-models]');
    var seq = 0;

    /* ---------- 小工具 ---------- */
    function textOf(value) {
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    }

    function setBusy(btn, busy, busyText) {
      if (!btn) return;
      if (busy) {
        if (!btn.getAttribute('data-idle-text')) {
          btn.setAttribute('data-idle-text', btn.textContent);
        }
        btn.disabled = true;
        btn.textContent = busyText || '刷新中…';
        return;
      }
      var idle = btn.getAttribute('data-idle-text');
      btn.disabled = false;
      if (idle) btn.textContent = idle;
    }

    function setBadge(text, tone) {
      if (!sysBadge) return;
      sysBadge.textContent = text;
      sysBadge.className = 'cl-tag ' + (tone || 'cl-tag--off');
    }

    function formatUptime(seconds) {
      var total = Number(seconds);
      if (!isFinite(total) || total < 0) return '—';
      var days = Math.floor(total / 86400);
      var hours = Math.floor((total % 86400) / 3600);
      return days + ' 天 ' + hours + ' 小时';
    }

    function formatSize(bytes) {
      var size = Number(bytes);
      if (!isFinite(size) || size < 0) return '—';
      if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
      return (size / 1024).toFixed(1) + ' KB';
    }

    function stateBlock(text, isError) {
      return CL.el('div', {
        class: 'admin-table-state' + (isError ? ' admin-table-state--error' : ''),
        text: text
      });
    }

    function emptyBlock(title, desc, actionHref, actionText) {
      var children = [
        CL.el('div', { class: 'cl-empty__art', 'aria-hidden': 'true' }),
        CL.el('h3', { class: 'cl-empty__title', text: title }),
        CL.el('p', { class: 'cl-empty__desc', text: desc })
      ];
      if (actionHref) {
        children.push(CL.el('div', { class: 'cl-empty__actions' }, [
          CL.el('a', { class: 'cl-btn cl-btn--primary cl-btn--sm', href: actionHref, text: actionText })
        ]));
      }
      return CL.el('div', { class: 'cl-empty cl-empty--compact' }, children);
    }

    function itemRow(name, desc, meta) {
      var state = CL.el('span', { class: 'status-item__state' });
      if (meta) state.textContent = meta;
      return CL.el('div', { class: 'status-item' }, [
        CL.el('div', {}, [
          CL.el('div', { class: 'status-item__name', text: name }),
          CL.el('div', { class: 'status-item__desc', text: desc })
        ]),
        state
      ]);
    }

    /* ---------- 渲染 ---------- */
    function renderStats(stats) {
      var data = stats || {};
      STAT_KEYS.forEach(function (key) {
        var valueNode = CL.qs('[data-stat="' + key + '"]');
        var footNode = CL.qs('[data-stat-foot="' + key + '"]');
        var number = Number(data[key]);
        if (valueNode) valueNode.textContent = isFinite(number) ? String(number) : '—';
        if (footNode) {
          footNode.textContent = STAT_FOOT[key];
          var dot = footNode.parentNode ? footNode.parentNode.querySelector('.cl-dot') : null;
          if (dot) dot.className = 'cl-dot cl-dot--live';
        }
      });
    }

    function renderSystem(system) {
      var sys = system || {};
      var versionNode = CL.qs('[data-sys-version]');
      var nodeNode = CL.qs('[data-sys-node]');
      var uptimeNode = CL.qs('[data-sys-uptime]');
      var sizeNode = CL.qs('[data-sys-dbsize]');

      if (versionNode) versionNode.textContent = textOf(sys.version);
      if (nodeNode) nodeNode.textContent = textOf(sys.nodeVersion);
      if (uptimeNode) uptimeNode.textContent = formatUptime(sys.uptimeSeconds);
      if (sizeNode) sizeNode.textContent = formatSize(sys.dbSizeBytes);
    }

    function renderProviders(items) {
      if (!providersBox) return;
      providersBox.textContent = '';
      var list = Array.isArray(items) ? items : [];
      if (!list.length) {
        providersBox.appendChild(emptyBlock(
          '还没有接入任何 API',
          '添加第一个服务后，这里会展示名称、地址与模型数量。',
          'api.html',
          '添加 API'
        ));
        return;
      }
      var wrap = CL.el('div', { class: 'status-list' });
      list.forEach(function (item) {
        var meta = (Number(item.modelCount) || 0) + ' 个模型';
        wrap.appendChild(itemRow(
          textOf(item.name),
          textOf(item.baseUrl) + ' · 添加于 ' + CL.formatTime(item.createdAt, 'datetime'),
          meta
        ));
      });
      providersBox.appendChild(wrap);
    }

    function renderModels(items) {
      if (!modelsBox) return;
      modelsBox.textContent = '';
      var list = Array.isArray(items) ? items : [];
      if (!list.length) {
        modelsBox.appendChild(emptyBlock(
          '暂无模型使用记录',
          '开始聊天并选择模型后，这里会展示最近使用的模型。',
          'models.html',
          '查看模型管理'
        ));
        return;
      }
      var wrap = CL.el('div', { class: 'status-list' });
      list.forEach(function (item) {
        var name = textOf(item.displayName) === '—' ? textOf(item.modelId) : textOf(item.displayName);
        var nameNode = CL.el('div', { class: 'status-item__name' }, [
          CL.el('span', { text: name }),
          CL.el('span', {
            class: 'cl-tag ' + (item.enabled ? 'cl-tag--ok' : 'cl-tag--off'),
            text: item.enabled ? '已启用' : '已停用'
          })
        ]);
        wrap.appendChild(CL.el('div', { class: 'status-item' }, [
          CL.el('div', {}, [
            nameNode,
            CL.el('div', {
              class: 'status-item__desc',
              text: textOf(item.providerName) + ' · 最近使用 ' + CL.formatTime(item.lastUsedAt, 'datetime')
            })
          ]),
          CL.el('span', { class: 'status-item__state', text: textOf(item.modelId) })
        ]));
      });
      modelsBox.appendChild(wrap);
    }

    /* ---------- 加载 ---------- */
    function load(showToast) {
      var token = ++seq;
      setBadge('加载中…', 'cl-tag--off');
      if (updatedHint) updatedHint.textContent = '正在读取后台统计…';

      return statsApi.get().then(function (data) {
        if (token !== seq) return;
        var payload = data || {};
        renderStats(payload.stats);
        renderSystem(payload.system);
        renderProviders(payload.recentProviders);
        renderModels(payload.recentModels);
        setBadge('数据已更新', 'cl-tag--ok');
        if (updatedHint) {
          updatedHint.textContent = '最近更新：' + CL.formatTime(new Date().toISOString(), 'datetime');
        }
        if (showToast) CL.toast('数据已刷新', 'success');
      }).catch(function (err) {
        if (token !== seq) return;
        setBadge('加载失败', 'cl-tag--danger');
        STAT_KEYS.forEach(function (key) {
          var valueNode = CL.qs('[data-stat="' + key + '"]');
          if (valueNode) valueNode.textContent = '—';
        });
        ['[data-sys-version]', '[data-sys-node]', '[data-sys-uptime]', '[data-sys-dbsize]'].forEach(function (selector) {
          var node = CL.qs(selector);
          if (node) node.textContent = '—';
        });
        if (providersBox) {
          providersBox.textContent = '';
          providersBox.appendChild(stateBlock(messageOf(err), true));
        }
        if (modelsBox) {
          modelsBox.textContent = '';
          modelsBox.appendChild(stateBlock(messageOf(err), true));
        }
        if (updatedHint) updatedHint.textContent = messageOf(err);
        CL.toast(messageOf(err), 'error');
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        setBusy(refreshBtn, true, '刷新中…');
        load(true).then(function () { setBusy(refreshBtn, false); });
      });
    }

    load(false);
  }

  CL.statsApi = statsApi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPage);
  } else {
    initPage();
  }
})(window, document);
