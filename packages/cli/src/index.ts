import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskService } from '../../core/src/tasks/service.js';
import {
  AdapterConfig,
  CommandAgentAdapter,
  runController,
} from '../../core/src/controller/loop.js';
import { startReportServer } from '../../core/src/reports/server.js';
const [command, ...args] = process.argv.slice(2),
  service = new TaskService();
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
try {
  let output: unknown;
  switch (command) {
    case 'create-task':
      output = await service.createTask(await readJson(args[0]));
      break;
    case 'register-candidate':
      output = await service.registerCandidate(args[0]);
      break;
    case 'evaluate-candidate':
      output = service.evaluateCandidate(args[0], args[1]);
      break;
    case 'get-evaluation':
      output = service.getEvaluation(args[0]);
      break;
    case 'get-task-status':
      output = service.getTaskStatus(args[0]);
      break;
    case 'finalize-task':
      output = await service.finalizeTask(args[0], args[1]);
      break;
    case 'cancel-task':
      output = service.cancelTask(args[0]);
      break;
    case 'get-artifact': {
      const a = service.getArtifact(args[0]);
      if (args[1]) await writeFile(args[1], await service.artifacts.read(a));
      output = { artifact_id: args[0], sha256: a.sha256, path: args[1] ?? a.path };
      break;
    }
    case 'import-evidence':
      output = await service.artifact(JSON.stringify(await readJson(args[0])), 'json');
      break;
    case 'controller':
      output = await runController(
        service,
        args[0],
        new CommandAgentAdapter(AdapterConfig.parse(await readJson(args[1]))),
        abort.signal,
      );
      break;
    case 'worker':
      do {
        const worked = await service.runNext(abort.signal);
        if (args.includes('--once')) break;
        if (!worked) await delay(250, undefined, { signal: abort.signal });
      } while (!abort.signal.aborted);
      output = { state: 'worker_stopped' };
      break;
    case 'report': {
      const server = await startReportServer(service, Number(args[0] ?? 4318));
      console.error(`Report: ${server.url}`);
      await new Promise<void>((resolve) =>
        abort.signal.addEventListener(
          'abort',
          () => {
            server.server.close(() => resolve());
          },
          { once: true },
        ),
      );
      break;
    }
    default:
      output = {
        usage: [
          'create-task <config.json>',
          'register-candidate <task_id>',
          'evaluate-candidate <candidate_id> <request_id>',
          'worker [--once]',
          'get-evaluation <evaluation_id>',
          'get-task-status <task_id>',
          'get-artifact <artifact_id> [output]',
          'cancel-task <task_id>',
          'finalize-task <task_id> <candidate_id>',
          'import-evidence <json>',
          'controller <task_id> <adapter.json>',
          'report [port]',
        ],
        store: service.root,
      };
  }
  if (output !== undefined) console.log(JSON.stringify(output, null, 2));
} catch (error) {
  if (!abort.signal.aborted) {
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : 'command_failed' }),
    );
    process.exitCode = 1;
  }
} finally {
  service.close();
}
