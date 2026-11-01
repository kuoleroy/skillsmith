#!/usr/bin/env node
/**
 * 回归测试：真源搬家后「重新绑定」必须能看见断链的 junction
 * ============================================================
 *  复现的 bug：
 *    1) rebindAll 用 stat()（跟随链接）过滤端目录下的技能项，
 *       断链的 junction stat 抛错被丢弃 → 搬家后一个链接都没重绑。
 *    2) makeJunction 用 existsSync 判断存在性，
 *       断链的 junction 被误判成「不存在」→ symlinkSync 撞 EEXIST。
 *
 *  隔离要求（重要）：
 *    这测试要造 junction、摘 junction，绝不能碰用户真实的端和真源。
 *    所以全程用临时目录：
 *      · 真源   → SANDBOX/canon
 *      · 端目录 → SANDBOX/agent/skills
 *      · 配置文件（agents.json / settings.json）先备份、测完原样恢复
 *    在 CI runner 上（没有任何真实端、也没有真源）也能跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SANDBOX = path.join(HOME, '.agents', 'skillsmith-test-rebind');
const CFG_DIR = path.join(HOME, '.agents', 'skillsmith');
const CFG_FILE = path.join(CFG_DIR, 'agents.json');
const SET_FILE = path.join(CFG_DIR, 'settings.json');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

// ── 环境备份 / 恢复 ────────────────────────────────────────────
const backups = {};
function backupFile(p) {
  backups[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
}
function restoreFiles() {
  for (const [p, buf] of Object.entries(backups)) {
    try {
      if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p, { force: true }); }
      else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
    } catch (e) { /* ignore */ }
  }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

backupFile(CFG_FILE);
backupFile(SET_FILE);

// core/settings 要在改配置之前加载
const core = require(path.join(__dirname, 'core.js'));
const settings = require(path.join(__dirname, 'settings.js'));

const OLD_CANON = settings.getCanonRoot();

try {
  // ── 搭隔离环境 ────────────────────────────────────────────────
  rmrf(SANDBOX);
  const CANON = path.join(SANDBOX, 'canon');
  const AGENT_DIR = path.join(SANDBOX, 'agent', 'skills');
  fs.mkdirSync(path.join(CANON, 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(CANON, 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 测试用技能\n---\n\n正文\n', 'utf8');
  fs.mkdirSync(AGENT_DIR, { recursive: true });

  // 临时真源 + 临时端
  settings.setCanonRoot(CANON);
  core.clearCanonCache();
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({
    version: 1,
    agents: [{ id: 'test-agent', name: '测试端', dir: AGENT_DIR, mode: 'junction' }],
  }, null, 2), 'utf8');

  console.log('\n=== 0. 隔离环境就绪 ===');
  check('真源已指向临时目录', core.canonRoot() === CANON, core.canonRoot());
  check('真源里有 1 个技能', core.listSkills().length === 1, core.listSkills().length);
  // 注意：AGENTS 是 Proxy，没实现 has trap —— 用 'x' in core.AGENTS 不可靠，
  //      要用 Object.keys（走 ownKeys trap）。
  check('生效映射里有测试端',
    Object.keys(core.AGENTS).includes('测试端'), Object.keys(core.AGENTS));

  const skill = core.listSkills()[0].name;
  const p = path.join(AGENT_DIR, skill);

  console.log('\n=== 1. 造一个断链的 junction ===');
  fs.symlinkSync(path.join(SANDBOX, 'OLD-NONEXISTENT-PATH', skill), p, 'junction');
  check('断链 junction 已创建', fs.lstatSync(p).isSymbolicLink());
  check('existsSync 判为不存在（这正是 bug 根源）', !fs.existsSync(p));
  check('lstat 判为符号链接（修复后靠它识别）', fs.lstatSync(p).isSymbolicLink());

  console.log('\n=== 2. makeJunction 能覆盖断链链接（不撞 EEXIST）===');
  let mkErr = null;
  try {
    core.makeJunction(path.join(CANON, skill), p);
  } catch (e) { mkErr = e.message; }
  check('makeJunction 未报 EEXIST', !mkErr, mkErr);
  check('已指向真源', core.linksToCanon(p, skill));

  console.log('\n=== 3. rebindAll 能看见断链项并重绑 ===');
  core.removeJunction(p);
  fs.symlinkSync(path.join(SANDBOX, 'OLD-NONEXISTENT-PATH', skill), p, 'junction');
  check('已造出断链', fs.lstatSync(p).isSymbolicLink() && !fs.existsSync(p));

  const dry = core.rebindAll({ dryRun: true, missing: 'keep' });
  const item = dry.report.find(r => r.agent === '测试端' && r.skill === skill);
  check('dryRun 报告里包含这个断链项', !!item, dry.report.length);
  check('dryRun 判定为需要 rebind', item && item.action === 'rebind', item);

  const real = core.rebindAll({ dryRun: false, missing: 'keep' });
  const item2 = real.report.find(r => r.agent === '测试端' && r.skill === skill);
  check('正式重绑后已指向当前真源', core.linksToCanon(p, skill), item2);
  check('真源内容完好', fs.existsSync(path.join(CANON, skill, 'SKILL.md')));
} catch (e) {
  fail++;
  console.error('\n✗ 测试异常：', e && e.message);
} finally {
  // ── 还原 ──────────────────────────────────────────────────────
  console.log('\n=== 5. 还原环境 ===');
  restoreFiles();
  settings.setCanonRoot(OLD_CANON);
  core.clearCanonCache();
  rmrf(SANDBOX);
  check('真源地址已还原', settings.getCanonRoot() === OLD_CANON, settings.getCanonRoot());
}

console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
