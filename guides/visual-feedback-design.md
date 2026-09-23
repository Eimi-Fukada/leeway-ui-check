# 视觉反馈设计：定位差异，让编码 Agent 决定如何修复

状态：首版已实现。新增报告采用 schema_version=1.1，继续读取旧1.0报告。下文为设计规范；实现差异与验证边界见末尾。

## 目标与职责

用户提供参考截图，编码 Agent 在业务项目工作区生成与修改代码。Harness 提供可重复测量、可定位的差异证据和验收结果，Agent 根据截图、源码和证据分析根因并修复。默认路径不要求用户手工标注全部页面元素，也不额外调用视觉模型。

Harness 应回答“哪里不同、测到了什么、比上一轮怎样”；Agent 决定“为什么不同、应该改哪个文件和样式”。只有参考区域、文字或交互要求已经明确时，Harness 才输出对应的元素级断言。不能从红色差异像素直接断言参考字体名称、padding 或业务行为。

沿用 workspace 执行方式及现有五个 Agent MCP 工具，不恢复源码快照，不新增远程服务。新增证据字段不等于改变评分算法。

## 三层反馈

| 层次                 | 内容                                                                | 依据与限制                                                   |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| 结果                 | 分数、可计算分项、阻断、预算、下一步、整图证据                      | 没有参考标注时 layout/text 为 null，明确使用两维诊断 profile |
| 差异定位（本次新增） | 差异区域、成对裁剪图、实际 DOM 候选、实际 computed styles、轮次变化 | 区域代表图像差异范围，不一定是一个组件；DOM 关联不等于根因   |
| 元素断言             | 已确认标题偏移、文字不一致、交互失败                                | 依赖固定的参考区域/文字/交互合同；沿用现有 issues 与 Gate    |

不把 Agent 从当前实现反推的区域或文字当作参考真值。后续人工确认的标注应创建新任务/参考版本，不覆盖既有评测标准。

## 单轮数据流

```text
ui_check_submit
→ 登记工作区 manifest
→ Playwright 稳定截图，同时采集实现侧 DOM 与样式
→ sharp 统一参考图和当前图
→ pixelmatch 产生评分数据、普通/严格差异图以及二值差异掩码
→ 差异区域提取 → 同坐标裁剪对 → DOM候选关联
→ 确定性评分与既有Gate
→ 与最近一轮可比较的有效评测比较
→ 保存完整报告和所有证据
→ MCP 返回有上限的摘要，Agent按需读取图片和完整报告
```

DOM 数据必须来自截图所在的同一页面状态，在交互测试之前采集；响应式探测的其他视口不能混入参考视口的 DOM 关联。评测期间源码变化沿用现有失败处理，不能拿旧代码的报告指导新版本。

## 差异区域提取

1. 在现有普通 pixelmatch 比较参数下取得明确的二值差异掩码。使用支持的 diff-mask 输出或等效的显式标记，不从普通展示图的任意颜色反推；与评分的差异像素数做一致性检查。
2. 剔除固定 profile 中的 ignore masks、被忽略的抗锯齿差异。严格差异图作为附加诊断，不混入普通评分掩码。
3. 使用确定性网格聚合及相邻单元合并，形成粗差异区域。初始候选参数：16px网格、8邻接、区域外扩8px。参数属于 feedback_version，不隐藏在评分公式里。
4. 每个区域记录原始差异像素数、有效像素数、区域内差异比例和全图差异贡献。无有效像素的区域不产生比例；不能除以零。
5. 合并结果保持不重叠；裁剪时外扩区域允许重叠，但排序和统计仍用外扩前范围。小差异不能静默丢弃，未展示部分归入省略计数并保留全图证据。
6. 页面整体偏移可能形成一个大区域，应保留它；不人为拆成几十个“组件错误”。大量离散细节则只展示优先区域。

排序建议：先关联已有关键阻断区域，再按差异像素数降序，最后用 y/x 坐标稳定排序。初始每轮摘要最多5个区域。排序只决定反馈顺序，不增加或减去评分。

## 成对裁剪证据

每个差异区域保存 reference、actual、diff 三张裁剪图。使用同一个 crop_bbox_px，裁到图像边界；不单独平移、拉伸或缩放实现图使其接近参考图。

保留完整截图，让 Agent 能判断局部差异是否由祖先容器偏移引起。标注边框另存诊断图，不能绘制到评分输入中。

图片写入 ArtifactStore，带 hash、媒体类型和尺寸。完整报告使用 artifact ID；MCP 摘要提供对应资源 URI。资源读取须复用现有路径/hash/体积检查。优先使用宿主支持的 MCP 图像内容或资源读取能力，不能只返回 URI 就假设 Agent 已看到图片；宿主不能读取时明确返回访问限制，不声称已完成视觉分析。

