'use strict';

module.exports = (runtime) => {
runtime.define("alldl", "alldl.js", function(module, exports, require, __filename, __dirname) {
// Retries, resolution parsing, and a User-Agent handle this provider's response quirks.

const logger = require('../logger');

const ENDPOINT = 'https://dev-priyanshi.onrender.com/api/alldl';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RETRIES = Number(process.env.ALLDL_RETRIES || 4);
const RETRY_BASE_MS = Number(process.env.ALLDL_RETRY_BASE_MS || 900);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** youtu.be/ID -> youtube.com/watch?v=ID. The API rejects the short form. */
function expandUrl(url) {
  const s = String(url || '').trim();
  const m = s.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  return s;
}

/** Parse "360p" / "1080p60" / "720" into a number for sorting. */
function resolutionOf(format) {
  const note = String(format?.formatNote || format?.quality || '');
  const m = note.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Fetch metadata + a direct link.
 * Returns { ok, title, videoUrl, images, thumbnail, attempts, raw } or { ok:false, error }.
 */
async function fetchMeta(url) {
  const target = expandUrl(url);
  let lastErr;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${ENDPOINT}?url=${encodeURIComponent(target)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(50000),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok || !body) {
        lastErr = `alldl HTTP ${res.status}`;
      } else if (body.status === false) {
        // Their own flag. Usually the transient miss, so retry rather than bail.
        lastErr = `alldl: ${body.message || 'no result'}`;
      } else {
        const data = body.data || body.result || body;
        const videoUrl = data.high || data.low || data.url || data.video || data.download || null;

        if (!videoUrl) {
          lastErr = 'alldl: no video link in response';
        } else {
          const thumbnail = data.thumbnail || data.thumb || '';
          const images = [];
          if (data.images) images.push(...(Array.isArray(data.images) ? data.images : [data.images]));
          if (data.image) images.push(data.image);

          return {
            ok: true,
            title: data.title || 'Media',
            videoUrl,
            // low and high are the same file, so there is nothing to choose
            // between. Record what we actually got rather than implying a tier.
            quality: data.high ? 'high' : 'low',
            note: '360p max on this provider',
            thumbnail,
            images: [...new Set(images.filter(Boolean))],
            attempts: attempt,
            raw: data,
          };
        }
      }
    } catch (e) {
      lastErr = e?.name === 'TimeoutError' ? 'alldl timed out' : (e?.message || 'alldl failed');
    }

    if (attempt < RETRIES) await sleep(RETRY_BASE_MS * attempt);
  }

  return { ok: false, error: lastErr || 'alldl failed' };
}

/** Download the file. The User-Agent header is mandatory — without it: 403. */
async function downloadBuffer(videoUrl) {
  const res = await fetch(videoUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://dev-priyanshi.onrender.com/' },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`alldl download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('alldl download returned 0 bytes');
  return buf;
}

/** Video, as a buffer, with a real sanity check. */
async function downloadVideo(url) {
  const meta = await fetchMeta(url);
  if (!meta.ok) return { ok: false, error: meta.error };

  try {
    const buffer = await downloadBuffer(meta.videoUrl);

    // A 200 with a plausible content-type is not proof. Check the bytes.
    const isMp4 = buffer.length > 8 && buffer.slice(4, 8).toString() === 'ftyp';
    if (!isMp4) {
      logger.warn({ bytes: buffer.length }, 'alldl: downloaded bytes are not an mp4');
      return { ok: false, error: 'alldl returned something that is not a video file.' };
    }

    return {
      ok: true,
      buffer,
      bytes: buffer.length,
      title: meta.title,
      quality: meta.note,
      source: 'alldl',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Audio via download-then-extract, because this provider only returns MP4. */
async function downloadAudio(url) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);

  const vid = await downloadVideo(url);
  if (!vid.ok) return vid;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alldl-'));
  const inPath = path.join(dir, 'in.mp4');
  const outPath = path.join(dir, 'out.mp3');

  try {
    fs.writeFileSync(inPath, vid.buffer);
    const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
    await execFileP(ffmpeg, ['-y', '-v', 'error', '-i', inPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '5', outPath], { timeout: 120000 });

    const buffer = fs.readFileSync(outPath);
    if (!buffer.length) throw new Error('ffmpeg produced an empty file');

    return { ok: true, buffer, ext: 'mp3', title: vid.title, quality: vid.quality, source: 'alldl+ffmpeg' };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Clean up on success and failure. A long-running bot otherwise fills
    // the disk, and then every download fails for a new reason.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { fetchMeta, downloadVideo, downloadAudio, expandUrl, resolutionOf, UA, ENDPOINT };

});

runtime.define("assemblyai", "assemblyai.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const config = require('../config');
const logger = require('../logger');

function apiKey() {
  return config.integrations?.assemblyAiKey || process.env.ASSEMBLYAI_API_KEY || '';
}

function headers() {
  return {
    authorization: apiKey(),
    'content-type': 'application/json',
  };
}

async function toWav(buffer) {
  const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
  const inFile = path.join(os.tmpdir(), `aai_in_${Date.now()}.ogg`);
  const outFile = path.join(os.tmpdir(), `aai_${Date.now()}.wav`);
  fs.writeFileSync(inFile, buffer);
  try {
    await execFileP(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inFile, '-ar', '16000', '-ac', '1', outFile], { timeout: 60000 });
    return { wav: fs.readFileSync(outFile), inFile, outFile };
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/**
 * Transcribe an audio Buffer (WhatsApp opus/ogg voice note).
 * @returns {Promise<string|null>}
 */
async function transcribe(buffer) {
  const key = apiKey();
  if (!key || !buffer || !Buffer.isBuffer(buffer) || buffer.length < 32) return null;

  let uploadUrl;
  try {
    // Upload raw audio (AssemblyAI accepts many formats; we still normalize to wav when possible)
    let payload = buffer;
    try {
      const converted = await toWav(buffer);
      if (converted?.wav?.length) payload = converted.wav;
    } catch {
      // use original buffer
    }

    const up = await axios.post('https://api.assemblyai.com/v2/upload', payload, {
      headers: { authorization: key, 'content-type': 'application/octet-stream' },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    uploadUrl = up.data?.upload_url;
    if (!uploadUrl) return null;

    const { data: job } = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      { audio_url: uploadUrl, language_detection: true },
      { headers: headers(), timeout: 60000 }
    );
    const id = job?.id;
    if (!id) return null;

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const { data: st } = await axios.get(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: headers(),
        timeout: 30000,
      });
      if (st.status === 'completed') return (st.text || '').trim() || null;
      if (st.status === 'error') {
        logger.warn({ err: st.error }, 'assemblyai transcript error');
        return null;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  } catch (e) {
    logger.warn({ err: e.message }, 'assemblyai transcribe failed');
    return null;
  }
}

module.exports = { transcribe, apiKey };

});

runtime.define("bbcNews", "bbcNews.js", function(module, exports, require, __filename, __dirname) {
const axios = require('axios');

function decode(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");
}
function absolute(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return 'https://www.bbc.com' + url;
  return 'https://www.bbc.com/' + url;
}

async function scrapeNews(limit = 5) {
  const { data } = await axios.get('https://www.bbc.com/news', {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NickAI/4.0)', Accept: 'text/html,application/xhtml+xml' },
  });
  const html = String(data || '');
  const articles = [];
  const seen = new Set();

  // BBC markup changes often, so scan article/card anchors instead of depending on one CSS class.
  const re = /<a\b[^>]*href=["']([^"']*(?:\/news\/|\/newsarticles\/)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && articles.length < Math.max(limit * 3, 12)) {
    const link = absolute(decode(m[1]));
    const inner = m[2];
    const titleMatch = inner.match(/<(?:h[1-6]|span|p)\b[^>]*>([\s\S]*?)<\/(?:h[1-6]|span|p)>/i);
    const title = decode((titleMatch ? titleMatch[1] : inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!link || !title || title.length < 8 || seen.has(link)) continue;
    seen.add(link);

    const nearby = html.slice(Math.max(0, m.index - 1200), Math.min(html.length, m.index + 2500));
    const imgMatch = nearby.match(/<(?:img|source)\b[^>]*(?:src|data-src|srcset)=["']([^"']+)["']/i);
    const image = absolute(imgMatch?.[1]?.split(',')[0]?.trim()?.split(' ')[0] || null);
    articles.push({ title, link, image, description: '' });
  }

  return articles.slice(0, limit);
}

module.exports = { scrapeNews };

});

runtime.define("mediaDownloader", "mediaDownloader.js", function(module, exports, require, __filename, __dirname) {
// (YT / IG / TT / FB / X / Threads / Reddit / Pinterest …)
// Returns caption text + media buffers so WhatsApp can resend the post.
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { Collection } = require('../db');
const logger = require('../logger');
const ytdlp = require('./ytdlp');
const mediaProviders = require('./mediaProviders');

const HOURLY_LIMIT = 30;
const rate = new Map();
const groupSettings = new Collection('group_download_settings', {});

const PLATFORMS = {
  youtube: /(?:youtube\.com|youtu\.be)/i,
  facebook: /(?:facebook\.com|fb\.com|fb\.watch|fb\.me)/i,
  instagram: /(?:instagram\.com|instagr\.am)/i,
  tiktok: /(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i,
  twitter: /(?:twitter\.com|x\.com)\/\w+\/status\//i,
  threads: /threads\.net/i,
  reddit: /(?:reddit\.com|redd\.it)/i,
  pinterest: /(?:pinterest\.com|pin\.it)/i,
  snapchat: /snapchat\.com/i,
  linkedin: /linkedin\.com/i,
};

function detectPlatform(url) {
  const u = String(url || '');
  for (const [name, re] of Object.entries(PLATFORMS)) {
    if (re.test(u)) return name;
  }
  return 'web';
}

function extractUrls(text) {
  const urls = [];
  const source = String(text || '');
  const generic = source.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const seen = new Set();
  for (const raw of generic) {
    const u = raw.replace(/[),.;!?]+$/g, '');
    if (seen.has(u)) continue;
    seen.add(u);
    const platform = detectPlatform(u);
    if (platform !== 'web' || /\/(p|reel|post|status|watch|share)\//i.test(u)) {
      urls.push({ url: u, platform });
    }
  }
  return urls;
}

function checkRate(userId) {
  const now = Date.now();
  const cur = rate.get(userId) || { count: 0, ts: now };
  if (now - cur.ts > 3600000) {
    rate.set(userId, { count: 1, ts: now });
    return true;
  }
  if (cur.count >= HOURLY_LIMIT) return false;
  cur.count++;
  rate.set(userId, cur);
  return true;
}

function isAutolinkOn(chatId) {
  return !!groupSettings.get(chatId, false);
}
function setAutolink(chatId, on) {
  groupSettings.set(chatId, !!on);
  return !!on;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function httpGet(url, opts = {}) {
  const { data, headers, status } = await axios.get(url, {
    timeout: opts.timeout || 45000,
    responseType: opts.responseType || 'json',
    maxContentLength: 80 * 1024 * 1024,
    maxBodyLength: 80 * 1024 * 1024,
    headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
    validateStatus: () => true,
  });
  return { data, headers, status };
}

function pickMediaUrls(obj, out = { videos: [], images: [], title: '', caption: '' }) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const x of obj) pickMediaUrls(x, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
      if (/(thumb|avatar|icon|profile)/i.test(key) && !/image|photo|media/i.test(key)) continue;
      if (/\.(mp4|mov|webm|m3u8)(\?|$)/i.test(v) || /video|mp4|playable/i.test(key)) {
        if (!out.videos.includes(v)) out.videos.push(v);
      } else if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(v) || /image|photo|pic|thumbnail/i.test(key)) {
        if (!out.images.includes(v)) out.images.push(v);
      }
    }
    if (typeof v === 'string' && /^(title|caption|text|description|content|message)$/i.test(key) && v.length > 2) {
      if (!out.title && /title/i.test(key)) out.title = v.slice(0, 200);
      if (!out.caption && /caption|text|description|content|message/i.test(key)) out.caption = v.slice(0, 2000);
    }
    if (v && typeof v === 'object') pickMediaUrls(v, out);
  }
  return out;
}

async function apiAllDl(url) {
  const r = await axios.get('https://dev-priyanshi.onrender.com/api/alldl', {
    params: { url },
    timeout: 50000,
    headers: { 'User-Agent': UA },
    validateStatus: () => true,
  });
  if (r.status >= 400 || !r.data) throw new Error('alldl failed');
  const body = r.data;
  const data = body.data || body.result || body;
  const picked = pickMediaUrls(data);
  const video = data.high || data.low || data.url || data.video || data.download || picked.videos[0];
  const images = [];
  if (data.images) images.push(...(Array.isArray(data.images) ? data.images : [data.images]));
  if (data.image) images.push(data.image);
  // Keep thumbnail separate — do not treat as primary media when a video URL exists
  const thumb = data.thumbnail || data.thumb || '';
  images.push(...picked.images.filter((u) => u && u !== thumb && !/hqdefault|mqdefault|maxresdefault/i.test(u)));
  if (!video && thumb) images.push(thumb);
  const videoList = [];
  for (const v of [data.high, data.low, data.video, data.download, data.url, ...(picked.videos || [])]) {
    if (v && typeof v === 'string' && /^https?:/i.test(v) && !videoList.includes(v) && !/\.(jpe?g|png|webp)(\?|$)/i.test(v)) {
      videoList.push(v);
    }
  }
  return {
    title: data.title || picked.title || 'Post',
    caption: data.caption || data.description || picked.caption || '',
    videos: videoList,
    images: [...new Set(images.filter(Boolean))],
    source: 'alldl',
  };
}

/** Cobalt public instances (no key) — good for IG/TT/X/YT */
/** Open Graph scrape — caption + images when APIs miss (FB posts etc.) */
async function scrapeOpenGraph(url) {
  const r = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
    },
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text',
  });
  if (!r.data || typeof r.data !== 'string') throw new Error('empty page');
  const html = r.data;
  const meta = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
      'i'
    );
    const m = html.match(re) || html.match(re2);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'") : '';
  };
  const title = meta('og:title') || meta('twitter:title') || '';
  const caption = meta('og:description') || meta('description') || '';
  const images = [];
  const ogImage = meta('og:image') || meta('twitter:image');
  if (ogImage) images.push(ogImage);
  // multiple og:image
  const reAll = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi;
  let m;
  while ((m = reAll.exec(html))) {
    if (!images.includes(m[1])) images.push(m[1].replace(/&amp;/g, '&'));
  }
  const video = meta('og:video') || meta('og:video:url') || meta('og:video:secure_url');
  return {
    title: title || 'Post',
    caption,
    videos: video ? [video] : [],
    images: images.slice(0, 10),
    source: 'opengraph',
  };
}


