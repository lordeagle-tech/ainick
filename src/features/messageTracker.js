// messageTracker.js — durable index of messages sent by this bot.
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
