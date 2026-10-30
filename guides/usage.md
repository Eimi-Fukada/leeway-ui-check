# 使用指南

依赖安装与 Demo 见 [README](../README.md)。Agent 接入与 hook 安装见 [MCP 指南](mcp.md)。

## MCP 与 CLI 共用五个操作

CLI 命令名、输入 JSON 和输出结构与 MCP 相同：

```powershell
npm run cli -- ui_check_start start.json
npm run cli -- ui_check_submit submit.json
npm run cli -- ui_check_status status.json
npm run cli -- ui_check_cancel status.json
npm run cli -- ui_check_finalize status.json
```

start.json 示例，替换参考图路径、页面 URL 和视口尺寸：

```json
{
  "reference_image_path": "E:/design/reference.png",
  "target_url": "http://127.0.0.1:3000/dashboard",
  "viewport_width": 375,
  "viewport_height": 812
}
```

submit.json：`{"run_id":"task_xxx","request_id":"round_001","wait_ms":10000}`。

status.json：`{"run_id":"task_xxx"}`。ID 来自 start。也可用 `-` 从 stdin 输入 JSON。

MCP 自带常驻 worker，submit 最多等30秒，之后 status 轮询。一次性 CLI submit 为避免退出遗留无人处理的任务，运行同一个 worker 并等本次评测结束；它不会修改代码。

## 本地运维入口

```powershell
npm run cli -- report
npm run worker
npm run cli -- import-evidence evidence.json
```

report 为只读报告服务，worker 用于独立诊断/恢复，import-evidence 用于校准证据导入。

数据默认保存在用户目录下的 `.leeway-ui-check`。可用 `HARNESS_HOME` 指定数据目录；MCP、CLI 和 hook 应使用同一目录。

## URL 与验收

由 Codex 或开发者启动目标项目，保持 URL 在评测期间可访问。URL 相对于 Harness 所在机器，远程服务的 localhost 不指向开发者电脑。

ready_selector 默认 body；等待数据渲染时提供页面就绪标志。取消只关闭评测浏览器，不停止目标服务。target_url 在任务内固定，地址改变时新建任务。

finalize 确认持久化截图的验收结果，返回评测 ID、URL 和截图哈希；验收范围为采集时的页面效果。

regions 定义参考 bbox、selector、文字，required_checks 定义交互；responsive 在其他宽度检查溢出/越界，不产生无参考图的还原分数。不要从候选页面反推标准。

默认 profile 为 provisional；各已测维度分别达到任务阈值且无阻断即可通过，calibrated=false 不阻止验收。start.profile_id 可选择存储中已审核的配置。校准材料通过 import-evidence 导入，维护者用 TaskService 登记审核后的配置。当前默认参数尚无真实页面校准与留出集验收结论。

HARNESS_PYTHON 可指定 Python，默认仓库 .venv。Windows 为实际测试平台。task.template.json 是内部 TaskInput 的参考，不是五工具 start 的输入格式。

## Codex 参考标注

截图还原推荐先完成项目 Skill 的 [标注流程](../.agents/skills/leeway-ui-check/references/annotations.md)。
Codex 用自身视觉提出候选；Pillow 脚本生成编号预览和局部放大图，Codex 查看后修正。
不调用额外模型 API，不包含 OCR 服务。参考标准与 DOM 映射分别保存。

先运行 `npx tsx scripts/normalize-reference.ts original.png normalized.png`，使用其输出的图片哈希和尺寸。
`ui_check_start` 仍使用五工具接口，增加可选参数：

```json
{
  "annotation_input": {
    "reference_path": "E:/design/reference-annotations.json",
    "bindings_path": "E:/design/implementation-bindings.json",
    "preview_path": "E:/design/preview.png"
  }
}
```

同时提供原有 `reference_image_path`（normalized.png）、URL、视口和 DPR。
`preview.png.json` 必须位于预览旁，预览内容、标注和参考图哈希必须匹配；有未解决项或未声明复核时拒绝创建。
声明复核和哈希关联不能证明人工/Agent 已正确看图。导入后保存不可变证据，不再读取原路径。
标注导入仅支持未裁剪的 viewport；旧 `regions` 仍可直接输入，但不能与 `annotation_input` 同传。
所有选定区域按固定策略作为关键区域、等权、10 图像像素几何扣分尺度；配置仍未校准。
纯文字区域可省略 bbox，只校验内容、可见性等，不参与布局及局部像素分数。

## 分数与通过条件

像素用于精细视觉差异，SSIM 是图像局部结构辅助指标；布局检查标注元素盒，文字检查内容。
它们可能重叠，不是互斥的错误分类。综合分为已测维度按配置权重归一化的进展指标，不代表还原百分比。
每个已测维度分别达到 `pass_threshold` 才能通过，关键区域、运行时、交互和响应式检查仍独立阻断。
无标注的布局/文字显示未评测，报告 `assessment.scope=image_only`；这类通过只代表图像检查通过。
仅提供布局或仅提供文字标注时，缺失维度保持未评测。覆盖数是已选标注数，不保证整页语义覆盖。
