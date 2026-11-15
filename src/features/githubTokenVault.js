// githubTokenVault.js — per-user GitHub PATs (DM only to save). Never log full tokens.
'use strict';

const crypto = require('crypto');
const { Collection } = require('../db');
const logger = require('../logger');

const store = new Collection('github_user_tokens', {});

function keyFor(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 64) || 'unknown';
}

function looksLikeToken(s) {
  const t = String(s || '').trim();
  return /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,}$/.test(t);
}

function extractToken(text) {
  const m = String(text || '').match(
    /\b((?:ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,})\b/
  );
  return m ? m[1] : null;
}

function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

/**
 * Save token for this user. Returns safe metadata (never the token).
 */
function save(jid, accessToken) {
  const token = String(accessToken || '').trim();
  if (!looksLikeToken(token)) {
    return { ok: false, error: 'That does not look like a GitHub token (expected ghp_… or github_pat_…).' };
  }
  const id = keyFor(jid);
  store.set(id, {
    token,
    fp: fingerprint(token),
    savedAt: Date.now(),
    jid: String(jid || ''),
  });
  logger.info({ user: id, fp: fingerprint(token) }, 'github token saved for user');
  return {
    ok: true,
    fingerprint: fingerprint(token),
    message: 'GitHub token saved for your account. Use it from DM for push/clone. Say "github disconnect" to remove it.',
  };
}

function get(jid) {
  const row = store.get(keyFor(jid), null);
  return row?.token || null;
}

function remove(jid) {
  const id = keyFor(jid);
  const had = !!store.get(id, null);
  try {
    store.delete(id);
  } catch {
    store.set(id, null);
  }
  return { ok: true, removed: had };
}

function status(jid) {
  const row = store.get(keyFor(jid), null);
  if (!row?.token) {
    return { connected: false, message: 'No GitHub token saved. DM me a token (ghp_…) or say "github connect" with your PAT.' };
  }
  return {
    connected: true,
    fingerprint: row.fp || fingerprint(row.token),
    savedAt: row.savedAt || null,
    message: 'GitHub connected for your account. I will use your token for your pushes (not shared with other users).',
  };
}

/** If the message is a DM containing a pasted PAT, save it. Returns result or null if not a token message. */
function maybeCaptureFromDm(isGroup, senderJid, text) {
  if (isGroup) return null;
  const token = extractToken(text);
  if (!token) return null;
  // Only auto-save if the message is mostly the token / connect intent
  const t = String(text || '').trim();
  if (t.length > 200 && !/github|token|pat|connect|push/i.test(t)) return null;
  return save(senderJid, token);
}

module.exports = {
  save,
  get,
  remove,
  status,
  looksLikeToken,
  extractToken,
  maybeCaptureFromDm,
  keyFor,
};
