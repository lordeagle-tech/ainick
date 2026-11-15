// features/zipMemory.js — remember last zip (source + fix) so follow-ups work mid-report.
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
