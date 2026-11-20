'use strict';

module.exports = (runtime) => {
runtime.define("axon_tools", "axon_tools.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_FILE = path.join(process.cwd(), 'data', 'axon_tools.json');

function loadDb() {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ memories: {}, cron: [], proactive: {} }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { memories: {}, cron: [], proactive: {} };
  }
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch {}
}

// ── perm_memory ────────────────────────────────────────────────────────────────
function toolPermMemoryAdd(args) {
  const db = loadDb();
  const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    content: String(args?.content || ''),
    kind: ['preference', 'info', 'creds', 'keys', 'private', 'secret', 'note', 'fact'].includes(args?.kind)
      ? args.kind : 'fact',
    created: Date.now(),
  };
  db.memories[id] = entry;
  saveDb(db);
  return { ok: true, id, kind: entry.kind, content: entry.content.slice(0, 100) };
}

function toolPermMemorySearch(args) {
  const db = loadDb();
  const query = String(args?.query || '').toLowerCase();
  const kind = args?.kind;
  const limit = Number(args?.limit) || 8;
  const results = Object.values(db.memories || {})
    .filter(m => {
      if (kind && m.kind !== kind) return false;
      if (!query) return true;
      return (m.content || '').toLowerCase().includes(query) || (m.kind || '').toLowerCase().includes(query);
    })
    .slice(0, limit);
  return { ok: true, count: results.length, results };
}

function toolPermMemoryList(args) {
  const db = loadDb();
  const kind = args?.kind;
  const limit = Number(args?.limit) || 20;
  const offset = Number(args?.offset) || 0;
  const all = Object.values(db.memories || {}).sort((a, b) => (b.created || 0) - (a.created || 0));
  const filtered = kind ? all.filter(m => m.kind === kind) : all;
  return { ok: true, total: all.length, results: filtered.slice(offset, offset + limit) };
}

function toolPermMemoryRemove(args) {
  const db = loadDb();
  const id = args?.id;
  if (!id || !db.memories[id]) return { ok: false, error: 'Memory not found' };
  delete db.memories[id];
  saveDb(db);
  return { ok: true, removed: id };
}

// ── cron_add / cron_list / cron_remove ─────────────────────────────────────────
function toolCronAdd(args) {
  const db = loadDb();
  const msg = String(args?.message || '');
  if (!msg) return { ok: false, error: 'message is required' };

  const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const at = args?.at;
  const cronExpr = args?.cron_expr;
  const everySeconds = Number(args?.every_seconds) || Number(args?.every) || null;
  const unit = args?.unit || 'seconds';

  const entry = {
    id,
    message: msg,
    at: at || null,
    cronExpr: cronExpr || null,
    everySeconds: everySeconds || null,
    unit,
    created: Date.now(),
    active: true,
  };
  db.cron.push(entry);
  saveDb(db);
  return { ok: true, id, schedule: entry };
}

function toolCronList() {
  const db = loadDb();
  return { ok: true, jobs: db.cron || [] };
}

function toolCronRemove(args) {
  const db = loadDb();
  const id = args?.id;
  const idx = (db.cron || []).findIndex(c => c.id === id);
  if (idx === -1) return { ok: false, error: 'Job not found' };
  db.cron.splice(idx, 1);
  saveDb(db);
  return { ok: true, removed: id };
}

