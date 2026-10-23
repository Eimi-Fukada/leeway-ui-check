import { installCodexWorkflow } from '../packages/codex/src/install.js';
// 显式接收目标项目目录与可选数据目录，生成本机可执行的项目级 Skill/hook 配置。
if (!process.argv[2])
  throw Error('Usage: npm run setup:codex -- <target-project-dir> [HARNESS_HOME]');
console.log(JSON.stringify(await installCodexWorkflow(process.argv[2], process.argv[3]), null, 2));
