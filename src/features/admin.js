'use strict';

module.exports = (runtime) => {
runtime.define("deletehandler", "deletehandler.js", function(module, exports, require, __filename, __dirname) {
const logger = require('../logger');
const { numFromJid } = require('../utils/helpers');
const autoreply = require('./autoreply');
const jidResolver = require('../utils/jidResolver');

function isDeleteCommand(text) {
  const t = String(text || '').trim();
  return /^(?:(?:broken|bot)\s+)?(?:please\s+)?(?:delete|remove|del)\s*(?:this|that|msg|message|it|status|the\s+status)?\s*$/i.test(t)
    || /^(?:(?:broken|bot)\s+)?(?:delete|remove)\s+(?:this|that)\s+(?:msg|message|status)\s*$/i.test(t)
    || /^(?:(?:broken|bot)\s+)?(?:delete|remove)\s+(?:the\s+)?(?:group\s+)?status\b/i.test(t)
    || /\b(?:delete|remove)\s+(?:this|that)\s+status\b/i.test(t);
}

function unwrapContext(message) {
  let cur = message || {};
  for (let i = 0; i < 8 && cur; i++) {
    const ctx =
      cur.extendedTextMessage?.contextInfo ||
      cur.imageMessage?.contextInfo ||
      cur.videoMessage?.contextInfo ||
      cur.audioMessage?.contextInfo ||
      cur.documentMessage?.contextInfo ||
      cur.stickerMessage?.contextInfo ||
      cur.contactMessage?.contextInfo;
    if (ctx?.stanzaId) return ctx;
    cur =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessage?.message ||
      cur.documentWithCaptionMessage?.message ||
      null;
  }
  return {};
}

function isBotIdentity(participant, botIds = []) {
  if (!participant) return false;
  const raw = String(participant);
  const n = numFromJid(raw);
  return botIds.some((id) => {
    const value = String(id || '');
    return value === raw || (n && numFromJid(value) === n);
  });
}

async function tryDelete(sock, jid, key) {
  // WhatsApp is picky about delete keys — try several shapes
  const attempts = [
    key,
    { remoteJid: jid, id: key.id, fromMe: !!key.fromMe, participant: key.participant },
    key.participant ? { remoteJid: jid, id: key.id, fromMe: false, participant: key.participant } : null,
    key.participant ? { remoteJid: jid, id: key.id, fromMe: true, participant: key.participant } : null,
  ].filter(Boolean);
  let lastErr;
  for (const k of attempts) {
    try {
      await sock.sendMessage(jid, { delete: k });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
}

async function handleDelete(sock, msg, deleteMessage, opts = {}) {
  try {
    const contextInfo = unwrapContext(msg.message);
    if (!contextInfo?.stanzaId) {
      return { success: false, message: '❌ Reply to the message you want removed, then say *delete*.' };
    }

    const botIds = [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid]
      .filter(Boolean)
      .map(String);
    const participantPn = contextInfo.participantPn || null;
    const participantAlt = contextInfo.participantAlt || null;
    const participant = participantPn || participantAlt || contextInfo.participant || undefined;

    const fromMe =
      !!contextInfo.quotedMessage?.key?.fromMe ||
      autoreply.isBotMessageReplied(msg) ||
      isBotIdentity(participant, botIds) ||
      isBotIdentity(participantAlt, botIds) ||
      isBotIdentity(participantPn, botIds);

    const base = {
      remoteJid: msg.key.remoteJid,
      id: String(contextInfo.stanzaId),
      fromMe,
    };

    // Try several key shapes — WhatsApp/Baileys is picky about participant format.
    const variants = [];
    const add = (k) => {
      const s = JSON.stringify(k);
      if (!variants.some((v) => JSON.stringify(v) === s)) variants.push(k);
    };
    add({ ...base });
    if (!fromMe && participant) add({ ...base, participant: String(participant) });
    if (!fromMe && participantPn) add({ ...base, participant: String(participantPn) });
    if (!fromMe && participantAlt) add({ ...base, participant: String(participantAlt) });
    if (!fromMe && contextInfo.participant) add({ ...base, participant: String(contextInfo.participant) });
    // Prefer PN over LID when both exist
    if (!fromMe && participantPn && String(participant || '').endsWith('@lid')) {
      add({ ...base, participant: String(participantPn) });
    }

    let lastErr = null;
    for (const key of variants) {
      try {
        if (typeof deleteMessage === 'function') {
          await deleteMessage(msg.key.remoteJid, key);
        } else {
          await tryDelete(sock, msg.key.remoteJid, key);
        }
        return { success: true, message: '✅ Message deleted.' };
      } catch (e) {
        lastErr = e;
        logger.warn({ err: e.message, key }, 'delete variant failed');
      }
    }
    return {
      success: false,
      message: `⚠️ Could not delete that message${lastErr ? `: ${lastErr.message}` : ''}. I may need admin rights, or the message is too old.`,
    };
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to delete message');
    return { success: false, message: `⚠️ Could not delete message: ${e.message}` };
  }
}

module.exports = { isDeleteCommand, handleDelete, unwrapContext };

});

runtime.define("groupAdmin", "groupAdmin.js", function(module, exports, require, __filename, __dirname) {
'use strict';

/**
 * Real WhatsApp group administration helpers (Baileys).
 * Replaces the previous compatibility stub so all group_* tools work.
 */

async function getMetadata(sock, jid) {
  if (!sock || !jid) throw new Error('sock and jid required');
  return sock.groupMetadata(jid);
}

async function kick(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'remove');
  return { ok: true, result: res };
}

async function add(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'add');
  const failed = (Array.isArray(res) ? res : []).filter(
    (r) => r.status && String(r.status) !== '200'
  );
  if (failed.length) {
    let inviteLink = null;
    try {
      const code = await sock.groupInviteCode(jid);
      if (code) inviteLink = `https://chat.whatsapp.com/${code}`;
    } catch (_) {}
    return {
      ok: false,
      error: 'Could not add member(s) (privacy or not on WhatsApp). Share the invite link instead.',
      inviteLink,
      result: res,
    };
  }
  return { ok: true, result: res };
}

async function promote(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'promote');
  return { ok: true, result: res };
}

async function demote(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'demote');
  return { ok: true, result: res };
}

async function setMuted(sock, jid, muted) {
  await sock.groupSettingUpdate(jid, muted ? 'announcement' : 'not_announcement');
  return { ok: true, muted: !!muted };
}

async function setInfoLocked(sock, jid, locked) {
  await sock.groupSettingUpdate(jid, locked ? 'locked' : 'unlocked');
  return { ok: true, locked: !!locked };
}

async function setSubject(sock, jid, subject) {
  await sock.groupUpdateSubject(jid, String(subject || '').slice(0, 100));
  return { ok: true };
}

async function setDescription(sock, jid, description) {
  await sock.groupUpdateDescription(jid, String(description || '').slice(0, 500));
  return { ok: true };
}

async function setPicture(sock, jid, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('picture buffer required');
  await sock.updateProfilePicture(jid, buffer);
  return { ok: true };
}

async function tagAllMentions(sock, jid) {
  const meta = await getMetadata(sock, jid);
  return (meta.participants || []).map((p) => p.id).filter(Boolean);
}

async function leaveGroup(sock, jid) {
  await sock.groupLeave(jid);
  return { ok: true };
}

async function acceptPendingRequests(sock, jid, count = 5) {
  let list = [];
  try {
    list = await sock.groupRequestParticipantsList(jid);
  } catch (e) {
    return { ok: false, error: e.message, accepted: 0 };
  }
  const toApprove = (list || []).slice(0, Math.max(1, Number(count) || 5)).map((p) => p.jid || p.id).filter(Boolean);
  if (!toApprove.length) return { ok: true, accepted: 0, note: 'No pending requests' };
  const res = await sock.groupRequestParticipantsUpdate(jid, toApprove, 'approve');
  return { ok: true, accepted: toApprove.length, result: res };
}

async function acceptAllPendingRequests(sock, jid) {
  let list = [];
  try {
    list = await sock.groupRequestParticipantsList(jid);
  } catch (e) {
    return { ok: false, error: e.message, accepted: 0 };
  }
  const toApprove = (list || []).map((p) => p.jid || p.id).filter(Boolean);
  if (!toApprove.length) return { ok: true, accepted: 0, note: 'No pending requests' };
  const res = await sock.groupRequestParticipantsUpdate(jid, toApprove, 'approve');
  return { ok: true, accepted: toApprove.length, result: res };
}

async function rejectAllPendingRequests(sock, jid) {
  let list = [];
  try {
    list = await sock.groupRequestParticipantsList(jid);
  } catch (e) {
    return { ok: false, error: e.message, rejected: 0 };
  }
  const toReject = (list || []).map((p) => p.jid || p.id).filter(Boolean);
  if (!toReject.length) return { ok: true, rejected: 0, note: 'No pending requests' };
  const res = await sock.groupRequestParticipantsUpdate(jid, toReject, 'reject');
  return { ok: true, rejected: toReject.length, result: res };
}

module.exports = {
  getMetadata, kick, add, promote, demote, setMuted, setInfoLocked,
  setSubject, setDescription, setPicture, tagAllMentions, leaveGroup,
  acceptPendingRequests, acceptAllPendingRequests, rejectAllPendingRequests,
};

});