## 实际 DOM 关联

在 capture/runner 中增加受限的运行时 DOM 采集，而不是读取 index.html 猜测渲染结果。

- 优先采集可见文本、按钮、输入、图片和主要容器，过滤零面积、display:none、visibility:hidden 的元素；对不可访问的跨域 iframe、canvas 内部结构明确标记不支持。
- 初始限制最多2000个元素，单元素文字摘要最多200字符；超限输出 dom_truncated=true。不读取密码值、令牌或隐藏输入，遵循现有证据敏感信息边界。
- 坐标统一到最终截图像素：viewport坐标减组件原点，乘DPR，再减crop偏移；只转换一次。保留元素完整边界，计算关联时使用与截图的可见交集。
- 用交集面积、区域覆盖和元素可见面积比例产生关联排序，避免 body 等大祖先始终排第一；每个区域最多返回3个候选。指标是关联依据，不伪装为概率置信度。
- 优先使用唯一 data-testid 或 id，随后生成并验证CSS选择器；无法唯一定位时报告 ambiguous，不把首个匹配当确定答案。
- 提取实际 font-size、line-height、font-family、color、background-color、padding、margin、display、position、width、height、box-sizing、overflow、white-space、text-overflow。它们描述实现，不代表参考图应有的CSS。

DOM候选可以用来帮助 Agent 找代码，但不能自动成为关键区域 Gate，也不能因为“最近的元素是标题”就确认差异根因是标题。

## 前后轮变化

基准选择同一任务、参考hash、profile hash、evaluator version、截图环境及反馈版本下，最近一次有效完成的评测，允许它未达标。不能只和 best_candidate 比，因为目前最佳候选筛选会排除有阻断的版本。

- 返回 score_delta、difference_ratio_delta（比率单位）、新增/已解除 blockers。
- 区域用同一坐标系的重叠关系尝试匹配；明确支持 new、resolved、persistent、split、merged，不用数组下标当跨轮身份。
- 如需判定区域改善，在前后轮区域并集上重新统计两轮差异，避免因裁剪面积变化导致比例虚假下降。
- 首轮、环境变化或上一轮无有效指标时返回 comparison=null 和原因，不编造趋势。
- 微小变化低于已配置噪声阈值时标为 unchanged，不宣称模型取得进步。截图分辨率变化直接不可比较。

## 结构化合同

以下是拟新增的MCP反馈片段，数值仅用于说明，不是实测。新字段在当前合同严格拒绝未知属性的前提下需要显式升级 schema_version（建议1.1）并提供旧报告读取适配；feedback_version 独立记录区域提取算法版本。旧证据只读保留。

```json
{
  "schema_version": "1.1",
  "feedback_version": "visual-feedback-v1",
  "visual_feedback": {
    "status": "available",
    "regions_total": 1,
    "regions_omitted": 0,
    "dom_truncated": false,
    "regions": [
      {
        "difference_id": "diff_001",
        "bbox_px": { "x": 16, "y": 24, "width": 218, "height": 48 },
        "crop_bbox_px": { "x": 8, "y": 16, "width": 234, "height": 64 },
        "mismatched_pixels": 1200,
        "evaluated_pixels": 10464,
        "difference_ratio": 0.11467889908256881,
        "observed": "该范围有1200个像素被判定为差异",
        "crops": {
          "reference": "harness://artifacts/EXAMPLE_REFERENCE",
          "actual": "harness://artifacts/EXAMPLE_ACTUAL",
          "diff": "harness://artifacts/EXAMPLE_DIFF"
        },
        "dom_candidates": [
          {
            "selector": "[data-testid=title]",
            "match_status": "unique",
            "association_method": "bbox_overlap",
            "region_coverage": 0.8,
            "text_excerpt": "会员中心",
            "actual_styles": { "font_size": "24px", "line_height": "32px" }
          }
        ]
      }
    ],
    "comparison": null,
    "comparison_unavailable_reason": "first_evaluation"
  }
}
```

保留现有 score、components、blockers、issues、budget_remaining、next_action。visual_feedback 是证据，不混入必须有可靠基准的元素问题。无DOM匹配时 dom_candidates=[]，无差异时 regions=[]，采集失败时 status=unavailable，不能补一个假区域。

摘要初始上限5个区域、每区域3个DOM候选，并限制JSON总字节数（初值32KB）；超出按稳定顺序截断、明确计数。完整报告仍保存在工件中且可读取。图像不以base64字符串塞进JSON，额外图像内容也须受数量/字节上限控制。

区域分析失败属于反馈降级时，保留已成功计算的原始指标并返回 unavailable原因；若失败表明截图/数据完整性有问题，必须让本轮失败而非继续通过。不能静默忽略异常。

## Gate 与结束条件

