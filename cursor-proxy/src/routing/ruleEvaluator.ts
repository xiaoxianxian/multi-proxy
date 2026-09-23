/**
 * M6 方向四 · 4b 规则条件求值器（白名单解析，禁用 eval/new Function）
 *
 * 输入 RoutingRule.condition 是一个受限表达式，例如：
 *   "taskType == 'coding'"
 *   "model.contains('vision')"
 *   "provider == 'glm' && model.contains('flash')"
 *   "taskType == 'cheap' || model.contains('agnes')"
 *   "privacy == true"
 *
 * 求值上下文（ctx）只暴露白名单字段：
 *   taskType | model | provider | messageLength | privacy | quality
 *
 * 解析策略（安全优先）：
 *   - **不使用 eval / new Function**（注入风险）。
 *   - 手写递归下降解析器（字面量 / 标识符 / 成员访问 / 方法调用 /
 *     比较 / 逻辑与或 / 括号 / 布尔非）。
 *   - 白名单字段 + 白名单方法，越界即抛 RuleEvalError；
 *     调用方 catch 后降级到 strategy 分支，主链路不崩溃。
 */

import { TaskType } from './taskClassifier.js';

// ---- 求值上下文（白名单投影）----
export interface RuleContext {
  taskType?: TaskType;
  model?: string;
  provider?: string;
  messageLength?: number;
  privacy?: boolean;
  quality?: string;
}

// 计费维度（老板 2026-09-22 拍板：API 按 token 计费 + coding plan 订阅计费，分开算）
//   token        —— 按量：input/output/cacheHit 每百万 tokens/人民币（现状，默认）。
//   subscription —— coding plan 会员订阅：月费 monthlyCny 按每周配额 monthlyQuotaTokens 均摊，
//                   单请求边际成本≈ monthlyCny / monthlyQuotaTokens × 本请求 tokens（接近 0）。
export type BillingMode = 'token' | 'subscription';

export interface Pricing {
  input: number;      // 每百万 input tokens，人民币（token 模式 / 或订阅均摊的兜底单价）
  output: number;     // 每百万 output tokens
  cacheHit?: number;
   // ---- 双计费维度（可选；缺省即 token 模式，逐字节向后兼容）----
  billingMode?: BillingMode;    // 默认 'token'。'subscription' 时启用订阅均摊（需门控开）。
  monthlyCny?: number;          // 订阅月费（人民币 / 月）；订阅维度专用。
  monthlyQuotaTokens?: number; // 订阅每月配额 tokens；均摊分母。缺省或为 0 → 退化 token 计价。
   // ---- Q1 价表扩展（2026-09-22 架构 §3.1/§3.5；全可选，缺省=现状逐字节不变）----
  currency?: string;            // 原生币种（'CNY'|'USD'|...，Q4：保留不丢）。缺省视为 'CNY'。
  source?: string;             // 价来源：'official-openai'|'openrouter'|'user'|...（L0/L2 标注用）。
  channel?: string;           // 渠道：'official'|'openrouter'|...（Q1 同模型多渠道）。
  _userSet?: boolean;          // 用户手动覆盖标记：漂移是否覆盖的分水岭（_userSet:true 永不自动覆盖，§3.2）。
  updatedAt?: string;          // 该价最后更新时间（ISO 或 YYYY-MM-DD）
   subscriptionId?: string;    // 所属订阅(§3.9 共享配额;缺省=独立)。可选,estimateCost 不读,不影响路由。
}

/**
 * 订阅计费门控（内核内决定，默认关）。
 *
 * PROXY_BILLING_MODE:
 *   未设 / 'token' / '' / 任意非 'subscription' 值 → 关（默认）：estimateCost 走 token 计价，
 *   行为与改造前逐字节一致（向后兼容，绝不改变现有路由选择）。
 *   'subscription'（大小写 / 前后空格不敏感）→ 开：Pricing.billingMode==='subscription' 的
 *   候选按月费均摊计价（边际成本≈月费/配额，接近 0）。
 *
 * 门控权在内核：默认关时，即便某 provider 配了 subscription 字段，也仍按 token 计价，
 * 行为不变（kimi 仍因 token 单价贵而排在 deepseek 之后——这正是"kimi 不是永不被选中"）。
 */
