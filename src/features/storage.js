'use strict';

module.exports = (runtime) => {
runtime.define("fileOps", "fileOps.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function canonicalWorkspace(workspace) {
  const root = fs.realpathSync(path.resolve(workspace));
  if (!fs.statSync(root).isDirectory()) throw new Error('Workspace root is not a directory.');
  return root;
}

/** Resolve a path safely within a workspace root, including symlink targets. */
function resolveSafe(filePath, workspace) {
  const workspacePath = path.resolve(workspace);
  const root = canonicalWorkspace(workspacePath);
  const raw = String(filePath || '.');
  const requested = path.resolve(workspacePath, raw);
  const resolved = isWithin(workspacePath, requested)
    ? path.resolve(root, path.relative(workspacePath, requested))
    : requested;
  if (!isWithin(root, resolved)) {
    throw new Error(`Path escapes workspace root: ${raw}`);
  }

  let existing = resolved;
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }

  const realExisting = fs.realpathSync(existing);
  if (!isWithin(root, realExisting)) {
    throw new Error(`Path escapes workspace root: ${raw}`);
  }
  const target = path.resolve(realExisting, path.relative(existing, resolved));
  if (!isWithin(root, target)) {
    throw new Error(`Path escapes workspace root: ${raw}`);
  }
  return target;
}

/** List files and directories at a given path. */
async function listFiles(dirPath, workspace, opts = {}) {
  const target = resolveSafe(dirPath || '.', workspace);
  if (!fs.existsSync(target)) return { ok: false, error: 'Path not found.' };
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    // Return file info
    return { ok: true, type: 'file', name: path.basename(target), size: stat.size, modified: stat.mtime.toISOString() };
  }
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
  const allEntries = fs.readdirSync(target, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const offset = Math.min(Math.max(Math.floor(Number(opts.offset) || 0), 0), allEntries.length);
  const entries = allEntries.slice(offset, offset + limit);
  const hasMore = offset + entries.length < allEntries.length;
  return {
    ok: true,
    path: path.relative(canonicalWorkspace(workspace), target) || '.',
    entries: entries.map(e => ({
      name: e.name,
      type: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : 'file',
      size: e.isFile() ? fs.statSync(path.join(target, e.name)).size : null,
    })),
    total: allEntries.length,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + entries.length : null,
  };
}

/** Read a file's contents. */
function readFile(filePath, workspace, opts = {}) {
  const target = resolveSafe(filePath, workspace);
  if (!fs.existsSync(target)) return { ok: false, error: 'File not found.' };
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return { ok: false, error: 'That is a directory, not a file.' };
  const maxSize = Number(opts.maxBytes) || 65536; // 64KB default
  if (stat.size > maxSize) {
    const start = Number(opts.startLine) || 1;
    const lines = fs.readFileSync(target, 'utf8').split('\n');
    const end = Math.min(lines.length, start + Math.floor(maxSize / 8) - 1);
    return { ok: true, name: path.basename(target), size: stat.size, truncated: true, startLine: start, endLine: end, totalLines: lines.length, content: lines.slice(start - 1, end).join('\n') };
  }
  return { ok: true, name: path.basename(target), size: stat.size, content: fs.readFileSync(target, 'utf8') };
}

/** Write content to a file. Creates parent directories if needed. */
function writeFile(filePath, content, workspace) {
  const root = canonicalWorkspace(workspace);
  const target = resolveSafe(filePath, workspace);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content);
  const stat = fs.statSync(target);
  return { ok: true, name: path.basename(target), size: stat.size, path: path.relative(root, target) };
}

