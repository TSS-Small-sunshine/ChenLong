/* ============================================================
   尘龙 ChenLong · 页面守卫与登录态渲染 guard.js
   依赖 app.js（CL.fetchJSON / CL.url / CL.toast）与 auth.js（CL.auth.me）。

   页面声明：
     <body data-guard="auth">    未登录 → login.html?redirect=<当前路径+search>
     <body data-guard="admin">   未登录或 role!=='admin' → 同上
   渲染约定：
     [data-guest-only] 游客可见   [data-auth-only] 已登录可见
     [data-user-nickname] / [data-user-username] / [data-user-avatar] /
     [data-user-role] / [data-user-id] / [data-user-created] 填充登录用户
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var qs = CL.qs;
  var qsa = CL.qsa;

  var LEVEL = (document.body && document.body.getAttribute('data-guard')) || '';

  /* 会话检查期间先藏起登录态区块，避免「登录 / 注册」闪一下再变昵称 */
  if (document.body) {
    document.body.classList.add('is-guard-pending');
    window.setTimeout(function () { document.body.classList.remove('is-guard-pending'); }, 4000);
  }

  function redirectToLogin() {
    var path = window.location.pathname || '';
    if (/\/login\.html$/.test(path)) return;
    var next = path + (window.location.search || '');
    window.location.replace(CL.url('login.html?redirect=' + encodeURIComponent(next)));
  }

  function initialOf(user) {
    var text = String((user && (user.nickname || user.username)) || '').trim();
    return text ? text.charAt(0).toUpperCase() : '尘';
  }

  function paint(user) {
    var authed = !!user;
    qsa('[data-guest-only]').forEach(function (node) { node.hidden = authed; });
    qsa('[data-auth-only]').forEach(function (node) { node.hidden = !authed; });
    if (!authed) return;

    var name = user.nickname || user.username || '用户';
    qsa('[data-user-nickname]').forEach(function (node) { node.textContent = name; });
    qsa('[data-user-username]').forEach(function (node) { node.textContent = user.username || '—'; });
    qsa('[data-user-avatar]').forEach(function (node) { node.textContent = initialOf(user); });
    qsa('[data-user-role]').forEach(function (node) {
      node.textContent = user.role === 'admin' ? '管理员' : '普通用户';
    });
    qsa('[data-user-id]').forEach(function (node) { node.textContent = String(user.id); });
    qsa('[data-user-created]').forEach(function (node) { node.textContent = CL.formatTime(user.created_at, 'datetime'); });

    var profileHint = qs('#profile-nickname-hint');
    if (profileHint) {
      var text = '当前昵称：' + name;
      profileHint.dataset.default = text;
      if (!profileHint.classList.contains('is-error')) profileHint.textContent = text;
    }
  }

  var sessionPromise = null;

  function session() {
    if (!sessionPromise) {
      sessionPromise = CL.auth.me().catch(function (err) {
        if (err && err.status === 401) return null;
        throw err;
      });
    }
    return sessionPromise;
  }

  function finish(user) {
    if (document.body) document.body.classList.remove('is-guard-pending');
    return user;
  }

  function run() {
    return session()
      .then(function (user) {
        if (LEVEL === 'auth' || LEVEL === 'admin') {
          if (!user) {
            redirectToLogin();
            return null;
          }
          if (LEVEL === 'admin' && user.role !== 'admin') {
            if (CL.flash) CL.flash('需要管理员权限，请使用管理员账号登录', 'error');
            redirectToLogin();
            return null;
          }
        }
        paint(user);
        return user;
      })
      .catch(function (err) {
        if (LEVEL) {
          if (CL.flash) CL.flash((err && err.message) || '登录状态检查失败', 'error');
          redirectToLogin();
          return null;
        }
        CL.toast((err && err.message) || '登录状态检查失败', 'error');
        return null;
      })
      .then(finish);
  }

  var guard = {
    level: LEVEL,
    session: session,
    paint: paint,
    redirectToLogin: redirectToLogin,
    ready: null
  };

  CL.guard = guard;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { guard.ready = run(); });
  } else {
    guard.ready = run();
  }
})(window, document);