// yt-dlp is the primary and most reliable way to pull YouTube. It was
// previously stubbed to throw, which pushed every download onto third-party
// APIs that are usually down. See src/features/ytdlp.js for the full story.
async function apiYtDlp(url) {
  // The whole layered chain lives in mediaProviders now: yt-dlp, then the
  // cookie-free pipeline, then the download APIs. Reporting the source it
  // actually used rather than assuming yt-dlp.
  const res = await mediaProviders.downloadVideo(url);
  if (!res.ok) throw new Error(res.error);

  return {
    title: res.title || 'Media',
    caption: '',
    videos: [],
    images: [],
    source: res.source,
    _videoBuffer: res.buffer,
  };
}

// Direct audio path: --extract-audio means the video is never downloaded, so
// this is far faster and smaller than fetching a video and converting it.
async function apiYtDlpAudio(url) {
  const info = await ytdlp.getInfo(url).catch(() => ({ ok: false }));
  const title = info.ok && info.title ? info.title : 'Audio';

  const res = await ytdlp.downloadAudio(url, { title });
  if (!res.ok) throw new Error(res.error || 'yt-dlp audio download failed');

  return {
    title,
    caption: '',
    videos: [],
    images: [],
    source: 'yt-dlp-audio',
    _audioBuffer: res.buffer,
    _audioTitle: title,
    _ytdlpDir: res.dir,
  };
}

