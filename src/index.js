// index.js — entrypoint. Connects to WhatsApp, wires the agent router, and
// handles group-membership events (welcome/goodbye).
const config = require('./config');
const logger = require('./logger');
const { connect } = require('./whatsapp/connection');
const { makeRouter } = require('./core/router');
const reminders = require('./features/reminders');
const birthdays = require('./features/birthdays');
// scheduledLeaderboard disabled (no games/levels)
const obsidian = require('./features/obsidian');
const mcpManager = require('./mcp/mcpManager');
const selfheal = require('./features/selfheal');
const names = require('./features/names');
const { Collection } = require('./db');
const { numFromJid, isGroupJid } = require('./utils/helpers');
const jidResolver = require('./utils/jidResolver');
const { flushAllSync } = require('./db');
const chatFont = require('./utils/chatFont');
const messageTracker = require('./features/messageTracker');
const starboard = require('./features/starboard');

/** Best-effort profile picture fetch — returns a URL or null (many users restrict this). */
async function getProfilePic(sock, jid) {
  try {
    return await sock.profilePictureUrl(jid, 'image');
  } catch {
    return null; // no picture, or privacy settings block it — not an error worth logging
  }
}

const { AIClient, getActiveProvider } = require('./ai/client');
const { startTelegram } = require('./telegram/bridge');
const aiClient = new AIClient();

// Runtime self-healing: on an uncaught exception, attempt a guarded syntax repair,
// then exit so supervisor.js can restart the process cleanly.
let healingFatal = false;
process.on('uncaughtException', async (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaught exception');
  if (healingFatal) return process.exit(1);
  healingFatal = true;
  try {
    const res = await selfheal.repair(aiClient, `Runtime crash: ${err.message}\n${err.stack || ''}`);
    logger.warn({ repaired: res.repaired, changed: res.changed || [] }, 'runtime self-heal result');
  } catch (e) {
    logger.error({ err: e.message }, 'runtime self-heal failed');
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: String(reason?.message || reason) }, 'unhandled promise rejection');
});

// startup self-check: diagnose syntax regressions before connecting
selfheal.healthCheck().then(r => logger.info({ ok: r.ok, checked: r.checked, failures: r.failures?.length || 0 }, 'startup self-check')).catch(e => logger.warn({ err: e.message }, 'startup self-check failed'));

