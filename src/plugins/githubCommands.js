'use strict';

const fs = require('fs');
const path = require('path');
const github = require('../features').github;
const githubTokenVault = require('../features').githubTokenVault;
const gitOps = require('../features').gitOps;
const userWorkspace = require('../features').userWorkspace;
const roles = require('../features').roles;
const commandPrefix = require('./commandPrefix');
const messageLayout = require('../utils/messageLayout');

const menuCommands = ['github', 'github status', 'github disconnect', 'gitcheck', 'gitinfo', 'gitrepos', 'gitissues'];
// Kept separate from the owner-only GitHub section so everyone sees the clone command.
const publicMenuCommands = ['gitclone owner/repo'];

// Cloning is open to everyone, so keep it bounded: shallow clones, a short
// cooldown per sender, one clone at a time per sender, and a size ceiling.
const CLONE_COOLDOWN_MS = 20000;
const MAX_CLONE_BYTES = 150 * 1024 * 1024;
const MAX_SCAN_FILES = 20000;
const activeClones = new Set();
const lastCloneAt = new Map();

const KEY_FILES = new Set([
  'readme', 'readme.md', 'readme.txt', 'package.json', 'pyproject.toml',
  'requirements.txt', 'setup.py', 'go.mod', 'cargo.toml', 'makefile',
  'dockerfile', 'docker-compose.yml', 'composer.json', 'pom.xml', 'build.gradle',
  'index.js', 'main.py', 'app.py',
]);

function commandText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^(?:github(?:\s+(?:status|disconnect))?|github\s+clone(?:\s+[\s\S]+)?|gitclone(?:\s+[\s\S]+)?|gitcheck|gitrepos|gitinfo(?:\s+[\s\S]+)?|gitissues(?:\s+[\s\S]+)?)$/i.test(commandText(input));
}

