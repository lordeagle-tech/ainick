// features/github.js — full GitHub ops via the REST + Git Data APIs.
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

// ---------------------------------------------------------------------------
// Create a new repo under the authenticated user (or an org they admin).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// List repos for the authenticated user. Filters: visibility, sort, direction.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Repo metadata. Public repos work without a token.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Add / remove a collaborator with a permission tier.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Issues.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Pull requests.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// File ops.
// ---------------------------------------------------------------------------
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
