/**
 * 本地技能搜索。
 *
 * ============================================================================
 * 为什么自己写而不用 fuzzysort / fuse.js
 * ============================================================================
 * 1. 项目是零运行时依赖。为了一个搜索框引一个库，安装包多几十 KB，
 *    还得跟着人家升级 —— 不划算。
 * 2. 需要的不是"通用模糊搜索"，是**知道字段重要性**的搜索：
 *    名字命中比描述命中更有意义。通用库要额外配权重，配完还不如手写清楚。
 * 3. 数据量小（真源里通常几十个技能），O(n) 逐条打分完全够用。
 *
 * ============================================================================
 * 打分规则
 * ============================================================================
 * 一个字串在某字段里怎么算"命中"，按可信度从高到低：
 *
 *   相等      1.00   query 就是这个字段的全部
 *   前缀      0.85   "mv" → "mv-image-pipeline"
 *   词边界    0.80   "pipe" → "mv-image-pipeline"（命中某个词的开头）
 *   包含      0.70   任意位置出现
 *   子序列    0.30   字符按顺序出现即可，"mvi" → "mv-image-pipeline"
 *
 * 最终分 = Σ(各词最佳命中字段权重 × 命中质量) + 奖励项。
 *
 * 多词是 AND：每个词都必须至少命中一个字段，否则整条不入选。
 * 这样 "comfy 视频" 只会返回同时沾两者的技能，而不是把两个词的结果堆一起。
 */

'use strict';

const installer = require('./installer.js');
const manifest = require('./manifest.js');

/** 字段权重。名字是用户最主要的识别依据，描述只作补充。 */
const FIELDS = [
  // allowSub: 是否允许子序列（缩写）匹配。
  // 只在名字/标题/标签上开：描述里做子序列等于噪声制造机 ——
  // 实测 "mvi" 会命中 browser-cli-skill 这种毫不相关的技能。
  { key: 'name', weight: 10, allowSub: true },
  { key: 'title', weight: 8, allowSub: true },
  { key: 'tags', weight: 6, allowSub: true },
  { key: 'description', weight: 3, allowSub: false },
];

/**
 * 子序列的最低密度。低于它就认为"只是碰巧有几个同字母"。
 *
 * 举例（都实测过）：
 *   "mvi" → mv-image-pipeline        m0 v1 i3  跨度 4  密度 0.75  ✓
 *   "mvi" → comfyui-minimax-h3-video m2 v19 i20 跨度 19 密度 0.16 ✗
 * 没有这道闸，缩写搜索会把一半技能都捞出来。
 */
const MIN_SUB_DENSITY = 0.4;

/** 索引缓存。搜索框每敲一个字都会打接口，重复遍历目录太浪费。 */
const CACHE_TTL_MS = 2000;
let _cache = { at: 0, root: null, items: null };

/** 让下一次搜索重建索引。安装 / 卸载 / 纳管之后必须调用。 */
function invalidate() {
  _cache = { at: 0, root: null, items: null };
}

/**
 * 构建可搜索的条目。
 *
 * 数据来源是 installer.listInstalled()：它已经把「安装记录」和「真源实况」
 * 合并好了，三种状态（installed / missing / unmanaged）都在里面。
 * 额外要补的是 tags —— listInstalled 没带，得从 SKILL.md 现读。
 */
function buildIndex() {
  const fs = require('fs');
  const path = require('path');
  const root = require('./core.js').canonRoot();

  const items = installer.listInstalled().map((it) => {
    let tags = [];
    // missing 状态没有目录可读，跳过
    if (it.status !== 'missing') {
      try {
        const dir = path.join(root, it.name);
        if (fs.existsSync(dir)) {
          tags = manifest.readManifest(dir).tags || [];
        }
      } catch (e) { /* 读不到 tags 不影响搜索 */ }
    }
    return {
      ...it,
      tags,
      // 预先拼好小写串，避免每次比较都重复 toLowerCase
      _nameLower: String(it.name).toLowerCase(),
      _titleLower: String(it.title || '').toLowerCase(),
      _descLower: String((it.current && it.current.description) || '').toLowerCase(),
      _tagsLower: tags.map((t) => String(t).toLowerCase()),
    };
  });

  _cache = { at: Date.now(), root, items };
  return items;
}

function getIndex(force) {
  const root = require('./core.js').canonRoot();
  const stale = Date.now() - _cache.at > CACHE_TTL_MS;
  if (force || !_cache.items || stale || _cache.root !== root) return buildIndex();
  return _cache.items;
}

// ---------------------------------------------------------------- 匹配

/**
 * 子序列匹配：q 的字符按顺序出现在 text 里。
 * 返回紧密度 0~1（连续命中越集中越高），不匹配返回 0。
 *
 * 用途：缩写搜索。"mvi" → "mv-image-pipeline"，"cwh" → "comfyui-workflow-analysis"。
 * 这类输入用包含匹配完全搜不到，但用户确实爱这么打。
 */
function subsequenceQuality(text, q) {
  if (!q) return 0;
  let ti = 0;
  let hit = 0;
  let first = -1;
  let last = -1;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    while (ti < text.length && text[ti] !== ch) ti += 1;
    if (ti >= text.length) return 0;    // 有字符没找到 → 整体不匹配
    if (first < 0) first = ti;
    last = ti;
    hit += 1;
    ti += 1;
  }
  // 跨度越小越像"真的在缩写它"；太散视为碰巧同字母，直接不算命中
  const span = last - first + 1;
  const density = hit / span;
  if (density < MIN_SUB_DENSITY) return 0;
  return 0.3 * (0.5 + 0.5 * density);
}

