import { setTimeout as delay } from 'node:timers/promises';
import { TaskService } from '../tasks/service.js';
/**
 * 持续领取并执行队列评测；没有任务时短暂等待，收到取消信号后退出。
 * once 用于只领取一次的运维场景；MCP 入口默认保持循环。
 */
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
