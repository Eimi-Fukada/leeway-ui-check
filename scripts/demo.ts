import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskService } from '../packages/core/src/tasks/service.js';
import { fixtureHtml, makeFixture, type Variant } from './fixtures.js';
const root = path.resolve('.demo', new Date().toISOString().replaceAll(/[:.]/g, '-'));
await mkdir(root, { recursive: true });
const config = await makeFixture(root);
config.budget.max_iterations = 4;
const service = new TaskService(),
  task = await service.createTask(config);
try {
  for (const variant of ['shift', 'text', 'exact'] as Variant[]) {
    await writeFile(path.join(root, 'target/index.html'), fixtureHtml(variant));
    const c = await service.registerCandidate(task.task_id),
      queued = service.evaluateCandidate(c.candidate_id, variant);
    if (!queued.evaluation_id) throw Error('budget_exhausted');
    await service.runNext();
    const result = service.getEvaluation(queued.evaluation_id);
    console.log(
      JSON.stringify({
        variant,
        evaluation_id: queued.evaluation_id,
        state: result.state,
        score: result.report?.score,
        blockers: result.report?.blockers,
      }),
    );
    if (result.state !== 'completed') throw Error(result.error ?? 'demo_failed');
  }
  await writeFile(
    path.join(root, 'result.json'),
    JSON.stringify(service.getTaskStatus(task.task_id), null, 2),
  );
  console.log(
    `Demo task: ${task.task_id}\nEvidence: ${root}\nViewer: npm run build && npm run cli -- report`,
  );
} finally {
  service.close();
}
