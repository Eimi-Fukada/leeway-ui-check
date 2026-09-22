import { it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { makeFixture } from '../../scripts/fixtures.js';
import { createMcpServer } from '../../packages/mcp/src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
it('serializes snapshots across connections, replays submissions, waits without consuming jobs, and resumes after worker completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-facade-'));
  const config = await makeFixture(root);
  const service = new TaskService(path.join(root, 'store')),
    worker = new TaskService(service.root);
  try {
    const task = await service.createTask(config);
    const [a, b] = await Promise.all([
      service.submitCandidate(task.task_id, 'one'),
      worker.submitCandidate(task.task_id, 'one'),
    ]);
    expect(a.evaluation_id).toBe(b.evaluation_id);
    expect(a.candidate_id).toBe(b.candidate_id);
    expect(
      service.store.get('SELECT COUNT(*) AS n FROM candidates WHERE task_id=?', task.task_id)!.n,
    ).toBe(1);
    const start = Date.now();
    const pending = await service.submitAndWait(task.task_id, 'one', 200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
    expect(pending.status).toBe('running');
    expect(pending.score).toBeNull();
    expect(service.getEvaluation(a.evaluation_id!).state).toBe('queued');
    await expect(worker.submitCandidate(task.task_id, 'two')).rejects.toThrow(
      'evaluation_conflict',
    );
    const waiting = service.submitAndWait(task.task_id, 'one', 15000);
    await worker.runNext();
    const done = await waiting;
    expect(done.status).toBe('completed');
    expect(done.score?.value).toBe(100);
    expect(done.next_action).toBe('review_configuration');
    expect(done.artifacts.actual).toMatch(/^harness:\/\/artifacts\//);
    expect((await worker.submitCandidate(task.task_id, 'one')).evaluation_id).toBe(a.evaluation_id);
  } finally {
    worker.close();
    service.close();
  }
});
it('exposes exactly five agent tools and ten owner tools, with no submit_and_wait alias', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-tools-'));
  const service = new TaskService(root);
  try {
    for (const owner of [false, true]) {
      const server = createMcpServer(service, owner),
        client = new Client({ name: 'test', version: '1' }),
        [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).not.toContain('ui_check_submit_and_wait');
        if (!owner)
          expect(names.sort()).toEqual(
            [
              'ui_check_start',
              'ui_check_submit',
              'ui_check_status',
              'ui_check_cancel',
              'ui_check_finalize',
            ].sort(),
          );
        else {
          expect(names).toHaveLength(10);
          expect(names).toContain('create_task');
          expect(names).not.toContain('ui_check_submit');
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    service.close();
  }
});
it('creates a run from a reference image and project inputs through ui_check_start', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-start-')),
    config = await makeFixture(root),
    service = new TaskService(path.join(root, 'store')),
    server = createMcpServer(service),
    client = new Client({ name: 'start-test', version: '1' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({
      name: 'ui_check_start',
      arguments: {
        reference_image_path: config.reference_path,
        source_dir: config.target.mode === 'managed' ? config.target.source_dir : '',
        viewport_width: 960,
        viewport_height: 640,
        ready_selector: '[data-page-ready]',
        serve:
          config.target.mode === 'managed' ? config.target.serve : { executable: 'node', args: [] },
      },
    });
    expect((result.structuredContent as any).run_id).toMatch(/^task_/);
    expect((result.structuredContent as any).requirements.reference_path).toBe(
      config.reference_path,
    );
  } finally {
    await client.close();
    await server.close();
    service.close();
  }
});
