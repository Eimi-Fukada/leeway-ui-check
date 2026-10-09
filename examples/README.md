# 示例与任务模板

## 可运行的确定性案例

完成README安装后，在仓库根目录执行 `npm run demo`。脚本创建Fieldnotes页面与参考截图，依次评测：

| 版本  | 预设修改                | 应观察的结果                         |
| ----- | ----------------------- | ------------------------------------ |
| shift | 容器向下偏移16px        | 几何差值、区域像素问题               |
| text  | 标题变为Fieldnotes 2027 | 关键文字阻断，即使总分较高           |
| exact | 与参考页面内容一致      | 本环境通常一致；因未校准不能正式通过 |

查看 `.demo/<时间>/result.json` 和本地报告页；源码生成逻辑在 [fixtures.ts](../scripts/fixtures.ts)，执行脚本在 [demo.ts](../scripts/demo.ts)。参考和当前截图、diff、DOM及日志保存在HARNESS_HOME。分数受环境影响，这里不承诺固定数值。

这是预设变体演示，没有真实模型修改。不要将它宣传为模型自动修复成功案例。

## 接入自己的页面

[task.template.json](task.template.json) 是内部 TaskInput 的完整参考，不依赖先运行 Demo。公开 CLI/MCP 统一使用 ui_check_start，输入示例见 [使用指南](../guides/usage.md)；不要将完整内部模板直接作为 start 输入。由 Codex 启动实际项目后，提供 URL、viewport 和区域/交互要求。

截图本身不能确定真实DOM和交互，模板不会自动恢复这些信息。完整说明见 [使用指南](../guides/usage.md)。