runtime.define("moderation", "moderation.js", function(module, exports, require, __filename, __dirname) {
// These checks run BEFORE the message ever reaches the AI agent, so they are
// instant and deterministic (a bad actor can't talk the LLM out of them).
const { Collection } = require('../db');
const { containsLink, containsGroupInviteLink } = require('../utils/helpers');

const settings = new Collection('group_settings', {});

const DEFAULTS = {
  antilink: false, // delete any external link from non-admins
  antilinkKick: false, // if true, also immediately kick the sender (skips the warning system) — antilink must be on too
  antigrouplink: true, // delete WhatsApp group-invite links from non-admins (on by default)
  antitag: false, // block mass @mentions (tag-spam) from non-admins
  antitagadmin: false, // delete messages from non-admins that mention group admins
  antitagThreshold: 5, // number of mentions in one message considered "mass tag"
  antigroupmention: true, // delete "mentioned the group in their status" posts from non-admins (on by default)
  antigroupstatus: true, // delete ANY group-status posts (bot promos, t.me ads, etc.) from non-admins
  antigroupstatusKick: true, // kick after 3 status warnings // also kick who posted the group status
  antigroupmentionKick: true, // kick after 3 status warnings // also kick the user who posted group-status mention (requires antigroupmention)
  antibot: false, // detect and kick likely bots (baileys/whatsapp-web.js style clients) from the group
  antisticker: false, // delete stickers from non-admins
  antiviewonce: false, // delete view-once message envelopes without opening their media
  autoAcceptRequests: false, // auto-approve pending group join requests as they come in
  // welcome/goodbye disabled — agent bot does not greet joins/leaves
  welcome: false,
  welcomeMessage: '',
  welcomeCard: false,
  welcomeAi: false,
  goodbye: false,
  goodbyeMessage: '',
  warnBeforeKick: true,
  maxWarnings: 3,
  antidelete: false, // recover + repost "deleted for everyone" messages in this chat
  antibadword: false, // delete messages containing group-defined banned words
  badwords: [], // lowercase list of banned words for this group
  antiflood: false, // auto-delete + warn on rapid-fire message flooding
  floodMaxMessages: 5, // max messages allowed within floodWindowSeconds before it's a flood
  floodWindowSeconds: 8,
};

function getSettings(groupId) {
  return { ...DEFAULTS, ...settings.get(groupId, {}) };
}

function updateSettings(groupId, patch) {
  return settings.update(groupId, (cur = {}) => ({ ...DEFAULTS, ...cur, ...patch }));
}

/** Case-insensitive, whole-word match against a group's banned-word list. Returns the matched
 *  word, or null. Regex metacharacters in a banned word are escaped so admins can't accidentally
 *  (or a jailbreak attempt can't deliberately) break the check by adding a malformed "word". */
function containsBadword(text, badwords) {
  if (!badwords || !badwords.length) return null;
  const lower = String(text || '').toLowerCase();
  for (const w of badwords) {
    if (!w) continue;
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) return w;
  }
  return null;
}

/** Returns a violation reason string, or null if the message is fine. */
function checkMessage(groupId, text, mentionCount = 0) {
  const s = getSettings(groupId);
  if (s.antigrouplink && containsGroupInviteLink(text)) return 'group-invite link';
  if (s.antilink && containsLink(text)) return 'external link';
  if (s.antitag && mentionCount >= s.antitagThreshold) return 'mass tagging';
  if (s.antibadword && containsBadword(text, s.badwords)) return 'banned word';
  return null;
}

// --- flood tracking (in-memory only, by design — a burst of timestamps doesn't need to
// survive a restart, and persisting it would mean disk writes on every single message) ---
const floodMap = new Map(); // `${groupId}:${userId}` -> timestamps[]

/** Registers this message's timestamp and returns true if the sender is now over the
 *  configured rate limit for this group. */
function checkFlood(groupId, userId, settings) {
  const key = `${groupId}:${userId}`;
  const now = Date.now();
  const windowMs = (settings.floodWindowSeconds || 8) * 1000;
  const arr = (floodMap.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  floodMap.set(key, arr);
  return arr.length > (settings.floodMaxMessages || 5);
}

function clearFlood(groupId, userId) {
  floodMap.delete(`${groupId}:${userId}`);
}

// --- warning tracking (used before auto-kick, if warnBeforeKick is on) ---
const warnings = new Collection('group_warnings', {});

function addWarning(groupId, userId) {
  const key = `${groupId}:${userId}`;
  const count = warnings.update(key, (c = 0) => c + 1);
  return count;
}

function clearWarnings(groupId, userId) {
  warnings.delete(`${groupId}:${userId}`);
}

function getWarnings(groupId, userId) {
  return warnings.get(`${groupId}:${userId}`, 0);
}


// --- timed suspensions (delete all messages from user until expiresAt) ---
const suspensions = new Collection('group_suspensions', {});

function suspendKey(groupId, userId) {
  return `${groupId}:${String(userId)}`;
}

/**
 * Suspend a user in a group for durationMs. Their messages will be auto-deleted until then.
 * @returns {{ ok: true, until: number, remainingMs: number } | { ok: false, error: string }}
 */
function suspendUser(groupId, userId, durationMs, meta = {}) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  if (!groupId || !id) return { ok: false, error: 'Missing group or user.' };
  const ms = Math.max(1000, Math.min(Number(durationMs) || 0, 30 * 24 * 60 * 60 * 1000)); // max 30 days
  if (!ms) return { ok: false, error: 'Invalid duration.' };
  const until = Date.now() + ms;
  const entry = {
    groupId: String(groupId),
    userId: id,
    until,
    reason: String(meta.reason || '').slice(0, 200),
    by: meta.by || null,
    at: Date.now(),
  };
  suspensions.set(suspendKey(groupId, id), entry);
  return { ok: true, until, remainingMs: ms, entry };
}

function unsuspendUser(groupId, userId) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  suspensions.delete(suspendKey(groupId, id));
  return { ok: true };
}

