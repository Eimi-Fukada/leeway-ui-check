# 使用与配置指南

截图 UI 还原与自动评分 Harness 的首个可运行实现。输入参考图和固定任务合同，冻结候选源码，在固定 Chromium 中截图，输出像素差异、SSIM、区域几何、文字与交互结果。CLI、MCP、Controller 共用一个 TaskService。

**当前默认评分为 provisional，100 分也不能正式 passed。** 示例页面用于验证工程链路，不代表 90 分已完成感知校准。真实模型自动修复、跨机器噪声校准和正式 heldout 验收尚未完成。详细边界见 [实施状态](status.md)。

## 快速运行（Windows / PowerShell）

固定环境：Node **22.16.0**、Python **3.13**、Playwright **1.55.0** / Chromium **140.0.7339.16（build 1187）**。npm 精确版本与 lockfile、Python 全量版本均已提交。

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r workers/requirements.txt
npm run setup:browser
npm run check
npm run build
npm test
npm run demo
npm run cli -- report
```

打开 http://127.0.0.1:4318 查看报告。Demo 自动创建 Fieldnotes 基准图，依次评测 16px 偏移、错误标题、完全一致三种候选。控制台输出 task_id，源页面和 task.json 写入 `.demo/<timestamp>/`；**证据、SQLite、候选快照默认写在用户目录 `.leeway-ui-check/`，位于目标代码之外**。

Linux 使用 `.venv/bin/python`；该平台尚未实机验收。可设置 `HARNESS_PYTHON` 指定解释器。`HARNESS_HOME` 指定独立数据目录；所有 CLI/MCP/worker 必须使用相同目录。

## 用自己的截图和项目

以 Demo 生成的 `task.json` 为完整配置示例。替换 `reference_path`、`target.source_dir`、启动方式和参考区域；参考图不要求手工填写每条 CSS。

- 明确 viewport CSS 尺寸、DPR、scroll；`confirmed: false` 的任务可以诊断，但不能通过。更改要求时创建新任务。
- viewport 模式要求图像尺寸等于 `viewport_css × DPR`；含浏览器边框的原图可以显式设 `crop`。crop 也会应用到当前 viewport，不能用于消除实际页面布局偏移。
- component 模式填写 `component_selector`，参考图须预先裁成该组件，不能同时传 crop。区域 bbox 均以最终参考图像素为坐标系。
- `regions` 用显式选择器标注参考边界与文字。`critical` 区域有独立几何、像素和文字阻断；重复匹配返回 review_required。
- `required_checks` 明确每步 click/fill/visible/text/value；不从截图推断业务动作。每个检查使用新 BrowserContext。
- `target.mode: managed` 将源码复制成快照后执行固定 `build` 命令列表和 `serve`。`{port}` 参数与 PORT 环境变量注入独占随机端口；服务须绑定 `127.0.0.1`，不可代理回原工作区。缓存、node_modules、常见密钥文件和符号链接不进入快照。
- Windows 下命令使用真正可执行文件，例如 `node.exe`；不使用 shell 拼接。需要 npm 时可通过 `node.exe <npm-cli.js绝对路径> ci` 执行。依赖必须通过锁文件恢复，不能依赖原目录的 node_modules。
- `target.mode: external` 输入 `url` 和 `ready_selector`，只作诊断，provenance 始终 unverified。
- 参考图没有区域/文字基准时显式选择 `pixel_diagnostic` profile，layout/text 权重为 0，状态只能是 provisional。

```powershell
npm run cli -- create-task 'E:\example\task.json'
npm run cli -- register-candidate <task_id>
npm run cli -- evaluate-candidate <candidate_id> <unique_request_id>
# 独立终端，持续消费持久队列：
npm run worker
# 原终端查询：
npm run cli -- get-evaluation <evaluation_id>
npm run cli -- get-task-status <task_id>
npm run cli -- get-artifact <artifact_id> output.png
npm run cli -- cancel-task <task_id>
```

`worker --once` 可用于 CI 单次消费。重复 request_id 返回同一个 evaluation_id；同任务另一个在途请求被拒绝。工具超时/客户端退出不隐式取消任务。worker 退出后重启，过期租约可重新领取；旧 fence 无法提交报告。

取消先记录请求，worker 终止进程树后才进入 cancelled。任务预算包括从首次评测/Agent attempt 起的墙钟时间；终态保留原记录，扩大预算须创建新任务。原目标工作区从不自动回滚。

## MCP

先运行独立 `npm run worker`。在支持 stdio MCP 的宿主配置实际绝对路径，例如：

```json
{
  "mcpServers": {
    "leeway-ui-check": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "E:/Projects/leeway-ui-check/node_modules/tsx/dist/cli.mjs",
        "E:/Projects/leeway-ui-check/packages/mcp/src/index.ts"
      ],
      "env": { "HARNESS_HOME": "C:/Users/admin/.leeway-ui-check" }
    }
  }
}
```

配置字段因宿主而异；这是标准 stdio 连接参数示例，未自动修改任何宿主配置。默认只暴露候选注册、评测、查询、工件、finalize、cancel。任务创建只能从 owner CLI 或显式 `--owner` MCP 入口完成，编码 Agent 没有修改 reference/profile/threshold 的工具。

`get_evaluation` 在 `structuredContent.report` 返回严格报告；图像经 `harness://artifacts/{artifact_id}` resource 获取。stdout 只写协议，日志走 stderr。当前仅单用户本地部署；工具权限分离不是操作系统级沙箱，不能阻止同一 OS 账号的任意程序直接改磁盘。

## Controller

`CodingAgentAdapter` 和基于命令的适配器已实现：输入 JSONL（task_id、source_dir、attempt、上轮报告），等待一次真实进程退出，保存日志，冻结候选，再评测。总轮次、总时限、每次进程时限在外层执行。

```json
{
  "command": {
    "executable": "C:/path/to/agent.exe",
    "args": ["your-supported-noninteractive-mode"]
  },
  "attempt_timeout_seconds": 120
}
```

上面是接口占位，不能原样运行。配置已确认支持非交互输入的真实编码工具后：

```powershell
npm run cli -- controller <task_id> adapter.json
```

当前测试用确定性 Node 适配器执行了两轮真实源码修改，不依赖模型/API key。**尚未声称 Codex 专用适配器或真实模型无人值守修复已验收。** Controller 进程异常退出后的 Agent attempt 人工恢复与沙箱隔离列为下一阶段工作。

## 配置校准与交付

权重、pixelmatch 参数、SSIM 窗口、mask、阈值都随 profile 冻结。同一 profile_id 内容变化会拒绝。`validated` 配置必须由 owner 导入不同的 calibration/heldout JSON 证据、提供 SHA-256 和 approved_by；系统不代替人判断这些证据是否充分。参见 [校准协议](../evals/calibration/README.md)。

`finalize-task <task_id> <candidate_id>` 只接受同任务、verified provenance、validated profile、未四舍五入 Gate 通过的候选；重新计算源码和构建产物 manifest，匹配后返回快照路径。不会覆盖用户后续修改。

## 目录

```text
packages/contracts/    Zod 合同 + 导出的 JSON Schema
packages/core/src/     TaskService、SQLite、快照、截图、比较、评分、Controller
packages/mcp/          stdio tools + resource
packages/cli/          同一服务的 CLI 入口
apps/report-web/       React/Vite 只读报告页
workers/               scikit-image SSIM、受管服务存活监督
evals/                 基准页面与校准/heldout 协议
tests/                 单元、真实链路、报告浏览器验收
```

更多支持范围与后续工作见 [实施状态](status.md)。
