// features/customCommands.js — lets the owner define "when someone says X, reply with Y"
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
