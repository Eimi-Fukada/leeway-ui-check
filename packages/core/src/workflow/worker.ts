import { setTimeout as delay } from 'node:timers/promises';
import { TaskService } from '../tasks/service.js';
export async function runWorker(service: TaskService, signal: AbortSignal, once = false) {
  while (!signal.aborted) {
    try {
      const worked = await service.runNext(signal);
      if (once) break;
      if (!worked) await delay(250, undefined, { signal });
    } catch (error) {
      if (signal.aborted) break;
      if (once) throw error;
      console.error(`Worker error: ${error instanceof Error ? error.message : 'unknown'}`);
      try {
        await delay(500, undefined, { signal });
      } catch {
        break;
      }
    }
  }
}
