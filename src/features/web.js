'use strict';

module.exports = (runtime) => {
runtime.define("browser", "browser.js", function(module, exports, require, __filename, __dirname) {
// Backends (tried in order): Playwright → Puppeteer+Sparticuz → Puppeteer system → remote API.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const logger = require('../logger');
const stealth = require('./browserStealth');

let _puppeteer = null;
let _playwright = null;
let serverlessChromium = null;

function getPuppeteer() {
  if (_puppeteer) return _puppeteer;
  try { _puppeteer = require('puppeteer'); return _puppeteer; } catch {}
  try { _puppeteer = require('puppeteer-core'); return _puppeteer; } catch (e) {
    throw new Error('Puppeteer is not installed. Run: npm i puppeteer-core');
  }
}

function getPlaywright() {
  if (_playwright !== null) return _playwright;
  try {
    _playwright = require('playwright');
    return _playwright;
  } catch {
    try {
      _playwright = require('playwright-core');
      return _playwright;
    } catch {
      _playwright = false;
      return null;
    }
  }
}

function getServerlessChromium() {
  if (serverlessChromium) return serverlessChromium;
  try {
    const { createRequire } = require('module');
    const req = createRequire(__filename);
    serverlessChromium = req('@sparticuz/chromium');
    return serverlessChromium;
  } catch (e1) {
    try {
      serverlessChromium = require('@sparticuz/chromium');
      return serverlessChromium;
    } catch (e2) {
      const candidates = [
        path.join(process.cwd(), 'node_modules', '@sparticuz', 'chromium', 'bin'),
        path.join(__dirname, '..', '..', 'node_modules', '@sparticuz', 'chromium', 'bin'),
      ];
      for (const base of candidates) {
        try {
          if (!fs.existsSync(base)) continue;
          const stack = [base];
          let guard = 0;
          while (stack.length && guard++ < 80) {
            const d = stack.pop();
            for (const n of fs.readdirSync(d)) {
              const fp = path.join(d, n);
              let st;
              try { st = fs.statSync(fp); } catch { continue; }
              if (st.isDirectory()) stack.push(fp);
              else if (/chrome|chromium|headless/i.test(n) && st.isFile() && st.size > 1000000) {
                serverlessChromium = {
                  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
                  executablePath: async () => fp,
                };
                return serverlessChromium;
              }
            }
          }
        } catch {}
      }
      return null;
    }
  }
}

function resolveChromePath() {
  for (const key of ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH', 'CHROMIUM_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']) {
    const v = process.env[key];
    if (v && fs.existsSync(v)) return v;
  }
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chrome',
    '/snap/bin/chromium',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  // puppeteer cache
  try {
    const cacheRoot = path.join(os.homedir(), '.cache', 'puppeteer');
    if (fs.existsSync(cacheRoot)) {
      const stack = [cacheRoot];
      let guard = 0;
      while (stack.length && guard++ < 100) {
        const d = stack.pop();
        for (const n of fs.readdirSync(d)) {
          const fp = path.join(d, n);
          let st;
          try { st = fs.statSync(fp); } catch { continue; }
          if (st.isDirectory()) stack.push(fp);
          else if (/^(chrome|chromium)(-linux)?$/i.test(n) || n === 'chrome-headless-shell') {
            if (st.size > 1000000) return fp;
          }
        }
      }
    }
  } catch {}
  return null;
}

async function resolveBundledExec(chromium) {
  if (!chromium) return null;
  try {
    if (typeof chromium.executablePath === 'function') {
      const p = await chromium.executablePath();
      if (p && typeof p === 'string') return p;
    }
    if (typeof chromium.executablePath === 'string' && chromium.executablePath) {
      return chromium.executablePath;
    }
    if (chromium.path && typeof chromium.path === 'string') return chromium.path;
  } catch (e) {
    logger.warn({ err: e.message }, 'bundled chromium executablePath failed');
  }
  try {
    const bases = [
      path.join(process.cwd(), 'node_modules', '@sparticuz', 'chromium'),
      path.join(__dirname, '..', '..', 'node_modules', '@sparticuz', 'chromium'),
    ];
    for (const base of bases) {
      if (!fs.existsSync(base)) continue;
      const stack = [base];
      let guard = 0;
      while (stack.length && guard++ < 120) {
        const d = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(d); } catch { continue; }
        for (const n of entries) {
          const fp = path.join(d, n);
          let st;
          try { st = fs.statSync(fp); } catch { continue; }
          if (st.isDirectory()) stack.push(fp);
          else if (/chrome|chromium|headless/i.test(n) && st.isFile() && st.size > 500000) {
            return fp;
          }
        }
      }
    }
  } catch {}
  return null;
}

async function inflateNearbyBr(execPath) {
  const zlib = require('zlib');
  const roots = [];
  if (execPath) roots.push(path.dirname(execPath));
  roots.push(
    path.join(process.cwd(), 'node_modules', '@sparticuz', 'chromium'),
    path.join(__dirname, '..', '..', 'node_modules', '@sparticuz', 'chromium'),
  );
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 200) {
      const d = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(d); } catch { continue; }
      for (const n of entries) {
        const fp = path.join(d, n);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (st.isDirectory()) { stack.push(fp); continue; }
        if (!n.endsWith('.br')) continue;
        const out = fp.slice(0, -3);
        if (fs.existsSync(out) && fs.statSync(out).size > 1000) continue;
        try {
          const raw = fs.readFileSync(fp);
          const inflated = zlib.brotliDecompressSync(raw);
          fs.writeFileSync(out, inflated);
          try { fs.chmodSync(out, 0o755); } catch {}
          logger.info({ out, bytes: inflated.length }, 'inflated chromium .br');
        } catch (e) {
          logger.warn({ file: n, err: e.message }, 'brotli inflate failed');
        }
      }
    }
  }
}

