// localHost.js — serve files/projects + public URL via Cloudflare quick tunnel
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
