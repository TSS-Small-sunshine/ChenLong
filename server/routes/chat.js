const express = require('express');

const { requireAuth } = require('../middleware/auth');
const chatClient = require('../services/chat-client');
const { decrypt } = require('../services/encryption');
const store = require('../services/chat-store');
const { isChatAllowed } = require('../services/settings-store');

const router = express.Router();

router.use(requireAuth);

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function readMessage(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, message: '请输入消息内容' };
  if (value.length > store.MESSAGE_MAX) return { ok: false, message: `消息过长（最多 ${store.MESSAGE_MAX} 字）` };
  return { ok: true, value };
}

function readTitle(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < 1 || value.length > store.TITLE_MAX) {
    return { ok: false, message: `会话标题需为 1-${store.TITLE_MAX} 个字` };
  }
  return { ok: true, value };
}

function wantsStream(raw) {
  return raw === true || raw === 'true' || raw === 1;
}

async function resolveConversation(userId, rawConversationId, message, modelId) {
  if (store.isEmptyId(rawConversationId)) {
    const created = await store.createConversation(userId, { title: store.autoTitle(message), modelId });
    return { ok: true, id: created.id };
  }
  const id = store.parseId(rawConversationId);
  const existing = id ? await store.findConversation(userId, id) : null;
  if (!existing) return { ok: false };
  return { ok: true, id: existing.id };
}

async function complete({ res, model, modelName, conversationId, userMessage, history, stream }) {
  const controller = new AbortController();
  let clientGone = false;

  // Node 24 里 req 的 close 在请求体读完时就会触发（早于响应），只能依赖 res 的 close + writableEnded 判断掉线
  res.on('close', () => {
    if (clientGone || res.writableEnded) return;
    clientGone = true;
    controller.abort();
  });

  let sse = false;
  const writeEvent = (payload) => {
    if (!sse || clientGone || res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const endSse = () => {
    if (!sse || clientGone || res.writableEnded) return;
    res.write('data: [DONE]\n\n');
    res.end();
  };

  if (stream) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    sse = true;
    writeEvent({ type: 'start', conversationId, userMessageId: userMessage.id, modelName });
  }

  const failUpstream = (code, message) => {
    if (!sse) return fail(res, 502, code, message);
    writeEvent({ type: 'error', code, message });
    return endSse();
  };

  let apiKey;
  try {
    apiKey = decrypt(model.api_key_encrypted);
  } catch (err) {
    console.error('[chat] API Key 解密失败：', err.message);
    return failUpstream('UPSTREAM_ERROR', 'API Key 解密失败，请重新保存该服务的密钥');
  }

  const result = await chatClient.streamChatCompletion({
    baseUrl: model.base_url,
    apiKey,
    modelId: model.model_id,
    messages: history,
    signal: controller.signal,
    onDelta: (content) => writeEvent({ type: 'delta', content }),
  });

  if (result.aborted) {
    if (result.content) {
      const saved = await store.appendMessage(conversationId, store.ROLE_ASSISTANT, result.content);
      await store.touchConversation(conversationId, model.id);
      console.warn(
        `[chat] 客户端断开，已保存部分回复：conversation=${conversationId} message=${saved.id} 字数=${result.content.length}`
      );
    }
    return undefined;
  }

  if (!result.ok) return failUpstream(result.code || 'UPSTREAM_ERROR', result.message);

  const assistant = await store.appendMessage(conversationId, store.ROLE_ASSISTANT, result.content);
  await store.touchConversation(conversationId, model.id);

  if (sse) {
    writeEvent({ type: 'done', conversationId, assistantMessageId: assistant.id, content: result.content });
    return endSse();
  }
  return res.json({
    conversationId,
    assistantMessageId: assistant.id,
    content: result.content,
    modelName,
  });
}

router.get('/models', async (req, res, next) => {
  try {
    return res.json({ items: await store.listModels() });
  } catch (err) {
    return next(err);
  }
});

router.get('/conversations', async (req, res, next) => {
  try {
    return res.json({ items: await store.listConversations(req.user.id, req.query.keyword) });
  } catch (err) {
    return next(err);
  }
});

router.post('/conversations', async (req, res, next) => {
  try {
    const body = req.body || {};
    let title = store.TITLE_DEFAULT;
    if (body.title !== undefined && body.title !== null && String(body.title).trim() !== '') {
      const read = readTitle(body.title);
      if (!read.ok) return fail(res, 400, 'VALIDATION_ERROR', read.message);
      title = read.value;
    }
    return res.status(201).json({ item: await store.createConversation(req.user.id, { title, modelId: body.modelId }) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/conversations/:id', async (req, res, next) => {
  try {
    const id = store.parseId(req.params.id);
    if (!id || !(await store.findConversation(req.user.id, id))) return fail(res, 404, 'NOT_FOUND', '会话不存在');
    const read = readTitle((req.body || {}).title);
    if (!read.ok) return fail(res, 400, 'VALIDATION_ERROR', read.message);
    return res.json({ item: await store.renameConversation(req.user.id, id, read.value) });
  } catch (err) {
    return next(err);
  }
});

router.delete('/conversations/:id', async (req, res, next) => {
  try {
    const id = store.parseId(req.params.id);
    if (!id || !(await store.deleteConversation(req.user.id, id))) return fail(res, 404, 'NOT_FOUND', '会话不存在');
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const id = store.parseId(req.params.id);
    if (!id || !(await store.findConversation(req.user.id, id))) return fail(res, 404, 'NOT_FOUND', '会话不存在');
    return res.json({ items: await store.listMessages(id) });
  } catch (err) {
    return next(err);
  }
});

router.post('/completions', async (req, res, next) => {
  try {
    if (!(await isChatAllowed())) return fail(res, 403, 'CHAT_DISABLED', '管理员已暂停聊天服务');

    const body = req.body || {};
    const message = readMessage(body.message);
    if (!message.ok) return fail(res, 400, 'VALIDATION_ERROR', message.message);

    const resolved = await store.resolveModel(body.modelId);
    if (!resolved.ok) return fail(res, 400, resolved.code, resolved.message);
    const model = resolved.model;

    const conversation = await resolveConversation(req.user.id, body.conversationId, message.value, model.id);
    if (!conversation.ok) return fail(res, 404, 'NOT_FOUND', '会话不存在');

    const userMessage = await store.appendMessage(conversation.id, store.ROLE_USER, message.value);
    const history = await store.conversationHistory(conversation.id);

    return await complete({
      res,
      model,
      modelName: store.modelName(model),
      conversationId: conversation.id,
      userMessage,
      history,
      stream: wantsStream(body.stream),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
