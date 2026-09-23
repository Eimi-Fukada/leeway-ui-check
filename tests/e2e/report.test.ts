import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { TaskService } from '../../packages/core/src/tasks/service.js';
import { startReportServer } from '../../packages/core/src/reports/server.js';
import { makeFixture, fixtureHtml } from '../../scripts/fixtures.js';
it('renders report images, switches history/views and fits a 390px viewport', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'leeway-report-')),
    config = await makeFixture(root),
    service = new TaskService(path.join(root, 'store'));
  await writeFile(path.join(root, 'target/index.html'), fixtureHtml('shift'));
  const task = await service.createTask(config),
    candidate = await service.registerCandidate(task.task_id);
  service.evaluateCandidate(candidate.candidate_id, 'report');
  await service.runNext();
  await writeFile(path.join(root, 'target/index.html'), fixtureHtml('exact'));
  const exact = await service.registerCandidate(task.task_id);
  service.evaluateCandidate(exact.candidate_id, 'exact');
  await service.runNext();
  const { server, url } = await startReportServer(service, 0),
    browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.getByRole('img', { name: '差异图', exact: true }).waitFor();
    expect(await page.locator('.score').innerText()).toContain('100.0');
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
