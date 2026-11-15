// websearch2.js — Node-only web browsing for the WhatsApp agent.
// Search order: Bing HTML -> Brave API -> DuckDuckGo -> Wikipedia.
// No Python dependency. Search results are enriched with readable page content so the AI
// can answer from what it actually found instead of hallucinating from titles/snippets.
const https = require('https');
const http = require('http');
const { URL } = require('url');

function httpGet(url, timeout = 15000, headers = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 0, headers: {}, body: '' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 BrokenAgent/2.0',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (data.length < 2_000_000) data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: data }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
    req.end();
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripHtml(s) {
  return decodeEntities(String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim());
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return /^(metadata\.google\.internal|metadata\.google|instance-data\.ec2\.internal)$/i.test(h);
}

function safeUrl(raw) {
  const u = new URL(String(raw || '').trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported.');
  if (u.username || u.password) throw new Error('Credentials in URLs are not allowed.');
  if (isPrivateHost(u.hostname)) throw new Error('Private/internal URLs are blocked.');
  return u.toString();
}

async function bingSearch(query, limit = 8) {
  const u = new URL('https://www.bing.com/search');
  u.searchParams.set('q', query);
  u.searchParams.set('count', String(Math.min(20, Math.max(1, limit))));
  u.searchParams.set('setlang', process.env.SEARCH_LANG || 'en');
  const r = await httpGet(u.toString(), 15000);
  if (!r.body || r.status < 200 || r.status >= 400) return [];
  const results = [];
  const re = /<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(r.body)) && results.length < limit) {
    const block = m[1];
    const a = block.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url;
    try { url = safeUrl(decodeEntities(a[1])); } catch { continue; }
    const title = stripHtml(a[2]);
    const sm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title, url, snippet: stripHtml(sm?.[1] || ''), source: 'Bing' });
  }
  return results;
}

async function braveSearch(query, limit = 8, freshness = '') {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', query); u.searchParams.set('count', String(Math.min(20, limit)));
  u.searchParams.set('country', process.env.SEARCH_COUNTRY || 'NG');
  u.searchParams.set('search_lang', process.env.SEARCH_LANG || 'en');
  if (freshness) u.searchParams.set('freshness', freshness);
  const r = await httpGet(u.toString(), 15000, { Accept: 'application/json', 'X-Subscription-Token': key });
  try {
    const d = JSON.parse(r.body);
    return (d.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description || '', source: 'Brave', published: x.age || x.page_age || '' }));
  } catch { return []; }
}


/** DuckDuckGo HTML version — no API key. */
async function ddgHtmlSearch(query, limit = 8) {
  const urls = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
  ];
  const out = [];
  for (const target of urls) {
    try {
      const r = await httpGet(target, 15000, {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        Accept: 'text/html',
      });
      if (!r.body || r.status >= 400) continue;
      // html.duckduckgo.com result links
      const re = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(r.body)) && out.length < limit) {
        let url = decodeEntities(m[1]);
        // DDG wraps redirects: //duckduckgo.com/l/?uddg=...
        const uddg = url.match(/[?&]uddg=([^&]+)/);
        if (uddg) {
          try { url = decodeURIComponent(uddg[1]); } catch {}
        }
        try { url = safeUrl(url); } catch { continue; }
        const title = stripHtml(m[2]);
        if (!title) continue;
        out.push({ title, url, snippet: '', source: 'DuckDuckGo' });
      }
      // lite results
      if (!out.length) {
        const re2 = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m2;
        while ((m2 = re2.exec(r.body)) && out.length < limit) {
          let url;
          try { url = safeUrl(decodeEntities(m2[1])); } catch { continue; }
          if (/duckduckgo\.com/i.test(url)) continue;
          out.push({ title: stripHtml(m2[2]).slice(0, 120), url, snippet: '', source: 'DuckDuckGo' });
        }
      }
      if (out.length) break;
    } catch {}
  }
  return out.slice(0, limit);
}

