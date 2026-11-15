// whatsapp/connection.js — Baileys connect, pairing, reconnect (avoids ghost/401 loops).
// Fixed: pairing code now waits for the user to link (long grace window) instead of
// timing out and immediately requesting a new code.
const baileys = require('@lordeagle21/baileys');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = baileys;
const makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore || ((keys) => keys);
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../logger');
const pino = require('pino');

const msgStore = new Map();
const MSG_STORE_MAX = 2000;

function rememberMessage(msg) {
  try {
    const id = msg?.key?.id;
    if (!id) return;
    msgStore.set(id, msg);
    if (msgStore.size > MSG_STORE_MAX) {
      const first = msgStore.keys().next().value;
      msgStore.delete(first);
    }
  } catch {}
}

let reconnectAttempts = 0;
let reconnectTimer = null;
let activeSocket = null;
let connectInProgress = false;
let pairingRequested = false;
let pairingInFlight = false;
/** Timestamp when a pairing code was successfully issued. During the grace window we refuse to spam new codes and we delay reconnects. */
let pairingCodeIssuedAt = 0;
/** Last pairing code string (kept so we can re-print it on reconnects during the wait). */
let lastPairingCode = null;
let lastPairingPhone = null;
let pairingReminderTimer = null;

const PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 45000);
const PING_TIMEOUT_MS = Number(process.env.WS_PING_TIMEOUT_MS || 25000);
/** How long (ms) to wait for the user to enter the pairing code on their phone before allowing a new code. Default 3 minutes. */
const PAIRING_GRACE_MS = Number(process.env.PAIRING_GRACE_MS || 180000);
/** Connect timeout while waiting for pairing — give WhatsApp more time. */
const PAIRING_CONNECT_TIMEOUT_MS = Number(process.env.PAIRING_CONNECT_TIMEOUT_MS || 120000);

function sessionsDir() {
  return path.join(process.cwd(), 'sessions');
}

function isInPairingGrace() {
  return pairingRequested && pairingCodeIssuedAt > 0 && (Date.now() - pairingCodeIssuedAt) < PAIRING_GRACE_MS;
}

function clearPairingReminder() {
  if (pairingReminderTimer) {
    clearInterval(pairingReminderTimer);
    pairingReminderTimer = null;
  }
}

function startPairingReminder() {
  clearPairingReminder();
  // Re-print the same code every 25s so the user can still see it if the terminal scrolled.
  pairingReminderTimer = setInterval(() => {
    if (!isInPairingGrace() || !lastPairingCode) {
      clearPairingReminder();
      return;
    }
    const remaining = Math.max(0, Math.ceil((PAIRING_GRACE_MS - (Date.now() - pairingCodeIssuedAt)) / 1000));
    console.log('\n----------------------------------------');
    console.log(`  STILL WAITING — enter this code on your phone`);
    console.log(`  PAIRING CODE:  ${lastPairingCode}`);
    console.log(`  Phone:         ${lastPairingPhone}`);
    console.log(`  Time left:     ~${remaining}s`);
    console.log('  WhatsApp → Linked Devices → Link with phone number');
    console.log('----------------------------------------\n');
  }, 25000);
}

function archiveDeadSession(reason) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return false;
  try {
    const files = fs.readdirSync(dir).filter((f) => f !== '.' && f !== '..');
    if (!files.length) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = path.join(process.cwd(), `sessions_dead_${stamp}`);
    fs.renameSync(dir, bak);
    fs.mkdirSync(dir, { recursive: true });
    logger.warn({ reason, bak }, 'Archived dead WhatsApp session — next start will pair fresh');
    return true;
  } catch (e) {
    try {
      for (const f of fs.readdirSync(dir)) {
        try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch {}
      }
      logger.warn({ reason, err: e.message }, 'Cleared sessions/ contents for re-pair');
      return true;
    } catch (e2) {
      logger.error({ err: e2.message }, 'Could not clear sessions');
      return false;
    }
  }
}

