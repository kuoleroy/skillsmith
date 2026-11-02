/**
 * 技能清单（manifest）解析。
 *
 * ============================================================================
 * 为什么需要单独一层，而不是直接用 core.readFrontmatter
 * ============================================================================
 * core 里那个解析器只认单行 `key: value`，够用是因为它只取 name / description。
 * 但「安装」要对一个来源做尽调：这个技能叫什么、哪个版本、什么许可、谁写的、
 * 有多大、有没有入口文件。这些信息在真实技能里写法五花八门：
 *
 *   实测 12 个技能：11 个有 frontmatter，1 个首行是 BOM 开头的 `---`；
 *   只有 1 个声明了 version。也就是说「版本」目前基本不存在。
 *
 * 所以这里的原则是 **容错优先，不强制规范**：
 *   · 缺 version 不算错，标成 unknown，安装记录里按 commit / 时间兜底
 *   · 缺 description 只记一条提醒（会影响 AI 判断何时调用，但不致命）
 *   · name 与目录名不一致要报出来（账本按 name 记账，不一致会导致开关失灵，
 *     这个坑我们踩过：写中文名进 skillOverrides，客户端按 name 查不到）
 *
 * 不引第三方 yaml 库。项目一直是零运行时依赖，装个解析器只为读几个字段不划算。
 * 这里实现的是 YAML 的**子集**，覆盖技能清单的实际写法，不是完整 YAML。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 清单入口文件名。技能必须以此为入口，各客户端也都认。 */
const ENTRY = 'SKILL.md';

/** 文件名层级上限，防恶意来源用深目录撑爆扫描 */
const MAX_DEPTH = 8;

// ---------------------------------------------------------------- 基础工具

/** 去掉 UTF-8 BOM。实测 comfyui 技能首行是 `\uFEFF---`，不剥掉连 frontmatter 都识别不到。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 去掉值两端的引号（只处理最外层，不处理内部的引号转义） */
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** 行内数组 `[a, b, "c"]` → ['a','b','c']；不是数组语法则返回 null */
function parseInlineArray(s) {
  const t = s.trim();
  if (!/^\[.*\]$/.test(t)) return null;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((x) => unquote(x)).filter(Boolean);
}

/**
 * 解析 frontmatter 的 YAML 子集。
 *
 * 支持的写法（都是技能里真实出现过的）：
 *   name: foo
 *   name: "foo bar"
 *   tags: [a, b]
 *   tags:
 *     - a
 *     - b
 *   description: |
 *     多行字面量，保留换行
 *   description: >
 *     多行折叠，合并成一行
 *   # 注释
 *
 * @param {string} block frontmatter 内部文本（不含首尾 ---）
 * @returns {Record<string, string|string[]>}
 */
function parseFrontmatterBlock(block) {
  const out = {};
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 空行与注释跳过（注释要求行首，避免把 URL 里的 # 当注释）
    if (!line.trim() || /^\s*#/.test(line)) continue;

    // 顶层键必须不缩进。缩进行属于上一个键的值，在本循环里被上面的分支消费掉。
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    let value = m[2];

    // ---- 块标量：`key: |` / `key: >`，后续缩进行是内容 ----
    const blockMark = value.match(/^([|>])([+-]?)\s*$/);
    if (blockMark) {
      const style = blockMark[1]; // | 保留换行，> 折叠成空格
      const buf = [];
      let j = i + 1;
      // 收集所有缩进行（或空行）。遇到下一个顶层键就停。
      for (; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === '') { buf.push(''); continue; }
        if (/^\s/.test(l)) { buf.push(l.replace(/^\s{1,4}/, '')); continue; }
        break;
      }
      // 去掉尾部空行（YAML 的 chomping，`-` 表示不保留结尾换行）
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      out[key] = style === '|' ? buf.join('\n') : buf.join(' ').replace(/\s+/g, ' ').trim();
      i = j - 1;
      continue;
    }

    // ---- 列表：`key:` 后面跟若干 `  - item` ----
    if (value.trim() === '') {
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === '') continue;
        const li = l.match(/^\s+-\s+(.*)$/);
        if (li) { items.push(unquote(li[1])); continue; }
        if (/^\s/.test(l)) continue;  // 列表项下的续行，忽略
        break;
      }
      if (items.length) {
        out[key] = items;
        i = j - 1;
        continue;
      }
      out[key] = '';
      continue;
    }

    // ---- 行内数组 ----
    const arr = parseInlineArray(value);
    if (arr) { out[key] = arr; continue; }

    // ---- 普通标量 ----
    out[key] = unquote(value);
  }

  return out;
}

