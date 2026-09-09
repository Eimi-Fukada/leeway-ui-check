// Keep stdin open as a parent-liveness pipe. EOF means the owning worker exited.
import { spawn } from 'node:child_process';
const [executable, ...args] = process.argv.slice(2);
const child = spawn(executable, args, {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
  detached: process.platform !== 'win32',
  shell: false,
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child.pid) {
    process.exit(1);
    return;
  }
  if (process.platform === 'win32') {
    const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    kill.on('close', () => process.exit(0));
    kill.on('error', () => {
      child.kill();
      process.exit(1);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    process.exit(0);
  }
}
process.stdin.resume();
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('close', (code) => {
  if (!stopping) process.exit(code ?? 1);
});
