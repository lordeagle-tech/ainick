// features/gptAndroid.js — free GPT via ChatGPT Android anonymous backend.
// No API key required. Rotates device every 10 prompts. Session is per-process
// (shared across chats for rate simplicity). Used as a sub-agent when owner
// switches with `model gpt` or when Agnes is unavailable.
const axios = require('axios');
const logger = require('../logger');

const BASE = 'https://android.chat.openai.com';

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function parseCookies(setCookieHeader) {
  const obj = {};
  if (!setCookieHeader) return obj;
  // axios may give array or string
  const parts = Array.isArray(setCookieHeader) ? setCookieHeader : String(setCookieHeader).split(/,(?=[^;]+?=)/);
  for (const c of parts) {
    const [kv] = String(c).split(';');
    const eq = kv.indexOf('=');
    if (eq > 0) {
      const key = kv.slice(0, eq).trim();
      const val = kv.slice(eq + 1).trim();
      if (key) obj[key] = val;
    }
  }
  return obj;
}

function cleanSpecialTags(text) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(/\ue200entity\ue202([^\ue201]+)\ue201/g, (match, p1) => {
    try {
      const arr = JSON.parse(p1);
      return arr[1] || arr[0] || '';
    } catch {
      return '';
    }
  });
  t = t.replace(/\ue200[^\ue201]*\ue201/g, '');
  return t.trim();
}

// Process-wide session (device rotation every 10 prompts)
let session = {
  auth: null,
  chatId: null,
  promptCount: 0,
};

