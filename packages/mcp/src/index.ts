import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TaskService } from '../../core/src/tasks/service.js';
import { createMcpServer } from './server.js';
const service = new TaskService();
const server = createMcpServer(service, process.argv.includes('--owner'));
await server.connect(new StdioServerTransport());
console.error(
  'Leeway MCP connected. Run the independent worker for durable asynchronous evaluation.',
);
