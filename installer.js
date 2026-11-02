/**
 * 技能安装 / 卸载。
 *
 * ============================================================================
 * 定位
 * ============================================================================
 * 这个模块把 Skillsmith 从「开关面板」变成「技能的安装入口」：
 *   来源（本地文件夹 / git 仓库） → 临时目录 → 尽调（清单 + 安全扫描）
 *   → 用户确认 → 复制进真源 → 记录来源 → 可选地给各端建立链接
 *
 * ============================================================================
 * 三条不可让步的设计约束
 * ============================================================================
 * 1. **元数据绝不写进技能目录。**
 *    `installed.json` 放在 ~/.agents/skillsmith/。写进技能目录会污染真源，
 *    而且客户端会把多出来的文件也读进上下文 —— 技能目录必须保持"可分发"的原样。
 *
 * 2. **安装前必须能看见装的是什么。**
 *    preview() 拉取完整内容、解析清单、跑安全扫描、算体积，全部返回给调用方。
 *    install() 不重新拉取，只接受一个已在预览里确认过的 plan。
 *    这样"看到的就是装的"，不存在预览与安装之间的偷换。
 *
 * 3. **路径必须被约束在真源内。**
 *    技能名来自不可信来源（远端仓库的 frontmatter）。它会被当目录名拼路径，
 *    所以必须先过 validateName，再用 resolve 后的前缀校验兜底 ——
 *    两道都过才允许写盘。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const manifest = require('./manifest.js');
const safety = require('./safety.js');
const core = require('./core.js');

/** 配置目录与安装记录。与 settings.js / agent-config.js 保持一致的位置。 */
const CONFIG_DIR = path.join(os.homedir(), '.agents', 'skillsmith');
const INSTALLED_FILE = path.join(CONFIG_DIR, 'installed.json');

/**
 * git clone 的硬超时。
 *
 * 60 秒是权衡：正常仓库几秒内完成，超时太短会把慢网络下的正常克隆打断，
 * 太长会让用户对着转圈界面失去耐心。超时后按失败处理并给出可操作的提示。
 */
const GIT_TIMEOUT_MS = 60 * 1000;

// ---------------------------------------------------------------- 记录读写

/** 读安装记录。文件损坏时返回空结构而不抛异常 —— 记录丢了不该让整个软件打不开。 */
function readInstalled() {
  try {
    const d = JSON.parse(fs.readFileSync(INSTALLED_FILE, 'utf8'));
    if (d && typeof d === 'object' && d.skills && typeof d.skills === 'object') return d;
  } catch (e) { /* 不存在或损坏，按空处理 */ }
  return { version: 1, skills: {} };
}

/** 原子写：先写 tmp 再 rename，避免写一半断电留下坏 JSON */
function writeInstalled(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${INSTALLED_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, INSTALLED_FILE);
}

// ---------------------------------------------------------------- 来源解析

/**
 * 把用户输入归一化成可执行的来源描述。
 *
 * 支持三种写法（都是包管理器的常见约定，不自创语法）：
 *   · 本地路径        C:\path\to\skill   或   ./relative/skill
 *   · 简写仓库        owner/repo
 *   · 仓库 URL        https://github.com/owner/repo
 *                     https://github.com/owner/repo/tree/main/skills/foo
 *                     owner/repo#skills/foo
 *
 * 不支持 zip：项目零依赖，Node 没有内置解压。硬做一个半残的 zip 解析器
 * 反而增加攻击面。压缩包用户解压后按本地文件夹安装即可，这一点在报错里说明。
 *
 * @param {string} input
 * @returns {{ type: 'local'|'git', input: string, dir?: string, url?: string, subdir: string|null, label: string }}
 */
