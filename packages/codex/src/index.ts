import { handleHook, type HookEvent } from './hooks.js';
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2_000_000) throw Error('hook_input_too_large');
  }
  console.log(JSON.stringify(await handleHook(JSON.parse(input) as HookEvent)));
} catch (error) {
  // Host hooks fail open: report the limitation instead of trapping unrelated work.
  console.error(`Leeway hook unavailable: ${error instanceof Error ? error.message : 'unknown'}`);
  console.log('{}');
}