/** Returns active suspension entry or null if not suspended / expired. */
function getSuspension(groupId, userId) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  const key = suspendKey(groupId, id);
  const entry = suspensions.get(key, null);
  if (!entry) return null;
  if (Date.now() >= entry.until) {
    suspensions.delete(key);
    return null;
  }
  return entry;
}

function isSuspended(groupId, userId) {
  return !!getSuspension(groupId, userId);
}

function listSuspensions(groupId) {
  const now = Date.now();
  const out = [];
  for (const [key, entry] of Object.entries(suspensions.all() || {})) {
    if (!entry || String(entry.groupId) !== String(groupId)) continue;
    if (now >= entry.until) {
      suspensions.delete(key);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Parse human duration: "30 seconds", "1 hour", "5m", "2h", "1 day", pure number = seconds */
function parseDuration(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  // pure number → seconds
  if (/^\d+$/.test(s)) return Math.max(1, parseInt(s, 10)) * 1000;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2];
  if (/^s|sec/.test(u)) return Math.round(n * 1000);
  if (/^m|min/.test(u)) return Math.round(n * 60 * 1000);
  if (/^h|hr|hour/.test(u)) return Math.round(n * 60 * 60 * 1000);
  if (/^d|day/.test(u)) return Math.round(n * 24 * 60 * 60 * 1000);
  return null;
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}



// --- group-status strike system: warn N times then kick ---
const statusWarnings = new Collection('group_status_warnings', {});

function statusWarnKey(groupId, userId) {
  return `${groupId}:${String(userId)}`;
}

function addStatusWarning(groupId, userId) {
  const key = statusWarnKey(groupId, userId);
  const count = statusWarnings.update(key, (c = 0) => c + 1);
  return count;
}

function getStatusWarnings(groupId, userId) {
  return statusWarnings.get(statusWarnKey(groupId, userId), 0);
}

function clearStatusWarnings(groupId, userId) {
  statusWarnings.delete(statusWarnKey(groupId, userId));
}

module.exports = { getSettings, updateSettings, checkMessage, addWarning, clearWarnings, getWarnings, checkFlood, clearFlood, containsBadword, DEFAULTS, suspendUser, unsuspendUser, getSuspension, isSuspended, listSuspensions, parseDuration, formatDuration, addStatusWarning, getStatusWarnings, clearStatusWarnings };

});

