import { chromium, type BrowserContext, type Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import pixelmatch from 'pixelmatch';
import { normalizeImage } from '../compare/images.js';
import { hash } from '../storage/artifacts.js';
import type { TaskConfig, Bbox } from '../../../contracts/src/index.js';
import { responsiveProbe } from './responsive.js';
import { collectDOM } from '../regions/dom-evidence.js';
import type { DOMEvidence } from '../../../contracts/src/feedback.js';
export type DOMRegion = {
  region_id: string;
  selector: string;
  count: number;
  bbox: Bbox | null;
  text: string;
  visible: boolean;
  overflow: boolean;
  selectable: boolean;
  font: string;
  role: string | null;
};
export type CaptureResult = {
  dom_evidence?: { elements: DOMEvidence[]; truncated: boolean };
  png: Buffer;
  regions: DOMRegion[];
  runtime: string[];
  environment: { platform: string; node: string; chromium: string; fingerprint: string };
  checks: { id: string; passed: boolean; error?: string; observed?: Record<string, unknown> }[];
  interactions?: {
    id: string;
    passed: boolean;
    error?: string;
    observed?: Record<string, unknown>;
  }[];
  stability_ratio: number;
  component_origin: { x: number; y: number };
  responsive?: {
    required: boolean;
    passed: boolean;
    probes: { width: number; passed: boolean; reasons: string[] }[];
  };
};
/**
 * 用独立 Chromium 上下文访问目标 URL，等待页面稳定并采集截图、DOM、运行错误和检查结果。
 * 每个交互检查使用独立上下文；函数结束或取消时关闭自身浏览器，不管理目标服务。
 */
export async function capture(
  config: TaskConfig,
  url: string,
  signal: AbortSignal,
  onTesting: () => void,
): Promise<CaptureResult> {
  const browser = await chromium.launch({ headless: true });
  const stop = () => {
    void browser.close().catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  const runtime: string[] = [];
  const contextOptions = {
    viewport: config.reference.viewport_css,
    deviceScaleFactor: config.reference.device_scale_factor,
    locale: config.locale,
    timezoneId: config.timezone,
    colorScheme: 'light' as const,
    reducedMotion: 'reduce' as const,
  };
  /**
   * 准备一个页面：访问 URL、等待就绪元素/字体/图片、关闭 CSS 动画并恢复滚动位置。
   * collect 控制是否将资源和页面错误写入本轮运行证据。
   */
  async function prepare(context: BrowserContext, collect: boolean) {
    const page = await context.newPage();
    page.setDefaultTimeout(config.capture_timeout_ms);
    page.setDefaultNavigationTimeout(config.capture_timeout_ms);
    if (collect) {
      page.on('pageerror', () => runtime.push('pageerror'));
      page.on('console', (m) => {
        if (m.type() === 'error') runtime.push('console_error');
      });
      page.on('requestfailed', (r) => runtime.push(`request_failed:${safeUrl(r.url())}`));
      page.on('response', (r) => {
        if (r.status() >= 400) runtime.push(`http_${r.status()}:${safeUrl(r.url())}`);
      });
    }
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (response?.status() === 401 || response?.status() === 403) throw Error('auth_required');
    if (!response?.ok()) throw Error('infrastructure_error');
    await page.locator(config.target.ready_selector).waitFor({ state: 'visible' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await page
      .waitForFunction(() =>
        Array.from(document.images).every((img) => {
          const r = img.getBoundingClientRect();
          return (
            !r.width ||
            !r.height ||
            r.bottom <= 0 ||
            r.right <= 0 ||
            r.top >= innerHeight ||
            r.left >= innerWidth ||
            img.complete
          );
        }),
      )
      .catch(() => {
        if (collect) runtime.push('image_load_timeout');
      });
    await page.addStyleTag({
      content:
        '*,*::before,*::after {animation:none!important;transition:none!important;caret-color:transparent!important}',
    });
    await page.evaluate(({ x, y }) => window.scrollTo(x, y), config.reference.scroll);
    if (collect) {
      const broken = await page.evaluate(() =>
        Array.from(document.images)
          .filter((img) => {
            const r = img.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              r.bottom > 0 &&
              r.right > 0 &&
              r.top < innerHeight &&
              r.left < innerWidth &&
              (!img.complete || !img.naturalWidth)
            );
          })
          .map((img) => img.getAttribute('src')?.split(/[?#]/)[0] ?? 'image'),
      );
      for (const item of broken) runtime.push(`missing_image:${item}`);
      const fonts = await page.evaluate(() =>
        Array.from(document.fonts)
          .filter((f) => f.status === 'error')
          .map((f) => f.family),
      );
      for (const font of fonts) runtime.push(`missing_font:${font}`);
    }
    return page;
  }
  try {
    signal.throwIfAborted();
    const context = await browser.newContext(contextOptions),
      page = await prepare(context, true);
    const component =
      config.reference.capture_mode === 'component'
        ? page.locator(config.reference.component_selector!)
        : null;
    if (component && (await component.count()) !== 1) throw Error('ambiguous_component_match');
    const shot = async () =>
      component
        ? component.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device' })
        : page.screenshot({
            fullPage: false,
            animations: 'disabled',
            caret: 'hide',
            scale: 'device',
          });
    // 连续比较页面自身的截图，确认足够稳定后，才将结果用于和参考图比较。
    let previous = await normalizeImage(await shot()),
      png = previous.png,
      stable = false,
      ratio = 1,
      consecutive = 0,
      samples = 0;
    const deadline = Date.now() + config.capture_timeout_ms;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      await delay(config.profile.stability_interval_ms + (samples++ % 3) * 37, undefined, {
        signal,
      });
      const next = await normalizeImage(await shot());
      ratio =
        next.width === previous.width && next.height === previous.height
          ? pixelmatch(previous.data, next.data, undefined, next.width, next.height, {
              threshold: 0,
              includeAA: true,
            }) /
            (next.width * next.height)
          : 1;
      previous = next;
      png = next.png;
      consecutive = ratio <= config.profile.stable_max_ratio ? consecutive + 1 : 0;
      if (consecutive >= 3) {
        stable = true;
        break;
      }
    }
    if (!stable) throw Error('unstable_capture');
    const componentBox = component ? await component.boundingBox() : null;
    const origin = componentBox ? { x: componentBox.x, y: componentBox.y } : { x: 0, y: 0 };
    const regions: DOMRegion[] = [];
    for (const region of config.regions) {
      const locator = page.locator(region.selector),
        count = await locator.count();
      if (count !== 1) {
        regions.push({
          region_id: region.region_id,
          selector: region.selector,
          count,
          bbox: null,
          text: '',
          visible: false,
          overflow: false,
          selectable: false,
          font: '',
          role: null,
        });
        continue;
      }
      const data = await locator.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
        return {
          bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
          text,
          visible:
            r.width > 0 &&
            r.height > 0 &&
            s.visibility !== 'hidden' &&
            s.display !== 'none' &&
            Number(s.opacity) > 0,
          overflow: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
          selectable: s.userSelect !== 'none' && text.trim().length > 0,
          font: s.font,
          role: el.getAttribute('role'),
        };
      });
      const dpr = config.reference.device_scale_factor,
        crop = config.reference.crop;
      const box = {
        x: (data.bbox.x - origin.x) * dpr - (crop?.x ?? 0),
        y: (data.bbox.y - origin.y) * dpr - (crop?.y ?? 0),
        width: data.bbox.width * dpr,
        height: data.bbox.height * dpr,
      };
      regions.push({
        ...data,
        bbox: box,
        region_id: region.region_id,
        selector: region.selector,
        count,
      });
    }
    if (config.reference.crop) png = (await normalizeImage(png, config.reference.crop)).png;
    const shotInfo = await normalizeImage(png);
    const domEvidence = await collectDOM(
      page,
      config.reference.device_scale_factor,
      origin,
      config.reference.crop,
      shotInfo.width,
      shotInfo.height,
    );
    onTesting();
    const checks: CaptureResult['checks'] = [];
    for (const check of config.required_checks) {
      const checkContext = await browser.newContext(contextOptions);
      try {
        const testPage = await prepare(checkContext, false);
        const observed = await runCheck(testPage, check);
        checks.push({ id: check.id, passed: true, observed });
      } catch (error) {
        signal.throwIfAborted();
        checks.push({
          id: check.id,
          passed: false,
          error: error instanceof Error ? error.message : 'interaction_failed',
          observed: error instanceof InteractionCheckError ? error.observed : undefined,
        });
      } finally {
        await checkContext.close();
      }
    }
    const interactions: CaptureResult['interactions'] = [];
    for (const interaction of config.interaction_checks) {
      const interactionContext = await browser.newContext(contextOptions);
      try {
        const interactionPage = await prepare(interactionContext, false);
        const observed = await runInteraction(interactionPage, interaction);
        interactions.push({ id: interaction.id, passed: true, observed });
      } catch (error) {
        signal.throwIfAborted();
        interactions.push({
          id: interaction.id,
          passed: false,
          error: error instanceof InteractionCheckError ? error.message : 'interaction_failed',
          observed: error instanceof InteractionCheckError ? error.observed : undefined,
        });
      } finally {
        await interactionContext.close();
      }
    }
    const environment = {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      chromium: browser.version(),
      fingerprint: '',
    };
    environment.fingerprint = hash(JSON.stringify({ ...environment, contextOptions }));
    return {
      png,
      regions,
      runtime: [...new Set(runtime)],
      environment,
      checks,
      interactions,
      stability_ratio: ratio,
      component_origin: origin,
      dom_evidence: domEvidence,
      responsive: await responsiveProbe(config, url, signal),
    };
  } finally {
    signal.removeEventListener('abort', stop);
    await browser.close();
  }
}

async function runInteraction(page: Page, interaction: TaskConfig['interaction_checks'][number]) {
  const locator = page.locator(interaction.selector);
  if ((await locator.count()) !== 1) throw Error('interaction_selector_missing_or_ambiguous');
  if (!(await locator.isVisible())) throw Error('interaction_selector_not_visible');
  const before = await readScrollState(locator);
  if (interaction.behavior === 'horizontal_scroll') {
    await locator.evaluate((el, distance) => el.scrollBy(distance, 0), interaction.distance_px);
  } else {
    await locator.evaluate((el, distance) => el.scrollBy(0, distance), interaction.distance_px);
  }
  await page.waitForTimeout(50);
  const after = await readScrollState(locator);
  const delta =
    interaction.behavior === 'horizontal_scroll'
      ? Math.abs(after.x - before.x)
      : Math.abs(after.y - before.y);
  const targetVisible = interaction.target_selector
    ? await page
        .locator(interaction.target_selector)
        .isVisible()
        .catch(() => false)
    : undefined;
  const observed = { before, after, delta, target_visible: targetVisible };
  if (delta < interaction.min_delta_px)
    throw new InteractionCheckError('interaction_state_did_not_change', observed);
  if (interaction.target_selector && !targetVisible)
    throw new InteractionCheckError('interaction_target_not_visible', observed);
  return observed;
}
/**
 * 依次执行声明的点击、输入、可见性、文字和输入值检查，选择器必须唯一匹配。
 */
class InteractionCheckError extends Error {
  constructor(
    message: string,
    readonly observed: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function runCheck(page: Page, check: TaskConfig['required_checks'][number]) {
  const before = new Map<string, { x: number; y: number }>();
  const observed: Record<string, unknown> = {};
  for (const step of check.steps) {
    const locator = page.locator(step.selector);
    if ((await locator.count()) !== 1) throw Error('ambiguous_or_missing_check_selector');
    if (step.action === 'click') await locator.click();
    if (step.action === 'fill') await locator.fill(step.value);
    if (step.action === 'visible') await locator.waitFor({ state: 'visible' });
    if (step.action === 'text')
      await page.waitForFunction(
        ({ selector, value }) => document.querySelector(selector)?.textContent?.includes(value),
        { selector: step.selector, value: step.value },
      );
    if (step.action === 'value')
      await page.waitForFunction(
        ({ selector, value }) =>
          (document.querySelector(selector) as HTMLInputElement)?.value === value,
        { selector: step.selector, value: step.value },
      );
    if (step.action === 'scroll' || step.action === 'gesture') {
      const state = await readScrollState(locator);
      before.set(step.selector, state);
      observed[`${step.selector}:before`] = state;
      if (step.action === 'scroll') {
        await locator.evaluate((el, input) => {
          el.scrollBy(input.axis === 'x' ? input.delta : 0, input.axis === 'y' ? input.delta : 0);
        }, step);
      } else {
        const box = await locator.boundingBox();
        if (!box) throw Error('check_target_not_visible');
        const cx = box.x + box.width / 2,
          cy = box.y + box.height / 2,
          sign = step.distance;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(
          cx + (step.axis === 'x' ? -sign : 0),
          cy + (step.axis === 'y' ? -sign : 0),
          { steps: Math.max(1, Math.round(step.duration_ms / 16)) },
        );
        await page.mouse.up();
      }
    }
    if (step.action === 'scroll_position') {
      const previous = before.get(step.selector),
        current = await readScrollState(locator);
      observed[`${step.selector}:after`] = current;
      const delta =
        step.axis === 'x'
          ? Math.abs(current.x - (previous?.x ?? 0))
          : Math.abs(current.y - (previous?.y ?? 0));
      observed[`${step.selector}:delta`] = delta;
      if (delta < step.min_delta)
        throw new InteractionCheckError('scroll_position_not_changed', {
          ...observed,
          selector: step.selector,
          axis: step.axis,
          min_delta: step.min_delta,
        });
    }
    if (step.action === 'assert_visible') {
      const visible = await locator.isVisible();
      observed[`${step.selector}:visible`] = visible;
      if (!visible)
        throw new InteractionCheckError('target_not_visible', {
          ...observed,
          selector: step.selector,
        });
    }
  }
  return observed;
}

async function readScrollState(locator: ReturnType<Page['locator']>) {
  return locator.evaluate((el) => ({
    x: (el as HTMLElement).scrollLeft,
    y: (el as HTMLElement).scrollTop,
    scrollWidth: (el as HTMLElement).scrollWidth,
    clientWidth: (el as HTMLElement).clientWidth,
    scrollHeight: (el as HTMLElement).scrollHeight,
    clientHeight: (el as HTMLElement).clientHeight,
  }));
}
/**
 * 只保留资源 URL 的来源和路径，避免将查询参数或片段中的敏感信息写入错误报告。
 */
function safeUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'resource';
  }
}
