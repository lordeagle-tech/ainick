'use strict';

module.exports = (runtime) => {
runtime.define("localHost", "localHost.js", function(module, exports, require, __filename, __dirname) {
// (trycloudflare.com) with localtunnel fallback.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const logger = require('../logger');

const ROOT = path.join(process.cwd(), 'storage', 'hosted');
fs.mkdirSync(ROOT, { recursive: true });

let server = null;
let port = 0;
let publicBase = null; // https://xxx.trycloudflare.com or loca.lt
let tunnelProc = null;
let tunnelKind = null; // 'cloudflare' | 'localtunnel' | 'local-only'
const routes = new Map(); // id -> entry
const projectHosts = new Map(); // id -> { root, userId, startedAt }

function mimeOf(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const map = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    map: 'application/json', wasm: 'application/wasm',
  };
  return map[ext] || 'application/octet-stream';
}

function randId() {
  return Math.random().toString(36).slice(2, 10);
}

function safeJoin(root, rel) {
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(path.resolve(root))) throw new Error('path escape');
  return resolved;
}

/** Resolve cloudflared binary: env, PATH, or npx */
async function findCloudflared() {
  // 1. Check explicit env path
  if (process.env.CLOUDFLARED_BIN && fs.existsSync(process.env.CLOUDFLARED_BIN)) {
    return process.env.CLOUDFLARED_BIN;
  }
  // 2. Check common install locations
  const knownPaths = [
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    path.join(process.cwd(), 'node_modules', '.bin', 'cloudflared'),
    path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
  ];
  for (const p of knownPaths) {
    if (fs.existsSync(p)) {
      try { await execFileP(p, ['--version'], { timeout: 5000 }); return p; } catch {}
    }
  }
  // 3. Check PATH
  try {
    await execFileP('cloudflared', ['--version'], { timeout: 5000 });
    return 'cloudflared';
  } catch {}
  // 4. Auto-download from Cloudflare's official releases
  try {
    const binDir = path.join(os.homedir(), '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'cloudflared');
    const platformName = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platformName}-${arch}`;
    logger.info({ url }, 'Downloading cloudflared binary');
    const axios = require('axios');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 100 * 1024 * 1024 });
    fs.writeFileSync(binPath, resp.data, { mode: 0o755 });
    await execFileP(binPath, ['--version'], { timeout: 5000 });
    logger.info({ binPath }, 'cloudflared downloaded successfully');
    return binPath;
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to auto-download cloudflared');
    return null;
  }
}

function parseTryCloudflareUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : null;
}

async function startCloudflareTunnel(localPort) {
  const bin = await findCloudflared();
  const args = bin
    ? ['tunnel', '--url', `http://127.0.0.1:${localPort}`]
    : ['-y', 'cloudflared', 'tunnel', '--url', `http://127.0.0.1:${localPort}`];
  const cmd = bin || 'npx';

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    tunnelProc = child;
    tunnelKind = 'cloudflare';

    const onData = (buf) => {
      const s = buf.toString();
      logger.info({ tunnel: s.slice(0, 200) }, 'cloudflared out');
      const url = parseTryCloudflareUrl(s);
      if (url && !settled) {
        settled = true;
        publicBase = url;
        resolve(url);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.on('exit', (code) => {
      logger.warn({ code }, 'cloudflared exited');
      if (!settled) {
        settled = true;
        reject(new Error(`cloudflared exited ${code}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('cloudflared timeout — no trycloudflare URL'));
      }
    }, 45000);
  });
}

async function startLocaltunnel(localPort) {
  try {
    const localtunnel = require('localtunnel');
    const tunnel = await localtunnel({ port: localPort });
    publicBase = tunnel.url;
    tunnelKind = 'localtunnel';
    tunnel.on('error', () => {});
    tunnel.on('close', () => {});
    return publicBase;
  } catch (e) {
    throw e;
  }
}

function ensureServer() {
  if (server) return Promise.resolve({ port, publicBase, tunnelKind });
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        let pathname = decodeURIComponent(u.pathname);

        // Project hosts: /p/<id>/...
        const projMatch = pathname.match(/^\/p\/([^/]+)(?:\/(.*))?$/);
        if (projMatch) {
          const id = projMatch[1];
          const proj = projectHosts.get(id);
          if (!proj) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Project not found or stopped');
            return;
          }
          let rel = projMatch[2] || '';
          if (!rel || rel.endsWith('/')) rel = path.join(rel, 'index.html');
          const filePath = safeJoin(proj.root, rel);
          if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            // SPA fallback
            const index = path.join(proj.root, 'index.html');
            if (fs.existsSync(index)) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(fs.readFileSync(index));
              return;
            }
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          const data = fs.readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': mimeOf(filePath),
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(data);
          return;
        }

        // Simple route ids
        const id = pathname.replace(/^\//, '').split('/')[0];
        const entry = routes.get(id);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found. Hosted routes: /p/<projectId>/  or single-file ids.');
          return;
        }
        if (entry.html) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(entry.html);
          return;
        }
        const data = fs.readFileSync(entry.filePath);
        res.writeHead(200, {
          'Content-Type': entry.mime || mimeOf(entry.filePath),
          'Cache-Control': 'public, max-age=300',
        });
        res.end(data);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });

    server.listen(0, '127.0.0.1', async () => {
      port = server.address().port;
      try {
        await startCloudflareTunnel(port);
        logger.info({ port, publicBase, tunnelKind }, 'localHost CF tunnel open');
      } catch (e1) {
        logger.warn({ err: e1.message }, 'cloudflared failed, trying localtunnel');
        try {
          await startLocaltunnel(port);
          logger.info({ port, publicBase, tunnelKind }, 'localHost localtunnel open');
        } catch (e2) {
          publicBase = `http://127.0.0.1:${port}`;
          tunnelKind = 'local-only';
          logger.warn({ err: e2.message }, 'no public tunnel — local only');
        }
      }
      resolve({ port, publicBase, tunnelKind });
    });
    server.on('error', reject);
  });
}

async function hostFile(filePath, fileName) {
  await ensureServer();
  const id = randId();
  const name = fileName || path.basename(filePath);
  routes.set(id, { filePath, mime: mimeOf(name) });
  return {
    ok: true,
    id,
    url: `${publicBase}/${id}/${encodeURIComponent(name)}`,
    local: `http://127.0.0.1:${port}/${id}/${encodeURIComponent(name)}`,
    base: publicBase,
    tunnel: tunnelKind,
  };
}

async function hostBuffer(buffer, fileName, mime) {
  await ensureServer();
  const id = randId();
  const dest = path.join(ROOT, `${id}_${fileName || 'file.bin'}`);
  fs.writeFileSync(dest, buffer);
  routes.set(id, { filePath: dest, mime: mime || mimeOf(fileName) });
  return {
    ok: true,
    id,
    url: `${publicBase}/${id}/${encodeURIComponent(fileName || 'file.bin')}`,
    local: `http://127.0.0.1:${port}/${id}/${encodeURIComponent(fileName || 'file.bin')}`,
    base: publicBase,
    tunnel: tunnelKind,
  };
}

async function hostImagePreview(imageBuffer, opts = {}) {
  await ensureServer();
  const id = randId();
  const imgName = opts.fileName || 'preview.jpg';
  const imgPath = path.join(ROOT, `${id}_${imgName}`);
  fs.writeFileSync(imgPath, imageBuffer);
  routes.set(`${id}_img`, { filePath: imgPath, mime: mimeOf(imgName) });
  const title = String(opts.title || 'Photo').slice(0, 80);
  const desc = String(opts.description || '').slice(0, 160);
  const imgUrl = `${publicBase}/${id}_img/${encodeURIComponent(imgName)}`;
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta property="og:title" content="${title.replace(/"/g, '&quot;')}"/>
<meta property="og:description" content="${desc.replace(/"/g, '&quot;')}"/>
<meta property="og:image" content="${imgUrl}"/>
<meta property="og:type" content="website"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:image" content="${imgUrl}"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title.replace(/</g, '')}</title>
<style>body{margin:0;background:#111;color:#eee;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}img{max-width:100%;height:auto;border-radius:12px}</style>
</head><body><img src="${imgUrl}" alt="${title.replace(/"/g, '')}"/></body></html>`;
  routes.set(id, { html });
  return { ok: true, id, url: `${publicBase}/${id}`, imageUrl: imgUrl, title, tunnel: tunnelKind };
}