export function isSubscriptionBillingEnabled(): boolean {
  const v = String(process.env.PROXY_BILLING_MODE ?? '').trim().toLowerCase();
  return v === 'subscription';
}

// 白名单字段
const ALLOWED_FIELDS = new Set<string>([
  'taskType', 'model', 'provider', 'messageLength', 'privacy', 'quality',
]);

// 白名单方法：receiver 必为 string；签名 (self, arg) => boolean
const ALLOWED_METHODS: Record<string, (self: string, arg: unknown) => boolean> = {
  contains: (self, arg) => self.includes(String(arg)),
  includes: (self, arg) => self.includes(String(arg)),
  equal: (self, arg) => self === String(arg),
  startsWith: (self, arg) => self.startsWith(String(arg)),
  endsWith: (self, arg) => self.endsWith(String(arg)),
};

// ---- Token 流 ----
type Token =
  | { type: 'ident'; value: string }
   | { type: 'string'; value: string }
   | { type: 'number'; value: string }
   | { type: 'op'; value: string }
   | { type: 'lp'; value?: undefined } | { type: 'rp'; value?: undefined }
   | { type: 'dot'; value?: undefined } | { type: 'comma'; value?: undefined }
   | { type: 'eof'; value?: string };

/** 异常：解析 / 求值失败时抛出，调用方 catch 后降级到 strategy。 */
export class RuleEvalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RuleEvalError';
  }
}

// 词法器：把 condition 串切成 token 流。
function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const twoCharOps = ['==', '!=', '<=', '>=', '&&', '||'];
  const oneCharOps = ['<', '>', '!', '(', ')', '.', ','];

  while (i < src.length) {
    const ch = src[i];

    // 空白跳过
    if (/\s/.test(ch)) { i++; continue; }

    // 字符串字面量 '...' 或 "..."
    if (ch === "'" || ch === '"') {
      const q = ch;
      let s = '';
      i++;
      while (i < src.length && src[i] !== q) {
        s += src[i];
        i++;
      }
      if (i >= src.length) throw new RuleEvalError('unterminated string literal');
      i++; // 跳过收尾引号
      tokens.push({ type: 'string', value: s });
      continue;
    }

    // 数字
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let s = '';
      while (i < src.length && /[0-9.]/.test(src[i])) {
        s += src[i];
        i++;
      }
      tokens.push({ type: 'number', value: s });
      continue;
    }

    // 标识符 / 字面量
    if (/[A-Za-z_$]/.test(ch)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) {
        s += src[i];
        i++;
      }
      tokens.push({ type: 'ident', value: s });
      continue;
    }

    // 二元运算符（优先）
    let matched = false;
    for (const op of twoCharOps) {
      if (src.startsWith(op, i)) {
        tokens.push({ type: 'op', value: op });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 一元 / 标点
    if (oneCharOps.includes(ch)) {
      tokens.push(ch === '(' ? { type: 'lp' }
        : ch === ')' ? { type: 'rp' }
        : ch === '.' ? { type: 'dot' }
        : ch === ',' ? { type: 'comma' }
        : { type: 'op', value: ch });
      i++;
      continue;
    }

    throw new RuleEvalError(`unexpected char at ${i}: '${ch}'`);
  }

  tokens.push({ type: 'eof' });
  return tokens;
}

// 递归下降解析器（优先级：or → and → comparison → primary）。
class Parser {
  private pos = 0;
  constructor(private toks: Token[], private ctx: RuleContext) {}

  private peek(): Token { return this.toks[this.pos]; }
  private next(): Token { return this.toks[this.pos++]; }
  private expect(type: string): Token {
    const t = this.next();
    if (t.type !== type) throw new RuleEvalError(`expected ${type} but got ${t.type}`);
    return t;
  }

