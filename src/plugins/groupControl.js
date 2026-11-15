'use strict';

const groupAdmin = require('../features/groupAdmin');
const moderation = require('../features/moderation');
const permissions = require('../utils/permissions');
const roles = require('../features/roles');
const { numFromJid } = require('../utils/helpers');
const commandPrefix = require('./commandPrefix');

const PROTECTION_KEYS = new Map([
  ['antilink', 'antilink'],
  ['antigrouplink', 'antigrouplink'],
  ['antitag', 'antitag'],
  ['antibadword', 'antibadword'],
]);

function command(label) {
  return `${commandPrefix.getPrefix()}${label}`;
}

function helpText() {
  return [
    '*Nick AI · Group controls*',
    'Stats are available to group members. Changes require a WhatsApp group admin (or Nick’s owner) and Nick must also be a group admin.',
    '',
    `• \`${command('group stats')}\` — member/admin counts`,
    `• \`${command('group open')}\` / \`${command('group close')}\` — allow admins only / reopen messages`,
    `• \`${command('group lock')}\` / \`${command('group unlock')}\` — lock/unlock group info edits`,
    `• \`${command('group protection')}\` — show link/tag/bad-word protection settings`,
    `• \`${command('group antilink on|off')}\` and \`${command('group antigrouplink on|off')}\``,
    `• \`${command('group antitag on|off')}\` and \`${command('group antibadword on|off')}\``,
    `• \`${command('group warnings')}\` — list active warnings`,
    `• \`${command('group warn @member')}\` / \`${command('group clearwarnings @member')}\` — manage one member’s warnings`,
    `• \`${command('group kick @member')}\`, \`${command('group promote @member')}\`, \`${command('group demote @member')}\``,
    'For member actions, mention exactly one person or reply to their message. A configured prefix is required for commands after it is set.',
  ].join('\n');
}

function isGroupPluginCommand(input) {
  const parsed = commandPrefix.parseCommand(input);
  return /^group(?:\s|$)/i.test(parsed.text);
}

function isGroupAdmin(ctx) {
  return !!ctx.isOwner || permissions.isOwner(ctx.senderJid)
    || permissions.isGroupAdmin(ctx.senderJid, ctx.groupMeta, ctx.senderAliases || []);
}

function isBotAdmin(ctx) {
  const ids = ctx.botJids || [ctx.sock?.user?.id, ctx.sock?.user?.lid].filter(Boolean);
  return permissions.botIsGroupAdmin(ids[0], ctx.groupMeta, ids);
}

function findTarget(ctx) {
  const mentions = [...new Set((ctx.mentions || []).filter(Boolean).map(String))];
  if (mentions.length > 1) return { error: 'Choose one member per command.' };
  const raw = mentions[0] || ctx.quotedParticipant;
  if (!raw) return { error: 'Mention one member or reply to their message.' };
  const rawNum = numFromJid(raw);
  const participants = ctx.groupMeta?.participants || [];
  const participant = participants.find((p) => {
    const ids = [p?.id, p?.jid, p?.lid, p?.phoneNumber, p?.participantAlt, p?.participantPn]
      .filter(Boolean).map(String);
    return ids.includes(String(raw)) || (rawNum && ids.some((id) => numFromJid(id) === rawNum));
  });
  if (!participant) return { error: 'That person is not in this group (or their WhatsApp identity could not be resolved).' };
  const targetIds = [participant.id, participant.jid, participant.lid, participant.phoneNumber]
    .filter(Boolean).map(String);
  const targetJid = participant.id || participant.jid || participant.phoneNumber || participant.lid;
  if (!targetJid) return { error: 'Could not resolve the group member.' };
  if (roles.isOwner(targetIds)) return { error: 'I will not target a configured bot owner.' };
  const botIds = ctx.botJids || [];
  if (botIds.some((id) => targetIds.includes(String(id)))) return { error: 'I will not target my own group account.' };
  return { participant, targetJid };
}

