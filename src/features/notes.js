'use strict';
// features/notes.js — per-user scratchpad notes for the agent.
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
