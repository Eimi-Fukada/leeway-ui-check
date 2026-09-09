import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const server = createServer(async (req, res) => {
  if (req.url === '/private') {
    res.writeHead(401);
    res.end('Login required');
    return;
  }
  if (req.url === '/missing.png' || req.url === '/missing.woff2') {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const filename = req.url === '/reference.png' ? 'reference.png' : 'index.html';
    res.setHeader(
      'Content-Type',
      filename.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8',
    );
    res.end(await readFile(new URL(filename, import.meta.url)));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(Number(process.env.PORT ?? process.argv[2] ?? 4173), '127.0.0.1');
