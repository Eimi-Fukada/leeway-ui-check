import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TaskService } from '../../core/src/tasks/service.js';
import { runWorker } from '../../core/src/workflow/worker.js';
import { createMcpServer } from './server.js';
if (process.argv.includes('--owner'))
  throw Error('--owner was removed; use the five ui_check tools');
const service = new TaskService();
const server = createMcpServer(service);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
await server.connect(new StdioServerTransport());
server.server.onclose = () => abort.abort();
console.error('Leeway MCP connected. The MCP process owns the local evaluation worker.');
try {
  await runWorker(service, abort.signal);
} finally {
  await server.close();
  service.close();
}