/**
 * 从文本里抽出 frontmatter。没有则返回 null。
 * 允许 BOM、允许首尾多余空行、允许 `---` 后带空格。
 */
function extractFrontmatter(text) {
  const src = stripBom(text);
  const m = src.match(/^[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- 技能名校验

/**
 * 技能名合法性。
 *
 * 技能名会被当作**目录名**拼进真源路径，所以必须挡住路径穿越：
 *   `../../Windows/System32` 这类名字一旦放行，安装就是任意位置写文件。
 * 同时排除 Windows 保留名与非法字符，否则 mkdir 会失败或产生诡异目录。
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * @param {string} name
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, reason: '名字为空' };
  }
  const n = name.trim();

  if (n.length > 100) return { ok: false, reason: '名字超过 100 字符' };
  if (n === '.' || n === '..') return { ok: false, reason: '名字不能是 . 或 ..' };
  // 同时挡住 / 和 \，以及 Windows 非法字符与结尾的点/空格
  if (/[\\/:*?"<>|]/.test(n)) return { ok: false, reason: '名字含路径分隔符或非法字符' };
  if (/[\x00-\x1f]/.test(n)) return { ok: false, reason: '名字含控制字符' };
  if (/^\./.test(n)) return { ok: false, reason: '名字不能以点开头（会变成隐藏目录）' };
  if (/[. ]$/.test(n)) return { ok: false, reason: '名字不能以点或空格结尾' };
  if (RESERVED.has(n.toLowerCase())) return { ok: false, reason: '名字是 Windows 保留设备名' };

  return { ok: true };
}

// ---------------------------------------------------------------- 主入口

/**
 * 读取一个技能目录的清单。
 *
 * @param {string} dir 技能目录（应含 SKILL.md）
 * @param {{ expectedName?: string }} [opts]
 *        expectedName：安装时的目标目录名，用于比对 frontmatter.name 与目录是否一致
 * @returns {{
 *   ok: boolean,
 *   dir: string,
 *   entry: string|null,
 *   name: string|null,
 *   title: string,
 *   description: string,
 *   version: string|null,
 *   license: string|null,
 *   author: string|null,
 *   tags: string[],
 *   raw: Record<string, string|string[]>,
 *   problems: Array<{ code: string, message: string }>,
 *   fatal: Array<{ code: string, message: string }>
 * }}
 */
function readManifest(dir, opts = {}) {
  const result = {
    ok: false,
    dir,
    entry: null,
    name: null,
    title: '',
    description: '',
    version: null,
    license: null,
    author: null,
    tags: [],
    raw: {},
    problems: [],
    fatal: [],
  };

  if (typeof dir !== 'string' || !dir) {
    result.fatal.push({ code: 'no-dir', message: '未提供技能目录' });
    return result;
  }

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    result.fatal.push({ code: 'not-found', message: `目录不存在：${dir}` });
    return result;
  }
  if (!stat.isDirectory()) {
    result.fatal.push({ code: 'not-dir', message: `不是目录：${dir}` });
    return result;
  }

  const entryPath = path.join(dir, ENTRY);
  let text;
  try {
    text = fs.readFileSync(entryPath, 'utf8');
  } catch (e) {
    // 没有 SKILL.md 就不是技能。有些仓库把技能放子目录，由 installer 负责定位。
    result.fatal.push({
      code: 'no-entry',
      message: `目录里没有 ${ENTRY}，不是可安装的技能`,
    });
    return result;
  }
  result.entry = ENTRY;

  const fmText = extractFrontmatter(text);
  if (fmText === null) {
    // 没有 frontmatter 不致命：客户端仍会加载这个技能，只是少了元信息。
    // 名字退回目录名，并记一条提醒 —— 完全拒绝会让一批老技能装不进来。
    result.problems.push({
      code: 'no-frontmatter',
      message: `SKILL.md 没有 frontmatter，名字与描述只能从正文/目录名推断`,
    });
  } else {
    result.raw = parseFrontmatterBlock(fmText);
  }

  const raw = result.raw;
  const str = (v) => (Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v))).trim();

  // ---- 名字：优先 frontmatter.name，退回目录名 ----
  // 客户端（WorkBuddy 的 skillOverrides、Trae 的 disabledSkills）都按这个名字记账，
  // 所以它比目录名更重要。两者不一致时必须报出来。
  const dirName = path.basename(dir);
  const fmName = str(raw.name);
  if (fmName) {
    result.name = fmName;
    if (opts.expectedName && fmName !== opts.expectedName) {
      result.problems.push({
        code: 'name-mismatch',
        message: `frontmatter.name（${fmName}）与目录名（${opts.expectedName}）不一致；`
          + '客户端按 name 记账，改名后原有开关状态可能失联',
      });
    }
    // 名字里出现路径分隔符：可能被当成路径拼接，必须挡住
    const v = validateName(fmName);
    if (!v.ok) {
      result.fatal.push({
        code: 'bad-name',
        message: `frontmatter.name 不可用作目录名：${v.reason}`,
      });
    }
  } else {
    result.name = dirName;
    result.problems.push({
      code: 'no-name',
      message: `frontmatter 没写 name，用目录名「${dirName}」代替`,
    });
  }

  // ---- 展示名 ----
  result.title = str(raw.name_cn) || str(raw.title) || str(raw.displayName) || result.name || dirName;

  // ---- 描述 ----
  result.description = str(raw.description) || str(raw.description_cn);
  if (!result.description) {
    result.problems.push({
      code: 'no-description',
      message: '没有 description，AI 无法判断何时该调用这个技能（会降低命中率）',
    });
  }

  // ---- 版本 / 许可 / 作者 ----
  // 没有 version 是常态（实测 12 个技能只有 1 个有）。不当作问题，
  // 安装记录里用 commit 或安装时间兜底，保证"装的是哪一版"仍有据可查。
  result.version = str(raw.version) || null;
  result.license = str(raw.license) || null;
  result.author = str(raw.author) || (Array.isArray(raw.authors) ? raw.authors.join(', ') : null);

  // ---- 标签 ----
  if (Array.isArray(raw.tags)) result.tags = raw.tags.map((x) => String(x).trim()).filter(Boolean);
  else if (str(raw.tags)) result.tags = str(raw.tags).split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  result.ok = result.fatal.length === 0;
  return result;
}