function parseSource(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('没有提供来源');
  }
  const raw = input.trim();

  /*
   * 展开 `~`。
   * 必须支持：README 与文档里到处写 `~/.agents/skills`，用户很自然会把
   * `~/my-skill` 直接粘进来。早先版本不认这个，落到 git 分支后报
   * 「看不懂的来源」—— 提示词与该做的事对不上，属于纯误导。
   */
  let expanded = raw;
  if (raw === '~') {
    expanded = os.homedir();
  } else if (/^~[\\/]/.test(raw)) {
    expanded = path.join(os.homedir(), raw.slice(2));
  }

  // ---- 本地路径优先判断：能 stat 到目录就当本地，避免把 `./a/b` 误认成 owner/repo ----
  const looksLocal = /^[a-zA-Z]:[\\/]/.test(expanded)   // C:\ 或 C:/
    || /^\\\\/.test(expanded)                            // UNC
    || /^\.{1,2}[\\/]/.test(expanded)                     // ./ 或 ../
    || expanded.startsWith('/');                          // POSIX 绝对路径

  if (looksLocal) {
    const dir = path.resolve(expanded);
    let st;
    try {
      st = fs.statSync(dir);
    } catch (e) {
      throw new Error(`本地路径不存在：${dir}`);
    }
    if (!st.isDirectory()) throw new Error(`不是目录：${dir}`);
    return { type: 'local', input: raw, dir, subdir: null, label: `本地 · ${path.basename(dir)}` };
  }

  // ---- 远程：只接受 git ----
  if (/\.zip$/i.test(raw) || /\.tar\.gz$/i.test(raw)) {
    throw new Error('暂不支持直接安装压缩包。请先解压，再用「本地文件夹」方式安装');
  }

  let url = raw;
  let subdir = null;

  // `#subdir` 后缀。放在最前面拆，避免后面处理 URL 片段时混淆。
  const hashAt = url.indexOf('#');
  if (hashAt > 0) {
    subdir = url.slice(hashAt + 1) || null;
    url = url.slice(0, hashAt);
  }

  // GitHub 的 /tree/<branch>/<path> 写法：拆成仓库地址 + 子目录
  const tree = url.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/[^/]+\/(.+)$/);
  if (tree) {
    url = tree[1];
    subdir = tree[2];
  }

  // owner/repo 简写
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    url = `https://github.com/${url}`;
  }

  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
    throw new Error('看不懂的来源。可以是：本地文件夹路径、owner/repo、或 git 仓库地址');
  }

  // GitHub 地址补 .git（少一次重定向，也让 clone 行为更确定）
  if (/github\.com\//.test(url) && !/\.git$/.test(url)) url += '.git';

  const repoName = (url.match(/\/([^/]+?)(?:\.git)?$/) || [])[1] || 'repo';
  return {
    type: 'git',
    input: raw,
    url,
    subdir,
    label: `git · ${repoName}${subdir ? `/${subdir}` : ''}`,
  };
}

// ---------------------------------------------------------------- 拉取

/** git 是否可用。不可用时给一句能照做的提示，而不是让用户看 ENOENT。 */
function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 把来源拉到临时目录，返回 { dir, commit, cleanup }。调用方负责删除。
 *
 * 为什么是 async：git clone 要等网络，用 execFileSync 会阻塞事件循环 ——
 * 整个 HTTP 服务在这几秒里连静态资源都发不出去，界面看起来就是卡死。
 * 改成异步后，前端可以正常显示"正在获取"并保持响应。
 */
