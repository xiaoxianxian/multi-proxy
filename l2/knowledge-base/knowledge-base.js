'use strict';

// KnowledgeBase — L2 P0 I1：RAG 知识库（拉模式）。
//
// 定位（§8.1 草图）：RAG 是「服务」不是「agent adapter」。复用 adapter-protocol 的**纪律**
//   （非侵入④ / 门控默认关 / shadow 优先 / 拉模式永不自动注入），但不硬塞 adapter 4 接口契约。
//   给 Orchestrator 注入第 5 可注入项 `retriever`（见 orchestrator.js 构造）。
//
// 设计（§8.2 草图）：
//   - 零依赖 MVP：纯内存 + 词频/特征向量 + 余弦相似度。不引外部向量库；
//     验证检索质量后再换 sqlite-vec / 真 embedding。
//   - 分词：中文按 bigram（相邻字符对）+ 单字，英文/数字按 \w+ 分词；
//     纯词频对 CJK 无效（无空格边界），bigram 是 CJK 轻量检索的务实解。
//   - 拉模式（VetarAI ①）：只有被显式 retrieve() 才返回，retriever=null 时 orchestrator 完全不检索、不挂 ctx.knowledge。
//   - 非侵入：只读传入文档，绝不写 agent 文件、绝不联网；dir 注入才落盘（manager 自己的目录）。
//   - 与 memory-merge.js 区分：memory-merge 是 agent 启动时无条件注入 AGENT_MEMORY_CONTEXT；
//     本 RAG 是子任务显式声明 useKnowledge 才检索，注入 AGENT_KNOWLEDGE_CONTEXT（变量独立，互不干扰）。
//
// 门控：PROXY_KNOWLEDGE_BASE 默认 0/未设 → 调用方不构造本类（retriever=null）→ 全量测试 0 回归。
// 持久化：PROXY_KNOWLEDGE_BASE_DIR 才落盘（镜像 L2_REGISTRY_DIR 默认内存、显式才落，绝不写 home）。

const fs = require('fs');
const path = require('path');

// ---- 分词（CJK bigram + 词） ----
// 中文/日文/韩文区间做 bigram+单字；其余用 \p{L}\p{N} 分词（\w+ 即可，避免 \p 在老 runtime 的兼容风险）。
function tokenize(text) {
  const s = String(text || '');
  const tokens = [];
  // 英文/数字词
  const ascii = s.match(/[A-Za-z0-9]+/g);
  if (ascii) for (const w of ascii) tokens.push(w.toLowerCase());
  // CJK 连续段做 bigram + 单字（bigram 是 CJK 轻量检索的务实解，无空格边界）
  const cjkRuns = s.split(/[^一-鿿]+/).filter(Boolean);
  for (const run of cjkRuns) {
    for (const ch of run) tokens.push(ch);               // 单字
    for (let i = 0; i < run.length - 1; i++) tokens.push(run[i] + run[i + 1]); // bigram
  }
  return tokens;
}

// ---- 文档切块：按段落 + 滑动窗口 ----
function chunk(text, size = 800, overlap = 150) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  // 先按空行切段
  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const pieces = [];
  let buf = '';
  for (const p of paras) {
    if (!buf) { buf = p; continue; }
    if (buf.length + p.length + 1 <= size) { buf = buf + '\n' + p; continue; }
    pieces.push(buf); buf = p;
  }
  if (buf) pieces.push(buf);
  // 超长段滑窗
  const final = [];
  for (const piece of pieces) {
    if (piece.length <= size) { final.push(piece); continue; }
    let i = 0;
    while (i < piece.length) {
      final.push(piece.slice(i, i + size));
      i += Math.max(1, size - overlap);
    }
  }
  return final;
}

// ---- 特征向量：词频（不归一，余弦计算时归一） ----
function toVec(text) {
  const freq = new Map();
  for (const t of tokenize(text)) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return freq; // Map<string, count>
}

