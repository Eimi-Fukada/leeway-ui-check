import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AgentStatus } from '../../core/src/workflow/facade.js';
import { TaskService } from '../../core/src/tasks/service.js';

// ui_check_start 在当前 Codex hook 事件中的完整工具名，精确匹配本服务。
export const startToolName = 'mcp__leeway_ui_check__ui_check_start';

type Status = ReturnType<typeof AgentStatus.parse>;
export type Binding = {
  run_id: string;
  cwd: string;
  continuations: number;
  bound_at: number;
  interrupted: boolean;
};
export type HookEvent = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_response?: unknown;
};
/**
 * 按真实任务状态决定 Stop hook 是否要求续执行，并限制次数、时长与修复预算。
 * 处理中或待完成时可继续；终态、配置阻断、用户中断及额度耗尽时放行结束。
 */
export function continuation(status: Status, binding: Binding, now = Date.now()) {
  if (binding.interrupted || binding.continuations >= 12 || now - binding.bound_at >= 1_200_000)
    return {};
  if (status.task_terminal || status.next_action === 'wait_for_cancellation') return {};
  if (!status.budget_remaining.wall_seconds) return {};
  // Let the last evaluation finish/finalize even if all submit attempts have been consumed.
  if (status.task_status === 'needs_revision' && !status.budget_remaining.iterations) return {};
  const actions: Record<string, string> = {
    created: `Implement the requested UI for run_id=${status.run_id}, then call ui_check_submit with a new request_id. The task has not been evaluated yet.`,
    evaluating: `Call ui_check_status for run_id=${status.run_id}, request_id=${status.request_id}; evaluation is still running. Do not submit duplicate work.`,
    needs_revision: `Read visual_feedback crop images for run_id=${status.run_id}, repair the UI, then call ui_check_submit with a new request_id. Do not change the reference or acceptance rules.`,
    ready_to_finalize: `Call ui_check_finalize for run_id=${status.run_id}; passing an evaluation is not task completion.`,
  };
  const reason = actions[status.task_status];
  return reason ? { decision: 'block' as const, reason: `UI task is unfinished. ${reason}` } : {};
}
/**
 * 从 MCP 工具响应中读取结构化结果，必要时解析 text 内容；错误响应不参与聊天绑定。
 */
function toolResult(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return null;
  const result = raw as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { type: string; text?: string }[];
  };
  if (result.isError) return null;
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) return raw;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
/**
 * 处理 Codex 生命周期事件：start 成功后绑定聊天与任务，Stop 查询状态，Interrupt 禁用绑定。
 * 只作用于同一 session/cwd 的指定服务任务，不影响其他聊天。
 */
export async function handleHook(
  event: HookEvent,
  root = process.env.HARNESS_HOME ?? path.join(os.homedir(), '.leeway-ui-check'),
) {
  if (!event.session_id || !event.cwd) return {};
  root = path.resolve(root);
  const dir = path.join(root, 'codex-bindings');
  const file = path.join(
    dir,
    createHash('sha256').update(event.session_id).digest('hex') + '.json',
  );
  // 先写临时文件再替换，避免 Stop 回调读到只写了一半的聊天绑定。
  const save = async (binding: Binding) => {
    await mkdir(dir, { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(binding), 'utf8');
    await rename(temp, file);
  };
  let binding: Binding | null = null;
  try {
    binding = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    /* unbound chats are untouched */
  }
  if (event.hook_event_name === 'PostToolUse') {
    // Bind only our start tool, not similarly named tools on other MCP servers.
    if (event.tool_name !== startToolName) return {};
    const parsed = AgentStatus.safeParse(toolResult(event.tool_response));
    if (!parsed.success) return {};
    const run = parsed.data;
    if (binding?.run_id === run.run_id) return {}; // replay must not reset the continuation cap
    await save({
      run_id: run.run_id,
      cwd: path.resolve(event.cwd),
      continuations: 0,
      bound_at: Date.now(),
      interrupted: false,
    });
    return {};
  }
  if (!binding || binding.cwd !== path.resolve(event.cwd)) return {};
  if (event.hook_event_name === 'Interrupt') {
    await save({ ...binding, interrupted: true });
    return {};
  }
  if (event.hook_event_name !== 'Stop' || binding.interrupted) return {};
  // Do not accidentally create a new/empty database if MCP used another HARNESS_HOME.
  await access(path.join(root, 'harness.sqlite'));
  const service = new TaskService(root);
  try {
    const status = AgentStatus.parse(service.agentStatus(binding.run_id));
    const result = continuation(status, binding);
    if ('decision' in result) await save({ ...binding, continuations: binding.continuations + 1 });
    return result;
  } finally {
    service.close();
  }
}
