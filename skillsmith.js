#!/usr/bin/env node
/**
 * Skillsmith 命令行入口。
 *
 * 界面是主路径，这个 CLI 是给三种场景用的：
 *   1. 脚本化 —— 一次装一批技能，或者写进 dotfiles 的初始化脚本
 *   2. 排障   —— 界面显示不对时，用它能直接看到后端到底拿到了什么
 *   3. CI     —— 无图形环境下验证安装链路
 *
 * 刻意保持零依赖：不用 commander/yargs，几十行的参数解析不值得引一个包。
 *
 * 用法：
 *   node skillsmith.js install <来源> [--subdir x] [--no-enable] [--overwrite] [--yes]
 *   node skillsmith.js preview <来源> [--subdir x]
 *   node skillsmith.js list
 *   node skillsmith.js remove <名字> [--yes]
 *   node skillsmith.js adopt <名字>
 */

'use strict';

const readline = require('readline');
const installer = require('./installer.js');

// ---------------------------------------------------------------- 参数解析

/**
 * 极简参数解析：第一个非 - 开头的参数是命令，第二个是它的参数，
 * 其余 `--key` 进 flags，`--key value` 进 opts。
 */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const flags = new Set();

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    // 后面还有值且不是另一个开关 → 当作这个开关的值
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { positional, opts, flags };
}

// ---------------------------------------------------------------- 输出

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const green = (s) => c('32', s);

const LEVEL_LABEL = {
  high: (s) => red(`[高危] ${s}`),
  medium: (s) => yellow(`[留意] ${s}`),
  info: (s) => dim(`[提示] ${s}`),
};

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 打印预览报告。这是用户做决定前唯一该看的东西。 */
function printPreview(r) {
  console.log('');
  console.log(bold(`  ${r.title}`) + (r.title !== r.name ? dim(`  (${r.name})`) : ''));
  if (r.description) console.log(`  ${r.description}`);
  console.log('');
  console.log(`  版本    ${r.version || dim('未声明')}`);
  console.log(`  许可    ${r.license || dim('未声明')}`);
  console.log(`  作者    ${r.author || dim('未声明')}`);
  console.log(`  来源    ${r.source.label}${r.relPath !== '.' ? dim(`  ·  子目录 ${r.relPath}`) : ''}`);
  if (r.commit) console.log(`  提交    ${r.commit.slice(0, 10)}`);
  console.log(`  体积    ${r.size.files} 个文件 / ${human(r.size.bytes)}`);
  console.log(`  上下文  ${dim('约')} ${r.tokens} token ${dim('（按入口正文粗估）')}`);
  console.log('');

  // 安全结论放在最显眼的位置：这是用户决定要不要装的主要依据
  if (r.safety.summary.high > 0) {
    console.log(`  ${red(bold('⚠ ' + r.safety.verdict))}`);
  } else if (r.safety.summary.medium > 0) {
    console.log(`  ${yellow(r.safety.verdict)}`);
  } else {
    console.log(`  ${green(r.safety.verdict)}`);
  }

  const shown = r.safety.findings.filter((f) => f.level !== 'info');
  if (shown.length) {
    console.log('');
    for (const f of shown) {
      console.log(`    ${LEVEL_LABEL[f.level](f.rule)}`);
      console.log(`      ${dim(f.file)}${f.line ? dim(':' + f.line) : ''}  ${f.evidence}`);
      console.log(`      ${dim(f.why)}`);
    }
  }
  const infoCount = r.safety.findings.filter((f) => f.level === 'info').length;
  if (infoCount) console.log(`\n    ${dim(`${infoCount} 条普通提示（网络请求等）已略`)}`);

  if (r.safety.executables.length) {
    console.log('');
    console.log(`    ${red('包含可执行文件：')}${r.safety.executables.join('、')}`);
  }

  if (r.problems.length) {
    console.log('');
    for (const p of r.problems) console.log(`    ${yellow('·')} ${p.message}`);
  }

  console.log('');
  if (r.conflict.exists) {
    console.log(`  ${yellow('真源里已经有同名技能')}：${r.conflict.targetDir}`);
    if (r.conflict.previouslyInstalled) {
      console.log(dim(`  当前安装于 ${r.conflict.previousInstalledAt}`
        + `，版本 ${r.conflict.previousVersion || '未知'}`));
    }
  }
}

// ---------------------------------------------------------------- 确认

