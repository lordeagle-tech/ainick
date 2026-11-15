// netlify.js — deploy static sites via Netlify API (NETLIFY_TOKEN).
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
