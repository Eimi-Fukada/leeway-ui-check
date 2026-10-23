import inspector from 'node:inspector';
import { register } from '../node_modules/tsx/dist/esm/api/index.mjs';

// 每次 Inspector 建立连接都检查端口；被占用时明确失败，避免调试器连到另一进程。
inspector.open(9229, '127.0.0.1');
register();
await import('../packages/mcp/src/index.ts');
