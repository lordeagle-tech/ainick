// telegram/bridge.js — full Broken agent on Telegram (parity with WhatsApp features)
const config = require('../config');
const logger = require('../logger');
const { client } = require('./api');
const darkAgent = require('../features/darkAgent');
const { buildSystemPrompt } = require('../ai/persona');
const memory = require('../core/memory');
const obsidian = require('../features/obsidian');
const funFeed = require('../features/funFeed');
const funExtras = require('../features/funExtras');
const genQuota = require('../features/genQuota');
const dailyReport = require('../features/dailyReport');
const usageTracker = require('../features/usageTracker');
const tts = require('../features/tts');
const economy = require('../features/economy');
const { Collection } = require('../db');

// Telegram-specific mode (also mirrors global when admin toggles "public"/"private")
const tgMode = new Collection('telegram_mode', { mode: 'public' });
let botIdentity = { id: null, username: null };


function adminIds() {
  const fromEnv = (process.env.TELEGRAM_ADMIN_IDS || process.env.TELEGRAM_OWNER_IDS || process.env.TG_ADMIN_IDS || '')
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const fromConfig = (config.integrations?.telegramAdminIds || []).map(String);
  // Also accept pure-numeric OWNER_IDS entries as Telegram user ids (common mistake: put TG id only in OWNER_IDS)
  const fromOwners = (process.env.OWNER_IDS || process.env.OWNER_ID || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,15}$/.test(s));
  return [...new Set([...fromEnv, ...fromConfig, ...fromOwners])];
}

function isTgAdmin(userId, username) {
  const id = String(userId || '');
  if (adminIds().includes(id)) return true;
  // Username match: TELEGRAM_ADMIN_USERNAMES=name1,name2 (without @)
  const names = (process.env.TELEGRAM_ADMIN_USERNAMES || '')
    .split(/[,\s]+/)
    .map((s) => s.replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);
  if (username && names.includes(String(username).toLowerCase())) return true;
  return false;
}

function getTgMode() {
  const m = tgMode.get('mode', 'public');
  return m === 'private' ? 'private' : 'public';
}

function setTgMode(mode) {
  tgMode.set('mode', mode === 'private' ? 'private' : 'public');
  // Keep WhatsApp global mode in sync so one "private" locks both platforms
  try {
    obsidian.store.set('mode', mode === 'private' ? 'private' : 'public');
    if (mode !== 'private') obsidian.store.set('lockdown', false);
  } catch {}
  return getTgMode();
}

function canUseBot(userId) {
  if (isTgAdmin(userId)) return true;
  if (getTgMode() === 'private' || obsidian.isGlobalPrivate()) return false;
  return true;
}

async function downloadTgMedia(api, msg) {
  let fileId; let kind = 'document'; let fileName = 'file.bin'; let mime = 'application/octet-stream';
  if (msg.photo?.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    kind = 'image'; fileName = 'photo.jpg'; mime = 'image/jpeg';
  } else if (msg.video) {
    fileId = msg.video.file_id; kind = 'video';
    fileName = msg.video.file_name || 'video.mp4'; mime = msg.video.mime_type || 'video/mp4';
  } else if (msg.voice || msg.audio) {
    const a = msg.voice || msg.audio;
    fileId = a.file_id; kind = 'audio';
    fileName = msg.audio?.file_name || 'audio.ogg'; mime = a.mime_type || 'audio/ogg';
  } else if (msg.document) {
    fileId = msg.document.file_id; kind = 'document';
    fileName = msg.document.file_name || 'file.bin'; mime = msg.document.mime_type || 'application/octet-stream';
  } else if (msg.sticker) {
    fileId = msg.sticker.file_id; kind = 'sticker';
    fileName = 'sticker.webp'; mime = 'image/webp';
  }
  if (!fileId) return {};
  try {
    const meta = await api.getFile(fileId);
    const buffer = await api.downloadFile(meta.file_path);
    return { buffer, kind, fileName, mime, size: buffer.length };
  } catch (e) {
    logger.warn({ err: e.message }, 'tg media download failed');
    return {};
  }
}