function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  for (const c of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']) {
    try {
      if (c === 'ffmpeg') return c;
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function safeUrl(u) {
  const s = String(u || '').trim();
  if (!/^https?:\/\//i.test(s)) throw new Error('URL must start with http:// or https://');
  return s;
}

// Chrome launch flags.
//
// --single-process and --no-zygote were removed on purpose. Running the
// renderer in the browser process is the single most common cause of a
// headless Chrome that "just hangs": navigation stalls, renderer crashes take
// the whole browser down with them, and pages that work everywhere else never
// finish loading. It is not a supported configuration for real browsing.
//
// --no-sandbox stays, because this runs as root inside a container where the
// sandbox cannot be initialised. The rest are memory and rendering hygiene for
// constrained hosts.
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--font-render-hinting=none',
  // Stop Chrome advertising itself as automated, which is what gets a headless
  // browser served a captcha wall or a stripped-down page.
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  // Realistic surface so responsive sites render their desktop layout rather
  // than a mobile one, and so lazy-loaded content actually enters the viewport.
  '--window-size=1440,900',
  '--lang=en-US',
  '--mute-audio',
  // Keep background tabs from being throttled, which otherwise freezes timers
  // on sites that render content after a delay.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

/**
 * Launch any available browser backend.
 * Returns { browser, close, engine, newPage }
 * where newPage() returns a puppeteer-like page (Playwright pages are adapted).
 */

/** Project-local browser stack install — NO root, NO owner gate.
 *  Only writes into ./node_modules and Playwright's user cache. */
let _browserInstallPromise = null;
let _browserInstallDone = false;

function isBrowserNpmPackage(spec) {
  const s = String(spec || '').toLowerCase().split('@')[0].trim();
  const allow = new Set([
    'puppeteer', 'puppeteer-core', 'playwright', 'playwright-core',
    '@sparticuz/chromium', 'ffmpeg-static', 'msedge-tts',
  ]);
  // also allow scoped version pins like @sparticuz/chromium@153.0.0
  if (allow.has(s)) return true;
  if (String(spec || '').toLowerCase().startsWith('@sparticuz/chromium')) return true;
  return false;
}

async function runNpmInstallLocal(packages) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);
  const pkgs = (packages || []).filter(Boolean);
  if (!pkgs.length) return { ok: true, skipped: true };
  const args = ['install', '--no-save', '--no-audit', '--no-fund', ...pkgs];
  try {
    const r = await execFileP('npm', args, {
      cwd: process.cwd(),
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_optional: 'true',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0',
        PUPPETEER_SKIP_DOWNLOAD: '0',
      },
    });
    return { ok: true, stdout: String(r.stdout || '').slice(-2000), stderr: String(r.stderr || '').slice(-2000) };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      stdout: String(e.stdout || '').slice(-2000),
      stderr: String(e.stderr || '').slice(-2000),
    };
  }
}

