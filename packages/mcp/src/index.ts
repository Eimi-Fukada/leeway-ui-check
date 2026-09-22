import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TaskService } from '../../core/src/tasks/service.js';
import { createMcpServer } from './server.js';
import { setTimeout as delay } from 'node:timers/promises';
const service = new TaskService();
const server = createMcpServer(service, process.argv.includes('--owner'));
await server.connect(new StdioServerTransport());
console.error('Leeway MCP connected. The MCP process owns the local evaluation worker.');
let stopping = false;
const stop = () => {
  stopping = true;
  service.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
void (async () => {
  while (!stopping) {
    try {
      const worked = await service.runNext();
      if (!worked) await delay(250);
    } catch (error) {
      if (!stopping)
        console.error(`Worker error: ${error instanceof Error ? error.message : 'unknown'}`);
      await delay(500);
    }
  }
})();
