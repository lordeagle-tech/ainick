// features/fixer.js — unzip → workspace → AI fix → verify → re-zip → return
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const AdmZip = require('adm-zip');
const logger = require('../logger');

const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'html', 'css', 'scss', 'json', 'yml', 'yaml', 'sh', 'bash', 'md', 'txt', 'xml', 'sql', 'vue', 'svelte',
]);

function isCode(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return CODE_EXT.has(ext);
}

function safeName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function extractToWorkspace(buffer) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-fix-'));
  const zip = new AdmZip(buffer);
  for (const e of zip.getEntries()) {
    const name = safeName(e.entryName);
    if (!name || name.includes('..') || name.startsWith('/')) continue;
    if (name.includes('node_modules/') || name.startsWith('__MACOSX')) continue;
    const dest = path.join(work, name);
    if (e.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }
  // Prefer single top-level folder as root
  const top = fs.readdirSync(work).filter((n) => n !== '__MACOSX' && !n.startsWith('.'));
  let root = work;
  if (top.length === 1 && fs.statSync(path.join(work, top[0])).isDirectory()) {
    root = path.join(work, top[0]);
  }
  return { work, root };
}

function listCodeFiles(root, maxFiles = 80, maxBytes = 120000) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (out.length >= maxFiles) break;
      if (['node_modules', '.git', 'dist', 'build', '__MACOSX', '.next'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (isCode(ent.name)) {
        try {
          const st = fs.statSync(p);
          if (st.size > 250000) continue;
          const content = fs.readFileSync(p, 'utf8');
          out.push({
            rel: path.relative(root, p).replace(/\\/g, '/'),
            abs: p,
            content: content.slice(0, maxBytes),
            full: content,
            size: st.size,
          });
        } catch {}
      }
    }
  };
  walk(root);
  return out;
}