async function installPlaywrightBrowser() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);
  try {
    await execFileP('npx', ['--yes', 'playwright', 'install', 'chromium'], {
      cwd: process.cwd(),
      timeout: 400000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1',
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Install Playwright + Puppeteer + @sparticuz/chromium into project node_modules.
 * Safe for any user — never uses sudo/apt. Call once per process.
 */
async function ensureBrowserInstalled(force = false) {
  if (_browserInstallDone && !force) return { ok: true, already: true };
  if (_browserInstallPromise) return _browserInstallPromise;

  _browserInstallPromise = (async () => {
    const major = Number(String(process.versions.node || '').split('.')[0]) || 20;
    const chromiumVersion = major >= 22 ? '153.0.0' : '149.0.0';
    const packages = [
      `@sparticuz/chromium@${chromiumVersion}`,
      'playwright-core@1.49.1',
      'playwright@1.49.1',
      'puppeteer-core@25.3.0',
    ];
    logger.info({ packages }, 'browser: installing project-local stack (no root)');
    const npmResult = await runNpmInstallLocal(packages);
    // Clear cached requires so new packages load
    try {
      for (const key of Object.keys(require.cache)) {
        if (/node_modules[\\/](@sparticuz[\\/]chromium|playwright|puppeteer)/.test(key)) {
          delete require.cache[key];
        }
      }
    } catch {}
    // Reset module-level caches
    serverlessChromium = null;
    _puppeteer = null;
    _playwright = null;

    const pw = await installPlaywrightBrowser();
    // Inflate any .br binaries
    try {
      const chromium = getServerlessChromium();
      const execPath = chromium ? await resolveBundledExec(chromium) : null;
      await inflateNearbyBr(execPath);
    } catch (e) {
      logger.warn({ err: e.message }, 'browser: inflate after install failed');
    }

    _browserInstallDone = true;
    return {
      ok: !!(npmResult.ok || pw.ok),
      npm: npmResult,
      playwrightBrowser: pw,
      note: 'Installed into project node_modules only — no sudo/apt required.',
    };
  })();

  try {
    return await _browserInstallPromise;
  } finally {
    _browserInstallPromise = null;
  }
}

async function launchBrowser(opts = {}) {
  const prefer = String(process.env.BROWSER_ENGINE || '').toLowerCase(); // playwright | puppeteer | auto
  const errors = [];
  const width = opts.width || 1280;
  const height = opts.height || 800;

  // --- 1) Playwright (often more reliable on constrained hosts) ---
  if (prefer !== 'puppeteer') {
    const pw = getPlaywright();
    if (pw) {
      const chromiumPkg = getServerlessChromium();
      let execPath = null;
      try {
        if (chromiumPkg) {
          execPath = await resolveBundledExec(chromiumPkg);
          await inflateNearbyBr(execPath);
        }
      } catch {}
      if (!execPath) execPath = resolveChromePath();

      const launchOpts = {
        headless: opts.headless !== false,
        args: [...BASE_ARGS, ...(chromiumPkg?.args || [])],
        ignoreHTTPSErrors: true,
      };
      if (execPath) launchOpts.executablePath = execPath;

      try {
        const browser = await pw.chromium.launch(launchOpts);
        logger.info({ engine: 'playwright', exec: execPath || 'bundled' }, 'browser launched');
        return {
          engine: 'playwright',
          browser,
          close: async () => { try { await browser.close(); } catch {} },
          newPage: async () => {
            const context = await browser.newContext({
              viewport: { width, height },
              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              ignoreHTTPSErrors: true,
            });
            // Context-level so the script is present before the first
            // navigation. Installing it on the page afterwards is too late —
            // the site has already read navigator.webdriver.
            await stealth.applyStealthToContext(context);
            const page = await context.newPage();
            return adaptPlaywrightPage(page, context);
          },
        };
      } catch (e) {
        errors.push(`playwright: ${e.message}`);
        logger.warn({ err: e.message }, 'playwright launch failed');
      }
    } else {
      errors.push('playwright: not installed');
    }
  }

  // --- 2) Puppeteer + Sparticuz / system ---
  if (prefer !== 'playwright') {
    try {
      const browserLib = getPuppeteer();
      const attempts = [];
      const chromium = getServerlessChromium();
      if (chromium) {
        let execPath = null;
        try { execPath = await resolveBundledExec(chromium); } catch {}
        try { await inflateNearbyBr(execPath); } catch {}
        attempts.push({
          label: 'puppeteer-sparticuz',
          opts: {
            headless: opts.headless !== false ? 'shell' : false,
            executablePath: execPath || undefined,
            args: Array.from(new Set([...(chromium.args || []), ...BASE_ARGS])),
            ignoreHTTPSErrors: true,
            defaultViewport: { width, height },
          },
        });
      }
      const systemPath = resolveChromePath();
      attempts.push({
        label: systemPath ? 'puppeteer-system' : 'puppeteer-default',
        opts: {
          headless: opts.headless !== false ? 'new' : false,
          ...(systemPath ? { executablePath: systemPath } : {}),
          args: BASE_ARGS,
          ignoreHTTPSErrors: true,
          defaultViewport: { width, height },
        },
      });

      for (const attempt of attempts) {
        try {
          const browser = await browserLib.launch(attempt.opts);
          logger.info({ engine: 'puppeteer', mode: attempt.label, exec: attempt.opts.executablePath || 'default' }, 'browser launched');
          return {
            engine: 'puppeteer',
            browser,
            close: async () => { try { await browser.close(); } catch {} },
            newPage: async () => {
              const page = await browser.newPage();
              try {
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
              } catch {}
              // Must run before the first goto, or the site has already seen
              // navigator.webdriver === true.
              await stealth.applyStealth(page);
              try {
                await page.setViewport({ width, height, deviceScaleFactor: 1 });
              } catch {}
              return page;
            },
          };
        } catch (e) {
          errors.push(`${attempt.label}: ${e.message}`);
          logger.warn({ mode: attempt.label, err: e.message }, 'puppeteer launch attempt failed');
        }
      }
    } catch (e) {
      errors.push(`puppeteer: ${e.message}`);
    }
  }

  // One automatic project-local install + retry (no root, no owner gate)
  if (!opts._retriedInstall) {
    try {
      logger.info({ errors }, 'browser: launch failed — auto-installing project-local stack');
      const inst = await ensureBrowserInstalled(true);
      logger.info({ inst: !!inst?.ok }, 'browser: auto-install finished');
      return await launchBrowser({ ...opts, _retriedInstall: true });
    } catch (e) {
      errors.push(`auto-install: ${e.message}`);
    }
  }

  throw new Error(
    `Browser launch failed. Tried: ${errors.join(' | ') || 'none'}. ` +
    `Project-local install was attempted (no sudo). Screenshots still fall back to remote API. ` +
    `Optional: set CHROME_PATH if a system browser exists.`
  );
}

/** Make Playwright page API look enough like Puppeteer for our helpers. */
function adaptPlaywrightPage(page, context) {
  return {
    _pw: true,
    _context: context,
    async goto(url, opts = {}) {
      return page.goto(url, {
        waitUntil: opts.waitUntil === 'networkidle2' ? 'networkidle' : (opts.waitUntil || 'domcontentloaded'),
        timeout: opts.timeout || 90000,
      });
    },
    async setViewport(vp) {
      await page.setViewportSize({ width: vp.width || 1280, height: vp.height || 800 });
    },
    async setUserAgent() { /* set on context already */ },
    async title() { return page.title(); },
    async content() { return page.content(); },
    url() { return page.url(); },
    async screenshot(opts = {}) {
      const o = {
        path: opts.path,
        fullPage: !!opts.fullPage,
        type: opts.type === 'jpeg' ? 'jpeg' : 'png',
        quality: opts.quality,
        clip: opts.clip,
      };
      return page.screenshot(o);
    },
    async click(selector, opts = {}) {
      await page.click(selector, { delay: opts.delay });
    },
    async type(selector, text, opts = {}) {
      await page.fill(selector, '');
      await page.type(selector, text, { delay: opts.delay });
    },
    async keyboard() { return page.keyboard; },
    get keyboard() { return page.keyboard; },
    async evaluate(fn, ...args) { return page.evaluate(fn, ...args); },
    async $eval(selector, fn, ...args) { return page.$eval(selector, fn, ...args); },
    async $$eval(selector, fn, ...args) { return page.$$eval(selector, fn, ...args); },
    async waitForSelector(selector, opts = {}) {
      return page.waitForSelector(selector, { timeout: opts.timeout || 10000 });
    },
    async waitForTimeout(ms) { return page.waitForTimeout(ms); },
    async close() {
      try { await page.close(); } catch {}
      try { await context.close(); } catch {}
    },
  };
}

async function withBrowser(fn, opts = {}) {
  const session = await launchBrowser(opts);
  try {
    // Compatibility: old code expected (browser) => browser.newPage()
    const fakeBrowser = {
      newPage: session.newPage,
      close: session.close,
      engine: session.engine,
    };
    return await fn(fakeBrowser, { engine: session.engine });
  } finally {
    await session.close();
  }
}

/**
 * Navigate, then make the page actually usable.
 *
 * Three things happen here that used to be missing, and each one accounts for
 * a class of "the browser doesn't work" report:
 *
 *   1. Retry. A single transient net::ERR_ABORTED or timeout used to kill the
 *      whole browse. Two retries with backoff absorb that.
 *   2. Consent. A cookie wall covers the page, so later clicks hit the overlay
 *      and extraction returns the dialog's text. Dismissing it here fixes both.
 *   3. Settle. `domcontentloaded` fires before a JS-heavy site has rendered, so
 *      the read comes back near-empty. If the text is thin, wait for the
 *      network to go quiet and check once more.
 */
async function gotoAndSettle(page, url, opts = {}) {
  const target = safeUrl(url);
  const waitUntil = opts.waitUntil || 'domcontentloaded';
  const timeout = opts.timeout || 60000;
  const attempts = opts.retries ?? 3;

  let lastErr = null;
  let navigated = false;

  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(target, { waitUntil, timeout });
      navigated = true;
      break;
    } catch (e) {
      lastErr = e;
      // A timeout still usually means the page loaded, just slowly. Keep what
      // we have rather than discarding a usable page.
      if (/timeout/i.test(e.message || '')) { navigated = true; break; }
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }

  if (!navigated) throw lastErr || new Error('navigation failed');

  // Clear any consent wall before the caller interacts with the page.
  let consent = null;
  try { consent = await stealth.dismissConsent(page); } catch {}

  // If the page looks empty, give client-side rendering a chance to finish.
  let settled = false;
  try {
    if (await stealth.isContentThin(page)) {
      await page.waitForLoadState?.('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout?.(1200).catch(() => {});
      settled = true;
    }
  } catch {}

  return { ok: true, url: target, consent, settled };
}

async function runPageActions(page, actions) {
  const list = Array.isArray(actions) ? actions : [];
  const results = [];
  for (const step of list) {
    if (!step || typeof step !== 'object') continue;
    const type = String(step.type || step.action || '').toLowerCase();
    try {
      if (type === 'scroll') {
        const y = Number(step.amount || step.y || 600);
        const times = Math.min(8, Math.max(1, Number(step.times) || 1));
        for (let i = 0; i < times; i++) {
          await page.evaluate((dy) => window.scrollBy(0, dy), y);
          await new Promise((r) => setTimeout(r, 250));
        }
        results.push({ type: 'scroll', y, times, ok: true });
      } else if (type === 'click' && (step.selector || step.text)) {
        if (step.selector) {
          await page.click(step.selector, { delay: 40 }).catch(async () => {
            if (step.text) {
              await page.evaluate((t) => {
                const el = [...document.querySelectorAll('a,button,[role=button],input[type=submit]')].find(
                  (e) => (e.textContent || e.value || '').includes(t)
                );
                if (el) el.click();
              }, step.text);
            }
          });
        } else if (step.text) {
          await page.evaluate((t) => {
            const el = [...document.querySelectorAll('a,button,[role=button],input[type=submit]')].find(
              (e) => (e.textContent || e.value || '').includes(t)
            );
            if (el) el.click();
          }, step.text);
        }
        results.push({ type: 'click', ok: true });
      } else if (type === 'type' && step.selector) {
        await page.click(step.selector, { clickCount: 3 }).catch(() => {});
        await page.type(step.selector, String(step.text || ''), { delay: 20 });
        results.push({ type: 'type', ok: true });
      } else if (type === 'press' && step.key) {
        await page.keyboard.press(step.key);
        results.push({ type: 'press', key: step.key, ok: true });
      } else if (type === 'wait') {
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout: Math.min(Number(step.ms) || 10000, 30000) }).catch(() => {});
        } else {
          await new Promise((r) => setTimeout(r, Math.min(Number(step.ms) || 500, 15000)));
        }
        results.push({ type: 'wait', ok: true });
      } else if (type === 'goto' && step.url) {
        const nav = await gotoAndSettle(page, step.url, { timeout: 60000 });
        results.push({ type: 'goto', ok: true, consent: nav.consent || null });
      }
    } catch (e) {
      results.push({ type, ok: false, error: e.message });
      logger.warn({ type, err: e.message }, 'page action failed');
    }
  }
  return results;
}

