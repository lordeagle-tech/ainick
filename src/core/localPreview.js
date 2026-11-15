// core/localPreview.js — serves a just-built website (from build_website's file list) over an
// ephemeral local static HTTP server, screenshots it with a headless browser, then tears the
// server down. Intentionally does NOT execute any generated code (no npm install, no running
// server-side scripts) — it only serves static files that were already written to disk and
// takes a picture. That keeps this to "show me what it looks like", not "run arbitrary code".
const http = require('http');
const path = require('path');
const logger = require('../logger');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8',
};

/** files: [{ name, code }] as produced by siteBuilder.parseFiles. Static-only, in-memory. */
function startStaticServer(files) {
  const byPath = new Map(files.map((f) => [`/${String(f.name || '').replace(/^\/+/, '')}`.replace(/\/+/g, '/'), f.code]));
  // Also map bare directory index
  if (byPath.has('/index.html') && !byPath.has('/')) byPath.set('/', byPath.get('/index.html'));
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const body = byPath.get(p);
    if (body == null) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(p).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function launchOpts() {
  return {
    headless: 'new',
    executablePath: process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  };
}

/**
 * Renders `page` (default index.html) from `files` and returns a PNG screenshot buffer.
 * Requires puppeteer — throws a clear error if it isn't installed.
 */
async function screenshotBuild(files, {
  page = 'index.html',
  width = 1280,
  height = 800,
  fullPage = false,
  device = 'desktop', // desktop | mobile
} = {}) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    try { puppeteer = require('puppeteer-core'); }
    catch {
      throw new Error("puppeteer isn't installed — run `npm i puppeteer-core` to enable local previews.");
    }
  }

  const viewport = device === 'mobile'
    ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { width, height, deviceScaleFactor: 1 };

  const server = await startStaticServer(files);
  const port = server.address().port;
  let browser;
  try {
    browser = await puppeteer.launch(launchOpts());
    const tab = await browser.newPage();
    await tab.setViewport(viewport);
    await tab.setUserAgent(
      device === 'mobile'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    const target = `http://127.0.0.1:${port}/${String(page).replace(/^\//, '')}`;
    await tab.goto(target, { waitUntil: 'networkidle0', timeout: 25000 });
    // Let Tailwind CDN / fonts settle
    await tab.evaluate(() => new Promise((r) => {
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => r()).catch(() => r());
      else setTimeout(r, 300);
    }));
    await new Promise((r) => setTimeout(r, 400));
    const buf = await tab.screenshot({ type: 'png', fullPage: !!fullPage });
    return Buffer.from(buf);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
}

/**
 * Capture desktop (+ optional mobile) screenshots for the main page(s).
 * Returns [{ page, device, buffer }] — skips failures without throwing.
 */
async function screenshotBuildMulti(files, {
  pages,
  includeMobile = true,
  fullPage = false,
  maxPages = 3,
} = {}) {
  const htmlNames = (pages && pages.length)
    ? pages
    : files
      .map((f) => f.name)
      .filter((n) => /\.html?$/i.test(n))
      .sort((a, b) => (/index\.html?$/i.test(a) ? 0 : 1) - (/index\.html?$/i.test(b) ? 0 : 1) || a.localeCompare(b))
      .slice(0, maxPages);

  if (!htmlNames.length) htmlNames.push('index.html');

  const shots = [];
  for (const page of htmlNames) {
    try {
      const desktop = await screenshotBuild(files, { page, device: 'desktop', fullPage, width: 1280, height: 800 });
      shots.push({ page, device: 'desktop', buffer: desktop });
    } catch (e) {
      logger.warn({ page, err: e.message }, 'desktop preview failed');
      shots.push({ page, device: 'desktop', error: e.message });
    }
    if (includeMobile) {
      try {
        const mobile = await screenshotBuild(files, { page, device: 'mobile', fullPage });
        shots.push({ page, device: 'mobile', buffer: mobile });
      } catch (e) {
        logger.warn({ page, err: e.message }, 'mobile preview failed');
      }
    }
  }
  return shots;
}

module.exports = { screenshotBuild, screenshotBuildMulti, startStaticServer };