// ── proactive_add / proactive_list / proactive_remove ──────────────────────────
function toolProactiveAdd(args) {
  const db = loadDb();
  const schedule = args?.schedule || {};
  const payload = args?.payload || {};
  if (!payload.kind) return { ok: false, error: 'payload.kind is required (static or prompt)' };
  if (!schedule.type) return { ok: false, error: 'schedule.type is required' };
  const firstRunAt = nextRunAt(schedule);
  if (!firstRunAt) return { ok: false, error: 'Invalid schedule. Use once with a future ISO at, interval with at least 30 seconds, or daily with HH:MM.' };

  const id = `prog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    chatId: args?.chat_id || null,
    chatType: args?.chat_type || 'direct',
    schedule,
    payload,
    guardrails: args?.guardrails || null,
    created: Date.now(),
    nextRunAt: firstRunAt,
    active: true,
  };
  db.proactive[id] = entry;
  saveDb(db);
  return { ok: true, id, schedule };
}

function nextRunAt(schedule, now = Date.now()) {
  const type = String(schedule?.type || '').toLowerCase();
  if (type === 'once') {
    const at = new Date(schedule.at || schedule.due_at || 0).getTime();
    return Number.isFinite(at) && at > now ? at : null;
  }
  if (type === 'interval') {
    const every = Number(schedule.every_seconds || schedule.seconds || schedule.every || 0);
    const unit = String(schedule.unit || 'seconds').toLowerCase();
    const multiplier = unit.startsWith('day') ? 86400 : unit.startsWith('hour') ? 3600 : unit.startsWith('min') ? 60 : 1;
    const seconds = every * multiplier;
    return seconds >= 30 ? now + seconds * 1000 : null;
  }
  if (type === 'daily') {
    const match = String(schedule.at || schedule.time || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const due = new Date(now);
    due.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (due.getTime() <= now) due.setDate(due.getDate() + 1);
    return due.getTime();
  }
  return null;
}

/** Deliver due proactive messages. Prompt payloads are intentionally not executed
 * here: background model execution would be costly and unsafe without a fresh user
 * request. Static status/reminder messages are reliable and survive restarts. */
function takeDueProactive(now = Date.now()) {
  const db = loadDb();
  const due = [];
  for (const entry of Object.values(db.proactive || {})) {
    if (!entry.active || !entry.nextRunAt || entry.nextRunAt > now) continue;
    if (entry.payload?.kind !== 'static' || !entry.chatId) continue;
    due.push(entry);
    const type = String(entry.schedule?.type || '').toLowerCase();
    if (type === 'once') entry.active = false;
    else entry.nextRunAt = nextRunAt(entry.schedule, now);
  }
  if (due.length) saveDb(db);
  return due;
}

let proactiveTimer = null;
let proactiveSock = null;
function startProactiveScheduler(sock) {
  proactiveSock = sock;
  if (proactiveTimer) return;
  proactiveTimer = setInterval(async () => {
    for (const entry of takeDueProactive()) {
      try {
        await proactiveSock?.sendMessage(entry.chatId, { text: String(entry.payload.message || entry.payload.text || '').slice(0, 3500) });
      } catch {}
    }
  }, 15000);
}

function toolProactiveList() {
  const db = loadDb();
  return { ok: true, jobs: Object.values(db.proactive || {}) };
}

function toolProactiveRemove(args) {
  const db = loadDb();
  const id = args?.id;
  if (!id || !db.proactive[id]) return { ok: false, error: 'Job not found' };
  delete db.proactive[id];
  saveDb(db);
  return { ok: true, removed: id };
}

// ── send_file / send_image / delete_message / send_location ───────────────────
function toolSendFile(args) {
  const ctx = args?.ctx;
  if (!ctx?.sendText && !ctx?.sock) return { ok: false, error: 'No sender available in context' };
  const filePath = args?.path || args?.file_path;
  if (!filePath) return { ok: false, error: 'path is required' };
  if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
  // For now just report success; actual send goes through context
  const stat = fs.statSync(filePath);
  return {
    ok: true,
    filename: path.basename(filePath),
    size: stat.size,
    note: 'File ready — use sock.sendMessage with document parameter to deliver',
  };
}

function toolSendImage(args) {
  const ctx = args?.ctx;
  const imagePath = args?.path || args?.image_path;
  if (!imagePath) return { ok: false, error: 'path is required' };
  if (!fs.existsSync(imagePath)) return { ok: false, error: `Image not found: ${imagePath}` };
  const stat = fs.statSync(imagePath);
  return { ok: true, path: imagePath, size: stat.size };
}

function toolDeleteMessage(args) {
  const sock = args?.ctx?.sock;
  const jid = args?.jid || args?.ctx?.chatId;
  const messageId = args?.message_id || args?.messageId;
  // Support quoted message deletion (when user replies to a message and says "delete this")
  const quotedId = args?.quoted_message_id || args?.quotedMessageId || args?.reply_to_id;
  const targetId = messageId || quotedId;
  if (!sock || !targetId) return { ok: false, error: 'message_id or quoted_message_id is required' };
  try {
    const sendTarget = jid || sock.user?.id || '';
    sock.sendMessage(sendTarget, { delete: { id: targetId } });
    return { ok: true, deleted: targetId, jid: sendTarget };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function toolSendLocation(args) {
  const sock = args?.ctx?.sock;
  const latitude = Number(args?.latitude);
  const longitude = Number(args?.longitude);
  const name = args?.name || args?.address;
  if (!sock || isNaN(latitude) || isNaN(longitude)) {
    return { ok: false, error: 'latitude and longitude are required' };
  }
  try {
    sock.sendMessage(sock.user?.id || '', { location: { degreesLatitude: latitude, degreesLongitude: longitude, name: name || 'Location', address: args?.address } });
    return { ok: true, lat: latitude, lng: longitude, name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Group tools ────────────────────────────────────────────────────────────────
function toolGroupMembersList(args) {
  const sock = args?.ctx?.sock;
  const jid = args?.jid || args?.group_jid;
  if (!sock || !jid) return { ok: false, error: 'sock and group_jid are required' };
  try {
    const meta = sock.groupMetadata(jid);
    const members = (meta.participants || []).map(p => ({
      id: p.id,
      admin: p.admin || null,
    }));
    return { ok: true, count: members.length, members: members.slice(0, Number(args?.limit) || 50) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Image/Video generators (stub — real impl would call external API) ─────────
function toolImageGenerator(args) {
  const prompt = args?.prompt;
  if (!prompt) return { ok: false, error: 'prompt is required' };
  const mode = args?.mode || 'generate';
  const size = args?.size || '1K';
  const ratio = args?.ratio || '1:1';
  return {
    ok: true,
    mode,
    prompt: prompt.slice(0, 200),
    size,
    ratio,
    note: 'Image generation delegated to image endpoint — returns job ID for async polling',
  };
}

function toolRunCommand(args) {
  const cmd = args?.command;
  if (!cmd) return { ok: false, error: 'command is required' };
  // This would spawn a background command via the agent runtime
  return { ok: true, command: cmd.slice(0, 200), note: 'Command queued for execution' };
}

// ── Export ─────────────────────────────────────────────────────────────────────
module.exports = {
  // Memory
  permMemoryAdd: toolPermMemoryAdd,
  permMemorySearch: toolPermMemorySearch,
  permMemoryList: toolPermMemoryList,
  permMemoryRemove: toolPermMemoryRemove,
  // Cron
  cronAdd: toolCronAdd,
  cronList: toolCronList,
  cronRemove: toolCronRemove,
  // Proactive
  proactiveAdd: toolProactiveAdd,
  proactiveList: toolProactiveList,
  proactiveRemove: toolProactiveRemove,
  startProactiveScheduler,
  // Senders
  sendFile: toolSendFile,
  sendImage: toolSendImage,
  deleteMessage: toolDeleteMessage,
  sendLocation: toolSendLocation,
  // Group
  groupMembersList: toolGroupMembersList,
  // Generators
  imageGenerator: toolImageGenerator,
  runCommand: toolRunCommand,
};

});

runtime.define("gptAndroid", "gptAndroid.js", function(module, exports, require, __filename, __dirname) {
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

});

runtime.define("repoAgent", "repoAgent.js", function(module, exports, require, __filename, __dirname) {
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const logger = require('../logger');
const userWorkspace = require('./userWorkspace');
const github = require('./github');

function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = s.match(/github\.com[:/]+([^/]+)\/([^/#?\s]+)/i);
  if (m) {
    return {
      owner: m[1],
      repo: m[2].replace(/\.git$/i, ''),
      url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}.git`,
    };
  }
  m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (m) {
    return {
      owner: m[1],
      repo: m[2].replace(/\.git$/i, ''),
      url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}.git`,
    };
  }
  if (/^https?:\/\//i.test(s)) {
    return { owner: '', repo: path.basename(s, '.git'), url: s };
  }
  if (/^[A-Za-z0-9._-]+$/.test(s)) {
    return { owner: '', repo: s, url: null, shortName: s };
  }
  return null;
}

async function git(args, cwd, timeoutMs = 120000) {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
}

function authUrl(repoUrl, token) {
  if (!token || !repoUrl) return repoUrl;
  try {
    const u = new URL(repoUrl);
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/** Search the authenticated user's repos (and orgs visible to the token). */
async function searchUserRepos(token, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!token) return { ok: false, error: 'GitHub token required. DM: github connect + your PAT.' };
  if (!q) return { ok: false, error: 'Search query required.' };

  const matches = [];
  const seen = new Set();
  try {
    for (let page = 1; page <= 5; page++) {
      const list = await github.listMyRepos({ token, perPage: 100, page, sort: 'updated' });
      if (!list?.length) break;
      for (const r of list) {
        const full = String(r.fullName || '');
        const name = full.split('/')[1] || '';
        const hay = `${full} ${r.description || ''}`.toLowerCase();
        if (!hay.includes(q) && name.toLowerCase() !== q) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        matches.push({
          fullName: full,
          url: r.url,
          description: r.description || '',
          private: !!r.private,
          defaultBranch: r.defaultBranch || 'main',
          language: r.language || '',
          updatedAt: r.updatedAt || '',
        });
      }
      if (list.length < 100) break;
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // Prefer exact name matches first
  matches.sort((a, b) => {
    const an = (a.fullName.split('/')[1] || '').toLowerCase();
    const bn = (b.fullName.split('/')[1] || '').toLowerCase();
    const ae = an === q ? 0 : an.startsWith(q) ? 1 : 2;
    const be = bn === q ? 0 : bn.startsWith(q) ? 1 : 2;
    if (ae !== be) return ae - be;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });

  return { ok: true, query: q, count: matches.length, repos: matches.slice(0, 15) };
}

function savePending(userJid, pending) {
  userWorkspace.setMemory(userJid, {
    pendingRepos: pending.repos || [],
    pendingQuery: pending.query || '',
    pendingTask: pending.task || '',
    pendingAt: Date.now(),
  });
}

function getPending(userJid) {
  const mem = userWorkspace.getMemory(userJid);
  if (!mem.pendingRepos?.length) return null;
  if (mem.pendingAt && Date.now() - mem.pendingAt > 30 * 60 * 1000) return null;
  return mem;
}

function clearPending(userJid) {
  userWorkspace.setMemory(userJid, {
    pendingRepos: [],
    pendingQuery: '',
    pendingTask: '',
    pendingAt: 0,
  });
}

/**
 * Search and return a numbered list for the user to pick from.
 */
async function searchAndList(opts = {}) {
  const token = opts.token;
  const userJid = opts.userJid;
  const query = opts.query || opts.repo || '';
  const task = opts.task || opts.error || '';
  const result = await searchUserRepos(token, query);
  if (!result.ok) return result;
  if (!result.repos.length) {
    return { ok: false, error: `No repos matching "${query}" on your GitHub account.` };
  }

  // Single exact match → auto-select path (caller may still confirm)
  const exact = result.repos.filter(
    (r) => (r.fullName.split('/')[1] || '').toLowerCase() === String(query).toLowerCase()
  );
  if (exact.length === 1 && result.repos.length === 1) {
    return {
      ok: true,
      unique: true,
      repo: exact[0],
      task,
      message: `Found exact match: ${exact[0].fullName}. Say "1" or "use it" to clone & fix, or call repo_work with that full name.`,
    };
  }

  savePending(userJid, { repos: result.repos, query, task });
  const lines = result.repos.map((r, i) => {
    const priv = r.private ? '🔒' : '🌐';
    const desc = r.description ? ` — ${r.description.slice(0, 60)}` : '';
    return `${i + 1}. ${priv} *${r.fullName}*${desc}`;
  });
  return {
    ok: true,
    needsChoice: true,
    count: result.repos.length,
    task: task || null,
    repos: result.repos,
    message:
      `Found ${result.repos.length} repo(s) related to *${query}*:\n\n` +
      lines.join('\n') +
      `\n\nReply with the number (e.g. *2*) or the full name. ` +
      (task ? `I'll then clone, fix (“${task.slice(0, 80)}”), verify, and push.` : 'Tell me what to fix after you pick.'),
  };
}

