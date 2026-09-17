已完整通读两个 CSS 文件与四个页面的 HTML/CSS（JS 仅在与 UI 相关处核对）。以下为评审结果。

# multi-proxy-manager 前端 UI 字段级评审

## 总评
设计系统骨架是健康的：有独立令牌层（colors_and_type.css）＋共享组件层（shared-styles.css），四页面统一引入，暗色模式、reduced-motion、移动端侧边栏都有覆盖。但存在三类系统性问题：**① 大量基础样式在共享文件和各页面内联重复定义且已经出现分歧；② 硬编码颜色逃逸遍布四页；③ proxy-config.html 与其他三页在导航模式/暗色模式/组件实现上明显掉队**。另有一个致命 JS 语法错误。

---

## 一、致命 Bug

1. **`apiKey: ***` 是非法 JS 语法，会导致整段脚本无法解析** — proxy-config.html:894 和 1926 两处 `JSON.stringify({ ..., apiKey: *** })`。无论是否为脱敏产物，现状下该页所有交互（含 init()）全部失效。必须修复。
2. **proxy-config.html 完全没有暗色模式初始化** — 全文件无 `initDarkMode()`、无 `darkModeToggle`（对比 dashboard.html:1421-1448、logs.html:1114）。用户在 Dashboard 开暗色后跳到配置页会闪回亮色，令牌虽在但 `:root.dark` 类永远不生效。
3. **login.html 同样无暗色模式**：html 硬编码 `class="light"`（login.html:2），且无任何切换/读取 localStorage 的逻辑。暗色用户每次登出都会被闪瞎一次。
4. **proxy-config.html 缺少字体加载链** — 没有 Google Fonts preconnect/link（对比 dashboard.html:7-9、logs.html:7-9、login.html:10-12），导致该页 Inter/JetBrains Mono 回退到系统字体，与其他三页渲染不一致。

## 二、设计令牌体系完整性

**好的：**
- 颜色、圆角、阴影、过渡、布局宽度全部令牌化且有完整暗色映射（colors_and_type.css:1-91），`:root.dark` 覆盖策略干净，组件层零改动即可换肤——这是正确的架构。
- 阴影三级（sm/md/lg）、圆角三级（sm/md/lg）、过渡两档，粒度合适。

**问题：**
- **间距无令牌**：colors_and_type.css 只声明了 radius/shadow/layout，没有 `--space-*` 尺度。结果 padding/margin 全是裸 px 且取值发散：14/16/18/20/22/24/28/32px 混用（dashboard.html:342 `padding:22px 24px` vs proxy-config.html:185 `padding:20px` vs login.html:143 `padding:32px 28px`）。
- **字号无令牌**：10/11/12/13/14/15/17/20/24/32px 共 10 档裸值散落各处（如 shared-styles.css:51,122,205; logs.html:291,389），且 shared-styles.css 头注声称"Rule D4: unified font-size"但实际并未收敛。
- **单位混用**：login.html 用 rem（121,129,172 行 `1.25rem/0.8125rem`），其余三页全用 px。同一系统两套度量。
- **z-index 无尺度**：90/100/150/200/9999/10000/99999 裸数字散布（shared-styles.css:140,498,515,834,726），建议收敛为 `--z-*` 令牌。

## 三、硬编码颜色逃逸（最严重的一致性债务）

暗色模式下的视觉断裂几乎全部来自逃逸色：

| 位置 | 问题 |
|---|---|
| dashboard.html:482-488 | `.proxy-icon.codex{background:#ede9fe}` `.hermes{background:#fef3c7}` 亮色粉彩背景不随主题切换，暗色下刺眼 |
| dashboard.html:219,236,248 | 三处 banner 文字/关闭按钮 `#92400e` 硬编码 |
| dashboard.html:534 | `.proxy-version-badge` 边框 `rgba(37,99,235,0.15)` 硬编码主色 RGB |
| logs.html:365-373 | proxy-tag codex/hermes 同样逃逸（cursor 反而正确用了令牌，同组内不一致） |
| logs.html:396-408 | level-badge 三色文字 `#1e40af/#92400e/#991b1b` 硬编码 |
| logs.html:243 | 边框 `#fde68a`（dashboard.html:211 同一 banner 却写成 `border-color: var(--color-warning-light)`——两页对同一组件写法不同） |
| login.html:51-52,101,222,347,421-428 | 品牌光晕/阴影/错误态大量 `rgba(37,99,235,…)`、`rgba(239,68,68,…)`、`#991b1b` |
| proxy-config.html:970-974 | `proxyColorMap` 整表十六进制，且 cursor 用 `#dbeafe/#2563eb` 而 dashboard 用令牌版 |
| shared-styles.css:165-183 | toast 四种文字色 `#065f46/#991b1b/#1e40af/#92400e`（好在 389-403 行做了暗色覆盖——这是唯一一处认真处理了逃逸色的地方，应作为范式推广） |
| shared-styles.css:277 | select 箭头 SVG 内联 `%2394a3b8`，暗色下不变 |
| shared-styles.css:669,677 | `.offline-banner` 边框 `#fde68a`、文字 `#92400e`，暗色 warning-light 变成 `#451a03` 后 `#92400e` 文字对比度约 1.8:1，几乎不可读 |

