'use strict';

const roles = require('../features').roles;
const commandPrefix = require('./commandPrefix');
const { numFromJid, toArray } = require('../utils/helpers');
const messageLayout = require('../utils/messageLayout');

function isOwnerPluginCommand(input) {
  const parsed = commandPrefix.parseCommand(input);
  return /^(?:owner\s+(?:menu|help|commands|status|daemon|groups)|restart(?:\s|$)|addowner(?:\s|$)|setprefix(?:\s|$)|setpp(?:\s|$)|vps\s+service(?:\s|$))/i.test(parsed.text);
}

function isSetProfilePictureCommand(input) {
  return /^setpp$/i.test(commandPrefix.parseCommand(input).text.trim());
}

function command(label) {
  return `${commandPrefix.getPrefix()}${label}`;
}

const menuCommands = [
  'owner menu', 'owner help', 'owner commands', 'owner status', 'model', 'private', 'public', 'owner daemon', 'owner groups',
  'restart', 'addowner', 'addsudo', 'addadmin', 'roles', 'setpp', 'vps service',
];

function ownerMenu() {
  const allowlist = String(process.env.VPS_ALLOWED_SERVICES || '').split(',').map((x) => x.trim()).filter(Boolean);
  const lines = [
    '*Nick AI · Owner commands*',
    `• \`${command('owner status')}\` — runtime, access mode and active model`,
    `• \`${command('model')}\` — view/switch the AI provider`,
    `• \`${command('private')}\` / \`${command('public')}\` — change bot access mode`,
    `• \`${command('owner daemon on|off|status')}\` / \`${command('owner groups on|off|status')}\` — control response modes`,
    `• \`${command('restart')}\` — restart through the VPS supervisor`,
    `• \`${command('addowner @member')}\` — add an owner (mention/reply or phone number)`,
    `• \`${command('addsudo @member')}\` / \`${command('addadmin @member')}\` — grant scoped bot roles`,
    `• \`${command('roles')}\` — list bot roles`,
    '• `setprefix !` — set a prefix for these plug-in commands; `setprefix off` clears it (always works without a prefix)',
    `• Send or reply to an image with \`${command('setpp')}\` — set Nick’s WhatsApp profile photo`,
    `• \`${command('vps service <action> unit.service')}\` — action is status/start/stop/restart; allowlisted units only`,
  ];
  if (!allowlist.length) lines.push('  VPS service control is currently disabled: `VPS_ALLOWED_SERVICES` is empty.');
  else lines.push(`  Allowlisted units: ${allowlist.join(', ')}`);
  return lines.join('\n');
}

function getExplicitOwner(ctx) {
  return !!ctx.isOwner || roles.isOwner(ctx.senderJid);
}