async function resolveRepoName(input, token, userJid) {
  const raw = String(input || '').trim();

  // Numeric choice from pending list
  if (/^\d{1,2}$/.test(raw)) {
    const pending = getPending(userJid);
    const idx = parseInt(raw, 10) - 1;
    if (pending?.pendingRepos?.[idx]) {
      const r = pending.pendingRepos[idx];
      const p = parseRepo(r.fullName);
      return {
        ok: true,
        ...p,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch || 'main',
        task: pending.pendingTask || '',
        from: 'choice',
      };
    }
  }

  let parsed = parseRepo(raw);
  if (!parsed) return { ok: false, error: 'Could not parse repo. Use a number from the list, owner/repo, or a name.' };

  if (parsed.owner && parsed.repo && parsed.url) {
    return { ok: true, ...parsed, fullName: `${parsed.owner}/${parsed.repo}` };
  }

  // Try pending name match
  const pending = getPending(userJid);
  if (pending?.pendingRepos?.length) {
    const short = (parsed.shortName || parsed.repo || '').toLowerCase();
    const hit = pending.pendingRepos.find(
      (r) =>
        (r.fullName || '').toLowerCase() === short ||
        (r.fullName.split('/')[1] || '').toLowerCase() === short
    );
    if (hit) {
      const p = parseRepo(hit.fullName);
      return {
        ok: true,
        ...p,
        fullName: hit.fullName,
        defaultBranch: hit.defaultBranch || 'main',
        task: pending.pendingTask || '',
        from: 'pending-name',
      };
    }
  }

  const search = await searchUserRepos(token, parsed.shortName || parsed.repo);
  if (!search.ok) return search;
  if (!search.repos.length) {
    return { ok: false, error: `No repo matching "${parsed.shortName || parsed.repo}".` };
  }
  if (search.repos.length === 1) {
    const r = search.repos[0];
    const p = parseRepo(r.fullName);
    return { ok: true, ...p, fullName: r.fullName, defaultBranch: r.defaultBranch || 'main', from: 'unique' };
  }
  // Ambiguous → list for choice
  savePending(userJid, { repos: search.repos, query: parsed.shortName || parsed.repo, task: '' });
  return {
    ok: true,
    needsChoice: true,
    repos: search.repos,
    message: search.repos.map((r, i) => `${i + 1}. ${r.fullName}`).join('\n'),
  };
}