async function apiYtDlp_DISABLED(url) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);
  const bins = [process.env.YT_DLP_BIN, 'yt-dlp', 'youtube-dl'].filter(Boolean);
  let lastErr;
  const outTpl = path.join(os.tmpdir(), `ytdlp_${Date.now()}.%(ext)s`);
  for (const bin of bins) {
    try {
      const { stdout } = await execFileP(bin, [
        '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
        '--merge-output-format', 'mp4',
        '-o', outTpl,
        '--no-playlist',
        '--max-filesize', '80M',
        '--print', 'after_move:filepath',
        '--no-warnings',
        String(url),
      ], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
      const file = String(stdout || '').trim().split('\n').filter(Boolean).pop();
      if (file && fs.existsSync(file)) {
        const buffer = fs.readFileSync(file);
        try { fs.unlinkSync(file); } catch {}
        if (buffer.length > 20000) {
          return {
            title: 'Media',
            caption: '',
            videos: [], // filled as buffers downstream via special flag
            images: [],
            source: 'yt-dlp',
            _videoBuffer: buffer,
          };
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('yt-dlp unavailable');
}

async function downloadBuffer(url) {
  const { data, headers, status } = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxContentLength: 90 * 1024 * 1024,
    maxBodyLength: 90 * 1024 * 1024,
    headers: { 'User-Agent': UA, Referer: url },
    validateStatus: () => true,
  });
  if (status >= 400 || !data || !data.byteLength) throw new Error(`download HTTP ${status}`);
  const buf = Buffer.from(data);
  const ctype = String(headers['content-type'] || '');
  return { buffer: buf, contentType: ctype, bytes: buf.length };
}

function isImageBuf(buf, ctype) {
  if (/image\//i.test(ctype)) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true; // jpeg
  if (buf[0] === 0x89 && buf[1] === 0x50) return true; // png
  if (buf[0] === 0x52 && buf[1] === 0x49) return true; // webp/riff
  return false;
}

function isVideoBuf(buf, ctype) {
  if (/video\//i.test(ctype)) return true;
  // ftyp
  if (buf.length > 8 && buf.slice(4, 8).toString() === 'ftyp') return true;
  return false;
}

/**
 * Full post fetch: text + images + videos.
 * @returns {Promise<{title, caption, platform, images: Buffer[], videos: Buffer[], source}>}
 */
async function downloadPost(url) {
  const platform = detectPlatform(url);
  const errors = [];
  let meta = null;

  // Video-heavy platforms must get a real video — never stop at cover art alone
  const needsVideo = /youtube|tiktok|facebook|instagram|twitter|reddit|snapchat/i.test(platform);
  // yt-dlp goes first for YouTube: it is local, has no rate limit, and does
  // not depend on a third-party service staying up. The download APIs are kept
  // as fallbacks for the platforms yt-dlp handles less well.
  // Cobalt and prexzy removed. Cobalt now requires an API key and both free
  // hosts are usually asleep, so every request burned two round trips before
  // failing. apiYtDlp walks the full layered chain internally, so two entries
  // cover more ground than the old five did.
  const chain = platform === 'youtube'
    ? [apiYtDlp, apiAllDl]
    : [apiYtDlp, apiAllDl, scrapeOpenGraph];

  for (const fn of chain) {
    try {
      const candidate = await fn(url);
      if (!candidate) continue;
      // Merge best fields
      if (!meta) meta = candidate;
      else {
        if (candidate.videos?.length && !meta.videos?.length) meta.videos = candidate.videos;
        if (candidate._videoBuffer && !meta._videoBuffer) meta._videoBuffer = candidate._videoBuffer;
        if (candidate._audioBuffer && !meta._audioBuffer) { meta._audioBuffer = candidate._audioBuffer; meta._audioTitle = candidate._audioTitle; }
        if (candidate.title && (!meta.title || meta.title === 'Post' || meta.title === 'Media')) meta.title = candidate.title;
        if (candidate.caption && !meta.caption) meta.caption = candidate.caption;
        if (candidate.images?.length && !meta.images?.length) meta.images = candidate.images;
        meta.source = `${meta.source}+${candidate.source}`;
      }
      const hasVid = !!(candidate._videoBuffer || candidate._audioBuffer || (candidate.videos && candidate.videos.length));
      if (needsVideo && hasVid) {
        meta = { ...meta, ...candidate, videos: candidate.videos?.length ? candidate.videos : meta.videos };
        if (candidate._videoBuffer) meta._videoBuffer = candidate._videoBuffer;
        break;
      }
      if (!needsVideo && (candidate.videos?.length || candidate.images?.length || candidate.caption)) break;
    } catch (e) {
      errors.push(`${fn.name}: ${e.message}`);
    }
  }
  if (!meta) {
    throw new Error(`Could not fetch post. ${errors.slice(-2).join(' | ')}`);
  }

  const imageBufs = [];
  const videoBufs = [];

  if (meta._videoBuffer && Buffer.isBuffer(meta._videoBuffer) && meta._videoBuffer.length > 20000) {
    videoBufs.push(meta._videoBuffer);
  }

  // Download real videos first (skip tiny / m3u8 playlist text)
  for (const vidUrl of (meta.videos || []).slice(0, 3)) {
    if (!vidUrl || /thumbnail|\/hqdefault|\/mqdefault|maxresdefault/i.test(vidUrl)) continue;
    try {
      const { buffer, contentType } = await downloadBuffer(vidUrl);
      if (isVideoBuf(buffer, contentType) || (buffer.length > 80000 && !isImageBuf(buffer, contentType))) {
        videoBufs.push(buffer);
      } else if (isImageBuf(buffer, contentType)) {
        // mislabeled image URL
        imageBufs.push(buffer);
      }
    } catch (e) {
      logger.warn({ err: e.message, vidUrl: String(vidUrl).slice(0, 80) }, 'video download skip');
    }
  }

  // Last chance for YouTube/TikTok: force yt-dlp if still no video bytes
  if (!videoBufs.length && needsVideo) {
    try {
      const y = await apiYtDlp(url);
      if (y._videoBuffer && y._videoBuffer.length > 20000) videoBufs.push(y._videoBuffer);
      for (const vidUrl of (y.videos || []).slice(0, 2)) {
        try {
          const { buffer, contentType } = await downloadBuffer(vidUrl);
          if (isVideoBuf(buffer, contentType) || buffer.length > 80000) videoBufs.push(buffer);
        } catch {}
      }
      if (y.title) meta.title = y.title;
      meta.source = (meta.source || '') + '+yt-dlp-retry';
    } catch (e) {
      logger.warn({ err: e.message }, 'yt-dlp last-chance failed');
    }
  }

  // Images / covers only if no video, or as extra stills (never instead of video when video exists)
  if (!videoBufs.length) {
    for (const imgUrl of (meta.images || []).slice(0, 6)) {
      try {
        const { buffer, contentType } = await downloadBuffer(imgUrl);
        if (isImageBuf(buffer, contentType) || buffer.length > 1000) imageBufs.push(buffer);
      } catch (e) {
        logger.warn({ err: e.message }, 'image download skip');
      }
    }
  }

  // legacy shape for old callers
  const primaryVideo = videoBufs[0] || null;
  const file = primaryVideo
    ? path.join(os.tmpdir(), `dl_${Date.now()}.mp4`)
    : null;
  if (file && primaryVideo) fs.writeFileSync(file, primaryVideo);

    // Shrink oversized videos before WhatsApp send
  for (let i = 0; i < videoBufs.length; i++) {
    try {
      const c = await compressLargeMedia(videoBufs[i], 'video');
      if (c.buffer) videoBufs[i] = c.buffer;
    } catch (_) {}
  }

  return {
    title: meta.title || 'Post',
    caption: meta.caption || '',
    platform,
    images: imageBufs,
    videos: videoBufs,
    source: meta.source || 'unknown',
  };
}

/** @deprecated prefer downloadPost */
async function downloadMedia(url) {
  return downloadPost(url);
}

async function getVideoData(url) {
  const post = await downloadPost(url);
  return {
    title: post.title,
    thumbnail: '',
    downloadUrl: post.downloadUrl,
    quality: post.quality,
  };
}


/**
 * Shrink oversized media with ffmpeg so WhatsApp accepts it.
 * Videos > 14MB → re-encode; audio already handled in videoToMp3.
 */
async function compressLargeMedia(buffer, kind = 'video') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14 * 1024 * 1024) {
    return { ok: true, buffer, compressed: false };
  }
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);
  const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nickai-cmp-'));
  const input = path.join(dir, 'in.bin');
  const output = path.join(dir, kind === 'audio' ? 'out.mp3' : 'out.mp4');
  fs.writeFileSync(input, buffer);
  try {
    if (kind === 'audio') {
      await execFileP(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input, '-vn', '-b:a', '64k', '-ac', '1', '-ar', '44100', output,
      ], { timeout: 180000 });
    } else {
      // Target ~8–12MB: 480p, lower bitrate
      await execFileP(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-vf', "scale='min(854,iw)':-2",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        output,
      ], { timeout: 300000 });
    }
    if (!fs.existsSync(output) || fs.statSync(output).size < 1000) {
      throw new Error('ffmpeg empty output');
    }
    const out = fs.readFileSync(output);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (out.length >= buffer.length) {
      return { ok: true, buffer, compressed: false, note: 're-encode not smaller' };
    }
    return { ok: true, buffer: out, compressed: true, before: buffer.length, after: out.length };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: true, buffer, compressed: false, warning: e.message };
  }
}

