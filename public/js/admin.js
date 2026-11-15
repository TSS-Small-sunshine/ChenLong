/* ============================================================
   尘龙 ChenLong · 管理后台接口封装（骨架 / 阶段 1）
   覆盖：仪表盘统计 / 系统状态 / 用户管理 / 聊天数据 / 系统设置。
   不发起真实请求、不返回假数据；阶段 2 按 TODO 接入。
   ============================================================ */
(function (window, document) {
  'use strict';

  var CL = (window.CL = window.CL || {});
  var qs = CL.qs;

  function pending(action) {
    throw new Error('尚未接入后端：' + action + '（计划阶段 2）');
  }

  var admin = {
    /* TODO 阶段 2：GET /api/admin/stats —— 返回 { users, conversations, messages, models } */
    async stats() {
      pending('获取仪表盘统计');
    },

    /* TODO 阶段 2：GET /api/admin/system/status —— 返回 [{ key, name, state, desc }] */
    async systemStatus() {
      pending('获取系统状态');
    },

    /* TODO 阶段 2：GET /api/admin/apis/recent?limit=5 */
    async recentApis() {
      pending('获取最近添加的 API');
    },

    /* TODO 阶段 2：GET /api/admin/models/recent?limit=5 */
    async recentModels() {
      pending('获取最近使用的模型');
    },

    users: {
      /* TODO 阶段 2：GET /api/admin/users?keyword=&status=&page= */
      async list(params) {
        void params;
        pending('获取用户列表');
      },

      /* TODO 阶段 2：PATCH /api/admin/users/:id/status —— payload: { disabled } */
      async toggle(id, disabled) {
        void id;
        void disabled;
        pending('禁用 / 启用用户');
      }
    },

    conversations: {
      /* TODO 阶段 2：GET /api/admin/conversations?keyword=&page= —— 含消息数 */
      async list(params) {
        void params;
        pending('获取聊天数据');
      },

      /* TODO 阶段 2：GET /api/admin/conversations/:id/messages */
      async messages(id) {
        void id;
        pending('查看会话消息');
      }
    },

    settings: {
      /* TODO 阶段 2：GET /api/admin/settings */
      async get() {
        pending('读取系统设置');
      },

      /* TODO 阶段 2：PUT /api/admin/settings
         payload: { siteName, subtitle, logo, defaultModelId, allowRegister, chatEnabled, announcement } */
      async save(payload) {
        void payload;
        pending('保存系统设置');
      }
    }
  };

  CL.admin = admin;
})(window, document);