async function requestPairing(sock) {
  // Never request a new code while one is already in flight or while we are still
  // inside the grace window after a successful issue (user may still be typing it).
  if (pairingInFlight) return;
  if (isInPairingGrace()) {
    logger.info(
      { remainingMs: PAIRING_GRACE_MS - (Date.now() - pairingCodeIssuedAt), code: lastPairingCode },
      'pairing code still valid — waiting for you to link on phone (not requesting a new one)'
    );
    return;
  }
  if (pairingRequested && !isInPairingGrace()) {
    // Grace expired — allow a fresh code on next successful request.
    pairingRequested = false;
  }
  if (!config.whatsapp.usePairingCode || !config.whatsapp.pairingNumber) return;
  if (sock?.authState?.creds?.registered) return;

  pairingInFlight = true;
  const phone = String(config.whatsapp.pairingNumber).replace(/\D/g, '');
  if (phone.length < 8) {
    logger.error('WHATSAPP_PAIRING_NUMBER looks invalid (need full country code digits)');
    pairingInFlight = false;
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Small delay so the socket is fully ready (Baileys pair-device stanza).
      await new Promise((r) => setTimeout(r, attempt === 1 ? 2000 : 3000));
      if (!sock || sock.ws?.readyState === 3) break;
      if (sock.authState?.creds?.registered) {
        pairingInFlight = false;
        return;
      }

      const code = await sock.requestPairingCode(phone);
      pairingRequested = true;
      pairingCodeIssuedAt = Date.now();
      lastPairingCode = code;
      lastPairingPhone = phone;

      console.log('\n========================================');
      console.log(`  PAIRING CODE:  ${code}`);
      console.log(`  Phone:         ${phone}`);
      console.log('  WhatsApp → Linked Devices → Link with phone number');
      console.log(`  You have ~${Math.round(PAIRING_GRACE_MS / 1000)} seconds — the bot will WAIT.`);
      console.log('  Do NOT restart. Just enter the code on your phone.');
      console.log('========================================\n');
      logger.info({ code, phone, graceMs: PAIRING_GRACE_MS }, 'pairing code issued — waiting for link');
      startPairingReminder();
      pairingInFlight = false;
      return;
    } catch (e) {
      logger.warn({ err: e.message, attempt }, 'pairing code request failed');
      if (/logged out|401|already in progress/i.test(e.message)) break;
    }
  }
  pairingInFlight = false;
}