此设计不改变 pixel/SSIM/DOM/text 的确定性 Gate，不把视觉模型或DOM关联猜测放入通过条件，不因新增区域定位给未标注任务补造 layout/text 分数。

Codex 读取 next_action 决定修复、查询或结束；Harness 不因给出建议而自行修改业务代码。等待评测时暂停修改工作区。预算、取消、停滞和配置阻断仍是有效停止原因。

当前 ui_check_start 只能创建 provisional profile，因此即使提供更好的反馈，也不能完成默认“达标后正式finalize”闭环。此问题需单独明确验收政策/已验证profile接入，不能借本次反馈设计暗中取消校准Gate。

## 实施拆分

| 顺序 | 拟修改位置                                        | 可审核产物                                                 |
| ---- | ------------------------------------------------- | ---------------------------------------------------------- |
| 1    | compare/images.ts + 新 regions/differences.ts     | 显式差异掩码、区域提取与固定参数、单元测试                 |
| 2    | capture/runner.ts + 新 regions/dom-association.ts | 有上限的运行时DOM采集、坐标转换、关联依据                  |
| 3    | 新 regions/crops.ts + storage/artifacts.ts        | 同坐标裁剪对、完整图及hash                                 |
| 4    | 新 reports/iteration-comparison.ts                | 可比较性检查、指标变化、区域匹配                           |
| 5    | contracts + scripts/schemas.ts + TaskService      | 版本化合同、旧报告读取、完整证据写入和摘要截断             |
| 6    | mcp/server.ts + report-web                        | 原五工具中返回增强反馈，验证宿主能实际读取图像，报告页展示 |

文件名为实现建议，均非本次已创建模块。不需要新增MCP工具或默认OCR/视觉模型依赖。

## 验收标准

- 完全相同的图片：无差异区域，无虚假DOM问题；全图评分保持原值。
- 小图标错误、文字颜色变化：能在摘要或明确省略统计中找到对应差异；裁剪不越界。
- 容器整体偏移16px：显示主要差异范围；无参考标注时不直接断言16px布局偏移，有标注时沿用几何事实。
- 白底大页面的小按钮错误：区域反馈不被全图比例掩盖；没有关键基准时不冒称关键组件Gate已经验证。
- mask、抗锯齿：二值掩码计数与评分分母一致；被批准忽略的像素不生成差异告警。
- DPR=2、组件截图、crop/滚动：裁剪和DOM框落在同一像素坐标，图像不被拉伸。
- 嵌套元素、重复文本、无唯一selector：候选关联明确不确定，不返回伪造的一对一映射。
- Canvas/iframe、超多元素：允许无DOM候选、截断或明确不支持，仍能提供像素证据。
- 前后轮区域分裂/合并、不同环境、失败后重试：趋势可解释，不把范围变化当改善。
- MCP：宿主实际读到成对图像；摘要有大小上限，可检索完整报告；超时与重试仍遵循原request_id语义。
- 回归：新证据模块不改变原有分数、阈值、交互和取消/预算逻辑。

效果实验另用同一任务、模型、初始代码与预算，对比“仅状态/分数”“整图证据”“局部图+DOM证据”。记录多次运行的成功率、轮数、时间和使用量；在执行之前不宣称新增反馈一定更快或更省token。

## 首版实现与验证边界

实际实现位于 `regions/visual-feedback.ts`（区域、裁剪、关联和趋势）、`regions/dom-evidence.ts`（运行时DOM）和 `contracts/src/feedback.ts`。未按设计表中的建议逐个拆文件。

- 网格为16px、8邻接，裁剪外扩8px。超过128个离散区域时合成一个粗区域以限制处理成本，保留全部差异像素统计；不承诺一框对应一组件。
- 全部区域计数保存在完整报告；只给前5个区域生成裁剪图和DOM候选，其余区域 `crops=null`。DOM上限2000个，遍历节点上限20000个；完整边界记录在full_bbox_px，可见交集记录在bbox_px。
- 每轮摘要最多5个区域、每区3个DOM候选、20条区域变化、8个原有问题。MCP提交/查询结果上限32KB，省略计数明确返回。通过full_report资源可读取未截断报告。
- 成功报告与失败报告写为1.1；失败报告反馈status=unavailable。旧1.0报告可读，无新增字段，不重写历史。
- 裁剪图通过原artifact资源读取。MCP协议客户端已测试实际读取PNG；真实Codex宿主的视觉读取和修复效率仍需单独验收。
- 反馈计算/证据写入错误当前采用保守失败处理，不会静默通过；细分可降级错误类型仍可完善。
- DOM关联不识别canvas内部结构或跨域iframe内部元素，不推断参考CSS，不增加评分权重。
- 新能力没有解除provisional阻断，也没有补造无标注任务的layout/text分数。
