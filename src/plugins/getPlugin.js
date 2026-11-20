'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const roles = require('../features').roles;
const commandPrefix = require('./commandPrefix');
const messageLayout = require('../utils/messageLayout');
const { extractCommandCode, stripJs } = require('./codeExtractor');

const ROOT = path.resolve(__dirname, '../..');
const PLUGINS_DIR = path.resolve(__dirname);
const ROUTER_FILE = path.join(ROOT, 'src', 'core', 'router.js');

function parse(input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  const match = text.match(/^(?:get\s+(?:plugins?|commands?|code)|getplugins?|getcommand|getcode|plugins?\s+get)(?:\s+([\s\S]*))?$/i);
  return { parsed, text, matched: !!match, tail: (match?.[1] || '').trim() };
}

function isCommand(input) {
  return parse(input).matched;
}

function isOwner(ctx) {
  return !!ctx?.isOwner || roles.isOwner(ctx?.senderJid);
}

async function pluginFiles() {
  const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function routerHasCommand(command) {
  try {
    const source = await fs.readFile(ROUTER_FILE, 'utf8');
    const re = new RegExp(`\\b${escapeRe(command)}\\b`, 'i');
    const state = { inBlockComment: false, inString: false, quote: null, inRegex: false, regexEscape: false, inCharClass: false };
    return source.split(/\r?\n/).some((line) => {
      const code = stripJs(line, state);
      return re.test(code) && /\.test\(|\.match\(|isCoreMenuCommand/.test(code);
    });
  } catch {
    return false;
  }
}

async function findCommandPlugin(command, files) {
  for (const file of files) {
    if (file === 'index.js' || file === 'getPlugin.js' || file === 'codeExtractor.js') continue;
    try {
      const mod = require(path.join(PLUGINS_DIR, file));
      const commands = mod?.menuCommands || [];
      if (Array.isArray(commands) && commands.some((cmd) => {
        const normalized = String(cmd || '').replace(/^[.!/]/, '').replace(/\s+<[^>]+>/g, '').trim().toLowerCase();
        return normalized === command || normalized.startsWith(`${command} `);
      })) {
        return file;
      }
    } catch {}
  }
  return null;
}

async function resolveTarget(raw) {
  const name = String(raw || '').trim();
  if (!name) return { error: 'Provide a plugin or command name. Use *get plugins* to list them.' };
  if (/[\\/]/.test(name) || name.includes('..') || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
    return { error: 'Use a plugin or command name only — paths and traversal are not allowed.' };
  }

  const files = await pluginFiles();
  const stem = name.replace(/\.js$/i, '').toLowerCase();

  // Explicit file name → send the whole module.
  const exact = files.find((file) => file.replace(/\.js$/i, '').toLowerCase() === stem);
  if (exact) return { file: path.join(PLUGINS_DIR, exact), name: exact, command: null };

  // Otherwise treat it as a command name and extract just that code block.
  const pluginName = await findCommandPlugin(stem, files);
  if (pluginName) {
    return { file: path.join(PLUGINS_DIR, pluginName), name: pluginName, command: stem };
  }
  if (await routerHasCommand(stem)) {
    return { file: ROUTER_FILE, name: 'router.js', command: stem };
  }

  const partial = files.filter((file) => file.replace(/\.js$/i, '').toLowerCase().includes(stem));
  if (partial.length === 1) return { file: path.join(PLUGINS_DIR, partial[0]), name: partial[0], command: null };
  if (partial.length > 1) return { error: `Ambiguous plugin name "${name}". Matches: ${partial.join(', ')}.` };
  return { error: `No plugin or command found for "${name}". Use *get plugins* to list them.` };
}

async function safeRead(resolved) {
  const real = await fs.realpath(resolved.file);
  const allowed = path.dirname(real) === PLUGINS_DIR || real === ROUTER_FILE;
  if (!allowed) throw new Error('That file resolves outside the bot source tree.');
  if (!real.toLowerCase().endsWith('.js')) throw new Error('Only JavaScript source files can be sent.');
  return real;
}

async function route(ctx, input) {
  const { parsed, matched, tail } = parse(input);
  if (!matched) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${parsed.text}\`` };
  }
  if (!isOwner(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };

  if (!tail || /^(?:list|menu|\?)$/i.test(tail)) {
    const files = await pluginFiles();
    return {
      handled: true,
      text: `🧩 *Available plugins* (${files.length})\n${files.join('\n')}\n\nUse *get command <name>* for the code of one command, or *get plugin <file>* for a whole plugin file.`,
    };
  }

  try {
    const resolved = await resolveTarget(tail);
    if (resolved.error) return { handled: true, text: `❌ ${resolved.error}` };
    const realFile = await safeRead(resolved);
    const relative = path.relative(ROOT, realFile).split(path.sep).join('/');

    let buffer;
    let fileName;
    let caption;
    if (resolved.command) {
      const snippet = await extractCommandCode(realFile, resolved.command, relative);
      if (!snippet) {
        return { handled: true, text: `❌ Could not isolate the code for "${resolved.command}" in ${resolved.name}. Try *get plugin ${resolved.name}* for the whole file.` };
      }
      buffer = Buffer.from(snippet, 'utf8');
      fileName = `${resolved.command.replace(/[^a-z0-9_-]+/gi, '_')}.js`;
      caption = `🧩 ${resolved.command} · from ${relative}`;
    } else {
      buffer = await fs.readFile(realFile);
      fileName = resolved.name;
      caption = `🧩 Plugin: ${resolved.name} (${(buffer.length / 1024).toFixed(1)} KB)`;
    }

    await ctx.sock.sendMessage(ctx.chatId, {
      document: buffer,
      mimetype: 'text/javascript',
      fileName,
      caption,
    });
    return { handled: true };
  } catch (error) {
    return { handled: true, text: `❌ Could not get that code: ${error.message}` };
  }
}

module.exports = { route, isCommand, menuCommands: ['get command <name>', 'get plugin <file>', 'get plugins'] };