function safe(value, limit = 180) {
  return String(value || '').replace(/[\r\n`*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** For values shown inside backticks: keeps underscores (part of repo names/paths). */
function codeSafe(value, limit = 200) {
  return String(value || '').replace(/[\r\n`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function ownerAllowed(ctx) {
  return !!ctx.isOwner || roles.isOwner(ctx.senderJid);
}

function helpText() {
  return [
    '*Nick AI · GitHub commands*',
    'Read-only commands are private (owner only); `gitclone` is open to everyone.',
    '• `gitclone owner/repo` — clone a *public* repo into your private Nick workspace',
    '• `github status` — check whether your personal token is saved',
    '• `github disconnect` — remove your saved token',
    '• `gitcheck` — verify your saved token with GitHub',
    '• `gitrepos` — list your recent repositories',
    '• `gitinfo owner/repo` — show repository details',
    '• `gitissues owner/repo` — list open issues',
    'To connect, DM Nick `github connect` with your GitHub token. Never send a token in a group.',
    'Push, pull, commits, issue creation, and other write actions are not enabled by these commands.',
  ].join('\n');
}

function tokenFor(ctx) {
  return githubTokenVault.get(ctx.senderJid);
}

function connectedHint() {
  return 'No GitHub token is saved for your account. In a private chat, send `github connect` with your GitHub token; it is stored per user and is not shown back.';
}

/** Accept only public GitHub repos: owner/repo or an https://github.com/... link. */
function parsePublicRepo(input) {
  const raw = String(input || '').trim().replace(/\s+/g, '');
  const bad = 'Usage: `gitclone owner/repo` or `gitclone https://github.com/owner/repo` (public repos only).';
  if (!raw) return { error: bad };

  let owner;
  let repo;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
    [owner, repo] = raw.split('/');
  } else {
    let url;
    try { url = new URL(raw); } catch { return { error: bad }; }
    if (!/^https?:$/i.test(url.protocol)) return { error: 'Only public GitHub HTTPS links are supported. Use `gitclone owner/repo` instead.' };
    if (url.username || url.password) return { error: 'Do not put credentials in the link — public repos need no token.' };
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return { error: 'Only github.com repositories are supported.' };
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return { error: bad };
    owner = parts[0];
    repo = parts[1];
  }

  repo = repo.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)
    || [owner, repo].some((part) => part === '.' || part === '..')) {
    return { error: bad };
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

/** Count files/bytes outside .git and collect top-level-style key files. */
function summarizeRepo(dest) {
  const found = [];
  let files = 0;
  let bytes = 0;
  const stack = [{ rel: '', depth: 0 }];
  while (stack.length && files < MAX_SCAN_FILES) {
    const { rel, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(dest, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (['.git', 'node_modules', 'vendor'].includes(entry.name)) continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push({ rel: childRel, depth: depth + 1 });
      } else if (entry.isFile()) {
        files++;
        try { bytes += fs.statSync(path.join(dest, childRel)).size; } catch {}
        if (depth <= 2 && KEY_FILES.has(entry.name.toLowerCase()) && found.length < 12) {
          found.push(childRel.replace(/\\/g, '/'));
        }
      }
    }
  }
  return { files, bytes, keyFiles: found.slice(0, 8) };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function handleClone(ctx, text) {
  const parsedRepo = parsePublicRepo(text.replace(/^(?:gitclone|github\s+clone)\b/i, '').trim());
  if (parsedRepo.error) return { handled: true, text: parsedRepo.error };

  const sender = String(ctx.senderJid || ctx.chatId || 'anon');
  const now = Date.now();
  if (activeClones.has(sender)) {
    return { handled: true, text: 'A clone is already running for you — wait for it to finish before starting another.' };
  }
  if (now - (lastCloneAt.get(sender) || 0) < CLONE_COOLDOWN_MS) {
    return { handled: true, text: 'Please wait a moment before cloning another repo.' };
  }
  activeClones.add(sender);
  lastCloneAt.set(sender, now);
  if (lastCloneAt.size > 500) lastCloneAt.clear();

  const root = userWorkspace.reposDir(sender);
  const dest = path.join(root, `${parsedRepo.owner}__${parsedRepo.repo}-${now}`);
  const label = `${parsedRepo.owner}/${parsedRepo.repo}`;

  try {
    const result = await gitOps.gitClone(parsedRepo.url, dest, { depth: 1, timeoutMs: 180000 });
    if (!result.ok) {
      fs.rmSync(dest, { recursive: true, force: true });
      return { handled: true, text: `Could not clone \`${codeSafe(label)}\`: ${safe(result.error, 300)}\nOnly public GitHub repos work here — private repos need your own token and the repo_work agent.` };
    }

    const stats = summarizeRepo(dest);
    if (stats.bytes > MAX_CLONE_BYTES) {
      fs.rmSync(dest, { recursive: true, force: true });
      return { handled: true, text: `That repo is too large to keep (${formatBytes(stats.bytes)}). Nothing was saved.` };
    }

    const branch = await gitOps.currentBranch(dest);
    const head = await gitOps.gitExec(['rev-parse', '--short', 'HEAD'], dest);
    userWorkspace.rememberRepo(sender, { path: dest, name: label, url: parsedRepo.url });

    const lines = [
      `*Cloned \`${codeSafe(label)}\`*`,
      `• Branch: \`${codeSafe(branch)}\` · Commit: \`${codeSafe(head.ok ? head.stdout : 'unknown', 20)}\``,
      `• Files: ${stats.files} · Size: ${formatBytes(stats.bytes)} (outside .git)`,
      stats.keyFiles.length ? `• Key files: ${stats.keyFiles.map((file) => codeSafe(file, 80)).join(', ')}` : '• Key files: none detected',
      `• Saved in your private workspace: \`${codeSafe(path.relative(process.cwd(), dest))}\``,
      'Public repo only — no GitHub token was used.',
    ];
    return { handled: true, text: lines.join('\n') };
  } catch (error) {
    fs.rmSync(dest, { recursive: true, force: true });
    return { handled: true, text: `Clone failed: ${safe(error.message, 300)}` };
  } finally {
    activeClones.delete(sender);
  }
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }

  // Public clone command — available to everyone, in DMs and groups, no token.
  if (/^(?:gitclone|github\s+clone)\b/i.test(text)) return handleClone(ctx, text);

  if (!ownerAllowed(ctx)) return { handled: true, text: messageLayout.accessDenied('owner') };
  if (ctx.isGroup) return { handled: true, text: 'For privacy, use GitHub commands in a private chat with Nick.' };

  if (/^github$/i.test(text)) return { handled: true, text: helpText() };
  if (/^github\s+status$/i.test(text)) {
    const status = githubTokenVault.status(ctx.senderJid);
    return { handled: true, text: status.connected ? 'GitHub token is saved for your account.' : connectedHint() };
  }
  if (/^github\s+disconnect$/i.test(text)) {
    const result = githubTokenVault.remove(ctx.senderJid);
    return { handled: true, text: result.removed ? 'GitHub token removed from your account.' : 'No saved GitHub token was found.' };
  }

  const token = tokenFor(ctx);
  if (/^gitcheck$/i.test(text)) {
    if (!token) return { handled: true, text: connectedHint() };
    try {
      const repos = await github.listMyRepos({ token, perPage: 1 });
      return { handled: true, text: `GitHub connection verified. Your token can access repositories${repos.length ? ` (for example, ${safe(repos[0].fullName)})` : ''}.` };
    } catch (error) {
      return { handled: true, text: `GitHub check failed: ${safe(error.message, 300)}` };
    }
  }

  if (/^gitrepos$/i.test(text)) {
    if (!token) return { handled: true, text: connectedHint() };
    try {
      const repos = await github.listMyRepos({ token, perPage: 10, sort: 'updated' });
      if (!repos.length) return { handled: true, text: 'No repositories were returned for this account.' };
      const lines = repos.map((repo) => `• ${safe(repo.fullName)} · ${repo.private ? 'private' : 'public'} · ${safe(repo.defaultBranch || 'no default branch')}`);
      return { handled: true, text: `*Your recent GitHub repositories*\n${lines.join('\n')}` };
    } catch (error) {
      return { handled: true, text: `Could not list repositories: ${safe(error.message, 300)}` };
    }
  }

  const repoMatch = text.match(/^(gitinfo|gitissues)(?:\s+([\s\S]+))?$/i);
  if (repoMatch) {
    const action = repoMatch[1].toLowerCase();
    const repoUrl = String(repoMatch[2] || '').trim();
    if (!repoUrl) return { handled: true, text: `Usage: \`${action} owner/repo\` or provide the GitHub repository URL.` };
    try {
      if (action === 'gitinfo') {
        const repo = await github.getRepoInfo({ repoUrl, token: token || undefined });
        const lines = [
          `*${safe(repo.fullName)}* · ${repo.private ? 'private' : 'public'}`,
          safe(repo.description || 'No description provided.'),
          `Default branch: ${safe(repo.defaultBranch || 'unknown')}`,
          `Stars: ${Number(repo.stars || 0).toLocaleString()} · Forks: ${Number(repo.forks || 0).toLocaleString()} · Open issues: ${Number(repo.openIssues || 0).toLocaleString()}`,
          `Language: ${safe(repo.language || 'not specified')} · License: ${safe(repo.license || 'not specified')}`,
          safe(repo.url, 300),
        ];
        return { handled: true, text: lines.join('\n') };
      }
      const issues = await github.listIssues({ repoUrl, token: token || undefined, state: 'open', perPage: 5 });
      if (!issues.length) return { handled: true, text: 'No open issues were returned for that repository.' };
      const lines = issues.map((issue) => `• #${issue.number} ${safe(issue.title, 140)}\n  ${safe(issue.url, 300)}`);
      return { handled: true, text: `*Open issues for ${safe(repoUrl)}*\n${lines.join('\n')}` };
    } catch (error) {
      return { handled: true, text: `GitHub request failed: ${safe(error.message, 300)}` };
    }
  }

  return { handled: false };
}

module.exports = { isCommand, route, menuCommands, publicMenuCommands };