function listProjectFiles(root, maxFiles = 120) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (out.length >= maxFiles) break;
      if (['.git', 'node_modules', '.next', 'dist', 'build', '__MACOSX', '.cache'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out;
}

async function verifyRepo(root) {
  const notes = [];
  const pkg = path.join(root, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      JSON.parse(fs.readFileSync(pkg, 'utf8'));
      notes.push('package.json: ok');
    } catch (e) {
      notes.push(`package.json: FAIL ${e.message}`);
    }
  }
  // syntax-check a few JS entry files
  const { execFileSync } = require('child_process');
  const candidates = listProjectFiles(root, 40).filter((f) => /\.(js|cjs|mjs)$/i.test(f)).slice(0, 8);
  for (const rel of candidates) {
    try {
      execFileSync(process.execPath, ['--check', path.join(root, rel)], {
        timeout: 8000,
        stdio: 'pipe',
      });
      notes.push(`${rel}: syntax ok`);
    } catch (e) {
      const msg = (e.stderr && e.stderr.toString()) || e.message;
      notes.push(`${rel}: FAIL ${String(msg).slice(0, 100)}`);
    }
  }
  const failed = notes.filter((n) => /FAIL/.test(n));
  return { ok: failed.length === 0, notes, failed };
}

async function pushWorkspaceViaApi(root, repoUrl, token, branch, message) {
  const files = [];
  for (const rel of listProjectFiles(root, 250)) {
    if (['.git'].some(x => rel === x || rel.startsWith(x + '/'))) continue;
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 900000) continue;
      if (!/\.(js|jsx|ts|tsx|mjs|cjs|json|html?|css|scss|less|md|txt|yml|yaml|xml|svg|sh|bash|py|rb|go|rs|java|c|cpp|h|hpp|sql|env|gitignore|toml|ini)$/i.test(rel)
          && !/^(Dockerfile|Makefile|Procfile)$/i.test(path.basename(rel))) continue;
      files.push({ name: rel, code: fs.readFileSync(abs, 'utf8') });
    } catch {}
  }
  if (!files.length) return { ok: false, error: 'No text files available for GitHub API push.' };
  return github.pushFiles({
    repoUrl,
    token,
    files,
    branch,
    commitMessage: message || 'fix: update project via repo agent',
  });
}

/**
 * Full pipeline: resolve → clone/download → fix → verify → push.
 * The GitHub API path is the fallback when local git/sandbox execution is unavailable.
 */