runtime.define("ownerCleanup", "ownerCleanup.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const os = require('os');
const stickers = require('./stickers');
const lastBuild = require('../core/lastBuild');
const zipMemory = require('./zipMemory');
const logger = require('../logger');

const ROOT = path.join(__dirname, '..', '..');
const STORAGE = path.join(ROOT, 'storage');

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else {
          bytes += fs.statSync(p).size;
          files++;
        }
      } catch {}
    }
  };
  walk(dir);
  return { bytes, files };
}

function clearDir(dir, { prefix, olderThanMs, extensions } = {}) {
  let removed = 0;
  let bytes = 0;
  const now = Date.now();
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return { removed: 0, bytes: 0 }; }
  for (const name of ents) {
    if (prefix && !name.startsWith(prefix)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) continue;
      if (extensions && extensions.length) {
        const ext = path.extname(name).toLowerCase();
        if (!extensions.includes(ext)) continue;
      }
      if (olderThanMs && now - st.mtimeMs < olderThanMs) continue;
      bytes += st.size;
      fs.unlinkSync(p);
      removed++;
    } catch {}
  }
  return { removed, bytes };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function status() {
  const stickerCount = stickers.count();
  const stickerDir = stickers.STORAGE_DIR || path.join(STORAGE, 'stickers');
  const builds = dirSize(lastBuild.BUILD_DIR || path.join(STORAGE, 'builds'));
  const fixes = dirSize(zipMemory.FIX_DIR || path.join(STORAGE, 'fixes'));
  const stickerDisk = dirSize(stickerDir);
  const tmp = dirSize(os.tmpdir());
  return {
    stickers: { count: stickerCount, ...stickerDisk },
    builds,
    fixes,
    tmpApprox: tmp,
  };
}

