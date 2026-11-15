// internetTools.js — lightweight public-web utilities used by Broken.
// These implementations use public metadata/search surfaces rather than copying
// third-party snippet code verbatim. They are intentionally dependency-light.
const axios = require('axios');
const cheerioLike = (html) => {
  const pick = (name) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
    const m = html.match(re);
    return m ? decodeHtml(m[1]) : null;
  };
  return { title: pick('og:title') || pick('twitter:title'), image: pick('og:image') || pick('twitter:image'), video: pick('og:video') || pick('twitter:player:stream'), description: pick('og:description') || pick('description') };
};
function decodeHtml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function cleanUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported.');
  return u.toString();
}
async function get(url, timeout = 20000) {
  return axios.get(cleanUrl(url), { timeout, maxRedirects: 4, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrokenBot/1.0)' }, responseType: 'text' });
}

async function npmSearch(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Package query required.' };
  const { data } = await axios.get('https://registry.npmjs.org/-/v1/search', { params: { text: q, size: Math.min(Math.max(Number(limit) || 8, 1), 20) }, timeout: 15000 });
  return { ok: true, query: q, results: (data.objects || []).map((o) => ({ name: o.package?.name, version: o.package?.version, description: o.package?.description || '', weeklyDownloads: o.downloads?.weekly || null, links: o.package?.links || {} })) };
}

async function npmPackage(name) {
  const pkg = String(name || '').trim();
  if (!pkg) return { ok: false, error: 'Package name required.' };
  const { data } = await axios.get(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, { timeout: 15000 });
  const latest = data['dist-tags']?.latest;
  const v = latest ? data.versions?.[latest] : null;
  return { ok: true, name: data.name, latest, description: data.description || '', license: v?.license || data.license || null, homepage: data.homepage || v?.homepage || null, repository: data.repository || v?.repository || null, dependencies: v?.dependencies || {} };
}

async function youtubeSearch(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'YouTube search query required.' };
  // Prefer the bot's existing search API; no scraping snippet code is required.
  try {
    const broken = require('./brokenapi');
    const r = await broken.searchSong(q);
    if (r?.ok) return { ok: true, results: [{ title: r.title, url: r.url, duration: r.duration, thumbnail: r.thumbnail }].slice(0, limit) };
  } catch {}
  try {
    const { data } = await axios.get('https://www.youtube.com/results', { params: { search_query: q }, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const out = [];
    const re = /"videoRenderer":\{.*?"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
    let m;
    while ((m = re.exec(data)) && out.length < limit) out.push({ title: decodeHtml(m[2]), url: `https://www.youtube.com/watch?v=${m[1]}` });
    return { ok: true, results: out };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function spotifyUrlMetadata(url) {
  const u = cleanUrl(url);
  if (!/open\.spotify\.com$/i.test(new URL(u).hostname)) throw new Error('Use an open.spotify.com URL.');
  const { data } = await get(u);
  const meta = cheerioLike(data);
  return { ok: true, url: u, title: meta.title, description: meta.description, image: meta.image };
}

async function spotifySearch(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Spotify search query required.' };
  try {
    const { data } = await get(`https://open.spotify.com/search/${encodeURIComponent(q)}`);
    const meta = cheerioLike(data);
    // Spotify's page embeds useful JSON in __NEXT_DATA__; keep parsing best-effort.
    const m = data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    const hits = [];
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const raw = JSON.stringify(j);
        const re = /\"name\":\"([^\"\\]*(?:\\.[^\"\\]*)*)\",\"uri\":\"spotify:(track|album|artist):([^\"]+)\"/g;
        let x;
        while ((x = re.exec(raw)) && hits.length < limit) {
          const name = x[1].replace(/\\"/g, '"');
          const type = x[2];
          const id = x[3];
          hits.push({ name, type, id, url: `https://open.spotify.com/${type}/${id}` });
        }
      } catch {}
    }
    // Spotify's web markup changes frequently. A second, deliberately conservative
    // fallback extracts track URIs from the raw HTML when __NEXT_DATA__ is absent.
    if (!hits.length) {
      const re = /spotify:(track|album|artist):([A-Za-z0-9]+)/g;
      const seen = new Set(); let x;
      while ((x = re.exec(data)) && hits.length < limit) {
        const key = `${x[1]}:${x[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ name: meta.title || q, type: x[1], id: x[2], url: `https://open.spotify.com/${x[1]}/${x[2]}` });
      }
    }
    return { ok: true, query: q, pageTitle: meta.title, results: hits };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function publicPageMedia(url, site) {
  const u = cleanUrl(url);
  const host = new URL(u).hostname.toLowerCase();
  if (site === 'pinterest' && !host.includes('pinterest.')) throw new Error('That is not a Pinterest URL.');
  if (site === 'telegram' && !(host === 't.me' || host.endsWith('.t.me') || host.includes('telegram.me'))) throw new Error('That is not a Telegram public URL.');
  const { data } = await get(u);
  const meta = cheerioLike(data);
  // Also look for direct media URLs in common public-page markup.
  const videos = [...String(data).matchAll(/https?:\\?\/\\?\/[^"]+\.(?:mp4|webm)(?:\?[^"]*)?/ig)].map(m => m[0].replace(/\\\\\//g, '/'));
  const images = [...String(data).matchAll(/https?:\\?\/\\?\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?/ig)].map(m => m[0].replace(/\\\\\//g, '/'));
  return { ok: true, source: site, url: u, title: meta.title, description: meta.description, image: meta.image || images[0] || null, video: meta.video || videos[0] || null };
}


function isPrivateIp(hostname) {
  // Resolve-free checks for common private/local destinations. The bot should not
  // be usable as an SSRF proxy against its own machine or cloud metadata services.
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^(metadata\.google\.internal|metadata\.google|instance-data\.ec2\.internal)$/i.test(h)) return true;
  return false;
}

function safeApiUrl(raw) {
  const u = new URL(String(raw || '').trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only public http(s) API endpoints are supported.');
  if (u.username || u.password) throw new Error('Credentials embedded in the URL are not allowed. Use headers instead.');
  if (isPrivateIp(u.hostname)) throw new Error('Local/private/internal API addresses are blocked for safety.');
  return u.toString();
}

function parseMaybeJson(text, contentType) {
  if (!text) return null;
  if (/json/i.test(contentType || '')) {
    try { return JSON.parse(text); } catch {}
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function apiTest({ url, method = 'GET', headers = {}, body, timeout = 15000 } = {}) {
  const target = safeApiUrl(url);
  const verb = String(method || 'GET').toUpperCase();
  const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  if (!allowed.includes(verb)) return { ok: false, error: `Unsupported HTTP method: ${verb}` };
  if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) return { ok: false, error: 'headers must be an object.' };

  const maxTimeout = Math.min(Math.max(Number(timeout) || 15000, 1000), 30000);
  let requestBody = body;
  const outHeaders = { 'User-Agent': 'BrokenBot/API-Test', 'Accept': 'application/json, text/plain, */*', ...headers };
  if (requestBody !== undefined && requestBody !== null && typeof requestBody === 'object' && !Buffer.isBuffer(requestBody)) {
    requestBody = JSON.stringify(requestBody);
    const hasContentType = Object.keys(outHeaders).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType) outHeaders['Content-Type'] = 'application/json';
  } else if (requestBody !== undefined && requestBody !== null) {
    requestBody = String(requestBody);
  }
  if (['GET', 'HEAD'].includes(verb)) requestBody = undefined;

  const started = Date.now();
  try {
    const res = await axios({
      url: target, method: verb, headers: outHeaders, data: requestBody,
      timeout: maxTimeout, maxRedirects: 4, validateStatus: () => true,
      responseType: 'text', transformResponse: [(x) => x],
    });
    const elapsedMs = Date.now() - started;
    const text = String(res.data ?? '');
    const contentType = res.headers?.['content-type'] || '';
    const parsed = parseMaybeJson(text, contentType);
    const preview = text.length > 12000 ? text.slice(0, 12000) + '\n…[truncated]' : text;
    const safeHeaders = {};
    for (const [k, v] of Object.entries(res.headers || {})) {
      // Never echo obvious credential material back into the chat.
      if (/authorization|cookie|set-cookie|proxy-auth|www-authenticate/i.test(k)) safeHeaders[k] = '[redacted]';
      else safeHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      statusText: res.statusText,
      method: verb,
      url: target,
      elapsedMs,
      contentType,
      responseHeaders: safeHeaders,
      json: parsed,
      body: parsed !== null ? undefined : preview,
      bodyLength: Buffer.byteLength(text),
    };
  } catch (e) {
    return {
      ok: false, method: verb, url: target, elapsedMs: Date.now() - started,
      error: e.code === 'ECONNABORTED' ? `Request timed out after ${maxTimeout}ms.` : e.message,
      code: e.code || null,
    };
  }
}

module.exports = { npmSearch, npmPackage, youtubeSearch, spotifySearch, spotifyUrlMetadata, apiTest, pinterest: (url) => publicPageMedia(url, 'pinterest'), telegramPublic: (url) => publicPageMedia(url, 'telegram') };
