# 用 Inspector 和断点观察一次评测

Inspector 代替 Agent 手动发送 MCP 请求，编辑器连接它启动的 MCP 进程查看内部变量。本流程不依赖 Codex 的工具选择或自动续执行 hooks。

## 启动并连接

在 Harness 仓库运行：

```powershell
npm run inspect:mcp
```

首次启动会下载固定版本 Inspector 和专用 Node 到 `.harness/inspector-tools`。项目与全局 Node 不变，MCP 仍使用项目当前 Node，以匹配 SQLite 等原生依赖。

打开终端打印的 Inspector 地址。在 Servers 中打开 `leeway-debug` 右侧连接开关，等待 Connected。首次启动可能需要下载依赖，请保持终端运行。

在编辑器打开本仓库，进入“运行和调试”，选择 **Attach Leeway MCP** 并按 F5。此时连接的是 Inspector 创建的 MCP 进程，而不是 Codex 的 MCP 进程。

- Inspector 页面默认端口为 6274，Node 调试端口为 9229。
- 调试配置自动生成于 `.harness/inspector.json`，不需要手工填写绝对路径。
- 调试数据使用 `.harness/inspector-data`，与日常任务分开。
- Codex 多聊天可以分别启动 MCP。9229 被占用时，新 MCP 自动分配空闲调试端口；编辑器选“Attach Leeway MCP (选择实际端口)”并输入对应进程日志中的端口。
- 结束本次连接时，先点击 Inspector 的 Disconnect，再关闭页面。只关网页可能留下服务连接并占用调试端口；遇到占用提示时回原页面断开，不要反复创建连接。重新连接后需重新 Attach。

## 先观察 start

在 `packages/mcp/src/server.ts` 的这行设置断点：

```ts
const result = await workflow.call(name, input);
```

选择 Inspector 的 Tools → ui_check_start，填写真实输入，例如：

```json
{
  "reference_image_path": "E:/design/reference.png",
  "target_url": "http://127.0.0.1:3000/dashboard",
  "viewport_width": 1440,
  "viewport_height": 900,
  "pass_threshold": 90
}
```

图片需已保存到本机，URL 需由 Codex 或开发者提前启动。参考图像素尺寸应与 viewport × device_scale_factor 一致。可使用表单，也可切换 Edit as JSON 输入完整对象。

点击 Execute Tool 后，编辑器应停在断点：

1. 查看 `name`、`input`，确认请求参数。
2. F11 进入 `UiWorkflow.call()`；在 start 分支查看 `config`，确认默认配置。
3. 进入 `TaskService.createTask()` 查看参考图校验和任务登记。
4. 执行到 MCP 回调的 return 前，查看 `result`。
5. F5 继续，在 Inspector 中查看返回 JSON；Protocol 面板展示请求与响应。

保存返回的 run_id。start 只创建任务，不执行截图比较。

## 再观察 submit 和 worker

在以下位置加断点：

| 位置                             | 观察内容                                     |
| -------------------------------- | -------------------------------------------- |
| TaskService.submitCandidate      | taskId、requestId、候选及评测登记结果        |
| TaskService.perform 入口         | evaluationId、config、目标 URL               |
| perform 中 await capture(...) 后 | captured.png、regions、runtime、checks       |
| perform 中 scoreReport(...) 后   | report.score、blockers、verdict、next_action |
| MCP 回调 return 前               | 实际返回客户端的 result                      |

调用 ui_check_submit：

```json
{
  "run_id": "替换为实际run_id",
  "request_id": "round_001",
  "wait_ms": 0
}
```

submit 登记后由 worker 的 runNext → perform 执行评测。异步 worker 的调用栈不同于 submit，使用 F5 运行到预设断点，比一路 F11 更清楚。

执行完后调用 ui_check_status：

```json
{
  "run_id": "替换为实际run_id",
  "request_id": "round_001"
}
```

Resources 中选择资源模板并填 evaluation_id 或 artifact_id，也可按返回 URI 读取完整报告和 reference/actual/diff 裁剪图。查看 task_status、evaluation_status、score、blockers 和 next_action。

默认 profile 为 provisional，校准状态不阻止达标验收。只有 ready_to_finalize 才调用 ui_check_finalize。结束观察时可用 ui_check_cancel 取消任务。

## 断点与超时

Inspector 请求等待设为十分钟，但页面采集超时、任务预算和队列租约仍是真实时间。停在截图阶段太久可能导致本轮失败；建议先在 start 阶段慢慢读变量，在采集/评分阶段使用日志断点或快速继续。

调试时不要同时为该调试数据目录运行独立 worker。截图与 DOM 的浏览器内部脚本、SSIM Python 子进程不是 Node Attach 的同一调试目标，需要单独工具深入调试。

stdout 用于 MCP 协议；临时日志写 console.error。调试结束，在终端 Ctrl+C 停止 Inspector。

## 直接观察 Codex 调用

将 Codex 的 leeway-ui-check 启动参数设为本仓库 `scripts/debug-mcp.mjs` 的绝对路径，并指定独立 HARNESS_HOME。停止 Inspector 连接后，让 Codex 重新加载该 MCP，再使用编辑器的 Attach Leeway MCP。

Attach 只连接已存在的进程，不负责启动 MCP。启动日志 `Leeway debugger ready: pid=..., endpoint=ws://127.0.0.1:端口/...` 给出本实例的进程号和实际端口。默认优先使用9229，冲突时自动分配空闲端口，不影响MCP初始化。

可在 PowerShell 检查：

```powershell
Invoke-RestMethod http://127.0.0.1:9229/json/list
```

将命令中的9229替换为本实例日志的实际端口。能够返回 Node 调试目标后再 Attach；连接其他聊天的调试端口不会命中本聊天的工具调用。

也可以查看所有 Leeway 调试进程及其监听端口：

```powershell
$leewayDebugIds = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -like '*leeway-ui-check*debug-mcp.mjs*'
} | Select-Object -ExpandProperty ProcessId)
Get-NetTCPConnection -State Listen | Where-Object {
  $_.OwningProcess -in $leewayDebugIds
} | Select-Object OwningProcess, LocalPort
```

只需结束废弃实例时，确认进程身份后用 `Stop-Process -Id 实际PID`。无需为启动新聊天而关闭正在使用的调试实例。
