'use strict';

module.exports = (runtime) => {
runtime.define("afk", "afk.js", function(module, exports, require, __filename, __dirname) {
// Router calls into this on EVERY incoming message (not just ones addressed to the bot):
//   - if the sender was AFK and this isn't itself an AFK-setting message, clear it
//   - if the message sets a new AFK status (matches AFK_SET_RE), store it
//   - if the message @mentions or replies to someone who is AFK, that's handled by the caller
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const store = new Collection('afk_status', {});

// Matches messages like "brb studying", "afk: lunch", "away - back in 10", "gtg for a bit".
// The captured group (if any) becomes the reason; otherwise it defaults to "AFK".
const AFK_SET_RE = /^(brb|afk|away|gtg|be right back)\b[\s,:.\-]*(.*)$/i;

function setAfk(userJid, reason) {
  const key = numFromJid(userJid);
  const entry = { reason: (reason || '').trim() || 'AFK', since: Date.now() };
  store.set(key, entry);
  return entry;
}

function clearAfk(userJid) {
  const key = numFromJid(userJid);
  const prev = store.get(key, null);
  if (prev) store.delete(key);
  return prev;
}

function getAfk(userJid) {
  return store.get(numFromJid(userJid), null);
}

/** Returns the AFK-set match (reason string) if this text is an AFK-setting command, else null. */
function parseAfkCommand(text) {
  const m = String(text || '').trim().match(AFK_SET_RE);
  if (!m) return null;
  return (m[2] || '').trim() || 'AFK';
}

module.exports = { setAfk, clearAfk, getAfk, parseAfkCommand, AFK_SET_RE };

});

runtime.define("autoreply", "autoreply.js", function(module, exports, require, __filename, __dirname) {
const botMessageKeys = new Map();
const botJids = new Set();
const botNums = new Set();

function registerBotJids(jids = []) {
  for (const jid of Array.isArray(jids) ? jids : [jids]) {
    if (!jid) continue;
    const raw = String(jid);
    botJids.add(raw);
    const n = raw.split('@')[0].split(':')[0];
    if (n) botNums.add(n);
  }
}

function addBotMessage(msgKey) {
  if (!msgKey?.id) return;
  botMessageKeys.set(msgKey.id, { ...msgKey });
  registerBotJids([msgKey.participant, msgKey.senderLid, msgKey.senderPn]);
  if (botMessageKeys.size > 10000) {
    const arr = Array.from(botMessageKeys.keys());
    arr.slice(0, 5000).forEach(k => botMessageKeys.delete(k));
  }
}

function isBotMessage(msg) {
  const id = msg?.key?.id || msg?.id;
  if (!id) return false;
  return botMessageKeys.has(String(id));
}

function unwrap(message) {
  let cur = message;
  for (let i = 0; i < 8 && cur; i++) {
    const next = cur?.message ||
      cur?.ephemeralMessage?.message ||
      cur?.viewOnceMessageV2?.message ||
      cur?.viewOnceMessage?.message ||
      cur?.documentWithCaptionMessage?.message ||
      cur?.editedMessage?.message;
    if (next && next !== cur) { cur = next; continue; }
    break;
  }
  return cur || {};
}

function contextOf(m) {
  const direct = m?.extendedTextMessage?.contextInfo || m?.imageMessage?.contextInfo ||
    m?.videoMessage?.contextInfo || m?.audioMessage?.contextInfo ||
    m?.documentMessage?.contextInfo || m?.stickerMessage?.contextInfo;
  if (direct) return direct;
  const reaction = m?.reactionMessage;
  if (reaction?.key) return { stanzaId: reaction.key.id, participant: reaction.key.participant, quotedMessage: null };
  return null;
}

function sameBotIdentity(value) {
  if (!value) return false;
  const raw = String(value);
  if (botJids.has(raw)) return true;
  const n = raw.split('@')[0].split(':')[0];
  return !!n && botNums.has(n);
}

function collectAllIds(node, ids = new Set()) {
  if (!node || typeof node !== 'object') return ids;
  const id = node.stanzaId || node.quotedMessageId || node.id;
  if (id) ids.add(String(id));
  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') collectAllIds(val, ids);
  }
  return ids;
}

function isBotMessageReplied(msg) {
  const m = unwrap(msg?.message);
  const contextInfo = contextOf(m);
  if (!contextInfo) return false;

  // Collect ALL possible quoted IDs from every nesting level
  const allPossibleIds = collectAllIds(contextInfo);
  for (const id of allPossibleIds) {
    if (botMessageKeys.has(id)) return true;
  }

  // WhatsApp replies can now expose the quoted participant as @lid. Never reduce that
  // opaque number to a phone number; compare the raw identity first, then known aliases.
  const participantValues = [
    contextInfo.participant,
    contextInfo.participantPn,
    contextInfo.participantAlt,
    contextInfo.quotedMessage?.key?.participant,
    contextInfo.quotedMessage?.key?.participantPn,
    contextInfo.quotedMessage?.key?.participantAlt,
  ].filter(Boolean);
  if (participantValues.some(sameBotIdentity)) return true;

  // A quoted message marked fromMe is authoritative for a bot-owned message.
  if (contextInfo.quotedMessage?.key?.fromMe === true) return true;

  // Some edited/re-wrapped replies move the original key under a nested message.
  const nestedKey = contextInfo.quotedMessage?.key;
  if (nestedKey && sameBotIdentity(nestedKey.participant)) return true;

  return false;
}

function clearOldMessages() {
  if (botMessageKeys.size > 5000) {
    const arr = Array.from(botMessageKeys.keys());
    arr.slice(0, 2500).forEach(k => botMessageKeys.delete(k));
  }
}

setInterval(clearOldMessages, 3600000);

module.exports = { addBotMessage, registerBotJids, isBotMessage, isBotMessageReplied, clearOldMessages };

});

runtime.define("birthdays", "birthdays.js", function(module, exports, require, __filename, __dirname) {
// shoutout in the chat where it was set when the day comes around. Same scheduler pattern as
// reminders.js: a persisted store + a background interval that checks once a day.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');
const logger = require('../logger');

const store = new Collection('birthdays', {}); // userId -> { month, day, chatId, lastAnnouncedYear }

function setBirthday(userId, chatId, month, day) {
  userId = numFromJid(userId);
  month = Number(month);
  day = Number(day);
  if (!(month >= 1 && month <= 12)) return { ok: false, error: 'Month must be 1-12.' };
  const daysInMonth = new Date(2024, month, 0).getDate(); // 2024 = leap year, so Feb 29 is valid to set
  if (!(day >= 1 && day <= daysInMonth)) return { ok: false, error: `Day must be 1-${daysInMonth} for that month.` };
  const existing = store.get(userId, {});
  store.set(userId, { ...existing, month, day, chatId });
  return { ok: true, month, day };
}

function getBirthday(userId) {
  const rec = store.get(numFromJid(userId), null);
  if (!rec) return null;
  return { month: rec.month, day: rec.day };
}

function removeBirthday(userId) {
  userId = numFromJid(userId);
  if (!store.get(userId, null)) return { ok: false, error: 'No birthday set.' };
  store.delete(userId);
  return { ok: true };
}

function _all() {
  return store.all();
}

// A single long-lived interval, checked once a day — safe to call again after reconnect.
const CHECK_MS = 6 * 60 * 60 * 1000; // every 6h is plenty for a once-a-day event
let activeSock = null;
let timer = null;

function startScheduler(sock) {
  activeSock = sock;
  if (timer) return;
  timer = setInterval(async () => {
    if (!activeSock) return;
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const year = now.getFullYear();
    const all = _all();
    for (const [userId, rec] of Object.entries(all)) {
      if (rec.month !== month || rec.day !== day) continue;
      if (rec.lastAnnouncedYear === year) continue; // already wished them this year
      try {
        await activeSock.sendMessage(rec.chatId, {
          text: `🎂 Happy birthday, @${userId}! 🎉`,
          mentions: [`${userId}@s.whatsapp.net`],
        });
        store.set(userId, { ...rec, lastAnnouncedYear: year });
      } catch (e) {
        logger.warn({ err: e.message, userId }, 'birthdays: failed to send announcement');
      }
    }
  }, CHECK_MS);
}

module.exports = { setBirthday, getBirthday, removeBirthday, startScheduler };

});

