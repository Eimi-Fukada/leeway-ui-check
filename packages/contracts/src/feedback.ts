import { z } from 'zod';
const rect = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const DOMCandidate = z
  .object({
    selector: z.string().nullable(),
    match_status: z.enum(['unique', 'unavailable']),
    tag: z.string(),
    text_excerpt: z.string().max(200),
    bbox_px: rect,
    full_bbox_px: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict()
      .optional(),
    actual_styles: z.record(z.string()),
    region_coverage: z.number().min(0).max(1),
    association_method: z.literal('bbox_overlap'),
  })
  .strict();
export const Difference = z
  .object({
    difference_id: z.string(),
    bbox_px: rect,
    crop_bbox_px: rect,
    mismatched_pixels: z.number().int().positive(),
    evaluated_pixels: z.number().int().positive(),
    difference_ratio: z.number().min(0).max(1),
    observed: z.string(),
    crops: z
      .object({ reference: z.string().min(1), actual: z.string().min(1), diff: z.string().min(1) })
      .strict()
      .nullable(),
    dom_candidates: z.array(DOMCandidate).max(3),
  })
  .strict();
export const VisualFeedback = z
  .object({
    feedback_version: z.literal('visual-feedback-v1'),
    status: z.enum(['available', 'unavailable']),
    reason: z.string().nullable(),
    regions_total: z.number().int().min(0),
    regions_omitted: z.number().int().min(0),
    dom_truncated: z.boolean(),
    regions: z.array(Difference),
    comparison: z
      .object({
        previous_evaluation_id: z.string(),
        score_delta: z.number().finite().nullable(),
        difference_ratio_delta: z.number().finite(),
        trend: z.enum(['improved', 'regressed', 'unchanged']),
        new_blockers: z.array(z.string()),
        resolved_blockers: z.array(z.string()),
        region_changes: z.array(
          z
            .object({
              kind: z.enum(['new', 'resolved', 'persistent', 'split', 'merged', 'reorganized']),
              current_ids: z.array(z.string()),
              previous_ids: z.array(z.string()),
              difference_ratio_delta: z.number().nullable(),
            })
            .strict(),
        ),
        region_changes_omitted: z.number().int().min(0).default(0),
      })
      .strict()
      .nullable(),
    comparison_unavailable_reason: z.string().nullable(),
  })
  .strict();
export type Feedback = z.infer<typeof VisualFeedback>;
export type DOMEvidence = Omit<
  z.infer<typeof DOMCandidate>,
  'region_coverage' | 'association_method'
>;
