// deletehandler.js — delete a replied-to WhatsApp message (robust key variants).
const logger = require('../logger');
const { numFromJid } = require('../utils/helpers');
const autoreply = require('./autoreply');
const jidResolver = require('../utils/jidResolver');

function isDeleteCommand(text) {
  const t = String(text || '').trim();
  return /^(?:(?:broken|bot)\s+)?(?:please\s+)?(?:delete|remove|del)\s*(?:this|that|msg|message|it|status|the\s+status)?\s*$/i.test(t)
    || /^(?:(?:broken|bot)\s+)?(?:delete|remove)\s+(?:this|that)\s+(?:msg|message|status)\s*$/i.test(t)
    || /^(?:(?:broken|bot)\s+)?(?:delete|remove)\s+(?:the\s+)?(?:group\s+)?status\b/i.test(t)
    || /\b(?:delete|remove)\s+(?:this|that)\s+status\b/i.test(t);
}

function unwrapContext(message) {
  let cur = message || {};
  for (let i = 0; i < 8 && cur; i++) {
    const ctx =
      cur.extendedTextMessage?.contextInfo ||
      cur.imageMessage?.contextInfo ||
      cur.videoMessage?.contextInfo ||
      cur.audioMessage?.contextInfo ||
      cur.documentMessage?.contextInfo ||
      cur.stickerMessage?.contextInfo ||
      cur.contactMessage?.contextInfo;
    if (ctx?.stanzaId) return ctx;
    cur =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessage?.message ||
      cur.documentWithCaptionMessage?.message ||
      null;
  }
  return {};
}

function isBotIdentity(participant, botIds = []) {
  if (!participant) return false;
  const raw = String(participant);
  const n = numFromJid(raw);
  return botIds.some((id) => {
    const value = String(id || '');
    return value === raw || (n && numFromJid(value) === n);
  });
}

async function tryDelete(sock, jid, key) {
  // WhatsApp is picky about delete keys — try several shapes
  const attempts = [
    key,
    { remoteJid: jid, id: key.id, fromMe: !!key.fromMe, participant: key.participant },
    key.participant ? { remoteJid: jid, id: key.id, fromMe: false, participant: key.participant } : null,
    key.participant ? { remoteJid: jid, id: key.id, fromMe: true, participant: key.participant } : null,
  ].filter(Boolean);
  let lastErr;
  for (const k of attempts) {
    try {
      await sock.sendMessage(jid, { delete: k });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
}

async function handleDelete(sock, msg, deleteMessage, opts = {}) {
  try {
    const contextInfo = unwrapContext(msg.message);
    if (!contextInfo?.stanzaId) {
      return { success: false, message: '❌ Reply to the message you want removed, then say *delete*.' };
    }

    const botIds = [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid]
      .filter(Boolean)
      .map(String);
    const participantPn = contextInfo.participantPn || null;
    const participantAlt = contextInfo.participantAlt || null;
    const participant = participantPn || participantAlt || contextInfo.participant || undefined;

    const fromMe =
      !!contextInfo.quotedMessage?.key?.fromMe ||
      autoreply.isBotMessageReplied(msg) ||
      isBotIdentity(participant, botIds) ||
      isBotIdentity(participantAlt, botIds) ||
      isBotIdentity(participantPn, botIds);

    const base = {
      remoteJid: msg.key.remoteJid,
      id: String(contextInfo.stanzaId),
      fromMe,
    };

    // Try several key shapes — WhatsApp/Baileys is picky about participant format.
    const variants = [];
    const add = (k) => {
      const s = JSON.stringify(k);
      if (!variants.some((v) => JSON.stringify(v) === s)) variants.push(k);
    };
    add({ ...base });
    if (!fromMe && participant) add({ ...base, participant: String(participant) });
    if (!fromMe && participantPn) add({ ...base, participant: String(participantPn) });
    if (!fromMe && participantAlt) add({ ...base, participant: String(participantAlt) });
    if (!fromMe && contextInfo.participant) add({ ...base, participant: String(contextInfo.participant) });
    // Prefer PN over LID when both exist
    if (!fromMe && participantPn && String(participant || '').endsWith('@lid')) {
      add({ ...base, participant: String(participantPn) });
    }

    let lastErr = null;
    for (const key of variants) {
      try {
        if (typeof deleteMessage === 'function') {
          await deleteMessage(msg.key.remoteJid, key);
        } else {
          await tryDelete(sock, msg.key.remoteJid, key);
        }
        return { success: true, message: '✅ Message deleted.' };
      } catch (e) {
        lastErr = e;
        logger.warn({ err: e.message, key }, 'delete variant failed');
      }
    }
    return {
      success: false,
      message: `⚠️ Could not delete that message${lastErr ? `: ${lastErr.message}` : ''}. I may need admin rights, or the message is too old.`,
    };
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to delete message');
    return { success: false, message: `⚠️ Could not delete message: ${e.message}` };
  }
}

module.exports = { isDeleteCommand, handleDelete, unwrapContext };
