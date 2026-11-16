'use strict';

module.exports = (runtime) => {
runtime.define("autoPresence", "autoPresence.js", function(module, exports, require, __filename, __dirname) {
'use strict';
const { Collection } = require('../db');

const settings = new Collection('auto_presence', {
  global: { statusView: true, typing: true },
});

function getSettings() {
  return { statusView: true, typing: true, ...settings.get('global', {}) };
}

function setEnabled(feature, enabled) {
  const current = getSettings();
  current[feature] = !!enabled;
  settings.set('global', current);
  return current[feature];
}

module.exports = {
  getSettings,
  isStatusViewEnabled: () => getSettings().statusView,
  isTypingEnabled: () => getSettings().typing,
  setStatusViewEnabled: (enabled) => setEnabled('statusView', enabled),
  setTypingEnabled: (enabled) => setEnabled('typing', enabled),
};
});

runtime.define("callHandler", "callHandler.js", function(module, exports, require, __filename, __dirname) {
// True live voice bridging is limited on linked devices; we support auto-reject /
// notify and optional auto-text when a call rings.
const { Collection } = require('../db');
const logger = require('../logger');

const settings = new Collection('call_settings', { autoAnswer: false, autoReject: false, replyText: "Can't take calls right now — text me here." });

function get() {
  return { autoAnswer: false, autoReject: false, replyText: "Can't take calls right now — text me here.", ...settings.get('global', {}) };
}

function set(patch) {
  const cur = get();
  const next = { ...cur, ...patch };
  settings.set('global', next);
  return next;
}

function attach(sock) {
  if (sock.__callHandlerAttached) return;
  sock.__callHandlerAttached = true;
  sock.ev.on('call', async (calls) => {
    const conf = get();
    if (!conf.autoAnswer && !conf.autoReject) return;
    for (const c of calls || []) {
      try {
        const status = String(c.status || '').toLowerCase();
        if (status !== 'offer' && status !== 'ringing') continue;
        const from = c.from || c.chatId;
        logger.info({ from, status, id: c.id }, 'incoming call');
        // Baileys MD: reject is the reliable action; full media answer is not available on linked devices.
        if (conf.autoReject || conf.autoAnswer) {
          try {
            if (typeof sock.rejectCall === 'function' && c.id && from) {
              await sock.rejectCall(c.id, from);
            }
          } catch (e) {
            logger.warn({ err: e.message }, 'rejectCall failed');
          }
          if (conf.replyText && from) {
            const jid = String(from).includes('@') ? from : `${from}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: conf.replyText }).catch(() => {});
          }
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'call handler error');
      }
    }
  });
}

module.exports = { get, set, attach };

});

runtime.define("dailyReport", "dailyReport.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');
const config = require('../config');
const logger = require('../logger');
const genQuota = require('./genQuota');
const usageTracker = require('./usageTracker');

const meta = new Collection('daily_report_meta', {});
const stats = new Collection('daily_stats', {
  messages: 0,
  groups: 0,
  dms: 0,
  errors: 0,
  gens: 0,
  day: '',
});

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function ensureDay() {
  const k = dayKey();
  const s = stats.get('today', { messages: 0, groups: 0, dms: 0, errors: 0, gens: 0, day: k });
  if (s.day !== k) {
    const fresh = { messages: 0, groups: 0, dms: 0, errors: 0, gens: 0, day: k };
    stats.set('today', fresh);
    return fresh;
  }
  return s;
}

function bump(field, n = 1) {
  try {
    const s = ensureDay();
    s[field] = (s[field] || 0) + n;
    stats.set('today', s);
  } catch {}
}

function formatReport() {
  const s = ensureDay();
  let usage = '';
  try { usage = '\n\n' + usageTracker.formatReport(); } catch {}
  return (
    `📊 *Daily report* — ${s.day}\n` +
    `────────────────\n` +
    `Messages handled: ${s.messages}\n` +
    `· Groups: ${s.groups}\n` +
    `· DMs: ${s.dms}\n` +
    `Errors logged: ${s.errors}\n` +
    `Image/video gens: ${s.gens}\n` +
    `Gen quota (public): ${genQuota.LIMIT} / 6h\n` +
    usage +
    `\n_Auto report · Nick AI_`
  );
}

/**
 * Start interval: every 15 min check if we should send daily report to owners.
 * Sends once after 08:00 local (or UTC if TZ unset) when not yet sent for that day.
 */
function start(sock) {
  if (start._timer) return;
  const hour = Number(process.env.DAILY_REPORT_HOUR || 8);
  start._timer = setInterval(async () => {
    try {
      const now = new Date();
      const k = dayKey(now);
      const last = meta.get('lastSentDay', '');
      if (last === k) return;
      if (now.getHours() < hour) return;
      const text = formatReport();
      for (const oid of (config.ownerIds || []).slice(0, 5)) {
        const jid = String(oid).includes('@') ? oid : `${oid}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text }).catch(() => {});
      }
      meta.set('lastSentDay', k);
      logger.info({ day: k }, 'daily report sent');
    } catch (e) {
      logger.warn({ err: e.message }, 'daily report failed');
    }
  }, 15 * 60 * 1000);
}

module.exports = { bump, formatReport, start, ensureDay };

});

runtime.define("daemons", "daemons.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');
const logger = require('../logger');

// Fixed: the original called db.get/db.set which don't exist on db.js (it only
// exports Collection). Persist via a proper Collection keyed under a fixed key.
const store = new Collection('system_daemons', {});

function getSettings() {
  return store.get('settings', {
    daemonMode: true,  // respond to messages
    groupMode: true,   // respond in groups
  });
}

function setSettings(settings) {
  store.set('settings', settings);
  logger.info({ settings }, 'Daemon settings updated');
  return settings;
}

function toggleDaemon(enable) {
  const settings = getSettings();
  settings.daemonMode = enable;
  return setSettings(settings).daemonMode;
}

function toggleGroup(enable) {
  const settings = getSettings();
  settings.groupMode = enable;
  return setSettings(settings).groupMode;
}

function isDaemonActive() {
  return getSettings().daemonMode;
}

function isGroupModeActive() {
  return getSettings().groupMode;
}

module.exports = {
  getSettings,
  setSettings,
  toggleDaemon,
  toggleGroup,
  isDaemonActive,
  isGroupModeActive,
};

});