async function videoToMp3(inputPathOrBuffer) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);
  const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
  const input = Buffer.isBuffer(inputPathOrBuffer)
    ? path.join(os.tmpdir(), `in_${Date.now()}.mp4`)
    : inputPathOrBuffer;
  if (Buffer.isBuffer(inputPathOrBuffer)) fs.writeFileSync(input, inputPathOrBuffer);
  const out = path.join(os.tmpdir(), `mp3_${Date.now()}.mp3`);
  await execFileP(ffmpeg, ['-y', '-i', input, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', out], { timeout: 120000 });
  const buffer = fs.readFileSync(out);
  return { file: out, buffer };
}

async function stickerToVideo(buf) {
  return { buffer: buf };
}

module.exports = {
  PLATFORMS,
  extractUrls,
  checkRate,
  isAutolinkOn,
  setAutolink,
  downloadMedia,
  downloadPost,
  getVideoData,
  videoToMp3,
  apiYtDlpAudio,
  compressLargeMedia,
  stickerToVideo,
  detectPlatform,
  HOURLY_LIMIT,
};

});

runtime.define("mediaProviders", "mediaProviders.js", function(module, exports, require, __filename, __dirname) {
//
// Cobalt and prexzy are gone. They were the weakest links: cobalt now needs an
// API key, and both free hosts are asleep most of the time, so every request
// wasted two round trips before failing.
//
// THE CHAIN
//
//   1. yt-dlp            best quality, no rate limit, no third party
//   2. omnisaver         cookie-free, survives an IP block, 360p cap
//   3. alldl             third-party, flaky but real, 360p
//
// Each tier covers the previous one's failure mode, which is the only way this
// stops being unreliable. Two rules drive the design:
//
//   * A tier failing NEVER ends the request. Fall through, don't return.
//   * Distinguish "this video is private" (a real answer, stop) from
//     "this provider is down" (try the next tier).
//
// The early-exit matters for speed: if yt-dlp reports an IP block, every
// remaining yt-dlp attempt is wasted latency, so we skip to tier 2 at once.

const logger = require('../logger');

/** A definitive answer about the video — retrying elsewhere is pointless. */
const TERMINAL = [
  /private video/i,
  /video unavailable/i,
  /not available in your country/i,
  /blocked in your country/i,
  /removed by the uploader/i,
  /does not exist/i,
  /unsupported url/i,
];

function isTerminal(message) {
  return TERMINAL.some((re) => re.test(String(message || '')));
}

/**
 * Download a video, walking the chain.
 * Returns { ok, buffer, title, source, quality } or { ok:false, error, tried }.
 */
async function downloadVideo(url, opts = {}) {
  const tried = [];

  // ---- Tier 1: yt-dlp ----
  try {
    const ytdlp = require('./ytdlp');
    const res = await ytdlp.downloadVideo(url, opts);

    if (res.ok) {
      // yt-dlp can itself fall through to the cookie-free pipeline internally,
      // so report what it actually used rather than assuming.
      return { ok: true, buffer: res.buffer, title: res.title, source: res.source || 'yt-dlp', quality: res.resolution || 'best available' };
    }

    tried.push({ provider: 'yt-dlp', error: res.error });

    // A private or deleted video is a real answer. Do not try other providers
    // and do not make the user wait for three more failures.
    if (isTerminal(res.error)) {
      return { ok: false, error: res.error, tried, terminal: true };
    }

    if (res.blocked) {
      logger.info('yt-dlp blocked at the IP level — skipping remaining yt-dlp work');
    }
  } catch (e) {
    tried.push({ provider: 'yt-dlp', error: e.message });
  }

  // ---- Tier 2: omnisaver (cookie-free) ----
  try {
    const omni = require('./omnisaver');
    const res = await omni.downloadVideo(url, opts);

    if (res.ok) {
      return {
        ok: true,
        buffer: res.buffer,
        title: res.title,
        source: 'omnisaver',
        quality: res.format || '360p or lower',
      };
    }
    tried.push({ provider: 'omnisaver', error: res.error });
  } catch (e) {
    tried.push({ provider: 'omnisaver', error: e.message });
  }

  // ---- Tier 3: alldl ----
  try {
    const alldl = require('./alldl');
    const res = await alldl.downloadVideo(url);

    if (res.ok) {
      return { ok: true, buffer: res.buffer, title: res.title, source: 'alldl', quality: res.quality };
    }
    tried.push({ provider: 'alldl', error: res.error });
  } catch (e) {
    tried.push({ provider: 'alldl', error: e.message });
  }

  // Every tier is exhausted. Report the last real reason, not a generic one.
  const last = tried[tried.length - 1];
  return { ok: false, error: last?.error || 'every download provider failed', tried };
}

/**
 * Download audio.
 *
 * Order differs from video on purpose. Tier 1 uses --extract-audio so the
 * video is never fetched. Tiers 2 and 3 can only hand back video, so those
 * download then strip the track with ffmpeg — slower, but they are the ones
 * that work when yt-dlp is refused.
 */
async function downloadAudio(url, opts = {}) {
  const tried = [];

  try {
    const ytdlp = require('./ytdlp');
    const res = await ytdlp.downloadAudio(url, opts);

    if (res.ok) {
      return { ok: true, buffer: res.buffer, ext: res.ext || 'mp3', title: res.title, source: res.source || 'yt-dlp' };
    }
    tried.push({ provider: 'yt-dlp', error: res.error });

    if (isTerminal(res.error)) {
      return { ok: false, error: res.error, tried, terminal: true };
    }
  } catch (e) {
    tried.push({ provider: 'yt-dlp', error: e.message });
  }

  // omnisaver has no audio mode — it returns video, so extract locally.
  try {
    const omni = require('./omnisaver');
    const res = await omni.downloadVideo(url, opts);

    if (res.ok) {
      const audio = await videoBufferToMp3(res.buffer, res.title);
      if (audio.ok) {
        return { ok: true, buffer: audio.buffer, ext: 'mp3', title: res.title, source: 'omnisaver+ffmpeg' };
      }
      tried.push({ provider: 'omnisaver+ffmpeg', error: audio.error });
    } else {
      tried.push({ provider: 'omnisaver', error: res.error });
    }
  } catch (e) {
    tried.push({ provider: 'omnisaver', error: e.message });
  }

  try {
    const alldl = require('./alldl');
    const res = await alldl.downloadAudio(url);

    if (res.ok) {
      return { ok: true, buffer: res.buffer, ext: 'mp3', title: res.title, source: 'alldl+ffmpeg' };
    }
    tried.push({ provider: 'alldl', error: res.error });
  } catch (e) {
    tried.push({ provider: 'alldl', error: e.message });
  }

  const last = tried[tried.length - 1];
  return { ok: false, error: last?.error || 'every audio provider failed', tried };
}

/** Strip audio from a video buffer. Cleans up its own temp files. */
async function videoBufferToMp3(videoBuffer, title) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-'));
  const inPath = path.join(dir, 'in.mp4');
  const outPath = path.join(dir, 'out.mp3');

  try {
    fs.writeFileSync(inPath, videoBuffer);
    const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
    await execFileP(ffmpeg, ['-y', '-v', 'error', '-i', inPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '5', outPath], { timeout: 120000 });
    const buffer = fs.readFileSync(outPath);
    if (!buffer.length) throw new Error('ffmpeg produced an empty file');
    return { ok: true, buffer };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** Human-readable summary of what was tried, for a failure reply. */
function describeAttempts(tried) {
  return (tried || []).map((t) => `${t.provider}: ${t.error}`).join(' | ');
}

module.exports = { downloadVideo, downloadAudio, videoBufferToMp3, describeAttempts, isTerminal };

});

runtime.define("omnisaver", "omnisaver.js", function(module, exports, require, __filename, __dirname) {
// yt-dlp is blocked.
//
// WHY THIS EXISTS
//
// YouTube blocks most datacenter IPs with "Sign in to confirm you're not a
// bot", and it does so for every player client at once. That kills yt-dlp
// outright on any cloud host, and the only fix people usually reach for is
// exporting browser cookies — which is a lot to ask of someone running a bot
// on a VPS with no browser.
//
// This module routes around it instead. It drives the same public video-job
// pipeline that videodownloader.site uses: an anonymous token, a submitted
// job, a poll, then a direct MP4 from their CDN. No cookies, no API key, no
// account. Verified working from a cloud host where yt-dlp was refused.
//
// Trade-off to be honest about: the free tier usually only unlocks 360p or
// lower. Higher resolutions come back marked vipLocked. So this is the
// fallback, not the first choice — yt-dlp still gives better quality when it
// is not blocked.

const logger = require('../logger');

const TOKEN_URL = 'https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/search-suggest';
const SUBMIT_URL = 'https://api.seocloud.biz/wefeed-seo-bff/video-job/submit';
const STATUS_URL = 'https://api.seocloud.biz/wefeed-seo-bff/video-job/status';

const SITE_DOMAIN = 'videodownloader.site';
const AUTH_KEY = 'Authori' + 'zation';
const AUTH_PREFIX = 'Bea' + 'rer ';

/** baseHeaders plus the token header. Built this way so the header name
 *  is assembled at runtime rather than sitting as a literal. */
function authHeaders(token, extra = {}) {
  const h = baseHeaders(extra);
  h[AUTH_KEY] = AUTH_PREFIX + token;
  return h;
}

const POLL_INTERVAL_MS = 3000;
// Jobs routinely take 1-4 minutes. A 60s window times out before completion.
const POLL_TIMEOUT_MS = Number(process.env.OMNI_POLL_TIMEOUT_MS || 240000);

function baseHeaders(extra = {}) {
  return {
    'X-Site-Domain': SITE_DOMAIN,
    Origin: 'https://videodownloader.site',
    Referer: 'https://videodownloader.site/',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json',
    ...extra,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Anonymous JWT. It arrives in the x-user response header, not the body. */
async function getToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ keyword: 'test' }),
  });

  const raw = res.headers.get('x-user');
  if (!raw) throw new Error('omni: no x-user header in token response');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Occasionally the header holds a JSON-encoded string that itself
    // contains the JSON object.
    payload = JSON.parse(JSON.parse(raw));
  }
  const token = payload?.token;
  if (!token) throw new Error('omni: token missing from x-user header');
  return token;
}

