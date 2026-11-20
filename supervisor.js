// Pterodactyl-friendly supervisor: restart owner requests cleanly and retry crashes with exponential backoff.
(() => {
  const noisy = /^(Closing session:|Removing old closed session:|Closing open session in favor of incoming prekey bundle$|Decrypted message with closed session\.|Failed to decrypt message with any known session|Session error:)/;
  for (const method of ['info', 'log', 'warn', 'error']) {
    const original = console[method];
    if (typeof original !== 'function') continue;
    console[method] = (...args) => {
      try {
        const first = args[0];
        if (typeof first === 'string' && noisy.test(first)) return;
      } catch {}
      return original.apply(console, args);
    };
  }
})();

const { spawn } = require('child_process');
let failures = 0;
let child;
let stopping = false;
function start(delayOverride = null) {
  const delay = delayOverride ?? Math.min(30000, failures * 3000);
  setTimeout(() => {
    if (stopping) return;
    child = spawn(process.execPath, ['src/index.js'], {
      stdio: 'inherit',
      env: { ...process.env, NICK_AI_SUPERVISED: '1' },
    });
    child.on('exit', (code, signal) => {
      if (stopping) return;
      if (code === 0 && !signal) {
        failures = 0;
        start(2000);
        return;
      }
      failures += 1;
      console.error(`[Nick AI supervisor] child exited code=${code} signal=${signal || '-'}; restarting in ${Math.min(30, failures * 3)}s`);
      start();
    });
    child.on('error', (err) => console.error('[Nick AI supervisor] spawn error:', err.message));
  }, delay);
}
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => { stopping = true; if (child) child.kill(sig); process.exit(0); });
start();
