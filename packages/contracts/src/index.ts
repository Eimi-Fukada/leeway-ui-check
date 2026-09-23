import { z } from 'zod';
import { VisualFeedback } from './feedback.js';

export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
export const Score = finite.min(0).max(100);
export const Rect = z
  .object({
    x: finite.min(0),
    y: finite.min(0),
    width: finite.positive(),
    height: finite.positive(),
  })
  .strict();
export const PixelRect = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const Region = z
  .object({
    region_id: Id,
    kind: z.enum(['text', 'component', 'image']),
    bbox: Rect,
    selector: z.string().min(1),
    expected_text: z.string().optional(),
    critical: z.boolean().default(false),
    weight: finite.positive().default(1),
    geometry_tolerance: z.object({ position: finite.positive(), size: finite.positive() }).strict(),
  })
  .strict();
export const Check = z
  .object({
    id: Id,
    steps: z
      .array(
        z.discriminatedUnion('action', [
          z.object({ action: z.literal('click'), selector: z.string().min(1) }).strict(),
          z
            .object({ action: z.literal('fill'), selector: z.string().min(1), value: z.string() })
            .strict(),
          z.object({ action: z.literal('visible'), selector: z.string().min(1) }).strict(),
          z
            .object({ action: z.literal('text'), selector: z.string().min(1), value: z.string() })
            .strict(),
          z
            .object({ action: z.literal('value'), selector: z.string().min(1), value: z.string() })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict();
export const Profile = z
  .object({
    profile_id: Id,
    evaluator_version: z.literal('leeway-0.1.0'),
    status: z.enum(['provisional', 'validated', 'retired']),
    mode: z.enum(['annotated', 'pixel_diagnostic']).default('annotated'),
    validation: z
      .object({ calibration_sha256: Hash, heldout_sha256: Hash, approved_by: z.string().min(1) })
      .strict()
      .optional(),
    pixel: z
      .object({
        threshold: finite.min(0).max(1),
        include_aa: z.boolean(),
        d_bad: finite.positive().max(1),
      })
      .strict(),
    ssim: z
      .object({
        window: z
          .number()
          .int()
          .min(3)
          .max(31)
          .refine((n) => n % 2 === 1),
        gaussian_weights: z.boolean(),
        s_bad: finite.min(-1).max(0.99),
      })
      .strict(),
    weights: z
      .object({
        pixel: finite.min(0),
        structure: finite.min(0),
        layout: finite.min(0),
        text: finite.min(0),
      })
      .strict(),
    critical_threshold: Score,
    text_normalization: z.enum(['unicode_whitespace', 'exact']),
    masks: z.array(PixelRect).default([]),
    stable_max_ratio: finite.min(0).max(0.01).default(0),
    stability_interval_ms: z.number().int().min(50).max(2000).default(150),
    stall_window: z.number().int().min(2).default(3),
    min_improvement: finite.min(0).default(0.2),
  })
  .strict()
  .superRefine((p, c) => {
    if (Math.abs(Object.values(p.weights).reduce((a, b) => a + b, 0) - 1) > 1e-9)
      c.addIssue({ code: 'custom', message: 'weights must sum to 1' });
    if (p.status === 'validated' && !p.validation)
      c.addIssue({
        code: 'custom',
        message: 'validated profile requires independent calibration and heldout evidence',
      });
    if (
      p.mode === 'pixel_diagnostic' &&
      (p.weights.layout !== 0 || p.weights.text !== 0 || p.status === 'validated')
    )
      c.addIssue({
        code: 'custom',
        message: 'pixel_diagnostic is provisional with zero layout/text weights',
      });
  });
export const Command = z
  .object({ executable: z.string().min(1), args: z.array(z.string()).default([]) })
  .strict();
export const Target = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('external'),
      url: z.string().url(),
      ready_selector: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal('workspace'),
      source_dir: z.string().min(1),
      ready_selector: z.string().min(1),
      build: z.array(Command).default([]),
      serve: Command,
      url_path: z.string().startsWith('/').default('/'),
      asset_extensions: z
        .array(z.string())
        .default(['.png', '.jpg', '.jpeg', '.svg', '.webp', '.woff', '.woff2']),
    })
    .strict(),
]);
export const TaskInput = z
  .object({
    schema_version: z.literal('1.0'),
    reference_path: z.string().min(1),
    reference: z
      .object({
        viewport_css: z
          .object({
            width: z.number().int().positive().max(8192),
            height: z.number().int().positive().max(8192),
          })
          .strict(),
        device_scale_factor: finite.min(0.5).max(4),
        capture_mode: z.enum(['viewport', 'component']),
        component_selector: z.string().min(1).optional(),
        crop: PixelRect.optional(),
        scroll: z.object({ x: finite.min(0), y: finite.min(0) }).strict(),
        confirmed: z.boolean(),
      })
      .strict(),
    target: Target,
    profile: Profile,
    regions: z.array(Region),
    required_checks: z.array(Check),
    pass_threshold: Score.default(90),
    threshold_operator: z.enum(['gte', 'gt']).default('gte'),
    budget: z
      .object({
        max_iterations: z.number().int().positive(),
        max_wall_seconds: z.number().int().positive(),
      })
      .strict(),
    capture_timeout_ms: z.number().int().min(500).max(120000).default(15000),
    locale: z.string().default('en-US'),
    timezone: z.string().default('UTC'),
    responsive: z
      .object({
        required: z.boolean().default(false),
        probe_widths: z.array(z.number().int().positive()).max(5).default([]),
        max_horizontal_overflow_px: z.number().int().min(0).default(0),
      })
      .strict()
      .default({ required: false, probe_widths: [], max_horizontal_overflow_px: 0 }),
    sandbox: z
      .object({
        enabled: z.boolean().default(false),
        network: z.enum(['disabled', 'loopback', 'inherit']).default('loopback'),
        max_memory_mb: z.number().int().positive().default(2048),
        max_cpu_seconds: z.number().int().positive().default(600),
        max_processes: z.number().int().positive().default(128),
        read_only_source: z.boolean().default(true),
      })
      .strict()
      .default({
        enabled: false,
        network: 'loopback',
        max_memory_mb: 2048,
        max_cpu_seconds: 600,
        max_processes: 128,
        read_only_source: true,
      }),
  })
  .strict()
  .superRefine((t, c) => {
    if (t.reference.capture_mode === 'component' && !t.reference.component_selector)
      c.addIssue({ code: 'custom', message: 'component_selector required' });
    if (t.reference.capture_mode === 'component' && t.reference.crop)
      c.addIssue({
        code: 'custom',
        message: 'component reference must be pre-cropped; crop is viewport-only',
      });
    if (t.responsive.required && !t.responsive.probe_widths.length)
      c.addIssue({ code: 'custom', message: 'responsive.required needs probe_widths' });
    if (
      t.profile.mode === 'annotated' &&
      (!t.regions.length || !t.regions.some((r) => r.expected_text !== undefined))
    )
      c.addIssue({
        code: 'custom',
        message: 'annotated profile requires regions and text baselines',
      });
    for (const values of [t.regions.map((r) => r.region_id), t.required_checks.map((r) => r.id)])
      if (new Set(values).size !== values.length)
        c.addIssue({ code: 'custom', message: 'duplicate region/check id' });
    if (
      t.reference.viewport_css.width *
        t.reference.viewport_css.height *
        t.reference.device_scale_factor ** 2 >
      32_000_000
    )
      c.addIssue({ code: 'custom', message: 'pixel limit exceeded' });
  });
export type TaskConfig = z.infer<typeof TaskInput>;
export type EvaluationProfile = z.infer<typeof Profile>;
export type ReferenceRegion = z.infer<typeof Region>;
export type Bbox = z.infer<typeof Rect>;
export const Issue = z
  .object({
    issue_id: Id,
    kind: z.enum([
      'dimension',
      'pixel',
      'geometry',
      'text',
      'asset',
      'interaction',
      'runtime',
      'unstable_capture',
    ]),
    severity: z.enum(['high', 'medium', 'low']),
    region_id: Id.optional(),
    reference_bbox_px: Rect.optional(),
    actual_bbox_px: Rect.optional(),
    delta_px: z.object({ x: finite, y: finite, width: finite, height: finite }).strict().optional(),
    element: z
      .object({
        selector: z.string(),
        match_method: z.literal('explicit'),
        confidence: finite.min(0).max(1),
      })
      .strict()
      .optional(),
    observed: z.string(),
    suggestion: z.string(),
    suggestion_kind: z.literal('hypothesis'),
    evidence_artifact_ids: z.array(Id),
  })
  .strict();
export type Finding = z.infer<typeof Issue>;
export const Components = z
  .object({ pixel: Score, structure: Score, layout: Score.nullable(), text: Score.nullable() })
  .strict();
export const RegionPixelMetric = z
  .object({
    region_id: Id,
    evaluated_pixels: z.number().int().positive(),
    difference_ratio: finite.min(0).max(1),
    pixel_score: Score,
  })
  .strict();
export const Report = z
  .object({
    schema_version: z.enum(['1.0', '1.1']),
    visual_feedback: VisualFeedback.optional(),
    task_id: Id,
    evaluation_id: Id,
    candidate_id: Id,
    profile_id: Id,
    reference_sha256: Hash,
    profile_sha256: Hash,
    source_manifest_hash: Hash,
    evaluator_version: z.literal('leeway-0.1.0'),
    build_manifest_hash: Hash.nullable().default(null),
    status: z.enum(['completed', 'failed', 'cancelled']),
    verdict: z.enum(['pass', 'needs_revision', 'review_required']),
    score: z
      .object({ value: Score, threshold: Score, calibrated: z.boolean() })
      .strict()
      .nullable(),
    components: Components.nullable(),
    blockers: z.array(z.string()),
    issues: z.array(Issue),
    artifacts: z
      .object({
        reference: Id,
        actual: Id.optional(),
        diff: Id.optional(),
        strict_diff: Id.optional(),
        dom: Id.optional(),
        report: Id.optional(),
      })
      .strict(),
    metrics: z
      .object({
        mismatched_pixels: z.number().int().min(0),
        strict_mismatched_pixels: z.number().int().min(0),
        evaluated_pixels: z.number().int().positive(),
        difference_ratio: finite.min(0).max(1),
        ssim: finite.min(-1).max(1),
        mask_coverage: finite.min(0).max(1),
      })
      .strict()
      .nullable(),
    environment: z
      .object({ platform: z.string(), node: z.string(), chromium: z.string(), fingerprint: Hash })
      .strict()
      .nullable(),
    region_metrics: z.array(RegionPixelMetric).default([]),
    next_action: z.enum([
      'revise_and_evaluate',
      'review_configuration',
      'finalize',
      'inspect_failure',
      'stop',
    ]),
    budget_remaining: z
      .object({ iterations: z.number().int().min(0), wall_seconds: finite.min(0) })
      .strict(),
  })
  .strict()
  .superRefine((r, c) => {
    if (r.schema_version === '1.0' && r.visual_feedback)
      c.addIssue({ code: 'custom', message: 'visual feedback requires report 1.1' });
    if (r.schema_version === '1.1' && !r.visual_feedback)
      c.addIssue({ code: 'custom', message: 'report 1.1 requires visual feedback' });
    if (r.score && (!r.components || !r.metrics))
      c.addIssue({ code: 'custom', message: 'score requires components and metrics' });
    if (r.status !== 'completed' && r.score)
      c.addIssue({ code: 'custom', message: 'failed evaluations cannot have scores' });
    if (
      r.verdict === 'pass' &&
      (r.status !== 'completed' || !r.score?.calibrated || r.blockers.length)
    )
      c.addIssue({ code: 'custom', message: 'pass requires calibrated score and no blockers' });
  });
export type EvaluationReport = z.infer<typeof Report>;
export const defaultProfile: EvaluationProfile = Profile.parse({
  profile_id: 'baseline-provisional-v1',
  evaluator_version: 'leeway-0.1.0',
  status: 'provisional',
  pixel: { threshold: 0.1, include_aa: false, d_bad: 0.25 },
  ssim: { window: 7, gaussian_weights: false, s_bad: 0.5 },
  weights: { pixel: 0.35, structure: 0.2, layout: 0.3, text: 0.15 },
  critical_threshold: 90,
  text_normalization: 'unicode_whitespace',
});
