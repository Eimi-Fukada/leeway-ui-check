import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TaskService } from '../../core/src/tasks/service.js';
import { runWorker } from '../../core/src/workflow/worker.js';
import { createMcpServer } from './server.js';
// 共享同一数据目录：工具调用负责提交/查询，worker 负责真正执行评测。
const service = new TaskService();
const server = createMcpServer(service);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
// Codex 通过 stdin 发送 MCP 请求，通过 stdout 接收协议响应；运行日志写到 stderr。
await server.connect(new StdioServerTransport());
server.server.onclose = () => abort.abort();
console.error('Leeway MCP connected. The MCP process owns the local evaluation worker.');
try {
  // 保持队列消费者运行；连接关闭或收到退出信号时，先取消评测再释放资源。
  await runWorker(service, abort.signal);
} finally {
  await server.close();
  service.close();
}
