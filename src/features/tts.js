// features/tts.js — reliable TTS for WhatsApp voice notes (Opus/OGG).
// Priority: free young-feminine sources → Edge neural → always ffmpeg → opus.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-tts-'));

// Young feminine neural voices (Edge)
const YOUNG_FEMALE = {
  en: 'en-US-JennyNeural',
  'en-us': 'en-US-JennyNeural',
  'en-gb': 'en-GB-SoniaNeural',
  'en-ng': 'en-NG-EzinneNeural',
  'en-au': 'en-AU-NatashaNeural',
  ar: 'ar-SA-ZariyahNeural',
  fr: 'fr-FR-DeniseNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
};

function pickVoice(text, preferred) {
  if (preferred) return preferred;
  const s = String(text || '');
  if (/[\u0600-\u06FF]/.test(s)) return YOUNG_FEMALE.ar;
  if (/[\u0400-\u04FF]/.test(s)) return YOUNG_FEMALE.ru;
  if (/[\u4E00-\u9FFF]/.test(s)) return YOUNG_FEMALE.zh;
  if (/[\u3040-\u30FF]/.test(s)) return YOUNG_FEMALE.ja;
  if (/\b(je|tu|vous|bonjour|merci)\b/i.test(s) && /[àâéèêëïôùûç]/i.test(s)) return YOUNG_FEMALE.fr;
  if (/\b(hola|gracias|porque|señor)\b/i.test(s)) return YOUNG_FEMALE.es;
  if (/\b(obrigad|você|não|sim)\b/i.test(s)) return YOUNG_FEMALE.pt;
  return process.env.TTS_VOICE || YOUNG_FEMALE.en;
}

