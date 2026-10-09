# 架构与执行流程

Harness 只评测已运行的 Web URL。项目构建、启动、代码修改和服务更新由 Codex 或开发者负责。

```text
Codex 启动并更新目标项目 → 可访问的 URL
                               ↓
CLI / MCP → UiWorkflow → TaskService → SQLite 评测队列
                               ↓ 内置/独立 worker
URL → Playwright 截图/DOM/交互 → 像素/SSIM/布局/文字
                               ↓
Report + ArtifactStore → Agent 读取差异图后修改并更新页面
```

Task 固定参考图与验收条件；Candidate 标识一轮 URL 页面采集候选；Evaluation 记录一次评测；Artifact 保存截图、差异图、DOM 与报告。

| 文件或目录                                  | 职责                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| packages/mcp/src/index.ts                   | stdio 服务连接和内置 worker                                                                      |
| packages/mcp/src/server.ts                  | 五工具、instructions/outputSchema、图像及报告资源                                                |
| packages/core/src/workflow/facade.ts        | 五操作共享合同和业务分发，CLI/MCP 共用                                                           |
| packages/core/src/tasks/service.ts          | createTask → submitCandidate → runNext/perform → afterEvaluation → agentStatus → finalize/cancel |
| packages/core/src/capture                   | 连接 URL、页面稳定性、截图、DOM、交互、响应式探针                                                |
| packages/core/src/compare                   | sharp/pixelmatch 图像比较和 Python SSIM                                                          |
| packages/core/src/scoring                   | 标注几何/文字、权重汇总与阻断条件                                                                |
| packages/core/src/regions                   | 差异区域、局部裁剪图、运行时 DOM 关联和轮次变化                                                  |
| packages/core/src/storage                   | SQLite 状态和不可变文件证据                                                                      |
| packages/core/src/runtime/subprocess.ts     | 仅用于执行 Harness 自身的 SSIM Python 子进程                                                     |
| packages/codex/src                          | Skill/hook 安装、聊天绑定、Stop 续执行和 Interrupt                                               |
| packages/cli/src/index.ts                   | 同名五工具适配；worker/report/import-evidence 运维入口                                           |
| packages/core/src/reports + apps/report-web | 本地只读报告服务                                                                                 |
| workers/ssim_worker.py                      | scikit-image SSIM 计算                                                                           |
| scripts/fixtures.ts                         | 测试/演示侧启动独立 HTTP 页面，非 Harness 目标启动能力                                           |

submit 在短文件锁内去重登记。新实现使用新 request_id，重试复用原 ID。worker 通过租约和 fence 控制提交权，等待超时不取消评测。

正式通过要求得分满足阈值、无阻断、已验证 profile。finalize 确认最新候选的持久化报告和证据，返回 evaluation_id、target_url、截图 URI/哈希、evidence_scope=captured_page。验收范围是采集时的页面效果。

数据保存在 HARNESS_HOME 下的 SQLite 与证据目录。Candidate 表保存 ID、任务、状态、目标 URL 和创建时间；报告使用 schema_version=1.1。
