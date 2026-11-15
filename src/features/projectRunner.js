// projectRunner.js — extract zip / folder, detect stack, serve locally + Cloudflare tunnel.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const logger = require('../logger');
const localHost = require('./localHost');

const RUNS = path.join(process.cwd(), 'storage', 'hosted', 'runs');
fs.mkdirSync(RUNS, { recursive: true });

/** @type {Map<string, { kind: string, root: string, child?: any, url?: string, startedAt: number, label?: string }>} */
const running = new Map();

function randId() {
  return Math.random().toString(36).slice(2, 10);
}

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

async function extractZipToDir(zipSource, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (Buffer.isBuffer(zipSource)) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipSource);
    zip.extractAllTo(destDir, true);
    return destDir;
  }
  const zpath = String(zipSource);
  if (!fs.existsSync(zpath)) throw new Error('Zip not found: ' + zpath);
  try {
    const AdmZip = require('adm-zip');
    new AdmZip(zpath).extractAllTo(destDir, true);
  } catch (e) {
    // fallback unzip CLI
    await execFileP('unzip', ['-o', '-q', zpath, '-d', destDir], { timeout: 120000 });
  }
  return destDir;
}

/** If zip has a single top-level folder, use that as root. */
function resolveProjectRoot(extractedDir) {
  const entries = fs.readdirSync(extractedDir).filter((n) => !n.startsWith('__MACOSX') && n !== '.DS_Store');
  if (entries.length === 1) {
    const only = path.join(extractedDir, entries[0]);
    if (fs.statSync(only).isDirectory()) return only;
  }
  return extractedDir;
}

function detectKind(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const scripts = pkg.scripts || {};
      if (scripts.start || scripts.dev || scripts.serve) return { kind: 'node', pkg, scripts };
      // static site with package.json but no start → treat as static if index exists
      if (has('index.html') || has('dist/index.html') || has('build/index.html') || has('public/index.html')) {
        return { kind: 'static', pkg, scripts };
      }
      return { kind: 'node', pkg, scripts };
    } catch {
      return { kind: 'node', pkg: {}, scripts: {} };
    }
  }
  if (has('requirements.txt') || has('pyproject.toml') || has('app.py') || has('main.py') || has('manage.py')) {
    return { kind: 'python' };
  }
  if (has('go.mod') || has('main.go')) return { kind: 'go' };
  if (has('Cargo.toml')) return { kind: 'rust' };
  if (has('index.html') || has('dist') || has('build') || has('public') || has('out')) {
    return { kind: 'static' };
  }
  // any html file
  try {
    const walk = (d, depth = 0) => {
      if (depth > 3) return false;
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        const st = fs.statSync(p);
        if (st.isFile() && /\.html?$/i.test(n)) return true;
        if (st.isDirectory() && !n.startsWith('.') && n !== 'node_modules') {
          if (walk(p, depth + 1)) return true;
        }
      }
      return false;
    };
    if (walk(root)) return { kind: 'static' };
  } catch {}
  return { kind: 'static' };
}

function findStaticRoot(root) {
  for (const c of ['', 'dist', 'build', 'public', 'out', 'www', 'docs']) {
    const p = c ? path.join(root, c) : root;
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  // first folder with index.html
  try {
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 80) {
      const d = stack.pop();
      if (fs.existsSync(path.join(d, 'index.html'))) return d;
      for (const n of fs.readdirSync(d)) {
        if (n === 'node_modules' || n.startsWith('.')) continue;
        const p = path.join(d, n);
        try {
          if (fs.statSync(p).isDirectory()) stack.push(p);
        } catch {}
      }
    }
  } catch {}
  return root;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}), CI: '1', FORCE_COLOR: '0' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const max = 200000;
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > max) out = out.slice(-max);
      if (opts.onData) opts.onData(d.toString());
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > max) err = err.slice(-max);
      if (opts.onData) opts.onData(d.toString());
    });
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`Command timed out: ${cmd} ${args.join(' ')}`));
    }, opts.timeoutMs || 180000);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function startDetached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}), HOST: '127.0.0.1', PORT: String(opts.port || 0) },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  let log = '';
  child.stdout.on('data', (d) => {
    log += d.toString();
    if (log.length > 100000) log = log.slice(-100000);
  });
  child.stderr.on('data', (d) => {
    log += d.toString();
    if (log.length > 100000) log = log.slice(-100000);
  });
  child.on('error', (e) => logger.warn({ err: e.message }, 'project child error'));
  return { child, getLog: () => log };
}

