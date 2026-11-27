# Nexus UI 工程约定规范（Design System Spec v1.0）

## 仓库实施决策（2026-11-28）

- 本文是视觉工程的唯一事实来源；[改版手册](UI_REFACTOR_PLAYBOOK.md)规定 P0 → P1 → P2 的推进顺序。旧设计文档中的字体、颜色与密度描述以本文为准，交互行为仍参考各专项文档。
- 默认采用森林绿 `#2E6F5E`，保留规范允许的石墨选项；旧蓝／砂／粉主题偏好兼容映射为森林绿。每个主题中只使用一个强调色，不使用渐变、分支轮换色或按日程种类染色。P0/P1 使用危险／警告语义，P2 使用强调色，P3 使用中性辅助色。
- 原文冲突以第二部分工程规范为准：布局分割线透明度 0.06，微型进度字号 11px，按钮与分段滑块统一 `--shadow-xs`；根节点使用双层 `--shadow-sm`。
- `packages/ui/src/tokens.css` 集中定义语义值；`theme.css` 的旧名称只作兼容别名。业务代码使用语义变量或其 Tailwind 工具类，不能新增底层色板值。Canvas 测量数字统一放在 `packages/ui/src/tokens.ts`，与 CSS 规格一致。
- 4px / 2px 为通用间距；规范明确的控件内边距 10px、节点内边距 14px、徽章内边距 5px 是有名的组件 Token，不扩展为任意间距。边框／轮廓厚度、几何坐标、百分比、用户字号及安全区不属于通用间距。圆形／胶囊使用 `--radius-pill`；共心嵌套控件遵守圆角公式（例如分段 8 = 6 + 2，菜单 10 = 6 + 4），不是把任意卡片中的每个独立控件当成共心容器。
- 已有用户指定的节点颜色／字体／字号和习惯颜色属于用户内容，继续显示与同步，不重写历史数据；默认节点统一 UI 字体、14px/600、白底。导图长标题保留完整换行，导航、工具栏和列表长标题截断。保留用户显式选择的直线／折线，默认曲线严格采用本文控制点公式。
- 深色模式是同一语义系统的 Slate 扩展；反色文字和终端颜色都有独立语义 Token。警告、成功的填充色与可读文字色分开，辅助文字在浅灰底上必要时提升为 `--text-secondary`，保证正文和标签对比度 ≥ 4.5:1。禁用／纯装饰内容例外。
- 桌面侧栏默认 232px，可调范围 220–240px，旧宽度兼容约束到新范围；移动端继续保留安全区与手势。桌面主行 52px、副行 40px；窄桌面次要操作进入“更多”，筛选可水平滚动，不挤出第三行。
- 保留列表、导图、四象限、甘特图、日历五视图。默认字体 Inter 在本地加载，中文回退系统字体；用户选择的授权字体继续按需加载。
- 本规范约束默认产品界面，不限制用户文档中的 Markdown 内容样式、图表数据坐标、终端 ANSI 内容。改变这些例外必须有明确产品需求，不能用于绕过 Token 规则。

## 验证入口

`pnpm lint:ui` 检查源码中的字面颜色、自定义阴影、非网格间距与超时长动效；`pnpm typecheck`、`pnpm build`、`pnpm test` 验证编译和现有行为；`e2e/specs/ui-engineering.spec.ts` 在独立临时实例检查默认主题、桌面尺寸、状态、曲线、点阵、极端标题／计数和移动端。发布按 [RUNBOOK](RUNBOOK.md)保留回滚镜像并备份完整数据。

以下保留用户给定的完整规范；上面的实施决策只解释歧义和兼容边界。


本规范为项目唯一 UI 事实来源（Single Source of Truth）。所有手写代码与 AI 生成的界面代码均须严格遵守。

## 1. 硬性设计红线（Hard Constraints）

1. 禁止魔法数值：业务组件中禁止直接出现硬编码的 Hex 色值、非规范间距（如 13px、17px）和自定义 box-shadow，必须引用 Design Tokens。
2. 禁止纯黑与纯灰：禁止使用 #000000 作为文字或背景色；所有中性灰必须来自 Slate 色系。
3. 禁止用边框代替留白：能通过 16px–24px 间距区分的区块，禁止添加分割线。
4. 禁止无理由投影：浅色模式下，非悬浮元素（如静态列表项、普通侧边栏区块）禁止添加阴影；阴影仅用于表达物理层级的抬升（Button、Popover、Canvas Node）。
5. 禁止不遵守圆角嵌套公式：任何嵌套圆角容器必须满足：

   $$R_{\text{outer}} = R_{\text{inner}} + \text{padding}$$

## 2. Design Tokens 定义

### 2.1 语义色彩系统（Semantic Color Tokens）

业务代码只允许消费 Semantic Token，禁止直接消费底层色板。

