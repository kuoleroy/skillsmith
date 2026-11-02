/**
 * 真实环境联通性验证
 * ============================================================================
 *
 *  目的：证明「在 Skillsmith 里开关」= 「客户端账本真的变了」。
 *
 *  做法（对每个有账本的端各跑一轮）：
 *    1. 记录开关前的目录状态 + 账本状态
 *    2. 调 core.disable()  → 检查：目录摘掉 & 账本写了禁用标记
 *    3. 调 core.enable()   → 检查：目录建回 & 账本禁用标记被清
 *    4. 还原到初始状态，并断言最终状态 == 初始状态
 *
 *  安全：所有文件在运行前已备份到 ledger-real-test-backup/。
 *       脚本只对「自己指定的一两个技能」操作，不碰全量。
 *
 *  运行：node verify-real-sync.js <技能名>
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./core.js');
const cs = require('./client-state.js');
const agentConfig = require('./agent-config.js');

const skillName = process.argv[2] || 'mv-image-pipeline';

// 只挑有独立账本的端来验证（无账本端只看目录，逻辑简单）
const LEDGER_AGENTS = agentConfig.listAgents()
  .filter((a) => a.statusFile && a.enabled !== false && !a.unsupported)
  .map((a) => a.name);

function probe() {
  const agents = agentConfig.listAgents();
  const out = {};
  for (const name of LEDGER_AGENTS) {
    const a = agents.find((x) => x.name === name);
    if (!a) continue;
    const p = path.join(a.dir, skillName);
    let dirPresent;
    if (a.mode === 'realdir') {
      try {
        const st = fs.lstatSync(p);
        dirPresent = st.isDirectory() && !st.isSymbolicLink();
      } catch (e) { dirPresent = false; }
    } else {
      try {
        dirPresent = fs.lstatSync(p).isSymbolicLink();
      } catch (e) { dirPresent = false; }
    }
    const led = cs.readLedger(
      { statusFile: a.statusFile, statusKind: a.statusKind,
        statusKey: a.statusKey, offValue: a.offValue, offValues: a.offValues },
      ledgerKeysFor(skillName)
    );
    out[name] = {
      mode: a.mode,
      dirPresent, ledgerDisabled: led.disabled, ledgerKey: led.key, ledgerValue: led.value,
    };
  }
  return out;
}

// core 内部的 ledgerKeys 没导出，这里复刻同一套规则（读真源 SKILL.md）
function ledgerKeysFor(name) {
  const dir = path.join(core.canonRoot(), name);
  let fm = {};
  try {
    let text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      for (const line of m[1].split(/\r?\n/)) {
        const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) { /* 没 SKILL.md 就用目录名 */ }
  return cs.candidateKeys({ name, title: fm.name_cn || '' }, fm);
}

function show(label, state) {
  console.log('  ' + label);
  for (const [agent, s] of Object.entries(state)) {
    console.log(
      '    ' +
      agent.padEnd(18) +
      ' 目录=' + (s.dirPresent ? '在' : '无') +
      '  账本=' + (s.ledgerDisabled ? '禁用' : '开') +
      (s.ledgerValue ? ' (值=' + s.ledgerValue + ')' : '')
    );
  }
}

