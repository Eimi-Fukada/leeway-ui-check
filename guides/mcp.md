# Agent / MCP 接入

## 启动方式

安装依赖后，在独立终端执行 `npm run worker`。MCP 仅提交与查询，不执行队列；宿主负责启动 stdio MCP 进程。CLI、worker 和 MCP 必须使用同一个 HARNESS_HOME（默认用户目录的 `.leeway-ui-check`）。

先按 [使用指南](usage.md) 创建任务，拿到 task_id；start 不会创建任务。

支持通用 mcpServers JSON 格式的宿主可使用下面的示例。将 `<HARNESS_DIR>` 替换为本仓库绝对路径，`<DATA_DIR>` 替换为数据目录；node 必须在宿主 PATH 中，否则使用其绝对路径。

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

不同宿主的配置文件格式不同，以上不是所有客户端通用的配置文件。连接参数始终是 executable、args、env。项目不自动修改宿主配置。

## 默认工具：五个

| 工具              | 参数                                                | 行为                                     |
| ----------------- | --------------------------------------------------- | ---------------------------------------- |
| ui_check_start    | task_id                                             | 打开已有任务，返回要求和当前状态         |
| ui_check_submit   | run_id, request_id, wait_ms（默认10000，上限30000） | 冻结并排队；限时等待；未完成返回 running |
| ui_check_status   | run_id, request_id（可选）                          | 查询指定提交或最新提交的精简反馈         |
| ui_check_cancel   | run_id                                              | 请求取消；进程清理结束前不保证已取消     |
| ui_check_finalize | run_id                                              | 复核并交付通过的候选                     |

run_id 就是 task_id。提交等待时间从排队后计算，源码快照还需要额外时间。等待结束不取消工作；没有 worker 时保持 running。新代码用新 request_id；网络重试用原 request_id，不会重新冻结源码或增加评测次数。

返回 score、verdict、blockers、issues、components、budget_remaining、next_action 和工件 URI。处理期间 score=null。历史仍保存在报告页和 owner 接口中。图像通过 `harness://artifacts/{artifact_id}` 资源读取；支持与否取决于宿主。

## 给 Agent 的指令模板

> 使用 Leeway 评测任务 TASK_ID。先调用 ui_check_start 读取要求；修改目标源码后调用 ui_check_submit，每个新版本使用新的 request_id。如果返回 running，用 ui_check_status 查询同一个 request_id。根据 issues 和差异图继续修复，不修改参考图、profile 或验收要求。仅 verdict=pass 时 finalize。预算耗尽、取消或停滞时停止；如果只剩 profile_not_validated，报告配置待审核，不反复修改页面。Harness 不会替你修改源码。

## Owner / 调试入口

启动参数末尾加 `--owner`，暴露十个工具：create_task、detect_project、suggest_regions、register_candidate、evaluate_candidate、get_evaluation、get_task_status、get_artifact、finalize_task、cancel_task。Owner 模式不暴露五个 Facade 工具。此区分只控制工具列表，不构成账号权限隔离。

## 迁移

移除 `ui_check_submit_and_wait`，改用 `ui_check_submit`；底层工具仅在 owner 模式注册。旧客户端需要刷新工具列表。无需更改已有 SQLite 数据。
