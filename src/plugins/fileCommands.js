'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const roles = require('../features').roles;
const commandPrefix = require('./commandPrefix');
const messageLayout = require('../utils/messageLayout');

const ROOT = path.resolve(__dirname, '../..');
const MAX_READ_CHARS = 12000;
const MAX_WRITE_BYTES = 32000;
const MAX_LIST_ENTRIES = 100;
const MAX_FIND_RESULTS = 50;
const MAX_WALK_FILES = 5000;
const MAX_DEPTH = 8;
const HIDDEN_DIRS = new Set([
  '.git', '.work', 'node_modules', 'data', 'logs', 'auth', 'sessions', 'tokens',
  'secrets', 'credentials', '.cache', 'coverage', 'dist', 'build',
]);
const FILE_COMMANDS = new Set([
  'files', 'filemenu', 'ls', 'dir', 'tree', 'find', 'cat', 'readfile', 'viewfile',
  'write', 'createfile', 'editfile', 'append', 'mkdir', 'createdir', 'eval',
]);
const menuCommands = [...FILE_COMMANDS];

function parse(input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  const match = text.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
  return { parsed, text, name: (match?.[1] || '').toLowerCase(), tail: match?.[2] || '' };
}

function isCommand(input) {
  return FILE_COMMANDS.has(parse(input).name);
}

function isOwner(ctx) {
  return !!ctx?.isOwner || roles.isOwner(ctx?.senderJid);
}

function hiddenComponent(component) {
  const name = String(component || '').toLowerCase();
  if (HIDDEN_DIRS.has(name)) return true;
  if (/^\.env(?:\..*)?$/i.test(name) && name !== '.env.example') return true;
  if (/^(?:mcp\.servers\.json|\.npmrc)$/i.test(name)) return true;
  if (/(?:secret|credential|private[-_.]?key|access[-_.]?token|auth[-_.]?state)/i.test(name)) return true;
  if (/\.(?:pem|key|p12|pfx|db|sqlite|sqlite3|wal|journal)$/i.test(name)) return true;
  return false;
}

function isInsideRoot(target) {
  const relative = path.relative(ROOT, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeUserPath(userPath) {
  const raw = String(userPath || '').trim();
  if (!raw) throw new Error('Provide a project-relative file or folder path.');
  if (raw.includes('\0') || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')) {
    throw new Error('Use a relative path inside the bot project. Absolute paths are not allowed.');
  }
  const portable = raw.replace(/[\\/]+/g, path.sep);
  const target = path.resolve(ROOT, portable);
  if (!isInsideRoot(target)) throw new Error('That path escapes the bot project.');
  const relative = path.relative(ROOT, target);
  const parts = relative ? relative.split(path.sep) : [];
  if (parts.some(hiddenComponent)) throw new Error('That path is protected (credentials, runtime data, dependencies, or internal files).');
  return { target, relative: relative || '.', parts };
}

async function checkNoSymlinkPath(target, allowMissingLeaf = false) {
  const relative = path.relative(ROOT, target);
  if (!isInsideRoot(target)) throw new Error('That path escapes the bot project.');
  const parts = relative ? relative.split(path.sep) : [];
  let current = ROOT;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed for file access.');
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('A parent path component is not a directory.');
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissingLeaf && i === parts.length - 1) return;
      throw error;
    }
  }
  const real = await fs.realpath(target);
  if (!isInsideRoot(real)) throw new Error('That path resolves outside the bot project.');
}

function commandBody(tail) {
  const newline = tail.indexOf('\n');
  if (newline < 0) return { file: tail.trim(), body: '' };
  return { file: tail.slice(0, newline).trim(), body: tail.slice(newline + 1) };
}