function makeToolCtx(api, chatId, userId, msg, media) {
  const replyTo = msg.message_id;
  const sendText = async (text) => api.sendMessage(chatId, String(text || '').slice(0, 4090), { reply_to: replyTo });
  return {
    platform: 'telegram',
    chatId: `tg:${chatId}`,
    senderJid: `tg:${userId}`,
    originalSenderJid: `tg:${userId}`,
    isGroup: String(chatId).startsWith('-'),
    groupMeta: null,
    mentionedJids: [],
    repliedToJid: null,
    replyMessage: null,
    imageBuffer: media.kind === 'image' ? media.buffer : null,
    imageDataUri: media.kind === 'image' && media.buffer
      ? `data:${media.mime};base64,${media.buffer.toString('base64')}` : null,
    videoBuffer: media.kind === 'video' ? media.buffer : null,
    audioBuffer: media.kind === 'audio' ? media.buffer : null,
    documentBuffer: media.kind === 'document' ? media.buffer : null,
    stickerBuffer: media.kind === 'sticker' ? media.buffer : null,
    attachmentInfo: media.kind === 'document' ? {
      fileName: media.fileName, mimetype: media.mime, size: media.size,
      isZip: /\.zip$/i.test(media.fileName || ''),
    } : null,
    sock: {
      sendMessage: async (_jid, content) => {
        if (content?.text) return api.sendMessage(chatId, content.text, { reply_to: replyTo });
        if (content?.image) {
          const img = content.image.url || content.image;
          return api.sendPhoto(chatId, img, content.caption, { reply_to: replyTo });
        }
        if (content?.document) {
          return api.sendDocument(chatId, content.document, content.fileName || 'file.bin', content.caption, { reply_to: replyTo });
        }
        if (content?.video) {
          return api.sendVideo(chatId, content.video.url || content.video, content.caption, { reply_to: replyTo });
        }
        if (content?.audio) {
          return api.sendAudio(chatId, content.audio, { reply_to: replyTo, fileName: content.fileName });
        }
        return null;
      },
    },
    sendText,
    sendImage: async (src, caption) => { await api.sendPhoto(chatId, src, caption, { reply_to: replyTo }); return true; },
    sendVideo: async (src, caption) => { await api.sendVideo(chatId, src, caption, { reply_to: replyTo }); return true; },
    sendAudio: async (buf, opts = {}) => {
      await api.sendAudio(chatId, buf, { reply_to: replyTo, fileName: opts.fileName, caption: opts.caption });
      return true;
    },
    sendFile: async (buf, fileName, caption) => {
      await api.sendDocument(chatId, buf, fileName, caption, { reply_to: replyTo });
      return true;
    },
  };
}

const HELP = `*Broken on Telegram*

*Access (admin)*
• public / private / mode
• dark on | dark off | dark status

*Fun*
• meme · joke · comedy · laugh
• tweet · funny tweet · black twitter
• debate · tiktok · tiktok comedy
• quote · fact · flip · roll · weather <city>

*Utility*
• ping · help · ctx · usage · gen quota
• pack as zip (send/reply with a file first)
• daily report (admin)

*Agent*
Just chat normally — same tools as WhatsApp:
search, code, image/video gen, zip encrypt, site preview, docs, etc.

_Admin IDs: TELEGRAM_ADMIN_IDS in .env_`;

