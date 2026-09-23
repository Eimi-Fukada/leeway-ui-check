import { it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { makeFixture, fixtureHtml } from '../../scripts/fixtures.js';
import { createMcpServer } from '../../packages/mcp/src/server.js';
import { Report } from '../../packages/contracts/src/index.js';
import { collectDOM } from '../../packages/core/src/regions/dom-evidence.js';
import { chromium } from 'playwright';
it('returns unannotated visual evidence, crop PNG resources and previous-round resolution without changing scores', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-feedback-')),
    config = await makeFixture(root),
    service = new TaskService(path.join(root, 'store'));
  const server = createMcpServer(service),
    client = new Client({ name: 'feedback', version: '1' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    config.regions = [];
    config.profile = {
      ...config.profile,
      profile_id: 'feedback-diagnostic',
      mode: 'pixel_diagnostic',
      weights: { pixel: 0.65, structure: 0.35, layout: 0, text: 0 },
    };
    const task = await service.createTask(config);
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('shift'));
    const queued = await service.submitCandidate(task.task_id, 'one');
    await service.runNext();
    const report = service.getEvaluation(queued.evaluation_id!).report!;
    expect(report.status).toBe('completed');
    expect(report.schema_version).toBe('1.1');
    expect(report.components?.layout).toBeNull();
    const feedback = report.visual_feedback!;
    expect(feedback.regions_total).toBeGreaterThan(0);
    expect(feedback.regions.reduce((n, r) => n + r.mismatched_pixels, 0)).toBe(
      report.metrics!.mismatched_pixels,
    );
    expect(feedback.regions.some((r) => r.dom_candidates.length)).toBe(true);
    const response = await client.callTool({
      name: 'ui_check_status',
      arguments: { run_id: task.task_id },
    });
    const result = response.structuredContent as any;
    expect(result.visual_feedback.regions.length).toBeLessThanOrEqual(5);
    const crop = result.visual_feedback.regions[0];
    const resource = await client.readResource({ uri: crop.crops.actual });
    const content = resource.contents[0];
    expect('blob' in content).toBe(true);
    const meta = await sharp(Buffer.from((content as { blob: string }).blob, 'base64')).metadata();
    expect(meta.width).toBe(crop.crop_bbox_px.width);
    expect(meta.height).toBe(crop.crop_bbox_px.height);
    const full = await client.readResource({ uri: result.full_report });
    expect(JSON.parse((full.contents[0] as { text: string }).text).report.schema_version).toBe(
      '1.1',
    );
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml('exact'));
    const q2 = await service.submitCandidate(task.task_id, 'two');
    await service.runNext();
    const exact = service.getEvaluation(q2.evaluation_id!).report!;
    expect(exact.score?.value).toBe(100);
    expect(exact.visual_feedback?.regions).toEqual([]);
    expect(exact.visual_feedback?.comparison?.trend).toBe('improved');
    expect(
      exact.visual_feedback?.comparison?.region_changes.every((r) => r.kind === 'resolved'),
    ).toBe(true);
    const { visual_feedback, ...legacy } = exact;
    expect(Report.parse({ ...legacy, schema_version: '1.0' }).visual_feedback).toBeUndefined();
    expect(() => Report.parse({ ...legacy, schema_version: '1.1' })).toThrow();
  } finally {
    await client.close();
    await server.close();
    service.close();
  }
});
it('transforms DPR and crop origins once, filters sensitive inputs, and bounds DOM capture', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
    await page.setContent(
      '<body style="margin:0"><h1 id="title" style="position:absolute;left:20px;top:30px;margin:0;width:60px;height:20px">Hello</h1><input type="password" value="secret"><input type="hidden" value="token"></body>',
    );
    const evidence = await collectDOM(page, 2, { x: 10, y: 20 }, { x: 4, y: 6 }, 200, 200);
    const title = evidence.elements.find((e) => e.selector === '#title')!;
    expect(title.bbox_px).toEqual({ x: 16, y: 14, width: 120, height: 40 });
    expect(JSON.stringify(evidence)).not.toContain('secret');
    expect(evidence.elements.some((e) => e.tag === 'input')).toBe(false);
    await page.setContent(
      '<body>' + Array.from({ length: 2100 }, (_, i) => `<div>${i}</div>`).join('') + '</body>',
    );
    const limited = await collectDOM(page, 1, { x: 0, y: 0 }, undefined, 200, 100000);
    expect(limited.elements).toHaveLength(2000);
    expect(limited.truncated).toBe(true);
  } finally {
    await browser.close();
  }
});