async function workOnRepo(opts = {}) {
  const userJid = opts.userJid || opts.senderJid;
  if (!userJid) return { ok: false, error: 'Missing user identity for sandbox.' };
  const token = opts.token || opts.accessToken || '';
  let task = String(opts.task || opts.errorDescription || opts.error || '').trim();
  const wantPush = opts.push !== false && !!token;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : async () => {};
  const input = opts.repoUrlOrName || opts.repo || opts.repoUrl || '';

  // Phase A: search-only when explicitly requested or ambiguous without choice
  if (opts.searchOnly || opts.action === 'search') {
    return searchAndList({ token, userJid, query: input, task });
  }

  if (!token) {
    return {
      ok: false,
      error: 'No GitHub token. DM me: github connect + your PAT (repo scope), then name the repo again.',
    };
  }

  const resolved = await resolveRepoName(input, token, userJid);
  if (!resolved.ok) return resolved;
  if (resolved.needsChoice) {
    savePending(userJid, {
      repos: resolved.repos,
      query: input,
      task,
    });
    const lines = resolved.repos.map((r, i) => `${i + 1}. ${r.private ? '🔒' : '🌐'} *${r.fullName}*`);
    return {
      ok: true,
      needsChoice: true,
      repos: resolved.repos,
      message:
        `Several repos match. Pick one:\n\n${lines.join('\n')}\n\nReply with the number or full name` +
        (task ? `, then I'll fix: ${task.slice(0, 100)}` : '.'),
    };
  }

  if (resolved.task && !task) task = resolved.task;

  const branch = opts.branch || resolved.defaultBranch || 'main';
  const root = userWorkspace.reposDir(userJid);
  const dest = path.join(root, `${resolved.owner}__${resolved.repo}`);
  const cloneUrl = authUrl(resolved.url, token);

  try {
    await onProgress(`Opening ${resolved.fullName}…`);
    let apiWorkspace = false;
    if (!fs.existsSync(path.join(dest, '.git'))) {
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      try {
        await git(['clone', '--depth', '50', cloneUrl, dest], root, 180000);
      } catch (cloneError) {
        // Do not let a restricted shell/sandbox kill GitHub work. Download the repo
        // directly through the GitHub API instead; edits and push can also stay API-only.
        logger.warn({ err: cloneError.message }, 'git clone unavailable — switching to GitHub API workspace');
        await onProgress('Local git is restricted here — switching to GitHub API access.');
        const downloaded = await github.downloadRepo({
          repoUrl: resolved.fullName,
          token,
          branch,
          destDir: dest,
        });
        if (!downloaded?.root) throw cloneError;
        apiWorkspace = true;
      }
    } else {
      try {
        await git(['remote', 'set-url', 'origin', cloneUrl], dest);
        await git(['fetch', 'origin'], dest, 120000);
        try {
          await git(['checkout', branch], dest);
        } catch {
          try { await git(['checkout', '-b', branch, `origin/${branch}`], dest); } catch {}
        }
        try { await git(['pull', '--ff-only', 'origin', branch], dest, 120000); } catch {}
      } catch (e) {
        logger.warn({ err: e.message }, 'git update failed — refreshing through GitHub API');
        try {
          await github.downloadRepo({ repoUrl: resolved.fullName, token, branch, destDir: dest });
          apiWorkspace = true;
        } catch (apiError) {
          logger.warn({ err: apiError.message }, 'GitHub API refresh failed — keeping local copy');
        }
      }
    }

    clearPending(userJid);
    userWorkspace.rememberRepo(userJid, {
      path: dest,
      name: resolved.fullName,
      url: resolved.url,
    });

    const tree = listProjectFiles(dest, 150);

    let fixResult = null;
    if (task && opts.aiClient) {
      await onProgress('Reading project & applying fixes…');
      try {
        const fixer = require('./fixer');
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        const walk = (dir, prefix = '') => {
          for (const name of fs.readdirSync(dir)) {
            if (['.git', 'node_modules', '.next', 'dist', 'build', '.cache'].includes(name)) continue;
            const full = path.join(dir, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            const st = fs.statSync(full);
            if (st.isDirectory()) walk(full, rel);
            else if (st.size < 500000) zip.addFile(rel.replace(/\\/g, '/'), fs.readFileSync(full));
          }
        };
        walk(dest);
        fixResult = await fixer.fixZip(zip.toBuffer(), task, opts.aiClient);
        if (fixResult.ok && !fixResult.noChanges && fixResult.zipPath && fs.existsSync(fixResult.zipPath)) {
          new AdmZip(fixResult.zipPath).extractAllTo(dest, true);
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'AI fix failed');
        fixResult = { ok: false, error: e.message };
      }
    }

    await onProgress('Verifying…');
    const verify = await verifyRepo(dest);

    let pushResult = null;
    if (wantPush && task && fixResult?.ok && !fixResult?.noChanges) {
      await onProgress('Pushing to GitHub…');
      try {
        if (apiWorkspace) {
          const pushed = await pushWorkspaceViaApi(
            dest,
            resolved.fullName,
            token,
            branch,
            `fix: ${task.slice(0, 72)}`,
          );
          pushResult = pushed?.commitSha
            ? { ok: true, pushed: true, method: 'github-api', commitSha: pushed.commitSha, commitUrl: pushed.commitUrl }
            : pushed;
        } else {
          await git(['config', 'user.email', 'agent@localhost'], dest);
          await git(['config', 'user.name', 'wa-agent'], dest);
          await git(['add', '-A'], dest);
          const status = await git(['status', '--porcelain'], dest);
          if (status.stdout) {
            await git(['commit', '-m', `fix: ${task.slice(0, 72)}`], dest, 60000);
            await git(['push', 'origin', 'HEAD'], dest, 180000);
            pushResult = { ok: true, pushed: true, method: 'git' };
          } else {
            pushResult = { ok: true, pushed: false, note: 'working tree clean' };
          }
        }
      } catch (e) {
        // One alternate push path before declaring failure.
        try {
          const pushed = await pushWorkspaceViaApi(dest, resolved.fullName, token, branch, `fix: ${task.slice(0, 72)}`);
          pushResult = pushed?.commitSha
            ? { ok: true, pushed: true, method: 'github-api-fallback', commitSha: pushed.commitSha, commitUrl: pushed.commitUrl }
            : { ok: false, error: pushed?.error || e.message };
        } catch (apiError) {
          pushResult = { ok: false, error: `${e.message}; API fallback: ${apiError.message}` };
        }
      }
    }

    return {
      ok: true,
      path: dest,
      repo: resolved.fullName,
      branch,
      files: tree.slice(0, 40),
      fileCount: tree.length,
      task: task || null,
      fixed: !!(fixResult?.ok && !fixResult?.noChanges),
      changed: fixResult?.changed || [],
      changelog: fixResult?.changelog || [],
      verified: verify,
      push: pushResult,
      sandbox: dest,
      message:
        `✅ *${resolved.fullName}*\n` +
        `Files: ${tree.length}\n` +
        (fixResult?.ok && !fixResult?.noChanges
          ? `Fixed: ${(fixResult.changed || []).slice(0, 8).join(', ')}\n`
          : task
            ? `Fix: ${fixResult?.noChanges ? 'no changes needed' : fixResult?.error || 'done'}\n`
            : '') +
        `Verify: ${verify.ok ? 'passed' : 'issues — ' + (verify.failed || []).slice(0, 3).join('; ')}\n` +
        (pushResult?.pushed ? 'Pushed to GitHub.' : pushResult?.error ? `Push failed: ${pushResult.error}` : ''),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), sandbox: userWorkspace.workspaceRoot(userJid) };
  }
}