async function browse(url, options = {}) {
  const target = safeUrl(url);
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width || 1280, height: options.height || 800 });
    await page.setUserAgent(
      options.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    // Retry + consent dismissal + settle-on-thin-content, in one call.
    const nav = await gotoAndSettle(page, target, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: options.timeout || 90000,
    });
    const actionResults = await runPageActions(page, options.actions);
    let screenshotPath = null;
    if (options.screenshot !== false) {
      const dir = path.join(process.cwd(), '.cache');
      fs.mkdirSync(dir, { recursive: true });
      screenshotPath = path.join(dir, `browser-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: !!options.fullPage });
    }
    const title = await page.title().catch(() => '');
    const content = await page.content().catch(() => '');
    const text = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    const links = await page.$$eval('a[href]', (as) =>
      as.slice(0, 40).map((a) => ({ text: (a.textContent || '').trim().slice(0, 80), href: a.href }))
    ).catch(() => []);
    return {
      ok: true,
      url: page.url(),
      title,
      content: content.slice(0, 50000),
      text: String(text || '').slice(0, 12000),
      links,
      screenshotPath,
      actions: actionResults,
    };
  });
}

async function click(url, selector, options = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(safeUrl(url), { waitUntil: 'domcontentloaded', timeout: 90000 });
    if (String(selector).startsWith('text=')) {
      const label = selector.slice(5);
      await page.evaluate((t) => {
        const el = [...document.querySelectorAll('a,button,[role=button],input[type=submit]')].find(
          (e) => (e.textContent || e.value || '').includes(t)
        );
        if (el) el.click();
        else throw new Error('text not found');
      }, label).catch(() => page.click(selector).catch(() => {}));
    } else {
      await page.click(selector, { delay: 40 });
    }
    if (options.type) await page.keyboard.type(String(options.type), { delay: 20 });
    await new Promise((r) => setTimeout(r, options.waitMs || 800));
    let screenshotPath = null;
    if (options.screenshot !== false) {
      const dir = path.join(process.cwd(), '.cache');
      fs.mkdirSync(dir, { recursive: true });
      screenshotPath = path.join(dir, `click-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
    }
    return { ok: true, url: page.url(), screenshotPath };
  });
}

async function typeText(url, selector, text, options = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.goto(safeUrl(url), { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.click(selector, { clickCount: 3 }).catch(() => {});
    await page.type(selector, String(text), { delay: 25 });
    let screenshotPath = null;
    if (options.screenshot !== false) {
      const dir = path.join(process.cwd(), '.cache');
      fs.mkdirSync(dir, { recursive: true });
      screenshotPath = path.join(dir, `type-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
    }
    return { ok: true, url: page.url(), screenshotPath };
  });
}

async function scrollPage(url, options = {}) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width || 1280, height: options.height || 800 });
    await page.goto(safeUrl(url), { waitUntil: 'domcontentloaded', timeout: 90000 });
    const y = Number(options.y || options.amount || 800);
    const times = Math.min(12, Math.max(1, Number(options.times) || 1));
    const direction = String(options.direction || 'down').toLowerCase();
    const dy = direction === 'up' ? -Math.abs(y) : Math.abs(y);
    for (let i = 0; i < times; i++) {
      await page.evaluate((d) => window.scrollBy(0, d), dy);
      await new Promise((r) => setTimeout(r, 300));
    }
    // Optional wait for lazy content
    if (options.waitMs) await new Promise((r) => setTimeout(r, Math.min(Number(options.waitMs) || 0, 8000)));
    let screenshotPath = null;
    if (options.screenshot !== false) {
      const dir = path.join(process.cwd(), '.cache');
      fs.mkdirSync(dir, { recursive: true });
      screenshotPath = path.join(dir, `scroll-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: !!options.fullPage });
    }
    const title = await page.title().catch(() => '');
    const scrollY = await page.evaluate(() => window.scrollY).catch(() => 0);
    return { ok: true, url: page.url(), title, screenshotPath, scrollY, times };
  });
}

/**
 * Screen record: run optional steps (click/type/scroll/wait) while capturing frames,
 * then stitch into mp4/webm via ffmpeg when available.
 */