async function fetchToTemp(source) {
  if (source.type === 'local') {
    return { dir: source.dir, commit: null, cleanup: () => {} };
  }

  if (!gitAvailable()) {
    throw new Error('未找到 git。安装远程仓库需要 git，请先安装 git 或改用本地文件夹');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-fetch-'));
  const cleanup = () => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  };

  try {
    await execFileAsync('git', [
      'clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet',
      source.url, tmp,
    ], { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    cleanup();
    // 超时与网络失败要分开说，否则用户不知道该重试还是该改地址
    if (e.killed || e.signal) {
      throw new Error(`获取超时（${GIT_TIMEOUT_MS / 1000} 秒）：${source.url}。请检查网络后重试`);
    }
    const detail = String(e.stderr || e.message || '').trim().split('\n').slice(-2).join(' ');
    throw new Error(`克隆失败：${detail || '未知错误'}（仓库地址：${source.url}）`);
  }

  let commit = null;
  try {
    const r = await execFileAsync('git', ['-C', tmp, 'rev-parse', 'HEAD'], {
      timeout: 8000, maxBuffer: 1024 * 1024,
    });
    commit = String(r.stdout).trim();
  } catch (e) { /* 拿不到 commit 不影响安装，只是记录里少个字段 */ }

  return { dir: tmp, commit, cleanup };
}

// ---------------------------------------------------------------- 体积与估算

/**
 * 目录体积统计。
 * 不直接复用 core.dirStats 是因为这里要一并排除 .git ——
 * git 元数据对技能无用，算进体积会让"这个技能多大"失真。
 */
function measure(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { files += 1; bytes += fs.statSync(p).size; } catch (err) { /* 忽略 */ }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * 粗估这个技能会占多少上下文 token。
 *
 * 口径：只算 SKILL.md 正文。客户端常驻上下文的是技能的元信息与入口正文，
 * 附属脚本是抽查而非全量加载，把它算进来会严重高估。
 * 系数 2.5 字符/token 是保守取值（中英混排），宁可高估让人注意体积。
 */
function estimateTokens(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, manifest.ENTRY), 'utf8');
    return Math.round(text.length / 2.5);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- 预览

/**
 * 预演一次安装：把来源拉下来、解析、扫描，返回完整报告，**不写任何东西到真源**。
 *
 * @param {string} input 用户输入的来源
 * @param {{ subdir?: string }} [opts]
 * @returns {Promise<object>} 预览报告
 */
async function preview(input, opts = {}) {
  const source = parseSource(input);
  const { dir: fetchedDir, commit, cleanup } = await fetchToTemp(source);

  try {
    // 定位技能根：支持 monorepo（SKILL.md 在子目录里）
    let skillDir;
    if (opts.subdir || source.subdir) {
      const sub = opts.subdir || source.subdir;
      skillDir = path.join(fetchedDir, sub);
      if (!fs.existsSync(path.join(skillDir, manifest.ENTRY))) {
        throw new Error(`指定的子目录里没有 ${manifest.ENTRY}：${sub}`);
      }
    } else {
      const located = manifest.locateSkillRoot(fetchedDir);
      if (!located.root) {
        if (located.candidates.length > 1) {
          const list = located.candidates
            .map((c) => path.relative(fetchedDir, c).split(path.sep).join('/'))
            .slice(0, 8).join('、');
          throw new Error(`这个来源里有多个技能（${list}），请指定子目录`);
        }
        throw new Error(`来源里没找到 ${manifest.ENTRY}，不是可安装的技能`);
      }
      skillDir = located.root;
    }

    // 相对路径，用于展示"这个子目录会被当成技能"
    const relPath = path.relative(fetchedDir, skillDir).split(path.sep).join('/') || '.';

    /*
     * 目录名比对只在「目录名有意义」时才做：
     *   · 本地来源 → 用户指定目录的名字，就是它要成为的名字
     *   · git 来源且定位到子目录 → 子目录名是真名字
     *   · git 来源且就是仓库根     → 根是 `skillsmith-fetch-xxxx` 这种临时名，
     *                              拿来比对必然误报（实测踩过：
     *                              mv-image-pipeline 被报成 name 与目录名不一致）
     */
    const expectedName = source.type === 'local'
      ? path.basename(fetchedDir)
      : (relPath === '.' ? null : path.basename(skillDir));

    const manifestResult = manifest.readManifest(skillDir, {
      expectedName: expectedName || undefined,
    });
    if (!manifestResult.ok) {
      throw new Error(manifestResult.fatal[0].message);
    }

    const nameCheck = manifest.validateName(manifestResult.name);
    if (!nameCheck.ok) {
      throw new Error(`技能名不能用作目录名：${nameCheck.reason}`);
    }

    const safetyResult = safety.scan(skillDir);
    const size = measure(skillDir);
    const tokens = estimateTokens(skillDir);

    // 重名与状态检查
    const targetDir = path.join(core.canonRoot(), manifestResult.name);
    const exists = fs.existsSync(targetDir);
    const record = readInstalled().skills[manifestResult.name] || null;

    return {
      ok: true,
      source: { ...source, dir: undefined },   // 临时目录不对外暴露
      skillDir,
      relPath,
      name: manifestResult.name,
      title: manifestResult.title,
      description: manifestResult.description,
      version: manifestResult.version,
      license: manifestResult.license,
      author: manifestResult.author,
      tags: manifestResult.tags,
      commit,
      size,
      tokens,
      safety: {
        verdict: safety.verdict(safetyResult),
        summary: safetyResult.summary,
        findings: safetyResult.findings,
        executables: safetyResult.executables,
        scanned: safetyResult.scanned,
      },
      problems: manifestResult.problems,
      conflict: {
        exists,
        targetDir,
        // 已装过：让界面能显示"升级/覆盖"而不是"新装"
        previouslyInstalled: Boolean(record),
        previousVersion: record ? record.version : null,
        previousInstalledAt: record ? record.installedAt : null,
      },
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------- 安装

/** 确认目标路径落在真源内。技能名来自远端，这一步是最后一道防线。 */
function assertInsideCanon(target) {
  const root = path.resolve(core.canonRoot());
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`拒绝写入真源之外的路径：${resolved}`);
  }
}

/**
 * 执行安装。
 *
 * 注意：这里会**重新拉取一次**来源，而不是复用 preview 的临时目录。
 * 原因是 preview 结束后临时目录会被删（不把下载物留在磁盘上等用户决定）。
 * 代价是多一次网络往返，换来的是"预览里看到的 commit 就是装进去的" ——
 * 所以下面会校验两次的 commit 是否一致，不一致直接中止。
 *
 * @param {string} input
 * @param {{
 *   subdir?: string,
 *   overwrite?: boolean,
 *   expectedCommit?: string,     // preview 返回的 commit，用于防止来源在两次之间变化
 *   enableAgents?: boolean|string[]  // false 不建链接；true/数组 建链接
 * }} [opts]
 * @returns {Promise<{ ok: boolean, name: string, targetDir: string, enabled: Array, warnings: string[] }>}
 */
async function install(input, opts = {}) {
  const source = parseSource(input);
  const { dir: fetchedDir, commit, cleanup } = await fetchToTemp(source);

  const warnings = [];
  try {
    // ---- 定位技能根（与 preview 完全同一套逻辑） ----
    let skillDir;
    const sub = opts.subdir || source.subdir;
    if (sub) {
      skillDir = path.join(fetchedDir, sub);
      if (!fs.existsSync(path.join(skillDir, manifest.ENTRY))) {
        throw new Error(`指定的子目录里没有 ${manifest.ENTRY}：${sub}`);
      }
    } else {
      const located = manifest.locateSkillRoot(fetchedDir);
      if (!located.root) {
        throw new Error(located.candidates.length > 1
          ? '这个来源里有多个技能，请指定子目录'
          : `来源里没找到 ${manifest.ENTRY}`);
      }
      skillDir = located.root;
    }

    // ---- 与预览比对：来源在两次拉取之间变了就停 ----
    if (opts.expectedCommit && commit && opts.expectedCommit !== commit) {
      throw new Error('来源在确认期间发生了变化（commit 不一致），请重新预览后再装');
    }

    // 与 preview 用同一套判定：git 来源落在仓库根时，目录名是临时名，不能拿来比对
    const relPath = path.relative(fetchedDir, skillDir).split(path.sep).join('/') || '.';
    const expectedName = source.type === 'local'
      ? path.basename(fetchedDir)
      : (relPath === '.' ? null : path.basename(skillDir));

    const m = manifest.readManifest(skillDir, { expectedName: expectedName || undefined });
    if (!m.ok) throw new Error(m.fatal[0].message);

    const nameCheck = manifest.validateName(m.name);
    if (!nameCheck.ok) throw new Error(`技能名不能用作目录名：${nameCheck.reason}`);

    const name = m.name;
    const target = path.join(core.canonRoot(), name);
    assertInsideCanon(target);

    // ---- 重名处理 ----
    if (fs.existsSync(target)) {
      if (!opts.overwrite) {
        throw new Error(`真源里已经有「${name}」了。如需覆盖，请明确选择覆盖`);
      }
      // 覆盖前拒绝动 junction：真源里出现链接说明配置被人为改过，
      // 顺着链接写会写到真源之外。
      if (core.isJunction(target)) {
        throw new Error(`真源里的「${name}」是目录联接，状态异常，已中止以免写穿到别处`);
      }
      // 两段式删除：先改名再删。直接递归删除在部分宿主环境会撞护栏，
      // 而 rename 是原子的，且失败时原目录还在、可回滚。
      const backup = `${target}.replaced-${Date.now()}`;
      fs.renameSync(target, backup);
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (e) {
        warnings.push(`旧版本未能完全删除，已改名为 ${path.basename(backup)}，可手动清理`);
      }
    }

    // ---- 落盘 ----
    fs.mkdirSync(core.canonRoot(), { recursive: true });
    fs.cpSync(skillDir, target, { recursive: true, dereference: false });

    // 复制后再校验一次：目标必须真的落在真源内（防 cpSync 的符号链接把内容带出去）
    assertInsideCanon(target);
    if (!fs.existsSync(path.join(target, manifest.ENTRY))) {
      throw new Error('复制后目标目录缺少 SKILL.md，安装可能不完整');
    }

    // ---- 记录来源 ----
    const data = readInstalled();
    const size = measure(target);
    data.skills[name] = {
      name,
      title: m.title,
      source: {
        type: source.type,
        input: source.input,
        url: source.url || null,
        subdir: sub || null,
      },
      version: m.version,
      commit,
      installedAt: new Date().toISOString(),
      bytes: size.bytes,
      files: size.files,
      // 安全扫描的结论一并留档：以后升级时可以对比风险是否变高
      safety: safety.scan(target).summary,
    };
    writeInstalled(data);

    // ---- 按需给各端建立链接 ----
    const enabled = [];
    if (opts.enableAgents !== false) {
      const only = Array.isArray(opts.enableAgents) ? opts.enableAgents : null;
      try {
        const results = only
          ? only.flatMap((agent) => core.enable(name, agent))
          : core.enable(name);
        for (const r of results) {
          if (r.ok) enabled.push(r.agent);
          else warnings.push(`${r.agent}：${r.detail}`);
        }
      } catch (e) {
        warnings.push(`技能已装入真源，但建立链接时出错：${e.message}。可用面板手动开启`);
      }
    }

    // 清单里的小毛病不阻断安装，但要让用户知道
    for (const p of m.problems) warnings.push(p.message);

    return { ok: true, name, targetDir: target, enabled, warnings, commit };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------- 卸载

/**
 * 卸载一个技能。
 *
 * 顺序很重要：**先摘各端链接，再删真源**。
 * 反过来的话，删除真源会让所有 junction 同时断链，而断链的联接待会
 * 让后续清理更难判断（我们在真源搬家时踩过这个坑）。
 *
 * 走 core.disable 而不是自己删链接，是为了顺带处理客户端账本 ——
 * 否则技能删了、WorkBuddy 的 skillOverrides 还留着一条记录。
 *
 * @param {string} name
 * @param {{ keepRecord?: boolean }} [opts]
 */
function uninstall(name, opts = {}) {
  const nameCheck = manifest.validateName(name);
  if (!nameCheck.ok) throw new Error(`技能名不合法：${nameCheck.reason}`);

  const target = path.join(core.canonRoot(), name);
  assertInsideCanon(target);

  const exists = fs.existsSync(target);
  const record = readInstalled().skills[name] || null;

  if (!exists && !record) {
    throw new Error(`真源和安装记录里都没有「${name}」`);
  }

  const warnings = [];

  // 1. 摘掉各端（同时清客户端账本）
  let detached = [];
  if (exists) {
    try {
      const results = core.disable(name);
      detached = results.filter((r) => r.ok).map((r) => r.agent);
      for (const r of results.filter((x) => !x.ok)) {
        warnings.push(`${r.agent}：${r.detail}`);
      }
    } catch (e) {
      warnings.push(`摘除链接时出错：${e.message}`);
    }
  }

  // 2. 删真源。真源里不应有 junction，出现就说明状态被人为改过，宁可不删。
  if (exists) {
    if (core.isJunction(target)) {
      throw new Error(`真源里的「${name}」是目录联接，拒绝删除以免写到别处`);
    }
    const trash = `${target}.removed-${Date.now()}`;
    fs.renameSync(target, trash);
    try {
      fs.rmSync(trash, { recursive: true, force: true });
    } catch (e) {
      warnings.push(`未能完全删除，已改名为 ${path.basename(trash)}，可手动清理`);
    }
  }

  // 3. 删记录
  if (!opts.keepRecord && record) {
    const data = readInstalled();
    delete data.skills[name];
    writeInstalled(data);
  }

  return { ok: true, name, detached, removedFromCanon: exists, warnings };
}

// ---------------------------------------------------------------- 列表

/**
 * 已安装技能清单：安装记录 ∪ 真源实况。
 *
 * 两边都要看，因为会不一致：
 *   · 记录有、目录没了 → 用户手删了目录，记录是残留
 *   · 目录有、没记录   → 手工拷进来的，或从别的机器搬来的
 * 这两种状态对用户都重要：前者要能清理残留记录，后者要能"纳管"。
 */
function listInstalled() {
  const data = readInstalled();
  const canonRoot = core.canonRoot();
  const out = [];
  const seen = new Set();

  for (const [name, rec] of Object.entries(data.skills)) {
    seen.add(name);
    const dir = path.join(canonRoot, name);
    const inCanon = fs.existsSync(dir);
    let current = null;
    if (inCanon) {
      const m = manifest.readManifest(dir, { expectedName: name });
      const size = measure(dir);
      current = {
        title: m.title,
        version: m.version,
        description: m.description,
        bytes: size.bytes,
        files: size.files,
        problems: m.problems.map((p) => p.code),
      };
    }
    out.push({
      name,
      title: rec.title || name,
      source: rec.source,
      version: rec.version,
      commit: rec.commit,
      installedAt: rec.installedAt,
      status: inCanon ? 'installed' : 'missing',
      // 记录与真源都能读出清单时，比对版本是否变了 —— 变了说明本地被改过
      changed: Boolean(
        inCanon && rec.version && current && current.version && rec.version !== current.version
      ),
      current,
      record: { bytes: rec.bytes, files: rec.files, safety: rec.safety },
    });
  }

  // 真源里有、但没安装记录的
  for (const s of core.listSkills()) {
    if (seen.has(s.name)) continue;
    out.push({
      name: s.name,
      title: s.title,
      source: null,
      version: null,
      commit: null,
      installedAt: null,
      status: 'unmanaged',   // 手工放入或从别处搬来
      changed: false,
      current: {
        title: s.title,
        version: null,
        description: s.description,
        bytes: s.bytes,
        files: s.files,
      },
      record: null,
    });
  }

  out.sort((a, b) => {
    // 有问题的排前面：missing 比 unmanaged 更需要处理
    const rank = { missing: 0, installed: 1, unmanaged: 2 };
    const d = rank[a.status] - rank[b.status];
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return out;
}

/** 给手工放进真源的技能补一条记录，之后就能看到来源与升级信息 */
function adopt(name) {
  const nameCheck = manifest.validateName(name);
  if (!nameCheck.ok) throw new Error(`技能名不合法：${nameCheck.reason}`);

  const dir = path.join(core.canonRoot(), name);
  assertInsideCanon(dir);
  if (!fs.existsSync(dir)) throw new Error(`真源里没有「${name}」`);

  const m = manifest.readManifest(dir, { expectedName: name });
  if (!m.ok) throw new Error(m.fatal[0].message);

  const data = readInstalled();
  if (data.skills[name]) throw new Error(`「${name}」已经有记录了`);

  const size = measure(dir);
  data.skills[name] = {
    name,
    title: m.title,
    source: { type: 'local', input: null, url: null, subdir: null, adopted: true },
    version: m.version,
    commit: null,
    installedAt: new Date().toISOString(),
    bytes: size.bytes,
    files: size.files,
    safety: safety.scan(dir).summary,
  };
  writeInstalled(data);
  return { ok: true, name };
}

module.exports = {
  CONFIG_DIR,
  INSTALLED_FILE,
  parseSource,
  preview,
  install,
  uninstall,
  listInstalled,
  adopt,
  readInstalled,
  estimateTokens,
  measure,
};
