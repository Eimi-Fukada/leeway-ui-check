import { afterAll } from 'vitest';
import { closeFixtures } from '../../scripts/fixtures.js';
afterAll(closeFixtures);
import { it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { makeFixture } from '../../scripts/fixtures.js';
import { createMcpServer } from '../../packages/mcp/src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
it('serializes URL submissions, replays requests, waits without consuming jobs, and resumes after worker completes', async () => {
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
    expect(pending.task_status).toBe('evaluating');
    expect(pending.score).toBeNull();
    expect(service.getEvaluation(a.evaluation_id!).state).toBe('queued');
    await expect(worker.submitCandidate(task.task_id, 'two')).rejects.toThrow(
      'evaluation_conflict',
    );
    const waiting = service.submitAndWait(task.task_id, 'one', 15000);
    await worker.runNext();
    const done = await waiting;
    expect(done.evaluation_status).toBe('completed');
    expect(done.score?.value).toBe(100);
    expect(done.next_action).toBe('review_configuration');
    expect(done.artifacts.actual).toMatch(/^harness:\/\/artifacts\//);
    expect((await worker.submitCandidate(task.task_id, 'one')).evaluation_id).toBe(a.evaluation_id);
  } finally {
    worker.close();
    service.close();
  }
});
it('exposes exactly five tools with output schemas and workflow instructions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-tools-'));
  const service = new TaskService(root),
    server = createMcpServer(service),
    client = new Client({ name: 'test', version: '1' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'ui_check_start',
        'ui_check_submit',
        'ui_check_status',
        'ui_check_cancel',
        'ui_check_finalize',
      ].sort(),
    );
    expect(tools.every((t) => t.outputSchema?.properties?.task_status)).toBe(true);
    expect(client.getInstructions()).toContain('without asking the user to continue');
    await expect(client.callTool({ name: 'create_task', arguments: {} })).rejects.toThrow(
      'not found',
    );
  } finally {
    await client.close();
    await server.close();
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
        target_url: config.target.url,
        viewport_width: 960,
        viewport_height: 640,
        ready_selector: '[data-page-ready]',
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
it('evaluates an externally owned URL without reading or copying source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-workspace-')),
    config = await makeFixture(root);
  const service = new TaskService(path.join(root, 'store')),
    worker = new TaskService(service.root);
  try {
    const task = await service.createTask(config),
      queued = await service.submitCandidate(task.task_id, 'workspace_001');
    expect(queued.evaluation_id).toBeTruthy();
    expect(service.candidate(queued.candidate_id).target_url).toBe(config.target.url);
    await worker.runNext();
    const result = service.getEvaluation(queued.evaluation_id!);
    expect(result.state).toBe('completed');
    expect(result.report?.score).toBeTruthy();
  } finally {
    worker.close();
    service.close();
  }
});