async function screenRecord(url, opts = {}) {
  const steps = Array.isArray(opts.steps) ? opts.steps : [];
  const durationSec = Math.min(30, Math.max(3, Number(opts.durationSec) || 8));
  const fps = Math.min(3, Math.max(1, Number(opts.fps) || 2));
  const totalFrames = Math.min(20, Math.max(4, durationSec * fps));
  const intervalMs = Math.floor(1000 / fps);

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    // Lower viewport to reduce memory on free tiers
    await page.setViewport({ width: Math.min(960, opts.width || 1280), height: Math.min(540, opts.height || 720) });
    await page.goto(safeUrl(url), { waitUntil: 'domcontentloaded', timeout: opts.timeout || 90000 });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-rec-'));
    const frames = [];

    const capture = async () => {
      const fp = path.join(tmpDir, `frame_${String(frames.length).padStart(4, '0')}.jpg`);
      // JPEG is 90% smaller than PNG — critical for OOM prevention on free tiers
      await page.screenshot({ path: fp, type: 'jpeg', quality: 60 });
      frames.push(fp);
    };

    await capture();

    // Execute interaction steps while recording
    for (const step of steps) {
      const action = String(step.action || step.type || '').toLowerCase();
      try {
        if (action === 'click' && step.selector) {
          if (String(step.selector).startsWith('text=')) {
            const label = String(step.selector).slice(5);
            await page.evaluate((t) => {
              const el = [...document.querySelectorAll('a,button,[role=tab],[role=button],input')].find(
                (e) => (e.textContent || e.value || '').trim().toLowerCase().includes(t.toLowerCase())
              );
              if (el) el.click();
            }, label);
          } else {
            await page.click(step.selector, { delay: 30 });
          }
        } else if (action === 'type' && step.selector) {
          await page.type(step.selector, String(step.text || step.value || ''), { delay: 20 });
        } else if (action === 'scroll') {
          await page.evaluate((y) => window.scrollBy(0, y || 500), step.y || 500);
        } else if (action === 'wait') {
          await new Promise((r) => setTimeout(r, Number(step.ms || 800)));
        } else if (action === 'goto' && step.url) {
          await page.goto(safeUrl(step.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
        } else if (action === 'press' && step.key) {
          await page.keyboard.press(step.key);
        }
      } catch (e) {
        logger.warn({ err: e.message, action }, 'screenRecord step failed');
      }
      await capture();
      // Cleanup old frames every 10 frames to keep memory in check
      if (frames.length % 10 === 0 && frames.length > 4) {
        for (const old of frames.slice(0, frames.length - 2)) {
          try { fs.unlinkSync(old); } catch {}
        }
        frames.splice(0, frames.length - 2);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Fill remaining frames with scroll or idle capture
    while (frames.length < totalFrames) {
      if (opts.scroll) {
        await page.evaluate(() => window.scrollBy(0, 350));
      }
      await capture();
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Renumber surviving frames so ffmpeg sees a continuous sequence
    const ordered = [];
    for (let i = 0; i < frames.length; i++) {
      const src = frames[i];
      if (!src || !fs.existsSync(src)) continue;
      const dest = path.join(tmpDir, `seq_${String(ordered.length).padStart(4, '0')}.jpg`);
      try {
        if (src !== dest) fs.copyFileSync(src, dest);
        ordered.push(dest);
      } catch {}
    }
    frames.length = 0;
    frames.push(...ordered);

    let videoPath = null;
    let videoBuffer = null;
    const ffmpeg = resolveFfmpeg();
    if (ffmpeg && frames.length >= 2) {
      videoPath = path.join(tmpDir, `record_${Date.now()}.mp4`);
      try {
        await execFileP(
          ffmpeg,
          [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-framerate', String(fps),
            '-i', path.join(tmpDir, 'seq_%04d.jpg'),
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            '-t', String(durationSec),
            videoPath,
          ],
          { timeout: 120000 }
        );
        if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 500) {
          videoBuffer = fs.readFileSync(videoPath);
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'ffmpeg screen record encode failed');
        videoPath = null;
      }
    }

    return {
      ok: true,
      url: page.url(),
      frames,
      frameCount: frames.length,
      videoPath,
      videoBuffer,
      tmpDir,
      hasVideo: !!(videoBuffer && videoBuffer.length),
    };
  });
}


// Extended browser ops: screenshot, structured extract, executeScript, cookies,
// PDF render. All use the same puppeteer singleton + withBrowser() wrapper.

/** Full-page (or viewport) PNG screenshot. Returns the absolute file path. */
async function screenshot(url, options = {}) {
  const target = safeUrl(url);
  // 1) Try real headless browser
  try {
    return await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.setViewport({ width: options.width || 1280, height: options.height || 800 });
      await page.goto(target, { waitUntil: options.waitUntil || 'domcontentloaded', timeout: options.timeout || 90000 });
      if (options.selector) {
        try { await page.waitForSelector(options.selector, { timeout: Math.min(options.waitMs || 10000, 30000) }); } catch {}
      }
      if (options.waitMs) {
        try { await page.waitForTimeout(Math.min(Number(options.waitMs) || 0, 15000)); } catch {}
      }
      const dir = path.join(process.cwd(), '.cache');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, `shot-${Date.now()}.png`);
      const shotOpts = { path: out, fullPage: options.fullPage !== false };
      if (options.selector) {
        try {
          const clip = await page.$eval(options.selector, (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
          });
          if (clip && clip.width > 0) shotOpts.clip = clip;
        } catch {}
      }
      await page.screenshot(shotOpts);
      return { ok: true, url: page.url(), screenshotPath: out, bytes: fs.statSync(out).size, source: 'browser' };
    });
  } catch (browserErr) {
    logger.warn({ err: browserErr.message, url: target }, 'local browser screenshot failed — trying remote API');
  }

  // 2) Remote screenshot APIs (no root, no chromium)
  const apiShot = await screenshotViaApi(target, options);
  if (apiShot?.ok) return apiShot;

  throw new Error(
    `Screenshot failed locally and via remote API. ` +
    `Local: browser could not launch (missing libs or binary). ` +
    `Fix: npm i @sparticuz/chromium && ensure brotli .br files inflate, or set CHROME_PATH.`
  );
}

/** Free remote screenshot fallbacks — no Chromium/root required. */
async function screenshotViaApi(url, options = {}) {
  const axios = require('axios');
  const dir = path.join(process.cwd(), '.cache');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `shot-api-${Date.now()}.png`);
  const w = options.width || 1280;

  const providers = [
    // thum.io — free public screenshot CDN
    async () => {
      const u = `https://image.thum.io/get/width/${w}/noanimate/${encodeURI(url)}`;
      const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 45000, maxContentLength: 15 * 1024 * 1024 });
      if (!r.data || r.data.byteLength < 2000) throw new Error('thum tiny');
      // reject HTML error pages
      const head = Buffer.from(r.data).slice(0, 20).toString('utf8');
      if (/<!DOCTYPE|<html/i.test(head)) throw new Error('thum html');
      return Buffer.from(r.data);
    },
    // microlink
    async () => {
      const r = await axios.get('https://api.microlink.io', {
        params: { url, screenshot: true, meta: false, embed: 'screenshot.url', waitUntil: 'domcontentloaded' },
        timeout: 45000,
      });
      const shotUrl = r.data?.data?.screenshot?.url || r.data?.screenshot?.url;
      if (!shotUrl) throw new Error('microlink no url');
      const img = await axios.get(shotUrl, { responseType: 'arraybuffer', timeout: 30000 });
      if (!img.data || img.data.byteLength < 2000) throw new Error('microlink tiny');
      return Buffer.from(img.data);
    },
    // wordpress mshots
    async () => {
      const u = `https://s0.wp.com/mshots/v1/${encodeURIComponent(url)}?w=${w}`;
      // mshots returns a placeholder first — retry a couple times
      let last;
      for (let i = 0; i < 3; i++) {
        const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 30000, maxRedirects: 5 });
        last = Buffer.from(r.data);
        if (last.length > 8000) return last;
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (last && last.length > 2000) return last;
      throw new Error('mshots tiny');
    },
  ];

  const errors = [];
  for (const fn of providers) {
    try {
      const buf = await fn();
      fs.writeFileSync(out, buf);
      return { ok: true, url, screenshotPath: out, bytes: buf.length, source: 'remote-api' };
    } catch (e) {
      errors.push(e.message);
    }
  }
  logger.warn({ errors }, 'all remote screenshot APIs failed');
  return null;
}


