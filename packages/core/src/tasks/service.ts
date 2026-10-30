import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import {
  TaskInput,
  Report,
  type TaskConfig,
  type EvaluationReport,
} from '../../../contracts/src/index.js';
import { Store } from '../storage/database.js';
import { ArtifactStore, hash, id } from '../storage/artifacts.js';
import { normalizeImage, pixelCompare, regionPixels } from '../compare/images.js';
import { ssim } from '../compare/ssim.js';
import { capture } from '../capture/runner.js';
import { loadAnnotations } from '../regions/annotations.js';
import { scoreReport } from '../scoring/evaluate.js';
import {
  buildFeedback,
  summarizeFeedback,
  unavailableFeedback,
} from '../regions/visual-feedback.js';

const terminal = new Set(['passed', 'cancelled', 'failed', 'budget_exhausted', 'stalled']);
type TaskRow = {
  id: string;
  state: string;
  config: string;
  profile_id: string;
  reference_id: string;
  reference_artifact: string;
  reference_hash: string;
  created_at: number;
  started_at: number | null;
  iterations: number;
  best_candidate: string | null;
  latest_candidate: string | null;
  cancellation_requested_at: number | null;
  final_candidate: string | null;
};
type JobRow = {
  id: string;
  evaluation_id: string;
  task_id: string;
  candidate_id: string;
  fence_token: number;
  attempt: number;
};
/**
 * 解析任务与证据的数据目录；优先采用 HARNESS_HOME，否则使用用户目录。
 */
export const defaultRoot = () =>
  process.env.HARNESS_HOME ?? path.join(os.homedir(), '.leeway-ui-check');
