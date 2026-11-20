'use strict';

const logger = require('../logger');
const groupAdmin = require('../features').groupAdmin;
const moderation = require('../features').moderation;
const birthdays = require('../features').birthdays;
const permissions = require('../utils/permissions');
const roles = require('../features').roles;
const afk = require('../features').afk;
const { Collection } = require('../db');
const { numFromJid, toArray } = require('../utils/helpers');
const commandPrefix = require('./commandPrefix');
const messageLayout = require('../utils/messageLayout');
const groupControl = require('./groupControl');
const jidResolver = require('../utils/jidResolver');

const TIMER_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TAGS = 100;
const MAX_BULK_REMOVALS = 10;
const timers = new Map();
const groupLog = new Collection('group_chat_log', {});

function botJids(ctx) {
  return toArray(ctx.botJids).filter(Boolean).map(String);
}

const pictureSetCommands = ['gcicon', 'seticon', 'setppgc', 'setppgroup', 'setgcprofile'];
const pictureGetCommands = ['getgcpp', 'gcpic', 'grouppic', 'gcphoto'];
const requestedCommands = [
  'creategroup', 'newgroup', 'gcreate',
  'tagall', 'tag', 'mentionall', 'hidetag', 'htag', 'silent', 'tagadmins', 'tagadmin', 'mentionadmins', 'totag', 'pingtag', 'membertag', 'mtag',
  'antitagadmin', 'antitagadminon', 'antitagadminoff',
  'gcicon', 'seticon', 'getgcpp', 'gcpic', 'grouppic', 'gcphoto', 'removeicon', 'setname', 'setdesc', 'desc', 'groupdesc', 'setdescription', 'setgcname', 'setsubject', 'setppgc', 'setppgroup', 'setgcprofile',
  'close', 'open', 'editinfo', 'lockgroup', 'unlockgroup', 'mute', 'unmute',
  'invite', 'link', 'getlink', 'invitelink', 'linkgc', 'resetlink', 'revokelink', 'revoke',
  'add', 'kick', 'kickpick', 'remove', 'kickall', 'demote', 'demotepick', 'dismiss', 'promote', 'promot', 'promotepick',
  'approveall', 'rejectall', 'approve', 'reject',
  'listactive', 'active', 'activeusers', 'listinactive', 'inactive', 'inactiveusers', 'lurkers', 'kickinactive', 'purgeinactive', 'removeinactive',
  'groupinfo', 'groupid', 'gcid', 'gclist', 'grouplist', 'listgc', 'memberlist', 'members', 'groupmembers', 'groupstats', 'gcstats', 'gstats', 'chatstats', 'leaderboard', 'topactive',
  'birthday', 'bday', 'birthdays',
  'warn', 'warning', 'unwarn', 'unwarning',
  'welcome', 'goodbye', 'setwelcome', 'setevents', 'welcometoggle',
  'antilink', 'antilinkgc', 'antigrouplink', 'antitag', 'antitagadmin', 'antimentionGC', 'antimention', 'antimentiongroup', 'antibadword', 'addbadword', 'antisticker', 'nostic', 'nosticker', 'antispam', 'antiviewonce', 'antivo', 'antiview',
  'timer', 'countdown', 'poll', 'vote', 'afk', 'broadcast', 'announce', 'say', 'sayme', 'repeat', 'left', 'leave', 'join', 'j', 'joingc', 'delete', 'groupmenu', 'groupactions', 'groupsettings', 'disp-1', 'disp-7', 'disp-90', 'disp-off', 'roast', 'tagaway',
];
const pluginCommands = new Set(requestedCommands.map((name) => name.toLowerCase()));


function parsedInput(input) {
  const parsed = commandPrefix.parseCommand(input);
  return { parsed, text: parsed.text.trim(), needsPrefix: commandPrefix.needsPrefix(parsed) };
}

function isCommand(input) {
  const { text } = parsedInput(input);
  const first = text.match(/^([^\s]+)/)?.[1]?.toLowerCase().replace(/:$/, '');
  return pluginCommands.has(first);
}

function isGroupPictureCommand(input) {
  const { text } = parsedInput(input);
  const name = text.split(/\s+/, 1)[0].toLowerCase();
  return pictureSetCommands.includes(name);
}

function isOwner(ctx) {
  return !!ctx.isOwner || permissions.isOwner(ctx.senderJid) || roles.isOwner(ctx.senderJid);
}

function isParticipantAdmin(p) {
  return ['admin', 'superadmin', true].includes(p?.admin ?? p?.role)
    || p?.isAdmin === true || p?.isSuperAdmin === true;
}

function requireOwner(ctx) {
  return isOwner(ctx) ? null : messageLayout.accessDenied('owner');
}

function requireGroup(ctx, needBotAdmin = true) {
  if (!ctx.isGroup) return 'This command only works inside a WhatsApp group.';
  if (!groupControl.isGroupAdmin(ctx)) return messageLayout.accessDenied('group admin');
  if (needBotAdmin && !groupControl.isBotAdmin(ctx)) {
    return '⚠️ Make Nick a group admin first; WhatsApp will not let me change group settings yet.';
  }
  return null;
}

function requireGroupMember(ctx) {
  return ctx.isGroup ? null : 'This command only works inside a WhatsApp group.';
}

