import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
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
import { snapshot, manifest } from '../candidates/snapshot.js';
import { launch, runCommand } from '../candidates/process.js';
import { capture } from '../capture/runner.js';
import { scoreReport } from '../scoring/evaluate.js';
import { sandboxEnvironment } from '../sandbox/policy.js';

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
export const defaultRoot = () =>
  process.env.HARNESS_HOME ?? path.join(os.homedir(), '.leeway-ui-check');
export class TaskService {
  readonly store: Store;
  readonly artifacts: ArtifactStore;
  constructor(readonly root = defaultRoot()) {
    this.root = path.resolve(root);
    this.store = new Store(this.root);
    this.artifacts = new ArtifactStore(path.join(this.root, 'artifacts'));
  }
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
  getArtifact(artifactId: string) {
    const a = this.store.get('SELECT * FROM artifacts WHERE id=?', artifactId);
    if (!a) throw Error('artifact_not_found');
    return a as { id: string; sha256: string; path: string; media_type: string };
  }
  task(taskId: string) {
    const row = this.store.get<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId);
    if (!row) throw Error('task_not_found');
    return { ...row, config: TaskInput.parse(JSON.parse(row.config)) };
  }
  async createTask(input: unknown) {
    const config = TaskInput.parse(input);
    if (config.profile.status === 'retired') throw Error('profile_retired');
    if (config.target.mode === 'managed')
      config.target.source_dir = path.resolve(config.target.source_dir);
    // Validation documents must already be imported by the owner into this store.
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
    for (const r of [...config.regions.map((r) => r.bbox), ...config.profile.masks])
      if (r.x + r.width > width || r.y + r.height > height)
        throw Error('reference_bbox_out_of_bounds');
    for (const region of config.regions.filter((r) => r.critical))
      for (const mask of config.profile.masks) {
        const b = region.bbox;
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
  async registerCandidate(taskId: string) {
    const task = this.task(taskId);
    if (terminal.has(task.state) || task.cancellation_requested_at)
      throw Error('task_not_accepting_candidates');
    const target = task.config.target,
      candidateId = id('cand');
    let frozen: { entries: unknown[]; source_hash: string; asset_hash: string; build_hash: string };
    let snapshotPath: string | null = null;
    if (target.mode === 'managed') {
      snapshotPath = path.join(this.root, 'snapshots', candidateId);
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      frozen = await snapshot(target.source_dir, snapshotPath, this.root, target);
    } else
      frozen = {
        entries: [],
        source_hash: hash(JSON.stringify(target)),
        asset_hash: hash('[]'),
        build_hash: hash(JSON.stringify(target)),
      };
    this.store.transaction(() => {
      const current = this.task(taskId);
      if (terminal.has(current.state) || current.cancellation_requested_at)
        throw Error('task_not_accepting_candidates');
      this.store.run(
        'INSERT INTO candidates(id,task_id,state,provenance,source_hash,asset_hash,build_hash,snapshot,manifest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        candidateId,
        taskId,
        'ready',
        target.mode === 'managed' ? 'verified' : 'unverified',
        frozen.source_hash,
        frozen.asset_hash,
        frozen.build_hash,
        snapshotPath,
        JSON.stringify(frozen.entries),
        Date.now(),
      );
      this.store.event(taskId, 'candidate_registered', {
        candidate_id: candidateId,
        source_manifest_hash: frozen.source_hash,
      });
    });
    return {
      candidate_id: candidateId,
      provenance: target.mode === 'managed' ? 'verified' : 'unverified',
      source_manifest_hash: frozen.source_hash,
      snapshot_path: snapshotPath,
    };
  }
  candidate(candidateId: string) {
    const c = this.store.get('SELECT * FROM candidates WHERE id=?', candidateId);
    if (!c) throw Error('candidate_not_found');
    return c;
  }
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
      const agent = this.store.get(
        "SELECT id FROM agent_attempts WHERE task_id=? AND state='running'",
        taskId,
      );
      if (!active && !agent)
        this.store.run("UPDATE tasks SET state='cancelled' WHERE id=?", taskId);
      this.store.event(taskId, 'cancellation_requested', {});
    });
    return this.getTaskStatus(taskId);
  }
  async submitCandidate(taskId: string, requestId: string) {
    const candidate = await this.registerCandidate(taskId);
    return {
      ...this.evaluateCandidate(candidate.candidate_id, requestId),
      candidate_id: candidate.candidate_id,
    };
  }
  async submitAndWait(taskId: string, requestId: string, signal = new AbortController().signal) {
    const queued = await this.submitCandidate(taskId, requestId);
    if (!queued.evaluation_id) return this.getTaskStatus(taskId);
    while (true) {
      const result = this.getEvaluation(queued.evaluation_id);
      if (!['queued', 'capturing', 'comparing', 'testing'].includes(result.state)) return result;
      await this.runNext(signal);
    }
  }
  async finalizeTask(taskId: string, candidateId: string) {
    const t = this.task(taskId),
      candidate = this.candidate(candidateId);
    if (t.state === 'passed' && t.final_candidate === candidateId)
      return {
        task_id: taskId,
        state: 'passed',
        candidate_id: candidateId,
        snapshot_path: candidate.snapshot,
      };
    if (terminal.has(t.state) || t.cancellation_requested_at) throw Error('task_terminal');
    if (
      this.store.get(
        "SELECT id FROM evaluations WHERE task_id=? AND state IN ('queued','capturing','comparing','testing')",
        taskId,
      )
    )
      throw Error('evaluation_conflict');
    if (
      candidate.task_id !== taskId ||
      candidate.provenance !== 'verified' ||
      t.config.profile.status !== 'validated'
    )
      throw Error('candidate_not_deliverable');
    const e = this.store.get(
      "SELECT report FROM evaluations WHERE task_id=? AND candidate_id=? AND state='completed' ORDER BY created_at DESC LIMIT 1",
      taskId,
      candidateId,
    );
    if (!e || Report.parse(JSON.parse(e.report)).verdict !== 'pass')
      throw Error('candidate_not_passed');
    const passing = Report.parse(JSON.parse(e.report));
    if (
      !passing.build_manifest_hash ||
      hash(JSON.stringify(await manifest(candidate.snapshot, true))) !== passing.build_manifest_hash
    )
      throw Error('build_artifact_hash_mismatch');
    await this.verifySnapshot(candidate);
    this.store.transaction(() => {
      const current = this.task(taskId);
      if (current.cancellation_requested_at || terminal.has(current.state))
        throw Error('task_terminal');
      this.store.run(
        "UPDATE tasks SET state='passed',final_candidate=? WHERE id=?",
        candidateId,
        taskId,
      );
      this.store.event(taskId, 'task_finalized', { candidate_id: candidateId });
    });
    return {
      task_id: taskId,
      state: 'passed',
      candidate_id: candidateId,
      snapshot_path: candidate.snapshot,
    };
  }
  async verifySnapshot(candidate: Record<string, any>) {
    if (
      candidate.snapshot &&
      hash(JSON.stringify(await manifest(candidate.snapshot))) !== candidate.source_hash
    )
      throw Error('snapshot_hash_mismatch');
  }
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
      for (const issue of report.issues)
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
  private base(evaluationId: string) {
    const e = this.store.get('SELECT * FROM evaluations WHERE id=?', evaluationId)!;
    const t = this.task(e.task_id),
      c = this.candidate(e.candidate_id);
    return {
      schema_version: '1.0' as const,
      task_id: t.id as string,
      evaluation_id: evaluationId,
      candidate_id: c.id as string,
      profile_id: t.config.profile.profile_id,
      reference_sha256: t.reference_hash as string,
      profile_sha256: hash(JSON.stringify(t.config.profile)),
      source_manifest_hash: c.source_hash as string,
      evaluator_version: 'leeway-0.1.0' as const,
      status: 'completed' as const,
      artifacts: { reference: t.reference_artifact as string },
      environment: null,
      build_manifest_hash: null,
      region_metrics: [],
      budget_remaining: this.remaining(t.id),
    };
  }
  private failureReport(evaluationId: string, error: string): EvaluationReport {
    return Report.parse({
      ...this.base(evaluationId),
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
          suggestion: '检查采集环境、候选构建和任务配置后重试',
          suggestion_kind: 'hypothesis',
          evidence_artifact_ids: [],
        },
      ],
      next_action:
        error === 'cancelled' || error === 'budget_exhausted' ? 'stop' : 'inspect_failure',
    });
  }
  private async perform(evaluationId: string, signal: AbortSignal, state: (s: string) => void) {
    const base = this.base(evaluationId),
      task = this.task(base.task_id),
      config = task.config,
      candidate = this.candidate(base.candidate_id);
    await this.verifySnapshot(candidate);
    let url = config.target.mode === 'external' ? config.target.url : '';
    let service: ReturnType<typeof launch> | undefined;
    let buildManifestHash: string | null = null;
    try {
      if (config.target.mode === 'managed') {
        state('capturing');
        this.store.run("UPDATE candidates SET state='building' WHERE id=?", candidate.id);
        for (const command of config.target.build) {
          try {
            const result = await runCommand(command, candidate.snapshot, signal);
            const log = await this.artifact(result.stdout + '\n' + result.stderr, 'txt');
            this.store.event(task.id, 'build_log', {
              candidate_id: candidate.id,
              artifact_id: log.artifact_id,
            });
          } catch (error) {
            throw Error(`build_failed: ${error instanceof Error ? error.message : 'unknown'}`);
          }
        }
        await this.verifySnapshot(candidate);
        buildManifestHash = hash(JSON.stringify(await manifest(candidate.snapshot, true)));
        const buildArtifact = await this.artifact(
          JSON.stringify(await manifest(candidate.snapshot, true)),
          'json',
        );
        this.store.event(task.id, 'build_frozen', {
          candidate_id: candidate.id,
          artifact_id: buildArtifact.artifact_id,
          hash: buildManifestHash,
        });
        const port = await freePort(),
          command = config.target.serve;
        service = launch(
          process.execPath,
          [
            fileURLToPath(new URL('../../../../workers/service_supervisor.mjs', import.meta.url)),
            command.executable,
            ...command.args.map((a) => a.replaceAll('{port}', String(port))),
          ],
          candidate.snapshot,
          signal,
          {
            PORT: String(port),
            HOST: '127.0.0.1',
            NODE_ENV: 'test',
            ...sandboxEnvironment(config.sandbox),
          },
        );
        url = `http://127.0.0.1:${port}${config.target.url_path}`;
        const deadline = Date.now() + config.capture_timeout_ms;
        while (true) {
          signal.throwIfAborted();
          if (service.child.exitCode !== null) throw Error('managed_server_exited');
          try {
            const r = await fetch(url, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
            });
            await r.body?.cancel();
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (Date.now() > deadline) throw Error('server_start_timeout');
            await delay(100, undefined, { signal });
          }
        }
        this.store.run("UPDATE candidates SET state='ready' WHERE id=?", candidate.id);
      }
      const captured = await capture(
        config,
        url,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(config.capture_timeout_ms * (config.required_checks.length + 3)),
        ]),
        () => state('testing'),
      );
      if (service && service.child.exitCode !== null) throw Error('managed_server_exited');
      await this.verifySnapshot(candidate);
      if (
        candidate.snapshot &&
        hash(JSON.stringify(await manifest(candidate.snapshot, true))) !== buildManifestHash
      )
        throw Error('build_artifact_changed_during_capture');
      state('comparing');
      const actual = await this.artifact(captured.png, 'png'),
        dom = await this.artifact(JSON.stringify({ ...captured, png: undefined }), 'json');
      const reference = this.getArtifact(task.reference_artifact),
        refImage = await normalizeImage(await this.artifacts.read(reference)),
        actualImage = await normalizeImage(captured.png);
      const pixels = pixelCompare(refImage, actualImage, config.profile),
        structure = await ssim(this.artifacts.root, reference, actual, config.profile, signal);
      const encode = (data: Buffer) =>
        sharp(data, { raw: { width: refImage.width, height: refImage.height, channels: 4 } })
          .png()
          .toBuffer();
      const diff = await this.artifact(await encode(pixels.diff), 'png'),
        strictDiff = await this.artifact(await encode(pixels.strict), 'png');
      const report = scoreReport(
        config,
        {
          ...base,
          build_manifest_hash: buildManifestHash,
          environment: captured.environment,
          artifacts: {
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
        if (region.critical && metric.pixel_score < config.profile.critical_threshold) {
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
      for (const issue of report.issues)
        issue.evidence_artifact_ids = [actual.artifact_id, diff.artifact_id, dom.artifact_id];
      return Report.parse(report);
    } catch (error) {
      if (config.target.mode === 'managed')
        this.store.run("UPDATE candidates SET state='invalid' WHERE id=?", candidate.id);
      throw error;
    } finally {
      if (service) {
        await service.stop();
        await service.done.catch(() => {});
        const logs = service.logs();
        if (logs.stdout || logs.stderr) {
          const a = await this.artifact(logs.stdout + '\n' + logs.stderr, 'txt');
          this.store.event(task.id, 'server_log', { artifact_id: a.artifact_id });
        }
      }
    }
  }
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
          (r) => r.score && r.environment?.fingerprint === report.environment?.fingerprint,
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
  close() {
    this.store.close();
  }
}
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
