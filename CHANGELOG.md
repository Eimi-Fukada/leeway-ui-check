# 更新记录

## Unreleased

- 新增报告1.1视觉反馈：二值差异掩码、区域与成对裁剪图、运行时DOM/样式关联、前后轮趋势和区域分裂/合并。旧1.0报告保留读取兼容。
- MCP摘要限制32KB并支持完整报告资源；报告页新增局部对照与DOM证据。评分参数和Gate不变。

- 默认MCP收敛到start、submit、status、cancel、finalize五个工具；底层与配置工具仅owner模式可用。
- 移除ui_check_submit_and_wait工具；submit增加wait_ms（0–30000），超时返回running，由独立worker继续执行。
- 提交按task/request复用已有结果，增加跨进程快照串行锁；异常锁恢复见FAQ。
- 状态返回当前反馈和证据URI，不再默认返回整段历史。
- 重整公开文档，新增任务模板、MCP指南、FAQ、贡献与安全说明。

## 0.1.0 初始实现

本地截图评测、四项指标、SQLite任务、CLI/MCP、报告页和确定性示例。此条描述代码阶段，不代表已经发布npm包或GitHub Release。