function usage(name, details = '') {
  const help = {
    files: 'Use files or filemenu to see supported commands.',
    filemenu: 'Use files or filemenu to see supported commands.',
    ls: 'Usage: ls [project-relative folder].',
    dir: 'Usage: dir [project-relative folder].',
    tree: 'Usage: tree [project-relative folder].',
    find: 'Usage: find <file-name fragment>.',
    cat: 'Usage: cat <project-relative file>.',
    readfile: 'Usage: readfile <project-relative file>.',
    viewfile: 'Usage: viewfile <project-relative file>.',
    write: 'Usage: write <path> then a newline and the new file contents. Existing files are replaced.',
    createfile: 'Usage: createfile <path> then a newline and the new file contents. The target must not exist.',
    editfile: 'Usage: editfile <path> then a newline, ---FIND---, the exact old text, ---REPLACE---, and the replacement text.',
    append: 'Usage: append <path> then a newline and the text to append.',
    mkdir: 'Usage: mkdir <project-relative folder>.',
    createdir: 'Usage: createdir <project-relative folder>.',
    eval: 'Usage: eval <safe math expression> (for example: eval sqrt(81) + 2^3).',
  };
  return details || help[name] || 'Invalid file command.';
}

async function listDirectory(userPath, recursive = false) {
  const { target, relative } = normalizeUserPath(userPath || '.');
  await checkNoSymlinkPath(target);
  const rootStat = await fs.stat(target);
  if (!rootStat.isDirectory()) throw new Error('That path is not a folder.');
  const rows = [];
  let visited = 0;
  async function walk(folder, depth) {
    if (depth > MAX_DEPTH || rows.length >= MAX_LIST_ENTRIES || visited >= MAX_WALK_FILES) return;
    const entries = await fs.readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (hiddenComponent(entry.name)) continue;
      const full = path.join(folder, entry.name);
      const shown = path.relative(ROOT, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) continue;
      rows.push(`${entry.isDirectory() ? '[DIR] ' : '[FILE] '}${shown}`);
      visited++;
      if (recursive && entry.isDirectory()) await walk(full, depth + 1);
      if (rows.length >= MAX_LIST_ENTRIES || visited >= MAX_WALK_FILES) break;
    }
  }
  await walk(target, 0);
  return { rows, relative };
}

async function findFiles(query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) throw new Error(usage('find'));
  const rows = [];
  let visited = 0;
  async function walk(folder, depth) {
    if (depth > MAX_DEPTH || rows.length >= MAX_FIND_RESULTS || visited >= MAX_WALK_FILES) return;
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (hiddenComponent(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(folder, entry.name);
      visited++;
      if (entry.name.toLowerCase().includes(needle)) rows.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      if (entry.isDirectory()) await walk(full, depth + 1);
      if (rows.length >= MAX_FIND_RESULTS || visited >= MAX_WALK_FILES) break;
    }
  }
  await walk(ROOT, 0);
  return rows;
}

async function readText(userPath) {
  const { target, relative } = normalizeUserPath(userPath);
  await checkNoSymlinkPath(target);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('That path is not a file.');
  if (stat.size > MAX_WRITE_BYTES * 8) throw new Error('That file is too large to display (maximum 256 KB).');
  const buffer = await fs.readFile(target);
  if (buffer.includes(0)) throw new Error('Binary files are not displayed.');
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) throw new Error('This file does not appear to be valid UTF-8 text.');
  return { relative, text };
}

async function writeText(userPath, body, { createOnly = false, append = false } = {}) {
  const { target, relative } = normalizeUserPath(userPath);
  await checkNoSymlinkPath(target, true);
  if (Buffer.byteLength(body, 'utf8') > MAX_WRITE_BYTES) throw new Error(`Text exceeds the ${MAX_WRITE_BYTES} byte per-write limit.`);
  const parent = await fs.realpath(path.dirname(target));
  if (!isInsideRoot(parent)) throw new Error('That path resolves outside the bot project.');
  const exists = await fs.stat(target).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (createOnly && exists) throw new Error('That file already exists. Use editfile or append instead.');
  if (append && !exists) throw new Error('The target file does not exist. Use createfile first.');
  if (exists && !(await fs.stat(target)).isFile()) throw new Error('That path is not a regular file.');
  if (append) {
    const current = await fs.stat(target);
    if (current.size + Buffer.byteLength(body, 'utf8') > MAX_WRITE_BYTES * 8) throw new Error('The resulting file would exceed 256 KB.');
    await fs.appendFile(target, body, { encoding: 'utf8' });
  } else {
    await fs.writeFile(target, body, { encoding: 'utf8', flag: createOnly ? 'wx' : 'w' });
  }
  return relative;
}

