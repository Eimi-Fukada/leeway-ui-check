import { z } from 'zod';
import {
  Id,
  Region,
  Check,
  Report,
  TaskInput,
  defaultProfile,
} from '../../../contracts/src/index.js';
import { TaskService } from '../tasks/service.js';

export const workflowInstructions = `Use ui_check_start once, then edit and ui_check_submit each new version with a new request_id. Retry the same submission with the same ID. If evaluating, poll ui_check_status. If needs_revision, read crop images, fix code and resubmit without asking the user to continue. Only finalize a verified passing result. Stop on cancellation, exhausted budget, stalled progress, or required configuration review. Never change reference or acceptance rules to pass.`;
const ResponsiveInput = z
  .object({
    required: z.boolean().default(false),
    probe_widths: z.array(z.number().int().positive()).max(5).default([]),
    max_horizontal_overflow_px: z.number().int().min(0).default(0),
  })
  .strict();
export const StartInput = z
  .object({
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
        z.object({ executable: z.string().min(1), args: z.array(z.string()).default([]) }).strict(),
      )
      .default([]),
    regions: z.array(Region).default([]),
    required_checks: z.array(Check).default([]),
    responsive: ResponsiveInput.optional(),
    profile_id: Id.optional(),
    pass_threshold: z.number().min(0).max(100).default(90),
  })
  .strict();
export const AgentStatus = z
  .object({
    run_id: Id,
    task_state: z.string(),
    task_status: z.enum([
      'created',
      'evaluating',
      'needs_revision',
      'ready_to_finalize',
      'blocked',
      'passed',
      'cancelled',
      'failed',
      'budget_exhausted',
      'stalled',
    ]),
    task_terminal: z.boolean(),
    evaluation_status: z.string().nullable(),
    request_id: Id.nullable(),
    status: z.string(), // legacy evaluation status; use task_status for workflow control
    score: Report.innerType().shape.score,
    verdict: Report.innerType().shape.verdict.nullable(),
    blockers: z.array(z.string()),
    issues: z.array(Report.innerType().shape.issues.element),
    issues_omitted: z.number().int().min(0),
    blockers_omitted: z.number().int().min(0),
    components: Report.innerType().shape.components,
    schema_version: z.string(),
    visual_feedback: Report.innerType().shape.visual_feedback.nullable().optional(),
    full_report: z.string().nullable(),
    budget_remaining: Report.innerType().shape.budget_remaining,
    artifacts: z.record(z.string()),
    next_action: z.enum([
      'stop',
      'wait_for_cancellation',
      'poll_status',
      'finalize',
      'review_configuration',
      'submit',
      'revise_and_evaluate',
      'inspect_failure',
    ]),
    requirements: TaskInput.optional(),
    delivery: z.record(z.unknown()).optional(),
  })
  .strict();
export const toolDefinitions = {
  ui_check_start: {
    input: StartInput,
    output: AgentStatus,
    description:
      'Create a UI reconstruction task. Read requirements and edit the target before submitting. Starting is not completion.',
  },
  ui_check_submit: {
    input: z
      .object({
        run_id: Id,
        request_id: Id,
        wait_ms: z.number().int().min(0).max(30000).default(10000),
      })
      .strict(),
    output: AgentStatus,
    description:
      'Evaluate the current version, not finish the task. Poll if evaluating; read evidence and repair if needs_revision. New code uses a new request_id; retries reuse the original ID.',
  },
  ui_check_status: {
    input: z.object({ run_id: Id, request_id: Id.optional() }).strict(),
    output: AgentStatus,
    description:
      'Read task and evaluation status, issues, crop image URIs and budget. Continue according to next_action; completed evaluation does not mean completed UI task.',
  },
  ui_check_cancel: {
    input: z.object({ run_id: Id }).strict(),
    output: AgentStatus,
    description:
      'Cancel a UI task. Cleanup may still be in progress; do not continue repairing a cancelled task.',
  },
  ui_check_finalize: {
    input: z.object({ run_id: Id }).strict(),
    output: AgentStatus,
    description:
      'Finish only a verified passing version. Server validates evidence and source identity; a submitted or high-scoring version alone is not complete.',
  },
} as const;
export type ToolName = keyof typeof toolDefinitions;
export class UiWorkflow {
  constructor(readonly service: TaskService) {}
  async call(name: string, raw: unknown): Promise<Record<string, unknown>> {
    const service = this.service;
    if (!(name in toolDefinitions) || !Object.hasOwn(toolDefinitions, name))
      throw Error('unknown_workflow_tool');
    let result: unknown;
    switch (name as ToolName) {
      case 'ui_check_start': {
        const input = StartInput.parse(raw);
        const storedProfile = input.profile_id
          ? service.store.get<{ json: string }>(
              'SELECT json FROM profiles WHERE id=?',
              input.profile_id,
            )
          : null;
        if (input.profile_id && !storedProfile) throw Error('profile_not_found');
        const profile = storedProfile
          ? JSON.parse(storedProfile.json)
          : input.regions.length
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
            mode: 'workspace' as const,
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
        result = {
          ...service.agentStatus(created.task_id),
          requirements: service.task(created.task_id).config,
        };
        break;
      }
      case 'ui_check_submit': {
        const input = toolDefinitions.ui_check_submit.input.parse(raw);
        result = await service.submitAndWait(input.run_id, input.request_id, input.wait_ms);
        break;
      }
      case 'ui_check_status': {
        const input = toolDefinitions.ui_check_status.input.parse(raw);
        result = service.agentStatus(input.run_id, input.request_id);
        break;
      }
      case 'ui_check_cancel': {
        const input = toolDefinitions.ui_check_cancel.input.parse(raw);
        service.cancelTask(input.run_id);
        result = service.agentStatus(input.run_id);
        break;
      }
      case 'ui_check_finalize': {
        const input = toolDefinitions.ui_check_finalize.input.parse(raw);
        const state = service.getTaskStatus(input.run_id);
        const candidate = state.final_candidate ?? state.latest_candidate;
        if (!candidate) throw Error('no_passing_candidate');
        const delivery = await service.finalizeTask(input.run_id, candidate);
        result = { ...service.agentStatus(input.run_id), delivery };
        break;
      }
    }
    return AgentStatus.parse(result);
  }
}
