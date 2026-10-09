# 视觉反馈机制

Leeway 对照参考图与目标 URL 的截图，返回差异区域、局部对照图、实际 DOM 信息和轮次变化。编码 Agent 根据证据判断原因并修改页面。

报告使用 `schema_version=1.1`，视觉反馈使用 `feedback_version=visual-feedback-v1`。数据合同见 [feedback.ts](../packages/contracts/src/feedback.ts)，核心实现见 [visual-feedback.ts](../packages/core/src/regions/visual-feedback.ts)。

## 单轮评测

```text
提交 URL 页面评测
→ worker 领取任务
→ Playwright 等待页面稳定，截图并采集 DOM
→ sharp 标准化参考图与候选图
→ pixelmatch 和 SSIM 比较
→ 汇总评分、标注区域和交互检查
→ 提取差异区域、裁剪对照图、关联 DOM
→ 比较上一轮有效结果
→ 保存报告和证据，返回 MCP 摘要
```

DOM 与截图来自同一页面状态，在交互检查之前采集。响应式探针单独运行，不混入参考视口的图像或 DOM。目标页面更新由 Agent 负责；报告代表采集时的页面效果。

## 差异区域与对照图

pixelmatch 输出二值差异掩码。区域提取剔除配置中的遮罩，通过 16px 网格和八邻接聚合，再合并重叠边界。区域超过 128 个时合成一个粗区域，保存全部差异像素统计。

区域按差异像素数降序排列，相同数量按 y/x 坐标排序。每个区域包含：

- `bbox_px`：差异范围。
- `mismatched_pixels`、`evaluated_pixels`、`difference_ratio`：像素统计。
- `crop_bbox_px`：外扩 8px 并裁到截图边界的范围。
- `crops`：参考图、候选图、差异图的同坐标裁剪证据。
- `dom_candidates`：与该范围重叠的实际页面元素。

前五个区域生成裁剪图和 DOM 候选，其余区域在完整报告中保留统计，`crops=null`。完整截图和差异图用于查看上下文。图像不会通过单独平移、拉伸或缩放来提高评分。

差异范围可能跨越多个组件。整体偏移也可能形成一个大区域；区域数量不能解释为组件错误数量。

## DOM 关联

[dom-evidence.ts](../packages/core/src/regions/dom-evidence.ts) 采集可见元素的文字摘要、边界、选择器和实际样式。

- 最多保存 2000 个元素，遍历上限 20000 个节点；截断时返回 `dom_truncated=true`。
- 单元素文字摘要最多 200 字符，过滤密码、隐藏输入等敏感内容。
- 坐标转换到最终截图像素，计入 DPR、组件原点和裁剪偏移。
- `bbox_px` 是可见交集，`full_bbox_px` 是完整边界。
- 每个差异区域最多关联三个候选；选择器经过唯一性检查，无法确定时返回 `unavailable`。
- `actual_styles` 使用浏览器样式属性名，例如 `font-size`、`line-height`、`padding`、`overflow`。

DOM 关联依据是边界重叠，不是根因判断。实际样式描述候选页面，不推断参考图中的 CSS。Canvas 内部和跨域 iframe 内部元素不在采集范围内。

## 轮次比较

系统选择同一任务最近一次完成的有效评测作为比较对象，并检查参考图、profile、评测器、环境指纹、反馈版本和图像尺寸。

比较结果包含分数变化、差异比例变化、阻断新增/解除，以及区域的 `new`、`resolved`、`persistent`、`split`、`merged`、`reorganized` 变化。区域比例变化在前后轮范围的并集上计算，避免范围变化产生虚假的改善。

首轮或条件不一致时返回 `comparison=null` 及原因。微小变化按照配置中的噪声阈值判断。

## MCP 结果与资源

`submit/status` 返回 `score`、`verdict`、`issues`、`blockers`、`budget_remaining`、`next_action` 和 `visual_feedback`。

反馈字段示例（数值为说明用途）：

```json
{
  "visual_feedback": {
    "feedback_version": "visual-feedback-v1",
    "status": "available",
    "reason": null,
    "regions_total": 0,
    "regions_omitted": 0,
    "dom_truncated": false,
    "regions": [],
    "comparison": null,
    "comparison_unavailable_reason": "first_evaluation"
  }
}
```

摘要最多展示五个区域、每区三个 DOM 候选、二十条区域变化和八条 issues，总 JSON 上限约 32KB。省略数量通过对应计数字段说明。`full_report` 指向完整持久报告，`harness://artifacts/{artifact_id}` 提供图像资源。

Agent 需要实际读取图像。宿主无法读取资源时，应说明证据访问限制；不能把 URI 当作已经看过的图片。

## 验收与验证范围

视觉反馈提供修复证据；通过条件由评分、阻断检查和 profile 校准状态决定。没有参考标注时，layout/text 分数为 null；DOM 候选不会自动成为参考标准或关键区域断言。

默认 profile 为 provisional。`start.profile_id` 可选择已存储并审核的配置；正式通过要求达到阈值、没有阻断且配置已验证。取消、停滞、预算耗尽和配置待审核按任务策略结束。

反馈计算或证据写入失败会使本轮失败，返回 unavailable 反馈。系统不会伪造差异区域或静默通过。

工程测试覆盖差异像素统计、遮罩、区域合并/分裂、DPR与裁剪坐标、DOM采集、图像资源读取和报告展示。真实 Codex 对话的读图质量、修复效率和自动收敛效果仍需实测。
