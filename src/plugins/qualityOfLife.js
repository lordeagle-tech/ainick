'use strict';

const dns = require('dns').promises;
const net = require('net');
const { Collection } = require('../db');
const commandPrefix = require('./commandPrefix');
const roles = require('../features').roles;
const logger = require('../logger');
const memory = require('../core/memory');
const groupCommands = require('./groupCommands');
const { AIClient } = require('../ai/client');

const settings = new Collection('nick_qol_settings', {});
const menuCommands = [
  'test call', 'help more',
  'memory backup', 'memory backups', 'memory restore',
  'remember', 'recall', 'forget fact',
  'check link', 'preview',
  'digest', 'digest now', 'digest on', 'digest off',
  'sticker battle', 'sticker battle on', 'sticker battle off', 'sticker battle score',
  'vibe', 'vibe check', 'quote', 'quote of the day', 'roast', 'hype',
  'ocr', 'read this',
];

const DIGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DIGEST_GAP_MS = 24 * 60 * 60 * 1000;
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly', 'rebrand.ly', 'cutt.ly', 's.id']);
const SUSPICIOUS_HOST_WORDS = ['login', 'verify', 'secure', 'account', 'bank', 'paypal', 'password', 'claim', 'gift', 'free', 'update', 'support'];

function parse(input) {
  const parsed = commandPrefix.parseCommand(String(input || ''));
  const text = parsed.text.trim();
  const match = text.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
  return { parsed, name: (match?.[1] || '').toLowerCase(), tail: (match?.[2] || '').trim() };
}

function isCommand(input) {
  const { name } = parse(input);
  return menuCommands.some((command) => command === name || command.startsWith(`${name} `));
}

function isOwner(ctx) {
  return !!ctx?.isOwner || roles.isOwner(ctx?.senderJid);
}

function clean(value, max = 800) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>`]/g, '').trim().slice(0, max);
}

function getSettings(chatId) {
  const current = settings.get(chatId, {}) || {};
  return { digest: false, stickerBattle: true, lastDigestAt: 0, ...current };
}

function saveSettings(chatId, next) {
  settings.set(chatId, next);
  return next;
}

function isStickerBattleEnabled(chatId) {
  return getSettings(chatId).stickerBattle !== false;
}

function extractUrl(input) {
  const match = String(input || '').match(/(https?:\/\/|www\.)[^\s<>"']+/i);
  if (!match) return null;
  let raw = match[0];
  if (/^www\./i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return null;
    return url;
  } catch { return null; }
}

function isPrivateIp(address) {
  const ip = String(address || '');
  if (ip === '::1' || ip === '127.0.0.1' || ip === '0.0.0.0') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip) || /^100\.64\./.test(ip)) return true;
  if (/^fc|^fd|^fe80/i.test(ip)) return true;
  return false;
}

async function isPublicUrl(url) {
  const host = String(url.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(local|internal|test|invalid)$/.test(host)) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addresses = await dns.lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateIp(entry.address));
  } catch { return false; }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPreview(url) {
  let current = url.toString();
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(current);
    if (!(await isPublicUrl(parsed))) throw new Error('That address points to a private or local network.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; NickAI-LinkCheck/1.0)' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
        current = new URL(response.headers.get('location'), current).toString();
        continue;
      }
      const html = (await response.text()).slice(0, 200000);
      const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).slice(0, 180);
      const description = decodeHtml(
        html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1]
      ).slice(0, 260);
      return { url: current, status: response.status, title, description };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects.');
}

function linkRisk(url) {
  const host = String(url.hostname || '').toLowerCase();
  const flags = [];
  if (url.protocol !== 'https:') flags.push('not HTTPS');
  if (SHORTENERS.has(host)) flags.push('URL shortener hides the real destination');
  if (net.isIP(host)) flags.push('raw IP address instead of a domain');
  if (host.includes('xn--')) flags.push('punycode/internationalized domain');
  if (SUSPICIOUS_HOST_WORDS.some((word) => host.includes(word))) flags.push('account/login-style words in the domain');
  return flags;
}

async function handleLinkCheck(ctx, text) {
  const url = extractUrl(text || ctx.quotedText);
  if (!url) return { handled: true, text: 'Send a link, e.g. `check link https://example.com`, or reply to a link with `preview`.' };
  try {
    const preview = await fetchPreview(url);
    const flags = linkRisk(new URL(preview.url));
    const lines = [
      '🔗 *Link check*',
      `URL: ${clean(preview.url, 220)}`,
      `Status: ${preview.status}`,
      preview.title ? `Title: ${clean(preview.title, 160)}` : '',
      preview.description ? `About: ${clean(preview.description, 240)}` : '',
      '',
      flags.length ? `⚠️ Caution: ${flags.join('; ')}.` : '✅ No obvious warning signs from the URL itself.',
      'This is a quick check, not a guarantee that the site is safe.',
    ];
    return { handled: true, text: lines.filter(Boolean).join('\n') };
  } catch (e) {
    return { handled: true, text: `Could not check that link: ${clean(e.message, 200)}` };
  }
}

