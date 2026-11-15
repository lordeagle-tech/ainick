'use strict';

const { Collection } = require('../db');
const settings = new Collection('command_plugin_settings', {});
const PREFIX_KEY = 'prefix';
const PREFIX_RE = /^[!#$%&*+,.?:~]{1,3}$/;

function getPrefix() {
  const value = settings.get(PREFIX_KEY, '');
  return typeof value === 'string' && PREFIX_RE.test(value) ? value : '';
}

function setPrefix(input) {
  const value = String(input || '').trim();
  if (/^(?:off|none|clear|reset)$/i.test(value)) {
    settings.set(PREFIX_KEY, '');
    return { ok: true, prefix: '' };
  }
  if (!PREFIX_RE.test(value)) {
    return { ok: false, error: 'Use 1–3 punctuation characters (for example `!`, `.` or `#`), or `off` to clear it.' };
  }
  settings.set(PREFIX_KEY, value);
  return { ok: true, prefix: value };
}

function parseCommand(input) {
  const raw = String(input || '').trim();
  const prefix = getPrefix();
  if (prefix && raw.startsWith(prefix)) {
    return { text: raw.slice(prefix.length).trimStart(), hadPrefix: true, prefix };
  }
  return { text: raw, hadPrefix: false, prefix };
}

function isPrefixExempt(commandText) {
  return /^(?:setprefix(?:\s|$)|owner\s+(?:menu|help|commands)(?:\s|$)|group\s+(?:menu|help|commands)(?:\s|$))/i.test(String(commandText || '').trim());
}

function needsPrefix(parsed) {
  return !!parsed.prefix && !parsed.hadPrefix && !isPrefixExempt(parsed.text);
}

module.exports = { getPrefix, setPrefix, parseCommand, isPrefixExempt, needsPrefix };
