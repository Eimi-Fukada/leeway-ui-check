import { chromium } from 'playwright';
import type { TaskConfig } from '../../../contracts/src/index.js';
/**
 * 在配置要求的额外视口宽度检查横向溢出和可见元素越界。
 * 它验证布局约束，不在缺少对应参考图时生成这些宽度的视觉还原分数。
 */
export async function responsiveProbe(config: TaskConfig, url: string, signal: AbortSignal) {
  if (!config.responsive.required)
    return {
      required: false,
      passed: true,
      probes: [] as { width: number; passed: boolean; reasons: string[] }[],
    };
  const browser = await chromium.launch({ headless: true });
  try {
    const probes = [];
    for (const width of config.responsive.probe_widths) {
      signal.throwIfAborted();
      const page = await browser.newPage({
        viewport: { width, height: config.reference.viewport_css.height },
        deviceScaleFactor: config.reference.device_scale_factor,
      });
      const reasons: string[] = [];
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.capture_timeout_ms });
        await page.locator(config.target.ready_selector).waitFor({ state: 'visible' });
        const r = await page.evaluate(() => ({
          overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          outside: Array.from(document.querySelectorAll('body *')).filter((e) => {
            const b = e.getBoundingClientRect();
            return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1);
          }).length,
        }));
        if (r.overflow > config.responsive.max_horizontal_overflow_px)
          reasons.push(`horizontal_overflow:${r.overflow}px`);
        if (r.outside) reasons.push(`elements_outside_viewport:${r.outside}`);
      } catch (e) {
        reasons.push(e instanceof Error ? e.message : 'probe_failed');
      } finally {
        await page.close();
      }
      probes.push({ width, passed: !reasons.length, reasons });
    }
    return { required: true, passed: probes.every((p) => p.passed), probes };
  } finally {
    await browser.close();
  }
}
