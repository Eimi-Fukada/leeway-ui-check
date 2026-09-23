import { describe, it, expect } from 'vitest';
import {
  TaskInput,
  defaultProfile,
  Report,
  type TaskConfig,
} from '../../packages/contracts/src/index.js';
import { scoreReport, inspectRegions } from '../../packages/core/src/scoring/evaluate.js';
import { hash } from '../../packages/core/src/storage/artifacts.js';
import type { CaptureResult } from '../../packages/core/src/capture/runner.js';
const config = TaskInput.parse({
  schema_version: '1.0',
  reference_path: 'reference.png',
  reference: {
    viewport_css: { width: 100, height: 100 },
    device_scale_factor: 1,
    capture_mode: 'viewport',
    scroll: { x: 0, y: 0 },
    confirmed: true,
  },
  target: {
    mode: 'workspace',
    source_dir: 'target',
    ready_selector: 'body',
    serve: { executable: 'node', args: ['server.mjs'] },
  },
  profile: {
    ...defaultProfile,
    status: 'validated',
    validation: {
      calibration_sha256: hash('calibration'),
      heldout_sha256: hash('heldout'),
      approved_by: 'test-only',
    },
  },
  regions: [
    {
      region_id: 'title',
      kind: 'text',
      bbox: { x: 0, y: 0, width: 100, height: 20 },
      selector: 'h1',
      expected_text: 'Title',
      critical: true,
      geometry_tolerance: { position: 16, size: 16 },
    },
  ],
  required_checks: [],
  budget: { max_iterations: 2, max_wall_seconds: 60 },
});
const captured: CaptureResult = {
  png: Buffer.alloc(0),
  regions: [
    {
      region_id: 'title',
      selector: 'h1',
      count: 1,
      bbox: { x: 0, y: 0, width: 100, height: 20 },
      text: 'Title',
      visible: true,
      overflow: false,
      selectable: true,
      font: 'Arial',
      role: null,
    },
  ],
  runtime: [],
  environment: { platform: 'test', node: 'test', chromium: 'test', fingerprint: hash('test') },
  checks: [],
  stability_ratio: 0,
  component_origin: { x: 0, y: 0 },
};
function score(c: TaskConfig, ratio = 0) {
  return scoreReport(
    c,
    {
      schema_version: '1.0',
      task_id: 'task',
      evaluation_id: 'eval',
      candidate_id: 'candidate',
      profile_id: c.profile.profile_id,
      reference_sha256: hash('ref'),
      profile_sha256: hash('profile'),
      source_manifest_hash: hash('source'),
      build_manifest_hash: null,
      evaluator_version: 'leeway-0.1.0',
      status: 'completed',
      artifacts: { reference: 'ref' },
      region_metrics: [],
      environment: captured.environment,
      budget_remaining: { iterations: 1, wall_seconds: 60 },
    },
    {
      diff: Buffer.alloc(0),
      differences: new Uint8Array(),
      strict: Buffer.alloc(0),
      mask: new Uint8Array(),
      mismatched_pixels: 0,
      strict_mismatched_pixels: 0,
      evaluated_pixels: 10000,
      difference_ratio: ratio,
      mask_coverage: 0,
    },
    1,
    captured,
    100,
    100,
  );
}
describe('deterministic acceptance gates', () => {
  it('uses unrounded scores and explicit greater-than semantics', () => {
    expect(score({ ...config, pass_threshold: 100, threshold_operator: 'gte' }).verdict).toBe(
      'pass',
    );
    expect(score({ ...config, pass_threshold: 100, threshold_operator: 'gt' }).verdict).toBe(
      'needs_revision',
    );
    const report = score(config, 10.0001 / 140);
    expect(report.score!.value).toBeCloseTo(89.9999, 5);
    expect(report.score!.value.toFixed(1)).toBe('90.0');
    expect(report.verdict).toBe('needs_revision');
  });
  it('blocks external URL provenance and unconfirmed reference', () => {
    expect(
      score({
        ...config,
        target: { mode: 'external', url: 'http://localhost:4173', ready_selector: 'body' },
      }).blockers,
    ).toContain('source_provenance_unverified');
    expect(
      score({ ...config, reference: { ...config.reference, confirmed: false } }).score,
    ).toBeNull();
  });
  it('keeps unmatched regions in the denominator and marks ambiguous matches for review', () => {
    const missing = inspectRegions(config, [], 100, 100);
    expect(missing.layout).toBe(0);
    expect(missing.text).toBe(0);
    expect(missing.blockers).toContain('critical_region_missing:title');
    expect(inspectRegions(config, [{ ...captured.regions[0], count: 2 }], 100, 100).review).toBe(
      true,
    );
  });
  it('rejects inconsistent report status, unknown verdict and invalid bbox', () => {
    const report = score(config);
    expect(() => Report.parse({ ...report, verdict: 'success' })).toThrow();
    expect(() => Report.parse({ ...report, status: 'failed' })).toThrow();
    expect(() =>
      Report.parse({
        ...report,
        issues: [
          {
            issue_id: 'x',
            kind: 'geometry',
            severity: 'high',
            reference_bbox_px: { x: -1, y: 0, width: 10, height: 10 },
            observed: 'x',
            suggestion: 'x',
            suggestion_kind: 'hypothesis',
            evidence_artifact_ids: [],
          },
        ],
      }),
    ).toThrow();
  });
  it('does not accept implicit mobile fidelity or zero geometry tolerance', () => {
    expect(() => TaskInput.parse({ ...config, mobile_fidelity: 90 })).toThrow();
    expect(() =>
      TaskInput.parse({
        ...config,
        regions: [{ ...config.regions[0], geometry_tolerance: { position: 0, size: 1 } }],
      }),
    ).toThrow();
  });
});
