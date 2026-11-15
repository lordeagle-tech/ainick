// features/afk.js — "away from keyboard" status per user (global, not per-group).
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
