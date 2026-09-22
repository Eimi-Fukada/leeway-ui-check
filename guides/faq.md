# 常见问题

**为什么100分仍未通过？** 默认profile是provisional，未完成独立校准。不要为了让示例成功就伪造验证材料。它可以用于诊断和修复观察。

**为什么需要Python？** SSIM使用scikit-image；Node负责浏览器、图像预处理、队列与协议。

**提交一直running？** 检查独立worker是否运行，以及它与MCP是否使用同一个HARNESS_HOME。等待超时不是执行失败。

**调用超时后怎么办？** 查询原request_id或原样重试提交。只有源码产生新版本才换request_id。

**submission_busy是什么？** 同一任务正在冻结源码，稍后重试。若MCP进程崩溃留下锁，先停止该数据目录下所有MCP提交进程，确认没有快照操作，再仅删除HARNESS_HOME/submission-locks/TASK_ID这个空目录。不要在进程运行时清锁。

**要自己标注区域吗？** 当前正式布局/文字评分需要参考bbox、selector、expected_text。区域建议不等于可靠自动识别；没有基准时使用明确的pixel_diagnostic配置，不能沿用四维90分的含义。

**支持所有操作系统吗？** 当前实际验收以Windows为主。其他平台不能据此宣称相同分数或完整兼容。

**sandbox.enabled能安全运行陌生代码吗？** 不能。当前不是操作系统隔离，详见安全说明。

**能直接npx安装吗？** 当前是源码运行项目，package.json为private，没有在此提供已发布npm包承诺。