async function waitForPort(port, timeoutMs = 25000) {
  const net = require('net');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/**
 * Deploy static or backend project.
 * @param {{ root?: string, zipBuffer?: Buffer, zipPath?: string, userId?: string, label?: string, onProgress?: Function }} opts
 */
async function deployProject(opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : async () => {};
  const id = randId();
  let root = opts.root ? String(opts.root) : '';
  let workDir = null;

  if (opts.zipBuffer || opts.zipPath) {
    workDir = path.join(RUNS, `run-${id}`);
    await onProgress('📦 Extracting project zip…');
    await extractZipToDir(opts.zipBuffer || opts.zipPath, workDir);
    root = resolveProjectRoot(workDir);
  }

  if (!root || !fs.existsSync(root)) {
    return { ok: false, error: 'No project root or zip to deploy.' };
  }
  if (!fs.statSync(root).isDirectory()) {
    root = path.dirname(root);
  }

  const detected = detectKind(root);
  await onProgress(`🔎 Detected: ${detected.kind}`);

  // --- STATIC ---
  if (detected.kind === 'static') {
    const serveRoot = findStaticRoot(root);
    await onProgress('🌐 Hosting static site + Cloudflare tunnel…');
    const r = await localHost.hostProject(serveRoot, {
      id,
      userId: opts.userId,
      label: opts.label || path.basename(root),
    });
    if (!r.ok) return r;
    running.set(id, {
      kind: 'static',
      root: serveRoot,
      url: r.publicUrl || r.localUrl,
      startedAt: Date.now(),
      label: opts.label || path.basename(root),
    });
    return {
      ok: true,
      id,
      kind: 'static',
      publicUrl: r.publicUrl,
      localUrl: r.localUrl,
      tunnel: r.tunnel,
      message: r.message,
    };
  }

  // --- NODE ---
  if (detected.kind === 'node') {
    const pkgPath = path.join(root, 'package.json');
    const pkg = detected.pkg || (fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {});
    const scripts = pkg.scripts || {};
    if (fs.existsSync(path.join(root, 'package.json')) && !fs.existsSync(path.join(root, 'node_modules'))) {
      await onProgress('📥 npm install…');
      const inst = await runCmd('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], {
        cwd: root,
        timeoutMs: 300000,
      });
      if (inst.code !== 0) {
        return {
          ok: false,
          error: `npm install failed: ${(inst.stderr || inst.stdout || '').slice(-500)}`,
        };
      }
    }

    // Prefer build then static if next/vite output
    if (scripts.build) {
      await onProgress('🏗️ npm run build…');
      const b = await runCmd('npm', ['run', 'build'], { cwd: root, timeoutMs: 300000 });
      if (b.code === 0) {
        const out = findStaticRoot(root);
        if (out !== root || fs.existsSync(path.join(out, 'index.html'))) {
          await onProgress('🌐 Serving build output + Cloudflare tunnel…');
          const r = await localHost.hostProject(out, { id, userId: opts.userId, label: opts.label });
          if (r.ok) {
            running.set(id, { kind: 'static-build', root: out, url: r.publicUrl, startedAt: Date.now(), label: opts.label });
            return {
              ok: true,
              id,
              kind: 'static-build',
              publicUrl: r.publicUrl,
              localUrl: r.localUrl,
              tunnel: r.tunnel,
              message: r.message,
            };
          }
        }
      }
    }

    const port = await pickFreePort();
    let script = scripts.start ? 'start' : scripts.dev ? 'dev' : scripts.serve ? 'serve' : null;
    if (!script) {
      // fallback static
      const r = await localHost.hostProject(findStaticRoot(root), { id, userId: opts.userId, label: opts.label });
      if (r.ok) {
        running.set(id, { kind: 'static', root, url: r.publicUrl, startedAt: Date.now() });
        return { ok: true, id, kind: 'static', publicUrl: r.publicUrl, localUrl: r.localUrl, tunnel: r.tunnel, message: r.message };
      }
      return { ok: false, error: 'No start/dev script and no index.html to host.' };
    }

    await onProgress(`▶️ npm run ${script} on port ${port}…`);
    const { child, getLog } = startDetached('npm', ['run', script], {
      cwd: root,
      port,
      env: { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' },
    });

    const up = await waitForPort(port, 35000);
    if (!up) {
      try {
        child.kill('SIGKILL');
      } catch {}
      return {
        ok: false,
        error: `Server did not open port ${port}. Log:\n${getLog().slice(-800)}`,
      };
    }

    await onProgress('☁️ Opening Cloudflare tunnel…');
    let publicUrl = null;
    let tunnel = 'local-only';
    try {
      const t = await localHost.tunnelPort(port);
      publicUrl = typeof t === 'string' ? t : (t?.publicUrl || t?.url || null);
      tunnel = typeof t === 'string' ? 'cloudflare' : (t?.tunnel || t?.kind || 'cloudflare');
    } catch (e) {
      logger.warn({ err: e.message }, 'tunnelPort failed');
      publicUrl = `http://127.0.0.1:${port}`;
    }

    running.set(id, {
      kind: 'node',
      root,
      child,
      port,
      url: publicUrl,
      startedAt: Date.now(),
      label: opts.label,
    });

    return {
      ok: true,
      id,
      kind: 'node',
      port,
      publicUrl,
      localUrl: `http://127.0.0.1:${port}`,
      tunnel,
      message:
        tunnel === 'local-only'
          ? `Node app running locally: http://127.0.0.1:${port}\n(Cloudflare tunnel unavailable — install cloudflared for a public link)`
          : `Node app live:\n• Local: http://127.0.0.1:${port}\n• Public: ${publicUrl}`,
    };
  }

  // --- PYTHON (best-effort static or simple http) ---
  if (detected.kind === 'python') {
    const port = await pickFreePort();
    // Prefer static if templates+no server, else python -m http.server on root
    if (fs.existsSync(path.join(root, 'index.html'))) {
      const r = await localHost.hostProject(root, { id, userId: opts.userId, label: opts.label });
      if (r.ok) {
        running.set(id, { kind: 'static', root, url: r.publicUrl, startedAt: Date.now() });
        return { ok: true, id, kind: 'static', publicUrl: r.publicUrl, localUrl: r.localUrl, tunnel: r.tunnel, message: r.message };
      }
    }
    await onProgress(`🐍 python http.server on ${port}…`);
    const { child } = startDetached('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
      cwd: root,
      port,
    });
    await waitForPort(port, 10000);
    let publicUrl = `http://127.0.0.1:${port}`;
    let tunnel = 'local-only';
    try {
      const t = await localHost.tunnelPort(port);
      publicUrl = typeof t === 'string' ? t : (t?.publicUrl || t?.url || publicUrl);
      tunnel = typeof t === 'string' ? 'cloudflare' : (t?.tunnel || 'cloudflare');
    } catch {}
    running.set(id, { kind: 'python', root, child, port, url: publicUrl, startedAt: Date.now() });
    return {
      ok: true,
      id,
      kind: 'python',
      publicUrl,
      localUrl: `http://127.0.0.1:${port}`,
      tunnel,
      message: `Python static server:\n• Local: http://127.0.0.1:${port}\n• Public: ${publicUrl}`,
    };
  }

  // default static attempt
  const r = await localHost.hostProject(findStaticRoot(root), { id, userId: opts.userId, label: opts.label });
  if (r.ok) {
    running.set(id, { kind: 'static', root, url: r.publicUrl, startedAt: Date.now() });
    return { ok: true, id, kind: 'static', publicUrl: r.publicUrl, localUrl: r.localUrl, tunnel: r.tunnel, message: r.message };
  }
  return { ok: false, error: `Unsupported or empty project (${detected.kind}).` };
}

function listRunning() {
  const out = [];
  for (const [id, r] of running.entries()) {
    out.push({
      id,
      kind: r.kind,
      url: r.url,
      label: r.label,
      ageMs: Date.now() - r.startedAt,
      root: r.root,
    });
  }
  return out;
}

function stop(id) {
  if (id === 'all') {
    for (const k of [...running.keys()]) stop(k);
    return { ok: true, stopped: 'all' };
  }
  const r = running.get(id);
  if (!r) return { ok: false, error: 'Unknown id' };
  try {
    if (r.child) r.child.kill('SIGTERM');
  } catch {}
  running.delete(id);
  try {
    localHost.stopProject(id);
  } catch {}
  return { ok: true, stopped: id };
}

module.exports = {
  deployProject,
  listRunning,
  stop,
  detectKind,
  extractZipToDir,
};
