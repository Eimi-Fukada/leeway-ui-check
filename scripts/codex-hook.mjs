// Plain Node entrypoint; use the Harness-owned tsx runtime, independent of the target project.
import { register } from '../node_modules/tsx/dist/esm/api/index.mjs';
if (process.argv[2]) process.env.HARNESS_HOME = process.argv[2];
register();
await import('../packages/codex/src/index.ts');