function listAllFiles(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (['node_modules', '.git', '__MACOSX'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out;
}

async function fixWithAI(aiClient, files, complaint, tree) {
  const codeCtx = files
    .map((f) => `===== FILE: ${f.rel} =====\n${f.content}`)
    .join('\n\n');

  const prompt = `You are a senior engineer fixing a whole project zip, not a single file.

PROBLEM: ${complaint}

Project tree:
${tree.slice(0, 80).join('\n')}

Code files (full contents where size allows):
${codeCtx}

YOUR JOB:
1. Read ALL listed files. Find every issue tied to the problem (blank page, truncated HTML, missing sections, broken CSS/JS links, incomplete tags, etc.).
2. Fix EVERY affected file — not just one. Typical static sites need index.html + CSS + JS together.
3. Output COMPLETE file contents for each changed file (never a partial snippet).
4. After writing fixes, mentally verify: HTML has full html/head/body and closed tags; linked CSS/JS paths exist; no blank main content if the design should show sections.

Output format — one block per file:

\`\`\`fix:path/to/file.ext
<full file content>
\`\`\`

Then:

\`\`\`CHANGELOG
- path/to/file.ext: what changed
\`\`\`

Rules:
- Prefer complete working pages over minimal patches when content was truncated or blank
- If index.html is truncated mid-tag or body is empty, rebuild the missing sections to match the project purpose
- Include CSS/JS changes when layout/behavior is broken
- Keep working unrelated files intact
- If truly nothing is wrong, output exactly: NO_FIX_NEEDED
- CHANGELOG must list every file you changed`;

  // Force primary Agnes path via simpleComplete (no Qwen)
  const answer = await aiClient.simpleComplete(
    prompt,
    'You are an expert software debugger. Output ```fix:path blocks, then optional ```CHANGELOG, or NO_FIX_NEEDED.',
    { coding: true },
  );
  if (!String(answer || '').trim()) {
    throw new Error('Empty response from coding model while fixing zip');
  }
  if (/NO_FIX_NEEDED/i.test(answer)) return { files: {}, changelog: [] };

  const changed = {};
  const re = /```fix:([^\n]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(answer)) !== null) {
    const p = m[1].trim().replace(/^\.\//, '');
    changed[p] = m[2].replace(/\n$/, '');
  }
  // Also accept ```path style
  const re2 = /```([a-z0-9_./-]+\.[a-z0-9]+)\n([\s\S]*?)```/gi;
  while ((m = re2.exec(answer)) !== null) {
    const p = m[1].trim();
    if (!changed[p] && !/^(fix|js|ts|python|bash|json|CHANGELOG)/i.test(p)) {
      // skip language-only tags without path
    }
  }

  const changelog = [];
  const cl = /```CHANGELOG\n([\s\S]*?)```/i.exec(answer);
  if (cl) {
    for (const line of cl[1].split(/\r?\n/)) {
      const t = line.replace(/^[-*•]\s*/, '').trim();
      if (t) changelog.push(t);
    }
  }
  // Fallback: one line per changed file if model skipped CHANGELOG
  if (!changelog.length) {
    for (const p of Object.keys(changed)) {
      changelog.push(`${p}: updated to address reported issue`);
    }
  }
  return { files: changed, changelog };
}

async function verifyProject(root) {
  const checks = [];
  // package.json → syntax-check main entry if node
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      checks.push({ name: 'package.json', ok: true });
      const main = pkg.main || 'index.js';
      const mainPath = path.join(root, main);
      if (fs.existsSync(mainPath) && /\.m?js$/i.test(main)) {
        try {
          await execFileP(process.execPath, ['--check', mainPath], { timeout: 15000 });
          checks.push({ name: `node --check ${main}`, ok: true });
        } catch (e) {
          checks.push({ name: `node --check ${main}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 300) });
        }
      }
      // check a few js files
      const jsFiles = listCodeFiles(root, 8, 500).filter((f) => /\.m?jsx?$/i.test(f.rel));
      for (const f of jsFiles.slice(0, 5)) {
        try {
          await execFileP(process.execPath, ['--check', f.abs], { timeout: 10000 });
          checks.push({ name: `syntax ${f.rel}`, ok: true });
        } catch (e) {
          checks.push({ name: `syntax ${f.rel}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 200) });
        }
      }
    } catch (e) {
      checks.push({ name: 'package.json', ok: false, error: e.message });
    }
  } else {
    // Plain JS/HTML project — syntax-check any .js
    const jsFiles = listCodeFiles(root, 12, 500).filter((f) => /\.m?jsx?$/i.test(f.rel));
    for (const f of jsFiles.slice(0, 6)) {
      try {
        await execFileP(process.execPath, ['--check', f.abs], { timeout: 10000 });
        checks.push({ name: `syntax ${f.rel}`, ok: true });
      } catch (e) {
        checks.push({ name: `syntax ${f.rel}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 200) });
      }
    }
    if (!jsFiles.length) {
      checks.push({ name: 'static/html project', ok: true, note: 'no JS to syntax-check' });
    }
  }

  // Python files
  const py = listCodeFiles(root, 6, 500).filter((f) => f.rel.endsWith('.py'));
  for (const f of py.slice(0, 3)) {
    try {
      await execFileP('python3', ['-m', 'py_compile', f.abs], { timeout: 10000 });
      checks.push({ name: `py_compile ${f.rel}`, ok: true });
    } catch (e) {
      checks.push({ name: `py_compile ${f.rel}`, ok: false, error: (e.stderr || e.message || '').toString().slice(0, 200) });
    }
  }

  const failed = checks.filter((c) => c.ok === false);
  return { ok: failed.length === 0, checks, failed };
}

function zipWorkspace(root, work) {
  const zip = new AdmZip();
  const walk = (dir, prefix = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '__MACOSX'].includes(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else zip.addLocalFile(abs, path.dirname(rel) === '.' ? '' : path.dirname(rel), ent.name);
    }
  };
  walk(root);
  const out = path.join(os.tmpdir(), `fixed_${Date.now()}.zip`);
  zip.writeZip(out);
  return out;
}

/**
 * Full pipeline: extract → fix → write → verify → zip
 */
async function fixZip(buffer, complaint, aiClient) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { ok: false, error: 'Empty or invalid zip buffer.' };
  }
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    return { ok: false, error: 'Not a valid zip (missing PK header). Resend the file.' };
  }

  let work, root;
  try {
    ({ work, root } = extractToWorkspace(buffer));
  } catch (e) {
    return { ok: false, error: `Could not extract zip: ${e.message}` };
  }

  try {
    const tree = listAllFiles(root);
    if (!tree.length) return { ok: false, error: 'Zip is empty after extract.' };

    const codeFiles = listCodeFiles(root);
    if (!codeFiles.length) {
      return { ok: false, error: 'No readable code files found in that zip.' };
    }

    let fixResult;
    try {
      fixResult = await fixWithAI(aiClient, codeFiles, complaint, tree);
    } catch (e) {
      const msg = String(e.message || e);
      if (/Cannot POST|<!DOCTYPE|__CF\$|qwen/i.test(msg)) {
        return { ok: false, error: 'AI fix failed — check AGNES_API_KEY (Qwen is permanently removed).' };
      }
      return { ok: false, error: `AI fix failed: ${msg.slice(0, 240)}` };
    }

    // Back-compat: older shape was a plain { path: content } map
    let changed = fixResult?.files && typeof fixResult.files === 'object' && !Array.isArray(fixResult.files)
      ? fixResult.files
      : (fixResult && !fixResult.files ? fixResult : {});
    let changelog = Array.isArray(fixResult?.changelog) ? fixResult.changelog : [];

    // Second pass if model only touched 1 file but project has more code and complaint is structural
    const broad = /blank|empty|broken|all|whole|entire|layout|page|section|css|js|html|everything|truncated/i.test(complaint || '');
    if (Object.keys(changed).length === 1 && codeFiles.length > 1 && broad) {
      try {
        // Apply first pass to in-memory file list for second review
        const merged = codeFiles.map((f) => {
          if (changed[f.rel] != null) {
            return { ...f, content: String(changed[f.rel]).slice(0, 120000), full: String(changed[f.rel]) };
          }
          return f;
        });
        const pass2 = await fixWithAI(
          aiClient,
          merged,
          complaint + '\n\nSECOND PASS: You only changed one file before. Review CSS/JS and any other files that must change for a complete fix. Output every remaining file that still needs updates.',
          tree,
        );
        const more = pass2?.files && typeof pass2.files === 'object' ? pass2.files : {};
        for (const [k, v] of Object.entries(more)) changed[k] = v;
        if (Array.isArray(pass2?.changelog)) changelog = changelog.concat(pass2.changelog);
      } catch (e2) {
        logger.warn({ err: e2.message }, 'fix second pass skipped');
      }
    }

    if (!Object.keys(changed).length) {
      return {
        ok: true,
        noChanges: true,
        message: "I read the project and didn't need changes for that report. Describe the exact error/stack if it's still broken.",
      };
    }

    // Write fixes into workspace
    const written = [];
    for (const [rel, content] of Object.entries(changed)) {
      const abs = path.join(root, rel);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        written.push(rel);
      } catch (e) {
        logger.warn({ rel, err: e.message }, 'fix write failed');
      }
    }

    // Verify
    let verify = { ok: true, checks: [] };
    try {
      verify = await verifyProject(root);
    } catch (e) {
      verify = { ok: false, checks: [], failed: [{ name: 'verify', error: e.message }] };
    }

    // If verify failed, one repair pass on failing files
    if (!verify.ok && verify.failed?.length) {
      try {
        const failNote = verify.failed.map((f) => `${f.name}: ${f.error || 'fail'}`).join('\n');
        const repairResult = await fixWithAI(
          aiClient,
          listCodeFiles(root),
          `After first fix, verification failed:\n${failNote}\nOriginal problem: ${complaint}`,
          tree,
        );
        const repair = repairResult?.files && typeof repairResult.files === 'object' && !Array.isArray(repairResult.files)
          ? repairResult.files
          : (repairResult && !repairResult.files ? repairResult : {});
        if (Array.isArray(repairResult?.changelog)) {
          changelog = changelog.concat(repairResult.changelog);
        }
        for (const [rel, content] of Object.entries(repair)) {
          const abs = path.join(root, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
          if (!written.includes(rel)) written.push(rel);
        }
        verify = await verifyProject(root);
      } catch (e) {
        logger.warn({ err: e.message }, 'repair pass failed');
      }
    }

    if (!changelog.length) {
      changelog = written.map((p) => `${p}: updated to address reported issue`);
    }

    const zipPath = zipWorkspace(root, work);
    return {
      ok: true,
      zipPath,
      changed: written,
      changelog,
      complaint,
      verified: verify.ok,
      verifyChecks: verify.checks,
      message: verify.ok
        ? `Fixed ${written.length} file(s) and verification passed.`
        : `Fixed ${written.length} file(s); some verification checks still fail — review the zip.`,
    };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { fixZip, listCodeFiles, verifyProject, isCode };
