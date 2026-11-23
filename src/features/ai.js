'use strict';

module.exports = (runtime) => {
runtime.define("brokenapi", "brokenapi.js", function(module, exports, require, __filename, __dirname) {
// Music helpers: YouTube search + audio download. Spotify is used for search/metadata,
// then the selected track is resolved to a public YouTube source for playback.
const https = require('https');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const { URL } = require('url');
const logger = require('../logger');

const PLAY_BASE = 'https://broken-api-production-31d5.up.railway.app';
const API_BASE = 'https://api.brokenvzn.de5.net';
const LYRICS_API_BASE = 'https://broken-api-production-31d5.up.railway.app';

function httpJson(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.request(u, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, error: 'bad json', raw: data.slice(0, 300) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Search a song via the play API. Returns { ok, title, id, url, thumbnail, duration }. */
async function searchSong(query) {
  const d = await httpJson(`${PLAY_BASE}/api/play/yt?q=${encodeURIComponent(query)}`);
  if (!d || d.ok !== true) return { ok: false, error: d?.error || 'no result' };
  return d;
}

/**
 * Resolve a song query to a downloadable media URL via all-download APIs (no yt-dlp).
 */
async function resolveSongUrl(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  // Direct YouTube / social URL
  if (/^https?:\/\//i.test(q)) {
    return { url: q, title: q };
  }
  // Search via Broken play API (metadata only — we only need a video URL)
  try {
    const result = await searchSong(q);
    if (result?.ok) {
      const url = result.url || result.video_url || result.webpage_url ||
        (result.id ? `https://www.youtube.com/watch?v=${result.id}` : null);
      if (url) return { url, title: result.title || q, thumbnail: result.thumbnail || '' };
    }
  } catch (_) {}
  // Piped free search → YouTube URL
  const instances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.private.coffee',
  ];
  for (const base of instances) {
    try {
      const { data } = await axios.get(`${base}/search?q=${encodeURIComponent(q)}&filter=videos`, {
        timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const items = Array.isArray(data) ? data : (data?.items || data?.results || []);
      const first = items.find((x) => x?.url || x?.id || x?.videoId) || items[0];
      if (!first) continue;
      const id = first.videoId || first.id || (String(first.url || '').match(/[?&]v=([\w-]{11})/) || [])[1];
      const url = first.url?.startsWith('http') ? first.url : (id ? `https://www.youtube.com/watch?v=${id}` : null);
      if (!url) continue;
      return { title: first.title || q, url, thumbnail: first.thumbnail || first.thumbnails?.[0]?.url || '' };
    } catch (_) {}
  }
  return null;
}

/**
 * Pull audio via all-download APIs (alldl / prexzy / cobalt) then ffmpeg → MP3.
 * yt-dlp is intentionally NOT used.
 */
async function downloadAudioViaAllDl(pageUrl, title = 'song') {
  const mediaDownloader = require('./mediaDownloader');
  // Prefer the social all-download chain (no yt-dlp)
  let videoBuf = null;
  let metaTitle = title;
  try {
    const post = await mediaDownloader.downloadPost(pageUrl);
    metaTitle = post.title || title;
    if (post.videos?.[0] && Buffer.isBuffer(post.videos[0])) {
      videoBuf = post.videos[0];
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'audio download fallback failed');
  }
  if (!videoBuf || videoBuf.length < 1000) {
    // Direct alldl / prexzy URL fetch as last resort
    for (const endpoint of [
      (u) => `https://dev-priyanshi.onrender.com/api/alldl?url=${encodeURIComponent(u)}`,
      (u) => `https://apis.prexzyvilla.site/download/aio?url=${encodeURIComponent(u)}`,
    ]) {
      try {
        const { data } = await axios.get(endpoint(pageUrl), { timeout: 50000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const body = data?.data || data?.result || data || {};
        const direct = body.high || body.low || body.url || body.video || body.download ||
          body.audio || body.audio_url || body.download_url;
        if (direct && /^https?:/i.test(String(direct))) {
          const r = await axios.get(direct, {
            responseType: 'arraybuffer', timeout: 120000,
            maxContentLength: 100 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          videoBuf = Buffer.from(r.data);
          metaTitle = body.title || metaTitle;
          if (videoBuf.length > 1000) break;
        }
      } catch (_) {}
    }
  }
  if (!videoBuf || videoBuf.length < 1000) {
    return { ok: false, error: 'All-download API returned no media for that track.' };
  }
  // ffmpeg: extract audio + compress if large
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-song-'));
  const inFile = path.join(dir, 'in.bin');
  const outFile = path.join(dir, 'out.mp3');
  fs.writeFileSync(inFile, videoBuf);
  const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
  try {
    await execFileP(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inFile,
      '-vn', '-acodec', 'libmp3lame', '-b:a', '96k', '-ac', '2', '-ar', '44100',
      outFile,
    ], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `ffmpeg audio extract failed: ${e.message}` };
  }
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 500) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: 'ffmpeg produced empty audio' };
  }
  // Further compress if still > 12MB
  let finalFile = outFile;
  let size = fs.statSync(outFile).size;
  if (size > 12 * 1024 * 1024) {
    const smaller = path.join(dir, 'small.mp3');
    try {
      await execFileP(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', outFile, '-vn', '-b:a', '64k', '-ac', '1', '-ar', '44100', smaller,
      ], { timeout: 120000 });
      if (fs.existsSync(smaller) && fs.statSync(smaller).size < size) {
        finalFile = smaller;
        size = fs.statSync(smaller).size;
      }
    } catch (_) {}
  }
  const buffer = fs.readFileSync(finalFile);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return {
    ok: true,
    buffer,
    title: metaTitle,
    source: 'alldl+ffmpeg',
    bytes: buffer.length,
  };
}

/**
 * Fast song playback — APIs first, then all-download + ffmpeg. No yt-dlp.
 */
async function playSong(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Empty song query' };

  const apiKey = (process.env.DAVID_CYRIL_API_KEY || process.env.PLAY_API_KEY || '').trim();
  const candidates = [];

  if (apiKey) {
    candidates.push(async () => {
      const endpoint = `https://apis.davidcyril.name.ng/play?query=${encodeURIComponent(q)}&apikey=${encodeURIComponent(apiKey)}`;
      const { data } = await axios.get(endpoint, { timeout: 45000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const result = data?.result || data?.data || data;
      const direct = result?.download_url || result?.audio_url || result?.audioUrl || result?.url;
      if (!direct || !/^https?:\/\//i.test(String(direct))) throw new Error('Music API returned no direct audio URL.');
      const audioResponse = await axios.get(direct, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 80 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const buffer = Buffer.from(audioResponse.data);
      if (!buffer.length) throw new Error('Music API returned an empty audio file.');
      return {
        ok: true,
        buffer,
        title: result.title || q,
        duration: result.duration || '',
        thumbnail: result.thumbnail || '',
        video_url: result.video_url || '',
        download_url: direct,
        source: 'david-cyril',
      };
    });
  }

  candidates.push(async () => {
    const result = await searchSong(q);
    if (!result?.ok) throw new Error(result?.error || 'Music API returned no result.');
    const direct = result.download_url || result.audio_url || result.audioUrl ||
      result.downloadUrl || result.media_url || result.mediaUrl ||
      result.result?.download_url || result.result?.audio_url || result.data?.download_url;
    if (!direct || !/^https?:\/\//i.test(String(direct))) {
      throw new Error('The configured music API returned a result but no direct audio URL.');
    }
    const r = await axios.get(direct, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 80 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const buffer = Buffer.from(r.data);
    if (!buffer.length) throw new Error('Music API returned an empty audio file.');
    return {
      ok: true,
      buffer,
      title: result.title || q,
      duration: result.duration || '',
      thumbnail: result.thumbnail || '',
      video_url: result.video_url || result.url || '',
      download_url: direct,
      source: 'broken-music-api',
    };
  });

  // All-download API path (social media downloader) + ffmpeg → mp3. No yt-dlp.
  candidates.push(async () => {
    const hit = await resolveSongUrl(q);
    if (!hit?.url) throw new Error('No match found for that track.');
    const dl = await downloadAudioViaAllDl(hit.url, hit.title || q);
    if (!dl.ok) throw new Error(dl.error || 'all-download audio failed');
    return {
      ok: true,
      buffer: dl.buffer,
      title: dl.title || hit.title || q,
      duration: '',
      thumbnail: hit.thumbnail || '',
      video_url: hit.url,
      download_url: hit.url,
      source: dl.source || 'alldl+ffmpeg',
    };
  });

  let lastError = null;
  for (const getAudio of candidates) {
    try {
      return await getAudio();
    } catch (e) {
      lastError = e;
      logger.warn({ err: e.message }, 'music source fallback failed');
    }
  }

  return {
    ok: false,
    error: lastError?.message || 'All music sources failed. Try a clearer title or paste a link.',
  };
}

/** HTTP helper that captures response headers too (for the x-user JWT). */
function httpReq(url, { method = 'GET', body, headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.request(u, {
      method,
      timeout,
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' }, headers),
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/** Get lyrics for a track. */
async function getLyrics(artist, title) {
  const d = await httpJson(`${LYRICS_API_BASE}/api/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
  return d;
}

/** Search the dedicated lyrics API when artist/title is not known exactly. */
async function searchLyrics(query) {
  return httpJson(`${LYRICS_API_BASE}/api/lyrics/search?q=${encodeURIComponent(query)}`);
}

/** Search music (trending/suggestions). */
async function searchMusic(query) {
  const d = await httpJson(`${API_BASE}/api/music/search?q=${encodeURIComponent(query)}`);
  return d;
}

/** Generic: hit any /api/... path on the broken API (for "use some more apis"). */
async function generic(pathname, params = {}) {
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const d = await httpJson(`${API_BASE}${pathname}${qs ? '?' + qs : ''}`);
  return d;
}

/**
 * Resolve a Spotify track/search result to YouTube and download it.
 * This intentionally does NOT download from Spotify or bypass Spotify DRM.
 * Spotify supplies metadata; YouTube supplies the playback source.
 */
async function downloadSpotifyTrack(queryOrUrl, internetTools) {
  if (!internetTools) throw new Error('internetTools is required');
  const input = String(queryOrUrl || '').trim();
  if (!input) return { ok: false, error: 'Spotify query or URL required.' };

  let track;
  if (/^https?:\/\/open\.spotify\.com\//i.test(input)) {
    const meta = await internetTools.spotifyUrlMetadata(input);
    if (!meta?.ok) return { ok: false, error: meta?.error || 'Could not read Spotify track.' };
    track = { name: meta.title || '', artist: '', url: input };
  } else {
    const res = await internetTools.spotifySearch(input, 5);
    if (!res?.ok || !res.results?.length) return { ok: false, error: res?.error || 'No Spotify track found.' };
    const first = res.results.find(x => x.type === 'track') || res.results[0];
    track = { name: first.name || '', artist: first.artist || '', url: first.url };
  }

  // If the Spotify result already contains a clean title/artist, use both to improve
  // YouTube matching. Never pass a raw Spotify URL to yt-dlp.
  const ytQuery = [track.name, track.artist].filter(Boolean).join(' ').trim();
  if (!ytQuery) return { ok: false, error: 'Spotify result has no usable track title.' };
  // Resolve metadata through YouTube search, then use the same direct audio API as
  // the normal `play` command. No yt-dlp process is started for Spotify playback.
  const yt = await searchSong(ytQuery);
  if (!yt?.ok || !yt.url) return { ok: false, error: yt?.error || 'Could not resolve the track on YouTube.' };

  const dl = await playSong(ytQuery);
  if (!dl.ok) return { ok: false, error: dl.error, spotify: track, youtube: yt };
  return {
    ok: true,
    title: track.name || yt.title || dl.title,
    artist: track.artist || '',
    duration: yt.duration || dl.duration || '',
    spotifyUrl: track.url,
    youtubeUrl: yt.url || dl.video_url,
    source: 'YouTube audio API (resolved from Spotify search)',
    buffer: dl.buffer,
    thumbnail: dl.thumbnail,
  };
}

module.exports = { searchSong, resolveSongUrl, playSong, getLyrics, searchLyrics, searchMusic, generic, downloadSongAudio, downloadSpotifyTrack, compressAudioForWhatsApp };


/**
 * Compress downloaded audio before it is sent to WhatsApp.
 * Large source files (for example ~18 MB) are re-encoded to a much smaller
 * MP3. If ffmpeg is unavailable, the original file is kept so playback still
 * works instead of failing just because compression is unavailable.
 */
async function compressAudioForWhatsApp(file, opts = {}) {
  if (!file || !fs.existsSync(file)) return { ok: false, file, compressed: false, error: 'audio file missing' };

  const bitrate = String(opts.bitrate || process.env.AUDIO_COMPRESS_BITRATE || '96k');
  const timeout = Number(opts.timeout || process.env.AUDIO_COMPRESS_TIMEOUT_MS || 120000);
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  const compressed = `${base}_c.mp3`;
  const ffmpeg = process.env.FFMPEG_BIN || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();

  try {
    await execFileP(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-vn',
      '-b:a', bitrate,
      '-ac', '2',
      '-ar', '44100',
      compressed,
    ], { timeout, maxBuffer: 1024 * 1024 });

    if (!fs.existsSync(compressed) || fs.statSync(compressed).size === 0) {
      throw new Error('ffmpeg produced an empty file');
    }

    const before = fs.statSync(file).size;
    const after = fs.statSync(compressed).size;
    // Never replace a smaller source with a larger re-encode (common for very
    // short clips). Keep whichever file is smaller.
    if (after >= before) {
      try { fs.unlinkSync(compressed); } catch {}
      return { ok: true, file, compressed: false, beforeBytes: before, afterBytes: before, bitrate, warning: 'compressed file was not smaller; original retained' };
    }
    try { fs.unlinkSync(file); } catch {}
    return { ok: true, file: compressed, compressed: true, beforeBytes: before, afterBytes: after, bitrate };
  } catch (e) {
    // ffmpeg is an optimization, not a hard dependency. Keep the original.
    return { ok: true, file, compressed: false, bitrate, warning: `ffmpeg compression skipped: ${e.message}` };
  }
}

/** Download audio when a system yt-dlp binary is available. This is intentionally optional:
 * the bot still works as a music searcher when yt-dlp is absent. */
async function downloadSongAudio(url, title = 'song') {
  if (!url) return { ok: false, error: 'No source URL.' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-song-'));
  const out = path.join(dir, 'audio.%(ext)s');
  const safeTitle = String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'song';
  return new Promise((resolve) => {
    const args = [
      '--no-playlist', '--no-warnings', '--quiet', '--extract-audio', '--audio-format', 'mp3',
      '--audio-quality', '5', '-o', out, url,
    ];
    let command = process.env.YTDLP_BIN || 'yt-dlp';
    let proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => {
      // Optional Node wrapper fallback. This keeps the normal system yt-dlp path
      // fast while allowing hosts without a global yt-dlp binary to use the
      // package when it is already installed.
      try {
        require.resolve('youtube-dl-exec');
        const ytdl = require('youtube-dl-exec');
        const child = ytdl(url, {
          noPlaylist: true, noWarnings: true, quiet: true, extractAudio: true,
          audioFormat: 'mp3', audioQuality: '5', output: out,
        });
        let err = '';
        child.stderr?.on('data', d => { err += d.toString(); });
        child.then(() => {
          const files = fs.readdirSync(dir).filter(f => /\.(mp3|m4a|opus|webm)$/i.test(f));
          if (!files.length) return resolve({ ok: false, error: `yt-dlp produced no audio file. ${err.slice(-300)}`, dir });
          const rawFile = path.join(dir, files[0]);
          compressAudioForWhatsApp(rawFile).then(c => resolve({ ok: true, file: c.file, fileName: `${safeTitle}.mp3`, dir, compressed: c.compressed, beforeBytes: c.beforeBytes, afterBytes: c.afterBytes, compressionWarning: c.warning })).catch(() => resolve({ ok: true, file: rawFile, fileName: `${safeTitle}.mp3`, dir, compressed: false }));
        }).catch(err2 => resolve({ ok: false, error: `yt-dlp failed: ${err2.message || err}`, dir }));
      } catch (_) {
        resolve({ ok: false, error: `yt-dlp unavailable: ${e.message}`, dir });
      }
    });
    proc.on('close', code => {
      if (code !== 0) return resolve({ ok: false, error: `yt-dlp failed (${code}): ${err.slice(-500)}`, dir });
      const files = fs.readdirSync(dir).filter(f => /\.(mp3|m4a|opus|webm)$/i.test(f));
      if (!files.length) return resolve({ ok: false, error: 'yt-dlp produced no audio file.', dir });
      const rawFile = path.join(dir, files[0]);
      compressAudioForWhatsApp(rawFile).then(c => resolve({ ok: true, file: c.file, fileName: `${safeTitle}.mp3`, dir, compressed: c.compressed, beforeBytes: c.beforeBytes, afterBytes: c.afterBytes, compressionWarning: c.warning })).catch(() => resolve({ ok: true, file: rawFile, fileName: `${safeTitle}.mp3`, dir, compressed: false }));
    });
  });
}

});

runtime.define("canvas", "canvas.js", function(module, exports, require, __filename, __dirname) {
// @napi-rs/canvas (prebuilt native bindings, no system build toolchain needed unlike
// node-canvas). All drawing is local/deterministic — no external image API involved.
const { createCanvas, loadImage } = require('@napi-rs/canvas');

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth, startSize, minSize, fontWeight = 'bold') {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${fontWeight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

async function safeLoadImage(source) {
  try {
    return await loadImage(source);
  } catch {
    return null;
  }
}

/**
 * Rank/level card — ties into leveling.js's profile(): shows avatar, name, level,
 * and an XP progress bar toward the next level.
 */
async function rankCard({ name, avatarUrl, level, xp, xpIntoLevel, xpToNextLevel, rank }) {
  const W = 900, H = 300;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1f1147');
  grad.addColorStop(1, '#3d1a5b');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 24);
  ctx.fill();

  // avatar
  const avSize = 200, avX = 50, avY = 50;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const avatar = avatarUrl ? await safeLoadImage(avatarUrl) : null;
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = '#5b3a8e';
    ctx.fillRect(avX, avY, avSize, avSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 90px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').charAt(0).toUpperCase(), avX + avSize / 2, avY + avSize / 2 + 8);
  }
  ctx.restore();
  ctx.strokeStyle = '#ffffff33';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  // name
  const textX = 290;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, name || 'User', W - textX - 40, 46, 26);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(name || 'User', textX, 100);

  // level / rank
  ctx.font = '28px sans-serif';
  ctx.fillStyle = '#c9b6f0';
  ctx.fillText(`Level ${level}${rank ? `  •  Rank #${rank}` : ''}`, textX, 140);

  // xp bar
  const barX = textX, barY = 180, barW = W - textX - 60, barH = 34;
  ctx.fillStyle = '#00000055';
  roundRect(ctx, barX, barY, barW, barH, 17);
  ctx.fill();
  const total = xpIntoLevel + xpToNextLevel;
  const pct = total > 0 ? Math.min(1, xpIntoLevel / total) : 1;
  const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  fillGrad.addColorStop(0, '#7c3aed');
  fillGrad.addColorStop(1, '#c026d3');
  ctx.fillStyle = fillGrad;
  roundRect(ctx, barX, barY, Math.max(barH, barW * pct), barH, 17);
  ctx.fill();

  ctx.fillStyle = '#e6d9ff';
  ctx.font = '20px sans-serif';
  ctx.fillText(`${xpIntoLevel} / ${total} XP to level ${level + 1}`, barX, barY + barH + 30);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffffaa';
  ctx.font = '18px sans-serif';
  ctx.fillText(`${xp} total XP`, barX + barW, barY + barH + 30);

  return canvas.toBuffer('image/png');
}

/** Welcome card — avatar, name, and group name over a gradient banner. */
async function welcomeCard({ name, avatarUrl, groupName, memberCount }) {
  const W = 900, H = 400;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0f2027');
  grad.addColorStop(0.5, '#203a43');
  grad.addColorStop(1, '#2c5364');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const avSize = 180, avX = W / 2 - avSize / 2, avY = 50;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const avatar = avatarUrl ? await safeLoadImage(avatarUrl) : null;
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = '#3d6b7a';
    ctx.fillRect(avX, avY, avSize, avSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 80px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').charAt(0).toUpperCase(), avX + avSize / 2, avY + avSize / 2 + 8);
  }
  ctx.restore();
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, `Welcome, ${name || 'friend'}!`, W - 80, 44, 24);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(`Welcome, ${name || 'friend'}!`, W / 2, 280);

  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#bcd9e0';
  const sub = groupName ? `${groupName}${memberCount ? ` • Member #${memberCount}` : ''}` : '';
  if (sub) ctx.fillText(sub, W / 2, 325);

  return canvas.toBuffer('image/png');
}

/** Quote card — styled text on a dark gradient, for "make a quote image of this" requests. */
async function quoteCard({ text, author }) {
  const W = 900, H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0d0d0d');
  grad.addColorStop(1, '#232323');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#ffffff22';
  ctx.font = 'bold 160px serif';
  ctx.textAlign = 'left';
  ctx.fillText('“', 40, 160);

  // word-wrap the quote text
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  const maxWidth = W - 140;
  let size = 46;
  let lines = [];
  const words = String(text || '').split(/\s+/);
  while (size > 24) {
    ctx.font = `600 ${size}px sans-serif`;
    lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    if (lines.length <= 6) break;
    size -= 2;
  }
  const lineHeight = size * 1.35;
  const startY = H / 2 - (lines.length * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineHeight));

  if (author) {
    ctx.font = '28px sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`— ${author}`, W / 2, H - 50);
  }

  return canvas.toBuffer('image/png');
}

/** Ship/compatibility card — two avatars, a heart, and a % score. Purely for fun. */
async function shipCard({ nameA, avatarUrlA, nameB, avatarUrlB, percent }) {
  const W = 900, H = 400;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#3a0d2e');
  grad.addColorStop(1, '#7a1e4a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const avSize = 200, avY = 60;
  async function drawAvatar(url, cx, fallbackLetter) {
    const x = cx - avSize / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const img = url ? await safeLoadImage(url) : null;
    if (img) {
      ctx.drawImage(img, x, avY, avSize, avSize);
    } else {
      ctx.fillStyle = '#5b2a4e';
      ctx.fillRect(x, avY, avSize, avSize);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 90px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fallbackLetter, cx, avY + avSize / 2 + 8);
    }
    ctx.restore();
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  await drawAvatar(avatarUrlA, 230, (nameA || '?').charAt(0).toUpperCase());
  await drawAvatar(avatarUrlB, W - 230, (nameB || '?').charAt(0).toUpperCase());

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 90px sans-serif';
  ctx.fillStyle = '#ff5c8a';
  ctx.fillText('💗', W / 2, avY + avSize / 2);

  ctx.font = 'bold 64px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${percent}%`, W / 2, avY + avSize + 55);

  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#f0c6d8';
  const namesLine = fitText(ctx, `${nameA || 'A'} × ${nameB || 'B'}`, W - 80, 30, 18);
  ctx.font = `${namesLine}px sans-serif`;
  ctx.fillText(`${nameA || 'A'} × ${nameB || 'B'}`, W / 2, avY + avSize + 100);

  return canvas.toBuffer('image/png');
}

/** Visual leaderboard — top N entries as ranked rows with bars proportional to the top score. */
async function leaderboardCard({ title, entries }) {
  // entries: [{ label, value }] sorted descending, already resolved to display names
  if (!Array.isArray(entries) || !entries.length) return null;
  const rows = entries.slice(0, 10).map((r, i) => ({ label: r.label || r.name || `Player ${i+1}`, value: Number(r.value) || Number(r.score) || 0 })).filter(r => r.value > 0);
  const W = 900;
  const rowH = 62;
  const H = 140 + rows.length * rowH;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#111827');
  bg.addColorStop(1, '#1f2937');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title || 'Leaderboard', 40, 65);

  const maxVal = Math.max(1, ...rows.map((r) => r.value));
  const barX = 260, barMaxW = W - barX - 140, barH = 34;

  rows.forEach((row, i) => {
    const y = 110 + i * rowH;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(String(medal), 40, y + barH - 6);

    const nameW = 180;
    ctx.font = '22px sans-serif';
    ctx.fillStyle = '#d1d5db';
    const label = fitText(ctx, row.label, nameW, 22, 14, '400');
    ctx.font = `${label}px sans-serif`;
    ctx.fillText(row.label, 100, y + barH - 8);

    ctx.fillStyle = '#00000055';
    roundRect(ctx, barX, y, barMaxW, barH, 10);
    ctx.fill();
    const w = Math.max(10, (row.value / maxVal) * barMaxW);
    const barGrad = ctx.createLinearGradient(barX, 0, barX + w, 0);
    barGrad.addColorStop(0, '#6366f1');
    barGrad.addColorStop(1, '#a855f7');
    ctx.fillStyle = barGrad;
    roundRect(ctx, barX, y, w, barH, 10);
    ctx.fill();

    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(String(row.value), W - 40, y + barH - 8);
    ctx.textAlign = 'left';
  });

  return canvas.toBuffer('image/png');
}

/** Monster card — renders a card_game creature as a collectible-style card image. */
async function monsterCard({ name, type, rarity, emoji, hp, atk, def }) {
  const W = 500, H = 700;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const RARITY_COLORS = {
    common: ['#4b5563', '#6b7280'],
    uncommon: ['#065f46', '#10b981'],
    rare: ['#1e3a8a', '#3b82f6'],
    legendary: ['#78350f', '#f59e0b'],
  };
  const [c1, c2] = RARITY_COLORS[rarity] || RARITY_COLORS.common;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, c1);
  bg.addColorStop(1, c2);
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  ctx.fillStyle = '#00000055';
  roundRect(ctx, 20, 20, W - 40, H - 40, 20);
  ctx.fill();

  // emoji "art" area
  ctx.font = '180px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji || '❔', W / 2, 260);

  ctx.font = 'bold 44px sans-serif';
  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, name, W - 80, 44, 26);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(name, W / 2, 420);

  ctx.font = '24px sans-serif';
  ctx.fillStyle = '#ffffffcc';
  ctx.fillText(`${type} • ${(rarity || '').toUpperCase()}`, W / 2, 460);

  // stat pills
  const stats = [['HP', hp], ['ATK', atk], ['DEF', def]];
  const pillW = 130, pillH = 60, gap = 15, totalW = stats.length * pillW + (stats.length - 1) * gap;
  let x = (W - totalW) / 2;
  const y = 540;
  stats.forEach(([label, val]) => {
    ctx.fillStyle = '#ffffff22';
    roundRect(ctx, x, y, pillW, pillH, 12);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(label, x + pillW / 2, y + 22);
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(String(val), x + pillW / 2, y + 46);
    x += pillW + gap;
  });

  return canvas.toBuffer('image/png');
}

/** Composite profile card — avatar, name, equipped title, level/XP bar, and currency
 *  balance in one image. Combines leveling + economy + shop data. */
async function profileCard({ name, avatarUrl, title, level, xpIntoLevel, xpToNextLevel, balance, currencyName }) {
  const W = 900, H = 420;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1e293b');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 24);
  ctx.fill();

  // avatar
  const avSize = 220, avX = 50, avY = 60;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const avatar = avatarUrl ? await safeLoadImage(avatarUrl) : null;
  if (avatar) {
    ctx.drawImage(avatar, avX, avY, avSize, avSize);
  } else {
    ctx.fillStyle = '#334155';
    ctx.fillRect(avX, avY, avSize, avSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 100px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').charAt(0).toUpperCase(), avX + avSize / 2, avY + avSize / 2 + 8);
  }
  ctx.restore();
  ctx.strokeStyle = '#38bdf855';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  const textX = 320;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (title) {
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(title.toUpperCase(), textX, 90);
  }

  ctx.fillStyle = '#ffffff';
  const nameSize = fitText(ctx, name || 'User', W - textX - 40, 48, 26);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillText(name || 'User', textX, 140);

  ctx.font = '26px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`Level ${level}`, textX, 180);

  // xp bar
  const barX = textX, barY = 210, barW = W - textX - 60, barH = 30;
  ctx.fillStyle = '#00000055';
  roundRect(ctx, barX, barY, barW, barH, 15);
  ctx.fill();
  const total = xpIntoLevel + xpToNextLevel;
  const pct = total > 0 ? Math.min(1, xpIntoLevel / total) : 1;
  const xpGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  xpGrad.addColorStop(0, '#38bdf8');
  xpGrad.addColorStop(1, '#818cf8');
  ctx.fillStyle = xpGrad;
  roundRect(ctx, barX, barY, Math.max(barH, barW * pct), barH, 15);
  ctx.fill();
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '18px sans-serif';
  ctx.fillText(`${xpIntoLevel}/${total} XP`, barX, barY + barH + 26);

  // currency pill
  const pillY = 300, pillH = 70;
  ctx.fillStyle = '#ffffff11';
  roundRect(ctx, textX, pillY, W - textX - 60, pillH, 16);
  ctx.fill();
  ctx.fillStyle = '#facc15';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(`💰 ${balance} ${currencyName || ''}`.trim(), textX + 20, pillY + 45);

  return canvas.toBuffer('image/png');
}

/** Battle result card — two creature cards side by side with HP bars showing damage taken,
 *  and a winner banner. Takes cardGame.battle()'s `visual` field directly. */
async function battleCard({ challengerName, opponentName, visual, winner }) {
  const W = 900, H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 50px sans-serif';
  ctx.fillStyle = '#f4f4f5';
  ctx.fillText('⚔️', W / 2, 60);

  async function drawSide(side, cx, label, won) {
    const { card, maxHp, finalHp } = side;
    ctx.font = '110px sans-serif';
    ctx.fillText(card.emoji || '❔', cx, 180);

    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = won ? '#4ade80' : '#f4f4f5';
    ctx.fillText(card.name, cx, 260);

    ctx.font = '18px sans-serif';
    ctx.fillStyle = '#a1a1aa';
    ctx.fillText(`${label} • ${card.type}`, cx, 290);

    // HP bar
    const barW = 260, barH = 26, barX = cx - barW / 2, barY = 320;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#3f3f46';
    roundRect(ctx, barX, barY, barW, barH, 13);
    ctx.fill();
    const pct = maxHp > 0 ? finalHp / maxHp : 0;
    ctx.fillStyle = pct > 0.5 ? '#22c55e' : pct > 0.2 ? '#eab308' : '#ef4444';
    roundRect(ctx, barX, barY, Math.max(pct > 0 ? 10 : 0, barW * pct), barH, 13);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`${finalHp} / ${maxHp} HP`, cx, barY + barH + 24);

    if (won) {
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = '#4ade80';
      ctx.fillText('🏆 WINNER', cx, barY + barH + 60);
    }
  }

  if (!visual || !visual.challenger || !visual.opponent) return null;
  await drawSide(visual.challenger, W * 0.27, challengerName, winner === 'challenger');
  await drawSide(visual.opponent, W * 0.73, opponentName, winner === 'opponent');

  ctx.font = 'bold 60px sans-serif';
  ctx.fillStyle = '#71717a';
  ctx.fillText('VS', W / 2, 200);

  return canvas.toBuffer('image/png');
}


/**
 * Tweet-style card (X/Twitter lookalike) for funny posts / debate prompts.
 */
async function tweetCard({ handle, name, text, likes, theme = 'dark' }) {
  const W = 900;
  const pad = 36;
  const avatar = 64;
  // measure wrapped text height
  const canvas0 = createCanvas(W, 200);
  const ctx0 = canvas0.getContext('2d');
  ctx0.font = '32px sans-serif';
  const maxTextW = W - pad * 2;
  const words = String(text || '').replace(/\n/g, ' \n ').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (w === '\n') { lines.push(line); line = ''; continue; }
    const test = line ? line + ' ' + w : w;
    if (ctx0.measureText(test).width > maxTextW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  const lineH = 42;
  const textBlock = Math.max(lines.length, 1) * lineH;
  const H = pad + avatar + 20 + textBlock + 56 + pad;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // background
  if (theme === 'light') {
    ctx.fillStyle = '#ffffff';
  } else {
    ctx.fillStyle = '#000000';
  }
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  // subtle border
  ctx.strokeStyle = theme === 'light' ? '#eff3f4' : '#2f3336';
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, W - 2, H - 2, 28);
  ctx.stroke();

  // avatar circle
  const ax = pad, ay = pad;
  const grad = ctx.createLinearGradient(ax, ay, ax + avatar, ay + avatar);
  grad.addColorStop(0, '#1d9bf0');
  grad.addColorStop(1, '#7856ff');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(ax + avatar / 2, ay + avatar / 2, avatar / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const initial = String(name || handle || 'B').charAt(0).toUpperCase();
  ctx.fillText(initial, ax + avatar / 2, ay + avatar / 2 + 1);

  // name + handle
  const tx = ax + avatar + 16;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme === 'light' ? '#0f1419' : '#e7e9ea';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(String(name || 'Broken').slice(0, 28), tx, ay + 28);
  ctx.fillStyle = theme === 'light' ? '#536471' : '#71767b';
  ctx.font = '24px sans-serif';
  ctx.fillText('@' + String(handle || 'broken').replace(/^@/, '').slice(0, 24), tx, ay + 58);

  // verified badge
  ctx.fillStyle = '#1d9bf0';
  const nx = tx + ctx.measureText(String(name || 'Broken').slice(0, 28)).width + 10;
  // measure name width with bold font
  ctx.font = 'bold 28px sans-serif';
  const nameW = ctx.measureText(String(name || 'Broken').slice(0, 28)).width;
  const bx = tx + nameW + 12;
  ctx.beginPath();
  ctx.arc(bx, ay + 20, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✓', bx, ay + 25);

  // body text
  ctx.textAlign = 'left';
  ctx.fillStyle = theme === 'light' ? '#0f1419' : '#e7e9ea';
  ctx.font = '32px sans-serif';
  let y = ay + avatar + 28;
  for (const ln of lines) {
    ctx.fillText(ln, pad, y);
    y += lineH;
  }

  // footer metrics
  y = H - pad - 8;
  const likesN = likes != null ? likes : (Math.floor(Math.random() * 8000) + 120);
  const rts = Math.floor(likesN * 0.35);
  ctx.fillStyle = theme === 'light' ? '#536471' : '#71767b';
  ctx.font = '22px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`♡  ${likesN.toLocaleString()}    ↻  ${rts.toLocaleString()}    💬  ${Math.floor(rts * 0.4)}`, pad, y);

  // X logo corner
  ctx.fillStyle = theme === 'light' ? '#0f1419' : '#e7e9ea';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('𝕏', W - pad, pad + 28);

  return canvas.toBuffer('image/png');
}


/** Support / donate card with bank details. */
async function donateCard({ name, bank, account, subtitle }) {
  const W = 900, H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0f2027');
  grad.addColorStop(0.5, '#203a43');
  grad.addColorStop(1, '#2c5364');
  ctx.fillStyle = grad;
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, 40, 40, W - 80, H - 80, 20);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🙏 Support the Project', W / 2, 110);

  ctx.font = '28px sans-serif';
  ctx.fillStyle = '#a8dadc';
  ctx.fillText(String(subtitle || 'Thank you for your kindness'), W / 2, 160);

  const rows = [
    ['👤 Name', String(name || '')],
    ['🏦 Bank', String(bank || '')],
    ['💳 Account', String(account || '')],
  ];
  let y = 230;
  ctx.textAlign = 'left';
  for (const [label, value] of rows) {
    ctx.fillStyle = '#90e0ef';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(label, 100, y);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText(value, 100, y + 42);
    y += 95;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#caf0f8';
  ctx.font = '22px sans-serif';
  ctx.fillText('Every support keeps the bots running ❤️', W / 2, H - 50);

  return canvas.toBuffer('image/png');
}

module.exports = { donateCard, rankCard, welcomeCard, quoteCard, shipCard, leaderboardCard, monsterCard, profileCard, battleCard, tweetCard };


});

runtime.define("fixer", "fixer.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const AdmZip = require('adm-zip');
const logger = require('../logger');

const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'html', 'css', 'scss', 'json', 'yml', 'yaml', 'sh', 'bash', 'md', 'txt', 'xml', 'sql', 'vue', 'svelte',
]);

function isCode(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return CODE_EXT.has(ext);
}

function safeName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function extractToWorkspace(buffer) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-fix-'));
  const zip = new AdmZip(buffer);
  for (const e of zip.getEntries()) {
    const name = safeName(e.entryName);
    if (!name || name.includes('..') || name.startsWith('/')) continue;
    if (name.includes('node_modules/') || name.startsWith('__MACOSX')) continue;
    const dest = path.join(work, name);
    if (e.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }
  // Prefer single top-level folder as root
  const top = fs.readdirSync(work).filter((n) => n !== '__MACOSX' && !n.startsWith('.'));
  let root = work;
  if (top.length === 1 && fs.statSync(path.join(work, top[0])).isDirectory()) {
    root = path.join(work, top[0]);
  }
  return { work, root };
}

function listCodeFiles(root, maxFiles = 80, maxBytes = 120000) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (out.length >= maxFiles) break;
      if (['node_modules', '.git', 'dist', 'build', '__MACOSX', '.next'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (isCode(ent.name)) {
        try {
          const st = fs.statSync(p);
          if (st.size > 250000) continue;
          const content = fs.readFileSync(p, 'utf8');
          out.push({
            rel: path.relative(root, p).replace(/\\/g, '/'),
            abs: p,
            content: content.slice(0, maxBytes),
            full: content,
            size: st.size,
          });
        } catch {}
      }
    }
  };
  walk(root);
  return out;
}

function listAllFiles(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (['node_modules', '.git', '__MACOSX'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out;
}

async function fixWithAI(aiClient, files, complaint, tree) {
  const codeCtx = files
    .map((f) => `===== FILE: ${f.rel} =====\n${f.content}`)
    .join('\n\n');

  const prompt = `You are a senior engineer fixing a whole project zip, not a single file.

PROBLEM: ${complaint}

Project tree:
${tree.slice(0, 80).join('\n')}

Code files (full contents where size allows):
${codeCtx}

YOUR JOB:
1. Read ALL listed files. Find every issue tied to the problem (blank page, truncated HTML, missing sections, broken CSS/JS links, incomplete tags, etc.).
2. Fix EVERY affected file — not just one. Typical static sites need index.html + CSS + JS together.
3. Output COMPLETE file contents for each changed file (never a partial snippet).
4. After writing fixes, mentally verify: HTML has full html/head/body and closed tags; linked CSS/JS paths exist; no blank main content if the design should show sections.

Output format — one block per file:

\`\`\`fix:path/to/file.ext
<full file content>
\`\`\`

Then:

\`\`\`CHANGELOG
- path/to/file.ext: what changed
\`\`\`

Rules:
- Prefer complete working pages over minimal patches when content was truncated or blank
- If index.html is truncated mid-tag or body is empty, rebuild the missing sections to match the project purpose
- Include CSS/JS changes when layout/behavior is broken
- Keep working unrelated files intact
- If truly nothing is wrong, output exactly: NO_FIX_NEEDED
- CHANGELOG must list every file you changed`;

  // Force primary Agnes path via simpleComplete (no Qwen)
  const answer = await aiClient.simpleComplete(
    prompt,
    'You are an expert software debugger. Output ```fix:path blocks, then optional ```CHANGELOG, or NO_FIX_NEEDED.',
    { coding: true },
  );
  if (!String(answer || '').trim()) {
    throw new Error('Empty response from coding model while fixing zip');
  }
  if (/NO_FIX_NEEDED/i.test(answer)) return { files: {}, changelog: [] };

  const changed = {};
  const re = /```fix:([^\n]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(answer)) !== null) {
    const p = m[1].trim().replace(/^\.\//, '');
    changed[p] = m[2].replace(/\n$/, '');
  }
  // Also accept ```path style
  const re2 = /```([a-z0-9_./-]+\.[a-z0-9]+)\n([\s\S]*?)```/gi;
  while ((m = re2.exec(answer)) !== null) {
    const p = m[1].trim();
    if (!changed[p] && !/^(fix|js|ts|python|bash|json|CHANGELOG)/i.test(p)) {
      // skip language-only tags without path
    }
  }

  const changelog = [];
  const cl = /```CHANGELOG\n([\s\S]*?)```/i.exec(answer);
  if (cl) {
    for (const line of cl[1].split(/\r?\n/)) {
      const t = line.replace(/^[-*•]\s*/, '').trim();
      if (t) changelog.push(t);
    }
  }
  // Fallback: one line per changed file if model skipped CHANGELOG
  if (!changelog.length) {
    for (const p of Object.keys(changed)) {
      changelog.push(`${p}: updated to address reported issue`);
    }
  }
  return { files: changed, changelog };
}

async function verifyProject(root) {
  const checks = [];
  // package.json → syntax-check main entry if node
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      checks.push({ name: 'package.json', ok: true });
      const main = pkg.main || 'index.js';
      const mainPath = path.join(root, main);
      if (fs.existsSync(mainPath) && /\.m?js$/i.test(main)) {
        try {
          await execFileP(process.execPath, ['--check', mainPath], { timeout: 15000 });
          checks.push({ name: `node --check ${main}`, ok: true });
        } catch (e) {
          checks.push({ name: `node --check ${main}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 300) });
        }
      }
      // check a few js files
      const jsFiles = listCodeFiles(root, 8, 500).filter((f) => /\.m?jsx?$/i.test(f.rel));
      for (const f of jsFiles.slice(0, 5)) {
        try {
          await execFileP(process.execPath, ['--check', f.abs], { timeout: 10000 });
          checks.push({ name: `syntax ${f.rel}`, ok: true });
        } catch (e) {
          checks.push({ name: `syntax ${f.rel}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 200) });
        }
      }
    } catch (e) {
      checks.push({ name: 'package.json', ok: false, error: e.message });
    }
  } else {
    // Plain JS/HTML project — syntax-check any .js
    const jsFiles = listCodeFiles(root, 12, 500).filter((f) => /\.m?jsx?$/i.test(f.rel));
    for (const f of jsFiles.slice(0, 6)) {
      try {
        await execFileP(process.execPath, ['--check', f.abs], { timeout: 10000 });
        checks.push({ name: `syntax ${f.rel}`, ok: true });
      } catch (e) {
        checks.push({ name: `syntax ${f.rel}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 200) });
      }
    }
    if (!jsFiles.length) {
      checks.push({ name: 'static/html project', ok: true, note: 'no JS to syntax-check' });
    }
  }

  // Python files
  const py = listCodeFiles(root, 6, 500).filter((f) => f.rel.endsWith('.py'));
  for (const f of py.slice(0, 3)) {
    try {
      await execFileP('python3', ['-m', 'py_compile', f.abs], { timeout: 10000 });
      checks.push({ name: `py_compile ${f.rel}`, ok: true });
    } catch (e) {
      checks.push({ name: `py_compile ${f.rel}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 200) });
    }
  }

  const failed = checks.filter((c) => c.ok === false);
  return { ok: failed.length === 0, checks, failed };
}

function zipWorkspace(root, work) {
  const zip = new AdmZip();
  const walk = (dir, prefix = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '__MACOSX'].includes(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else zip.addLocalFile(abs, path.dirname(rel) === '.' ? '' : path.dirname(rel), ent.name);
    }
  };
  walk(root);
  const out = path.join(os.tmpdir(), `fixed_${Date.now()}.zip`);
  zip.writeZip(out);
  return out;
}

/**
 * Full pipeline: extract → fix → write → verify → zip
 */
async function fixZip(buffer, complaint, aiClient) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { ok: false, error: 'Empty or invalid zip buffer.' };
  }
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    return { ok: false, error: 'Not a valid zip (missing PK header). Resend the file.' };
  }

  let work, root;
  try {
    ({ work, root } = extractToWorkspace(buffer));
  } catch (e) {
    return { ok: false, error: `Could not extract zip: ${e.message}` };
  }

  try {
    const tree = listAllFiles(root);
    if (!tree.length) return { ok: false, error: 'Zip is empty after extract.' };

    const codeFiles = listCodeFiles(root);
    if (!codeFiles.length) {
      return { ok: false, error: 'No readable code files found in that zip.' };
    }

    let fixResult;
    try {
      fixResult = await fixWithAI(aiClient, codeFiles, complaint, tree);
    } catch (e) {
      const msg = String(e.message || e);
      if (/Cannot POST|<!DOCTYPE|__CF\$|qwen/i.test(msg)) {
        return { ok: false, error: 'AI fix failed — check AGNES_API_KEY (Qwen is permanently removed).' };
      }
      return { ok: false, error: `AI fix failed: ${msg.slice(0, 240)}` };
    }

    // Back-compat: older shape was a plain { path: content } map
    let changed = fixResult?.files && typeof fixResult.files === 'object' && !Array.isArray(fixResult.files)
      ? fixResult.files
      : (fixResult && !fixResult.files ? fixResult : {});
    let changelog = Array.isArray(fixResult?.changelog) ? fixResult.changelog : [];

    // Second pass if model only touched 1 file but project has more code and complaint is structural
    const broad = /blank|empty|broken|all|whole|entire|layout|page|section|css|js|html|everything|truncated/i.test(complaint || '');
    if (Object.keys(changed).length === 1 && codeFiles.length > 1 && broad) {
      try {
        // Apply first pass to in-memory file list for second review
        const merged = codeFiles.map((f) => {
          if (changed[f.rel] != null) {
            return { ...f, content: String(changed[f.rel]).slice(0, 120000), full: String(changed[f.rel]) };
          }
          return f;
        });
        const pass2 = await fixWithAI(
          aiClient,
          merged,
          complaint + '\n\nSECOND PASS: You only changed one file before. Review CSS/JS and any other files that must change for a complete fix. Output every remaining file that still needs updates.',
          tree,
        );
        const more = pass2?.files && typeof pass2.files === 'object' ? pass2.files : {};
        for (const [k, v] of Object.entries(more)) changed[k] = v;
        if (Array.isArray(pass2?.changelog)) changelog = changelog.concat(pass2.changelog);
      } catch (e2) {
        logger.warn({ err: e2.message }, 'fix second pass skipped');
      }
    }

    if (!Object.keys(changed).length) {
      return {
        ok: true,
        noChanges: true,
        message: "I read the project and didn't need changes for that report. Describe the exact error/stack if it's still broken.",
      };
    }

    // Write fixes into workspace
    const written = [];
    for (const [rel, content] of Object.entries(changed)) {
      const abs = path.join(root, rel);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        written.push(rel);
      } catch (e) {
        logger.warn({ rel, err: e.message }, 'fix write failed');
      }
    }

    // Verify
    let verify = { ok: true, checks: [] };
    try {
      verify = await verifyProject(root);
    } catch (e) {
      verify = { ok: false, checks: [], failed: [{ name: 'verify', error: e.message }] };
    }

    // If verify failed, one repair pass on failing files
    if (!verify.ok && verify.failed?.length) {
      try {
        const failNote = verify.failed.map((f) => `${f.name}: ${f.error || 'fail'}`).join('\n');
        const repairResult = await fixWithAI(
          aiClient,
          listCodeFiles(root),
          `After first fix, verification failed:\n${failNote}\nOriginal problem: ${complaint}`,
          tree,
        );
        const repair = repairResult?.files && typeof repairResult.files === 'object' && !Array.isArray(repairResult.files)
          ? repairResult.files
          : (repairResult && !repairResult.files ? repairResult : {});
        if (Array.isArray(repairResult?.changelog)) {
          changelog = changelog.concat(repairResult.changelog);
        }
        for (const [rel, content] of Object.entries(repair)) {
          const abs = path.join(root, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
          if (!written.includes(rel)) written.push(rel);
        }
        verify = await verifyProject(root);
      } catch (e) {
        logger.warn({ err: e.message }, 'repair pass failed');
      }
    }

    if (!changelog.length) {
      changelog = written.map((p) => `${p}: updated to address reported issue`);
    }

    const zipPath = zipWorkspace(root, work);
    return {
      ok: true,
      zipPath,
      changed: written,
      changelog,
      complaint,
      verified: verify.ok,
      verifyChecks: verify.checks,
      message: verify.ok
        ? `Fixed ${written.length} file(s) and verification passed.`
        : `Fixed ${written.length} file(s); some verification checks still fail — review the zip.`,
    };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { fixZip, listCodeFiles, verifyProject, isCode };

});
};