function requireGroup(ctx, needBotAdmin = true) {
  if (!ctx.isGroup) return 'This command only works inside a WhatsApp group.';
  if (!isGroupAdmin(ctx)) return '🔒 Group-admin only.';
  if (needBotAdmin && !isBotAdmin(ctx)) return '⚠️ Make Nick a group admin first; WhatsApp will not let me change group settings yet.';
  return null;
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!/^group(?:\s|$)/i.test(text)) return { handled: false };

  const action = text.replace(/^group\s*/i, '').trim() || 'menu';
  const menu = /^(?:menu|help|commands)$/i.test(action);
  if (commandPrefix.needsPrefix(parsed) && !menu) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }
  if (menu) return { handled: true, text: helpText() };
  if (!ctx.isGroup) return { handled: true, text: 'Group controls must be used inside a WhatsApp group.' };

  if (/^stats$/i.test(action)) {
    try {
      const meta = ctx.groupMeta || await groupAdmin.getMetadata(ctx.sock, ctx.chatId);
      const members = meta.participants || [];
      const admins = members.filter((p) => ['admin', 'superadmin', true].includes(p.admin ?? p.role) || p.isAdmin === true || p.isSuperAdmin === true).length;
      return { handled: true, text: `📊 *${meta.subject || 'Group stats'}*\nMembers: ${members.length}\nAdmins: ${admins}` };
    } catch (e) {
      return { handled: true, text: `Could not read group stats: ${e.message}` };
    }
  }

  if (/^(?:protection|settings)$/i.test(action)) {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    const settings = moderation.getSettings(ctx.chatId);
    const flags = [...PROTECTION_KEYS.entries()].map(([label, key]) => `• ${label}: ${settings[key] ? 'ON' : 'OFF'}`);
    return { handled: true, text: `🛡️ *Group protection*\n${flags.join('\n')}` };
  }

  const protectionChange = action.match(/^(antilink|antigrouplink|antitag|antibadword)\s+(on|off)$/i);
  if (protectionChange) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const settingKey = PROTECTION_KEYS.get(protectionChange[1].toLowerCase());
    const enabled = protectionChange[2].toLowerCase() === 'on';
    moderation.updateSettings(ctx.chatId, { [settingKey]: enabled });
    return { handled: true, text: `🛡️ ${settingKey} is now *${enabled ? 'ON' : 'OFF'}* in this group.` };
  }

  if (/^(?:open|close|lock|unlock)$/i.test(action)) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    try {
      if (/^(?:open|close)$/i.test(action)) {
        const closed = action.toLowerCase() === 'close';
        await groupAdmin.setMuted(ctx.sock, ctx.chatId, closed);
        return { handled: true, text: closed ? '🔒 Group closed: only admins can send messages.' : '🔓 Group reopened: members can send messages.' };
      }
      const locked = action.toLowerCase() === 'lock';
      await groupAdmin.setInfoLocked(ctx.sock, ctx.chatId, locked);
      return { handled: true, text: locked ? '🔒 Group info changes locked to admins.' : '🔓 Group info changes unlocked.' };
    } catch (e) {
      return { handled: true, text: `WhatsApp could not change the group setting: ${e.message}` };
    }
  }

  if (/^warnings?$/i.test(action)) {
    const denial = requireGroup(ctx, false);
    if (denial) return { handled: true, text: denial };
    const meta = ctx.groupMeta || await groupAdmin.getMetadata(ctx.sock, ctx.chatId).catch(() => null);
    const active = (meta?.participants || []).map((p) => {
      const ids = [p.id, p.jid, p.phoneNumber, p.lid].filter(Boolean);
      const userId = ids.map(numFromJid).find(Boolean);
      const count = userId ? moderation.getWarnings(ctx.chatId, userId) : 0;
      return count ? `• ${p.notify || p.name || userId}: ${count}` : null;
    }).filter(Boolean);
    return { handled: true, text: active.length ? `⚠️ *Active warnings*\n${active.join('\n')}` : 'No active warnings.' };
  }

  const warningAction = action.match(/^(warn|clearwarnings)(?:\s+.*)?$/i);
  if (warningAction) {
    const shouldWarn = warningAction[1].toLowerCase() === 'warn';
    const denial = requireGroup(ctx, shouldWarn);
    if (denial) return { handled: true, text: denial };
    const target = findTarget(ctx);
    if (target.error) return { handled: true, text: target.error };
    const userId = numFromJid(target.targetJid);
    if (!userId) return { handled: true, text: 'Could not resolve that member’s phone identity for warning storage.' };
    if (!shouldWarn) {
      moderation.clearWarnings(ctx.chatId, userId);
      return { handled: true, text: `✅ Cleared warnings for ${target.participant.notify || target.participant.name || userId}.` };
    }
    const count = moderation.addWarning(ctx.chatId, userId);
    const settings = moderation.getSettings(ctx.chatId);
    const who = target.participant.notify || target.participant.name || userId;
    if (settings.warnBeforeKick && count >= settings.maxWarnings) {
      try {
        await groupAdmin.kick(ctx.sock, ctx.chatId, target.targetJid);
        moderation.clearWarnings(ctx.chatId, userId);
        return { handled: true, text: `⛔ ${who} reached the warning limit (${count}) and was removed.` };
      } catch (e) {
        return { handled: true, text: `⚠️ ${who} now has ${count} warnings, but removal failed: ${e.message}` };
      }
    }
    return { handled: true, text: `⚠️ ${who} has ${count}${settings.maxWarnings ? `/${settings.maxWarnings}` : ''} warning(s).` };
  }

  const memberAction = action.match(/^(kick|promote|demote)(?:\s+.*)?$/i);
  if (memberAction) {
    const denial = requireGroup(ctx, true);
    if (denial) return { handled: true, text: denial };
    const target = findTarget(ctx);
    if (target.error) return { handled: true, text: target.error };
    const targetRole = target.participant.admin ?? target.participant.role;
    if (['kick', 'demote'].includes(memberAction[1].toLowerCase()) && targetRole === 'superadmin') {
      return { handled: true, text: 'I will not remove or demote the group creator.' };
    }
    try {
      const verb = memberAction[1].toLowerCase();
      await groupAdmin[verb](ctx.sock, ctx.chatId, target.targetJid);
      const who = target.participant.notify || target.participant.name || numFromJid(target.targetJid);
      const status = { kick: 'removed', promote: 'promoted to admin', demote: 'demoted to member' }[verb];
      return { handled: true, text: `✅ ${who} ${status}.` };
    } catch (e) {
      return { handled: true, text: `WhatsApp could not complete that action: ${e.message}` };
    }
  }

  return { handled: true, text: helpText() };
}

module.exports = { route, isGroupPluginCommand, helpText };
