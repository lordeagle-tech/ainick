// features/mediaDownloader.js — download posts/videos/images from social links
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-cmp-'));
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