| Token 名称 | 浅色模式值（Slate + Accent） | 对比度 / 用途说明 |
| --- | --- | --- |
| --bg-canvas | #FFFFFF | 主工作区、画布、卡片默认底色 |
| --bg-subtle | #F8FAFC | 侧边栏底色、次级面板底色 |
| --bg-muted | #F1F5F9 | 分段控制器槽底、Badge 底色、`<kbd>` 底色 |
| --bg-hover | rgba(15, 23, 42, 0.04) | 列表项、图标按钮 Hover 态叠加层 |
| --bg-active | rgba(15, 23, 42, 0.07) | 按下态（Pressed）或侧边栏选中态 |
| --border-hairline | rgba(15, 23, 42, 0.06) | 区域大分割线（Sidebar 右侧、Header 底部） |
| --border-default | rgba(15, 23, 42, 0.10) | 按钮、输入框、普通卡片描边 |
| --border-strong | rgba(15, 23, 42, 0.18) | Hover 态边框、强调描边 |
| --text-primary | #0F172A | 主标题、核心正文、激活态文字（对比度 > 15:1） |
| --text-secondary | #475569 | 导航项、次级标签、普通图标（对比度 > 7:1） |
| --text-muted | #64748B | 辅助说明、时间戳、计数、快捷键（对比度 > 4.5:1，满足 WCAG AA） |
| --text-disabled | #94A3B8 | 禁用态文字、Placeholder、装饰性图标（禁止用于需清晰阅读的正文） |
| --accent-primary | #2E6F5E（或 #18181B） | 品牌主强调色、主 CTA、聚焦指示 |
| --accent-surface | rgba(46, 111, 94, 0.08) | 强调色浅底（如筛选激活胶囊） |
| --status-danger | #DC2626 | 逾期、删除、错误 |
| --status-warning | #D97706 | 高优先级、警告 |
| --status-success | #16A34A | 已完成状态 |

### 2.2 排版系统（Typography Scale）

- 字体栈：英文/数字优先使用 Inter / -apple-system / SF Pro Text；中文回退至 PingFang SC / Noto Sans SC；代码与快捷键使用 JetBrains Mono / SF Mono。
- 数字规则：所有涉及计数、进度（1/21）、日期、列表对齐的数字，强制启用等宽数字（font-variant-numeric: tabular-nums），防止数字变动时布局抖动。

| 层级 Token | 字号 | 行高 | 字重 | 字距（Letter Spacing） | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| --text-page-title | 18px | 24px | 600 | -0.02em | 页面/视图主标题（如 AIDD & Bio） |
| --text-section-title | 14px | 20px | 600 | -0.01em | 卡片/导图节点标题、弹窗标题 |
| --text-body | 13.5px | 20px | 450 | 0 | 导航项、任务标题、正文内容 |
| --text-control | 13px | 18px | 500 | 0 | 按钮、筛选 Tab、分段控制器 |
| --text-caption | 12px | 16px | 500 | 0.01em | 分组小标题（如 快捷视图）、面包屑 |
| --text-micro | 11px | 14px | 500 | 0.02em | Badge 数字、`<kbd>` 快捷键、节点进度 |

### 2.3 空间与栅格（Spacing & Radius）

- 基准网格：以 4px 为基准单位，密集型桌面控件允许使用 2px 微调步长。
  ⚬ 标准间距枚举：2, 4, 6, 8, 12, 16, 20, 24, 32。
- 亲密性硬规则：任意容器的外部间距 margin / gap 必须严格 \ge 内部相关元素间距。
- 圆角枚举：
  ⚬ --radius-xs: 4px（`<kbd>`、小徽章、Checkbox）
  ⚬ --radius-sm: 6px（侧边栏菜单项、分段控制器内部滑块、小型按钮）
  ⚬ --radius-md: 8px（标准按钮、输入框、分段控制器外框、普通导图节点）
  ⚬ --radius-lg: 10px（导图根节点、悬浮弹窗、Popover）

### 2.4 景深与阴影系统（Elevation）

全站仅允许使用以下 3 级阴影，禁止自行拼接：

- --shadow-xs（微浮起：按钮、分段滑块、普通节点）：
  0 1px 2px 0 rgba(15, 23, 42, 0.05)
- --shadow-sm（中浮起：导图根节点、Hover 卡片）：
  0 4px 12px -2px rgba(15, 23, 42, 0.10), 0 0 0 1px rgba(15, 23, 42, 0.06)
- --shadow-md（顶层浮层：Dropdown、Context Menu、Modal）：
  0 12px 28px -4px rgba(15, 23, 42, 0.14), 0 0 0 1px rgba(15, 23, 42, 0.08)

## 3. 交互状态机与动效规范（Interaction & Motion）

所有可交互组件必须完整实现以下 5 种状态，不得缺失：

