import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { normalizeImage } from '../../packages/core/src/compare/images.js';
import { hash } from '../../packages/core/src/storage/artifacts.js';
import { pythonPath } from '../../packages/core/src/compare/ssim.js';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { UiWorkflow } from '../../packages/core/src/workflow/facade.js';
import { bindAnnotations } from '../../packages/contracts/src/annotations.js';

it('renders and imports reference-only annotations, freezes evidence, and rejects stale/mismatched inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-annotations-'));
  const png = (
    await normalizeImage(
      await sharp({ create: { width: 100, height: 100, channels: 4, background: '#ffffff' } })
        .png()
        .toBuffer(),
    )
  ).png;
  const reference = path.join(root, 'reference.png'),
    annotations = path.join(root, 'annotations.json'),
    bindings = path.join(root, 'bindings.json'),
    preview = path.join(root, 'preview.png');
  await writeFile(reference, png);
  const a = {
    version: '1',
    image_sha256: hash(png),
    image_width: 100,
    image_height: 100,
    source: 'codex',
    preview_reviewed: true,
    unresolved: [],
    regions: [
      {
        region_id: 'card',
        kind: 'component',
        boundary: 'element_box',
        bbox: { x: 10, y: 10, width: 80, height: 60 },
      },
      { region_id: 'price', kind: 'text', boundary: 'content_only', expected_text: '¥136' },
    ],
  };
  const b = {
    version: '1',
    bindings: [
      { region_id: 'card', selector: '.card' },
      { region_id: 'price', selector: '.price' },
    ],
  };
  await writeFile(annotations, JSON.stringify(a));
  await writeFile(bindings, JSON.stringify(b));
  expect(() => bindAnnotations({ ...a, preview_reviewed: false }, b)).toThrow(
    'annotation_review_required',
  );
  expect(() => bindAnnotations(a, { ...b, bindings: [b.bindings[0], b.bindings[0]] })).toThrow(
    'annotation_binding_mismatch',
  );
  expect(() =>
    bindAnnotations(
      { ...a, regions: [{ ...a.regions[0], bbox: { x: 90, y: 10, width: 80, height: 60 } }] },
      b,
    ),
  ).toThrow();
  await promisify(execFile)(pythonPath(), [
    '.agents/skills/leeway-ui-check/scripts/render_annotations.py',
    reference,
    annotations,
    preview,
  ]);
  const service = new TaskService(path.join(root, 'store')),
    workflow = new UiWorkflow(service);
  const start = {
    reference_image_path: reference,
    target_url: 'http://localhost:4173',
    viewport_width: 100,
    viewport_height: 100,
    annotation_input: {
      reference_path: annotations,
      bindings_path: bindings,
      preview_path: preview,
    },
  };
  try {
    const run = await workflow.call('ui_check_start', start);
    const config = service.task(run.run_id as string).config;
    expect(config.regions[1].bbox).toBeUndefined();
    expect(config.regions.every((r) => r.critical)).toBe(true);
    expect(config.annotation_input).toBeUndefined();
    expect(config.annotation_evidence?.preview).toBeTruthy();
    expect(
      await service.artifacts.read(service.getArtifact(config.annotation_evidence!.reference)),
    ).toEqual(await readFile(annotations));
    await writeFile(annotations, JSON.stringify({ ...a, source: 'human' }));
    await expect(workflow.call('ui_check_start', start)).rejects.toThrow(
      'annotation_preview_stale',
    );
    await writeFile(annotations, JSON.stringify({ ...a, image_sha256: '0'.repeat(64) }));
    await expect(workflow.call('ui_check_start', start)).rejects.toThrow(
      'annotation_reference_hash_mismatch',
    );
    expect(service.task(run.run_id as string).config.regions[1].expected_text).toBe('¥136');
  } finally {
    service.close();
  }
});