function evaluateMath(source) {
  const input = String(source || '').trim();
  if (!input) throw new Error(usage('eval'));
  if (input.length > 256) throw new Error('Expression is too long (maximum 256 characters).');

  const tokens = [];
  const tokenPattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d+))?|([A-Za-z]+)|(.))/y;
  let offset = 0;
  while (offset < input.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(input);
    if (!match) throw new Error('Invalid expression token.');
    offset = tokenPattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1] + (match[2] || '')) });
    else if (match[3] !== undefined) tokens.push({ type: 'name', value: match[3].toLowerCase() });
    else if ('+-*/%^(),'.includes(match[4])) tokens.push({ type: match[4], value: match[4] });
    else throw new Error(`Unsupported character: ${match[4]}`);
    if (tokens.length > 128) throw new Error('Expression has too many parts.');
  }

  const constants = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
  const functions = {
    abs: [1, 1, Math.abs], ceil: [1, 1, Math.ceil], floor: [1, 1, Math.floor],
    round: [1, 1, Math.round], sqrt: [1, 1, Math.sqrt], exp: [1, 1, Math.exp],
    ln: [1, 1, Math.log], log: [1, 1, Math.log10], sin: [1, 1, Math.sin],
    cos: [1, 1, Math.cos], tan: [1, 1, Math.tan], min: [1, 32, Math.min],
    max: [1, 32, Math.max], pow: [2, 2, Math.pow],
  };
  let position = 0;
  let nesting = 0;
  const peek = () => tokens[position];
  const take = (type) => {
    if (peek()?.type !== type) throw new Error(`Expected "${type}" in expression.`);
    return tokens[position++];
  };
  const expression = () => {
    let value = term();
    while (peek()?.type === '+' || peek()?.type === '-') {
      const operator = tokens[position++].type;
      const right = term();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const term = () => {
    let value = unary();
    while (peek()?.type === '*' || peek()?.type === '/' || peek()?.type === '%') {
      const operator = tokens[position++].type;
      const right = unary();
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
      if (!Number.isFinite(value)) throw new Error('That operation does not produce a finite number.');
    }
    return value;
  };
  const unary = () => {
    if (peek()?.type === '+') { position++; return unary(); }
    if (peek()?.type === '-') { position++; return -unary(); }
    return power();
  };
  const power = () => {
    const value = primary();
    if (peek()?.type !== '^') return value;
    position++;
    const result = value ** unary();
    if (!Number.isFinite(result)) throw new Error('That operation does not produce a finite number.');
    return result;
  };
  const primary = () => {
    const token = peek();
    if (!token) throw new Error('Expression ended unexpectedly.');
    if (token.type === 'number') { position++; return token.value; }
    if (token.type === '(') {
      position++;
      if (++nesting > 24) throw new Error('Expression nesting is too deep.');
      const value = expression();
      take(')');
      nesting--;
      return value;
    }
    if (token.type !== 'name') throw new Error(`Unexpected token "${token.value}".`);
    position++;
    if (peek()?.type !== '(') {
      if (!Object.prototype.hasOwnProperty.call(constants, token.value)) throw new Error(`Unknown name: ${token.value}.`);
      return constants[token.value];
    }
    if (!Object.prototype.hasOwnProperty.call(functions, token.value)) throw new Error(`Function is not allowed: ${token.value}.`);
    const spec = functions[token.value];
    position++;
    if (++nesting > 24) throw new Error('Expression nesting is too deep.');
    const args = [];
    if (peek()?.type !== ')') {
      args.push(expression());
      while (peek()?.type === ',') { position++; args.push(expression()); }
    }
    take(')');
    nesting--;
    if (args.length < spec[0] || args.length > spec[1]) throw new Error(`Function ${token.value} expects ${spec[0] === spec[1] ? spec[0] : `between ${spec[0]} and ${spec[1]}`} argument(s).`);
    const result = spec[2](...args);
    if (!Number.isFinite(result)) throw new Error('That expression does not produce a finite number.');
    return result;
  };

  const result = expression();
  if (position !== tokens.length) throw new Error(`Unexpected token "${peek().value}".`);
  if (!Number.isFinite(result)) throw new Error('That expression does not produce a finite number.');
  return result;
}

async function route(ctx, input) {
  const { parsed, name, tail } = parse(input);
  if (!FILE_COMMANDS.has(name)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${parsed.text}\`` };
  }
  if (!isOwner(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };
  if (name === 'files' || name === 'filemenu') {
    return { handled: true, text: '*Nick AI · Owner file access*\n' + menuCommands.join('\n') + '\n\nPaths are project-relative. Credentials, runtime data, dependencies, internal files, binary files, and paths outside the project are blocked. No delete or shell commands are provided.' };
  }
  try {
    if (name === 'eval') {
      const result = evaluateMath(tail);
      return { handled: true, text: `🧮 ${tail.trim()} = ${result}` };
    }
    if (name === 'ls' || name === 'dir' || name === 'tree') {
      const { rows, relative } = await listDirectory(tail || '.', name === 'tree');
      if (!rows.length) return { handled: true, text: `No accessible files found under ${relative}.` };
      return { handled: true, text: `📁 ${relative}\n${rows.join('\n')}${rows.length >= MAX_LIST_ENTRIES ? '\n… listing capped' : ''}` };
    }
    if (name === 'find') {
      const rows = await findFiles(tail);
      return { handled: true, text: rows.length ? `🔎 Matches\n${rows.join('\n')}${rows.length >= MAX_FIND_RESULTS ? '\n… results capped' : ''}` : 'No accessible file names matched.' };
    }
    if (['cat', 'readfile', 'viewfile'].includes(name)) {
      const { relative, text } = await readText(tail);
      return { handled: true, text: `📄 ${relative}\n${text.slice(0, MAX_READ_CHARS)}${text.length > MAX_READ_CHARS ? '\n… output truncated at 12,000 characters' : ''}` };
    }
    if (name === 'mkdir' || name === 'createdir') {
      const { target, relative } = normalizeUserPath(tail);
      await checkNoSymlinkPath(target, true);
      const parent = await fs.realpath(path.dirname(target));
      if (!isInsideRoot(parent)) throw new Error('That path resolves outside the bot project.');
      await fs.mkdir(target, { recursive: false });
      return { handled: true, text: `✅ Created folder ${relative}.` };
    }
    const { file, body } = commandBody(tail);
    if (!file || !tail.includes('\n')) return { handled: true, text: usage(name) };
    if (name === 'editfile') {
      const separator = body.match(/(?:^|\n)---FIND---\n([\s\S]*?)\n---REPLACE---\n([\s\S]*)$/);
      if (!separator) return { handled: true, text: usage(name) };
      const { text } = await readText(file);
      const oldText = separator[1];
      const replacement = separator[2];
      if (!oldText) throw new Error('FIND text cannot be empty. No changes were made.');
      const firstIndex = text.indexOf(oldText);
      if (firstIndex < 0) throw new Error('The FIND text was not found. No changes were made.');
      if (text.indexOf(oldText, firstIndex + oldText.length) >= 0) throw new Error('The FIND text occurs more than once. Use a longer unique block. No changes were made.');
      const updated = text.slice(0, firstIndex) + replacement + text.slice(firstIndex + oldText.length);
      const relative = await writeText(file, updated);
      return { handled: true, text: `✅ Updated ${relative} (one unique text block replaced).` };
    }
    const relative = await writeText(file, body, { createOnly: name === 'createfile', append: name === 'append' });
    return { handled: true, text: `✅ ${name === 'append' ? 'Appended to' : name === 'createfile' ? 'Created' : 'Wrote'} ${relative}.` };
  } catch (error) {
    const message = error.code === 'ENOENT' ? 'That file or folder does not exist.'
      : error.code === 'EEXIST' ? 'That path already exists.'
        : error.code === 'EISDIR' ? 'That path is a folder, not a file.'
          : error.code === 'ENOTDIR' ? 'A path component is not a folder.'
            : error.message || 'File operation failed.';
    return { handled: true, text: `❌ ${message}` };
  }
}

module.exports = { route, isCommand, menuCommands };
