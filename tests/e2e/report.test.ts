import { afterAll } from 'vitest';
import { closeFixtures } from '../../scripts/fixtures.js';
afterAll(closeFixtures);
import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeImage } from '../../packages/core/src/compare/images.js';
import { hash } from '../../packages/core/src/storage/artifacts.js';
import { pythonPath } from '../../packages/core/src/compare/ssim.js';
import { readFile } from 'node:fs/promises';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { startReportServer } from '../../packages/core/src/reports/server.js';
import { makeFixture, fixtureHtml } from '../../scripts/fixtures.js';
it('renders report images, switches history/views and fits a 390px viewport', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-report-')),
    config = await makeFixture(root),
    service = new TaskService(path.join(root, 'store'));
  await writeFile(path.join(root, 'target/index.html'), fixtureHtml('shift'));
  const referenceBytes = (await normalizeImage(await readFile(config.reference_path))).png;
  const annotationPath = path.join(root, 'annotations.json'),
    bindingPath = path.join(root, 'bindings.json'),
    previewPath = path.join(root, 'preview.png');
  const normalizedPath = path.join(root, 'normalized.png');
  await writeFile(normalizedPath, referenceBytes);
  await writeFile(
    annotationPath,
    JSON.stringify({
      version: '1',
      image_sha256: hash(referenceBytes),
      image_width: 960,
      image_height: 640,
      source: 'human',
      preview_reviewed: true,
      unresolved: [],
      regions: config.regions.map((r) => ({
        region_id: r.region_id,
        kind: r.kind,
        bbox: r.bbox,
        expected_text: r.expected_text,
        boundary: 'element_box',
      })),
    }),
  );
  await writeFile(
    bindingPath,
    JSON.stringify({
      version: '1',
      bindings: config.regions.map((r) => ({ region_id: r.region_id, selector: r.selector })),
    }),
  );
  await promisify(execFile)(pythonPath(), [
    '.agents/skills/leeway-ui-check/scripts/render_annotations.py',
    normalizedPath,
    annotationPath,
    previewPath,
  ]);
  const task = await service.createTask({
      ...config,
      reference_path: normalizedPath,
      regions: [],
      annotation_input: {
        reference_path: annotationPath,
        bindings_path: bindingPath,
        preview_path: previewPath,
      },
    }),
    candidate = await service.registerCandidate(task.task_id);
  service.evaluateCandidate(candidate.candidate_id, 'report');
  await service.runNext();
  const diagnosticReport = service.getTaskStatus(task.task_id).evaluations[0].report!;
  expect(diagnosticReport.annotation_diagnostics?.findings.length).toBeGreaterThan(0);
  expect(diagnosticReport.blockers.some((b: string) => b.startsWith('critical_pixels:'))).toBe(
    false,
  );
  expect(diagnosticReport.components!.layout).toBeNull();
  await writeFile(path.join(root, 'target/index.html'), fixtureHtml('exact'));
  const exact = await service.registerCandidate(task.task_id);
  service.evaluateCandidate(exact.candidate_id, 'exact');
  await service.runNext();
  const { server, url } = await startReportServer(service, 0),
    browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.getByRole('img', { name: '差异图', exact: true }).waitFor();
    expect(await page.locator('.score').innerText()).toContain('100.0');
    expect(await page.locator('.assessment-panel').innerText()).toContain('标注区域评测');
    expect(await page.locator('.assessment-panel').innerText()).toContain(
      '标注诊断（不计入主分，不阻断验收）',
    );
    await page.getByRole('button', { name: '标注预览', exact: true }).click();
    await page.getByRole('img', { name: '参考标注预览', exact: true }).waitFor();
    expect(await page.locator('.canvas .region').count()).toBe(0);
    await page.getByRole('button', { name: '差异图', exact: true }).click();
    await page.getByRole('button', { name: '参考图', exact: true }).click();
    await page.getByRole('img', { name: '参考图', exact: true }).waitFor();
    await page.getByRole('button', { name: '当前截图', exact: true }).click();
    await page.getByRole('img', { name: '当前截图', exact: true }).waitFor();
    await page.locator('.history-item').first().click();
    await page.locator('.crop-grid img').first().waitFor();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('.crop-grid img')).every(
        (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
      ),
    );
    expect(await page.locator('.crop-grid img').count()).toBeGreaterThanOrEqual(3);
    await mkdir('.demo/qa', { recursive: true });
    await page.screenshot({ path: '.demo/qa/report-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.demo/qa/report-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    const response = await fetch(`${url}/api/artifact/unknown`);
    expect(response.status).toBe(404);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
  }
});
