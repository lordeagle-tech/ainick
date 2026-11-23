'use strict';

// Port of Zynex-MD's `fetch` and `nettools` command families.
// `fetch/get/curl` are public but refuse local/private targets. DNS, port
// checks and HTTP ping stay owner-only, matching the source project.

const dns = require('node:dns').promises;
const net = require('node:net');
const axios = require('axios');
const commandPrefix = require('./commandPrefix');
const roles = require('../features').roles;
const messageLayout = require('../utils/messageLayout');

const FETCH_COMMANDS = new Set(['fetch', 'get', 'curl']);
const DNS_COMMANDS = new Set(['dns', 'dnslookup', 'nslookup']);
const PORT_COMMANDS = new Set(['portscan', 'portcheck', 'scanport']);
const PING_COMMANDS = new Set(['netping', 'httpcheck', 'httpping']);
const MENU_COMMANDS = new Set(['netmenu', 'netloc', 'networkmenu', 'locationmenu']);

const menuCommands = [
  'fetch', 'get', 'curl',
  'netmenu', 'networkmenu', 'netloc', 'locationmenu',
  'dns', 'dnslookup', 'nslookup',
  'portscan', 'portcheck', 'scanport',
  'netping', 'httpcheck', 'httpping',
];
const publicMenuCommands = ['fetch', 'get', 'curl'];
const ownerMenuCommands = ['netmenu', 'dns', 'portscan', 'netping'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FETCH_TIMEOUT_MS = 20000;
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3306, 5432, 6379, 8080, 8443, 27017];
const PORT_NAMES = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP',
  110: 'POP3', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 3306: 'MySQL',
  5432: 'Postgres', 6379: 'Redis', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt',
  27017: 'MongoDB',
};

function commandText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^(?:fetch|get|curl|netmenu|networkmenu|netloc|locationmenu|dns|dnslookup|nslookup|portscan|portcheck|scanport|netping|httpcheck|httpping)(?:\s|$)/i.test(commandText(input));
}

function safe(value, limit = 180) {
  return String(value || '').replace(/[\r\n`*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** For URLs and code: keeps underscores but removes markdown/backtick breaks. */
function codeSafe(value, limit = 240) {
  return String(value || '').replace(/[\r\n`]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, limit);
}

/** Pretty JSON must keep its newlines; only backticks can break the fence. */
function codeBlockSafe(value, limit = 3400) {
  return String(value || '').replace(/`/g, "'").slice(0, limit);
}

function isOwner(ctx) {
  return !!ctx?.isOwner || roles.isOwner(ctx?.senderJid);
}

function formatSize(bytes) {
  if (!bytes || Number.isNaN(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = Number(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function isPrivateIp(value) {
  const raw = String(value || '').toLowerCase();
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateIp(mapped[1]);
  if (!net.isIP(raw)) return false;
  if (raw === '::' || raw === '::1' || raw.startsWith('fc') || raw.startsWith('fd') || raw.startsWith('fe80')) return true;
  const v4 = raw.split('.').map(Number);
  if (v4.length !== 4) return false;
  if (v4[0] === 0 || v4[0] === 10 || v4[0] === 127) return true;
  if (v4[0] === 169 && v4[1] === 254) return true;
  if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true;
  if (v4[0] === 192 && v4[1] === 168) return true;
  if (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) return true;
  return false;
}

/** Validate a user URL and (for public commands) reject local/private hosts. */
async function normalizeUrl(raw, { allowPrivate = false } = {}) {
  let candidate = String(raw || '').trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let url;
  try { url = new URL(candidate); } catch { return { error: 'Enter a valid URL.' }; }
  if (!/^https?:$/i.test(url.protocol)) return { error: 'Only http:// and https:// URLs are supported.' };
  if (url.username || url.password) return { error: 'URLs containing credentials are not allowed.' };
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { error: 'Enter a valid URL.' };

  if (!allowPrivate) {
    const blockedName = host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.local') || host.endsWith('.internal');
    if (blockedName) return { error: 'Local/private hosts are not allowed.' };
    let addresses;
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = (await dns.lookup(host, { all: true })).map((entry) => entry.address);
      } catch {
        return { error: `Could not resolve \`${safe(host)}\`.` };
      }
    }
    if (!addresses.length || addresses.some(isPrivateIp)) return { error: 'Local/private hosts are not allowed.' };
  }
  return { url: url.toString() };
}

