# 架构与执行流程

本页说明当前实现。安装和操作见 [使用指南](usage.md)。

反馈规则与实现边界见 [视觉反馈设计](visual-feedback-design.md)。它已接入差异定位、局部图像、DOM关联与前后轮比较；不改变现有评分Gate。

```text
CLI / MCP → TaskService → 工作区 manifest → SQLite评测队列
                                      ↓ 独立worker领取
构建并启动 → Playwright截图/DOM/交互 → 像素/SSIM/布局/文字
                                      ↓
                        Report + ArtifactStore → Agent读取后修改源码
```

Task 是固定要求的一次任务；Candidate 是某一轮源码 manifest；Evaluation 是对该工作区版本的检查；Artifact 是截图、差异图、DOM、日志等证据文件。

| 文件或目录                                  | 职责                                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| packages/cli/src/index.ts                   | 终端命令入口、worker循环、报告服务入口                            |
| packages/mcp/src/server.ts                  | Agent五工具与owner十工具、资源读取；提交只等待，不执行队列        |
| packages/contracts/src/index.ts             | Zod运行时合同、类型、默认配置                                     |
| packages/core/src/tasks/service.ts          | 创建任务、工作区版本登记、去重、队列租约、单轮评测、取消和交付    |
| packages/core/src/candidates                | 受管进程启动、日志及进程树清理                                    |
| packages/core/src/workspace/manifest.ts     | 记录工作区文件清单/hash，不复制源码                               |
| packages/core/src/capture                   | 截图稳定性、标注DOM数据、交互、基础响应式探测                     |
| packages/core/src/compare                   | sharp/pixelmatch、Python SSIM调用                                 |
| packages/core/src/scoring                   | 几何与文字计算、四项加权、阻断；关键区域像素阻断还在TaskService中 |
| packages/core/src/storage                   | SQLite状态与文件证据                                              |
| packages/core/src/controller                | 可选外部编码程序循环及策略提示，不是MCP必经步骤                   |
| packages/core/src/project                   | 从依赖和固定路径给出框架/入口建议                                 |
| packages/core/src/regions                   | 根目录HTML正则候选；OCR/视觉为未配置占位                          |
| packages/core/src/sandbox                   | 策略字段与环境变量，目前没有OS隔离                                |
| packages/core/src/reports + apps/report-web | 本地只读HTTP服务与React报告页                                     |
| workers/ssim_worker.py                      | scikit-image structural_similarity计算                            |
| workers/service_supervisor.mjs              | 父进程退出时回收页面服务                                          |
| scripts/schemas.ts                          | 导出JSON Schema，不负责传输报告                                   |

提交在短文件锁内串行冻结源码，数据库事务不跨文件IO。相同request_id复用已排队评测。MCP进程内部 worker 通过租约和fence控制提交权；等待超时不会取消评测。进程异常退出留下的提交锁采用显式人工恢复，见 [FAQ](faq.md)。

正式通过需要得分满足阈值、无阻断、已验证profile及可验证来源。finalize再次核对源码和构建产物。当前best_candidate仅从无阻断的结果中选取，不代表所有失败尝试中最高分的版本。
