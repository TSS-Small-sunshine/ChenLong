/* ============================================================
   尘龙 ChenLong · 模型管理（阶段 3：真实接口 + 页面控制）
   接口：/api/models —— 列表（筛选）/ 详情 / 新增 / 修改 / 删除 /
        设为默认 / 启停 / 测试；同步模型复用 /api/providers
   页面：public/admin/models.html（仅当存在 [data-model-form] 时接管）
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var BASE = '/api/models';

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
  var models = {
    base: BASE,

    /* GET /api/models?providerId=&keyword=&status= */
    async list(filters) {
      var f = filters || {};
      var params = [];
      if (f.providerId) params.push('providerId=' + encodeURIComponent(f.providerId));
      if (f.keyword) params.push('keyword=' + encodeURIComponent(f.keyword));
      if (f.status) params.push('status=' + encodeURIComponent(f.status));
      var data = await CL.fetchJSON(endpoint(params.length ? '?' + params.join('&') : ''));
      return (data && data.items) || [];
    },

    /* GET /api/models/:id */
    async get(id) {
      var data = await CL.fetchJSON(endpoint(itemPath(id)));
      return (data && data.item) || null;
    },

    /* POST /api/models */
    async create(payload) {
      var data = await CL.fetchJSON(endpoint(''), { method: 'POST', body: payload });
      return (data && data.item) || null;
    },

    /* PATCH /api/models/:id（displayName / modelId / enabled） */
    async update(id, payload) {
      var data = await CL.fetchJSON(endpoint(itemPath(id)), { method: 'PATCH', body: payload });
      return (data && data.item) || null;
    },

    /* DELETE /api/models/:id → 204 */
    async remove(id) {
      await CL.fetchJSON(endpoint(itemPath(id)), { method: 'DELETE' });
    },

    /* PATCH /api/models/:id/default（全局唯一，禁用模型后端返回 400） */
    async setDefault(id) {
      var data = await CL.fetchJSON(endpoint(itemPath(id, '/default')), { method: 'PATCH' });
      return (data && data.item) || null;
    },

    /* PATCH /api/models/:id/status */
    async toggle(id, enabled) {
      var data = await CL.fetchJSON(endpoint(itemPath(id, '/status')), {
        method: 'PATCH',
        body: { enabled: enabled === true }
      });
      return (data && data.item) || null;
    },

    /* POST /api/models/:id/test → { ok, latencyMs, message } */
    async test(id) {
      return CL.fetchJSON(endpoint(itemPath(id, '/test')), { method: 'POST' });
    }
  };

  CL.models = models;

  /* ---------- 页面控制（models.html） ---------- */
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
    var form = CL.qs('[data-model-form]');
    if (!form) return;

    var tbody = CL.qs('[data-model-rows]');
    if (!tbody) return;

    var countTag = CL.qs('[data-model-count]');
    var searchInput = CL.qs('[data-model-search]');
    var providerFilter = CL.qs('[data-model-provider-filter]');
    var statusFilter = CL.qs('[data-model-status-filter]');
    var syncBtn = CL.qs('[data-model-sync]');

    var modeTag = CL.qs('[data-model-mode]');
    var titleEl = CL.qs('[data-model-form-title]');
    var currentEl = CL.qs('[data-model-current]');
    var errorEl = CL.qs('[data-model-form-error]');
    var providerHint = CL.qs('[data-model-provider-hint]');
    var defaultHint = CL.qs('[data-model-default-hint]');

    var submitBtn = form.querySelector('button[type="submit"]');
    var cancelBtn = CL.qs('[data-model-cancel]', form);
    var testBtn = CL.qs('[data-model-test]', form);
    var pullBtn = CL.qs('[data-model-pull]', form);

    var nameInput = CL.qs('#model-name', form);
    var modelIdInput = CL.qs('#model-id', form);
    var providerSelect = CL.qs('#model-api', form);
    var enabledInput = CL.qs('#model-enabled', form);
    var defaultInput = CL.qs('#model-default', form);

    var emptyRow = tbody.querySelector('.cl-table__empty');
    var emptyTemplate = emptyRow ? emptyRow.cloneNode(true) : null;

    var items = [];
    var providers = [];
    var editingId = null;
    var current = null;
    var query = { keyword: '', providerId: '', status: '' };
    var searchTimer = null;
    var loadSeq = 0;
    var busy = false;

    /* ---------- 渲染工具 ---------- */
    function paintCount() {
      if (!countTag) return;
      countTag.textContent = items.length + ' 个模型';
      countTag.className = 'cl-tag' + (items.length ? ' cl-tag--ok' : ' cl-tag--off');
    }

    function emptyState(title, desc, keepAction) {
      if (!emptyTemplate) {
        return CL.el('tr', { class: 'cl-table__empty' }, [
          CL.el('td', { colspan: '7' }, [CL.el('div', { class: 'admin-table-state', text: title })])
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
        CL.el('td', { colspan: '7' }, [CL.el('div', { class: 'admin-table-state', text: text })])
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
      var enabled = item.enabled !== false;
      var tr = CL.el('tr', { dataset: { id: String(item.id) } });
      if (!enabled) tr.classList.add('is-off');
      if (item.isDefault) tr.classList.add('is-default');

      tr.appendChild(CL.el('td', {}, [
        CL.el('div', { class: 'admin-cell-main', text: item.displayName || item.modelId || '未命名模型' }),
        item.lastTestedAt
          ? CL.el('div', { class: 'admin-cell-sub', text: '上次测试 ' + CL.formatTime(item.lastTestedAt, 'datetime') })
          : null
      ]));
      tr.appendChild(CL.el('td', {}, [
        CL.el('span', { class: 'admin-cell-code', text: item.modelId || '—' })
      ]));
      tr.appendChild(CL.el('td', { text: item.providerName || '—' }));
      tr.appendChild(CL.el('td', {}, [statusTag(enabled)]));
      tr.appendChild(CL.el('td', {}, [
        item.isDefault
          ? CL.el('span', { class: 'cl-tag cl-tag--violet', text: '默认' })
          : CL.el('span', { class: 'admin-muted', text: '—' })
      ]));
      tr.appendChild(CL.el('td', { text: CL.formatTime(item.createdAt, 'auto') }));
      tr.appendChild(CL.el('td', {}, [
        CL.el('div', { class: 'cl-table-actions' }, [
          item.isDefault
            ? null
            : actionBtn('设为默认', 'default', item, 'cl-btn cl-btn--soft cl-btn--xs', enabled ? null : {
              disabled: true,
              title: '禁用模型不能设为默认，请先启用'
            }),
          actionBtn(enabled ? '禁用' : '启用', 'toggle', item, 'cl-btn cl-btn--ghost cl-btn--xs'),
          actionBtn('测试', 'test', item, 'cl-btn cl-btn--ghost cl-btn--xs'),
          actionBtn('编辑', 'edit', item, 'cl-btn cl-btn--ghost cl-btn--xs'),
          actionBtn('删除', 'remove', item, 'cl-btn cl-btn--danger-ghost cl-btn--xs')
        ])
      ]));
      return tr;
    }

    function renderRows() {
      tbody.textContent = '';
      paintCount();
      if (!items.length) {
        if (!providers.length) {
          tbody.appendChild(emptyState(
            '还没有可用的 API 服务',
            '先到「API 管理」添加服务并刷新模型，模型会自动出现在这里。',
            true
          ));
        } else if (query.keyword || query.providerId || query.status) {
          tbody.appendChild(emptyState('没有匹配的模型', '换个关键词或筛选条件再试试。', false));
        } else {
          tbody.appendChild(emptyState(
            '还没有模型',
            '在下方表单手动添加，或用「从 API 拉取」同步服务上的模型。',
            false
          ));
        }
        return;
      }
      items.forEach(function (item) { tbody.appendChild(buildRow(item)); });
    }

    function findItem(id) {
      var key = String(id);
      return items.filter(function (item) { return String(item.id) === key; })[0] || null;
    }

    /* ---------- 下拉框 ---------- */
    function fillProviderOptions(select, placeholder, keepValue) {
      if (!select) return;
      var wanted = keepValue;
      select.textContent = '';
      select.appendChild(CL.el('option', { value: '', text: placeholder }));
      providers.forEach(function (provider) {
        select.appendChild(CL.el('option', {
          value: String(provider.id),
          text: provider.name || '未命名服务'
        }));
      });
      var exists = Array.prototype.some.call(select.options, function (option) {
        return option.value === wanted;
      });
      if (wanted && !exists) {
        select.appendChild(CL.el('option', { value: wanted, text: wanted }));
      }
      select.value = wanted || '';
    }

    function syncFilterValue() {
      if (!providerFilter) return;
      query.providerId = providerFilter.value || '';
    }

    /* ---------- 表单状态 ---------- */
    function setError(message) {
      if (!errorEl) return;
      errorEl.textContent = message || '';
      errorEl.hidden = !message;
    }

    function paintMode() {
      var editing = editingId !== null;
      if (modeTag) modeTag.textContent = editing ? '编辑' : '新增';
      if (titleEl) titleEl.textContent = editing ? '编辑模型' : '添加模型';
      if (submitBtn) submitBtn.textContent = editing ? '保存修改' : '保存';
      if (cancelBtn) cancelBtn.hidden = !(editing || current);
      if (providerSelect) providerSelect.disabled = editing;
      if (defaultInput) defaultInput.disabled = editing;
      if (providerHint) {
        providerHint.textContent = editing
          ? '所属 API 保存后不可修改'
          : '从「API 管理」里已添加的服务中选择';
      }
      if (defaultHint) {
        defaultHint.textContent = editing
          ? '默认模型请在列表中点击「设为默认」'
          : '全局只能有一个默认模型，且必须是启用状态';
      }
      if (currentEl) {
        currentEl.textContent = current
          ? '当前模型：' + (current.displayName || current.modelId || '未命名模型') + '，可直接测试'
          : '当前模型：尚未保存，保存后才能测试';
      }
    }

    function fillForm(item) {
      nameInput.value = item.displayName || '';
      modelIdInput.value = item.modelId || '';
      if (providerSelect) {
        var value = item.providerId === undefined || item.providerId === null ? '' : String(item.providerId);
        var exists = Array.prototype.some.call(providerSelect.options, function (option) {
          return option.value === value;
        });
        if (value && !exists) {
          providerSelect.appendChild(CL.el('option', { value: value, text: item.providerName || value }));
        }
        providerSelect.value = value;
      }
      enabledInput.checked = item.enabled !== false;
      defaultInput.checked = item.isDefault === true;
      setError('');
    }

    function resetForm() {
      editingId = null;
      current = null;
      form.reset();
      setError('');
      paintMode();
    }

    function collectCreate() {
      var payload = {
        providerId: providerSelect ? providerSelect.value : '',
        modelId: (modelIdInput.value || '').trim(),
        enabled: enabledInput.checked
      };
      var displayName = (nameInput.value || '').trim();
      if (displayName) payload.displayName = displayName;
      if (defaultInput && defaultInput.checked) payload.isDefault = true;
      return payload;
    }

    function collectUpdate() {
      return {
        displayName: (nameInput.value || '').trim(),
        modelId: (modelIdInput.value || '').trim(),
        enabled: enabledInput.checked
      };
    }

    function validateCreate(payload) {
      if (!payload.providerId) return '请选择所属 API 服务';
      if (!payload.modelId) return '请填写模型 ID';
      if (payload.isDefault && !payload.enabled) return '禁用状态的模型不能设为默认';
      return '';
    }

    function validateUpdate(payload) {
      if (!payload.modelId) return '请填写模型 ID';
      return '';
    }

    /* ---------- 反馈 ---------- */
    function reportTest(res) {
      var ok = !!res && res.ok !== false;
      var text = (res && res.message) || (ok ? '模型可用' : '模型测试失败');
      if (res && typeof res.latencyMs === 'number') text += '（延迟 ' + res.latencyMs + ' ms）';
      CL.toast(text, ok ? 'success' : 'error');
    }

    function reportPull(res) {
      var ok = !!res && res.ok !== false;
      if (!ok) {
        CL.toast((res && res.message) || '拉取模型失败', 'error');
        return;
      }
      var added = res && typeof res.added === 'number' ? res.added : 0;
      var total = res && typeof res.total === 'number' ? res.total : 0;
      CL.toast(
        '拉取完成：新增 ' + added + ' 个，共 ' + total + ' 个模型。新模型默认禁用，请在列表中启用。',
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

    /* ---------- 数据加载 ---------- */
    async function loadProviders() {
      try {
        providers = await CL.api.list();
      } catch (err) {
        providers = [];
        console.error('加载 API 服务失败：', messageOf(err));
      }
      var filterValue = providerFilter ? providerFilter.value : '';
      fillProviderOptions(providerFilter, '全部 API', filterValue);
      if (providerFilter) {
        if (providerFilter.value !== filterValue) providerFilter.value = '';
        query.providerId = providerFilter.value || '';
      }
      fillProviderOptions(providerSelect, '请选择 API 服务', providerSelect ? providerSelect.value : '');
    }

    async function loadList() {
      var seq = ++loadSeq;
      tbody.textContent = '';
      tbody.appendChild(loadingState('正在加载…'));
      try {
        var list = await models.list(query);
        if (seq !== loadSeq) return;
        items = list;
        syncCurrent();
        renderRows();
      } catch (err) {
        if (seq !== loadSeq) return;
        items = [];
        paintCount();
        console.error('加载模型列表失败：', messageOf(err));
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
      var label = item.displayName || item.modelId || '该模型';
      var ok = await CL.confirmDialog('删除模型「' + label + '」后不可恢复，确定删除吗？', {
        title: '删除模型',
        confirmText: '删除',
        danger: true
      });
      if (!ok) return;
      try {
        await models.remove(item.id);
        CL.toast('已删除该模型', 'success');
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
      var panel = CL.qs('#model-form');
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
        if (action === 'default') {
          await models.setDefault(item.id);
          CL.toast('已设为默认模型', 'success');
          await loadList();
        } else if (action === 'toggle') {
          await models.toggle(item.id, item.enabled === false);
          CL.toast(item.enabled === false ? '已启用该模型' : '已禁用该模型', 'success');
          await loadList();
        } else if (action === 'test') {
          reportTest(await models.test(item.id));
          await loadList();
        }
      } catch (err) {
        CL.toast(messageOf(err), 'error');
      } finally {
        if (btn.parentNode) btn.disabled = false;
      }
    }

    /* ---------- 从 API 同步 ---------- */
    async function syncAll() {
      var targets = providers.filter(function (provider) { return provider.enabled !== false; });
      if (!targets.length) {
        CL.toast('没有已启用的 API 服务可同步', 'info');
        return;
      }
      var success = 0;
      var failed = 0;
      for (var i = 0; i < targets.length; i += 1) {
        try {
          var res = await CL.api.refreshModels(targets[i].id);
          if (res && res.ok === false) failed += 1;
          else success += 1;
        } catch (err) {
          failed += 1;
          console.error('同步服务失败：', messageOf(err));
        }
      }
      CL.toast(
        '同步完成：成功 ' + success + ' 个，失败 ' + failed + ' 个。新模型默认禁用，请在列表中启用。',
        failed ? 'warning' : 'success',
        6000
      );
      await loadProviders();
      await loadList();
    }

    /* ---------- 事件 ---------- */
    tbody.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
      if (!btn || !tbody.contains(btn)) return;
      var item = findItem(btn.getAttribute('data-id'));
      if (!item) return;
      runRowAction(btn.getAttribute('data-action'), item, btn);
    });

    function scheduleReload() {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = null;
        query.keyword = searchInput ? (searchInput.value || '').trim() : '';
        loadList();
      }, 300);
    }

    if (searchInput) {
      searchInput.addEventListener('input', scheduleReload);
      searchInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (searchTimer) {
            clearTimeout(searchTimer);
            searchTimer = null;
          }
          query.keyword = (searchInput.value || '').trim();
          loadList();
        }
      });
    }

    if (providerFilter) {
      providerFilter.addEventListener('change', function () {
        syncFilterValue();
        loadList();
      });
    }

    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        query.status = statusFilter.value || '';
        loadList();
      });
    }

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (busy) return;
      setError('');
      busy = true;
      if (submitBtn) submitBtn.disabled = true;
      try {
        if (editingId !== null) {
          var patch = collectUpdate();
          var patchError = validateUpdate(patch);
          if (patchError) {
            setError(patchError);
            return;
          }
          await models.update(editingId, patch);
          CL.toast('模型已更新', 'success');
        } else {
          var payload = collectCreate();
          var message = validateCreate(payload);
          if (message) {
            setError(message);
            return;
          }
          current = await models.create(payload);
          CL.toast('模型已添加', 'success');
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
      });
    }

    if (testBtn) {
      testBtn.addEventListener('click', function () {
        if (!current) {
          CL.toast('请先保存该模型，再测试', 'info');
          return;
        }
        withButton(testBtn, '测试中…', async function () {
          try {
            reportTest(await models.test(current.id));
            await loadList();
          } catch (err) {
            CL.toast(messageOf(err), 'error');
          }
        });
      });
    }

    if (pullBtn) {
      pullBtn.addEventListener('click', function () {
        var providerId = editingId !== null && current
          ? String(current.providerId)
          : (providerSelect ? providerSelect.value : '');
        if (!providerId) {
          CL.toast('请先在「所属 API」中选择一个服务', 'info');
          return;
        }
        withButton(pullBtn, '拉取中…', async function () {
          try {
            reportPull(await CL.api.refreshModels(providerId));
            await loadProviders();
            await loadList();
          } catch (err) {
            CL.toast(messageOf(err), 'error');
          }
        });
      });
    }

    if (syncBtn) {
      syncBtn.addEventListener('click', function () {
        withButton(syncBtn, '同步中…', syncAll);
      });
    }

    paintMode();
    (async function bootstrap() {
      await loadProviders();
      await loadList();
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPage);
  else initPage();
})(window, document);
