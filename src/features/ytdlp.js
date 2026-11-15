// ytdlp.js — real yt-dlp wrapper for video AND audio downloads.
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
