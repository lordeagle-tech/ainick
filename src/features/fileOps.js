// features/fileOps.js — clean file operations for the bot's AI tools
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

/** Resolve a path safely within a workspace root. Prevents path traversal. */
function resolveSafe(filePath, workspace) {
  const root = path.resolve(workspace);
  const raw = String(filePath || '.');
  // Absolute paths are allowed only when they are already inside the selected
  // workspace. Relative paths are resolved from that workspace. This keeps
  // the tool safe while allowing the developer agent to pass real absolute
  // project paths when it has explicitly selected the project workspace.
  const resolved = path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${raw}`);
  }
  return resolved;
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
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, limit);
  return {
    ok: true,
    path: path.relative(workspace, target) || '.',
    entries: entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isFile() ? fs.statSync(path.join(target, e.name)).size : null,
    })),
    total: entries.length,
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
  const target = resolveSafe(filePath, workspace);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content);
  const stat = fs.statSync(target);
  return { ok: true, name: path.basename(target), size: stat.size, path: path.relative(workspace, target) };
}

/** Search for files matching a pattern using find + grep. */
async function searchFiles(query, workspace, opts = {}) {
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
    const files = stdout.trim().split('\n').filter(Boolean).slice(0, limit).map(f => path.relative(workspace, f));
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
      const files = stdout.trim().split('\n').filter(Boolean).slice(0, limit).map(f => path.relative(workspace, f));
      return { ok: true, query, matches: files, total: files.length };
    } catch (e) {
      return { ok: false, error: 'Search failed: ' + e.message };
    }
  }
}

module.exports = { listFiles, readFile, writeFile, searchFiles, resolveSafe };