async function getSession() {
  const deviceId = generateUUID();
  const res = await axios.post(
    `${BASE}/backend-anon/sentinel/chat-requirements`,
    {},
    {
      headers: {
        'User-Agent': 'ChatGPT/1.2026.181 (Android 16; Neo/1.0; build 2222222)',
        'OAI-Package-Name': 'com.openai.chatgpt',
        'OAI-Client-Type': 'android',
        'OAI-Device-Id': deviceId,
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Device-Tier': 'upper_mid',
        'ChatGPT-Account-Id': 'default',
        'ChatGPT-Residency-Region': 'no_constraint',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
      validateStatus: () => true,
    }
  );
  const setCookie = res.headers['set-cookie'] || res.headers['Set-Cookie'];
  const cookies = parseCookies(setCookie);
  let cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const data = res.data || {};
  let oaiSc = cookies['oai-sc'];
  if (!oaiSc && data?.token) {
    oaiSc = '0' + data.token;
    cookieStr = `oai-sc=${oaiSc}; ${cookieStr}`;
  }
  return { cookie: cookieStr, deviceId, parentMessageId: generateUUID() };
}

async function rotateDevice() {
  const newSession = await getSession();
  session = { auth: newSession, chatId: null, promptCount: 0 };
  logger.info('gpt-android: device rotated');
  return session;
}

/**
 * Chat completion via Android anon API.
 * @param {Array<{role:string, content:string|Array}>} messages - OpenAI-style messages
 * @returns {Promise<{role:string, content:string}>}
 */
async function complete(messages) {
  // Extract last user text + recent history (text only)
  const history = [];
  let lastUser = '';
  for (const m of messages || []) {
    if (m.role === 'system') continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((b) => b && (typeof b === 'string' || b.type === 'text'))
        .map((b) => (typeof b === 'string' ? b : String(b.text || '')))
        .join('\n');
    }
    if (!text.trim()) continue;
    if (m.role === 'user') lastUser = text;
    if (m.role === 'user' || m.role === 'assistant') {
      history.push({ role: m.role, content: text });
    }
  }
  // history includes last user — chatGPT wants history without the final prompt
  const prior = history.slice(0, -1);
  const prompt = lastUser || (history.length ? history[history.length - 1].content : 'Hello');

  if (session.promptCount >= 10 || !session.auth) {
    await rotateDevice();
  }
  if (!session.auth) session.auth = await getSession();
  if (!session.auth.deviceId) session.auth.deviceId = generateUUID();
  if (!session.auth.parentMessageId) session.auth.parentMessageId = generateUUID();

  const auth = session.auth;
  const chatId = session.chatId;
  const promptCount = session.promptCount;

  const apiMessages = [];
  for (const msg of prior.slice(-10)) {
    apiMessages.push({
      id: generateUUID(),
      author: { role: msg.role },
      content: { content_type: 'text', parts: [msg.content] },
      status: 'finished_successfully',
      recipient: 'all',
    });
  }
  apiMessages.push({
    id: generateUUID(),
    author: { role: 'user' },
    content: { content_type: 'text', parts: [prompt] },
    status: 'finished_successfully',
    recipient: 'all',
  });

  const body = {
    action: 'next',
    messages: apiMessages,
    model: 'auto',
    history_and_training_disabled: false,
    enable_message_followups: true,
    force_use_sse: true,
    supported_encodings: ['v1'],
    supports_buffering: true,
    timezone: 'Africa/Lagos',
    timezone_offset_min: -60,
    no_auth_ad_preferences: { personalization_enabled: true, history_enabled: true },
    client_prepare_state: 'none',
    stream: true,
  };
  if (chatId) {
    body.conversation_id = chatId;
    body.parent_message_id = auth.parentMessageId;
  }

  const res = await axios.post(`${BASE}/backend-anon/f/conversation`, body, {
    headers: {
      'User-Agent': 'ChatGPT/1.2026.181 (Android 16; Neo/1.0; build 2222222)',
      'OAI-Package-Name': 'com.openai.chatgpt',
      'OAI-Client-Type': 'android',
      'OAI-Device-Id': auth.deviceId,
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Device-Tier': 'upper_mid',
      'ChatGPT-Account-Id': 'default',
      'ChatGPT-Residency-Region': 'no_constraint',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Cookie: auth.cookie,
    },
    timeout: 120000,
    responseType: 'text',
    validateStatus: () => true,
    transformResponse: [(d) => d],
  });

  if (res.status >= 400) {
    const err = new Error(`GPT Android API status ${res.status}: ${String(res.data || '').slice(0, 200)}`);
    err.response = { status: res.status, data: res.data };
    // Force rotate on auth-ish errors
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      session.promptCount = 99;
    }
    throw err;
  }

  const text = typeof res.data === 'string' ? res.data : String(res.data || '');
  let result = '';
  let finalChatId = chatId;
  let currentAssistantMsgId = null;
  let lastPath = null;
  let lastOp = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'data: [DONE]') continue;
    if (!trimmed.startsWith('data: ')) continue;
    try {
      const data = JSON.parse(trimmed.substring(6));
      if (data.conversation_id) finalChatId = data.conversation_id;
      const p = data.p !== undefined ? data.p : lastPath;
      const o = data.o !== undefined ? data.o : lastOp;
      if (data.p !== undefined) lastPath = data.p;
      if (data.o !== undefined) lastOp = data.o;

      if (o === 'add' && data.v?.message?.author?.role === 'assistant') {
        currentAssistantMsgId = data.v.message.id;
        const parts = data.v.message.content?.parts;
        if (parts?.[0]) result = parts[0];
      } else if (o === 'patch' && Array.isArray(data.v)) {
        for (const op of data.v) {
          if (op.o === 'append' && op.p?.startsWith('/message/content/parts/')) {
            result += op.v;
          }
        }
      } else if (o === 'append' && p?.startsWith('/message/content/parts/') && typeof data.v === 'string') {
        result += data.v;
      }
    } catch {
      /* ignore parse errors in stream */
    }
  }

  if (currentAssistantMsgId) auth.parentMessageId = currentAssistantMsgId;
  session.auth = auth;
  session.chatId = finalChatId;
  session.promptCount = promptCount + 1;

  const cleaned = cleanSpecialTags(result);
  if (!cleaned) {
    const e = new Error('Empty response from GPT Android API');
    e.code = 'EMPTY_RESPONSE';
    throw e;
  }
  return { role: 'assistant', content: cleaned };
}

module.exports = { complete, rotateDevice };
