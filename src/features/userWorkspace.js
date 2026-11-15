// userWorkspace.js — per-user private sandbox on disk for git/clone/file work.
'use strict';

const fs = require('fs');
const path = require('path');
const { Collection } = require('../db');

const ROOT = path.join(process.cwd(), 'storage', 'workspaces');
fs.mkdirSync(ROOT, { recursive: true });

const memStore = new Collection('user_workspace_mem', {});

function safeId(userJid) {
  const s = String(userJid || 'anon')
    .split('@')[0]
    .split(':')[0]
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 48);
  return s || 'anon';
}

/** Absolute path to this user's private sandbox (created on demand). */
function workspaceRoot(userJid) {
  const id = safeId(userJid);
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  // repos subfolder
  fs.mkdirSync(path.join(dir, 'repos'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  return dir;
}

function reposDir(userJid) {
  const d = path.join(workspaceRoot(userJid), 'repos');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function getMemory(userJid) {
  const id = safeId(userJid);
  return memStore.get(id, { repos: [], lastRepo: null, notes: [] });
}

function setMemory(userJid, patch) {
  const id = safeId(userJid);
  const prev = getMemory(userJid);
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  memStore.set(id, next);
  return next;
}

function rememberRepo(userJid, info) {
  const mem = getMemory(userJid);
  const repos = Array.isArray(mem.repos) ? mem.repos.slice() : [];
  const entry = {
    path: info.path,
    name: info.name || path.basename(info.path || ''),
    url: info.url || '',
    at: Date.now(),
  };
  const rest = repos.filter((r) => r.path !== entry.path);
  rest.unshift(entry);
  while (rest.length > 20) rest.pop();
  return setMemory(userJid, { repos: rest, lastRepo: entry });
}

function resolveInside(userJid, relOrAbs) {
  const root = workspaceRoot(userJid);
  const target = path.resolve(root, relOrAbs || '.');
  if (!target.startsWith(path.resolve(root))) {
    throw new Error('Path escapes user sandbox');
  }
  return target;
}

function listRepos(userJid) {
  const dir = reposDir(userJid);
  try {
    return fs.readdirSync(dir).filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

module.exports = {
  workspaceRoot,
  reposDir,
  getMemory,
  setMemory,
  rememberRepo,
  resolveInside,
  listRepos,
  ROOT,
};