/**
 * Structured extraction. mode:
 *   - "table"     → returns {headers, rows} for the first <table> (or selector)
 *   - "list"      → returns array of {text, html, href} for selector matches
 *   - "jsonld"    → returns array of JSON-LD objects found on the page
 *   - "selector"  → returns {text, html, attr, links} for a single selector
 */
async function extract(url, options = {}) {
  const target = safeUrl(url);
  const mode = options.mode || 'list';
  const sel = options.selector;
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(target, { waitUntil: options.waitUntil || 'domcontentloaded', timeout: options.timeout || 90000 });
    if (sel) {
      try { await page.waitForSelector(sel, { timeout: Math.min(options.waitMs || 10000, 30000) }); } catch {}
    }
    const title = await page.title().catch(() => '');

    if (mode === 'table') {
      const data = await page.$$eval(sel || 'table', (tables) => tables.slice(0, 5).map((t) => {
        const headers = Array.from(t.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'))
          .map((c) => c.textContent.trim());
        const rows = Array.from(t.querySelectorAll('tbody tr, tr')).slice(headers.length ? 1 : 0).map((r) =>
          Array.from(r.querySelectorAll('td, th')).map((c) => c.textContent.trim())
        );
        return { headers, rows: rows.slice(0, 200) };
      }));
      return { ok: true, url: page.url(), title, mode, tables: data };
    }

    if (mode === 'list') {
      if (!sel) throw new Error('extract(mode:"list") needs a selector.');
      const items = await page.$$eval(sel, (els, attr) => els.slice(0, 200).map((e) => ({
        text: (e.textContent || '').trim().slice(0, 500),
        html: (e.innerHTML || '').slice(0, 2000),
        href: e.href || (e.querySelector && e.querySelector('a[href]')?.href) || null,
        attr: attr ? e.getAttribute(attr) : null,
      })), options.attr || null);
      return { ok: true, url: page.url(), title, mode, selector: sel, count: items.length, items };
    }

    if (mode === 'jsonld') {
      const objs = await page.$$eval('script[type="application/ld+json"]', (scripts) => {
        const out = [];
        for (const s of scripts) {
          try {
            const j = JSON.parse(s.textContent || '{}');
            if (Array.isArray(j)) out.push(...j);
            else if (j['@graph']) out.push(...j['@graph']);
            else out.push(j);
          } catch {}
        }
        return out;
      });
      return { ok: true, url: page.url(), title, mode, count: objs.length, items: objs.slice(0, 50) };
    }

    if (mode === 'selector') {
      if (!sel) throw new Error('extract(mode:"selector") needs a selector.');
      const data = await page.$eval(sel, (el, attr) => ({
        text: (el.textContent || '').trim().slice(0, 5000),
        html: (el.innerHTML || '').slice(0, 10000),
        attr: attr ? el.getAttribute(attr) : null,
        links: Array.from(el.querySelectorAll('a[href]')).slice(0, 100).map((a) => ({ text: a.textContent.trim(), href: a.href })),
      }), options.attr || null);
      return { ok: true, url: page.url(), title, mode, selector: sel, data };
    }

    throw new Error(`Unknown extract mode: ${mode}`);
  });
}

/** Run arbitrary JS in the page context. Returns the JSON-serialisable result. */
async function executeScript(url, script, options = {}) {
  const target = safeUrl(url);
  if (!script) throw new Error('A script string is required.');
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: options.timeout || 90000 });
    const result = await page.evaluate((src) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (async () => {' + src + '})()');
      return fn();
    }, script);
    return { ok: true, url: page.url(), result };
  });
}

async function getCookies(url) {
  const target = safeUrl(url);
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const cookies = await page.cookies();
    return { ok: true, url: target, cookies };
  });
}

async function setCookies(url, cookies) {
  const target = safeUrl(url);
  if (!Array.isArray(cookies) || !cookies.length) throw new Error('cookies must be a non-empty array of {name, value, domain?, path?}.');
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const host = new URL(target).hostname;
    const norm = cookies.map((c) => ({
      name: c.name, value: c.value,
      domain: c.domain || host, path: c.path || '/',
      httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
      ...(c.expires ? { expires: c.expires } : {}),
    }));
    await page.setCookie(...norm);
    return { ok: true, url: target, set: norm.length };
  });
}

async function downloadPdf(url, options = {}) {
  const target = safeUrl(url);
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width || 1280, height: options.height || 800 });
    await page.goto(target, { waitUntil: 'networkidle0', timeout: options.timeout || 90000 });
    const dir = path.join(process.cwd(), '.cache');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `page-${Date.now()}.pdf`);
    await page.pdf({
      path: out,
      format: options.format || 'A4',
      printBackground: options.printBackground !== false,
      ...(options.selector ? { } : { margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } }),
    });
    return { ok: true, url: page.url(), pdfPath: out, bytes: fs.statSync(out).size };
  });
}



// Multi-step login / signup flows. Run a JSON array of steps with:
//   { action: "goto"|"fill"|"click"|"type"|"wait"|"press"|"select"|"check"|"screenshot"|"captcha_check"|"extract", ... }
// Always returns {ok, url, steps, cookies, finalScreenshot, captcha, error}.
// Captcha detection is best-effort: looks for common captcha iframes and recaptcha
// containers, and the model can then pause and ask the user to solve it.

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="reCAPTCHA" i]',
  'iframe[title*="hCaptcha" i]',
  'div.g-recaptcha',
  'div.h-captcha',
  'div[data-sitekey]',
  'input[name*="captcha" i]',
  'img[alt*="captcha" i]',
];