// 两个词频向量的余弦相似度（共享维度求点积；任一为空 → 0）
function cosine(a, b) {
  let dot = 0;
  // 取较小方遍历
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const vb = big.get(k);
    if (vb) dot += v * vb;
  }
  if (dot === 0) return 0;
  const norm = (m) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  const na = norm(a); const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

class KnowledgeBase {
  constructor({ dir = null } = {}) {
    this.docs = new Map(); // id -> [{ id, title, snippet, vec(Map), tags, scope }]
    this.dir = dir;        // 非侵入：null=仅内存；注入才落盘（manager 自己的目录）
    this._loaded = false;
    if (dir && dir.length > 0) this._load();
  }

  // 摄取：一篇文档 → 切块 → 存（保留 title/snippet 供检索返回）
  ingest({ id, title, text, tags = [], scope = 'shared' }) {
    if (!id) throw new Error('KnowledgeBase.ingest: id required');
    const chunks = chunk(text).map((c, i) => ({
      id: `${id}#${i}`,
      title: title || id,
      snippet: c,
      vec: toVec(c),
      tags,
      scope,
    }));
    this.docs.set(id, chunks);
    if (this.dir) this._persist();
    return chunks.length;
  }

  // 删除一篇
  remove(id) {
    const had = this.docs.delete(id);
    if (had && this.dir) this._persist();
    return had;
  }

  // 列文档
  list() {
    return [...this.docs.entries()].map(([id, chunks]) => ({
      id,
      title: chunks[0] ? chunks[0].title : id,
      chunks: chunks.length,
      scope: chunks[0] ? chunks[0].scope : 'shared',
      tags: chunks[0] ? chunks[0].tags : [],
    }));
  }

  // 检索（拉模式：只有被显式调用才返回，绝不自动注入）
  retrieve({ query, topK = 3, scope = null } = {}) {
    const q = toVec(query);
    const all = [...this.docs.values()].flat();
    if (q.size === 0) return []; // 空 query 不检索（与 memory-merge 拉模式一致：不自动注入）
    return all
      .filter((c) => !scope || c.scope === scope)
      .map((c) => ({ ...c, score: cosine(q, c.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ snippet, title, id, score, scope, tags }) => ({ id, title, snippet, score, scope, tags }));
  }

  status() {
    return {
      ready: true,
      docs: this.docs.size,
      chunks: [...this.docs.values()].reduce((n, c) => n + c.length, 0),
      persisted: !!this.dir,
    };
  }

  // ---- 持久化（镜像 agent-registry 的「默认内存、dir 才落」；绝不写 home）----
  _persist() {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const data = JSON.stringify(
        [...this.docs.entries()].map(([id, chunks]) => chunks.map((c) => ({
          id: c.id, title: c.title, snippet: c.snippet, tags: c.tags, scope: c.scope,
        }))),
        null, 2,
      );
      const p = path.join(this.dir, 'knowledge.json');
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, p); // 原子写
    } catch (e) {
      // 非侵入：落盘失败不抛（observe 优先），仅 warn 到 stderr
      process.stderr.write('[knowledge-base] persist failed: ' + e.message + '\n');
    }
  }

  _load() {
    try {
      const p = path.join(this.dir, 'knowledge.json');
      if (!fs.existsSync(p)) return;
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      for (const arr of raw) {
        const id = arr[0] ? arr[0].id.split('#')[0] : null;
        if (!id) continue;
        this.docs.set(id, arr.map((o) => ({
          id: o.id, title: o.title, snippet: o.snippet, vec: toVec(o.snippet),
          tags: o.tags || [], scope: o.scope || 'shared',
        })));
      }
      this._loaded = true;
    } catch (e) {
      // 非侵入：加载失败不抛，留空库（observe）
      process.stderr.write('[knowledge-base] load failed: ' + e.message + '\n');
    }
  }
}

module.exports = { KnowledgeBase, chunk, toVec, cosine, tokenize };
