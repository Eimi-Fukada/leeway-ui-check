import { installCodexWorkflow } from '../packages/codex/src/install.js';
if (!process.argv[2])
  throw Error('Usage: npm run setup:codex -- <target-project-dir> [HARNESS_HOME]');
console.log(JSON.stringify(await installCodexWorkflow(process.argv[2], process.argv[3]), null, 2));
