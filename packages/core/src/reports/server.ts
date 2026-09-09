import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskService } from '../tasks/service.js';
import { inside } from '../storage/artifacts.js';
const webRoot = fileURLToPath(new URL('../../../../dist/report-web/', import.meta.url));
export async function startReportServer(service: TaskService, port = 4318) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
      );
      if (url.pathname === '/api/tasks') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            service.store.all('SELECT id,state,created_at FROM tasks ORDER BY created_at DESC'),
          ),
        );
        return;
      }
      if (url.pathname.startsWith('/api/task/')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(service.getTaskStatus(url.pathname.slice(10))));
        return;
      }
      if (url.pathname.startsWith('/api/artifact/')) {
        const a = service.getArtifact(url.pathname.slice(14));
        res.setHeader('Content-Type', a.media_type);
        res.end(await service.artifacts.read(a));
        return;
      }
      const file = path.resolve(
        webRoot,
        url.pathname === '/' ? 'index.html' : '.' + decodeURIComponent(url.pathname),
      );
      if (!inside(webRoot, file)) throw Error('invalid_path');
      res.setHeader(
        'Content-Type',
        file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream',
      );
      res.end(await readFile(file));
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'not_found' }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`,
  };
}
