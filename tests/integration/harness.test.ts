import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { TaskInput, type TaskConfig } from '../../packages/contracts/src/index.js';
import { makeFixture, fixtureHtml, type Variant } from '../../scripts/fixtures.js';
import { CommandAgentAdapter, runController } from '../../packages/core/src/controller/loop.js';
import { createMcpServer } from '../../packages/mcp/src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('real Chromium + SQLite + Python pipeline', () => {
  let root: string, config: TaskConfig, service: TaskService;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'leeway-test-'));
    config = await makeFixture(root);
    service = new TaskService(path.join(root, 'store'));
  });
  afterAll(() => service.close());
  async function evaluate(variant: Variant, override: Partial<TaskConfig> = {}) {
    const c = TaskInput.parse({ ...config, ...override });
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml(variant));
    if (variant === 'screenshot')
      await copyFile(config.reference_path, path.join(root, 'target/reference.png'));
    const task = await service.createTask(c),
      candidate = await service.registerCandidate(task.task_id),
      queued = service.evaluateCandidate(candidate.candidate_id, 'request');
    expect(queued.evaluation_id).toBeTruthy();
    await service.runNext();
    return { task, candidate, evaluation: service.getEvaluation(queued.evaluation_id!) };
  }
  it('captures exact pixels twice and never formally passes a provisional profile', async () => {
    const { task, candidate, evaluation } = await evaluate('exact');
    expect(evaluation.state).toBe('completed');
    expect(evaluation.report?.score?.value).toBe(100);
    expect(evaluation.report?.metrics?.ssim).toBe(1);
    expect(evaluation.report?.blockers).toEqual(['profile_not_validated']);
    await expect(service.finalizeTask(task.task_id, candidate.candidate_id)).rejects.toThrow(
      'candidate_not_deliverable',
    );
    const replay = service.evaluateCandidate(candidate.candidate_id, 'request');
    expect(replay.evaluation_id).toBe(evaluation.evaluation_id);
    expect(service.task(task.task_id).iterations).toBe(1);
  });
  it('rejects a workspace change made after submission', async () => {
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('shift'));
    const task = await service.createTask(config),
      candidate = await service.registerCandidate(task.task_id);
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('exact'));
    const queued = service.evaluateCandidate(candidate.candidate_id, 'shift');
    await service.runNext();
    const report = service.getEvaluation(queued.evaluation_id!).report!;
    expect(report.score).toBeNull();
    expect(report.blockers).toContain('workspace_changed_during_evaluation');
  });
  it.each([
    'blank',
    'missing',
    'text',
    'overflow',
    'broken_image',
    'font_missing',
    'unusable',
    'screenshot',
  ] as Variant[])('blocks severe variant %s', async (variant) => {
    const { evaluation } = await evaluate(variant);
    expect(evaluation.report?.verdict).not.toBe('pass');
    expect(evaluation.report?.blockers.some((b) => b !== 'profile_not_validated')).toBe(true);
  });
  it('does not invent a score for ambiguous selectors', async () => {
    const { evaluation } = await evaluate('duplicate');
    expect(evaluation.report?.verdict).toBe('review_required');
    expect(evaluation.report?.score).toBeNull();
    expect(evaluation.report?.blockers).toContain('ambiguous_match:title');
  });
  it('fails an unstable JS animation without assigning zero', async () => {
    const { evaluation } = await evaluate('animation', { capture_timeout_ms: 600 });
    expect(evaluation.state).toBe('failed');
    expect(evaluation.report?.score).toBeNull();
  });
  it('is idempotent and serializes concurrent connections', async () => {
    const task = await service.createTask(config),
      candidate = await service.registerCandidate(task.task_id),
      second = new TaskService(service.root);
    try {
      const a = service.evaluateCandidate(candidate.candidate_id, 'same'),
        b = second.evaluateCandidate(candidate.candidate_id, 'same');
      expect(a).toEqual(b);
      expect(() => second.evaluateCandidate(candidate.candidate_id, 'different')).toThrow(
        'evaluation_conflict',
      );
      service.cancelTask(task.task_id);
      expect(service.getEvaluation(a.evaluation_id!).state).toBe('cancelled');
      expect(service.task(task.task_id).state).toBe('cancelled');
    } finally {
      second.close();
    }
  });
  it('recovers queued work after a client reconnect and honors iteration exhaustion', async () => {
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('exact'));
    const task = await service.createTask({
        ...config,
        budget: { max_iterations: 1, max_wall_seconds: 60 },
      }),
      candidate = await service.registerCandidate(task.task_id),
      queued = service.evaluateCandidate(candidate.candidate_id, 'recover');
    const worker = new TaskService(service.root);
    try {
      await worker.runNext();
      expect(worker.getEvaluation(queued.evaluation_id!).state).toBe('completed');
    } finally {
      worker.close();
    }
    expect(service.task(task.task_id).state).toBe('budget_exhausted');
    expect(service.getEvaluation(queued.evaluation_id!).report?.verdict).not.toBe('pass');
  });
  it('cancels in flight and only settles after the workspace evaluation is cleaned up', async () => {
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('animation'));
    const task = await service.createTask(config),
      candidate = await service.registerCandidate(task.task_id),
      queued = service.evaluateCandidate(candidate.candidate_id, 'cancel');
    const running = service.runNext();
    await new Promise((resolve) => setTimeout(resolve, 300));
    service.cancelTask(task.task_id);
    await running;
    expect(service.task(task.task_id).state).toBe('cancelled');
    expect(service.getEvaluation(queued.evaluation_id!).state).toBe('cancelled');
  });
  it('rejects profile tampering and changed workspace provenance', async () => {
    await expect(
      service.createTask({
        ...config,
        profile: { ...config.profile, pixel: { ...config.profile.pixel, threshold: 0.9 } },
      }),
    ).rejects.toThrow('profile_id_immutable');
    const task = await service.createTask(config),
      candidate = await service.registerCandidate(task.task_id);
    await writeFile(path.join(root, 'target/index.html'), 'tampered');
    const queued = service.evaluateCandidate(candidate.candidate_id, 'tamper');
    await service.runNext();
    expect(service.getEvaluation(queued.evaluation_id!).error).toContain(
      'workspace_changed_during_evaluation',
    );
  });
  it('exposes structured MCP responses, excludes owner creation and guards artifact paths', async () => {
    const server = createMcpServer(service),
      client = new Client({ name: 'contract-test', version: '1.0' }),
      [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).not.toContain('create_task');
      const { task, evaluation } = await evaluate('exact');
      const result = await client.callTool({
        name: 'ui_check_status',
        arguments: { run_id: task.task_id },
      });
      expect((result.structuredContent as any).score.value).toBe(100);
      const artifact = await client.readResource({
        uri: `harness://artifacts/${evaluation.report!.artifacts.diff}`,
      });
      expect(artifact.contents[0].mimeType).toBe('image/png');
      expect(() => service.getArtifact('../../secrets')).toThrow('artifact_not_found');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('runs two actual command-adapter source revisions, captures both, and stops on budget', async () => {
    const script = path.join(root, 'fixture-agent.mjs');
    await writeFile(
      script,
      `import {readFile,writeFile} from 'node:fs/promises';let input='';for await(const c of process.stdin)input+=c;const {attempt}=JSON.parse(input);let html=await readFile('index.html','utf8');html=html.replace(/translateY\\(\\d+px\\)/,'translateY('+(attempt===1?8:0)+'px)');await writeFile('index.html',html);console.log('revised '+attempt);`,
    );
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('shift'));
    const task = await service.createTask({
      ...config,
      budget: { max_iterations: 2, max_wall_seconds: 90 },
    });
    await runController(
      service,
      task.task_id,
      new CommandAgentAdapter({
        command: { executable: process.execPath, args: [script] },
        attempt_timeout_seconds: 10,
      }),
    );
    const status = service.getTaskStatus(task.task_id);
    expect(status.state).toBe('budget_exhausted');
    expect(status.evaluations).toHaveLength(2);
    expect(status.evaluations[1].report!.score!.value).toBe(100);
    expect(status.evaluations[0].report!.source_manifest_hash).not.toBe(
      status.evaluations[1].report!.source_manifest_hash,
    );
  });
  it('requires owner evidence, finalizes the exact build, and preserves subsequent user edits', async () => {
    const calibration = await service.artifact(
        JSON.stringify({ purpose: 'state-machine-test-only', split: 'calibration' }),
        'json',
      ),
      heldout = await service.artifact(
        JSON.stringify({ purpose: 'state-machine-test-only', split: 'heldout' }),
        'json',
      );
    const profile = {
      ...config.profile,
      profile_id: 'test-only-validated-v1',
      status: 'validated' as const,
      validation: {
        calibration_sha256: calibration.sha256,
        heldout_sha256: heldout.sha256,
        approved_by: 'automated-contract-test-not-product-calibration',
      },
    };
    const { task, candidate, evaluation } = await evaluate('exact', { profile });
    expect(evaluation.report?.verdict).toBe('pass');
    expect(evaluation.report?.build_manifest_hash).toBeTruthy();
    const final = await service.finalizeTask(task.task_id, candidate.candidate_id);
    expect(final.state).toBe('passed');
    await writeFile(path.join(root, 'target/index.html'), 'user edits after passing capture');
    expect(await readFile(path.join(root, 'target/index.html'), 'utf8')).toBe(
      'user edits after passing capture',
    );
    expect(service.task(task.task_id).best_candidate).toBe(candidate.candidate_id);
    const other = await evaluate('exact', { profile });
    await writeFile(path.join(root, 'target/injected-build.js'), 'different delivered build');
    await expect(
      service.finalizeTask(other.task.task_id, other.candidate.candidate_id),
    ).rejects.toThrow('build_artifact_hash_mismatch');
  });
  it('reclaims an expired worker lease and increments fencing without double counting', async () => {
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('exact'));
    const task = await service.createTask(config),
      candidate = await service.registerCandidate(task.task_id),
      queued = service.evaluateCandidate(candidate.candidate_id, 'lease');
    service.store.run(
      "UPDATE jobs SET state='running',lease_until=0,fence_token=1,attempt=1 WHERE evaluation_id=?",
      queued.evaluation_id,
    );
    service.store.run("UPDATE evaluations SET state='comparing' WHERE id=?", queued.evaluation_id);
    await service.runNext();
    expect(service.getEvaluation(queued.evaluation_id!).state).toBe('completed');
    expect(service.task(task.task_id).iterations).toBe(1);
    expect(
      service.store.get('SELECT fence_token FROM jobs WHERE evaluation_id=?', queued.evaluation_id)!
        .fence_token,
    ).toBe(2);
  });
  it('returns auth_required, build_failed and exhausted wall time with null scores', async () => {
    const workspace = config.target as Extract<TaskConfig['target'], { mode: 'workspace' }>;
    const auth = await evaluate('exact', { target: { ...workspace, url_path: '/private' } });
    expect(auth.evaluation.error).toContain('auth_required');
    expect(auth.evaluation.report?.score).toBeNull();
    const build = await evaluate('exact', {
      target: {
        ...workspace,
        build: [{ executable: process.execPath, args: ['-e', 'process.exit(2)'] }],
      },
    });
    expect(build.evaluation.error).toContain('build_failed');
    expect(build.evaluation.report?.score).toBeNull();
    const wall = await evaluate('animation', {
      budget: { max_iterations: 8, max_wall_seconds: 1 },
    });
    expect(service.task(wall.task.task_id).state).toBe('budget_exhausted');
    expect(wall.evaluation.report?.score).toBeNull();
  });
  it('enforces viewport, component and crop coordinate contracts', async () => {
    await expect(
      service.createTask({
        ...config,
        reference: { ...config.reference, viewport_css: { width: 390, height: 844 } },
      }),
    ).rejects.toThrow('reference_dimension_mismatch');
    const cropped = await evaluate('exact', {
      reference: { ...config.reference, crop: { x: 16, y: 16, width: 928, height: 608 } },
      regions: config.regions.map((r) => ({
        ...r,
        bbox: { ...r.bbox, x: r.bbox.x - 16, y: r.bbox.y - 16 },
      })),
    });
    expect(cropped.evaluation.report?.score?.value).toBe(100);
    const sharp = (await import('sharp')).default,
      ref = path.join(root, 'component.png');
    await sharp(config.reference_path)
      .extract({ left: 32, top: 32, width: 500, height: 42 })
      .png()
      .toFile(ref);
    const component = await evaluate('exact', {
      reference_path: ref,
      reference: { ...config.reference, capture_mode: 'component', component_selector: 'h1' },
      regions: [{ ...config.regions[0], bbox: { x: 0, y: 0, width: 500, height: 42 } }],
    });
    expect(component.evaluation.report?.score?.value).toBe(100);
  });
});
