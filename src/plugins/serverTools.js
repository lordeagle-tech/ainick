'use strict';

const os = require('node:os');
const roles = require('../features').roles;
const commandPrefix = require('./commandPrefix');
const messageLayout = require('../utils/messageLayout');
const packageInfo = require('../../package.json');

const menuCommands = ['about', 'vpsinfo'];

function parsedText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^(?:about|vpsinfo)$/i.test(parsedText(input));
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, `${secs}s`]
    .filter(Boolean).join(' ');
}

function aboutText() {
  return messageLayout.commandCard('NICK AI', [
    'WhatsApp AI assistant',
    `Version: ${packageInfo.version || 'unknown'}`,
    'Use `normal menu` to browse available commands.',
  ], 'ℹ️');
}

function serverInfoText() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const memory = process.memoryUsage();
  const cpuCount = (os.cpus() || []).length;
  const load = os.loadavg();
  const lines = [
    `System: ${os.platform()} ${os.arch()}`,
    `Node.js: ${process.version}`,
    `CPU cores: ${cpuCount || 'unavailable'}`,
    `System uptime: ${formatDuration(os.uptime())}`,
    `System memory: ${formatBytes(freeMemory)} free / ${formatBytes(totalMemory)} total`,
    `Bot process memory: ${formatBytes(memory.rss)} RSS · ${formatBytes(memory.heapUsed)} heap`,
    `Bot uptime: ${formatDuration(process.uptime())}`,
  ];
  if (process.platform !== 'win32' && load.some((value) => value > 0)) {
    lines.push(`Load average (1/5/15 min): ${load.map((value) => value.toFixed(2)).join(' / ')}`);
  }
  return messageLayout.commandCard('SERVER INFO', lines, '🖥️');
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }
  if (/^about$/i.test(text)) return { handled: true, text: aboutText() };
  if (/^vpsinfo$/i.test(text)) {
    if (!ctx.isOwner && !roles.isOwner(ctx.senderJid)) {
      return { handled: true, text: messageLayout.accessDenied('owner') };
    }
    return { handled: true, text: serverInfoText() };
  }
  return { handled: false };
}

module.exports = { isCommand, route, menuCommands, formatBytes, formatDuration };