/**
 * 在一个可能很杂的目录里定位技能根。
 *
 * 为什么需要：很多技能仓库是 monorepo，SKILL.md 在 `skills/xxx/` 下面，
 * 而不是仓库根。直接拿仓库根当技能装进去，客户端读不到入口。
 *
 * 策略（从严到宽）：
 *   1. 根目录就有 SKILL.md        → 就是它
 *   2. 恰好找到一个子目录有 SKILL.md → 用那个
 *   3. 找到多个                    → 不猜，报错让调用方指定 subdir
 *
 * @param {string} root
 * @param {number} [maxDepth]
 * @returns {{ root: string|null, candidates: string[] }}
 */
function locateSkillRoot(root, maxDepth = MAX_DEPTH) {
  try {
    if (fs.statSync(path.join(root, ENTRY)).isFile()) {
      return { root, candidates: [root] };
    }
  } catch (e) { /* 根目录没有入口，往下找 */ }

  const found = [];
  const walk = (d, depth) => {
    if (depth > maxDepth || found.length > 20) return;   // 限制搜索规模
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 跳过明显的非技能目录，省时间也避免把依赖里的样例当技能
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist'
          || e.name === 'build' || e.name === '__pycache__') continue;
      const p = path.join(d, e.name);
      try {
        if (fs.statSync(path.join(p, ENTRY)).isFile()) {
          found.push(p);
          continue;   // 找到就不再往里钻
        }
      } catch (err) { /* 忽略 */ }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);

  if (found.length === 1) return { root: found[0], candidates: found };
  return { root: null, candidates: found };
}

module.exports = {
  ENTRY,
  readManifest,
  extractFrontmatter,
  parseFrontmatterBlock,
  validateName,
  locateSkillRoot,
  stripBom,
};
