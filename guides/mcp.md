# Agent / MCP 接入

## 统一五个工具

GUI/TUI、MCP/CLI 共用 UiWorkflow 输入校验和输出合同。

| 工具              | 输入                                                                                                                       | 行为                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| ui_check_start    | reference_image_path、target_url、viewport_width/height；可选 ready_selector/regions/required_checks/responsive/profile_id | 创建并冻结要求                     |
| ui_check_submit   | run_id、request_id、wait_ms（默认10000，上限30000）                                                                        | 提交当前版本并等待评测，不代表完成 |
| ui_check_status   | run_id、request_id（可选）                                                                                                 | 查询状态、证据和下一步             |
| ui_check_cancel   | run_id                                                                                                                     | 请求取消并等待清理                 |
| ui_check_finalize | run_id                                                                                                                     | 复核最新通过版本，成功才完成       |

图片和完整报告通过 MCP resources 读取。

## 连接

MCP 内置 worker，无需另开 npm run worker。hook 要求宿主服务名为 leeway-ui-check。

```json
{
  "mcpServers": {
    "leeway-ui-check": {
      "command": "node",
      "args": [
        "<HARNESS_DIR>/node_modules/tsx/dist/cli.mjs",
        "<HARNESS_DIR>/packages/mcp/src/index.ts"
      ],
      "env": { "HARNESS_HOME": "<DATA_DIR>" }
    }
  }
}
```

替换为绝对路径；不同宿主配置格式可能不同。start 只接收已运行的 HTTP/HTTPS target_url。Codex 负责启动与更新目标项目，Harness 不读取源码、不构建、不启动或停止目标服务。ready_selector 默认 body，可指定实际页面就绪标志。内置 Playwright，无需 Codex 另装 Playwright MCP。

## 状态和持续修复

所有工具声明 outputSchema，由 UiWorkflow 校验结果。

- task_status：created/evaluating/needs_revision/ready_to_finalize/blocked/passed/cancelled/failed/budget_exhausted/stalled。
- task_terminal：任务是否结束，结束不一定成功。
- evaluation_status：这轮评测状态，completed 不代表 UI 达标。
- next_action：submit/poll_status/revise_and_evaluate/finalize/review_configuration/inspect_failure/wait_for_cancellation/stop。
- 证据：score、verdict、blockers、issues、budget_remaining、visual_feedback、artifacts、full_report。

以 task_status/next_action 控制循环。新代码用新 request_id，网络重试用原 ID。处理中 score=null；等待超时不取消工作。

服务端 instructions 和 .agents/skills/leeway-ui-check/SKILL.md 指导未达标继续读图、修复、提交；只剩 profile_not_validated 时报告配置待审核，不能不停改 UI。默认 profile 未校准，正式验收通过 profile_id 选择存储中已审核的配置。

finalize 返回 target_url、evaluation_id、截图 URI/哈希和 evidence_scope=captured_page，确认本次采集证据通过。报告使用 schema_version=1.1。

## Codex Stop hook

在 Harness 仓库执行：

```powershell
npm run setup:codex -- "<目标项目绝对路径>" "<与MCP相同的HARNESS_HOME>"
```

安装项目级 Skill 和 .codex/hooks.json，保留其他 hook，不改全局配置。使用 Harness 的 Node/tsx，重复安装不重复添加。

重新加载配置，在 Codex 中审阅并信任项目 hooks（CLI 可用 /hooks）。未信任的 hook 会被跳过，见 [官方文档](https://learn.chatgpt.com/docs/hooks)。

PostToolUse 只监听本服务 start，将任务绑定到 session_id/cwd。Stop 查询数据库，在待实现、评测中、需修复、待 finalize 时返回 decision=block 与下一步，由宿主生成自动续执行提示。取消、终态、配置审核与耗尽预算时放行；最后一次评测仍可查询/finalize。

Interrupt 禁用绑定，不阻止用户中断；重新创建任务才重新绑定。每个绑定最多续执行12次、20分钟。无关聊天、不同 cwd、其他服务不拦截。错误写 stderr 并允许结束。

hook 是 Codex 适配层，不增加 MCP 工具。纯 MCP JSON/Schema 不强制宿主继续。当前验证覆盖真实 Chromium、共享CLI反馈、hook命令进程和状态策略；真实 Codex GUI/TUI 对话自动收敛仍需端到端验收。

## 图像证据

visual_feedback.regions 含差异 bbox、比例、reference/actual/diff crops URI、DOM候选和实际样式。comparison 含上一轮变化；参考CSS不会猜测成事实。

Agent 必须实际读图，URI不代表已经看图。无法读取应说明宿主限制。摘要约32KB上限，省略量有计数；full_report指向完整报告。