/**
 * @param {object} opts
 * @param {boolean} [opts.stickers]
 * @param {boolean} [opts.builds]
 * @param {boolean} [opts.fixes]
 * @param {boolean} [opts.temp] - bot-related temp files in os.tmpdir
 * @param {boolean} [opts.all]
 */
function cleanup(opts = {}) {
  const all = !!opts.all;
  const report = [];
  let totalRemoved = 0;
  let totalBytes = 0;

  if (all || opts.stickers) {
    const r = stickers.clearAll();
    totalRemoved += r.removed;
    totalBytes += r.bytes;
    report.push(`Stickers: deleted ${r.removed} file(s) (${fmtBytes(r.bytes)})`);
  }
  if (all || opts.builds) {
    const r = lastBuild.clearBuildZips();
    totalRemoved += r.removed;
    totalBytes += r.bytes;
    report.push(`Build zips: deleted ${r.removed} file(s) (${fmtBytes(r.bytes)})`);
  }
  if (all || opts.fixes) {
    const r = zipMemory.clearFixZips();
    totalRemoved += r.removed;
    totalBytes += r.bytes;
    report.push(`Fix zips: deleted ${r.removed} file(s) (${fmtBytes(r.bytes)})`);
  }
  // NEVER delete WhatsApp sessions / auth — that logs the bot out
  const SESSIONS_DIR = path.join(ROOT, 'sessions');
  const PROTECTED = new Set([
    path.resolve(SESSIONS_DIR),
    path.resolve(path.join(ROOT, 'auth')),
    path.resolve(path.join(ROOT, 'baileys_auth')),
  ]);

  if (all || opts.temp) {
    // Only clear bot-owned temp prefixes — never sessions or auth state
    const prefixes = ['nick_ai_last_', 'nickai-cmp-', 'nickai-tts-', 'broken_last_', 'broken_fix', 'site-', 'sitef-', 'dl_', 'vin_', 'vout_', 'site_', 'wa_', 'br_', 'host_', 'send_', 'vn_', 'mp3_', 'in_'];
    let removed = 0;
    let bytes = 0;
    const tmp = os.tmpdir();
    try {
      for (const name of fs.readdirSync(tmp)) {
        // hard deny anything that looks like WhatsApp auth
        if (/session|creds|app-state|auth_info|baileys/i.test(name)) continue;
        if (!prefixes.some((p) => name.startsWith(p))) continue;
        const p = path.join(tmp, name);
        if (PROTECTED.has(path.resolve(p))) continue;
        try {
          const st = fs.statSync(p);
          if (st.isDirectory()) {
            // recursive small dirs
            const size = dirSize(p);
            fs.rmSync(p, { recursive: true, force: true });
            removed += size.files || 1;
            bytes += size.bytes;
          } else {
            bytes += st.size;
            fs.unlinkSync(p);
            removed++;
          }
        } catch {}
      }
    } catch {}
    totalRemoved += removed;
    totalBytes += bytes;
    report.push(`Temp bot files: deleted ${removed} item(s) (${fmtBytes(bytes)})`);
  }

  if (!report.length) {
    return {
      ok: false,
      error: 'Specify what to clear: stickers, builds, fixes, temp, or all.',
    };
  }

  logger.info({ totalRemoved, totalBytes, report }, 'owner cleanup');
  report.push('🔒 sessions/ auth was NOT touched (WhatsApp login preserved).');
  return {
    ok: true,
    removed: totalRemoved,
    bytes: totalBytes,
    human: `${report.join('\n')}\n\nTotal: ${totalRemoved} items, ${fmtBytes(totalBytes)}`,
    report,
  };
}