function fetchErrorMessage(error, target) {
  const code = error?.code || '';
  if (code === 'ENOTFOUND') return `Domain not found: \`${codeSafe(target)}\`.`;
  if (code === 'ECONNREFUSED') return `Connection refused: \`${codeSafe(target)}\`.`;
  if (code === 'ETIMEDOUT' || /timeout/i.test(error?.message || '')) return 'Request timed out.';
  return `Failed to fetch: ${safe(error?.message || 'unknown error', 220)}`;
}

async function fetchRawUrl(raw) {
  const original = /^https?:\/\//i.test(String(raw || '').trim())
    ? String(raw).trim()
    : `https://${String(raw || '').trim()}`;
  let current = original;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await normalizeUrl(current);
    if (check.error) return { error: check.error };
    current = check.url;

    let response;
    try {
      response = await axios.get(current, {
        timeout: FETCH_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: MAX_FETCH_BYTES,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': UA, Accept: '*/*' },
        validateStatus: () => true,
      });
    } catch (error) {
      return { error: fetchErrorMessage(error, current) };
    }

    const location = response.headers?.location;
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === MAX_REDIRECTS) return { error: 'Too many redirects.' };
      try { current = new URL(location, current).toString(); } catch { return { error: 'The server sent an invalid redirect.' }; }
      continue;
    }

    const buffer = Buffer.from(response.data || []);
    if (buffer.length > MAX_FETCH_BYTES) return { error: 'The response was too large (20 MB limit).' };
    const contentType = String(response.headers?.['content-type'] || 'unknown').split(';')[0].trim();
    return {
      ok: true,
      requestedUrl: original,
      finalUrl: current,
      status: response.status,
      contentType,
      size: Number(response.headers?.['content-length']) || buffer.length,
      server: String(response.headers?.server || 'unknown'),
      buffer,
    };
  }
  return { error: 'Too many redirects.' };
}

function formatFetchInfo(result) {
  const lines = [
    '🌐 *URL FETCH RESULT*',
    '━━━━━━━━━━━━━━━━━━━━━',
    `🔗 *URL:* ${codeSafe(result.requestedUrl, 240)}`,
  ];
  if (result.finalUrl && result.finalUrl !== result.requestedUrl) {
    lines.push(`↪️ *Redirected:* ${codeSafe(result.finalUrl, 240)}`);
  }
  lines.push(
    `📊 *Status:* ${safe(result.status, 20)}`,
    `📄 *Content-Type:* ${safe(result.contentType, 80)}`,
    `📦 *Size:* ${formatSize(result.size)}`,
    `🖥️ *Server:* ${safe(result.server, 80)}`,
  );
  return lines.join('\n');
}

function fileNameFor(url, contentType) {
  let name = 'file';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'file'); } catch {}
  name = codeSafe(name, 80).replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '') || 'file';
  if (!name.includes('.')) {
    const ext = /image\/jpeg/i.test(contentType) ? 'jpg'
      : /image\/png/i.test(contentType) ? 'png'
        : /image\/gif/i.test(contentType) ? 'gif'
          : /pdf/i.test(contentType) ? 'pdf'
            : /json/i.test(contentType) ? 'json'
              : /text\//i.test(contentType) ? 'txt' : '';
    if (ext) name += `.${ext}`;
  }
  return name;
}

async function fetchCommand(ctx, raw) {
  if (!raw) {
    return { handled: true, text: [
      '*Nick AI · Fetch*',
      'Fetch a public URL and show its status, headers and content.',
      'Usage: `fetch <url>` (aliases: `get`, `curl`)',
      'Example: `fetch https://api.github.com`',
      'Text/JSON is previewed; images, audio, video and other files are sent directly.',
    ].join('\n') };
  }
  if (!ctx?.sock || !ctx?.chatId) return { handled: true, text: 'Fetch is unavailable in this context.' };

  const result = await fetchRawUrl(raw);
  if (!result.ok) return { handled: true, text: `❌ ${result.error}` };

  const info = formatFetchInfo(result);
  const type = result.contentType.toLowerCase();
  const isText = type.startsWith('text/')
    || /json|xml|javascript|csv|x-www-form-urlencoded|yaml/i.test(type)
    || type === 'unknown';

  if (isText) {
    let body = result.buffer.toString('utf8');
    if (/json/i.test(type)) {
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
      if (body.length > 3000) body = `${body.slice(0, 3000)}\n... (truncated)`;
      return { handled: true, text: `${info}\n\n📋 *Response (JSON):*\n\`\`\`${codeBlockSafe(body)}\`\`\`\n\n━━━━━━━━━━━━━━━━━━━━━` };
    }
    const clean = safe(body.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' '), 1800);
    return { handled: true, text: `${info}${clean ? `\n\n📋 *Response (Text):*\n${clean}` : '\n\n_(empty body)_'}\n\n━━━━━━━━━━━━━━━━━━━━━` };
  }

  const fileName = fileNameFor(result.finalUrl, type);
  let message;
  if (type.startsWith('image/')) message = { image: result.buffer, caption: info };
  else if (type.startsWith('video/')) message = { video: result.buffer, caption: info };
  else if (type.startsWith('audio/')) message = { audio: result.buffer, mimetype: type, ptt: false };
  else message = { document: result.buffer, mimetype: type, fileName, caption: info };

  try {
    await ctx.sock.sendMessage(ctx.chatId, message);
    return { handled: true, text: null };
  } catch (error) {
    return { handled: true, text: `${info}\n⚠️ Binary content (\`${safe(type, 60)}\`) could not be sent: ${safe(error?.message, 180)}` };
  }
}

function validDomain(input) {
  const domain = String(input || '').trim().toLowerCase().split('/')[0].replace(/\.$/, '');
  if (domain.length > 253 || net.isIP(domain)) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}

async function dnsCommand(raw) {
  const domain = String(raw || '').trim().split(/\s+/)[0];
  if (!validDomain(domain)) {
    return { handled: true, text: '*🔍 DNS Lookup*\n\nUsage: `dns <domain>`\nExample: `dns google.com`' };
  }
  const clean = domain.toLowerCase().replace(/\.$/, '');
  const records = [];
  const tryResolve = async (type, fn) => {
    try {
      const value = await fn();
      if (Array.isArray(value) && value.length) records.push({ type, values: value.slice(0, 10) });
    } catch {}
  };
  await Promise.all([
    tryResolve('A', () => dns.resolve4(clean)),
    tryResolve('AAAA', () => dns.resolve6(clean)),
    tryResolve('MX', () => dns.resolveMx(clean).then((list) => list.map((r) => `${r.priority} ${r.exchange}`).sort())),
    tryResolve('NS', () => dns.resolveNs(clean)),
    tryResolve('TXT', () => dns.resolveTxt(clean).then((list) => list.map((parts) => parts.join('')).slice(0, 10))),
    tryResolve('CNAME', () => dns.resolveCname(clean)),
    tryResolve('SOA', () => dns.resolveSoa(clean).then((r) => [`${r.nsname} (serial ${r.serial})`])),
  ]);
  if (!records.length) {
    return { handled: true, text: `❌ No DNS records found for \`${safe(clean)}\`.\n_The domain may not exist or is unreachable._` };
  }
  const lines = ['╭─〘 *🔍 DNS LOOKUP* 〙', `┃❍ *Domain:* ${safe(clean)}`, '┃'];
  for (const { type, values } of records) {
    lines.push(`┃ *${type}:*`);
    for (const value of values) lines.push(`┃   • ${safe(value, 180)}`);
    lines.push('┃');
  }
  lines.push('╰──────────⊷');
  return { handled: true, text: lines.join('\n') };
}

function checkPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    const started = Date.now();
    const socket = net.createConnection({ host, port, timeout });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => finish({ open: true, ms: Date.now() - started }));
    socket.on('timeout', () => finish({ open: false, ms: timeout, reason: 'timeout' }));
    socket.on('error', (error) => finish({ open: false, ms: Date.now() - started, reason: error.code || error.message }));
  });
}

async function portCommand(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const host = parts[0]?.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  if (!host || host.length > 253 || /\s/.test(host)) {
    return { handled: true, text: [
      '*🔌 Port Check*',
      'Usage: `portscan <host> [port]`',
      '• `portscan 1.1.1.1 443` — check one port',
      `• \`portscan example.com\` — check ${COMMON_PORTS.length} common ports`,
    ].join('\n') };
  }
  let specificPort = null;
  if (parts[1]) {
    specificPort = Number(parts[1]);
    if (!Number.isInteger(specificPort) || specificPort < 1 || specificPort > 65535) {
      return { handled: true, text: '❌ Port must be an integer between 1 and 65535.' };
    }
  }
  const ports = specificPort ? [specificPort] : COMMON_PORTS;
  const checks = await Promise.all(ports.map(async (port) => ({ port, ...(await checkPort(host, port, 6000)) })));
  const open = checks.filter((item) => item.open);
  const closed = checks.filter((item) => !item.open);
  const lines = ['╭─〘 *🔌 PORT SCAN* 〙', `┃❍ *Host:* \`${safe(host)}\``, `┃❍ *Ports scanned:* ${ports.length}`, '┃'];
  if (open.length) {
    lines.push(`┃ *🟢 Open (${open.length}):*`);
    for (const item of open) {
      const name = PORT_NAMES[item.port] ? ` [${PORT_NAMES[item.port]}]` : '';
      lines.push(`┃   ✅ :${item.port}${name} — ${item.ms}ms`);
    }
  }
  if (specificPort && closed.length) {
    lines.push('┃', '┃ *🔴 Closed:*');
    for (const item of closed) {
      const name = PORT_NAMES[item.port] ? ` [${PORT_NAMES[item.port]}]` : '';
      lines.push(`┃   ❌ :${item.port}${name} — ${safe(item.reason || 'refused', 60)}`);
    }
  } else if (!open.length) {
    lines.push(`┃ 🔴 All ${ports.length} common ports are closed/filtered.`);
  } else if (closed.length) {
    lines.push('┃', `┃ 🔴 ${closed.length} other ports closed/filtered.`);
  }
  lines.push('╰──────────⊷');
  return { handled: true, text: lines.join('\n') };
}

async function netPingCommand(raw) {
  if (!raw) {
    return { handled: true, text: '*📡 Net Ping*\n\nUsage: `netping <host-or-url>`\nExample: `netping google.com`' };
  }
  // Owner-only diagnostics may target local services; no private-host block.
  const check = await normalizeUrl(raw, { allowPrivate: true });
  if (check.error) return { handled: true, text: `❌ ${check.error}` };
  const times = [];
  let status = null;
  let statusText = '';
  let lastError = '';
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    try {
      const response = await axios.get(check.url, {
        timeout: 8000,
        maxRedirects: 5,
        validateStatus: () => true,
        responseType: 'stream',
        headers: { 'User-Agent': UA },
      });
      try { response.data?.destroy?.(); } catch {}
      times.push(Date.now() - started);
      status = response.status;
      statusText = String(response.statusText || '').slice(0, 40);
    } catch (error) {
      lastError = error?.message || 'unknown error';
      if (error?.response) status = error.response.status;
    }
  }
  if (!times.length) {
    return { handled: true, text: `❌ *Host unreachable*\n\`${safe(check.url, 240)}\`\n_Error: ${safe(lastError, 180)}_` };
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const quality = avg < 200 ? '🟢 Excellent' : avg < 500 ? '🟡 Good' : avg < 1500 ? '🟠 Fair' : '🔴 Poor';
  const statusIcon = status >= 200 && status < 400 ? '✅' : status >= 400 && status < 500 ? '⚠️' : '🔴';
  return { handled: true, text: [
    '╭─〘 *📡 NET PING* 〙',
    `┃❍ *Host:* ${safe(check.url, 240)}`,
    `┃❍ *HTTP Status:* ${statusIcon} ${safe(status, 20)} ${safe(statusText, 40)}`.trim(),
    `┃❍ *Attempts:* ${times.length}/3`,
    `┃❍ *Avg latency:* ${avg}ms`,
    `┃❍ *Min / Max:* ${min}ms / ${max}ms`,
    `┃❍ *Connection:* ${quality}`,
    '╰──────────⊷',
  ].join('\n') };
}

function netMenu() {
  return { handled: true, text: [
    '╭─〘 *🌐 NETWORK TOOLS* 〙',
    '┃',
    '┃ 🌍 *Public:*',
    '┃   • `fetch <url>` — status, headers, text/JSON or file',
    '┃     aliases: `get`, `curl`',
    '┃',
    '┃ 🔒 *Owner only:*',
    '┃   • `dns <domain>` — A/AAAA/MX/NS/TXT/CNAME/SOA records',
    '┃   • `portscan <host> [port]` — TCP port check',
    '┃   • `netping <host>` — HTTP status & latency (3 tries)',
    '┃     aliases: `nslookup`, `portcheck`, `httpcheck`',
    '┃',
    '┃ _Public fetch blocks local/private addresses._',
    '╰──────────⊷',
  ].join('\n') };
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }

  const command = (text.match(/^(\S+)/)?.[1] || '').toLowerCase();
  const raw = text.replace(/^\S+\s*/, '').trim();

  if (FETCH_COMMANDS.has(command)) return fetchCommand(ctx, raw);

  if (!isOwner(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };
  if (MENU_COMMANDS.has(command)) return netMenu();
  if (DNS_COMMANDS.has(command)) return dnsCommand(raw);
  if (PORT_COMMANDS.has(command)) return portCommand(raw);
  if (PING_COMMANDS.has(command)) return netPingCommand(raw);
  return { handled: false };
}

module.exports = { isCommand, route, menuCommands, publicMenuCommands, ownerMenuCommands };