async function runFlow(url, steps, options = {}) {
  const target = safeUrl(url);
  if (!Array.isArray(steps) || !steps.length) {
    throw new Error('steps must be a non-empty array.');
  }
  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const result = { ok: true, url: target, steps: [], cookies: [], finalScreenshot: null, captcha: null };
    try {
      // First step: navigate to start URL
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] || {};
        const action = String(step.action || '').toLowerCase();
        const stepLog = { index: i, action, status: 'ok' };

        if (action === 'goto') {
          await page.goto(safeUrl(step.url), { waitUntil: step.waitUntil || 'domcontentloaded', timeout: 90000 });
        } else if (action === 'fill') {
          // step.selector, step.value
          await page.waitForSelector(step.selector, { timeout: step.timeout || 15000 });
          await page.click(step.selector, { clickCount: 3 }).catch(() => {});
          await page.type(step.selector, String(step.value || ''), { delay: 25 });
        } else if (action === 'type') {
          // like fill but doesn't click first
          await page.waitForSelector(step.selector, { timeout: step.timeout || 15000 });
          await page.type(step.selector, String(step.value || ''), { delay: 25 });
        } else if (action === 'click') {
          await page.waitForSelector(step.selector, { timeout: step.timeout || 15000 });
          await Promise.all([
            page.click(step.selector).catch(() => {}),
            step.waitForNavigation ? page.waitForNavigation({ timeout: step.navTimeout || 30000 }).catch(() => {}) : Promise.resolve(),
          ]);
        } else if (action === 'press') {
          await page.keyboard.press(String(step.key || 'Enter'));
        } else if (action === 'select') {
          await page.waitForSelector(step.selector, { timeout: 15000 });
          await page.select(step.selector, String(step.value || ''));
        } else if (action === 'check' || action === 'uncheck') {
          const checked = await page.$eval(step.selector, (el) => el.checked).catch(() => null);
          const want = action === 'check';
          if (checked !== want) await page.click(step.selector).catch(() => {});
        } else if (action === 'wait') {
          if (step.selector) {
            await page.waitForSelector(step.selector, { timeout: step.timeout || 15000 }).catch(() => {
              stepLog.status = 'selector-timeout';
            });
          } else {
            await new Promise((r) => setTimeout(r, Math.min(Number(step.ms) || 500, 60000)));
          }
        } else if (action === 'extract') {
          const data = await page.$eval(step.selector || 'body', (el, attr) => ({
            text: (el.textContent || '').trim().slice(0, 5000),
            html: (el.innerHTML || '').slice(0, 5000),
            attr: attr ? el.getAttribute(attr) : null,
          }), step.attr || null);
          stepLog.extracted = data;
        } else if (action === 'screenshot') {
          const dir = path.join(process.cwd(), '.cache');
          fs.mkdirSync(dir, { recursive: true });
          const out = path.join(dir, `flow-${Date.now()}-${i}.png`);
          await page.screenshot({ path: out, fullPage: !!step.fullPage });
          stepLog.screenshotPath = out;
        } else if (action === 'captcha_check') {
          // explicit check, returns a captcha descriptor
        } else {
          stepLog.status = 'unknown-action';
        }

        // Always-on captcha detection after each step
        if (step.captchaCheck !== false) {
          const found = await page.evaluate((sels) => {
            for (const s of sels) {
              const el = document.querySelector(s);
              if (el) return { selector: s, tag: el.tagName, src: el.src || null, text: (el.textContent || '').trim().slice(0, 200) };
            }
            return null;
          }, CAPTCHA_SELECTORS).catch(() => null);
          if (found) {
            result.captcha = found;
            stepLog.status = 'captcha-detected';
            // stop the flow: model can ask the user
            result.steps.push(stepLog);
            const dir = path.join(process.cwd(), '.cache');
            fs.mkdirSync(dir, { recursive: true });
            const cap = path.join(dir, `captcha-${Date.now()}.png`);
            await page.screenshot({ path: cap });
            result.captcha.screenshotPath = cap;
            break;
          }
        }

        result.steps.push(stepLog);
      }

      result.url = page.url();
      result.cookies = await page.cookies();
      if (options.finalScreenshot !== false) {
        const dir = path.join(process.cwd(), '.cache');
        fs.mkdirSync(dir, { recursive: true });
        const out = path.join(dir, `flow-final-${Date.now()}.png`);
        await page.screenshot({ path: out, fullPage: false });
        result.finalScreenshot = out;
      }
      if (result.captcha) result.ok = false; // signal "needs human"
      return result;
    } finally {
      await page.close().catch(() => {});
    }
  });
}

async function loginFlow({ url, steps, options }) {
  return runFlow(url, steps, options);
}
async function diagnose() {
  const result = {
    ok: false,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    systemChrome: resolveChromePath(),
    puppeteer: null,
    playwright: null,
    bundledChromium: false,
    launch: null,
  };
  try { result.puppeteer = require('puppeteer/package.json').version; } catch {
    try { result.puppeteer = require('puppeteer-core/package.json').version; } catch {}
  }
  try { result.playwright = require('playwright/package.json').version; } catch {
    try { result.playwright = require('playwright-core/package.json').version; } catch {}
  }
  const chromium = getServerlessChromium();
  result.bundledChromium = !!chromium;
  if (chromium) {
    try { result.bundledExecutable = await resolveBundledExec(chromium); } catch (e) { result.bundledError = e.message; }
  }
  try {
    const session = await launchBrowser({ headless: true });
    result.launch = { ok: true, engine: session.engine };
    result.ok = true;
    await session.close();
  } catch (e) {
    result.launch = { ok: false, error: e.message };
  }
  return result;
}

async function signupFlow({ url, steps, options }) {
  return runFlow(url, steps, options);
}

module.exports = {
  ensureBrowserInstalled,
  isBrowserNpmPackage,
  runNpmInstallLocal,
  browse,
  search: async (q, limit = 8) => {
    const result = await browse(`https://www.bing.com/search?q=${encodeURIComponent(q)}`, { screenshot: false });
    return (result.links || []).filter((x) => x.href && !/bing\.com/i.test(x.href)).slice(0, limit).map((x) => ({
      title: x.text,
      url: x.href,
      source: 'Bing/browser',
    }));
  },
  safeUrl,
  click,
  typeText,
  scrollPage,
  screenRecord,
  screenshot,
  extract,
  executeScript,
  getCookies,
  setCookies,
  downloadPdf,
  runFlow,
  loginFlow,
  signupFlow,
  diagnose,
};

});

