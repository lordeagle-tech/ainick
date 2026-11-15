// vercel.js — deploy static sites via Vercel API (VERCEL_TOKEN).
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