function formatWhen(timestamp) {
  if (!timestamp) return 'never';
  return new Date(timestamp).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
}

function formatBackup(backup) {
  return `• \`${backup.id}\` — ${formatWhen(backup.createdAt)} (${backup.files || 0} files)`;
}

async function handleMemory(ctx, name, tail) {
  if (name === 'memory') {
    const action = tail.split(/\s+/)[0].toLowerCase();
    if (action === 'backup' || action === 'backups') {
      if (!isOwner(ctx)) return { handled: true, text: 'Only the owner can manage memory backups.' };
      if (action === 'backups') {
        const list = memory.listMemoryBackups(10);
        return { handled: true, text: list.length
          ? `💾 *Memory backups*\n${list.map(formatBackup).join('\n')}\n\nRestore with \`memory restore <id>\`.`
          : 'No memory backups yet. Send `memory backup` first.' };
      }
      const result = memory.backupMemory();
      return { handled: true, text: `💾 Memory backed up as \`${result.id}\` (${result.files} files). Use \`memory backups\` to list.` };
    }
    if (action === 'restore') {
      if (!isOwner(ctx)) return { handled: true, text: 'Only the owner can restore memory.' };
      const id = tail.split(/\s+/)[1];
      if (!id) return { handled: true, text: 'Usage: `memory restore <backup-id>`' };
      try {
        const result = memory.restoreMemory(id);
        return { handled: true, text: `✅ Restored memory from \`${result.id}\` (${result.restored} files).` };
      } catch (e) {
        return { handled: true, text: `Could not restore that backup: ${clean(e.message, 200)}` };
      }
    }
    return { handled: true, text: 'Usage: `memory backup` · `memory backups` · `memory restore <id>`' };
  }

  if (name === 'remember') {
    if (!isOwner(ctx)) return { handled: true, text: 'Only the owner can store permanent facts.' };
    const fact = tail.replace(/^that\s+/i, '');
    const result = memory.rememberFact(ctx.senderJid, fact, ctx.isGroup ? ctx.chatId : 'dm');
    return { handled: true, text: result.ok ? `🧠 Remembered: "${clean(result.fact, 160)}"` : result.error };
  }
  if (name === 'recall') {
    if (!isOwner(ctx)) return { handled: true, text: 'Only the owner can recall stored facts.' };
    const facts = memory.getFacts(ctx.senderJid);
    return { handled: true, text: facts.length
      ? `🧠 Stored facts:\n${facts.map((f, i) => `${i + 1}. ${clean(f.text, 160)}`).join('\n')}`
      : 'I have no stored facts for you yet.' };
  }
  if (name === 'forget' && /^fact\b/i.test(tail)) {
    if (!isOwner(ctx)) return { handled: true, text: 'Only the owner can remove stored facts.' };
    const result = memory.forgetFact(ctx.senderJid, tail.replace(/^fact\s*/i, ''));
    return { handled: true, text: result.ok ? `🧹 Forgot: "${clean(result.removed, 160)}"` : result.error };
  }
  return { handled: false };
}

const QUOTES = [
  'Small moves, done daily, beat big plans that never start.',
  'Stay sharp, stay kind, and do not confuse noise with progress.',
  'You do not need the perfect moment. You need the next honest step.',
  'Calm is a superpower when everyone else is shouting.',
  'Protect your peace like it is a limited resource — because it is.',
];

const VIBES = [
  ['calm 🌙', 'Soft mode: clear head, low noise, steady hands.'],
  ['hype 🔥', 'Loud mode: main-character energy, but make it useful.'],
  ['focused 🎯', 'One thing at a time. Cut the extra noise.'],
  ['playful 😏', 'Mischief is allowed, chaos is not required.'],
  ['tender 🫶', 'Gentle words today. Be kind to yourself too.'],
];

