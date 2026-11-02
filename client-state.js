/**
 * 客户端账本（Client Ledger）适配层
 * ============================================================================
 *
 *  为什么需要这一层
 *  ---------------------------------------------------------------------------
 *  Skillsmith 的开关只有一半在「目录」上：摘掉 junction，技能目录里就没有
 *  这一项了。但**部分客户端并不只看目录** —— 它们各自还有一份私有账本，
 *  记着「哪些技能被用户关掉过」。
 *
 *  实测结果（2026-11，读各端二进制与配置确认）：
 *
 *    · Claude Code / CodeBuddy / Codex / OpenCode / Qoder
 *        只扫目录，没有独立账本 —— 摘 junction 即完全生效。
 *
 *    · Trae CN / Trae 国际版
 *        junction + <配置目录>/skill-config.json 的 disabledSkills 数组。
 *        只摘链接不写数组时，客户端可能仍按数组里的记录当作已禁用。
 *
 *    · 华为 CodeArts
 *        skills/ 下放真实目录副本，开关走 skills/UserSkillStatus.txt
 *        （name=false 表示禁用）。
 *
 *    · WorkBuddy
 *        共三处：junction + settings.json 的 skillOverrides 映射。
 *        WorkBuddy 自己的实现（app.asar 内 toggleSkill）是：
 *            disable ? setSkillOverrides(key, 'user-invocable-only' | 'off')
 *                    : deleteSkillOverrides(key)
 *        即「开启 = 把这个 key 从映射里删掉」，不是写 true。
 *        只在目录层做开关时，skillOverrides 原封不动，
 *        于是出现「在 Skillsmith 里打开了，客户端里还是关的」。
 *
 *  所以这一层把「各端账本的读写」收敛成三个函数，core.js 只调这三个，
 *  不再关心某个端的配置长什么样。
 *
 *  三种账本格式
 *  ---------------------------------------------------------------------------
 *    kv_lines    每行 key=value；value 为 false/true 表示禁用/启用
 *    json_array  JSON 对象的某个数组字段，元素是技能名；出现 = 禁用
 *    json_map    JSON 对象的某个映射字段，map[key]=禁用标记；不存在 = 启用
 *
 *  安全约束（这一层会写用户的真实配置文件，必须克制）
 *  ---------------------------------------------------------------------------
 *    1. 文件不存在 → 当作空账本，不报错
 *    2. 文件存在但解析失败 → **拒绝写入**并抛错。
 *       宁可这次开关失败，也不能覆盖掉用户那份可能是手写的配置。
 *    3. 写入前把原文件备份到 ~/.agents/skillsmith/backups/（最多留 20 份）
 *    4. 先写临时文件再 rename，避免写一半断电留下半个 JSON
 *    5. 内容没有实际变化时不写盘 —— 客户端可能监听文件变化做重载，
 *       无谓的写入会触发它整轮重扫
 *
 *  关于 key（技能名）
 *  ---------------------------------------------------------------------------
 *  账本里的 key 未必等于目录名。WorkBuddy 的解析顺序是
 *  「SKILL.md frontmatter 的 name → 相对路径 a:b → 目录名」，
 *  而历史数据里还出现过用 name_cn 的（例：score-rewrite 存成了「乐谱改写」）。
 *
 *  处理策略：
 *    · 读：候选 key 全部查一遍，任一命中即算禁用（宁可多报，不漏报）
 *    · 写：优先写在「已经存在的那个 key」上，保持客户端原有命名不变；
 *          都没有才新建，用 frontmatter name（没有则目录名）
 *    · 启用：把候选 key 全部清掉，避免残留造成「删了没生效」
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/** 备份目录：放在本工具自己的配置区，不往用户的客户端目录里扔文件 */
const BACKUP_DIR = path.join(HOME, '.agents', 'skillsmith', 'backups');
const BACKUP_KEEP = 20;

// ---------------------------------------------------------------- 小工具

/** 展开 ~ 与环境变量（与 settings.js 保持同一套规则） */
function expandHome(p) {
  if (!p) return p;
  let s = String(p).trim();
  if (s === '~') s = HOME;
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(HOME, s.slice(2));
  s = s.replace(/%USERPROFILE%/gi, HOME);
  s = s.replace(/%APPDATA%/gi, path.join(HOME, 'AppData', 'Roaming'));
  s = s.replace(/%LOCALAPPDATA%/gi, path.join(HOME, 'AppData', 'Local'));
  return path.resolve(s);
}

