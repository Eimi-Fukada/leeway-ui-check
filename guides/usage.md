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
  "source_dir": "E:/projects/my-ui",
  "viewport_width": 375,
  "viewport_height": 812,
  "serve": { "executable": "node", "args": ["server.mjs", "{port}"] }
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

## 构建、运行与验收

workspace 模式直接使用工作区与依赖，不复制源码；每轮记录 manifest、报告与证据。build/serve 使用 executable+args，支持 `{port}` 和 PORT。HARNESS_HOME 必须位于源码目录之外。

regions 定义参考 bbox、selector、文字，required_checks 定义交互；responsive 在其他宽度检查溢出/越界，不产生无参考图的还原分数。不要从候选页面反推标准。

默认 profile 为 provisional，100分也不能正式通过。start.profile_id 可选择存储中已审核的配置。校准材料通过 import-evidence 导入，维护者仍可用内部 TaskService 登记审核后的配置；Agent 不再通过 owner MCP 创建/修改底层配置。见 [校准协议](../evals/calibration/README.md)。

HARNESS_PYTHON 可指定 Python，默认仓库 .venv。Windows 为实际测试平台。旧 task.template.json 是内部 TaskInput 的参考，不是五工具 start 的输入格式。