  parse(): boolean {
    const v = this.parseOr();
    if (this.peek().type !== 'eof') {
      const nt = this.peek();
      const desc = 'value' in nt ? `'${nt.value}'` : nt.type;
      throw new RuleEvalError(`unexpected token after expression: ${desc}`);
     }
    return Boolean(v);
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.peek().type === 'op' && (this.peek() as any).value === '||') {
      this.next();
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseComparison();
    while (this.peek().type === 'op' && (this.peek() as any).value === '&&') {
      this.next();
      const right = this.parseComparison();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseComparison(): unknown {
    let left = this.parseUnary();
    const t = this.peek();
    if (t.type === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.value)) {
      this.next();
      const right = this.parseUnary();
      return this.applyCompare(t.value, left, right);
    }
    return left;
  }

  private parseUnary(): unknown {
    const t = this.peek();
    if (t.type === 'op' && t.value === '!') {
      this.next();
      return !this.parseUnary();
    }
    return this.parsePrimary();
  }

  private applyCompare(op: string, l: unknown, r: unknown): boolean {
    switch (op) {
      case '==': return l === r;
      case '!=': return l !== r;
      case '<':  return Number(l) < Number(r);
      case '>':  return Number(l) > Number(r);
      case '<=': return Number(l) <= Number(r);
      case '>=': return Number(l) >= Number(r);
      default:   return false;
    }
  }

  private parsePrimary(): unknown {
    const t = this.peek();

    if (t.type === 'string') { this.next(); return t.value; }
    if (t.type === 'number') { this.next(); return Number(t.value); }

    if (t.type === 'lp') {
      this.next();
      const v = this.parseOr();
      this.expect('rp');
      return v;
    }

    if (t.type === 'ident') {
      this.next();
      let value: unknown = this.resolveIdent(t.value);
      // 成员访问 / 方法调用
      while (this.peek().type === 'dot') {
        this.next();
        const member = String(this.expect('ident').value);
        if (this.peek().type === 'lp') {
          this.next();
          const args: unknown[] = [];
          while (this.peek().type !== 'rp' && this.peek().type !== 'eof') {
            args.push(this.parseOr());
            if (this.peek().type === 'comma') this.next();
          }
          this.expect('rp');
          value = this.callMethod(member, String(value), args[0]);
        } else {
          throw new RuleEvalError(`member access on '${member}' not supported`);
        }
      }
      return value;
    }

    throw new RuleEvalError(`unexpected token: ${t.type}`);
  }

  // 标识符求值：字面量 true/false/null → 常量；白名单字段 → ctx；越界抛错
  private resolveIdent(name: string): unknown {
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    if (!ALLOWED_FIELDS.has(name)) {
      throw new RuleEvalError(`field not in whitelist: '${name}'`);
    }
    return this.ctx[name as keyof RuleContext];
  }

  // 方法调用：仅允许白名单方法
  private callMethod(name: string, receiver: string, arg: unknown): unknown {
    const fn = ALLOWED_METHODS[name];
    if (!fn) throw new RuleEvalError(`method not in whitelist: '${name}'`);
    if (arg == null) throw new RuleEvalError(`missing argument in method call '${name}'`);
    return fn(receiver, arg);
  }
}

// 主 API：安全求值一个 condition 表达式。
// 任何异常 → 降级为 false（不命中），由调用方走 strategy 分支兜底。
export function evaluateCondition(condition: string, ctx: RuleContext): boolean {
  if (!condition || typeof condition !== 'string') return false;
  try {
    const toks = tokenize(condition);
    return new Parser(toks, ctx).parse();
  } catch {
    return false;
  }
}

// 规则表求值：逐条求值，返回首个命中的 rule.targetProvider；不中或解析失败 → null。
export interface RoutingRuleLite {
  id: string;
  condition: string;
  targetProvider: string;
}

export function evaluateRules(rules: RoutingRuleLite[] | undefined, ctx: RuleContext): string | null {
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    if (!rule || typeof rule.condition !== 'string') continue;
    if (rule.condition.trim() === '') continue;
    if (evaluateCondition(rule.condition, ctx)) {
      return rule.targetProvider;
    }
  }
  return null;
}

