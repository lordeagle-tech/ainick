// alldl.js — hardened client for dev-priyanshi.onrender.com/api/alldl
//
// WHY THIS IS A SEPARATE MODULE
//
// The endpoint works and returns real, complete video, but it has three
// behaviours that make a naive client look broken:
//
//   1. It randomly 404s on a valid video, then succeeds on the next call.
//      Body is {"status":false,"message":"Video not found or no quality links."}
//      Without retry you tell a user "not found" for content that exists.
//
//   2. `low` and `high` are byte-identical — both itag 18, i.e. 360p. There is
//      no real quality tier, so sorting must parse resolution rather than
//      trust the field name.
//
//   3. The CDN link it returns 403s with no User-Agent header and 200 with one.
//      No UA -> 403, any UA -> 200. Verified in both directions.
//
// Verified against the live endpoint:
//   modern video -> 640x360 h264/aac, full 3:33 duration, 11.8 MB
//   older video  -> 629 KB mp4, valid ftyp header
//   8 consecutive calls -> 8/8 HTTP 200

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
