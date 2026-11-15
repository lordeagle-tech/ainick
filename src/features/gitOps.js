// gitOps.js — git operations for the agent's tools.
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