| 状态 | 视觉响应规范 |
| --- | --- |
| Hover | 背景叠加 --bg-hover；带边框控件边框由 --border-default 切换为 --border-strong。 |
| Active (Pressed) | 背景切换为 --bg-active；按钮类允许 scale(0.985) 微缩反馈。 |
| Selected | 侧边栏项使用 --bg-active + --text-primary（字重升至 550）；Tab 项使用 --accent-surface + --accent-primary。 |
| Focus-Visible | 键盘导航触发时，外圈显示 2px 轮廓（outline: 2px solid var(--accent-primary); outline-offset: 1px），鼠标点击不显示。 |
| Disabled | 整体不透明度降至 0.45，移除 Hover 反馈，禁用指针事件。 |

- 动效曲线与时长：
  ⚬ 颜色/透明度/边框切换：120ms cubic-bezier(0.2, 0, 0, 1)
  ⚬ 位移/尺寸/弹窗展开：180ms cubic-bezier(0.2, 0, 0, 1)
  ⚬ 禁止使用超过 300ms 的慢速过渡，禁止使用弹性过冲（bounce）曲线破坏工具的利落感。

## 4. 核心组件工程规格（Component Specs）

### 4.1 侧边栏主操作按钮（如 + 添加任务）

- 尺寸：宽 100%（父容器左右 padding: 12px），高 34px，内边距 0 10px。
- 结构：[16px 图标] --8px-- [13px/500 标题] --flex:1-- [`<kbd>` 快捷键]。
- 样式：bg: --bg-canvas、border: 1px solid --border-default、radius: --radius-md、shadow: --shadow-xs。

### 4.2 顶部筛选栏项（Filter Pill）

- 高度：28px，左右内边距 10px，圆角 --radius-sm，项间距 4px。
- 内部计数徽章：与文字间距 6px，高 18px，最小宽 18px，左右内边距 5px，圆角 999px，字号 11px（tabular-nums），bg: --bg-muted，color: --text-muted。

### 4.3 图标规范（Iconography）

- 全站锁定单一图标库（推荐 Lucide 或 Phosphor Regular），禁止混用线性图标与实心图标。
- 统一尺寸：16px（导航/按钮/筛选）、14px（辅助箭头/关闭/节点内微图标）。
- 统一描边粗细：1.5px（避免默认 2px 在桌面端显得笨重）。

## 5. 图谱 / 导图画布专项规范（Graph Canvas Spec）

1. 无限画布背景：纯白底 --bg-canvas + 点阵网格（间距 20px，点径 1px，色值 #E2E8F0；缩放比 < 0.5 时自动淡出点阵以防摩尔纹）。
2. 节点层级视觉区分：
  ⚬ Root 节点：深色反转卡片（bg: --text-primary 或 --accent-primary，text: #FFFFFF），圆角 --radius-lg，最小宽 160px，内边距 12px 16px，shadow: --shadow-sm。
  ⚬ Branch / Leaf 节点：纯白卡片（bg: --bg-canvas），border: 1px solid --border-default，圆角 --radius-md，内边距 10px 14px，shadow: --shadow-xs。
  ⚬ 节点选中态：border: 1.5px solid --accent-primary + 外发光环 0 0 0 3px var(--accent-surface)。
3. 连接线几何规范：
  ⚬ 默认色 #CBD5E1，线宽 1.5px；关联节点被选中或 Hover 时，路径高亮为 --accent-primary，线宽 2px。
  ⚬ 贝塞尔控制点公式（水平树状布局，起点 (x_1, y_1) 到终点 (x_2, y_2)）：

    $$C_1 = \left(\frac{x_1 + x_2}{2},\; y_1\right), \quad C_2 = \left(\frac{x_1 + x_2}{2},\; y_2\right)$$

    保证所有进出节点的切线严格水平，视觉流畅无折角。

## 6. 工程落地与 PR 视觉审查清单（Review Checklist）

在合并任何 UI 改动 PR 前，必须逐项通过以下检查：

- [ ] Token 合规：Diff 中无新增硬编码 Hex 颜色、无非 4px/2px 倍数的魔法间距。
- [ ] 文字对比度：所有可读正文与次级标签对比度 \ge 4.5:1，数字已开启 tabular-nums。
- [ ] 边框克制：不存在多余的双重叠加边框（如卡片边紧贴分割线导致 2px 粗线）。
- [ ] 圆角几何：嵌套组件均满足 R_{\text{outer}} = R_{\text{inner}} + \text{padding}。
- [ ] 状态完整：新增交互元素已覆盖 Hover / Active / Selected / Focus / Disabled 五态，且过渡时长 \le 180\text{ms}。
- [ ] 极端数据压力测试：超长中文/英文混合标题（触发 ellipsis 截断）、0 条数据空状态、大数字（如 999+）均未撑破布局。

