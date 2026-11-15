// repoAgent.js — search → choose → clone → fix → verify → push (user token + sandbox).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const logger = require('../logger');
const userWorkspace = require('./userWorkspace');
const github = require('./github');

function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = s.match(/github\.com[:/]+([^/]+)\/([^/#?\s]+)/i);
  if (m) {
    return {
      owner: m[1],
      repo: m[2].replace(/\.git$/i, ''),
      url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}.git`,
    };
  }
  m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (m) {
    return {
      owner: m[1],
      repo: m[2].replace(/\.git$/i, ''),
      url: `https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}.git`,
    };
  }
  if (/^https?:\/\//i.test(s)) {
    return { owner: '', repo: path.basename(s, '.git'), url: s };
  }
  if (/^[A-Za-z0-9._-]+$/.test(s)) {
    return { owner: '', repo: s, url: null, shortName: s };
  }
  return null;
}

async function git(args, cwd, timeoutMs = 120000) {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
}

function authUrl(repoUrl, token) {
  if (!token || !repoUrl) return repoUrl;
  try {
    const u = new URL(repoUrl);
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/** Search the authenticated user's repos (and orgs visible to the token). */
async function searchUserRepos(token, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!token) return { ok: false, error: 'GitHub token required. DM: github connect + your PAT.' };
  if (!q) return { ok: false, error: 'Search query required.' };

  const matches = [];
  const seen = new Set();
  try {
    for (let page = 1; page <= 5; page++) {
      const list = await github.listMyRepos({ token, perPage: 100, page, sort: 'updated' });
      if (!list?.length) break;
      for (const r of list) {
        const full = String(r.fullName || '');
        const name = full.split('/')[1] || '';
        const hay = `${full} ${r.description || ''}`.toLowerCase();
        if (!hay.includes(q) && name.toLowerCase() !== q) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        matches.push({
          fullName: full,
          url: r.url,
          description: r.description || '',
          private: !!r.private,
          defaultBranch: r.defaultBranch || 'main',
          language: r.language || '',
          updatedAt: r.updatedAt || '',
        });
      }
      if (list.length < 100) break;
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // Prefer exact name matches first
  matches.sort((a, b) => {
    const an = (a.fullName.split('/')[1] || '').toLowerCase();
    const bn = (b.fullName.split('/')[1] || '').toLowerCase();
    const ae = an === q ? 0 : an.startsWith(q) ? 1 : 2;
    const be = bn === q ? 0 : bn.startsWith(q) ? 1 : 2;
    if (ae !== be) return ae - be;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });

  return { ok: true, query: q, count: matches.length, repos: matches.slice(0, 15) };
}

function savePending(userJid, pending) {
  userWorkspace.setMemory(userJid, {
    pendingRepos: pending.repos || [],
    pendingQuery: pending.query || '',
    pendingTask: pending.task || '',
    pendingAt: Date.now(),
  });
}

function getPending(userJid) {
  const mem = userWorkspace.getMemory(userJid);
  if (!mem.pendingRepos?.length) return null;
  if (mem.pendingAt && Date.now() - mem.pendingAt > 30 * 60 * 1000) return null;
  return mem;
}

function clearPending(userJid) {
  userWorkspace.setMemory(userJid, {
    pendingRepos: [],
    pendingQuery: '',
    pendingTask: '',
    pendingAt: 0,
  });
}

/**
 * Search and return a numbered list for the user to pick from.
 */
async function searchAndList(opts = {}) {
  const token = opts.token;
  const userJid = opts.userJid;
  const query = opts.query || opts.repo || '';
  const task = opts.task || opts.error || '';
  const result = await searchUserRepos(token, query);
  if (!result.ok) return result;
  if (!result.repos.length) {
    return { ok: false, error: `No repos matching "${query}" on your GitHub account.` };
  }

  // Single exact match → auto-select path (caller may still confirm)
  const exact = result.repos.filter(
    (r) => (r.fullName.split('/')[1] || '').toLowerCase() === String(query).toLowerCase()
  );
  if (exact.length === 1 && result.repos.length === 1) {
    return {
      ok: true,
      unique: true,
      repo: exact[0],
      task,
      message: `Found exact match: ${exact[0].fullName}. Say "1" or "use it" to clone & fix, or call repo_work with that full name.`,
    };
  }

  savePending(userJid, { repos: result.repos, query, task });
  const lines = result.repos.map((r, i) => {
    const priv = r.private ? '🔒' : '🌐';
    const desc = r.description ? ` — ${r.description.slice(0, 60)}` : '';
    return `${i + 1}. ${priv} *${r.fullName}*${desc}`;
  });
  return {
    ok: true,
    needsChoice: true,
    count: result.repos.length,
    task: task || null,
    repos: result.repos,
    message:
      `Found ${result.repos.length} repo(s) related to *${query}*:\n\n` +
      lines.join('\n') +
      `\n\nReply with the number (e.g. *2*) or the full name. ` +
      (task ? `I'll then clone, fix (“${task.slice(0, 80)}”), verify, and push.` : 'Tell me what to fix after you pick.'),
  };
}

async function resolveRepoName(input, token, userJid) {
  const raw = String(input || '').trim();

  // Numeric choice from pending list
  if (/^\d{1,2}$/.test(raw)) {
    const pending = getPending(userJid);
    const idx = parseInt(raw, 10) - 1;
    if (pending?.pendingRepos?.[idx]) {
      const r = pending.pendingRepos[idx];
      const p = parseRepo(r.fullName);
      return {
        ok: true,
        ...p,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch || 'main',
        task: pending.pendingTask || '',
        from: 'choice',
      };
    }
  }

  let parsed = parseRepo(raw);
  if (!parsed) return { ok: false, error: 'Could not parse repo. Use a number from the list, owner/repo, or a name.' };

  if (parsed.owner && parsed.repo && parsed.url) {
    return { ok: true, ...parsed, fullName: `${parsed.owner}/${parsed.repo}` };
  }

  // Try pending name match
  const pending = getPending(userJid);
  if (pending?.pendingRepos?.length) {
    const short = (parsed.shortName || parsed.repo || '').toLowerCase();
    const hit = pending.pendingRepos.find(
      (r) =>
        (r.fullName || '').toLowerCase() === short ||
        (r.fullName.split('/')[1] || '').toLowerCase() === short
    );
    if (hit) {
      const p = parseRepo(hit.fullName);
      return {
        ok: true,
        ...p,
        fullName: hit.fullName,
        defaultBranch: hit.defaultBranch || 'main',
        task: pending.pendingTask || '',
        from: 'pending-name',
      };
    }
  }

  const search = await searchUserRepos(token, parsed.shortName || parsed.repo);
  if (!search.ok) return search;
  if (!search.repos.length) {
    return { ok: false, error: `No repo matching "${parsed.shortName || parsed.repo}".` };
  }
  if (search.repos.length === 1) {
    const r = search.repos[0];
    const p = parseRepo(r.fullName);
    return { ok: true, ...p, fullName: r.fullName, defaultBranch: r.defaultBranch || 'main', from: 'unique' };
  }
  // Ambiguous → list for choice
  savePending(userJid, { repos: search.repos, query: parsed.shortName || parsed.repo, task: '' });
  return {
    ok: true,
    needsChoice: true,
    repos: search.repos,
    message: search.repos.map((r, i) => `${i + 1}. ${r.fullName}`).join('\n'),
  };
}

function listProjectFiles(root, maxFiles = 120) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (out.length >= maxFiles) break;
      if (['.git', 'node_modules', '.next', 'dist', 'build', '__MACOSX', '.cache'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out;
}

async function verifyRepo(root) {
  const notes = [];
  const pkg = path.join(root, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      JSON.parse(fs.readFileSync(pkg, 'utf8'));
      notes.push('package.json: ok');
    } catch (e) {
      notes.push(`package.json: FAIL ${e.message}`);
    }
  }
  // syntax-check a few JS entry files
  const { execFileSync } = require('child_process');
  const candidates = listProjectFiles(root, 40).filter((f) => /\.(js|cjs|mjs)$/i.test(f)).slice(0, 8);
  for (const rel of candidates) {
    try {
      execFileSync(process.execPath, ['--check', path.join(root, rel)], {
        timeout: 8000,
        stdio: 'pipe',
      });
      notes.push(`${rel}: syntax ok`);
    } catch (e) {
      const msg = (e.stderr && e.stderr.toString()) || e.message;
      notes.push(`${rel}: FAIL ${String(msg).slice(0, 100)}`);
    }
  }
  const failed = notes.filter((n) => /FAIL/.test(n));
  return { ok: failed.length === 0, notes, failed };
}

async function pushWorkspaceViaApi(root, repoUrl, token, branch, message) {
  const files = [];
  for (const rel of listProjectFiles(root, 250)) {
    if (['.git'].some(x => rel === x || rel.startsWith(x + '/'))) continue;
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 900000) continue;
      if (!/\.(js|jsx|ts|tsx|mjs|cjs|json|html?|css|scss|less|md|txt|yml|yaml|xml|svg|sh|bash|py|rb|go|rs|java|c|cpp|h|hpp|sql|env|gitignore|toml|ini)$/i.test(rel)
          && !/^(Dockerfile|Makefile|Procfile)$/i.test(path.basename(rel))) continue;
      files.push({ name: rel, code: fs.readFileSync(abs, 'utf8') });
    } catch {}
  }
  if (!files.length) return { ok: false, error: 'No text files available for GitHub API push.' };
  return github.pushFiles({
    repoUrl,
    token,
    files,
    branch,
    commitMessage: message || 'fix: update project via repo agent',
  });
}