function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  for (const c of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']) {
    try {
      if (c === 'ffmpeg') return c;
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function httpGetBuffer(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${u.protocol}//${u.host}${res.headers.location}`;
          res.resume();
          return resolve(httpGetBuffer(next, headers, redirects + 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400 || buf.length < 64) {
            return reject(new Error(`HTTP ${res.statusCode} (${buf.length}b)`));
          }
          resolve(buf);
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Google Translate TTS — free, no key, young female-ish default. Chunk long text. */
async function ttsGoogle(text, lang = 'en') {
  const clean = String(text || '').trim().slice(0, 180);
  if (!clean) throw new Error('empty tts text');
  const url =
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob` +
    `&q=${encodeURIComponent(clean)}&tl=${encodeURIComponent(lang)}`;
  const buf = await httpGetBuffer(url, {
    Referer: 'https://translate.google.com/',
  });
  // Google returns mp3
  if (buf[0] !== 0xff && buf[0] !== 0x49) {
    // not typical mp3/id3 — still accept if large enough
    if (buf.length < 500) throw new Error('google tts returned tiny payload');
  }
  return buf;
}

/** StreamElements / similar Google-backed TTS proxy (female voice). */
async function ttsStreamElements(text, voice = 'Amy') {
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) throw new Error('empty tts text');
  // Amy / Joanna / Salli are young-ish Amazon Polly female voices exposed by SE
  const url =
    `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}` +
    `&text=${encodeURIComponent(clean)}`;
  const buf = await httpGetBuffer(url);
  if (buf.length < 500) throw new Error('streamelements tiny payload');
  return buf;
}

/** Edge neural TTS (msedge-tts) — best quality young feminine when available. */
async function ttsEdge(text, voice) {
  let MsEdgeTTS, OUTPUT_FORMAT;
  try {
    ({ MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts'));
  } catch (e) {
    throw new Error('msedge-tts not installed');
  }
  const v = voice || YOUNG_FEMALE.en;
  const clean = String(text || 'Hello.').slice(0, 3500);
  const jobDir = fs.mkdtempSync(path.join(TMP, 'edge-'));
  const expected = path.join(jobDir, 'audio.mp3');
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(v, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const result = await tts.toFile(jobDir, clean);
    const produced = result?.audioFilePath || expected;
    if (!fs.existsSync(produced)) throw new Error('edge produced no file');
    const buf = fs.readFileSync(produced);
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    if (buf.length < 200) throw new Error('edge empty audio');
    return buf;
  } catch (e) {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

/** Convert any audio buffer/file to WhatsApp PTT Opus OGG. */
async function toWhatsAppVoice(input) {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg missing — cannot convert to Opus voice note.');

  let inputFile;
  let cleanupIn = false;
  if (Buffer.isBuffer(input)) {
    inputFile = path.join(TMP, `in_${Date.now()}.bin`);
    fs.writeFileSync(inputFile, input);
    cleanupIn = true;
  } else if (typeof input === 'string' && fs.existsSync(input)) {
    inputFile = input;
  } else {
    throw new Error('TTS audio input is missing');
  }

  const out = path.join(TMP, `vn_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);
  // WhatsApp PTT: OGG container + Opus, mono, low bitrate
  const attempts = [
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputFile, '-vn',
      '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip',
      '-ar', '16000', '-ac', '1', '-f', 'ogg', out],
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputFile, '-vn',
      '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-ar', '48000', '-ac', '1', '-f', 'ogg', out],
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputFile, '-vn',
      '-acodec', 'libopus', '-b:a', '24k', '-ac', '1', '-f', 'ogg', out],
  ];
  let lastErr;
  try {
    for (const args of attempts) {
      try {
        try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
        await execFileP(ffmpeg, args, { timeout: 45000 });
        if (!fs.existsSync(out) || fs.statSync(out).size < 100) throw new Error('empty ogg');
        const buffer = fs.readFileSync(out);
        // OggS magic
        if (buffer[0] !== 0x4f || buffer[1] !== 0x67) throw new Error('not ogg container');
        return {
          file: out,
          buffer,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Opus conversion failed: ${lastErr?.message || 'unknown'}`);
  } finally {
    if (cleanupIn) {
      try { fs.unlinkSync(inputFile); } catch {}
    }
  }
}

/**
 * Speak text → always returns Opus OGG voice-note ready payload.
 * opts.voice — Edge voice name (default young female Jenny)
 * opts.lang — ISO lang for Google fallback
 */
async function speak(text, opts = {}) {
  const clean = String(text || '').trim().slice(0, 3500);
  if (!clean) throw new Error('empty text');
  const voice = pickVoice(clean, opts.voice);
  const lang = opts.lang || (voice.startsWith('ar') ? 'ar' : voice.startsWith('fr') ? 'fr' : voice.startsWith('es') ? 'es' : voice.startsWith('pt') ? 'pt' : 'en');

  const errors = [];
  let mp3Buf = null;

  // 1) Edge neural young female (best quality)
  try {
    mp3Buf = await ttsEdge(clean, voice);
  } catch (e) {
    errors.push(`edge: ${e.message}`);
  }

  // 2) StreamElements Amy (young female Polly)
  if (!mp3Buf) {
    try {
      mp3Buf = await ttsStreamElements(clean, process.env.TTS_SE_VOICE || 'Amy');
    } catch (e) {
      errors.push(`se: ${e.message}`);
    }
  }

  // 3) Google Translate TTS (chunk if long)
  if (!mp3Buf) {
    try {
      if (clean.length <= 180) {
        mp3Buf = await ttsGoogle(clean, lang);
      } else {
        // stitch short chunks
        const parts = [];
        let rest = clean;
        while (rest.length && parts.length < 8) {
          let chunk = rest.slice(0, 160);
          const sp = chunk.lastIndexOf(' ');
          if (sp > 40) chunk = chunk.slice(0, sp);
          parts.push(await ttsGoogle(chunk, lang));
          rest = rest.slice(chunk.length).trim();
        }
        mp3Buf = Buffer.concat(parts);
      }
    } catch (e) {
      errors.push(`google: ${e.message}`);
    }
  }

  if (!mp3Buf || mp3Buf.length < 200) {
    throw new Error(`TTS failed (${errors.join(' | ') || 'no provider'})`);
  }

  // Always convert to Opus for WhatsApp VN
  const voiceNote = await toWhatsAppVoice(mp3Buf);
  return {
    file: voiceNote.file,
    dir: null,
    buffer: voiceNote.buffer,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
    source: errors.length ? `fallback(${errors.length})` : 'primary',
  };
}

async function transcribe(buffer, mime = 'audio/ogg') {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 64) return null;
  try {
    const aai = require('./assemblyai');
    if (aai.apiKey()) {
      const t = await aai.transcribe(buffer);
      if (t) return t;
    }
  } catch {}
  const key = process.env.OPENAI_API_KEY || process.env.AGNES_API_KEY;
  if (!key) return null;
  const base = (process.env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : (process.env.AI_BASE_URL || 'https://apihub.agnes-ai.com/v1')).replace(/\/$/, '');
  const inFile = path.join(TMP, `stt_in_${Date.now()}.ogg`);
  const wavFile = path.join(TMP, `stt_${Date.now()}.wav`);
  fs.writeFileSync(inFile, buffer);
  try {
    const ffmpeg = resolveFfmpeg();
    if (ffmpeg) {
      try {
        await execFileP(ffmpeg, ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', wavFile], { timeout: 30000 });
      } catch {}
    }
    const FormData = require('form-data');
    const form = new FormData();
    const useFile = fs.existsSync(wavFile) ? wavFile : inFile;
    form.append('file', fs.createReadStream(useFile), { filename: 'audio.wav' });
    form.append('model', 'whisper-1');
    const axios = require('axios');
    const r = await axios.post(`${base}/audio/transcriptions`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${key}` },
      timeout: 60000,
      maxContentLength: 50 * 1024 * 1024,
    });
    return r.data?.text || null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(wavFile); } catch {}
  }
}

module.exports = {
  resolveFfmpeg,
  speak,
  pickVoice,
  toWhatsAppVoice,
  transcribe,
  YOUNG_FEMALE,
};