module.exports = { cleanup, status, fmtBytes, clearDir, dirSize };

});

runtime.define("roles", "roles.js", function(module, exports, require, __filename, __dirname) {
// owner. Supports addowner / addadmin / addsudo at runtime (persisted to disk via
// the db Collection, so it survives restarts).
//
// Hierarchy (highest to lowest): owner > sudo > admin > group-admin > member.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');
const config = require('../config');

const store = new Collection('roles', { owners: [], sudo: [], admins: [] });

function _norm(jidOrNum) {
  return String(jidOrNum || '').split('@')[0].split(':')[0];
}

/** Digits-only phone variants so 2340812… and 234812… both match WhatsApp JIDs. */
function phoneVariants(jidOrNum) {
  const raw = _norm(jidOrNum);
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return [];
  const set = new Set([digits, raw]);
  // Strip leading zeros after country-style prefixes users often paste wrong
  // e.g. 2340XXXXXXXXX → 234XXXXXXXXX, 0XXXXXXXXXX → XXXXXXXXXX
  if (digits.startsWith('2340') && digits.length >= 14) set.add('234' + digits.slice(4));
  if (digits.startsWith('0') && digits.length >= 10) set.add(digits.slice(1));
  if (digits.startsWith('234') && digits.length >= 13) set.add(digits.slice(3)); // national
  // Last 10 / 11 / 12 digits (common WA local forms)
  for (const n of [10, 11, 12, 13]) {
    if (digits.length >= n) set.add(digits.slice(-n));
  }
  return [...set].filter(Boolean);
}

function phonesMatch(a, b) {
  const A = phoneVariants(a);
  const B = new Set(phoneVariants(b));
  if (!A.length || !B.size) return false;
  return A.some((x) => B.has(x));
}

function all() {
  return store.get('roles', { owners: [], sudo: [], admins: [] });
}
function save(r) {
  store.set('roles', r);
}

// --- getters ---
function isStaticOwner(num) {
  const owners = config.ownerIds || [];
  if (!owners.length) return false;
  return owners.some((o) => phonesMatch(o, num));
}
function isOwner(jidOrNum) {
  const candidates = Array.isArray(jidOrNum) ? jidOrNum : [jidOrNum];
  const r = all();
  let aliasMap = null;
  try { aliasMap = require('../utils/jidResolver').aliases(); } catch {}
  for (const c of candidates) {
    if (!c) continue;
    if (isStaticOwner(c)) return true;
    if ((r.owners || []).some((o) => phonesMatch(o, c))) return true;
    // Group traffic may identify the owner only by their @lid. Resolve known
    // LID↔phone pairs and check the phone side too.
    const raw = String(c);
    const bareRaw = raw.replace(/:\d+@/, '@');
    const alts = [aliasMap?.get(raw), aliasMap?.get(bareRaw)];
    for (const alt of alts) {
      if (!alt) continue;
      if (isStaticOwner(alt)) return true;
      if ((r.owners || []).some((o) => phonesMatch(o, alt))) return true;
    }
  }
  return false;
}
function isOwnerAny(list) { return isOwner(list); }
function isSudo(jidOrNum) {
  if (isOwner(jidOrNum)) return true;
  const r = all();
  return (r.sudo || []).some((o) => phonesMatch(o, jidOrNum));
}
function isAdmin(jidOrNum) {
  if (isSudo(jidOrNum)) return true;
  const r = all();
  return (r.admins || []).some((o) => phonesMatch(o, jidOrNum));
}
// --- mutators (all guarded by caller checking isOwner) ---
function addOwner(jidOrNum) {
  const r = all();
  for (const n of phoneVariants(jidOrNum)) {
    if (n && !r.owners.includes(n)) r.owners.push(n);
  }
  const primary = _norm(jidOrNum);
  if (primary && !r.owners.includes(primary)) r.owners.push(primary);
  save(r);
  return primary;
}
function removeOwner(jidOrNum) {
  const n = _norm(jidOrNum);
  if (isStaticOwner(n)) return null; // can't remove a .env owner
  const r = all();
  r.owners = r.owners.filter((x) => x !== n);
  r.sudo = r.sudo.filter((x) => x !== n);
  r.admins = r.admins.filter((x) => x !== n);
  save(r);
  return n;
}
function addSudo(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  if (!r.sudo.includes(n)) r.sudo.push(n);
  save(r);
  return n;
}
function removeSudo(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  r.sudo = r.sudo.filter((x) => x !== n);
  save(r);
  return n;
}
function addAdmin(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  if (!r.admins.includes(n)) r.admins.push(n);
  save(r);
  return n;
}
function removeAdmin(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  r.admins = r.admins.filter((x) => x !== n);
  save(r);
  return n;
}

function list() {
  const r = all();
  return {
    owners: r.owners,
    sudo: r.sudo,
    admins: r.admins,
    staticOwners: config.ownerIds,
  };
}

module.exports = {
  isOwner, isSudo, isAdmin, isStaticOwner,
  addOwner, removeOwner, addSudo, removeSudo, addAdmin, removeAdmin,
  list,
};

});

