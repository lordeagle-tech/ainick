// Browser runtime bootstrap. Runs only after WhatsApp reaches connection=open.
// It keeps browser dependencies out of the critical pairing/startup path.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
    console.log('[browser] ensureBrowsers skipped — install only on demand (AUTO_INSTALL_BROWSERS=true or force:true)');
    return { ok: false, skipped: true, reason: 'not forced' };
  }
  if (done || running) return { ok: done, running };
  running = true;
  try {
    console.log('[browser] Preparing Playwright/Puppeteer runtime (explicit request)...');

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
    if (!pw.ok) console.warn('[browser] Playwright Chromium install failed; Puppeteer may still work:', pw.error || pw.code);

    const pp = await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['puppeteer', 'browsers', 'install', 'chrome']);
    if (!pp.ok) console.warn('[browser] Puppeteer Chrome install failed:', pp.error || pp.code);

    done = true;
    console.log('[browser] Browser runtime ready. Agent browsing tools can use Playwright/Puppeteer.');
  } catch (err) {
    console.warn('[browser] Browser setup did not complete:', err.message);
    console.warn('[browser] WhatsApp stays online; browser setup will retry on the next successful connection.');
  } finally {
    running = false;
  }
}

module.exports = { ensureBrowsers };
