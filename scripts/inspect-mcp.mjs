import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = path.join(root, '.harness/inspector-tools');
const runtime = path.join(
  tools,
  'node_modules/node/bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const inspectorRoot = path.join(tools, 'node_modules/@modelcontextprotocol/inspector');
const debugHome = path.join(root, '.harness/inspector-data');
const configPath = path.join(root, '.harness/inspector.json');

/** 子进程使用参数数组启动，避免项目路径中的空格被 shell 拆开。 */
async function run(executable, args, env = process.env) {
  const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/** 先检查调试端口，避免 Inspector 误连到 Codex 或其他调试会话的 MCP 进程。 */
async function checkDebugPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(Error('9229 调试端口已占用。请先结束另一个调试进程。')));
    server.listen(9229, '127.0.0.1', () => server.close(resolve));
  });
}

try {
  let installed = false;
  try {
    const info = JSON.parse(await readFile(path.join(inspectorRoot, 'package.json'), 'utf8'));
    const node = JSON.parse(
      await readFile(path.join(tools, 'node_modules/node/package.json'), 'utf8'),
    );
    await access(runtime);
    installed = info.version === '2.12.0' && node.version === '22.21.1';
  } catch {
    /* 首次使用时安装独立调试工具，不改项目或全局 Node。 */
  }
  if (!installed) {
    if (!process.env.npm_execpath) throw Error('请通过 npm run inspect:mcp 启动。');
    console.error('首次使用：下载 Inspector 2.12.0 和专用 Node 22.21.1…');
    const code = await run(process.execPath, [
      process.env.npm_execpath,
      'install',
      '--prefix',
      tools,
      '--no-save',
      '--package-lock=false',
      'node@22.21.1',
      '@modelcontextprotocol/inspector@2.12.0',
    ]);
    if (code) throw Error('Inspector 安装失败，请检查网络后重试。');
  }
  await checkDebugPort();
  await mkdir(debugHome, { recursive: true });
  // MCP 使用项目当前 Node，以匹配 better-sqlite3 等已安装的原生依赖。
  const config = {
    mcpServers: {
      'leeway-debug': {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(root, 'scripts/debug-mcp.mjs')],
        cwd: root,
        env: { HARNESS_HOME: debugHome },
        connectionTimeout: 120000,
        requestTimeout: 600000,
      },
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  console.error(
    `调试数据：${debugHome}\n在 Inspector 中连接 leeway-debug，再在编辑器 F5 选择 Attach Leeway MCP。`,
  );
  const info = JSON.parse(await readFile(path.join(inspectorRoot, 'package.json'), 'utf8'));
  const bin = path.join(inspectorRoot, info.bin['mcp-inspector']);
  process.exitCode = await run(runtime, [bin, ...process.argv.slice(2), '--config', configPath], {
    ...process.env,
    MCP_AUTO_OPEN_ENABLED: 'false',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
