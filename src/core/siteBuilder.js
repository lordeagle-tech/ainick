// core/siteBuilder.js — AI fenced code → structured zip (never empty).
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

function langToFile(lang) {
  const l = (lang || '').toLowerCase();
  if (l === 'html' || l === 'html5' || l === '') return 'index.html';
  if (l === 'css') return 'css/style.css';
  if (l === 'js' || l === 'javascript' || l === 'node') return 'js/script.js';
  if (l === 'json') return 'package.json';
  if (l === 'py' || l === 'python') return 'main.py';
  if (l === 'md' || l === 'markdown') return 'README.md';
  if (l === 'ts' || l === 'typescript') return 'src/index.ts';
  return 'README.txt';
}

function sanitizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * Parse ```path/file.ext or ```lang fences. Prefers full file bodies.
 */
function parseFiles(answer) {
  const files = [];
  const seen = new Set();
  const text = String(answer || '');

  // Named fences: ```index.html or ```css/style.css
  const named = /```\s*([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)\s*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = named.exec(text)) !== null) {
    const name = sanitizePath(m[1].trim());
    const code = m[2].replace(/^\uFEFF/, '').trimEnd();
    if (!name || seen.has(name) || !code.trim()) continue;
    seen.add(name);
    files.push({ name, code });
  }

  if (!files.length) {
    const classic = /```([a-zA-Z0-9+#-]*)\s*\r?\n([\s\S]*?)```/g;
    while ((m = classic.exec(text)) !== null) {
      const name = langToFile(m[1]);
      const code = m[2].replace(/^\uFEFF/, '').trimEnd();
      if (seen.has(name) || !code.trim()) continue;
      seen.add(name);
      files.push({ name, code });
    }
  }

  // Bare HTML document without fences
  if (!files.length && /<!DOCTYPE html>|<html[\s>]/i.test(text)) {
    const start = text.search(/<!DOCTYPE html>|<html[\s>]/i);
    files.push({ name: 'index.html', code: text.slice(start).trim() });
  }

  return files;
}

function ensureHtmlDoc(code) {
  let c = String(code || '').trim();
  if (!c) return c;
  // If model returned HTML escaped as text inside a pre, don't double-wrap
  if (!/<html[\s>]/i.test(c) && !/<!DOCTYPE/i.test(c) && /<body|<div|<section/i.test(c)) {
    c = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n<title>Site</title>\n<script src="https://cdn.tailwindcss.com"><\/script>\n</head>\n<body>\n${c}\n</body>\n</html>`;
  }
  return c;
}

function buildZip(files, outDir, { requireIndexHtml = true, zipName = 'project' } = {}) {
  const list = Array.isArray(files) ? files.filter((f) => f && f.name && String(f.code || '').trim()) : [];
  if (!list.length) {
    throw new Error('No code files parsed from the model — empty zip blocked. Ask the model to output full files as ```index.html fences.');
  }

  // Normalize website index
  if (requireIndexHtml) {
    const idx = list.find((f) => f.name === 'index.html' || f.name.endsWith('/index.html'));
    if (idx) {
      idx.name = 'index.html';
      idx.code = ensureHtmlDoc(idx.code);
    } else {
      const htmlish = list.find((f) => /\.html?$/i.test(f.name));
      if (htmlish) {
        list.push({ name: 'index.html', code: ensureHtmlDoc(htmlish.code) });
      } else {
        throw new Error('Website build missing index.html with real HTML content.');
      }
    }
  }

  const zip = new AdmZip();
  let totalBytes = 0;
  const seen = new Set();
  for (const f of list) {
    const name = sanitizePath(f.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const buf = Buffer.from(String(f.code), 'utf8');
    if (!buf.length) continue;
    totalBytes += buf.length;
    zip.addFile(name, buf);
  }

  if (!seen.size || totalBytes < 20) {
    throw new Error('Refusing to write empty/near-empty zip.');
  }

  const safeName = String(zipName || 'project').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const outPath = path.join(outDir || os.tmpdir(), `${safeName}-${Date.now()}.zip`);
  zip.writeZip(outPath);

  const st = fs.statSync(outPath);
  if (st.size < 64) {
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error('Zip file was empty after write — build aborted.');
  }
  return outPath;
}

module.exports = { parseFiles, buildZip, sanitizePath, ensureHtmlDoc };
