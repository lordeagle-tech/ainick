// Lightweight Pterodactyl-friendly supervisor. It restarts the bot after crashes with
// exponential backoff instead of letting a transient exception take the container offline.
const { spawn } = require('child_process');
let failures = 0;
let child;
let stopping = false;
function start() {
  const delay = Math.min(30000, failures * 3000);
  setTimeout(() => {
    if (stopping) return;
    child = spawn(process.execPath, ['src/index.js'], { stdio: 'inherit', env: process.env });
    child.on('exit', (code, signal) => {
      if (stopping) return;
      failures = code === 0 ? 0 : failures + 1;
      console.error(`[BROKEN supervisor] child exited code=${code} signal=${signal || '-'}; restarting in ${Math.min(30, Math.max(3, failures * 3))}s`);
      start();
    });
    child.on('error', (err) => console.error('[BROKEN supervisor] spawn error:', err.message));
  }, delay);
}
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => { stopping = true; if (child) child.kill(sig); process.exit(0); });
start();
