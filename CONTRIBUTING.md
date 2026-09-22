# 贡献指南

先按README安装Node/Python依赖和Chromium。开发入口见 [架构](guides/project-tour.md)。

提交前运行：

```powershell
npm run check
npm run build
npm test
npm run format:check
```

更改合同后运行 `npm run schemas` 并提交导出文件。评分算法/权重变化要明确版本和回归样例，不把fixture结果当正式校准。

PR请描述触发条件、前后行为、测试结果和限制。修复优先附最小复现；界面变化附截图；不要上传个人项目、凭证、私有参考图或本地数据库。新增工具需检查默认/owner工具清单、重试、取消和超时语义。

提交issue时使用对应模板。欢迎文档纠错和失败样例，真实模型效果只有实际执行并保存证据后才能宣称。