async function hostHtml(html, title = 'Preview') {
  await ensureServer();
  const id = randId();
  routes.set(id, { html: String(html) });
  return {
    ok: true,
    id,
    url: `${publicBase}/${id}`,
    local: `http://127.0.0.1:${port}/${id}`,
    title,
    tunnel: tunnelKind,
  };
}

/**
 * Host a full static project folder (index.html + assets).
 * Public URL: {publicBase}/p/{id}/
 */
async function hostProject(projectRoot, opts = {}) {
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    return { ok: false, error: 'Project folder not found' };
  }
  const root = fs.statSync(projectRoot).isDirectory() ? projectRoot : path.dirname(projectRoot);
  // Prefer folder with index.html
  let serveRoot = root;
  if (!fs.existsSync(path.join(serveRoot, 'index.html'))) {
    const candidates = ['dist', 'build', 'public', 'out', '.next'];
    for (const c of candidates) {
      const p = path.join(root, c);
      if (fs.existsSync(path.join(p, 'index.html'))) {
        serveRoot = p;
        break;
      }
    }
  }
  await ensureServer();
  const id = opts.id || randId();
  projectHosts.set(id, {
    root: serveRoot,
    userId: opts.userId || null,
    startedAt: Date.now(),
    label: opts.label || path.basename(root),
  });
  const publicUrl = `${publicBase}/p/${id}/`;
  const localUrl = `http://127.0.0.1:${port}/p/${id}/`;
  return {
    ok: true,
    id,
    publicUrl,
    localUrl,
    base: publicBase,
    tunnel: tunnelKind,
    root: serveRoot,
    message:
      tunnelKind === 'cloudflare'
        ? `Live on Cloudflare tunnel:\n• Local: ${localUrl}\n• Public: ${publicUrl}`
        : tunnelKind === 'localtunnel'
          ? `Live (localtunnel):\n• Public: ${publicUrl}`
          : `Local only (no public tunnel): ${localUrl}\nInstall cloudflared for trycloudflare.com links.`,
  };
}