async function pushFolder(opts = {}) {
  const token = opts.token || '';
  if (!token) return { ok: false, error: 'GitHub token required.' };
  const folder = opts.folder;
  if (!folder || !fs.existsSync(folder)) return { ok: false, error: 'Folder not found.' };
  const resolved = await resolveRepoName(opts.repo || opts.repoUrl, token, opts.userJid);
  if (!resolved.ok || resolved.needsChoice) return resolved;
  try {
    await git(['remote', 'set-url', 'origin', authUrl(resolved.url, token)], folder);
    await git(['add', '-A'], folder);
    try {
      await git(['commit', '-m', opts.message || 'update from agent'], folder);
    } catch {}
    await git(['push', '-u', 'origin', opts.branch || 'HEAD'], folder, 180000);
    return { ok: true, method: 'git-push', repo: resolved.fullName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  workOnRepo,
  pushFolder,
  parseRepo,
  resolveRepoName,
  searchAndList,
  searchUserRepos,
  getPending,
  clearPending,
};

});

runtime.define("subagents", "subagents.js", function(module, exports, require, __filename, __dirname) {
// Parallel coding sub-agents — assign workers to Claude Opus (AgentRouter), Gemini, Groq, etc.
const logger = require('../logger');
const config = require('../config');

const NAMES = ['Nora', 'Theo', 'Milo', 'Ava', 'Kai', 'Rex', 'Lia', 'Zen'];

/** Preferred coding backends in rotation order */
function codingBackends() {
  // Sub-agents for coding only — never openai / anthropic / xai-grok.
  const order = (process.env.SUBAGENT_PROVIDERS || process.env.AI_CODING_CHAIN || 'apmix,agentrouter,nvidia,gemini,groq,agnes')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && !['openai', 'anthropic', 'grok', 'xai', 'gpt', 'stability'].includes(s));
  const out = [];
  for (const name of order) {
    const p = config.ai.providers[name];
    if (!p) continue;
    const hasKey = !!(p.apiKeys && p.apiKeys.length) || p.local;
    if (!hasKey) continue;
    out.push({ name, provider: p });
  }
  // Always allow Agnes as last resort if present
  if (!out.find((x) => x.name === 'agnes') && config.ai.providers.agnes) {
    out.push({ name: 'agnes', provider: config.ai.providers.agnes });
  }
  return out;
}

function plan(task, features = []) {
  const feats = (Array.isArray(features) ? features : [features])
    .map((f) => String(f || '').trim())
    .filter(Boolean);
  if (!feats.length) {
    // Split task text into chunks by "and" / commas / newlines
    const parts = String(task || '')
      .split(/\n+|;\s*|\band\b|,/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 8)
      .slice(0, 6);
    if (parts.length >= 2) {
      return parts.map((scope, i) => ({
        agent: NAMES[i % NAMES.length],
        scope: [scope],
      }));
    }
    return [{ agent: NAMES[0], scope: [String(task || 'general work').slice(0, 500)] }];
  }
  return feats.slice(0, 8).map((f, i) => ({
    agent: NAMES[i % NAMES.length],
    scope: [f],
  }));
}

/**
 * Run workers in parallel, each on a different provider when possible.
 * progress(msg) should already route to admin DM only.
 */
async function run(workers, { task, context, aiClient, progress }) {
  const backends = codingBackends();
  if (!backends.length) {
    return { ok: false, error: 'No coding providers configured (need AGENTROUTER / GEMINI / GROQ / AGNES keys).' };
  }

  await progress?.(
    `🧩 Spinning ${workers.length} sub-agent(s): ${workers.map((w) => w.agent).join(', ')}\n` +
      `Backends: ${backends.map((b) => b.name).join(' → ')}`
  );

  const jobs = workers.map(async (w, idx) => {
    const backend = backends[idx % backends.length];
    const prompt =
      `Overall task:\n${String(task || '').slice(0, 4000)}\n\n` +
      (context ? `Context:\n${String(context).slice(0, 3000)}\n\n` : '') +
      `Your ONLY scope:\n${w.scope.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
      `Deliver concrete implementation (full code for your files if coding). Be specific. Do not redo other agents' work.`;

    try {
      await progress?.(`⚡ *${w.agent}* → ${backend.name}…`);
      let text = '';
      if (aiClient && typeof aiClient.simpleCompleteOn === 'function') {
        text = await aiClient.simpleCompleteOn(backend.name, prompt, 'Focused coding sub-agent. Full concrete output only.', {
          coding: true,
        });
      } else if (aiClient && typeof aiClient.simpleComplete === 'function') {
        text = await aiClient.simpleComplete(
          prompt + `\n\n[Use best coding quality; assigned backend preference: ${backend.name}]`,
          'Focused coding sub-agent. Full concrete output only.',
          { coding: true }
        );
      } else {
        text = `(no AI) ${w.agent}: ${w.scope.join(', ')}`;
      }
      await progress?.(`✅ *${w.agent}* done (${backend.name})`);
      return {
        agent: w.agent,
        scope: w.scope,
        backend: backend.name,
        ok: true,
        result: String(text || '').slice(0, 20000),
      };
    } catch (e) {
      logger.warn({ err: e.message, agent: w.agent, backend: backend.name }, 'subagent failed');
      // Fallback once on Agnes
      try {
        if (aiClient && backend.name !== 'agnes') {
          const text = await aiClient.simpleComplete(
            prompt,
            'Focused coding sub-agent fallback.',
            { coding: true }
          );
          await progress?.(`✅ *${w.agent}* done (fallback)`);
          return { agent: w.agent, scope: w.scope, backend: 'fallback', ok: true, result: String(text || '').slice(0, 20000) };
        }
      } catch {}
      await progress?.(`❌ *${w.agent}* failed: ${e.message}`);
      return { agent: w.agent, scope: w.scope, backend: backend.name, ok: false, error: e.message };
    }
  });

  const results = await Promise.all(jobs);
  await progress?.('🔀 Merging worker outputs…');

  const merged = results
    .map((r) => {
      if (!r.ok) return `### ${r.agent} (failed on ${r.backend})\n${r.error}`;
      return `### ${r.agent} [${r.backend}]\nScope: ${r.scope.join(' | ')}\n\n${r.result}`;
    })
    .join('\n\n---\n\n');

  return {
    ok: true,
    workers: results,
    merged,
    summary:
      `All ${results.length} workers finished.\n` +
      results.map((r) => `• ${r.agent} (${r.backend}): ${r.ok ? 'ok' : 'fail'}`).join('\n'),
  };
}

module.exports = { plan, run, NAMES, codingBackends };

});

