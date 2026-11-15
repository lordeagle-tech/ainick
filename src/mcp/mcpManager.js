// mcp/mcpManager.js — real MCP (Model Context Protocol) client support.
//
// This is a genuine MCP *client*: it spawns each configured MCP server as a child
// process, speaks the actual MCP protocol to it over stdio using Anthropic's
// official @modelcontextprotocol/sdk, asks it what tools it has, and converts
// those into the same OpenAI-function-calling tool schema the rest of this bot
// already uses — so the agent loop in ai/client.js doesn't need to know or care
// whether a tool it's calling is hand-written in ai/tools.js or lives inside an
// external MCP server.
//
// Config: mcp.servers.json in the project root (gitignored — see
// mcp.servers.example.json). If that file is missing or empty, MCP is simply a
// no-op: zero servers, zero MCP tools, nothing else changes. A server that fails
// to start or connect is logged and skipped — it never blocks bot startup or
// crashes the rest of the tool system.
//
// Tool names exposed to the model are namespaced as `mcp__<server>__<tool>` so
// they can never collide with a built-in tool name, and so executeTool() can
// route a call to the right server just by looking at its name.

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const CONFIG_PATH = process.env.MCP_CONFIG_PATH
  ? path.resolve(process.env.MCP_CONFIG_PATH)
  : path.join(process.cwd(), 'mcp.servers.json');

// serverName -> { client, transport, tools: [{name, description, inputSchema}], status, error }
const servers = new Map();
let initialized = false;
let initPromise = null;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.servers || {};
  } catch (e) {
    logger.warn({ err: e.message, path: CONFIG_PATH }, 'mcp: failed to parse mcp.servers.json — ignoring MCP config');
    return {};
  }
}

function sanitizeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Connects to every server in the config. Never throws — failures are recorded
 *  per-server so one bad server doesn't take down MCP (or the bot) entirely. */
async function connectAll() {
  const config = loadConfig();
  const names = Object.keys(config);
  if (!names.length) {
    logger.info({ path: CONFIG_PATH }, 'mcp: no servers configured — skipping (this is fine, MCP is optional)');
    return;
  }

  let sdk;
  try {
    // Loaded dynamically (works whether the installed SDK ships as ESM or CJS,
    // and lets the bot boot even if the dependency isn't installed yet).
    sdk = await import('@modelcontextprotocol/sdk/client/index.js');
  } catch (e) {
    logger.error({ err: e.message }, 'mcp: @modelcontextprotocol/sdk is not installed — run `npm install @modelcontextprotocol/sdk` to enable MCP servers');
    return;
  }
  const { Client } = sdk;
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  await Promise.all(names.map(async (rawName) => {
    const name = sanitizeName(rawName);
    const spec = config[rawName];
    if (!spec || !spec.command) {
      servers.set(name, { status: 'error', error: 'Missing "command" in config', tools: [] });
      return;
    }
    try {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args || [],
        env: { ...process.env, ...(spec.env || {}) },
      });
      const client = new Client({ name: `wa-agent-mcp-${name}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const { tools } = await client.listTools();
      servers.set(name, { client, transport, tools: tools || [], status: 'connected', error: null });
      logger.info({ server: rawName, toolCount: (tools || []).length }, 'mcp: server connected');
    } catch (e) {
      servers.set(name, { status: 'error', error: e.message, tools: [] });
      logger.warn({ server: rawName, err: e.message }, 'mcp: server failed to connect — skipping it');
    }
  }));
}

async function init() {
  if (initialized) return;
  if (!initPromise) {
    initPromise = connectAll().finally(() => { initialized = true; });
  }
  await initPromise;
}

/** Returns OpenAI-function-calling-format schemas for every tool on every
 *  connected server. Safe to call before init() finishes — just returns []. */
function getToolSchemas() {
  const out = [];
  for (const [serverName, s] of servers.entries()) {
    if (s.status !== 'connected') continue;
    for (const t of s.tools) {
      out.push({
        type: 'function',
        function: {
          name: `mcp__${serverName}__${sanitizeName(t.name)}`,
          description: `[MCP:${serverName}] ${t.description || t.name}`,
          parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

function isMcpTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}

/** mcp__<server>__<tool> -> { serverName, toolName } */
function parseToolName(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  // The above is ambiguous if server/tool names contain underscores, so we
  // resolve it against the actual connected server list instead of guessing.
  if (!m) return null;
  for (const serverName of servers.keys()) {
    const prefix = `mcp__${serverName}__`;
    if (name.startsWith(prefix)) {
      return { serverName, toolName: name.slice(prefix.length) };
    }
  }
  return null;
}

async function callTool(name, args) {
  const parsed = parseToolName(name);
  if (!parsed) return { ok: false, error: `Could not resolve MCP tool "${name}" to a connected server.` };
  const s = servers.get(parsed.serverName);
  if (!s || s.status !== 'connected') return { ok: false, error: `MCP server "${parsed.serverName}" is not connected.` };
  // Real tool names on the server side aren't sanitized — match by original name.
  const realTool = s.tools.find((t) => sanitizeName(t.name) === parsed.toolName);
  if (!realTool) return { ok: false, error: `Tool "${parsed.toolName}" not found on MCP server "${parsed.serverName}".` };
  try {
    const result = await s.client.callTool({ name: realTool.name, arguments: args || {} });
    return { ok: !result.isError, content: result.content };
  } catch (e) {
    logger.error({ err: e.message, server: parsed.serverName, tool: realTool.name }, 'mcp: tool call failed');
    return { ok: false, error: e.message };
  }
}

function listServers() {
  return [...servers.entries()].map(([name, s]) => ({
    name, status: s.status, error: s.error || null, toolCount: s.tools.length,
    tools: s.tools.map((t) => t.name),
  }));
}

/** Owner-triggered reconnect for one server, e.g. after editing mcp.servers.json. */
async function reconnect(rawName) {
  const name = sanitizeName(rawName);
  const config = loadConfig();
  const spec = config[rawName] || config[name];
  if (!spec) return { ok: false, error: `"${rawName}" is not in ${path.basename(CONFIG_PATH)}.` };
  const existing = servers.get(name);
  if (existing?.transport) { try { await existing.transport.close(); } catch {} }
  servers.delete(name);
  await connectAll();
  const after = servers.get(name);
  return after?.status === 'connected'
    ? { ok: true, tools: after.tools.map((t) => t.name) }
    : { ok: false, error: after?.error || 'Unknown error connecting.' };
}

module.exports = { init, getToolSchemas, isMcpTool, callTool, listServers, reconnect, CONFIG_PATH };