/** Google web search HTML scrape — no API key (best-effort, may be blocked). */
async function googleHtmlSearch(query, limit = 8) {
  try {
    const u = new URL('https://www.google.com/search');
    u.searchParams.set('q', query);
    u.searchParams.set('hl', process.env.SEARCH_LANG || 'en');
    u.searchParams.set('num', String(Math.min(10, limit)));
    const r = await httpGet(u.toString(), 15000, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    if (!r.body || r.status >= 400) return [];
    const out = [];
    const re = /<a[^>]+href=["']\/url\?q=([^"'&]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(r.body)) && out.length < limit) {
      let url;
      try { url = safeUrl(decodeURIComponent(m[1])); } catch { continue; }
      if (/google\.(com|co\.)/i.test(url)) continue;
      const title = stripHtml(m[2]);
      if (!title || title.length < 2) continue;
      out.push({ title, url, snippet: '', source: 'Google' });
    }
    // Alternate: data-href or standard result blocks
    if (!out.length) {
      const re2 = /href=["'](https?:\/\/(?!www\.google\.)[^"']+)["'][^>]*><h3[^>]*>([\s\S]*?)<\/h3>/gi;
      let m2;
      while ((m2 = re2.exec(r.body)) && out.length < limit) {
        let url;
        try { url = safeUrl(m2[1]); } catch { continue; }
        out.push({ title: stripHtml(m2[2]), url, snippet: '', source: 'Google' });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function ddgInstant(query) {
  const r = await httpGet(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  const out = [];
  try {
    const d = JSON.parse(r.body);
    if (d.AbstractText) out.push({ title: d.Heading || query, url: d.AbstractURL || '', snippet: d.AbstractText, source: 'DuckDuckGo' });
    for (const t of d.RelatedTopics || []) {
      if (t.Text) out.push({ title: t.Text.slice(0, 120), url: t.FirstURL || '', snippet: t.Text, source: 'DuckDuckGo' });
      if (out.length >= 5) break;
    }
  } catch {}
  return out;
}

async function wikiSearch(query) {
  const r = await httpGet(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=4`);
  const out = [];
  try {
    const d = JSON.parse(r.body);
    for (const x of d.query?.search || []) {
      const title = x.title;
      out.push({ title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, snippet: stripHtml(x.snippet), source: 'Wikipedia' });
    }
  } catch {}
  return out;
}

function freshnessFor(query) {
  const q = String(query).toLowerCase();
  return /\b(today|latest|current|now|breaking|news|this hour|this week|2026)\b/.test(q) ? 'pw' : '';
}

async function searchBest(query, limit = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  const freshness = freshnessFor(q);
  // Free cascade — no API keys required
  let results = await bingSearch(q, Math.max(limit, 8));
  if (!results.length) results = await ddgHtmlSearch(q, Math.max(limit, 8));
  if (!results.length) results = await googleHtmlSearch(q, Math.max(limit, 8));
  if (!results.length) results = await braveSearch(q, Math.max(limit, 8), freshness);
  if (!results.length) {
    const [a, b] = await Promise.all([ddgInstant(q), wikiSearch(q)]);
    results = [...a, ...b];
  }
  const seen = new Set();
  return results.filter(r => r.url && !seen.has(r.url) && seen.add(r.url)).slice(0, limit)
    .map(r => ({ ...r, retrievedAt: new Date().toISOString(), freshness: freshness || 'default' }));
}

async function fetchContent(url) {
  const target = safeUrl(url);
  const r = await httpGet(target);
  if (!r.body) return { ok: false, error: 'Could not fetch the page (blocked, empty, or unreachable).' };
  const type = r.headers['content-type'] || '';
  if (/json/i.test(type)) return { ok: true, type: 'json', url: target, content: r.body.slice(0, 10000) };
  const staticContent = stripHtml(r.body).slice(0, 12000);

  // JS-heavy sites often return an almost-empty HTML shell. When enabled, render
  // those pages in real Chrome so search answers can use the content users actually see.
  if (process.env.BROWSER_RENDER_WEB !== 'false' && staticContent.length < 700) {
    try {
      const browser = require('./browser');
      const rendered = await browser.browse(target, { screenshot: false, timeoutMs: 25000 });
      if (rendered.ok && rendered.text.length > staticContent.length) {
        return { ok: true, type: 'browser-html', url: rendered.url, title: rendered.title, content: rendered.text.slice(0, 14000), links: rendered.links.slice(0, 40) };
      }
    } catch {}
  }
  return { ok: true, type: 'html', url: target, content: staticContent };
}

async function browse(query, limit = 5) {
  const results = await searchBest(query, limit);
  const enriched = [];
  for (const result of results.slice(0, Math.min(5, results.length))) {
    let page = null;
    try { page = await fetchContent(result.url); } catch (e) { page = { ok: false, error: e.message }; }
    enriched.push({ ...result, page: page?.ok ? page.content : null, pageError: page?.ok ? null : page?.error || null });
  }
  return enriched;
}

module.exports = { searchBest, fetchContent, browse };
