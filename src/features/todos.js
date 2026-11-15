'use strict';
// features/todos.js — per-user persistent task list for the agent.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const store = new Collection('user_todos', {});

function _key(userId) {
  return String(numFromJid(userId) || userId || '').replace(/\D/g, '') || 'anon';
}

function _list(userId) {
  const key = _key(userId);
  const list = store.get(key, []);
  return Array.isArray(list) ? list : [];
}

function _save(userId, list) {
  store.set(_key(userId), list);
  return list;
}

function addTodo(userId, text, dueAt = null) {
  const list = _list(userId);
  const item = {
    id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    text: String(text || '').trim().slice(0, 500),
    done: false,
    dueAt: dueAt && Number.isFinite(Number(dueAt)) ? Number(dueAt) : null,
    createdAt: Date.now(),
  };
  if (!item.text) throw new Error('todo text is required');
  list.push(item);
  _save(userId, list);
  return item;
}

function listTodos(userId, includeDone = false) {
  const list = _list(userId);
  return includeDone ? list.slice() : list.filter((t) => !t.done);
}

function getTodos(userId) {
  return _list(userId);
}

function completeTodo(userId, id) {
  const list = _list(userId);
  const item = list.find((t) => t.id === String(id));
  if (!item) return { ok: false, error: `todo ${id} not found` };
  item.done = true;
  item.completedAt = Date.now();
  _save(userId, list);
  return { ok: true, todo: item };
}

function deleteTodo(userId, id) {
  const list = _list(userId);
  const next = list.filter((t) => t.id !== String(id));
  if (next.length === list.length) return { ok: false, error: `todo ${id} not found` };
  _save(userId, next);
  return { ok: true, removed: id };
}

function clearCompleted(userId) {
  const list = _list(userId);
  const cleaned = list.filter((t) => !t.done);
  _save(userId, cleaned);
  return { ok: true, removed: list.length - cleaned.length, remaining: cleaned.length };
}

module.exports = {
  addTodo,
  listTodos,
  getTodos,
  completeTodo,
  deleteTodo,
  clearCompleted,
};
