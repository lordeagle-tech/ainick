'use strict';

module.exports = (runtime) => {
runtime.define("usageTracker", "usageTracker.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');

const store = new Collection('token_usage', {});
// Default window similar to the sample the operator asked for
const DEFAULT_LIMIT = Number(process.env.TOKEN_WINDOW_LIMIT || 450000);
const PERIOD_MS = Number(process.env.TOKEN_WINDOW_MS || 6 * 3600 * 1000); // 6h rolling window

function state() {
  const s = store.get('window', null);
  const now = Date.now();
  if (!s || !s.startedAt || now - s.startedAt >= PERIOD_MS) {
    const fresh = { startedAt: now, used: 0, limit: DEFAULT_LIMIT };
    store.set('window', fresh);
    return fresh;
  }
  return s;
}

function save(s) {
  store.set('window', s);
  return s;
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text) {
  const n = String(text || '').length;
  return Math.max(1, Math.ceil(n / 4));
}

function addUsage(promptText, completionText, extra = 0) {
  const s = state();
  const add = estimateTokens(promptText) + estimateTokens(completionText) + (Number(extra) || 0);
  s.used = Math.min(s.limit, (s.used || 0) + add);
  save(s);
  return report();
}

function report() {
  const s = state();
  const used = Math.round(s.used || 0);
  const limit = s.limit || DEFAULT_LIMIT;
  const remaining = Math.max(0, limit - used);
  const pct = limit ? (used / limit) * 100 : 0;
  const leftPct = Math.max(0, 100 - pct);
  const endsAt = (s.startedAt || Date.now()) + PERIOD_MS;
  const msLeft = Math.max(0, endsAt - Date.now());
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  return {
    used,
    limit,
    remaining,
    pct: Math.round(pct * 10) / 10,
    leftPct: Math.round(leftPct * 10) / 10,
    resetsIn: `${h}h ${m}m`,
    warning: pct >= 50,
  };
}

function formatReport() {
  const r = report();
  return (
    `*Nick AI usage warning:* ${r.pct}% of the current token window has been used.\n` +
    `You have *${r.leftPct}%* of usage left\n\n` +
    `Used: ${r.used.toLocaleString()} / ${r.limit.toLocaleString()} tokens (${r.pct}%)\n\n` +
    `Remaining: ${r.remaining.toLocaleString()} tokens\n\n` +
    `Resets in: ${r.resetsIn}\n\n` +
    `Tips:\n` +
    `Use /ctx to check usage.\n\n` +
    `Use /compact to reduce the conversation context.`
  );
}

function resetWindow() {
  const fresh = { startedAt: Date.now(), used: 0, limit: DEFAULT_LIMIT };
  save(fresh);
  return report();
}

module.exports = { addUsage, report, formatReport, resetWindow, estimateTokens };

});
};
