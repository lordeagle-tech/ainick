// features/genQuota.js — image/video generation quota (5 per 6h for normal users)
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');
const roles = require('./roles');
const perms = require('../utils/permissions');

const WINDOW_MS = 6 * 60 * 60 * 1000;
const LIMIT = 5;
const store = new Collection('gen_quota', {});

function isUnlimited(jid) {
  return perms.isOwner(jid) || roles.isSudo(jid) || roles.isOwner(jid);
}

function state(userJid) {
  const id = numFromJid(userJid);
  const now = Date.now();
  let s = store.get(id, null) || { hits: [] };
  s.hits = (s.hits || []).filter((t) => now - t < WINDOW_MS);
  store.set(id, s);
  return s;
}

function remaining(userJid) {
  if (isUnlimited(userJid)) return { unlimited: true, left: Infinity, used: 0, limit: LIMIT };
  const s = state(userJid);
  const used = s.hits.length;
  return { unlimited: false, left: Math.max(0, LIMIT - used), used, limit: LIMIT };
}

/** @returns {{ ok: true } | { ok: false, error: string }} */
function consume(userJid, kind = 'image') {
  if (isUnlimited(userJid)) return { ok: true, unlimited: true };
  const s = state(userJid);
  if (s.hits.length >= LIMIT) {
    const oldest = Math.min(...s.hits);
    const resetMs = WINDOW_MS - (Date.now() - oldest);
    const mins = Math.max(1, Math.ceil(resetMs / 60000));
    return {
      ok: false,
      error: `Generation limit reached (${LIMIT} image/video gens per 6 hours). Resets in ~${mins} min. Owners/sudo are unlimited.`,
    };
  }
  s.hits.push(Date.now());
  store.set(numFromJid(userJid), s);
  return { ok: true, left: LIMIT - s.hits.length, kind };
}

module.exports = { consume, remaining, isUnlimited, LIMIT, WINDOW_MS };
