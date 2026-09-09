import {
  Report,
  type TaskConfig,
  type EvaluationReport,
  type Finding,
  type Bbox,
} from '../../../contracts/src/index.js';
import type { DOMRegion, CaptureResult } from '../capture/runner.js';
import type { pixelCompare } from '../compare/images.js';
const clamp = (n: number) => Math.min(1, Math.max(0, n));
export function geometry(reference: Bbox, actual: Bbox, position: number, size: number) {
  const ep = (Math.abs(actual.x - reference.x) + Math.abs(actual.y - reference.y)) / (2 * position);
  const es =
    (Math.abs(actual.width - reference.width) + Math.abs(actual.height - reference.height)) /
    (2 * size);
  return 100 * Math.max(0, 1 - 0.5 * ep - 0.5 * es);
}
export function textSimilarity(
  expected: string,
  actual: string,
  normalization: TaskConfig['profile']['text_normalization'],
) {
  const normalize = (s: string) =>
    normalization === 'exact' ? s : s.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const a = Array.from(normalize(expected)),
    b = Array.from(normalize(actual));
  if (Math.max(a.length, b.length) > 10000) throw Error('text_limit_exceeded');
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return 100 * (1 - row[b.length] / Math.max(1, a.length, b.length));
}
export function inspectRegions(
  config: TaskConfig,
  actual: DOMRegion[],
  width: number,
  height: number,
) {
  const issues: Finding[] = [],
    blockers: string[] = [];
  let layout = 0,
    text = 0,
    layoutWeight = 0,
    textWeight = 0,
    review = false;
  const add = (
    kind: Finding['kind'],
    region: TaskConfig['regions'][number],
    observed: string,
    suggestion: string,
    element?: DOMRegion,
  ) => {
    const box = element?.bbox;
    const valid =
      box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.width > 0 &&
      box.height > 0 &&
      box.x + box.width <= width &&
      box.y + box.height <= height;
    issues.push({
      issue_id: `${kind}_${region.region_id}`,
      kind,
      severity: region.critical ? 'high' : 'medium',
      region_id: region.region_id,
      reference_bbox_px: region.bbox,
      ...(valid
        ? {
            actual_bbox_px: box,
            delta_px: {
              x: box.x - region.bbox.x,
              y: box.y - region.bbox.y,
              width: box.width - region.bbox.width,
              height: box.height - region.bbox.height,
            },
          }
        : {}),
      element: {
        selector: region.selector,
        match_method: 'explicit',
        confidence: element?.count === 1 ? 1 : 0,
      },
      observed,
      suggestion,
      suggestion_kind: 'hypothesis',
      evidence_artifact_ids: [],
    });
  };
  for (const region of config.regions) {
    const item = actual.find((r) => r.region_id === region.region_id);
    layoutWeight += region.weight;
    if (region.expected_text !== undefined) textWeight += region.weight;
    if (!item || item.count !== 1 || !item.bbox || !item.visible) {
      if (item && item.count > 1) {
        review = true;
        blockers.push(`ambiguous_match:${region.region_id}`);
      }
      if (region.critical) blockers.push(`critical_region_missing:${region.region_id}`);
      add(
        'geometry',
        region,
        item?.count && item.count > 1 ? '选择器匹配到多个元素' : '区域缺失或不可见',
        '检查区域的选择器、渲染条件和可见性',
        item,
      );
      continue;
    }
    const score = geometry(
      region.bbox,
      item.bbox,
      region.geometry_tolerance.position,
      region.geometry_tolerance.size,
    );
    layout += score * region.weight;
    if (score < 100)
      add(
        'geometry',
        region,
        `位置差 (${item.bbox.x - region.bbox.x}, ${item.bbox.y - region.bbox.y}) px；尺寸差 (${item.bbox.width - region.bbox.width}, ${item.bbox.height - region.bbox.height}) px`,
        '检查容器尺寸、间距与盒模型',
        item,
      );
    if (region.critical && score < config.profile.critical_threshold)
      blockers.push(`critical_geometry:${region.region_id}`);
    if (item.overflow) {
      if (region.critical) blockers.push(`critical_overflow:${region.region_id}`);
      add('text', region, 'DOM 内容超出元素边界', '检查文字换行、可用宽度与溢出样式', item);
    }
    if (region.expected_text !== undefined) {
      const match = textSimilarity(
        region.expected_text,
        item.text,
        config.profile.text_normalization,
      );
      text += match * region.weight;
      if (match < 100 && !issues.some((i) => i.issue_id === `text_${region.region_id}`))
        add(
          'text',
          region,
          `文字匹配 ${match.toFixed(2)}；实际文字：${item.text.slice(0, 300)}`,
          '核对文字内容、数字、标点和编码',
          item,
        );
      if (region.critical && (match < 100 || !item.selectable))
        blockers.push(`critical_text:${region.region_id}`);
    }
  }
  return {
    layout: layoutWeight ? layout / layoutWeight : null,
    text: textWeight ? text / textWeight : null,
    issues,
    blockers,
    review,
  };
}
export function scoreReport(
  config: TaskConfig,
  base: Omit<
    EvaluationReport,
    'score' | 'components' | 'blockers' | 'issues' | 'verdict' | 'next_action' | 'metrics'
  >,
  pixels: ReturnType<typeof pixelCompare>,
  ssim: number,
  captured: CaptureResult,
  width: number,
  height: number,
): EvaluationReport {
  const region = inspectRegions(config, captured.regions, width, height),
    p = config.profile;
  const components = {
    pixel: 100 * clamp(1 - pixels.difference_ratio / p.pixel.d_bad),
    structure: 100 * clamp((ssim - p.ssim.s_bad) / (1 - p.ssim.s_bad)),
    layout: region.layout,
    text: region.text,
  };
  const value =
    components.pixel * p.weights.pixel +
    components.structure * p.weights.structure +
    (components.layout ?? 0) * p.weights.layout +
    (components.text ?? 0) * p.weights.text;
  const blockers = [...region.blockers],
    issues = [...region.issues];
  if (!config.reference.confirmed) blockers.push('needs_reference_confirmation');
  if (p.status !== 'validated') blockers.push('profile_not_validated');
  if (config.target.mode === 'external') blockers.push('source_provenance_unverified');
  for (const error of captured.runtime) {
    blockers.push(error);
    issues.push({
      issue_id: `runtime_${issues.length}`,
      kind: error.startsWith('missing_') ? 'asset' : 'runtime',
      severity: 'high',
      observed: error,
      suggestion: '检查资源、控制台错误及运行环境',
      suggestion_kind: 'hypothesis',
      evidence_artifact_ids: [],
    });
  }
  if (captured.responsive?.required && !captured.responsive.passed)
    blockers.push('responsive_layout_failed');
  for (const check of captured.checks.filter((c) => !c.passed)) {
    blockers.push(`interaction_failed:${check.id}`);
    issues.push({
      issue_id: `check_${check.id}`,
      kind: 'interaction',
      severity: 'high',
      observed: `交互检查 ${check.id} 失败`,
      suggestion: '检查该交互的元素状态和业务处理',
      suggestion_kind: 'hypothesis',
      evidence_artifact_ids: [],
    });
  }
  const threshold =
    config.threshold_operator === 'gt'
      ? value > config.pass_threshold
      : value >= config.pass_threshold;
  if (!threshold) blockers.push('below_threshold');
  const review = region.review || !config.reference.confirmed;
  const verdict = review ? 'review_required' : !blockers.length ? 'pass' : 'needs_revision';
  return Report.parse({
    ...base,
    verdict,
    score: review
      ? null
      : { value, threshold: config.pass_threshold, calibrated: p.status === 'validated' },
    components: review ? null : components,
    blockers,
    issues,
    metrics: {
      mismatched_pixels: pixels.mismatched_pixels,
      strict_mismatched_pixels: pixels.strict_mismatched_pixels,
      evaluated_pixels: pixels.evaluated_pixels,
      difference_ratio: pixels.difference_ratio,
      ssim,
      mask_coverage: pixels.mask_coverage,
    },
    next_action:
      verdict === 'pass' ? 'finalize' : review ? 'review_configuration' : 'revise_and_evaluate',
  });
}
