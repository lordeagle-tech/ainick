'use strict';

const commandPrefix = require('./commandPrefix');
const roles = require('../features').roles;
const messageLayout = require('../utils/messageLayout');
const { getActiveProvider, listProviders } = require('../ai/client');

const COMMAND = 'botdiag';
const menuCommands = [COMMAND];

function parse(input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  const match = text.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
  return { parsed, name: (match?.[1] || '').toLowerCase(), tail: match?.[2] || '' };
}

function isCommand(input) {
  return parse(input).name === COMMAND;
}

function isOwner(ctx) {
  return !!ctx?.isOwner || roles.isOwner(ctx?.senderJid);
}

function safeLabel(value, max = 72) {
  return String(value || '').replace(/[\r\n\t]/g, ' ').replace(/[<>`]/g, '').trim().slice(0, max);
}

function safeJid(value) {
  const jid = String(value || '').replace(/[^a-zA-Z0-9@._:-]/g, '').slice(0, 120);
  return jid || 'unavailable';
}

function safeIdentifier(value, max = 80) {
  const identifier = String(value || '').replace(/[^a-zA-Z0-9_./:-]/g, '').slice(0, max);
  return identifier || 'unknown';
}

function formatUptime(seconds) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${secs}s`].filter(Boolean).join(' ');
}

function providerSnapshot() {
  let rows = [];
  let active = null;
  try {
    rows = listProviders().map((provider) => ({
      name: safeIdentifier(provider?.name, 48),
      label: safeLabel(provider?.label || provider?.name, 80),
      model: safeIdentifier(provider?.model, 80),
      configured: !!provider?.hasKey,
      local: !!provider?.local,
    }));
  } catch {}
  try {
    const current = getActiveProvider();
    active = {
      name: safeIdentifier(current?.name, 48),
      label: safeLabel(current?.label || current?.name, 80),
      model: safeIdentifier(current?.model, 80),
    };
  } catch {}
  return { rows, active };
}

function diagnosticText(ctx) {
  const { rows, active } = providerSnapshot();
  const meta = ctx?.messageMeta && typeof ctx.messageMeta === 'object' ? ctx.messageMeta : {};
  const providers = rows.length
    ? rows.map((provider) => `• ${provider.label} (${provider.name}) — ${provider.configured ? 'configured' : 'not configured'}${provider.local ? ' · local' : ''}${provider.model !== 'unknown' ? ` · ${provider.model}` : ''}`).join('\n')
    : '• Provider status unavailable';
  const activeLine = active
    ? `${active.label} (${active.name})${active.model !== 'unknown' ? ` · ${active.model}` : ''}`
    : 'unavailable';
  const messageType = safeIdentifier(meta.type, 48);
  const messageId = safeIdentifier(meta.id, 80);
  const mentions = Number.isSafeInteger(meta.mentions) && meta.mentions >= 0 ? meta.mentions : 0;
  const groupMembers = Number.isSafeInteger(meta.groupMembers) && meta.groupMembers >= 0 ? String(meta.groupMembers) : 'n/a';

  return [
    '*Nick AI · Owner Diagnostics*',
    '',
    '*AI providers*',
    `Active: ${activeLine}`,
    providers,
    '',
    '*Current message context*',
    `Message object: ${meta.present === true ? 'available' : 'not provided'}`,
    `Sender JID: ${safeJid(ctx?.senderJid)}`,
    `Chat JID: ${safeJid(ctx?.chatId)}`,
    `Chat type: ${ctx?.isGroup ? 'group' : 'direct'}`,
    `Message ID: ${messageId}`,
    `Message type: ${messageType}`,
    `From bot: ${meta.fromMe === true ? 'yes' : 'no'}`,
    `Quoted message: ${meta.quoted === true ? 'yes' : 'no'}`,
    `Mention count: ${mentions}`,
    ...(ctx?.isGroup ? [`Group member count: ${groupMembers}`] : []),
    '',
    '*Runtime*',
    `Node: ${safeLabel(process.version, 32)}`,
    `Platform: ${safeIdentifier(process.platform, 24)}`,
    `Uptime: ${formatUptime(process.uptime())}`,
    '',
    '_Credentials, endpoints, raw message contents, and socket data are intentionally hidden._',
  ].join('\n');
}

async function route(ctx, input) {
  const { parsed, name, tail } = parse(input);
  if (name !== COMMAND) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${parsed.text}\`` };
  }
  if (!isOwner(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };
  if (tail.trim()) return { handled: true, text: 'Usage: botdiag' };
  return { handled: true, text: diagnosticText(ctx) };
}

module.exports = { route, isCommand, menuCommands };