/**
 * 单字段单词的命中质量。0 表示没命中。
 *
 * @param {string} text 已小写
 * @param {string} q    已小写
 * @param {boolean} allowSub 是否允许子序列兜底
 */
function fieldQuality(text, q, allowSub = true) {
  if (!text || !q) return 0;
  if (text === q) return 1;

  if (text.startsWith(q)) {
    // 恰好命中一个完整词的开头，比"字母碰巧在前面"更强
    return text.length > q.length && /[\s\-_./·]/.test(text[q.length]) ? 0.95 : 0.85;
  }

  const at = text.indexOf(q);
  if (at > 0) {
    // 命中位置前面是分隔符 → 命中了某个词的开头
    const prev = text[at - 1];
    return /[\s\-_./·]/.test(prev) ? 0.8 : 0.7;
  }

  return allowSub ? subsequenceQuality(text, q) : 0;
}

/** 把 query 拆成词。空格、逗号、中文顿号都当分隔。 */
function tokenize(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 给一个条目打分。
 *
 * @param {object} item
 * @param {string[]} terms 已小写的词
 * @param {string} fullQuery 整串 query（已小写），用于"照着名字打"的奖励
 * @param {boolean} requireAll true = 每个词都必须命中（AND）；
 *                             false = 任一词命中即可（OR，回退用）
 * @returns {{ score: number, matched: string[] } | null}
 */
function scoreItem(item, terms, fullQuery, requireAll = true) {
  const values = {
    name: item._nameLower,
    title: item._titleLower,
    tags: item._tagsLower,
    description: item._descLower,
  };

  let total = 0;
  const matched = new Set();

  for (const term of terms) {
    let best = 0;
    let bestField = null;

    for (const f of FIELDS) {
      const v = values[f.key];
      let q = 0;
      if (Array.isArray(v)) {
        // tags 是数组：任一项命中即取最高
        for (const t of v) q = Math.max(q, fieldQuality(t, term, f.allowSub));
      } else {
        q = fieldQuality(v, term, f.allowSub);
      }
      const score = q * f.weight;
      if (score > best) {
        best = score;
        bestField = f.key;
      }
    }

    if (best <= 0) {
      if (requireAll) return null;   // AND 模式下有话没命中 → 整条不符合
      continue;                       // OR 模式下跳过这个词
    }
    total += best;
    if (bestField) matched.add(bestField);
  }

  if (total <= 0) return null;

  // 奖励：整串 query 直接出现在名字里，说明用户基本是照着名字打的
  if (terms.length > 1 && fullQuery) {
    const nameQ = fieldQuality(values.name, fullQuery, true);
    if (nameQ >= 0.7) total += nameQ * 8;
  }

  // 已装的稍微靠前：用户搜到它多半是要开关，而不是要重装
  if (item.status === 'installed') total += 1.5;
  // 残留记录排后：它不可用，只是待清理
  if (item.status === 'missing') total -= 3;

  return { score: Math.round(total * 100) / 100, matched: [...matched] };
}

// ---------------------------------------------------------------- 对外

/**
 * 搜索本地技能。
 *
 * @param {string} query
 * @param {{ limit?: number, force?: boolean }} [opts]
 * @returns {{
 *   query: string,
 *   total: number,
 *   results: Array<object>,
 *   indexSize: number,
 *   cached: boolean
 * }}
 */
function searchLocal(query, opts = {}) {
  const limit = Math.max(1, Math.min(200, opts.limit || 50));
  const cached = !opts.force && Date.now() - _cache.at <= CACHE_TTL_MS && Boolean(_cache.items);
  const items = getIndex(opts.force);

  const q = String(query || '').trim();
  const terms = tokenize(q);

  // 空查询 = 浏览全部，按状态 + 名字排序（让用户能像看清单一样翻）
  if (!terms.length) {
    const sorted = items.slice().sort((a, b) => {
      const rank = { missing: 0, installed: 1, unmanaged: 2 };
      const d = rank[a.status] - rank[b.status];
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
    return {
      query: q,
      partial: false,
      total: sorted.length,
      results: sorted.slice(0, limit).map(({ _nameLower, _titleLower, _descLower, _tagsLower, ...rest }) => ({
        ...rest,
        score: 0,
        matched: [],
      })),
      indexSize: items.length,
      cached,
    };
  }

  const scored = [];
  for (const it of items) {
    const r = scoreItem(it, terms, q.toLowerCase(), true);
    if (!r) continue;
    scored.push({ item: it, ...r });
  }

  /*
   * 多词一个都没"全中"时，退回 OR 并标记 partial。
   *
   * 为什么：用户打「comfy 视频」，本意是"找跟这两个都沾边的"，
   * 但很多技能描述是英文（comfyui 写的是 "Generate images, video…"），
   * AND 会把它们全过滤掉，只剩一条 —— 看起来像"搜不到"。
   * 退回 OR 至少给出候选，同时明确告知「只匹配了部分关键词」，
   * 不至于让人以为结果就是全部。
   */
  let partial = false;
  if (!scored.length && terms.length > 1) {
    partial = true;
    for (const it of items) {
      const r = scoreItem(it, terms, q.toLowerCase(), false);
      if (!r) continue;
      scored.push({ item: it, ...r });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

  return {
    query: q,
    partial,
    total: scored.length,
    results: scored.slice(0, limit).map(({ item, score, matched }) => {
      const { _nameLower, _titleLower, _descLower, _tagsLower, ...rest } = item;
      return { ...rest, score, matched };
    }),
    indexSize: items.length,
    cached,
  };
}

module.exports = {
  searchLocal,
  invalidate,
  // 导出给测试用
  _internal: { tokenize, fieldQuality, subsequenceQuality, scoreItem },
};
