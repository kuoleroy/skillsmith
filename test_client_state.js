/**
 * client-state.js 的离线测试
 * ============================================================================
 *
 *  测试原则：
 *    1. 全程用临时目录，绝不碰用户真实的客户端配置
 *    2. 每种账本格式都测「读 → 写 → 再读」闭环，验证写入结果真的能被读回
 *    3. 重点覆盖「危险路径」：文件损坏时拒绝覆盖、已一致时不写盘、
 *       启用时清理残留 key（写漏一个就会「删了没生效」）
 *
 *  运行：node test_client_state.js
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const cs = require('./client-state.js');

// ---------------------------------------------------------------- 测试框架

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail += 1;
    failures.push({ name, err: e });
    console.log('  ✗ ' + name);
    console.log('      ' + e.message);
  }
}

function section(t) {
  console.log('\n=== ' + t + ' ===');
}

// ---------------------------------------------------------------- 沙箱

const SANDBOX = path.join(os.tmpdir(), 'skillsmith-ledger-test-' + process.pid);

function sandboxFile(name, content) {
  const p = path.join(SANDBOX, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (content !== undefined) fs.writeFileSync(p, content, 'utf8');
  return p;
}

function cleanup() {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 1. 候选 key

section('1. candidateKeys：账本 key 解析');

check('frontmatter name 优先', () => {
  const keys = cs.candidateKeys({ name: 'score-rewrite', title: '乐谱改写' }, { name: 'score-rewrite' });
  assert.deepStrictEqual(keys, ['score-rewrite', '乐谱改写']);
});

check('没有 frontmatter name 时用 name_cn + 目录名', () => {
  const keys = cs.candidateKeys({ name: 'dir-name', title: '中文名' }, {});
  assert.deepStrictEqual(keys, ['中文名', 'dir-name']);
});

check('去重', () => {
  const keys = cs.candidateKeys({ name: 'same', title: 'same' }, { name: 'same' });
  assert.deepStrictEqual(keys, ['same']);
});

// ---------------------------------------------------------------- 2. kv_lines

section('2. kv_lines（CodeArts 风格）');

const kvCfg = (file) => ({ statusFile: file, statusKind: 'kv_lines' });

check('读到 name=false 判为禁用', () => {
  const f = sandboxFile('kv/a.txt', 'foo=true\nbar=false\n');
  assert.strictEqual(cs.readLedger(kvCfg(f), ['bar']).disabled, true);
});

check('读到 name=true 判为启用', () => {
  const f = sandboxFile('kv/a.txt', 'foo=true\nbar=false\n');
  assert.strictEqual(cs.readLedger(kvCfg(f), ['foo']).disabled, false);
});

check('不存在的 key 视为启用', () => {
  const f = sandboxFile('kv/a.txt', 'foo=true\n');
  assert.strictEqual(cs.readLedger(kvCfg(f), ['nope']).disabled, false);
});

check('写禁用后能读回 true', () => {
  const f = sandboxFile('kv/b.txt', 'foo=true\n');
  const r = cs.writeLedger(kvCfg(f), ['foo'], true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(cs.readLedger(kvCfg(f), ['foo']).disabled, true);
});

check('写启用后能读回 false', () => {
  const f = sandboxFile('kv/b.txt', 'foo=true\n');
  cs.writeLedger(kvCfg(f), ['foo'], true);
  cs.writeLedger(kvCfg(f), ['foo'], false);
  assert.strictEqual(cs.readLedger(kvCfg(f), ['foo']).disabled, false);
});

check('保留文件里的其它行', () => {
  const f = sandboxFile('kv/c.txt', 'alpha=true\nbeta=false\n');
  cs.writeLedger(kvCfg(f), ['gamma'], true);
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes('alpha=true'), 'alpha 行应保留');
  assert.ok(text.includes('beta=false'), 'beta 行应保留');
  assert.ok(text.includes('gamma=false'), 'gamma 应被追加');
});

check('已一致时不写盘（mtime 不变）', () => {
  const f = sandboxFile('kv/d.txt', 'foo=false\n');
  const before = fs.statSync(f).mtimeMs;
  const r = cs.writeLedger(kvCfg(f), ['foo'], true);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(fs.statSync(f).mtimeMs, before);
});

// ---------------------------------------------------------------- 3. json_array

section('3. json_array（Trae 风格）');

const arrCfg = (file) => ({
  statusFile: file, statusKind: 'json_array', statusKey: 'disabledSkills',
});

check('数组里出现即禁用', () => {
  const f = sandboxFile('arr/a.json', JSON.stringify({ disabledSkills: ['foo'] }));
  assert.strictEqual(cs.readLedger(arrCfg(f), ['foo']).disabled, true);
  assert.strictEqual(cs.readLedger(arrCfg(f), ['bar']).disabled, false);
});

check('写禁用后进数组', () => {
  const f = sandboxFile('arr/b.json', JSON.stringify({ disabledSkills: [] }));
  cs.writeLedger(arrCfg(f), ['foo'], true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(d.disabledSkills, ['foo']);
});

check('写启用后出数组', () => {
  const f = sandboxFile('arr/c.json', JSON.stringify({ disabledSkills: ['foo', 'bar'] }));
  cs.writeLedger(arrCfg(f), ['foo'], false);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(d.disabledSkills, ['bar']);
});

check('保留 JSON 里的其它字段', () => {
  const f = sandboxFile('arr/d.json', JSON.stringify({
    disabledSkills: [], builtinSkillStatus: { x: false }, extra: 42,
  }));
  cs.writeLedger(arrCfg(f), ['foo'], true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(d.builtinSkillStatus, { x: false });
  assert.strictEqual(d.extra, 42);
});

check('大小写不同也能识别', () => {
  const f = sandboxFile('arr/e.json', JSON.stringify({ disabledSkills: ['FooBar'] }));
  assert.strictEqual(cs.readLedger(arrCfg(f), ['foobar']).disabled, true);
});

check('文件损坏时拒绝写入', () => {
  const f = sandboxFile('arr/broken.json', '{ this is not json');
  let threw = false;
  try {
    cs.writeLedger(arrCfg(f), ['foo'], true);
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, true, '应当抛错而不是覆盖');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ this is not json', '原内容必须原样保留');
});

// ---------------------------------------------------------------- 4. json_map

section('4. json_map（WorkBuddy 风格）');

const mapCfg = (file) => ({
  statusFile: file,
  statusKind: 'json_map',
  statusKey: 'skillOverrides',
  offValue: 'off',
  offValues: ['user-invocable-only', 'off', 'name-only'],
});

check('user-invocable-only 判为禁用', () => {
  const f = sandboxFile('map/a.json', JSON.stringify({
    skillOverrides: { foo: 'user-invocable-only' },
  }));
  assert.strictEqual(cs.readLedger(mapCfg(f), ['foo']).disabled, true);
});

check('off 判为禁用', () => {
  const f = sandboxFile('map/a.json', JSON.stringify({ skillOverrides: { foo: 'off' } }));
  assert.strictEqual(cs.readLedger(mapCfg(f), ['foo']).disabled, true);
});

check('没有记录视为启用', () => {
  const f = sandboxFile('map/a.json', JSON.stringify({ skillOverrides: {} }));
  assert.strictEqual(cs.readLedger(mapCfg(f), ['foo']).disabled, false);
});

check('写禁用写入 off（完全关闭，而非半关）', () => {
  const f = sandboxFile('map/b.json', JSON.stringify({ skillOverrides: {} }));
  cs.writeLedger(mapCfg(f), ['foo'], true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(d.skillOverrides.foo, 'off');
});

check('已存在 user-invocable-only 时就地改成 off（不新增 key）', () => {
  const f = sandboxFile('map/c.json', JSON.stringify({
    skillOverrides: { foo: 'user-invocable-only' },
  }));
  cs.writeLedger(mapCfg(f), ['foo'], true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(Object.keys(d.skillOverrides), ['foo'], '不能变成两个 key');
  assert.strictEqual(d.skillOverrides.foo, 'off');
});

check('启用 = 删除记录（不是写 true）', () => {
  const f = sandboxFile('map/d.json', JSON.stringify({ skillOverrides: { foo: 'off' } }));
  cs.writeLedger(mapCfg(f), ['foo'], false);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual('foo' in d.skillOverrides, false);
});

check('启用时清掉候选 key 的全部残留', () => {
  // 历史数据里同一个技能可能存了两种 key（目录名 + 中文名）
  const f = sandboxFile('map/e.json', JSON.stringify({
    skillOverrides: { 'score-rewrite': 'off', '乐谱改写': 'user-invocable-only', other: 'off' },
  }));
  cs.writeLedger(mapCfg(f), ['score-rewrite', '乐谱改写'], false);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual('score-rewrite' in d.skillOverrides, false);
  assert.strictEqual('乐谱改写' in d.skillOverrides, false);
  assert.strictEqual(d.skillOverrides.other, 'off', '别的技能不能被动到');
});

check('保留 settings.json 的其它顶层字段', () => {
  const f = sandboxFile('map/f.json', JSON.stringify({
    skillOverrides: {},
    enabledPlugins: { a: true },
    chatSendBehavior: 'enter',
  }));
  cs.writeLedger(mapCfg(f), ['foo'], true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(d.enabledPlugins, { a: true });
  assert.strictEqual(d.chatSendBehavior, 'enter');
});

check('文件损坏时拒绝写入', () => {
  const f = sandboxFile('map/broken.json', 'not json at all');
  let threw = false;
  try {
    cs.writeLedger(mapCfg(f), ['foo'], true);
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, true);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'not json at all');
});

check('文件不存在时创建', () => {
  const f = path.join(SANDBOX, 'map', 'new.json');
  const r = cs.writeLedger(mapCfg(f), ['foo'], true);
  assert.strictEqual(r.changed, true);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(d.skillOverrides.foo, 'off');
});

// ---------------------------------------------------------------- 5. 边界

section('5. 边界情况');

check('没有账本的端直接跳过', () => {
  const r = cs.writeLedger({ dir: '/tmp/x' }, ['foo'], true);
  assert.strictEqual(r.changed, false);
  assert.ok(r.detail.includes('没有独立账本'));
});

check('未知账本格式不崩', () => {
  const f = sandboxFile('edge/x.json', '{}');
  const r = cs.writeLedger({ statusFile: f, statusKind: 'weird' }, ['foo'], true);
  assert.strictEqual(r.changed, false);
});

check('readLedger 对不存在的文件返回 disabled=false', () => {
  const r = cs.readLedger(kvCfg(path.join(SANDBOX, 'nope.txt')), ['foo']);
  assert.strictEqual(r.disabled, false);
});

check('readLedger 对损坏 JSON 不抛错（读要宽容，写才严格）', () => {
  const f = sandboxFile('edge/broken.json', '{{{');
  const r = cs.readLedger(arrCfg(f), ['foo']);
  assert.strictEqual(r.disabled, false);
});

// ---------------------------------------------------------------- 汇总

cleanup();

console.log('');
console.log('─'.repeat(50));
console.log(`结果：${pass} 通过, ${fail} 失败`);
if (fail) {
  console.log('');
  for (const f of failures) {
    console.log('失败：' + f.name);
    console.log('  ' + f.err.message);
  }
}
console.log('─'.repeat(50));

process.exit(fail ? 1 : 0);