runtime.define("genQuota", "genQuota.js", function(module, exports, require, __filename, __dirname) {
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

});

runtime.define("selfheal", "selfheal.js", function(module, exports, require, __filename, __dirname) {
// The bot can diagnose its own startup/runtime health, create a backup, ask the active
// AI to propose a minimal patch, validate syntax, and only then apply it.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const BACKUP_ROOT = path.join(ROOT, '.selfheal-backups');

function run(cmd, args = [], timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, timeout, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code || 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function safePath(p) {
  const abs = path.resolve(ROOT, p);
  return abs.startsWith(SRC + path.sep) && !abs.includes(`${path.sep}node_modules${path.sep}`);
}

async function healthCheck() {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|cjs)$/.test(ent.name)) files.push(p);
    }
  };
  walk(SRC);
  const failures = [];
  for (const file of files) {
    const r = await run(process.execPath, ['--check', file], 10000);
    if (!r.ok) failures.push({ file: path.relative(ROOT, file), error: r.stderr || r.stdout });
  }
  return { ok: failures.length === 0, checked: files.length, failures };
}

async function repair(aiClient, reason = 'health check failed') {
  const health = await healthCheck();
  if (health.ok) return { ok: true, repaired: false, message: `Health check passed (${health.checked} JS files).` };

  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const backupDir = path.join(BACKUP_ROOT, String(Date.now()));
  fs.mkdirSync(backupDir, { recursive: true });

  const targets = health.failures.slice(0, 3);
  const changed = [];
  for (const failure of targets) {
    if (!safePath(failure.file)) continue;
    const abs = path.resolve(ROOT, failure.file);
    const content = fs.readFileSync(abs, 'utf8');
    fs.mkdirSync(path.dirname(path.join(backupDir, failure.file)), { recursive: true });
    fs.copyFileSync(abs, path.join(backupDir, failure.file));

    const prompt = `Repair this Node.js source file. Reason: ${reason}\nSyntax error: ${failure.error}\n\nFILE: ${failure.file}\n${content}\n\nReturn ONLY the complete corrected file content. Do not change unrelated behavior.`;
    let fixed;
    try { fixed = await aiClient.simpleComplete(prompt, 'You are a conservative production JavaScript repair agent. Return complete code only.'); }
    catch (e) { continue; }
    if (!fixed || fixed.length < 20) continue;
    fixed = fixed.replace(/^```(?:javascript|js)?\s*/i, '').replace(/```\s*$/i, '').trim();
    fs.writeFileSync(abs, fixed, 'utf8');
    const check = await run(process.execPath, ['--check', abs], 10000);
    if (check.ok) changed.push(failure.file);
    else fs.copyFileSync(path.join(backupDir, failure.file), abs);
  }

  const after = await healthCheck();
  return { ok: after.ok, repaired: changed.length > 0, changed, backupDir, health: after };
}

module.exports = { healthCheck, repair };

});
};