// ---- 4c cost-optimization 辅助 ----
// 预估花费 = input单价 × 预估输入tokens + output单价 × 预估输出tokens。
// 单价为「每百万 tokens / 人民币」，返回「人民币」。
//
// 双计费维度（老板 2026-09-22）：
//   - billingMode 缺省 / 'token'，或门控 PROXY_BILLING_MODE 关 → 走下方 token 计价
//     （逐字节即改造前现状，向后兼容）。
//   - billingMode==='subscription' 且门控开 → 月费均摊：
//     边际成本 = monthlyCny / monthlyQuotaTokens × 本请求 tokens（接近 0）。
//     分母缺失 / 非正 / 缺 monthlyCny 时退化 token 计价（绝不产出 NaN / 负值）。
// 门控关时本函数与改造前完全一致 → 绝不改变现有路由选择。
export function estimateCost(
  pricing: Pricing | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!pricing) return Infinity;

  // 订阅维度（门控开 + 声明订阅）：月费按配额均摊到单请求。
  if (pricing.billingMode === 'subscription' && isSubscriptionBillingEnabled()) {
    const quota = pricing.monthlyQuotaTokens;
    const fee = pricing.monthlyCny;
    // 配额或月费缺失 / 非法 → 退化 token 计价（安全兜底，不产假成本）。
    if (typeof fee === 'number' && isFinite(fee) && fee >= 0
        && typeof quota === 'number' && isFinite(quota) && quota > 0) {
      const reqTokens = inputTokens + outputTokens;
      return (fee * reqTokens) / quota;
    }
  }

  const inputCost = (pricing.input * inputTokens) / 1_000_000;
  const outputCost = (pricing.output * outputTokens) / 1_000_000;
  if (pricing.cacheHit != null) {
    // 缓存红利：保守假设 50% 命中，命中部分按 cacheHit 计价
    const cacheInputCost = (pricing.cacheHit * inputTokens * 0.5) / 1_000_000;
    return Math.max(cacheInputCost, inputCost * 0.5) + outputCost;
  }
  return inputCost + outputCost;
}

// 按「健康优先、其次预估花费升序」排列候选 provider。
export function rankByCost(
  candidates: { id: string; pricing?: Pricing; health?: 'ok' | 'degraded' | 'down' }[],
  inputTokens: number,
  outputTokens: number,
): { id: string; cost: number }[] {
  const scored = candidates.map((c) => ({
    id: c.id,
    cost: estimateCost(c.pricing, inputTokens, outputTokens),
    healthRank: c.health === 'ok' ? 0 : c.health === 'degraded' ? 1 : 2,
  }));
  scored.sort((a, b) => {
    if (a.healthRank !== b.healthRank) return a.healthRank - b.healthRank;
    return a.cost - b.cost;
  });
  return scored.map((s) => ({ id: s.id, cost: s.cost }));
}

// ============================================================================
// ---- Q1 价表三层 + 汇率(CNY 比价)· 纯函数(2026-09-22 架构 §3.1/§3.5)----
//
// 门控 PROXY_FX_CURRENCY 默认为关(gate 关时 resolveBillingCost ≡ estimateCost,
// 逐字节不变;gate 开时非 CNY 币种按汇率折算 CNY 再比价)。
//
// 铁律(与双计费维度同):
//  - 非侵入门控默认关,绝不改变现有路由选择。
//  - 汇率异常(缺失/为0/负)→ fx=1.0 + fxSource='fallback', 绝不产假/混算。
//  - 逐模型门控 PROXY_ROUTE_{PROVIDER}_ENABLED: P1 仅留接口(全员默认参与),
//    逐模型开关由 P3 接入(routeEngine wiring),不在 P1 改变路由行为。
// ============================================================================

