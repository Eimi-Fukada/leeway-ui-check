# 示例与任务模板

## 可运行的确定性案例

完成README安装后，在仓库根目录执行 `npm run demo`。脚本创建Fieldnotes页面与参考截图，依次评测：

| 版本  | 预设修改                | 应观察的结果                           |
| ----- | ----------------------- | -------------------------------------- |
| shift | 容器向下偏移16px        | 几何差值、区域像素问题                 |
| text  | 标题变为Fieldnotes 2027 | 关键文字阻断，即使总分较高             |
| exact | 恢复参考页面内容        | 本环境通常一致；仍因未校准不能正式通过 |

查看 `.demo/<时间>/result.json` 和本地报告页；源码生成逻辑在 [fixtures.ts](../scripts/fixtures.ts)，执行脚本在 [demo.ts](../scripts/demo.ts)。参考和当前截图、diff、DOM及日志保存在HARNESS_HOME。分数受环境影响，这里不承诺固定数值。

这是预设变体演示，没有真实模型修改。不要将它宣传为模型自动修复成功案例。

## 接入自己的页面

[task.template.json](task.template.json) 是独立完整模板，不依赖先运行Demo。替换所有REPLACE\_值及页面相关区域/文字/交互后，用CLI create-task创建新任务。它假设你的页面由Node server.mjs通过PORT环境变量启动；不同框架需按真实构建/启动方式修改target。

截图本身不能确定真实DOM和交互，模板不会自动恢复这些信息。完整说明见 [使用指南](../guides/usage.md)。