**建议**：为品牌代理色（codex 紫/hermes 琥珀/cursor 蓝）建立语义令牌 `--accent-codex-bg/--accent-codex-fg` 并入 `:root.dark` 映射；banner/toast 文字色改用「light 底×dark 字」的成对令牌。

## 四、CSS 架构

**好的：**
- 分层清晰：令牌层 → 组件层 → 页面层，命名扁平可读（`.stat-card`、`.filter-bar`、`.section-tab`），无 `!important` 滥用（仅 disabled transform 一处合理使用，shared-styles.css:128）。
- 事件委托替代内联 onclick 处理 XSS（proxy-config.html:1984-2026）、data-* 传参，符合 CLAUDE.md 记录的安全整改。

**问题：**
- **重复度失控**：reset/base、`.sidebar` 全套、`.mobile-menu-btn`、`.sidebar-overlay`、响应式块在每个页面内联重抄一遍，与 shared-styles.css 完全重叠。例如 `.sidebar` 定义了三次（shared-styles.css:504、dashboard.html:76、logs.html:76）；约 300 行/页 × 3 页的纯冗余。更糟的是**副本已经漂移**：
  - dashboard.html:37 `body{overflow:hidden}` vs shared-styles.css:469 `overflow:auto`；
  - dashboard.html:180 `.main` 多了 `max-height:100vh`，logs 版没有。
- shared-styles.css:473 和 620 存在近乎相同的 `.mobile-menu-btn` 与 `.hamburger-btn` 两个类。
- **内联样式泛滥（JS 生成 DOM）**：proxy-config.html:1306-1308 每个 `<code>` 都拖 120+ 字符的内联样式串，且 `'SF Mono',Menlo,monospace` 手写而不用 `var(--font-mono)`（1306,1307,1308,1756,1757,1938）；balance 卡（1709-1714）、模型列表（1934-1941）同理。应抽 `.code-chip` 类。
- 死代码：dashboard.html 的 `showDemoBanner/hideDemoBanner/dismissDemoBanner`（1247-1259）操作的 `#demoBanner` 元素不存在；`.page/.page.active` 切换逻辑（873-896）无对应 CSS 也只有一个页面；logs.html:998 `exportLogs()` 功能完整但界面上没有导出按钮。
- 注释失真：logs.html:508 "Rule 1: Unified sidebar-brand (NO .sidebar-brand)" 与事实相反；shared-styles.css:230 "NOT in media query" 这类规则编号注释与实际文件结构脱节。

## 五、一致性（跨页面）

- **两套 Toggle 并存**：dashboard 用自造 `.toggle-switch`（40×22，选中为主色蓝，dashboard.html:278-326），shared/proxy-config 用 `.toggle`（40×24，选中为绿色 success，shared-styles.css:314-356）。同一产品里开关颜色语义不同（蓝=刷新开关、绿=供应商启用），尺寸也不同。
- **Toast 两套实现**：dashboard/logs 带 SVG 图标＋`toast-out` 动画＋duration 参数（dashboard.html:850-870）；proxy-config 无图标、用 opacity 渐隐、2500ms 写死（1817-1829），且调用方传的第三参被静默丢弃（1693 行传了 2000）。
- **移动端导航两套模式**：dashboard/logs 用 `mobile-menu-btn`＋遮罩层（shared-styles.css:685-710），proxy-config 却用 `hamburger-btn`＋`sidebar-close`、无遮罩、点击外部不能关闭（proxy-config.html:17-49,534,505）。同一产品两种手势。
- **侧边栏内容不一致**：dashboard/logs 有动态代理列表＋ON/OFF 徽章＋暗色切换按钮；proxy-config 是静态三个链接、无徽章、无暗色按钮，图标容器类名还不同（`<span class="icon">` proxy-config.html:509,513 vs 其他页 `.nav-icon`，导致 shared-styles.css:563 的图标尺寸规则在此页失效）。
- 小杂项：logs.html:538 登出按钮文案用 `&nbsp;&nbsp;登出&nbsp;&nbsp;` 凑宽度；dashboard.html:733 自动刷新间隔的 `<select>` 没挂 `.form-select`，裸原生样式混在精致控件中间；login.html:207 输入框边框 1.5px，全站其余皆 1px。

## 六、暗色模式支持

- 架构正确（令牌级覆盖，前述）。已处理的细节值得肯定：toast 暗色文字覆盖（shared-styles.css:384-403）、toggle 滑块阴影加深（365-367）、阴影整体加重（colors_and_type.css:88-90）。
- 未覆盖面：第三节列出的所有硬编码浅色背景/文字在暗色下全部失效；`.toggle-slider::before` 固定白色滑块在暗色轨道上尚可但未调；login.html:110 半透明白高光 `rgba(255,255,255,0.2)` 在暗色下脏。
- 无 `prefers-color-scheme` 自动跟随，只有手动开关（可接受，但至少应在首次访问时读系统偏好）。