/** Search for files matching a pattern using find + grep. */
async function searchFiles(query, workspace, opts = {}) {
  const root = canonicalWorkspace(workspace);
  const dir = resolveSafe(opts.dir || '.', workspace);
  if (!fs.existsSync(dir)) return { ok: false, error: 'Search directory not found.' };
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
  try {
    // Use rg (ripgrep) for content search, fall back to grep
    const pattern = String(query || '').replace(/[[\]*$^\\]/g, '\\$&');
    const { stdout } = await execFileP('rg', [
      '--files-with-matches', '-i',
      '--max-count', '1',
      '-g', '!.git',
      '-g', '!node_modules',
      pattern,
      dir,
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const files = stdout.trim().split('\n').filter(Boolean).slice(0, limit).map(f => path.relative(root, f));
    return { ok: true, query, matches: files, total: files.length };
  } catch {
    // Fallback: search filenames with find
    try {
      const { stdout } = await execFileP('find', [
        dir, '-name', `*${query}*`,
        '-not', '-path', '*/.git/*',
        '-not', '-path', '*/node_modules/*',
        '-type', 'f',
      ], { timeout: 10000, maxBuffer: 1024 * 1024 });
      const files = stdout.trim().split('\n').filter(Boolean).slice(0, limit).map(f => path.relative(root, f));
      return { ok: true, query, matches: files, total: files.length };
    } catch (e) {
      return { ok: false, error: 'Search failed: ' + e.message };
    }
  }
}

module.exports = { listFiles, readFile, writeFile, searchFiles, resolveSafe };

});

