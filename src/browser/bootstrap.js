// Browser runtime bootstrap. Runs only after WhatsApp reaches connection=open.
// It keeps browser dependencies out of the critical pairing/startup path.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger');

const root = path.resolve(__dirname, '..', '..');
let running = false;
let done = false;

function hasPackage(name) {
  try { require.resolve(name, { paths: [root] }); return true; } catch { return false; }
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, error: stderr.slice(-1500) }));
  });
}

async function ensureBrowsers(opts = {}) {
  // Refuse automatic installs unless explicitly forced (tool call or AUTO_INSTALL_BROWSERS).
  const forced = !!(opts && opts.force) || (process.env.AUTO_INSTALL_BROWSERS || '').toLowerCase() === 'true';
  if (!forced) {
    return { ok: false, skipped: true, reason: 'not forced' };
  }
  if (done || running) return { ok: done, running };
  running = true;
  try {
    if (!hasPackage('playwright')) {
      const r = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', 'playwright']);
      if (!r.ok) throw new Error(`playwright install failed: ${r.error || r.code}`);
    }

    if (!hasPackage('puppeteer')) {
      const r = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', 'puppeteer']);
      if (!r.ok) throw new Error(`puppeteer install failed: ${r.error || r.code}`);
    }

    // Ensure Chromium/Chrome browser binaries exist for both browser stacks.
    const pw = await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium']);
    if (!pw.ok) logger.warn({ err: pw.error || pw.code }, 'Playwright Chromium install failed');

    const pp = await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['puppeteer', 'browsers', 'install', 'chrome']);
    if (!pp.ok) logger.warn({ err: pp.error || pp.code }, 'Puppeteer Chrome install failed');

    done = true;
  } catch (err) {
    logger.error({ err: err.message }, 'browser setup failed');
  } finally {
    running = false;
  }
}

module.exports = { ensureBrowsers };