async function main() {
  logger.info('Nick AI starting (built by Lord Eagle)...');
  try {
    if (typeof obsidian.repairModeState === 'function') obsidian.repairModeState();
    // Heal corrupted private lock from older builds so the bot answers again
    if (obsidian.isGlobalPrivate()) {
      const mode = obsidian.getGlobalMode();
      logger.warn({ mode }, 'healing: clearing stuck private/lockdown so public replies work — owner can say private again');
      obsidian.store.set('mode', 'public');
      obsidian.store.set('lockdown', false);
      obsidian.store.set('scope', 'all');
    }
  } catch (e) { logger.warn({ err: e.message }, 'mode repair failed'); }

  // Telegram runs in parallel with WhatsApp (same AI brain)
  try {
    await startTelegram(aiClient);
  } catch (e) {
    logger.warn({ err: e.message }, 'telegram bridge failed to start (WhatsApp still runs)');
  }

  const provider = getActiveProvider();
  logger.info(`   Model → ${provider.model} via ${provider.name} (${provider.baseUrl})`);
  try {
    const nOk = !!(process.env.NETLIFY_TOKEN || process.env.NETLIFY_AUTH_TOKEN);
    const vOk = !!(process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN || process.env.VERCEL_API_KEY);
    logger.info({ netlify: nOk, vercel: vOk }, 'deploy backends (static sites)');
  } catch {}


  // This flag is a stored runtime toggle (set by the owner typing "private"/"lockdown"),
  // not a code default — it survives restarts. It's also the #1 cause of "the bot only
  // replies to me" reports: only the owner bypasses this gate, so it silently looks like
  // everyone else is broken. Logging it loudly on every boot means it can never again go
  // unnoticed for an entire deployment's lifetime.
  if (obsidian.isGlobalPrivate()) {
    logger.warn('🔒 STARTUP NOTICE: global mode is PRIVATE/LOCKDOWN — only the owner will get replies. DM "public" (as owner) to restore normal responses.');
  }
  const scope = obsidian.getResponseScope();
  if (scope !== 'all') {
    logger.warn({ scope }, `🎯 STARTUP NOTICE: response scope is "${scope}", not "all" — non-owner messages outside that scope are ignored.`);
  }

  // MCP servers connect in parallel with everything else below; a slow/failed
  // MCP server never blocks WhatsApp from coming up. Tools from any server that
  // connects in time are available from the very first message.
  mcpManager.init().then(() => {
    const connected = mcpManager.listServers().filter((s) => s.status === 'connected');
    if (connected.length) logger.info({ servers: connected.map((s) => s.name) }, 'mcp: ready');
  }).catch((e) => logger.warn({ err: e.message }, 'mcp: init failed'));

  await connect((sock) => {
    // Capture every message key returned by Baileys. This is what makes
    // "delete all my messages" reliable across text/media/tool/game sends,
    // instead of only tracking the router's text helper.
    if (!sock.__brokenSendTrackerInstalled) {
      const originalSendMessage = sock.sendMessage.bind(sock);
      // One outbound queue per chat. AI tools can fire several sends while completing
      // one task; WhatsApp should see those as paced human messages, not a burst.
      const sendQueues = new Map();
      const lastSentAt = new Map();
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const randomGap = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
      sock.sendMessage = async (...args) => {
        const jid = String(args[0] || '');
        const content = args[1] || {};
        const isDelete = !!content?.delete;
        const isPresenceOnly = !content || Object.keys(content).length === 0;
        const previous = sendQueues.get(jid) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        sendQueues.set(jid, current);
        await previous.catch(() => {});
        try {
          // Deletions stay quick; actual user-facing sends get a natural gap.
          if (!isDelete && !isPresenceOnly) {
            const last = lastSentAt.get(jid) || 0;
            const minGap = randomGap(750, 1450);
            const wait = Math.max(0, minGap - (Date.now() - last));
            if (wait) await sleep(wait);
          }
          const result = await originalSendMessage(...args);
          if (!isDelete && !isPresenceOnly) lastSentAt.set(jid, Date.now());
          if (result?.key && !isDelete) messageTracker.record(result.key);
          return result;
        } finally {
          release();
          if (sendQueues.get(jid) === current) sendQueues.delete(jid);
          if (sendQueues.size > 500) sendQueues.clear();
        }
      };
      sock.__brokenSendTrackerInstalled = true;
      logger.info('human outbound message pacing enabled');
    }

    const senderNameCache = new Map();
    const senderName = (jid, groupId) => {
      const fromNames = names.getName(jid, groupId);
      if (fromNames) return fromNames;
      return senderNameCache.get(numFromJid(jid)) || '';
    };

    sock.ev.on('contacts.update', (updates) => {
      for (const u of updates) {
        if (u.id && u.notify) senderNameCache.set(numFromJid(u.id), u.notify);
      }
    });

    // capture push names from incoming messages (more reliable than contacts.update)
    sock.ev.on('messages.upsert', (m) => {
      try {
        if (m.type !== 'notify') return;
        for (const msg of m.messages || []) {
          const from = msg.key?.participant || msg.key?.remoteJid;
          if (from && msg.pushName) names.rememberPush(from, msg.pushName);
        }
      } catch {}
    });

    const router = makeRouter({ sock, aiClient, senderName });
    reminders.startScheduler(sock);
    // Durable, opt-in status/reminder follow-ups created by the agent.  This keeps
    // promised feedback flowing even when the user does not send another message.
    try { require('./features/axon_tools').startProactiveScheduler(sock); } catch (e) { logger.warn({ err: e.message }, 'proactive scheduler failed to start'); }
    birthdays.startScheduler(sock);
    // scheduledLeaderboard disabled (no games/levels/economy boards)

    // Scheduled-message delivery: check every 15s and send any that are due.
    const schedStore = new Collection('scheduled', { list: [] });
    setInterval(async () => {
      try {
        const now = Date.now();
        const list = schedStore.get('list', []);
        const due = list.filter((x) => x.at <= now);
        if (due.length) {
          schedStore.set('list', list.filter((x) => x.at > now));
          for (const item of due) {
            try { await sock.sendMessage(item.chatId, { text: chatFont.apply(item.chatId, `⏰ Scheduled: ${item.text}`) }); } catch (e) { logger.warn({ err: e.message }, 'scheduled send failed'); }
          }
        }
      } catch (e) { logger.warn({ err: e.message }, 'scheduled checker failed'); }
    }, 15000);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          // --- anti-delete: capture/revoke run fire-and-forget so they never delay the
          // actual command pipeline below ---
          if (msg.message?.protocolMessage?.key?.id) {
          } else {
          }
          await router.handleIncoming(msg);
        } catch (e) {
          logger.error({ err: e.message }, 'unhandled error in message handler');
        }
      }
    });

    // Banned-member guard only (no welcome/goodbye spam — this is an agent, not a greeting bot).
    sock.ev.on('group-participants.update', async (event) => {
      try {
        const { id: groupId, participants = [], action } = event;
        if (action !== 'add' || !participants.length) return;
        let groupMeta = null;
        try { groupMeta = await sock.groupMetadata(groupId); } catch {}
        const jidMap = jidResolver.buildMap(sock, { key: {} }, groupMeta);
        const resolvedParticipants = jidResolver.normalizeMany(participants, jidMap);
        for (const p of resolvedParticipants) {
          if (obsidian.isBanned(p)) {
            try { await sock.groupParticipantsUpdate(groupId, [p], 'remove'); } catch (e) {
              logger.warn({ err: e.message }, 'failed to remove banned user');
            }
          }
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'group-participants.update handler failed');
      }
    });

    // --- starboard: react with the group's chosen emoji enough times and the message
    // gets reposted to a designated chat (defaults to the same group). ---
    sock.ev.on('messages.reaction', async (reactions) => {
      for (const r of reactions) {
        try {
          const groupId = r.key?.remoteJid;
          const msgId = r.key?.id;
          const reactorId = r.key?.participant || r.key?.remoteJid;
          const emoji = r.reaction?.text || '';
          const remove = !emoji; // empty text = reaction removed
          if (!groupId || !msgId || !isGroupJid(groupId)) continue;

          const res = starboard.registerReaction(groupId, msgId, remove ? starboard.getSettings(groupId).emoji : emoji, reactorId, remove);
          if (!res.shouldPost) continue;

          const cached = starboard.getCached(groupId, msgId);
          const target = res.targetChatId || groupId;
          const settings = starboard.getSettings(groupId);
          const header = `${settings.emoji} *${res.count}* | starred message`;

          if (!cached) {
            await sock.sendMessage(target, { text: `${header}\n\n(original content no longer cached — nothing to repost)` });
            continue;
          }
          const label = names.displayLabel(cached.senderJid, groupId);
          const caption = `${header}\nfrom ${label}${cached.text ? `\n\n${cached.text}` : ''}`;
          if (cached.kind === 'image' && cached.buffer) {
            await sock.sendMessage(target, { image: cached.buffer, mimetype: cached.mimetype, caption });
          } else if (cached.kind === 'video' && cached.buffer) {
            await sock.sendMessage(target, { video: cached.buffer, mimetype: cached.mimetype, caption });
          } else {
            await sock.sendMessage(target, { text: caption });
          }
        } catch (e) {
          logger.warn({ err: e.message }, 'starboard: reaction handler failed');
        }
      }
    });
  });
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, 'fatal startup error');
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info(`Received ${sig}, flushing data and exiting...`);
    flushAllSync();
    process.exit(0);
  });
}
