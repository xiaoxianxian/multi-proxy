// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

/**
 * M6 方向四 · 4a 轻量任务分类器
 *
 * 基于请求 messages 的特征做「关键词 + 结构启发式」分类，输出枚举
 *   coding | writing | writing-rewrite | writing-rephrase | vision | cheap | general
 *
 * writing 自 2026-10-18 TierFlow 评测结论拆成两副面孔（见下 WRITING_REWRITE/REPHRASE）：
 *   writing-rewrite  —— 缩写/扩写/去废话/改写，产出长度或结构会变，绝不降档
 *   writing-rephrase —— 润色/翻译/换说法，只换表达语义不变，可降档到廉价模型
 *
 * 不引入任何新依赖；分类在 proxy 入口做**一次**（请求级），结果作为 taskType
 * 下传给路由引擎，不重复计算。
 *
 * 判定维度（短路，从上到下；首个命中即返回）：
 *   1. vision  —— 含 image_url / 文件附件 / 「图/截图/识别」类词
 *   2. code    —— 含代码块 / 文件路径 / git·compile·bug·refactor / 「实现·修复·写函数」开头
 *   3. writing-rewrite —— 含「缩写/扩写/去废话/重写/改写」类词（产出变长/结构，绝不降档）
 *   4. writing-rephrase —— 含「润色/翻译/换说法」类词（只换表达，可降档；先于 writing 因常与文章同现）
 *   5. writing —— 含「公众号/文章/撰写/总结」类长文创作词（无代码信号、非 rewrite/rephrase）
 *   6. cheap   —— 短消息 + 显式琐碎低价信号（格式化/format/summarize）
 *   7. general —— 兜底
 *
 * 设计原则：确定性 + 可单测。同一输入必得同一结果，便于断言与回归。
 */

export type TaskType = 'coding' | 'writing' | 'writing-rewrite' | 'writing-rephrase' | 'vision' | 'cheap' | 'general';

// OpenAI 风格的 message 形状（鸭子类型，不强制结构化，便于调用方传任意消息数组）。
export interface ClassifyMessage {
  role?: string;
  content?: string | Array<unknown> | Record<string, unknown>;
  [key: string]: unknown;
}

// ---- 关键词 / 信号表（中英混合，覆盖真实使用场景）----
const VISION_PATTERNS: readonly RegExp[] = [
  /image_url/i,
  /screenshot|screencap/i,
  /picture|image/i,
  /附件\b/,
  /截图|图片|图像|视觉|识别|ocr|看图|读图/,
  /file_url/,
];

