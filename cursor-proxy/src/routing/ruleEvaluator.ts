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

export interface Pricing {
  input: number;    // 每百万 input tokens，人民币
  output: number;   // 每百万 output tokens
  cacheHit?: number;
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
export function estimateCost(
  pricing: Pricing | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!pricing) return Infinity;
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