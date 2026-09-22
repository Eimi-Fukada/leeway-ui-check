import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  Id,
  TaskInput,
  Report,
  Profile,
  Region,
  Check,
  defaultProfile,
} from '../../contracts/src/index.js';
import { TaskService } from '../../core/src/tasks/service.js';
import { detectProject } from '../../core/src/project/detect.js';
import { suggestRegions } from '../../core/src/regions/suggestions.js';
const ResponsiveInput = z
  .object({
    required: z.boolean().default(false),
    probe_widths: z.array(z.number().int().positive()).max(5).default([]),
    max_horizontal_overflow_px: z.number().int().min(0).default(0),
  })
  .strict();
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
      {
        description: 'Create a UI fidelity run from a reference image and target project.',
        inputSchema: {
          reference_image_path: z.string().min(1),
          source_dir: z.string().min(1),
          viewport_width: z.number().int().positive().max(8192),
          viewport_height: z.number().int().positive().max(8192),
          device_scale_factor: z.number().positive().max(4).default(1),
          ready_selector: z.string().min(1).default('[data-page-ready]'),
          serve: z
            .object({ executable: z.string().min(1), args: z.array(z.string()).default([]) })
            .strict(),
          build: z
            .array(
              z
                .object({ executable: z.string().min(1), args: z.array(z.string()).default([]) })
                .strict(),
            )
            .default([]),
          regions: z.array(Region).default([]),
          required_checks: z.array(Check).default([]),
          responsive: ResponsiveInput.optional(),
          pass_threshold: z.number().min(0).max(100).default(90),
        },
      },
      (input) =>
        wrap(async () => {
          const profile = input.regions.length
            ? { ...defaultProfile, profile_id: 'facade-annotated-v1' }
            : {
                ...defaultProfile,
                profile_id: 'facade-pixel-diagnostic-v1',
                mode: 'pixel_diagnostic' as const,
                weights: { pixel: 0.65, structure: 0.35, layout: 0, text: 0 },
              };
          const config = {
            schema_version: '1.0' as const,
            reference_path: input.reference_image_path,
            reference: {
              viewport_css: { width: input.viewport_width, height: input.viewport_height },
              device_scale_factor: input.device_scale_factor,
              capture_mode: 'viewport' as const,
              scroll: { x: 0, y: 0 },
              confirmed: true,
            },
            target: {
              mode: 'managed' as const,
              source_dir: input.source_dir,
              ready_selector: input.ready_selector,
              build: input.build,
              serve: input.serve,
              url_path: '/',
            },
            profile,
            regions: input.regions,
            required_checks: input.required_checks,
            pass_threshold: input.pass_threshold,
            threshold_operator: 'gte' as const,
            budget: { max_iterations: 8, max_wall_seconds: 1200 },
            responsive: input.responsive ?? {
              required: false,
              probe_widths: [],
              max_horizontal_overflow_px: 0,
            },
          };
          const created = await service.createTask(config);
          return {
            ...service.agentStatus(created.task_id),
            requirements: service.task(created.task_id).config,
          };
        }),
    );
    server.registerTool(
      'ui_check_submit',
      {
        description:
          'Submit once per request_id and wait briefly; the MCP-owned worker continues when running is returned.',
        inputSchema: {
          run_id: Id,
          request_id: Id,
          wait_ms: z.number().int().min(0).max(30000).default(10000),
        },
      },
      ({ run_id, request_id, wait_ms }) =>
        wrap(() => service.submitAndWait(run_id, request_id, wait_ms)),
    );
    server.registerTool(
      'ui_check_status',
      {
        description: 'Get score, blockers and issues.',
        inputSchema: { run_id: Id, request_id: Id.optional() },
      },
      ({ run_id, request_id }) => wrap(() => service.agentStatus(run_id, request_id)),
    );
    server.registerTool(
      'ui_check_cancel',
      { description: 'Cancel a run.', inputSchema: { run_id: Id } },
      ({ run_id }) =>
        wrap(() => {
          service.cancelTask(run_id);
          return service.agentStatus(run_id);
        }),
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
  if (owner)
    server.registerTool(
      'detect_project',
      {
        description: 'Detect framework, bundler, styling and likely entrypoints for task setup.',
        inputSchema: { source_dir: z.string().min(1) },
      },
      ({ source_dir }) => wrap(() => detectProject(source_dir)),
    );
  if (owner)
    server.registerTool(
      'suggest_regions',
      {
        description: 'Suggest DOM/OCR/visual regions; owner confirmation is required.',
        inputSchema: { source_dir: z.string().min(1) },
      },
      ({ source_dir }) => wrap(() => suggestRegions(source_dir)),
    );
  if (owner) {
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
        description:
          'Queue once per request_id. Worker must be running; disconnect does not cancel.',
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
  }
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