async function connect(onSocket) {
  if (activeSocket && activeSocket.ws?.readyState === 1) return activeSocket;
  if (connectInProgress) return activeSocket;
  connectInProgress = true;

  try {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);

    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest?.version;
    } catch (e) {
      logger.warn({ err: e.message }, 'Baileys version lookup failed; using default');
    }

    const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
    const needsPairing = !state.creds?.registered && config.whatsapp.usePairingCode && config.whatsapp.pairingNumber;

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers.ubuntu('Chrome'),
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      fireInitQueries: false,
      markOnlineOnConnect: false,
      emitOwnEvents: true,
      // Longer timeout while pairing so the socket does not die before you type the code.
      connectTimeoutMs: needsPairing || isInPairingGrace() ? PAIRING_CONNECT_TIMEOUT_MS : 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      getMessage: async (key) => {
        const id = key?.id;
        if (id && msgStore.has(id)) return msgStore.get(id)?.message || undefined;
        return undefined;
      },
    });

    // Only reset pairing flags when we truly have no session (fresh start).
    // Do NOT reset if we are still inside the grace window from a previous code.
    if (!sock.authState.creds.registered && !isInPairingGrace()) {
      pairingRequested = false;
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages || []) rememberMessage(m);
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Official Baileys pattern: request pairing code when the `qr` event fires
      // (even in pairing-code mode the event is emitted as the readiness signal).
      if (!sock.authState.creds.registered && config.whatsapp.usePairingCode) {
        if (qr) {
          requestPairing(sock).catch(() => {});
        } else if ((connection === 'connecting' || connection === 'open') && !pairingRequested && !pairingInFlight) {
          // Fallback trigger if qr event is delayed.
          requestPairing(sock).catch(() => {});
        }
      }

      if (qr && !config.whatsapp.usePairingCode) {
        console.log('\n=== Scan this QR with WhatsApp ===\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        logger.info('✅ Connected to WhatsApp');
        clearPairingReminder();
        try {
          const me = sock.user?.id || sock.authState?.creds?.me?.id;
          logger.info({ me, owners: config.ownerIds }, 'identity + owners loaded');
        } catch {}
        reconnectAttempts = 0;
        pairingRequested = true;
        pairingCodeIssuedAt = 0;
        lastPairingCode = null;

        // Browser/Playwright/Puppeteer are NOT auto-installed — they fill disk (ENOSPC)
        // and are only needed when the user explicitly asks for browser/preview tools.
        // Opt-in: set AUTO_INSTALL_BROWSERS=true or call ensureBrowsers() from a tool.
        if ((process.env.AUTO_INSTALL_BROWSERS || '').toLowerCase() === 'true') {
          try {
            require('../browser/bootstrap').ensureBrowsers().catch((e) => {
              logger.warn({ err: e.message }, 'post-connect browser setup failed');
            });
          } catch (e) {
            logger.warn({ err: e.message }, 'post-connect browser bootstrap unavailable');
          }
        } else {
          logger.info('browser auto-install skipped (set AUTO_INSTALL_BROWSERS=true to enable)');
        }

        try {
          if (sock.__keepAliveTimer) clearInterval(sock.__keepAliveTimer);
          sock.__keepAliveTimer = setInterval(() => {
            try {
              if (activeSocket !== sock) return;
              sock.sendPresenceUpdate('available').catch(() => {});
            } catch {}
          }, 25000);
        } catch {}

        try {
          if (sock.__pingTimer) clearInterval(sock.__pingTimer);
          let pingPending = false;
          sock.__pingTimer = setInterval(() => {
            try {
              if (activeSocket !== sock || !sock.ws) return;
              if (pingPending) {
                sock.__missedPongs = (sock.__missedPongs || 0) + 1;
                if (sock.__missedPongs >= 2) {
                  logger.warn({ jid: sock.user?.id || 'unknown', missed: sock.__missedPongs }, 'ping watchdog: no pong x2, forcing reconnect');
                  sock.end(new Error('WebSocket watchdog timeout — no pong received'));
                  return;
                }
                logger.warn({ missed: sock.__missedPongs }, 'ping watchdog: missed pong, will retry before reconnect');
              } else {
                sock.__missedPongs = 0;
              }
              pingPending = true;
              try { sock.ws.ping(); } catch {}
              setTimeout(() => { pingPending = false; }, PING_TIMEOUT_MS);
            } catch {}
          }, PING_INTERVAL_MS);
        } catch {}
      } else if (connection === 'close') {
        if (activeSocket && activeSocket !== sock) return;
        activeSocket = null;
        try {
          if (sock.__keepAliveTimer) { clearInterval(sock.__keepAliveTimer); sock.__keepAliveTimer = null; }
          if (sock.__pingTimer) { clearInterval(sock.__pingTimer); sock.__pingTimer = null; }
        } catch {}

        const statusCode = lastDisconnect?.error?.output?.statusCode
          ?? lastDisconnect?.error?.output?.payload?.statusCode
          ?? lastDisconnect?.error?.status;
        const errMsg = lastDisconnect?.error?.message || '';
        const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || /logged out/i.test(errMsg);
        const timedOut = statusCode === DisconnectReason.timedOut || statusCode === 408 || /timed out|timeout/i.test(errMsg);

        logger.warn({ code: statusCode, loggedOut, timedOut, errMsg, inGrace: isInPairingGrace() }, 'connection closed');

        // ----- PAIRING GRACE WINDOW -----
        // If we already gave the user a code and they haven't finished linking yet,
        // do NOT clear the session and do NOT request a brand-new code immediately.
        // Just wait a bit and reconnect while keeping the same code state.
        if (isInPairingGrace() && !loggedOut) {
          const remaining = Math.max(5000, PAIRING_GRACE_MS - (Date.now() - pairingCodeIssuedAt));
          const delay = Math.min(remaining, timedOut ? 15000 : 10000);
          logger.info(
            { delayMs: delay, code: lastPairingCode },
            'still in pairing grace — reconnecting slowly, SAME code stays valid. Enter it on your phone now.'
          );
          if (lastPairingCode) {
            console.log(`\n  ⏳ Connection paused while waiting for you to enter code: ${lastPairingCode}`);
            console.log('  Keep the WhatsApp "Link with phone number" screen open and type the code.\n');
          }
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(async () => {
              reconnectTimer = null;
              try { await connect(onSocket); } catch (e) { logger.error({ err: e.message }, 'grace reconnect failed'); }
            }, delay);
          }
          return;
        }

        const clearOnLogout = process.env.CLEAR_SESSION_ON_LOGOUT !== 'false';
        if (loggedOut && clearOnLogout) {
          logger.error('WhatsApp session is dead (401/loggedOut). Clearing sessions so a NEW pairing code can be issued on next connect.');
          archiveDeadSession(`logout_${statusCode || '401'}`);
          pairingRequested = false;
          pairingCodeIssuedAt = 0;
          lastPairingCode = null;
          clearPairingReminder();
          reconnectAttempts = 0;
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(async () => {
              reconnectTimer = null;
              try { await connect(onSocket); } catch (e) { logger.error({ err: e.message }, 're-pair connect failed'); }
            }, 5000);
          }
          return;
        }

        if (/conflict/i.test(errMsg)) {
          logger.warn('Session conflict — wait 45s (stop other bot instances / WhatsApp Web using this number).');
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(async () => {
              reconnectTimer = null;
              try { await connect(onSocket); } catch (e) { logger.error({ err: e.message }, 'conflict reconnect failed'); }
            }, 45000);
          }
          return;
        }

        // Normal reconnect (not in pairing grace).
        if (!reconnectTimer) {
          reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
          const delay = Math.min(3000 * Math.pow(2, reconnectAttempts - 1), 90000);
          logger.info(`reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
          reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try { await connect(onSocket); } catch (e) { logger.error({ err: e.message }, 'reconnect failed'); }
          }, delay);
        }
      }
    });

    try { require('../features/callHandler').attach(sock); } catch (e) {
      logger.warn({ err: e.message }, 'call handler attach failed');
    }

    activeSocket = sock;
    onSocket(sock);
    return sock;
  } finally {
    connectInProgress = false;
  }
}

module.exports = { connect, rememberMessage, archiveDeadSession };
