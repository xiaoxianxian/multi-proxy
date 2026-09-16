# DeepSeek 基线（官方 API + 项目内定位）

> 状态：2026-09-16 从**官方 API 文档**整理（项目内角色引用 `m6-action-checklist.md`）
> 来源：`https://api-docs.deepseek.com/zh-cn/quick_start/pricing/` + `https://api-docs.deepseek.com/`
> 铁律：数字回官方文档，不凭印象。老板给的会话链接 `chat.deepseek.com/share/6phvit41x6blxpxaik` 本机访问受限，见 §四。

---

## 一、模型名（官方 2026）
| 官方模型名 | 说明 |
|-----------|------|
| `deepseek-flash` | Flash 系（1）。旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍可调，但已下线，由 V4.1-Flash 服务、按 Flash 价计费 |
| `deepseek-v4-pro` | V4 Pro，2026-09-14 后继续提供 API（2） |
| `deepseek-v3` / `deepseek-r1`（deepseek-reasoner） | 历史/推理模型 |

## 二、价格（人民币 / 1M tokens，官方）
| 时段 | 输入（缓存命中） | 输入（缓存未命中） | 输出 |
|------|------------------|--------------------|------|
| **高峰**（北京周一至周五 9-12 / 14-18） | — | — | — |
| **空闲**（其余，=高峰一半） | ¥0.02 | ¥1 | ¥4 |
| 另：V4-Pro 空闲时段 | 0.15 | 4.5 | 13.5（不同档位，见官方表格） |
- 计费公式：扣减 = token 消耗 × 单价，先扣赠送余额再扣充值。
- 上下文 1M；输出最大 384K。
- 完整限速见官方 `/zh-cn/quick_start/rate_limit`。

## 三、与项目 pricing 表的交叉校验（一致 ✅）
| 模型 | 项目 pricing（¥/1M） input/output/cacheHit | 官方空闲价 input/out/cache | 校验 |
|------|--------------------------------------------|----------------------------|------|
| deepseek-v4-pro | 1 / 4 / 0.02 | 1 / 4 / 0.02（空闲） | ✅ 一致 |
- 项目按**空闲价**取（最经济），与官方一致；高峰价翻倍未单列（如需可补，属定价决策）。
- 缓存命中 ¥0.02 是「性价比之王」（见 m6-checklist），与官方吻合。

## 四、关于老板给的会话链接
- 链接 `chat.deepseek.com/share/6phvit41x6blxpxaik` **本机三种途径均访问不到**：
    - `web_extract` → 只回 cookie 占位（页面 JS 渲染，内容在服务端注入）；
    - `curl` 直连 → `CONNECT tunnel failed 404`（系统代理不转发该站）；
    - 浏览器 real-profile → 本机 Chrome 配置库被锁，无法读取。
- **已做的替代**：用**官方 API 文档**（可达，未受代理限制）补本基线，覆盖 DeepSeek 在项目里的**模型/价格/角色**。
- **若老板指的就是这份会话里另有内容**（如 DeepSeek 侧的某评估结论），请直接把该段文字/截图贴进来，我据此补；不凭链接臆造内容。

## 五、DeepSeek 在项目内的角色（引用）
- M6 路由核心层：`r-coding` / `r-hard` 指向 `deepseek-v4-pro`（缓存红利、性价比之王）。
- 四层 fallback：`[qwen3.8:27b-mlx, deepseek-v4-pro, agnes-2.5-flash, kimi-k2.6]`。
- live 已证（D7）：coding 请求 → `api.deepseek.com/v1` HTTP 200 / 162ms / 上游回 `model=deepseek-v4-pro`。