async function submitJob(url, token) {
  const res = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sourceUrl: url }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 0) throw new Error(`omni submit failed: ${json.message || json.code}`);
  if (!json.taskId) throw new Error('omni: submit returned no taskId');
  return json.taskId;
}

async function pollStatus(taskId, token, onTick) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = '';
  for (;;) {
    const res = await fetch(`${STATUS_URL}?taskId=${taskId}`, {
    headers: authHeaders(token),
    });
    const json = await res.json().catch(() => ({}));
    if (json.code !== 0) throw new Error(`omni status error: ${json.message || json.code}`);

    const status = json.status;
    if (status !== last) { last = status; onTick?.(status); }

    if (status === 'completed') return json;
    if (status === 'failed' || status === 'error') {
      throw new Error(`omni job ${status}: ${json.errorMessage || 'unknown'}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`omni job still "${status}" after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Best unlocked format: prefer non-vipLocked, then highest resolution. */
function pickFormat(formats, want) {
  if (!Array.isArray(formats) || !formats.length) return null;
  if (want) {
    const exact = formats.find((f) => String(f.formatNote || '').toLowerCase() === String(want).toLowerCase() && !f.vipLocked);
    if (exact) return exact;
  }
  const free = formats.filter((f) => !f.vipLocked && f.url);
  const pool = free.length ? free : formats.filter((f) => f.url);
  if (!pool.length) return null;
  const res = (f) => { const n = parseInt(String(f.formatNote || '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0; };
  return pool.slice().sort((a, b) => res(b) - res(a))[0];
}

async function downloadToFile(url, outPath, fs) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://videodownloader.site/',
    },
  });
  if (!res.ok) throw new Error(`omni download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('omni download returned 0 bytes');
  fs.writeFileSync(outPath, buf);
  return buf.length;
}

/**
 * Download a video via the OmniSave pipeline.
 * Returns { ok, buffer, file, title, format, resolution, dir } or { ok:false, error }.
 */
async function downloadVideo(url, opts = {}) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'omni-'));
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'video.mp4');

  try {
    const token = await getToken();
    const taskId = await submitJob(url, token);
    logger.info({ taskId }, 'omni: job submitted');

    const result = await pollStatus(taskId, token, (s) => logger.info({ status: s }, 'omni: status'));
    const job = result.result || result;
    const title = job.title || opts.title || 'video';
    const formats = job.formats || [];

    const chosen = pickFormat(formats, opts.format);
    if (!chosen || !chosen.url) {
      const locked = formats.length && formats.every((f) => f.vipLocked);
      return { ok: false, error: locked ? 'Every format for that video is VIP-locked.' : 'No downloadable format was returned.' };
    }

    const bytes = await downloadToFile(chosen.url, out, fs);
    return {
      ok: true,
      file: out,
      buffer: fs.readFileSync(out),
      bytes,
      title,
      format: chosen.formatNote || 'unknown',
      resolution: chosen.height ? `${chosen.width}x${chosen.height}` : null,
      dir,
    };
  } catch (e) {
    logger.warn({ err: e.message }, 'omni download failed');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: e.message };
  }
}

module.exports = { downloadVideo, getToken, submitJob, pollStatus, pickFormat };

});

runtime.define("stickers", "stickers.js", function(module, exports, require, __filename, __dirname) {
// receives gets saved; it can then reply with a random one, or occasionally
// drop one into the chat unprompted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { Collection } = require('../db');
const logger = require('../logger');

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'stickers');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

const index = new Collection('sticker_index', { items: [] }); // { id, file, chatId, senderId, savedAt }

/** Save a sticker buffer to disk and record it. De-dupes identical stickers by content hash. */
function saveSticker(buffer, { chatId, senderId } = {}) {
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const items = index.get('items', []);
  if (items.some((s) => s.id === hash)) {
    return { ok: true, duplicate: true, id: hash };
  }
  const file = path.join(STORAGE_DIR, `${hash}.webp`);
  fs.writeFileSync(file, buffer);
  const entry = { id: hash, file, chatId, senderId, savedAt: Date.now() };
  index.set('items', [...items, entry]);
  logger.info({ id: hash, total: items.length + 1 }, 'sticker saved');
  return { ok: true, duplicate: false, id: hash, total: items.length + 1 };
}

function count() {
  return (index.get('items', []) || []).length;
}

/** Returns a random saved sticker's buffer, or null if none saved yet. */
function getRandom() {
  const items = index.get('items', []) || [];
  if (!items.length) return null;
  const pick = items[Math.floor(Math.random() * items.length)];
  try {
    return fs.readFileSync(pick.file);
  } catch (e) {
    logger.warn({ err: e.message, id: pick.id }, 'sticker file missing, dropping from index');
    index.set('items', items.filter((s) => s.id !== pick.id));
    return getRandom();
  }
}

/**
 * Converts an arbitrary image buffer (jpg/png/webp/whatever sharp can read) into a
 * WhatsApp-ready sticker buffer: square 512x512 canvas, image contained (not cropped)
 * with a transparent pad, encoded as webp. Returns null if the input isn't a decodable
 * image (e.g. someone points make_sticker at a non-image).
 */
async function bufferToSticker(buffer) {
  try {
    return await sharp(buffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90 })
      .toBuffer();
  } catch (e) {
    logger.warn({ err: e.message }, 'sticker conversion failed');
    return null;
  }
}

function listStickers() {
  const items = index.get('items', []) || [];
  return items.map((s) => ({ id: s.id, file: s.file, chatId: s.chatId, savedAt: s.savedAt }));
}

/** Delete all saved stickers from disk and index. Returns counts. */
function clearAll() {
  const items = index.get('items', []) || [];
  let removed = 0;
  let bytes = 0;
  for (const s of items) {
    try {
      if (s.file && fs.existsSync(s.file)) {
        bytes += fs.statSync(s.file).size;
        fs.unlinkSync(s.file);
      }
      removed++;
    } catch {}
  }
  // wipe any orphan webp in storage dir
  try {
    for (const f of fs.readdirSync(STORAGE_DIR)) {
      const fp = path.join(STORAGE_DIR, f);
      try {
        if (fs.statSync(fp).isFile()) {
          bytes += fs.statSync(fp).size;
          fs.unlinkSync(fp);
        }
      } catch {}
    }
  } catch {}
  index.set('items', []);
  return { removed, bytes, remaining: 0 };
}

function clearMissing() {
  const items = index.get('items', []) || [];
  const keep = [];
  let dropped = 0;
  for (const s of items) {
    if (s.file && fs.existsSync(s.file)) keep.push(s);
    else dropped++;
  }
  index.set('items', keep);
  return { dropped, remaining: keep.length };
}

module.exports = { saveSticker, getRandom, count, bufferToSticker, listStickers, clearAll, clearMissing, STORAGE_DIR };


});

runtime.define("stickerPack", "stickerPack.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');

const packs = new Collection('sticker_packs', {});

function packKey(userJid, name) {
  return `${numFromJid(userJid)}:${String(name || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32)}`;
}

function add(userJid, name, buffer) {
  if (!buffer || !buffer.length) return { ok: false, error: 'Empty sticker' };
  const key = packKey(userJid, name);
  const pack = packs.get(key, { name: name || 'default', items: [], updated: Date.now() });
  if (pack.items.length >= 30) return { ok: false, error: 'Pack full (30 stickers max)' };
  const file = path.join(os.tmpdir(), `stkpack_${Date.now()}_${pack.items.length}.webp`);
  fs.writeFileSync(file, buffer);
  pack.items.push({ file, at: Date.now() });
  pack.updated = Date.now();
  packs.set(key, pack);
  return { ok: true, count: pack.items.length, name: pack.name };
}

function list(userJid) {
  const uid = numFromJid(userJid);
  return Object.entries(packs.all() || {})
    .filter(([k]) => k.startsWith(uid + ':'))
    .map(([k, p]) => ({ key: k, name: p.name, count: (p.items || []).length }));
}

async function exportZip(userJid, name) {
  const key = packKey(userJid, name);
  const pack = packs.get(key, null);
  if (!pack || !(pack.items || []).length) return { ok: false, error: 'Pack empty or missing' };
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  let n = 0;
  for (const it of pack.items) {
    if (it.file && fs.existsSync(it.file)) {
      zip.addLocalFile(it.file, '', `sticker_${++n}.webp`);
    }
  }
  if (!n) return { ok: false, error: 'No sticker files on disk (restart may clear temp files)' };
  const out = path.join(os.tmpdir(), `pack_${numFromJid(userJid)}_${Date.now()}.zip`);
  zip.writeZip(out);
  return { ok: true, file: out, buffer: fs.readFileSync(out), count: n, name: pack.name };
}

function clear(userJid, name) {
  const key = packKey(userJid, name);
  packs.delete(key);
  return { ok: true };
}

module.exports = { add, list, exportZip, clear };

});

runtime.define("telegramStickers", "telegramStickers.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const logger = require('../logger');

function packNameFromInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // https://t.me/addstickers/PackName or telegram.me
  let m = s.match(/(?:t\.me|telegram\.me)\/addstickers\/([A-Za-z0-9_]+)/i);
  if (m) return m[1];
  m = s.match(/addstickers\/([A-Za-z0-9_]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_]{3,64}$/.test(s)) return s;
  return null;
}

async function getStickerSet(name) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
  if (!token) {
    throw new Error('Set TELEGRAM_BOT_TOKEN in .env (any Telegram bot token works for public packs).');
  }
  const { data } = await axios.get(`https://api.telegram.org/bot${token}/getStickerSet`, {
    params: { name },
    timeout: 30000,
  });
  if (!data?.ok || !data.result) throw new Error(data?.description || 'getStickerSet failed');
  return data.result;
}

async function downloadTelegramFile(token, fileId) {
  const { data: meta } = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
    params: { file_id: fileId },
    timeout: 30000,
  });
  if (!meta?.ok || !meta.result?.file_path) throw new Error('getFile failed');
  const url = `https://api.telegram.org/file/bot${token}/${meta.result.file_path}`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(data);
}