runtime.define("browserStealth", "browserStealth.js", function(module, exports, require, __filename, __dirname) {
// a browser, and stop a page from being unusable once it loads.
//
// WHY
//
// Two failure modes account for most "the browser doesn't work" reports, and
// neither shows up as an error:
//
//   1. BOT DETECTION. Chrome in automation mode reports navigator.webdriver =
//      true. That single property is the most widely used bot signal on the
//      web. Sites respond by serving a captcha, an "Access Denied" page, or a
//      stripped-down version with the content removed. Nothing throws — you
//      just get the wrong page. The --disable-blink-features=AutomationControlled
//      launch flag helps but does NOT clear navigator.webdriver on its own.
//
//   2. CONSENT WALLS. A large share of sites open with a full-screen cookie or
//      consent dialog. It covers the page, so every subsequent click lands on
//      the overlay instead of the thing you aimed at, and extraction returns
//      the dialog's text rather than the content. The page loaded fine, which
//      is why this looks like a mystery.
//
// Both are fixed here, once, for every page.

/**
 * Runs before any page script, in every frame.
 *
 * Kept deliberately small. Over-patching is itself detectable — a page can
 * check that navigator has the right shape, and an inconsistent profile is
 * more suspicious than a plain one.
 */
const STEALTH_SCRIPT = `
(() => {
  try {
    // 1. The big one. Automation sets this true; nothing else does.
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch (e) {}

  try {
    // 2. A headless browser has no plugins. Real Chrome has several.
    const fake = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];
    Object.defineProperty(navigator, 'plugins', { get: () => fake, configurable: true });
    Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }], configurable: true });
  } catch (e) {}

  try {
    // 3. Headless defaults to a single bare locale.
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  } catch (e) {}

  try {
    // 4. window.chrome is absent in headless and present in real Chrome.
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: { isInstalled: false } };
    }
  } catch (e) {}

  try {
    // 5. Headless reports a notification permission of "denied" while also
    //    claiming to be a normal browser. Make the two agree.
    const orig = window.navigator.permissions && window.navigator.permissions.query;
    if (orig) {
      window.navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : orig.call(window.navigator.permissions, params);
    }
  } catch (e) {}

  try {
    // 6. Headless lacks a real GPU, so the renderer string gives it away.
    const gl = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = gl.call(this, type, ...rest);
      if (ctx && (type === 'webgl' || type === 'experimental-webgl')) {
        const dbg = ctx.getExtension && ctx.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          const patch = (fn) => function (p) {
            if (p === dbg.UNMASKED_VENDOR_WEBGL) return 'Intel Inc.';
            if (p === dbg.UNMASKED_RENDERER_WEBGL) return 'Intel Iris OpenGL Engine';
            return fn.call(this, p);
          };
          ctx.getParameter = patch(ctx.getParameter);
        }
      }
      return ctx;
    };
  } catch (e) {}
})();
`;

/**
 * Install the stealth script on a page, whichever engine it is.
 * Must run BEFORE the first navigation to take effect.
 */
async function applyStealth(page) {
  try {
    // Puppeteer
    if (typeof page.evaluateOnNewDocument === 'function') {
      await page.evaluateOnNewDocument(STEALTH_SCRIPT);
      return true;
    }
    // Playwright
    if (typeof page.addInitScript === 'function') {
      await page.addInitScript(STEALTH_SCRIPT);
      return true;
    }
  } catch {
    // Never let this break a browse. Worst case the page looks automated.
  }
  return false;
}

/** Playwright: set it once on the context so every page gets it. */
async function applyStealthToContext(context) {
  try {
    if (typeof context.addInitScript === 'function') {
      await context.addInitScript(STEALTH_SCRIPT);
      return true;
    }
  } catch {}
  return false;
}

// Consent / cookie dialogs, most common first. Matched on visible text and on
// the id/class patterns the big consent platforms actually ship.
const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#onetrust-banner-sdk button#onetrust-accept-btn-handler',
  'button[aria-label*="accept" i]',
  'button[data-testid*="accept" i]',
  '[id*="cookie" i] button[class*="accept" i]',
  '[class*="cookie" i] button[class*="accept" i]',
  '[class*="consent" i] button[class*="accept" i]',
  '.cc-btn.cc-allow',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  'button#truste-consent-button',
  'button[aria-label="Agree" i]',
  'button[aria-label="Accept all" i]',
];

const CONSENT_TEXT = [
  'Accept all cookies',
  'Accept all',
  'Allow all',
  'Accept cookies',
  'I agree',
  'Agree and continue',
  'Got it',
  'OK, got it',
  'Allow cookies',
  'Accept',
];

/**
 * Clear a consent wall if one is covering the page.
 *
 * Best-effort by design: a miss is harmless, and this must never throw into a
 * caller that is mid-navigation.
 *
 * Returns the label it clicked, or null.
 */
async function dismissConsent(page, opts = {}) {
  const timeout = opts.timeout ?? 2500;

  // 1. Known ids/classes.
  for (const sel of CONSENT_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isIntersectingViewport?.().catch(() => true);
        if (visible !== false) {
          await el.click().catch(() => {});
          return sel;
        }
      }
    } catch {}
  }

  // 2. Visible text, via an in-page search so it also reaches shadow roots and
  //    iframes that a selector cannot.
  try {
    const clicked = await page.evaluate((labels) => {
      const clickable = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
      for (const label of labels) {
        const target = label.toLowerCase();
        for (const el of clickable) {
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
          if (text === target) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              el.click();
              return el.innerText || label;
            }
          }
        }
      }
      return null;
    }, CONSENT_TEXT);

    if (clicked) {
      // Give the overlay a moment to animate away before the caller interacts.
      await page.waitForTimeout?.(300).catch(() => {});
      return clicked;
    }
  } catch {}

  return null;
}

/**
 * Is the page basically empty?
 *
 * A JS-heavy site returns from domcontentloaded before it renders, so the
 * extraction comes back as a near-empty string and looks like a scraping bug.
 * Detecting it lets the caller escalate the wait instead of reporting nothing.
 */
async function isContentThin(page, minChars = 250) {
  try {
    const text = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '';
      return (body.innerText || '').trim();
    });
    return String(text || '').length < minChars;
  } catch {
    return false;
  }
}

module.exports = {
  STEALTH_SCRIPT,
  applyStealth,
  applyStealthToContext,
  dismissConsent,
  isContentThin,
  CONSENT_SELECTORS,
  CONSENT_TEXT,
};

});

runtime.define("internetTools", "internetTools.js", function(module, exports, require, __filename, __dirname) {
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
  return axios.get(cleanUrl(url), { timeout, maxRedirects: 4, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NickAI/4.0)' }, responseType: 'text' });
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
  const outHeaders = { 'User-Agent': 'NickAI/4.0', 'Accept': 'application/json, text/plain, */*', ...headers };
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

});

runtime.define("websearch2", "websearch2.js", function(module, exports, require, __filename, __dirname) {
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 NickAI/4.0',
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

});
};
