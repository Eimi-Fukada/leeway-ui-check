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

Task 是冻结参考图与验收条件的任务；Candidate 是一轮 URL 页面采集候选，不是源码快照；Evaluation 是一次评测；Artifact 是截图、差异图、DOM 与报告。

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

源码扫描、目标 build/serve、项目识别、源码区域建议、Controller 编码程序循环和目标进程监督器已移除。

submit 在短文件锁内去重登记。新实现使用新 request_id，重试复用原 ID。worker 通过租约和 fence 控制提交权，等待超时不取消评测。

正式通过仍要求得分满足阈值、无阻断、已验证 profile。finalize 确认最新候选的持久化报告和证据，返回 evaluation_id、target_url、截图 URI/哈希、evidence_scope=captured_page。不重新访问动态 URL，不证明当前或未来页面、源码提交、构建产物对应截图。

历史报告保留旧 source_manifest_hash/build_manifest_hash 字段；新报告均为 null。数据库暂保留旧列用于兼容已有存储，新候选不记录源码清单。旧 workspace 任务不会继续执行，需用 URL 新建任务；历史报告及图片资源仍可读取。
