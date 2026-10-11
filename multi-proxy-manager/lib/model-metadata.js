'use strict';
// 模型价格元数据：来源时刻标注（P4，2026-10-12）。
//
// 每笔账要能回答「这个价格是什么时候采集的」。价格溯源由三样东西共同构成：
//   - pricingSource（P2，ledger 字段）：哪一层答的价 —— 'model' | 'proxy' | 'unknown'
//   - priceSource  （自由文本备注）：价格从哪来，例如 "litellm docs 2026-10-12"
//   - retrievedAt  （本模块，ledger 字段 pricingRetrievedAt）：价格被采集的时刻
//
// 🔴 铁律（与 cost-track「值是 0 ≠ 值不存在」同源）：
//    取不到就 null，**绝不填「现在」或 0** —— 把「不知道」伪装成「知道」比没有更糟。
//    账本里的 ledger `ts` 是「这笔账发生的时间」，与价格的 retrievedAt 是两回事，
//    别拿 ts 冒充价格采集时刻。

// 从一条价表登记项里抽出价格采集时刻。
// 支持两个位置：entry.retrievedAt（结构化，优先）或 entry.priceSource.retrievedAt
// （当 priceSource 是对象时）。都没有 → null。非对象入参 → null。
function extractRetrievedAt(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.retrievedAt != null) return entry.retrievedAt;
  const ps = entry.priceSource;
  if (ps && typeof ps === 'object' && ps.retrievedAt != null) return ps.retrievedAt;
  return null;
}

// 把采集时刻并进取价结果：只补 retrievedAt 一个字段（缺省 null，不造）。
// 直接改传入的 pr（resolvePricing 每次新建对象，无共享态）。
function annotateResult(pr, entry) {
  if (!pr) return pr;
  pr.retrievedAt = extractRetrievedAt(entry);
  return pr;
}

module.exports = { extractRetrievedAt, annotateResult };