const CODE_BLOCK_PATTERN = /```|<code|<\/code>/;
const CODE_PATH_PATTERN = /(?:src|lib|dist|build|tests?|node_modules|app)\/[\w.@-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|py|java|go|rs|rb|c|cpp|h|php|sql|sh|css|html)\b/;
const CODE_KEYWORDS: readonly string[] = [
  'git', 'compile', 'compiled', 'compile', 'bug', 'refactor', 'refactoring',
  '单元测试', '函数', 'class', 'exception', 'stack trace', 'stacktrace', '报错',
  '代码库', '重构',
];
// 「以…开头」的动作类前缀（取消息开头 16 字做匹配，限定为祈使式动作）
const CODE_START_PATTERNS: readonly RegExp[] = [
    /^实现/,
    /^修复/,
    /^写函数/,
    /^写个函数/,
    /^修复bug/i,
    /^debug/i,
    /^fix/i,
    /^write\s+code/i,
    // P1-4（09-30 路由能力矩阵 P1-4）：英文描述性需求补全，避免 "implement/refactor/…" 漏判为 general
    /^implement/i,
    /^refactor/i,
    /^generate\s/i,
    /^build\s/i,
    /^deploy/i,
    /^create\s+(a\s+)?function/i,
    /^optimiz/i,
];

const WRITING_KEYWORDS: readonly string[] = [
  '公众号', '文章', '撰写', '文案', '标题', '营销', '推广文案', '长文',
  '总结', '小结', '摘要',
];

// 改写的两副面孔（TierFlow 评测 2026-10-18 结论落代码）：
//   writing-rewrite  —— 缩写/扩写/去废话/重写/改写：产出长度或结构会变。
//                       小模型一降档就掉字数（交出原文的 32%~83% 是概括不是改写），绝不降档。
//   writing-rephrase —— 润色/翻译/换说法/rewrite/translate：只换表达、语义长度不变，可降档到廉价模型。
// 两者分开，路由才能对「换说法」降档、对「去废话/缩写」保强模型——原来一刀切归 cheap 正是 0/8 翻车的根。
const WRITING_REWRITE_KEYWORDS: readonly string[] = [
  '缩写', '扩写', '精简', '去废话', '重写', '改写',
];
const WRITING_REPHRASE_KEYWORDS: readonly string[] = [
  '润色', '翻译', '换说法', 'rewrite', 'translate',
];
// cheap：仅剩真正琐碎、与写作无关的低价信号（短消息 + 显式信号）
const CHEAP_KEYWORDS: readonly string[] = [
  '格式化', 'format', 'summar',
];

// 把一条 message 的 content 归一化成纯文本。
function contentToText(content: ClassifyMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // OpenAI 多模态：content = [{type:'text',text}, {type:'image_url',image_url:{url}}]
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          // 显式标注图片部件
          if (p.type === 'image_url' || p.type === 'image') return ' \n[image] \n ';
          if (typeof p.text === 'string') return p.text;
          if (typeof p.image_url === 'string' || (p.image_url && typeof p.image_url === 'object')) return ' \n[image_url] \n ';
        }
        return String(part);
      })
      .join('');
  }
  if (typeof content === 'object') {
    // 兜底：对象里找 text/image 字段
    const obj = content as Record<string, unknown>;
    return [obj.text, obj.content, obj.image, obj.image_url]
      .filter((v) => typeof v === 'string' || (v && typeof v === 'object'))
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('');
  }
  return String(content);
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * 分类一次请求。
 * @params messages 请求消息数组
 * @param hints 可选的调用方显式提示（如 proxy 已知的 quality/privacy 上下文，预留扩展）
 * @returns TaskType 枚举
 */
export function classifyTask(messages: ClassifyMessage[] | string, hints?: Record<string, unknown>): TaskType {
  // 1) 归一化
  const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: messages } as ClassifyMessage];
  // 全量文本（判定关键词/代码/视觉）
  const fullText = msgs.map((m) => contentToText(m.content)).join('\n');
  // 最后一条用户消息（判定「以…开头」的动作类前缀，避免被历史噪声干扰）
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser ? contentToText(lastUser.content) : '';
  // 总字符数（估算「短消息」）
  const totalLen = fullText.length;

  // 1. vision：任何部件出现图片/附件信号即归视觉
  if (hasAny(fullText, VISION_PATTERNS)) return 'vision';

  // 2. coding：代码块 / 文件路径 / 编码关键词 / 动作前缀
  if (CODE_BLOCK_PATTERN.test(fullText)) return 'coding';
  if (CODE_PATH_PATTERN.test(fullText)) return 'coding';
  if (hasAny(fullText, [/bug/i, /refactor/i, /compile/i, /git\b/i, /单元测试/, /重构/])) return 'coding';
  if (CODE_KEYWORDS.some((kw) => fullText.toLowerCase().includes(kw.toLowerCase()))) return 'coding';
  if (CODE_START_PATTERNS.some((re) => re.test(lastUserText))) return 'coding';

  // 3. writing-rewrite：缩写/扩写/去废话/改写 —— 产出变长或结构变化，绝不降档（走强模型）
  if (WRITING_REWRITE_KEYWORDS.some((kw) => fullText.includes(kw))) return 'writing-rewrite';

  // 4. writing-rephrase：润色/翻译/换说法 —— 只换表达、语义长度不变，可降档到廉价模型。
  //    放在 writing 之前：润色/翻译常与「文章/公众号」同现，rephrase 信号优先才兑现「换说法可降档」。
  if (WRITING_REPHRASE_KEYWORDS.some((kw) => fullText.includes(kw))) return 'writing-rephrase';

  // 5. writing：长文创作类词（此时已排除代码信号、rewrite、rephrase 信号）
  if (WRITING_KEYWORDS.some((kw) => fullText.includes(kw))) return 'writing';

  // 6. cheap：短消息 + 显式琐碎低价信号（与写作无关，如格式化 json）
  const short = totalLen < 200;
  const cheapHit = CHEAP_KEYWORDS.some((kw) => {
    const rx = kw.length > 1 && !/^[a-z]{4,}$/.test(kw) ? new RegExp(kw, 'i') : kw;
    if (typeof rx === 'string') return fullText.includes(rx);
    return rx.test(fullText);
  });
  if (short && cheapHit) return 'cheap';

  // 7. general：兜底
  return 'general';
}

// 便于日志 / 调试：人类可读说明。
export function describeTaskType(t: TaskType): string {
  switch (t) {
    case 'vision': return '视觉/多模态任务 → 多模态模型';
    case 'coding': return '编码任务 → 重编码模型';
    case 'writing': return '写作任务 → 强且便宜模型';
    case 'writing-rewrite': return '改写(变长/结构)任务 → 强模型，不降档';
    case 'writing-rephrase': return '换表达任务 → 廉价模型';
    case 'cheap': return '低价值琐碎任务 → 免费/廉价模型';
    case 'general': return '通用任务 → 默认模型';
    default: return t;
    }
}