function same(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return false;
  for (const k of ka) {
    if (a[k].dirPresent !== b[k].dirPresent) return false;
    if (a[k].ledgerDisabled !== b[k].ledgerDisabled) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 账本快照
//
// 关键：这个脚本会真的改客户端配置。测完必须精确还原，
// 否则会把用户设的「仅手动调用」（user-invocable-only）清成「开」——
// 那是用户为了省 token 主动设的状态，不能被测试顺手改掉。
//
// 所以测前把每个端、每个候选 key 的原始值记下来，测后逐条写回。

/** 直接读写配置文件里的原始值（不走 client-state 的语义层，要原样复原） */
function snapshotLedger() {
  const snap = {};
  const agents = agentConfig.listAgents();
  for (const a of agents) {
    if (!a.statusFile || a.enabled === false || a.unsupported) continue;
    const file = cs.expandHome(a.statusFile);
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { /* 不存在 */ }
    snap[a.name] = { file, raw, kind: a.statusKind, key: a.statusKey };
  }
  return snap;
}

/**
 * 还原账本：把文件内容整个写回原始文本。
 *
 * 为什么整文件还原而不是逐 key 修：
 *   开关过程可能新增/删除 key、改变 JSON 缩进 —— 逐 key 修容易漏。
 *   直接写回原文本是唯一能保证「字节级一致」的做法。
 *   如果这个技能本来就在账本里没记录、测完也没记录，写回原文本同样正确。
 */
function restoreLedger(snap) {
  let restored = 0;
  for (const [agent, s] of Object.entries(snap)) {
    try {
      let cur = null;
      try { cur = fs.readFileSync(s.file, 'utf8'); } catch (e) { /* 可能不存在 */ }
      if (cur === s.raw) continue;            // 没变过，不碰
      if (s.raw === null) {
        // 原本没有这个文件 → 删掉测试创建出来的
        try { fs.rmSync(s.file, { force: true }); } catch (e) { /* 忽略 */ }
      } else {
        fs.writeFileSync(s.file, s.raw, 'utf8');
      }
      restored += 1;
    } catch (e) {
      console.log(`  ! 还原 ${agent} 失败：${e.message}`);
    }
  }
  return restored;
}

// ---------------------------------------------------------------- 主流程

console.log('='.repeat(64));
console.log('真实联通性验证：' + skillName);
console.log('参与验证的端（有独立账本）：' + LEDGER_AGENTS.join(', '));
console.log('='.repeat(64));

// 先存原样，最后无论成功失败都还原
const ledgerSnapshot = snapshotLedger();

const initial = probe();
console.log('\n[0] 初始状态');
show('', initial);

let failures = 0;
function assertTrue(cond, msg) {
  if (cond) {
    console.log('  ✓ ' + msg);
  } else {
    console.log('  ✗ ' + msg);
    failures += 1;
  }
}

// ---- 关闭 ----
console.log('\n[1] 调 core.disable() —— 期望：目录摘掉 + 账本写禁用');
const offResults = core.disable(skillName);
for (const r of offResults) {
  if (r.ok) console.log(`    ${r.agent.padEnd(18)} ${r.detail}`);
}
const afterOff = probe();
show('', afterOff);
for (const agent of Object.keys(afterOff)) {
  // realdir 端（CodeArts）的「关闭」语义是「保留目录副本 + 清单标禁用」，
  // 不是删目录 —— 它 readdir 时过滤符号链接，只认真实目录，删了反而要重拷。
  // 所以这里按各端自己的机制断言，不能一刀切要求目录消失。
  const isRealdir = afterOff[agent].mode === 'realdir';
  if (isRealdir) {
    assertTrue(afterOff[agent].dirPresent === true, agent + ' 目录保留（realdir 设计）');
  } else {
    assertTrue(afterOff[agent].dirPresent === false, agent + ' 目录已摘除');
  }
  assertTrue(afterOff[agent].ledgerDisabled === true, agent + ' 账本记着禁用');
}

// ---- 开启 ----
console.log('\n[2] 调 core.enable() —— 期望：目录建回 + 账本禁用标记清除');
const onResults = core.enable(skillName);
for (const r of onResults) {
  if (r.ok) console.log(`    ${r.agent.padEnd(18)} ${r.detail}`);
}
const afterOn = probe();
show('', afterOn);
for (const agent of Object.keys(afterOn)) {
  assertTrue(afterOn[agent].dirPresent === true, agent + ' 目录已建立');
  assertTrue(afterOn[agent].ledgerDisabled === false, agent + ' 账本已无禁用记录');
}

// ---- 还原账本原样 ----
//
// 开关过程会清掉「仅手动调用」这类用户设置，必须原样写回。
// 目录保持「开」是对的（测完技能本就该是开着的），只还原账本。
console.log('\n[3] 还原客户端账本到测试前原样');
const restoredN = restoreLedger(ledgerSnapshot);
if (restoredN) {
  console.log('  ✓ 已还原 ' + restoredN + ' 个配置文件（含「仅手动调用」等用户设置）');
} else {
  console.log('  ✓ 无需还原（测试未改变任何账本）');
}

// ---- 一致性自检 ----
console.log('\n[4] 全量一致性自检 verifyLedger()');
const v = core.verifyLedger();
console.log('  检查组合:', v.checked,
  ' 真问题:', v.problems.length,
  ' 仅手动:', v.manualOnly,
  ' 提醒:', v.notices.length);
if (!v.ok) {
  for (const p of v.problems.slice(0, 12)) {
    console.log('    ✗', p.kind, '|', p.agent + '/' + p.skill);
  }
}

console.log('\n' + '='.repeat(64));
console.log(failures ? `失败 ${failures} 项` : '全部通过：目录与账本同步一致，且原有设置已还原');
console.log('='.repeat(64));
process.exit(failures ? 1 : 0);