runtime.define("channelTools", "channelTools.js", function(module, exports, require, __filename, __dirname) {
'use strict';

/**
 * Channel / reaction / poll-vote helpers used by AI tools.
 * Replaces the previous compatibility stub.
 */

const logger = require('../logger');
const axios = require('axios');

async function react(sock, jid, messageId, emoji) {
  if (!sock || !jid || !messageId) return { ok: false, error: 'sock, jid and messageId required' };
  const emojiStr = String(emoji || '👍').slice(0, 8);
  try {
    await sock.sendMessage(jid, {
      react: { text: emojiStr, key: { remoteJid: jid, id: messageId } },
    });
    return { ok: true, emoji: emojiStr };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function vote(sock, jid, pollMessageId, optionName) {
  if (!sock || !jid || !pollMessageId || !optionName) {
    return { ok: false, error: 'jid, poll_message_id and option_name required' };
  }
  try {
    if (typeof sock.relayMessage === 'function') {
      await sock.sendMessage(jid, {
        pollUpdateMessage: {
          pollCreationMessageKey: { remoteJid: jid, id: pollMessageId, fromMe: false },
          vote: { selectedOptions: [Buffer.from(String(optionName))] },
        },
      });
    } else {
      await sock.sendMessage(jid, { text: `🗳️ Voted for: ${optionName}` });
    }
    return { ok: true, option: optionName };
  } catch (e) {
    try { logger.warn({ err: e.message }, 'poll vote failed'); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

async function comment(sock, jid, postMessageId, text) {
  if (!sock || !jid || !text) return { ok: false, error: 'jid and text required' };
  try {
    const payload = { text: String(text).slice(0, 4000) };
    const opts = postMessageId
      ? { quoted: { key: { remoteJid: jid, id: postMessageId } } }
      : undefined;
    await sock.sendMessage(jid, payload, opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function postTechUpdate(sock, jid, title, body) {
  if (!sock || !jid) return { ok: false, error: 'sock and jid required' };
  const msg = `📡 *${String(title || 'Update').slice(0, 120)}*\n\n${String(body || '').slice(0, 3500)}`;
  try {
    await sock.sendMessage(jid, { text: msg });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getTechNews(count = 3) {
  try {
    const r = await axios.get('https://hn.algolia.com/api/v1/search?tags=front_page', { timeout: 12000 });
    const hits = (r.data?.hits || []).slice(0, Math.max(1, Number(count) || 3));
    return hits.map((h) => ({
      title: h.title || h.story_title || 'Untitled',
      source: 'Hacker News',
      url: h.url || h.story_url || '',
    }));
  } catch (e) {
    return [];
  }
}

async function scrapeUrl(url) {
  try {
    const r = await axios.get(String(url), {
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WaAgent/1.0)' },
      responseType: 'text',
      validateStatus: () => true,
    });
    const text = String(r.data || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    return { ok: true, status: r.status, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function webSearch(query, count = 5) {
  try {
    const websearch2 = require('./websearch2');
    if (websearch2 && typeof websearch2.browse === 'function') {
      return await websearch2.browse(query, count);
    }
  } catch (_) {}
  return [];
}

module.exports = {
  react, vote, comment, postTechUpdate, getTechNews, scrapeUrl, webSearch,
};

});

runtime.define("customCommands", "customCommands.js", function(module, exports, require, __filename, __dirname) {
// without touching code. Checked deterministically before the AI agent, same tier as the
// built-in games/obsidian commands, so it's instant and doesn't cost a model call.
const { Collection } = require('../db');

const store = new Collection('custom_commands', {}); // trigger (lowercase) -> response text

const MAX_COMMANDS = 200; // sanity cap so this can't grow unbounded

function add(trigger, response) {
  const key = String(trigger || '').trim().toLowerCase();
  if (!key) return { ok: false, error: 'Empty trigger.' };
  if (key.length > 100) return { ok: false, error: 'Trigger too long (max 100 chars).' };
  const text = String(response || '').trim();
  if (!text) return { ok: false, error: 'Empty response.' };
  if (text.length > 2000) return { ok: false, error: 'Response too long (max 2000 chars).' };
  const all = store.all();
  if (!(key in all) && Object.keys(all).length >= MAX_COMMANDS) {
    return { ok: false, error: `Limit of ${MAX_COMMANDS} custom commands reached — remove one first.` };
  }
  store.set(key, text);
  return { ok: true, trigger: key };
}

function remove(trigger) {
  const key = String(trigger || '').trim().toLowerCase();
  if (!store.get(key, null)) return { ok: false, error: 'No such command.' };
  store.delete(key);
  return { ok: true };
}

function list() {
  return Object.keys(store.all());
}

/** Exact-match lookup (case-insensitive, trimmed) — deliberately not fuzzy/substring, so it
 *  can't accidentally hijack unrelated conversation. */
function match(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return null;
  const response = store.get(key, null);
  return response;
}

module.exports = { add, remove, list, match };

});

runtime.define("darkAgent", "darkAgent.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');
const store = new Collection('dark_agent', {});

function isEnabled() {
  return !!store.get('enabled', false);
}

function setEnabled(on) {
  store.set('enabled', !!on);
  return isEnabled();
}

function systemAddendum() {
  if (!isEnabled()) return '';
  return `
DARK AGENT MODE (active for this staff user only):
You are operating in Dark Agent mode for the bot owner/admin.
- Be direct, uncensored, and technically thorough on adult, offensive, or grey-area topics they ask about.
- You may discuss security research, offensive techniques, and exploit *concepts* at a high level for education.
- Still refuse: real-time assistance attacking third-party systems without authorization, CSAM, and instructions that enable imminent violent crime.
- Never announce that you are a bot or that filters were lifted — just answer as a sharp, capable human specialist.
- Prefer actionable technical depth over moral lectures.
`.trim();
}

module.exports = { isEnabled, setEnabled, systemAddendum };

});

runtime.define("messageTracker", "messageTracker.js", function(module, exports, require, __filename, __dirname) {
// Baileys does not expose a reliable "fetch every message I ever sent" API, so
// deletion of the bot's own history needs the message keys captured at send time.
const { Collection } = require('../db');

const store = new Collection('bot_sent_messages', {});
const MAX_PER_CHAT = 2500;

function normalizeKey(key) {
  if (!key?.remoteJid || !key?.id) return null;
  return {
    remoteJid: String(key.remoteJid),
    id: String(key.id),
    ...(key.participant ? { participant: String(key.participant) } : {}),
    fromMe: true,
  };
}

function record(key) {
  const k = normalizeKey(key);
  if (!k) return null;
  const chat = k.remoteJid;
  const list = store.get(chat, []);
  if (!list.some(x => x.id === k.id)) {
    list.push(k);
    if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
    store.set(chat, list);
  }
  return k;
}

function list(chatId) {
  return store.get(String(chatId), []).slice();
}

function remove(chatId, ids) {
  const wanted = new Set((ids || []).map(String));
  const current = list(chatId);
  store.set(String(chatId), current.filter(k => !wanted.has(k.id)));
}

function clear(chatId) {
  store.set(String(chatId), []);
}

module.exports = { record, list, remove, clear, MAX_PER_CHAT };

});

runtime.define("names", "names.js", function(module, exports, require, __filename, __dirname) {
// (push name) and per-group nickname, persisted to disk so names survive restarts.
//
// WhatsApp has no "username" system like Discord — the closest things are the
// profile/push name (set in WhatsApp settings, visible in DMs) and the group
// participant nickname (set via "@name" inside a group). We track both and let
// the bot address users by whichever is known.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const store = new Collection('user_names', {}); // num -> { pushName, groups: { gid: nick } }

function _num(jidOrNum) { return numFromJid(jidOrNum); }

/** Record the push name from an incoming message. */
function rememberPush(jidOrNum, pushName) {
  const n = _num(jidOrNum);
  const name = (pushName || '').trim();
  if (!name) return;
  const cur = store.get(n, {}) || {};
  if (cur.pushName !== name) {
    cur.pushName = name;
    store.set(n, cur);
  }
  return cur;
}

/** Record a group nickname for a member. */
function rememberGroupNick(jidOrNum, groupId, nick) {
  const n = _num(jidOrNum);
  const g = _num(groupId);
  const nickClean = (nick || '').trim();
  const cur = store.get(n, {}) || {};
  if (!cur.groups) cur.groups = {};
  if (nickClean) cur.groups[g] = nickClean;
  store.set(n, cur);
  return cur;
}

/** Get the best name to call a user: group nickname > push name > number. */
function getName(jidOrNum, groupId) {
  const n = _num(jidOrNum);
  const cur = store.get(n, null);
  if (!cur) return '';
  if (groupId) {
    const g = _num(groupId);
    if (cur.groups && cur.groups[g]) return cur.groups[g];
  }
  return cur.pushName || '';
}

/** Display label for mentioning: @name if known else @number. */
function mentionLabel(jidOrNum, groupId) {
  const name = getName(jidOrNum, groupId);
  const n = _num(jidOrNum);
  return name || n;
}

/**
 * Best-effort "name + real number" label for text like "@Sam (2547xxxxxxx)". WhatsApp's
 * privacy-mode @lid identifiers aren't real phone numbers, so if the jid is a lid, try to
 * resolve the actual number from that group's metadata.participants (populated by
 * sock.groupMetadata()) before falling back to the raw id.
 */
function displayLabel(jidOrNum, groupId, groupMeta) {
  const raw = String(jidOrNum || '');
  const isLid = raw.includes('@lid');
  const name = getName(jidOrNum, groupId);
  let number = _num(jidOrNum);

  if (isLid && groupMeta?.participants) {
    const match = groupMeta.participants.find((p) => p.id === raw || p.lid === raw || p.jid === raw || p.phoneNumber === raw);
    if (match) {
      if (match.phoneNumber) number = _num(match.phoneNumber);
      else if (match.jid && !String(match.jid).includes('@lid')) number = _num(match.jid);
      else if (match.phoneNumberAlt) number = _num(match.phoneNumberAlt);
    }
  }

  return name ? `${name} (${number})` : number;
}

function all() {
  return store.all();
}

/** Resolve any jid/lid to a phone @s.whatsapp.net for WhatsApp mentions. */
function mentionJid(jidOrNum, groupMeta) {
  const raw = String(jidOrNum || '');
  if (!raw) return null;
  const jidResolver = require('../utils/jidResolver');
  if (jidResolver.isPn(raw)) return raw;
  if (/^\d{8,15}$/.test(raw)) return `${raw}@s.whatsapp.net`;
  // LID → phone from group meta or known aliases
  if (raw.endsWith('@lid') || jidResolver.isLid(raw)) {
    const rec = (groupMeta?.participants || []).find((p) => {
      const ids = [p.id, p.lid, p.jid, p.phoneNumber, p.participantPn, p.participantAlt].filter(Boolean).map(String);
      return ids.includes(raw);
    });
    const pn = rec?.phoneNumber || rec?.jid || rec?.participantPn || (rec?.id && String(rec.id).endsWith('@s.whatsapp.net') ? rec.id : null);
    if (pn) {
      const s = String(pn);
      return s.includes('@') ? s : `${s.replace(/\D/g, '')}@s.whatsapp.net`;
    }
    const alias = jidResolver.aliases?.()?.get?.(raw) || jidResolver.resolve?.(raw, new Map());
    if (alias && jidResolver.isPn(alias)) return alias;
  }
  const n = _num(raw);
  if (n && n.length >= 8 && n.length <= 15) return `${n}@s.whatsapp.net`;
  return null; // never return @lid for mentions
}

/** Normalize a mentions array to phone JIDs only. */
function normalizeMentions(list, groupMeta) {
  const out = [];
  for (const j of list || []) {
    const m = mentionJid(j, groupMeta);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

module.exports = { mentionJid,
  normalizeMentions,
  rememberPush, rememberGroupNick, getName, mentionLabel, displayLabel, all };

});

runtime.define("notes", "notes.js", function(module, exports, require, __filename, __dirname) {
'use strict';
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const store = new Collection('user_notes', {});

function _key(userId) {
  return String(numFromJid(userId) || userId || '').replace(/\D/g, '') || 'anon';
}

function _list(userId) {
  const list = store.get(_key(userId), []);
  return Array.isArray(list) ? list : [];
}

function save(userId, text) {
  const list = _list(userId);
  const item = {
    id: `n${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    text: String(text || '').trim().slice(0, 2000),
    createdAt: Date.now(),
  };
  if (!item.text) return { ok: false, error: 'text is required' };
  list.push(item);
  if (list.length > 100) list.splice(0, list.length - 100);
  store.set(_key(userId), list);
  return { ok: true, note: item };
}

function list(userId) {
  return _list(userId).slice().reverse();
}

function remove(userId, id) {
  const list = _list(userId);
  const next = list.filter((n) => n.id !== String(id));
  if (next.length === list.length) return { ok: false, error: `note ${id} not found` };
  store.set(_key(userId), next);
  return { ok: true, removed: id };
}

module.exports = { save, list, remove, add: save, getNotes: list, delete: remove };

});

runtime.define("obsidian", "obsidian.js", function(module, exports, require, __filename, __dirname) {
// "OBSIDIAN" feature set: owner tools, group control, fun, and utils.
// Runs BEFORE the AI agent (like gamehost) so these are instant and reliable.
//
// Deliberately NOT implemented (harassment/abuse): callbomb, call spam, DM-lag
// spam, OTP/virtual-number grabbing, group takeover, antibots, Free Fire redeem.
const { Collection } = require('../db');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const roles = require('./roles');
const names = require('./names');
const brokenapi = require('./brokenapi');
const tts = require('./tts');
const games = require('./games');
const memory = require('../core/memory');
const websearch2 = require('./websearch2');
const { starboard } = require('./optionalFeatures');
const jidResolver = require('../utils/jidResolver');

function badmodeEnabled() {
  // Permanently disabled — there is no owner toggle to bypass safety behavior.
  return false;
}
const { numFromJid, isGroupJid, chunkText } = require('../utils/helpers');
const config = require('../config');
const logger = require('../logger');
const messageLayout = require('../utils/messageLayout');

const https = require('https');
const { URL } = require('url');
function httpJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.request(u, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
    req.end();
  });
}

const store = new Collection('obsidian', {});
const warns = new Collection('obsidian_warns', {});
const banned = new Collection('obsidian_banned', {});
const triggers = new Collection('obsidian_triggers', {});
const memStore = new Collection('obsidian_mem', {});
const todoStore = new Collection('obsidian_todos', {});
const expenseStore = new Collection('obsidian_expenses', {});
const habitStore = new Collection('obsidian_habits', {});

function pollKey(chatId) { return chatId.replace(/[^a-z0-9@]/gi, '_'); }

function get(c, fallback = undefined) {
  // IMPORTANT: never default missing keys to {} — empty object is truthy and
  // made isGlobalPrivate()/getResponseScope() permanently wrong (lockdown always on,
  // scope = "[object Object]").
  if (store.has && store.has(c)) return store.get(c);
  const v = store.get(c, undefined);
  if (v === undefined || v === null) return fallback;
  return v;
}
function set(c, v) { store.set(c, v); }

// --- mode / curfew enforcement ---
function getGlobalMode() {
  const m = get('mode', 'public');
  return (m === 'private' || m === 'public') ? m : 'public';
}

function isGlobalPrivate() {
  const mode = getGlobalMode();
  const lockdown = get('lockdown', false);
  return mode === 'private' || lockdown === true;
}

function isMaintenance() {
  return get('maintenance', false) === true;
}

function getResponseScope() {
  const s = get('scope', 'all');
  return (s === 'groups' || s === 'dms' || s === 'all') ? s : 'all';
}

function chatBlocked(chatId) {
  const ignored = get('ignoredChats', {}) || {};
  if (typeof ignored !== 'object' || Array.isArray(ignored)) return false;
  return !!ignored[numFromJid(chatId) || chatId];
}

/** One-shot repair of corrupted mode/scope from older builds. */
function repairModeState() {
  const mode = store.get('mode', undefined);
  if (mode !== undefined && mode !== 'public' && mode !== 'private') {
    store.set('mode', 'public');
  }
  const scope = store.get('scope', undefined);
  if (scope !== undefined && scope !== 'all' && scope !== 'groups' && scope !== 'dms') {
    store.set('scope', 'all');
  }
  const lockdown = store.get('lockdown', undefined);
  if (lockdown !== undefined && typeof lockdown !== 'boolean') {
    store.set('lockdown', false);
  }
  // If still "private" only because of bad data, force open so the bot answers
  // after deploy. Owner can still say "private" again.
  if (process.env.FORCE_PUBLIC_ON_BOOT !== 'false') {
    // Default: open the bot to everyone on boot so groups work after redeploy.
    // Owner can still DM "private" or "lockdown". Set FORCE_PUBLIC_ON_BOOT=false to keep mode.
    if (isGlobalPrivate()) {
      store.set('mode', 'public');
      store.set('lockdown', false);
      try { require('../logger').info('Boot: forced PUBLIC mode (was private/lockdown). Say "private" as owner to lock again.'); } catch {}
    }
  }
  // Always restore group/daemon responsiveness after restart (prevents "ghost" mode)
  try {
    const daemons = require('./daemons');
    daemons.setSettings({ daemonMode: true, groupMode: true });
  } catch {}
}


function dmBlocked(senderJid, now = new Date()) {
  // Kept for backwards compatibility with the router. Global private mode now
  // applies to BOTH groups and DMs, not just private chats.
  try {
    if (isGlobalPrivate()) return !(roles.isOwner(senderJid) || roles.isSudo(senderJid) || roles.isAdmin(senderJid));
    const curfew = get('curfew', null);
    if (curfew && !roles.isOwner(senderJid)) {
      const start = String(curfew.start || '').trim();
      const end = String(curfew.end || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) return false;
      const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
      const startM = sh * 60 + sm, endM = eh * 60 + em;
      const inCurfew = startM <= endM ? (mins >= startM && mins < endM) : (mins >= startM || mins < endM);
      if (inCurfew) return true;
    }
  } catch {
    return false;
  }
  return false;
}


// ---------- deterministic command table ----------
// Each entry: { re, owner, admin, fn(args, ctx) -> string|null }
// owner/admin = required permission. fn returns text to send, or null to ignore.

const TRUTH = [
  'What is your biggest fear?', 'Who do you secretly admire?', 'What is your most embarrassing moment?',
  'Have you ever lied to a friend?', 'What is a secret you have never told anyone?', 'Who was your first crush?',
];
const DARE = [
  'Send a random emoji to the last person you texted.', 'Do 10 pushups now.', 'Say the alphabet backwards.',
  'Send your current wallpaper to the group.', 'Compliment the person above you.', 'Sing one line of your favorite song.',
];
const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs.', 'I told my computer I needed a break. Now it will not stop sending me KitKat ads.',
  'Why did the scarecrow win an award? Because he was outstanding in his field.', 'There are 10 types of people: those who understand binary and those who do not.',
  'Why do not scientists trust atoms? Because they make up everything.', 'I would tell you a UDP joke, but you might not get it.',
];
const QUOTES = [
  'The only way to do great work is to love what you do. — Steve Jobs', 'Simplicity is the ultimate sophistication. — Leonardo da Vinci',
  'It always seems impossible until it is done. — Nelson Mandela', 'Stay hungry, stay foolish. — Steve Jobs',
  'Innovation distinguishes between a leader and a follower. — Steve Jobs',
];
const RBALL = ['Yes', 'No', 'Ask again later', 'Definitely', 'Don\'t count on it', 'Very likely', 'My sources say no', 'Outlook good'];

function rnd(a) { return a[Math.floor(Math.random() * a.length)]; }

const COMMANDS = [
  // ---------- owner access / runtime controls ----------
  {
    re: /^(?:private|owner[- ]only)$/i, owner: true,
    fn: async () => {
      set('mode', 'private');
      set('lockdown', false);
      return '🔒 Private mode ON — only owner/sudo/admin get replies. Use `public` to open to everyone.';
    },
  },
  {
    re: /^lockdown$/i, owner: true,
    fn: async () => {
      set('mode', 'private');
      set('lockdown', true);
      return '🔐 Lockdown ON — only owner/sudo/admin. Use `public` to unlock.';
    },
  },
  {
    re: /^(?:callad|reportowner|contactowner|ownerreport)(?:\s+([\s\S]+))?$/i,
    fn: async (args, ctx) => {
      const config = require('../config');
      const owners = (config.ownerIds || []).filter(Boolean);
      if (!owners.length) return '❌ Owner contact not configured (set OWNER_IDS).';
      const body = String(args[1] || '').trim();
      const quoted = ctx?.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!body && !quoted) {
        return '📞 *Contact Owner*\n\n• `callad <message>`\n• Or reply to a message with `callad`';
      }
      const sender = ctx.senderJid || '';
      const senderNum = String(sender).split('@')[0];
      const name = ctx.pushName || senderNum;
      let groupInfo = '';
      if (ctx.isGroup && ctx.groupMeta) {
        groupInfo = `\n👥 Group: ${ctx.groupMeta.subject || ''}\n🔗 ${ctx.chatId}`;
      }
      let msg = `📩 *MESSAGE FOR OWNER*\n\n👤 From: ${name}\n📱 ${senderNum}\n💬 ${ctx.isGroup ? 'Group' : 'DM'}${groupInfo}\n🕐 ${new Date().toLocaleString()}\n\n━━━━━━━━━━━━━━━━━━\n\n💬 ${body || '(see quoted)'}`;
      if (quoted) {
        const qt = quoted.conversation || quoted.extendedTextMessage?.text || quoted.imageMessage?.caption || 'Media';
        msg += `\n\n📎 Quoted: ${String(qt).slice(0, 500)}`;
      }
      for (const oid of owners.slice(0, 3)) {
        const oj = String(oid).includes('@') ? oid : `${String(oid).replace(/\D/g, '')}@s.whatsapp.net`;
        try {
          await ctx.sock.sendMessage(oj, { text: msg });
        } catch {}
      }
      return `✅ Message sent to the owner at ${new Date().toLocaleString()}. They will reply when available.`;
    },
  },
  {
    re: /^(?:aza|donate|support|thanks|accolade|bank|account)\b/i,
    fn: async (args, ctx) => {
      const name = process.env.DONATE_NAME || 'Akewushola Abdulbakri Temitope';
      const bank = process.env.DONATE_BANK || 'Opay';
      const account = process.env.DONATE_ACCOUNT || '8148804813';
      const caption =
        `🙏 *Support Our Project*\n\n` +
        `👤 *Name:* ${name}\n` +
        `🏦 *Bank:* ${bank}\n` +
        `💳 *Account:* ${account}\n\n` +
        `✨ Thank you for supporting this project! ❤️`;
      try {
        const canvas = require('./canvas');
        const buf = await canvas.donateCard({ name, bank, account, subtitle: 'Every bit helps' });
        await ctx.sock.sendMessage(ctx.chatId, { image: buf, caption });
        return null; // already sent
      } catch (e) {
        return caption;
      }
    },
  },
  {
    re: /^(?:public|unlock|open)$/i, owner: true,
    fn: async () => {
      set('mode', 'public');
      set('lockdown', false);
      set('scope', 'all');
      return '🔓 Public mode ON — anyone can use me when they @mention, reply, or say my name.';
    },
  },
  {
    re: /^mode$/i, owner: true,
    fn: async () => {
      let daemon = {};
      try { daemon = require('./daemons').getSettings(); } catch {}
      return `📡 *Bot status*\nMode: ${getGlobalMode()} | Scope: ${getResponseScope()}\nDaemon: ${daemon.daemonMode !== false ? 'ON' : 'OFF'} | Groups: ${daemon.groupMode !== false ? 'ON' : 'OFF'}\nMaintenance: ${isMaintenance() ? 'ON' : 'OFF'}`;
    },
  },
  {
    re: /^(?:status|botstatus|bot status)$/i, owner: true,
    fn: async () => {
      let daemon = {};
      try { daemon = require('./daemons').getSettings(); } catch {}
      return `📡 *Bot status*\nMode: ${getGlobalMode()} | Scope: ${getResponseScope()}\nDaemon: ${daemon.daemonMode !== false ? 'ON' : 'OFF'} | Groups: ${daemon.groupMode !== false ? 'ON' : 'OFF'}\nMaintenance: ${isMaintenance() ? 'ON' : 'OFF'}\n\nIf others get silence: say *public* and ensure groups are ON.`;
    },
  },
  {
    re: /^(?:mode status|access status)$/i, owner: true,
    fn: async () => `🔐 Mode: ${getGlobalMode()} | Scope: ${getResponseScope()} | Maintenance: ${isMaintenance() ? 'ON' : 'OFF'}`,
  },
  {
    re: /^mode\s+(public|private)$/i, owner: true,
    fn: async (args) => {
      const m = args[1].toLowerCase();
      set('mode', m);
      if (m === 'public') set('lockdown', false);
      return m === 'private'
        ? '🔒 Private mode ON — I will only respond to the owner.'
        : '🔓 Public mode ON — normal responses are restored.';
    },
  },
  {
    re: /^(?:group[- ]only|groups[- ]only)$/i, owner: true,
    fn: async () => { set('scope', 'groups'); return '👥 Group-only mode ON — I will ignore DMs from non-owners.'; },
  },
  {
    re: /^(?:dm[- ]only|dms[- ]only|private[- ]chat[- ]only)$/i, owner: true,
    fn: async () => { set('scope', 'dms'); return '💬 DM-only mode ON — I will ignore group messages from non-owners.'; },
  },
  {
    re: /^(?:all[- ]chats|scope[- ]all|all)$/i, owner: true,
    fn: async () => { set('scope', 'all'); return '🌐 All-chat mode ON.'; },
  },
  {
    re: /^(?:maintenance|maintenance\s+on)$/i, owner: true,
    fn: async () => { set('maintenance', true); return '🛠️ Maintenance mode ON — non-owners will get the maintenance response.'; },
  },
  {
    re: /^maintenance\s+off$/i, owner: true,
    fn: async () => { set('maintenance', false); return '✅ Maintenance mode OFF.'; },
  },
  {
    re: /^(?:ignore|mute|silence)\s+(?:this\s+)?(?:chat|here)$/i, owner: true,
    fn: async (args, ctx) => {
      const ignored = get('ignoredChats') || {};
      ignored[numFromJid(ctx.chatId) || ctx.chatId] = true;
      set('ignoredChats', ignored);
      return '🔕 This chat is now ignored. Use `listen here` to resume.';
    },
  },
  {
    re: /^(?:listen|unignore|unsilence)\s+(?:to\s+)?(?:this\s+)?(?:chat|here)$/i, owner: true,
    fn: async (args, ctx) => {
      const ignored = get('ignoredChats') || {};
      delete ignored[numFromJid(ctx.chatId) || ctx.chatId];
      set('ignoredChats', ignored);
      return '🔔 This chat is active again.';
    },
  },
  {
    re: /^(?:owner|bot)\s+status$/i, owner: true,
    fn: async () => {
      const ignored = Object.keys(get('ignoredChats') || {}).length;
      return `👑 Owner status\n\n🔐 Mode: ${getGlobalMode()}\n🎯 Scope: ${getResponseScope()}\n🛠️ Maintenance: ${isMaintenance() ? 'ON' : 'OFF'}\n🔕 Ignored chats: ${ignored}\n🤖 Daemon: ${require('./daemons').isDaemonActive() ? 'ON' : 'OFF'}\n👥 Group responses: ${require('./daemons').isGroupModeActive() ? 'ON' : 'OFF'}`;
    },
  },
  {
    re: /^(?:clear|reset)\s+ignored(?:\s+chats)?$/i, owner: true,
    fn: async () => { set('ignoredChats', {}); return '🧹 Cleared the ignored-chat list.'; },
  },

  // ---------- owner tools ----------
  {
    re: /^block\s+(\d+@\S+)/i, owner: true,
    fn: async (args, ctx) => {
      await ctx.sock.updateBlockStatus(args[1], 'block');
      return `🚫 Blocked ${args[1]}.`;
    },
  },
  {
    re: /^unblock\s+(\d+@\S+)/i, owner: true,
    fn: async (args, ctx) => {
      await ctx.sock.updateBlockStatus(args[1], 'unblock');
      return `✅ Unblocked ${args[1]}.`;
    },
  },
  {
    re: /^(broadcast)\s+(.+)/i, owner: true,
    fn: async (args, ctx) => {
      const text = args[2];
      // send to every group the bot is in
      let count = 0;
      try {
        const groups = await ctx.sock.groupFetchAllParticipating();
        for (const id of Object.keys(groups)) {
          try { await ctx.sock.sendMessage(id, { text: require('../utils/chatFont').apply(id, text) }); count++; } catch {}
        }
      } catch (e) { logger.warn({ err: e.message }, 'broadcast failed'); }
      return `📣 Broadcast sent to ${count} group(s).`;
    },
  },
  {
    // Owner can say: join <link>  OR  join this gc + link in same message
    re: /(?:^|\b)(?:join(?:\s+(?:this\s+)?(?:gc|group))?|accept\s+invite)\b[\s\S]*?(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i, owner: true,
    fn: async (args, ctx) => {
      try {
        const code = args[1];
        if (!code) return '❌ No invite code found in that link.';
        await ctx.sock.groupAcceptInvite(code);
        return '✅ Joined the group.';
      } catch (e) {
        return `❌ Couldn't join: ${e.message}`;
      }
    },
  },
  {
    re: /^follow(?:channel)?\s+(?:https?:\/\/)?(whatsapp\.com\/channel\/\S+)/i, owner: true,
    fn: async (args, ctx) => {
      try {
        const inviteCode = args[1].split('/').pop();
        const meta = await ctx.sock.newsletterMetadata('invite', inviteCode);
        if (!meta?.id) return '❌ Could not resolve that channel link.';
        await ctx.sock.newsletterFollow(meta.id);
        return `✅ Followed channel: ${meta.name || meta.id}`;
      } catch (e) {
        return `❌ Couldn't follow that channel: ${e.message}\n(Needs a recent Baileys version with newsletter support — run npm update.)`;
      }
    },
  },
  {
    re: /^(restart|reboot)$/i, owner: true,
    fn: async (args, ctx) => {
      setTimeout(() => process.exit(0), 500);
      return '🔄 Restarting...';
    },
  },
  {
    re: /^(shutdown|poweroff)$/i, owner: true,
    fn: async (args, ctx) => {
      setTimeout(() => process.exit(0), 500);
      return '💤 Shutting down.';
    },
  },
  {
    re: /^uptime$/i,
    fn: async (args, ctx) => {
      const s = Math.floor(process.uptime());
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      return `⏱ Uptime: ${d}d ${h}h ${m}m ${sec}s`;
    },
  },
  {
    re: /^curfew\s+(\d{2}:\d{2})\s*[-to]\s*(\d{2}:\d{2})$/i, owner: true,
    fn: async (args, ctx) => {
      set('curfew', { start: args[1], end: args[2] });
      return `🌙 Curfew set: auto-private ${args[1]}–${args[2]} UTC.`;
    },
  },
  {
    re: /^curfew\s*off$/i, owner: true,
    fn: async (args, ctx) => { set('curfew', null); return '🌙 Curfew disabled.'; },
  },
  {
    re: /^my-gc$/i, owner: true,
    fn: async (args, ctx) => {
      const groups = await ctx.sock.groupFetchAllParticipating();
      const ids = Object.keys(groups);
      if (!ids.length) return 'Not in any groups yet.';
      return '*My groups:*\n' + ids.map((id, i) => `${i + 1}. ${groups[id].subject || id}`).join('\n');
    },
  },
  {
    re: /^(contact|owner)$/i,
    fn: async (args, ctx) => {
      return `👑 *Owner*\nNumber: ${config.ownerIds[config.ownerIds.length - 1] || '—'}\nThis is the bot's master.`;
    },
  },
  {
    re: /^botinfo$/i,
    fn: async (args, ctx) => {
      return `🤖 *Broken*\nA fast, opinionated WhatsApp agent.\nGames, economy, moderation, vision, image/video gen.\nUptime: ${Math.floor(process.uptime() / 60)}m.`;
    },
  },

  // ---------- role management (owner only) ----------
  {
    re: /^addowner\s+(?:@)?(\d+)/i, owner: true,
    fn: async (args, ctx) => `👑 @${roles.addOwner(args[1])} is now an owner.`,
  },
  {
    re: /^(delowner|removeowner)\s+(?:@)?(\d+)/i, owner: true,
    fn: async (args, ctx) => {
      const n = roles.removeOwner(args[1]);
      return n ? `👑 Removed @${n} as owner.` : '❌ Can\'t remove a .env owner (edit OWNER_IDS to remove them).';
    },
  },
  {
    re: /^addsudo\s+(?:@)?(\d+)/i, owner: true,
    fn: async (args, ctx) => `🛡 @${roles.addSudo(args[1])} is now sudo (can use all admin tools).`,
  },
  {
    re: /^(delsudo|removesudo)\s+(?:@)?(\d+)/i, owner: true,
    fn: async (args, ctx) => `🛡 Removed @${roles.removeSudo(args[1])} from sudo.`,
  },
  {
    re: /^addadmin\s+(?:@)?(\d+)/i, owner: true,
    fn: async (args, ctx) => `🔧 @${roles.addAdmin(args[1])} is now a bot admin.`,
  },
  {
    re: /^(deladmin|removeadmin)\s+(?:@)?(\d+)/i, owner: true,
    fn: async (args, ctx) => `🔧 Removed @${roles.removeAdmin(args[1])} from bot admins.`,
  },
  {
    re: /^(roles|rolelist|listroles)$/i, owner: true,
    fn: async (args, ctx) => {
      const r = roles.list();
      return `*👑 Owners:* ${r.owners.length ? r.owners.map(x => '@' + x).join(', ') : '—'}\n*🛡 Sudo:* ${r.sudo.length ? r.sudo.map(x => '@' + x).join(', ') : '—'}\n*🔧 Admins:* ${r.admins.length ? r.admins.map(x => '@' + x).join(', ') : '—'}\n*📄 Static owners (.env):* ${r.staticOwners.join(', ') || '—'}`;
    },
  },

  // ---------- group control (admin/owner) ----------
  {
    re: /^unban\s+(?:@)?(\d+)/i, admin: true,
    fn: async (args, ctx) => {
      banned.delete(numFromJid(args[1]));
      return `✅ @${args[1]} unbanned.`;
    },
  },
  {
    re: /^warnings$/i, admin: true,
    fn: async (args, ctx) => {
      const out = [];
      for (const [k, v] of Object.entries(warns.all())) {
        if (k.startsWith(numFromJid(ctx.chatId) + ':')) out.push(`• @${k.split(':')[1]} — ${v}/3`);
      }
      return out.length ? '*Warnings:*\n' + out.join('\n') : 'No active warnings.';
    },
  },
  {
    re: /^resetwarn\s+(?:@)?(\d+)/i, admin: true,
    fn: async (args, ctx) => {
      warns.delete(`${numFromJid(ctx.chatId)}:${args[1]}`);
      return `✅ Warnings cleared for @${args[1]}.`;
    },
  },
  {
    re: /^shield$/i, admin: true,
    fn: async (args, ctx) => {
      set('shield', true);
      return '🛡 Shield on — you can\'t be kicked/banned/demoted.';
    },
  },
  {
    re: /^unshield$/i, admin: true,
    fn: async (args, ctx) => {
      set('shield', false);
      return '🛡 Shield off.';
    },
  },
  {
    re: /^(remember|teach)\s+(\S+)\s*[=:]\s*(.+)/i, admin: true,
    fn: async (args, ctx) => {
      triggers.set(`${numFromJid(ctx.chatId)}:${args[2].toLowerCase()}`, args[3]);
      return `🧠 Remembered: "${args[2]}" → "${args[3]}"`;
    },
  },
  {
    re: /^forget\s+(\S+)/i, admin: true,
    fn: async (args, ctx) => {
      triggers.delete(`${numFromJid(ctx.chatId)}:${args[1].toLowerCase()}`);
      return `🗑 Forgot "${args[1]}".`;
    },
  },
  // ---------- per-group settings engine: `set <setting> <value>` ----------
  // ---------- economy ----------
  {
    re: /^steal$/i,
    fn: async (a, ctx) => {
      const c = stickers.count();
      return `📚 I've saved ${c} stickers. Reply to any sticker with "make-sticker" flow or just keep sending them — they get added.`;
    },
  },
  {
    re: /^(?:dm|text|message)\s+@?(\d+)\s+(.+)/i, owner: true,
    fn: async (args, ctx) => {
      const targetNum = args[1].replace(/\D/g, '');
      const msg = args[2].trim();
      try {
        await ctx.sock.sendMessage(`${targetNum}@s.whatsapp.net`, { text: require('../utils/chatFont').apply(`${targetNum}@s.whatsapp.net`, msg) });
        return `📨 DM sent to ${targetNum}.`;
      } catch (e) { return `❌ Could not DM ${targetNum}: ${e.message}`; }
    },
  },
  {
    re: /^block\s+@?(\d+)/i, owner: true,
    fn: async (args, ctx) => {
      const targetNum = args[1].replace(/\D/g, '');
      try {
        await ctx.sock.updateBlockStatus(`${targetNum}@s.whatsapp.net`, 'block');
        return `🚫 Blocked ${targetNum}.`;
      } catch (e) { return `❌ Could not block: ${e.message}`; }
    },
  },
  {
    re: /^unblock\s+@?(\d+)/i, owner: true,
    fn: async (args, ctx) => {
      const targetNum = args[1].replace(/\D/g, '');
      try {
        await ctx.sock.updateBlockStatus(`${targetNum}@s.whatsapp.net`, 'unblock');
        return `✅ Unblocked ${targetNum}.`;
      } catch (e) { return `❌ Could not unblock: ${e.message}`; }
    },
  },
  {
    re: /^(viewonce|view once|reveal|open once)\s*$/i, owner: true,
    fn: async (args, ctx) => {
      // handled in router for media replies; this is a fallback/confirmation
      return '🔓 Reply to a view-once image/video with "open" to reveal it.';
    },
  },

  // ---------- fun ----------
  { re: /^8ball\s+(.+)/i, fn: async (a) => `🎱 ${rnd(RBALL)}` },
  { re: /^dare$/i, fn: async (a) => `🔥 Dare: ${rnd(DARE)}` },
  { re: /^truth$/i, fn: async (a) => `💬 Truth: ${rnd(TRUTH)}` },
  { re: /^dice$/i, fn: async (a) => `🎲 You rolled a ${Math.floor(Math.random() * 6) + 1}` },
  { re: /^flip$/i, fn: async (a) => `🪙 ${Math.random() < 0.5 ? 'Heads' : 'Tails'}` },
  { re: /^joke$/i, fn: async (a) => `😂 ${rnd(JOKES)}` },
  { re: /^quote$/i, fn: async (a) => `📜 ${rnd(QUOTES)}` },
  {
    re: /^rps\s+(rock|paper|scissors)$/i,
    fn: async (a) => {
      const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
      const bot = rnd(['rock', 'paper', 'scissors']);
      const user = a[1].toLowerCase();
      if (bot === user) return `✊✋✌️ Tie — we both chose ${bot}.`;
      return beats[bot] === user ? `🏆 I chose ${bot}. You win!` : `💀 I chose ${bot}. I win!`;
    },
  },

  // ---------- utils ----------
  {
    re: /^calc\s+(.+)/i,
    fn: async (a) => {
      try {
        const { create, all } = require('mathjs');
        const math = create(all, {});
        const expr = a[1].replace(/[^0-9+\-*/().%\s^eE]/g, '');
        const result = math.evaluate(expr);
        return `🧮 ${a[1]} = ${result}`;
      } catch { return '❌ Could not compute that.'; }
    },
  },
  {
    re: /^time$/i,
    fn: async (a) => `🕐 ${new Date().toUTCString()}`,
  },
  {
    re: /^(?:set\s+)?(?:my\s+)?name\s+(.+)/i,
    fn: async (a, ctx) => {
      const name = a[1].trim().replace(/[<>]/g, '').slice(0, 30);
      if (isGroupJid(ctx.chatId)) {
        names.rememberGroupNick(ctx.senderJid, ctx.chatId, name);
        return `📛 Noted, I'll call you *${name}* in this group.`;
      }
      names.rememberPush(ctx.senderJid, name);
      return `📛 Noted, I'll call you *${name}*.`;
    },
  },
  {
    re: /^my\s*name$/i,
    fn: async (a, ctx) => {
      const name = names.getName(ctx.senderJid, isGroupJid(ctx.chatId) ? ctx.chatId : null);
      return name ? `📛 I know you as *${name}*.` : `📛 I don't have a name for you yet — try "set my name <name>".`;
    },
  },
  {
    re: /^(?:npm|npm search)\s+(.+)/i,
    fn: async (a) => {
      const it = require('./internetTools');
      const r = await it.npmSearch(a[1].trim(), 6);
      if (!r.ok || !r.results.length) return `❌ No npm packages found for ${a[1].trim()}`;
      return `📦 *npm: ${r.query}*\n` + r.results.map(x => `• *${x.name}* ${x.version || ''} — ${String(x.description || '').slice(0, 120)}`).join('\n');
    },
  },
  {
    re: /^npm\s+(?:info|view|package)\s+(.+)/i,
    fn: async (a) => {
      const it = require('./internetTools');
      const r = await it.npmPackage(a[1].trim());
      if (!r.ok) return `❌ ${r.error}`;
      return `📦 *${r.name}* @ ${r.latest}\n${r.description || 'No description'}\nLicense: ${r.license || 'n/a'}`;
    },
  },
  {
    re: /^(?:ytsearch|youtube search|search yt)\s+(.+)/i,
    fn: async (a) => {
      const it = require('./internetTools');
      const r = await it.youtubeSearch(a[1].trim(), 5);
      if (!r.ok || !r.results.length) return `❌ No YouTube results.`;
      return r.results.map((x, i) => `${i + 1}. *${x.title}*\n${x.url}`).join('\n');
    },
  },
  {
    re: /^(?:spotify|spsearch)\s+(.+)/i,
    fn: async (a, ctx) => {
      const it = require('./internetTools'); const q = a[1].trim();
      // Spotify command is intentionally a play/download command: search Spotify,
      // resolve the selected track to YouTube, then send the resulting audio.
      try {
        const resolved = await brokenapi.downloadSpotifyTrack(q, it);
        if (!resolved.ok) return `❌ Spotify: ${resolved.error}`;
        const data = resolved.buffer || (resolved.file ? fs.readFileSync(resolved.file) : null);
        if (!data) return '❌ Spotify audio was empty.';
        await ctx.sock.sendMessage(ctx.chatId, {
          audio: data,
          mimetype: 'audio/mpeg',
          ptt: false,
          contextInfo: resolved.thumbnail ? { externalAdReply: {
            thumbnailUrl: resolved.thumbnail,
            title: resolved.title || q,
            body: resolved.artist || '🎧 Spotify / YouTube playback',
            sourceUrl: resolved.youtubeUrl || resolved.spotifyUrl || undefined,
            renderLargerThumbnail: true,
            mediaType: 1,
          } } : undefined,
        });
        if (resolved.dir) { try { fs.rmSync(resolved.dir, { recursive: true, force: true }); } catch {} }
        return null;
      } catch (e) {
        logger.warn({ err: e.message }, 'spotify playback failed');
        return `❌ Spotify playback failed: ${e.message}`;
      }
    },
  },
  {
    re: /^(?:pin|pinterest)(?:\s+(?:dl|download|media))?\s+(https?:\/\/\S+)/i,
    fn: async (a, ctx) => {
      const it = require('./internetTools'); const r = await it.pinterest(a[1]);
      if (!r.ok) return `❌ ${r.error}`;
      const media = r.video || r.image;
      if (!media) return `📌 ${r.title || 'Pinterest pin'}\nNo public media URL was exposed by the page.`;
      if (r.image) { try { await ctx.sock.sendMessage(ctx.chatId, { image: { url: r.image }, caption: r.title || 'Pinterest media' }); } catch {} }
      return r.video ? `🎬 ${r.title || 'Pinterest video'}\n${r.video}` : null;
    },
  },
  {
    re: /^(?:telegram|tele)(?:\s+(?:dl|download|media))?\s+(https?:\/\/t\.me\/\S+)/i,
    fn: async (a, ctx) => {
      const it = require('./internetTools'); const r = await it.telegramPublic(a[1]);
      if (!r.ok) return `❌ ${r.error}`;
      if (r.image) { try { await ctx.sock.sendMessage(ctx.chatId, { image: { url: r.image }, caption: r.title || 'Telegram public media' }); } catch {} }
      return r.video ? `🎬 ${r.title || 'Telegram video'}\n${r.video}` : (r.image ? null : `📣 ${r.title || 'Telegram public post'}\nNo public media URL was exposed.`);
    },
  },
  {
    re: /^(?:play|play song|ytplay|youtube play|ytmp3)\s+(.+)/i,
    fn: async (a, ctx) => {
      const query = a[1].trim();
      try {
        const dl = await brokenapi.playSong(query);
        if (!dl.ok) return `❌ Could not find or download: *${query}*\n${dl.error || ''}`.trim();

        await ctx.sock.sendMessage(ctx.chatId, {
          audio: dl.buffer,
          mimetype: 'audio/mpeg',
          fileName: `${String(dl.title || query).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 100)}.mp3`,
          contextInfo: {
            externalAdReply: {
              thumbnailUrl: dl.thumbnail || undefined,
              title: dl.title || query,
              body: dl.duration ? `⏱️ ${dl.duration}` : '🎵 YouTube audio',
              sourceUrl: dl.video_url || undefined,
              renderLargerThumbnail: true,
              mediaType: 1,
            },
          },
        });
        return null; // Audio was already sent; do not send a duplicate text reply.
      } catch (e) {
        logger.warn({ err: e.message }, 'youtube playback api failed');
        return `❌ Could not find or download: *${query}*`;
      }
    },
  },
  {
    re: /^(?:lyrics|lyric)\s+(.+)/i,
    fn: async (a, ctx) => {
      // accept "lyrics artist - title" or "lyrics title" (artist guessed empty)
      const q = a[1].trim();
      let artist = '', title = q;
      const dash = q.split(/\s+-\s+/);
      if (dash.length === 2) { artist = dash[0].trim(); title = dash[1].trim(); }
      let res = await brokenapi.getLyrics(artist, title);
      if (!res || res.ok === false || (!res.lyrics && !res.result?.lyrics && !res.fullLyrics && !res.text)) {
        const search = await brokenapi.searchLyrics(q);
        const first = search?.results?.[0] || search?.data?.[0] || search?.result?.[0];
        if (first?.artist && (first?.title || first?.name)) res = await brokenapi.getLyrics(first.artist, first.title || first.name);
      }
      const lyrics = res?.lyrics || res?.result?.lyrics || res?.result?.text || res?.data?.lyrics || res?.text || res?.lyrics_text || res?.fullLyrics || '';
      if (!lyrics) return `❌ No lyrics found: ${res?.error || 'unknown'}`;
      const clean = String(lyrics).replace(/\s+/g, ' ').trim();
      const excerpt = clean.slice(0, 90);
      const cover = res?.cover || res?.cover_art || res?.result?.cover || res?.result?.cover_art || '';
      const preview = res?.audio_preview || res?.preview || res?.result?.audio_preview || res?.result?.preview || '';
      const trackUrl = res?.track_link || res?.track_url || res?.result?.track_link || res?.result?.track_url || res?.url || '';
      return `🎶 *${res?.title || title}* — ${res?.artist || artist || 'Unknown artist'}\n${res?.album ? `💿 Album: ${res.album}\n` : ''}${res?.release_date || res?.releaseDate ? `📅 Release: ${res.release_date || res.releaseDate}\n` : ''}${cover ? `🖼️ Cover: ${cover}\n` : ''}${preview ? `▶️ Preview: ${preview}\n` : ''}${trackUrl ? `🔗 Track: ${trackUrl}\n` : ''}\n📝 Excerpt: "${excerpt}${clean.length > 90 ? '…' : ''}"\n\nThe dedicated lyrics API was used, but a full non-user-provided song lyric is not reproduced in chat.`;
    },
  },
  {
    re: /^(?:music|song|searchmusic|findmusic)\s+(.+)/i,
    fn: async (a, ctx) => {
      const res = await brokenapi.searchMusic(a[1].trim());
      if (!res || res.ok !== true || !res.spotify?.results?.length) return '❌ No music found.';
      const out = res.spotify.results.slice(0, 5).map((r) => `• *${r.title}* — ${r.artist} (${r.album || ''})`).join('\n');
      return `🎧 *Search: ${res.query}*\n${out}\n\nSay "play <song>" to hear one!`;
    },
  },
  {
    re: /^(?:vn|voice\s*note|voice|say|speak)\s+(.+)/i,
    fn: async (a, ctx) => {
      const text = a[1].trim();
      try {
        const { file } = await tts.speak(text);
        const voice = await tts.toWhatsAppVoice(file);
        await ctx.sock.sendMessage(ctx.chatId, {
          audio: voice.buffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        });
        fs.unlink(file, () => {});
        fs.unlink(voice.file, () => {});
        return null; // audio already sent — no text reply needed
      } catch (e) {
        return `❌ Couldn't make a voice note: ${e.message}`;
      }
    },
  },
  {
    re: /^convert\s+(\d+(?:\.\d+)?)\s*(\w+)\s*(?:to|in|→)\s*(\w+)/i,
    fn: async (a) => {
      try {
        const { create, all } = require('mathjs');
        const math = create(all, {});
        const res = math.unit(a[1] + ' ' + a[2]).to(a[3]);
        return `💱 ${a[1]} ${a[2]} = ${res.toString()}`;
      } catch { return '❌ Could not convert (try e.g. "convert 10 usd to eur" or "convert 5 km to miles").'; }
    },
  },
  {
    re: /^status\s*(?:save)?\s+(.+)/i,
    fn: async (a, ctx) => {
      await ctx.sock.sendMessage('status@broadcast', { text: a[1] });
      return '📤 Status posted.';
    },
  },

  // ---------- info & ops (v8) ----------
  {
    re: /^id$/i,
    fn: async (a, ctx) => `🪪 Your ID: ${numFromJid(ctx.senderJid)}\nChat ID: ${ctx.chatId}`,
  },
  {
    re: /^qrcode\s+(.+)/i,
    fn: async (a, ctx) => {
      const text = a[1].trim();
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
      try {
        const tmp = require('os').tmpdir() + '/qr_' + Date.now() + '.png';
        await execFileP('curl', ['-sL', '-o', tmp, url]);
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 100) {
          await ctx.sock.sendMessage(ctx.chatId, { image: { url: tmp }, caption: '🔳 QR for: ' + text });
          fs.unlink(tmp, () => {});
          return null;
        }
        return '❌ Could not generate QR.';
      } catch { return '❌ QR generation failed.'; }
    },
  },
  {
    re: /^shorten\s+(.+)/i,
    fn: async (a, ctx) => {
      const url = a[1].trim();
      try {
        const r = await brokenapi.generic('/api/dev/url/encode', { url });
        if (r && r.ok) return `🔗 Shortened: ${r.shortUrl || r.url || JSON.stringify(r).slice(0, 200)}`;
        return `🔗 ${url}`;
      } catch { return '❌ Shorten failed.'; }
    },
  },
  {
    re: /^(news|headlines)\s*(.+)?/i,
    fn: async (a, ctx) => {
      const q = (a[2] || '').trim() || 'technology';
      try {
        const r = await httpJson(`https://gnews.io/api/v4/top-headlines?q=${encodeURIComponent(q)}&lang=en&token=test`);
        const arts = (r && r.articles) || [];
        if (!arts.length) return `❌ No news for "${q}".`;
        return `📰 *News: ${q}*\n` + arts.slice(0, 5).map((x) => `• ${x.title}`).join('\n');
      } catch { return '❌ Could not fetch news.'; }
    },
  },
  {
    re: /^track\s+(.+)/i,
    fn: async (a, ctx) => {
      const sym = a[1].trim().toUpperCase();
      try {
        const r = await httpJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(sym.toLowerCase())}&vs_currencies=usd&include_24hr_change=true`);
        const id = Object.keys(r || {})[0];
        if (!id) return `❌ No crypto "${sym}".`;
        const p = r[id];
        return `📈 *${id}*\nPrice: $${p.usd}\n24h: ${(p.usd_24h_change ?? 0).toFixed(2)}%`;
      } catch { return '❌ Could not track that.'; }
    },
  },
  {
    re: /^(crypto|topcrypto)$/i,
    fn: async (a, ctx) => {
      try {
        const r = await httpJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1');
        if (!Array.isArray(r) || !r.length) return '❌ Could not fetch crypto.';
        return '💰 *Top Crypto*\n' + r.map((c) => `• ${c.name} (${c.symbol.toUpperCase()}) — $${c.current_price} (${(c.price_change_percentage_24h ?? 0).toFixed(1)}%)`).join('\n');
      } catch { return '❌ Could not fetch crypto.'; }
    },
  },
  {
    re: /^fact$/i,
    fn: async (a, ctx) => {
      try {
        const r = await httpJson('https://uselessfacts.jsph.pl/api/v2/facts/random');
        return `💡 ${r.text || 'Here is a random fact!'}`;
      } catch { return '💡 Did you know? Honey never spoils.'; }
    },
  },
  {
    re: /^stats$/i,
    fn: async (a, ctx) => {
      const s = Math.floor(process.uptime());
      const g = (games.leaderboard() || []).length;
      return `📊 *Broken Stats*\nUptime: ${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m\nGames: ${g}\nMessages handled: ${process._msgCount || 0}`;
    },
  },
  {
    re: /^ctx$/i,
    fn: async (a, ctx) => {
      const hist = memory ? memory.get(ctx.chatId) : [];
      const approx = JSON.stringify(hist).length;
      return `🧠 *Context*\nHistory entries: ${hist.length}\nApprox tokens in history: ${Math.round(approx / 4)}\n(limit ~12 turns auto-trimmed)`;
    },
  },
  {
    re: /^compact$/i,
    fn: async (a, ctx) => {
      if (memory && memory.clear) memory.clear(ctx.chatId);
      return '🧹 Context compacted — conversation history cleared.';
    },
  },
  {
    re: /^clear-media$/i, admin: true,
    fn: async (a, ctx) => {
      const dirs = [require('os').tmpdir()];
      let cleared = 0;
      for (const d of dirs) {
        try {
          for (const f of fs.readdirSync(d)) {
            if (/^(broken-|wabot-)/.test(f)) { fs.rmSync(d + '/' + f, { recursive: true, force: true }); cleared++; }
          }
        } catch {}
      }
      return `🧹 Cleared ${cleared} temp folder(s).`;
    },
  },
  {
    re: /^clean$/i, admin: true,
    fn: async (a, ctx) => {
      let cleared = 0;
      const d = require('os').tmpdir();
      try { for (const f of fs.readdirSync(d)) { if (/^(broken-|wabot-)/.test(f)) { fs.rmSync(d + '/' + f, { recursive: true, force: true }); cleared++; } } } catch {}
      return `🧹 Full temp wipe done (${cleared} folders).`;
    },
  },
  {
    re: /^remember\s+(.+)/i,
    fn: async (a, ctx) => {
      const fact = a[1].trim();
      const list = memStore.get(numFromJid(ctx.senderJid), []);
      list.push({ text: fact, at: Date.now() });
      memStore.set(numFromJid(ctx.senderJid), list.slice(-100));
      return `🧠 Noted: "${fact}"`;
    },
  },
  {
    re: /^(facts|myfacts)$/i,
    fn: async (a, ctx) => {
      const list = memStore.get(numFromJid(ctx.senderJid), []);
      if (!list.length) return 'No remembered facts yet.';
      return '🧠 *Your facts:*\n' + list.map((f, i) => `${i + 1}. ${f.text}`).join('\n');
    },
  },
  {
    re: /^scamcheck\s+(.+)/i,
    fn: async (a, ctx) => {
      const target = a[1].trim();
      const sussy = /(free\s*money|click\s*here|congratulations\s*you'?ve\s*won|claim\s*your\s*prize|verify\s*your\s*account|urgent|wire\s*transfer)/i;
      const risk = sussy.test(target) ? '⚠️ High risk — looks like a scam pattern.' : '✅ No obvious scam patterns detected.';
      return `🔍 *Scam check*\nTarget: ${target.slice(0, 80)}\n${risk}`;
    },
  },
  {
    re: /^lockdown$/i, owner: true,
    fn: async (a, ctx) => {
      set('lockdown', true);
      return '🔒 Lockdown ON — only the owner can DM the bot.';
    },
  },
  {
    re: /^unlockdown$/i, owner: true,
    fn: async (a, ctx) => {
      set('lockdown', false);
      return '🔓 Lockdown OFF.';
    },
  },
  {
    re: /^todo\s+(.+)/i,
    fn: async (a, ctx) => {
      const task = a[1].trim();
      const list = todoStore.get(numFromJid(ctx.senderJid), []);
      list.push({ text: task, done: false, at: Date.now() });
      todoStore.set(numFromJid(ctx.senderJid), list.slice(-100));
      return `✅ Added todo: "${task}" (${list.length} total)`;
    },
  },
  {
    re: /^todos$/i,
    fn: async (a, ctx) => {
      const list = todoStore.get(numFromJid(ctx.senderJid), []);
      if (!list.length) return 'No todos yet. Try "todo <task>".';
      return '📋 *Your todos:*\n' + list.map((t, i) => `${i + 1}. ${t.done ? '✅' : '⬜'} ${t.text}`).join('\n');
    },
  },
  {
    re: /^schedule\s+(.+?)\s+(?:in|at)\s+(.+)/i, owner: true,
    fn: async (a, ctx) => {
      const msgText = a[1].trim();
      const when = a[2].trim();
      let ms = 0;
      const inMatch = when.match(/^(\d+)\s*(s|m|h|min|sec|secs|mins|hrs|hour|minute|second)?s?\s*$/i);
      if (inMatch) {
        const n = parseInt(inMatch[1], 10);
        const unit = (inMatch[2] || 'm').toLowerCase().replace(/s$/,'');
        ms = unit === 's' ? n * 1000 : unit === 'h' ? n * 3600000 : n * 60000;
      } else {
        // "at HH:MM" or "at HH:MM AM/PM"
        const tm = when.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (tm) {
          let h = parseInt(tm[1], 10), min = parseInt(tm[2], 10);
          const ap = (tm[3] || '').toLowerCase();
          if (ap === 'pm' && h < 12) h += 12;
          if (ap === 'am' && h === 12) h = 0;
          const now = new Date();
          const target = new Date(now); target.setHours(h, min, 0, 0);
          ms = target - now;
          if (ms <= 0) ms += 86400000;
        }
      }
      if (!ms || ms < 1000) return '❌ Could not parse that time. Try "schedule <msg> in 10 min" or "schedule <msg> at 6:30pm".';
      const { Collection } = require('../db');
      const schedStore = new Collection('scheduled', { list: [] });
      const list = schedStore.get('list', []);
      list.push({ chatId: ctx.chatId, text: msgText, at: Date.now() + ms, id: 's' + Date.now() });
      schedStore.set('list', list.slice(-200));
      return `⏰ Scheduled for ${new Date(Date.now() + ms).toLocaleTimeString()} (${Math.round(ms/60000)} min from now).`;
    },
  },
  {
    re: /^backup$/i, owner: true,
    fn: async (a, ctx) => {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      const dir = path.join(__dirname, '..', '..', 'data');
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          try { zip.addFile('data/' + f, fs.readFileSync(path.join(dir, f))); } catch {}
        }
      }
      const out = path.join(os.tmpdir(), `backup_${Date.now()}.zip`);
      zip.writeZip(out);
      const buf = fs.readFileSync(out);
      await ctx.sock.sendMessage(ctx.chatId, { document: buf, mimetype: 'application/zip', fileName: `backup-${Date.now()}.zip`, caption: '💾 Bot backup (config, memory, economy, notes)' });
      fs.unlink(out, () => {});
      return null;
    },
  },
  {
    re: /^visit\s+(.+)/i,
    fn: async (a, ctx) => {
      const url = a[1].trim().startsWith('http') ? a[1].trim() : 'https://' + a[1].trim();
      try {
        const https = require('https');
        return await new Promise((resolve) => {
          const mod = url.startsWith('https') ? https : require('http');
          const req = mod.request(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              const isJson = /application\/json/.test(res.headers['content-type'] || '');
              if (isJson) resolve(`🌐 *${url}*\n${data.slice(0, 1500)}`);
              else {
                // strip tags for a readable text preview
                const text = data.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                resolve(`🌐 *${url}*\n${text.slice(0, 1500) || '(empty page)'}`);
              }
            });
          });
          req.on('error', () => resolve(`🌐 Could not fetch ${url}.`));
          req.on('timeout', () => { req.destroy(); resolve(`🌐 Timed out fetching ${url}.`); });
          req.end();
        });
      } catch { return `🌐 Could not fetch ${url}.`; }
    },
  },
  {
    re: /^imgsearch\s+(.+)/i,
    fn: async (a, ctx) => {
      const q = a[1].trim();
      const url = `https://source.unsplash.com/600x400/?${encodeURIComponent(q)}`;
      try {
        await ctx.sock.sendMessage(ctx.chatId, { image: { url }, caption: `🖼 ${q}` });
        return null;
      } catch { return '❌ Could not fetch image.'; }
    },
  },
  {
    re: /^define\s+(.+)/i,
    fn: async (a, ctx) => {
      const word = a[1].trim();
      const r = await httpJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (Array.isArray(r) && r[0] && r[0].meanings) {
        const defs = r[0].meanings.slice(0, 2).map((m) => `• (${m.partOfSpeech}) ${m.definitions[0]?.definition || ''}`).join('\n');
        return `📖 *${word}*\n${defs}`;
      }
      return `❌ No definition found for "${word}".`;
    },
  },
  {
    re: /^expense\s+(.+)/i,
    fn: async (a, ctx) => {
      const entry = a[1].trim();
      const m = entry.match(/^(.+?)\s+([\d.]+)$/);
      if (!m) return '❌ Usage: expense <label> <amount>, e.g. "expense lunch 15.50"';
      const list = expenseStore.get(numFromJid(ctx.senderJid), []);
      list.push({ label: m[1].trim(), amount: parseFloat(m[2]), at: Date.now() });
      expenseStore.set(numFromJid(ctx.senderJid), list.slice(-200));
      const total = list.reduce((s, x) => s + x.amount, 0);
      return `💰 Logged ${m[1].trim()}: ${m[2]}. Total: ${total.toFixed(2)}`;
    },
  },
  {
    re: /^expenses$/i,
    fn: async (a, ctx) => {
      const list = expenseStore.get(numFromJid(ctx.senderJid), []);
      if (!list.length) return 'No expenses logged yet. Try "expense <label> <amount>".';
      const total = list.reduce((s, x) => s + x.amount, 0);
      return '💰 *Expenses:*\n' + list.slice(-10).map((x) => `• ${x.label}: ${x.amount}`).join('\n') + `\n\nTotal: ${total.toFixed(2)}`;
    },
  },
  {
    re: /^summary$/i,
    fn: async (a, ctx) => {
      const hist = memory.get(ctx.chatId) || [];
      if (!hist.length) return 'No conversation history to summarize.';
      const recent = hist.slice(-6).map((h) => `${h.role}: ${h.content}`).join('\n');
      return `📝 *Recent conversation:*\n${recent.slice(0, 1500)}`;
    },
  },
  {
    re: /^update$/i, owner: true,
    fn: async (a, ctx) => {
      try {
        const r = await httpJson('https://api.github.com/repos/your-repo/broken/commits?per_page=1');
        return '🔄 Latest bot version info not configured for auto-update. Manual: pull latest code and restart.';
      } catch { return '🔄 Could not check for updates.'; }
    },
  },
  {
    re: /^debug$/i, owner: true,
    fn: async (a, ctx) => {
      const mem = process.memoryUsage();
      return `🔧 *Debug*\nUptime: ${Math.floor(process.uptime())}s\nRSS: ${Math.round(mem.rss / 1048576)}MB\nHeap: ${Math.round(mem.heapUsed / 1048576)}MB\nMsgCount: ${process._msgCount || 0}\nNode: ${process.version}`;
    },
  },
  {
    re: /^logs$/i, owner: true,
    fn: async (a, ctx) => {
      try {
        const logFile = path.join(__dirname, '..', '..', 'logs.txt');
        if (fs.existsSync(logFile)) return `📄 Recent logs:\n${fs.readFileSync(logFile, 'utf8').slice(-1500)}`;
      } catch {}
      return '📄 No log file found.';
    },
  },
  {
    re: /^stats$/i, owner: true,
    fn: async (a, ctx) => {
      const up = process.uptime();
      const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60);
      const mem = process.memoryUsage();
      let groupCount = 'n/a';
      try { groupCount = Object.keys(await ctx.sock.groupFetchAllParticipating()).length; } catch {}
      return `📊 *Bot stats*\n⏱️ Uptime: ${h}h ${m}m\n💾 RAM: ${(mem.rss / 1024 / 1024).toFixed(0)}MB\n👥 Groups: ${groupCount}\n🧵 Node: ${process.version}`;
    },
  },
  {
    re: /^model\s*(\S+)?$/i, owner: true,
    fn: async (a, ctx) => {
      const { getActiveProvider, setActiveProvider, listProviders } = require('../ai/client');
      if (!a[1]) {
        const ready = listProviders().filter((p) => p.hasKey).length;
        return `🧠 Brain status: ready. ${ready} configured provider(s) available.`;
      }
      const res = setActiveProvider(a[1].toLowerCase());
      if (!res.ok) return '❌ Model switch failed. Check the configured model aliases/API keys.';
      return '✅ Brain switched successfully. Takes effect on the next message.';
    },
  },
  {
    re: /^addcmd\s+"?([^"\n]+?)"?\s*=\s*([\s\S]+)$/i, owner: true,
    fn: async (a, ctx) => {
      const res = require('../features/customCommands').add(a[1], a[2]);
      if (!res.ok) return `❌ ${res.error}`;
      return `✅ Custom command added: "${res.trigger}" → (your response)`;
    },
  },
  {
    re: /^delcmd\s+"?([^"\n]+?)"?\s*$/i, owner: true,
    fn: async (a, ctx) => {
      const res = require('../features/customCommands').remove(a[1]);
      if (!res.ok) return `❌ ${res.error}`;
      return `✅ Removed custom command "${a[1].trim().toLowerCase()}".`;
    },
  },
  {
    re: /^listcmd(s)?$/i, owner: true,
    fn: async (a, ctx) => {
      const triggers = require('../features/customCommands').list();
      if (!triggers.length) return '📭 No custom commands set yet. Add one with: addcmd "trigger" = response text';
      return `📋 *Custom commands* (${triggers.length}):\n${triggers.map((t) => `• ${t}`).join('\n')}`;
    },
  },
  {
    re: /^starboard\s*(on|off)?$/i, admin: true,
    fn: async (a, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Only works in a group.';
      if (!a[1]) {
        const s = starboard.getSettings(ctx.chatId);
        return `⭐ Starboard is ${s.enabled ? 'ON' : 'OFF'}.\nEmoji: ${s.emoji} | Threshold: ${s.threshold}${s.targetChatId ? `\nPosting to a separate chat (set).` : '\nPosting in this same group.'}`;
      }
      starboard.updateSettings(ctx.chatId, { enabled: a[1].toLowerCase() === 'on' });
      return `⭐ Starboard ${a[1].toLowerCase() === 'on' ? 'enabled' : 'disabled'} for this group.`;
    },
  },
  {
    re: /^starboard\s+emoji\s+(\S+)$/i, admin: true,
    fn: async (a, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Only works in a group.';
      starboard.updateSettings(ctx.chatId, { emoji: a[1] });
      return `⭐ Starboard emoji set to ${a[1]}.`;
    },
  },
  {
    re: /^starboard\s+threshold\s+(\d+)$/i, admin: true,
    fn: async (a, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Only works in a group.';
      const n = Math.max(1, parseInt(a[1], 10));
      starboard.updateSettings(ctx.chatId, { threshold: n });
      return `⭐ Starboard threshold set to ${n} reactions.`;
    },
  },
  {
    re: /^leaderboard\s+schedule\s+(daily|weekly|off)(?:\s+(level|economy|cards))?$/i, admin: true,
    fn: async (a, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Only works in a group.';
      const scheduledLeaderboard = require('../features/scheduledLeaderboard');
      const freq = a[1].toLowerCase();
      if (freq === 'off') {
        scheduledLeaderboard.updateSettings(ctx.chatId, { enabled: false });
        return '📅 Scheduled leaderboard posts turned off for this group.';
      }
      const kind = (a[2] || 'level').toLowerCase();
      scheduledLeaderboard.updateSettings(ctx.chatId, { enabled: true, frequency: freq, kind });
      return `📅 Will post the ${kind} leaderboard ${freq} in this group.`;
    },
  },
  {
    re: /^reload$/i, owner: true,
    fn: async (a, ctx) => {
      try {
        delete require.cache[require.resolve('../config')];
        require('../config');
        return '♻️ Config reloaded from disk. (Code changes still need a restart.)';
      } catch (e) { return `❌ Reload failed: ${e.message}`; }
    },
  },
  {
    re: /^(listgroups|listgc|mygroups)$/i, owner: true,
    fn: async (a, ctx) => {
      try {
        const groups = await ctx.sock.groupFetchAllParticipating();
        const list = Object.values(groups);
        if (!list.length) return '📭 Not in any groups.';
        return `👥 *In ${list.length} groups:*\n` + list.slice(0, 40).map((g) => `• ${g.subject} (${g.participants?.length || 0} members)`).join('\n');
      } catch (e) { return `❌ Could not list groups: ${e.message}`; }
    },
  },
  {
    re: /^vote\s+(.+)/i,
    fn: async (a, ctx) => {
      const topic = a[1].trim();
      const poll = new Collection(`poll_${ctx.chatId.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`, { yes: 0, no: 0, topic, voters: {}, open: true, id: Date.now() });
      await ctx.sock.sendMessage(ctx.chatId, { poll: { name: `🗳 ${topic}`, values: ['Yes', 'No'] } });
      global._polls = global._polls || {};
      global._polls[pollKey(ctx.chatId)] = poll;
      return null;
    },
  },
  {
    re: /^habit\s+(.+)/i,
    fn: async (a, ctx) => {
      const name = a[1].trim();
      const habits = habitStore.get(numFromJid(ctx.senderJid), {});
      const today = new Date().toISOString().slice(0, 10);
      habits[name] = habits[name] || { streak: 0, last: null, days: [] };
      if (habits[name].last === today) return `✅ "${name}" already checked in today. Streak: ${habits[name].streak} days`;
      if (habits[name].last && new Date(habits[name].last).getTime() === new Date(today).getTime() - 86400000) {
        habits[name].streak++;
      } else {
        habits[name].streak = 1;
      }
      habits[name].last = today;
      habits[name].days.push(today);
      habitStore.set(numFromJid(ctx.senderJid), habits);
      return `🔥 "${name}" checked in! Streak: ${habits[name].streak} day${habits[name].streak > 1 ? 's' : ''} 🔥`;
    },
  },
  {
    re: /^habits$/i,
    fn: async (a, ctx) => {
      const habits = habitStore.get(numFromJid(ctx.senderJid), {});
      const entries = Object.entries(habits);
      if (!entries.length) return 'No habits tracked yet. Try "habit <name>".';
      return '🔥 *Your habits:*\n' + entries.map(([n, h]) => `• ${n}: ${h.streak} day streak`).join('\n');
    },
  },
  {
    re: /^gist\s+(.+)/i,
    fn: async (a, ctx) => {
      const content = a[1].trim();
      try {
        const out = path.join(os.tmpdir(), 'gist_note.txt');
        fs.writeFileSync(out, content);
        const { execFileP } = require('../utils/exec');
        const res = await execFileP('curl', ['-s', '-F', `file=@${out}`, 'https://tmpfiles.org/api/v1/upload']);
        fs.unlink(out, () => {});
        const j = JSON.parse(res.stdout);
        if (j.data?.url) return `🔗 Saved: ${j.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/')}`;
        return '❌ Could not upload note.';
      } catch { return '❌ Could not create gist.'; }
    },
  },
  {
    re: /^mute-user\s+(.+)/i, admin: true,
    fn: async (a, ctx) => {
      const parts = a[1].trim().split(/\s+/);
      const target = (parts[0].match(/\d+/) || [''])[0];
      const timeStr = parts.slice(1).join(' ');
      let minutes = 10;
      const tm = timeStr.match(/(\d+)\s*(m|min|h|hr|s|sec)/i);
      if (tm) {
        const n = parseInt(tm[1], 10);
        const u = (tm[2] || 'm').toLowerCase();
        minutes = u === 'h' || u === 'hr' ? n * 60 : u === 's' ? n / 60 : n;
      }
      if (!target) return '❌ Usage: mute-user <@phone> [duration e.g. 10m / 1h]';
      const muteStore = new Collection('timed_mutes', {});
      const until = Date.now() + minutes * 60000;
      muteStore.set(target, until);
      return `🔇 Muted ${target} for ${minutes} min (until ${new Date(until).toLocaleTimeString()}).`;
    },
  },
  {
    re: /^remind\s+(?:me\s+)?at\s+(.+)/i,
    fn: async (a, ctx) => {
      const when = a[1].trim();
      return '⏰ Use "remind <time> <message>" — or I can set it if you give me "remind me to <task> in <n> <unit>".';
    },
  },
  {
    re: /^(search|google)\s+(.+)/i,
    fn: async (a, ctx) => {
      const q = a[2].trim();
      const res = await websearch2.searchBest(q, 5);
      if (!res.length) return `❌ No results for "${q}".`;
      return `🔍 *Results for: ${q}*\n` + res.map((r, i) => `${i + 1}. *${r.title}*\n${r.snippet}\n${r.url}`).join('\n\n');
    },
  },
  {
    re: /^(open|fetch|readlink|get)\s+(https?:\/\/\S+|www\.\S+)/i,
    fn: async (a, ctx) => {
      let url = a[2];
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const res = await websearch2.fetchContent(url);
      if (!res.ok) return `❌ ${res.error}`;
      return `🌐 *${url}*\n\n${res.content || '(no readable content)'}`;
    },
  },
  {
    re: /^weather\s+(.+)/i,
    fn: async (a, ctx) => {
      const city = a[1].trim();
      const r = await httpJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
      if (!r || !r.current_condition) return `❌ No weather for ${city}.`;
      const c = r.current_condition[0];
      const temp = c.temp_C;
      const desc = c.weatherDesc?.[0]?.value || 'N/A';
      const hum = c.humidity;
      return `🌤 *${city}*\n🌡 ${temp}°C · ${desc}\n💧 Humidity: ${hum}%\n📍 ${r.nearest_area?.[0]?.areaName?.[0]?.value || city}`;
    },
  },
  {
    re: /^translate\s+(.+)/i,
    fn: async (a, ctx) => {
      const text = a[1].trim();
      try {
        const src = text.match(/^([a-z]{2})\s+(.+)/i);
        const q = src ? src[2] : text;
        const tl = src ? src[1].toLowerCase() : 'en';
        const r = await httpJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${tl === 'en' ? 'en|en' : 'en|' + tl}`);
        const out = r?.responseData?.translatedText;
        return out && !/QUERY LENGTH/i.test(out) ? `🌐 *${tl}:* ${out}` : `❌ Could not translate.`;
      } catch { return '❌ Translation failed.'; }
    },
  },
  {
    re: /^wiki\s+(.+)/i,
    fn: async (a, ctx) => {
      const q = a[1].trim();
      const r = await httpJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.replace(/ /g, '_'))}`);
      if (r && r.title && r.extract) return `📖 *${r.title}*\n${r.extract.slice(0, 1000)}\n\n${r.content_urls?.desktop?.page || ''}`;
      return `❌ No wiki article found for "${q}".`;
    },
  },
  {
    re: /^lyrics\s+(.+)/i,
    fn: async (a, ctx) => {
      const q = a[1].trim();
      const r = await httpJson(`https://api.lyrics.ovh/v1/${q.split(' - ')[0] || q}/${q.split(' - ')[1] || q}`);
      if (r && r.lyrics) return `🎵 *${q}*\n\n${r.lyrics.slice(0, 1000)}`;
      return `❌ No lyrics found for "${q}". Try "lyrics artist - song".`;
    },
  },
  {
    re: /^invite$/i, admin: true,
    fn: async (a, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Only works in a group.';
      try {
        const code = await ctx.sock.groupInviteCode(ctx.chatId);
        return `🔗 Group invite: https://chat.whatsapp.com/${code}`;
      } catch { return '❌ Could not fetch invite (need admin).'; }
    },
  },
  {
    re: /^screenshot\s+(https?:\/\/\S+)/i,
    fn: async (a, ctx) => {
      const url = a[1];
      try {
        await ctx.sock.sendMessage(ctx.chatId, { image: { url: `https://image.thum.io/get/width/600/crop/800/${encodeURIComponent(url)}` }, caption: `📷 Screenshot of ${url}` });
        return null;
      } catch { return '❌ Could not screenshot that site.'; }
    },
  },
  {
    re: /^anime\s+(.+)/i,
    fn: async (a, ctx) => {
      const q = a[1].trim();
      const r = await httpJson(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=3`);
      const d = r && r.data;
      if (!d || !d.length) return `❌ No anime found for "${q}".`;
      return `🎌 *Anime results for ${q}:*\n` + d.slice(0, 3).map((an, i) => `${i + 1}. *${an.title}*\n📅 ${an.year || 'N/A'} · ⭐ ${an.score || 'N/A'}/10\n${an.synopsis ? an.synopsis.slice(0, 120) + '...' : ''}`).join('\n\n');
    },
  },
  {
    re: /^(animechar|anime-char|randomchar|animecharacter)\s*$/i,
    fn: async (a, ctx) => {
      const chars = [
        ['Rin', 'Ice queen', 'cool, reserved, secretly caring', 'ice blue hair, piercing eyes'],
        ['Kai', 'Blazing striker', 'hot-headed, loyal, impulsive', 'crimson hair, sharp fang'],
        ['Sora', 'Sky knight', 'dreamy, brave, soft-spoken', 'silver hair, gentle smile'],
        ['Yuki', 'Silent shadow', 'mysterious, precise, brooding', 'jet-black hair, scar over eye'],
        ['Aya', 'Thunder mage', 'playful, electric, energetic', 'golden hair, bright grin'],
        ['Ren', 'Beast tamer', 'wild, strong, protective', 'amber eyes, wolf companion'],
      ];
      const c = chars[Math.floor(Math.random() * chars.length)];
      // try to fetch a waifu image to go with it
      try {
        await ctx.sock.sendMessage(ctx.chatId, { image: { url: `https://api.waifu.pics/sfw/waifu` }, caption: `🎌 *${c[0]} — ${c[1]}*\n\n🧬 Personality: ${c[2]}\n✨ Looks: ${c[3]}` });
        return null;
      } catch {
        return `🎌 *${c[0]} — ${c[1]}*\n\n🧬 Personality: ${c[2]}\n✨ Looks: ${c[3]}`;
      }
    },
  },
  {
    re: /^(waifu|animegirl)\s*$/i,
    fn: async (a, ctx) => {
      try {
        await ctx.sock.sendMessage(ctx.chatId, { image: { url: 'https://api.waifu.pics/sfw/waifu' }, caption: '🎀 Here you go!' });
        return null;
      } catch { return '❌ Could not fetch waifu image.'; }
    },
  },
  {
    re: /^movie\s+(.+)/i,
    fn: async (a, ctx) => {
      const q = a[1].trim();
      const r = await httpJson(`https://api.popcat.xyz/imdb?q=${encodeURIComponent(q)}`);
      if (r && r.title) return `🎬 *${r.title}* (${r.year || 'N/A'})\n⭐ ${r.rating || 'N/A'}/10\n⏱ ${r.runtime || 'N/A'}\n🎭 ${r.genres || ''}\n📖 ${(r.plot || '').slice(0, 200)}\n\n${r.poster || ''}`;
      return `❌ No movie found for "${q}".`;
    },
  },
  {
    re: /^(b64|base64)\s+(encode|decode)\s+(.+)/i,
    fn: async (a, ctx) => {
      const mode = a[2].toLowerCase();
      const data = a[3];
      try {
        return mode === 'encode'
          ? `🔐 *Encoded:* ${Buffer.from(data).toString('base64')}`
          : `🔓 *Decoded:* ${Buffer.from(data, 'base64').toString('utf8')}`;
      } catch { return '❌ Could not process.'; }
    },
  },
  {
    re: /^figlet\s+(.+)/i,
    fn: async (a, ctx) => {
      const text = a[1].trim().toUpperCase();
      const font = { A: '█▀█', B: '▄▀█', C: '█▄█', D: '█▀▄', E: '█▀█', F: '█▀▄' };
      const line1 = text.split('').map((c) => font[c] || '░░░').join(' ');
      return `🎨 *ASCII:*\n\`\`\`${text}\`\`\`\n${line1}`;
    },
  },
  {
    re: /^hashtags\s+(.+)/i,
    fn: async (a, ctx) => {
      const words = a[1].trim().split(/\s+/);
      const tags = words.map((w) => '#' + w.replace(/[^a-zA-Z0-9]/g, '')).join(' ');
      return `🏷 *Hashtags:*\n${tags}\n\nAlso: #${words[0] || ''} #viral #foryou #trending`;
    },
  },
  {
    re: /^(tiktok|tt|tik)\s+(https?:\/\/\S+)/i,
    fn: async (a, ctx) => {
      const url = a[2];
      await ctx.sock.sendMessage(ctx.chatId, { text: '⬇️ Fetching TikTok...' });
      try {
        const r = await new Promise((resolve) => {
          https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            const loc = res.headers.location;
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ loc, d }));
          }).on('error', () => resolve({}));
        });
        return `🎵 Found TikTok — download URL resolving may need extra headers. Best via /dl aio downloader command.`;
      } catch { return '❌ Could not fetch TikTok.'; }
    },
  },
  {
    re: /^emoji(?:mix)?\s+(\S+)\s*(\S*)/i,
    fn: async (a, ctx) => {
      const e1 = a[1], e2 = a[2];
      if (!e2) return '❌ Usage: emojimix 😀 😂';
      const r = await httpJson(`https://emojimix-api.justcal.me/${encodeURIComponent(e1)}/${encodeURIComponent(e2)}`);
      if (r) { await ctx.sock.sendMessage(ctx.chatId, { image: { url: r.url || r }, caption: require('../utils/chatFont').apply(ctx.chatId, `${e1} + ${e2}`) }); return null; }
      return '❌ Could not mix those emojis.';
    },
  },

  // ---------- extra owner ops ----------
  {
    re: /^owners?$/i, owner: true,
    fn: async () => {
      const ids = (config.ownerIds || []).map(String);
      return `👑 *Owners*\n${ids.map((id, i) => `${i + 1}. ${id}`).join('\n') || 'none'}`;
    },
  },
  {
    re: /^addowner\s+(\d+)/i, owner: true,
    fn: async (args) => {
      const id = String(args[1]).replace(/\D/g, '');
      if (!/^\d{7,15}$/.test(id)) return '❌ Provide a valid country-code phone number.';
      if (roles.isOwner(id)) return `ℹ️ ${id} is already an owner.`;
      roles.addOwner(id);
      return `✅ Owner role added for +${id}.`;
    },
  },
  {
    re: /^stats$/i, owner: true,
    fn: async () => {
      const s = Math.floor(process.uptime());
      const mem = process.memoryUsage();
      return `📊 *Runtime stats*\nUptime: ${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m\nRSS: ${Math.round(mem.rss/1024/1024)}MB\nMode: ${getGlobalMode()}\nMsgs: ${process._msgCount || 0}`;
    },
  },
  {
    re: /^setname\s+(.+)/i, owner: true,
    fn: async (args, ctx) => {
      try {
        await ctx.sock.updateProfileName(args[1].trim().slice(0, 25));
        return `✅ Profile name set to: ${args[1].trim().slice(0, 25)}`;
      } catch (e) { return `❌ ${e.message}`; }
    },
  },
  {
    re: /^setstatus\s+(.+)/i, owner: true,
    fn: async (args, ctx) => {
      try {
        await ctx.sock.updateProfileStatus(args[1].trim().slice(0, 139));
        return `✅ Status updated.`;
      } catch (e) { return `❌ ${e.message}`; }
    },
  },
  {
    re: /^blocklist$/i, owner: true,
    fn: async (args, ctx) => {
      try {
        const list = await ctx.sock.fetchBlocklist();
        if (!list?.length) return 'Blocklist empty.';
        return '*Blocked:*\n' + list.slice(0, 40).map((j, i) => `${i + 1}. ${j}`).join('\n');
      } catch (e) { return `❌ ${e.message}`; }
    },
  },
  {
    re: /^clearsession$/i, owner: true,
    fn: async () => '⚠️ To clear WhatsApp session, stop the process, delete the auth folder, and restart for a new pair.',
  },
  {
    re: /^groups?$/i, owner: true,
    fn: async (args, ctx) => {
      const groups = await ctx.sock.groupFetchAllParticipating();
      const ids = Object.keys(groups);
      return `*In ${ids.length} groups:*\n` + ids.slice(0, 30).map((id, i) => `${i + 1}. ${groups[id].subject || id}`).join('\n');
    },
  },
  {
    re: /^invite$/i, admin: true,
    fn: async (args, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Group only.';
      try {
        const code = await ctx.sock.groupInviteCode(ctx.chatId);
        return `🔗 https://chat.whatsapp.com/${code}`;
      } catch (e) { return `❌ ${e.message} (need admin)`; }
    },
  },
  {
    re: /^revokeinvite$/i, admin: true,
    fn: async (args, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Group only.';
      try {
        await ctx.sock.groupRevokeInvite(ctx.chatId);
        const code = await ctx.sock.groupInviteCode(ctx.chatId);
        return `🔄 Invite revoked. New: https://chat.whatsapp.com/${code}`;
      } catch (e) { return `❌ ${e.message}`; }
    },
  },
  {
    re: /^poll\s+(.+)$/i, admin: true,
    fn: async (args, ctx) => {
      if (!isGroupJid(ctx.chatId)) return 'Group only.';
      const parts = args[1].split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 3) return 'Usage: poll Question | option1 | option2 | option3';
      const [q, ...opts] = parts;
      try {
        await ctx.sock.sendMessage(ctx.chatId, {
          poll: { name: q, values: opts.slice(0, 12), selectableCount: 1 },
        });
        return null;
      } catch (e) { return `❌ Poll failed: ${e.message}`; }
    },
  },
];

// ---------- remember-trigger check (runs on every message) ----------
function checkTrigger(chatId, text) {
  const lower = (text || '').toLowerCase();
  for (const [k, v] of Object.entries(triggers.all())) {
    const [c, word] = k.split(':');
    if (c === numFromJid(chatId) && lower.includes(word)) return v;
  }
  return null;
}

// ---------- main route ----------
async function route(sock, jid, senderJid, text, mentions = []) {
  const t = (text || '').trim();

  // remember-trigger auto-replies (anyone can trigger, admin sets)
  const trig = checkTrigger(jid, t);
  if (trig) return { handled: true, text: trig };

  const owner = roles.isOwner(senderJid);
  for (const cmd of COMMANDS) {
    if (!cmd.re.test(t)) continue;
    const args = t.match(cmd.re);
    if (cmd.owner && !owner) return { handled: true, text: messageLayout.accessDenied('owner') };
    if (cmd.admin) {
      const isAdmin = roles.isSudo(senderJid) || (isGroupJid(jid) && await ctxGroupAdmin(sock, jid, senderJid));
      if (!isAdmin) return { handled: true, text: messageLayout.accessDenied('admin') };
    }
    const ctx = { sock, chatId: jid, senderJid, mentions, isGroup: String(jid).endsWith('@g.us') };
    const res = await cmd.fn(args, ctx);
    if (res === null) return { handled: true, text: null };
    return { handled: true, text: res };
  }
  return { handled: false };
}

// helper: check group admin via group metadata
async function ctxGroupAdmin(sock, jid, senderJid) {
  try {
    const meta = await sock.groupMetadata(jid);
    const map = jidResolver.buildMap(sock, { key: { participant: senderJid } }, meta);
    const resolved = jidResolver.resolve(senderJid, map);
    const candidates = new Set([String(senderJid), String(resolved)].filter(Boolean));
    const nums = new Set([...candidates].map(numFromJid).filter(Boolean));
    const p = (meta.participants || []).find((x) => {
      if (!x || !(x.admin === 'admin' || x.admin === 'superadmin')) return false;
      const ids = [x.id, x.jid, x.lid, x.phoneNumber, x.participantAlt, x.participantPn].filter(Boolean).map(String);
      return ids.some(id => candidates.has(id)) || ids.map(numFromJid).filter(Boolean).some(n => nums.has(n));
    });
    return !!p;
  } catch { return false; }
}

// ---------- banned-member guard (runs on join) ----------
function isBanned(userJid) { return !!banned.get(numFromJid(userJid), false); }

module.exports = { route, isBanned, dmBlocked, isGlobalPrivate, isMaintenance, getGlobalMode, getResponseScope, chatBlocked, store, warns, banned, repairModeState, set };

});

runtime.define("reminders", "reminders.js", function(module, exports, require, __filename, __dirname) {
// Persisted via db.js (a plain JSON file), so reminders survive process restarts — a
// background interval (startScheduler) polls for due reminders and delivers them.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');
const logger = require('../logger');

const store = new Collection('reminders', { list: [] });

function _all() {
  return store.get('list', []);
}

function schedule({ chatId, userJid, dueAt, text }) {
  const list = _all();
  const item = {
    id: `r${Date.now()}${Math.floor(Math.random() * 10000)}`,
    chatId,
    userJid: numFromJid(userJid),
    text: String(text || '').slice(0, 500),
    dueAt,
    createdAt: Date.now(),
  };
  list.push(item);
  store.set('list', list);
  return item;
}

function listFor(userJid) {
  const key = numFromJid(userJid);
  return _all().filter((r) => r.userJid === key);
}

function cancel(id, userJid) {
  const key = numFromJid(userJid);
  const list = _all();
  const idx = list.findIndex((r) => r.id === id && r.userJid === key);
  if (idx === -1) return false;
  list.splice(idx, 1);
  store.set('list', list);
  return true;
}

function takeDue(now = Date.now()) {
  const list = _all();
  const due = list.filter((r) => r.dueAt <= now);
  if (due.length) {
    const remaining = list.filter((r) => r.dueAt > now);
    store.set('list', remaining);
  }
  return due;
}

// A single long-lived interval that always sends through the CURRENT socket — startScheduler
// is safe to call again after every reconnect (it just updates which socket to use).
const CHECK_MS = 15000;
let activeSock = null;
let timer = null;

function startScheduler(sock) {
  activeSock = sock;
  if (timer) return;
  timer = setInterval(async () => {
    let due = [];
    try {
      due = takeDue();
    } catch (e) {
      logger.error({ err: e.message }, 'reminders: failed to check due reminders');
      return;
    }
    for (const r of due) {
      if (!activeSock) continue;
      try {
        await activeSock.sendMessage(r.chatId, {
          text: `⏰ Reminder for @${r.userJid}: ${r.text}`,
          mentions: [`${r.userJid}@s.whatsapp.net`],
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'reminders: failed to deliver reminder');
      }
    }
  }, CHECK_MS);
}

module.exports = { schedule, listFor, cancel, startScheduler };

});

runtime.define("scheduledBroadcast", "scheduledBroadcast.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');
const logger = require('../logger');

const jobs = new Collection('scheduled_broadcasts', {});
let timer = null;
let sockRef = null;

function list() {
  return Object.entries(jobs.all() || {}).map(([id, j]) => ({ id, ...j }));
}

function schedule({ text, whenMs, groupJids = [], repeatHours = 0 }) {
  const id = `bc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    text: String(text || '').slice(0, 4000),
    when: Number(whenMs) || Date.now() + 60000,
    groups: Array.isArray(groupJids) ? groupJids : [],
    repeatHours: Number(repeatHours) || 0,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return { ok: true, id, job };
}

function cancel(id) {
  if (!jobs.get(id, null)) return { ok: false, error: 'Not found' };
  jobs.delete(id);
  return { ok: true };
}

async function tick() {
  if (!sockRef) return;
  const now = Date.now();
  for (const [id, job] of Object.entries(jobs.all() || {})) {
    if (!job || job.when > now) continue;
    const targets = job.groups?.length
      ? job.groups
      : Object.keys((await sockRef.groupFetchAllParticipating().catch(() => ({}))) || {});
    for (const g of targets.slice(0, 50)) {
      try {
        await sockRef.sendMessage(g, { text: job.text });
      } catch (e) {
        logger.warn({ err: e.message, g }, 'broadcast send failed');
      }
    }
    if (job.repeatHours > 0) {
      job.when = now + job.repeatHours * 3600000;
      jobs.set(id, job);
    } else {
      jobs.delete(id);
    }
  }
}

function start(sock) {
  sockRef = sock;
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick().catch(() => {}), 30000);
  return true;
}

module.exports = { list, schedule, cancel, start, tick };

});

runtime.define("todos", "todos.js", function(module, exports, require, __filename, __dirname) {
'use strict';
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const store = new Collection('user_todos', {});

function _key(userId) {
  return String(numFromJid(userId) || userId || '').replace(/\D/g, '') || 'anon';
}

function _list(userId) {
  const key = _key(userId);
  const list = store.get(key, []);
  return Array.isArray(list) ? list : [];
}

function _save(userId, list) {
  store.set(_key(userId), list);
  return list;
}

function addTodo(userId, text, dueAt = null) {
  const list = _list(userId);
  const item = {
    id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    text: String(text || '').trim().slice(0, 500),
    done: false,
    dueAt: dueAt && Number.isFinite(Number(dueAt)) ? Number(dueAt) : null,
    createdAt: Date.now(),
  };
  if (!item.text) throw new Error('todo text is required');
  list.push(item);
  _save(userId, list);
  return item;
}

function listTodos(userId, includeDone = false) {
  const list = _list(userId);
  return includeDone ? list.slice() : list.filter((t) => !t.done);
}

function getTodos(userId) {
  return _list(userId);
}

function completeTodo(userId, id) {
  const list = _list(userId);
  const item = list.find((t) => t.id === String(id));
  if (!item) return { ok: false, error: `todo ${id} not found` };
  item.done = true;
  item.completedAt = Date.now();
  _save(userId, list);
  return { ok: true, todo: item };
}

function deleteTodo(userId, id) {
  const list = _list(userId);
  const next = list.filter((t) => t.id !== String(id));
  if (next.length === list.length) return { ok: false, error: `todo ${id} not found` };
  _save(userId, next);
  return { ok: true, removed: id };
}

function clearCompleted(userId) {
  const list = _list(userId);
  const cleaned = list.filter((t) => !t.done);
  _save(userId, cleaned);
  return { ok: true, removed: list.length - cleaned.length, remaining: cleaned.length };
}

module.exports = {
  addTodo,
  listTodos,
  getTodos,
  completeTodo,
  deleteTodo,
  clearCompleted,
};

});

runtime.define("userWorkspace", "userWorkspace.js", function(module, exports, require, __filename, __dirname) {
'use strict';

const fs = require('fs');
const path = require('path');
const { Collection } = require('../db');

const ROOT = path.join(process.cwd(), 'storage', 'workspaces');
fs.mkdirSync(ROOT, { recursive: true });

const memStore = new Collection('user_workspace_mem', {});

function safeId(userJid) {
  const s = String(userJid || 'anon')
    .split('@')[0]
    .split(':')[0]
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 48);
  return s || 'anon';
}

/** Absolute path to this user's private sandbox (created on demand). */
function workspaceRoot(userJid) {
  const id = safeId(userJid);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  // repos subfolder
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  return dir;
}

function reposDir(userJid) {
  const d = path.join(workspaceRoot(userJid), 'repos');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function getMemory(userJid) {
  const id = safeId(userJid);
  return memStore.get(id, { repos: [], lastRepo: null, notes: [] });
}

function setMemory(userJid, patch) {
  const id = safeId(userJid);
  const prev = getMemory(userJid);
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  memStore.set(id, next);
  return next;
}

function rememberRepo(userJid, info) {
  const mem = getMemory(userJid);
  const repos = Array.isArray(mem.repos) ? mem.repos.slice() : [];
  const entry = {
    path: info.path,
    name: info.name || path.basename(info.path || ''),
    url: info.url || '',
    at: Date.now(),
  };
  const rest = repos.filter((r) => r.path !== entry.path);
  rest.unshift(entry);
  while (rest.length > 20) rest.pop();
  return setMemory(userJid, { repos: rest, lastRepo: entry });
}

function resolveInside(userJid, relOrAbs) {
  const root = workspaceRoot(userJid);
  const target = path.resolve(root, relOrAbs || '.');
  if (!target.startsWith(path.resolve(root))) {
    throw new Error('Path escapes user sandbox');
  }
  return target;
}

function listRepos(userJid) {
  const dir = reposDir(userJid);
  try {
    return fs.readdirSync(dir).filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

module.exports = {
  workspaceRoot,
  reposDir,
  getMemory,
  setMemory,
  rememberRepo,
  resolveInside,
  listRepos,
  ROOT,
};

});
};
