/* ============================================================
   尘龙 ChenLong · 认证与账号接口封装
   接口：/api/auth/{register,login,logout,me}、/api/user/{profile,password}
   后端统一错误信封 { error: { code, message } } 由 CL.fetchJSON 解包，
   这里只负责请求形状、跳转规则与表单提示位联动。
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var qs = CL.qs;
  var qsa = CL.qsa;

  var ENDPOINTS = {
    me: '/api/auth/me',
    login: '/api/auth/login',
    register: '/api/auth/register',
    logout: '/api/auth/logout',
    profile: '/api/user/profile',
    password: '/api/user/password'
  };

  function request(path, options) {
    return CL.fetchJSON(CL.url(path), options);
  }

  /* ---------- 跳转参数 ---------- */
  /* 只接受站内绝对路径：以 / 开头、不含 // 与 :，防开放重定向 */
  function safeRedirect(target, fallback) {
    var value = typeof target === 'string' ? target.trim() : '';
    if (!value || value.charAt(0) !== '/') return fallback;
    if (value.indexOf('//') !== -1 || value.indexOf(':') !== -1) return fallback;
    if (value.indexOf('\\') !== -1) return fallback;
    if (/^\/(login|register)\.html(\?|$)/.test(value)) return fallback;
    return value;
  }

  function redirectParam() {
    try {
      return new URLSearchParams(window.location.search).get('redirect');
    } catch (err) {
      return null;
    }
  }

  /* ---------- 接口 ---------- */
  var auth = {
    /* GET /api/auth/me → user；未登录时抛 status=401，不跳转（游客页要用） */
    async me() {
      var data = await request(ENDPOINTS.me, { noAuthRedirect: true });
      return (data && data.user) || null;
    },

    /* POST /api/auth/login → user；成功后跳 redirect 指定的站内路径 */
    async login(payload) {
      var data = await request(ENDPOINTS.login, {
        method: 'POST',
        noAuthRedirect: true,
        body: { username: payload.username, password: payload.password }
      });
      // 登录会重建会话，旧 token 立即失效：写回响应里的新 token
      if (data && data.csrfToken) CL.csrf.set(data.csrfToken);
      window.location.assign(safeRedirect(redirectParam(), '/user.html'));
      return (data && data.user) || null;
    },

    /* POST /api/auth/register → user（后端同时下发会话）；成功后直接进用户中心 */
    async register(payload) {
      var data = await request(ENDPOINTS.register, {
        method: 'POST',
        noAuthRedirect: true,
        body: { nickname: payload.nickname, username: payload.username, password: payload.password }
      });
      // 注册同时建立会话：写回响应里的新 token
      if (data && data.csrfToken) CL.csrf.set(data.csrfToken);
      CL.flash(MESSAGES.register, 'success');
      window.location.assign('/user.html');
      return (data && data.user) || null;
    },

    /* POST /api/auth/logout → 204；成功后回首页 */
    async logout() {
      // 登出请求本身也要带旧 token（fetchJSON 自动附加），成功后再清缓存
      await request(ENDPOINTS.logout, { method: 'POST' });
      CL.csrf.clear();
      CL.flash(MESSAGES.logout, 'success');
      window.location.assign('/');
    },

    /* PATCH /api/user/profile → user */
    async updateProfile(payload) {
      var data = await request(ENDPOINTS.profile, { method: 'PATCH', body: { nickname: payload.nickname } });
      return (data && data.user) || null;
    },

    /* PATCH /api/user/password → { ok: true } */
    async changePassword(payload) {
      return request(ENDPOINTS.password, {
        method: 'PATCH',
        body: { currentPassword: payload.currentPassword, newPassword: payload.newPassword }
      });
    }
  };

  /* ---------- 表单提示位 ---------- */
  function hintOf(input) {
    var field = input.closest('.cl-field');
    return field ? field.querySelector('.cl-hint') : null;
  }

  function setError(input, message) {
    var field = input.closest('.cl-field');
    var hint = hintOf(input);
    if (!field) return;
    field.classList.toggle('has-error', !!message);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (!hint) return;
    if (hint.dataset.default === undefined) hint.dataset.default = hint.textContent;
    hint.textContent = message || hint.dataset.default;
    hint.classList.toggle('is-error', !!message);
    hint.classList.remove('is-ok');
  }

  function clearError(input) {
    setError(input, '');
  }

  function valueOf(form, name) {
    var input = form.elements[name];
    return input && typeof input.value === 'string' ? input.value.trim() : '';
  }

  var RULES = {
    username: { min: 3, max: 24, label: '用户名' },
    password: { min: 6, max: 64, label: '密码' },
    nickname: { min: 1, max: 20, label: '昵称' }
  };

  function checkLength(form, name) {
    var input = form.elements[name];
    if (!input) return true;
    var value = String(input.value || '').trim();
    var rule = RULES[name];
    if (!value) {
      setError(input, '请输入' + rule.label);
      return false;
    }
    if (value.length < rule.min || value.length > rule.max) {
      setError(input, rule.label + '长度需为 ' + rule.min + '–' + rule.max + ' 个字符');
      return false;
    }
    clearError(input);
    return true;
  }

  function validateLogin(form) {
    return [checkLength(form, 'username'), checkLength(form, 'password')].every(Boolean);
  }

  function validateRegister(form) {
    var ok = [checkLength(form, 'nickname'), checkLength(form, 'username'), checkLength(form, 'password')].every(Boolean);
    var password = form.elements.password;
    var confirm = form.elements.confirmPassword;
    if (confirm) {
      if (!confirm.value) {
        setError(confirm, '请再次输入密码');
        ok = false;
      } else if (password && confirm.value !== password.value) {
        setError(confirm, '两次输入的密码不一致');
        ok = false;
      } else {
        clearError(confirm);
      }
    }
    return ok;
  }

  function validatePasswordChange(form) {
    var ok = checkLength(form, 'password');
    var next = form.elements.newPassword;
    var confirm = form.elements.confirmPassword;
    if (next) {
      if (!next.value) {
        setError(next, '请输入新密码');
        ok = false;
      } else if (next.value.length < 6) {
        setError(next, '新密码至少 6 位');
        ok = false;
      } else {
        clearError(next);
      }
    }
    if (confirm) {
      if (next && confirm.value !== next.value) {
        setError(confirm, '两次输入的新密码不一致');
        ok = false;
      } else {
        clearError(confirm);
      }
    }
    return ok;
  }

  function focusFirstError(form) {
    var input = form.querySelector('.has-error input, .has-error select, .has-error textarea');
    if (input) input.focus();
  }

  /* ---------- 后端报错 → 字段提示 ---------- */
  function messageOf(err) {
    return (err && err.message) || '操作失败，请稍后重试';
  }

  function fieldForMessage(form, message) {
    if (!message) return null;
    if (message.indexOf('当前密码') !== -1) return form.elements.password || null;
    if (message.indexOf('昵称') !== -1) return form.elements.nickname || null;
    if (message.indexOf('用户名') !== -1) return form.elements.username || null;
    if (message.indexOf('新密码') !== -1) return form.elements.newPassword || null;
    if (message.indexOf('密码') !== -1) return form.elements.newPassword || form.elements.password || null;
    return null;
  }

  function resolveErrorField(form, err, message) {
    var code = err && err.code;
    if (code === 'USERNAME_TAKEN' || code === 'INVALID_CREDENTIALS') return form.elements.username || null;
    if (code === 'REGISTER_DISABLED') return form.elements.username || null;
    if (code === 'VALIDATION_ERROR') return fieldForMessage(form, message);
    return null;
  }

  /* 有字段就写进 .cl-hint，定位不到就 toast；始终视为已处理 */
  function showFormError(form, err) {
    var message = messageOf(err);
    var input = resolveErrorField(form, err, message);
    if (input) {
      setError(input, message);
      focusFirstError(form);
      return;
    }
    CL.toast(message, 'error');
  }

  function submitOnce(button, task, onError) {
    if (button && button.dataset.busy === '1') return;
    var original = button ? button.textContent : '';
    if (button) {
      button.dataset.busy = '1';
      button.disabled = true;
      button.textContent = '处理中…';
    }
    Promise.resolve()
      .then(task)
      .catch(function (err) {
        if (onError) onError(err);
        else CL.toast(messageOf(err), 'error');
      })
      .then(function () {
        if (!button) return;
        button.dataset.busy = '0';
        button.disabled = button.dataset.locked === '1';
        button.textContent = original;
      });
  }

  var MESSAGES = {
    register: '注册成功',
    logout: '已退出登录',
    profile: '昵称已更新',
    password: '密码已更新，下次登录请使用新密码'
  };

  /* ---------- 注册开关（GET /api/settings 的 allowRegister） ---------- */
  var REGISTER_CLOSED_TEXT = '管理员已关闭注册，暂时无法创建新账号';
  var registerLocked = false;

  /* 页面顶部提示条：只在关闭注册时出现，默认状态不新增任何节点 */
  function registerNotice() {
    var form = qs('[data-auth-form="register"]');
    if (!form) return null;
    var card = form.closest('.cl-card') || form;
    var notice = qs('#cl-register-notice');
    if (!notice && card.parentNode) {
      notice = CL.el('div', { id: 'cl-register-notice', class: 'cl-notice', role: 'status' });
      card.parentNode.insertBefore(notice, card);
    }
    if (notice) notice.textContent = REGISTER_CLOSED_TEXT;
    return notice;
  }

  /* 关闭注册：输入框与按钮全部禁用；data-locked 让 submitOnce 收尾时不重新启用 */
  function lockRegisterForm(message) {
    var form = qs('[data-auth-form="register"]');
    if (!form) return;
    qsa('input, button, select, textarea', form).forEach(function (field) {
      field.disabled = true;
      field.dataset.locked = '1';
    });
    form.classList.add('is-disabled');
    var notice = registerNotice();
    if (notice) notice.textContent = message || REGISTER_CLOSED_TEXT;
    registerLocked = true;
  }

  /* 设置接口不可用或字段缺失时保持原样（allowRegister 兜底为 true） */
  function watchRegisterSwitch() {
    if (!CL.settings || typeof CL.settings.ready !== 'object') return;
    CL.settings.ready.then(function (settings) {
      if (settings && settings.allowRegister === false && !registerLocked) lockRegisterForm();
    }, function () { /* 静默：前台按默认值继续工作 */ });
  }

  function bindAuthForms() {
    var loginForm = qs('[data-auth-form="login"]');
    if (loginForm) {
      loginForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (!validateLogin(loginForm)) {
          focusFirstError(loginForm);
          CL.toast('请检查用户名与密码', 'warning');
          return;
        }
        submitOnce(qs('[type="submit"]', loginForm), function () {
          return auth.login({ username: valueOf(loginForm, 'username'), password: loginForm.elements.password.value });
        }, function (err) {
          showFormError(loginForm, err);
        });
      });
      loginForm.addEventListener('input', function (ev) {
        if (ev.target.closest('.cl-field')) clearError(ev.target);
      });
    }

    var registerForm = qs('[data-auth-form="register"]');
    if (registerForm) {
      registerForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (!validateRegister(registerForm)) {
          focusFirstError(registerForm);
          CL.toast('请检查注册信息', 'warning');
          return;
        }
        var agree = registerForm.elements.agree;
        if (agree && !agree.checked) {
          CL.toast('请先阅读并同意用户协议', 'warning');
          return;
        }
        submitOnce(qs('[type="submit"]', registerForm), function () {
          return auth.register({
            nickname: valueOf(registerForm, 'nickname'),
            username: valueOf(registerForm, 'username'),
            password: registerForm.elements.password.value
          });
        }, function (err) {
          showFormError(registerForm, err);
          if (err && err.code === 'REGISTER_DISABLED') lockRegisterForm(messageOf(err));
        });
      });
      registerForm.addEventListener('input', function (ev) {
        if (ev.target.closest('.cl-field')) clearError(ev.target);
      });
    }

    /* 全局钩子可能被别处同名表单撞上，字段不全就不绑（如后台重置弹窗） */
    var profileForm = qs('[data-profile-form]');
    if (profileForm && profileForm.elements.nickname) {
      profileForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (!checkLength(profileForm, 'nickname')) {
          focusFirstError(profileForm);
          return;
        }
        submitOnce(qs('[type="submit"]', profileForm), function () {
          return auth.updateProfile({ nickname: valueOf(profileForm, 'nickname') }).then(function (user) {
            if (user && CL.guard && CL.guard.paint) CL.guard.paint(user);
            profileForm.elements.nickname.value = '';
            CL.toast(MESSAGES.profile, 'success');
            return user;
          });
        }, function (err) {
          showFormError(profileForm, err);
        });
      });
    }

    var passwordForm = qs('[data-password-form]');
    if (passwordForm && passwordForm.elements.password && passwordForm.elements.newPassword) {
      passwordForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (!validatePasswordChange(passwordForm)) {
          focusFirstError(passwordForm);
          CL.toast('请检查密码填写', 'warning');
          return;
        }
        submitOnce(qs('[type="submit"]', passwordForm), function () {
          return auth.changePassword({
            currentPassword: passwordForm.elements.password.value,
            newPassword: passwordForm.elements.newPassword.value
          }).then(function (result) {
            passwordForm.reset();
            CL.toast(MESSAGES.password, 'success');
            return result;
          });
        }, function (err) {
          showFormError(passwordForm, err);
        });
      });
    }

    qsa('[data-logout]').forEach(function (logoutBtn) {
      logoutBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        CL.confirmDialog('退出后需要重新登录才能继续使用，确定退出吗？', {
          title: '退出登录',
          confirmText: '退出',
          danger: true
        }).then(function (ok) {
          if (!ok) return undefined;
          return auth.logout().catch(function (err) {
            CL.toast(messageOf(err), 'error');
          });
        });
      });
    });

    /* 密码可见性切换 */
    qsa('[data-toggle-password]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = qs(btn.getAttribute('data-toggle-password'));
        if (!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        btn.classList.toggle('is-visible', show);
      });
    });

    watchRegisterSwitch();
  }

  auth.bindForms = bindAuthForms;
  auth.messages = MESSAGES;
  auth.safeRedirect = safeRedirect;
  auth.redirectParam = redirectParam;
  CL.auth = auth;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindAuthForms);
  else bindAuthForms();
})(window, document);
