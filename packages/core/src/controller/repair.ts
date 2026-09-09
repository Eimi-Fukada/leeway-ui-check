import type { Finding } from '../../../contracts/src/index.js';
export function planRepair(score: number | null, issues: Finding[], blockers: string[]) {
  if (issues.some((i) => ['runtime', 'asset', 'unstable_capture'].includes(i.kind)))
    return {
      strategy: 'manual_review',
      priority: blockers,
      prompt: '先修复运行环境、资源或采集稳定性。',
    };
  const surgical =
    score !== null &&
    score >= 75 &&
    issues.filter((i) => ['geometry', 'text'].includes(i.kind)).length <= 4;
  return {
    strategy: surgical ? 'surgical_patch' : 'structural_rebuild',
    priority: issues.slice(0, 8).map((i) => i.issue_id),
    prompt: surgical
      ? '只修改问题涉及的组件与样式。'
      : '先修复主要容器和页面结构，再处理局部细节。',
  };
}
