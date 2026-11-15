// callHandler.js — WhatsApp call events (Baileys multi-device).
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
