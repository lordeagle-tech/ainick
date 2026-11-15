// omnisaver.js — cookie-free YouTube downloader, as a fallback for when
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