function listHosts() {
  const projects = [];
  for (const [id, p] of projectHosts.entries()) {
    projects.push({
      id,
      label: p.label,
      url: publicBase ? `${publicBase}/p/${id}/` : null,
      ageMs: Date.now() - p.startedAt,
    });
  }
  return {
    port,
    publicBase,
    tunnel: tunnelKind,
    projects,
    routes: routes.size,
  };
}

function stopProject(id) {
  if (!projectHosts.has(id)) return { ok: false, error: 'Unknown project id' };
  projectHosts.delete(id);
  return { ok: true, stopped: id };
}

function stopAll() {
  projectHosts.clear();
  routes.clear();
  if (tunnelProc) {
    try { tunnelProc.kill('SIGTERM'); } catch {}
    tunnelProc = null;
  }
  if (server) {
    try { server.close(); } catch {}
    server = null;
    port = 0;
    publicBase = null;
    tunnelKind = null;
  }
  return { ok: true };
}


/** Open a public CF/localtunnel URL pointing at an arbitrary local port (backends). */
async function tunnelPort(localPort) {
  try {
    return await startCloudflareTunnel(localPort);
  } catch (e1) {
    try {
      return await startLocaltunnel(localPort);
    } catch (e2) {
      throw new Error(`No public tunnel: ${e1.message}; ${e2.message}`);
    }
  }
}

module.exports = {
  tunnelPort,
  hostFile,
  hostBuffer,
  hostImagePreview,
  hostHtml,
  hostProject,
  listHosts,
  stopProject,
  stopAll,
  ensureServer,
  getBase: () => publicBase,
  getPort: () => port,
};

});

runtime.define("projectRunner", "projectRunner.js", function(module, exports, require, __filename, __dirname) {
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

});

runtime.define("siteRunner", "siteRunner.js", function(module, exports, require, __filename, __dirname) {
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

});
};