function ask(question) {
  // 非交互环境（管道、CI）不能等输入，直接按否处理，由调用方决定要不要 --yes
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

// ---------------------------------------------------------------- 命令

async function cmdPreview(src, opts) {
  const r = await installer.preview(src, { subdir: opts.subdir });
  printPreview(r);
}

async function cmdInstall(src, opts, flags) {
  // 先预览：安装前的尽调不能省，即使用户加了 --yes
  const r = await installer.preview(src, { subdir: opts.subdir });
  printPreview(r);

  if (!flags.has('yes')) {
    const ok = await ask(`  确认安装「${r.name}」到真源？[y/N] `);
    if (!ok) {
      console.log(dim('  已取消，未做任何改动'));
      return;
    }
  }

  const result = await installer.install(src, {
    subdir: opts.subdir,
    overwrite: flags.has('overwrite'),
    expectedCommit: r.commit,      // 保证装的就是刚才看到的那一版
    enableAgents: flags.has('no-enable') ? false : undefined,
  });

  console.log('');
  console.log(green(`  ✓ 已安装：${result.name}`));
  console.log(`    ${dim('位置')} ${result.targetDir}`);
  if (result.enabled.length) {
    console.log(`    ${dim('已在')} ${result.enabled.length} 个端生效：${result.enabled.join('、')}`);
  } else if (flags.has('no-enable')) {
    console.log(dim('    未给任何端建立链接（--no-enable）'));
  }
  for (const w of result.warnings) console.log(`    ${yellow('!')} ${w}`);
  console.log('');
}

function cmdList() {
  const list = installer.listInstalled();
  if (!list.length) {
    console.log(dim('  真源里还没有技能'));
    return;
  }

  console.log('');
  const missing = list.filter((x) => x.status === 'missing');
  const unmanaged = list.filter((x) => x.status === 'unmanaged');

  for (const it of list) {
    const tag = it.status === 'missing' ? red('记录残留')
      : it.status === 'unmanaged' ? yellow('手工放入') : green('已安装');
    console.log(`  ${tag}  ${bold(it.name)}  ${dim(it.version || '无版本')}`);
    if (it.source) {
      console.log(`          ${dim('来源')} ${it.source.type}${it.source.input ? ` · ${it.source.input}` : ''}`);
    }
    if (it.current) {
      console.log(`          ${dim('当前')} ${it.current.files} 文件 / ${human(it.current.bytes)}`);
    }
  }

  console.log('');
  if (missing.length) {
    console.log(dim(`  ${missing.length} 条记录对应的目录已不在真源里，可用 remove 清理`));
  }
  if (unmanaged.length) {
    console.log(dim(`  ${unmanaged.length} 个技能没有安装记录，可用 adopt 纳管`));
  }
  console.log('');
}

async function cmdRemove(name, flags) {
  if (!flags.has('yes')) {
    const ok = await ask(`  确认卸载「${name}」？会删除真源目录并摘掉各端链接。[y/N] `);
    if (!ok) {
      console.log(dim('  已取消'));
      return;
    }
  }
  const r = installer.uninstall(name);
  console.log('');
  console.log(green(`  ✓ 已卸载：${r.name}`));
  if (r.detached.length) console.log(`    ${dim('已从')} ${r.detached.join('、')} ${dim('摘除')}`);
  for (const w of r.warnings) console.log(`    ${yellow('!')} ${w}`);
  console.log('');
}

function cmdAdopt(name) {
  const r = installer.adopt(name);
  console.log(green(`  ✓ 已纳管：${r.name}`));
  console.log(dim('    之后可以在 list 里看到它，也能记录来源'));
}

// ---------------------------------------------------------------- 入口

const USAGE = `
${bold('Skillsmith')} — 智能体技能管理软件

  ${bold('用法')}
    node skillsmith.js ${green('<命令>')} [参数]

  ${bold('命令')}
    ${green('preview')} <来源>        查看一个技能：清单、体积、上下文占用、安全扫描（不写盘）
    ${green('install')} <来源>        安装到真源，并给各端建立链接
    ${green('list')}                 列出已安装技能与来源
    ${green('remove')} <名字>        卸载：删真源目录 + 摘各端链接
    ${green('adopt')} <名字>         把手工放进真源的技能纳入管理

  ${bold('来源写法')}
    本地文件夹      ./my-skill   或   C:\\path\\to\\skill
    简写仓库        owner/repo
    仓库地址        https://github.com/owner/repo
    指定子目录      owner/repo#skills/foo
    完整路径        https://github.com/owner/repo/tree/main/skills/foo

  ${bold('选项')}
    --subdir <路径>   指定技能在仓库里的子目录
    --overwrite       真源已有同名技能时覆盖
    --no-enable       只放进真源，不给任何端建立链接
    --yes             跳过确认（脚本用）
`;

(async () => {
  const { positional, opts, flags } = parseArgs(process.argv.slice(2));
  const [cmd, arg] = positional;

  if (!cmd || flags.has('help') || cmd === 'help') {
    console.log(USAGE);
    return;
  }

  try {
    switch (cmd) {
      case 'preview':
        if (!arg) throw new Error('preview 需要一个来源');
        await cmdPreview(arg, opts);
        break;
      case 'install':
        if (!arg) throw new Error('install 需要一个来源');
        await cmdInstall(arg, opts, flags);
        break;
      case 'list':
        cmdList();
        break;
      case 'remove':
        if (!arg) throw new Error('remove 需要一个技能名');
        await cmdRemove(arg, flags);
        break;
      case 'adopt':
        if (!arg) throw new Error('adopt 需要一个技能名');
        cmdAdopt(arg);
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error(`\n  ${red('✗')} ${e.message}\n`);
    process.exitCode = 1;
  }
})();