runtime.define("zipMemory", "zipMemory.js", function(module, exports, require, __filename, __dirname) {
const fs = require('fs');
const path = require('path');
const { Collection } = require('../db');
const AdmZip = require('adm-zip');

const store = new Collection('zip_memory', {});
const FIX_DIR = path.join(__dirname, '..', '..', 'storage', 'fixes');
const SRC_DIR = path.join(__dirname, '..', '..', 'storage', 'zips');
if (!fs.existsSync(FIX_DIR)) fs.mkdirSync(FIX_DIR, { recursive: true });
if (!fs.existsSync(SRC_DIR)) fs.mkdirSync(SRC_DIR, { recursive: true });

function key(chatId) {
  return String(chatId || '').replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 120);
}

function listTreeFromBuffer(buf, max = 100) {
  try {
    const z = new AdmZip(buf);
    return z
      .getEntries()
      .filter((e) => !e.isDirectory && !e.entryName.includes('__MACOSX'))
      .map((e) => e.entryName.replace(/\\/g, '/'))
      .filter((n) => n && !n.startsWith('.'))
      .slice(0, max);
  } catch {
    return [];
  }
}

function saveSourceZip(chatId, buffer, fileName = 'project.zip') {
  const k = key(chatId);
  const dest = path.join(SRC_DIR, `${k}_src.zip`);
  fs.writeFileSync(dest, buffer);
  return dest;
}

function saveFixZip(chatId, srcPath, fileName = 'fixed.zip') {
  const k = key(chatId);
  const dest = path.join(FIX_DIR, `${k}_${Date.now()}.zip`);
  try {
    fs.copyFileSync(srcPath, dest);
    try {
      for (const f of fs.readdirSync(FIX_DIR)) {
        if (f.startsWith(`${k}_`) && path.join(FIX_DIR, f) !== dest) {
          try { fs.unlinkSync(path.join(FIX_DIR, f)); } catch {}
        }
      }
    } catch {}
    return dest;
  } catch {
    return null;
  }
}

/** Persist the zip the user just sent so later "check X.js too" works without re-upload. */
function rememberSource(chatId, buffer, info = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const srcPath = saveSourceZip(chatId, buffer, info.fileName);
  const tree = listTreeFromBuffer(buffer);
  const prev = store.get(key(chatId), {}) || {};
  store.set(key(chatId), {
    ...prev,
    type: prev.type || 'source',
    at: Date.now(),
    fileName: info.fileName || prev.fileName || 'project.zip',
    sourceZipPath: srcPath,
    tree,
    summary: info.summary || prev.summary || `Zip with ${tree.length} files`,
  });
  return { srcPath, tree };
}

function rememberFix(chatId, info) {
  const k = key(chatId);
  const prev = store.get(k, {}) || {};
  let zipPath = info.zipPath || null;
  if (info.srcZipPath && fs.existsSync(info.srcZipPath)) {
    zipPath = saveFixZip(chatId, info.srcZipPath, info.fileName) || zipPath;
  }
  store.set(k, {
    ...prev,
    type: 'fix',
    at: Date.now(),
    changed: info.changed || [],
    changelog: info.changelog || [],
    verified: !!info.verified,
    message: info.message || '',
    complaint: info.complaint || '',
    fileName: info.fileName || prev.fileName || 'project.zip',
    summary: info.summary || prev.summary || '',
    zipPath,
    // keep source for follow-ups
    sourceZipPath: prev.sourceZipPath || info.sourceZipPath || null,
    tree: info.tree || prev.tree || [],
  });
}

function rememberAnalysis(chatId, info) {
  const prev = store.get(key(chatId), {}) || {};
  store.set(key(chatId), {
    ...prev,
    type: 'analysis',
    at: Date.now(),
    fileName: info.fileName || prev.fileName || 'project.zip',
    tree: (info.tree || prev.tree || []).slice(0, 120),
    summary: info.summary || '',
    sourceZipPath: prev.sourceZipPath || null,
  });
}

function get(chatId) {
  return store.get(key(chatId), null);
}

function getSourceBuffer(chatId) {
  const m = get(chatId);
  // Prefer fixed zip if we already fixed (continue from latest), else original source
  if (m?.zipPath && fs.existsSync(m.zipPath)) return fs.readFileSync(m.zipPath);
  if (m?.sourceZipPath && fs.existsSync(m.sourceZipPath)) return fs.readFileSync(m.sourceZipPath);
  return null;
}

function getFixZipPath(chatId) {
  const m = get(chatId);
  if (m?.type === 'fix' && m.zipPath && fs.existsSync(m.zipPath)) return m.zipPath;
  return null;
}

function readFileFromSavedZip(chatId, filePath) {
  const buf = getSourceBuffer(chatId);
  if (!buf) return { ok: false, error: 'No zip saved in this chat. Send a .zip first.' };
  const want = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (!want) return { ok: false, error: 'Which file path should I open?' };
  try {
    const z = new AdmZip(buf);
    const entry = z.getEntries().find((e) => {
      const n = e.entryName.replace(/\\/g, '/');
      return n.toLowerCase() === want || n.toLowerCase().endsWith('/' + want) || n.split('/').pop().toLowerCase() === want;
    });
    if (!entry || entry.isDirectory) {
      const tree = listTreeFromBuffer(buf, 60);
      return {
        ok: false,
        error: `File not found: ${filePath}`,
        tree,
        hint: 'Pick a path from the tree and ask again.',
      };
    }
    const data = entry.getData();
    const text = data.toString('utf8');
    const binary = /[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 200));
    return {
      ok: true,
      path: entry.entryName.replace(/\\/g, '/'),
      size: data.length,
      content: binary ? null : text.slice(0, 30000),
      binary,
      note: binary ? 'Binary file — content not shown as text.' : undefined,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function contextBlock(chatId) {
  const m = get(chatId);
  if (!m) return '';
  const ageMin = Math.round((Date.now() - (m.at || 0)) / 60000);
  const tree = (m.tree || []).slice(0, 40).join(', ');
  if (m.type === 'fix') {
    const changes = (m.changelog && m.changelog.length)
      ? m.changelog.slice(0, 12).join(' | ')
      : (m.changed || []).join(', ');
    return `[Last zip fix in this chat (~${ageMin}m ago) file=${m.fileName}
Changed: ${changes || '(none)'}
Tree sample: ${tree}
Source still available for follow-ups like "check server.js too" or "also fix the CSS".]`;
  }
  return `[Zip in this chat (~${ageMin}m ago) file=${m.fileName}
Files: ${tree}
You can open any path with read_zip_file or continue fixing with fix_zip without re-upload.]`;
}

module.exports = {
  rememberFix,
  rememberAnalysis,
  rememberSource,
  get,
  getSourceBuffer,
  getFixZipPath,
  saveFixZip,
  readFileFromSavedZip,
  listTreeFromBuffer,
  contextBlock,
  FIX_DIR,
  SRC_DIR,
};

});
};
