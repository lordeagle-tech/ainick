
'use strict';

// Compatibility surface for an optional feature that is not included in this
// distribution. Methods are deliberately conservative: they never throw at
// import time and report an actionable result when invoked.
const featureName = "devTools";
const state = new Map();
const unavailable = (method) => ({
  ok: false,
  error: `Optional feature "${featureName}" is not installed (method: ${method}).`,
});
const api = {
  handlers: {},
  current: () => null,
  enabled: (key) => state.get(String(key)) === true,
  isEnabled: (key) => state.get(String(key)) === true,
  setEnabled: (key, value) => { state.set(String(key), Boolean(value)); return Boolean(value); },
  toggle: (key) => { const value = !state.get(String(key)); state.set(String(key), value); return value; },
  isAllowed: () => true,
  list: () => [],
  listCustom: () => [],
  getAllStats: () => ({}),
  getStats: () => ({}),
  resetUsage: () => ({ ok: true }),
  registry: new Map(),
  workspaceRoot: () => null,
  getMemory: () => ({}),
  safeUrl: (url) => String(url || ''),
  listRunning: () => [],
  stop: () => ({ ok: true, stopped: true }),
};
for (const method of [
  'handle', 'run', 'execute', 'executeCustom', 'deployStatic', 'deployProject',
  'upload', 'convert', 'workOnRepo', 'loginOrRegister', 'runSession',
  'react', 'vote', 'comment', 'postTechUpdate', 'scrapeUrl', 'webSearch',
  'getTechNews', 'addTodo', 'listTodos', 'getTodos', 'save', 'remove',
  'status', 'catalog', 'buy', 'equip', 'inventory', 'propose', 'respond',
  'divorce', 'marriageStatus', 'create', 'search', 'extractDesign',
]) api[method] = (...args) => unavailable(method);

module.exports = new Proxy(api, {
  get(target, property) {
    if (property in target) return target[property];
    if (typeof property === 'symbol') return target[property];
    return (...args) => unavailable(String(property));
  },
});
