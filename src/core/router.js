// core/router.js — WhatsApp message pipeline.
// Feature dependencies live in ./featureRegistry so this file stays focused on routing.
const { downloadMediaMessage } = require('@lordeagle21/baileys');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const perms = require('../utils/permissions');
const lastBuild = require('./lastBuild');
const githubTokenVault = require('../features/githubTokenVault');
const workSession = require('./workSession');

async function sendOwnerProgress(sock, text, fallbackJid, isGroup, senderJid) {
  const body = String(text || '').slice(0, 1200);
  if (!body) return;
  try {
    const perms = require('../utils/permissions');
    const owners = (require('../config').ownerIds || []).filter(Boolean);
    if (sock && owners.length) {
      const owner = String(owners[0]).includes('@') ? String(owners[0]) : `${String(owners[0]).replace(/\D/g, '')}@s.whatsapp.net`;
      await sock.sendMessage(owner, { text: body });
      return;
    }
    if (!isGroup && (perms.isOwner(senderJid) || perms.isSudo(senderJid))) {
      // fallback is the current DM; caller can safely use sendText for it.
      return;
    }
  } catch {}
}
const { economy, stickers, afk, autoreply, daemons, darkAgent, roles, funFeed, usageTracker, partyExtras, spamScore, scheduledBroadcast, stickerPack, telegramStickers, funExtras, siteRunner, dailyReport, genQuota, zipMemory, ownerCleanup, selfheal, deletehandler, leveling, customCommands, obsidian, commandPlugins, names, fixer, tts, messageTracker, training, subagents } = require('./featureRegistry');
const { Collection } = require('../db');
const { numFromJid, isGroupJid, fmtCurrency, isGroupStatusMentionMessage, isGroupStatusPost, looksLikeStatusPromo, phonesFromMessageType, timeAgo } = require('../utils/helpers');
const jidResolver = require('../utils/jidResolver');
const { getActiveProvider, setActiveProvider, listProviders } = require('../ai/client');
const memory = require('./memory');
const { buildSystemPrompt, withPersona, personalas } = require('../ai/persona');
const aiTools = require('../ai/tools');
const logger = require('../logger');
const textStyler = require('../utils/textStyler');
const chatFont = require('../utils/chatFont');

// anti-spam tracker (module-level so it persists across messages)
/** Human-like pacing: read time + a rough "typing speed" delay, capped so it never feels laggy. */
function humanDelayMs(text) {
  const len = String(text || '').length;
  const readMs = 400 + Math.min(len * 8, 2500); // skim/compose time, caps ~2.9s
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(readMs + jitter, 3800);
}

const spam = new Map();
// Serialize AI turns per (chat,user) so two rapid messages from the same person cannot
// read the same stale history and then overwrite each other's context. Different users
// remain fully independent and can be processed concurrently.
const agentQueues = new Map();
// Coalesce rapid messages from the same user in the same chat (DM or group).
// If they send 2–5 messages in a row, we wait, join them, and answer ONCE.
const coalesceBuffers = new Map();
const COALESCE_MS = Number(process.env.MESSAGE_COALESCE_MS || 2800);       // quiet gap before flush
const COALESCE_MAX_MS = Number(process.env.MESSAGE_COALESCE_MAX_MS || 7500); // hard cap so we never stall forever
const COALESCE_MAX_PARTS = Number(process.env.MESSAGE_COALESCE_MAX_PARTS || 8);

function formatCoalescedParts(parts) {
  const clean = (parts || []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!clean.length) return '';
  if (clean.length === 1) return clean[0];
  // Numbered so the model sees them as one multi-part turn from the same person
  return clean.map((p, i) => `[msg ${i + 1}/${clean.length}] ${p}`).join('\n');
}

// ---------------------------------------------------------------------------
// Group follow-through.
//
// By default the bot stays quiet in groups unless it is mentioned, replied to,
// or called by name. That is deliberate: answering every line of group chatter
// turns it into a spammer.
//
// But someone who fires three messages in a row is not making conversation at
// the room, they are talking TO the bot and waiting. This counts consecutive
// messages from the same person in the same group and, once they cross the
// threshold inside the window, lets the message through so the existing
// coalescer merges the whole run into ONE reply.
//
// Tune or disable with env vars:
//   GROUP_STREAK_THRESHOLD=3   messages in a row before it engages (0 = off)
//   GROUP_STREAK_WINDOW_MS=25000  how long a run stays open
// ---------------------------------------------------------------------------
const groupStreaks = new Map();
const GROUP_STREAK_THRESHOLD = Number(process.env.GROUP_STREAK_THRESHOLD ?? 3);
const GROUP_STREAK_WINDOW_MS = Number(process.env.GROUP_STREAK_WINDOW_MS || 25000);

function noteGroupStreak(chatId, senderId) {
  if (!GROUP_STREAK_THRESHOLD) return false;
  const key = `${chatId}::${senderId}`;
  const now = Date.now();
  const prev = groupStreaks.get(key);

  if (!prev || now - prev.lastAt > GROUP_STREAK_WINDOW_MS) {
    groupStreaks.set(key, { count: 1, lastAt: now, engaged: false });
    return false;
  }

  prev.count += 1;
  prev.lastAt = now;

  // Already answered this run — stay quiet so the reply is not repeated.
  if (prev.engaged) return false;

  if (prev.count >= GROUP_STREAK_THRESHOLD) {
    prev.engaged = true;
    return true;
  }
  return false;
}

// Drop stale streaks so the map cannot grow without bound in busy groups.
setInterval(() => {
  const cutoff = Date.now() - GROUP_STREAK_WINDOW_MS * 2;
  for (const [k, v] of groupStreaks) if (v.lastAt < cutoff) groupStreaks.delete(k);
}, 60000).unref?.();

function coalesceUserText(scope, text, opts = {}) {
  const piece = String(text || '').trim();
  if (!piece) return Promise.resolve('');

  return new Promise((resolve) => {
    const now = Date.now();
    const prev = coalesceBuffers.get(scope);

    if (prev) {
      clearTimeout(prev.timer);
      prev.parts.push(piece);
      if (prev.parts.length > COALESCE_MAX_PARTS) {
        prev.parts = prev.parts.slice(-COALESCE_MAX_PARTS);
      }
      // Cancel older waiters — only the latest timer owner replies
      try { prev.resolve(null); } catch {}
      prev.resolve = resolve;

      const elapsed = now - prev.startedAt;
      const wait = elapsed >= COALESCE_MAX_MS ? 80 : COALESCE_MS;
      prev.timer = setTimeout(() => {
        const entry = coalesceBuffers.get(scope);
        if (!entry || entry !== prev) return;
        coalesceBuffers.delete(scope);
        const merged = formatCoalescedParts(entry.parts);
        entry.resolve(merged);
      }, wait);
      return;
    }

    const entry = {
      parts: [piece],
      resolve,
      timer: null,
      startedAt: now,
    };
    entry.timer = setTimeout(() => {
      const cur = coalesceBuffers.get(scope);
      if (!cur || cur !== entry) return;
      coalesceBuffers.delete(scope);
      resolve(formatCoalescedParts(entry.parts));
    }, COALESCE_MS);
    coalesceBuffers.set(scope, entry);
  });
}
async function runAgentQueued(scope, fn) {
  const previous = agentQueues.get(scope) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  agentQueues.set(scope, current);
  // Don't wait forever on a stuck previous job for this user/chat
  try {
    await Promise.race([
      previous.catch(() => {}),
      new Promise((r) => setTimeout(r, Number(process.env.AGENT_QUEUE_WAIT_MS || 45000))),
    ]);
  } catch {}
  const timeoutMs = Number(process.env.AGENT_TIMEOUT_MS || 600000);
  try {
    return await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Agent timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
  } catch (e) {
    logger.warn({ err: e.message, scope: String(scope).slice(0, 60) }, 'runAgentQueued failed/timeout');
    throw e;
  } finally {
    try { release(); } catch {}
    if (agentQueues.get(scope) === current) agentQueues.delete(scope);
  }
}
// group metadata cache (60s TTL) — avoids a network fetch on every message
const groupMetaCache = new Map();
const groupChatLog = new Collection('group_chat_log', {});
function logGroupMessage(groupId, sender, text) {
  if (!groupId || !text) return;
  const list = groupChatLog.get(groupId, []);
  list.push({ at: Date.now(), sender: numFromJid(sender), text: String(text).slice(0, 1200) });
  if (list.length > 300) list.splice(0, list.length - 300);
  groupChatLog.set(groupId, list);
}

// sticker-reply cooldown: only auto-reply to stickers once per chat every 3 hours
const stickerCooldown = new Map();
const STICKER_COOLDOWN_MS = 3 * 60 * 60 * 1000;

// Tiny human-style group reactions. Deliberately sparse and rate-limited.
const groupEngagement = new Map();
const GROUP_ENGAGEMENT_COOLDOWN_MS = 4 * 60 * 1000;
const GROUP_EMOJIS = ['😭', '💀', '😐', '🫠', '🎀', '🦋', '🫧', '🤦🏽‍♀️', '😂', '🔥', '👍', '👀'];
function energyEmoji(text) {
  const t = String(text || '').toLowerCase();
  if (/lol|lmao|😂|haha|dead|💀|funny|joke/.test(t)) return '😂';
  if (/fire|lit|hard|goat|🔥|hype|w/.test(t)) return '🔥';
  if (/ok|yes|thanks|thank|good|nice|cool|👍|bet/.test(t)) return '👍';
  if (/sad|cry|😭|miss|hurt/.test(t)) return '😭';
  if (/wtf|bro|bruh|chaos|insane/.test(t)) return '💀';
  if (/love|❤️|cute|pretty/.test(t)) return '❤️';
  if (/\?$/.test(t.trim())) return '👀';
  return null;
}
async function cachedGroupMeta(sock, jid) {
  const hit = groupMetaCache.get(jid);
  if (hit && Date.now() - hit.t < 5000) return hit.meta;
  try {
    const meta = await sock.groupMetadata(jid);
    groupMetaCache.set(jid, { meta, t: Date.now() });
    if (groupMetaCache.size > 200) groupMetaCache.clear();
    return meta;
  } catch (e) {
    logger.warn({ err: e.message }, 'failed to fetch group metadata');
    return hit ? hit.meta : null;
  }
}

function buildMenuText(isOwner = false) {
  const ownerSection = isOwner
    ? '\n\n*Owner controls*\n• `owner menu` — full owner command list\n• `owner status` — check Nick’s status\n• `model` — view or switch the AI provider\n• `private` / `public` — change access mode'
    : '';
  return `╭── ✦ *NICK AI* ✦ ──╮
│ Built by Lord Eagle
╰───────────────────╯

*Talk to me*
Ask a question, search the web, get help writing or coding, or summarize a link. You can also share a photo, document, or voice note and tell me what you need.

*Quick commands*
• \`menu\` / \`help\` / \`commands\` — show this menu
• \`ping\` — check that I’m online

*In groups*
Mention me or start your message with \`Nick\`. Admins can type \`group menu\` for group controls.${ownerSection}`;
}