function displayName(participant) {
  return String(participant?.notify || participant?.name || participant?.verifiedName || numFromJid(participant?.id || participant?.jid) || 'member').trim();
}

function participantJid(participant) {
  return participant?.id || participant?.jid || participant?.phoneNumber || participant?.lid || null;
}

function mentionData(participants) {
  const entries = [];
  for (const participant of participants || []) {
    const jid = participant?.participantPn || participant?.phoneNumber || participant?.id
      || participant?.jid || participant?.lid || null;
    const number = numFromJid(jid);
    if (jid && number) entries.push({ jid: String(jid), number });
  }
  const unique = new Map(entries.map((entry) => [entry.jid, entry]));
  return [...unique.values()];
}

function getActivity(groupId, days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const messages = groupLog.get(groupId, []);
  const counts = new Map();
  for (const entry of Array.isArray(messages) ? messages : []) {
    if (!entry || Number(entry.at) < cutoff || !entry.sender) continue;
    const sender = numFromJid(entry.sender) || String(entry.sender);
    counts.set(sender, (counts.get(sender) || 0) + 1);
  }
  return counts;
}

function formatActivity(meta, activity, { inactive = false, limit = 35 } = {}) {
  const members = meta?.participants || [];
  const entries = members.map((p) => {
    const number = numFromJid(participantJid(p));
    const count = number ? (activity.get(number) || 0) : 0;
    return { p, count, number };
  }).filter((entry) => inactive ? entry.count === 0 : entry.count > 0);
  entries.sort((a, b) => inactive ? displayName(a.p).localeCompare(displayName(b.p)) : b.count - a.count);
  return entries.slice(0, limit).map((entry, i) => `${i + 1}. ${displayName(entry.p)}${entry.count ? ` — ${entry.count} msg(s)` : ''}`);
}

function helpText() {
  const prefix = commandPrefix.getPrefix();
  const p = (s) => `${prefix}${s}`;
  return [
    '*Nick AI · Group commands*',
    'Group changes require a group admin (or Nick’s owner); Nick must also be a group admin for WhatsApp changes.',
    '',
    `• ${p('tagall text')} / ${p('hidetag text')} — mention group members`,
    `• ${p('groupinfo')}, ${p('members')}, ${p('groupstats')} — group details`,
    `• ${p('gcname name')}, ${p('gcdesc text')}, ${p('gcpp')} — group profile`,
    `• ${p('close')} / ${p('open')}, ${p('lockgroup')} / ${p('unlockgroup')} — group settings`,
    `• ${p('antilink on|off')}, ${p('antisticker on|off')}, ${p('antiviewonce on|off')} — moderation`,
    `• ${p('kick @member')}, ${p('promote @member')}, ${p('demote @member')}, ${p('warn @member')}`,
    `• ${p('kickall confirm')} and ${p('kickinactive 30 confirm')} — owner-only, limited bulk removals`,
    'Use the configured command prefix when one is set.',
  ].join('\n');
}

async function metadata(ctx) {
  return ctx.groupMeta || groupAdmin.getMetadata(ctx.sock, ctx.chatId);
}

async function getInviteLink(ctx) {
  const code = await ctx.sock.groupInviteCode(ctx.chatId);
  return code ? `https://chat.whatsapp.com/${code}` : null;
}

async function sendMentions(ctx, name, body) {
  const meta = await metadata(ctx);
  let participants = meta.participants || [];
  if (['tagadmins', 'tagadmin', 'mentionadmins'].includes(name)) participants = participants.filter(isParticipantAdmin);
  const entries = mentionData(participants);
  if (!entries.length) return { handled: true, text: 'No mentionable group members were found.' };
  if (entries.length > MAX_TAGS) return { handled: true, text: `This group has ${entries.length} mentionable members. I cap one tag message at ${MAX_TAGS} people to prevent oversized/spammy sends.` };
  const hidden = ['hidetag', 'htag', 'silent'].includes(name);
  const message = String(body || '').trim();
  const tags = entries.map((entry) => `@${entry.number}`).join(' ');
  const text = hidden ? (message || '\u200b') : `${message ? `${message}\n` : ''}${tags}`;
  await ctx.sock.sendMessage(ctx.chatId, { text, mentions: entries.map((entry) => entry.jid) });
  return { handled: true, text: '' };
}

async function handleCreateGroup(ctx, commandText) {
  const denial = requireOwner(ctx);
  if (denial) return { handled: true, text: denial };
  const body = commandText.replace(/^(?:creategroup|newgroup|gcreate)\s*/i, '').trim();
  const participants = [...new Set((ctx.mentions || []).filter(Boolean).map(String))];
  if (!body || !participants.length) {
    return { handled: true, text: 'Usage: creategroup Group name (mention at least one participant).' };
  }
  if (participants.some((jid) => botJids(ctx).includes(jid))) {
    return { handled: true, text: 'Do not include Nick as a participant; WhatsApp adds the bot when it creates the group.' };
  }
  try {
    const result = await ctx.sock.groupCreate(body.slice(0, 100), participants);
    const groupId = result?.id || result?.gid;
    let link = '';
    if (groupId) {
      try {
        const code = await ctx.sock.groupInviteCode(groupId);
        if (code) link = `\nInvite: https://chat.whatsapp.com/${code}`;
      } catch {}
    }
    return { handled: true, text: `✅ Group created: ${result?.subject || body.slice(0, 100)}${groupId ? `\nID: ${groupId}` : ''}${link}` };
  } catch (e) {
    return { handled: true, text: `Could not create the group: ${e.message}` };
  }
}

