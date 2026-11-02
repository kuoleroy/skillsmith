/**
 * 技能安装与搜索面板。
 *
 * ============================================================================
 * 为什么是「一个弹窗 + 两个 tab」
 * ============================================================================
 * 用户要的是「像装软件一样装技能」。装软件的界面范式很固定：
 * 搜索框 + 结果列表 + 详情 + 一个安装按钮。照这个来，不用发明新交互。
 *
 * 本地 / 在线两个 tab 是刻意的：本地搜索现在能用（搜真源里已有的），
 * 在线搜索留空但界面先占住位置 —— 这样用户知道"以后会在这搜全网"，
 * 而不是以为这软件只能管本地。
 *
 * 在线 tab 不放假按钮。假按钮点下去没反应比没有更糟，所以就是明确的
 * 「建设中」+ 一句说明它将来怎么做。
 *
 * ============================================================================
 * 与后端的分工
 * ============================================================================
 * 前端不做任何判断，全部问后端：
 *   GET  /api/search?q=          搜什么、怎么排序，后端定
 *   POST /api/install/preview    装之前能看到什么，后端定
 * 这样界面换掉也不影响逻辑，反过来逻辑改了界面不用跟着改。
 */

(() => {
  'use strict';

  // ============================================================ 样式

  const CSS = `
.sw-install-btn { width:100%; margin-top:8px; }

/* ---- 弹窗骨架（与 agent-manager 保持一致） ---- */
.sw-modal-backdrop {
  position:fixed; inset:0; z-index:9000;
  background:rgba(8,10,14,.72); backdrop-filter:blur(3px);
  display:flex; align-items:center; justify-content:center;
  animation:sw-fade .16s ease-out;
}
@keyframes sw-fade { from { opacity:0 } to { opacity:1 } }
.sw-modal {
  width:min(860px, 92vw); height:min(680px, 88vh);
  background:#12141a; border:1px solid #262c37; border-radius:14px;
  box-shadow:0 24px 70px rgba(0,0,0,.6);
  display:flex; flex-direction:column; overflow:hidden;
  animation:sw-pop .18s cubic-bezier(.2,.9,.3,1);
}
@keyframes sw-pop { from { transform:scale(.97) translateY(6px); opacity:0 } to { transform:none; opacity:1 } }
.sw-modal-head {
  display:flex; align-items:flex-start; justify-content:space-between;
  padding:16px 20px 12px; border-bottom:1px solid #21262f; flex:0 0 auto;
}
.sw-modal-head h2 { margin:0; font-size:15px; font-weight:600; color:#eef1f6; letter-spacing:-.01em; }
.sw-modal-head p  { margin:4px 0 0; font-size:11.5px; color:#6b7484; }

.sw-btn {
  height:30px; padding:0 12px; border-radius:8px; cursor:pointer;
  background:#1b1f27; border:1px solid #2b313d; color:#9aa3b2;
  font-size:12px; font-family:inherit; transition:.15s;
  display:inline-flex; align-items:center; gap:5px;
}
.sw-btn:hover { background:#252a34; color:#eef1f6; border-color:#3a4252; }
.sw-btn.primary { background:#f0a34a; border-color:#f0a34a; color:#14161b; font-weight:600; }
.sw-btn.primary:hover { background:#ffb35c; border-color:#ffb35c; }
.sw-btn.danger:hover { background:rgba(229,101,101,.12); border-color:rgba(229,101,101,.45); color:#e56565; }
.sw-btn.ghost { background:transparent; border-color:transparent; }
.sw-btn.ghost:hover { background:#252a34; }
.sw-btn.icon { width:30px; height:30px; padding:0; justify-content:center; }
.sw-btn:disabled { opacity:.45; cursor:not-allowed; }

/* ---- tab ---- */
.sw-tabs { display:flex; gap:2px; padding:10px 20px 0; flex:0 0 auto; }
.sw-tab {
  padding:7px 14px; border:none; cursor:pointer; background:transparent;
  color:#6b7484; font-size:12.5px; font-family:inherit; font-weight:500;
  border-bottom:2px solid transparent; transition:.15s;
  display:inline-flex; align-items:center; gap:6px;
}
.sw-tab:hover { color:#9aa3b2; }
.sw-tab.on { color:#f0a34a; border-bottom-color:#f0a34a; }
.sw-tab .dot { width:5px; height:5px; border-radius:50%; background:#4a5260; }
.sw-tab.on .dot { background:#f0a34a; }

/* ---- 主体 ---- */
.sw-body { flex:1; min-height:0; display:flex; flex-direction:column; }
.sw-searchwrap { padding:12px 20px 10px; flex:0 0 auto; }
.sw-search {
  width:100%; height:36px; padding:0 12px 0 34px; box-sizing:border-box;
  background:#0e1014 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%236b7484' stroke-width='2.2' stroke-linecap='round'><circle cx='11' cy='11' r='7'/><path d='M20 20l-4-4'/></svg>") no-repeat 12px center;
  border:1px solid #2b313d; border-radius:9px; color:#eef1f6;
  font-size:13px; font-family:inherit; outline:none; transition:.15s;
}
.sw-search:focus { border-color:#f0a34a; background-color:#111318; }
.sw-search::placeholder { color:#5d6575; }
.sw-search-meta {
  display:flex; align-items:center; justify-content:space-between;
  margin-top:7px; font-size:11px; color:#5d6575;
}
.sw-partial { color:#e0a34a; }

/* ---- 列表 ---- */
.sw-list { flex:1; min-height:0; overflow-y:auto; padding:0 20px 8px; }
.sw-list::-webkit-scrollbar { width:9px; }
.sw-list::-webkit-scrollbar-thumb { background:#2b313d; border-radius:5px; border:2px solid #12141a; }

.sw-item {
  border:1px solid #232833; border-radius:10px; padding:11px 13px;
  margin-bottom:8px; cursor:pointer; transition:.13s; background:#15171e;
}
.sw-item:hover { border-color:#3a4252; background:#181b23; }
.sw-item.open { border-color:#f0a34a55; background:#181a20; }

.sw-item-top { display:flex; align-items:center; gap:8px; }
.sw-item-name { font-size:13px; font-weight:600; color:#eef1f6; letter-spacing:-.005em; }
.sw-item-title { font-size:11.5px; color:#6b7484; }
.sw-item-spacer { flex:1; }
.sw-item-desc {
  margin-top:5px; font-size:11.5px; line-height:1.6; color:#8b94a4;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
  overflow:hidden;
}
.sw-item-meta {
  margin-top:6px; display:flex; gap:12px; flex-wrap:wrap;
  font-size:10.5px; color:#5d6575;
  font-family:'JetBrains Mono',Consolas,monospace;
}

.sw-tagx {
  font-size:9.5px; padding:2px 7px; border-radius:5px; font-weight:600;
  letter-spacing:.02em; white-space:nowrap;
}
.sw-tagx.installed { background:rgba(84,180,120,.14); color:#63c48c; border:1px solid rgba(84,180,120,.28); }
.sw-tagx.unmanaged { background:rgba(240,163,74,.13); color:#e0a34a; border:1px solid rgba(240,163,74,.26); }
.sw-tagx.missing   { background:rgba(229,101,101,.13); color:#e56565; border:1px solid rgba(229,101,101,.26); }

/* ---- 详情（展开区） ---- */
.sw-detail {
  margin-top:10px; padding-top:10px; border-top:1px dashed #2a303b;
  font-size:11.5px; color:#8b94a4; line-height:1.7;
}
.sw-detail dl { margin:0; display:grid; grid-template-columns:74px 1fr; gap:4px 10px; }
.sw-detail dt { color:#5d6575; }
.sw-detail dd { margin:0; color:#9aa3b2; word-break:break-all; }
.sw-detail-acts { margin-top:10px; display:flex; gap:8px; }

/* ---- 安全发现 ---- */
.sw-find { margin-top:9px; border-radius:8px; overflow:hidden; border:1px solid #2a303b; }
.sw-find-row { display:flex; gap:9px; padding:8px 10px; border-bottom:1px solid #21262f; }
.sw-find-row:last-child { border-bottom:none; }
.sw-find-lv {
  flex:0 0 auto; font-size:9.5px; font-weight:700; padding:2px 6px; border-radius:4px;
  height:16px; line-height:16px; letter-spacing:.03em;
}
.sw-find-lv.high   { background:rgba(229,101,101,.16); color:#ff8f8f; }
.sw-find-lv.medium { background:rgba(240,163,74,.15); color:#e0a34a; }
.sw-find-lv.info   { background:#21262f; color:#7b8494; }
.sw-find-body { flex:1; min-width:0; }
.sw-find-rule { font-size:11px; color:#c8cfdb; font-weight:600; }
.sw-find-why { font-size:10.5px; color:#6b7484; margin-top:2px; }
.sw-find-ev {
  margin-top:4px; font-size:10px; color:#5d6575;
  font-family:'JetBrains Mono',Consolas,monospace;
  white-space:pre-wrap; word-break:break-all;
}

/* ---- 空状态 / 占位 ---- */
.sw-empty {
  padding:34px 20px; text-align:center; color:#5d6575; font-size:12px; line-height:1.9;
}
.sw-empty b { display:block; color:#8b94a4; font-size:13px; margin-bottom:6px; font-weight:600; }

.sw-soon { padding:44px 34px; text-align:center; }
.sw-soon h3 { margin:0 0 8px; font-size:15px; color:#9aa3b2; font-weight:600; }
.sw-soon p { margin:0 auto; max-width:430px; font-size:12px; line-height:1.8; color:#5d6575; }
.sw-soon .badge {
  display:inline-block; margin-bottom:14px; padding:3px 10px; border-radius:20px;
  font-size:10.5px; font-weight:600; letter-spacing:.04em;
  background:rgba(240,163,74,.1); color:#e0a34a; border:1px solid rgba(240,163,74,.24);
}
.sw-soon .plan {
  margin:22px auto 0; max-width:470px; text-align:left;
  border:1px solid #232833; border-radius:10px; padding:13px 15px;
  font-size:11.5px; line-height:1.9; color:#6b7484;
}
.sw-soon .plan code {
  font-family:'JetBrains Mono',Consolas,monospace;
  background:#0e1014; padding:1px 5px; border-radius:4px; color:#9aa3b2;
}

/* ---- 底部安装区 ---- */
.sw-foot {
  flex:0 0 auto; border-top:1px solid #21262f; padding:11px 20px 13px;
  background:#101216;
}
.sw-foot-label {
  font-size:10.5px; color:#5d6575; font-weight:600;
  letter-spacing:.05em; text-transform:uppercase; margin-bottom:7px;
}
.sw-foot-row { display:flex; gap:8px; align-items:center; }
.sw-foot-input {
  flex:1; height:32px; padding:0 11px; box-sizing:border-box;
  background:#0e1014; border:1px solid #2b313d; border-radius:8px;
  color:#eef1f6; font-size:12px; font-family:'JetBrains Mono',Consolas,monospace;
  outline:none; transition:.15s;
}
.sw-foot-input:focus { border-color:#f0a34a; }
.sw-foot-input::placeholder { color:#4d5462; font-family:inherit; }
.sw-foot-hint { margin-top:6px; font-size:10.5px; color:#4d5462; line-height:1.6; }

/* ---- toast ---- */
.sw-toast {
  position:fixed; left:50%; bottom:34px; transform:translateX(-50%);
  z-index:9500; padding:10px 16px; border-radius:9px; font-size:12.5px;
  background:#1b1f27; border:1px solid #2b313d; color:#c8cfdb;
  box-shadow:0 10px 30px rgba(0,0,0,.5); animation:sw-fade .16s;
}
.sw-toast.err { border-color:rgba(229,101,101,.5); color:#ff9a9a; }
.sw-toast.ok  { border-color:rgba(240,163,74,.5); color:#ffc98a; }

.sw-busy { opacity:.55; pointer-events:none; }
`;

  // ============================================================ 工具

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function toast(msg, kind) {
    const old = document.querySelector('.sw-toast');
    if (old) old.remove();
    const t = el('div', 'sw-toast ' + (kind || ''), msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  function human(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  async function getJson(url) {
    const r = await fetch(url);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || 'HTTP ' + r.status);
    return d;
  }

  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || 'HTTP ' + r.status);
    return d;
  }

  // ============================================================ 状态

  let modal = null;
  let currentTab = 'local';     // local | online
  let searchTimer = null;
  let lastQuery = '';
  let lastResult = null;        // 最近一次搜索结果，切 tab 回来时复用
  let preview = null;           // 当前展开的预览（来源安装时）
  let listEl = null;
  let metaEl = null;
  let searchInput = null;
  let footEl = null;

  const STATUS_LABEL = {
    installed: '已安装',
    unmanaged: '手工放入',
    missing: '记录残留',
  };

  function closeModal() {
    if (modal) modal.remove();
    modal = null;
    listEl = null;
    metaEl = null;
    searchInput = null;
    footEl = null;
    preview = null;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      // 有预览时先退预览，再按一次才关窗 —— 避免手滑关掉
      if (preview) {
        exitPreview();
        return;
      }
      closeModal();
    }
  }

  // ============================================================ 弹窗

  function openModal() {
    if (modal) return;
    modal = el('div', 'sw-modal-backdrop');
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeModal();
    });
    document.body.appendChild(modal);
    document.addEventListener('keydown', onKey);
    modal.appendChild(buildPanel());
    refresh();
    // 打开就能直接打字，省一次点击
    setTimeout(() => searchInput && searchInput.focus(), 60);
  }

  function buildPanel() {
    const panel = el('div', 'sw-modal');

    // ---- 头 ----
    const head = el('div', 'sw-modal-head');
    const h = el('div');
    h.appendChild(el('h2', null, '安装技能'));
    h.appendChild(el('p', null, '从本地目录或 git 仓库装进真源。装之前会先给你看清里面是什么。'));
    head.appendChild(h);
    const closeBtn = el('button', 'sw-btn icon ghost', '✕');
    closeBtn.title = '关闭 (Esc)';
    closeBtn.onclick = closeModal;
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // ---- tab ----
    const tabs = el('div', 'sw-tabs');
    const tabLocal = el('button', 'sw-tab on');
    tabLocal.appendChild(el('span', 'dot'));
    tabLocal.appendChild(document.createTextNode('本地'));
    const tabOnline = el('button', 'sw-tab');
    tabOnline.appendChild(el('span', 'dot'));
    tabOnline.appendChild(document.createTextNode('在线'));
    tabLocal.onclick = () => switchTab('local');
    tabOnline.onclick = () => switchTab('online');
    tabs.appendChild(tabLocal);
    tabs.appendChild(tabOnline);
    panel.appendChild(tabs);

    // ---- 主体 ----
    const body = el('div', 'sw-body');
    panel.appendChild(body);

    const searchWrap = el('div', 'sw-searchwrap');
    searchInput = el('input', 'sw-search');
    searchInput.type = 'text';
    searchInput.placeholder = '搜索本地技能：名称、描述、标签，支持缩写（如 mvi）';
    searchInput.spellcheck = false;
    searchInput.addEventListener('input', () => {
      // 防抖：搜索接口要读磁盘建索引，逐键请求没必要
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => refresh(searchInput.value), 220);
    });
    searchWrap.appendChild(searchInput);

    metaEl = el('div', 'sw-search-meta');
    searchWrap.appendChild(metaEl);
    body.appendChild(searchWrap);

    listEl = el('div', 'sw-list');
    body.appendChild(listEl);

    // ---- 底部：来源安装 ----
    footEl = el('div', 'sw-foot');
    buildFoot(footEl);
    panel.appendChild(footEl);

    return panel;
  }

  function buildFoot(container) {
    container.innerHTML = '';
    container.appendChild(el('div', 'sw-foot-label', '从来源安装'));
    const row = el('div', 'sw-foot-row');
    const input = el('input', 'sw-foot-input');
    input.type = 'text';
    input.placeholder = '本地文件夹路径，或 owner/repo、git 地址';
    input.spellcheck = false;
    input.id = 'sw-install-source';

    const btn = el('button', 'sw-btn primary', '预览并安装');
    btn.onclick = () => doPreview(input.value);

    // 输入框里回车直接预览，符合"填完就提交"的直觉
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doPreview(input.value);
    });

    row.appendChild(input);
    row.appendChild(btn);
    container.appendChild(row);
    container.appendChild(el(
      'div',
      'sw-foot-hint',
      '例：C:\\my-skills\\foo　·　kuoleroy/mv-image-pipeline　·　https://github.com/a/b#skills/c',
    ));
  }

  // ============================================================ tab

  function switchTab(tab) {
    currentTab = tab;
    const tabs = modal.querySelectorAll('.sw-tab');
    tabs[0].classList.toggle('on', tab === 'local');
    tabs[1].classList.toggle('on', tab === 'online');

    // 搜索框只属于本地 tab；底部「从来源安装」两个 tab 都保留 ——
    // 它是"给个地址就能装"，与搜索方式无关。在线 tab 的说明里也写着
    // "可以粘贴仓库地址安装"，藏起来就自相矛盾了。
    const showLocal = tab === 'local';
    modal.querySelector('.sw-searchwrap').style.display = showLocal ? '' : 'none';

    if (showLocal) {
      renderList(lastResult);
      if (searchInput) searchInput.focus();
    } else {
      renderOnlinePlaceholder();
    }
  }

  function renderOnlinePlaceholder() {
    listEl.innerHTML = '';
    metaEl.textContent = '';

    const box = el('div', 'sw-soon');
    box.appendChild(el('span', 'badge', '建设中'));
    box.appendChild(el('h3', null, '在线搜索还没接'));
    box.appendChild(el('p', null, '这里将来用于在公开仓库里搜索可安装的技能。'));
    box.appendChild(el('p', null, '之所以先留空：在线搜索需要一个索引，'
      + '而索引需要有人维护内容质量。没有内容就做搜索，只会让用户搜到一堆不能用的东西。'));

    const plan = el('div', 'plan');
    plan.innerHTML = [
      '计划分三步：',
      '① 维护一份<code>curated 清单</code>（仓库里一个 JSON，人工筛选分类）',
      '② 搜索结果来自这份清单，可一键安装',
      '③ 清单有内容之后，再考虑接入全网搜索',
      '',
      '在此之前，可以直接在下方粘贴仓库地址安装 —— 只要你知道要装什么。',
    ].join('<br>');
    box.appendChild(plan);

    listEl.appendChild(box);
  }

  // ============================================================ 列表

  async function refresh(q) {
    if (currentTab !== 'local') return;
    const query = q === undefined ? '' : q;
    lastQuery = query;

    try {
      const r = await getJson('/api/search?q=' + encodeURIComponent(query));
      lastResult = r;
      preview = null;
      renderList(r);
    } catch (e) {
      listEl.innerHTML = '';
      const empty = el('div', 'sw-empty');
      empty.appendChild(el('b', null, '搜索失败'));
      empty.appendChild(document.createTextNode(e.message));
      listEl.appendChild(empty);
    }
  }

  function renderMeta(r) {
    metaEl.innerHTML = '';
    if (!r) return;
    const left = el('span');
    if (!r.query) {
      left.textContent = `共 ${r.total} 个技能`;
    } else {
      left.textContent = r.total
        ? `找到 ${r.total} 个`
        : '没有找到';
    }
    metaEl.appendChild(left);

    if (r.partial) {
      const warn = el('span', 'sw-partial', '仅匹配部分关键词');
      warn.title = '没有同时匹配全部关键词的技能，下面是只匹配了一部分的';
      metaEl.appendChild(warn);
    }
  }

  function renderList(r) {
    if (!listEl) return;
    renderMeta(r);

    listEl.innerHTML = '';
    if (!r) return;

    if (!r.results.length) {
      const empty = el('div', 'sw-empty');
      empty.appendChild(el('b', null, r.query ? '没找到匹配的技能' : '真源里还没有技能'));
      empty.appendChild(document.createTextNode(
        r.query
          ? '换个词试试，或者直接在下面粘贴来源安装。'
          : '在下面粘贴一个本地文件夹或仓库地址，第一个技能就进来了。'
      ));
      listEl.appendChild(empty);
      return;
    }

    for (const item of r.results) {
      listEl.appendChild(buildItem(item, r));
    }
  }

  function buildItem(item, result) {
    const box = el('div', 'sw-item');
    const top = el('div', 'sw-item-top');

    top.appendChild(el('span', 'sw-item-name', item.name));
    if (item.title && item.title !== item.name) {
      top.appendChild(el('span', 'sw-item-title', item.title));
    }
    top.appendChild(el('span', 'sw-item-spacer'));
    top.appendChild(el('span', 'sw-tagx ' + item.status, STATUS_LABEL[item.status] || item.status));
    box.appendChild(top);

    const desc = (item.current && item.current.description) || '';
    if (desc) box.appendChild(el('div', 'sw-item-desc', desc));

    // 元信息行：体积 / 版本 / 来源。只放有的，不放空占位。
    const meta = el('div', 'sw-item-meta');
    if (item.current) {
      meta.appendChild(el('span', null, `${item.current.files} 文件 · ${human(item.current.bytes)}`));
    }
    if (item.version) meta.appendChild(el('span', null, 'v' + item.version));
    if (item.source && item.source.type) {
      meta.appendChild(el('span', null,
        item.source.type === 'git' ? '来自 git' : '来自本地'));
    }
    if (item.installedAt) {
      meta.appendChild(el('span', null, item.installedAt.slice(0, 10) + ' 安装'));
    }
    if (meta.childNodes.length) box.appendChild(meta);

    // 展开详情
    let detail = null;
    box.onclick = () => {
      if (detail) {
        detail.remove();
        detail = null;
        box.classList.remove('open');
        return;
      }
      detail = buildDetail(item, result);
      box.appendChild(detail);
      box.classList.add('open');
    };

    return box;
  }

  function buildDetail(item, result) {
    const d = el('div', 'sw-detail');

    const dl = el('dl');
    const add = (k, v) => {
      if (!v) return;
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, v));
    };
    add('名称', item.name);
    add('标题', item.title);
    add('版本', item.version);
    if (item.source) {
      add('来源', item.source.input
        || (item.source.adopted ? '手工放入真源' : item.source.type));
    }
    if (item.commit) add('提交', String(item.commit).slice(0, 10));
    if (item.installedAt) add('安装于', item.installedAt.replace('T', ' ').slice(0, 19));
    if (item.current) {
      add('文件', `${item.current.files} 个 · ${human(item.current.bytes)}`);
      if (item.current.description) add('描述', item.current.description);
    }
    d.appendChild(dl);

    // 操作
    const acts = el('div', 'sw-detail-acts');

    if (item.status === 'missing') {
      const clean = el('button', 'sw-btn danger', '清除残留记录');
      clean.onclick = async (e) => {
        e.stopPropagation();
        await doUninstall(item.name, true);
      };
      acts.appendChild(clean);
    }

    if (item.status === 'installed' || item.status === 'unmanaged') {
      const rm = el('button', 'sw-btn danger', '卸载');
      rm.title = '删除真源目录，并摘掉各端链接';
      rm.onclick = async (e) => {
        e.stopPropagation();
        await doUninstall(item.name, false);
      };
      acts.appendChild(rm);
    }

    if (item.status === 'unmanaged') {
      const adopt = el('button', 'sw-btn', '纳管');
      adopt.title = '补一条安装记录，之后能看到来源与版本';
      adopt.onclick = async (e) => {
        e.stopPropagation();
        try {
          await postJson('/api/adopt', { name: item.name });
          toast('已纳管 ' + item.name, 'ok');
          await refresh(lastQuery);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      acts.appendChild(adopt);
    }

    if (acts.childNodes.length) d.appendChild(acts);
    return d;
  }

  // ============================================================ 卸载

  async function doUninstall(name, keepRecord) {
    const msg = keepRecord
      ? `清除「${name}」的残留记录？\n\n真源里已经没有这个目录了，只是把记录删掉。`
      : `卸载「${name}」？\n\n会删除真源目录，并摘掉各端链接。\n真源里的其他技能不受影响。`;
    if (!window.confirm(msg)) return;

    try {
      await postJson('/api/uninstall', { name });
      toast(keepRecord ? '已清除记录' : '已卸载 ' + name, 'ok');
      await refresh(lastQuery);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ============================================================ 预览与安装

  /** 退出预览，底部恢复成「从来源安装」 */
  function exitPreview() {
    preview = null;
    buildFoot(footEl);
    renderList(lastResult);
  }

  /**
   * 预览态的底部操作栏。
   *
   * 为什么把按钮放到底部而不是卡片里：预览内容（尤其安全发现）可能很长，
   * 按钮跟着滚出屏幕，用户会以为没法继续。底部固定栏是安装类界面的常规做法。
   * 同时把「从来源安装」输入区收起来 —— 正在预览时再输入新来源只会造成困惑。
   */
  function renderPreviewFoot(r) {
    footEl.innerHTML = '';
    const row = el('div', 'sw-foot-row');

    const back = el('button', 'sw-btn', '← 返回列表');
    back.onclick = exitPreview;
    row.appendChild(back);

    const hint = el('div', null,
      r.conflict.exists ? '真源里已有同名技能，继续会覆盖' : '确认无误后再安装');
    hint.style.cssText = 'flex:1;font-size:10.5px;color:#5d6575;padding-left:4px;';
    row.appendChild(hint);

    const ok = el('button', 'sw-btn primary', r.conflict.exists ? '覆盖安装' : '安装');
    ok.onclick = () => doInstall(r);
    row.appendChild(ok);

    footEl.appendChild(row);
  }

  async function doPreview(source) {
    const src = String(source || '').trim();
    if (!src) {
      toast('先填一个来源', 'err');
      return;
    }

    // 上一次可能是预览态，先把底部复位
    buildFoot(footEl);

    listEl.innerHTML = '';
    const loading = el('div', 'sw-empty');
    loading.appendChild(el('b', null, '正在获取…'));
    loading.appendChild(document.createTextNode('拉取来源、解析清单、扫描内容。远程仓库通常几秒。'));
    listEl.appendChild(loading);
    metaEl.textContent = '';

    try {
      const r = await postJson('/api/install/preview', { source: src });
      preview = r;
      renderPreview(r);
    } catch (e) {
      preview = null;
      buildFoot(footEl);
      listEl.innerHTML = '';
      const err = el('div', 'sw-empty');
      err.appendChild(el('b', null, '获取失败'));
      err.appendChild(document.createTextNode(e.message));
      listEl.appendChild(err);
    }
  }

  function renderPreview(r) {
    listEl.innerHTML = '';
    metaEl.textContent = '';

    const head = el('div', 'sw-item open');
    const top = el('div', 'sw-item-top');
    top.appendChild(el('span', 'sw-item-name', r.name));
    if (r.title && r.title !== r.name) top.appendChild(el('span', 'sw-item-title', r.title));
    top.appendChild(el('span', 'sw-item-spacer'));
    const hi = r.safety.summary.high;
    if (hi > 0) {
      const t = el('span', 'sw-tagx missing', hi + ' 项高危');
      top.appendChild(t);
    }
    head.appendChild(top);

    if (r.description) head.appendChild(el('div', 'sw-item-desc', r.description));

    const meta = el('div', 'sw-item-meta');
    meta.appendChild(el('span', null, `${r.size.files} 文件 · ${human(r.size.bytes)}`));
    meta.appendChild(el('span', null, '约 ' + r.tokens + ' token'));
    if (r.version) meta.appendChild(el('span', null, 'v' + r.version));
    if (r.license) meta.appendChild(el('span', null, r.license));
    if (r.commit) meta.appendChild(el('span', null, String(r.commit).slice(0, 8)));
    head.appendChild(meta);

    // 详情
    const d = el('div', 'sw-detail');
    const dl = el('dl');
    const add = (k, v) => {
      if (!v) return;
      dl.appendChild(el('dt', null, k));
      dl.appendChild(el('dd', null, v));
    };
    add('来源', r.source.label + (r.relPath !== '.' ? ` · ${r.relPath}` : ''));
    add('将装到', r.conflict.targetDir);
    d.appendChild(dl);

    // 安全结论
    const verdict = el('div', null, r.safety.verdict);
    verdict.style.cssText = 'margin-top:9px;font-size:11.5px;font-weight:600;'
      + (hi > 0 ? 'color:#ff8f8f' : r.safety.summary.medium > 0 ? 'color:#e0a34a' : 'color:#63c48c');
    d.appendChild(verdict);

    // 发现项（只列非 info，info 太多会淹没重点）
    const shown = r.safety.findings.filter((f) => f.level !== 'info');
    if (shown.length) {
      const box = el('div', 'sw-find');
      for (const f of shown.slice(0, 12)) {
        const row = el('div', 'sw-find-row');
        row.appendChild(el('span', 'sw-find-lv ' + f.level, f.level === 'high' ? '高危' : '留意'));
        const body = el('div', 'sw-find-body');
        body.appendChild(el('div', 'sw-find-rule', f.rule + '  ' + (f.file || '')
          + (f.line ? ':' + f.line : '')));
        body.appendChild(el('div', 'sw-find-why', f.why));
        if (f.evidence) body.appendChild(el('div', 'sw-find-ev', f.evidence));
        row.appendChild(body);
        box.appendChild(row);
      }
      d.appendChild(box);
      if (shown.length > 12) {
        const more = el('div', null, `…以及另外 ${shown.length - 12} 项`);
        more.style.cssText = 'margin-top:6px;font-size:10.5px;color:#5d6575;';
        d.appendChild(more);
      }
    }

    // 清单里的问题
    if (r.problems && r.problems.length) {
      const w = el('div');
      w.style.cssText = 'margin-top:9px;';
      for (const p of r.problems) {
        const line = el('div', null, '· ' + p.message);
        line.style.cssText = 'font-size:10.5px;color:#e0a34a;line-height:1.7;';
        w.appendChild(line);
      }
      d.appendChild(w);
    }

    // 冲突
    if (r.conflict.exists) {
      const c = el('div');
      c.style.cssText = 'margin-top:9px;padding:8px 10px;border-radius:8px;'
        + 'background:rgba(240,163,74,.08);border:1px solid rgba(240,163,74,.24);'
        + 'font-size:11px;color:#e0a34a;line-height:1.7;';
      c.textContent = r.conflict.previouslyInstalled
        ? `真源里已有同名技能（${r.conflict.previouslyVersion || '未知版本'}），`
          + '继续会覆盖它。'
        : '真源里已存在同名目录，但不在安装记录里。继续会覆盖它。';
      d.appendChild(c);
    }

    head.appendChild(d);
    listEl.appendChild(head);
    listEl.scrollTop = 0;
    // 操作按钮放到底部固定栏，不跟内容滚出屏幕
    renderPreviewFoot(r);
  }

  async function doInstall(r) {
    try {
      toast('正在安装…');
      const res = await postJson('/api/install', {
        source: r.source.input,
        // 传预览时拿到的 commit：来源在确认期间被改掉，后端会拒绝
        expectedCommit: r.commit,
        overwrite: r.conflict.exists,
      });
      const n = (res.enabled || []).length;
      toast(`已安装 ${res.name}` + (n ? `，在 ${n} 个端生效` : ''), 'ok');
      if (res.warnings && res.warnings.length) {
        console.warn('[Skillsmith] 安装提醒：', res.warnings);
      }
      preview = null;
      // 清空输入框，避免手快又装一次
      const inp = document.getElementById('sw-install-source');
      if (inp) inp.value = '';
      await refresh('');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ============================================================ 挂载

  function injectEntry() {
    if (document.querySelector('.sw-install-btn')) return;
    const nav = document.querySelector('aside nav');
    if (!nav) return;

    const btn = el('button', 'sw-btn sw-install-btn');
    btn.textContent = '＋ 安装技能';
    btn.title = '搜索本地技能，或从文件夹 / 仓库安装';
    btn.onclick = openModal;
    nav.appendChild(btn);
  }

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
      return;
    }
    if (!document.getElementById('sw-install-style')) {
      const style = document.createElement('style');
      style.id = 'sw-install-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; injectEntry(); }, 150);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    injectEntry();

    // 允许菜单栏/其他脚本触发
    window.addEventListener('sw:open-install-panel', () => openModal());
  }

  start();
})();
