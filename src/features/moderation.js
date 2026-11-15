// features/moderation.js — per-group moderation settings + automatic checks.
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
  antitagThreshold: 5, // number of mentions in one message considered "mass tag"
  antigroupmention: true, // delete "mentioned the group in their status" posts from non-admins (on by default)
  antigroupstatus: true, // delete ANY group-status posts (bot promos, t.me ads, etc.) from non-admins
  antigroupstatusKick: true, // kick after 3 status warnings // also kick who posted the group status
  antigroupmentionKick: true, // kick after 3 status warnings // also kick the user who posted group-status mention (requires antigroupmention)
  antibot: false, // detect and kick likely bots (baileys/whatsapp-web.js style clients) from the group
  antisticker: false, // delete stickers from non-admins
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
