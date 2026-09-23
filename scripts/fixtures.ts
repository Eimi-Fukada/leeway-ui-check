import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { capture } from '../packages/core/src/capture/runner.js';
import { defaultProfile, TaskInput, type TaskConfig } from '../packages/contracts/src/index.js';
export type Variant =
  | 'exact'
  | 'shift'
  | 'text'
  | 'blank'
  | 'missing'
  | 'duplicate'
  | 'overflow'
  | 'broken_image'
  | 'font_missing'
  | 'unusable'
  | 'animation'
  | 'screenshot';
export function fixtureHtml(variant: Variant = 'exact') {
  if (variant === 'blank') return '<html><body data-page-ready></body></html>';
  if (variant === 'screenshot')
    return '<html><body style="margin:0" data-page-ready><img src="/reference.png" style="width:960px;height:640px"></body></html>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fieldnotes</title><style>
  *{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#f6f5f0;color:#243c35}.page{position:relative;width:960px;height:640px;padding:32px;transform:translateY(${variant === 'shift' ? 16 : 0}px)}
  header{height:76px;border-bottom:1px solid #dce0d5;display:flex;justify-content:space-between}h1{margin:0;width:500px;height:42px;font-size:32px;line-height:42px;letter-spacing:-1px}.label{font-size:11px;letter-spacing:2px;color:#6a8677}.tag{padding:8px 14px;height:32px;border:1px solid #d0dbc9;border-radius:20px;font-size:11px;color:#6c8557}h2{font-size:18px;font-weight:500;margin:30px 0 7px}p{font-size:12px;color:#89947d}.cards{display:flex;gap:18px;margin-top:26px}.card{background:white;border:1px solid #e2e5dc;padding:22px;border-radius:10px;flex:1;height:140px}.card label{font-size:12px;color:#7f8e75}.card strong{display:block;font-size:32px;font-weight:500;margin:13px 0}.card small{font-size:10px;color:#8ea277}.lower{display:flex;margin-top:22px;gap:20px}.chart{width:570px;background:#eaf0df;border-radius:12px;padding:22px;height:210px}.chart h3{font-size:13px;margin:0 0 20px}.bars{display:flex;align-items:end;gap:18px;height:116px}.bars i{display:block;flex:1;background:#a7b88c;border-radius:5px 5px 0 0}.notes{flex:1;background:white;border:1px solid #e0e5d7;border-radius:12px;padding:22px}.notes h3{font-size:14px;margin:0 0 15px}.notes p{line-height:1.8}.action{position:absolute;left:734px;top:566px;width:194px;height:40px;background:#3d5840;border:0;border-radius:6px;color:white;cursor:pointer}.search{position:absolute;left:32px;top:566px;width:280px;height:40px;border:1px solid #d4ddc9;border-radius:6px;padding:10px;background:#fff}dialog{border:1px solid #b6c8a3;padding:30px;border-radius:10px}dialog::backdrop{background:#23342155}
  ${variant === 'overflow' ? 'h1{width:100px;white-space:nowrap;overflow:hidden}' : ''}
  ${variant === 'font_missing' ? "@font-face{font-family:Missing;src:url('/missing.woff2')}body{font-family:Missing,Arial}" : ''}
  </style></head><body data-page-ready><div class="page"><header><div><h1 data-testid="title">${variant === 'text' ? 'Fieldnotes 2027' : 'Fieldnotes'}</h1><div class="label">A LITTLE MORE ROOM TO GROW</div></div><div class="tag">September workspace</div></header>
  ${variant === 'duplicate' ? '<h1 data-testid="title">Fieldnotes</h1>' : ''}
  <h2>Your week, at a glance.</h2><p>Small steps. Meaningful progress. Everything in one place.</p><div class="cards"><div class="card"><label>Completed projects</label><strong>24</strong><small>+4 this month</small></div><div class="card"><label>Focus time</label><strong>38.5 <small>hrs</small></strong><small>A little better, every day</small></div><div class="card"><label>Team rhythm</label><strong>92%</strong><small>Steady and growing</small></div></div><div class="lower"><div class="chart"><h3>Weekly activity</h3><div class="bars">${[45, 70, 52, 92, 80, 106, 86].map((h) => `<i style="height:${h}px"></i>`).join('')}</div></div><div class="notes"><h3>Make space for good work.</h3><p>A clear view of what matters.<br>Less noise, more momentum.</p><p>Next review · Friday, 10:00</p></div></div><input class="search" placeholder="Search your notes" aria-label="Search"/>
  ${variant === 'missing' ? '' : `<button class="action" data-testid="primary" ${variant === 'unusable' ? 'disabled' : ''}>View weekly report</button>`}
  ${variant === 'broken_image' ? '<img src="/missing.png" style="position:absolute;left:30px;top:250px;width:100px;height:80px">' : ''}
  <dialog><h2>Weekly report</h2><button onclick="this.closest('dialog').close()">Close</button></dialog></div><script>document.querySelector('.action')?.addEventListener('click',()=>document.querySelector('dialog').showModal());${variant === 'animation' ? "let n=0;setInterval(()=>{document.querySelector('.page').style.background='hsl('+(++n%360)+' 70% 80%)';document.querySelector('h1').textContent='Frame '+n},31)" : ''}</script></body></html>`;
}
export async function makeFixture(root: string) {
  const source = path.join(root, 'target');
  await mkdir(source, { recursive: true });
  await copyFile('evals/fixtures/server.mjs', path.join(source, 'server.mjs'));
  await writeFile(path.join(source, 'index.html'), fixtureHtml());
  const config = TaskInput.parse({
    schema_version: '1.0',
    reference_path: path.join(root, 'reference.png'),
    reference: {
      viewport_css: { width: 960, height: 640 },
      device_scale_factor: 1,
      capture_mode: 'viewport',
      scroll: { x: 0, y: 0 },
      confirmed: true,
    },
    target: {
      mode: 'workspace',
      source_dir: source,
      ready_selector: '[data-page-ready]',
      build: [],
      serve: { executable: process.execPath, args: ['server.mjs', '{port}'] },
      url_path: '/',
    },
    profile: defaultProfile,
    regions: [
      {
        region_id: 'title',
        kind: 'text',
        selector: '[data-testid="title"]',
        bbox: { x: 32, y: 32, width: 500, height: 42 },
        expected_text: 'Fieldnotes',
        critical: true,
        weight: 2,
        geometry_tolerance: { position: 16, size: 16 },
      },
      {
        region_id: 'primary',
        kind: 'text',
        selector: '[data-testid="primary"]',
        bbox: { x: 734, y: 566, width: 194, height: 40 },
        expected_text: 'View weekly report',
        critical: true,
        weight: 1,
        geometry_tolerance: { position: 16, size: 16 },
      },
    ],
    required_checks: [
      {
        id: 'search_accepts_text',
        steps: [
          { action: 'fill', selector: '.search', value: 'hello' },
          { action: 'value', selector: '.search', value: 'hello' },
        ],
      },
      {
        id: 'details_dialog_opens',
        steps: [
          { action: 'click', selector: '.action' },
          { action: 'visible', selector: 'dialog[open]' },
        ],
      },
    ],
    budget: { max_iterations: 8, max_wall_seconds: 300 },
    capture_timeout_ms: 3000,
  });
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(fixtureHtml());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('no_port');
    const reference = await capture(
      config,
      `http://127.0.0.1:${address.port}`,
      AbortSignal.timeout(15000),
      () => {},
    );
    await writeFile(config.reference_path, reference.png);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await writeFile(path.join(root, 'task.json'), JSON.stringify(config, null, 2));
  return config;
}
