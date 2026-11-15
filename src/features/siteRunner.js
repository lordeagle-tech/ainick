// features/siteRunner.js — extract static site (zip OR single html), serve, screenshot
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const logger = require('../logger');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function isZipBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function looksLikeHtml(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const head = buf.slice(0, 256).toString('utf8').trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<html') || head.startsWith('<!--');
}

function safeExtractAdmZip(buffer, destDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  for (const e of zip.getEntries()) {
    const name = String(e.entryName || '').replace(/\\/g, '/');
    if (name.includes('..') || path.isAbsolute(name) || name.startsWith('/')) {
      throw new Error(`Unsafe path in zip: ${name}`);
    }
  }
  zip.extractAllTo(destDir, true);
}

async function extractWithSystemUnzip(buffer, destDir) {
  const tmpZip = path.join(os.tmpdir(), `site_${Date.now()}.zip`);
  fs.writeFileSync(tmpZip, buffer);
  try {
    await execFileP('unzip', ['-o', '-q', tmpZip, '-d', destDir], { timeout: 60000 });
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }
}

async function materializeProject(buffer, fileName = 'upload.bin') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    throw new Error('Empty or incomplete download — resend the file and try again.');
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  const name = String(fileName || 'upload.bin');

  try {
    if (looksLikeHtml(buffer) || /\.html?$/i.test(name)) {
      fs.writeFileSync(path.join(work, 'index.html'), buffer);
      return { workDir: work, root: work, kind: 'html-file' };
    }

    if (isZipBuffer(buffer) || /\.zip$/i.test(name)) {
      let extracted = false;
      let lastErr = null;
      try {
        safeExtractAdmZip(buffer, work);
        extracted = true;
      } catch (e) {
        lastErr = e;
        logger.warn({ err: e.message }, 'adm-zip failed, trying system unzip');
        try {
          await extractWithSystemUnzip(buffer, work);
          extracted = true;
        } catch (e2) {
          lastErr = e2;
        }
      }
      if (!extracted) {
        if (looksLikeHtml(buffer)) {
          fs.writeFileSync(path.join(work, 'index.html'), buffer);
          return { workDir: work, root: work, kind: 'html-fallback' };
        }
        throw new Error(
          `Could not open archive (${lastErr && lastErr.message ? lastErr.message : 'unknown'}). Resend a normal .zip (or a single .html file).`
        );
      }

      const top = fs.readdirSync(work).filter((n) => n !== '__MACOSX' && !n.startsWith('.'));
      let root = work;
      if (top.length === 1 && fs.statSync(path.join(work, top[0])).isDirectory()) {
        root = path.join(work, top[0]);
      }
      return { workDir: work, root, kind: 'zip' };
    }

    const asText = buffer.toString('utf8');
    if (/<html|<!doctype/i.test(asText)) {
      fs.writeFileSync(path.join(work, 'index.html'), buffer);
      return { workDir: work, root: work, kind: 'html-text' };
    }

    throw new Error('Unsupported file — send a .zip of the site or a single .html page.');
  } catch (e) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

function findHtmlFiles(root, max = 12) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= max) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (out.length >= max) break;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (['node_modules', '.git', '__MACOSX'].includes(ent.name)) continue;
        walk(p);
      } else if (/\.(html?)$/i.test(ent.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  out.sort((a, b) => {
    const ai = /index\.html?$/i.test(a) ? 0 : 1;
    const bi = /index\.html?$/i.test(b) ? 0 : 1;
    return ai - bi || a.localeCompare(b);
  });
  return out;
}

function startDirServer(root) {
  const server = http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const resolved = path.normalize(path.join(root, urlPath));
      if (!resolved.startsWith(path.normalize(root))) {
        res.writeHead(403); return res.end('Forbidden');
      }
      let file = resolved;
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, 'index.html');
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end('Not found');
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(String(e.message));
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function screenshotPages(root, { pages, width = 1280, height = 800, maxPages = 5, includeMobile = true, fullPage = false } = {}) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    try { puppeteer = require('puppeteer-core'); }
    catch {
      throw new Error('puppeteer is not installed — run npm i puppeteer-core');
    }
  }
  const htmlFiles = pages && pages.length
    ? pages.map((p) => (path.isAbsolute(p) ? p : path.join(root, p))).filter((p) => fs.existsSync(p))
    : findHtmlFiles(root, maxPages);
  if (!htmlFiles.length) throw new Error('No HTML files found in the project.');

  const server = await startDirServer(root);
  const port = server.address().port;
  const shots = [];
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });

    async function capture(file, device) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const tab = await browser.newPage();
      try {
        if (device === 'mobile') {
          await tab.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
          await tab.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
        } else {
          await tab.setViewport({ width, height, deviceScaleFactor: 1 });
        }
        await tab.goto('http://127.0.0.1:' + port + '/' + rel, {
          waitUntil: 'networkidle0',
          timeout: 25000,
        });
        await tab.evaluate(() => new Promise((r) => {
          if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => r()).catch(() => r());
          else setTimeout(r, 300);
        }));
        await new Promise((r) => setTimeout(r, 350));
        const png = await tab.screenshot({ type: 'png', fullPage: !!fullPage });
        shots.push({ page: rel, device, buffer: Buffer.from(png) });
      } catch (e) {
        logger.warn({ page: rel, device, err: e.message }, 'page screenshot failed');
        shots.push({ page: rel, device, error: e.message });
      } finally {
        await tab.close().catch(() => {});
      }
    }

    for (const file of htmlFiles.slice(0, maxPages)) {
      await capture(file, 'desktop');
      if (includeMobile) await capture(file, 'mobile');
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }
  return { shots, root, port };
}

async function previewZip(buffer, opts = {}) {
  const fileName = opts.fileName || 'site.zip';
  const { workDir, root, kind } = await materializeProject(buffer, fileName);
  try {
    const result = await screenshotPages(root, opts);
    return { ...result, workDir, kind };
  } catch (e) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

async function previewFiles(files, opts = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sitef-'));
  try {
    for (const f of files) {
      const dest = path.join(work, String(f.name || 'index.html').replace(/^\/+/, ''));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.buffer || Buffer.from(String(f.code || ''), 'utf8'));
    }
    return await screenshotPages(work, opts);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  extractZipToDir: safeExtractAdmZip,
  materializeProject,
  findHtmlFiles,
  startDirServer,
  screenshotPages,
  previewZip,
  previewFiles,
  isZipBuffer,
  looksLikeHtml,
};
