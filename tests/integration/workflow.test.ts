import { it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { UiWorkflow, AgentStatus } from '../../packages/core/src/workflow/facade.js';
import { handleHook } from '../../packages/codex/src/hooks.js';
import { makeFixture, fixtureHtml } from '../../scripts/fixtures.js';
async function command(args: string[], root: string, input?: unknown) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HARNESS_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(Error(err))));
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
it('uses identical CLI/MCP facade feedback and continues a failed UI, then releases configuration review and user interruption', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-loop-'));
  const config = await makeFixture(root);
  const service = new TaskService(path.join(root, 'store')),
    workflow = new UiWorkflow(service);
  try {
    const input = {
      reference_image_path: config.reference_path,
      source_dir: path.join(root, 'target'),
      viewport_width: 960,
      viewport_height: 640,
      serve:
        config.target.mode === 'workspace' ? config.target.serve : { executable: 'node', args: [] },
    };
    const created = AgentStatus.parse(await workflow.call('ui_check_start', input));
    const event = {
      session_id: 'chat-one',
      cwd: root,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__leeway-ui-check__ui_check_start',
      tool_response: { structuredContent: created },
    };
    await handleHook(event, service.root);
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('shift'));
    const pending = AgentStatus.parse(
      await workflow.call('ui_check_submit', {
        run_id: created.run_id,
        request_id: 'one',
        wait_ms: 0,
      }),
    );
    expect(pending.task_status).toBe('evaluating');
    await service.runNext();
    const failed = AgentStatus.parse(
      await workflow.call('ui_check_status', { run_id: created.run_id }),
    );
    expect(failed.evaluation_status).toBe('completed');
    expect(failed.task_status).toBe('needs_revision');
    expect(failed.task_terminal).toBe(false);
    expect(failed.visual_feedback?.regions.length).toBeGreaterThan(0);
    const cli = JSON.parse(
      await command(
        ['node_modules/tsx/dist/cli.mjs', 'packages/cli/src/index.ts', 'ui_check_status', '-'],
        service.root,
        { run_id: created.run_id },
      ),
    );
    expect(cli.task_status).toBe(failed.task_status);
    expect(cli.next_action).toBe(failed.next_action);
    expect(cli.visual_feedback).toEqual(failed.visual_feedback);
    const stop = { ...event, hook_event_name: 'Stop' };
    expect(await handleHook(stop, service.root)).toHaveProperty('decision', 'block');
    expect(await handleHook({ ...stop, session_id: 'another-chat' }, service.root)).toEqual({});
    expect(await handleHook({ ...stop, cwd: path.join(root, 'different') }, service.root)).toEqual(
      {},
    );
    // Run the real command-hook process, not only the helper.
    expect(
      JSON.parse(await command(['scripts/codex-hook.mjs', service.root], service.root, stop)),
    ).toHaveProperty('decision', 'block');
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('exact'));
    const done = JSON.parse(
      await command(
        ['node_modules/tsx/dist/cli.mjs', 'packages/cli/src/index.ts', 'ui_check_submit', '-'],
        service.root,
        { run_id: created.run_id, request_id: 'two', wait_ms: 0 },
      ),
    );
    expect(done.evaluation_status).toBe('completed');
    expect(done.task_status).toBe('blocked'); // provisional profile must not become a false pass
    expect(done.next_action).toBe('review_configuration');
    expect(await handleHook(stop, service.root)).toEqual({});
    await expect(workflow.call('ui_check_finalize', { run_id: created.run_id })).rejects.toThrow(
      'candidate_not_deliverable',
    );
    await handleHook({ ...stop, hook_event_name: 'Interrupt' }, service.root);
    // Interrupt remains effective even after additional tool results.
    await handleHook(event, service.root);
    service.store.run("UPDATE tasks SET state='active' WHERE id=?", created.run_id);
    expect(await handleHook(stop, service.root)).toEqual({});
  } finally {
    service.close();
  }
});