runtime.define("spamScore", "spamScore.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const scores = new Collection('spam_scores', {});
const WINDOW_MS = 60 * 1000;

function key(chatId, userId) {
  return `${chatId}:${numFromJid(userId)}`;
}

function note(chatId, userJid, text = '') {
  const k = key(chatId, userJid);
  const now = Date.now();
  let s = scores.get(k, { hits: [], score: 0, mutedUntil: 0 });
  s.hits = (s.hits || []).filter((t) => now - t < WINDOW_MS);
  s.hits.push(now);
  let add = 1;
  if (text && text.length > 300) add += 1;
  if (/(.)\1{6,}/.test(text || '')) add += 2; // repeated chars
  if (/https?:\/\//i.test(text || '') && s.hits.length > 3) add += 2;
  s.score = Math.min(100, (s.score || 0) * 0.9 + add * 5); // decay + bump
  if (s.hits.length >= 8) s.score = Math.min(100, s.score + 20);
  scores.set(k, s);
  return { score: Math.round(s.score), rate: s.hits.length, muted: s.mutedUntil > now };
}

function isSpam(chatId, userJid, threshold = 70) {
  const s = scores.get(key(chatId, userJid), { score: 0, mutedUntil: 0 });
  if (s.mutedUntil && s.mutedUntil > Date.now()) return true;
  return (s.score || 0) >= threshold;
}

function mute(chatId, userJid, minutes = 10) {
  const k = key(chatId, userJid);
  const s = scores.get(k, { hits: [], score: 0, mutedUntil: 0 });
  s.mutedUntil = Date.now() + minutes * 60000;
  scores.set(k, s);
  return s.mutedUntil;
}

function status(chatId, userJid) {
  const s = scores.get(key(chatId, userJid), { score: 0, hits: [], mutedUntil: 0 });
  return {
    score: Math.round(s.score || 0),
    recent: (s.hits || []).length,
    mutedUntil: s.mutedUntil || 0,
  };
}

module.exports = { note, isSpam, mute, status };

});

