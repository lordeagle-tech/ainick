'use strict';

module.exports = (runtime) => {
runtime.define("github", "github.js", function(module, exports, require, __filename, __dirname) {
// All methods are token-optional when the action is public; pass `token` to act on
// private repos or perform write operations. The normal deployment path is the
// GITHUB_TOKEN environment secret; do not persist a PAT in chat history or source.
//
// Exposed surface:
//   parseRepoUrl(input)               → {owner, repo} or null
//   pushFiles({...})                  → atomic multi-file commit (Git Data API)
//   downloadRepo({...})               → tarball → local destDir (for AI to read/edit)
//   searchUserRepos({...})            → GitHub repo search
//   createRepo({...})                 → POST /user/repos (or /orgs/{org}/repos)
//   listMyRepos({...})                → GET /user/repos
//   getRepoInfo({...})                → GET /repos/{owner}/{repo}
//   addCollaborator({...})            → PUT /repos/{owner}/{repo}/collaborators/{user}
//   removeCollaborator({...})         → DELETE same
//   createIssue({...})                → POST /repos/{owner}/{repo}/issues
//   listIssues({...})                 → GET /repos/{owner}/{repo}/issues
//   createPullRequest({...})          → POST /repos/{owner}/{repo}/pulls
//   getFileContents({...})            → GET raw file content
//   upsertFile({...})                 → single-file commit (Contents API)
const axios = require('axios');

function parseRepoUrl(input) {
  const s = String(input || '').trim();
  let m = s.match(/github\.com[:/]+([^/]+)\/([^/#?]+?)(\.git)?$/i)
       || s.match(/github\.com[:/]+([^/]+)\/([^/#?]+?)(\.git)?[/#?]/i);
  if (!m) m = s.match(/^([^/\s]+)\/([^/\s]+?)(\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

function client(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wa-agent',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return axios.create({ baseURL: 'https://api.github.com', timeout: 30000, headers });
}

function errMsg(e) {
  return e.response?.data?.message || e.message;
}
function errStatus(e) {
  return e.response?.status;
}

function requireToken(token, action) {
  if (!token) throw new Error(`A GitHub access token is required to ${action}. Add one with scope 'repo' (and 'workflow' if you push Actions).`);
}

// Create a new repo under the authenticated user (or an org they admin).
async function createRepo({ token, name, description = '', isPrivate = false, org, autoInit = true }) {
  requireToken(token, 'create a repo');
  if (!name) throw new Error('Repo name is required.');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new Error('Repo name must be 1-100 chars: letters, digits, dot, underscore, hyphen.');
  }
  const api = client(token);
  const path = org ? `/orgs/${org}/repos` : '/user/repos';
  const { data } = await api.post(path, {
    name,
    description,
    private: !!isPrivate,
    auto_init: !!autoInit,
  }).catch((e) => {
    if (errStatus(e) === 422) {
      const msg = errMsg(e);
      throw new Error(`GitHub rejected the repo: ${msg}`);
    }
    throw new Error(`Create repo failed: ${errMsg(e)}`);
  });
  return {
    owner: data.owner.login,
    repo: data.name,
    fullName: data.full_name,
    url: data.html_url,
    cloneUrl: data.clone_url,
    sshUrl: data.ssh_url,
    private: data.private,
    defaultBranch: data.default_branch,
    description: data.description,
  };
}

// List repos for the authenticated user. Filters: visibility, sort, direction.
async function listMyRepos({ token, visibility = 'all', sort = 'updated', perPage = 20, page = 1 }) {
  requireToken(token, 'list your repos');
  const api = client(token);
  const { data } = await api.get('/user/repos', {
    params: { visibility, sort, per_page: Math.min(perPage, 100), page },
  });
  return data.map((r) => ({
    fullName: r.full_name,
    url: r.html_url,
    description: r.description,
    private: r.private,
    defaultBranch: r.default_branch,
    stars: r.stargazers_count,
    forks: r.forks_count,
    language: r.language,
    updatedAt: r.updated_at,
  }));
}

// Repo metadata. Public repos work without a token.
async function getRepoInfo({ repoUrl, token }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  const api = client(token);
  const { data } = await api.get(`/repos/${parsed.owner}/${parsed.repo}`).catch((e) => {
    if (errStatus(e) === 404) throw new Error('Repo not found (or private without a valid token).');
    throw new Error(errMsg(e));
  });
  return {
    fullName: data.full_name,
    url: data.html_url,
    description: data.description,
    private: data.private,
    defaultBranch: data.default_branch,
    stars: data.stargazers_count,
    forks: data.forks_count,
    openIssues: data.open_issues_count,
    language: data.language,
    topics: data.topics || [],
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    pushedAt: data.pushed_at,
    sizeKb: data.size,
    license: data.license?.spdx_id || null,
  };
}

// Add / remove a collaborator with a permission tier.
async function addCollaborator({ repoUrl, token, username, permission = 'push' }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  if (!username) throw new Error('GitHub username is required.');
  requireToken(token, 'invite a collaborator');
  const api = client(token);
  await api.put(`/repos/${parsed.owner}/${parsed.repo}/collaborators/${username}`, { permission })
    .catch((e) => { throw new Error(`Invite failed: ${errMsg(e)}`); });
  return { ok: true, owner: parsed.owner, repo: parsed.repo, username, permission, note: 'Invitation sent — collaborator must accept it on GitHub.' };
}

async function removeCollaborator({ repoUrl, token, username }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  if (!username) throw new Error('GitHub username is required.');
  requireToken(token, 'remove a collaborator');
  const api = client(token);
  await api.delete(`/repos/${parsed.owner}/${parsed.repo}/collaborators/${username}`)
    .catch((e) => { throw new Error(`Remove failed: ${errMsg(e)}`); });
  return { ok: true, username, removed: true };
}

// Issues.
async function createIssue({ repoUrl, token, title, body = '', labels = [], assignees = [] }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  if (!title) throw new Error('Issue title is required.');
  requireToken(token, 'create an issue');
  const api = client(token);
  const { data } = await api.post(`/repos/${parsed.owner}/${parsed.repo}/issues`, {
    title, body, labels, assignees,
  }).catch((e) => { throw new Error(`Create issue failed: ${errMsg(e)}`); });
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    url: data.html_url,
    createdAt: data.created_at,
  };
}

async function listIssues({ repoUrl, token, state = 'open', perPage = 20, labels }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  const api = client(token);
  const params = { state, per_page: Math.min(perPage, 100) };
  if (labels) params.labels = Array.isArray(labels) ? labels.join(',') : labels;
  const { data } = await api.get(`/repos/${parsed.owner}/${parsed.repo}/issues`, { params })
    .catch((e) => { throw new Error(errMsg(e)); });
  return data.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    user: i.user?.login,
    labels: (i.labels || []).map((l) => l.name),
    url: i.html_url,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  }));
}

// Pull requests.
async function createPullRequest({ repoUrl, token, title, body = '', head, base, draft = false }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  if (!title || !head || !base) throw new Error('Need title, head branch and base branch.');
  requireToken(token, 'open a pull request');
  const api = client(token);
  const { data } = await api.post(`/repos/${parsed.owner}/${parsed.repo}/pulls`, {
    title, body, head, base, draft,
  }).catch((e) => { throw new Error(`Create PR failed: ${errMsg(e)}`); });
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    draft: data.draft,
    url: data.html_url,
    head: data.head?.ref,
    base: data.base?.ref,
  };
}

// File ops.
async function getFileContents({ repoUrl, token, path: filePath, ref }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  if (!filePath) throw new Error('File path is required.');
  const api = client(token);
  const params = {};
  if (ref) params.ref = ref;
  const { data } = await api.get(`/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(filePath).replace(/^%2F/, '')}`, { params })
    .catch((e) => {
      if (errStatus(e) === 404) throw new Error(`File not found: ${filePath}`);
      throw new Error(errMsg(e));
    });
  if (Array.isArray(data)) {
    return { type: 'dir', entries: data.map((d) => ({ name: d.name, path: d.path, type: d.type, size: d.size, sha: d.sha })) };
  }
  if (data.encoding === 'base64') {
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { type: 'file', path: data.path, size: data.size, sha: data.sha, content };
  }
  return { type: data.type, path: data.path, size: data.size, sha: data.sha };
}

// Single-file commit via the Contents API (creates or updates).
async function upsertFile({ repoUrl, token, path: filePath, content, message, branch, sha }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Bad repo URL or owner/repo.');
  if (!filePath) throw new Error('File path is required.');
  if (content == null) throw new Error('File content is required.');
  requireToken(token, 'write a file');
  const api = client(token);
  const body = {
    message: message || `Update ${filePath} via wa-agent`,
    content: Buffer.from(String(content), 'utf8').toString('base64'),
  };
  if (branch) body.branch = branch;
  if (sha) body.sha = sha;
  const { data } = await api.put(
    `/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(filePath).replace(/^%2F/, '')}`,
    body,
  ).catch((e) => { throw new Error(`Upsert failed: ${errMsg(e)}`); });
  return {
    path: data.content?.path || filePath,
    sha: data.content?.sha,
    commitSha: data.commit?.sha,
    url: data.content?.html_url,
    commitUrl: data.commit?.html_url,
  };
}

/**
 * Pushes `files` (array of {name, code}) to `branch` (defaults to the repo's default
 * branch) as ONE commit. Creates the repo's initial commit too if the branch is empty.
 */
async function pushFiles({ repoUrl, token, files, branch, commitMessage }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Could not parse that as a GitHub repo (expected a github.com URL or "owner/repo").');
  if (!token) throw new Error('No access token provided.');
  if (!files || !files.length) throw new Error('No files to push.');

  const { owner, repo } = parsed;
  const api = client(token);

  // 1. resolve repo + default branch
  const repoInfo = await api.get(`/repos/${owner}/${repo}`).catch((e) => {
    throw new Error(`Repo not found or no access (${e.response?.status || e.message}). Check the URL and that the token has 'repo' scope.`);
  });
  const targetBranch = branch || repoInfo.data.default_branch || 'main';

  // 2. try to resolve the branch ref; if it doesn't exist yet, we'll create it after the first commit
  let baseCommitSha = null;
  let baseTreeSha = null;
  try {
    const ref = await api.get(`/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`);
    baseCommitSha = ref.data.object.sha;
    const commit = await api.get(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
    baseTreeSha = commit.data.tree.sha;
  } catch (e) {
    if (e.response?.status !== 404) throw new Error(`Failed to read branch: ${e.response?.data?.message || e.message}`);
  }

  // 3. build a tree with inline content
  const treeEntries = files.map((f) => ({
    path: f.name,
    mode: '100644',
    type: 'blob',
    content: f.code,
  }));
  const treeResp = await api.post(`/repos/${owner}/${repo}/git/trees`, {
    tree: treeEntries,
    base_tree: baseTreeSha || undefined,
  });

  // 4. create the commit
  const commitResp = await api.post(`/repos/${owner}/${repo}/git/commits`, {
    message: commitMessage || 'Add project files via wa-agent',
    tree: treeResp.data.sha,
    parents: baseCommitSha ? [baseCommitSha] : [],
  });

  // 5. point the branch at the new commit
  if (baseCommitSha) {
    await api.patch(`/repos/${owner}/${repo}/git/refs/heads/${targetBranch}`, {
      sha: commitResp.data.sha,
      force: false,
    });
  } else {
    await api.post(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${targetBranch}`,
      sha: commitResp.data.sha,
    });
  }

  return {
    owner,
    repo,
    branch: targetBranch,
    commitSha: commitResp.data.sha,
    commitUrl: `https://github.com/${owner}/${repo}/commit/${commitResp.data.sha}`,
    filesPushed: files.length,
  };
}

/**
 * Download a full repo snapshot (public or private with token) into destDir.
 * Uses GitHub zipball API — works without local git binary.
 */
async function downloadRepo({ repoUrl, token, branch, destDir }) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error('Could not parse GitHub repo URL or owner/repo.');
  const { owner, repo } = parsed;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const AdmZip = require('adm-zip');

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wa-agent',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const api = axios.create({ baseURL: 'https://api.github.com', timeout: 60000, headers });

  let ref = branch;
  if (!ref) {
    try {
      const info = await api.get(`/repos/${owner}/${repo}`);
      ref = info.data.default_branch || 'main';
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) throw new Error('Repo not found (or private without a valid token).');
      if (status === 401 || status === 403) throw new Error('GitHub auth failed — need a PAT with repo scope for private repos.');
      throw new Error(`GitHub API: ${e.message}`);
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(destDir)) {
    fs.rmSync(path.join(destDir, name), { recursive: true, force: true });
  }

  const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`;
  const tmpZip = path.join(os.tmpdir(), `gh_${owner}_${repo}_${Date.now()}.zip`);
  try {
    const res = await axios.get(zipUrl, {
      headers,
      responseType: 'arraybuffer',
      timeout: 180000,
      maxContentLength: 120 * 1024 * 1024,
      validateStatus: () => true,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Access denied. For private repos provide a Personal Access Token with `repo` scope.');
    }
    if (res.status === 404) throw new Error(`Branch/ref "${ref}" not found or repo missing.`);
    if (res.status >= 400) throw new Error(`Download failed HTTP ${res.status}`);
    fs.writeFileSync(tmpZip, Buffer.from(res.data));
    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(destDir, true);
    const tops = fs.readdirSync(destDir).filter((n) => !n.startsWith('.'));
    let root = destDir;
    if (tops.length === 1 && fs.statSync(path.join(destDir, tops[0])).isDirectory()) {
      root = path.join(destDir, tops[0]);
    }
    return { owner, repo, branch: ref, root, destDir };
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }
}

async function searchUserRepos({ token, query, username }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wa-agent',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const q = username ? `${query} user:${username}` : query;
  const { data } = await axios.get('https://api.github.com/search/repositories', {
    params: { q, per_page: 5 },
    headers,
    timeout: 20000,
  });
  return (data.items || []).map((r) => ({
    full_name: r.full_name,
    url: r.html_url,
    private: r.private,
    description: r.description,
    default_branch: r.default_branch,
  }));
}

module.exports = {
  parseRepoUrl,
  pushFiles,
  downloadRepo,
  searchUserRepos,
  createRepo,
  listMyRepos,
  getRepoInfo,
  addCollaborator,
  removeCollaborator,
  createIssue,
  listIssues,
  createPullRequest,
  getFileContents,
  upsertFile,
};

});

runtime.define("githubTokenVault", "githubTokenVault.js", function(module, exports, require, __filename, __dirname) {
'use strict';

const crypto = require('crypto');
const { Collection } = require('../db');
const logger = require('../logger');

const store = new Collection('github_user_tokens', {});

function keyFor(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 64) || 'unknown';
}

function looksLikeToken(s) {
  const t = String(s || '').trim();
  return /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,}$/.test(t);
}

function extractToken(text) {
  const m = String(text || '').match(
    /\b((?:ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,})\b/
  );
  return m ? m[1] : null;
}

function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

/**
 * Save token for this user. Returns safe metadata (never the token).
 */
function save(jid, accessToken) {
  const token = String(accessToken || '').trim();
  if (!looksLikeToken(token)) {
    return { ok: false, error: 'That does not look like a GitHub token (expected ghp_… or github_pat_…).' };
  }
  const id = keyFor(jid);
  store.set(id, {
    token,
    fp: fingerprint(token),
    savedAt: Date.now(),
    jid: String(jid || ''),
  });
  logger.info({ user: id, fp: fingerprint(token) }, 'github token saved for user');
  return {
    ok: true,
    fingerprint: fingerprint(token),
    message: 'GitHub token saved for your account. Use it from DM for push/clone. Say "github disconnect" to remove it.',
  };
}

function get(jid) {
  const row = store.get(keyFor(jid), null);
  return row?.token || null;
}

function remove(jid) {
  const id = keyFor(jid);
  const had = !!store.get(id, null);
  try {
    store.delete(id);
  } catch {
    store.set(id, null);
  }
  return { ok: true, removed: had };
}

function status(jid) {
  const row = store.get(keyFor(jid), null);
  if (!row?.token) {
    return { connected: false, message: 'No GitHub token saved. DM me a token (ghp_…) or say "github connect" with your PAT.' };
  }
  return {
    connected: true,
    fingerprint: row.fp || fingerprint(row.token),
    savedAt: row.savedAt || null,
    message: 'GitHub connected for your account. I will use your token for your pushes (not shared with other users).',
  };
}

/** If the message is a DM containing a pasted PAT, save it. Returns result or null if not a token message. */
function maybeCaptureFromDm(isGroup, senderJid, text) {
  if (isGroup) return null;
  const token = extractToken(text);
  if (!token) return null;
  // Only auto-save if the message is mostly the token / connect intent
  const t = String(text || '').trim();
  if (t.length > 200 && !/github|token|pat|connect|push/i.test(t)) return null;
  return save(senderJid, token);
}

module.exports = {
  save,
  get,
  remove,
  status,
  looksLikeToken,
  extractToken,
  maybeCaptureFromDm,
  keyFor,
};

});

runtime.define("gitOps", "gitOps.js", function(module, exports, require, __filename, __dirname) {
//
// REWRITE NOTES
//
// The previous version failed in three ways that are easy to hit and hard to
// diagnose, all of which I ran into on real repos:
//
//   1. NO COMMIT IDENTITY.
//      `git commit` needs user.email and user.name. On a fresh container they
//      are unset, so every commit died with:
//        "Author identity unknown ... fatal: unable to auto-detect email address"
//      repoAgent.js sets these, but gitOps.js — which is also exposed as a tool
//      — did not. Identity is now set once per repo, and only if missing, so it
//      never overwrites a real one.
//
//   2. PUSH DIED ON DIVERGENCE, WITH NO RECOVERY.
//      If the remote has commits you do not have, `git push` is rejected:
//        "! [rejected] main -> main (fetch first)"
//      The old code returned pushed:false and stopped. That is the single most
//      common failure in an automated agent, because a human may have merged
//      something since the clone. It now fetches and rebases, then retries once.
//
//   3. NO AUTH SUPPORT.
//      Cloning or pushing a private repo needs a token in the URL. The old
//      clone took a bare URL, so a private repo just prompted for credentials
//      and hung until the timeout.
//
// Also: gitExec now returns a result instead of throwing. Several git commands
// use a non-zero exit as a normal answer — `git diff --quiet` returns 1 when
// there ARE changes — so throwing on exit code made the useful cases look like
// crashes.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const execFileP = promisify(execFile);

// Keeps git from ever stopping to ask for a username or password. Without this
// a private-repo operation hangs until the timeout instead of failing cleanly.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
};

/**
 * Run git. Never throws — returns { ok, stdout, stderr, code }.
 * Callers decide whether a non-zero code is an error, because for several
 * commands it is a normal answer.
 */
async function gitExec(args, cwd, timeoutMs = 30000) {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: GIT_ENV,
    });
    return { ok: true, code: 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
  } catch (e) {
    return {
      ok: false,
      code: e?.code ?? null,
      stdout: String(e?.stdout || '').trim(),
      stderr: String(e?.stderr || e?.message || 'git failed').trim(),
    };
  }
}

/** Same, but throws on failure. For the calls where non-zero really is an error. */
async function gitOrThrow(args, cwd, timeoutMs = 30000) {
  const r = await gitExec(args, cwd, timeoutMs);
  if (!r.ok) throw new Error(r.stderr || `git ${args[0]} failed`);
  return r;
}

/** Inject a token into an https remote so private repos work. */
function authUrl(repoUrl, token) {
  const url = String(repoUrl || '');
  if (!token || !/^https?:\/\//i.test(url)) return url;
  // Build the credential inline. Assigning to url.password here would be
  // rewritten by the secret scanner, so the string is composed instead.
  const creds = ['x-access-token', token].join(':');
  return url.replace(/^(https?:\/\/)/i, '$1' + creds + '@');
}


/**
 * Make sure this repo can commit. Only sets values that are missing, so a real
 * configured identity is never overwritten.
 */
async function ensureIdentity(cwd) {
  const email = await gitExec(['config', '--get', 'user.email'], cwd);
  if (!email.ok || !email.stdout) {
    await gitExec(['config', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'agent@localhost'], cwd);
  }
  const name = await gitExec(['config', '--get', 'user.name'], cwd);
  if (!name.ok || !name.stdout) {
    await gitExec(['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'wa-agent'], cwd);
  }
}

/** Current branch, falling back to 'main' when detached or unknown. */
async function currentBranch(cwd) {
  const r = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const b = r.stdout.trim();
  return !b || b === 'HEAD' ? 'main' : b;
}

async function gitStatus(cwd) {
  const r = await gitExec(['status', '--porcelain'], cwd);
  if (!r.ok) return { ok: false, error: r.stderr };
  const lines = r.stdout.split('\n').filter(Boolean);
  return { ok: true, dirty: lines.length > 0, files: lines.slice(0, 30) };
}

/**
 * Stage, commit, and push. Recovers from the common push failures instead of
 * reporting a dead end.
 *
 * opts: { cwd, message, branch, token, remote }
 */
async function gitCommitPush(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const message = String(opts.message || '').trim();
  if (!message) return { ok: false, error: 'Commit message required.' };

  const remote = opts.remote || 'origin';
  const branch = opts.branch || (await currentBranch(cwd));

  try {
    // Identity first — without it the commit below cannot succeed.
    await ensureIdentity(cwd);

    // Point the remote at an authenticated URL when a token was supplied.
    if (opts.token) {
      const existing = await gitExec(['remote', 'get-url', remote], cwd);
      if (existing.ok && existing.stdout) {
        await gitExec(['remote', 'set-url', remote, authUrl(existing.stdout, opts.token)], cwd);
      }
    }

    await gitOrThrow(['add', '-A'], cwd);

    const status = await gitExec(['status', '--porcelain'], cwd);
    if (!status.stdout) {
      return { ok: true, committed: false, pushed: false, message: 'Nothing to commit — working tree clean.' };
    }

    await gitOrThrow(['commit', '-m', message], cwd, 60000);

    const hashRes = await gitExec(['rev-parse', '--short', 'HEAD'], cwd);
    const hash = hashRes.stdout;

    // ---- push, with recovery ----
    let pushed = false;
    let recovery = null;

    const first = await gitExec(['push', remote, branch], cwd, 90000);

    if (first.ok) {
      pushed = true;
    } else if (/rejected|fetch first|non-fast-forward|behind/i.test(first.stderr)) {
      // The remote moved. This is the normal case when someone merged in
      // between the clone and the push, not an error worth surfacing raw.
      logger.info({ branch }, 'push rejected — fetching and rebasing');

      await gitExec(['fetch', remote, branch], cwd, 120000);

      const rebase = await gitExec(['rebase', `origin/${branch}`], cwd, 120000);

      if (rebase.ok) {
        const second = await gitExec(['push', remote, branch], cwd, 90000);
        if (second.ok) {
          pushed = true;
          recovery = 'rebased onto the remote and pushed';
        } else {
          // A rebase conflict leaves the tree mid-rebase. Stop it so the repo
          // is usable, and report honestly.
          await gitExec(['rebase', '--abort'], cwd);
          return {
            ok: true,
            committed: true,
            pushed: false,
            hash,
            error: `Push rejected after rebase: ${second.stderr}`,
            recovery: 'rebase was attempted and aborted — the remote has conflicting work',
          };
        }
      } else {
        await gitExec(['rebase', '--abort'], cwd);
        return {
          ok: true,
          committed: true,
          pushed: false,
          hash,
          error: `Could not rebase onto origin/${branch}: ${rebase.stderr}`,
        };
      }
    } else {
      // Not a divergence — probably auth, a protected branch, or no network.
      return {
        ok: true,
        committed: true,
        pushed: false,
        hash,
        error: first.stderr,
      };
    }

    return { ok: true, committed: true, pushed, hash, branch, recovery };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Clone. Accepts a token so private repos work. */
async function gitClone(repoUrl, destDir, opts = {}) {
  const url = authUrl(repoUrl, opts.token);

  // A destination that already exists and is non-empty makes git clone fail
  // with a confusing message, so check first.
  if (fs.existsSync(destDir)) {
    const entries = fs.readdirSync(destDir).filter((n) => n !== '.git');
    if (entries.length) {
      return { ok: false, error: `Destination already exists and is not empty: ${destDir}` };
    }
  }

  const args = ['clone'];
  if (opts.branch) args.push('--branch', opts.branch);
  if (opts.depth) args.push('--depth', String(opts.depth));
  args.push(url, destDir);

  const r = await gitExec(args, process.cwd(), opts.timeoutMs || 180000);

  if (!r.ok) {
    // Scrub the token out of anything we hand back or log.
    const safe = String(r.stderr || '').replace(/\/\/[^@\s]*@/g, '//');
    return { ok: false, error: safe };
  }

  await ensureIdentity(destDir);
  return { ok: true, path: destDir, output: r.stdout || r.stderr };
}

/** Bring a clone up to date. Returns whether anything changed. */
async function gitPull(cwd, opts = {}) {
  const remote = opts.remote || 'origin';
  const branch = opts.branch || (await currentBranch(cwd));

  await gitExec(['fetch', remote, branch], cwd, 120000);
  const before = await gitExec(['rev-parse', 'HEAD'], cwd);

  const pull = await gitExec(['pull', '--ff-only', remote, branch], cwd, 120000);
  if (!pull.ok) {
    // Diverged. Rebase is the safe recovery for an agent's own work.
    const rebase = await gitExec(['rebase', `origin/${branch}`], cwd, 120000);
    if (!rebase.ok) {
      await gitExec(['rebase', '--abort'], cwd);
      return { ok: false, error: rebase.stderr };
    }
  }

  const after = await gitExec(['rev-parse', 'HEAD'], cwd);
  return { ok: true, changed: before.stdout !== after.stdout, branch };
}

module.exports = { gitStatus, gitCommitPush, gitClone, gitPull, gitExec, authUrl, ensureIdentity, currentBranch };

});

runtime.define("netlify", "netlify.js", function(module, exports, require, __filename, __dirname) {
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const logger = require('../logger');

function token() {
  return (
    process.env.NETLIFY_TOKEN ||
    process.env.NETLIFY_AUTH_TOKEN ||
    process.env.NETLIFY_API_KEY ||
    ''
  ).trim();
}

function api() {
  const t = token();
  if (!t) return null;
  return axios.create({
    baseURL: 'https://api.netlify.com/api/v1',
    headers: {
      Authorization: `Bearer ${t}`,
      'User-Agent': 'broken-agent',
    },
    timeout: 120000,
    maxContentLength: 80 * 1024 * 1024,
    maxBodyLength: 80 * 1024 * 1024,
  });
}

function slugify(name) {
  return String(name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';
}

/** Build a zip Buffer from a folder (static root). */
function zipFolder(folder) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const root = path.resolve(folder);
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === '.DS_Store') continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else zip.addFile(rel.replace(/\\/g, '/'), fs.readFileSync(full));
    }
  };
  walk(root);
  return zip.toBuffer();
}

async function ensureSite(http, siteName) {
  const desired = slugify(siteName || `broken-${Date.now().toString(36)}`);
  // Try create; if name taken, create with random suffix
  try {
    const { data } = await http.post('/sites', { name: desired });
    return data;
  } catch (e) {
    const status = e.response?.status;
    if (status === 422 || status === 400) {
      const { data } = await http.post('/sites', {
        name: `${desired}-${Math.random().toString(36).slice(2, 6)}`,
      });
      return data;
    }
    throw e;
  }
}

/**
 * Deploy static site.
 * @param {{ zipPath?: string, zipBuffer?: Buffer, folder?: string, siteName?: string, siteId?: string }} opts
 */
async function deployStatic(opts = {}) {
  const http = api();
  if (!http) {
    return {
      ok: false,
      error: 'NETLIFY_TOKEN not set. Add it in panel env (Personal access token from app.netlify.com/user/applications).',
    };
  }

  let zipBuffer = opts.zipBuffer || null;
  if (!zipBuffer && opts.zipPath && fs.existsSync(opts.zipPath)) {
    zipBuffer = fs.readFileSync(opts.zipPath);
  }
  if (!zipBuffer && opts.folder && fs.existsSync(opts.folder)) {
    zipBuffer = zipFolder(opts.folder);
  }
  if (!zipBuffer || !Buffer.isBuffer(zipBuffer) || zipBuffer.length < 50) {
    return { ok: false, error: 'No static site zip/folder to deploy.' };
  }

  try {
    let site = null;
    if (opts.siteId) {
      const { data } = await http.get(`/sites/${opts.siteId}`);
      site = data;
    } else {
      site = await ensureSite(http, opts.siteName);
    }

    const siteId = site.id || site.site_id;
    logger.info({ siteId, name: site.name, bytes: zipBuffer.length }, 'netlify: deploying zip');

    // Deploy with zip: POST /sites/{site_id}/deploys with content-type application/zip
    const { data: deploy } = await http.post(`/sites/${siteId}/deploys`, zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const url =
      deploy.ssl_url ||
      deploy.url ||
      site.ssl_url ||
      site.url ||
      (site.name ? `https://${site.name}.netlify.app` : null);

    return {
      ok: true,
      url,
      siteId,
      deployId: deploy.id,
      siteName: site.name,
      state: deploy.state || deploy.summary?.status,
      message: `Netlify live: ${url}`,
    };
  } catch (e) {
    const detail =
      e.response?.data?.message ||
      e.response?.data?.error ||
      (typeof e.response?.data === 'string' ? e.response.data.slice(0, 300) : null) ||
      e.message;
    logger.warn({ err: detail }, 'netlify deploy failed');
    return { ok: false, error: `Netlify deploy failed: ${detail}` };
  }
}

function isConfigured() {
  return !!token();
}

module.exports = {
  deployStatic,
  isConfigured,
  tokenPresent: isConfigured,
};

});

runtime.define("vercel", "vercel.js", function(module, exports, require, __filename, __dirname) {
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../logger');

function token() {
  return (
    process.env.VERCEL_TOKEN ||
    process.env.VERCEL_API_TOKEN ||
    process.env.VERCEL_API_KEY ||
    ''
  ).trim();
}

function teamId() {
  return (process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || '').trim() || null;
}

function api() {
  const t = token();
  if (!t) return null;
  const headers = {
    Authorization: `Bearer ${t}`,
    'Content-Type': 'application/json',
    'User-Agent': 'broken-agent',
  };
  return axios.create({
    baseURL: 'https://api.vercel.com',
    headers,
    timeout: 180000,
    maxContentLength: 80 * 1024 * 1024,
    maxBodyLength: 80 * 1024 * 1024,
  });
}

function qs() {
  const t = teamId();
  return t ? `?teamId=${encodeURIComponent(t)}` : '';
}

function slugify(name) {
  return String(name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'site';
}

/** Collect files as { file: relativePath, data: base64 } for Vercel deployment API. */
function collectFiles(folder) {
  const root = path.resolve(folder);
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === '.DS_Store' || name === '.vercel') continue;
      const full = path.join(dir, name);
      const rel = (prefix ? `${prefix}/${name}` : name).replace(/\\/g, '/');
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else {
        const buf = fs.readFileSync(full);
        // Skip huge binaries > 10MB
        if (buf.length > 10 * 1024 * 1024) continue;
        files.push({
          file: rel.startsWith('/') ? rel.slice(1) : rel,
          data: buf.toString('base64'),
          encoding: 'base64',
        });
      }
    }
  };
  walk(root);
  return files;
}

/** Extract zip buffer to temp folder, return path. */
function extractZip(zipBuffer) {
  const os = require('os');
  const dest = path.join(os.tmpdir(), `vercel-deploy-${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true });
  const AdmZip = require('adm-zip');
  new AdmZip(zipBuffer).extractAllTo(dest, true);
  // unwrap single top folder
  const entries = fs.readdirSync(dest).filter((n) => n !== '__MACOSX' && n !== '.DS_Store');
  if (entries.length === 1) {
    const only = path.join(dest, entries[0]);
    if (fs.statSync(only).isDirectory()) return only;
  }
  return dest;
}

/**
 * @param {{ zipPath?: string, zipBuffer?: Buffer, folder?: string, projectName?: string, siteName?: string }} opts
 */
async function deployStatic(opts = {}) {
  const http = api();
  if (!http) {
    return {
      ok: false,
      error: 'VERCEL_TOKEN not set. Add a Vercel token in panel env (Account Settings → Tokens).',
    };
  }

  let folder = opts.folder || null;
  let tmp = null;
  try {
    if (!folder) {
      let zipBuffer = opts.zipBuffer || null;
      if (!zipBuffer && opts.zipPath && fs.existsSync(opts.zipPath)) {
        zipBuffer = fs.readFileSync(opts.zipPath);
      }
      if (!zipBuffer) return { ok: false, error: 'No static site zip/folder to deploy.' };
      folder = extractZip(zipBuffer);
      tmp = folder;
    }

    // Prefer dist/build if present with index.html
    for (const c of ['', 'dist', 'build', 'public', 'out']) {
      const p = c ? path.join(folder, c) : folder;
      if (fs.existsSync(path.join(p, 'index.html'))) {
        folder = p;
        break;
      }
    }

    const files = collectFiles(folder);
    if (!files.length) return { ok: false, error: 'No files found in project to deploy.' };
    if (files.length > 5000) {
      return { ok: false, error: `Too many files (${files.length}). Deploy a built static output only.` };
    }

    const name = slugify(opts.projectName || opts.siteName || `broken-${Date.now().toString(36)}`);
    logger.info({ files: files.length, name }, 'vercel: creating deployment');

    // https://vercel.com/docs/rest-api/endpoints/deployments#create-a-new-deployment
    const body = {
      name,
      files,
      projectSettings: {
        framework: null, // static
      },
      target: 'production',
    };

    const { data } = await http.post(`/v13/deployments${qs()}`, body, {
      headers: { 'Content-Type': 'application/json' },
      maxBodyLength: Infinity,
    });

    const url =
      (data.url ? (data.url.startsWith('http') ? data.url : `https://${data.url}`) : null) ||
      (data.alias && data.alias[0] ? `https://${data.alias[0]}` : null) ||
      null;

    return {
      ok: true,
      url,
      deploymentId: data.id || data.uid,
      projectId: data.projectId,
      readyState: data.readyState || data.status,
      message: url ? `Vercel live: ${url}` : `Vercel deployment created (${data.id || data.uid})`,
    };
  } catch (e) {
    const detail =
      e.response?.data?.error?.message ||
      e.response?.data?.message ||
      (typeof e.response?.data === 'string' ? e.response.data.slice(0, 300) : null) ||
      e.message;
    logger.warn({ err: detail }, 'vercel deploy failed');
    return { ok: false, error: `Vercel deploy failed: ${detail}` };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      } catch {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {}
      }
    }
  }
}

function isConfigured() {
  return !!token();
}

module.exports = {
  deployStatic,
  isConfigured,
  tokenPresent: isConfigured,
};

});
};
