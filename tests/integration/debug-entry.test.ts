import { it, expect } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('initializes MCP on a separate debug port when 9229 is occupied', async () => {
  const occupied = createServer();
  let ownsPort = true;
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        ownsPort = false;
        resolve();
      } else reject(error);
    });
    occupied.listen(9229, '127.0.0.1', resolve);
  });
  const client = new Client({ name: 'debug-port-regression', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['scripts/debug-mcp.mjs'],
    env: {
      ...process.env,
      HARNESS_HOME: await mkdtemp(path.join(os.tmpdir(), 'leeway-debug-')),
    } as Record<string, string>,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (data) => (stderr += data));
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(5);
    const endpoint = stderr.match(/Leeway debugger ready: pid=\d+, endpoint=(ws:\/\/[^\s]+)/)?.[1];
    expect(endpoint).toBeTruthy();
    const port = new URL(endpoint!).port;
    expect(port).not.toBe('9229');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    expect(targets).toHaveLength(1);
    expect(targets[0].webSocketDebuggerUrl).toBe(endpoint);
  } finally {
    await client.close();
    if (ownsPort) await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
