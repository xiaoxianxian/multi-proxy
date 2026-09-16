# 视觉设计规范（visual-design）

> 提炼自 `multi-proxy-manager/public/colors_and_type.css`（明暗双主题 token 源）+ `*_html` 页面实测。
> 生成日期：2026-09-17（HEAD `f8a3413`，main）。所有 token 值从真实 CSS 提取，非臆造。

---

## 一、形态

管理面板是 **4 个独立 HTML 静态页**（`dashboard.html` / `logs.html` / `proxy-config.html` / `login.html` + `index.html` + `sessions.html`）+ 2 个共享 CSS（`colors_and_type.css` token 层 + `shared-styles.css` 组件层）。无前端框架，纯 CSS 变量 + 原生 JS。

- token 层：`colors_and_type.css`（品牌色 / 中性 / 排版 / 间距 / 阴影 / 明暗主题 / provider 配色）
- 组件层：`shared-styles.css`（卡片 / 按钮 / 表格 / toast 等）

---

## 二、Design Tokens（从 `colors_and_type.css` 提取）

### 2.1 品牌与语义色（Light）

| Token | 值 | 用途 |
|-------|----|------|
| `--color-primary` | `#2563eb` | 主操作 / 链接 |
| `--color-primary-hover` | `#1d4ed8` | 主色 hover |
| `--color-success` | `#10b981` | 成功 / 运行中 |
| `--color-warning` | `#f59e0b` | 警告 |
| `--color-error` | `#ef4444` | 错误 |
| `--color-info` | `#3b82f6` | 信息 |
| `*-deep` | `#991b1b`/`#92400e`/`#1e40af`/`#065f46` | 彩色 badge/toast 文字（AA 对比） |

### 2.2 中性 / 文本 / 排版

| Token | 值 |
|-------|----|
| `--color-bg` / `-secondary` / `-tertiary` | `#ffffff` / `#f8fafc` / `#f1f5f9` |
| `--color-text` / `-secondary` / `-tertiary` | `#0f172a` / `#475569` / `#94a3b8` |
| `--font-family` | `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` |
| `--font-mono` | `'JetBrains Mono', 'SF Mono', Menlo, monospace` |

### 2.3 间距 / 圆角 / 阴影 / 过渡

| 类别 | Token | 值 |
|------|-------|----|
| 圆角 | `--radius-sm/md/lg` | `6px` / `10px` / `14px` |
| 阴影 | `--shadow-sm/md/lg` | `0 1px 2px` / `0 4px 12px` / `0 8px 24px` |
| 过渡 | `--transition-fast` / `-normal` | `150ms ease` / `200ms ease` |
| 布局 | `--sidebar-width` / `--main-padding` | `240px` / `32px` |

### 2.4 明暗主题

`:root.dark` 整体覆盖 bg/secondary/tertiary/text/border/shadow 与语义色的 dark 变体（如 `--color-primary: #3b82f6`、`--color-bg: #0f172a`）。深色阴影透明度从 `0.04-0.08` 提到 `0.3-0.5`。

### 2.5 Provider 品牌色（仅 dark）

| Token | 值 | 绑定 |
|-------|----|------|
| `--color-prov-codex-bg/fg(+dark)` | `#ede9fe`/`#7c3aed` / `#2e1065`/`#c4b5fd` | Codex 紫色 |
| `--color-prov-hermes-bg/fg(+dark)` | `#fef3c7`/`#d97706` / `#451a03`/`#fde68a` | Hermes 琥珀 |

> provider 配色在 dark 主题定义明暗两套 fg/bg（`-dark` 后缀），用于 proxy-config / dashboard 的供应商标识。

---

## 三、主题切换

- 默认 Light；`:root.dark` 类驱动 Dark。
- 切换入口：`shared-styles.css` 内的 theme toggle（`.js` 切 `<html class>`/`:root`）。
- 跨页面主题同步：`dashboard.html` / `proxy-config.html` 用 `BroadcastChannel('proxy-status')` 同步状态；主题偏好存 `localStorage`。

---

## 四、组件规范（`shared-styles.css`）

| 组件 | 约定 |
|------|------|
| 卡片 | `--radius-lg` + `--shadow-md` + `--color-bg-secondary` |
| 按钮 | 主按钮 `--color-primary`；hover `--color-primary-hover`；过渡 `--transition-fast` |
| 表格 | `--color-border-light` 分隔，`--font-mono` 数值列 |
| Toast | 彩色 badge 用 `*-deep` 文字保 AA 对比 |

---

## 五、一致性要点（从 CLAUDE.md 已知点）

- 供应商启用 toggle：`checkbox` 用 `pointer-events: none` + `opacity: 0` 隐藏，`label` 包裹整个 toggle 区域点击触发（非标准 radio 样式）。
- 跨页面状态：`stop/start` 成功后广播 `proxy-status-changed`，其它页面 `loadStatus()` 刷新（实时同步，不整页重载）。
- 加载态：全局 loading bar CSS 动画（P1-4），8 个 API 调用包裹 loading 状态。

---

## 六、缺口 / 待确认

| 项 | 状态 |
|----|------|
| 响应式断点（移动端） | 未见媒体查询，桌面壳场景为主 |
| 设计系统文档化（Storybook/Figma） | 无，token 仅存于 CSS |
| 暗色下 provider 色的 `light` 变体 | 未在 `:root` 定义，仅 `:root.dark` |

---

## 数据源

- token 值：`multi-proxy-manager/public/colors_and_type.css`（107 行，全量提取）
- 组件层：`multi-proxy-manager/public/shared-styles.css`
- 主题同步 / toggle 交互：`CLAUDE.md §前端路由` + 实测页面
- 评估原标 `[待确认]` 因判断为"纯静态页无设计系统"——实查 token 层完整，本稿据实纠正。
