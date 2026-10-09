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

start.json 示例，路径和命令按实际项目替换：

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

旧 create-task/register-candidate/evaluate-candidate/get-evaluation/get-task-status/finalize-task/cancel-task/controller CLI 命令已删除；内部步骤由共享 UiWorkflow 隐藏。

MCP 自带常驻 worker，submit 最多等30秒，之后 status 轮询。一次性 CLI submit 为避免退出遗留无人处理的任务，运行同一个 worker 并等本次评测结束；它不会修改代码。

## 本地运维入口

```powershell
npm run cli -- report
npm run worker
npm run cli -- import-evidence evidence.json
```

report 为只读报告服务，worker 用于独立诊断/恢复，import-evidence 用于校准证据导入。它们不是另一套任务流程。MCP、CLI、hook 必须使用同一个 HARNESS_HOME。

## URL 与验收

由 Codex 或开发者启动目标项目，保持 URL 在评测期间可访问。MCP/CLI 不接受 source_dir、build、serve 或 sandbox。URL 相对于 Harness 所在机器，远程服务的 localhost 不指向开发者电脑。

ready_selector 默认 body；等待数据渲染时提供页面就绪标志。取消只关闭评测浏览器，不停止目标服务。target_url 在任务内固定，地址改变时新建任务。

finalize 只确认持久化截图评测通过，不验证代码或安装包来源。旧 workspace 任务不再执行，需重新创建 URL 任务；已有报告和图像资源仍可读取。

regions 定义参考 bbox、selector、文字，required_checks 定义交互；responsive 在其他宽度检查溢出/越界，不产生无参考图的还原分数。不要从候选页面反推标准。

默认 profile 为 provisional，100分也不能正式通过。start.profile_id 可选择存储中已审核的配置。校准材料通过 import-evidence 导入，维护者仍可用内部 TaskService 登记审核后的配置；Agent 不再通过 owner MCP 创建/修改底层配置。见 [校准协议](../evals/calibration/README.md)。

HARNESS_PYTHON 可指定 Python，默认仓库 .venv。Windows 为实际测试平台。旧 task.template.json 是内部 TaskInput 的参考，不是五工具 start 的输入格式。
