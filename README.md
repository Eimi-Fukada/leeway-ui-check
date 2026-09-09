![Leeway UI Check — Turn screenshots into actionable feedback](assets/readme/banner.svg)

# Leeway UI Check — 面向 AI 编码 Agent 的 UI 还原评测工具

让每一轮 UI 修改，都有可对照的截图、可定位的差异和可追溯的结果。

**Leeway UI Check** 是一个本地运行的截图还原评测 Harness。它将参考截图与实际 Web 页面进行比较，检查像素、布局、文字和交互，并通过 **CLI 或 MCP** 向编码 Agent 返回结构化反馈，帮助完成「修改 → 截图 → 比较 → 修复」的迭代。

[快速开始](#快速开始) · [使用指南](guides/usage.md) · [开发状态](guides/status.md) · [问题反馈](https://github.com/Eimi-Fukada/leeway-ui-check/issues)

第一次了解项目？先看 [项目导览](guides/project-tour.md)，里面按一次真实评测的流转顺序解释每个模块。

![Leeway UI Check 实际报告界面：截图对照、视觉评分、修复线索与候选历史](assets/readme/report-preview.png)

_报告页支持参考图、当前截图、差异图与严格差异切换，并展示区域标记、阻断原因和候选历史。上图来自本地 Demo 的实际运行结果。_

## 核心能力

- **多维度视觉比较**：结合 pixelmatch 像素差异、SSIM 结构相似度、区域几何与文字匹配，帮助定位页面偏移、内容错误和局部细节差异。
- **关键问题独立验收**：关键文字错误、组件缺失、图片加载失败或按钮不可用，都可以单独阻断通过，避免被大面积相似背景掩盖。
- **面向 Agent 的反馈**：通过 MCP 提供结构化报告、问题位置、测量依据和修复建议，让编码 Agent 继续修改与复测。
- **候选与证据可追溯**：冻结源码快照，记录截图、差异图、DOM 和构建信息；交付前复核对应版本，不覆盖用户后续修改。
- **可恢复的评测任务**：SQLite 保存任务和历史，独立 worker 消费队列，支持请求去重、取消、预算限制及过期租约重领。
- **本地报告工作台**：在浏览器中对照截图、查看修复线索和历史候选，支持桌面与窄屏浏览。

## 快速开始

以下步骤适用于 **Windows / PowerShell**。准备 Node.js **22.16.0** 和 Python **3.13**，然后克隆项目：

```powershell
git clone https://github.com/Eimi-Fukada/leeway-ui-check.git
cd leeway-ui-check
```

安装依赖与固定版本的 Chromium：

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r workers/requirements.txt
npm run setup:browser
```

运行内置示例并打开报告：

```powershell
npm run build
npm run demo
npm run cli -- report
```

访问 **[http://127.0.0.1:4318](http://127.0.0.1:4318)**，即可查看三轮示例：整体偏移、标题错误和完全一致。

示例会自动创建参考图和目标页面，无需先配置模型或 API key。评测数据默认保存在用户目录下的 `.leeway-ui-check/`，与目标源码分开存放。

想评测自己的页面？从 Demo 生成的 `task.json` 开始，替换参考截图、视口尺寸、项目启动方式与交互要求。完整步骤见 **[使用与配置指南](guides/usage.md#用自己的截图和项目)**。

## 工作方式

```text
参考截图 + 视口约定 + 区域与交互要求
                  ↓
             冻结候选源码
                  ↓
       启动页面 → Playwright 稳定截图
                  ↓
       像素 / SSIM / 布局 / 文字 / 交互
                  ↓
          差异图 + 结构化问题报告
                  ↓
          Agent 修复 → 新候选复测
```

你可以选择适合自己的接入方式：

| 方式           | 用途                                                       |
| -------------- | ---------------------------------------------------------- |
| **CLI**        | 手工创建任务、评测候选、查询结果，或接入 CI                |
| **MCP**        | 让支持 stdio MCP 的编码 Agent 注册候选、发起评测和读取反馈 |
| **Controller** | 通过命令适配器执行有轮次和时限约束的修改、评测循环         |

MCP 与评测 worker 独立运行，客户端断开不会自动取消已排队任务。配置方法见 [MCP 接入](guides/usage.md#mcp) 和 [Controller 接入](guides/usage.md#controller)。

## 当前状态

项目处于 **v0.1 早期开发阶段**，已打通本地评测链路。可查看 [测试与验证用例](tests) 和 [实施进度](guides/status.md)。

> **评分说明：** 默认配置尚未完成正式校准，分数用于诊断，不等于客观还原百分比。即使显示 100 分，也不会自动判定为正式通过。

当前支持单页面、固定视口及组件截图。真实编码模型的无人值守修复、跨机器渲染一致性和正式 90 分校准仍待验收；Controller 已有命令适配器与两轮真实文件修改测试，尚未完成真实模型适配验收。

## 文档与资源

- [使用与配置指南](guides/usage.md) — 自定义任务、CLI、MCP、Controller 与交付流程
- [实施进度与支持范围](guides/status.md) — 已实现能力、限制与下一步
- [测试与验证用例](tests) — 指标计算、真实评测链路与报告页浏览器检查
- [评分校准协议](evals/calibration/README.md) — 从诊断配置到正式验收配置
- [任务与报告 Schema](packages/contracts/schemas) — 机器可读的数据契约
- [核心实现](packages/core/src) — 任务、截图、比较、评分与执行控制

## 参与贡献

欢迎通过 [Issues](https://github.com/Eimi-Fukada/leeway-ui-check/issues) 提交问题或建议，也欢迎提交 Pull Request。

报告问题时，请附上复现步骤、运行环境、相关错误日志，以及可公开的任务配置或最小示例。涉及评分问题时，参考图、当前截图和差异图有助于定位原因。

提交代码前，在完成依赖安装后运行：

```powershell
npm run check
npm run build
npm test
npm run format:check
```

涉及数据契约变更时，执行 `npm run schemas` 同步 JSON Schema；评分参数或算法变更需同步更新配置版本和验证记录。

## 开源许可

本项目采用 [MIT License](LICENSE)。

## 响应式布局要求

移动端任务可以把响应式布局设为强制要求：

```json
{
  "responsive": {
    "required": true,
    "probe_widths": [343, 407],
    "max_horizontal_overflow_px": 0
  }
}
```

参考尺寸（例如 375px）继续做正式视觉评分；`probe_widths` 只做适配 Gate，检查横向溢出和元素越界。这样无需为每种手机准备参考截图，但至少要探测一个不同于参考宽度的尺寸。

## 面向 Agent 的 MCP Facade

编程 Agent 默认使用简化接口：

- `ui_check_start`：开始一次已有任务
- `ui_check_submit`：冻结并评测当前源码
- `ui_check_submit_and_wait`：冻结、评测并直接返回完成报告
- `ui_check_status`：获取得分、阻断、问题和下一步
- `ui_check_cancel`：取消执行
- `ui_check_finalize`：交付已验证通过的结果

Owner 还可以调用 `detect_project` 识别 React/Vue/Svelte、Vite/Next、Tailwind 和常见入口；识别结果是便利层建议，启动命令仍需 owner 确认。

底层的 `register_candidate`、`evaluate_candidate` 等接口仍保留给 CLI、CI 和调试使用。Facade 隐藏 candidate、evaluation、lease 和 artifact 细节，典型循环是 `start → submit → status → 修复 → submit → finalize`。

## 评分配置与项目边界

默认 profile 使用以下初始权重：`pixel 0.35`、`structure 0.20`、`layout 0.30`、`text 0.15`。这些值会保留，但 owner 可以在任务 profile 中自行配置；权重必须合计为 1，配置内容变化会生成新的 profile 版本。未完成 calibration/heldout 审核前，profile 仍为 provisional。

Leeway UI Check 当前是本地、单用户 Harness。远程执行平台、云端队列、企业权限、分布式 artifact 存储和通用多租户服务不属于当前设计目标。
