# 使用指南

依赖安装与 Demo 见 [README](../README.md)。以下说明如何评测自己的项目。

## 创建任务

复制 [task.template.json](../examples/task.template.json)，替换全部 `REPLACE_` 值。模板以一个 375×812 的页面为例，参考图像素尺寸须与 viewport×DPR 一致。区域、文字和交互是示例要求，必须按真实页面改写。

- reference_path：参考 PNG/JPEG 的绝对路径。
- target.source_dir：Agent 实际修改的目录；使用 worktree 时填写 worktree 路径。
- target.build：在候选副本中安装依赖、构建的固定命令列表。
- target.serve：在副本内启动服务；支持 `{port}` 参数，自动提供 PORT 环境变量。
- regions：参考区域 bbox、对应页面 selector、参考文字；不要从实现页面反推标准。
- required_checks：你明确要求的交互。
- profile：保留默认权重或自行配置，合计必须为1。同一个 profile_id 不能修改内容，改参数要使用新 ID；不会自动生成版本。
- responsive：按需开启其他宽度的横向溢出与越界检查；这些检查不产生无参考图的还原分数。

```powershell
npm run cli -- create-task "你的任务配置绝对路径.json"
```

记录 task_id。新终端运行：

```powershell
npm run worker
```

连接 [MCP](mcp.md) 后，Agent 可以从参考图启动任务、提交代码并读取报告；MCP 进程会自动运行本地 worker。手工 CLI 操作也可以：

```powershell
npm run cli -- register-candidate TASK_ID
npm run cli -- evaluate-candidate CANDIDATE_ID request_001
npm run cli -- get-evaluation EVALUATION_ID
npm run cli -- get-task-status TASK_ID
npm run cli -- report
```

大写 ID 是需替换的值。报告页为只读页面，不提供任务配置编辑。

## 构建和运行约定

workspace 模式直接使用目标工作区和已有依赖；每轮只记录 manifest、报告与证据，不长期复制完整源码。构建命令应避免修改源码文件。workspace 模式不会复制源码；它直接使用工作区依赖。Windows 使用实际可执行程序；npm 可以用 `node <npm-cli.js绝对路径> ci`，不依赖 shell 拼接。模板的 Node 服务只是启动方式示意；React/Vue/Next 项目应按实际脚本配置。自动识别只提供建议，不保证可运行。

外部 URL 使用 `target.mode: external`，只做诊断，不能验证对应源码版本或 finalize。完整字段见 [Task Schema](../packages/contracts/schemas/task.schema.json)。

## 数据与结束

HARNESS_HOME 默认为用户目录 `.leeway-ui-check`，必须位于目标源码目录之外。HARNESS_PYTHON 可指定 Python 解释器；默认使用仓库 `.venv`。Windows 为当前测试平台，其他系统尚未完整验收。

取消：`npm run cli -- cancel-task TASK_ID`。通过后：`npm run cli -- finalize-task TASK_ID CANDIDATE_ID`，复核源码与构建指纹后返回已验证的工作区版本信息，不覆盖原工作区。

默认 profile 为 provisional，不会正式通过。正式配置需要 owner 审核独立校准与留出集证据，见 [校准协议](../evals/calibration/README.md)。

## Controller（实验性）

`npm run cli -- controller TASK_ID adapter.json` 启动外部编码程序循环。adapter.json 包含 command.executable、command.args、attempt_timeout_seconds。程序从 stdin 接收 JSON，修改源码后退出。当前只有确定性脚本的链路测试，没有真实模型适配验收。使用 MCP 的 Agent 不需要同时运行 Controller。
