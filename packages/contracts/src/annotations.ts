import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const box = z
  .object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();
/** Coordinates refer to the normalized reference image, in image pixels (not CSS pixels). */
export const ReferenceAnnotations = z
  .object({
    version: z.literal('1'),
    image_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    image_width: z.number().int().positive(),
    image_height: z.number().int().positive(),
    source: z.enum(['codex', 'human']),
    // A declaration by the caller, not proof that an agent inspected the preview.
    preview_reviewed: z.boolean(),
    unresolved: z.array(z.string().min(1)),
    regions: z
      .array(
        z
          .object({
            region_id: id,
            kind: z.enum(['text', 'component', 'image']),
            boundary: z.enum(['element_box', 'content_only']),
            bbox: box.optional(),
            expected_text: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((a, ctx) => {
    const seen = new Set<string>();
    for (const r of a.regions) {
      if (seen.has(r.region_id)) ctx.addIssue({ code: 'custom', message: 'duplicate region id' });
      seen.add(r.region_id);
      if (r.boundary === 'element_box' && !r.bbox)
        ctx.addIssue({ code: 'custom', message: 'element_box requires bbox' });
      if (r.boundary === 'content_only' && (r.bbox || r.expected_text === undefined))
        ctx.addIssue({ code: 'custom', message: 'content_only requires text and omits bbox' });
      if (
        r.bbox &&
        (r.bbox.x + r.bbox.width > a.image_width || r.bbox.y + r.bbox.height > a.image_height)
      )
        ctx.addIssue({ code: 'custom', message: 'annotation bbox out of bounds' });
    }
  });

export const ImplementationBindings = z
  .object({
    version: z.literal('1'),
    bindings: z.array(z.object({ region_id: id, selector: z.string().min(1) }).strict()).min(1),
  })
  .strict();

/** One fixed initial policy: every explicitly selected region is required, with equal weight. */
export function bindAnnotations(reference: unknown, bindings: unknown) {
  const a = ReferenceAnnotations.parse(reference),
    b = ImplementationBindings.parse(bindings);
  if (!a.preview_reviewed || a.unresolved.length) throw Error('annotation_review_required');
  const mapping = new Map(b.bindings.map((r) => [r.region_id, r.selector]));
  if (
    mapping.size !== b.bindings.length ||
    mapping.size !== a.regions.length ||
    a.regions.some((r) => !mapping.has(r.region_id))
  )
    throw Error('annotation_binding_mismatch');
  return a.regions.map((r) => ({
    region_id: r.region_id,
    kind: r.kind,
    bbox: r.bbox,
    expected_text: r.expected_text,
    selector: mapping.get(r.region_id)!,
    critical: true,
    weight: 1,
    geometry_tolerance: { position: 10, size: 10 },
  }));
}
