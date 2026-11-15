'use strict';

/**
 * Real WhatsApp group administration helpers (Baileys).
 * Replaces the previous compatibility stub so all group_* tools work.
 */

async function getMetadata(sock, jid) {
  if (!sock || !jid) throw new Error('sock and jid required');
  return sock.groupMetadata(jid);
}

async function kick(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'remove');
  return { ok: true, result: res };
}

async function add(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'add');
  const failed = (Array.isArray(res) ? res : []).filter(
    (r) => r.status && String(r.status) !== '200'
  );
  if (failed.length) {
    let inviteLink = null;
    try {
      const code = await sock.groupInviteCode(jid);
      if (code) inviteLink = `https://chat.whatsapp.com/${code}`;
    } catch (_) {}
    return {
      ok: false,
      error: 'Could not add member(s) (privacy or not on WhatsApp). Share the invite link instead.',
      inviteLink,
      result: res,
    };
  }
  return { ok: true, result: res };
}

async function promote(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'promote');
  return { ok: true, result: res };
}

async function demote(sock, jid, participantJid) {
  const target = Array.isArray(participantJid) ? participantJid : [participantJid];
  const res = await sock.groupParticipantsUpdate(jid, target, 'demote');
  return { ok: true, result: res };
}

async function setMuted(sock, jid, muted) {
  await sock.groupSettingUpdate(jid, muted ? 'announcement' : 'not_announcement');
  return { ok: true, muted: !!muted };
}

async function setInfoLocked(sock, jid, locked) {
  await sock.groupSettingUpdate(jid, locked ? 'locked' : 'unlocked');
  return { ok: true, locked: !!locked };
}

async function setSubject(sock, jid, subject) {
  await sock.groupUpdateSubject(jid, String(subject || '').slice(0, 100));
  return { ok: true };
}

async function setDescription(sock, jid, description) {
  await sock.groupUpdateDescription(jid, String(description || '').slice(0, 500));
  return { ok: true };
}

async function setPicture(sock, jid, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('picture buffer required');
  await sock.updateProfilePicture(jid, buffer);
  return { ok: true };
}

async function tagAllMentions(sock, jid) {
  const meta = await getMetadata(sock, jid);
  return (meta.participants || []).map((p) => p.id).filter(Boolean);
}

async function leaveGroup(sock, jid) {
  await sock.groupLeave(jid);
  return { ok: true };
}

async function acceptPendingRequests(sock, jid, count = 5) {
  let list = [];
  try {
    list = await sock.groupRequestParticipantsList(jid);
  } catch (e) {
    return { ok: false, error: e.message, accepted: 0 };
  }
  const toApprove = (list || []).slice(0, Math.max(1, Number(count) || 5)).map((p) => p.jid || p.id).filter(Boolean);
  if (!toApprove.length) return { ok: true, accepted: 0, note: 'No pending requests' };
  const res = await sock.groupRequestParticipantsUpdate(jid, toApprove, 'approve');
  return { ok: true, accepted: toApprove.length, result: res };
}

async function acceptAllPendingRequests(sock, jid) {
  let list = [];
  try {
    list = await sock.groupRequestParticipantsList(jid);
  } catch (e) {
    return { ok: false, error: e.message, accepted: 0 };
  }
  const toApprove = (list || []).map((p) => p.jid || p.id).filter(Boolean);
  if (!toApprove.length) return { ok: true, accepted: 0, note: 'No pending requests' };
  const res = await sock.groupRequestParticipantsUpdate(jid, toApprove, 'approve');
  return { ok: true, accepted: toApprove.length, result: res };
}

async function rejectAllPendingRequests(sock, jid) {
  let list = [];
  try {
    list = await sock.groupRequestParticipantsList(jid);
  } catch (e) {
    return { ok: false, error: e.message, rejected: 0 };
  }
  const toReject = (list || []).map((p) => p.jid || p.id).filter(Boolean);
  if (!toReject.length) return { ok: true, rejected: 0, note: 'No pending requests' };
  const res = await sock.groupRequestParticipantsUpdate(jid, toReject, 'reject');
  return { ok: true, rejected: toReject.length, result: res };
}

module.exports = {
  getMetadata, kick, add, promote, demote, setMuted, setInfoLocked,
  setSubject, setDescription, setPicture, tagAllMentions, leaveGroup,
  acceptPendingRequests, acceptAllPendingRequests, rejectAllPendingRequests,
};