async function handleRequestDecision(ctx, name) {
  const denial = requireGroup(ctx, true);
  if (denial) return { handled: true, text: denial };
  const action = name === 'approve' ? 'approve' : 'reject';
  let pending;
  try { pending = await ctx.sock.groupRequestParticipantsList(ctx.chatId); }
  catch (e) { return { handled: true, text: `Could not read pending requests: ${e.message}` }; }
  if (name === 'approveall' || name === 'rejectall') {
    const result = name === 'approveall'
      ? await groupAdmin.acceptAllPendingRequests(ctx.sock, ctx.chatId)
      : await groupAdmin.rejectAllPendingRequests(ctx.sock, ctx.chatId);
    if (!result.ok) return { handled: true, text: `Request processing failed: ${result.error || 'unknown error'}` };
    return { handled: true, text: name === 'approveall' ? `✅ Approved ${result.accepted} pending request(s).` : `✅ Rejected ${result.rejected} pending request(s).` };
  }
  const raw = (ctx.mentions || [])[0] || ctx.quotedParticipant || '';
  if (!raw) return { handled: true, text: `Mention or reply to one pending requester. Use ${name}all to process the full queue.` };
  const number = numFromJid(raw);
  const match = (pending || []).find((p) => {
    const ids = [p.jid, p.id, p.phoneNumber].filter(Boolean).map(String);
    return ids.includes(String(raw)) || (number && ids.some((id) => numFromJid(id) === number));
  });
  const jid = match?.jid || match?.id;
  if (!jid) return { handled: true, text: 'That person is not in the pending request list.' };
  try {
    await ctx.sock.groupRequestParticipantsUpdate(ctx.chatId, [jid], action);
    return { handled: true, text: action === 'approve' ? '✅ Join request approved.' : '✅ Join request rejected.' };
  } catch (e) {
    return { handled: true, text: `Could not ${action} that request: ${e.message}` };
  }
}

