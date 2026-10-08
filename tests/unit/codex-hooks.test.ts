import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { continuation, handleHook, type Binding } from '../../packages/codex/src/hooks.js';
import { installCodexWorkflow } from '../../packages/codex/src/install.js';
type Status = Parameters<typeof continuation>[0];
const binding: Binding = {
  run_id: 'task_one',
  cwd: process.cwd(),
  continuations: 0,
  bound_at: 1000,
  interrupted: false,
};
const status = (task_status: Status['task_status'], overrides: Partial<Status> = {}): Status =>
  ({
    run_id: 'task_one',
    task_status,
    task_terminal: false,
    next_action: 'revise_and_evaluate',
    request_id: 'round_one',
    budget_remaining: { iterations: 2, wall_seconds: 30 },
    ...overrides,
  }) as Status;
it.each(['created', 'evaluating', 'needs_revision', 'ready_to_finalize'] as const)(
  'continues unfinished %s without requiring a user prompt',
  (state) => {
    expect(continuation(status(state), binding, 2000)).toHaveProperty('decision', 'block');
  },
);
it('lets final evaluation polling/finalization finish on the last attempt but prohibits more repair submissions', () => {
  const budget_remaining = { iterations: 0, wall_seconds: 30 };
  expect(continuation(status('evaluating', { budget_remaining }), binding, 2000)).toHaveProperty(
    'decision',
    'block',
  );
  expect(
    continuation(status('ready_to_finalize', { budget_remaining }), binding, 2000),
  ).toHaveProperty('decision', 'block');
  expect(continuation(status('needs_revision', { budget_remaining }), binding, 2000)).toEqual({});
});
it('releases blocked/terminal/cancelling tasks and enforces interruption, time and continuation caps', () => {
  for (const state of [
    'blocked',
    'passed',
    'cancelled',
    'stalled',
    'budget_exhausted',
    'failed',
  ] as const)
    expect(continuation(status(state), binding, 2000)).toEqual({});
  expect(
    continuation(status('evaluating', { next_action: 'wait_for_cancellation' }), binding, 2000),
  ).toEqual({});
  expect(continuation(status('needs_revision'), { ...binding, interrupted: true }, 2000)).toEqual(
    {},
  );
  expect(continuation(status('needs_revision'), { ...binding, continuations: 12 }, 2000)).toEqual(
    {},
  );
  expect(continuation(status('needs_revision'), binding, 1_201_000)).toEqual({});
  expect(
    continuation(
      status('needs_revision', { budget_remaining: { iterations: 2, wall_seconds: 0 } }),
      binding,
      2000,
    ),
  ).toEqual({});
});
it('does not intercept an unbound chat or a foreign MCP server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-hook-unbound-'));
  const event = { hook_event_name: 'Stop', session_id: '../chat', cwd: process.cwd() };
  expect(await handleHook(event, root)).toEqual({});
  expect(
    await handleHook(
      { ...event, hook_event_name: 'PostToolUse', tool_name: 'mcp__foreign__ui_check_start' },
      root,
    ),
  ).toEqual({});
});
it('installs project-local hooks idempotently, preserves unrelated hooks, and wires the Harness runtime/home', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-hook-setup-'));
  await mkdir(path.join(root, '.codex'));
  await writeFile(
    path.join(root, '.codex/hooks.json'),
    JSON.stringify({
      description: 'keep',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-check' }] }] },
    }),
  );
  const first = await installCodexWorkflow(root, path.join(root, 'store'));
  await installCodexWorkflow(root, path.join(root, 'store'));
  const config = JSON.parse(await readFile(first.hooks, 'utf8'));
  expect(config.description).toBe('keep');
  expect(config.hooks.Stop).toHaveLength(2);
  expect(config.hooks.Stop[0].hooks[0].command).toBe('existing-check');
  expect(config.hooks.PostToolUse).toHaveLength(1);
  expect(config.hooks.Interrupt[0].hooks[0].timeout).toBe(3);
  expect(config.hooks.Stop[1].hooks[0].command).toContain('codex-hook.mjs');
  expect(config.hooks.Stop[1].hooks[0].commandWindows).toContain('powershell.exe');
  expect(config.hooks.Stop[1].hooks[0].command).toContain(first.harness_home);
  expect(await readFile(first.skill, 'utf8')).toContain('needs_revision');
});
it.skipIf(process.platform !== 'win32')(
  'executes the generated Windows hook from a project without Harness dependencies',
  async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'leeway-hook-command-'));
    const installed = await installCodexWorkflow(project, path.join(project, "store with ' quote"));
    const config = JSON.parse(await readFile(installed.hooks, 'utf8'));
    const encoded = config.hooks.Stop[0].hooks[0].commandWindows.split(' ').at(-1);
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        {
          cwd: project,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let out = '',
        err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 && !err ? resolve(out) : reject(Error(err))));
      child.stdin.end(
        JSON.stringify({ hook_event_name: 'Stop', session_id: 'unbound', cwd: project }),
      );
    });
    expect(JSON.parse(result)).toEqual({});
  },
);
