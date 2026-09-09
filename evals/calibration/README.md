# 校准协议（未完成）

`scripts/fixtures.ts` 的 Fieldnotes 页面是工程 fixture。其空白、缺图、字体失败、错误文字、16px 偏移、按钮禁用、图片冒充和动画变体用于验证不会误报，不用于宣布“90 分 = 90% 还原”。

正式校准需要：

1. 收集 5–10 类有真实素材与文字标注的页面，锁定 viewport/DPR/OS/字体/Chromium。
2. 每页重复捕获记录噪声；生成已知偏移、字体、图标、文字、布局等变体，记录所有原始 metrics 和人工可接受排序。
3. 仅在 calibration 页面调节 D_bad、S_bad、区域阈值、权重与稳定噪声阈值。
4. 冻结 profile，在从未用于调参的 heldout 页面计算严重错误误过率、可接受页面通过率及重复采集方差。
5. 由 owner 审核两份不同的 JSON 证据，记录 case 列表、原图/变体 hash、人工标注、环境、原始分项、冻结参数、误过结果和审核者。CLI `import-evidence` 导入后得到 SHA-256。
6. 新建 validated profile_id，填写两个 hash 与 approved_by。编码 Agent 默认没有创建/修改 profile 的工具。证据完整性由 hash 保证，证据是否充分由审核者负责。

不得将 fixtures 的测试成功填成真实用户项目校准成功，不得自动把默认 profile 改成 validated。
