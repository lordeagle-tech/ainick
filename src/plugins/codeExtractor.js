'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove braces that are inside strings, templates, regexes or comments. */
function stripJs(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf('*/', i);
      if (end < 0) return out;
      i = end + 2;
      state.inBlockComment = false;
      continue;
    }
    if (state.inString) {
      const ch = line[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === state.quote) { state.inString = false; state.quote = null; }
      i += 1;
      continue;
    }
    if (state.inRegex) {
      const ch = line[i];
      const keep = (value) => (value === '{' ? '\u0001' : value === '}' ? '\u0002' : value);
      if (state.regexEscape) { out += keep(ch); state.regexEscape = false; i += 1; continue; }
      if (ch === '\\') { out += '\\'; state.regexEscape = true; i += 1; continue; }
      if (ch === '[') { state.inCharClass = true; out += ch; i += 1; continue; }
      if (ch === ']') { state.inCharClass = false; out += ch; i += 1; continue; }
      if (ch === '/' && !state.inCharClass) { state.inRegex = false; out += ch; i += 1; continue; }
      out += keep(ch);
      i += 1;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '//') return out;
    if (two === '/*') { state.inBlockComment = true; i += 2; continue; }
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === '`') { state.inString = true; state.quote = ch; i += 1; continue; }
    if (ch === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1);
      if (!prev || '=(,:[!&|?;{+}'.includes(prev)) { state.inRegex = true; i += 1; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function analyze(lines) {
  const state = { inBlockComment: false, inString: false, quote: null, inRegex: false, regexEscape: false, inCharClass: false };
  const stacks = [];
  const deltas = [];
  const stripped = [];
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    stacks.push(stack.slice());
    const code = stripJs(lines[i], state);
    stripped.push(code);
    let delta = 0;
    for (const ch of code) {
      if (ch === '{') { stack.push(i); delta += 1; }
      else if (ch === '}') { stack.pop(); delta -= 1; }
    }
    deltas.push(delta);
  }
  return { stacks, deltas, stripped };
}

function blockEnd(deltas, start, total) {
  let depth = 0;
  for (let i = start; i < total; i++) {
    depth += deltas[i];
    if (depth <= 0) return i;
  }
  return total - 1;
}

function isHandlerLine(line, command) {
  const cmd = escapeRe(command);
  // A standalone quoted token (`name === 'cat'`, `['cat', ...]`) is the strongest signal.
  if (new RegExp(`(['"\`])${cmd}\\1`, 'i').test(line)) return true;
  // Command names in regex checks (`/^(?:...|vv)\\b/i.test(text)`).
  if (/\.(?:test|match)\(|\/[^/\n]+\/[gimsuy]*/.test(line)
    && new RegExp(`\\b${cmd}\\b`, 'i').test(line)) return true;
  // Or a helper function named after the command.
  return new RegExp(`\\bfunction\\s+${cmd}\\s*\\(`, 'i').test(line);
}

function topLevelFunctions(lines, deltas) {
  const fns = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (m) fns.push({ name: m[1], start: i, end: blockEnd(deltas, i, lines.length) });
  }
  return fns;
}

function collectHandlers(lines, { stacks, deltas, stripped }, command) {
  const blocks = [];
  const seen = new Set();
  const total = lines.length;
  const add = (start, end) => {
    if (start < 0 || end < start) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push({ start, end });
  };

  for (let i = 0; i < total; i++) {
    if (!isHandlerLine(lines[i], command)) continue;
    const line = lines[i];
    if (/^\s*(?:if\b|else\s+if\b|case\b)/i.test(line) && line.includes('{')) {
      add(i, blockEnd(deltas, i, total));
      continue;
    }
    const stack = stacks[i];
    const outer = stack.length ? stack[stack.length - 1] : -1;
    if (outer >= 0 && blockEnd(deltas, outer, total) - outer <= 60) {
      add(outer, blockEnd(deltas, outer, total));
      continue;
    }
    add(Math.max(0, i - 1), Math.min(total - 1, i + 2));
  }

  // A command regex is often defined on one line and consumed by an `if` elsewhere
  // (e.g. `const viewOnceCommand = ...` → `if (viewOnceCommand && isAddressed)`).
  // Follow those variables so the actual handler is included too.
  const vars = new Set();
  for (const block of blocks) {
    for (const line of lines.slice(block.start, block.end + 1)) {
      const m = line.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m && m[1].length >= 4) vars.add(m[1]);
    }
  }
  let expanded = 0;
  for (const name of vars) {
    if (expanded >= 4) break;
    const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'i');
    for (let i = 0; i < total; i++) {
      if (expanded >= 4) break;
      if (!re.test(stripped[i]) || !/^\s*if\b/i.test(stripped[i]) || !stripped[i].includes('{')) continue;
      const end = blockEnd(deltas, i, total);
      if (end - i > 120) continue;
      add(i, end);
      expanded += 1;
    }
  }

  if (!blocks.length) {
    const fn = topLevelFunctions(lines, deltas).find((f) => f.name.toLowerCase() === command.toLowerCase());
    if (fn) add(fn.start, fn.end);
  }
  return blocks.sort((a, b) => a.start - b.start);
}

function collectHelpers(lines, fns, handlers, limit = 6) {
  const textOf = (b) => lines.slice(b.start, b.end + 1).join('\n');
  const out = [];
  const names = new Set(['route', 'handleMedia', 'isCommand', 'parseCommand']);
  let frontier = handlers.map(textOf);
  for (let depth = 0; depth < 2 && out.length < limit; depth++) {
    const next = [];
    for (const source of frontier) {
      for (const fn of fns) {
        if (names.has(fn.name) || out.length >= limit) continue;
        if (new RegExp(`\\b${escapeRe(fn.name)}\\s*\\(`).test(source)) {
          names.add(fn.name);
          out.push(fn);
          next.push(textOf(fn));
        }
      }
    }
    frontier = next;
  }
  return out;
}

function collectRequires(lines, text) {
  const out = [];
  for (const line of lines) {
    if (/^(?:async\s+)?function\s/.test(line)) break;
    const m = line.match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/);
    if (m && new RegExp(`\\b${escapeRe(m[1])}\\b`).test(text)) out.push(line);
  }
  return out;
}

async function extractCommandCode(filePath, command, relativePath) {
  const source = await fs.readFile(filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  const info = analyze(lines);
  const fns = topLevelFunctions(lines, info.deltas);
  const handlers = collectHandlers(lines, info, command);
  if (!handlers.length) return null;

  const helpers = collectHelpers(lines, fns, handlers);
  const textOf = (b) => lines.slice(b.start, b.end + 1).join('\n');
  const handlersText = handlers.map(textOf).join('\n\n');
  const helpersText = helpers.map(textOf).join('\n\n');
  const body = `${handlersText}${helpersText ? `\n\n// ── helpers used above ──\n${helpersText}` : ''}`;
  const requires = collectRequires(lines, body);

  return [
    '// ─────────────────────────────────────────────',
    `// Command : ${command}`,
    `// Source  : ${relativePath}`,
    '// ─────────────────────────────────────────────',
    '',
    ...requires,
    ...(requires.length ? [''] : []),
    body,
    '',
  ].join('\n');
}

module.exports = { extractCommandCode, stripJs };