async function handleBulkKick(ctx, name, tail) {
  const ownerOnly = ['kickall', 'kickinactive', 'purgeinactive', 'removeinactive'].includes(name);
  if (ownerOnly && !isOwner(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };
  const denial = requireGroup(ctx, true);
  if (denial) return { handled: true, text: denial };
  const meta = await metadata(ctx);
  const args = tail.trim().split(/\s+/).filter(Boolean);
  const days = Math.max(1, Math.min(365, Number(args[0]) || 30));
  if (!args.some((arg) => /^confirm$/i.test(arg))) {
    return { handled: true, text: name === 'kickall'
      ? 'This removes every eligible non-admin member. To proceed, run `kickall confirm`. Only up to 10 members are removed per run.'
      : `This removes members with no observed messages in the last ${days} day(s). To proceed, run \`kickinactive ${days} confirm\`. Only up to 10 members are removed per run.` };
  }
  const eligible = (meta.participants || []).filter((p) => {
    if (isParticipantAdmin(p)) return false;
    const ids = [p?.id, p?.jid, p?.lid, p?.phoneNumber].filter(Boolean).map(String);
    if (botJids(ctx).some((id) => ids.includes(String(id)))) return false;
    if (roles.isOwner(ids)) return false;
    if (name === 'kickall') return true;
    const number = ids.map(numFromJid).find(Boolean);
    const activity = getActivity(ctx.chatId, days);
    return !number || !activity.has(number);
  });
  if (!eligible.length) return { handled: true, text: name === 'kickall' ? 'No eligible non-admin members to remove.' : `No inactive members found for the last ${days} day(s).` };
  if (eligible.length > MAX_BULK_REMOVALS) {
    return { handled: true, text: `${eligible.length} members qualify. For safety, this command removes at most ${MAX_BULK_REMOVALS} per run; review the member list and use a narrower scope.` };
  }
  try {
    const ids = eligible.map(participantJid).filter(Boolean);
    await groupAdmin.kick(ctx.sock, ctx.chatId, ids);
    return { handled: true, text: `✅ Removed ${ids.length} eligible member(s).` };
  } catch (e) {
    return { handled: true, text: `Could not remove members: ${e.message}` };
  }
}

async function route(ctx, input) {
  const { parsed, text, needsPrefix } = parsedInput(input);
  const firstToken = text.match(/^([^\s]+)/)?.[1]?.toLowerCase();
  if (!pluginCommands.has(firstToken)) return { handled: false };
  const match = text.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return { handled: false };
  const name = match[1].toLowerCase();
  const tail = (match[2] || '').trim();

  // Existing feature commands keep their original implementation; this module makes them
  // explicitly callable in group chats and catalogs them in the group menu.
  const passthrough = new Set(['poll', 'vote', 'afk', 'delete']);
  if (passthrough.has(name)) return { handled: false };
  if (needsPrefix) return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };

  if (['creategroup', 'newgroup', 'gcreate'].includes(name)) return handleCreateGroup(ctx, text);
  if (['join', 'j', 'joingc'].includes(name)) {
    const denial = requireOwner(ctx);
    if (denial) return { handled: true, text: denial };
    // "Slide to a link": the invite may be in the message being replied to.
    const linkSources = [tail, ctx.quotedText || ''].filter(Boolean).join('\n');
    let code = (linkSources.match(/(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i) || [])[1];
    if (!code) {
      const bare = linkSources.trim().split(/\s+/)[0] || '';
      if (/^[A-Za-z0-9_-]{8,}$/.test(bare)) code = bare;
    }
    if (!code) return { handled: true, text: 'Include a WhatsApp group invite link, or reply to a message containing one and send `join` / `j`.' };
    try { await ctx.sock.groupAcceptInvite(code); return { handled: true, text: '✅ Joined the group.' }; }
    catch (e) { return { handled: true, text: `Could not join the group: ${e.message}` }; }
  }
  if (['left', 'leave'].includes(name)) {
    const denial = requireOwner(ctx);
    if (denial) return { handled: true, text: denial };
    if (!ctx.isGroup) return { handled: true, text: 'Use `left confirm` inside the group Nick should leave.' };
    if (!/^confirm$/i.test(tail)) return { handled: true, text: 'This makes Nick leave the current group. To proceed, run `left confirm`.' };
    try { await groupAdmin.leaveGroup(ctx.sock, ctx.chatId); return { handled: true, text: '✅ Nick left the group.' }; }
    catch (e) { return { handled: true, text: `Could not leave the group: ${e.message}` }; }
  }
  if (['gclist', 'grouplist', 'listgc'].includes(name)) {
    const denial = requireOwner(ctx);
    if (denial) return { handled: true, text: denial };
    try {
      const groups = await ctx.sock.groupFetchAllParticipating();
      const list = Object.entries(groups || {}).slice(0, 40);
      return { handled: true, text: list.length ? `👥 *Groups (${Object.keys(groups).length})*\n${list.map(([id, g], i) => `${i + 1}. ${g.subject || id} (${g.participants?.length || 0})`).join('\n')}` : 'Nick is not in any groups.' };
    } catch (e) { return { handled: true, text: `Could not list groups: ${e.message}` }; }
  }
  // Current-group commands can share short names with bot profile/access commands.
  if (!ctx.isGroup && ['setname', 'open', 'close', 'mute', 'unmute', 'invite', 'link', 'getlink', 'invitelink', 'linkgc', 'resetlink', 'revokelink', 'revoke'].includes(name)) return { handled: false };
  if (['groupmenu', 'groupactions', 'groupsettings'].includes(name)) return { handled: true, text: helpText() };
  if (['listonline', 'online', 'whoonline'].includes(name)) {
    if (!ctx.isGroup) return { handled: true, text: 'This command only works inside a WhatsApp group.' };
    return { handled: true, text: 'WhatsApp does not provide a reliable group-wide online roster to bots, so I cannot list members as online.' };
  }
  if (['leaderboard'].includes(name) && /^schedule\b/i.test(tail)) return { handled: false };

  if (name === 'invite' || ['link', 'getlink', 'invitelink', 'linkgc'].includes(name)) {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    try {
      const link = await getInviteLink(ctx);
      return { handled: true, text: link ? `🔗 ${link}` : 'Could not read the invite link.' };
    } catch (e) { return { handled: true, text: `Could not fetch the invite link: ${e.message}` }; }
  }
  if (['resetlink', 'revokelink', 'revoke'].includes(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    try {
      await ctx.sock.groupRevokeInvite(ctx.chatId);
      const link = await getInviteLink(ctx);
      return { handled: true, text: `✅ Invite link reset.${link ? `\nNew link: ${link}` : ''}` };
    } catch (e) { return { handled: true, text: `Could not reset the invite link: ${e.message}` }; }
  }
  if (pictureGetCommands.includes(name)) {
    const denial = requireGroupMember(ctx);
    if (denial) return { handled: true, text: denial };
    try {
      const url = await ctx.sock.profilePictureUrl(ctx.chatId, 'image');
      return { handled: true, text: url ? `🖼️ Group photo: ${url}` : 'No group photo is available.' };
    } catch { return { handled: true, text: 'No group photo is available, or WhatsApp privacy settings restrict it.' }; }
  }
  if (name === 'removeicon') {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    if (typeof ctx.sock.removeProfilePicture !== 'function') return { handled: true, text: 'This WhatsApp client does not expose a safe group-photo removal API.' };
    try { await ctx.sock.removeProfilePicture(ctx.chatId); return { handled: true, text: '✅ Group photo removed.' }; }
    catch (e) { return { handled: true, text: `Could not remove the group photo: ${e.message}` }; }
  }
  if (['groupinfo', 'groupid', 'gcid', 'groupstats', 'gcstats', 'gstats'].includes(name)) {
    const denial = requireGroupMember(ctx);
    if (denial) return { handled: true, text: denial };
    try {
      const meta = await metadata(ctx);
      const participants = meta.participants || [];
      const admins = participants.filter(isParticipantAdmin).length;
      if (['groupid', 'gcid'].includes(name)) return { handled: true, text: `🆔 Group ID: ${ctx.chatId}` };
      if (['groupstats', 'gcstats', 'gstats'].includes(name)) return { handled: true, text: `📊 *${meta.subject || 'Group stats'}*\nMembers: ${participants.length}\nAdmins: ${admins}\nObserved messages: ${(groupLog.get(ctx.chatId, []) || []).length}` };
      const description = String(meta.desc || meta.description || '').trim();
      return { handled: true, text: `👥 *${meta.subject || 'Group'}*\nMembers: ${participants.length}\nAdmins: ${admins}${meta.owner ? `\nCreated by: ${displayName({ id: meta.owner })}` : ''}${description ? `\nDescription: ${description.slice(0, 500)}` : ''}` };
    } catch (e) { return { handled: true, text: `Could not read group information: ${e.message}` }; }
  }
  if (['memberlist', 'members', 'groupmembers'].includes(name)) {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    const meta = await metadata(ctx);
    const list = (meta.participants || []).slice(0, 60).map((p, i) => `${i + 1}. ${displayName(p)}${isParticipantAdmin(p) ? ' (admin)' : ''}`);
    return { handled: true, text: list.length ? `👥 *Members (${(meta.participants || []).length})*\n${list.join('\n')}${(meta.participants || []).length > 60 ? '\n… list capped at 60' : ''}` : 'No members found.' };
  }
  if (name === 'tagaway') {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const meta = await metadata(ctx);
    const away = (meta.participants || []).map((p) => {
      const identities = [p?.participantPn, p?.phoneNumber, p?.participantAlt, p?.id, p?.jid, p?.lid].filter(Boolean);
      return { p, status: identities.map((id) => afk.getAfk(id)).find(Boolean) };
    }).filter((entry) => entry.status);
    if (!away.length) return { handled: true, text: 'No group members are currently marked AFK.' };
    const entries = mentionData(away.map((entry) => entry.p));
    const lines = away.slice(0, MAX_TAGS).map(({ p, status }) => `• @${numFromJid(participantJid(p)) || displayName(p)} — ${String(status.reason || 'AFK').slice(0, 120)}`);
    await ctx.sock.sendMessage(ctx.chatId, { text: `💤 *Away members*\n${lines.join('\n')}`, mentions: entries.slice(0, MAX_TAGS).map((entry) => entry.jid) });
    return { handled: true, text: '' };
  }
  if (['chatstats', 'leaderboard', 'topactive', 'listactive', 'active', 'activeusers', 'listinactive', 'inactive', 'inactiveusers', 'lurkers'].includes(name)) {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    const days = Math.max(1, Math.min(365, Number(tail.match(/\d+/)?.[0]) || 7));
    const meta = await metadata(ctx);
    const activity = getActivity(ctx.chatId, days);
    if (name === 'chatstats') return { handled: true, text: `📊 *Chat stats*\nMembers: ${(meta.participants || []).length}\nObserved messages in last ${days} day(s): ${(groupLog.get(ctx.chatId, []) || []).filter((m) => Number(m.at) >= Date.now() - days * 86400000).length}\nActive members: ${formatActivity(meta, activity).length}` };
    const inactive = ['listinactive', 'inactive', 'inactiveusers', 'lurkers'].includes(name);
    const entries = formatActivity(meta, activity, { inactive, limit: 40 });
    return { handled: true, text: entries.length ? `${inactive ? '💤' : '🔥'} *${inactive ? 'Inactive' : 'Active'} members — ${days} day(s)*\n${entries.join('\n')}${(meta.participants || []).length > 40 ? '\n… list capped at 40' : ''}` : (inactive ? 'No inactive members found.' : 'No recent activity is recorded yet.') };
  }
  if (['birthday', 'bday', 'birthdays'].includes(name)) {
    const remove = /^(?:remove|delete|clear)$/i.test(tail);
    if (remove) {
      const result = birthdays.removeBirthday(ctx.senderJid);
      return { handled: true, text: result.ok ? '✅ Your birthday was removed.' : result.error };
    }
    const date = tail.match(/^(?:(?:set)\s+)?(\d{1,2})[/-](\d{1,2})$/i)
      || tail.match(/^(?:(?:set)\s+)?(\d{1,2})\s+(\d{1,2})$/i);
    if (date) {
      const result = birthdays.setBirthday(ctx.senderJid, ctx.chatId, Number(date[1]), Number(date[2]));
      if (!result.ok) return { handled: true, text: `Could not save that birthday: ${result.error}` };
      return { handled: true, text: `🎂 Birthday saved as ${result.month}/${result.day}. I’ll announce it in this chat.` };
    }
    const own = birthdays.getBirthday(ctx.senderJid);
    if (own) return { handled: true, text: `Your saved birthday is ${own.month}/${own.day}. Use ${name} MM/DD to change it or ${name} remove to clear it.` };
    return { handled: true, text: `Set your birthday with ${name} MM/DD (for example, ${name} 8/24). Use ${name} remove to clear it.` };
  }
  if (['kickall', 'kickinactive', 'purgeinactive', 'removeinactive'].includes(name)) return handleBulkKick(ctx, name, tail);

  if (name === 'add') {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const target = (ctx.mentions || [])[0] || ctx.quotedParticipant;
    if (!target) return { handled: true, text: 'Mention one person to add to this group.' };
    const meta = await metadata(ctx);
    const existing = (meta.participants || []).some((p) => [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).some((id) => String(id) === String(target) || (numFromJid(id) && numFromJid(id) === numFromJid(target))));
    if (existing) return { handled: true, text: 'That person is already in the group.' };
    try {
      const result = await groupAdmin.add(ctx.sock, ctx.chatId, target);
      if (!result.ok && result.inviteLink) return { handled: true, text: `${result.error}\nInvite link: ${result.inviteLink}` };
      return { handled: true, text: result.ok ? '✅ Add request sent.' : `Could not add that person: ${result.error || 'WhatsApp rejected the request.'}` };
    } catch (e) { return { handled: true, text: `Could not add that person: ${e.message}` }; }
  }

  if (['warn', 'warning', 'unwarn', 'unwarning'].includes(name)) {
    const isWarn = ['warn', 'warning'].includes(name);
    const denial = requireGroup(ctx, isWarn);
    if (denial) return { handled: true, text: denial };
    const target = groupControl.findTarget(ctx);
    if (target.error) return { handled: true, text: target.error };
    const userId = numFromJid(target.targetJid);
    if (!userId) return { handled: true, text: 'Could not resolve that member’s phone identity for warning storage.' };
    if (!isWarn) {
      moderation.clearWarnings(ctx.chatId, userId);
      return { handled: true, text: `✅ Cleared warnings for ${displayName(target.participant)}.` };
    }
    const count = moderation.addWarning(ctx.chatId, userId);
    const settings = moderation.getSettings(ctx.chatId);
    if (settings.warnBeforeKick && count >= settings.maxWarnings) {
      try {
        await groupAdmin.kick(ctx.sock, ctx.chatId, target.targetJid);
        moderation.clearWarnings(ctx.chatId, userId);
        return { handled: true, text: `⛔ ${displayName(target.participant)} reached the warning limit (${count}) and was removed.` };
      } catch (e) { return { handled: true, text: `⚠️ ${displayName(target.participant)} now has ${count} warnings, but removal failed: ${e.message}` }; }
    }
    return { handled: true, text: `⚠️ ${displayName(target.participant)} has ${count} warning(s).` };
  }

  const memberVerb = ({ remove: 'kick', dismiss: 'demote', promot: 'promote', demotepick: 'demote', promotepick: 'promote', kickpick: 'kick' })[name] || (['kick', 'promote', 'demote'].includes(name) ? name : null);
  if (memberVerb) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const target = groupControl.findTarget(ctx);
    if (target.error) return { handled: true, text: target.error };
    if (['kick', 'demote'].includes(memberVerb) && ['superadmin', 'super-admin'].includes(String(target.participant.admin ?? target.participant.role).toLowerCase())) {
      return { handled: true, text: 'I will not remove or demote the group creator.' };
    }
    try {
      await groupAdmin[memberVerb](ctx.sock, ctx.chatId, target.targetJid);
      const label = { add: 'added', kick: 'removed', promote: 'promoted to admin', demote: 'demoted to member' }[memberVerb];
      return { handled: true, text: `✅ ${displayName(target.participant)} ${label}.` };
    } catch (e) { return { handled: true, text: `WhatsApp could not complete that action: ${e.message}` }; }
  }
  if (['approve', 'reject', 'approveall', 'rejectall'].includes(name)) return handleRequestDecision(ctx, name);

  const settingAliases = {
    antilink: 'antilink', antilinkgc: 'antilink', antigrouplink: 'antigrouplink',
    antitag: 'antitag', antimentiongc: 'antitag', antimention: 'antitag', antimentiongroup: 'antitag', antitagadmin: 'antitagadmin', antitagadminon: 'antitagadmin', antitagadminoff: 'antitagadmin',
    antibadword: 'antibadword', antisticker: 'antisticker', nostic: 'antisticker', nosticker: 'antisticker',
    antispam: 'antiflood', antiviewonce: 'antiviewonce', antivo: 'antiviewonce', antiview: 'antiviewonce',
  };
  if (settingAliases[name]) {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    const key = settingAliases[name];
    const forced = name === 'antitagadminon' ? true : name === 'antitagadminoff' ? false : null;
    const action = forced === null ? tail.toLowerCase() : (forced ? 'on' : 'off');
    if (!action) {
      const value = !!moderation.getSettings(ctx.chatId)[key];
      return { handled: true, text: `🛡️ ${key} is ${value ? 'ON' : 'OFF'}. Use ${name} on/off to change it.` };
    }
    if (!/^(?:on|off|enable|disable)$/i.test(action)) return { handled: true, text: `Use ${name} on or ${name} off.` };
    const enabled = /^(?:on|enable)$/i.test(action);
    if (['antitag', 'antitagadmin', 'antibadword', 'antisticker', 'antiflood', 'antiviewonce'].includes(key)) {
      const botGate = ['antitag', 'antitagadmin', 'antibadword', 'antisticker', 'antiviewonce', 'antiflood'].includes(key);
      const adminDenial = requireGroup(ctx, botGate);
      if (adminDenial) return { handled: true, text: adminDenial };
    }
    moderation.updateSettings(ctx.chatId, { [key]: enabled });
    return { handled: true, text: `🛡️ ${key} is now *${enabled ? 'ON' : 'OFF'}* in this group.` };
  }
  if (name === 'addbadword') {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    if (!tail) return { handled: true, text: 'Usage: addbadword word.' };
    const settings = moderation.getSettings(ctx.chatId);
    const word = tail.toLowerCase().trim().slice(0, 64);
    const badwords = [...new Set([...(settings.badwords || []), word])].slice(0, 100);
    moderation.updateSettings(ctx.chatId, { badwords });
    return { handled: true, text: `✅ Added “${word}” to the group filter. Toggle it with antibadword on/off.` };
  }

  if (['tagall', 'tag', 'mentionall', 'hidetag', 'htag', 'silent', 'tagadmins', 'tagadmin', 'mentionadmins', 'totag', 'pingtag', 'membertag', 'mtag'].includes(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    return sendMentions(ctx, name, tail);
  }
  if (['antitagadminon', 'antitagadminoff'].includes(name)) return { handled: true, text: 'Use antitagadmin on/off.' };

  if (['setname', 'setgcname', 'setsubject'].includes(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    if (!tail) return { handled: true, text: `Current group name: ${(await metadata(ctx)).subject || '(unnamed)'}` };
    try { await groupAdmin.setSubject(ctx.sock, ctx.chatId, tail); return { handled: true, text: '✅ Group name updated.' }; }
    catch (e) { return { handled: true, text: `Could not update the group name: ${e.message}` }; }
  }
  if (['setdesc', 'desc', 'groupdesc', 'setdescription'].includes(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    if (!tail) return { handled: true, text: `Current group description: ${(await metadata(ctx)).desc || '(empty)'}` };
    try { await groupAdmin.setDescription(ctx.sock, ctx.chatId, tail); return { handled: true, text: '✅ Group description updated.' }; }
    catch (e) { return { handled: true, text: `Could not update the group description: ${e.message}` }; }
  }
  if (['close', 'open', 'mute', 'unmute', 'editinfo', 'lockgroup', 'unlockgroup'].includes(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const close = ['close', 'mute'].includes(name);
    const infoLock = ['editinfo', 'lockgroup', 'unlockgroup'].includes(name);
    const locked = infoLock ? name !== 'unlockgroup' : close;
    try {
      if (infoLock) await groupAdmin.setInfoLocked(ctx.sock, ctx.chatId, locked);
      else await groupAdmin.setMuted(ctx.sock, ctx.chatId, close);
      return { handled: true, text: infoLock ? `🔒 Group info edits ${locked ? 'locked' : 'unlocked'}.` : `🔒 Group chat ${close ? 'closed to non-admin messages' : 'reopened'}.` };
    } catch (e) { return { handled: true, text: `WhatsApp could not change the setting: ${e.message}` }; }
  }
  if (['welcome', 'goodbye', 'setwelcome', 'setevents', 'welcometoggle'].includes(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const settings = moderation.getSettings(ctx.chatId);
    if (name === 'setwelcome') {
      if (!tail) return { handled: true, text: 'Usage: setwelcome Welcome {name} to {group}.' };
      moderation.updateSettings(ctx.chatId, { welcomeMessage: tail.slice(0, 500), welcome: true });
      return { handled: true, text: '✅ Welcome message saved and enabled.' };
    }
    if (name === 'setevents') {
      if (!/^(on|off)$/i.test(tail)) return { handled: true, text: 'Use setevents on/off.' };
      const enabled = tail.toLowerCase() === 'on';
      moderation.updateSettings(ctx.chatId, { welcome: enabled, goodbye: enabled });
      return { handled: true, text: `✅ Join/leave messages ${enabled ? 'enabled' : 'disabled'}.` };
    }
    if (name === 'welcometoggle') {
      const enabled = !settings.welcome;
      moderation.updateSettings(ctx.chatId, { welcome: enabled });
      return { handled: true, text: `✅ Welcome messages ${enabled ? 'enabled' : 'disabled'}.` };
    }
    const key = name;
    if (!tail) return { handled: true, text: `${name} messages are ${settings[key] ? 'ON' : 'OFF'}. Use ${name} on/off.` };
    if (!/^(on|off)$/i.test(tail)) return { handled: true, text: `Use ${name} on/off.` };
    const enabled = tail.toLowerCase() === 'on';
    moderation.updateSettings(ctx.chatId, { [key]: enabled });
    return { handled: true, text: `✅ ${name} messages ${enabled ? 'enabled' : 'disabled'}.` };
  }
  if (['timer', 'countdown'].includes(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const timerMatch = tail.match(/^([^\s]+)\s+([\s\S]+)$/);
    const durationMs = timerMatch ? moderation.parseDuration(timerMatch[1]) : null;
    const message = timerMatch?.[2]?.trim();
    if (!durationMs || !message) return { handled: true, text: 'Usage: timer 5m Message to send (maximum 7 days).' };
    if (durationMs > TIMER_LIMIT_MS) return { handled: true, text: 'Timers are limited to 7 days.' };
    const groupTimers = timers.get(ctx.chatId) || new Set();
    if (groupTimers.size >= 5) return { handled: true, text: 'There are already 5 pending timers in this group.' };
    const timer = setTimeout(async () => {
      groupTimers.delete(timer);
      if (!groupTimers.size) timers.delete(ctx.chatId);
      try { await ctx.sock.sendMessage(ctx.chatId, { text: `⏰ ${message}` }); } catch {}
    }, durationMs);
    timer.unref?.();
    groupTimers.add(timer);
    timers.set(ctx.chatId, groupTimers);
    return { handled: true, text: `⏰ Timer set for ${moderation.formatDuration(durationMs)}.` };
  }
  if (/^disp-(?:1|7|90|off)$/.test(name)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    if (typeof ctx.sock.groupToggleEphemeral !== 'function') return { handled: true, text: 'This WhatsApp client does not support changing disappearing-message timers.' };
    const seconds = name === 'disp-off' ? 0 : name === 'disp-1' ? 86400 : name === 'disp-7' ? 7 * 86400 : 90 * 86400;
    try { await ctx.sock.groupToggleEphemeral(ctx.chatId, seconds); return { handled: true, text: seconds ? `✅ Disappearing messages set to ${seconds / 86400} day(s).` : '✅ Disappearing messages turned off.' }; }
    catch (e) { return { handled: true, text: `Could not update disappearing messages: ${e.message}` }; }
  }
  if (name === 'announce' || name === 'broadcast' || name === 'say' || name === 'repeat' || name === 'sayme') {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    const message = tail || (ctx.quotedText || '').trim();
    if (!message) return { handled: true, text: `Usage: ${name} message text.` };
    const actor = numFromJid(ctx.senderJid);
    if (name === 'sayme' && actor) await ctx.sock.sendMessage(ctx.chatId, { text: `${message} @${actor}`, mentions: [ctx.senderJid] });
    else await ctx.sock.sendMessage(ctx.chatId, { text: message });
    return { handled: true, text: '' };
  }
  if (name === 'roast') {
    const denial = requireGroupMember(ctx);
    if (denial) return { handled: true, text: denial };
    const target = groupControl.findTarget(ctx);
    if (target.error) return { handled: true, text: target.error };
    return { handled: true, text: `😄 ${displayName(target.participant)} has the confidence of a Wi-Fi signal with one bar.` };
  }
  if (name === 'antitagadminon' || name === 'antitagadminoff') return { handled: true, text: 'Use antitagadmin on/off.' };
  return { handled: false };
}

async function handleMedia(ctx, input, imageBuffer) {
  if (!isGroupPictureCommand(input)) return { handled: false };
  const { parsed } = parsedInput(input);
  if (commandPrefix.needsPrefix(parsed)) return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${parsed.text}\`` };
  const denial = requireGroup(ctx, true);
  if (denial) return { handled: true, text: denial };
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return { handled: true, text: 'Send or reply to an image with this command to change the group photo.' };
  try { await groupAdmin.setPicture(ctx.sock, ctx.chatId, imageBuffer); return { handled: true, text: '✅ Group photo updated.' }; }
  catch (e) { return { handled: true, text: `Could not update the group photo: ${e.message}` }; }
}

async function handleParticipantUpdate(sock, event) {
  const groupId = event?.id;
  if (!groupId || !String(groupId).endsWith('@g.us')) return;
  const action = String(event.action || '').toLowerCase();
  if (!['add', 'remove', 'leave'].includes(action)) return;
  const settings = moderation.getSettings(groupId);
  const enabled = action === 'add' ? settings.welcome : settings.goodbye;
  if (!enabled) return;
  const meta = await sock.groupMetadata(groupId).catch(() => null);
  const members = jidResolver.normalizeMany(event.participants || [], jidResolver.buildMap(sock, { key: {} }, meta));
  const mentions = [...new Set(members.filter(Boolean).map(String))];
  if (!mentions.length) return;
  const label = action === 'add' ? 'welcome' : 'goodbye';
  const template = String(action === 'add' ? settings.welcomeMessage : settings.goodbyeMessage || '').trim();
  const names = mentions.map((jid) => `@${numFromJid(jid) || jid.split('@')[0]}`).join(', ');
  const text = template
    ? template.replace(/\{name\}/gi, names).replace(/\{group\}/gi, String(meta?.subject || 'the group'))
    : action === 'add' ? `Welcome ${names} to ${meta?.subject || 'the group'}!` : `${names} left ${meta?.subject || 'the group'}.`;
  try { await sock.sendMessage(groupId, { text: text.slice(0, 1000), mentions }); }
  catch (e) { logger.warn({ err: e.message, label }, 'group welcome/goodbye message failed'); }
}

const menuCommands = [...new Set(requestedCommands)];

function clearAllLogs() {
  const count = Object.keys(groupLog.all()).length;
  for (const key of Object.keys(groupLog.all())) groupLog.delete(key);
  return count;
}

function getLogs(chatId, limit = 200) {
  const logs = groupLog.get(chatId, []) || [];
  return logs.slice(-Math.max(1, Math.min(500, Number(limit) || 200)));
}

module.exports = {
  route,
  clearAllLogs,
  getLogs,
  handleMedia,
  handleParticipantUpdate,
  isCommand,
  isGroupPictureCommand,
  menuCommands,
  helpText,
  getActivity,
};