/** 文件内容原样读出来；不存在返回 null */
function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * 写盘前备份原文件。
 *
 * 为什么只保留 20 份而不是全部：这些是「改动前的快照」，用于回滚最近的操作。
 * 无限增长会把用户盘占满，而且越老的备份越没有回滚价值。
 */
function backupBeforeWrite(file, raw) {
  if (raw === null) return;   // 原本没有这个文件，不需要备份
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${path.basename(file)}.${stamp}.bak`;
    fs.writeFileSync(path.join(BACKUP_DIR, name), raw, 'utf8');

    // 只留最近 BACKUP_KEEP 份
    const all = fs.readdirSync(BACKUP_DIR)
      .filter((n) => n.endsWith('.bak'))
      .map((n) => ({ n, t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of all.slice(BACKUP_KEEP)) {
      try { fs.rmSync(path.join(BACKUP_DIR, old.n), { force: true }); } catch (e) { /* 忽略 */ }
    }
  } catch (e) {
    // 备份失败不应阻断开关，但必须让调用方能从日志看出「这次没有回滚点」
    console.warn('[ledger] 备份失败：' + e.message);
  }
}

/** 原子写：先写 .tmp 再 rename，避免写到一半留下半个文件 */
function atomicWrite(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.skillsmith-${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 解析 JSON，失败则抛一个带文件名的错。
 *
 * 刻意不捕获成「空对象」：这份配置可能是用户手写的，
 * 也可能是客户端正写到一半。静默重建会直接毁掉它。
 */
function parseJsonStrict(file, raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `配置文件不是合法 JSON，已跳过写入以免覆盖：${file}\n（${e.message}）`
    );
  }
}

// ---------------------------------------------------------------- 候选 key

/**
 * 生成一个技能的候选 key 列表（按优先级）。
 *
 * 顺序即优先级：
 *   1. frontmatter 的 name  —— 客户端官方解析规则的首选
 *   2. name_cn             —— 历史数据里出现过用它当 key 的情况
 *   3. 目录名               —— 兜底，几乎所有端都能对上
 *
 * 去重且保持顺序，避免同一个 key 被查两遍。
 *
 * @param {object} skill { name, title, ... } 技能条目
 * @param {object} fm    SKILL.md frontmatter（可为空对象）
 * @returns {string[]}
 */
function candidateKeys(skill, fm) {
  const list = [
    fm && fm.name,
    skill && skill.title,          // title 来自 frontmatter 的 name_cn
    skill && skill.name,           // 目录名
  ];
  const out = [];
  for (const k of list) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- 账本：读

/**
 * 读某端某技能的账本状态。
 *
 * @param {object} cfg      端配置（statusFile / statusKind / statusKey）
 * @param {string[]} keys   候选 key
 * @returns {{ hasLedger: boolean, disabled: boolean, key: string|null }}
 *          disabled=true 表示「账本明确记着这个技能是关的」
 */
function readLedger(cfg, keys) {
  const empty = { hasLedger: false, disabled: false, key: null };
  if (!cfg || !cfg.statusFile) return empty;

  const file = expandHome(cfg.statusFile);
  const raw = readRaw(file);
  if (raw === null) return { hasLedger: true, disabled: false, key: null };

  const lowered = keys.map((k) => k.toLowerCase());

  if (cfg.statusKind === 'kv_lines') {
    const map = parseKvLines(raw);
    for (const k of lowered) {
      if (!map.has(k)) continue;
      const v = String(map.get(k)).trim().toLowerCase();
      // 只有明确的 false 才算禁用；其它值（true / 空）都当启用
      return { hasLedger: true, disabled: v === 'false', key: k };
    }
    return { hasLedger: true, disabled: false, key: null };
  }

  if (cfg.statusKind === 'json_array') {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // 读不动就当空账本，不阻断判定（写的时候才严格）
      return { hasLedger: true, disabled: false, key: null };
    }
    const arr = Array.isArray(data[cfg.statusKey]) ? data[cfg.statusKey] : [];
    const pool = arr.map((x) => String(x).toLowerCase());
    for (const k of lowered) {
      const i = pool.indexOf(k);
      if (i >= 0) return { hasLedger: true, disabled: true, key: arr[i] };
    }
    return { hasLedger: true, disabled: false, key: null };
  }

  if (cfg.statusKind === 'json_map') {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { hasLedger: true, disabled: false, key: null };
    }
    const map = data[cfg.statusKey];
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      return { hasLedger: true, disabled: false, key: null };
    }
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      const v = String(map[k] || '').toLowerCase();
      // WorkBuddy 的语义：这三个值都表示「模型不得自动调用」
      const off = isMapValueOff(cfg, v);
      return { hasLedger: true, disabled: off, key: k, value: v };
    }
    // 大小写不敏感兜底（客户端可能做过规范化）
    for (const [kk, vv] of Object.entries(map)) {
      if (!lowered.includes(kk.toLowerCase())) continue;
      const v = String(vv || '').toLowerCase();
      return { hasLedger: true, disabled: isMapValueOff(cfg, v), key: kk, value: v };
    }
    return { hasLedger: true, disabled: false, key: null };
  }

  return { hasLedger: true, disabled: false, key: null };
}

/**
 * json_map 里哪些值代表「关闭」。
 *
 * 默认按 WorkBuddy 的定义：user-invocable-only / off / name-only
 * 都表示模型不能自动调用（见其 app.asar 内 overrideDisablesModel）。
 * 端配置可用 offValues 覆盖。
 */
function isMapValueOff(cfg, v) {
  const list = Array.isArray(cfg.offValues) && cfg.offValues.length
    ? cfg.offValues.map((x) => String(x).toLowerCase())
    : ['user-invocable-only', 'off', 'name-only'];
  return list.includes(v);
}

/** 解析 kv_lines 成 Map<小写 key, value> */
function parseKvLines(raw) {
  const map = new Map();
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim().toLowerCase();
    const v = t.slice(i + 1).trim();
    if (k) map.set(k, v);
  }
  return map;
}

// ---------------------------------------------------------------- 账本：写

/**
 * 把某端某技能在账本里标记为「开」或「关」。
 *
 * @param {object} cfg
 * @param {string[]} keys     候选 key（按客户端解析优先级排序）
 * @param {boolean} disabled  true=关, false=开
 * @param {string} [dirName]  技能目录名。新建记录时用得着：
 *                            kv_lines / json_array 两类端记的是目录名，
 *                            而 json_map 端（WorkBuddy）记的是 frontmatter name。
 *                            不能拿 keys 的最后一项冒充目录名 —— 候选列表
 *                            去重后最后一项可能是 name_cn（中文名），
 *                            写进去客户端按 name 查不到，等于没关。
 * @returns {{ changed: boolean, key: string|null, detail: string }}
 */
function writeLedger(cfg, keys, disabled, dirName) {
  if (!cfg || !cfg.statusFile) {
    return { changed: false, key: null, detail: '该端没有独立账本' };
  }
  const file = expandHome(cfg.statusFile);
  const raw = readRaw(file);

  if (cfg.statusKind === 'kv_lines') {
    return writeKvLines(file, raw, keys, disabled, dirName);
  }
  if (cfg.statusKind === 'json_array') {
    return writeJsonArray(file, raw, cfg, keys, disabled, dirName);
  }
  if (cfg.statusKind === 'json_map') {
    return writeJsonMap(file, raw, cfg, keys, disabled);
  }

  return { changed: false, key: null, detail: `未知账本格式：${cfg.statusKind}` };
}

/** 新建记录该用哪个 key（各端约定不同，见 writeLedger 注释） */
function newKeyFor(keys, dirName) {
  return dirName || keys[keys.length - 1] || keys[0] || null;
}

/** kv_lines：写 key=false / key=true */
function writeKvLines(file, raw, keys, disabled, dirName) {
  const text = raw === null ? '' : raw;
  const lines = text.split(/\r?\n/);
  const want = disabled ? 'false' : 'true';
  const lower = keys.map((k) => k.toLowerCase());

  let hit = -1;
  let hitValue = null;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim().toLowerCase();
    if (!lower.includes(k)) continue;
    hit = i;
    hitValue = t.slice(eq + 1).trim();
    break;
  }

  // 已经是要写的值 → 不碰文件
  if (hit >= 0 && hitValue === want) {
    return { changed: false, key: keys[0] || null, detail: '账本状态已一致' };
  }

  if (hit >= 0) {
    const eq = lines[hit].indexOf('=');
    const left = lines[hit].slice(0, eq);
    lines[hit] = `${left}=${want}`;
  } else if (disabled) {
    // 只有「关」才需要新增一行；「开」而本来没有记录 = 本来就是开的
    lines.push(`${newKeyFor(keys, dirName)}=false`);
  } else {
    return { changed: false, key: keys[0] || null, detail: '账本无记录，视为已开启' };
  }

  backupBeforeWrite(file, raw);
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  atomicWrite(file, body.endsWith('\n') ? body : body + '\n');
  return { changed: true, key: keys[0] || null, detail: disabled ? '账本标记禁用' : '账本标记启用' };
}

/** json_array：元素出现 = 禁用 */
function writeJsonArray(file, raw, cfg, keys, disabled, dirName) {
  const data = raw === null ? {} : parseJsonStrict(file, raw);
  const cur = Array.isArray(data[cfg.statusKey]) ? data[cfg.statusKey].slice() : [];
  const pool = cur.map((x) => String(x).toLowerCase());

  if (disabled) {
    // 已经在里面就不动
    if (keys.some((k) => pool.includes(k.toLowerCase()))) {
      return { changed: false, key: keys[0] || null, detail: '账本状态已一致' };
    }
    const key = newKeyFor(keys, dirName);
    cur.push(key);
    data[cfg.statusKey] = cur;
    backupBeforeWrite(file, raw);
    atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
    return { changed: true, key, detail: '账本标记禁用' };
  }

  const next = cur.filter((x) => !keys.some((k) => k.toLowerCase() === String(x).toLowerCase()));
  if (next.length === cur.length) {
    return { changed: false, key: keys[0] || null, detail: '账本状态已一致' };
  }
  data[cfg.statusKey] = next;
  backupBeforeWrite(file, raw);
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  return { changed: true, key: keys[0] || null, detail: '账本已启用' };
}

/**
 * json_map：map[key]=标记 表示禁用；启用 = 删 key。
 *
 * 新建记录用 keys[0]（frontmatter 的 name），不用候选列表末尾。
 * 原因：WorkBuddy 读账本时按「frontmatter name → 相对路径 → 目录名」解析，
 * 写 name_cn 它查不到，技能会被当成仍然开启 —— 等于开关失效（实测踩过：
 * parallel-agents 被写成了「并行智能体编排」，客户端读 name=parallel-agents 读不到）。
 *
 * 写「关」时用哪个值：
 *   用 cfg.offValue（默认 off = 完全关闭），不用 user-invocable-only。
 *   区别：user-invocable-only 只是「模型不自动调用，用户仍可手动 @」，
 *         off 才是真正关掉。Skillsmith 的语义是「关掉」，所以用 off。
 */
function writeJsonMap(file, raw, cfg, keys, disabled) {
  const data = raw === null ? {} : parseJsonStrict(file, raw);
  const map = (data[cfg.statusKey] && typeof data[cfg.statusKey] === 'object'
    && !Array.isArray(data[cfg.statusKey]))
    ? { ...data[cfg.statusKey] }
    : {};

  if (disabled) {
    // 已经存在就就地改值，保持客户端原有的 key 写法
    const existing = Object.keys(map).find(
      (k) => keys.some((x) => x.toLowerCase() === k.toLowerCase())
    );
    const offValue = cfg.offValue || 'off';
    // 新建时用最高优先级的 key（frontmatter name），客户端才认
    const key = existing || keys[0];

    if (existing && String(map[existing]).toLowerCase() === String(offValue).toLowerCase()) {
      return { changed: false, key: existing, detail: '账本状态已一致' };
    }
    map[key] = offValue;
    data[cfg.statusKey] = map;
    backupBeforeWrite(file, raw);
    atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
    return { changed: true, key, detail: '账本标记禁用' };
  }

  // 启用 = 删掉候选 key 的全部残留
  const victims = Object.keys(map).filter(
    (k) => keys.some((x) => x.toLowerCase() === k.toLowerCase())
  );
  if (!victims.length) {
    return { changed: false, key: keys[0] || null, detail: '账本无记录，视为已开启' };
  }
  for (const v of victims) delete map[v];
  data[cfg.statusKey] = map;
  backupBeforeWrite(file, raw);
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  return { changed: true, key: victims[0], detail: '账本已启用（删除记录）' };
}

module.exports = {
  candidateKeys,
  readLedger,
  writeLedger,
  expandHome,
  parseKvLines,
  BACKUP_DIR,
};
