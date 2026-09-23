import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EvaluationReport } from '../../../packages/contracts/src/index.js';
import './style.css';
type Evaluation = {
  evaluation_id: string;
  candidate_id: string;
  state: string;
  report: EvaluationReport | null;
};
type Status = {
  task_id: string;
  state: string;
  best_candidate: string | null;
  final_candidate: string | null;
  budget_remaining: { iterations: number; wall_seconds: number };
  evaluations: Evaluation[];
};
const imageUrl = (id: string) => `/api/artifact/${id}`;
function App() {
  const [tasks, setTasks] = useState<{ id: string; state: string }[]>([]),
    [taskId, setTaskId] = useState(''),
    [task, setTask] = useState<Status | null>(null),
    [selected, setSelected] = useState(''),
    [view, setView] = useState<'reference' | 'actual' | 'diff' | 'strict_diff'>('diff'),
    [boxes, setBoxes] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const response = await fetch('/api/tasks');
        if (!response.ok) throw Error('无法加载任务');
        const list = await response.json();
        if (!stopped) {
          setTasks(list);
          setTaskId((current) => current || list[0]?.id || '');
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!taskId) return;
    let stopped = false;
    async function refresh() {
      try {
        const response = await fetch(`/api/task/${taskId}`);
        if (!response.ok) throw Error('无法加载评测');
        const data = await response.json();
        if (!stopped) {
          setTask(data);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    }
    setSelected('');
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [taskId]);
  const evaluation =
      task?.evaluations.find((e) => e.evaluation_id === selected) ?? task?.evaluations.at(-1),
    report = evaluation?.report;
  const [size, setSize] = useState({ width: 1, height: 1 });
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          l<span>eeway</span>
          <i>UI CHECK</i>
        </a>
        <div className="nav-label">评测工作台</div>
        <div className="nav-active">◈　视觉还原</div>
        <div className="task-label">任务 / {tasks.length}</div>
        <nav>
          {tasks.map((t, i) => (
            <button
              key={t.id}
              className={t.id === taskId ? 'task selected' : 'task'}
              onClick={() => setTaskId(t.id)}
            >
              <strong>评测任务 {String(tasks.length - i).padStart(2, '0')}</strong>
              <span>
                {t.id.slice(-12)} · {t.state}
              </span>
            </button>
          ))}
        </nav>
        <footer>
          <span className="dot" /> 本地证据 · 独立评测
          <br />
          <small>Leeway Harness / v0.1</small>
        </footer>
      </aside>
      <main>
        <header>
          <div>
            <div className="eyebrow">VISUAL FIDELITY / EVIDENCE WORKSPACE</div>
            <h1>
              每一处差异，都有依据<span className="badge">{task?.state ?? '等待任务'}</span>
            </h1>
            <p>对照截图、定位问题，查看每轮候选的真实评测结果。</p>
          </div>
          <span className="local">● LOCAL</span>
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {!tasks.length ? (
          <section className="empty">
            <h2>从第一张参考截图开始</h2>
            <p>创建任务并启动 worker 后，截图与评测证据会显示在这里。</p>
            <code>npm run demo</code>
          </section>
        ) : (
          <>
            <section className="stats">
              <article>
                <label>视觉评分</label>
                <div className="score">
                  {report?.score ? report.score.value.toFixed(1) : '—'}
                  <small> / 100</small>
                </div>
                <span>{report?.score?.calibrated ? '已校准配置' : '诊断分 · 尚未校准'}</span>
              </article>
              <article>
                <label>差异像素比例</label>
                <div>
                  {report?.metrics ? (report.metrics.difference_ratio * 100).toFixed(2) + '%' : '—'}
                </div>
                <span>相同尺寸 · 固定比较参数</span>
              </article>
              <article>
                <label>待处理阻断</label>
                <div>
                  {report?.blockers.length ?? '—'}
                  <small> 项</small>
                </div>
                <span>{report?.verdict ?? evaluation?.state ?? '等待评测'}</span>
              </article>
              <article>
                <label>剩余评测预算</label>
                <div>
                  {task?.budget_remaining.iterations ?? '—'}
                  <small> 轮</small>
                </div>
                <span>{Math.ceil(task?.budget_remaining.wall_seconds ?? 0)} 秒可用</span>
              </article>
            </section>
            {report?.blockers.includes('profile_not_validated') && (
              <div className="notice">
                ⓘ　当前配置用于诊断。即使显示 90 分以上，也不会被判定为正式通过。
              </div>
            )}
            <div className="workspace">
              <section className="canvas-panel">
                <div className="panel-top">
                  <div className="tabs">
                    {(['reference', 'actual', 'diff', 'strict_diff'] as const).map((key, i) => (
                      <button
                        key={key}
                        aria-pressed={key === view}
                        className={key === view ? 'active' : ''}
                        onClick={() => setView(key)}
                      >
                        {['参考图', '当前截图', '差异图', '严格差异'][i]}
                      </button>
                    ))}
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={boxes}
                      onChange={(e) => setBoxes(e.target.checked)}
                    />{' '}
                    区域标记
                  </label>
                </div>
                <div className="canvas">
                  {report?.artifacts[view] ? (
                    <div className="image-wrap">
                      <img
                        alt={
                          {
                            reference: '参考图',
                            actual: '当前截图',
                            diff: '差异图',
                            strict_diff: '严格差异图',
                          }[view]
                        }
                        src={imageUrl(report.artifacts[view]!)}
                        onLoad={(e) =>
                          setSize({
                            width: e.currentTarget.naturalWidth,
                            height: e.currentTarget.naturalHeight,
                          })
                        }
                      />
                      {boxes &&
                        report.issues
                          .filter((i) => i.reference_bbox_px)
                          .map((issue) => {
                            const r =
                              (view === 'actual'
                                ? issue.actual_bbox_px
                                : issue.reference_bbox_px) ?? issue.reference_bbox_px!;
                            return (
                              <div
                                key={issue.issue_id}
                                title={issue.observed}
                                className="region"
                                style={{
                                  left: `${(r.x / size.width) * 100}%`,
                                  top: `${(r.y / size.height) * 100}%`,
                                  width: `${(r.width / size.width) * 100}%`,
                                  height: `${(r.height / size.height) * 100}%`,
                                }}
                              />
                            );
                          })}
                    </div>
                  ) : (
                    <div className="empty">
                      <h3>{evaluation?.state ?? '尚无截图'}</h3>
                      <p>采集失败或未完成时不生成虚假分数。</p>
                    </div>
                  )}
                </div>
                <div className="canvas-foot">
                  <span>{report?.environment?.platform ?? '环境待采集'}</span>
                  <span>
                    {report?.environment ? 'Chromium ' + report.environment.chromium : ''}
                  </span>
                </div>
              </section>
              <section className="findings">
                <div className="section-title">
                  <h2>修复线索</h2>
                  <span>{report?.issues.length ?? 0}</span>
                </div>
                {report?.issues.map((issue) => (
                  <article key={issue.issue_id} className="finding">
                    <div>
                      <span className={'severity ' + issue.severity}>
                        {issue.severity === 'high' ? '优先处理' : '差异'}
                      </span>
                      <small>{issue.kind}</small>
                    </div>
                    <h3>{issue.region_id ?? issue.issue_id}</h3>
                    <p>{issue.observed}</p>
                    <div className="suggestion">建议核查：{issue.suggestion}</div>
                  </article>
                ))}
                {!report?.issues.length && (
                  <p className="muted">
                    {report ? '暂无可定位问题，请查看下方阻断原因。' : '评测完成后显示问题。'}
                  </p>
                )}
                <div className="blockers">
                  {report?.blockers.map((b) => (
                    <div key={b}>{b}</div>
                  ))}
                </div>
              </section>
            </div>
            {report?.visual_feedback && (
              <section className="history">
                <div className="section-title">
                  <h2>差异区域与实际元素</h2>
                  <span>{report.visual_feedback.regions_total} 个区域</span>
                </div>
                <p className="muted">
                  区域表示像素差异范围；DOM 与样式是实现侧证据，不代表错误根因。
                </p>
                {report.visual_feedback.comparison ? (
                  <p>
                    与上一轮相比：差异像素比例变化{' '}
                    {(report.visual_feedback.comparison.difference_ratio_delta * 100).toFixed(2)}{' '}
                    个百分点；评分变化{' '}
                    {report.visual_feedback.comparison.score_delta?.toFixed(2) ?? '不可比较'}。
                  </p>
                ) : (
                  <p className="muted">
                    暂无可比较趋势：{report.visual_feedback.comparison_unavailable_reason}
                  </p>
                )}
                {report.visual_feedback.regions.slice(0, 5).map((region) => (
                  <article className="finding" key={region.difference_id}>
                    <h3>
                      {region.difference_id} · {region.observed}
                    </h3>
                    <p>
                      位置 ({region.bbox_px.x}, {region.bbox_px.y})，{region.bbox_px.width} ×{' '}
                      {region.bbox_px.height}px，差异 {(region.difference_ratio * 100).toFixed(2)}%
                    </p>
                    {region.crops && (
                      <div className="crop-grid">
                        {(['reference', 'actual', 'diff'] as const).map((key, i) => (
                          <figure key={key}>
                            <figcaption>{['参考区域', '当前区域', '区域差异'][i]}</figcaption>
                            <a href={imageUrl(region.crops![key])} target="_blank" rel="noreferrer">
                              <img
                                loading="lazy"
                                alt={`${region.difference_id} ${key}`}
                                src={imageUrl(region.crops![key])}
                              />
                            </a>
                          </figure>
                        ))}
                      </div>
                    )}
                    {region.dom_candidates.map((element, i) => (
                      <details key={i}>
                        <summary>
                          {element.selector ?? element.tag} · 区域覆盖{' '}
                          {(element.region_coverage * 100).toFixed(0)}%
                        </summary>
                        <p>{element.text_excerpt}</p>
                        <pre>{JSON.stringify(element.actual_styles, null, 2)}</pre>
                      </details>
                    ))}
                  </article>
                ))}
                {report.visual_feedback.regions_total > 5 && (
                  <p className="muted">其余区域保存在完整报告中。</p>
                )}
              </section>
            )}
            <section className="history">
              <div className="section-title">
                <h2>候选历史</h2>
                <span>同一参考 · 同一评分配置</span>
              </div>
              <div className="history-list">
                {task?.evaluations.map((e, i) => (
                  <button
                    className={
                      e.evaluation_id === evaluation?.evaluation_id
                        ? 'history-item current'
                        : 'history-item'
                    }
                    key={e.evaluation_id}
                    onClick={() => setSelected(e.evaluation_id)}
                  >
                    <span>第 {i + 1} 轮</span>
                    <strong>{e.report?.score?.value.toFixed(1) ?? '—'}</strong>
                    <div className="bar">
                      <i style={{ width: `${e.report?.score?.value ?? 0}%` }} />
                    </div>
                    <small>
                      {e.report?.verdict ?? e.state}
                      {task.best_candidate === e.candidate_id ? ' · 最佳' : ''}
                      {task.final_candidate === e.candidate_id ? ' · 已交付' : ''}
                    </small>
                  </button>
                ))}
              </div>
            </section>
            {report && (
              <div className="metadata">
                <span>
                  候选 {report.candidate_id.slice(-12)} · {report.profile_id}
                </span>
                <a
                  href={imageUrl(report.artifacts.dom ?? report.artifacts.reference)}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看原始证据 ↗
                </a>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
