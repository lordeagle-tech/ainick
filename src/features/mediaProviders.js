// mediaProviders.js — the layered download chain.
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
