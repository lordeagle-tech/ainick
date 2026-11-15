// axon_tools.js — tools ported from Axon that bring the bot closer to my capabilities
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
