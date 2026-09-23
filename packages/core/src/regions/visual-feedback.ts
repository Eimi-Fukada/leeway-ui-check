import sharp from 'sharp';
import type { Feedback, DOMEvidence } from '../../../contracts/src/feedback.js';
import type { EvaluationReport, TaskConfig } from '../../../contracts/src/index.js';
import { pixelCompare, type Normalized } from '../compare/images.js';
type Box = { x: number; y: number; width: number; height: number };
const area = (b: Box) => b.width * b.height;
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
export function differenceRegions(
  bits: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
) {
  const cell = 16,
    cols = Math.ceil(width / cell),
    rows = Math.ceil(height / cell),
    active = new Set<number>();
  for (let i = 0; i < bits.length; i++)
    if (bits[i] && !mask[i])
      active.add(Math.floor(Math.floor(i / width) / cell) * cols + Math.floor((i % width) / cell));
  const boxes: Box[] = [];
  while (active.size) {
    const first = active.values().next().value!;
    active.delete(first);
    const queue = [first];
    let minX = cols,
      minY = rows,
      maxX = 0,
      maxY = 0;
    for (let p = 0; p < queue.length; p++) {
      const v = queue[p],
        x = v % cols,
        y = Math.floor(v / cols);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy,
            n = ny * cols + nx;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && active.delete(n)) queue.push(n);
        }
    }
    boxes.push({
      x: minX * cell,
      y: minY * cell,
      width: Math.min(width, (maxX + 1) * cell) - minX * cell,
      height: Math.min(height, (maxY + 1) * cell) - minY * cell,
    });
  }
  // Bound pathological checkerboards: retain every differing pixel in one coarse region.
  if (boxes.length > 128) {
    const x = Math.min(...boxes.map((b) => b.x)),
      y = Math.min(...boxes.map((b) => b.y));
    const box = {
      x,
      y,
      width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
      height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    };
    return [{ ...box, ...counts(bits, mask, width, box) }];
  }
  // Bounding rectangles of disconnected components can overlap; merge before counting.
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (overlap(boxes[i], boxes[j]) > 0) {
        const a = boxes[i],
          b = boxes[j],
          x = Math.min(a.x, b.x),
          y = Math.min(a.y, b.y);
        boxes[i] = {
          x,
          y,
          width: Math.max(a.x + a.width, b.x + b.width) - x,
          height: Math.max(a.y + a.height, b.y + b.height) - y,
        };
        boxes.splice(j, 1);
        i = -1;
        break;
      }
  return boxes.map((b) => ({ ...b, ...counts(bits, mask, width, b) }));
}
function counts(bits: Uint8Array, mask: Uint8Array, width: number, box: Box) {
  let mismatched = 0,
    evaluated = 0;
  for (let y = box.y; y < box.y + box.height; y++)
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = y * width + x;
      if (!mask[i]) {
        evaluated++;
        mismatched += bits[i];
      }
    }
  return {
    mismatched_pixels: mismatched,
    evaluated_pixels: evaluated,
    difference_ratio: evaluated ? mismatched / evaluated : 0,
  };
}
export function associateDOM(box: Box, elements: DOMEvidence[]) {
  return elements
    .filter((e) => overlap(box, e.bbox_px) > 0)
    .map((e) => ({
      ...e,
      region_coverage: overlap(box, e.bbox_px) / area(box),
      association_method: 'bbox_overlap' as const,
      rank: overlap(box, e.bbox_px) / Math.sqrt(area(box) * area(e.bbox_px)),
    }))
    .sort((a, b) => b.rank - a.rank || area(a.bbox_px) - area(b.bbox_px))
    .slice(0, 3)
    .map(({ rank, ...e }) => e);
}
export const unavailableFeedback = (reason: string): Feedback => ({
  feedback_version: 'visual-feedback-v1',
  status: 'unavailable',
  reason,
  regions_total: 0,
  regions_omitted: 0,
  dom_truncated: false,
  regions: [],
  comparison: null,
  comparison_unavailable_reason: reason,
});
export async function buildFeedback(input: {
  reference: Normalized;
  actual: Normalized;
  pixels: ReturnType<typeof pixelCompare>;
  config: TaskConfig;
  report: EvaluationReport;
  dom?: { elements: DOMEvidence[]; truncated: boolean };
  previous?: { report: EvaluationReport; actual: Normalized };
  put: (bytes: Buffer) => Promise<string>;
}) {
  const { reference, actual, pixels, config, report, dom, previous, put } = input,
    { width, height } = reference;
  const boxes = differenceRegions(pixels.differences, pixels.mask, width, height).sort((a, b) => {
    const critical = (r: Box) =>
      config.regions.some((c) => c.critical && overlap(r, c.bbox) > 0) ? 1 : 0;
    return (
      critical(b) - critical(a) ||
      b.mismatched_pixels - a.mismatched_pixels ||
      a.y - b.y ||
      a.x - b.x
    );
  });
  const feedback: Feedback = {
    ...unavailableFeedback('first_evaluation'),
    status: 'available',
    reason: null,
    regions_total: boxes.length,
    dom_truncated: dom?.truncated ?? false,
  };
  const diffPng = await sharp(pixels.diff, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  for (const [index, box] of boxes.entries()) {
    const x = Math.max(0, box.x - 8),
      y = Math.max(0, box.y - 8),
      crop = {
        x,
        y,
        width: Math.min(width, box.x + box.width + 8) - x,
        height: Math.min(height, box.y + box.height + 8) - y,
      };
    // All region measurements are retained; generate bounded crop evidence for the top five.
    const crops = { reference: '', actual: '', diff: '' };
    if (index < 5)
      for (const [key, png] of Object.entries({
        reference: reference.png,
        actual: actual.png,
        diff: diffPng,
      }))
        crops[key as keyof typeof crops] = await put(
          await sharp(png)
            .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
            .png()
            .toBuffer(),
        );
    feedback.regions.push({
      difference_id: `diff_${index + 1}`,
      bbox_px: { x: box.x, y: box.y, width: box.width, height: box.height },
      crop_bbox_px: crop,
      mismatched_pixels: box.mismatched_pixels,
      evaluated_pixels: box.evaluated_pixels,
      difference_ratio: box.difference_ratio,
      observed: `该范围有${box.mismatched_pixels}个像素被判定为差异`,
      crops: index < 5 ? crops : null,
      dom_candidates: index < 5 ? associateDOM(box, dom?.elements ?? []) : [],
    });
  }
  if (previous) {
    const p = previous.report;
    const compatible =
      p.reference_sha256 === report.reference_sha256 &&
      p.profile_sha256 === report.profile_sha256 &&
      p.evaluator_version === report.evaluator_version &&
      p.environment?.fingerprint === report.environment?.fingerprint &&
      p.visual_feedback?.feedback_version === feedback.feedback_version &&
      p.visual_feedback.status === 'available' &&
      previous.actual.width === width &&
      previous.actual.height === height &&
      p.metrics;
    if (!compatible) feedback.comparison_unavailable_reason = 'incompatible_evaluation';
    else {
      const oldPixels = pixelCompare(reference, previous.actual, config.profile),
        old = p.visual_feedback!.regions,
        current = feedback.regions;
      const delta = report.metrics!.difference_ratio - p.metrics!.difference_ratio;
      const scoreDelta = report.score && p.score ? report.score.value - p.score.value : null;
      const changes: NonNullable<Feedback['comparison']>['region_changes'] = [];
      const seenCurrent = new Set<number>(),
        seenOld = new Set<number>();
      for (let seed = 0; seed < current.length; seed++) {
        if (seenCurrent.has(seed)) continue;
        const cset = new Set([seed]),
          pset = new Set<number>();
        let changed = true;
        while (changed) {
          changed = false;
          for (let c = 0; c < current.length; c++)
            for (let o = 0; o < old.length; o++)
              if (overlap(current[c].bbox_px, old[o].bbox_px) > 0 && (cset.has(c) || pset.has(o))) {
                if (!cset.has(c)) {
                  cset.add(c);
                  changed = true;
                }
                if (!pset.has(o)) {
                  pset.add(o);
                  changed = true;
                }
              }
        }
        cset.forEach((i) => seenCurrent.add(i));
        pset.forEach((i) => seenOld.add(i));
        const bounds = [...cset]
          .map((i) => current[i].bbox_px)
          .concat([...pset].map((i) => old[i].bbox_px));
        // Count on the union of matched regions, never compare ratios with different denominators.
        const union = new Uint8Array(width * height);
        for (const b of bounds)
          for (let y = b.y; y < b.y + b.height; y++)
            union.fill(1, y * width + b.x, y * width + b.x + b.width);
        let n = 0,
          cur = 0,
          prev = 0;
        for (let i = 0; i < union.length; i++)
          if (union[i] && !pixels.mask[i]) {
            n++;
            cur += pixels.differences[i];
            prev += oldPixels.differences[i];
          }
        changes.push({
          kind: !pset.size
            ? 'new'
            : cset.size > 1 && pset.size > 1
              ? 'reorganized'
              : cset.size > 1
                ? 'split'
                : pset.size > 1
                  ? 'merged'
                  : 'persistent',
          current_ids: [...cset].map((i) => current[i].difference_id),
          previous_ids: [...pset].map((i) => old[i].difference_id),
          difference_ratio_delta: n ? (cur - prev) / n : null,
        });
      }
      for (let o = 0; o < old.length; o++)
        if (!seenOld.has(o))
          changes.push({
            kind: 'resolved',
            current_ids: [],
            previous_ids: [old[o].difference_id],
            difference_ratio_delta: -old[o].difference_ratio,
          });
      feedback.comparison = {
        previous_evaluation_id: p.evaluation_id,
        score_delta: scoreDelta,
        difference_ratio_delta: delta,
        trend:
          Math.abs(delta) <= config.profile.stable_max_ratio
            ? 'unchanged'
            : delta < 0
              ? 'improved'
              : 'regressed',
        new_blockers: report.blockers.filter((b) => !p.blockers.includes(b)),
        resolved_blockers: p.blockers.filter((b) => !report.blockers.includes(b)),
        region_changes: changes,
        region_changes_omitted: 0,
      };
      feedback.comparison_unavailable_reason = null;
    }
  }
  return feedback;
}
export function summarizeFeedback(feedback: Feedback) {
  const copy = structuredClone(feedback);
  copy.regions = copy.regions.slice(0, 5);
  if (copy.comparison) {
    copy.comparison.region_changes_omitted = Math.max(
      0,
      copy.comparison.region_changes.length - 20,
    );
    copy.comparison.region_changes = copy.comparison.region_changes.slice(0, 20);
  }
  for (const r of copy.regions)
    if (r.crops)
      for (const key of ['reference', 'actual', 'diff'] as const)
        r.crops[key] = `harness://artifacts/${r.crops[key]}`;
  while (Buffer.byteLength(JSON.stringify(copy)) > 24000 && copy.regions.length) copy.regions.pop();
  copy.regions_omitted = feedback.regions_total - copy.regions.length;
  return copy;
}
