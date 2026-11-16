'use strict';

module.exports = (runtime) => {
runtime.define("optionalFeatures", "optionalFeatures.js", function(module, exports, require, __filename, __dirname) {
'use strict';

const OPTIONAL_FEATURES = [
  'audioConvert',
  'cardGame',
  'cryptoZip',
  'devTools',
  'dynatools',
  'gamehost',
  'gofile',
  'marriage',
  'newFeatures',
  'pokemonHunt',
  'quickGames',
  'scrapers',
  'shop',
  'socialGames',
  'starboard',
  'usageLimiter',
  'webAutomate',
];

const UNAVAILABLE_METHODS = [
  'handle', 'run', 'execute', 'executeCustom', 'deployStatic', 'deployProject',
  'upload', 'convert', 'workOnRepo', 'loginOrRegister', 'runSession',
  'react', 'vote', 'comment', 'postTechUpdate', 'scrapeUrl', 'webSearch',
  'getTechNews', 'addTodo', 'listTodos', 'getTodos', 'save', 'remove',
  'status', 'catalog', 'buy', 'equip', 'inventory', 'propose', 'respond',
  'divorce', 'marriageStatus', 'create', 'search', 'extractDesign',
];

function createOptionalFeature(featureName) {
  const state = new Map();
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

  if (featureName === 'starboard') {
    Object.assign(api, {
      getSettings: () => ({ emoji: '⭐', threshold: 3, channel: null, enabled: false }),
      registerReaction: () => ({ shouldPost: false, count: 0 }),
      getCached: () => null,
    });
  }

  const unavailable = (method) => ({
    ok: false,
    error: `Optional feature "${featureName}" is not installed (method: ${method}).`,
  });

  for (const method of UNAVAILABLE_METHODS) {
    api[method] = (...args) => unavailable(method);
  }

  return new Proxy(api, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'symbol') return target[property];
      return (...args) => unavailable(String(property));
    },
  });
}

module.exports = Object.freeze(
  Object.fromEntries(OPTIONAL_FEATURES.map((name) => [name, createOptionalFeature(name)])),
);

});
};
