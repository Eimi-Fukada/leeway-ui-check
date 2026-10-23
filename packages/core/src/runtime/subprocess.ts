import { spawn, type ChildProcess } from 'node:child_process';
/**
 * 回收 Harness 子进程及其进程树，避免取消或超时后计算进程残留。
 */
export async function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32')
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
        resolve();
      }, 1000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
/**
 * 不经过 shell 启动 Harness 子进程，限制继承环境与日志长度，返回等待、日志和终止句柄。
 * 目前用于 SSIM 计算，不负责启动用户项目。
 */
export function launch(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
) {
  signal.throwIfAborted();
  const child = spawn(executable, args, {
    cwd,
    env: { ...minimalEnv(), ...env },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '',
    stderr = '';
  child.stdout?.on('data', (d) => {
    stdout = (stdout + d).slice(-1_000_000);
  });
  child.stderr?.on('data', (d) => {
    stderr = (stderr + d).slice(-1_000_000);
  });
  const stop = () => {
    void killTree(child);
  };
  signal.addEventListener('abort', stop, { once: true });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        signal.removeEventListener('abort', stop);
        resolve({ code, stdout, stderr });
      });
    },
  );
  // A service can fail before its caller awaits done.
  void done.catch(() => {});
  return { child, done, logs: () => ({ stdout, stderr }), stop: () => killTree(child) };
}
/**
 * 仅继承子进程正常运行所需的系统环境变量，避免默认传入任意业务凭证。
 */
function minimalEnv() {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
    'PROGRAMFILES',
    'NODE_EXTRA_CA_CERTS',
  ];
  return Object.fromEntries(
    allowed.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
}
/**
 * 启动一次计算命令，通过 stdin 传入请求并等待完成；取消或非零退出转成异常。
 */
export async function runCommand(
  command: { executable: string; args: string[] },
  cwd: string,
  signal: AbortSignal,
  input?: string,
  env?: NodeJS.ProcessEnv,
) {
  const run = launch(command.executable, command.args, cwd, signal, env);
  run.child.stdin?.end(input);
  const result = await run.done;
  signal.throwIfAborted();
  if (result.code !== 0)
    throw Error(`process_failed (${result.code}): ${result.stderr.slice(-4000)}`);
  return result;
}
