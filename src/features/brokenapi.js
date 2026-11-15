// features/brokenapi.js — helpers for the BROKEN APIs (play/lyrics/music/search).
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
    console.warn('[brokenapi] alldl path:', e.message);
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
      console.warn('[brokenapi] music path failed:', e.message);
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

module.exports = { searchSong, playSong, getLyrics, searchLyrics, searchMusic, generic, downloadSongAudio, downloadSpotifyTrack, compressAudioForWhatsApp };


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
