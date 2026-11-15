// core/memory.js — durable, isolated memory.
//
// There are intentionally TWO different scopes:
//   1) user profile memory: identity/preferences/interactions for one WhatsApp user.
//   2) conversation memory: one user INSIDE one chat. This is what gets sent to the AI.
//
// The second scope is critical in groups: User A's conversation can never become part of
// User B's prompt just because they are in the same WhatsApp group.
const { Collection } = require('../db');

// Keep substantially more durable context by default. Deployments can lower these
// limits when their model context window or storage budget is smaller.
const MAX_TURNS = Number(process.env.MEMORY_MAX_TURNS || 240);
const MAX_USER_CONTEXT = Number(process.env.MEMORY_MAX_USER_CONTEXT || 2000);
const MAX_PROFILE_MESSAGE = Number(process.env.MEMORY_MAX_MESSAGE_CHARS || 5000);

// Legacy chat-wide history is retained for older features that explicitly use it (e.g.
// group summaries), but the AI router must use scoped history below.
const historyStore = new Collection('chat_history', {});
const scopedHistoryStore = new Collection('user_chat_history', {});
const userProfileStore = new Collection('user_profiles', {});

const userProfiles = new Map(Object.entries(userProfileStore.all()));
const chatContext = new Map();

// Credentials may be present in a live tool call, but must never become durable
// chat/profile memory that can be replayed into a later model prompt.
function redactSensitive(value) {
  return String(value ?? '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_TOKEN]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
}

for (const [phoneNumber, profile] of userProfiles.entries()) {
  const key = `${phoneNumber}:chats`;
  const chats = chatContext.get(key) || new Set();
  for (const interaction of profile.interactions || []) {
    if (interaction.chatId) chats.add(interaction.chatId);
  }
  if (chats.size) chatContext.set(key, chats);
}

function scopeKey(chatId, userId) {
  // Keep the key deterministic and filesystem/JSON friendly. Collection keys are JSON
  // object keys, so no extra encoding is necessary.
  return `${String(chatId || 'unknown-chat')}::${String(userId || 'unknown-user')}`;
}

function get(chatId) {
  return historyStore.get(chatId, []) || [];
}

function push(chatId, role, content) {
  const arr = historyStore.get(chatId, []) || [];
  arr.push({ role, content, timestamp: Date.now() });
  while (arr.length > MAX_TURNS) arr.shift();
  historyStore.set(chatId, arr);
}

function clear(chatId) {
  historyStore.delete(chatId);
}

/** Get isolated conversation history for exactly one user in exactly one chat. */
function getScoped(chatId, userId) {
  return scopedHistoryStore.get(scopeKey(chatId, userId), []) || [];
}

/** Ensure a persistent session exists without adding a fake user/assistant turn. */
function ensureScoped(chatId, userId) {
  const key = scopeKey(chatId, userId);
  if (!scopedHistoryStore.has(key)) scopedHistoryStore.set(key, []);
  return scopedHistoryStore.get(key, []) || [];
}

/** Append to isolated conversation history for exactly one user in exactly one chat. */
function pushScoped(chatId, userId, role, content) {
  const key = scopeKey(chatId, userId);
  const arr = scopedHistoryStore.get(key, []) || [];
  let text = redactSensitive(typeof content === 'string' ? content : JSON.stringify(content)).slice(0, MAX_PROFILE_MESSAGE);
  // Drop pure status spam from history (never train the model on these loops)
  if (/^(?:⏳\s*)?still building|anti-?delete|starting (?:website |project )?build/i.test(text.trim())) {
    return;
  }
  const last = arr[arr.length - 1];
  if (last && last.role === role && (last.content === text || similarText(last.content, text))) {
    last.timestamp = Date.now();
    scopedHistoryStore.set(key, arr);
    return;
  }
  // Stronger dedupe: remove any of the last 6 turns that match this assistant line
  if (role === 'assistant') {
    for (let i = arr.length - 1; i >= Math.max(0, arr.length - 6); i--) {
      if (arr[i].role === 'assistant' && similarText(arr[i].content, text)) {
        arr.splice(i, 1);
      }
    }
  }
  arr.push({ role, content: text, timestamp: Date.now() });
  while (arr.length > MAX_TURNS) arr.shift();
  scopedHistoryStore.set(key, arr);
}

function similarText(a, b) {
  const x = String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const y = String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const n = Math.min(80, Math.min(x.length, y.length));
  if (n >= 24 && (x.slice(0, n) === y.slice(0, n) || x.includes(y.slice(0, Math.min(50, y.length))) || y.includes(x.slice(0, Math.min(50, x.length))))) {
    return true;
  }
  // High overlap ratio for mid-length strings
  if (x.length > 60 && y.length > 60) {
    const shorter = x.length <= y.length ? x : y;
    const longer = x.length > y.length ? x : y;
    if (longer.includes(shorter.slice(0, Math.floor(shorter.length * 0.7)))) return true;
  }
  return false;
}

/** History for the model: collapse stuck repeated assistant loops.
 * Also caps the window at MAX_RECENT_TURNS so the context never bloats.
 * Older turns get summarised via getUserMemorySummary, not dumped raw. */
const MAX_RECENT_TURNS = Number(process.env.MEMORY_PROMPT_TURNS || 100);

function getScopedForPrompt(chatId, userId) {
  const arr = getScoped(chatId, userId);
  // Trim old turns first (keep the tail)
  const trimmed = arr.slice(-MAX_RECENT_TURNS);
  const out = [];
  for (const turn of trimmed) {
    const prev = out[out.length - 1];
    if (prev && prev.role === turn.role && similarText(prev.content, turn.content)) continue;
    out.push(turn);
  }
  return out;
}

/** Evict scoped sessions that haven't been touched in STALE_THRESHOLD_MS. */
const STALE_THRESHOLD_MS = Number(process.env.MEMORY_STALE_MS || 7776000000); // 90 days default
let _staleCleanupDone = false;
function cleanupStaleSessions() {
  if (_staleCleanupDone) return;
  _staleCleanupDone = true;
  const now = Date.now();
  for (const [key, arr] of Object.entries(scopedHistoryStore.all())) {
    const last = arr[arr.length - 1];
    if (!last || !last.timestamp || (now - last.timestamp) > STALE_THRESHOLD_MS) {
      scopedHistoryStore.delete(key);
    }
  }
}

function clearScoped(chatId, userId) {
  scopedHistoryStore.delete(scopeKey(chatId, userId));
}

function clearUserMemory(userId) {
  const needle = `::${String(userId || '')}`;
  for (const key of Object.keys(scopedHistoryStore.all())) {
    if (key.endsWith(needle)) scopedHistoryStore.delete(key);
  }
  userProfiles.delete(String(userId));
  userProfileStore.delete(String(userId));
}

function getUserProfile(phoneNumber) {
  const key = String(phoneNumber || 'unknown');
  if (!userProfiles.has(key)) {
    userProfiles.set(key, {
      userId: key,
      phoneNumber: key,
      aliases: [],
      name: '',
      interactions: [],
      lastSeen: Date.now(),
      preferences: {},
    });
  }
  return userProfiles.get(key);
}

function rememberIdentity(canonicalId, identities = {}) {
  const key = String(canonicalId || identities.phoneNumber || identities.jid || identities.lid || 'unknown');
  const profile = getUserProfile(key);
  profile.userId = key;
  profile.phoneNumber = identities.phoneNumber || profile.phoneNumber || '';
  profile.jid = identities.jid || profile.jid || '';
  profile.lid = identities.lid || profile.lid || '';
  const aliases = new Set(profile.aliases || []);
  for (const value of [identities.phoneNumber, identities.jid, identities.lid, ...(identities.aliases || [])]) {
    if (value) aliases.add(String(value));
  }
  profile.aliases = [...aliases].slice(-20);
  profile.lastSeen = Date.now();
  userProfiles.set(key, profile);
  userProfileStore.set(key, profile);
  return profile;
}

function getUserMemory(canonicalId, limit = 24) {
  const profile = getUserProfile(canonicalId);
  return (profile.interactions || []).slice(-Math.max(1, Number(limit) || 24));
}

function isGroupJid(chatId) {
  return /@g\.us$/i.test(String(chatId || ''));
}

function isPrivateJid(chatId) {
  const s = String(chatId || '');
  return /@s\.whatsapp\.net$/i.test(s) || /@lid$/i.test(s);
}

/**
 * Profile summary for prompts.
 * CRITICAL privacy: never inject another chat's messages into this one.
 * - Pass opts.chatId so only interactions from THIS chat are included.
 * - DMs and groups are isolated from each other.
 */
function getUserMemorySummary(canonicalId, limit = 16, opts = {}) {
  const profile = getUserProfile(canonicalId);
  const chatId = opts.chatId || null;
  const max = Math.max(1, Number(limit) || 16);
  let interactions = Array.isArray(profile.interactions) ? profile.interactions.slice() : [];

  if (chatId) {
    interactions = interactions.filter((ix) => String(ix.chatId || '') === String(chatId));
  } else {
    // No chat scope requested → do NOT leak message text across chats
    interactions = [];
  }

  // Extra safety: if current chat is a group, drop any residual private-chat lines
  if (chatId && isGroupJid(chatId)) {
    interactions = interactions.filter((ix) => isGroupJid(ix.chatId) && String(ix.chatId) === String(chatId));
  }
  if (chatId && isPrivateJid(chatId)) {
    interactions = interactions.filter((ix) => isPrivateJid(ix.chatId) && String(ix.chatId) === String(chatId));
  }

  return {
    userId: profile.userId || String(canonicalId || ''),
    name: profile.name || '',
    preferences: profile.preferences || {},
    // Only same-chat snippets — never DM content in a group prompt
    recentInteractions: interactions.slice(-max).map((ix) => ({
      role: ix.role,
      message: String(ix.message || '').slice(0, 400),
      chatId: ix.chatId,
      timestamp: ix.timestamp,
    })),
    scope: chatId ? `chat:${chatId}` : 'profile-only',
  };
}

function updateUserContext(phoneNumber, chatId, message, role = 'user', identities = {}) {
  const key = String(phoneNumber || 'unknown');
  const profile = getUserProfile(key);
  if (identities && typeof identities === 'object') rememberIdentity(key, identities);
  profile.lastSeen = Date.now();
  const interaction = {
    timestamp: Date.now(),
    chatId,
    isGroup: isGroupJid(chatId),
    message: redactSensitive(message).slice(0, MAX_PROFILE_MESSAGE),
    role,
  };
  profile.interactions.push(interaction);
  while (profile.interactions.length > MAX_USER_CONTEXT) profile.interactions.shift();

  const chatKey = `${key}:chats`;
  const chats = chatContext.get(chatKey) || new Set();
  chats.add(chatId);
  chatContext.set(chatKey, chats);

  userProfiles.set(key, profile);
  userProfileStore.set(key, profile);
}

function getUserChats(phoneNumber) {
  return Array.from(chatContext.get(`${String(phoneNumber)}:chats`) || new Set());
}

function getChatUsers(chatId) {
  const users = [];
  for (const [phoneNumber, chats] of chatContext.entries()) {
    if (phoneNumber.endsWith(':chats') && chats.has(chatId)) {
      users.push(phoneNumber.slice(0, -6));
    }
  }
  return users;
}

function setUserPreference(phoneNumber, key, value) {
  const profile = getUserProfile(phoneNumber);
  profile.preferences[key] = value;
  userProfiles.set(String(phoneNumber), profile);
  userProfileStore.set(String(phoneNumber), profile);
}

function getUserPreference(phoneNumber, key) {
  return getUserProfile(phoneNumber).preferences[key];
}

/** Compact identity-only memory. Not conversation history; safe to use across chats. */
function getUserProfileSummary(phoneNumber) {
  const profile = getUserProfile(phoneNumber);
  return {
    phoneNumber: profile.phoneNumber,
    name: profile.name || '',
    preferences: profile.preferences || {},
    lastSeen: profile.lastSeen || null,
    interactionCount: (profile.interactions || []).length,
  };
}

module.exports = {
  get,
  push,
  clear,
  getScoped, getScopedForPrompt,
  ensureScoped,
  pushScoped,
  clearScoped,
  clearUserMemory,
  getUserProfile,
  getUserProfileSummary,
  redactSensitive,
  rememberIdentity,
  getUserMemory,
  getUserMemorySummary,
  updateUserContext,
  getUserChats,
  getChatUsers,
  setUserPreference,
  getUserPreference,
  cleanupStaleSessions,
};