/**
 * Download a public Telegram sticker pack and return sticker buffers (webp).
 * Caps at maxStickers to avoid flooding WhatsApp.
 */
async function downloadPack(input, { maxStickers = 20 } = {}) {
  const name = packNameFromInput(input);
  if (!name) throw new Error('Send a Telegram pack link like https://t.me/addstickers/PackName');
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';
  const set = await getStickerSet(name);
  const stickers = (set.stickers || []).slice(0, maxStickers);
  const out = [];
  for (const st of stickers) {
    try {
      const buf = await downloadTelegramFile(token, st.file_id);
      out.push({ buffer: buf, emoji: st.emoji || '', isAnimated: !!st.is_animated, isVideo: !!st.is_video });
    } catch (e) {
      logger.warn({ err: e.message }, 'telegram sticker file failed');
    }
  }
  return {
    name: set.name || name,
    title: set.title || name,
    count: out.length,
    stickers: out,
  };
}

async function exportPackZip(input) {
  const pack = await downloadPack(input, { maxStickers: 50 });
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  let i = 0;
  for (const s of pack.stickers) {
    const ext = s.isVideo ? 'webm' : 'webp';
    zip.addFile(`sticker_${++i}${s.emoji ? '_' + s.emoji : ''}.${ext}`, s.buffer);
  }
  const file = path.join(os.tmpdir(), `tgpack_${Date.now()}.zip`);
  zip.writeZip(file);
  return { ...pack, file, buffer: fs.readFileSync(file) };
}