function handleFun(ctx, name, tail) {
  if (name === 'vibe' || (name === 'vibe' && tail.startsWith('check'))) {
    const [label, line] = VIBES[Math.floor(Math.random() * VIBES.length)];
    return { handled: true, text: `Today’s vibe: *${label.trim()}* — ${line}` };
  }
  if (name === 'quote' || name === 'roast' || name === 'hype') {
    if (name === 'quote') {
      return { handled: true, text: `💬 ${QUOTES[Math.floor(Math.random() * QUOTES.length)]}` };
    }
    const subject = tail || (ctx.isGroup ? 'the group' : 'you');
    const system = name === 'roast'
      ? 'You are Nick AI. Write one playful, affectionate roast. Never cruel, never hateful, never about protected traits. Max 2 short sentences.'
      : 'You are Nick AI. Write one short hype line that makes the subject feel capable and motivated. Max 2 short sentences.';
    return { handled: true, async: true, system, prompt: `${name.charAt(0).toUpperCase() + name.slice(1)} this: ${subject}` };
  }
  return { handled: false };
}

async function buildDigest(ctx, hours = 24) {
  const logs = groupCommands.getLogs(ctx.chatId, 300);
  if (!logs.length) return 'I have not observed enough group messages to make a digest yet.';
  const window = Math.max(1, Math.min(168, Number(hours) || 24));
  const cutoff = Date.now() - window * 3600000;
  const recent = logs.filter((entry) => Number(entry.at) >= cutoff);
  const source = recent.length ? recent : logs;
  const lines = source.slice(-220).map((entry) => `[${new Date(entry.at).toISOString()}] ${clean(entry.sender, 32)}: ${clean(entry.text, 300)}`);
  const ai = new AIClient();
  return ai.simpleComplete(
    `Summarize these observed WhatsApp group messages from roughly the last ${window} hours. Do not invent facts. Return short sections: Topics, Decisions, Open questions, Action items. Keep it under 180 words.\n\n${lines.join('\n')}`,
    'You are Nick AI. Be concise, neutral, and factual. Do not mention that you are an AI.'
  );
}

let digestTimer = null;
let lastSocket = null;

function startDigestTimer() {
  if (digestTimer) return;
  digestTimer = setInterval(async () => {
    if (!lastSocket) return;
    for (const [chatId, value] of settings.entries()) {
      if (!value?.digest || Date.now() - Number(value.lastDigestAt || 0) < DIGEST_GAP_MS) continue;
      try {
        const text = await buildDigest({ chatId, isGroup: true }, 24);
        await lastSocket.sendMessage(chatId, { text: `📌 *Group digest*\n\n${text.slice(0, 1800)}` });
        saveSettings(chatId, { ...getSettings(chatId), lastDigestAt: Date.now() });
      } catch (e) {
        logger.warn({ err: e.message, chatId }, 'automatic group digest failed');
      }
    }
  }, DIGEST_INTERVAL_MS);
  if (digestTimer.unref) digestTimer.unref();
}

async function handleDigest(ctx, tail) {
  if (!ctx.isGroup) return { handled: true, text: 'Group digests only work inside a group.' };
  lastSocket = ctx.sock || lastSocket;
  startDigestTimer();
  const action = (tail.split(/\s+/)[0] || 'now').toLowerCase();
  const current = getSettings(ctx.chatId);
  if (action === 'on' || action === 'off' || action === 'status') {
    if (!isOwner(ctx)) return { handled: true, text: 'Only the owner can change digest settings.' };
    if (action === 'status') {
      return { handled: true, text: `📌 Auto digest is ${current.digest ? 'ON' : 'OFF'}. Last sent: ${formatWhen(current.lastDigestAt)}.` };
    }
    const on = action === 'on';
    saveSettings(ctx.chatId, { ...current, digest: on });
    return { handled: true, text: `📌 Auto digest is now ${on ? 'ON' : 'OFF'}.` };
  }
  const hours = Number(tail.match(/\b(\d{1,3})\b/)?.[1]) || 24;
  try {
    const text = await buildDigest(ctx, hours);
    return { handled: true, text: `📌 *Group digest*\n\n${text.slice(0, 1800)}` };
  } catch (e) {
    return { handled: true, text: `Could not build the digest: ${clean(e.message, 200)}` };
  }
}

