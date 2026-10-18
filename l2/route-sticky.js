// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 路由粘性与续聊锁档（外部对照 #71 PilotDeck 落地件 · 2026-10-18）
//
// 来源：PilotDeck `src/router/tokenSaver/` + `RouterRuntime.ts:388-412`（AGPL-3.0，
// 2026-10-18 经 7897 代理直读 GitHub 核证，母本 docs/10-initiatives/90-PilotDeck外部对照与路由工程设计对照-2026-10-18.md）。
// 抄它的两条度量衡，不抄它的形态：
//   ① sticky 主/子双轨：一个 session 内档位判一次就粘住，后续轮次不再调 judge
//      （省调用成本 + 防任务内档位抖动）；
//   ② 续聊锁档：「好的/继续/冲」类短确认消息必须保持上一轮档位——
//      PilotDeck 用真金白银换来的补丁（它的 prompt 原文叫 CRITICAL RULE），
//      不补就会把长任务的中途跟进误降档。
//
// **双方优势合并（老板 2026-10-18 拍板「不二选一」）**：
//   · PilotDeck 侧：续聊保护规则 + sticky 双轨 + 失败回落默认档；
//   · multi-proxy 侧：本地 Clef judge（1.5s 超时、低置信落 medium、永不抛错，
//     见 l2/decision-judge.js）——**判定不花钱、不出本机**。
//   合并形态 = 本地 judge 前面加两级**确定性短路**（sticky 命中 / 续聊锁定），
// 标准场景一次模型都不用调；非标准短消息仍走 judge，但把 previousTier
// 带给它（decision-judge.js 的 previousTier 参数）做上下文感知——
// 对应 PilotDeck 把 previousTier 写进 judge prompt 的做法，只是我们把能确定的
// 部分前移成规则，把剩下的才交给模型。
//
// 🔴 双通道设计（2026-10-18 修，对齐 PilotDeck 原始形态）：
//   sticky 与 previousTier 是**两条独立通道**，不可混存：
//     · sticky.tier    —— 服务端 session 级缓存（本模块 StickyStore），
//                         命中即省一次 judge 调用；
//     · previousTier   —— **请求级透传**（调用方从请求元数据带上来，
//                         对齐 PilotDeck 的 input.metadata.previousTier），
//                         供给「本轮」的续聊锁定与 judge 上下文。
//   首版把两者塞进同一条 store 记录，导致 sticky.tier 有值时续聊分支
// 永不可达（sticky 先 return）——续聊锁档名存实亡。分开后两条通道
// 各自成立：sticky 管「session 内省调用」，previousTier 管「这一轮的
// 续聊保护」。
//
// 架构纪律（与 route-engine 的 judge 旁路同构）：
//   - 本模块零决策权：只产出「建议档位 + 来源标注」，采不采纳由调用方定
//     （N3 纯决策铁律；complexity 定价权归 Portico，Portico/02-架构设计.md 条款 5）。
//   - 门控 PROXY_ROUTE_STICKY 默认关：关时 resolveTierDecision 直接返回 null，
//     调用方走原逻辑逐字节不变；开时才走决策链。
//   - 存储纯内存（Map）：进程级，不落盘。落盘是 manager 账本侧的事，
//     本模块不擅自写任何文件（非侵入铁律）。
//   - judgeFn 注入：不 import decision-judge（避免热路径耦合），由调用方
//     把 judgeComplexity 包一层传进来；测试传假 fn。

const GATE_ENV = 'PROXY_ROUTE_STICKY';

