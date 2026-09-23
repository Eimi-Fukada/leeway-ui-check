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
  checks: { id: string; passed: boolean; error?: string }[];
  stability_ratio: number;
  component_origin: { x: number; y: number };
  responsive?: {
    required: boolean;
    passed: boolean;
    probes: { width: number; passed: boolean; reasons: string[] }[];
  };
};
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
        await runCheck(testPage, check);
        checks.push({ id: check.id, passed: true });
      } catch (error) {
        signal.throwIfAborted();
        checks.push({
          id: check.id,
          passed: false,
          error: error instanceof Error ? error.message : 'interaction_failed',
        });
      } finally {
        await checkContext.close();
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
async function runCheck(page: Page, check: TaskConfig['required_checks'][number]) {
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
  }
}
function safeUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'resource';
  }
}