function resolveOwnerTarget(ctx, rawTarget) {
  const mentions = [...new Set((ctx.mentions || []).filter(Boolean).map(String))];
  if (mentions.length > 1) return { error: 'Add one owner per command.' };
  const raw = mentions[0] || ctx.quotedParticipant || rawTarget;
  if (!raw) return { error: 'Usage: `addowner @member` or reply to their message with `addowner`.' };
  if (/@lid$/i.test(String(raw))) return { error: 'I could not resolve that WhatsApp LID to a phone number. Mention the member again or provide their country-code phone number.' };
  const digits = numFromJid(raw).replace(/\D/g, '');
  if (!/^\d{7,15}$/.test(digits)) return { error: 'Provide one valid country-code phone number, mention, or reply target.' };
  return { digits };
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isOwnerPluginCommand(input)) return { handled: false };
  const exempt = /^setprefix(?:\s|$)|^owner\s+(?:menu|help|commands)$/i.test(text);
  if (commandPrefix.needsPrefix(parsed) && !exempt) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }
  if (!getExplicitOwner(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };

  if (/^owner\s+(?:menu|help|commands)$/i.test(text)) {
    return { handled: true, text: ownerMenu() };
  }

  if (/^restart(?:\s|$)/i.test(text)) {
    if (!/^restart$/i.test(text)) {
      return { handled: true, text: `Usage: \`${command('restart')}\`.` };
    }
    if (process.env.NICK_AI_SUPERVISED !== '1') {
      return { handled: true, text: 'Restart is not active because Nick AI was started directly. Start it with `npm start` (or `npm run start:supervisor`) to enable supervised restarts.' };
    }
    return { handled: true, text: '♻️ Restarting Nick AI through the VPS supervisor. I should be back shortly.', restartAfterReply: true };
  }

  if (/^owner\s+status$/i.test(text)) {
    try {
      const obsidian = require('../features').obsidian;
      const daemons = require('../features').daemons.getSettings();
      const active = require('../ai/client').getActiveProvider();
      return {
        handled: true,
        text: `📡 *Nick AI status*\nMode: ${obsidian.getGlobalMode()} · scope: ${obsidian.getResponseScope()}\nDaemon: ${daemons.daemonMode === false ? 'OFF' : 'ON'} · groups: ${daemons.groupMode === false ? 'OFF' : 'ON'}\nMaintenance: ${obsidian.isMaintenance() ? 'ON' : 'OFF'}\nBrain: ${active.name} (${active.model || 'n/a'})`,
      };
    } catch (e) {
      return { handled: true, text: `Could not read owner status: ${e.message}` };
    }
  }

  const runtimeModeMatch = text.match(/^owner\s+(daemon|groups)\s+(on|off|status)$/i);
  if (runtimeModeMatch) {
    const daemons = require('../features').daemons;
    const mode = runtimeModeMatch[1].toLowerCase();
    const action = runtimeModeMatch[2].toLowerCase();
    if (action === 'status') {
      const settings = daemons.getSettings();
      return { handled: true, text: `Daemon mode: ${settings.daemonMode === false ? 'OFF' : 'ON'}\nGroup responses: ${settings.groupMode === false ? 'OFF' : 'ON'}` };
    }
    const enabled = action === 'on';
    if (mode === 'daemon') daemons.toggleDaemon(enabled);
    else daemons.toggleGroup(enabled);
    return { handled: true, text: `✅ ${mode === 'daemon' ? 'Daemon' : 'Group response'} mode is now ${enabled ? 'ON' : 'OFF'}.` };
  }

  const prefixMatch = text.match(/^setprefix(?:\s+(.+))?$/i);
  if (prefixMatch) {
    if (!prefixMatch[1]) {
      const current = commandPrefix.getPrefix();
      return { handled: true, text: `Current command prefix: ${current ? `\`${current}\`` : 'none'}. Use \`setprefix !\` (or any 1–3 non-space characters, including emoji) to set one, or \`setprefix off\` to clear it.` };
    }
    const result = commandPrefix.setPrefix(prefixMatch[1]);
    if (!result.ok) return { handled: true, text: `❌ ${result.error}` };
    return { handled: true, text: result.prefix
      ? `✅ Command prefix set to \`${result.prefix}\`. Use it before group/owner plug-in commands; \`setprefix off\` still works without it.`
      : '✅ Command prefix cleared. Plug-in commands work without a prefix again.' };
  }

  const addOwnerMatch = text.match(/^addowner(?:\s+(.+))?$/i);
  if (addOwnerMatch) {
    const target = resolveOwnerTarget(ctx, addOwnerMatch[1] || '');
    if (target.error) return { handled: true, text: `❌ ${target.error}` };
    if (roles.isOwner(target.digits)) return { handled: true, text: 'That number is already an owner.' };
    roles.addOwner(target.digits);
    return { handled: true, text: `✅ Owner role added for +${target.digits}.` };
  }

  if (/^setpp$/i.test(text)) {
    return { handled: true, text: 'Send or reply to a photo with `setpp` to update Nick’s profile picture.' };
  }

  const serviceMatch = text.match(/^vps\s+service\s+(status|start|stop|restart)\s+(\S+)$/i);
  if (serviceMatch) {
    try {
      const result = await require('../ai/tools').executeTool('vps_service', {
        action: serviceMatch[1].toLowerCase(),
        service: serviceMatch[2],
      }, { senderJid: ctx.senderJid, isOwner: true });
      if (!result?.ok) return { handled: true, text: `⚠️ ${result?.error || 'VPS service request failed.'}` };
      return { handled: true, text: `✅ ${result.action} *${result.service}*\n${result.output || 'Completed.'}` };
    } catch (e) {
      return { handled: true, text: `VPS service request failed: ${e.message}` };
    }
  }

  if (/^vps\s+service\b/i.test(text)) {
    return { handled: true, text: 'Usage: `vps service status|start|stop|restart <allowlisted-unit.service>`.' };
  }
  return { handled: false };
}

async function handleMedia(ctx, input, imageBuffer) {
  if (!isSetProfilePictureCommand(input)) return { handled: false };
  const parsed = commandPrefix.parseCommand(input);
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}setpp\`` };
  }
  if (!getExplicitOwner(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return { handled: true, text: 'I could not find a photo. Send or reply to an image with `setpp`.' };
  }
  const ids = [...toArray(ctx.botJids), ctx.sock?.user?.id, ctx.sock?.user?.lid].filter(Boolean).map(String);
  const botJid = ids.find((id) => /@s\.whatsapp\.net$/i.test(id)) || ids.find((id) => /@c\.us$/i.test(id)) || null;
  if (!botJid) return { handled: true, text: 'Could not resolve Nick’s WhatsApp profile ID.' };
  try {
    await ctx.sock.updateProfilePicture(botJid, imageBuffer);
    return { handled: true, text: '✅ Nick’s WhatsApp profile picture has been updated.' };
  } catch (e) {
    return { handled: true, text: `Could not update the profile picture: ${e.message}` };
  }
}

module.exports = { route, handleMedia, isOwnerPluginCommand, isSetProfilePictureCommand, ownerMenu, menuCommands };