## 七、响应式与移动端

**好的：**
- 断点策略简单一致（≤768px），侧栏抽屉化＋transform 过渡＋遮罩（shared-styles.css:690-709）是标准做法；`.main` 移动端顶部留 72px 给悬浮菜单钮考虑周到。
- stat-grid 2→1 列（dashboard.html:625-627）、proxy-card 换行＋操作区下沉带分隔线（629-639）、filter-bar 纵向堆叠＋控件 100% 宽（logs.html:466-479）、表格 `overflow-x:auto`（proxy-config.html:283）都做得对。

**问题：**
- 断点不统一：login 用 480px（login.html:565），其余 768px；平板区间（769-1024px）完全空白，240px 侧栏＋480px 弹窗在中屏偏挤。
- proxy-config 移动端无遮罩层、侧栏打开后无点击外部关闭手段（只能点 × 或再点汉堡）。
- `.btn-icon` 样式竟然定义在 `@media(max-width:768px)` 内部（proxy-config.html:455-480）——桌面端若引用会直接失效，组件样式不应住在媒体查询里。
- loading-bar 的 `loading-slide` 动画用 `left` 属性做位移（shared-styles.css:854-857），每帧触发 layout，应改 `transform: translateX`。

## 八、可访问性

**好的：**
- `prefers-reduced-motion` 全局兜底四页齐备（dashboard.html:650-655 等）；密码显隐按钮有 `aria-label` 且随状态更新（login.html:856-876）、有 `:focus-visible` 外框（281-284）——这是全站焦点态的最佳范本；banner 关闭钮、汉堡钮、关闭侧栏钮都有 aria-label；登录表单 label/for、autocomplete（new/current-password）规范。

**问题：**
- **键盘导航半残**：`.nav-item` 是 div/a 加了 `tabindex="0"`（dashboard.html:676,685）但没有 keydown 处理——Tab 能聚焦、回车/空格无效（div 版完全不可激活）；且 `:focus` 态只显示 tooltip（shared-styles.css:256-259）没有背景/描边变化，键盘用户看不到焦点在哪。tooltip 出现在 `left: calc(100% + 8px)`，屏幕右缘的导航项 tooltip 会溢出视口。
- **全局 `.btn` 无 `:focus-visible` 样式**（shared-styles.css:45-129）：仅靠浏览器默认 outline，而多处又没动默认 outline 时观感割裂；`.form-input:focus` 用 `outline:none`＋box-shadow 替代（301-305）可以，但按钮没有等价物。
- **对比度多处不达 AA**：
  - `--color-text-tertiary #94a3b8` 于白底 ≈ 2.9:1（需 4.5），却用于 11-12px 的 hint/stat-label/version-info（shared-styles.css:578,781; dashboard.html:381）；
  - status-badge `#10b981` 文字于 `#d1fae5` 底 ≈ 2.3:1、`#ef4444` 于 `#fee2e2` ≈ 3.2:1（shared-styles.css:219-227），12px 正文级别双双不达标——badge 文字应换 deep 色（如 `#047857`/`#b91c1c`）；
  - 暗色 offline-banner 前文已述 ≈ 1.8:1。
- **弹窗可访问性缺失**：proxy-config 动态创建的 modal（1422-1509,1842-1907）无 `role="dialog"`/`aria-modal`/`aria-labelledby`、无焦点陷阱、不支持 Esc 关闭（login.html 的忘记密码弹窗反而三者有其二，1133-1137 有 Esc——又是页间不一致）；关闭后焦点不归还原按钮。
- 日志行点击复制只有 `title="点击复制日志内容"` 提示（logs.html:854），无键盘可达路径、复制成功依赖 toast 但 toast 无 `role="status"`/`aria-live`，屏幕阅读器收不到任何反馈。
- `confirm()` 原生弹窗与自定义 modal 混用（logs.html:960、proxy-config.html:1357,1776），风格断层。

## 九、优先级建议（Top 5）

1. 修 proxy-config.html:894/1926 的语法错误（P0，页面瘫痪级）。
2. proxy-config/login 补 `initDarkMode()`（或抽成共享 `app-common.js`），消灭主题断连。
3. 建立 accent/banner 语义色令牌并补暗色映射，清偿第三节的全部逃逸色。
4. 把每页重复的 reset/sidebar/mobile 块删掉只留 shared-styles.css，消除已发生的分叉；顺手统一 `.toggle-switch`→`.toggle` 和两套 toast。
5. 可访问性补课：`.nav-item` 键盘激活＋可见焦点态、`.btn:focus-visible`、badge/tertiary 对比度、动态 modal 的 role/Esc/焦点管理。

**未修改任何文件；本次为纯评审输出。**