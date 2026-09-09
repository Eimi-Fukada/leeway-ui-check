import { z } from 'zod';
import { Command } from '../../../contracts/src/index.js';
import { TaskService } from '../tasks/service.js';
import { runCommand } from '../candidates/process.js';
import { id } from '../storage/artifacts.js';
export const AdapterConfig = z
  .object({ command: Command, attempt_timeout_seconds: z.number().int().positive().max(3600) })
  .strict();
export interface CodingAgentAdapter {
  revise(
    input: { task_id: string; source_dir: string; attempt: number; report: unknown },
    signal: AbortSignal,
  ): Promise<{ log: string }>;
}
/** Owner-selected noninteractive executable; JSON input on stdin, logs on stdout/stderr. */
export class CommandAgentAdapter implements CodingAgentAdapter {
  constructor(readonly config: z.infer<typeof AdapterConfig>) {}
  async revise(input: Parameters<CodingAgentAdapter['revise']>[0], signal: AbortSignal) {
    const result = await runCommand(
      this.config.command,
      input.source_dir,
      AbortSignal.any([signal, AbortSignal.timeout(this.config.attempt_timeout_seconds * 1000)]),
      JSON.stringify(input) + '\n',
    );
    return { log: result.stdout + '\n' + result.stderr };
  }
}
export async function runController(
  service: TaskService,
  taskId: string,
  adapter: CodingAgentAdapter,
  signal = new AbortController().signal,
) {
  const first = service.task(taskId);
  if (first.config.target.mode !== 'managed') throw Error('controller_requires_managed_target');
  if (['passed', 'failed', 'cancelled', 'stalled', 'budget_exhausted'].includes(first.state))
    return service.getTaskStatus(taskId);
  service.store.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS one_running_agent ON agent_attempts(task_id) WHERE state='running'",
  );
  while (true) {
    const task = service.task(taskId),
      status = service.getTaskStatus(taskId);
    signal.throwIfAborted();
    if (['passed', 'failed', 'cancelled', 'stalled', 'budget_exhausted'].includes(task.state))
      return status;
    const latest = status.evaluations.at(-1)?.report;
    if (latest?.verdict === 'pass') return service.finalizeTask(taskId, latest.candidate_id);
    const attemptId = id('attempt');
    const count = service.store.transaction(() => {
      if (service.task(taskId).cancellation_requested_at) throw Error('cancelled');
      const active = service.store.get(
        "SELECT id FROM evaluations WHERE task_id=? AND state IN ('queued','capturing','comparing','testing')",
        taskId,
      );
      if (active) throw Error('evaluation_conflict');
      const n = service.store.get(
        'SELECT COUNT(*) AS n FROM agent_attempts WHERE task_id=?',
        taskId,
      )!.n as number;
      if (
        n >= task.config.budget.max_iterations ||
        !service.remaining(taskId).wall_seconds ||
        !service.remaining(taskId).iterations
      ) {
        service.store.run("UPDATE tasks SET state='budget_exhausted' WHERE id=?", taskId);
        return null;
      }
      service.store.run(
        "INSERT INTO agent_attempts(id,task_id,state,started_at) VALUES(?,?,'running',?)",
        attemptId,
        taskId,
        Date.now(),
      );
      service.store.run(
        "UPDATE tasks SET state='active',started_at=COALESCE(started_at,?) WHERE id=?",
        Date.now(),
        taskId,
      );
      return n + 1;
    });
    if (count === null) return service.getTaskStatus(taskId);
    const cancel = new AbortController();
    const pulse = setInterval(() => {
      if (service.task(taskId).cancellation_requested_at) cancel.abort(Error('cancelled'));
    }, 250);
    const attemptSignal = AbortSignal.any([
      signal,
      cancel.signal,
      AbortSignal.timeout(Math.max(1, Math.floor(service.remaining(taskId).wall_seconds * 1000))),
    ]);
    try {
      const result = await adapter.revise(
        {
          task_id: taskId,
          source_dir: first.config.target.source_dir,
          attempt: count,
          report: latest ?? null,
        },
        attemptSignal,
      );
      attemptSignal.throwIfAborted();
      const log = await service.artifact(result.log, 'txt');
      service.store.run(
        "UPDATE agent_attempts SET state='completed',completed_at=?,log_artifact=? WHERE id=?",
        Date.now(),
        log.artifact_id,
        attemptId,
      );
    } catch (error) {
      const cancelled = !!service.task(taskId).cancellation_requested_at;
      const log = await service.artifact(
        error instanceof Error ? error.message : 'agent_failed',
        'txt',
      );
      service.store.run(
        'UPDATE agent_attempts SET state=?,completed_at=?,log_artifact=? WHERE id=?',
        cancelled ? 'cancelled' : 'failed',
        Date.now(),
        log.artifact_id,
        attemptId,
      );
      service.store.run(
        'UPDATE tasks SET state=? WHERE id=?',
        cancelled
          ? 'cancelled'
          : !service.remaining(taskId).wall_seconds
            ? 'budget_exhausted'
            : 'failed',
        taskId,
      );
      return service.getTaskStatus(taskId);
    } finally {
      clearInterval(pulse);
    }
    const candidate = await service.registerCandidate(taskId),
      evaluation = service.evaluateCandidate(candidate.candidate_id, id('request'));
    if (!evaluation.evaluation_id) return service.getTaskStatus(taskId);
    while (
      ['queued', 'capturing', 'comparing', 'testing'].includes(
        service.getEvaluation(evaluation.evaluation_id).state,
      )
    ) {
      if (!(await service.runNext(signal))) throw Error('worker_owned_elsewhere');
    }
  }
}