runtime.define("suspend", "suspend.js", function(module, exports, require, __filename, __dirname) {
// While suspended, every message (text/media/sticker) from that user in the group
// is deleted until the countdown ends.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const store = new Collection('group_suspends', {});

function key(groupId, userId) {
  return `${String(groupId)}::${String(userId)}`;
}

function userKey(userJid) {
  return numFromJid(userJid) || String(userJid || '').replace(/@.*/, '');
}

/**
 * Parse human duration strings into milliseconds.
 * Supports: 30s, 30 sec, 5m, 1h, 2 hours, 1d, pure numbers (seconds).
 */
function parseDuration(input) {
  if (input == null) return null;
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return input < 10000 ? Math.floor(input * 1000) : Math.floor(input);
  }
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  let totalMs = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (/^ms/.test(u)) totalMs += n;
    else if (/^s/.test(u)) totalMs += n * 1000;
    else if (/^m/.test(u)) totalMs += n * 60 * 1000;
    else if (/^h/.test(u)) totalMs += n * 60 * 60 * 1000;
    else if (/^d/.test(u)) totalMs += n * 24 * 60 * 60 * 1000;
  }
  if (matched && totalMs > 0) return Math.floor(totalMs);

  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n > 0) return Math.floor(n * 1000);
  }
  return null;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

function formatRemaining(ms) {
  return formatDuration(ms);
}

/**
 * Suspend a user. duration can be ms number or human string ("30 seconds", "1h").
 * opts: { by, reason }
 */
function suspend(groupId, userJid, duration, opts = {}) {
  if (opts == null || typeof opts === 'string') {
    opts = { by: arguments[3] || null, reason: arguments[4] || '' };
  }
  const uid = userKey(userJid);
  if (!groupId || !uid) return { ok: false, error: 'Missing group or user.' };

  let ms = typeof duration === 'number' ? duration : parseDuration(duration);
  if (typeof duration === 'number' && duration > 0 && duration < 1000) {
    ms = Math.floor(duration * 1000);
  }
  if (!ms || ms <= 0) {
    return { ok: false, error: 'Invalid duration. Try: 30s, 5 minutes, 1 hour, 2h' };
  }
  ms = Math.min(ms, 30 * 24 * 60 * 60 * 1000);
  const expiresAt = Date.now() + ms;
  const entry = {
    groupId: String(groupId),
    userId: uid,
    expiresAt,
    startedAt: Date.now(),
    by: opts.by ? userKey(opts.by) : null,
    reason: String(opts.reason || '').slice(0, 200),
  };
  store.set(key(groupId, uid), entry);
  return {
    ok: true,
    userId: uid,
    expiresAt,
    remaining: formatDuration(ms),
    remainingMs: ms,
    entry,
  };
}

function unsuspend(groupId, userJid) {
  const uid = userKey(userJid);
  const k = key(groupId, uid);
  const had = store.get(k, null);
  store.delete(k);
  return { removed: !!had, userId: uid };
}

function getSuspend(groupId, userJid) {
  const uid = userKey(userJid);
  const k = key(groupId, uid);
  const entry = store.get(k, null);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(k);
    return null;
  }
  return entry;
}

function isSuspended(groupId, userJid, aliases = []) {
  const candidates = [userJid, ...(aliases || [])].filter(Boolean);
  for (const c of candidates) {
    const entry = getSuspend(groupId, c);
    if (entry) {
      return {
        active: true,
        remainingMs: Math.max(0, entry.expiresAt - Date.now()),
        entry,
        userId: entry.userId,
      };
    }
  }
  return { active: false, remainingMs: 0 };
}

function remainingMs(groupId, userJid) {
  const e = getSuspend(groupId, userJid);
  if (!e) return 0;
  return Math.max(0, e.expiresAt - Date.now());
}

function listGroup(groupId) {
  const all = store.all() || {};
  const out = [];
  const prefix = `${String(groupId)}::`;
  for (const [k, entry] of Object.entries(all)) {
    if (!k.startsWith(prefix)) continue;
    if (!entry || Date.now() >= entry.expiresAt) {
      store.delete(k);
      continue;
    }
    out.push({
      ...entry,
      remaining: formatDuration(entry.expiresAt - Date.now()),
      remainingMs: Math.max(0, entry.expiresAt - Date.now()),
    });
  }
  return out.sort((a, b) => a.expiresAt - b.expiresAt);
}

function listSuspended(groupId) {
  return listGroup(groupId);
}

module.exports = {
  parseDuration,
  formatDuration,
  formatRemaining,
  suspend,
  unsuspend,
  getSuspend,
  isSuspended,
  remainingMs,
  listGroup,
  listSuspended,
  userKey,
};

});
};