runtime.define("training", "training.js", function(module, exports, require, __filename, __dirname) {
// Learns per-user style, common requests, preferred language, and short facts
// from real chat turns. Injected into the system prompt as a compact summary.
// No external ML — durable JSON via Collection.
const { Collection } = require('../db');
const logger = require('../logger');

const store = new Collection('user_training', {});
const MAX_FACTS = 40;
const MAX_PHRASES = 30;
const MAX_STYLE_SAMPLES = 12;

function blank(userId) {
  return {
    userId: String(userId || ''),
    style: {
      avgLen: 0,
      samples: 0,
      emojiHeavy: 0,
      shortReplies: 0,
      casual: 0,
    },
    language: null, // e.g. 'en', 'pidgin', 'mixed'
    facts: [], // { text, at, hits }
    phrases: [], // frequent user phrases { text, hits }
    likes: [], // things they ask for often
    lastTrained: 0,
  };
}

function get(userId) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  if (!id) return blank('');
  return { ...blank(id), ...(store.get(id, {}) || {}) };
}

function save(userId, data) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  if (!id) return;
  data.userId = id;
  data.lastTrained = Date.now();
  store.set(id, data);
}

function detectLanguage(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  // Very light heuristics for this bot's audience
  if (/\b(abeg|wetin|dey|sha|naija|jare|no wahala|how far|gimme|lmfao|fr\b|ngl)\b/i.test(t)) return 'pidgin-casual';
  if (/[\u00C0-\u024F]/.test(t) && /\b(je|tu|oui|non|merci)\b/i.test(t)) return 'fr';
  return 'en';
}

function isCasual(text) {
  return /\b(lol|lmao|fr|ngl|bro|sis|fam|abeg|sha|wetin|sup|wsg|gtg|idk|ikr)\b/i.test(text)
    || (text.length < 40 && /[!?]{2,}|\p{Emoji}/u.test(text));
}

