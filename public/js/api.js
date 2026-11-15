/* ============================================================
   尘龙 ChenLong · API 服务管理（阶段 3：真实接口 + 页面控制）
   接口：/api/providers —— 列表 / 详情 / 新增 / 修改 / 删除 /
        启停 / 测试连接 / 刷新模型
   页面：public/admin/api.html（仅当页面存在 [data-api-form] 时接管）
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var BASE = '/api/providers';

  var TYPE_LABELS = {
    openai: 'OpenAI 兼容',
    anthropic: 'Anthropic',
    gemini: 'Google Gemini',
    custom: '自定义'
  };

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
  var api = {
    base: BASE,

    /* GET /api/providers */
    async list() {
      var data = await CL.fetchJSON(endpoint(''));
      return (data && data.items) || [];
    },

    /* GET /api/providers/:id */
    async get(id) {
      var data = await CL.fetchJSON(endpoint(itemPath(id)));
      return (data && data.item) || null;
    },

    /* POST /api/providers */
    async create(payload) {
      var data = await CL.fetchJSON(endpoint(''), { method: 'POST', body: payload });
      return (data && data.item) || null;
    },

    /* PATCH /api/providers/:id（apiKey 留空表示不修改） */
    async update(id, payload) {
      var data = await CL.fetchJSON(endpoint(itemPath(id)), { method: 'PATCH', body: payload });
      return (data && data.item) || null;
    },

    /* DELETE /api/providers/:id → 204 */
    async remove(id) {
      await CL.fetchJSON(endpoint(itemPath(id)), { method: 'DELETE' });
    },

    /* PATCH /api/providers/:id/status */
    async toggle(id, enabled) {
      var data = await CL.fetchJSON(endpoint(itemPath(id, '/status')), {
        method: 'PATCH',
        body: { enabled: enabled === true }
      });
      return (data && data.item) || null;
    },

    /* POST /api/providers/:id/test → { ok, latencyMs, modelCount, message } */
    async test(id) {
      return CL.fetchJSON(endpoint(itemPath(id, '/test')), { method: 'POST' });
    },

    /* POST /api/providers/:id/refresh-models → { ok, added, total, message } */
    async refreshModels(id) {
      return CL.fetchJSON(endpoint(itemPath(id, '/refresh-models')), { method: 'POST' });
    }
  };

  CL.api = api;

  /* ---------- 页面控制（api.html） ---------- */
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
    var form = CL.qs('[data-api-form]');
    if (!form) return;

    var tbody = CL.qs('[data-api-rows]');
    if (!tbody) return;

    var countTag = CL.qs('[data-api-count]');
    var modeTag = CL.qs('[data-api-mode]');
    var titleEl = CL.qs('[data-api-form-title]');
    var currentEl = CL.qs('[data-api-current]');
    var errorEl = CL.qs('[data-api-form-error]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var cancelBtn = CL.qs('[data-api-cancel]', form);
    var testBtn = CL.qs('[data-api-test]', form);
    var pullBtn = CL.qs('[data-api-refresh-models]', form);
    var listBtn = CL.qs('[data-api-refresh]');
    var keyHint = CL.qs('[data-api-key-hint]', form);

    var nameInput = CL.qs('#api-name', form);
    var baseInput = CL.qs('#api-base', form);
    var typeInput = CL.qs('#api-type', form);
    var keyInput = CL.qs('#api-key', form);
    var noteInput = CL.qs('#api-note', form);
    var enabledInput = CL.qs('#api-enabled', form);

    var emptyRow = tbody.querySelector('.cl-table__empty');
    var emptyTemplate = emptyRow ? emptyRow.cloneNode(true) : null;

    var items = [];
    var editingId = null;
    var current = null;
    var busy = false;

    /* ---------- 渲染 ---------- */
    function paintCount() {
      if (!countTag) return;
      countTag.textContent = items.length + ' 个服务';
      countTag.className = 'cl-tag' + (items.length ? ' cl-tag--ok' : ' cl-tag--off');
    }

    function emptyState(title, desc, keepAction) {
      if (!emptyTemplate) {
        return CL.el('tr', { class: 'cl-table__empty' }, [
          CL.el('td', { colspan: '6' }, [CL.el('div', { class: 'admin-table-state', text: title })])
        ]);
      }
      var row = emptyTemplate.cloneNode(true);
      var titleNode = row.querySelector('.cl-empty__title');
      var descNode = row.querySelector('.cl-empty__desc');
      if (titleNode && title) titleNode.textContent = title;
      if (descNode && desc) descNode.textContent = desc;
      if (!keepAction) {
        var actions = row.querySelector('.cl-empty__actions');
        if (actions) actions.parentNode.removeChild(actions);
      }
      return row;
    }

    function loadingState(text) {
      return CL.el('tr', { class: 'cl-table__empty' }, [
        CL.el('td', { colspan: '6' }, [CL.el('div', { class: 'admin-table-state', text: text })])
      ]);
    }

    function actionBtn(label, action, item, className, extra) {
      var attrs = {
        type: 'button',
        class: className,
        dataset: { action: action, id: String(item.id) },
        text: label
      };
      if (extra) {
        if (extra.disabled) attrs.disabled = true;
        if (extra.title) attrs.title = extra.title;
      }
      return CL.el('button', attrs);
    }

    function statusTag(enabled) {
      return CL.el('span', {
        class: 'cl-tag ' + (enabled ? 'cl-tag--ok' : 'cl-tag--off'),
        text: enabled ? '启用' : '禁用'
      });
    }

    function buildRow(item) {
      var tr = CL.el('tr', { dataset: { id: String(item.id) } });
      if (item.enabled === false) tr.classList.add('is-off');

      tr.appendChild(CL.el('td', {}, [
        CL.el('div', { class: 'admin-cell-main', text: item.name || '未命名服务' }),
        item.keyMasked ? CL.el('div', { class: 'admin-cell-sub', text: '密钥 ' + item.keyMasked }) : null
      ]));
      tr.appendChild(CL.el('td', {}, [
        CL.el('span', { class: 'admin-cell-url', text: item.baseUrl || '—' })
      ]));
      tr.appendChild(CL.el('td', { text: TYPE_LABELS[item.apiType] || item.apiType || '—' }));
      tr.appendChild(CL.el('td', {}, [statusTag(item.enabled !== false)]));
      tr.appendChild(CL.el('td', { text: String(typeof item.modelCount === 'number' ? item.modelCount : 0) }));
      tr.appendChild(CL.el('td', {}, [
        CL.el('div', { class: 'cl-table-actions' }, [
          actionBtn('编辑', 'edit', item, 'cl-btn cl-btn--soft cl-btn--xs'),
          actionBtn('测试', 'test', item, 'cl-btn cl-btn--ghost cl-btn--xs'),
          actionBtn('刷新模型', 'refresh', item, 'cl-btn cl-btn--ghost cl-btn--xs'),
          actionBtn(item.enabled === false ? '启用' : '禁用', 'toggle', item, 'cl-btn cl-btn--ghost cl-btn--xs'),
          actionBtn('删除', 'remove', item, 'cl-btn cl-btn--danger-ghost cl-btn--xs')
        ])
      ]));
      return tr;
    }

    function renderRows() {
      tbody.textContent = '';
      paintCount();
      if (!items.length) {
        tbody.appendChild(emptyState('还没有添加 API 服务', '添加一个服务后，就可以拉取模型并在聊天中使用了。', true));
        return;
      }
      items.forEach(function (item) { tbody.appendChild(buildRow(item)); });
    }

    function findItem(id) {
      var key = String(id);
      return items.filter(function (item) { return String(item.id) === key; })[0] || null;
    }

    /* ---------- 表单状态 ---------- */
    function setError(message) {
      if (!errorEl) return;
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }

    function paintMode() {
      var editing = editingId !== null && editingId !== undefined;
      if (modeTag) modeTag.textContent = editing ? '编辑' : '新增';
      if (titleEl) titleEl.textContent = editing ? '编辑 API' : '添加 API';
      if (submitBtn) submitBtn.textContent = editing ? '保存修改' : '保存';
      if (cancelBtn) cancelBtn.hidden = !(editing || current);
      if (keyHint) {
        keyHint.textContent = editing
          ? '留空表示不修改已保存的密钥'
          : '仅提交给后端保存，前端不做本地存储';
      }
      if (currentEl) {
        currentEl.textContent = current
          ? '当前服务：' + (current.name || '未命名服务') + (current.enabled === false ? '（已禁用）' : '') + '，可直接测试连接或刷新模型'
          : '当前服务：尚未保存，保存后才能测试连接或刷新模型';
      }
    }

    function fillForm(item) {
      nameInput.value = item.name || '';
      baseInput.value = item.baseUrl || '';
      keyInput.value = '';
      setSelectValue(typeInput, item.apiType || 'openai');
      noteInput.value = item.description || '';
      enabledInput.checked = item.enabled !== false;
      setError('');
    }

    function setSelectValue(select, value) {
      var exists = Array.prototype.some.call(select.options, function (option) {
        return option.value === value;
      });
      if (!exists) {
        select.appendChild(CL.el('option', { value: value, text: value }));
      }
      select.value = value;
    }

    function resetForm() {
      editingId = null;
      current = null;
      form.reset();
      setError('');
      paintMode();
    }

    function collect() {
      var payload = {
        name: (nameInput.value || '').trim(),
        baseUrl: (baseInput.value || '').trim(),
        apiType: typeInput.value,
        description: (noteInput.value || '').trim(),
        enabled: enabledInput.checked
      };
      var key = (keyInput.value || '').trim();
      if (key) payload.apiKey = key;
      return payload;
    }

    function validate(payload) {
      if (!payload.name) return '请填写服务名称';
      if (!payload.baseUrl) return '请填写 Base URL';
      if (!/^https?:\/\//i.test(payload.baseUrl)) return 'Base URL 需以 http 或 https 开头，并包含 :// 前缀';
      if (editingId === null && !payload.apiKey) return '请填写 API Key';
      return '';
    }

    /* ---------- 反馈 ---------- */
    function reportTest(res) {
      var ok = !!res && res.ok !== false;
      var parts = [];
      if (res && typeof res.latencyMs === 'number') parts.push('延迟 ' + res.latencyMs + ' ms');
      if (res && typeof res.modelCount === 'number') parts.push('模型 ' + res.modelCount + ' 个');
      var text = (res && res.message) || (ok ? '连接成功' : '连接失败');
      if (parts.length) text += '（' + parts.join('，') + '）';
      CL.toast(text, ok ? 'success' : 'error');
    }

    function reportRefresh(res) {
      var ok = !!res && res.ok !== false;
      if (!ok) {
        CL.toast((res && res.message) || '刷新模型失败', 'error');
        return;
      }
      var added = res && typeof res.added === 'number' ? res.added : 0;
      var total = res && typeof res.total === 'number' ? res.total : 0;
      CL.toast(
        '刷新完成：新增 ' + added + ' 个，共 ' + total + ' 个模型。新模型默认禁用，请到「模型管理」启用。',
        'success',
        5600
      );
    }

    function withButton(btn, label, task) {
      if (!btn) return task();
      var original = btn.textContent;
      btn.disabled = true;
      btn.textContent = label;
      return Promise.resolve()
        .then(task)
        .then(function (value) {
          btn.disabled = false;
          btn.textContent = original;
          return value;
        }, function (err) {
          btn.disabled = false;
          btn.textContent = original;
          throw err;
        });
    }

    /* ---------- 列表 ---------- */
    async function loadList() {
      tbody.textContent = '';
      tbody.appendChild(loadingState('正在加载…'));
      try {
        var list = await CL.api.list();
        items = list;
        syncCurrent();
        renderRows();
      } catch (err) {
        items = [];
        paintCount();
        console.error('加载 API 服务列表失败：', messageOf(err));
        tbody.textContent = '';
        tbody.appendChild(emptyState('列表加载失败', messageOf(err), false));
      }
    }

    function syncCurrent() {
      if (!current) return;
      var fresh = findItem(current.id);
      if (fresh) {
        current = fresh;
        paintMode();
      }
    }

    /* ---------- 行内操作 ---------- */
    async function removeItem(item) {
      var ok = await CL.confirmDialog(
        '删除「' + (item.name || '该服务') + '」后，该服务下的模型将无法使用，确定删除吗？',
        { title: '删除 API 服务', confirmText: '删除', danger: true }
      );
      if (!ok) return;
      try {
        await CL.api.remove(item.id);
        CL.toast('已删除该服务', 'success');
        if (current && String(current.id) === String(item.id)) resetForm();
        await loadList();
      } catch (err) {
        CL.toast(messageOf(err), 'error');
      }
    }

    function editItem(item) {
      editingId = item.id;
      current = item;
      fillForm(item);
      paintMode();
      var panel = CL.qs('#api-form');
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (nameInput && nameInput.focus) nameInput.focus();
    }

    async function runRowAction(action, item, btn) {
      if (action === 'edit') {
        editItem(item);
        return;
      }
      if (action === 'remove') {
        await removeItem(item);
        return;
      }
      btn.disabled = true;
      try {
        if (action === 'toggle') {
          await CL.api.toggle(item.id, item.enabled === false);
          CL.toast(item.enabled === false ? '已启用该服务' : '已禁用该服务', 'success');
          await loadList();
        } else if (action === 'test') {
          reportTest(await CL.api.test(item.id));
        } else if (action === 'refresh') {
          reportRefresh(await CL.api.refreshModels(item.id));
          await loadList();
        }
      } catch (err) {
        CL.toast(messageOf(err), 'error');
      } finally {
        if (btn.parentNode) btn.disabled = false;
      }
    }

    /* ---------- 事件 ---------- */
    tbody.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
      if (!btn || !tbody.contains(btn)) return;
      var item = findItem(btn.getAttribute('data-id'));
      if (!item) return;
      runRowAction(btn.getAttribute('data-action'), item, btn);
    });

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (busy) return;
      setError('');
      var payload = collect();
      var message = validate(payload);
      if (message) {
        setError(message);
        return;
      }
      busy = true;
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (editingId !== null) {
          await CL.api.update(editingId, payload);
          CL.toast('API 服务已更新', 'success');
        } else {
          var created = await CL.api.create(payload);
          current = created;
          CL.toast('API 服务已添加', 'success');
        }
        form.reset();
        editingId = null;
        setError('');
        paintMode();
        await loadList();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        busy = false;
        if (submitBtn) submitBtn.disabled = false;
        paintMode();
      }
    });

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        resetForm();
        form.reset();
        paintMode();
      });
    }

    if (testBtn) {
      testBtn.addEventListener('click', function () {
        if (!current) {
          CL.toast('请先保存该服务，再测试连接', 'info');
          return;
        }
        withButton(testBtn, '测试中…', async function () {
          try {
            reportTest(await CL.api.test(current.id));
          } catch (err) {
            CL.toast(messageOf(err), 'error');
          }
        });
      });
    }

    if (pullBtn) {
      pullBtn.addEventListener('click', function () {
        if (!current) {
          CL.toast('请先保存该服务，再刷新模型', 'info');
          return;
        }
        withButton(pullBtn, '刷新中…', async function () {
          try {
            reportRefresh(await CL.api.refreshModels(current.id));
            await loadList();
          } catch (err) {
            CL.toast(messageOf(err), 'error');
          }
        });
      });
    }

    if (listBtn) {
      listBtn.addEventListener('click', function () {
        withButton(listBtn, '刷新中…', loadList);
      });
    }

    paintMode();
    loadList();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPage);
  else initPage();
})(window, document);