/** Deterministic commands — return true if handled */
async function tryCommands(api, chatId, userId, text, media, msg, admin) {
  const t = text.replace(/^(?:broken|@broken)\s+/i, '').trim();
  const reply = async (s) => api.sendMessage(chatId, s, { reply_to: msg.message_id });

  if (/^(help|menu|commands|start)$/i.test(t)) { await reply(HELP); return true; }
  if (/^ping$/i.test(t)) { await reply('🏓 pong — Telegram + WhatsApp brain online.'); return true; }

  // Mode
  if (admin && /^(public|private|lockdown|mode)$/i.test(t)) {
    if (/^public$/i.test(t)) {
      setTgMode('public');
      await reply('🔓 *Public* — anyone can use Broken on Telegram (and WhatsApp public).');
    } else if (/^private$/i.test(t) || /^lockdown$/i.test(t)) {
      setTgMode('private');
      await reply('🔒 *Private* — only Telegram admins.');
    } else {
      await reply(`🔐 TG mode: *${getTgMode()}*\nWA global: *${obsidian.getGlobalMode()}*\nDark: *${darkAgent.isEnabled() ? 'ON' : 'OFF'}*`);
    }
    return true;
  }

  // Dark agent
  if (admin && /\bdark(?:\s*[-_]?\s*agent)?\b/i.test(t) && /\b(on|off|status|enable|disable|turn)\b/i.test(t)) {
    const off = /\b(off|disable)\b/i.test(t);
    if (/\bstatus\b/i.test(t) && !/\b(on|off|enable|disable)\b/i.test(t)) {
      await reply(`🌑 Dark Agent is ${darkAgent.isEnabled() ? 'ON' : 'OFF'}`);
      return true;
    }
    darkAgent.setEnabled(!off && /\b(on|enable|turn)\b/i.test(t));
    await reply(darkAgent.isEnabled() ? '🌑 Dark Agent ON' : '🌑 Dark Agent OFF');
    return true;
  }
  if (admin && /^(dark(?:\s+agent)?|darkmode)$/i.test(t)) {
    await reply(`🌑 Dark Agent is ${darkAgent.isEnabled() ? 'ON' : 'OFF'}.\nSay *dark on* / *dark off*.`);
    return true;
  }

  if (/^(?:\/ctx|ctx|usage|token\s*usage)$/i.test(t)) {
    try { await reply(usageTracker.formatReport()); } catch { await reply('Usage tracker unavailable.'); }
    return true;
  }
  if (/^(gen\s*quota|quota|my\s*gens)$/i.test(t)) {
    const rem = genQuota.remaining(`tg:${userId}`);
    await reply(rem.unlimited
      ? '✨ Unlimited image/video gens (admin).'
      : `🎨 Gen quota: ${rem.used}/${rem.limit} used (6h window) · ${rem.left} left`);
    return true;
  }
  if (admin && /^(daily\s*report|report\s*today)$/i.test(t)) {
    await reply(dailyReport.formatReport());
    return true;
  }

  // Economy-ish
  if (/^(bal|balance|coins|wallet)$/i.test(t)) {
    const bal = economy.getBalance(`tg${userId}`);
    await reply(`💰 Balance: ${bal}`);
    return true;
  }
  if (/^daily$/i.test(t)) {
    const r = economy.claimDaily(`tg${userId}`);
    await reply(r.ok ? `🎁 Daily +${r.amount}! Balance: ${r.balance}` : `⏳ Come back in ${Math.ceil((r.seconds || 0) / 60)} min.`);
    return true;
  }
  if (/^work$/i.test(t)) {
    const r = economy.work(`tg${userId}`);
    await reply(r.ok ? `💼 ${r.text} +${r.amount}. Balance: ${r.balance}` : `⏳ Rest ${Math.ceil((r.seconds || 0) / 60)} min.`);
    return true;
  }

  // Fun feeds
  try {
    if (/^(meme|memes|dank\s*meme)$/i.test(t)) {
      await api.sendChatAction(chatId, 'upload_photo');
      const m = await funFeed.randomMeme();
      if (m.image) await api.sendPhoto(chatId, m.image, `😂 ${m.title}`, { reply_to: msg.message_id });
      else await reply(m.title || 'No meme');
      return true;
    }
    if (/^(funny\s*tweet|tweet|twitter\s*funny|black\s*twitter)$/i.test(t)) {
      const sub = /black/i.test(t) ? 'blacktwitter' : 'tweets';
      const r = await funFeed.funnyPosts(sub, 1);
      if (!r.ok) { await reply(r.error || 'No tweets'); return true; }
      const p = r.posts[0];
      if (p.image) await api.sendPhoto(chatId, p.image, `🐦 ${r.sub}`, { reply_to: msg.message_id });
      else await reply(`🐦 "${p.title}"`);
      return true;
    }
    if (/^(debate|debate\s*topic|unpopular\s*opinion)$/i.test(t)) {
      const d = await funFeed.debateTopic();
      if (!d.ok) { await reply(d.error || 'No topic'); return true; }
      if (d.image) await api.sendPhoto(chatId, d.image, '🗣 Debate — Agree or Disagree?', { reply_to: msg.message_id });
      else await reply(d.prompt || d.topic);
      return true;
    }
    if (/^(tiktok|funny\s*tiktok|tiktok\s*comedy)$/i.test(t)) {
      const tk = await funFeed.tiktokComedy();
      if (tk.image) await api.sendPhoto(chatId, tk.image, tk.caption || '🎬 Comedy', { reply_to: msg.message_id });
      else await reply(tk.caption || tk.error || '…');
      return true;
    }
    if (/^(comedy|joke|make\s*me\s*laugh|laugh)$/i.test(t)) {
      const c = await funFeed.comedyBit();
      if (c.image) await api.sendPhoto(chatId, c.image, '😂 Comedy', { reply_to: msg.message_id });
      else await reply(c.text || c.title || '…');
      return true;
    }
    if (/^(quote|motivate|motivation)$/i.test(t)) { await reply(funExtras.quote()); return true; }
    if (/^(fact|fun\s*fact)$/i.test(t)) { await reply(funExtras.fact()); return true; }
    if (/^(flip|coin\s*flip)$/i.test(t)) { await reply(funExtras.flip()); return true; }
    if (/^roll(?:\s+(\d+))?$/i.test(t)) {
      const sides = (t.match(/^roll(?:\s+(\d+))?$/i) || [])[1];
      await reply(funExtras.roll(sides));
      return true;
    }
    if (/^weather\s+(.+)/i.test(t)) {
      const city = t.replace(/^weather\s+/i, '').trim();
      const res = await funExtras.weather(city);
      await reply(res.ok ? res.text : `Weather failed: ${res.error}`);
      return true;
    }
  } catch (e) {
    await reply(`Feed error: ${e.message}`);
    return true;
  }

  // Pack media as zip
  if (/\b(pack|zip)\b/i.test(t) && media.buffer) {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile(media.fileName || 'file.bin', media.buffer);
      await api.sendDocument(chatId, zip.toBuffer(), 'media.zip', '📦 Packed', { reply_to: msg.message_id });
      return true;
    } catch (e) {
      await reply('Zip failed: ' + e.message);
      return true;
    }
  }

  return false;
}

