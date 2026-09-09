# 实施状态与验收边界

当前版本：v0.1。下表区分已实现能力与仍需验证的工作。

| 阶段 | 当前实现                                                                                                                       | 尚需正式验收 / 补齐                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| H0   | 固定依赖与 Chromium；sharp sRGB/alpha/EXIF；严格/tolerance 差异；CLI；稳定采样                                                 | 多机器字体/OS 噪声基线与受控容器镜像                                        |
| H1   | Task/Region/Profile 严格合同；不可变参考与配置；几何/文字/关键区域像素；DOM 工件；16px 定位                                    | role+text 匹配、邻接间距专用指标、参考区域可视化编辑                        |
| H2   | 受管 scikit-image worker；文字/交互/运行时 Gate；严重错误变体集；provisional 阻止正式通过                                      | 5–10 类页面的人工排序、独立 heldout、阈值校准、正式 validated profile       |
| H3   | SQLite WAL/外键/事件/队列；单任务唯一评测；request 去重；lease/fence；独立 worker；MCP structuredContent/resources；只读报告页 | 多进程断电/故障注入压测、孤立工件自动回收、完整错误分类、远程鉴权（首版外） |
| H4   | CodingAgentAdapter 接口、命令适配器、有界 Controller；确定性适配器真实两轮源码修改/评测                                        | 真实编码工具专用非交互适配与真实模型两轮验收、Agent 崩溃恢复与隔离          |
| H5   | 同配置/环境最佳候选保留；历史证据；finalize 源码和构建产物 hash 复核；只交付快照                                               | 多类别真实任务最佳版本交付演练、用户要求的受控恢复功能                      |

## 已采用的工程决策

- 服务型 worker 与 stdio MCP 分离，MCP 断开不会带走评测。启动两个进程是有意设计。
- 无正式校准证据时，不提供可通过的默认配置。测试中的 validated 配置只验证状态机，不是产品校准证明。
- 稳定采集要求连续 3 次相邻比较满足容差（共至少 4 张），采样间隔作固定错位，降低周期动画同相采样风险。无法证明任意 JS/WebGL 动画完全静止，应用仍需测试 hook。
- SSIM 固定 uint8 RGB / data_range=255 / channel_axis=2 / sample covariance。mask 同时从像素分母及 SSIM 邻域剔除；窗口太小或没有有效像素明确失败。
- 参考 geometry 由人工提供。截图不被当作真实 CSS/DOM 真值；建议只标注为 hypothesis。
- 源码快照创建前后比对 manifest，评测前后复核。构建产物在启动前记录、截图后复核、交付前复核。目标运行命令由 owner 配置，不能保证恶意服务没有代理外部页面。
- 默认不继承任意 API key/生产凭证到构建子进程，仅传系统运行环境。密钥文件排除是常见文件规则，不是完整秘密扫描。
- 本地报告只绑定 127.0.0.1，无写 API、无 CORS 放开。不是多租户服务。

## 当前明确不支持

- OCR 自动提取、视觉模型区域建议、full-page、canvas/WebGL 内部 DOM 识别。
- storageState 注入、业务随机种子/时钟与 fixture 测试 hook 配置（当前由目标测试页面自身固定）；无参考移动端还原评分。
- 费用预算、真实模型效果对照实验、跨平台一致分数、生产部署。
- 操作系统级不可篡改隔离、Agent attempt 崩溃后自动回收/重领、任意项目的一键依赖自动推断。

## 下一步

用首个真实项目的截图、viewport/DPR、素材、启动命令与交互合同创建任务，先校验诊断反馈；再扩充人工标注 calibration/heldout 页面。独立实现并验证所选编码工具的非交互适配器后，才宣称完整无人值守还原能力。

## 最近变更

- `responsive.required`：强制响应式布局时，用 `probe_widths` 做低成本适配探测；横向溢出或元素越界会阻断。
- 新增 Agent Facade MCP：`ui_check_start`、`ui_check_submit`、`ui_check_status`、`ui_check_cancel`、`ui_check_finalize`。
- 底层 MCP 和 TaskService 保持兼容，方便 CI、恢复和审计。