/**
 * Full pipeline: resolve → clone/download → fix → verify → push.
 * The GitHub API path is the fallback when local git/sandbox execution is unavailable.
 */
async function workOnRepo(opts = {}) {
  const userJid = opts.userJid || opts.senderJid;
  if (!userJid) return { ok: false, error: 'Missing user identity for sandbox.' };
  const token = opts.token || opts.accessToken || '';
  let task = String(opts.task || opts.errorDescription || opts.error || '').trim();
  const wantPush = opts.push !== false && !!token;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : async () => {};
  const input = opts.repoUrlOrName || opts.repo || opts.repoUrl || '';

  // Phase A: search-only when explicitly requested or ambiguous without choice
  if (opts.searchOnly || opts.action === 'search') {
    return searchAndList({ token, userJid, query: input, task });
  }

  if (!token) {
    return {
      ok: false,
      error: 'No GitHub token. DM me: github connect + your PAT (repo scope), then name the repo again.',
    };
  }

  const resolved = await resolveRepoName(input, token, userJid);
  if (!resolved.ok) return resolved;
  if (resolved.needsChoice) {
    savePending(userJid, {
      repos: resolved.repos,
      query: input,
      task,
    });
    const lines = resolved.repos.map((r, i) => `${i + 1}. ${r.private ? '🔒' : '🌐'} *${r.fullName}*`);
    return {
      ok: true,
      needsChoice: true,
      repos: resolved.repos,
      message:
        `Several repos match. Pick one:\n\n${lines.join('\n')}\n\nReply with the number or full name` +
        (task ? `, then I'll fix: ${task.slice(0, 100)}` : '.'),
    };
  }

  if (resolved.task && !task) task = resolved.task;

  const branch = opts.branch || resolved.defaultBranch || 'main';
  const root = userWorkspace.reposDir(userJid);
  const dest = path.join(root, `${resolved.owner}__${resolved.repo}`);
  const cloneUrl = authUrl(resolved.url, token);

  try {
    await onProgress(`Opening ${resolved.fullName}…`);
    let apiWorkspace = false;
    if (!fs.existsSync(path.join(dest, '.git'))) {
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      try {
        await git(['clone', '--depth', '50', cloneUrl, dest], root, 180000);
      } catch (cloneError) {
        // Do not let a restricted shell/sandbox kill GitHub work. Download the repo
        // directly through the GitHub API instead; edits and push can also stay API-only.
        logger.warn({ err: cloneError.message }, 'git clone unavailable — switching to GitHub API workspace');
        await onProgress('Local git is restricted here — switching to GitHub API access.');
        const downloaded = await github.downloadRepo({
          repoUrl: resolved.fullName,
          token,
          branch,
          destDir: dest,
        });
        if (!downloaded?.root) throw cloneError;
        apiWorkspace = true;
      }
    } else {
      try {
        await git(['remote', 'set-url', 'origin', cloneUrl], dest);
        await git(['fetch', 'origin'], dest, 120000);
        try {
          await git(['checkout', branch], dest);
        } catch {
          try { await git(['checkout', '-b', branch, `origin/${branch}`], dest); } catch {}
        }
        try { await git(['pull', '--ff-only', 'origin', branch], dest, 120000); } catch {}
      } catch (e) {
        logger.warn({ err: e.message }, 'git update failed — refreshing through GitHub API');
        try {
          await github.downloadRepo({ repoUrl: resolved.fullName, token, branch, destDir: dest });
          apiWorkspace = true;
        } catch (apiError) {
          logger.warn({ err: apiError.message }, 'GitHub API refresh failed — keeping local copy');
        }
      }
    }

    clearPending(userJid);
    userWorkspace.rememberRepo(userJid, {
      path: dest,
      name: resolved.fullName,
      url: resolved.url,
    });

    const tree = listProjectFiles(dest, 150);

    let fixResult = null;
    if (task && opts.aiClient) {
      await onProgress('Reading project & applying fixes…');
      try {
        const fixer = require('./fixer');
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        const walk = (dir, prefix = '') => {
          for (const name of fs.readdirSync(dir)) {
            if (['.git', 'node_modules', '.next', 'dist', 'build', '.cache'].includes(name)) continue;
            const full = path.join(dir, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            const st = fs.statSync(full);
            if (st.isDirectory()) walk(full, rel);
            else if (st.size < 500000) zip.addFile(rel.replace(/\\/g, '/'), fs.readFileSync(full));
          }
        };
        walk(dest);
        fixResult = await fixer.fixZip(zip.toBuffer(), task, opts.aiClient);
        if (fixResult.ok && !fixResult.noChanges && fixResult.zipPath && fs.existsSync(fixResult.zipPath)) {
          new AdmZip(fixResult.zipPath).extractAllTo(dest, true);
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'AI fix failed');
        fixResult = { ok: false, error: e.message };
      }
    }

    await onProgress('Verifying…');
    const verify = await verifyRepo(dest);

    let pushResult = null;
    if (wantPush && task && fixResult?.ok && !fixResult?.noChanges) {
      await onProgress('Pushing to GitHub…');
      try {
        if (apiWorkspace) {
          const pushed = await pushWorkspaceViaApi(
            dest,
            resolved.fullName,
            token,
            branch,
            `fix: ${task.slice(0, 72)}`,
          );
          pushResult = pushed?.commitSha
            ? { ok: true, pushed: true, method: 'github-api', commitSha: pushed.commitSha, commitUrl: pushed.commitUrl }
            : pushed;
        } else {
          await git(['config', 'user.email', 'agent@localhost'], dest);
          await git(['config', 'user.name', 'wa-agent'], dest);
          await git(['add', '-A'], dest);
          const status = await git(['status', '--porcelain'], dest);
          if (status.stdout) {
            await git(['commit', '-m', `fix: ${task.slice(0, 72)}`], dest, 60000);
            await git(['push', 'origin', 'HEAD'], dest, 180000);
            pushResult = { ok: true, pushed: true, method: 'git' };
          } else {
            pushResult = { ok: true, pushed: false, note: 'working tree clean' };
          }
        }
      } catch (e) {
        // One alternate push path before declaring failure.
        try {
          const pushed = await pushWorkspaceViaApi(dest, resolved.fullName, token, branch, `fix: ${task.slice(0, 72)}`);
          pushResult = pushed?.commitSha
            ? { ok: true, pushed: true, method: 'github-api-fallback', commitSha: pushed.commitSha, commitUrl: pushed.commitUrl }
            : { ok: false, error: pushed?.error || e.message };
        } catch (apiError) {
          pushResult = { ok: false, error: `${e.message}; API fallback: ${apiError.message}` };
        }
      }
    }

    return {
      ok: true,
      path: dest,
      repo: resolved.fullName,
      branch,
      files: tree.slice(0, 40),
      fileCount: tree.length,
      task: task || null,
      fixed: !!(fixResult?.ok && !fixResult?.noChanges),
      changed: fixResult?.changed || [],
      changelog: fixResult?.changelog || [],
      verified: verify,
      push: pushResult,
      sandbox: dest,
      message:
        `✅ *${resolved.fullName}*\n` +
        `Files: ${tree.length}\n` +
        (fixResult?.ok && !fixResult?.noChanges
          ? `Fixed: ${(fixResult.changed || []).slice(0, 8).join(', ')}\n`
          : task
            ? `Fix: ${fixResult?.noChanges ? 'no changes needed' : fixResult?.error || 'done'}\n`
            : '') +
        `Verify: ${verify.ok ? 'passed' : 'issues — ' + (verify.failed || []).slice(0, 3).join('; ')}\n` +
        (pushResult?.pushed ? 'Pushed to GitHub.' : pushResult?.error ? `Push failed: ${pushResult.error}` : ''),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), sandbox: userWorkspace.workspaceRoot(userJid) };
  }
}

async function pushFolder(opts = {}) {
  const token = opts.token || '';
  if (!token) return { ok: false, error: 'GitHub token required.' };
  const folder = opts.folder;
  if (!folder || !fs.existsSync(folder)) return { ok: false, error: 'Folder not found.' };
  const resolved = await resolveRepoName(opts.repo || opts.repoUrl, token, opts.userJid);
  if (!resolved.ok || resolved.needsChoice) return resolved;
  try {
    await git(['remote', 'set-url', 'origin', authUrl(resolved.url, token)], folder);
    await git(['add', '-A'], folder);
    try {
      await git(['commit', '-m', opts.message || 'update from agent'], folder);
    } catch {}
    await git(['push', '-u', 'origin', opts.branch || 'HEAD'], folder, 180000);
    return { ok: true, method: 'git-push', repo: resolved.fullName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  workOnRepo,
  pushFolder,
  parseRepo,
  resolveRepoName,
  searchAndList,
  searchUserRepos,
  getPending,
  clearPending,
};
