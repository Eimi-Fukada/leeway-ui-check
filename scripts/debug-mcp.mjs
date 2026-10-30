import inspector from 'node:inspector';
import { register } from '../node_modules/tsx/dist/esm/api/index.mjs';

// 不同 Codex 聊天可能各自启动 MCP；调试端口必须按进程分配，不能阻止工具握手。
inspector.open(9229, '127.0.0.1');
// 9229 已由另一进程使用时，请系统分配空闲端口，而非关闭正在工作的 MCP。
if (!inspector.url()) inspector.open(0, '127.0.0.1');
if (!inspector.url()) {
  console.error('Leeway debugger could not open a loopback port.');
  process.exit(1);
}
console.error(`Leeway debugger ready: pid=${process.pid}, endpoint=${inspector.url()}`);
register();
await import('../packages/mcp/src/index.ts');
