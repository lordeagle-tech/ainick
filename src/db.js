// Not a "real" database, but it's durable, atomic, and enough for a self-hosted bot.
// Collections are separate files under /data, loaded into memory and flushed on write
// (debounced) so we don't hammer the disk on every message.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const cache = new Map();
const dirty = new Set();
let flushTimer = null;

function fileFor(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function load(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  const file = fileFor(name);
  let data = fallback;
  try {
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    logger.warn({ err: e.message, name }, 'db: failed to read collection, using fallback');
  }
  cache.set(name, data);
  return data;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const name of dirty) {
      try {
        const tmp = fileFor(name) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cache.get(name), null, 2));
        fs.renameSync(tmp, fileFor(name));
      } catch (e) {
        logger.error({ err: e.message, name }, 'db: failed to flush collection');
      }
    }
    dirty.clear();
  }, 250);
}

function markDirty(name) {
  dirty.add(name);
  scheduleFlush();
}

/** A simple key -> object collection with get/set/all/delete, backed by one JSON file. */
class Collection {
  constructor(name, fallback = {}) {
    this.name = name;
    this._fallback = fallback;
  }
  _data() {
    return load(this.name, { ...this._fallback });
  }
  get(key, def = undefined) {
    const d = this._data();
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : def;
  }
  has(key) {
    return Object.prototype.hasOwnProperty.call(this._data(), key);
  }
  set(key, value) {
    const d = this._data();
    d[key] = value;
    markDirty(this.name);
    return value;
  }
  update(key, updater, def = {}) {
    const d = this._data();
    const current = Object.prototype.hasOwnProperty.call(d, key) ? d[key] : def;
    const next = updater(current);
    d[key] = next;
    markDirty(this.name);
    return next;
  }
  delete(key) {
    const d = this._data();
    delete d[key];
    markDirty(this.name);
  }
  all() {
    return this._data();
  }
  entries() {
    return Object.entries(this._data());
  }
}

/** Flush everything synchronously — call on graceful shutdown. */
function flushAllSync() {
  for (const name of dirty) {
    try {
      fs.writeFileSync(fileFor(name), JSON.stringify(cache.get(name), null, 2));
    } catch (e) {
      logger.error({ err: e.message, name }, 'db: sync flush failed');
    }
  }
  dirty.clear();
}

module.exports = { Collection, flushAllSync };