function gateOpen() {
  const v = String(process.env[GATE_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// 短确认消息白名单（中英混合）。判据 = 去空白后整体命中（不是包含匹配）——
// 「继续改需求」不是确认消息，不能锁档。
const CONTINUATION_TOKENS = new Set([
  // 英文
  'go', 'continue', 'cont', 'ok', 'okay', 'k', 'yes', 'y', 'yeah', 'yep', 'sure',
  'no', 'n', 'nope', 'thanks', 'thx', 'ty', 'please', 'proceed', 'next', 'again',
  // 中文
  '好的', '好', '好吧', '好啊', '嗯', '嗯嗯', '行', '可以', '对', '是的', '没错',
  '继续', '接着', '冲', '收到', '明白', '懂了', '谢了', '谢谢', '感谢', '稍等',
  '等下', '等待', '试试', '可以试试', '去吧', '来吧', '开始吧',
]);
// ⚠️ 刻意**不收**「开始 / 跑 / 启动」：这些词既可能是续聊也可能是新任务的首句
// （「开始写第三篇」是新任务），锁错了比不锁糟。留给 judge 带 previousTier 判。
const CONTINUATION_MAX_LEN = 12; // 去空白后超过此长度不走白名单（中文 12 字 / 英文 12 字符）

/**
 * 判断一条消息是否是「上一轮任务的续聊/确认」。
 * 确定性规则：去空白整体命中白名单，且长度 ≤ CONTINUATION_MAX_LEN。
 *
 * ⚠️ 调用方语义：仅在 previousTier 存在时才有意义——没有上轮档位就无从「保持」。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isContinuation(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim().replace(/\s+/g, '');
  if (!t || t.length > CONTINUATION_MAX_LEN) return false;
  // 去掉常见尾标点后再比一次（「好的。」「继续!」仍是确认）
  const bare = t.replace(/[。.!！?？~～，,、;；]+$/g, '');
  return CONTINUATION_TOKENS.has(t) || CONTINUATION_TOKENS.has(bare);
}

/**
 * 主/子双轨 sticky 存储（纯内存）。
 *
 * key = `${sessionKey}::${isMainAgent ? 'main' : 'sub'}`——同一 session 的
 * 主 agent 与子 agent 各存一份，互不污染（对齐 PilotDeck 的
 * sessionStore.get(sessionId, true/false) 双轨）。
 * 值形状：`{ tier: string }`（只有服务端判出的档位；请求级 previousTier
 * 不走这里，见文件头「双通道设计」）。
 *
 * 容量：默认 400 条（session 数），超容量按插入序淘汰最旧（Map 保序）。
 * 不落盘、不过期——进程重启即清空，下一轮重新判（judge 旁路本来就是
 * 「这个进程内的观测」，不承诺跨进程记忆）。
 */
class StickyStore {
  constructor(capacity = 400) {
    this.capacity = capacity > 0 ? capacity : 400;
    this._map = new Map();
  }

  _key(sessionKey, isMainAgent) {
    return `${sessionKey}::${isMainAgent ? 'main' : 'sub'}`;
  }

  get(sessionKey, isMainAgent) {
    if (!sessionKey) return null;
    return this._map.get(this._key(sessionKey, isMainAgent)) || null;
  }

  set(sessionKey, isMainAgent, value) {
    if (!sessionKey || !value) return;
    const k = this._key(sessionKey, isMainAgent);
    // 先删再插：保证命中序 = 最新（Map 插入序语义）
    this._map.delete(k);
    this._map.set(k, value);
    while (this._map.size > this.capacity) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  delete(sessionKey, isMainAgent) {
    if (!sessionKey) return;
    this._map.delete(this._key(sessionKey, isMainAgent));
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }
}

/**
 * 档位决策链（双通道，2026-10-18 修）：
 *   ① sticky 命中（session 级缓存）      ⇒ from=sticky，不调 judge；
 *   ② 请求级 previousTier + 短确认消息    ⇒ from=continuation，不调 judge；
 *   ③ 其余                               ⇒ 调 judge（带 previousTier 上下文）；
 *   ④ judge 不可用/解析失败              ⇒ from=fallback，回落 defaultTier。
 *
 * 为什么 ② 不在 ① 前面：session 内有缓存时直接沿用最省（一次判断都不用）；
 * ② 服务的是「没有服务端缓存、但请求带了上轮档位」的场景（首轮 /
 * store 被淘汰 / 跨进程重启后客户端仍带着 previousTier）。
 *
 * @param {object} input
 * @param {string} input.text 待判文本（最后一条 user 消息）
 * @param {string} input.sessionKey session 标识（没有则本链路不启用 sticky）
 * @param {string} [input.previousTier] 请求级上轮档位（调用方从元数据透传；
 *        不给则续聊锁定与 judge 上下文都无依据，落到 ③ 首判）
 * @param {boolean} [input.isMainAgent=true] 主/子轨
 * @param {string} [input.defaultTier] 默认档（judge 失败回落目标）
 * @param {(text: string, opts: {previousTier?: string}) => Promise<{tier: string}|null>} input.judgeFn
 *        注入的判定函数（例：包一层的 judgeComplexity）。返回 {tier} 或 null（失败）
 * @param {StickyStore} input.store sticky 存储（注入，便于测试隔离）
 * @returns {Promise<{tier: string, from: 'sticky'|'continuation'|'judge'|'fallback', previousTier?: string}|null>}
 *          门控关 ⇒ null（调用方走原逻辑）
 */
async function resolveTierDecision(input) {
  if (!gateOpen()) return null;
  const { text, sessionKey, previousTier = null, isMainAgent = true, defaultTier, judgeFn, store } = input;
  if (!store || !sessionKey || typeof text !== 'string' || !text) return null;

  // ① sticky 命中：本 session 非首轮，直接沿用，不调 judge
  const sticky = store.get(sessionKey, isMainAgent);
  if (sticky && sticky.tier) {
    return { tier: sticky.tier, from: 'sticky', previousTier: sticky.tier };
  }

  // ② 续聊锁定：请求带了 previousTier + 短确认消息 ⇒ 保持上轮档位，不调 judge
  // （没有 previousTier 时无从「保持」，落到 ③ 让 judge 首判）
  if (previousTier && isContinuation(text)) {
    store.set(sessionKey, isMainAgent, { tier: previousTier });
    return { tier: previousTier, from: 'continuation', previousTier };
  }

  // ③ judge 判定（注入的本地 judge；带上轮档位做上下文——对齐 PilotDeck
  //    给 judge 的 CRITICAL RULE：续聊别误降档）
  let judged = null;
  if (typeof judgeFn === 'function') {
    try {
      judged = await judgeFn(text, { previousTier: previousTier || undefined });
    } catch {
      judged = null; // 旁路失败不影响路由（decision-judge 同款纪律）
    }
  }
  if (judged && judged.tier) {
    store.set(sessionKey, isMainAgent, { tier: judged.tier });
    return { tier: judged.tier, from: 'judge', previousTier: previousTier || null };
  }

  // ④ 回落默认档（judge 不可用/解析失败）——对齐 PilotDeck 的
  // resolvedFrom:'fallback' + 失败诊断；这里只标来源，诊断由调用方补。
  return { tier: defaultTier, from: 'fallback', previousTier: previousTier || null };
}

module.exports = {
  StickyStore,
  isContinuation,
  resolveTierDecision,
  gateOpen,
  GATE_ENV,
  CONTINUATION_TOKENS,
  CONTINUATION_MAX_LEN,
};

// ---- 接线（2026-10-18 落地记录）----
// l2/route-engine.js 的 judge 旁路（route() 内，原 L131-142 区块）改为：
//   门控 PROXY_ROUTE_STICKY 开 且 task 带 sessionKey ⇒ 走 resolveTierDecision，
//     结果写 decision.stickyTier = { tier, from }（观测，不改 expectedTier）；
//   门控关 / 无 sessionKey ⇒ 原 judgeComplexity 直调，行为逐字节不变。
// 详见 route-engine.js 内该区块注释。
