import { readFile } from 'node:fs/promises';
import { TaskService } from '../../core/src/tasks/service.js';
import { UiWorkflow, toolDefinitions } from '../../core/src/workflow/facade.js';
import { runWorker } from '../../core/src/workflow/worker.js';
import { startReportServer } from '../../core/src/reports/server.js';
const [command, ...args] = process.argv.slice(2);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const service = new TaskService();
let worker: Promise<void> | undefined;
try {
  let output: unknown;
  if (Object.hasOwn(toolDefinitions, command ?? '')) {
    if (!args[0]) throw Error('expected_input_json_file_or_dash_for_stdin');
    let text = '';
    if (args[0] === '-') for await (const chunk of process.stdin) text += chunk;
    else text = await readFile(args[0], 'utf8');
    if (command === 'ui_check_submit') worker = runWorker(service, abort.signal);
    output = await new UiWorkflow(service).call(command, JSON.parse(text));
    // A one-shot CLI must finish its owned work before exiting. MCP instead stays connected.
    if (command === 'ui_check_submit') {
      const first = output as { run_id: string; request_id: string };
      while (
        !abort.signal.aborted &&
        service.agentStatus(first.run_id, first.request_id).task_status === 'evaluating'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      output = service.agentStatus(first.run_id, first.request_id);
    }
  } else if (command === 'import-evidence') {
    if (!args[0]) throw Error('expected_evidence_json_file');
    output = await service.artifact(
      JSON.stringify(JSON.parse(await readFile(args[0], 'utf8'))),
      'json',
    );
  } else if (command === 'worker') {
    await runWorker(service, abort.signal, args.includes('--once'));
    output = { state: 'worker_stopped' };
  } else if (command === 'report') {
    const server = await startReportServer(service, Number(args[0] ?? 4318));
    console.error(`Report: ${server.url}`);
    await new Promise<void>((resolve) => {
      const close = () => server.server.close(() => resolve());
      if (abort.signal.aborted) close();
      else abort.signal.addEventListener('abort', close, { once: true });
    });
  } else if (!command || command === 'help') {
    output = {
      usage: [
        ...Object.keys(toolDefinitions).map((name) => `${name} <input.json | ->`),
        'worker [--once]',
        'report [port]',
        'import-evidence <evidence.json> (calibration maintenance)',
      ],
      store: service.root,
    };
  } else throw Error(`unknown_command:${command}; use help for the shared five-tool workflow`);
  if (output !== undefined) console.log(JSON.stringify(output, null, 2));
} catch (error) {
  if (!abort.signal.aborted) {
    console.error(
      JSON.stringify({ error: error instanceof Error ? error.message : 'command_failed' }),
    );
    process.exitCode = 1;
  }
} finally {
  abort.abort();
  await worker;
  service.close();
}