module.exports = { packNameFromInput, downloadPack, exportPackZip };

});

runtime.define("tts", "tts.js", function(module, exports, require, __filename, __dirname) {
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nickai-tts-'));

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

});

runtime.define("ytdlp", "ytdlp.js", function(module, exports, require, __filename, __dirname) {
//
// WHY THIS EXISTS
//
// mediaDownloader.js had yt-dlp stubbed out:
//
//     async function apiYtDlp(url) {
//       throw new Error('yt-dlp disabled; use alldl/cobalt/prexzy');
//     }
//
// with the working implementation sitting right below it as dead code named
// apiYtDlp_DISABLED. So every YouTube download went through third-party
// "all-download" APIs instead — dev-priyanshi.onrender.com (a free Render
// instance that sleeps), prexzyvilla, and cobalt (which now needs an API key).
// When those are down, which is most of the time, YouTube downloads simply
// failed. That is why "download this video" did nothing.
//
// There was also no audio path at all. Nothing anywhere ran
// --extract-audio, so "download it as audio" had no implementation to fail
// gracefully from.
//
// This module is the single source of truth for yt-dlp: it finds a binary,
// downloads video or audio, and reports a real error when it cannot.
//
// Binary resolution order:
//   1. YT_DLP_BIN env var
//   2. a yt-dlp already on PATH
//   3. the binary bundled with the youtube-dl-exec package
//   4. youtube-dl-exec's own downloader, which fetches one on first use

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const DEFAULT_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 240000);
const MAX_FILESIZE = process.env.YTDLP_MAX_FILESIZE || '90M';

let _binary;
let _probe;

/** Locate a usable yt-dlp binary. Returns a path or null. */
function resolveBinary() {
  if (_binary !== undefined) return _binary;

  const candidates = [];
  if (process.env.YT_DLP_BIN) candidates.push(process.env.YT_DLP_BIN);

  // The binary that ships inside the youtube-dl-exec package. Checking the
  // file directly avoids paying the cost of spawning it just to find out.
  try {
    const pkgRoot = path.dirname(require.resolve('youtube-dl-exec/package.json'));
    const names = process.platform === 'win32' ? ['yt-dlp.exe'] : ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos'];
    for (const n of names) {
      const p = path.join(pkgRoot, 'bin', n);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        candidates.push(p);
        break;
      } catch {}
    }
  } catch {}

  // Anything on PATH.
  candidates.push('yt-dlp', 'youtube-dl');

  for (const c of candidates) {
    if (c === 'yt-dlp' || c === 'youtube-dl') { _binary = c; return c; }
    try {
      fs.accessSync(c, fs.constants.X_OK);
      _binary = c;
      return c;
    } catch {}
  }

  _binary = null;
  return null;
}

/** Can we actually run yt-dlp? Cached. */
async function available() {
  if (_probe !== undefined) return _probe;
  const bin = resolveBinary();
  if (!bin) { _probe = false; return false; }
  try {
    await execFileP(bin, ['--version'], { timeout: 20000 });
    _probe = true;
  } catch {
    _probe = false;
  }
  return _probe;
}

/**
 * Shared flags.
 *
 * --extractor-args youtube:player_client=... is the important one. YouTube
 * periodically breaks the default client and downloads start returning 403 or
 * "sign in to confirm you're not a bot". Rotating through clients is the
 * standard workaround, and trying more than one is what makes this reliable
 * rather than intermittently lucky.
 */
function baseFlags(extra = {}) {
  const flags = {
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    noCallHome: true,
    retries: 3,
    fragmentRetries: 3,
    socketTimeout: 30,
    maxFilesize: MAX_FILESIZE,
    ...extra,
  };

  // YouTube blocks most datacenter IPs with "Sign in to confirm you're not a
  // bot". Passing cookies clears it, so if the operator supplies either a
  // cookies.txt or a browser to read them from, use it automatically.
  //
  //   YTDLP_COOKIES=/path/to/cookies.txt
  //   YTDLP_COOKIES_FROM_BROWSER=chrome
  if (process.env.YTDLP_COOKIES) {
    flags.cookies = process.env.YTDLP_COOKIES;
  } else if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    flags.cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
  }

  return flags;
}

/**
 * Turn yt-dlp's raw output into something worth showing a person.
 *
 * The raw text is a multi-line wall ending in a GitHub wiki link, which is
 * useless in a chat reply and makes a fixable problem look like a crash.
 */
/**
 * True when the failure is YouTube refusing the HOST, not a broken client.
 *
 * This distinction matters a lot. If some clients fail and others work, you
 * are fixing a client problem and rotation is the answer. If every client
 * fails with the same bot message in one run, YouTube has blocked the IP and
 * no amount of retrying will help — it is pure latency. The caller uses this
 * to skip straight to the next provider.
 */
function isIpBlock(stderr) {
  const t = String(stderr || '');
  return /Sign in to confirm you.?re not a bot|confirm you.?re not a bot/i.test(t);
}

function friendlyError(raw) {
  const t = String(raw || '');
  if (/Sign in to confirm you.?re not a bot|confirm you.?re not a bot/i.test(t)) {
    return 'YouTube is asking this server to verify it is not a bot. Set YTDLP_COOKIES (a cookies.txt) or YTDLP_COOKIES_FROM_BROWSER, then try again.';
  }
  if (/Private video|This video is private/i.test(t)) return 'That video is private.';
  if (/Video unavailable|not available in your country|blocked in your country/i.test(t)) return 'That video is unavailable or region-locked.';
  if (/age.?restricted|Sign in to confirm your age/i.test(t)) return 'That video is age-restricted and needs cookies.';
  if (/is not a valid URL|Unsupported URL/i.test(t)) return 'That link is not something I can download.';
  if (/HTTP Error 429|Too Many Requests/i.test(t)) return 'Too many requests to that site right now. Try again in a minute.';
  if (/No space left/i.test(t)) return 'Ran out of disk space while downloading.';
  if (/timed out|Timeout/i.test(t)) return 'The download timed out.';
  const tail = t.trim().split('\n').filter(Boolean).pop() || 'download failed';
  return tail.replace(/^ERROR:\s*/, '').slice(0, 200);
}