// 汇率门控(默认关)。
//   未设 / 空 / 任何非 truthy 值 → 关(默认): 非 CNY 币种不折算(cny===tokenCost, fx=1)。
//   'true' | '1' | 'enable' | 'enabled' | 'on'(大小写/空格不敏感)→ 开: gate 开且 currency!=='CNY'
//   时按汇率折算 CNY。
export function isFxCurrencyEnabled(): boolean {
  const v = String(process.env.PROXY_FX_CURRENCY ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'enable' || v === 'enabled' || v === 'on';
}

// 汇率来源追踪(路由显示 + 日志用, 不混算)。
export type FxSource = 'env' | 'cached-value' | 'cache' | 'fallback';

// 汇率解析(纯函数, 热路径零网络): 优先级 env(PROXY_FX_RATE) > 缓存(pricing-cache.json.fx)
//   > 缓存最近值 cachedValue > 兜底默认 1.0(架构 §3.5 + 定稿 D2: USD 模型会显贵被降权,
//  调用方需提示"比价失真")。异常(缺失/为0/负/非数)→ 1.0 + fxSource='fallback'。
// envRate: 缺省从 process.env.PROXY_FX_RATE 读(与 isFxCurrencyEnabled 读 env 同源);
//   显式传入时覆盖 env(便于测试注入)。
export function resolveFxRate(opts?: {
    cacheFx?: number;         // 来自 pricing-cache.json.fx(可选, P1 不读写文件系统, 仅接口)
    cachedValue?: number;     // "缓存最近值"兜底(架构定稿 D2: 7.2 仅留作此项)
    fallbackRate?: number;    // 兜底值, 默认 1.0
    envRate?: string | number; // 可选显式传入; 缺省读 process.env.PROXY_FX_RATE
   }): { rate: number; source: FxSource } {
  const fb = Math.max(numOrNull(opts?.fallbackRate) ?? 1.0, 0) || 1.0;

     // 1. env(PROXY_FX_RATE)手填(架构 §3.5.1 方案 C 推荐, 热路径零网络)
  const envNum = numOrNull(envNumFrom(opts?.envRate ?? process.env.PROXY_FX_RATE));
  if (envNum !== null && envNum > 0) return { rate: envNum, source: 'env' };

     // 2. 缓存最近值(pricing-cache.json.fx, 架构 §3.5 与价格缓存同生命周期)
  const cacheNum = numOrNull(opts?.cacheFx);
  if (cacheNum !== null && cacheNum > 0) return { rate: cacheNum, source: 'cache' };

     // 3. 缓存最近值兜底(架构定稿 D2: 7.2 留作 cachedValue, 非默认兜底值)
  const cachedNum = numOrNull(opts?.cachedValue);
  if (cachedNum !== null && cachedNum > 0) return { rate: cachedNum, source: 'cached-value' };

     // 4. 兜底: 1.0(不混算, 不产假; 此时 USD 模型按 1:1 视同 CNY, 会"显贵"被降权)
   return { rate: fb, source: 'fallback' };
}

// 价表三层解析(架构 §3.1 优先级 L1 > L2 > L0 > 0):
//   L1 用户覆盖(_userSet:true, 用户主权, 永不自动覆盖) >
//   L2 渠道价(同 model+channel 匹配) > L0 官方种子 > 0(免费, 绝不编造)。
// 返回 null 表示该 (model, channel) 三层都无价。
export function resolvePricing(
  model: string,
  l1?: Record<string, Pricing>,     // 用户覆盖(pricing-overrides.json, P1 不读写文件, 仅接口)
  l2?: Pricing[],                   // 渠道价(pricing-cache.json)
  l0?: (model: string) => Pricing | undefined,  // L0 官方种子(routeEngine DEFAULT_ROUTE_CONFIG.pricing)
  channel?: string,
): Pricing | null {
   // L1 > L0: 用户覆盖最高优先(带 _userSet:true 由调用方保证)
  if (l1 && l1[model]) return l1[model];
   // L2: 同 model(+channel 若指定)匹配渠道价。条目携带 §3.1 标准字段 model/channel
   //   (Pricing 条目自带), 兼容 __model/__channel 元前缀。
   if (l2 && l2.length > 0) {
   for (const p of l2) {
     const pModel = ((p as any).model ?? (p as any).__model) as string | undefined;
     const pChannel = ((p as any).channel ?? (p as any).__channel) as string | undefined;
     if (pModel === model && (!channel || pChannel === channel || pChannel == null)) return p;
     }
   }
  // L0: 官方种子
  const l0p = l0 ? l0(model) : undefined;
   if (l0p) return l0p;

   // 都没有 → 显式返回 null(调用方按"免费/不参与最贵"处理, 绝不编造)
  return null;
}

// 逐模型门控 PROXY_ROUTE_{PROVIDER_UPPER}_ENABLED(架构 §4.4 + 定稿 D4-P1: P1 仅接口,
// 全员默认参与; 逐模型开关由 P3 接入 routeEngine wiring, P1 不改变路由行为)。
// 门控关/未设 → 全部 true(参与)。'false'|'0'|'disable'|'off' → 排除。
export function resolveModelEnabled(provider: string): boolean {
  const upper = provider.trim().toUpperCase();
  if (!upper) return true;
  const v = String(process.env[`PROXY_ROUTE_${upper}_ENABLED`] ?? '').trim().toLowerCase();
  if (v === '' || v == null) return true;          // 未设 → 参与
   return !(v === 'false' || v === '0' || v === 'disable' || v === 'off' || v === 'disabled');
}

// 最终路由计价(整合汇率 + 逐模型门控 + 双计费维度): 纯函数。
//   - gate PROXY_FX_CURRENCY 关(默认) → 直接 estimateCost(逐字节=现状)
//   - gate 开 → estimateCost × fxRate(CNY 比价, 架构 §3.5)
//   - pricing 为 undefined → cny=Infinity(视为最贵, 同 estimateCost(undefined))
//   - 汇率异常 → fx=1 + source='fallback'(USD 模型此时不折算, 显贵; 调用方需提示"比价失真")
// 返回 BillingDecision 供路由展示(原始币种 + 换算 CNY 并列, 架构 §3.5 Q5 UX 数据契约)。
export interface BillingDecision {
  tokenCost: number;       // 原生币种计价(未折算 CNY)
  cny: number;             // 折算 CNY 后(门控关时 === tokenCost)
  fxRate: number;
  fxSource: FxSource;
  currency: string;       // 原始币种(CNY 默认)
  userSet: boolean;       // 是否用户手动覆盖
}

export function resolveBillingCost(
  pricing: Pricing | undefined,
  inputTokens: number,
  outputTokens: number,
  opts?: { currency?: string; cachedValue?: number; fallbackRate?: number; userSet?: boolean },
): BillingDecision {
  const currency = pricing?.currency ?? opts?.currency ?? 'CNY';
  const userSet = pricing?._userSet ?? opts?.userSet ?? false;

     // 门控关(默认): 非 CNY 也不折算, 直接 estimateCost(逐字节=现状)
  if (!isFxCurrencyEnabled() || currency === 'CNY') {
    const tokenCost = estimateCost(pricing, inputTokens, outputTokens);
    return { tokenCost, cny: tokenCost, fxRate: 1, fxSource: currency === 'CNY' ? 'env' : 'fallback', currency, userSet };
     }

     // 门控开 + 非 CNY: 按汇率折算 CNY(env 汇率由 resolveFxRate 读 PROXY_FX_RATE)
  const tokenCost = estimateCost(pricing, inputTokens, outputTokens);
      // 汇率解析: 异常(缺失/为0/负)→ 1.0 + fallback
  const { rate, source } = resolveFxRate({
   cachedValue: opts?.cachedValue, fallbackRate: opts?.fallbackRate,
     });
  const cny = tokenCost * rate;
  return { tokenCost, cny, fxRate: rate, fxSource: source, currency, userSet };
}

// 按「健康优先、其次 CNY 计费升序」排列候选(架构 §4.2.2 最终路由计价)。
// 与 rankByCost 区别: 价格取 resolveBillingCost 的 cny(门控开时含汇率折算)。
//
// 门控 PROXY_FX_CURRENCY 关(默认)→ cny === estimateCost(逐字节=rankByCost),
// 路由选择逐字节不变(非侵袭)。P1 仅暴露纯函数 + 测试; 接入 routeEngine 路由逻辑
// 由 P5 完成(架构 §7), P1 不碰热路径选择逻辑。
export function rankByCostCny(
  candidates: { id: string; pricing?: Pricing; health?: 'ok' | 'degraded' | 'down' }[],
  inputTokens: number,
  outputTokens: number,
): { id: string; cost: number }[] {
  const scored = candidates.map((c) => ({
     id: c.id,
     cost: resolveBillingCost(c.pricing, inputTokens, outputTokens).cny,
     healthRank: c.health === 'ok' ? 0 : c.health === 'degraded' ? 1 : 2,
    }));
  scored.sort((a, b) => {
     if (a.healthRank !== b.healthRank) return a.healthRank - b.healthRank;
     return a.cost - b.cost;
    });
   return scored.map((s) => ({ id: s.id, cost: s.cost }));
}

// 近似相等(避免浮点), 测试用; 容差 1e-6(与 toBeCloseTo 同量级)
export function approxEqual(a: number, b: number, tol = 1e-6): boolean {
   if (a === b) return true;
    if (!isFinite(a) && !isFinite(b)) return true;
    if (!isFinite(a) || !isFinite(b)) return false;
   return Math.abs(a - b) <= tol;
}

function envNumFrom(v: string | number | undefined): number {
    if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : 0;
}
function numOrNull(v: number | undefined): number | null {
  if (v == null) return null;
  return isFinite(v) ? v : null;
}