const config = require('../config');
const { numFromJid } = require('./helpers');
const roles = require('../features').roles;

function isOwner(senderJid) {
  return roles.isOwner(senderJid);
}

function isSudo(senderJid) {
  return roles.isSudo(senderJid);
}

function isAdmin(senderJid) {
  return roles.isAdmin(senderJid);
}

/** groupMeta is the result of sock.groupMetadata(jid). */
function identityValues(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return [];
  const out = new Set([raw]);
  // Keep both the exact JID and its numeric part. Exact matching is important for
  // @lid identities; numeric matching is useful for normal phone JIDs.
  const num = numFromJid(raw);
  if (num) out.add(num);
  return [...out];
}

function isGroupAdmin(senderJid, groupMeta, alternateJids = []) {
  if (!groupMeta) return false;
  const candidates = [...new Set([senderJid, ...alternateJids].filter(Boolean))];
  const exact = new Set(candidates.map(String));
  const nums = new Set(candidates.map(numFromJid).filter(Boolean));

  const participant = (groupMeta.participants || []).find((p) => {
    if (!p) return false;
    const role = p.admin ?? p.role;
    if (!(role === 'admin' || role === 'superadmin' || role === true || p.isAdmin === true || p.isSuperAdmin === true)) return false;
    const ids = [p.id, p.jid, p.lid, p.phoneNumber, p.participantAlt, p.participantPn]
      .filter(Boolean).map(String);
    if (ids.some((id) => exact.has(id))) return true;
    return ids.map(numFromJid).filter(Boolean).some((n) => nums.has(n));
  });
  return !!participant;
}

function botIsGroupAdmin(botJid, groupMeta, alternateJids = []) {
  if (!groupMeta) return false;
  const ids = [...new Set([botJid, ...alternateJids].filter(Boolean).map(String))];
  const exact = new Set(ids);
  const nums = new Set(ids.map(numFromJid).filter(Boolean));
  return (groupMeta.participants || []).some((p) => {
    const role = p?.admin ?? p?.role;
    const admin = role === 'admin' || role === 'superadmin' || role === true || p?.isAdmin === true || p?.isSuperAdmin === true;
    if (!admin) return false;
    const values = [p?.id, p?.jid, p?.lid, p?.phoneNumber, p?.participantAlt, p?.participantPn].filter(Boolean).map(String);
    return values.some((v) => exact.has(v) || (numFromJid(v) && nums.has(numFromJid(v))));
  });
}

function canModerate(senderJid, groupMeta) {
  return isOwner(senderJid) || isGroupAdmin(senderJid, groupMeta);
}

module.exports = { isOwner, isSudo, isAdmin, isGroupAdmin, botIsGroupAdmin, canModerate, identityValues };