async function handleStickerBattle(ctx, tail) {
  const action = (tail.split(/\s+/)[0] || 'status').toLowerCase();
  const current = getSettings(ctx.chatId);
  if (action === 'score' || action === 'stats') {
    return { handled: true, text: `😹 Sticker battle is ${current.stickerBattle !== false ? 'ON' : 'OFF'} in this chat.` };
  }
  if (action === 'on' || action === 'off' || action === 'status') {
    if (action !== 'status' && !isOwner(ctx)) return { handled: true, text: 'Only the owner can toggle sticker battles.' };
    if (action === 'status') return { handled: true, text: `😹 Sticker battle is ${current.stickerBattle !== false ? 'ON' : 'OFF'}.` };
    const on = action === 'on';
    saveSettings(ctx.chatId, { ...current, stickerBattle: on });
    return { handled: true, text: `😹 Sticker battle is now ${on ? 'ON' : 'OFF'}.` };
  }
  return { handled: true, text: 'Usage: `sticker battle on/off/status/score`' };
}

function helpMore() {
  return [
    '*More commands*',
    '• `github` / `gitrepos` / `gitissues` — GitHub tools (owner)',
    '• `gitclone owner/repo` — clone a public GitHub repo (everyone)',
    '• `vpsinfo` / `botdiag` — server and bot diagnostics',
    '• `get command <name>` / `get plugin <file>` — source (owner)',
    '• `files` / `filemenu` — owner file tools',
    '• `check link <url>` / `preview <url>` — link safety and preview',
    '• `digest now` — group activity summary',
    '• `remember ...` / `recall` / `forget fact <n>` — owner facts',
    '• `memory backup` / `memory backups` / `memory restore <id>`',
    '• `test call <message>` — owner dry-run of the call gate',
    '• `ocr` — reply to an image to extract visible text',
    '• `vibe` / `quote` / `roast <name>` / `hype <name>`',
  ].join('\n');
}

async function route(ctx, input) {
  const { parsed, name, tail } = parse(input);
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${parsed.text}\`` };
  }

  if (name === 'help' && /^more\b/i.test(tail)) return { handled: true, text: helpMore() };

  if (['test'].includes(name) && /^call\b/i.test(tail)) {
    return { handled: false }; // handled inside the router where the gate lives
  }

  if (['memory', 'remember', 'recall', 'forget'].includes(name)) {
    return handleMemory(ctx, name, tail);
  }
  if (['check'].includes(name) && /^link\b/i.test(tail)) {
    return handleLinkCheck(ctx, tail.replace(/^link\s*/i, ''));
  }
  if (name === 'preview') return handleLinkCheck(ctx, tail);
  if (name === 'digest') return handleDigest(ctx, tail);
  if (name === 'sticker' && /^battle\b/i.test(tail)) {
    return handleStickerBattle(ctx, tail.replace(/^battle\s*/i, ''));
  }
  if (['vibe', 'quote', 'roast', 'hype'].includes(name)) return handleFun(ctx, name, tail);
  return { handled: false };
}

async function handleMedia(ctx, input, imageBuffer) {
  const { name } = parse(input);
  if (!['ocr', 'read'].includes(name) || !/^(?:ocr|read\s+this)$/i.test(parse(input).parsed.text.trim())) {
    return { handled: false };
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    return { handled: true, text: 'Reply to an image with `ocr` and I will read the visible text.' };
  }
  const mime = /^image\//i.test(String(ctx.imageMime || '')) ? ctx.imageMime : 'image/jpeg';
  const dataUri = `data:${mime};base64,${imageBuffer.toString('base64')}`;
  try {
    const ai = new AIClient();
    const text = await ai.simpleVision({
      dataUri,
      system: 'You are an OCR engine. Transcribe only the text visibly present in the image. Preserve line breaks. If there is no legible text, say exactly: No legible text found.',
      prompt: 'Extract all visible text. Do not explain or add commentary.',
    });
    return { handled: true, text: `🔎 *OCR result*\n${text.slice(0, 3000)}` };
  } catch (e) {
    return { handled: true, text: `Could not read that image: ${clean(e.message, 200)}` };
  }
}

module.exports = {
  route,
  handleMedia,
  isCommand,
  isStickerBattleEnabled,
  menuCommands,
};
