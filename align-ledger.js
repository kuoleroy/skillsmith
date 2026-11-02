/**
 * 账本对齐工具（一次性修复 + 可重复安全执行）
 * ============================================================================
 *
 *  解决的问题
 *  ---------------------------------------------------------------------------
 *  过去的开关只改目录（摘 junction / 删真实副本），但没同步客户端自己的
 *  禁用账本。结果是：目录已经就位，客户端读完自己的账本又把技能当作关的 ——
 *  用户必须去客户端里再点一次，本工具就失去了意义。
 *
 *  这个脚本把两层的状态对齐：以「目录状态」为准（目录在 = 用户希望开启），
 *  把客户端账本刷成一致的结果。
 *
 *  为什么以目录为准
 *  ---------------------------------------------------------------------------
 *  目录是用户在本工具里操作时唯一可见的结果，也是判断「该端到底有没有这个
 *  技能」的直接依据。账本是客户端的内部记录，它不一致本身就是 bug，
 *  所以按目录纠正它。
 *
 *  安全保证
 *  ---------------------------------------------------------------------------
 *    · 只处理有独立账本的端（其余端只有目录，不存在不一致）
 *    · 默认 dry-run，只看不改；加 --apply 才写盘
 *    · 每次写盘前自动备份到 ~/.agents/skillsmith/backups/
 *    · 不新增技能、不删除技能，只改账本里的禁用记录
 *    · 可重复执行：已经一致的不动（writeLedger 内部判 changed）
 *
 *  用法
 *  ---------------------------------------------------------------------------
 *    node align-ledger.js            # 预演，列出将要做的修改
 *    node align-ledger.js --apply    # 真正写入
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const core = require('./core.js');
const agentConfig = require('./agent-config.js');

const APPLY = process.argv.includes('--apply');

// 只取有账本的端
const ledgerAgents = agentConfig.listAgents()
  .filter((a) => a.statusFile && a.enabled !== false && !a.unsupported);

if (!ledgerAgents.length) {
  console.log('没有配置了独立账本的端，无需对齐。');
  process.exit(0);
}

console.log('='.repeat(64));
console.log('账本对齐' + (APPLY ? '（写入模式）' : '（预演模式，加 --apply 才写入）'));
console.log('有账本的端：' + ledgerAgents.map((a) => a.name).join(', '));
console.log('='.repeat(64));

const before = core.verifyLedger();
console.log('\n对齐前：检查 ' + before.checked + ' 组，不一致 ' + before.problems.length + ' 处\n');

if (!before.problems.length) {
  console.log('已经全部一致，无需操作。');
  process.exit(0);
}

// 按「技能 + 端」逐条修：以目录状态为准
let fixed = 0;
let skipped = 0;

for (const p of before.problems) {
  const cfg = core.AGENTS[p.agent];
  if (!cfg) { skipped += 1; continue; }

  // 目录在 → 期望开（清账本）；目录不在 → 期望关（但这类通常无需写账本）
  if (!p.dirPresent) {
    console.log(`  跳过  ${p.agent} / ${p.skill}  （目录不在，无需对齐账本）`);
    skipped += 1;
    continue;
  }

  if (!APPLY) {
    console.log(`  待修  ${p.agent} / ${p.skill}  → 清除客户端禁用记录`);
    fixed += 1;
    continue;
  }

  try {
    const r = core.enable(p.skill, p.agent);
    const bad = r.filter((x) => !x.ok);
    if (bad.length) {
      console.log(`  失败  ${p.agent} / ${p.skill}  ${bad[0].detail}`);
      skipped += 1;
    } else {
      console.log(`  已修  ${p.agent} / ${p.skill}  → ${r[0].detail}`);
      fixed += 1;
    }
  } catch (e) {
    console.log(`  异常  ${p.agent} / ${p.skill}  ${e.message}`);
    skipped += 1;
  }
}

console.log('\n' + '-'.repeat(64));
console.log((APPLY ? '已修 ' : '待修 ') + fixed + ' 处，跳过 ' + skipped + ' 处');

if (APPLY) {
  const after = core.verifyLedger();
  console.log('对齐后：不一致 ' + after.problems.length + ' 处');
  if (after.problems.length) {
    console.log('\n仍存在的不一致：');
    for (const p of after.problems.slice(0, 20)) {
      console.log('  - ' + p.kind + ' | ' + p.agent + '/' + p.skill);
    }
  }
}
console.log('='.repeat(64));

process.exit(APPLY && core.verifyLedger().problems.length > 0 ? 1 : 0);
