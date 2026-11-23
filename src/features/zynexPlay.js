'use strict';

// Port of Zynex-MD's `play` downloader (zynextelee/plugins/downloads/song.js).
// Search is delegated to Nick's existing brokenapi resolver instead of adding
// the yt-search dependency; the URL API chain and buffer handling are the same.

const axios = require('axios');
const logger = require('../logger');

const KEITH_BASE = (process.env.HEROKU_API_BASE_URL
  || process.env.KEITH_DEPLOY_BASE_URL
  || 'https://keithhostdeploysite-22l75uk5-ff0ccc337078.herokuapp.com').replace(/\/+$/, '');
const OSTYADO_BASE = (process.env.OSTYADO_API_BASE_URL || 'https://apis.ostyado.space').replace(/\/+$/, '');
const DAVID_BASE = (process.env.DAVID_CYRIL_API_BASE || 'https://apis.davidcyriltech.my.id').replace(/\/+$/, '');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

const URL_APIS = [
  // #1 — Keith /download/audio (binary stream, no link check needed)
  async (ytUrl) => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await axios.get(
          `${KEITH_BASE}/download/audio?url=${encodeURIComponent(ytUrl)}`,
          { timeout: 25000 }
        );
        if (!data?.status || !data?.result) throw new Error('No audio link');
        return { audio: data.result, title: '' };
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  },
  // #2 — Keith /download/ytmp3
  async (ytUrl) => {
    const { data } = await axios.get(
      `${KEITH_BASE}/download/ytmp3?url=${encodeURIComponent(ytUrl)}`,
      { timeout: 20000 }
    );
    if (!data?.status || !data?.result) throw new Error('No audio link');
    return { audio: data.result, title: '' };
  },
  // #3 — David Cyril ytmp3
  async (ytUrl) => {
    const { data } = await axios.get(
      `${DAVID_BASE}/download/ytmp3?url=${encodeURIComponent(ytUrl)}`,
      { timeout: 25000 }
    );
    const r = data?.result;
    if (!data?.success || !r?.download_url) throw new Error('No audio link');
    return { audio: r.download_url, title: r.title || '' };
  },
  // #4 — Ostyado /download/ytmp3
  async (ytUrl) => {
    const { data } = await axios.get(
      `${OSTYADO_BASE}/download/ytmp3?q=${encodeURIComponent(ytUrl)}`,
      { timeout: 25000 }
    );
    const r = data?.result;
    const audio = r?.download || r?.url;
    if (!data?.status || !audio) throw new Error('No audio link');
    return { audio, title: r.title || '' };
  },
];

/** Check an audio link is reachable and not an HTML error page. */
async function linkAlive(url) {
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': UA, 'Range': 'bytes=0-8191' },
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const ct = String(res.headers['content-type'] || '');
    if (ct.includes('text/html')) return false;
    return (res.data?.length || 0) > 0;
  } catch { return false; }
}

/** Download the audio ourselves — WhatsApp fetching URLs breaks on redirects. */
async function downloadAudioFile(url) {
  const res = await axios.get(url, {
    timeout: 90000,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': UA, 'Referer': 'https://savetube.me/' },
    maxContentLength: MAX_AUDIO_BYTES,
    maxRedirects: 5,
  });
  const buffer = Buffer.from(res.data);
  if (!buffer.length) throw new Error('Empty audio file');
  return buffer;
}

async function tryUrlApis(ytUrl) {
  for (const [i, fn] of URL_APIS.entries()) {
    try {
      const result = await fn(ytUrl);
      const isKeithLink = typeof result.audio === 'string' && result.audio.startsWith(`${KEITH_BASE}/`);
      if (!isKeithLink && !(await linkAlive(result.audio))) throw new Error('dead link (404/expired/IP-locked)');
      logger.info({ api: i + 1 }, 'zynex play URL API success');
      return result;
    } catch (e) {
      logger.warn({ api: i + 1, err: e.message }, 'zynex play URL API failed');
    }
  }
  throw new Error('All URL APIs failed');
}

function isYouTubeUrl(text) {
  return /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/|youtu\.be\/)/i.test(String(text || '').trim());
}

/** Search query → YouTube URL, using Nick's existing resolver. */
async function resolveYouTubeUrl(query) {
  if (isYouTubeUrl(query)) return { url: String(query).trim(), title: '' };
  const features = require('./index');
  const resolved = await features.brokenapi.resolveSongUrl(query);
  if (!resolved?.url) throw new Error('Song not found on YouTube.');
  return { url: resolved.url, title: resolved.title || '' };
}

function youtubeId(url) {
  return String(url || '').match(/[?&]v=([\w-]{11})/)?.[1]
    || (String(url || '').match(/youtu\.be\/([\w-]{11})/i) || [])[1]
    || null;
}

/**
 * Download a song using the ported Zynex chain.
 * Returns { ok, title, youtubeUrl, buffer, payload, ext, source, error }.
 */
async function downloadSong(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Give me a song name or YouTube link.' };

  try {
    const resolved = await resolveYouTubeUrl(q);
    const ytUrl = resolved.url;
    let title = resolved.title || '';
    let payload = null;
    let ext = 'mp3';
    let source = '';

    try {
      const result = await tryUrlApis(ytUrl);
      title = title || result.title || '';
      ext = result.ext || ext;
      try {
        payload = await downloadAudioFile(result.audio);
        source = 'zynex-url-api+buffer';
      } catch (e) {
        logger.warn({ err: e.message }, 'zynex play buffer download failed — sending URL payload');
        payload = { url: result.audio };
        source = 'zynex-url-api+link';
      }
    } catch (apiError) {
      logger.warn({ err: apiError.message, videoId: youtubeId(ytUrl) }, 'zynex play falling back to yt-dlp');
      const features = require('./index');
      const res = await features.ytdlp.downloadAudio(ytUrl, { title: title || q });
      if (!res?.ok) throw new Error(res?.error || 'yt-dlp download failed');
      payload = res.buffer;
      ext = res.ext || 'mp3';
      title = title || res.title || '';
      source = res.source || 'zynex-yt-dlp';
    }

    return { ok: true, title: title || q, youtubeUrl: ytUrl, payload, ext, source };
  } catch (error) {
    logger.warn({ err: error.message }, 'zynex play failed');
    return { ok: false, error: error.message };
  }
}

module.exports = { downloadSong };
