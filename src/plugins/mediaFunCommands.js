'use strict';

// Text-to-speech, QR decoding, media conversion, anime reactions and wallpapers.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const jsQR = require('jsqr');
const sharp = require('sharp');
const commandPrefix = require('./commandPrefix');
const tts = require('../features').tts;

const execFileP = promisify(execFile);
const UA = 'NickAI (https://github.com/lordeagle-tech/ainick)';
const API_TIMEOUT_MS = 15000;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

const REACTIONS = {
  hug: '🤗',
  pat: '🫶',
  slap: '👋',
  wave: '🌊',
  cuddle: '🫂',
  kiss: '💋',
  poke: '👉',
  cry: '😢',
  smile: '😊',
  dance: '💃',
  blush: '😳',
  bonk: '🔨',
  wink: '😉',
  nom: '😋',
  highfive: '🙌',
  handhold: '🤝',
  feed: '🍽️',
  tickle: '😆',
  smug: '😏',
  happy: '😄',
};
const REACTION_ALIASES = {
  smack: 'slap',
  glomp: 'hug',
  lick: 'nom',
};
const VOICE_HINTS = {
  en: 'en-US-JennyNeural',
  'en-us': 'en-US-JennyNeural',
  'en-gb': 'en-GB-SoniaNeural',
  'en-ng': 'en-NG-EzinneNeural',
  'en-au': 'en-AU-NatashaNeural',
  sw: 'sw-KE-ZuriNeural',
  fr: 'fr-FR-DeniseNeural',
  es: 'es-ES-ElviraNeural',
  de: 'de-DE-KatjaNeural',
  pt: 'pt-BR-FranciscaNeural',
  it: 'it-IT-ElsaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  ar: 'ar-SA-ZariyahNeural',
  hi: 'hi-IN-SwaraNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
};
const MEDIA_COMMANDS = new Set(['readqr', 'tomp3', 'tovn']);
const COMMAND_NAMES = new Set([
  'tts', 'wallpaper',
  ...MEDIA_COMMANDS,
  ...Object.keys(REACTIONS),
  ...Object.keys(REACTION_ALIASES),
]);
const menuCommands = [
  'tts <text>',
  'readqr', 'tomp3', 'tovn',
  'wallpaper <query>',
  ...Object.keys(REACTIONS).map((name) => `${name} [@user]`),
];

function parse(input) {
  const parsed = commandPrefix.parseCommand(String(input || ''));
  const text = parsed.text.trim();
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { parsed, text, name: (match?.[1] || '').toLowerCase(), tail: (match?.[2] || '').trim() };
}

function isCommand(input) {
  return COMMAND_NAMES.has(parse(input).name);
}

function isDeferredMediaCommand(input) {
  return MEDIA_COMMANDS.has(parse(input).name);
}

