
const LINK_RE = /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/)[^\s]+/i;

function numFromJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

function containsLink(text) {
  return LINK_RE.test(String(text || ''));
}

function containsGroupInviteLink(text) {
  return /chat\.whatsapp\.com\/[A-Za-z0-9]+/i.test(String(text || ''));
}

/**
 * Detects the special message WhatsApp posts into a group when someone mentions/tags that
 * group in their own Status update. The known Baileys/WAProto field name is
 * `groupStatusMentionMessage`, but proto field names have shifted across Baileys versions in
 * the past, so we also fall back to scanning for any key that looks like it (case-insensitive
 * "statusmention"). Safe either way — worst case this never matches and antigroupmention is a
 * no-op, rather than throwing.
 */
function isGroupStatusMentionMessage(mt) {
  if (!mt || typeof mt !== 'object') return false;
  // Catches: "mentioned group in status", group-status posts, bot-posted group statuses.
  const seen = new Set();
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return false;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      const k = String(key);
      if (/group.?status.?mention|status.?mention|groupStatusMention|statusMention|groupStatusMessage|group.?status.?message|statusPost|statusReply|associatedChildMessage|newsletterAdminInvite/i.test(k)) return true;
      if (/status.?mention|group.?status|status.?post/i.test(String(child?.messageType || child?.type || ''))) return true;
      if (child && typeof child === 'object' && walk(child, depth + 1)) return true;
    }
    return false;
  };
  return walk(mt);
}

/**
 * True for WhatsApp *group status* posts (the status feed attached to a group),
 * including bot-driven promo posts — broader than mention-only detection.
 */
function isGroupStatusPost(msg, mt) {
  if (isGroupStatusMentionMessage(mt)) return true;
  if (!msg || !mt) return false;
  const jid = String(msg.key?.remoteJid || '');
  if (/status@broadcast/i.test(jid)) return true;
  if (msg.messageStubParameters && /status|group.?status/i.test(JSON.stringify(msg.messageStubParameters))) return true;

  // Explicit group-status payload used by bot commands (gcstatus / groupStatusMessageV2)
  if (mt.groupStatusMessageV2 || mt.groupStatusMessage) return true;
  if (msg.message?.groupStatusMessageV2 || msg.message?.groupStatusMessage) return true;

  const gatherCtx = (node) => {
    if (!node || typeof node !== 'object') return [];
    const out = [];
    for (const k of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'conversation']) {
      const c = node[k]?.contextInfo || (k === 'conversation' ? null : null);
      if (node[k]?.contextInfo) out.push(node[k].contextInfo);
    }
    if (node.contextInfo) out.push(node.contextInfo);
    return out;
  };
  const ctxs = [
    ...gatherCtx(mt),
    ...gatherCtx(mt.groupStatusMessageV2?.message),
    ...gatherCtx(msg.message),
  ];
  for (const ctx of ctxs) {
    if (!ctx) continue;
    if (ctx.isGroupStatus === true || ctx.isStatusMention || ctx.groupStatusMentionMessage) return true;
    if (ctx.statusAttributionsType != null) return true;
    if (ctx.quotedMessage && (isGroupStatusMentionMessage(ctx.quotedMessage) || ctx.quotedMessage.groupStatusMessageV2)) return true;
  }
  if (msg.message && isGroupStatusMentionMessage(msg.message)) return true;
  return false;
}

/** Promo / bot spam signals often used on group-status ads (telegram, external bots). */
function looksLikeStatusPromo(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  // Telegram invite / channel spam is the most common "bot posted to group status" pattern
  if (/\b(?:t\.me|telegram\.me)\/\S+/i.test(t)) return true;
  if (/\b(?:join\s+(?:my|our)?\s*(?:channel|group)|tap\s*(?:here|now)|click\s*(?:here|link))\b/i.test(t) && /https?:\/\//i.test(t)) return true;
  if (/\b(?:wa\.me\/\d+|chat\.whatsapp\.com\/\S+)/i.test(t) && /\b(?:bot|auto|promo)\b/i.test(t)) return true;
  return false;
}

/** Extract phone numbers from a WhatsApp contact card (vCard / contactMessage). */
function phonesFromVcard(vcardOrContact) {
  const out = [];
  const push = (n) => {
    const d = String(n || '').replace(/\D/g, '');
    if (d.length >= 8 && d.length <= 15 && !out.includes(d)) out.push(d);
  };
  if (!vcardOrContact) return out;
  if (typeof vcardOrContact === 'string') {
    // TEL lines: TEL;type=CELL:+233... or TEL:+233... or item1.TEL:...
    const re = /TEL[^:]*:([+\d\s()-]+)/gi;
    let m;
    while ((m = re.exec(vcardOrContact)) !== null) push(m[1]);
    // Also bare waid= in some vcards: waid=233549268912
    const waid = /waid=(\d{8,15})/gi;
    while ((m = waid.exec(vcardOrContact)) !== null) push(m[1]);
    return out;
  }
  if (typeof vcardOrContact === 'object') {
    if (vcardOrContact.vcard) return phonesFromVcard(vcardOrContact.vcard);
    if (Array.isArray(vcardOrContact.vcard)) {
      for (const v of vcardOrContact.vcard) out.push(...phonesFromVcard(v));
      return out;
    }
    // contactsArrayMessage style
    if (Array.isArray(vcardOrContact.contacts)) {
      for (const c of vcardOrContact.contacts) out.push(...phonesFromVcard(c));
    }
  }
  return out;
}

/** Pull phone(s) from a Baileys message type object (current or quoted). */
function phonesFromMessageType(mt) {
  if (!mt || typeof mt !== 'object') return [];
  const out = [];
  const take = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.contactMessage) out.push(...phonesFromVcard(node.contactMessage));
    if (node.contactsArrayMessage) out.push(...phonesFromVcard(node.contactsArrayMessage));
    if (node.ephemeralMessage?.message) take(node.ephemeralMessage.message);
    if (node.viewOnceMessage?.message) take(node.viewOnceMessage.message);
    if (node.viewOnceMessageV2?.message) take(node.viewOnceMessageV2.message);
  };
  take(mt);
  const ctx =
    mt.extendedTextMessage?.contextInfo ||
    mt.imageMessage?.contextInfo ||
    mt.videoMessage?.contextInfo ||
    mt.conversation?.contextInfo ||
    null;
  if (ctx?.quotedMessage) take(ctx.quotedMessage);
  return [...new Set(out)];
}

/** Extract ```filename ...``` or ```lang ...``` fenced blocks from AI output. */
function extractCodeBlocks(answer) {
  const out = [];
  const re = /```([a-zA-Z0-9+#./_-]*)\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(answer || '')) !== null) {
    out.push({ language: m[1] || 'text', code: m[2].trim() });
  }
  return out;
}

function fmtCurrency(amount, name) {
  return `${Number(amount).toLocaleString('en-US')} ${name}`;
}

function chunkText(text, size = 4000) {
  const chunks = [];
  let s = String(text || '');
  while (s.length > size) {
    chunks.push(s.slice(0, size));
    s = s.slice(size);
  }
  if (s.length) chunks.push(s);
  return chunks;
}

function timeAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

module.exports = {
  numFromJid,
  isGroupJid,
  containsLink,
  containsGroupInviteLink,
  isGroupStatusMentionMessage,
  isGroupStatusPost,
  looksLikeStatusPromo,
  phonesFromVcard,
  phonesFromMessageType,
  extractCodeBlocks,
  fmtCurrency,
  chunkText,
  timeAgo,
};
