import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Id, TaskInput, Report } from '../../contracts/src/index.js';
import { TaskService } from '../../core/src/tasks/service.js';
export function createMcpServer(service: TaskService, owner = false) {
  const server = new McpServer({ name: 'leeway-ui-check', version: '0.1.0' });
  const wrap = async (work: () => unknown | Promise<unknown>) => {
    try {
      const result = await work();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: 'text' as const, text: error instanceof Error ? error.message : 'tool_failed' },
        ],
      };
    }
  };
  if (owner)
    server.registerTool(
      'create_task',
      {
        description: 'Owner-only: freeze reference, profile and requirements.',
        inputSchema: { config: TaskInput },
      },
      ({ config }) => wrap(() => service.createTask(config)),
    );
  if (!owner) {
    server.registerTool(
      'ui_check_start',
      { description: 'Start a UI fidelity run.', inputSchema: { task_id: Id } },
      ({ task_id }) =>
        wrap(() => ({
          run_id: task_id,
          status: service.getTaskStatus(task_id).state,
          next_action: 'submit',
        })),
    );
    server.registerTool(
      'ui_check_submit',
      {
        description: 'Freeze and evaluate the current source revision.',
        inputSchema: { run_id: Id, request_id: Id },
      },
      ({ run_id, request_id }) => wrap(() => service.submitCandidate(run_id, request_id)),
    );
    server.registerTool(
      'ui_check_status',
      { description: 'Get score, blockers and issues.', inputSchema: { run_id: Id } },
      ({ run_id }) => wrap(() => service.getTaskStatus(run_id)),
    );
    server.registerTool(
      'ui_check_cancel',
      { description: 'Cancel a run.', inputSchema: { run_id: Id } },
      ({ run_id }) => wrap(() => service.cancelTask(run_id)),
    );
    server.registerTool(
      'ui_check_finalize',
      { description: 'Finalize the verified passing result.', inputSchema: { run_id: Id } },
      ({ run_id }) =>
        wrap(() => {
          const s = service.getTaskStatus(run_id),
            candidate = s.final_candidate ?? s.best_candidate;
          if (!candidate) throw Error('no_passing_candidate');
          return service.finalizeTask(run_id, candidate);
        }),
    );
  }
  server.registerTool(
    'register_candidate',
    {
      description: 'Freeze the configured source directory; cannot change reference or target.',
      inputSchema: { task_id: Id },
    },
    ({ task_id }) => wrap(() => service.registerCandidate(task_id)),
  );
  server.registerTool(
    'evaluate_candidate',
    {
      description: 'Queue once per request_id. Worker must be running; disconnect does not cancel.',
      inputSchema: { candidate_id: Id, request_id: Id },
      outputSchema: { evaluation_id: Id.nullable(), state: z.string() },
    },
    ({ candidate_id, request_id }) =>
      wrap(() => service.evaluateCandidate(candidate_id, request_id)),
  );
  server.registerTool(
    'get_evaluation',
    {
      description: 'Read persisted evaluation; processing has no score.',
      inputSchema: { evaluation_id: Id },
      outputSchema: {
        evaluation_id: Id,
        candidate_id: Id,
        state: z.string(),
        report: Report.nullable(),
        error: z.string().nullable(),
      },
    },
    ({ evaluation_id }) => wrap(() => service.getEvaluation(evaluation_id)),
  );
  server.registerTool(
    'get_task_status',
    {
      description: 'Task state, budget, latest and best candidates.',
      inputSchema: { task_id: Id },
    },
    ({ task_id }) => wrap(() => service.getTaskStatus(task_id)),
  );
  server.registerTool(
    'get_artifact',
    {
      description: 'Resolve an immutable managed artifact to an MCP resource URI.',
      inputSchema: { artifact_id: Id },
    },
    ({ artifact_id }) =>
      wrap(() => {
        const a = service.getArtifact(artifact_id);
        return {
          artifact_id,
          sha256: a.sha256,
          media_type: a.media_type,
          uri: `harness://artifacts/${artifact_id}`,
        };
      }),
  );
  server.registerTool(
    'finalize_task',
    {
      description: 'Deliver only the exact verified, calibrated passing snapshot.',
      inputSchema: { task_id: Id, candidate_id: Id },
    },
    ({ task_id, candidate_id }) => wrap(() => service.finalizeTask(task_id, candidate_id)),
  );
  server.registerTool(
    'cancel_task',
    {
      description: 'Request cancellation; completion waits for owned process cleanup.',
      inputSchema: { task_id: Id },
    },
    ({ task_id }) => wrap(() => service.cancelTask(task_id)),
  );
  server.registerResource(
    'artifact',
    new ResourceTemplate('harness://artifacts/{artifact_id}', { list: undefined }),
    { description: 'Immutable capture, diff or JSON report' },
    async (uri, { artifact_id }) => {
      const a = service.getArtifact(Id.parse(artifact_id)),
        data = await service.artifacts.read(a);
      if (data.length > 16_000_000) throw Error('artifact_too_large_for_mcp_use_local_report');
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: a.media_type,
            ...(a.media_type.startsWith('image/') || a.media_type === 'application/octet-stream'
              ? { blob: data.toString('base64') }
              : { text: data.toString('utf8') }),
          },
        ],
      };
    },
  );
  return server;
}
