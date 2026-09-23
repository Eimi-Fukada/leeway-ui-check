import { it, expect } from 'vitest';
import sharp from 'sharp';
import {
  differenceRegions,
  associateDOM,
  buildFeedback,
  summarizeFeedback,
} from '../../packages/core/src/regions/visual-feedback.js';
import { normalizeImage, pixelCompare } from '../../packages/core/src/compare/images.js';
import { defaultProfile, Report, TaskInput } from '../../packages/contracts/src/index.js';
import { unavailableFeedback } from '../../packages/core/src/regions/visual-feedback.js';
it('counts scattered differences exactly, merges adjacent cells, excludes masks and clips border cells', () => {
  const bits = new Uint8Array(100 * 80),
    mask = new Uint8Array(bits.length);
  for (const [x, y] of [
    [0, 0],
    [16, 0],
    [99, 79],
    [50, 40],
  ])
    bits[y * 100 + x] = 1;
  mask[40 * 100 + 50] = 1;
  const regions = differenceRegions(bits, mask, 100, 80);
  expect(regions).toHaveLength(2);
  expect(regions.reduce((n, r) => n + r.mismatched_pixels, 0)).toBe(3);
  expect(regions.find((r) => r.x === 96)?.width).toBe(4);
  expect(differenceRegions(new Uint8Array(bits.length), mask, 100, 80)).toEqual([]);
});
it('prefers overlapping specific elements over a page ancestor without inferring CSS targets', () => {
  const base = {
    selector: null,
    match_status: 'unavailable' as const,
    tag: 'div',
    text_excerpt: '',
    actual_styles: { 'font-size': '24px' },
  };
  const candidates = associateDOM({ x: 10, y: 10, width: 30, height: 20 }, [
    { ...base, bbox_px: { x: 0, y: 0, width: 1000, height: 1000 } },
    {
      ...base,
      selector: '#title',
      match_status: 'unique',
      bbox_px: { x: 10, y: 10, width: 30, height: 20 },
    },
  ]);
  expect(candidates[0].selector).toBe('#title');
  expect(candidates[0].region_coverage).toBe(1);
  expect(candidates[0]).not.toHaveProperty('expected_styles');
});
it('explicit mask output matches the existing tolerance count and preserves strict diagnostics', async () => {
  const a = await normalizeImage(
    await sharp({ create: { width: 40, height: 40, channels: 4, background: '#fff' } })
      .png()
      .toBuffer(),
  );
  const b = await normalizeImage(
    await sharp({ create: { width: 40, height: 40, channels: 4, background: '#000' } })
      .png()
      .toBuffer(),
  );
  const p = pixelCompare(a, b, {
    ...defaultProfile,
    masks: [{ x: 0, y: 0, width: 20, height: 40 }],
  });
  expect(p.differences.reduce((n, v) => n + v, 0)).toBe(p.mismatched_pixels);
  expect(p.mismatched_pixels).toBe(800);
  expect(p.difference_ratio).toBe(1);
});
it('bounds summaries and preserves counts and the original full evidence', () => {
  const feedback = {
    ...unavailableFeedback('first_evaluation'),
    status: 'available' as const,
    regions_total: 12,
    regions: Array.from({ length: 12 }, (_, i) => ({
      difference_id: `r${i}`,
      bbox_px: { x: i * 16, y: 0, width: 16, height: 16 },
      crop_bbox_px: { x: i * 16, y: 0, width: 16, height: 16 },
      mismatched_pixels: 1,
      evaluated_pixels: 256,
      difference_ratio: 1 / 256,
      observed: 'one pixel',
      crops: { reference: 'ref', actual: 'act', diff: 'diff' },
      dom_candidates: [],
    })),
  };
  const summary = summarizeFeedback(feedback);
  expect(summary.regions).toHaveLength(5);
  expect(summary.regions_omitted).toBe(7);
  expect(summary.regions[0].crops?.actual).toBe('harness://artifacts/act');
  expect(feedback.regions[0].crops.actual).toBe('act');
});
it('tracks split/merged regions on equal-area unions and rejects incompatible history', async () => {
  const config = TaskInput.parse({
    schema_version: '1.0',
    reference_path: 'ref.png',
    reference: {
      viewport_css: { width: 160, height: 64 },
      device_scale_factor: 1,
      capture_mode: 'viewport',
      scroll: { x: 0, y: 0 },
      confirmed: true,
    },
    target: {
      mode: 'workspace',
      source_dir: 'target',
      ready_selector: 'body',
      serve: { executable: 'node', args: [] },
    },
    regions: [],
    required_checks: [],
    budget: { max_iterations: 8, max_wall_seconds: 60 },
    profile: {
      ...defaultProfile,
      mode: 'pixel_diagnostic',
      weights: { pixel: 0.65, structure: 0.35, layout: 0, text: 0 },
    },
  });
  const make = async (rectangles: { left: number; top: number; width: number; height: number }[]) =>
    normalizeImage(
      await sharp({ create: { width: 160, height: 64, channels: 4, background: '#fff' } })
        .composite(
          await Promise.all(
            rectangles.map(async (r) => ({
              left: r.left,
              top: r.top,
              input: await sharp({
                create: { width: r.width, height: r.height, channels: 4, background: '#000' },
              })
                .png()
                .toBuffer(),
            })),
          ),
        )
        .png()
        .toBuffer(),
    );
  const ref = await make([]),
    split = await make([
      { left: 0, top: 0, width: 16, height: 16 },
      { left: 64, top: 0, width: 16, height: 16 },
    ]),
    merged = await make([{ left: 0, top: 0, width: 80, height: 16 }]);
  const base = (actual: typeof ref, evaluation_id: string) => {
    const pixels = pixelCompare(ref, actual, config.profile);
    return {
      pixels,
      report: Report.parse({
        schema_version: '1.0',
        task_id: 'task',
        evaluation_id,
        candidate_id: 'candidate',
        profile_id: config.profile.profile_id,
        reference_sha256: 'a'.repeat(64),
        profile_sha256: 'b'.repeat(64),
        source_manifest_hash: 'c'.repeat(64),
        evaluator_version: 'leeway-0.1.0',
        status: 'completed',
        verdict: 'needs_revision',
        score: null,
        components: null,
        blockers: [],
        issues: [],
        artifacts: { reference: 'ref' },
        metrics: {
          mismatched_pixels: pixels.mismatched_pixels,
          strict_mismatched_pixels: pixels.strict_mismatched_pixels,
          evaluated_pixels: pixels.evaluated_pixels,
          difference_ratio: pixels.difference_ratio,
          ssim: 1,
          mask_coverage: 0,
        },
        environment: {
          platform: 'test',
          node: 'test',
          chromium: 'test',
          fingerprint: 'd'.repeat(64),
        },
        next_action: 'revise_and_evaluate',
        budget_remaining: { iterations: 4, wall_seconds: 30 },
      }),
    };
  };
  const one = base(split, 'one');
  const first = await buildFeedback({
    reference: ref,
    actual: split,
    ...one,
    config,
    put: async () => 'artifact',
  });
  one.report.schema_version = '1.1';
  one.report.visual_feedback = first;
  const two = base(merged, 'two');
  const second = await buildFeedback({
    reference: ref,
    actual: merged,
    ...two,
    config,
    previous: { report: one.report, actual: split },
    put: async () => 'artifact',
  });
  expect(second.comparison?.region_changes[0].kind).toBe('merged');
  expect(second.comparison?.region_changes[0].difference_ratio_delta).toBeCloseTo(0.6);
  two.report.schema_version = '1.1';
  two.report.visual_feedback = second;
  const third = await buildFeedback({
    reference: ref,
    actual: split,
    ...base(split, 'three'),
    config,
    previous: { report: two.report, actual: merged },
    put: async () => 'artifact',
  });
  expect(third.comparison?.region_changes[0].kind).toBe('split');
  expect(third.comparison?.region_changes[0].difference_ratio_delta).toBeCloseTo(-0.6);
  two.report.environment!.fingerprint = 'e'.repeat(64);
  const incompatible = await buildFeedback({
    reference: ref,
    actual: split,
    ...one,
    config,
    previous: { report: two.report, actual: merged },
    put: async () => 'artifact',
  });
  expect(incompatible.comparison).toBeNull();
  expect(incompatible.comparison_unavailable_reason).toBe('incompatible_evaluation');
});
