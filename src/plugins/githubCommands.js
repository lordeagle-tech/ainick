'use strict';

const github = require('../features').github;
const githubTokenVault = require('../features').githubTokenVault;
const roles = require('../features').roles;
const commandPrefix = require('./commandPrefix');
const messageLayout = require('../utils/messageLayout');

const menuCommands = ['github', 'github status', 'github disconnect', 'gitcheck', 'gitinfo', 'gitrepos', 'gitissues'];

function commandText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^(?:github(?:\s+(?:status|disconnect))?|gitcheck|gitrepos|gitinfo(?:\s+[\s\S]+)?|gitissues(?:\s+[\s\S]+)?)$/i.test(commandText(input));
}

function safe(value, limit = 180) {
  return String(value || '').replace(/[\r\n`*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function ownerAllowed(ctx) {
  return !!ctx.isOwner || roles.isOwner(ctx.senderJid);
}

function helpText() {
  return [
    '*Nick AI · GitHub commands*',
    'Use these in a private chat; they are read-only except disconnecting your saved token.',
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

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }
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

module.exports = { isCommand, route, menuCommands };
