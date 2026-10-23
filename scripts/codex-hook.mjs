// 普通 Node 启动入口：加载 Harness 自带的 tsx，目标项目无需安装这份运行依赖。
import { register } from '../node_modules/tsx/dist/esm/api/index.mjs';
if (process.argv[2]) process.env.HARNESS_HOME = process.argv[2];
register();
await import('../packages/codex/src/index.ts');