/** Groups: only respond when tagged, replied-to-bot, named, or /command. DMs always. */
function isAddressedInGroup(msg, text) {
  const chatType = msg.chat?.type || '';
  const isPrivate = chatType === 'private';
  if (isPrivate) return true;

  // Always allow slash commands
  if (/^\//.test(String(text || '').trim())) return true;

  const botId = botIdentity.id;
  const botUser = (botIdentity.username || '').toLowerCase();
  const entities = msg.entities || msg.caption_entities || [];
  for (const e of entities) {
    if (e.type === 'mention' && botUser) {
      const slice = String(text || '').slice(e.offset, e.offset + e.length).toLowerCase();
      if (slice === `@${botUser}` || slice.includes(`@${botUser}`)) return true;
    }
    if (e.type === 'text_mention' && botId && String(e.user?.id) === String(botId)) return true;
  }
  // Reply to bot message
  const rt = msg.reply_to_message;
  if (rt?.from?.is_bot && botId && String(rt.from.id) === String(botId)) return true;
  if (rt?.from?.is_bot && botUser && String(rt.from.username || '').toLowerCase() === botUser) return true;

  // Bot name / "broken" call
  const names = [
    botUser,
    ...(config.behavior?.botNames || ['broken', 'agnes']),
  ].filter(Boolean).map((n) => String(n).toLowerCase());
  const lower = String(text || '').toLowerCase();
  for (const n of names) {
    if (!n) continue;
    const re = new RegExp(`(?:^|[^a-z0-9])@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i');
    if (re.test(lower)) return true;
  }

  // Opt-in always-respond for TG groups
  if (process.env.TELEGRAM_RESPOND_ALWAYS === 'true' || process.env.RESPOND_IN_GROUPS_ALWAYS === 'true') {
    return true;
  }
  return false;
}

async function handleMessage(api, aiClient, msg) {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (!chatId || !userId || msg.from?.is_bot) return;

  const text = String(msg.text || msg.caption || '').trim();
  const admin = isTgAdmin(userId, msg.from?.username);

  if (!canUseBot(userId)) {
    // Only reply about private mode in DMs or when addressed
    if (text && (msg.chat?.type === 'private' || isAddressedInGroup(msg, text))) {
      await api.sendMessage(chatId, '🔒 Private mode — only Telegram admins can use me. (Admin: send public to open.)');
    }
    return;
  }

  // Group ghost fix: do NOT answer every group message — require @bot / reply / name /command
  const isGroupChat = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';
  if (isGroupChat && !isAddressedInGroup(msg, text)) {
    return;
  }

  const media = await downloadTgMedia(api, msg);

  // Deterministic commands first
  if (text || media.buffer) {
    const handled = await tryCommands(api, chatId, userId, text || '', media, msg, admin);
    if (handled) return;
  }

  if (!text && !media.buffer) return;

  await api.sendChatAction(chatId, 'typing');

  // Voice → transcript
  let voiceTranscript = null;
  if (media.kind === 'audio' && media.buffer) {
    try {
      voiceTranscript = await tts.transcribe(media.buffer, media.mime);
    } catch (e) {
      logger.warn({ err: e.message }, 'tg voice transcribe failed');
    }
  }

  const toolCtx = makeToolCtx(api, chatId, userId, msg, media);
  // Gen quota identity for telegram users
  toolCtx.senderJid = `tg:${userId}`;

  let userText = text || (voiceTranscript ? voiceTranscript : (media.kind ? `[Sent a ${media.kind}]` : ''));
  if (voiceTranscript && text) userText = `${text}\n\n[Voice transcript]: ${voiceTranscript}`;
  else if (voiceTranscript) userText = voiceTranscript;

  if (media.kind === 'image' && media.buffer) {
    userText = [
      { type: 'text', text: text || voiceTranscript || 'Describe this image and help.' },
      { type: 'image_url', image_url: { url: `data:${media.mime};base64,${media.buffer.toString('base64')}` } },
    ];
  }

  const scopeId = `tg:${chatId}`;
  const userKey = `tg:${userId}`;
  const system = buildSystemPrompt({
    isGroup: toolCtx.isGroup,
    isAdmin: admin,
    senderName: msg.from?.username || msg.from?.first_name || String(userId),
    groupName: msg.chat?.title || '',
    userMemory: memory.getUserMemorySummary?.(userKey, 12) || '',
  }) + `\n\nPlatform: Telegram. Same capabilities as WhatsApp. Prefer tools for real actions. Never say you are a bot.`;

  const history = memory.getScopedForPrompt?.(scopeId, userKey) || memory.getScoped?.(scopeId, userKey) || [];

  try {
    const answer = await aiClient.runAgent({
      system,
      history: Array.isArray(history) ? history.slice(-12) : [],
      userText,
      toolCtx,
    });
    const out = String(answer || '').trim();
    if (out) {
      let buf = out;
      while (buf.length > 0) {
        await api.sendMessage(chatId, buf.slice(0, 4000), { reply_to: msg.message_id });
        buf = buf.slice(4000);
      }
    }
    try {
      memory.pushScoped?.(scopeId, userKey, 'user', typeof userText === 'string' ? userText : text || '[media]');
      memory.pushScoped?.(scopeId, userKey, 'assistant', out);
    } catch {}
  } catch (e) {
    logger.error({ err: e.message }, 'telegram agent error');
    await api.sendMessage(chatId, `Something broke: ${e.message}`).catch(() => {});
  }
}

async function startTelegram(aiClient) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || config.integrations?.telegramToken || '';
  if (!token) {
    logger.info('telegram: no TELEGRAM_BOT_TOKEN — Telegram bridge disabled');
    return null;
  }
  const api = client(token);
  const me = await api.getMe();
  botIdentity = { id: me.id, username: me.username || null };
  logger.info({ username: me.username, id: me.id, mode: getTgMode() }, 'telegram: connected');

  const admins = adminIds();
  if (!admins.length) {
    logger.warn('telegram: NO admin ids — set TELEGRAM_ADMIN_IDS=YOUR_NUMERIC_ID (from @userinfobot). OWNER_IDS with digits also works.');
  } else {
    logger.info({ admins }, 'telegram: admin ids loaded (must match your numeric id exactly)');
  }

  let offset = 0;
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const updates = await api.getUpdates(offset, 25);
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message) {
            handleMessage(api, aiClient, u.message).catch((e) =>
              logger.warn({ err: e.message }, 'tg handle failed')
            );
          }
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'telegram poll error');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  loop();
  return { stop: () => { stopped = true; }, api, me };
}

module.exports = { startTelegram, isTgAdmin, adminIds, getTgMode, setTgMode };
