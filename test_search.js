#!/usr/bin/env node
/**
 * search.js 测试。
 *
 * 隔离：真源指向沙箱，造一批名字/描述差异明显的技能，
 * 断言排序与命中字段 —— 不依赖用户机器上实际装了什么。
 *
 * 重点验证两类容易被"看起来能用"骗过去的行为：
 *   1. 子序列（缩写）搜索不能太松 —— 否则缩写会把一半技能都捞出来
 *   2. 多词 AND 无结果时要退到 OR 并标记 partial —— 否则用户以为搜不到
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SANDBOX = path.join(HOME, '.agents', 'skillsmith-test-search');
const CFG_DIR = path.join(HOME, '.agents', 'skillsmith');
const CFG_FILE = path.join(CFG_DIR, 'agents.json');
const SET_FILE = path.join(CFG_DIR, 'settings.json');
const INS_FILE = path.join(CFG_DIR, 'installed.json');

let pass = 0;
let fail = 0;
function check(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}

// ---------------------------------------------------------------- 备份

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
backupFile(INS_FILE);

const core = require(path.join(__dirname, 'core.js'));
const settings = require(path.join(__dirname, 'settings.js'));
const search = require(path.join(__dirname, 'search.js'));

const OLD_CANON = settings.getCanonRoot();

/** 造一个技能 */
function makeSkill(root, name, { title, description, tags } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = ['---', `name: ${name}`];
  if (title) fm.push(`name_cn: ${title}`);
  if (description) fm.push(`description: ${description}`);
  if (tags && tags.length) fm.push(`tags: [${tags.join(', ')}]`);
  fm.push('---', '', '正文', '');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${fm.join('\n')}\n`, 'utf8');
}

const names = (r) => r.results.map((x) => x.name);
const first = (r) => (r.results[0] || {}).name;

try {
  // ---------------------------------------------------------------- 沙箱
  rmrf(SANDBOX);
  const CANON = path.join(SANDBOX, 'canon');
  const AGENT_DIR = path.join(SANDBOX, 'agent', 'skills');
  fs.mkdirSync(CANON, { recursive: true });
  fs.mkdirSync(AGENT_DIR, { recursive: true });

  settings.setCanonRoot(CANON);
  core.clearCanonCache();
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify({
    version: 1,
    agents: [{ id: 'test-agent', name: '测试端', dir: AGENT_DIR, mode: 'junction' }],
  }, null, 2), 'utf8');

  // 故意造差异明显的样本：中英混排、有 abbr、有长描述
  makeSkill(CANON, 'mv-image-pipeline', {
    title: 'MV 视频流水线',
    description: '用 AI 生成图片制作音乐视频，支持 ASS 字幕与 Ken Burns 渲染',
    tags: ['视频', '流水线'],
  });
  makeSkill(CANON, 'comfyui', {
    title: 'ComfyUI 出图',
    description: 'Generate images and video with ComfyUI workflow',
    tags: ['image'],
  });
  makeSkill(CANON, 'comfyui-model-setup', {
    title: 'ComfyUI 模型安装',
    description: '查找模型下载源、核验直链',
    tags: ['模型'],
  });
  makeSkill(CANON, 'score-rewrite', {
    title: '乐谱改写',
    description: '处理 MusicXML 乐谱：改写乐曲、合并声部',
  });
  makeSkill(CANON, 'parallel-agents', {
    title: '并行智能体',
    description: 'Orchestrate multiple agents in parallel',
  });

  search.invalidate();

  console.log('\n=== 1. 空查询 = 浏览全部 ===');
  const all = search.searchLocal('');
  check('空查询返回全部', all.total === 5, all.total);
  check('partial 为 false', all.partial === false);

  console.log('\n=== 2. 名字匹配优先 ===');
  const q1 = search.searchLocal('comfyui');
  check('命中 2 个 comfyui 技能', q1.total === 2, q1.total);
  check('完全相等的排第一', first(q1) === 'comfyui', first(q1));
  check('匹配字段标注 name', q1.results[0].matched.includes('name'), q1.results[0].matched);

  console.log('\n=== 3. 大小写不敏感 ===');
  const q2 = search.searchLocal('COMFYUI');
  check('大写也命中', q2.total === 2, q2.total);
  check('排序与小写一致', first(q2) === 'comfyui', first(q2));

  console.log('\n=== 4. 中文与描述匹配 ===');
  const q3 = search.searchLocal('乐谱');
  check('中文命中', q3.total === 1, q3.total);
  check('命中的是 score-rewrite', first(q3) === 'score-rewrite', first(q3));
  check('匹配字段标注 title', q3.results[0].matched.includes('title'), q3.results[0].matched);

  const q4 = search.searchLocal('Ken Burns');
  check('英文描述片段也能命中', q4.total === 1 && first(q4) === 'mv-image-pipeline',
    [q4.total, names(q4)]);

  console.log('\n=== 5. 子序列（缩写）要够紧 ===');
  const q5 = search.searchLocal('mvi');
  check('mvi 命中 mv-image-pipeline', names(q5).includes('mv-image-pipeline'), names(q5));
  check('mvi 不把 comfyui 系列捞进来', !names(q5).includes('comfyui'), names(q5));
  check('mvi 结果数不超过 2', q5.total <= 2, q5.total);

  // scr：s-c-r 在 score 里连续命中，是真实会出现的缩写
  const q6 = search.searchLocal('scr');
  check('scr 命中 score-rewrite', names(q6).includes('score-rewrite'), names(q6));

  // 3 字符跨太远的缩写会被密度阈值挡掉 —— 这是刻意的：
  // "srw" 在 score-rewrite 里跨度 9（s0 r3 w8），密度 0.33，
  // 与 "mvi" 误命 comfyui 是一类噪音，不能为了迁就它把阈值放松。
  const q6b = search.searchLocal('srw');
  check('跨度太散的缩写不入选（防噪音）', !names(q6b).includes('score-rewrite'), names(q6b));

  console.log('\n=== 6. 多词 AND ===');
  const q7 = search.searchLocal('comfy 模型');
  check('两个词都要命中', q7.total === 1 && first(q7) === 'comfyui-model-setup',
    [q7.total, names(q7)]);
  check('不是 partial', q7.partial === false);

  const q8 = search.searchLocal('乐谱 MusicXML');
  check('同一条目跨字段命中也算', q8.total >= 1 && names(q8).includes('score-rewrite'),
    names(q8));

  console.log('\n=== 7. AND 无结果时退回 OR ===');
  // comfyui 的描述里没有「乐谱」，score-rewrite 里没有 comfy → AND 必空
  const q9 = search.searchLocal('comfy 乐谱');
  check('退回 OR 后仍有结果', q9.total > 0, q9.total);
  check('标记 partial=true', q9.partial === true, q9.partial);
  check('结果覆盖两个词各自的对象',
    names(q9).includes('comfyui') && names(q9).includes('score-rewrite'), names(q9));

  console.log('\n=== 8. 无结果 ===');
  const q10 = search.searchLocal('nonexistent-xyz-123');
  check('返回 0 条', q10.total === 0, q10.total);
  check('结果数组为空', q10.results.length === 0);

  console.log('\n=== 9. limit 生效 ===');
  const q11 = search.searchLocal('', { limit: 2 });
  check('limit=2 只返回 2 条', q11.results.length === 2, q11.results.length);
  check('但 total 仍是真实总数', q11.total === 5, q11.total);

  console.log('\n=== 10. 已装状态影响排序 ===');
  // 给 comfyui-model-setup 写一条安装记录，它应当排在 comfyui 前面
  const rec = {
    version: 1,
    skills: {
      'comfyui-model-setup': {
        name: 'comfyui-model-setup', title: 'ComfyUI 模型安装',
        source: { type: 'local', input: null },
        version: '1.0.0', commit: null,
        installedAt: new Date().toISOString(),
        bytes: 100, files: 1, safety: { high: 0, medium: 0, info: 0 },
      },
    },
  };
  fs.writeFileSync(INS_FILE, JSON.stringify(rec, null, 2), 'utf8');
  search.invalidate();
  const q12 = search.searchLocal('comfyui');
  check('已装的排在前面', first(q12) === 'comfyui-model-setup', first(q12));
  check('状态为 installed', q12.results[0].status === 'installed', q12.results[0].status);

  console.log('\n=== 11. 索引缓存与失效 ===');
  const a = search.searchLocal('comfyui', { force: true });
  const b = search.searchLocal('comfyui');
  check('第二次命中缓存', b.cached === true, b.cached);
  makeSkill(CANON, 'comfyui-extra-skill', { title: '新增的', description: 'x' });
  const c = search.searchLocal('comfyui');   // 缓存还在有效期内
  check('缓存有效期内看不到新技能', c.total === a.total, [c.total, a.total]);
  const d = search.searchLocal('comfyui', { force: true });
  check('force 后能看到新技能', d.total === a.total + 1, [d.total, a.total]);
  search.invalidate();
  const e = search.searchLocal('comfyui');
  check('invalidate 后立刻刷新', e.total === a.total + 1, e.total);

  console.log('\n=== 12. 打分单调性 ===');
  const s1 = search.searchLocal('comfyui').results[0].score;
  const s2 = search.searchLocal('comfy').results[0].score;
  check('完全相等的分数不低于前缀', s1 >= s2, [s1, s2]);

} catch (e) {
  fail += 1;
  console.error('\n✗ 测试异常：', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e);
} finally {
  console.log('\n=== 13. 还原环境 ===');
  restoreFiles();
  settings.setCanonRoot(OLD_CANON);
  core.clearCanonCache();
  search.invalidate();
  rmrf(SANDBOX);
  check('真源地址已还原', settings.getCanonRoot() === OLD_CANON);

  console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}