function extractFactCandidates(text) {
  const t = String(text || '').trim();
  const out = [];
  // "my name is X", "call me X", "I prefer X", "I'm from X"
  const patterns = [
    /\b(?:my name is|i am|i'm|call me|i go by)\s+([A-Za-z][A-Za-z0-9_\- ]{1,30})/i,
    /\b(?:i (?:live|stay) in|i'm from|im from)\s+([A-Za-z0-9 ,\-]{2,40})/i,
    /\b(?:i prefer|prefer|always use|use)\s+([A-Za-z0-9 #+\-]{2,40})/i,
    /\b(?:don't|dont|never)\s+(?:call me|say|do)\s+([A-Za-z0-9 ]{2,40})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) out.push(m[0].slice(0, 80));
  }
  return out;
}

function extractLike(text) {
  const t = String(text || '').toLowerCase();
  const likes = [];
  if (/\b(image|logo|edit|picture|photo|pp)\b/.test(t)) likes.push('images');
  if (/\b(music|song|play|lyrics)\b/.test(t)) likes.push('music');
  if (/\b(code|build|website|zip|fix)\b/.test(t)) likes.push('coding');
  if (/\b(group|kick|promote|admin|antilink|mute)\b/.test(t)) likes.push('group-admin');
  if (/\b(dm|message|text)\b/.test(t)) likes.push('dms');
  return likes;
}

function bumpList(list, text, max) {
  const key = String(text || '').trim().slice(0, 80);
  if (!key) return list;
  const existing = list.find((x) => x.text.toLowerCase() === key.toLowerCase());
  if (existing) {
    existing.hits = (existing.hits || 1) + 1;
    existing.at = Date.now();
  } else {
    list.push({ text: key, hits: 1, at: Date.now() });
  }
  list.sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.at || 0) - (a.at || 0));
  return list.slice(0, max);
}

/**
 * Observe a user message and update durable training profile.
 * @param {string} userId - phone or stable id
 * @param {string} message - user text
 * @param {object} [meta]
 */
function observe(userId, message, meta = {}) {
  try {
    if (!userId || !message) return get(userId);
    const data = get(userId);
    const text = String(message).slice(0, 500);
    const len = text.length;

    // Style running averages
    const s = data.style || blank(userId).style;
    s.samples = (s.samples || 0) + 1;
    s.avgLen = ((s.avgLen || 0) * (s.samples - 1) + len) / s.samples;
    if (/\p{Emoji}/u.test(text)) s.emojiHeavy = (s.emojiHeavy || 0) + 1;
    if (len < 25) s.shortReplies = (s.shortReplies || 0) + 1;
    if (isCasual(text)) s.casual = (s.casual || 0) + 1;
    data.style = s;

    const lang = detectLanguage(text);
    if (lang) data.language = lang;

    for (const fact of extractFactCandidates(text)) {
      data.facts = bumpList(data.facts || [], fact, MAX_FACTS);
    }
    // Keep a few short phrase fingerprints
    if (len > 2 && len < 60) {
      data.phrases = bumpList(data.phrases || [], text, MAX_PHRASES);
    }
    for (const like of extractLike(text)) {
      data.likes = bumpList(data.likes || [], like, 20);
    }

    save(userId, data);
    return data;
  } catch (e) {
    logger.warn({ err: e.message }, 'training.observe failed');
    return get(userId);
  }
}

/**
 * Observe bot reply quality signal: if user says "good"/"wrong"/"wack" etc.
 */
function observeFeedback(userId, message) {
  const t = String(message || '').toLowerCase();
  const data = get(userId);
  if (/\b(good|perfect|nice|thanks|thank you|correct|exactly|love it)\b/.test(t)) {
    data.facts = bumpList(data.facts || [], 'Likes concise direct answers for simple factual questions — still match their mood when they are vibing', MAX_FACTS);
  }
  if (/\b(wack|wrong|bad|no|not that|try again|fix it|useless)\b/.test(t)) {
    data.facts = bumpList(data.facts || [], 'Dislikes vague answers — be precise and use tools when relevant', MAX_FACTS);
  }
  save(userId, data);
  return data;
}

/**
 * Compact prompt block for the system message.
 */
function promptBlock(userId) {
  const data = get(userId);
  if (!data || !(data.style?.samples > 2)) return '';

  const lines = ['Learned about this user (style hints only — adapt to the current conversation, never treat these as limits on tone, affection, roleplay, or reply length):'];
  const s = data.style;
  const n = s.samples || 1;
  if (s.avgLen && s.avgLen < 40) lines.push('- Often sends short messages; match their energy, but do not force every reply to be short.');
  if (s.avgLen && s.avgLen > 120) lines.push('- Often writes longer messages; still answer as briefly as possible unless detail is explicitly requested.');
  if ((s.casual || 0) / n > 0.35) lines.push('- Casual tone; match slang lightly, stay useful.');
  if ((s.emojiHeavy || 0) / n > 0.25) lines.push('- Comfortable with emojis; match the mood instead of rationing them.');
  if (data.language === 'pidgin-casual') lines.push('- Often uses Nigerian Pidgin / casual EN — understand it; reply clearly.');
  if (data.language && data.language !== 'en' && data.language !== 'pidgin-casual') {
    lines.push(`- Language lean: ${data.language}.`);
  }
  const topLikes = (data.likes || []).slice(0, 4).map((x) => x.text);
  if (topLikes.length) lines.push(`- Often asks about: ${topLikes.join(', ')}.`);
  const soften = (text) => String(text)
    .replace(/^User often approves short direct answers$/i, 'Likes concise direct answers for simple factual questions — still match the mood when vibing')
    .replace(/^User rejects vague answers — be precise and use tools$/i, 'Dislikes vague answers — be precise and use tools when relevant');
  const topFacts = (data.facts || []).slice(0, 6).map((x) => soften(x.text));
  for (const f of topFacts) lines.push(`- ${f}`);

  if (lines.length <= 1) return '';
  return '\n\n' + lines.join('\n');
}

function clear(userId) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  if (!id) return false;
  if (!store.has(id)) return false;
  store.delete(id);
  return true;
}

function clearAll() {
  const count = Object.keys(store.all()).length;
  for (const key of Object.keys(store.all())) store.delete(key);
  return count;
}

module.exports = {
  observe,
  observeFeedback,
  promptBlock,
  get,
  save,
  clear,
  clearAll,
};

});
};