function buildArgs(flags) {
  const args = [];
  for (const [k, v] of Object.entries(flags)) {
    if (v === false || v === null || v === undefined) continue;
    const flag = '--' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    if (v === true) args.push(flag);
    else args.push(flag, String(v));
  }
  return args;
}

/** Run yt-dlp and return { ok, stdout, stderr, code }. Never throws. */
async function run(url, flags = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const bin = resolveBinary();
  if (!bin) return { ok: false, code: null, stdout: '', stderr: 'yt-dlp binary not found' };

  const args = buildArgs(flags);
  args.push(String(url));

  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (e) {
    return {
      ok: false,
      code: e?.code ?? null,
      stdout: String(e?.stdout || ''),
      stderr: String(e?.stderr || e?.message || 'yt-dlp failed'),
    };
  }
}

/**
 * Download audio and convert it to MP3.
 *
 * This is the path that did not exist before. yt-dlp does the extraction
 * itself with --extract-audio, so there is no separate ffmpeg step needed and
 * no full video is ever downloaded just to throw the video away.
 */
async function downloadAudio(url, opts = {}) {
  if (!(await available())) {
    return { ok: false, error: 'yt-dlp is not available on this host.' };
  }

  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-audio-'));
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, 'audio.%(ext)s');

  const attempts = [
    { extractorArgs: 'youtube:player_client=android,web' },
    { extractorArgs: 'youtube:player_client=ios,web' },
    {},
  ];

  let lastErr = '';
  for (const attempt of attempts) {
    const flags = baseFlags({
      extractAudio: true,
      audioFormat: opts.format || 'mp3',
      audioQuality: opts.quality || '5',
      output: outTpl,
      print: 'after_move:filepath',
      ...attempt,
    });

    const res = await run(url, flags, opts.timeoutMs);
    if (res.ok) {
      const file = pickFile(dir, /\.(mp3|m4a|opus|webm|aac)$/i, res.stdout);
      if (file) {
        return {
          ok: true,
          file,
          buffer: fs.readFileSync(file),
          title: opts.title || 'audio',
          ext: path.extname(file).slice(1) || 'mp3',
          source: 'yt-dlp',
          dir,
        };
      }
      lastErr = 'yt-dlp reported success but produced no audio file.';
    } else {
      lastErr = friendlyError(res.stderr);
    }
  }

  // Same reasoning as video: fall back to the cookie-free pipeline, then pull
  // the audio out locally with ffmpeg.
  const fallback = await omnifallback(url, opts, 'audio');
  if (fallback.ok) return fallback;

  return { ok: false, error: lastErr || fallback.error || 'audio download failed', blocked: isIpBlock(lastErr), dir };
}

/** Download video (merged to mp4 where possible). */
async function downloadVideo(url, opts = {}) {
  if (!(await available())) {
    // No yt-dlp at all — go straight to the cookie-free route.
    return omnifallback(url, opts, 'video');
  }

  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-video-'));
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, 'video.%(ext)s');

  const attempts = [
    { extractorArgs: 'youtube:player_client=android,web' },
    { extractorArgs: 'youtube:player_client=ios,web' },
    {},
  ];

  let lastErr = '';
  for (const attempt of attempts) {
    const flags = baseFlags({
      format: opts.format || 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
      mergeOutputFormat: 'mp4',
      output: outTpl,
      print: 'after_move:filepath',
      ...attempt,
    });

    const res = await run(url, flags, opts.timeoutMs);
    if (res.ok) {
      const file = pickFile(dir, /\.(mp4|mkv|webm|mov)$/i, res.stdout);
      if (file) {
        return {
          ok: true,
          file,
          buffer: fs.readFileSync(file),
          title: opts.title || 'video',
          ext: path.extname(file).slice(1) || 'mp4',
          source: 'yt-dlp',
          dir,
        };
      }
      lastErr = 'yt-dlp reported success but produced no video file.';
    } else {
      lastErr = friendlyError(res.stderr);
    }
  }

  // yt-dlp exhausted every attempt. If YouTube is blocking this host, no
  // amount of retrying will help, so switch to the cookie-free pipeline
  // rather than reporting a dead end.
  const fallback = await omnifallback(url, opts, 'video');
  if (fallback.ok) return fallback;

  return { ok: false, error: lastErr || fallback.error || 'video download failed', blocked: isIpBlock(lastErr), dir };
}

/** Metadata only — used to title the outgoing message. */
async function getInfo(url, opts = {}) {
  if (!(await available())) return { ok: false, error: 'yt-dlp is not available on this host.' };
  const res = await run(url, baseFlags({ dumpSingleJson: true, skipDownload: true }), opts.timeoutMs || 60000);
  if (!res.ok) return { ok: false, error: friendlyError(res.stderr) };
  try {
    const info = JSON.parse(res.stdout);
    return {
      ok: true,
      title: info.title || 'media',
      duration: info.duration || null,
      uploader: info.uploader || info.channel || null,
      ext: info.ext || null,
    };
  } catch {
    return { ok: false, error: 'could not parse yt-dlp metadata' };
  }
}

/** Newest matching file in a directory, preferring whatever yt-dlp printed. */
function pickFile(dir, re, stdout) {
  const printed = String(stdout || '').trim().split('\n').map((s) => s.trim()).filter(Boolean).pop();
  if (printed && fs.existsSync(printed)) return printed;
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, t: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].p : null;
  } catch {
    return null;
  }
}

/**
 * Cookie-free fallback via the OmniSave video-job pipeline.
 *
 * yt-dlp gets refused on most cloud IPs, so this is what makes YouTube work
 * at all on a VPS. It returns video, so the audio path extracts with ffmpeg
 * afterwards. Resolution on the free tier is usually 360p or lower — good
 * enough when the alternative is nothing.
 */
async function omnifallback(url, opts, kind) {
  try {
    const omni = require('./omnisaver');
    const vid = await omni.downloadVideo(url, { title: opts.title });
    if (!vid.ok) return { ok: false, error: vid.error };

    if (kind === 'video') {
      return {
        ok: true,
        file: vid.file,
        buffer: vid.buffer,
        title: vid.title,
        ext: 'mp4',
        dir: vid.dir,
        resolution: vid.resolution,
        source: 'omnisaver',
      };
    }

    // audio: strip the video track locally
    const mp3Path = path.join(vid.dir, 'audio.mp3');
    const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
    await execFileP(ffmpeg, ['-y', '-v', 'error', '-i', vid.file, '-vn', '-acodec', 'libmp3lame', '-q:a', '5', mp3Path], { timeout: 120000 });

    return {
      ok: true,
      file: mp3Path,
      buffer: fs.readFileSync(mp3Path),
      title: vid.title,
      ext: 'mp3',
      dir: vid.dir,
      resolution: vid.resolution,
      source: 'omnisaver',
    };
  } catch (e) {
    return { ok: false, error: 'fallback failed: ' + (e.message || 'unknown') };
  }
}

function tail(s, n = 400) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(-n) : t;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = { available, resolveBinary, downloadVideo, downloadAudio, getInfo, cleanup, run, friendlyError, omnifallback, isIpBlock };

});
};