export class TaskService {
  readonly store: Store;
  readonly artifacts: ArtifactStore;
  /**
   * 打开任务数据库和证据文件存储，后续评测围绕同一数据目录执行。
   */
  constructor(readonly root = defaultRoot()) {
    this.root = path.resolve(root);
    this.store = new Store(this.root);
    this.artifacts = new ArtifactStore(path.join(this.root, 'artifacts'));
  }
  /**
   * 把截图、报告或文本写入内容寻址的证据文件，并登记可查询的数据库元数据。
   */
  async artifact(data: Buffer | string, extension: string) {
    const a = await this.artifacts.put(data, extension);
    this.store.run(
      'INSERT OR IGNORE INTO artifacts(id,sha256,path,media_type) VALUES(?,?,?,?)',
      a.artifact_id,
      a.sha256,
      a.path,
      a.media_type,
    );
    return a;
  }
  /**
   * 按证据 ID 查询元数据；不存在时抛错，避免直接接受任意文件路径。
   */
  getArtifact(artifactId: string) {
    const a = this.store.get('SELECT * FROM artifacts WHERE id=?', artifactId);
    if (!a) throw Error('artifact_not_found');
    return a as { id: string; sha256: string; path: string; media_type: string };
  }
  /**
   * 读取任务记录并按当前合同解析固定配置，供所有后续操作检查状态与要求。
   */
  task(taskId: string) {
    const row = this.store.get<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId);
    if (!row) throw Error('task_not_found');
    return { ...row, config: TaskInput.parse(JSON.parse(row.config)) };
  }
  /**
   * 校验参考图、视口、区域和评分配置，保存参考证据并创建任务。
   * 只固定评测要求；不会访问目标 URL、启动目标项目或进行截图比较。
   */
  async createTask(input: unknown) {
    const raw = TaskInput.parse(input);
    if (raw.annotation_evidence) throw Error('annotation_evidence_is_server_managed');
    if (raw.annotation_input && raw.regions.length)
      throw Error('annotation_input_conflicts_with_regions');
    if (raw.annotation_input && (raw.reference.crop || raw.reference.capture_mode !== 'viewport'))
      throw Error('annotation_input_requires_uncropped_viewport');
    // Load normalized reference before binding; baseline coordinates use that exact image.
    const config = raw;
    if (config.profile.status === 'retired') throw Error('profile_retired');
    // 正式验收前，维护者应已导入独立的校准集和留出集证据；这里只复核存在性与完整性。
    if (config.profile.status === 'validated') {
      const validation = config.profile.validation!;
      if (validation.calibration_sha256 === validation.heldout_sha256)
        throw Error('heldout_must_be_independent');
      for (const h of [validation.calibration_sha256, validation.heldout_sha256]) {
        const evidence = this.store.get(
          'SELECT * FROM artifacts WHERE sha256=? AND media_type=?',
          h,
          'application/json',
        );
        if (!evidence) throw Error('validation_evidence_not_imported');
        await this.artifacts.read(evidence as any);
      }
    }
    const bytes = await readFile(config.reference_path),
      original = await this.artifact(bytes, 'bin');
    const normalized = await normalizeImage(bytes, config.reference.crop),
      reference = await this.artifact(normalized.png, 'png');
    const { width, height } = normalized;
    if (config.annotation_input) {
      const a = await loadAnnotations(config.annotation_input, normalized.png);
      config.regions = a.regions;
      config.annotation_evidence = {
        reference: (await this.artifact(a.referenceBytes, 'json')).artifact_id,
        bindings: (await this.artifact(a.bindingBytes, 'json')).artifact_id,
        preview: (await this.artifact(a.preview, 'png')).artifact_id,
        manifest: (await this.artifact(a.manifestBytes, 'json')).artifact_id,
      };
      delete config.annotation_input;
      TaskInput.parse(config);
    }
    if (config.reference.capture_mode === 'viewport') {
      const expected = config.reference.crop ?? {
        width: Math.round(
          config.reference.viewport_css.width * config.reference.device_scale_factor,
        ),
        height: Math.round(
          config.reference.viewport_css.height * config.reference.device_scale_factor,
        ),
      };
      if (width !== expected.width || height !== expected.height)
        throw Error('reference_dimension_mismatch');
      const crop = config.reference.crop;
      if (
        crop &&
        (crop.x + crop.width >
          config.reference.viewport_css.width * config.reference.device_scale_factor ||
          crop.y + crop.height >
            config.reference.viewport_css.height * config.reference.device_scale_factor)
      )
        throw Error('crop_outside_viewport');
    }
    for (const r of [
      ...config.regions.flatMap((r) => (r.bbox ? [r.bbox] : [])),
      ...config.profile.masks,
    ])
      if (r.x + r.width > width || r.y + r.height > height)
        throw Error('reference_bbox_out_of_bounds');
    for (const region of config.regions.filter(
      (r) => r.usage !== 'diagnostic' && r.critical && r.bbox,
    ))
      for (const mask of config.profile.masks) {
        const b = region.bbox!;
        if (
          mask.x < b.x + b.width &&
          mask.x + mask.width > b.x &&
          mask.y < b.y + b.height &&
          mask.y + mask.height > b.y
        )
          throw Error('mask_overlaps_critical_region');
      }
    const taskId = id('task'),
      refId = id('ref'),
      profileHash = hash(JSON.stringify(config.profile));
    this.store.transaction(() => {
      const existing = this.store.get(
        'SELECT hash FROM profiles WHERE id=?',
        config.profile.profile_id,
      );
      if (existing && existing.hash !== profileHash) throw Error('profile_id_immutable');
      this.store.run(
        'INSERT OR IGNORE INTO profiles(id,hash,json) VALUES(?,?,?)',
        config.profile.profile_id,
        profileHash,
        JSON.stringify(config.profile),
      );
      this.store.run(
        'INSERT INTO reference_versions(id,artifact_id,sha256) VALUES(?,?,?)',
        refId,
        original.artifact_id,
        original.sha256,
      );
      this.store.run(
        'INSERT INTO tasks(id,state,config,profile_id,reference_id,reference_artifact,reference_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',
        taskId,
        config.reference.confirmed ? 'ready' : 'draft',
        JSON.stringify(config),
        config.profile.profile_id,
        refId,
        reference.artifact_id,
        reference.sha256,
        Date.now(),
      );
      for (const region of config.regions)
        this.store.run(
          'INSERT INTO regions(id,task_id,json) VALUES(?,?,?)',
          region.region_id,
          taskId,
          JSON.stringify(region),
        );
      this.store.event(taskId, 'task_created', {
        original_artifact: original.artifact_id,
        normalized_artifact: reference.artifact_id,
        profile_hash: profileHash,
      });
    });
    return {
      task_id: taskId,
      state: config.reference.confirmed ? 'ready' : 'draft',
      needs_reference_confirmation: !config.reference.confirmed,
    };
  }
  /**
   * 为任务登记一次 URL 页面采集候选，后续评测通过 candidate_id 关联它。
   * 候选标识一轮采集，不是源码快照或部署版本证明。
   */
  async registerCandidate(taskId: string) {
    const task = this.task(taskId);
    if (terminal.has(task.state) || task.cancellation_requested_at)
      throw Error('task_not_accepting_candidates');
    const target = task.config.target,
      candidateId = id('cand');
    this.store.transaction(() => {
      const current = this.task(taskId);
      if (terminal.has(current.state) || current.cancellation_requested_at)
        throw Error('task_not_accepting_candidates');
      this.store.run(
        'INSERT INTO candidates(id,task_id,state,target_url,created_at) VALUES(?,?,?,?,?)',
        candidateId,
        taskId,
        'ready',
        target.url,
        Date.now(),
      );
      this.store.event(taskId, 'candidate_registered', {
        candidate_id: candidateId,
        target_url: target.url,
      });
    });
    return {
      candidate_id: candidateId,
      target_url: target.url,
      evidence_scope: 'captured_page',
    };
  }
  /**
   * 读取候选记录；候选不存在时立即报错。
   */
  candidate(candidateId: string) {
    const c = this.store.get('SELECT * FROM candidates WHERE id=?', candidateId);
    if (!c) throw Error('candidate_not_found');
    return c;
  }
  /**
   * 按 request_id 去重并校验任务状态、并发评测和剩余预算，然后创建评测及队列作业。
   * 这里只排队并消耗一次迭代额度，真正截图由 runNext 调用 perform 执行。
   */
  evaluateCandidate(candidateId: string, requestId: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw Error('invalid_request_id');
    return this.store.transaction(() => {
      const candidate = this.candidate(candidateId),
        task = this.task(candidate.task_id);
      const existing = this.store.get(
        'SELECT id,candidate_id,state FROM evaluations WHERE task_id=? AND request_id=?',
        task.id,
        requestId,
      );
      if (existing) {
        if (existing.candidate_id !== candidateId) throw Error('request_id_conflict');
        return { evaluation_id: existing.id, state: existing.state };
      }
      if (terminal.has(task.state) || task.cancellation_requested_at) throw Error('task_terminal');
      if (candidate.state !== 'ready') throw Error('candidate_not_ready');
      const active = this.store.get(
        "SELECT id FROM evaluations WHERE task_id=? AND state IN ('queued','capturing','comparing','testing')",
        task.id,
      );
      if (active) throw Error('evaluation_conflict');
      const budget = this.remaining(task.id);
      if (!budget.iterations || !budget.wall_seconds) {
        this.store.run("UPDATE tasks SET state='budget_exhausted' WHERE id=?", task.id);
        return { evaluation_id: null, state: 'budget_exhausted' };
      }
      const evaluationId = id('eval');
      this.store.run(
        "INSERT INTO evaluations(id,task_id,candidate_id,request_id,state,created_at) VALUES(?,?,?,?,'queued',?)",
        evaluationId,
        task.id,
        candidateId,
        requestId,
        Date.now(),
      );
      this.store.run(
        "INSERT INTO jobs(id,evaluation_id,dedupe_key,state) VALUES(?,?,?,'queued')",
        id('job'),
        evaluationId,
        `${task.id}:${requestId}`,
      );
      this.store.run(
        "UPDATE tasks SET state='active',iterations=iterations+1,started_at=COALESCE(started_at,?),latest_candidate=? WHERE id=?",
        Date.now(),
        candidateId,
        task.id,
      );
      this.store.event(task.id, 'evaluation_queued', {
        evaluation_id: evaluationId,
        candidate_id: candidateId,
      });
      return { evaluation_id: evaluationId, state: 'queued' };
    });
  }
  /**
   * 计算还可提交的轮数与剩余时间；任务首次开始评测后计入墙钟时间。
   */
  remaining(taskId: string) {
    const t = this.task(taskId);
    return {
      iterations: Math.max(0, t.config.budget.max_iterations - t.iterations),
      wall_seconds: Math.max(
        0,
        t.config.budget.max_wall_seconds - (t.started_at ? (Date.now() - t.started_at) / 1000 : 0),
      ),
    };
  }
  /**
   * 读取单轮评测的持久状态、完整报告和错误；运行中尚未产生报告。
   */
  getEvaluation(evaluationId: string) {
    const e = this.store.get('SELECT * FROM evaluations WHERE id=?', evaluationId);
    if (!e) throw Error('evaluation_not_found');
    return {
      evaluation_id: e.id,
      candidate_id: e.candidate_id,
      state: e.state,
      report: e.report ? Report.parse(JSON.parse(e.report)) : null,
      error: e.error,
    };
  }
  /**
   * 汇总任务、候选、预算和全部评测记录，供报告页及内部操作查看完整进度。
   */
  getTaskStatus(taskId: string) {
    const t = this.task(taskId);
    return {
      task_id: t.id,
      state: t.state,
      cancellation_requested_at: t.cancellation_requested_at,
      budget_remaining: this.remaining(taskId),
      latest_candidate: t.latest_candidate,
      best_candidate: t.best_candidate,
      final_candidate: t.final_candidate,
      evaluations: this.store
        .all(
          'SELECT id AS evaluation_id,candidate_id,state,report FROM evaluations WHERE task_id=? ORDER BY created_at',
          taskId,
        )
        .map((e) => ({ ...e, report: e.report ? Report.parse(JSON.parse(e.report)) : null })),
    };
  }
  /**
   * 登记取消请求，取消排队作业；仍在采集的评测需等待 worker 退出并清理浏览器。
   * 不会关闭 Codex 或开发者启动的目标页面服务。
   */
  cancelTask(taskId: string) {
    this.store.transaction(() => {
      const t = this.task(taskId);
      if (terminal.has(t.state)) return;
      this.store.run('UPDATE tasks SET cancellation_requested_at=? WHERE id=?', Date.now(), taskId);
      this.store.run(
        "UPDATE jobs SET state='cancelled' WHERE state='queued' AND evaluation_id IN (SELECT id FROM evaluations WHERE task_id=?)",
        taskId,
      );
      this.store.run(
        "UPDATE evaluations SET state='cancelled' WHERE task_id=? AND state='queued'",
        taskId,
      );
      const active = this.store.get(
        "SELECT id FROM evaluations WHERE task_id=? AND state IN ('capturing','comparing','testing')",
        taskId,
      );
      if (!active) this.store.run("UPDATE tasks SET state='cancelled' WHERE id=?", taskId);
      this.store.event(taskId, 'cancellation_requested', {});
    });
    return this.getTaskStatus(taskId);
  }
  /**
   * 使用任务级短文件锁串行登记提交，相同 request_id 复用同一轮结果。
   * 新提交依次登记候选和评测，避免网络重试重复计数或并发创建候选。
   */
  async submitCandidate(taskId: string, requestId: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw Error('invalid_request_id');
    this.task(taskId);
    const existing = () =>
      this.store.get<{ evaluation_id: string; candidate_id: string; state: string }>(
        'SELECT id AS evaluation_id,candidate_id,state FROM evaluations WHERE task_id=? AND request_id=?',
        taskId,
        requestId,
      );
    const replay = existing();
    if (replay) return replay;
    // Cross-process submission serialization. Never hold a SQLite transaction across artifact IO.
    const parent = path.join(this.root, 'submission-locks');
    await mkdir(parent, { recursive: true });
    const lock = path.join(parent, taskId);
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const replay = existing();
        if (replay) return replay;
        if (Date.now() >= deadline) throw Error('submission_busy');
        await delay(100);
      }
    }
    try {
      const replay = existing();
      if (replay) return replay;
      if (
        this.store.get(
          "SELECT id FROM evaluations WHERE task_id=? AND state IN ('queued','capturing','comparing','testing')",
          taskId,
        )
      )
        throw Error('evaluation_conflict');
      const candidate = await this.registerCandidate(taskId);
      return {
        ...this.evaluateCandidate(candidate.candidate_id, requestId),
        candidate_id: candidate.candidate_id,
      };
    } finally {
      await rmdir(lock);
    }
  }
  /**
   * 提交一轮评测并限时查询结果，最后返回 Agent 摘要；超时仅结束等待，不取消评测。
   * 此方法不消费队列，需要同进程或独立 worker 执行。
   */
  async submitAndWait(taskId: string, requestId: string, waitMs = 10000) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw Error('invalid_wait_ms');
    const queued = await this.submitCandidate(taskId, requestId);
    if (!queued.evaluation_id) return this.agentStatus(taskId);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const result = this.getEvaluation(queued.evaluation_id);
      if (!['queued', 'capturing', 'comparing', 'testing'].includes(result.state)) break;
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    return this.agentStatus(taskId, requestId);
  }
  /**
   * 将最新或指定提交的评测转换为有大小上限的 Agent 反馈，并给出 next_action。
   * 单轮评测完成不代表整个任务通过；task_status 才表示是否修复、查询或完成。
   */
  agentStatus(taskId: string, requestId?: string) {
    const task = this.task(taskId);
    const row = requestId
      ? this.store.get(
          'SELECT * FROM evaluations WHERE task_id=? AND request_id=?',
          taskId,
          requestId,
        )
      : this.store.get(
          'SELECT * FROM evaluations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
          taskId,
        );
    if (requestId && !row) throw Error('request_not_found');
    const report = row?.report ? Report.parse(JSON.parse(row.report)) : null;
    const processing = row && ['queued', 'capturing', 'comparing', 'testing'].includes(row.state);
    const result = {
      run_id: taskId,
      task_status: terminal.has(task.state)
        ? task.state
        : task.cancellation_requested_at
          ? 'blocked'
          : processing
            ? 'evaluating'
            : report?.verdict === 'pass'
              ? 'ready_to_finalize'
              : report?.next_action === 'review_configuration'
                ? 'blocked'
                : report?.verdict === 'needs_revision'
                  ? 'needs_revision'
                  : report
                    ? 'blocked'
                    : 'created',
      task_terminal: terminal.has(task.state),
      evaluation_status: row?.state ?? null,
      request_id: row?.request_id ?? null,
      score: report?.score ?? null,
      verdict: report?.verdict ?? null,
      blockers: report?.blockers ?? [],
      issues: (report?.issues ?? []).slice(0, 8).map((issue) => ({
        ...issue,
        observed: issue.observed.slice(0, 600),
        suggestion: issue.suggestion.slice(0, 600),
      })),
      issues_omitted: Math.max(0, (report?.issues.length ?? 0) - 8),
      blockers_omitted: 0,
      annotation_diagnostics: report?.annotation_diagnostics
        ? {
            ...report.annotation_diagnostics,
            findings_omitted: Math.max(0, report.annotation_diagnostics.findings.length - 8),
            findings: report.annotation_diagnostics.findings.slice(0, 8).map((f) => ({
              ...f,
              observed: f.observed.slice(0, 600),
              suggestion: f.suggestion.slice(0, 600),
            })),
          }
        : null,
      assessment: report?.assessment ?? null,
      components: report?.components ?? null,
      schema_version: report?.schema_version ?? '1.1',
      visual_feedback: report?.visual_feedback ? summarizeFeedback(report.visual_feedback) : null,
      full_report: row ? `harness://evaluations/${row.id}` : null,
      budget_remaining: this.remaining(taskId),
      artifacts: report
        ? Object.fromEntries(
            Object.entries(report.artifacts)
              .filter(([, v]) => v)
              .map(([k, v]) => [k, `harness://artifacts/${v}`]),
          )
        : {},
      next_action: terminal.has(task.state)
        ? 'stop'
        : task.cancellation_requested_at
          ? 'wait_for_cancellation'
          : processing
            ? 'poll_status'
            : report?.verdict === 'pass'
              ? 'finalize'
              : (report?.next_action ?? 'submit'),
    };
    // Preserve bounded transport even when page text/selectors or failure logs are unusually large.
    while (Buffer.byteLength(JSON.stringify(result)) > 32768) {
      if (result.annotation_diagnostics?.findings.length) {
        result.annotation_diagnostics.findings.pop();
        result.annotation_diagnostics.findings_omitted++;
      } else if (result.issues.length) {
        result.issues.pop();
        result.issues_omitted++;
      } else if (result.visual_feedback?.regions.length) {
        result.visual_feedback.regions.pop();
        result.visual_feedback.regions_omitted++;
      } else if (result.visual_feedback?.comparison) {
        result.visual_feedback.comparison = null;
        result.visual_feedback.comparison_unavailable_reason = 'summary_size_limit';
      } else if (result.blockers.length) {
        result.blockers = result.blockers.slice(0, -1);
        result.blockers_omitted++;
      } else break;
    }
    return result;
  }
  /**
   * 校验最新候选已通过、持久化证据完整，然后正式结束任务。
   * 只确认采集时页面的验收结果，不重新访问 URL，也不验证源码或未来页面内容。
   */
  async finalizeTask(taskId: string, candidateId: string) {
    const t = this.task(taskId),
      candidate = this.candidate(candidateId);
    if (candidate.task_id !== taskId || candidate.target_url !== t.config.target.url)
      throw Error('candidate_not_deliverable');
    if (t.state !== 'passed' && (terminal.has(t.state) || t.cancellation_requested_at))
      throw Error('task_terminal');
    if (t.latest_candidate !== candidateId) throw Error('candidate_not_latest');
    if (
      this.store.get(
        "SELECT id FROM evaluations WHERE task_id=? AND state IN ('queued','capturing','comparing','testing')",
        taskId,
      )
    )
      throw Error('evaluation_conflict');
    const e = this.store.get(
      "SELECT id,report FROM evaluations WHERE task_id=? AND candidate_id=? AND state='completed' ORDER BY created_at DESC LIMIT 1",
      taskId,
      candidateId,
    );
    if (!e || Report.parse(JSON.parse(e.report)).verdict !== 'pass')
      throw Error('candidate_not_passed');
    const report = Report.parse(JSON.parse(e.report));
    if (
      report.target_url !== t.config.target.url ||
      report.evidence_scope !== 'captured_page' ||
      !report.artifacts.actual
    )
      throw Error('candidate_evidence_missing');
    // Validate persisted evidence, not the current (mutable) page or a source/build version.
    for (const artifactId of Object.values(report.artifacts))
      if (artifactId) await this.artifacts.read(this.getArtifact(artifactId));
    if (t.state !== 'passed')
      this.store.transaction(() => {
        const current = this.task(taskId);
        if (current.cancellation_requested_at || terminal.has(current.state))
          throw Error('task_terminal');
        if (
          current.latest_candidate !== candidateId ||
          this.store.get(
            "SELECT id FROM evaluations WHERE task_id=? AND state IN ('queued','capturing','comparing','testing')",
            taskId,
          )
        )
          throw Error('evaluation_conflict');
        this.store.run(
          "UPDATE tasks SET state='passed',final_candidate=? WHERE id=?",
          candidateId,
          taskId,
        );
        this.store.event(taskId, 'task_finalized', {
          candidate_id: candidateId,
          evaluation_id: e.id,
          evidence_scope: 'captured_page',
        });
      });
    return {
      task_id: taskId,
      state: 'passed',
      candidate_id: candidateId,
      evaluation_id: e.id,
      target_url: report.target_url,
      evidence_scope: 'captured_page',
      actual: `harness://artifacts/${report.artifacts.actual}`,
      actual_sha256: this.getArtifact(report.artifacts.actual).sha256,
    };
  }
  /**
   * 领取一个排队或租约过期的作业，续租并使用 fence_token 防止重复提交结果。
   * 执行 perform，处理取消/超时/失败，保存证据和报告后更新任务状态。
   */
  async runNext(signal?: AbortSignal) {
    const job = this.store.transaction(() => {
      const j = this.store.get<JobRow>(
        "SELECT j.*,e.task_id,e.candidate_id FROM jobs j JOIN evaluations e ON e.id=j.evaluation_id WHERE j.state='queued' OR (j.state='running' AND j.lease_until<?) ORDER BY e.created_at LIMIT 1",
        Date.now(),
      );
      if (!j) return null;
      this.store.run(
        "UPDATE jobs SET state='running',lease_until=?,fence_token=fence_token+1,attempt=attempt+1 WHERE id=?",
        Date.now() + 15000,
        j.id,
      );
      this.store.run(
        "UPDATE evaluations SET state='capturing',error=NULL WHERE id=?",
        j.evaluation_id,
      );
      return { ...j, fence_token: j.fence_token + 1, attempt: j.attempt + 1 };
    });
    if (!job) return false;
    const controller = new AbortController(),
      task = this.task(job.task_id),
      remaining = this.remaining(task.id);
    const combined = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(Math.max(1, Math.floor(remaining.wall_seconds * 1000))),
    ]);
    // 执行期间续租并检查取消请求，防止工作已被其他 worker 接管后继续写入结果。
    const pulse = setInterval(() => {
      try {
        const t = this.task(task.id);
        if (t.cancellation_requested_at) controller.abort(Error('cancelled'));
        const renewed = this.store.run(
          "UPDATE jobs SET lease_until=? WHERE id=? AND fence_token=? AND state='running'",
          Date.now() + 15000,
          job.id,
          job.fence_token,
        );
        if (!renewed.changes) controller.abort(Error('lease_lost'));
      } catch {
        controller.abort(Error('lease_lost'));
      }
    }, 1000);
    let report: EvaluationReport;
    // 只有仍持有本次 fence_token 的 worker 能保存报告。
    const owns = () =>
      !!this.store.get(
        "SELECT id FROM jobs WHERE id=? AND fence_token=? AND state='running'",
        job.id,
        job.fence_token,
      );
    try {
      if (task.cancellation_requested_at) controller.abort(Error('cancelled'));
      combined.throwIfAborted();
      if (job.attempt > 3) throw Error('worker_retry_exhausted');
      report = await this.perform(job.evaluation_id, combined, (state) => {
        if (!owns()) throw Error('lease_lost');
        this.store.run('UPDATE evaluations SET state=? WHERE id=?', state, job.evaluation_id);
      });
    } catch (error) {
      const message = this.task(task.id).cancellation_requested_at
        ? 'cancelled'
        : combined.aborted && this.remaining(task.id).wall_seconds === 0
          ? 'budget_exhausted'
          : error instanceof Error
            ? error.message
            : 'evaluation_failed';
      report = this.failureReport(job.evaluation_id, message);
    } finally {
      clearInterval(pulse);
    }
    if (!owns()) return true;
    // Artifact first, state second. A crash leaves an unreferenced immutable file, never a partial report.
    const saved = await this.artifact(JSON.stringify(report, null, 2), 'json');
    this.store.transaction(() => {
      if (!owns()) return;
      this.store.run(
        'UPDATE evaluations SET state=?,report=?,error=? WHERE id=?',
        report.status,
        JSON.stringify(report),
        report.status === 'completed' ? null : report.blockers.join(';'),
        job.evaluation_id,
      );
      this.store.run(
        "UPDATE jobs SET state='done',lease_until=NULL WHERE id=? AND fence_token=?",
        job.id,
        job.fence_token,
      );
      for (const issue of [...report.issues, ...(report.annotation_diagnostics?.findings ?? [])])
        this.store.run(
          'INSERT OR REPLACE INTO issues(id,evaluation_id,json) VALUES(?,?,?)',
          issue.issue_id,
          job.evaluation_id,
          JSON.stringify(issue),
        );
      this.afterEvaluation(task.id, report);
      this.store.event(task.id, 'evaluation_finished', {
        evaluation_id: job.evaluation_id,
        report_artifact: saved.artifact_id,
        status: report.status,
      });
    });
    return true;
  }
  /**
   * 构造本轮报告共有的任务、参考图、URL、环境占位和预算信息。
   */
  private base(evaluationId: string) {
    const e = this.store.get('SELECT * FROM evaluations WHERE id=?', evaluationId)!;
    const t = this.task(e.task_id),
      c = this.candidate(e.candidate_id);
    return {
      schema_version: '1.1' as const,
      visual_feedback: unavailableFeedback('not_generated'),
      task_id: t.id as string,
      evaluation_id: evaluationId,
      candidate_id: c.id as string,
      profile_id: t.config.profile.profile_id,
      reference_sha256: t.reference_hash as string,
      profile_sha256: hash(JSON.stringify(t.config.profile)),
      target_url: t.config.target.url,
      evidence_scope: 'captured_page' as const,
      evaluator_version: 'leeway-0.1.0' as const,
      status: 'completed' as const,
      artifacts: {
        reference: t.reference_artifact as string,
        ...(t.config.annotation_evidence
          ? {
              annotations: t.config.annotation_evidence.reference,
              bindings: t.config.annotation_evidence.bindings,
              annotation_preview: t.config.annotation_evidence.preview,
              annotation_manifest: t.config.annotation_evidence.manifest,
            }
          : {}),
      },
      environment: null,
      region_metrics: [],
      budget_remaining: this.remaining(t.id),
    };
  }
  /**
   * 把采集或运行异常转换为无评分的失败报告，提供错误证据与下一步检查方向。
   */
  private failureReport(evaluationId: string, error: string): EvaluationReport {
    return Report.parse({
      ...this.base(evaluationId),
      schema_version: '1.1',
      visual_feedback: unavailableFeedback('evaluation_failed'),
      status: error === 'cancelled' ? 'cancelled' : 'failed',
      verdict: 'review_required',
      score: null,
      components: null,
      metrics: null,
      blockers: [error],
      issues: [
        {
          issue_id: 'failure',
          kind: error.includes('dimension')
            ? 'dimension'
            : error.includes('unstable')
              ? 'unstable_capture'
              : 'runtime',
          severity: 'high',
          observed: error,
          suggestion: '检查目标URL是否可访问、页面状态和采集配置后重试',
          suggestion_kind: 'hypothesis',
          evidence_artifact_ids: [],
        },
      ],
      next_action:
        error === 'cancelled' || error === 'budget_exhausted' ? 'stop' : 'inspect_failure',
    });
  }
  /**
   * 执行一轮实际评测：连接 URL 采集 → 像素/SSIM 比较 → 评分与阻断检查 → 差异图和趋势。
   * 返回完整报告，由 runNext 负责持久化及任务状态更新。
   */
  private async perform(evaluationId: string, signal: AbortSignal, state: (s: string) => void) {
    const base = this.base(evaluationId),
      task = this.task(base.task_id),
      config = task.config,
      candidate = this.candidate(base.candidate_id);
    const url = config.target.url;
    state('capturing');
    // 先获取稳定页面截图及运行时证据，采集超时与整个任务取消信号共同生效。
    const captured = await capture(
      config,
      url,
      AbortSignal.any([
        signal,
        AbortSignal.timeout(config.capture_timeout_ms * (config.required_checks.length + 3)),
      ]),
      () => state('testing'),
    );
    state('comparing');
    const actual = await this.artifact(captured.png, 'png'),
      dom = await this.artifact(JSON.stringify({ ...captured, png: undefined }), 'json');
    const reference = this.getArtifact(task.reference_artifact),
      refImage = await normalizeImage(await this.artifacts.read(reference)),
      actualImage = await normalizeImage(captured.png);
    // 两条图像指标独立计算：pixelmatch 定位像素差异，SSIM 衡量局部结构相似度。
    const pixels = pixelCompare(refImage, actualImage, config.profile),
      structure = await ssim(this.artifacts.root, reference, actual, config.profile, signal);
    const encode = (data: Buffer) =>
      sharp(data, { raw: { width: refImage.width, height: refImage.height, channels: 4 } })
        .png()
        .toBuffer();
    const diff = await this.artifact(await encode(pixels.diff), 'png'),
      strictDiff = await this.artifact(await encode(pixels.strict), 'png');
    // 汇总分数与阻断条件；随后关键区域像素检查也可阻止通过。
    const report = scoreReport(
      config,
      {
        ...base,
        environment: captured.environment,
        artifacts: {
          ...base.artifacts,
          reference: task.reference_artifact,
          actual: actual.artifact_id,
          diff: diff.artifact_id,
          strict_diff: strictDiff.artifact_id,
          dom: dom.artifact_id,
        },
        budget_remaining: this.remaining(task.id),
      },
      pixels,
      structure,
      captured,
      refImage.width,
      refImage.height,
    );
    report.region_metrics = regionPixels(refImage, actualImage, config.regions, config.profile);
    for (const metric of report.region_metrics) {
      const region = config.regions.find((r) => r.region_id === metric.region_id)!;
      if (
        region.usage !== 'diagnostic' &&
        region.critical &&
        metric.pixel_score < config.profile.critical_threshold
      ) {
        report.blockers.push(`critical_pixels:${region.region_id}`);
        report.issues.push({
          issue_id: `pixels_${region.region_id}`,
          kind: 'pixel',
          severity: 'high',
          region_id: region.region_id,
          reference_bbox_px: region.bbox,
          observed: `该区域差异像素 ${(metric.difference_ratio * 100).toFixed(2)}%`,
          suggestion: '检查该区域的文字、颜色与图片素材',
          suggestion_kind: 'hypothesis',
          evidence_artifact_ids: [],
        });
      }
    }
    if (report.verdict === 'pass' && report.blockers.length) {
      report.verdict = 'needs_revision';
      report.next_action = 'revise_and_evaluate';
    }
    for (const issue of [...report.issues, ...(report.annotation_diagnostics?.findings ?? [])])
      issue.evidence_artifact_ids = [actual.artifact_id, diff.artifact_id, dom.artifact_id];
    const previousRow = this.store.get(
      "SELECT report FROM evaluations WHERE task_id=? AND state='completed' AND id<>? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      task.id,
      evaluationId,
    );
    let previous:
      | { report: EvaluationReport; actual: Awaited<ReturnType<typeof normalizeImage>> }
      | undefined;
    if (previousRow) {
      const older = Report.parse(JSON.parse(previousRow.report));
      if (older.artifacts.actual)
        previous = {
          report: older,
          actual: await normalizeImage(
            await this.artifacts.read(this.getArtifact(older.artifacts.actual)),
          ),
        };
    }
    report.schema_version = '1.1';
    report.visual_feedback = await buildFeedback({
      reference: refImage,
      actual: actualImage,
      pixels,
      config,
      report,
      dom: captured.dom_evidence,
      previous,
      put: async (bytes) => (await this.artifact(bytes, 'png')).artifact_id,
    });
    return Report.parse(report);
  }
  /**
   * 根据验收结论、预算、取消和连续改善情况更新任务状态，并记录可比较的最佳合格候选。
   * 评测通过后仍需 finalize，才把任务标记为正式完成。
   */
  private afterEvaluation(taskId: string, report: EvaluationReport) {
    const t = this.task(taskId),
      budget = this.remaining(taskId);
    let state = 'awaiting_agent';
    if (t.cancellation_requested_at) state = 'cancelled';
    else if (report.verdict === 'pass') state = 'active';
    else if (!budget.iterations || !budget.wall_seconds) state = 'budget_exhausted';
    else if (report.blockers.includes('worker_retry_exhausted')) state = 'failed';
    else {
      const history = this.store
        .all(
          "SELECT report FROM evaluations WHERE task_id=? AND state='completed' ORDER BY created_at DESC LIMIT ?",
          taskId,
          t.config.profile.stall_window,
        )
        .map((e) => Report.parse(JSON.parse(e.report)));
      if (
        history.length === t.config.profile.stall_window &&
        history.every(
          (r) =>
            r.score &&
            r.assessment?.main_score_basis === report.assessment?.main_score_basis &&
            r.environment?.fingerprint === report.environment?.fingerprint,
        ) &&
        Math.max(...history.map((r) => r.score!.value)) -
          Math.min(...history.map((r) => r.score!.value)) <
          t.config.profile.min_improvement
      )
        state = 'stalled';
    }
    if (report.score && !report.blockers.length) {
      const best = t.best_candidate
        ? this.store.get(
            "SELECT report FROM evaluations WHERE candidate_id=? AND state='completed' ORDER BY created_at DESC LIMIT 1",
            t.best_candidate,
          )
        : null;
      const previous = best ? Report.parse(JSON.parse(best.report)) : null;
      if (
        !previous ||
        (previous.environment?.fingerprint === report.environment?.fingerprint &&
          report.score.value > (previous.score?.value ?? -1))
      )
        this.store.run('UPDATE tasks SET best_candidate=? WHERE id=?', report.candidate_id, taskId);
    }
    this.store.run('UPDATE tasks SET state=? WHERE id=?', state, taskId);
  }
  /**
   * 关闭本实例的数据库连接；调用方应先结束正在执行的 worker。
   */
  close() {
    this.store.close();
  }
}