function safe(value, limit = 220) {
  return String(value || '').replace(/[\r\n`*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function multilineSafe(value, limit = 3000) {
  return String(value || '').replace(/`/g, "'").replace(/\r/g, '').slice(0, limit);
}

async function requestJson(url) {
  const response = await axios.get(url, {
    timeout: API_TIMEOUT_MS,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: () => true,
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404) throw new Error('not found');
    if (response.status === 403 || response.status === 429) throw new Error('provider rate limit reached — try again shortly.');
    throw new Error(`provider returned HTTP ${response.status}`);
  }
  return response.data;
}

async function fetchImage(url) {
  const response = await axios.get(url, {
    timeout: 30000,
    maxContentLength: MAX_MEDIA_BYTES,
    responseType: 'arraybuffer',
    validateStatus: () => true,
    headers: { Accept: 'image/*', 'User-Agent': UA },
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`image download returned HTTP ${response.status}`);
  const buffer = Buffer.from(response.data || []);
  const contentType = String(response.headers?.['content-type'] || '');
  if (!buffer.length || !/^image\//i.test(contentType)) throw new Error('the provider did not return an image');
  return buffer;
}

async function handleTts(ctx, tail) {
  if (!tail) {
    return { handled: true, text: [
      '╭─〘 *🔊 TEXT TO SPEECH* 〙',
      '┃❍ `tts <text>` — speak text as a voice note',
      '┃❍ `tts en|hello` / `tts sw|habari` — choose a voice',
      '╰──────────⊷',
    ].join('\n') };
  }
  if (!ctx?.sock || !ctx?.chatId) return { handled: true, text: 'TTS is unavailable in this context.' };

  let text = tail;
  let voice = null;
  const voiceMatch = tail.match(/^([A-Za-z-]{2,10})\|([\s\S]+)$/);
  if (voiceMatch && VOICE_HINTS[voiceMatch[1].toLowerCase()]) {
    voice = VOICE_HINTS[voiceMatch[1].toLowerCase()];
    text = voiceMatch[2].trim();
  }
  if (!text) return { handled: true, text: '❌ Give me some text to speak.' };
  if (text.length > 1000) text = `${text.slice(0, 1000)}…`;

  let speech = null;
  try {
    speech = await tts.speak(text, voice ? { voice } : {});
    const buffer = speech.buffer || (speech.file ? (await tts.toWhatsAppVoice(speech.file)).buffer : null);
    if (!buffer || !Buffer.isBuffer(buffer)) throw new Error('no audio was generated');
    await ctx.sock.sendMessage(ctx.chatId, {
      audio: buffer,
      mimetype: speech.mimetype || 'audio/ogg; codecs=opus',
      ptt: speech.ptt !== false,
      fileName: 'tts.ogg',
    });
    return { handled: true, text: null };
  } catch (error) {
    return { handled: true, text: `❌ TTS failed: ${safe(error?.message, 240)}` };
  } finally {
    try { if (speech?.file) fs.unlinkSync(speech.file); } catch {}
  }
}

async function handleWallpaper(ctx, tail) {
  if (!tail) {
    return { handled: true, text: '🖼️ Usage: `wallpaper <query>`\nExample: `wallpaper nature`' };
  }
  if (!ctx?.sock || !ctx?.chatId) return { handled: true, text: 'Wallpaper is unavailable in this context.' };
  const query = tail.slice(0, 120);
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${query} wallpaper`,
    gsrnamespace: '6',
    gsrlimit: '6',
    prop: 'imageinfo',
    iiprop: 'url',
    iiurlwidth: '1600',
    format: 'json',
  });

  try {
    const data = await requestJson(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
    const pages = Object.values(data?.query?.pages || {});
    const candidates = pages.map((page) => ({
      title: String(page.title || 'Wallpaper').replace(/^File:/i, ''),
      url: page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url || '',
    })).filter((item) => /^https?:\/\//i.test(item.url));
    if (!candidates.length) return { handled: true, text: `❌ No wallpapers found for "${safe(query, 100)}".` };

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const buffer = await fetchImage(pick.url);
    const source = `https://commons.wikimedia.org/wiki/${encodeURIComponent(pick.title.replace(/ /g, '_'))}`;
    await ctx.sock.sendMessage(ctx.chatId, {
      image: buffer,
      caption: `🖼️ *${safe(pick.title, 140)}*\n${source}`,
    });
    return { handled: true, text: null };
  } catch (error) {
    return { handled: true, text: `❌ Wallpaper failed: ${safe(error?.message, 240)}` };
  }
}

function mentionedJids(ctx) {
  const raw = Array.isArray(ctx?.mentions) ? ctx.mentions : ctx?.mentions instanceof Set ? [...ctx.mentions] : [];
  return raw.filter((jid) => typeof jid === 'string').slice(0, 3);
}

async function handleReaction(ctx, commandName) {
  const action = REACTION_ALIASES[commandName] || commandName;
  const emoji = REACTIONS[action] || '✨';
  if (!ctx?.sock || !ctx?.chatId) return { handled: true, text: 'Reactions are unavailable in this context.' };

  try {
    const data = await requestJson(`https://nekos.best/api/v2/${encodeURIComponent(action)}`);
    const url = data?.results?.[0]?.url || data?.url;
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('no reaction image returned');
    const buffer = await fetchImage(url);
    const mentions = mentionedJids(ctx);
    const tag = mentions.map((jid) => `@${String(jid).split('@')[0]}`).join(' ');
    const caption = `${tag ? `${tag} ` : ''}${action} ${emoji}`.trim();
    await ctx.sock.sendMessage(
      ctx.chatId,
      { video: buffer, gifPlayback: true, caption },
      mentions.length ? { mentions } : {}
    );
    return { handled: true, text: null };
  } catch (error) {
    if (safe(error.message) === 'not found') return { handled: true, text: `❌ No ${action} reaction is available right now.` };
    return { handled: true, text: `❌ ${action} failed: ${safe(error?.message, 240)}` };
  }
}

async function handleReadQr(ctx, imageBuffer) {
  if (!ctx?.sock || !ctx?.chatId) return { handled: true, text: 'QR reading is unavailable in this context.' };
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 32) {
    return { handled: true, text: 'Reply to an image with `readqr` and I will decode its QR code.' };
  }
  try {
    const { data, info } = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 2200, withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (!decoded?.data) return { handled: true, text: '❌ No readable QR code found in that image.' };
    return { handled: true, text: `✅ *QR decoded*\n${multilineSafe(decoded.data)}` };
  } catch (error) {
    return { handled: true, text: `❌ QR decode failed: ${safe(error?.message, 240)}` };
  }
}

function extensionForMime(mime) {
  const value = String(mime || '').toLowerCase();
  if (/mpeg|mp3/.test(value)) return '.mp3';
  if (/mp4|m4a/.test(value)) return '.m4a';
  if (/wav/.test(value)) return '.wav';
  if (/webm/.test(value)) return '.webm';
  if (/ogg|opus/.test(value)) return '.ogg';
  if (/aac/.test(value)) return '.aac';
  if (/flac/.test(value)) return '.flac';
  return '.ogg';
}

async function handleConvert(ctx, commandName, buffer, mime, isVideo = false) {
  if (!ctx?.sock || !ctx?.chatId) return { handled: true, text: 'Media conversion is unavailable in this context.' };
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 32) {
    return { handled: true, text: `Reply to a video or audio message with \`${commandName}\`, or send one with that caption.` };
  }

  const inputExt = isVideo ? '.mp4' : extensionForMime(mime || ctx.audioMime);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nickai-convert-'));
  const inputPath = path.join(dir, `input${inputExt}`);

  try {
    fs.writeFileSync(inputPath, buffer);
    if (commandName === 'tovn') {
      const voice = await tts.toWhatsAppVoice(inputPath);
      if (!voice.buffer || !Buffer.isBuffer(voice.buffer)) throw new Error('no voice note was produced');
      await ctx.sock.sendMessage(ctx.chatId, {
        audio: voice.buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        fileName: 'voice.ogg',
      });
      try { if (voice.file) fs.unlinkSync(voice.file); } catch {}
      return { handled: true, text: null };
    }

    const ffmpeg = tts.resolveFfmpeg();
    if (!ffmpeg) throw new Error('ffmpeg is not available');
    const outputPath = path.join(dir, 'output.mp3');
    await execFileP(ffmpeg, [
      '-y', '-v', 'error', '-i', inputPath, '-vn',
      '-acodec', 'libmp3lame', '-q:a', '5', outputPath,
    ], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    const mp3 = fs.readFileSync(outputPath);
    if (!mp3.length) throw new Error('ffmpeg produced an empty file');
    await ctx.sock.sendMessage(ctx.chatId, {
      document: mp3,
      mimetype: 'audio/mpeg',
      fileName: `audio_${Date.now()}.mp3`,
      caption: '🎵 Converted to MP3',
    });
    return { handled: true, text: null };
  } catch (error) {
    return { handled: true, text: `❌ ${commandName} failed: ${safe(error?.message, 240)}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function handleMedia(ctx, input, imageBuffer, videoBuffer, audioBuffer, audioMime) {
  const { parsed, name } = parse(input);
  if (!MEDIA_COMMANDS.has(name)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${parsed.text}\`` };
  }
  if (name === 'readqr') return handleReadQr(ctx, imageBuffer);
  return handleConvert(ctx, name, videoBuffer || audioBuffer, audioMime, !!videoBuffer);
}

async function route(ctx, input) {
  const { parsed, name, tail } = parse(input);
  if (!isCommand(input)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${parsed.text}\`` };
  }
  if (MEDIA_COMMANDS.has(name)) return { handled: false };
  if (name === 'tts') return handleTts(ctx, tail);
  if (name === 'wallpaper') return handleWallpaper(ctx, tail);
  if (COMMAND_NAMES.has(name)) return handleReaction(ctx, name);
  return { handled: false };
}

module.exports = {
  isCommand,
  isDeferredMediaCommand,
  route,
  handleMedia,
  menuCommands,
};