function makeRouter({ sock, aiClient, senderName }) {
  const sender = require('../whatsapp/sender').makeSender(sock);
  const rawSendText = sender.sendText;
  const { sendAudio, sendFile, sendSticker, sendImage, sendVideo, typing, deleteMessage } = sender;
  // Register every identity WhatsApp exposes for this account. Replies may quote the
  // bot as either its PN or opaque @lid identity.
  autoreply.registerBotJids([
    sock?.user?.id, sock?.user?.lid,
    sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid,
  ].filter(Boolean));
  // Track every bot text message so a user can reply to ANY bot message, not just an AI
  // response. The quoted-message key is kept by autoreply for reliable reply detection.
  async function sendText(jid, text, opts = {}) {
    const sent = await rawSendText(jid, text, opts);
    if (sent?.key) autoreply.addBotMessage(sent.key);
    return sent;
  }

  async function sendGameResult(jid, result, opts = {}) {
    if (!result) return;
    const merged = { ...opts };
    if (result.mentions?.length) merged.mentions = result.mentions;

    // Game media is sent as a real Buffer. This avoids WhatsApp/URL fetching failures.
    if (result.image) {
      try {
        const sent = await sock.sendMessage(jid, {
          image: Buffer.isBuffer(result.image) ? result.image : result.image,
          caption: chatFont.apply(jid, result.text || ''),
          ...(result.mentions?.length ? { mentions: result.mentions } : {}),
        });
        if (sent?.key) autoreply.addBotMessage(sent.key);
      } catch (e) {
        logger.warn({ err: e.message }, 'game image send failed');
        await sendText(jid, result.text || '🖼️ Game image could not be sent.', merged);
      }
      return;
    }

    // Spelling bee / game TTS — always Opus OGG voice note (ptt)
    if (result.ttsText || result.audioUrl) {
      if (result.text) await sendText(jid, result.text, merged);
      try {
        let audioBuf = null;
        let mime = 'audio/ogg; codecs=opus';
        if (result.ttsText) {
          // speak() already returns Opus buffer (young female voice + ffmpeg)
          const speech = await tts.speak(String(result.ttsText), {
            voice: result.ttsVoice || process.env.TTS_VOICE || 'en-US-JennyNeural',
          });
          audioBuf = speech.buffer;
          mime = speech.mimetype || 'audio/ogg; codecs=opus';
          // Fallback convert if somehow still not opus
          if (!audioBuf && speech.file) {
            const voice = await tts.toWhatsAppVoice(speech.file);
            audioBuf = voice.buffer;
            mime = voice.mimetype || mime;
          }
          try { if (speech.file && require('fs').existsSync(speech.file)) require('fs').unlinkSync(speech.file); } catch {}
          try { if (speech.dir) require('fs').rmSync(speech.dir, { recursive: true, force: true }); } catch {}
        }
        if (!audioBuf || !audioBuf.length) {
          throw new Error('TTS produced no opus audio');
        }
        const payload = {
          audio: audioBuf,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
          fileName: 'voice.ogg',
        };
        const sent = await sock.sendMessage(jid, payload);
        if (sent?.key) {
          autoreply.addBotMessage(sent.key);
          if (result.deleteAudioAfterMs) {
            setTimeout(() => {
              sock.sendMessage(jid, { delete: sent.key }).catch(() => {});
            }, result.deleteAudioAfterMs);
          }
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'game audio/tts send failed');
        // Don't spam the chat with engine errors — short human line
        await sendText(jid, "couldnt send the voice note. spelling still on — type your guess.", merged);
      }
      return;
    }

    // Music Guess: send the prompt first, then a real MP3 mystery clip. The answer
    // is deliberately not placed in the filename or external preview metadata.
    if (result.audio) {
      if (result.text) await sendText(jid, result.text, merged);
      try {
        const sent = await sock.sendMessage(jid, {
          audio: Buffer.isBuffer(result.audio) ? result.audio : result.audio,
          mimetype: 'audio/mpeg',
          ptt: false,
          fileName: 'mystery-song.mp3',
        });
        if (sent?.key) autoreply.addBotMessage(sent.key);
      } catch (e) {
        logger.warn({ err: e.message }, 'game audio send failed');
        await sendText(jid, '❌ I fetched the mystery song but WhatsApp could not send the audio. Try the game again.', merged);
      }
      return;
    }

    // Real WhatsApp poll (WYR etc.)
    if (result.poll && result.poll.name && Array.isArray(result.poll.values) && result.poll.values.length >= 2) {
      try {
        const sent = await sock.sendMessage(jid, {
          poll: {
            name: String(result.poll.name).slice(0, 255),
            values: result.poll.values.map((v) => String(v).slice(0, 100)).slice(0, 12),
            selectableCount: result.poll.selectableCount === 0 ? 0 : 1,
          },
        });
        if (sent?.key) autoreply.addBotMessage(sent.key);
        if (result.text) await sendText(jid, result.text, merged);
        return;
      } catch (e) {
        logger.warn({ err: e.message }, 'game poll send failed — falling back to text');
        if (result.text) return sendText(jid, result.text, merged);
        return sendText(jid, `${result.poll.name}\n` + result.poll.values.map((v, i) => `${i + 1}) ${v}`).join('\n'), merged);
      }
    }

    if (result.text !== undefined && result.text !== null) return sendText(jid, result.text, merged);
  }

  async function handleIncoming(msg) {
    // Rate-limit owner error DMs (same signature at most once per 2 min)
    if (!handleIncoming._errCooldown) handleIncoming._errBag = new Map();
    const notifyOwnerError = async (text) => {
      try {
        if ((process.env.ERROR_REPORTS || 'true') === 'false') return; // ON by default — set ERROR_REPORTS=false to silence owner DMs
        const raw = String(text || '');
        // Never spam owner with noise
        if (/Cannot POST \/ai\/qwen|__CF\$cv\$params|challenge-platform|<!DOCTYPE html>|status@broadcast|@newsletter/i.test(raw)) return;
        if (/ECONNREFUSED.*11434|__CF\$cv\$params|challenge-platform/i.test(raw)) return;
        if (/timed out|ETIMEDOUT|socket hang up|rate.?limit|429/i.test(raw)) return;
        const key = raw.replace(/\d+/g, '#').slice(0, 100);
        const now = Date.now();
        if (!handleIncoming._errBag) handleIncoming._errBag = new Map();
        const last = handleIncoming._errBag.get(key) || 0;
        if (now - last < 120000) return; // 2 min dedupe — still report to admin
        handleIncoming._errBag.set(key, now);
        for (const oid of (config.ownerIds || []).slice(0, 2)) {
          const oj = String(oid).includes('@') ? oid : `${oid}@s.whatsapp.net`;
          await sock.sendMessage(oj, { text: raw.slice(0, 500) }).catch(() => {});
        }
      } catch {}
    };
    try {
    try { if (!handleIncoming._bc) { scheduledBroadcast.start(sock); dailyReport.start(sock); handleIncoming._bc = true; } } catch {}

    const jid = msg.key.remoteJid;
    if (!jid || msg.key.fromMe) return;
    if (jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;
    if (String(jid).endsWith('@newsletter')) return; // channels/newsletters are not group chats for the AI
    process._msgCount = (process._msgCount || 0) + 1;
    try {
      dailyReport.bump('messages');
      if (String(msg.key.remoteJid || '').endsWith('@g.us')) dailyReport.bump('groups');
      else dailyReport.bump('dms');
    } catch {}
    
    // Check daemon mode (staff can still talk to re-enable)
    if (!daemons.isDaemonActive()) {
      const earlyElevated = perms.isOwner(msg.key.participant || jid) || perms.isSudo(msg.key.participant || jid) || perms.isAdmin(msg.key.participant || jid);
      if (!earlyElevated) {
        if (!handleIncoming._daemonLogAt || Date.now() - handleIncoming._daemonLogAt > 120000) {
          handleIncoming._daemonLogAt = Date.now();
          logger.warn('daemonMode OFF — silent. Owner: "daemon on" or restart.');
        }
        return;
      }
    }
    
    const isGroup = isGroupJid(jid);
    const senderJid = isGroup ? msg.key.participant : jid;
    if (!senderJid) return;
    const preJidMap = jidResolver.buildMap(sock, msg, null);
    let actorJid = jidResolver.resolve(senderJid, preJidMap);

    // Remember the sender's WhatsApp display name so we can address them by name/number
    // instead of raw jid/lid later (the number-only fallback resolves once group metadata
    // — needed to unmask @lid ids — is fetched further down).
    if (msg.pushName) names.rememberPush(senderJid, msg.pushName);
    
    // Elevate early using every identity we already have (PN + raw participant).
    // Full LID→PN resolution happens later with group metadata; re-check there too.
    let senderIsOwner = perms.isOwner(actorJid) || perms.isOwner(senderJid);
    let senderIsElevated = senderIsOwner || perms.isSudo(actorJid) || perms.isSudo(senderJid)
      || perms.isAdmin(actorJid) || perms.isAdmin(senderJid);

    // Access control:
    // - PUBLIC mode: every non-blocked chat member can talk to the bot (no owner-only filter)
    // - PRIVATE/lockdown: only owner/sudo/admin
    // Staff always pass so the bot is never invisible to them.
    if (!senderIsElevated) {
      if (obsidian.isGlobalPrivate()) {
        if (!handleIncoming._privLogAt || Date.now() - handleIncoming._privLogAt > 60000) {
          handleIncoming._privLogAt = Date.now();
          logger.info({ mode: obsidian.getGlobalMode() }, 'private/lockdown ON — dropping non-staff (say "public" as owner to open)');
        }
        return;
      }
      if (obsidian.chatBlocked(jid)) {
        logger.info({ jid }, 'chat ignored by owner');
        return;
      }
      const scope = obsidian.getResponseScope();
      if (scope === 'groups' && !isGroup) return;
      if (scope === 'dms' && isGroup) return;
    } else {
      logger.debug({ sender: String(senderJid).slice(0, 40) }, 'staff message allowed');
    }

    // Check group mode
    if (isGroup && !daemons.isGroupModeActive() && !senderIsElevated) {
      if (!handleIncoming._gmodeLogAt || Date.now() - handleIncoming._gmodeLogAt > 120000) {
        handleIncoming._gmodeLogAt = Date.now();
        logger.warn('groupMode OFF — ignoring groups. Owner: enable group mode.');
      }
      return;
    }

    // Curfew / legacy DM restriction.
    if (!isGroup && !senderIsElevated && obsidian.dmBlocked(senderJid)) {
      return;
    }
    
    // WhatsApp may wrap the real message inside ephemeral/view-once/edit wrappers.
    // Always unwrap before looking for text, mentions, quoted media, or documents.
    function unwrapMessage(message) {
      let cur = message;
      for (let i = 0; i < 5 && cur; i++) {
        if (cur.ephemeralMessage?.message) { cur = cur.ephemeralMessage.message; continue; }
        if (cur.viewOnceMessageV2?.message) { cur = cur.viewOnceMessageV2.message; continue; }
        if (cur.viewOnceMessage?.message) { cur = cur.viewOnceMessage.message; continue; }
        if (cur.documentWithCaptionMessage?.message) { cur = cur.documentWithCaptionMessage.message; continue; }
        if (cur.editedMessage?.message) { cur = cur.editedMessage.message; continue; }
        break;
      }
      return cur;
    }
    const mt = unwrapMessage(msg.message);
    if (!mt) {
      // Common when Baileys failed to decrypt (SessionError) — message key arrives, body is empty.
      if (msg.messageStubType || msg.key?.id) {
        logger.debug({ id: msg.key?.id, remote: jid, stub: msg.messageStubType }, 'skip: empty message body (possible decrypt failure)');
      }
      return;
    }
    
    // Track bot's sent messages for auto-reply
    if (msg.key.fromMe) {
      autoreply.addBotMessage(msg.key);
    }

    // --- stickers ---
    // Save every sticker. A sticker that is a direct reply to one of our messages is
    // treated as a real conversation turn and is never blocked by the random-sticker
    // cooldown. It gets a quoted response (sticker or text) so WhatsApp shows the
    // normal reply card.
    if (mt.stickerMessage) {
      try {
        const stickerCtx = mt.stickerMessage?.contextInfo || {};
        const quotedId = stickerCtx.stanzaId || stickerCtx.quotedMessageId;
        const isReplyToBot = !!quotedId && autoreply.isBotMessageReplied(msg);
        if (isReplyToBot) {
          const meta = isGroup ? await cachedGroupMeta(sock, jid) : null;
          const identity = jidResolver.resolveIdentity(senderJid, jidResolver.buildMap(sock, msg, meta), meta);
          const memoryUserId = identity.phoneNumber || numFromJid(senderJid);
          if (memoryUserId) memory.ensureScoped(jid, memoryUserId);
        }

        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        stickers.saveSticker(buffer, { chatId: jid, senderId: numFromJid(senderJid) });
        const reply = ['😂 I see you!', 'Haha, nice one 😭', 'That sticker says enough 😂', '🤣🤣', 'I got you 😎'];

        // Stickers are a special, lightweight exception to the group AI gate.
        // They NEVER wake the AI by themselves. Instead, occasionally react with
        // a sticker/text just like a human might. Direct replies to the bot get a
        // higher chance; ordinary group stickers stay mostly quiet.
        const now = Date.now();
        const lastStickerReply = stickerCooldown.get(jid) || 0;
        const cooldownReady = now - lastStickerReply >= STICKER_COOLDOWN_MS;
        const chance = isReplyToBot ? 0.75 : (isGroup ? config.stickers.replyToStickerChance : 0.45);
        const shouldReact = cooldownReady && Math.random() < Math.max(0, Math.min(1, chance));

        if (shouldReact) {
          stickerCooldown.set(jid, now);
          const back = stickers.getRandom();
          if (back && Math.random() < 0.85) {
            await sendSticker(jid, back, { quoted: msg });
          } else {
            await sendText(jid, reply[Math.floor(Math.random() * reply.length)], { quoted: msg });
          }
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'failed to handle incoming sticker');
      }
      return;
    }

    // A "group status mention" is the special message WhatsApp posts into a group when
    // someone mentions/tags that group in their own Status update — not a normal text message.
    const isGroupStatusMention = isGroupStatusMentionMessage(mt);
    const isGroupStatus = isGroupStatusPost(msg, mt) || isGroupStatusMention;
    const hasImage = !!mt.imageMessage;
    const hasMedia = hasImage || !!mt.videoMessage || !!mt.audioMessage;

    const rawText = (mt.conversation || mt.extendedTextMessage?.text || mt.imageMessage?.caption || mt.videoMessage?.caption || '').trim();
    if (isGroup && rawText) logGroupMessage(jid, senderJid, rawText);
    const contactPhones = phonesFromMessageType(mt);
    if (!rawText && !isGroupStatusMention && !hasMedia && !contactPhones.length) return;

    // contextInfo is used by the viewonce reveal (below) AND the zip-fix section later
    const ctxInfoDoc = mt.extendedTextMessage?.contextInfo;

    // Preserve the actual message being replied to. A tagged reply often contains only
    // the user's short instruction; the quoted text is the missing context the AI needs.
    function unwrapQuoted(message) {
      let cur = message;
      for (let i = 0; i < 6 && cur; i++) {
        const next = cur.message || cur.ephemeralMessage?.message || cur.viewOnceMessageV2?.message || cur.viewOnceMessage?.message || cur.documentWithCaptionMessage?.message || cur.editedMessage?.message;
        if (next && next !== cur) { cur = next; continue; }
        break;
      }
      return cur || {};
    }
    function extractTextFromMessage(message) {
      if (!message) return '';
      const m = unwrapQuoted(message);
      return String(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '').trim();
    }
    const quotedMessage = ctxInfoDoc?.quotedMessage || null;
    const quotedUnwrapped = unwrapQuoted(quotedMessage);
    const quotedText = extractTextFromMessage(quotedMessage);
    const quotedContext =
      ctxInfoDoc ||
      quotedMessage?.extendedTextMessage?.contextInfo ||
      quotedMessage?.imageMessage?.contextInfo ||
      quotedMessage?.videoMessage?.contextInfo ||
      quotedMessage?.audioMessage?.contextInfo ||
      quotedMessage?.stickerMessage?.contextInfo ||
      quotedUnwrapped?.extendedTextMessage?.contextInfo ||
      quotedUnwrapped?.imageMessage?.contextInfo ||
      quotedUnwrapped?.videoMessage?.contextInfo ||
      quotedUnwrapped?.audioMessage?.contextInfo ||
      quotedUnwrapped?.stickerMessage?.contextInfo ||
      quotedUnwrapped?.contextInfo ||
      null;
    const quotedParticipantRaw = quotedContext?.participant || quotedContext?.participantPn || quotedContext?.participantAlt || null;
    const quotedParticipantPnRaw = quotedContext?.participantPn || quotedContext?.participantAlt || null;
    const quotedMessageId = quotedContext?.stanzaId || quotedContext?.quotedMessageId || null;

    // --- open quoted document / text file (NOT view-once) ---
    const quotedDoc = quotedUnwrapped?.documentMessage || quotedMessage?.documentMessage
      || quotedUnwrapped?.documentWithCaptionMessage?.message?.documentMessage;
    const wantsOpenFile = !!quotedDoc && /\b(open|read|paste|show|extract|print)\b/i.test(rawText || '')
      && /\b(file|text|txt|document|doc|content|lyrics|paste)\b/i.test(rawText || '');
    if (wantsOpenFile) {
      try {
        const { downloadMediaMessage } = require('@lordeagle21/baileys');
        const payloadMsg = {
          key: { remoteJid: jid, id: ctxInfoDoc?.stanzaId, participant: ctxInfoDoc?.participant, fromMe: false },
          message: { documentMessage: quotedDoc },
        };
        const buf = await downloadMediaMessage(payloadMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        const mime = String(quotedDoc.mimetype || '');
        const name = String(quotedDoc.fileName || 'file.txt');
        let textOut = '';
        if (/text|json|xml|javascript|csv|markdown|plain/i.test(mime) || /\.(txt|md|json|csv|js|ts|html|css|log|xml)$/i.test(name)) {
          textOut = buf.toString('utf8');
        } else {
          // best-effort utf8 for unknown small files
          textOut = buf.toString('utf8');
          if (/[\x00-\x08\x0e-\x1f]/.test(textOut.slice(0, 200))) {
            return sendText(jid, `📄 That file (*${name}*) is not plain text (${mime || 'binary'}). I can only paste text files here.`);
          }
        }
        textOut = textOut.replace(/\r\n/g, '\n').trim();
        if (!textOut) return sendText(jid, '📄 File was empty.');
        // Cap to WhatsApp-friendly size; split via sendText chunking
        const header = `📄 *${name}*\n\n`;
        await sendText(jid, header + textOut.slice(0, 35000));
        return;
      } catch (e) {
        logger.warn({ err: e.message }, 'open file failed');
        return sendText(jid, `Couldn't open that file: ${e.message}`);
      }
    }

    // --- view-once unlock: ONLY when quoted message is actually view-once ---
    const voQuoted = ctxInfoDoc?.quotedMessage?.viewOnceMessageV2
      || ctxInfoDoc?.quotedMessage?.viewOnceMessage
      || ctxInfoDoc?.quotedMessage?.viewOnceMessageV2Extension
      || quotedUnwrapped?.viewOnceMessageV2
      || quotedUnwrapped?.viewOnceMessage;
    const wantsViewOnce = !!voQuoted
      && /\b(open|unlock|reveal|view\s*once|show|send\s+(it\s+)?(to\s+)?me|dm\s+me|to\s+dm)\b/i.test(rawText || '');
    if (wantsViewOnce) {
      try {
        const quotedRoot = ctxInfoDoc?.quotedMessage || {};
        const voNode = quotedRoot.viewOnceMessageV2 || quotedRoot.viewOnceMessage || quotedRoot.viewOnceMessageV2Extension || quotedRoot;
        const voInner = voNode?.message || quotedUnwrapped?.viewOnceMessageV2?.message || quotedUnwrapped?.viewOnceMessage?.message || voNode || {};
        const voMsg = {
          key: { remoteJid: jid, id: ctxInfoDoc?.stanzaId, participant: ctxInfoDoc?.participant, fromMe: false },
          message: voInner.imageMessage || voInner.videoMessage || voInner.audioMessage ? voInner : voNode,
        };
        const mediaNode = voInner.imageMessage || voInner.videoMessage || voInner.audioMessage
          ? voInner
          : (voInner.message || voInner);
        const hasImg = !!(mediaNode.imageMessage || voInner.imageMessage);
        const hasVid = !!(mediaNode.videoMessage || voInner.videoMessage);
        const hasAud = !!(mediaNode.audioMessage || voInner.audioMessage);
        if (!hasImg && !hasVid && !hasAud) {
          // Silent skip — was not a media view-once; do not spam the chat
          logger.info('view-once quote had no media — ignoring');
          // fall through to normal handling instead of error
        } else {
        const payloadMsg = {
          key: voMsg.key,
          message: hasImg ? { imageMessage: mediaNode.imageMessage || voInner.imageMessage }
            : hasVid ? { videoMessage: mediaNode.videoMessage || voInner.videoMessage }
            : { audioMessage: mediaNode.audioMessage || voInner.audioMessage },
        };
        const buf = await downloadMediaMessage(payloadMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        const toDm = /\b(dm\s+me|send\s+(it\s+)?to\s+me|to\s+dm)\b/i.test(rawText || '');
        let dest = jid;
        if (toDm) {
          const pn = resolvedSenderJid || senderJid;
          dest = String(pn).endsWith('@s.whatsapp.net') ? pn : `${numFromJid(pn)}@s.whatsapp.net`;
        }
        if (hasImg) await sock.sendMessage(dest, { image: buf, caption: toDm ? '' : undefined });
        else if (hasVid) await sock.sendMessage(dest, { video: buf, mimetype: (mediaNode.videoMessage || voInner.videoMessage)?.mimetype || 'video/mp4' });
        else await sock.sendMessage(dest, { audio: buf, mimetype: (mediaNode.audioMessage || voInner.audioMessage)?.mimetype || 'audio/ogg; codecs=opus', ptt: true });
        if (toDm && isGroup) await sendText(jid, 'Sent it to your DM.');
        return;
        } // end else has media
      } catch (e) {
        logger.warn({ err: e.message }, 'viewonce reveal failed');
        // don't spam chat on false positives
      }
    }
    
    // --- Deterministic bot-history deletion (groups + DMs) ---
    // "delete all this text you sent", "delete your messages", "clear error reports", etc.
    const deleteMineRe = /^(?:broken\s+)?(?:please\s+)?(?:delete|remove|clear)\s+(?:all\s+)?(?:this\s+)?(?:text\s+)?(?:you\s+)?(?:sent\s+)?(?:your\s+)?(?:the\s+)?(?:bot(?:'s|s)?\s+)?(?:error\s+)?(?:messages?|reports?|spam)?\s*$/i
      || /^(?:broken\s+)?delete\s+(?:all|every)\s+(?:my|your|its|the\s+bot(?:'s|s)?)\s+messages?\s*$/i
      || /^(?:broken\s+)?(?:delete|clear)\s+(?:all\s+)?(?:your\s+)?(?:error\s+)?(?:reports?|messages?)\s*$/i;
    if (rawText && (
      /^(?:broken\s+)?delete\s+(?:all|every)\s+(?:my|your|its|the\s+bot(?:'s|s)?)\s+messages?\s*$/i.test(rawText)
      || /^(?:broken\s+)?(?:please\s+)?(?:delete|remove|clear)\s+(?:all\s+)?(?:this\s+)?(?:text\s+)?you\s+sent\b/i.test(rawText)
      || /^(?:broken\s+)?(?:please\s+)?(?:delete|clear)\s+(?:all\s+)?(?:your\s+)?(?:error\s+)?(?:reports?|messages?)\s*$/i.test(rawText)
      || /^(?:broken\s+)?(?:delete|clear)\s+your\s+messages?\s*$/i.test(rawText)
    )) {
      if (isGroup) {
        const meta = await cachedGroupMeta(sock, jid);
        const aliases = [senderJid, actorJid, msg.key?.participantAlt, msg.key?.participantPn].filter(Boolean);
        if (!(perms.isOwner(actorJid) || perms.isGroupAdmin(actorJid, meta, aliases))) {
          return sendText(jid, 'Only a group admin or the owner can clear my messages here.');
        }
      }
      const keys = messageTracker.list(jid);
      if (!keys.length) {
        return sendText(jid, "I don't have any tracked messages in this chat to delete (only ones sent after tracking started).");
      }
      let deleted = 0, failed = 0;
      const failedIds = new Set();
      for (const key of keys.slice().reverse()) {
        try {
          await sock.sendMessage(jid, { delete: { remoteJid: jid, id: key.id, fromMe: true } });
          deleted++;
          await new Promise(r => setTimeout(r, 150));
        } catch (e) {
          failed++;
          failedIds.add(key.id);
        }
      }
      if (deleted) messageTracker.remove(jid, keys.filter(k => !failedIds.has(k.id)).map(k => k.id));
      return sendText(jid, deleted
        ? `🧹 Deleted ${deleted} of my message(s)${failed ? ` (${failed} failed — too old or not found)` : ''}.`
        : `Couldn't delete those messages (${failed} failed). WhatsApp may block deletes on older messages.`);
    }

    // --- Handle delete command ---
    if (rawText && deletehandler.isDeleteCommand(rawText)) {
      const quotedRaw = quotedParticipantRaw || '';
      const botIds = [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid].filter(Boolean);
      const quotedLooksLikeBot = !!ctxInfoDoc?.stanzaId && (
        !!ctxInfoDoc?.quotedMessage?.key?.fromMe ||
        botIds.some(id => String(id) === String(quotedRaw)) ||
        autoreply.isBotMessageReplied(msg)
      );
      if (isGroup && !quotedLooksLikeBot) {
        const meta = await cachedGroupMeta(sock, jid);
        const botAliases = new Set(botIds);
        for (const id of botIds) {
          const identity = jidResolver.resolveIdentity(id, jidResolver.buildMap(sock, msg, meta), meta);
          for (const a of identity.aliases || []) botAliases.add(a);
          if (identity.jid) botAliases.add(identity.jid);
        }
        if (!perms.botIsGroupAdmin(botIds[0], meta, [...botAliases])) {
          return sendText(jid, "⚠️ I need to be a group admin to delete another member's message.");
        }
      }
      const result = await deletehandler.handleDelete(sock, msg, deleteMessage);
      return sendText(jid, result.message);
    }

    
    // Follow-up about last zip fix (do NOT re-run fixer)
    if (rawText && /\\b(what did you fix|what was fixed|what.?s in (the|that) zip|what is in (the|that) zip|explain the fix|which files|what changed)\\b/i.test(rawText)) {
      const mem = zipMemory.get(jid);
      if (mem && mem.type === 'fix') {
        return sendText(jid,
          `📦 *Last zip fix in this chat*\n` +
          `File: ${mem.fileName}\n` +
          `Changed:\n• ${(mem.changed || ['(none)']).join('\\n• ')}\n` +
          `${mem.verified ? '✅ Verification passed' : '⚠️ Verification had warnings'}\n` +
          (mem.complaint ? `Request: ${mem.complaint}\\n` : '') +
          `\\nAsk something specific about those files, or send/reply to a zip with *fix ...* to run another fix.`
        );
      }
      if (mem && mem.type === 'analysis') {
        return sendText(jid, `📦 Last zip looked at: *${mem.fileName}*\\n${mem.summary || ''}\\nFiles: ${(mem.tree||[]).slice(0,20).join(', ')}`);
      }
    }

    // --- Fix-my-zip: user replies to a .zip with a complaint ("fix this", "it errors") ---
    const quotedZipDoc = ctxInfoDoc?.quotedMessage?.documentMessage;
    if (quotedZipDoc && /\.zip$/i.test(quotedZipDoc.fileName || '')) {
      const isQuestion = /\?\s*$|^(what|why|how|which|where|who|did you|can you tell|explain|show me|list)\b/i.test(rawText.trim());
      const wantsFix = !isQuestion && /\b(fix|repair|debug|patch)\b|\b(not working|broken|crashes?|bug[s]?)\b/i.test(rawText)
        && !/\b(what did you|what was|what is in|what's in|whats in|did you fix|explain the fix|tell me what)\b/i.test(rawText);
      if (wantsFix) {
        await typing(jid, true);
        await sendText(jid, '🔧 Let me look at that zip...');
        try {
          const quotedMsg = {
            key: { remoteJid: jid, id: ctxInfoDoc.stanzaId, participant: ctxInfoDoc.participant, fromMe: false },
            message: ctxInfoDoc.quotedMessage,
          };
          const buf = await downloadMediaMessage(quotedMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const complaint = rawText.replace(/^(fix|please fix|it has|the |this |zip )/i, '').trim() || 'the project has an error, find and fix it';
          const res = await fixer.fixZip(buf, complaint, aiClient);
          if (!res.ok) return sendText(jid, `❌ ${res.error}`);
          if (res.noChanges) return sendText(jid, res.message);
          const fixedFile = fs.readFileSync(res.zipPath);
          await sock.sendMessage(jid, { document: fixedFile, mimetype: 'application/zip', fileName: `fixed-${path.basename(res.zipPath)}`, caption: chatFont.apply(jid, `🔧 Fixed. Changed: ${res.changed.join(', ')}`) });
          try {
            zipMemory.rememberFix(jid, {
              changed: res.changed,
              verified: res.verified,
              message: res.message,
              complaint,
              fileName: quotedZipDoc.fileName || 'project.zip',
              summary: `Fixed ${ (res.changed||[]).length } files: ${(res.changed||[]).join(', ')}`,
            });
          } catch {}
          return;
        } catch (e) {
          logger.warn({ err: e.message }, 'zip fix failed');
          return sendText(jid, `❌ Couldn't process that zip: ${e.message}`);
        }
      }
    }
    
    // --- Handle daemon toggle commands ---
    if (perms.isOwner(actorJid)) {
      
    // Owner storage cleanup: clear stickers / builds / fixes / temp / all / status
    if (perms.isOwner(actorJid) && rawText && /^(?:broken\s+)?(?:clear|delete|purge|cleanup|clean)\s+(?:all\s+)?(?:saved\s+)?(?:stickers?|builds?|build\s+zips?|fixes?|fix\s+zips?|temp|tmp|downloads?|storage|everything)\b/i.test(rawText)
      || (perms.isOwner(actorJid) && /^(?:broken\s+)?(?:storage\s+)?(?:status|stats)\s*$/i.test(rawText))
      || (perms.isOwner(actorJid) && /^(?:broken\s+)?cleanup\s+(?:status|stickers?|builds?|fixes?|temp|all)\s*$/i.test(rawText))) {
      const rt = rawText.toLowerCase();
      if (/status|stats/.test(rt) && !/clear|delete|purge|cleanup|clean/.test(rt)) {
        const s = ownerCleanup.status();
        await sendText(jid, `📂 *Storage status*\n• Stickers: ${s.stickers.count} (${ownerCleanup.fmtBytes(s.stickers.bytes)})\n• Build zips: ${s.builds.files} files (${ownerCleanup.fmtBytes(s.builds.bytes)})\n• Fix zips: ${s.fixes.files} files (${ownerCleanup.fmtBytes(s.fixes.bytes)})\n\nOwner commands:\n• clear stickers\n• clear builds\n• clear fixes\n• clear temp\n• clear storage / clear everything`);
        return;
      }
      const opts = { all: false, stickers: false, builds: false, fixes: false, temp: false };
      if (/\b(everything|storage|all)\b/.test(rt)) opts.all = true;
      else {
        if (/sticker/.test(rt)) opts.stickers = true;
        if (/build/.test(rt)) opts.builds = true;
        if (/fix/.test(rt)) opts.fixes = true;
        if (/temp|tmp|download/.test(rt)) opts.temp = true;
      }
      if (!opts.all && !opts.stickers && !opts.builds && !opts.fixes && !opts.temp) {
        await sendText(jid, 'Specify: clear stickers | clear builds | clear fixes | clear temp | clear everything');
        return;
      }
      const res = ownerCleanup.cleanup(opts);
      await sendText(jid, res.ok ? `🧹 ${res.human}` : `⚠️ ${res.error}`);
      return;
    }

if (/^(self[- ]?fix|fix yourself|health check)$/i.test(rawText) && perms.isOwner(actorJid)) {
        await sendText(jid, '🛠️ Running self-check…');
        const res = await selfheal.repair(aiClient, rawText);
        if (res.ok && res.repaired) return sendText(jid, `✅ Self-repair complete. Fixed: ${res.changed.join(', ')}`);
        if (res.ok) return sendText(jid, `✅ Self-check passed. No repair needed.`);
        return sendText(jid, `⚠️ Self-repair could not safely complete. Backup: ${res.backupDir || 'none'}`);
      }
      if (/^\.broken\s*(?:dmon|dmoff|groupon|groupoff)$/i.test(rawText) && !senderIsOwner) {
        await sendText(jid, '👑 Owner only.');
        return;
      }
      if (/^\.broken\s*dmon$/i.test(rawText)) {
        daemons.toggleDaemon(true);
        await sendText(jid, '✅ Daemon mode ON — I will respond to messages.');
        return;
      }
      if (/^\.broken\s*dmoff$/i.test(rawText)) {
        daemons.toggleDaemon(false);
        await sendText(jid, '⏸️ Daemon mode OFF — I will ignore all messages.');
        return;
      }
      if (/^\.broken\s*groupon$/i.test(rawText)) {
        daemons.toggleGroup(true);
        await sendText(jid, '✅ Group mode ON — I will respond in groups.');
        return;
      }
      if (/^\.broken\s*groupoff$/i.test(rawText)) {
        daemons.toggleGroup(false);
        await sendText(jid, '⏸️ Group mode OFF — I will ignore group messages.');
        return;
      }
    }

    // --- Deterministic WhatsApp poll command ---
    // Poll creation is handled before the LLM so a request such as
    // `poll: Question | Option A | Option B` can never be mistaken for a
    // normal text response. This sends an actual WhatsApp poll message.
    if (rawText && /^(?:poll|make\s+(?:a\s+)?poll)\s*:/i.test(rawText)) {
      const body = rawText.replace(/^(?:poll|make\s+(?:a\s+)?poll)\s*:/i, '').trim();
      const parts = body.split(/\s*\|\s*/).map(x => x.trim()).filter(Boolean);
      const question = parts.shift() || '';
      const multi = /(?:\s|^)multi(?:ple)?\s*[- ]?select(?:\s|$)/i.test(question);
      const cleanQuestion = question.replace(/\s*\(?multi(?:ple)?\s*[- ]?select\)?\s*$/i, '').trim();
      const options = [...new Set(parts)].slice(0, 12);
      if (!cleanQuestion || options.length < 2) {
        await sendText(jid, '🗳️ Poll format: `poll: Your question | Option 1 | Option 2 | Option 3`');
        return;
      }
      try {
        const sent = await sock.sendMessage(jid, {
          poll: {
            name: cleanQuestion,
            values: options,
            selectableCount: multi ? 0 : 1,
            toAnnouncementGroup: false,
          },
        });
        logger.info({ jid, pollId: sent?.key?.id, options: options.length, multi }, 'WhatsApp poll sent');
        await sendText(jid, `✅ Poll created: *${cleanQuestion}*`);
      } catch (e) {
        logger.error({ jid, err: e.message, stack: e.stack }, 'WhatsApp poll creation failed');
        await sendText(jid, `❌ WhatsApp poll failed: ${e.message}`);
      }
      return;
    }

    const mentions =
      mt.extendedTextMessage?.contextInfo?.mentionedJid ||
      mt.imageMessage?.contextInfo?.mentionedJid ||
      mt.videoMessage?.contextInfo?.mentionedJid ||
      [];

    let groupMeta = null;
    if (isGroup) {
      groupMeta = await cachedGroupMeta(sock, jid);
    }

    // WhatsApp LID/PN normalization: resolve the real phone number whenever WhatsApp
    // supplied a mapping. This is critical for @mentions, XP, roles and moderation.
    const jidMap = jidResolver.buildMap(sock, msg, groupMeta);
    // Learn/resolve LID mappings from Baileys' persistent mapping store when available.
    // This is async because getPNForLID is async in Baileys 6.7.x.
    if (jidResolver.isLid(senderJid)) {
      const resolvedFromSock = await jidResolver.resolveWithSock(senderJid, sock, jidMap, groupMeta);
      if (resolvedFromSock && !jidResolver.isLid(resolvedFromSock)) actorJid = resolvedFromSock;
    }
    const senderIdentity = jidResolver.resolveIdentity(senderJid, jidMap, groupMeta);
    const resolvedSenderJid = senderIdentity.jid || jidResolver.resolve(senderJid, jidMap);
    // Keep every identity WhatsApp gave us. Admin checks must not depend on a LID -> PN
    // conversion being present in one particular metadata field.
    const senderIdentityAliases = [...new Set([
      senderJid,
      resolvedSenderJid,
      msg.key?.participantAlt,
      msg.key?.participantPn,
      msg.key?.senderLid,
      msg.key?.senderPn,
      ...(senderIdentity.aliases || []),
    ].filter(Boolean))];
    actorJid = resolvedSenderJid;

    // Re-evaluate owner/sudo/admin with fully resolved PN + all aliases (LID-safe).
    const ownerCandidates = [
      actorJid, senderJid, resolvedSenderJid,
      senderIdentity?.phoneNumber, senderIdentity?.jid,
      ...(senderIdentityAliases || []),
    ].filter(Boolean);
    senderIsOwner = ownerCandidates.some((id) => perms.isOwner(id));
    senderIsElevated = senderIsOwner
      || ownerCandidates.some((id) => perms.isSudo(id) || perms.isAdmin(id));
    if (senderIsOwner && !(handleIncoming._ownerLogAt > Date.now() - 300000)) {
      handleIncoming._ownerLogAt = Date.now();
      try { logger.info({ candidates: ownerCandidates.map((x) => String(x).slice(0, 24)), owners: (config.ownerIds || []).slice(0, 6) }, 'owner match OK'); } catch {}
    }
    // Deterministic group moderation runs before the AI/address gate.
    // Admin/owner messages are exempt; violations are deleted silently.
    if (isGroup && rawText && groupMeta) {
      try {
        const moderation = require('../features/moderation');
        const groupAdmin = perms.isGroupAdmin(actorJid, groupMeta, senderIdentityAliases);
        const reason = groupAdmin || senderIsElevated
          ? null
          : moderation.checkMessage(jid, rawText, Array.isArray(mentions) ? mentions.length : 0);
        if (reason) {
          const botIds = [...new Set([...(selfNums || []), sock?.user?.id, sock?.user?.lid,
            sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid].filter(Boolean))];
          if (perms.botIsGroupAdmin(botIds[0], groupMeta, botIds)) {
            try {
              await sock.sendMessage(jid, { delete: {
                remoteJid: jid,
                id: msg.key.id,
                fromMe: !!msg.key.fromMe,
                participant: msg.key.participant,
              }});
              logger.info({ jid, sender: String(actorJid).slice(0, 40), reason }, 'silent group moderation delete');
            } catch (e) {
              logger.warn({ jid, reason, err: e.message }, 'group moderation delete failed');
            }
          }
          return;
        }
      } catch (e) {
        logger.warn({ jid, err: e.message }, 'group moderation check failed');
      }
    }

    if (!senderIsElevated && obsidian.isGlobalPrivate()) {
      logger.info({ jid, actor: String(actorJid).slice(0, 40), mode: obsidian.getGlobalMode() }, 'private after LID resolve: drop');
      return;
    }
    // Public only widens *who* may talk to the bot; engagement still needs a tag/name/reply.

    // Stable memory identity: prefer the real phone-number identity resolved from a LID.
    // This keeps the same person's memory together while preventing different group
    // members from sharing one chat-wide conversation history.
    const memoryUserId = (senderIdentity.phoneNumber || jidResolver.number(senderJid, jidMap) || numFromJid(resolvedSenderJid || senderJid) || resolvedSenderJid || senderJid);
    const memoryScope = `${jid}::${memoryUserId}`;

    // Soft anti-spam: high score messages from non-staff are dropped quietly
    if (isGroup && !senderIsElevated && rawText) {
      try {
        const sp = spamScore.note(jid, resolvedSenderJid || senderJid, rawText);
        if (spamScore.isSpam(jid, resolvedSenderJid || senderJid, 75)) {
          logger.info({ jid, score: sp.score }, 'spam score drop');
          return;
        }
      } catch {}
    }

    senderIdentity.name = msg.pushName || '';
    memory.rememberIdentity(memoryUserId, senderIdentity);
    // Resolve @mentions through Baileys LID→phone mapping so DMs/admin tools get real numbers
    const resolvedMentions = await jidResolver.normalizeManyWithSock(mentions, sock, jidMap, groupMeta);
    const selfNums = jidResolver.selfIds(sock, jidMap);
    // Keep raw PN/LID identities registered for participant-based reply detection.
    autoreply.registerBotJids([...selfNums]);

    // Resolve who the user replied to (quoted message author) — must exist for toolCtx.
    let quotedParticipant = null;
    if (quotedParticipantRaw) {
      quotedParticipant = jidResolver.resolve(quotedParticipantRaw, jidMap) || quotedParticipantRaw;
      try {
        if (typeof jidResolver.isLid === 'function' && jidResolver.isLid(quotedParticipantRaw)) {
          const r = await jidResolver.resolveWithSock(quotedParticipantRaw, sock, jidMap, groupMeta);
          if (r && !(typeof jidResolver.isLid === 'function' && jidResolver.isLid(r))) quotedParticipant = r;
        }
      } catch {}
      if (quotedParticipantPnRaw) {
        const pn = jidResolver.resolve(quotedParticipantPnRaw, jidMap) || quotedParticipantPnRaw;
        if (pn && !(typeof jidResolver.isLid === 'function' && jidResolver.isLid(pn))) {
          quotedParticipant = pn;
        }
      }
    }

    // Display label for @-mentions in bot text: name + real number, not raw jid/lid.
    const who = names.displayLabel(resolvedSenderJid, isGroup ? jid : null, groupMeta);

    // Sparse human-style group presence. This never wakes the AI.
    if (isGroup && !senderIsElevated && rawText && !isGroupStatus) {
      try {
        const now = Date.now();
        const last = groupEngagement.get(jid) || 0;
        if (now - last >= GROUP_ENGAGEMENT_COOLDOWN_MS && Math.random() < 0.055) {
          groupEngagement.set(jid, now);
          const roll = Math.random();
          if (roll < 0.38) {
            await sendText(jid, GROUP_EMOJIS[Math.floor(Math.random() * GROUP_EMOJIS.length)]);
          } else if (roll < 0.72) {
            const emoji = ['😭', '💀', '😐', '😂', '🫠'][Math.floor(Math.random() * 5)];
            await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
          } else {
            const back = stickers.getRandom();
            if (back) await sendSticker(jid, back, { quoted: msg });
            else await sendText(jid, GROUP_EMOJIS[Math.floor(Math.random() * GROUP_EMOJIS.length)]);
          }
        }
      } catch (e) {
        logger.debug({ err: e.message }, 'group engagement skipped');
      }
    }



    // --- anti-spam: ignore the same message repeated 3+ times in quick succession ---
    if (rawText) {
      const spamKey = `${jid}:${numFromJid(senderJid)}:${rawText.slice(0, 60)}`;
      const now = Date.now();
      const prev = spam.get(spamKey);
      if (prev && now - prev.ts < 15000) {
        prev.count++;
        prev.ts = now;
        if (prev.count >= 3) return; // block repeated spam
      } else {
        spam.set(spamKey, { count: 1, ts: now });
      }
      if (spam.size > 500) spam.clear();
    }
    // DMs are direct conversations; groups are gated by isAddressed below.

    // --- Engagement + clean text (must exist before any cleanText / isAddressed use) ---
    const botNameList = (config.behavior && config.behavior.botNames) || ['broken'];
    const selfIdSet = new Set(
      [...(selfNums || []), sock?.user?.id, sock?.user?.lid, sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid]
        .filter(Boolean)
        .map((id) => String(id).split(':')[0].split('@')[0])
    );
    const mentionedBot = (mentions || []).some((m) => {
      const n = String(m || '').split(':')[0].split('@')[0];
      return selfIdSet.has(n) || selfNums?.includes?.(m);
    });
    const repliedToBot = (() => {
      try { return autoreply.isBotMessageReplied(msg); } catch { return false; }
    })();
    const namedBot = botNameList.some((n) => {
      if (!n || !rawText) return false;
      const name = String(n).trim();
      if (!name) return false;
      // ONLY treat as address when the bot name starts the message (or after hey/hi/@).
      // Do NOT match "my phone is broken" mid-sentence — that caused random group replies.
      try {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(
          `^(?:@)?(?:hey\\s+|hi\\s+|yo\\s+|oi\\s+|please\\s+)?${esc}\\b`,
          'i'
        ).test(String(rawText).trim());
      } catch {
        const t = String(rawText).trim().toLowerCase();
        const nl = name.toLowerCase();
        return t === nl || t.startsWith(nl + ' ') || t.startsWith('@' + nl);
      }
    });
    // HARD rule: groups only respond when @mentioned, reply-to-bot, or bot name starts the message.
    // Owners are never auto-addressed for normal chat (that caused hopping on every message).
    const requireAddress = true;
    // A run of consecutive messages counts as being addressed, so a user who
    // sends three quick lines gets one reply that understands all three,
    // instead of silence or three separate answers.
    const groupStreakAddressed = isGroup && !senderIsElevated
      ? noteGroupStreak(jid, resolvedSenderJid || senderJid)
      : false;

    // Strip leading bot name / @mention noise so commands match cleanly.
    let cleanText = String(rawText || '');
    for (const n of botNameList) {
      if (!n) continue;
      try {
        cleanText = cleanText.replace(new RegExp(`^[@]?${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,:;\\s-]*`, 'i'), '');
      } catch {}
    }
    cleanText = cleanText.replace(/^@\d{6,}\s*/g, '').trim();

    const pluginContext = {
      sock,
      chatId: jid,
      senderJid: actorJid || resolvedSenderJid || senderJid,
      senderAliases: senderIdentityAliases,
      isOwner: senderIsOwner,
      isGroup,
      groupMeta,
      mentions: resolvedMentions,
      quotedParticipant,
      botJids: selfNums,
    };
    const isAddressed = !isGroup
      || mentionedBot
      || repliedToBot
      || groupStreakAddressed
      || namedBot
      || (isGroup && commandPlugins.isExplicitCommand(cleanText));

    // --- FAST PATH: instant commands that need no media / group metadata ---
    // Runs before any network/await work so help/ping/games/obsidian reply near-instantly.
    if (!hasMedia && !isGroupStatusMention && cleanText && !commandPlugins.isDeferredMediaCommand(cleanText)) {
      const commandInput = cleanText.trim();
      const t = commandPlugins.parseCommand(commandInput).text.trim();
      // Instant build-cancel: works for anyone (not owner-gated — it's their own build
      // request), and only fires while a build is actually running in this chat, so an
      // ordinary "stop"/"cancel" elsewhere in conversation is never hijacked. This goes
      // through cancelBuild() directly instead of the agent loop, so it can't get stuck
      // waiting behind the very build call it's trying to interrupt.
      if (aiTools.isBuildRunning(jid) && /\b(stop|cancel|abort)\b/i.test(t)) {
        aiTools.cancelBuild(jid);
        return; // the build's own catch block sends the "🛑 Build cancelled" confirmation
      }
      // Normal group chatter must not enter the command/AI path. Explicit
      // addressing is required: @mention, reply to the bot, or bot name.
      // Owner control commands remain available without a tag because they are
      // explicit privileged commands, not conversational replies.
      const ownerControlCommand = /^(?:private|public|open|unlock|lockdown|owner[- ]only|group[- ]only|groups[- ]only|dm[- ]only|dms[- ]only|private[- ]chat[- ]only|all[- ]chats|scope[- ]all|all|maintenance(?:\s+(?:on|off))?|ignore(?:\s+(?:this\s+)?(?:chat|here))?|mute(?:\s+(?:this\s+)?(?:chat|here))?|silence(?:\s+(?:this\s+)?(?:chat|here))?|listen(?:\s+(?:to\s+)?(?:this\s+)?(?:chat|here))?|unignore(?:\s+(?:this\s+)?(?:chat|here))?|unsilence(?:\s+(?:this\s+)?(?:chat|here))?|clear\s+ignored(?:\s+chats)?|owner\s+status|bot\s+status|mode(?:\s+(?:public|private))?)$/i;
      const addressedNow = !isGroup || isAddressed || (senderIsElevated && ownerControlCommand.test(t));
      if (addressedNow) {
      const fastHandled = await (async () => {
        const pluginResult = await commandPlugins.route(pluginContext, commandInput);
        if (pluginResult.handled) return sendText(jid, pluginResult.text || '');
        // Owner-only sub-agent status/list. Shows the worker roster and configured backends
        // without exposing API keys.
        if (perms.isOwner(actorJid) && /^(?:subagents?|agents?)\s+(?:list|status)$/i.test(t)) {
          const backends = subagents.codingBackends();
          const workers = subagents.NAMES.map((name, i) => {
            const backend = backends.length ? backends[i % backends.length] : null;
            return `• *${name}* → ${backend ? backend.name : 'unconfigured'}`;
          }).join('\n');
          const configured = backends.length
            ? backends.map((b) => `• ${b.name} — ${b.provider.label || b.provider.model || 'configured'}`).join('\n')
            : '• None configured';
          return sendText(jid,
            `🧩 *Sub-agents*\n\n${workers}\n\n*Available backends*\n${configured}\n\nParallel workers rotate across the available backends.`
          );
        }
        // Owner-only runtime model/provider switching. Persists across restarts.
        if (perms.isOwner(actorJid) && /^(model|ai model|switch model|use model)(?:\s+.*)?$/i.test(t)) {
          const arg = t.replace(/^(model|ai model|switch model|use model)\s*/i, '').trim();
          const providers = listProviders();
          const lines = providers.map((p) => {
            const mark = p.hasKey || p.name === 'gpt' ? '✅' : '⬜';
            return `${mark} *${p.name}* — ${p.label || p.model || ''} (${p.model || 'n/a'})`;
          });
          if (!arg || /^(list|status|\?)$/i.test(arg)) {
            const active = getActiveProvider();
            return sendText(jid,
              `🧠 *Active brain:* ${active.name} (${active.model || 'n/a'})\n\n` +
              `Available (Agnes = main; others = sub-agents):\n${lines.join('\n')}\n\n` +
              `Switch with: \`model agnes\` · \`model gpt\` · \`model openai\` · \`model agentrouter\``
            );
          }
          const result = setActiveProvider(arg);
          if (!result.ok) {
            return sendText(jid,
              `❌ Unknown model/provider *${arg}*.\n\nTry one of:\n${lines.join('\n')}\n\nExample: \`model agnes\``
            );
          }
          const active = getActiveProvider();
          const keyOk = !!(active.apiKeys && active.apiKeys.length) || active.local || active.name === 'gpt';
          const warning = !keyOk
            ? '\n⚠️ No API key configured for this brain — set it in `.env` then restart, or pick another.'
            : '';
          const role = active.name === config.ai.defaultProvider ? ' (default provider)' : ' (alternate provider)';
          return sendText(jid,
            `✅ Switched to *${active.name}*${role}\nModel: \`${active.model || 'n/a'}\`${warning}`
          );
        }
        // xp toggle removed
        // xp status removed


        // Dark Agent — staff only (deterministic; never let the LLM answer this).
        {
          const td = t.replace(/^(?:broken|@broken)\s+/i, '').trim();
          const canDark = senderIsElevated || perms.isOwner(actorJid) || roles.isSudo(actorJid) || roles.isOwner(actorJid);
          if (canDark && /\bdark(?:\s*[-_]?\s*agent)?\b/i.test(td) && /\b(on|off|status|enable|disable|turn)\b/i.test(td)) {
            const act = /\b(off|disable)\b/i.test(td) ? 'off'
              : /\bstatus\b/i.test(td) && !/\b(on|off|enable|disable)\b/i.test(td) ? 'status'
              : /\b(on|enable)\b/i.test(td) ? 'on'
              : /\bturn\b/i.test(td) && /\boff\b/i.test(td) ? 'off'
              : /\bturn\b/i.test(td) ? 'on'
              : 'status';
            if (act === 'status') {
              return sendText(jid, `🌑 Dark Agent is ${darkAgent.isEnabled() ? 'ON' : 'OFF'} (staff only).`);
            }
            const on = act === 'on';
            darkAgent.setEnabled(on);
            return sendText(jid, on
              ? '🌑 Dark Agent ON — staff get the unrestricted persona. Normal members unchanged.'
              : '🌑 Dark Agent OFF — standard persona restored.');
          }
          if (canDark && /^(dark(?:\s+agent)?|darkmode)\s*$/i.test(td)) {
            return sendText(jid, `🌑 Dark Agent is ${darkAgent.isEnabled() ? 'ON' : 'OFF'}.\nSay *dark on* / *dark off* to toggle.`);
          }
        }

        // Persistent font/design controls. The selected style is applied by sendText to
        // every later bot text message in this chat until reset.
        const resetFont = /^(?:reset|clear|remove)\s+(?:the\s+)?font(?:\s+style)?$|^font\s+(?:reset|normal|plain|default)$/i.test(t);
        if (resetFont) { chatFont.reset(jid); return sendText(jid, '✨ Font reset — normal text is back.'); }
        const persistentFont = t.match(/^(?:change\s+)?font(?:\s+to)?\s+([a-z0-9 _-]+)$/i) || t.match(/^use\s+([a-z0-9 _-]+)\s+(?:font|style)$/i) || t.match(/^set\s+(?:text\s+)?(?:style|font)\s+to\s+([a-z0-9 _-]+)$/i);
        if (persistentFont) {
          const requested = persistentFont[1].trim();
          const bits = requested.split(/\s+\+\s+|\s+with\s+/i).map(x => x.trim()).filter(Boolean);
          const fontName = bits[0] || requested;
          const canonical = textStyler.aliases[fontName.toLowerCase()] || fontName.toLowerCase();
          const presetKey = fontName.toLowerCase().replace(/[ _-]+/g,'');
          const symbolName = bits.slice(1).find(x => textStyler.symbolPacks[textStyler.symbolAliases[x.toLowerCase()] || x.toLowerCase()]);
          if (textStyler.presets[presetKey]) chatFont.set(jid, 'normal', presetKey, symbolName || '');
          else chatFont.set(jid, canonical, '', symbolName || '');
          return sendText(jid, `✨ Font changed to ${fontName}. Every bot text message from now on will keep it until you change/reset it.`);
        }
        if (/^(?:font|text\s+style)\s+(?:status|current)$/i.test(t)) {
          const cfg=chatFont.describe(jid); return sendText(jid, cfg ? `✨ Current font: ${cfg.preset || cfg.style}${cfg.symbols ? ` + ${cfg.symbols}` : ''}` : '✨ Current font: normal');
        }

        // Deterministic text-font shortcut. Complex requests still go through the AI style_text tool.
        const fontMatch = t.match(/^(?:font|style|text style)\s+([^:]+?)(?:\s*:\s*|\s+)(.+)$/i);
        if (fontMatch) {
          const style = fontMatch[1].trim();
          const styled = textStyler.styleText(fontMatch[2].trim(), style);
          if (styled !== fontMatch[2].trim() || /^(normal|plain|reset)$/i.test(style)) return sendText(jid, styled);
        }
        if (isGroup && /^(group stats|group statistics)$/i.test(t)) {
          const meta = groupMeta || await cachedGroupMeta(sock, jid); const members=meta?.participants||[]; const admins=members.filter(p=>p.admin).length;
          return sendText(jid, `📊 Group Stats\n\n👥 Members: ${members.length}\n🛡️ Admins: ${admins}\n💬 Observed messages: ${new Collection('group_chat_log',{}).get(jid,[]).length}`);
        }
        // daily question removed
        // group challenge removed
        if (/^(help|menu|commands)$/i.test(t)) return sendText(jid, buildMenuText(senderIsOwner));
        if (/^(\/|!)?ping$/i.test(t)) return sendText(jid, '🏓 pong — I\'m alive.');        // profile/leveling removed

        if (perms.isOwner(actorJid) && /^broadcast\s+/i.test(t)) {
          const text = t.replace(/^broadcast\s+/i, '');
          return sendText(jid, `📣 Broadcast queued: "${text}" (hook this up to your known-chats list in index.js).`);
        }
        // fast custom command (owner-defined trigger -> canned response)
        const customResponse = customCommands.match(t);
        if (customResponse !== null) return sendText(jid, customResponse);
        // fast obsidian command (admin-gated ones lazily fetch meta only when needed)
        const obsRes = await obsidian.route(sock, jid, senderJid, t, resolvedMentions);
        if (obsRes.handled) {
          if (obsRes.text === null) return undefined;
          return sendText(jid, obsRes.text);
        }
        return null;
      })();
      if (fastHandled !== null) return fastHandled === undefined ? undefined : fastHandled;
      }
    }

    // Social link download: autolink ON, or user asked to download, or message is mostly a social URL
    try {
      const mediaDownloader = require('../features/mediaDownloader');
      const urls = rawText ? mediaDownloader.extractUrls(rawText) : [];
      const askedDownload = /\b(download|save|fetch|get|pull|dl)\b/i.test(rawText || '')
        || /\b(download|save|fetch|dl)\s+(this|the|that)?\s*(post|video|image|reel|link)?\b/i.test(rawText || '');
      const onlyLink = urls.length && String(rawText || '').replace(urls[0].url, '').trim().length < 8;
      const shouldDl = urls.length && (mediaDownloader.isAutolinkOn(jid) || askedDownload || (onlyLink && isAddressed));
      if (shouldDl) {
        const uid = numFromJid(resolvedSenderJid || senderJid) || String(senderJid);
        if (!mediaDownloader.checkRate(uid)) {
          await sendText(jid, `⚠️ Download limit: ${mediaDownloader.HOURLY_LIMIT}/hour.`);
          return;
        }
        for (const { url, platform } of urls.slice(0, 2)) {
          try {
            await typing(jid, true);
            const post = await mediaDownloader.downloadPost(url);
            const captionParts = [];
            if (post.title) captionParts.push(`📎 *${post.title}*`);
            if (post.caption) captionParts.push(post.caption.slice(0, 900));
            captionParts.push(`${platform} · via ${post.source}`);
            const caption = captionParts.filter(Boolean).join('\n\n');

            let sentSomething = false;
            // Images first (FB photo posts etc.)
            for (const img of (post.images || []).slice(0, 5)) {
              await sock.sendMessage(jid, {
                image: img,
                caption: sentSomething ? undefined : caption,
              }, { quoted: msg });
              sentSomething = true;
            }
            // Videos
            for (const vid of (post.videos || []).slice(0, 2)) {
              await sock.sendMessage(jid, {
                video: vid,
                caption: sentSomething ? undefined : caption,
                mimetype: 'video/mp4',
              }, { quoted: msg });
              sentSomething = true;
            }
            // Text-only post
            if (!sentSomething && caption) {
              await sendText(jid, caption);
              sentSomething = true;
            }
            if (!sentSomething) {
              await sendText(jid, `❌ No media found on that ${platform} link.`);
            }
            try { if (post.file) require('fs').unlinkSync(post.file); } catch {}
          } catch (e) {
            await sendText(jid, `❌ Download failed (${platform}): ${e.message}`);
          }
        }
        return;
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'autolink failed');
    }

    // Normal group chatter must not wake the AI. Users can address it by mention,
    // bot name, or replying to a bot message.
    if (isGroup && !isAddressed) {
      // Quiet — do not hop on untagged group traffic
      return;
    }

    // DM: if user pastes a GitHub PAT, save it privately for their account only.
    if (!isGroup && rawText) {
      try {
        const cap = githubTokenVault.maybeCaptureFromDm(false, resolvedSenderJid || senderJid, rawText);
        if (cap && cap.ok) {
          return sendText(jid, '🔐 GitHub token saved for *your* account only. I will use it when you ask to push/clone. Say *github disconnect* to remove it.\n\nTip: create a classic PAT with `repo` scope at github.com/settings/tokens');
        }
      } catch {}
    }


    // --- vision + sticker-maker: download the image now that we know we're actually
    // engaging with it. Also handles a *replied-to* image (e.g. "make this a sticker"
    // sent as a reply to a photo) so tools like make_sticker have something to work with
    // even when the triggering message itself carries no media. ---
    // Now generalized to handle image, video, AND audio (current message or quoted),
    // so replying to any media lets the AI actually see/hear it.
    let mediaContent = null; // OpenAI-style content block(s): image_url or input_audio
    let imageDataUri = null;
    let imageBuffer = null;
    let videoBuffer = null;
    let stickerBuffer = null;
    let audioBuffer = null;
    let audioMime = null;
    let attachmentInfo = null; // { fileName, mimetype, size, isZip, textPreview } for docs
    let documentBuffer = null;
    let quotedVideoBuffer = null;
    let quotedStickerBuffer = null;
    let quotedImageBuffer = null;

    async function attachMedia(srcMsg, msgType, mediaMsg, asQuoted = false) {
      try {
        let buffer = await downloadMediaMessage(srcMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        // Retry once if WhatsApp returned a truncated document (common cause of "No END header")
        const expected = Number(mediaMsg?.fileLength || 0);
        if (Buffer.isBuffer(buffer) && expected > 0 && buffer.length < expected * 0.9) {
          try {
            buffer = await downloadMediaMessage(srcMsg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          } catch {}
        }
        if (msgType === 'imageMessage') {
          const mime = mediaMsg.mimetype || 'image/jpeg';
          imageDataUri = `data:${mime};base64,${buffer.toString('base64')}`;
          imageBuffer = buffer;
          if (asQuoted) quotedImageBuffer = buffer;
          mediaContent = { type: 'image_url', image_url: { url: imageDataUri } };
          try { aiTools.rememberChatImage(jid, imageDataUri, buffer); } catch {}
        } else if (msgType === 'videoMessage') {
          const mime = mediaMsg.mimetype || 'video/mp4';
          imageDataUri = null;
          videoBuffer = buffer;
          if (asQuoted) quotedVideoBuffer = buffer;
          mediaContent = { type: 'video_url', video_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } };
        } else if (msgType === 'stickerMessage') {
          stickerBuffer = buffer;
          if (asQuoted) quotedStickerBuffer = buffer;
        } else if (msgType === 'audioMessage') {
          const mime = mediaMsg.mimetype || 'audio/ogg; codecs=opus';
          audioBuffer = buffer;
          audioMime = mime;
          mediaContent = { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format: mime.includes('mp4') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : 'ogg' } };
        } else if (msgType === 'documentMessage') {
          const fileName = mediaMsg.fileName || 'file';
          const mime = mediaMsg.mimetype || 'application/octet-stream';
          const isZip = /\.zip$/i.test(fileName) || /\.brkn$/i.test(fileName);
          documentBuffer = buffer;
          attachmentInfo = { fileName, mimetype: mime, size: buffer.length, isZip, kind: 'document' };
          if (isZip || /\.zip$/i.test(fileName) || (buffer[0]===0x50 && buffer[1]===0x4b)) {
            try { zipMemory.rememberSource(jid, buffer, { fileName }); } catch {}
          }
          const texty = /\.(js|ts|py|rb|go|java|c|cpp|h|html|css|json|yml|yaml|sh|md|txt|sql|xml|jsx|tsx)$/i.test(fileName);
          if (texty) {
            attachmentInfo.textPreview = buffer.toString('utf8').slice(0, 3000);
          }
        }
      } catch (e) {
        logger.warn({ err: e.message, msgType }, 'failed to download media for AI');
      }
    }

    // current message media
    const curMediaType = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].find((t) => mt[t]);
    if (curMediaType) {
      await attachMedia(msg, curMediaType, mt[curMediaType], false);
    }
    // Always try quoted media too (reply-to-video → convert to mp3, reply-to-sticker → video)
    let quotedType = null;
    {
      const ctxInfo = mt.extendedTextMessage?.contextInfo || mt.imageMessage?.contextInfo || mt.videoMessage?.contextInfo || mt.audioMessage?.contextInfo || {};
      const quoted = ctxInfo?.quotedMessage || quotedUnwrapped;
      quotedType = quoted && ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].find((t) => quoted[t]);
      if (quotedType) {
        const quotedMsg = {
          key: { remoteJid: jid, id: ctxInfo.stanzaId || quotedMessageId, participant: ctxInfo.participant || quotedParticipantRaw, fromMe: false },
          message: quoted,
        };
        await attachMedia(quotedMsg, quotedType, quoted[quotedType], true);
      }
    }

    const mediaPluginResult = await commandPlugins.handleMedia(pluginContext, cleanText.trim(), imageBuffer || quotedImageBuffer);
    if (mediaPluginResult.handled) return sendText(jid, mediaPluginResult.text || '');

    await typing(jid, true);

    try {
      // --- 3. tiny built-ins that don't need the model ---
      if (/^(help|menu|commands)$/i.test(cleanText.trim())) {
        return sendText(jid, buildMenuText(senderIsOwner));
      }

      if (/^(?:\/ctx|ctx|usage|token\s*usage)$/i.test(cleanText.trim())) {
        return sendText(jid, usageTracker.formatReport());
      }
      if (/^(?:\/compact|compact)$/i.test(cleanText.trim())) {
        try {
          memory.clearScoped?.(jid, memoryUserId);
          memory.clear?.(jid);
        } catch {}
        return sendText(jid, '🧹 Conversation context compacted for this chat. Usage window unchanged.\n\n' + usageTracker.formatReport());
      }

      // Roleplay controls (per-user persona store)
      {
        const rp = cleanText.trim();
        if (/^(?:roleplay|rp)\s+on\b/i.test(rp) || /^(?:start\s+)?(?:roleplay|rp)\b/i.test(rp) && !/\bas\b/i.test(rp)) {
          try {
            const { Collection } = require('../db');
            const store = new Collection('user_persona', {});
            store.set(String(resolvedSenderJid || senderJid), 'roleplay');
          } catch {}
          return sendText(jid, 'roleplay mode on. tell me who to be — or just start the scene 🎀');
        }
        const asMatch = rp.match(/^(?:roleplay|rp)\s+as\s+(.+)/i);
        if (asMatch) {
          const who = asMatch[1].trim().slice(0, 120);
          try {
            const { Collection } = require('../db');
            const store = new Collection('user_persona', {});
            store.set(String(resolvedSenderJid || senderJid), 'roleplay');
          } catch {}
          // seed scoped memory with the character so the model stays in character
          try {
            memory.pushScoped(jid, memoryUserId, 'user', `Start roleplay. You are: ${who}. Stay in character.`);
            memory.pushScoped(jid, memoryUserId, 'assistant', `*settles into character as ${who}* ...ready when you are.`);
          } catch {}
          return sendText(jid, `got it — i'm ${who} now. your move 🎀`);
        }
        if (/^(?:end\s+rp|stop\s+roleplay|rp\s+off|roleplay\s+off|be\s+normal)$/i.test(rp)) {
          try {
            const { Collection } = require('../db');
            const store = new Collection('user_persona', {});
            store.set(String(resolvedSenderJid || senderJid), '');
          } catch {}
          return sendText(jid, 'back to normal.');
        }
      }

      {
        const t = cleanText.trim();

        
        
        
        
        // Fix current-message zip: user sends zip with caption/text "fix this"
        if (documentBuffer && (attachmentInfo?.isZip || /\.zip$/i.test(attachmentInfo?.fileName || '') || (documentBuffer[0]===0x50 && documentBuffer[1]===0x4b))) {
          if (/(fix|error|broken|not working|bug|crash|issue|problem|repair|debug|correct)/i.test(t)) {
            await typing(jid, true);
            await sendText(jid, '🔧 Looking at your zip...');
            try {
              const complaint = t.replace(/^(fix|please fix|it has|the |this |zip )/i, '').trim() || 'find and fix bugs';
              const res = await fixer.fixZip(documentBuffer, complaint, aiClient);
              if (!res.ok) return sendText(jid, `❌ ${res.error}`);
              if (res.noChanges) return sendText(jid, res.message);
              const data = require('fs').readFileSync(res.zipPath);
              await sock.sendMessage(jid, { document: data, mimetype: 'application/zip', fileName: 'fixed.zip', caption: `🔧 Fixed: ${res.changed.join(', ')}\n${res.verified ? '✅ Verified' : '⚠️ Check files'}` }, { quoted: msg });
              try {
                zipMemory.rememberFix(jid, {
                  changed: res.changed,
                  verified: res.verified,
                  message: res.message,
                  complaint,
                  fileName: attachmentInfo?.fileName || 'project.zip',
                  summary: `Fixed ${(res.changed||[]).length} files: ${(res.changed||[]).join(', ')}`,
                });
              } catch {}
              return true;
            } catch (e) {
              return sendText(jid, `❌ Fix failed: ${e.message}`);
            }
          }
        }

        if (/\b(send|pack|zip)\b.*\b(as\s+)?zip\b/i.test(t) || /^(pack|zip)\s*(this|it|media|file)?$/i.test(t)) {
          try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip();
            let n = 0;
            const add = (name, buf) => { if (buf && buf.length) { zip.addFile(name, buf); n++; } };
            add((attachmentInfo && attachmentInfo.fileName) || 'document.bin', documentBuffer);
            add('image.jpg', imageBuffer || quotedImageBuffer);
            add('video.mp4', videoBuffer || quotedVideoBuffer);
            add('audio.ogg', audioBuffer);
            add('sticker.webp', stickerBuffer || quotedStickerBuffer);
            if (!n) return sendText(jid, 'Reply to a photo/video/file and say *pack as zip*.');
            const out = zip.toBuffer();
            await sock.sendMessage(jid, { document: out, mimetype: 'application/zip', fileName: 'media.zip', caption: `📦 ${n} file(s)` }, { quoted: msg });
            return true;
          } catch (e) {
            return sendText(jid, 'Zip failed: ' + e.message);
          }
        }
        if (/^(gen\s*quota|quota|my\s*gens)$/i.test(t)) {
          const rem = genQuota.remaining(resolvedSenderJid || senderJid);
          if (rem.unlimited) return sendText(jid, '✨ Unlimited image/video gens (owner/sudo).');
          return sendText(jid, `🎨 Gen quota: ${rem.used}/${rem.limit} used in the last 6h · ${rem.left} left`);
        }
        if (senderIsElevated && /^(daily\s*report|report\s*today)$/i.test(t)) {
          return sendText(jid, dailyReport.formatReport());
        }

        if (/\b(preview|run|screenshot|open)\b.*\b(site|website|zip|html)\b/i.test(t) || /^(preview|run)\s+(this\s+)?(site|zip|website)\b/i.test(t)) {
          if (!documentBuffer) return sendText(jid, 'Send a static website *zip* first, then ask me to preview/screenshot it.');
          try {
            await typing(jid, true);
            const fname = (attachmentInfo && attachmentInfo.fileName) || 'site.zip';
            const result = await siteRunner.previewZip(documentBuffer, { maxPages: 4, fileName: fname });
            let n = 0;
            for (const shot of result.shots) {
              if (shot.buffer) { await sendImage(jid, shot.buffer, `🖼️ ${shot.page}`); n++; }
            }
            try { require('fs').rmSync(result.workDir, { recursive: true, force: true }); } catch {}
            if (!n) return sendText(jid, 'Preview ran but no screenshots were captured (check puppeteer/chrome).');
            return sendText(jid, `Preview done — ${n} page(s) (${result.kind || 'site'}). Static only.`);
          } catch (e) {
            return sendText(jid, `Preview failed: ${e.message}`);
          }
        }

        

        if (/^translate\s+(?:to\s+)?(\w+)\s*[:\-]?\s+([\s\S]+)/i.test(t)) {
          const m = t.match(/^translate\s+(?:to\s+)?(\w+)\s*[:\-]?\s+([\s\S]+)/i);
          const res = await funExtras.translate(m[2], m[1]);
          return sendText(jid, res.ok ? res.text : `Translate failed: ${res.error}`);
        }
        if (/^weather\s+(.+)/i.test(t)) {
          const city = t.replace(/^weather\s+/i, '').trim();
          const res = await funExtras.weather(city);
          return sendText(jid, res.ok ? res.text : `Weather failed: ${res.error}`);
        }

        if (/^lang(?:uage)?\s+(\w+)\b/i.test(t)) {
          const lang = t.match(/^lang(?:uage)?\s+(\w+)/i)[1];
          partyExtras.setLang(resolvedSenderJid || senderJid, lang);
          return sendText(jid, `🌐 Language preference set to *${lang}*. I will try to reply in that language.`);
        }
        if (/^spam\s+(?:score|status)\b/i.test(t)) {
          const st = spamScore.status(jid, resolvedSenderJid || senderJid);
          return sendText(jid, `🛡️ Spam score: ${st.score}/100 · recent msgs/min window: ${st.recent}`);
        }
        if (senderIsElevated && /^broadcast\s+at\s+/i.test(t)) {
          // broadcast at 2h Hello everyone
          const m = t.match(/^broadcast\s+at\s+(\d+)\s*(m|min|mins|h|hr|hours)?\s+([\s\S]+)/i);
          if (!m) return sendText(jid, 'Usage: *broadcast at 30m Hello group*');
          const n = parseInt(m[1], 10);
          const unit = (m[2] || 'm').toLowerCase();
          const ms = /h/.test(unit) ? n * 3600000 : n * 60000;
          const job = scheduledBroadcast.schedule({ text: m[3].trim(), whenMs: Date.now() + ms, groupJids: isGroup ? [jid] : [] });
          return sendText(jid, `⏰ Broadcast scheduled (${job.id}) in ${n}${unit || 'm'}.`);
        }
        if (senderIsElevated && /^broadcasts$/i.test(t)) {
          const list = scheduledBroadcast.list();
          return sendText(jid, list.length ? list.map(j => `• ${j.id} @ ${new Date(j.when).toLocaleString()}: ${String(j.text).slice(0,40)}`).join('\n') : 'No scheduled broadcasts.');
        }
        if (/^pack\s+(?:list|status)\b/i.test(t)) {
          const packs = stickerPack.list(resolvedSenderJid || senderJid);
          return sendText(jid, packs.length ? packs.map(p => `• ${p.name}: ${p.count} stickers`).join('\n') : 'No packs yet. Reply to stickers with *pack add*');
        }
        if (/^pack\s+add\b/i.test(t)) {
          return sendText(jid, 'Reply to a sticker with *pack add* (or *pack add mypack*).');
        }
        
        if (/\b(?:tg|telegram)\s*(?:sticker\s*)?pack\b/i.test(t) || /t\.me\/addstickers\//i.test(t)) {
          const link = (t.match(/https?:\/\/\S+/i) || [t.replace(/^(?:broken\s+)?(?:download\s+)?(?:tg|telegram)\s*(?:sticker\s*)?pack\s*/i, '').trim()])[0];
          try {
            await typing(jid, true);
            const pack = await telegramStickers.downloadPack(link, { maxStickers: 15 });
            await sendText(jid, `📦 *${pack.title}* — sending ${pack.count} stickers…`);
            for (const s of pack.stickers) {
              try {
                if (s.isVideo || s.isAnimated) {
                  await sock.sendMessage(jid, { sticker: s.buffer });
                } else {
                  await sock.sendMessage(jid, { sticker: s.buffer });
                }
              } catch (e) {
                logger.warn({ err: e.message }, 'tg sticker send failed');
              }
            }
            return true;
          } catch (e) {
            return sendText(jid, `Couldn't pull that Telegram pack: ${e.message}`);
          }
        }

        if (/^pack\s+export\b/i.test(t)) {
          const name = t.replace(/^pack\s+export\s*/i, '').trim() || 'default';
          const ex = await stickerPack.exportZip(resolvedSenderJid || senderJid, name);
          if (!ex.ok) return sendText(jid, ex.error);
          await sock.sendMessage(jid, { document: ex.buffer, mimetype: 'application/zip', fileName: `${ex.name || name}.zip`, caption: `🎨 Sticker pack (${ex.count})` });
          return true;
        }

      }
      if (/^ping$/i.test(cleanText.trim())) {
        return sendText(jid, '🏓 pong — I\'m alive.');
      }
      // Full games module: wordgrid (visual), trivia, scramble, hangman, blackjack, etc.
      try {
        const games = require('../features/games');
        const tGame = cleanText.trim();
        const tLower = tGame.toLowerCase();
        const displayName = (typeof who === 'string' && who) || names.displayLabel?.(resolvedSenderJid, isGroup ? jid : null, groupMeta) || numFromJid(senderJid);

        // Stop / cancel active game
        if (/^(stop\s*game|end\s*game|cancel\s*game|quit\s*game)$/i.test(tGame)) {
          if (games.current(jid)) {
            games.end(jid);
            return sendText(jid, 'game stopped.');
          }
        }

        // Start commands
        let started = null;
        if (/^(wordgrid|word\s*grid|wordsearch|word\s*search)\b/i.test(tGame)) {
          started = await games.startWordSearch(jid, resolvedSenderJid || senderJid);
        } else if (/^trivia\b/i.test(tGame)) {
          started = games.startTrivia(jid, resolvedSenderJid || senderJid);
        } else if (/^(scramble|unscramble)\b/i.test(tGame)) {
          started = games.startScramble(jid, resolvedSenderJid || senderJid);
        } else if (/^(guess|number\s*guess)\b/i.test(tGame)) {
          started = games.startGuess(jid, resolvedSenderJid || senderJid);
        } else if (/^riddle\b/i.test(tGame)) {
          started = games.startRiddle(jid, resolvedSenderJid || senderJid);
        } else if (/^hangman\b/i.test(tGame)) {
          started = games.startHangman(jid, resolvedSenderJid || senderJid);
        } else if (/^(ttt|tictactoe|tic\s*tac\s*toe)\b/i.test(tGame)) {
          started = games.startTtt(jid, resolvedSenderJid || senderJid);
        } else if (/^(crossword)\b/i.test(tGame)) {
          started = games.startCrossword(jid, resolvedSenderJid || senderJid);
        } else if (/^(spelling\s*bee|spell(?:ing)?\s*bee)\b/i.test(tGame)) {
          started = games.startSpellingBee(jid, resolvedSenderJid || senderJid);
        } else if (/^(wyr|would you rather)\b/i.test(tGame)) {
          started = games.startWyr(jid, resolvedSenderJid || senderJid);
        } else if (/^(emoji\s*game|emojiquiz)\b/i.test(tGame)) {
          started = games.startEmojiGame(jid, resolvedSenderJid || senderJid);
        } else if (/^(quiz)\b/i.test(tGame)) {
          started = games.startQuiz(jid, resolvedSenderJid || senderJid);
        } else if (/^blackjack\s+(\d+)\b/i.test(tGame)) {
          const bet = parseInt(tGame.match(/blackjack\s+(\d+)/i)[1], 10);
          started = games.startBlackjack(jid, resolvedSenderJid || senderJid, bet);
        } else if (/^coinflip\s+(\d+)\b/i.test(tGame)) {
          const bet = parseInt(tGame.match(/coinflip\s+(\d+)/i)[1], 10);
          started = games.startCoinflip(jid, resolvedSenderJid || senderJid, bet);
        } else if (/^slot\s+(\d+)\b/i.test(tGame)) {
          const bet = parseInt(tGame.match(/slot\s+(\d+)/i)[1], 10);
          started = games.startSlot(jid, resolvedSenderJid || senderJid, bet);
        } else if (/^(games|game\s*list|list\s*games)\b/i.test(tGame)) {
          return sendText(jid, '🎀 *games*\nwordgrid · trivia · scramble · guess · riddle · hangman · crossword · spelling bee · wyr · emoji · quiz · ttt · blackjack <bet> · coinflip <bet> · slot <bet>\n\nstop game to cancel.');
        } else if (/^game\s*leaderboard\b/i.test(tGame)) {
          const lb = games.leaderboard();
          if (!lb.length) return sendText(jid, 'no wins yet.');
          return sendText(jid, '🏆 *game wins*\n' + lb.map(([u, w], i) => `${i + 1}. ${u} — ${w}`).join('\n'));
        }

        if (started) {
          // Attach visual grid image for wordgrid
          if (started.needsImage && started.game) {
            try {
              const img = await games.renderWordGridImage(started.game);
              if (img) started.image = img;
            } catch (e) {
              logger.warn({ err: e.message }, 'wordgrid image render failed');
              if (typeof games.textGridFallback === 'function') {
                started.text = (started.text || '') + '\n\n' + games.textGridFallback(started.game);
              }
            }
          }
          await sendGameResult(jid, started);
          return true;
        }

        // Resolve answers against active game in this chat
        const active = games.current(jid);
        if (active) {
          let resolved = null;
          if (active.type === 'wordgrid' || active.type === 'wordsearch') {
            resolved = games.resolveWordSearch(jid, resolvedSenderJid || senderJid, tGame, displayName);
          } else if (active.type === 'trivia' || active.type === 'scramble' || active.type === 'riddle') {
            resolved = games.resolveAnswer(jid, resolvedSenderJid || senderJid, tGame);
          } else if (active.type === 'guess') {
            resolved = games.resolveGuess(jid, resolvedSenderJid || senderJid, tGame);
          } else if (active.type === 'blackjack' && /^(hit|stand)$/i.test(tGame)) {
            resolved = games.resolveBlackjack(jid, resolvedSenderJid || senderJid, tLower);
          } else if (active.type === 'coinflip' && /^(heads|tails)$/i.test(tGame)) {
            resolved = games.resolveCoinflip(jid, resolvedSenderJid || senderJid, tLower);
          } else if (active.type === 'ttt' && /^[1-9]$/.test(tGame.trim())) {
            resolved = games.resolveTtt(jid, resolvedSenderJid || senderJid, parseInt(tGame, 10));
          } else if (active.type === 'hangman' && /^[a-zA-Z]$/.test(tGame.trim())) {
            resolved = games.resolveHangman(jid, resolvedSenderJid || senderJid, tLower);
          } else if (active.type === 'slot' && /^spin$/i.test(tGame)) {
            resolved = games.resolveSlot(jid, resolvedSenderJid || senderJid, 'spin');
          } else if (active.type === 'quiz') {
            resolved = games.resolveQuiz(jid, resolvedSenderJid || senderJid, tGame);
          } else if (active.type === 'emoji' || active.type === 'emojigame') {
            resolved = games.resolveEmojiGame?.(jid, resolvedSenderJid || senderJid, tGame);
          } else if (active.type === 'wyr') {
            resolved = games.resolveWyr?.(jid, resolvedSenderJid || senderJid, tGame);
          } else if (active.type === 'crossword') {
            resolved = games.resolveCrossword(jid, resolvedSenderJid || senderJid, tGame, displayName);
          } else if (active.type === 'spellingbee') {
            resolved = games.resolveSpellingBee(jid, resolvedSenderJid || senderJid, tGame);
          }

          if (resolved) {
            // Format common win/lose shapes into text when missing
            if (resolved.correct === true && !resolved.text) {
              resolved.text = `✅ +${resolved.prize || 0} · wins: ${resolved.wins || '?'}`;
            } else if (resolved.correct === false && !resolved.text) {
              // silent wrong answer for trivia/scramble — don't spam
              return;
            } else if (resolved.tooLow) {
              resolved.text = 'higher.';
            } else if (resolved.tooHigh) {
              resolved.text = 'lower.';
            } else if (resolved.bust) {
              resolved.text = `bust (${resolved.hand}).`;
            } else if (resolved.hit) {
              resolved.text = `hand: ${resolved.hand} — hit or stand?`;
            } else if (resolved.stand) {
              resolved.text = `you ${resolved.player} · dealer ${resolved.dealer} · *${resolved.result}*`;
            } else if (resolved.flip !== undefined) {
              resolved.text = resolved.won ? `🪙 ${resolved.flip}. you win +${resolved.bet}` : `🪙 ${resolved.flip}. -${resolved.bet}`;
            } else if (resolved.board && !resolved.text) {
              resolved.text = (resolved.win ? 'you win.\n' : resolved.draw ? 'draw.\n' : 'my turn done.\n') + '```\n' + resolved.board + '\n```';
            } else if (resolved.invalid && resolved.text === null) {
              return; // ignore non-game chatter while wordgrid is active
            } else if (resolved.notFound && !resolved.text) {
              return; // silent miss on wordgrid
            } else if (resolved.alreadyFound || resolved.already) {
              // keep text
            }

            if (resolved.needsImage && resolved.game) {
              try {
                const img = await games.renderWordGridImage(resolved.game);
                if (img) resolved.image = img;
              } catch (e) {
                logger.warn({ err: e.message }, 'wordgrid image update failed');
              }
            }
            if (resolved.text || resolved.image || resolved.poll || resolved.ttsText) {
              await sendGameResult(jid, resolved);
              return true;
            }
          }
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'games handle error');
      }

      if (perms.isOwner(actorJid) && /^broadcast\s+/i.test(cleanText.trim())) {
        const text = cleanText.replace(/^broadcast\s+/i, '');
        return sendText(jid, `📣 Broadcast queued: "${text}" (hook this up to your known-chats list in index.js).`);
      }

      // --- 3.4 owner-defined custom commands: exact-match trigger -> canned response,
      // deterministic and instant, checked before games/obsidian/AI. ---
      const customResponse = customCommands.match(cleanText);
      if (customResponse !== null) {
        return sendText(jid, customResponse);
      }

      // --- 3.6 OBSIDIAN commands: owner tools, group control, fun, utils. ---
      const obsRes = await obsidian.route(sock, jid, senderJid, cleanText, resolvedMentions);
      if (obsRes.handled) {
        if (obsRes.text === null) return; // command produced no visible reply (e.g. leave/mass)
        return sendText(jid, obsRes.text);
      }

      // --- 4. the real agent: LLM + tools ---
      const userLang = (() => { try { return partyExtras.getLang(resolvedSenderJid || senderJid); } catch { return 'en'; } })();
      const _zipCtx = (() => { try { return zipMemory.contextBlock(jid); } catch { return ''; } })();
      const _buildCtx = (() => {
        try {
          const b = lastBuild.get(jid);
          if (!b) return '';
          const ageMin = Math.round((Date.now() - (b.at || 0)) / 60000);
          const files = (b.files || []).map((f) => f.name).filter(Boolean).slice(0, 30).join(', ');
          const zipOk = !!(b.zipPath && require('fs').existsSync(b.zipPath));
          return `[Last build in this chat (~${ageMin}m ago) kind=${b.kind || '?'} name=${b.projectName || '—'} stack=${b.stack || '—'}
Description: ${String(b.description || '').slice(0, 300)}
Files (${(b.files || []).length}): ${files || '—'}
Zip on disk: ${zipOk ? 'yes (call resend_last_build to send again)' : 'no'}
If the user asks to send/resend the zip again, call resend_last_build — do not rebuild unless they ask for changes.]`;
        } catch { return ''; }
      })();
      // Persona: read per-user preference (set via persona_set tool).
      let _activePersona = personalas.defaultId();
      try {
        const { Collection } = require('../db');
        const _ps = new Collection('user_persona', {});
        const _p = _ps.get(String(resolvedSenderJid || senderJid || ''));
        if (_p) _activePersona = String(_p);
      } catch {}

      // Evict stale sessions once per boot
      try { memory.cleanupStaleSessions(); } catch {}
      const system = withPersona(
        buildSystemPrompt({
          isGroup,
          isAdmin: senderIsElevated || (isGroup ? (perms.isOwner(actorJid) || perms.isGroupAdmin(actorJid, groupMeta, senderIdentityAliases)) : true),
          isOwner: !!senderIsOwner,
          senderName: senderName?.(senderJid, isGroup ? jid : null) || senderIdentity.name || '',
          groupName: groupMeta?.subject || '',
          userMemory: memory.getUserMemorySummary(memoryUserId, 12, { chatId: jid, isGroup }),
        }) + (_zipCtx ? `\n\n${_zipCtx}` : '') + (_buildCtx ? `\n\n${_buildCtx}` : ''),
        _activePersona,
      );

      // Seed / refresh active work session from this user message so we never forget mid-job.
      try {
        workSession.maybeSeedFromUser(jid, memoryUserId, cleanText || rawText || '');
      } catch {}
      const _workCtx = (() => { try { return workSession.contextBlock(jid, memoryUserId); } catch { return ''; } })();
      const systemWithWork = system + (_workCtx ? `

${_workCtx}` : '');

      // Outer scope — timeout/retry path also needs this (was ReferenceError).
      let systemWithLang = (userLang && userLang !== 'en')
        ? (systemWithWork + `

User language preference: ${userLang}. Reply in that language when reasonable.`)
        : systemWithWork;

      const toolCtx = {
        sock,
        aiClient: null, // set below before runAgent
        chatId: jid,
        senderJid: resolvedSenderJid,
        originalSenderJid: senderJid,
        senderIdentityAliases,
        userIdentity: senderIdentity,
        userMemory: memory.getUserMemorySummary(memoryUserId, 18, { chatId: jid, isGroup }),
        history: memory.getScopedForPrompt(jid, memoryUserId),
        isGroup,
        groupMeta,
        // Reliable structured info about who's being referred to — the AI should use these
        // instead of trying to parse a phone number out of rendered "@..." text, since that
        // text isn't always the literal number depending on the sender's WhatsApp client.
        mentionedJids: resolvedMentions || [],
        contactPhones: (typeof contactPhones !== 'undefined' ? contactPhones : phonesFromMessageType(mt)) || [],
        jidMap,
        repliedToJid: quotedParticipant || null,
        repliedToMessageId: quotedMessageId,
        repliedToMessageKey: {
          remoteJid: jid,
          id: quotedMessageId || null,
          participant: quotedParticipant || quotedParticipantRaw || null,
          participantAlt: ctxInfoDoc?.participantAlt || null,
          participantPn: ctxInfoDoc?.participantPn || null,
          fromMe: !!ctxInfoDoc?.quotedMessage?.key?.fromMe,
        },
        replyMessage: msg,
        quotedText: quotedText || null,
        quotedZipBuffer: await (async () => {
          try {
            if (quotedDoc && /\.zip$/i.test(quotedDoc.fileName || '')) {
              const q = { key: { remoteJid: jid, id: ctxInfoDoc.stanzaId, participant: ctxInfoDoc.participant, fromMe: false }, message: ctxInfoDoc.quotedMessage };
              return await downloadMediaMessage(q, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            }
          } catch {}
          // Current-message zip also counts
          if (documentBuffer && attachmentInfo?.isZip) return documentBuffer;
          if (documentBuffer && /\.zip$/i.test(attachmentInfo?.fileName || '')) return documentBuffer;
          if (documentBuffer && documentBuffer[0] === 0x50 && documentBuffer[1] === 0x4b) return documentBuffer;
          return null;
        })(),
        sendText: (text, opts = {}) => sendText(jid, text, opts),
        sendProgress: (text) => sendOwnerProgress(sock, text, jid, isGroup, resolvedSenderJid || senderJid),
        sendFile: (p, name, caption) => sendFile(jid, p, name, caption),
        sendImage: (source, caption) => sendImage(jid, source, caption, { quoted: msg }),
        sendAudio: (source, opts = {}) => sendAudio(jid, source, { ...opts, quoted: opts.quoted || msg }),
        sendVideo: (source, caption) => sendVideo(jid, source, caption, { quoted: msg }),
        sendSticker: (buffer) => sendSticker(jid, buffer, { quoted: msg }),
        imageBuffer,
        videoBuffer,
        quotedImageBuffer,
        quotedVideoBuffer,
        quotedAudioBuffer: null,
        imageDataUri: imageDataUri || (aiTools.getLastChatImage?.(jid)?.dataUri) || null,
        audioBuffer,
        audioMime,
        attachmentInfo,
        documentBuffer,
        quotedMessage: ctxInfoDoc?.quotedMessage || quotedMessage || null,
        quotedContext: ctxInfoDoc || null,
        quotedStanzaId: quotedMessageId || ctxInfoDoc?.stanzaId || null,
        quotedParticipant: quotedParticipant || quotedParticipantRaw || null,
        senderPhone: senderIdentity?.phoneNumber || jidResolver.number(senderJid, jidMap) || numFromJid(resolvedSenderJid || senderJid),
        senderIdentity,
        memoryUserId,
        workSession,
      };

      // Transcribe incoming voice notes so the agent can reason on text even if the model lacks audio.
      let voiceTranscript = null;
      const shouldTranscribeAudio = audioBuffer && (
        curMediaType === 'audioMessage' || mt.ptvMessage
        || (quotedType === 'audioMessage') // text reply to someone's VN
      );
      if (shouldTranscribeAudio) {
        try {
          await typing(jid, true);
          voiceTranscript = await tts.transcribe(audioBuffer, audioMime || 'audio/ogg');
          if (voiceTranscript) {
            logger.info({ len: voiceTranscript.length }, 'voice note transcribed');
          } else {
            logger.warn('voice transcription returned empty');
          }
        } catch (e) {
          logger.warn({ err: e.message }, 'voice transcription failed');
        }
      }
      let effectiveClean = voiceTranscript
        ? (cleanText ? `${cleanText}\n\n[Voice note transcript]: ${voiceTranscript}` : voiceTranscript)
        : (cleanText || ((curMediaType === 'audioMessage' || mt.ptvMessage)
          ? '[User sent a voice note but transcription failed. Ask them briefly to type it, or reply helpfully.]'
          : cleanText));

      // Coalesce rapid follow-ups from the same user (DM or group) into ONE agent turn.
      // Example: three quick texts → wait → single reply that understands all of them.
      // Media/attachments skip the wait so photos aren't delayed behind text debounce.
      if (effectiveClean && !mediaContent && !attachmentInfo) {
        try {
          // Show typing while we wait for possible follow-ups
          try { await typing(jid, true); } catch {}
          const merged = await coalesceUserText(memoryScope, effectiveClean);
          if (merged === null) {
            // A newer message from this user took over — stay silent on this one
            try { await typing(jid, false); } catch {}
            return;
          }
          if (merged && merged !== effectiveClean) {
            effectiveClean = merged;
            logger.info({
              scope: String(memoryScope).slice(0, 48),
              chars: merged.length,
              parts: (merged.match(/\[msg \d+\//g) || []).length || 1,
            }, 'coalesced rapid messages into one turn');
          }
        } catch (e) {
          logger.warn({ err: e.message }, 'coalesce failed — continuing with single message');
        }
      }

      // Energy-matched reaction on the inbound message (sparse, human-feeling).
      try {
        const e = energyEmoji(effectiveClean || rawText);
        if (e && msg?.key && Math.random() < 0.45) {
          await sock.sendMessage(jid, { react: { text: e, key: msg.key } }).catch(() => {});
        }
      } catch {}

      // Build the user turn: media (image/video/audio) block, and/or attachment info text.
      let userText;
      if (mediaContent) {
        userText = [
          { type: 'text', text: (effectiveClean || (curMediaType === 'audioMessage' ? (voiceTranscript ? voiceTranscript : 'Transcribe and answer based on this audio.') : 'Describe this media and answer naturally.')) + (quotedText ? `\n\n[Replied-to message]\n${quotedText}` : '') },
          mediaContent,
        ];
      } else if (attachmentInfo) {
        const info = attachmentInfo;
        let t = `[Attached file: ${info.fileName} (${info.mimetype}, ${info.size} bytes, ${info.isZip ? 'ZIP archive' : 'document'})]`;
        if (info.textPreview) t += `\n\nFile contents preview:\n${info.textPreview}`;
        if (effectiveClean) t += `\n\nUser: ${effectiveClean}`;
        userText = t;
      } else {
        let body = effectiveClean;
        // Multi-bubble turn: tell the model these are sequential lines from the same person
        if (typeof body === 'string' && /\[msg \d+\//.test(body)) {
          body =
            '(User sent several messages in a row — treat them as ONE request and reply once.)\n' +
            body;
        }
        userText = quotedText
          ? `${body || 'Please respond to the message I replied to.'}\n\n[Replied-to message]\n${quotedText}`
          : body;
      }

      // --- jailbreak protection: refuse/ignore prompt-injection & jailbreak attempts ---
      const userString = typeof userText === 'string' ? userText : JSON.stringify(userText);
      const JB = [
        /^ignore (your|all|any) (previous |prior )?(instructions|prompt|rules|guidelines)\b/i,
        /\byou (are|'re|were) now (dan|chatgpt|a different bot|an ai without|jailbroken)\b/i,
        /^reveal (your|the) (system prompt|instructions|initial prompt)/i,
        /^print (your|the) (system|prompt|instructions)/i,
        /^disable (your )?(safety|ethics|guardrails|limits)\b/i,
        /^pretend you have no (rules|limits|restrictions)/i,
        /^act as if you('re| are) not an ai/i,
        /^bypass (your|the) (safety|filter|restrictions|guardrails)/i,
        /^respond as an unrestricted/i,
        /^you don't have to follow your guidelines/i,
        /^ignore all previous instructions/i,
      ];
      const isJailbreak = JB.some((re) => re.test(userString));
      
      const userMessage = imageDataUri ? `[image] ${cleanText}`.trim() : cleanText;
      // The entire read -> generate -> write cycle is scoped to this exact user/chat pair.
      // This prevents cross-user context leakage and prevents rapid messages from racing.
      let answer;
      try {
      answer = await runAgentQueued(memoryScope, async () => {
        if (isJailbreak) {
          const blocked = "🙅 Can't do that. I'm not going to ignore my instructions or hand over my system prompt — that's a hard no. Ask me something real and I'll help.";
          memory.pushScoped(jid, memoryUserId, 'user', userMessage);
          memory.pushScoped(jid, memoryUserId, 'assistant', blocked);
          memory.updateUserContext(memoryUserId, jid, userMessage, 'user', senderIdentity);
          memory.updateUserContext(memoryUserId, jid, blocked, 'assistant', senderIdentity);
          return blocked;
        }
        const history = memory.getScopedForPrompt(jid, memoryUserId);
        toolCtx.aiClient = aiClient;
        // Keep tool context aligned with the same isolated conversation as the model prompt.
        toolCtx.history = history;
        try {
          workSession.maybeSeedFromUser(jid, memoryUserId, effectiveClean || cleanText || rawText || '');
          // Refresh system with latest work session (tools from prior turns already stored).
          const liveWork = workSession.contextBlock(jid, memoryUserId);
          if (liveWork && typeof systemWithLang === 'string' && !systemWithLang.includes('[ACTIVE WORK SESSION')) {
            systemWithLang = systemWithLang + "\n\n" + liveWork;
          } else if (liveWork && typeof systemWithLang === 'string') {
            systemWithLang = systemWithLang.replace(/\[ACTIVE WORK SESSION[\s\S]*?\]/, liveWork);
          }
        } catch {}
        
        // Hard rule for image edit / generate: never describe an edited image — always call the tool
        const editIntent = /\b(edit|change|replace|restyle|modify|redraw|fix the (logo|image|sign|banner)|make it say|change the text|add .* underneath)\b/i.test(String(effectiveClean || '') + String(quotedText || ''))
          || /\b(yeah|yes|do it|go ahead|send (it|the image)|generate (it|the)|edit (it|this))\b/i.test(String(effectiveClean || '').trim());
        const hasImg = !!(imageDataUri || aiTools.getLastChatImage?.(jid)?.dataUri);
        let systemEditBoost = '';
        if (hasImg && editIntent) {
          systemEditBoost = `\n\nCRITICAL IMAGE EDIT RULE (this turn):
- The user wants an EDITED IMAGE sent back into the chat.
- You MUST call generate_image NOW with a clear edit prompt describing the requested changes.
- Leave referenceImages empty — the image is already attached automatically.
- NEVER reply with only a text description, ASCII art, or a fake "[Image: ...]" placeholder.
- NEVER say "here's the edited logo" in text without calling generate_image.
- After the tool sends the real image, reply with at most one short line (or nothing).`;
        }

      try {
          training.observe(memoryUserId, effectiveClean || cleanText || rawText || '');
          training.observeFeedback(memoryUserId, effectiveClean || cleanText || '');
        } catch {}
        const trainBlock = (() => { try { return training.promptBlock(memoryUserId) || ''; } catch { return ''; } })();
        systemWithLang = (typeof systemWithLang === 'string' ? systemWithLang : system) + (systemEditBoost || '') + trainBlock;
        let result = await aiClient.runAgent({ system: systemWithLang, history, userText, toolCtx });

        // Final safety net: never let raw tool/function JSON leak into WhatsApp chat
        if (typeof result === 'string' && (/^\s*\{\s*"type"\s*:\s*"function"/i.test(result) || /"name"\s*:\s*"(analyze_zip|build_|generate_|fix_zip|send_)/i.test(result))) {
          logger.warn({ preview: result.slice(0, 100) }, 'router: stripped leaked tool JSON from answer');
          result = "Done — something glitched in the tool output. Try asking again.";
        }

        // Persist before releasing this user's queue so the next rapid message sees the
        // newly generated turn. No other user's queue can read this scope.
        memory.pushScoped(jid, memoryUserId, 'user', userMessage);
        memory.pushScoped(jid, memoryUserId, 'assistant', result);
        memory.updateUserContext(memoryUserId, jid, userMessage, 'user', senderIdentity);
        memory.updateUserContext(memoryUserId, jid, result, 'assistant', senderIdentity);
        // Report errors/explanations inline if the model included them
        // A short response is still a real response.  The old length gate
        // replaced useful replies such as "yes" with repetitive "Done. ✅".
        return String(result || '').trim();
      });
      } catch (agentErr) {
        logger.warn({ err: agentErr.message }, 'agent failed — recovering without ghosting');
        const isTimeout = agentErr.message && /timed out/i.test(agentErr.message);
        if (isTimeout) {
          // Smart timeout handling: if the task looks parallelizable, retry with sub-agents
          const _ut = typeof userText === 'string' ? userText : (Array.isArray(userText) ? userText.map((x) => (typeof x === 'string' ? x : (x?.text || ''))).join(' ') : String(userText || ''));
          const looksParallel = /\b(fix|build|deploy|clone|scan|analyze|research|compare|test)\b/i.test(_ut)
            || _ut.split(/\s+/).filter(Boolean).length > 5;
          if (looksParallel) {
            logger.info({ timeout: true, userText }, 'router: timeout detected — will retry with sub-agents');
            answer = `⏱️ That timed out. Splitting into parallel agents and retrying...`;
            // Re-run without the timeout constraint, letting sub-agents handle it
            try {
              const result2 = await runAgentQueued(memoryScope, async () => {
                const h2 = memory.getScopedForPrompt(jid, memoryUserId);
                toolCtx.history = h2;
                // Override timeout to 0 (unlimited) and let sub-agent logic handle it
                const r = await aiClient.runAgent({ system: (typeof systemWithLang === 'string' && systemWithLang) ? systemWithLang : (system || 'You are Broken.'), history: h2, userText, toolCtx, maxSteps: 40 });
                memory.pushScoped(jid, memoryUserId, 'user', userMessage);
                memory.pushScoped(jid, memoryUserId, 'assistant', r);
                memory.updateUserContext(memoryUserId, jid, userMessage, 'user', senderIdentity);
                memory.updateUserContext(memoryUserId, jid, r, 'assistant', senderIdentity);
                return r;
              });
              answer = result2;
            } catch (e2) {
              answer = `⚠️ Still stuck after retry: ${e2.message?.slice(0, 120)}`;
            }
          } else {
            answer = "⏱️ That took too long. Try breaking it into smaller steps or say it again.";
          }
        } else {
          answer = "⚠️ I hit a snag answering that. Try once more.";
        }
      }

      // If the model exhausted its tool-step budget, stay silent instead of sending
      // the old circular "try rephrasing" fallback. Deterministic commands/games above
      // still reply normally.
      if (!String(answer || '').trim()) {
        // Often happens after a successful tool (image/file already sent). Don't spam the chat.
        // One quiet retry via a short nudge only if nothing was likely delivered.
        try {
          logger.warn({ jid }, 'empty agent answer — skipping blank warning (tools may have already replied)');
        } catch {}
        return;
      }
      try {
        const rep = usageTracker.addUsage(userText || cleanText, answer);
        if (rep.warning && rep.pct >= 50 && rep.pct < 51) {
          // one-shot style: fire when crossing ~50%
          await sendText(jid, usageTracker.formatReport()).catch(() => {});
        } else if (rep.pct >= 80 && Math.random() < 0.15) {
          await sendText(jid, usageTracker.formatReport()).catch(() => {});
        }
      } catch {}

      // Pace the reply like a person: show "typing...", wait roughly as long as it'd
      // take to read + type the answer, then send. Keeps it well under WhatsApp's own
      // presence timeout so it doesn't look stuck.
      
    // pack add: text message replying to sticker
    if (isAddressed || !isGroup) {
      try {
        const tpack = String(cleanText || '').trim();
        if (/^pack\s+add\b/i.test(tpack) && (stickerBuffer || quotedStickerBuffer)) {
          const name = tpack.replace(/^pack\s+add\s*/i, '').trim() || 'default';
          const r = stickerPack.add(resolvedSenderJid || senderJid, name, stickerBuffer || quotedStickerBuffer);
          await sendText(jid, r.ok ? `✅ Added to pack *${name}* (${r.count}/30)` : `❌ ${r.error}`);
          return;
        }
      } catch {}
    }

    // Never leak tool XML/JSON into WhatsApp
      answer = String(answer || '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<tool_call>[\s\S]*$/gi, '')
        .replace(/<function\s*=\s*[^>]+>[\s\S]*?<\/function>/gi, '')
        .replace(/<function\s*=\s*[^>]+>[\s\S]*$/gi, '')
        .replace(/<parameter\s*=\s*[^>]+>[\s\S]*?<\/parameter>/gi, '')
        .replace(/\{\s*"type"\s*:\s*"function"[\s\S]*?\}/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!answer) return;

      await typing(jid, true);
      await new Promise((r) => setTimeout(r, humanDelayMs(answer)));

      // If the user spoke via a voice note / audio, reply with a voice note (UK female voice).
      const isAudioIn = curMediaType === 'audioMessage' || mt.ptvMessage;
      let sentMsg;
      const preferVoice = isAudioIn && Math.random() < 0.55;
      if (preferVoice) {
        try {
          const speech = await tts.speak(answer, { voice: process.env.TTS_VOICE || 'en-US-JennyNeural' });
          const buf = speech.buffer || (speech.file ? (await tts.toWhatsAppVoice(speech.file)).buffer : null);
          if (!buf) throw new Error('empty opus');
          sentMsg = await sendAudio(jid, buf, {
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            fileName: 'voice.ogg',
            quoted: msg,
          });
          try { if (speech.file) fs.unlink(speech.file, () => {}); } catch {}
        } catch (e) {
          sentMsg = await sendText(jid, answer, isGroup ? { mentions: [resolvedSenderJid], quoted: msg } : { quoted: msg });
        }
      } else {
        sentMsg = await sendText(jid, answer, isGroup ? { mentions: [resolvedSenderJid], quoted: msg } : { quoted: msg });
      }
      
      // Track sent message for auto-reply
      if (sentMsg?.key) {
        autoreply.addBotMessage(sentMsg.key);
      }

      // --- occasionally drop a random saved sticker into the conversation ---
      if (stickers.count() >= config.stickers.minSavedForRandomDrop && Math.random() < config.stickers.randomDropChance) {
        const random = stickers.getRandom();
        if (random) await sendSticker(jid, random).catch(() => {});
      }
    } catch (e) {
      logger.error({ err: e.message, stack: e.stack }, 'router error');
      try { dailyReport.bump('errors'); } catch {}
      const errMsg = String(e.message || '');
      const isTimeout = /timeout of \d+ms exceeded|ETIMEDOUT|ECONNABORTED/i.test(errMsg);
      const isEmpty = e.code === 'EMPTY_RESPONSE' || /empty response/i.test(errMsg);
      const is400 = /status code 400/i.test(errMsg) || e.response?.status === 400;
      const soft = /ECONNREFUSED|ENOTFOUND|timeout|429|rate limit/i.test(errMsg);
      if (isTimeout) {
        try {
          await sendText(jid, `⏳ That took a bit too long. Try again — or keep it simpler if it's a big request.`);
        } catch {}
      } else if (isEmpty) {
        // Auto-fallback already tried Agnes; only nudge once, briefly
        try {
          await sendText(jid, `⏳ One sec — retrying…`);
        } catch {}
        // Silent auto-retry once with force Agnes path is handled in client; avoid long error spam
      } else if (is400) {
        try {
          await sendText(jid, `⚠️ Request bounced. Already retried. Try again in a moment.`);
        } catch {}
      } else if (/502|Bad Gateway|Upstream request failed/i.test(errMsg)) {
        try {
          await sendText(jid, `⚠️ Upstream glitch (502). Trying again usually works — hang tight or resend.`);
        } catch {}
      } else if (/multimodal|enable-multimodal/i.test(errMsg)) {
        try {
          await sendText(jid, `⚠️ Image/vision hiccup on this model. Try again or send the text without the pic.`);
        } catch {}
      } else if (/single tool.?call/i.test(errMsg)) {
        try {
          await sendText(jid, `⚠️ Model hiccup on tools. Retrying should be fine — send again.`);
        } catch {}
      } else if (!soft) {
        // Useful hint + short fingerprint so we stop guessing in the dark.
        const short = String(errMsg || 'unknown').replace(/\s+/g, ' ').slice(0, 140);
        const hint =
          /No API key configured|api key|401|unauthorized|invalid.?key|authentication|Bearer/i.test(errMsg)
            ? `⚠️ AI auth failed. Set *AGNES_API_KEY* (main) and/or *APMIX_API_KEY* (coding) in panel env, restart. Owner: *model status*\n\`${short}\``
            : /empty response|422|no choices|blank content/i.test(errMsg)
              ? `⚠️ Model returned empty. Resend or owner: *model status*\n\`${short}\``
              : /403|404|model.?not.?found|does not exist|not available/i.test(errMsg)
                ? `⚠️ Model rejected. Owner: *model status* — check AGNES/APMIX model names.\n\`${short}\``
                : /ECONNREFUSED|ENOTFOUND|certificate|SSL|network/i.test(errMsg)
                  ? `⚠️ Network to AI provider failed.\n\`${short}\``
                  : `⚠️ Something glitched on my side. Try again in a sec.\n\`${short}\``;
        try { await sendText(jid, hint); } catch {}
      }
      await notifyOwnerError(`⚠️ *Error report*\nChat: ${jid}\nError: ${e.message}\n\n\`\`\`${String(e.stack || '').slice(0, 600)}\`\`\``);
    } finally {
      await typing(jid, false);
    }
    } catch (outerErr) {
      try {
        logger.error({ err: outerErr?.message, stack: outerErr?.stack }, 'handleIncoming crash');
        // Do not message the group for every internal crash — log + rate-limited owner DM only
        await notifyOwnerError(`⚠️ Handler crash: ${outerErr?.message}\n${String(outerErr?.stack || '').slice(0, 500)}`);
      } catch {}
    }
  }

  return { handleIncoming };
}

module.exports = { makeRouter, buildMenuText };
