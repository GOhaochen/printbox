// 打印助手 · 前端单页应用（原生 ES Module）
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  meta: null,
  settings: {},
  roots: [],
  cwd: '',
  entries: [],
  selected: new Set(),
  selectMode: false,
  filter: 'all',
  searchQ: '',
  printers: [],
  defaultPrinter: null,
  printerStatus: null,
  jobs: [],
  queueTimer: null,
  scanners: [],
  currentScanner: '',
};

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const { method = 'GET', body, headers = {} } = opts;
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = n => String(n).padStart(2, '0');
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function confirmDialog(msg, okText = '确定') {
  return new Promise(resolve => {
    const m = $('#modal');
    m.innerHTML = `<div class="modal-box" style="max-width:420px">
      <div style="font-size:15px;margin-bottom:14px">${esc(msg)}</div>
      <div class="actions" style="justify-content:flex-end">
        <button class="btn" id="cd-no">取消</button>
        <button class="btn primary" id="cd-yes">${esc(okText)}</button>
      </div></div>`;
    m.classList.add('open');
    $('#cd-no').onclick = () => { m.classList.remove('open'); resolve(false); };
    $('#cd-yes').onclick = () => { m.classList.remove('open'); resolve(true); };
  });
}

// ---------- 路由 ----------
function route() {
  const hash = location.hash || '#/files';
  $$('#tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.nav === hash));
  if (state.queueTimer) { clearInterval(state.queueTimer); state.queueTimer = null; }
  const view = $('#view');
  if (view) view.scrollTop = 0;
  switch (hash) {
    case '#/scan': return renderScan(view);
    case '#/queue': return renderQueue(view);
    case '#/history': return renderHistory(view);
    case '#/settings': return renderSettings(view);
    default: return renderFiles(view);
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('popstate', e => {
  const st = e.state;
  if (st && st.dir) { loadDir(st.dir, { noPush: true }); return; }
  route();
});
document.addEventListener('click', e => {
  const back = e.target.closest('#btn-back');
  if (back) { location.hash = '#/files'; }
});

// ---------- 打印机状态 ----------
async function loadPrinters() {
  try {
    state.printers = await api('/api/printers');
    state.defaultPrinter = state.printers.find(p => p.is_default) || state.printers[0] || null;
  } catch (e) { state.printers = []; state.defaultPrinter = null; }
  renderPrinterChip();
  if (state.defaultPrinter) refreshStatus(state.defaultPrinter.ip);
}

function renderPrinterChip() {
  const dot = $('#printer-dot');
  const label = $('#printer-label');
  if (!dot || !label) return;
  if (!state.defaultPrinter) {
    dot.className = 'dot warn';
    label.textContent = '未设置打印机';
    return;
  }
  label.textContent = state.defaultPrinter.name || state.defaultPrinter.ip;
  const st = state.printerStatus;
  dot.className = 'dot ' + (st ? (st.state === 'idle' ? 'ok' : st.state === 'processing' ? 'warn' : 'err') : '');
}

async function refreshStatus(ip) {
  try {
    state.printerStatus = await api('/api/printers/status?ip=' + encodeURIComponent(ip));
  } catch (e) { state.printerStatus = null; }
  renderPrinterChip();
}

// ---------- 文件页 ----------
async function renderFiles(view) {
  view.innerHTML = `
    <div class="files-layout">
      <aside class="tree" id="tree"></aside>
      <div class="files-main">
        <div class="toolbar">
          <div class="crumbs" id="crumbs"></div>
          <div class="actions" id="file-actions"></div>
        </div>
        <div class="toolbar" id="filterbar"></div>
        <div class="grid" id="grid"></div>
      </div>
    </div>`;
  if (!state.roots.length) {
    try {
      state.roots = await api('/api/files/roots');
      state.cwd = (state.roots[0] && state.roots[0].path) || '';
    } catch (e) { toast(e.message); }
  }
  if (!state.roots.length) {
    view.innerHTML = `<div class="panel" style="max-width:560px;margin:40px auto;text-align:center">
      <h3 style="margin:0 0 10px">还没有可打印的文件</h3>
      <p class="hint">请按以下步骤授权：<b>控制面板 → 关于本机 → 应用 → 打印 → 可访问文件夹</b>，添加文件夹并保存，然后重启应用；也可以先上传文件或输入网页链接。</p>
      <div class="actions" style="justify-content:center;margin-top:14px">
        <button class="btn primary" id="empty-upload">上传文件</button>
        <button class="btn" id="empty-url">粘贴链接</button>
      </div></div>`;
    $('#empty-upload').onclick = () => { const i = document.createElement('input'); i.type='file'; i.multiple=true; i.accept='.pdf,.jpg,.jpeg,.png'; i.onchange=async()=>{ for(const f of Array.from(i.files||[])){ const fd=new FormData(); fd.append('file',f); try{ await api('/api/files/upload',{method:'POST',body:fd}); }catch(e){ toast(e.message); } } toast('上传完成'); location.hash='#/files'; route(); }; i.click(); };
    $('#empty-url').onclick = async () => { const u = prompt('输入文件链接'); if (!u) return; try { await api('/api/files/fetch-url',{method:'POST',body:{url:u}}); toast('已下载'); route(); } catch(e){ toast(e.message); } };
    return;
  }
  if (!state.cwd || !state.roots.some(r => state.cwd.startsWith(r.path))) state.cwd = state.roots[0].path;
  await loadDir(state.cwd, { noPush: true });
  renderTree();
  const si = $('#search');
  if (si) {
    si.value = state.searchQ || '';
    si.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(si.value.trim()); } };
    let timer = null;
    si.oninput = () => {
      clearTimeout(timer);
      const v = si.value.trim();
      if (!v) {
        if (state.searchResults) { state.searchQ = ''; state.searchResults = null; renderFilesView(); }
        return;
      }
      timer = setTimeout(() => doSearch(v), 450);
    };
  }
}

async function loadDir(path, opts = {}) {
  try {
    const data = await api('/api/files/list?path=' + encodeURIComponent(path));
    state.cwd = data.path;
    state.entries = data.entries || [];
    state.parent = data.parent;
    state.searchResults = null;
    if (opts.noPush) {
      try { history.replaceState({ dir: state.cwd }, ''); } catch (e) {}
    } else {
      try { history.pushState({ dir: state.cwd }, ''); } catch (e) {}
    }
    renderFilesView();
  } catch (e) { toast(e.message); }
}

function renderTree() {
  const tree = $('#tree');
  if (!tree) return;
  const roots = state.roots.map(r => `
    <div class="tree-item ${state.cwd === r.path ? 'active' : ''}" data-root="${esc(r.path)}">
      <span class="ico">${folderSVG()}</span><span class="name">${esc(r.name)}</span>
    </div>`).join('');
  const subDirs = state.entries.filter(e => e.is_dir).map(e => `
    <div class="tree-item tree-sub" data-dir="${esc(e.path)}">
      <span class="ico">${folderSVG()}</span><span class="name">${esc(e.name)}</span>
    </div>`).join('');
  const canUp = state.parent && state.parent !== state.cwd && state.parent !== '/';
  const upBtn = canUp ? `<div class="tree-item" data-up="${esc(state.parent)}"><span class="ico">↑</span><span class="name">返回上一级</span></div>` : '';
  tree.innerHTML = `<div class="tree-title">存储位置</div>${roots}${upBtn}${subDirs ? `<div class="tree-title" style="margin-top:10px">当前目录</div>${subDirs}` : ''}`;
  $$('#tree .tree-item').forEach(el => {
    el.onclick = () => {
      if (el.dataset.up) loadDir(el.dataset.up);
      else if (el.dataset.root) loadDir(el.dataset.root);
      else loadDir(el.dataset.dir);
    };
  });
}

function renderBreadcrumb() {
  const box = $('#crumbs');
  if (!box) return;
  if (state.searchResults) {
    box.innerHTML = `<span class="hint">搜索“${esc(state.searchQ || '')}”共 ${state.searchResults.length} 个结果</span>
      <button class="btn small" id="search-clear">清除</button>`;
    const c = $('#search-clear');
    if (c) c.onclick = () => { state.searchQ = ''; state.searchResults = null; const si = $('#search'); if (si) si.value = ''; renderFilesView(); };
    return;
  }
  const root = state.roots.find(r => state.cwd.startsWith(r.path)) || state.roots[0];
  const parts = [];
  if (root) {
    parts.push({ name: root.name, path: root.path });
    let cur = root.path;
    const rel = state.cwd.slice(root.path.length).split('/').filter(Boolean);
    for (const seg of rel) {
      cur = cur.replace(/\/$/, '') + '/' + seg;
      parts.push({ name: seg, path: cur });
    }
  } else {
    parts.push({ name: state.cwd, path: state.cwd });
  }
  box.innerHTML = parts.map((p, i) => {
    const cls = i === parts.length - 1 ? 'crumb current' : 'crumb';
    return `<button class="${cls}" data-crumb="${esc(p.path)}">${esc(p.name)}</button>`;
  }).join('<span style="color:var(--muted)">/</span>');
  $$('#crumbs [data-crumb]').forEach(b => b.onclick = () => loadDir(b.dataset.crumb));
}

// 文件类型图标（自绘，风格接近系统文件管理）
function fileExt(name) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function folderSVG() {
  return `<svg viewBox="0 0 64 64" class="file-ico"><path d="M6 18a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v25a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#5b9cf5"/><path d="M6 24h52v24a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4z" fill="#7fb4ff"/></svg>`;
}

function fileIconSVG(ext) {
  const colors = {
    pdf: '#e53935', doc: '#1e88e5', docx: '#1e88e5',
    xls: '#43a047', xlsx: '#43a047', ods: '#43a047',
    ppt: '#fb8c00', pptx: '#fb8c00',
    txt: '#78909c', csv: '#43a047', md: '#78909c',
  };
  const labels = { docx: 'DOC', doc: 'DOC', xlsx: 'XLS', xls: 'XLS', ods: 'ODS', pptx: 'PPT', ppt: 'PPT', pdf: 'PDF' };
  const color = colors[ext] || '#90a4ae';
  const label = labels[ext] || (ext || 'FILE').toUpperCase().slice(0, 4);
  return `<svg viewBox="0 0 64 64" class="file-ico">
    <path d="M14 4h24l12 12v40a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="#fff" stroke="#d0d7de" stroke-width="1.5"/>
    <path d="M38 4l12 12H38z" fill="#eef2f6"/>
    <rect x="8" y="38" width="34" height="15" rx="3" fill="${color}"/>
    <text x="25" y="49.5" text-anchor="middle" font-size="9.5" font-family="Arial, sans-serif" font-weight="700" fill="#fff">${label}</text>
  </svg>`;
}

function renderFilterBar() {
  const bar = $('#filterbar');
  if (!bar) return;
  const items = [['all', '全部'], ['pdf', 'PDF'], ['image', '图片'], ['office', 'Office']];
  bar.innerHTML = items.map(([k, label]) =>
    `<button class="chip ${state.filter === k ? 'active' : ''}" data-filter="${k}">${label}</button>`).join('');
  $$('#filterbar [data-filter]').forEach(b => b.onclick = () => { state.filter = b.dataset.filter; renderFilesView(); });
}

function renderFilesView() {
  renderBreadcrumb();
  renderFilterBar();
  renderTree();
  const grid = $('#grid');
  if (!grid) return;
  let entries = state.searchResults ? state.searchResults : state.entries;
  if (!state.searchResults && state.filter !== 'all') entries = entries.filter(e => e.is_dir || e.kind === state.filter);
  if (!entries.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${state.searchResults ? '没有匹配的文件' : '此目录没有可显示的文件'}</div>`;
  } else {
    grid.innerHTML = entries.map(e => {
      if (e.is_dir) {
        return `<div class="file-card" data-dir="${esc(e.path)}">
          <div class="thumb">${folderSVG()}</div>
          <div class="meta"><div class="fname">${esc(e.name)}</div><div class="fsub">文件夹</div></div>
        </div>`;
      }
      const sel = state.selected.has(e.path);
      const ext = fileExt(e.name);
      const thumb = e.kind === 'image'
        ? `<img loading="lazy" src="/api/files/content?path=${encodeURIComponent(e.path)}" alt="">`
        : fileIconSVG(ext);
      const star = state.favorites && state.favorites.includes(e.path) ? '<span class="star">★</span>' : '';
      return `<div class="file-card ${sel ? 'selected' : ''}" data-file="${esc(e.path)}" data-kind="${esc(e.kind)}">
        <div class="thumb">${thumb}${state.selectMode ? '<span class="pick"></span>' : ''}${star}</div>
        <div class="meta"><div class="fname" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="fsub">${fmtSize(e.size)} · ${fmtTime(e.mod_time)}</div></div>
      </div>`;
    }).join('');
  }
  const clearBtn = $('#search-clear');
  if (clearBtn) clearBtn.onclick = () => { state.searchQ = ''; state.searchResults = null; const si = $('#search'); if (si) si.value = ''; renderFilesView(); };
  $$('#grid .file-card').forEach(card => {
    card.onclick = e => {
      if (card.dataset.dir) { loadDir(card.dataset.dir); return; }
      const path = card.dataset.file;
      if (state.selectMode) { toggleSelect(path); return; }
      const ext = fileExt(path);
      const SUPPORTED = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'xlsx', 'xls', 'docx', 'doc', 'txt', 'ods', 'odt'];
      if (!SUPPORTED.includes(ext)) {
        toast(`暂不支持 ${ext ? ext.toUpperCase() : '该'} 格式打印，请转换为 PDF 后重试`, 3600);
        return;
      }
      openPrintDialog([{ path, name: card.querySelector('.fname').textContent }]);
    };
    if (!card.dataset.dir) card.oncontextmenu = e => { e.preventDefault(); openFileMenu(card.dataset.file); };
  });
  renderFileActions();
}

function renderFileActions() {
  const box = $('#file-actions');
  if (!box) return;
  box.innerHTML = `
    <button class="btn small" id="btn-select-files">选择</button>
    <button class="btn small" id="btn-recent">最近</button>
    <button class="btn small" id="btn-favs">收藏</button>
    <button class="btn small" id="btn-refresh">刷新</button>
    <button class="btn small primary" id="btn-upload">上传</button>
    <input type="file" id="file-input" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp">
    <button class="btn small" id="btn-url">链接</button>`;
  $('#btn-select-files').onclick = () => toggleSelectMode();
  $('#btn-recent').onclick = () => showQuick2('recents');
  $('#btn-favs').onclick = () => showQuick2('favorites');
  $('#btn-refresh').onclick = () => loadDir(state.cwd);
  $('#btn-upload').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async () => {
    const files = Array.from($('#file-input').files || []);
    if (!files.length) return;
    const uploaded = [];
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        const r = await api('/api/files/upload?temp=1', { method: 'POST', body: fd });
        uploaded.push({ path: r.path, name: r.name, temp: true });
      } catch (e) { toast(f.name + '：' + e.message); }
    }
    if (uploaded.length) openPrintDialog(uploaded);
  };
  $('#btn-url').onclick = async () => {
    const url = prompt('输入文件链接（http/https）');
    if (!url) return;
    try {
      const r = await api('/api/files/fetch-url?temp=1', { method: 'POST', body: { url } });
      openPrintDialog([{ path: r.path, name: r.name, temp: true }]);
    } catch (e) { toast(e.message); }
  };
}

function toggleSelect(path) {
  if (state.selected.has(path)) state.selected.delete(path); else state.selected.add(path);
  const card = document.querySelector(`.file-card[data-file="${CSS.escape(path)}"]`);
  if (card) card.classList.toggle('selected', state.selected.has(path));
  renderSelBar();
}

function renderSelBar() {
  const bar = $('#selbar');
  if (!bar) return;
  if (!state.selectMode) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `<span>已选 <b>${state.selected.size}</b> 个</span>
    <button class="btn small primary" id="sel-print">打印</button>
    <button class="btn small" id="sel-cancel">取消</button>`;
  $('#sel-print').onclick = () => {
    const paths = [...state.selected];
    if (!paths.length) { toast('请先选择文件'); return; }
    openPrintDialog(paths.map(p => ({ path: p, name: p.split('/').pop() })));
  };
  $('#sel-cancel').onclick = () => {
    state.selectMode = false;
    state.selected.clear();
    renderSelBar();
    renderFilesView();
  };
}

// ---------- 打印弹窗 ----------
function openPrintDialog(files) {
  const s = state.settings || {};
  const first = files[0];
  const isImage = /\.(jpe?g|png|webp|gif|bmp)$/i.test(first.path);
  const isPDF = /\.pdf$/i.test(first.path);
  const firstExt = fileExt(first.name || first.path);
  const isOffice = ['xlsx', 'xls', 'docx', 'doc', 'ods', 'odt'].includes(firstExt);
  const isText = firstExt === 'txt';
  const preview = isImage
    ? `<img src="/api/files/content?path=${encodeURIComponent(first.path)}" alt="">`
    : isOffice || isText
      ? `<div class="hint" style="padding:20px;text-align:center">正在生成预览…</div>`
      : `<iframe src="/api/files/content?path=${encodeURIComponent(first.path)}"></iframe>`;
  const m = $('#modal');
  m.innerHTML = `<div class="modal-box">
    <h3 style="margin:0 0 12px;font-size:16px">打印${files.length > 1 ? `（${files.length} 个文件）` : ''}</h3>
    <div class="print-dialog">
      <div class="preview" id="pr-preview">${preview}</div>
      <div class="form">
        <div class="hint" style="margin-bottom:2px">${files.map(f => esc(f.name)).join('<br>')}</div>
        <label class="field"><span>打印机</span>
          <select id="pr-printer">${state.printers.map(p => `<option value="${esc(p.ip)}" ${state.defaultPrinter && p.ip === state.defaultPrinter.ip ? 'selected' : ''}>${esc(p.name)}（${esc(p.ip)}）</option>`).join('')}</select>
        </label>
        <div class="row2">
          <label class="field"><span>份数</span><input id="pr-copies" type="number" min="1" max="99" value="${esc(s.default_copies || '1')}"></label>
          <label class="field"><span>纸张</span><select id="pr-paper">
            <option value="A4" ${s.default_paper === 'A4' || !s.default_paper ? 'selected' : ''}>A4</option>
            <option value="Letter" ${s.default_paper === 'Letter' ? 'selected' : ''}>Letter</option>
          </select></label>
        </div>
        <div class="row2">
          <label class="field"><span>单双面</span><select id="pr-duplex">
            <option value="false" ${s.default_duplex !== 'true' ? 'selected' : ''}>单面</option>
            <option value="true" ${s.default_duplex === 'true' ? 'selected' : ''}>双面（长边）</option>
          </select></label>
          <label class="field"><span>颜色</span><select id="pr-color">
            <option value="false" ${s.default_color !== 'true' ? 'selected' : ''}>黑白</option>
            <option value="true" ${s.default_color === 'true' ? 'selected' : ''}>彩色</option>
          </select></label>
        </div>
        <label class="field" id="pr-pages-wrap" style="display:${isPDF ? 'flex' : 'none'}"><span>页码范围</span>
          <input id="pr-pages" placeholder="全部；例如 1-3,5">
        </label>
        <div class="row2">
          <label class="field" id="pr-duplex-mode-wrap"><span>双面方式</span><select id="pr-duplex-mode">
            <option value="long" selected>长边翻转（书籍）</option>
            <option value="short">短边翻转（便签）</option>
          </select></label>
          <label class="field"><span>打印质量</span><select id="pr-quality">
            <option value="draft">草稿（省墨）</option>
            <option value="normal" selected>标准</option>
            <option value="high">高（清晰）</option>
          </select></label>
        </div>
        <label class="field"><span>页面方向</span><select id="pr-orientation">
          <option value="portrait" selected>纵向</option>
          <option value="landscape">横向</option>
        </select></label>
        <label class="field"><span>缩放</span><select id="pr-scale">
          <option value="fit" ${s.default_scale !== 'actual' ? 'selected' : ''}>适应页面</option>
          <option value="actual" ${s.default_scale === 'actual' ? 'selected' : ''}>实际大小</option>
        </select></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="pr-save" style="width:auto"> <span>保存为默认参数</span>
        </label>
        ${files[0].temp ? '<div class="hint" style="margin-top:4px">该文件为临时文件：打印后自动删除；如需保留请点「保存到…」。</div>' : ''}
        <div class="actions">
          <button class="btn" id="pr-cancel">取消</button>
          <button class="btn" id="pr-save">保存到…</button>
          <button class="btn" id="pr-test">打印测试页</button>
          <button class="btn primary" id="pr-ok">打印</button>
        </div>
      </div>
    </div></div>`;
  m.classList.add('open');
  if (isOffice || isText) {
    (async () => {
      const pre = $('#pr-preview');
      try {
        const cached = state.previewCache && state.previewCache.path === first.path ? state.previewCache.data : null;
        const data = cached || await renderDocToBlobs(first.path, (i, n) => {
          if (pre) pre.innerHTML = `<div class="hint" style="padding:20px;text-align:center"><span class="spinner"></span> 正在生成预览 ${i}/${n} 页…</div>`;
        });
        state.previewCache = { path: first.path, data };
        renderPreviewPage(0);
      } catch (e) {
        if (pre) pre.innerHTML = `<div class="hint" style="padding:20px;text-align:center">预览失败：${esc(e.message)}</div>`;
      }
    })();
  }
  const dupToggle = () => {
    const wrap = $('#pr-duplex-mode-wrap');
    const sel = $('#pr-duplex');
    if (wrap && sel) wrap.style.display = sel.value === 'true' ? 'flex' : 'none';
  };
  const dupSel = $('#pr-duplex');
  if (dupSel) { dupSel.onchange = dupToggle; dupToggle(); }
  $('#pr-cancel').onclick = () => m.classList.remove('open');
  const saveBtn = $('#pr-save');
  if (saveBtn) saveBtn.onclick = async () => {
    const dir = await pickDirectory((state.roots[0] || {}).path || '');
    if (!dir) return;
    try {
      let saved = 0;
      for (const f of files) {
        await api('/api/files/save-copy', { method: 'POST', body: { path: f.path, target_dir: dir } });
        saved++;
      }
      toast(`已保存 ${saved} 个文件到 ${dir}`, 3600);
    } catch (e) { toast(e.message, 3600); }
  };
  $('#pr-test').onclick = async () => {
    try {
      await api('/api/print/test', { method: 'POST', body: { printer_ip: $('#pr-printer').value } });
      toast('测试页已加入队列');
      location.hash = '#/queue';
    } catch (e) { toast(e.message); }
  };
  $('#pr-ok').onclick = async () => {
    const body = {
      printer_ip: $('#pr-printer').value,
      copies: Number($('#pr-copies').value) || 1,
      paper: $('#pr-paper').value,
      duplex: $('#pr-duplex').value === 'true',
      color: $('#pr-color').value === 'true',
      scale: $('#pr-scale').value,
      pages: ($('#pr-pages') && $('#pr-pages').value.trim()) || '',
      duplex_mode: ($('#pr-duplex-mode') && $('#pr-duplex-mode').value) || 'long',
      quality: ($('#pr-quality') && $('#pr-quality').value) || 'normal',
      orientation: ($('#pr-orientation') && $('#pr-orientation').value) || 'portrait',
      save_as_default: $('#pr-save').checked,
    };
    const btn = $('#pr-ok');
    const oldText = btn.textContent;
    btn.disabled = true;
    try {
      let created = 0;
      for (const f of files) {
        const ext = fileExt(f.name || f.path);
        if (['xlsx', 'xls', 'docx', 'doc', 'txt', 'ods', 'odt'].includes(ext)) {
          const cached = state.previewCache && state.previewCache.path === f.path ? state.previewCache.data : null;
          let blobs;
          if (cached) {
            blobs = cached.blobs;
          } else {
            btn.textContent = '正在解析文档…';
            const data = await renderDocToBlobs(f.path, (i, n) => {
              btn.textContent = `正在生成第 ${i}/${n} 页…`;
            });
            state.previewCache = { path: f.path, data };
            blobs = data.blobs;
          }
          for (const { page, blob } of blobs) {
            btn.textContent = `正在上传第 ${page} 页…`;
            const fd = new FormData();
            fd.append('file', new File([blob], `${(f.name || 'document').replace(/\.[^.]+$/, '')}-p${page}.jpg`, { type: 'image/jpeg' }));
            const up = await api('/api/files/upload', { method: 'POST', body: fd });
            await api('/api/print', { method: 'POST', body: { ...body, pages: '', file_path: up.path } });
            created++;
          }
          continue;
        }
        if (ext === 'ppt' || ext === 'pptx') {
          throw new Error('PPT 暂不支持直接打印，请先转换为 PDF');
        }
        if (ext === 'pdf') {
          btn.textContent = '正在准备 PDF…';
          const { blobs } = await renderPdfToBlobs(f.path, body.pages, (i, n) => {
            btn.textContent = `正在渲染 ${i}/${n} 页…`;
          });
          for (const { page, blob } of blobs) {
            btn.textContent = `正在上传第 ${page} 页…`;
            const fd = new FormData();
            fd.append('file', new File([blob], `${f.name.replace(/\.pdf$/i, '')}-p${page}.jpg`, { type: 'image/jpeg' }));
            const up = await api('/api/files/upload', { method: 'POST', body: fd });
            await api('/api/print', { method: 'POST', body: { ...body, pages: '', file_path: up.path } });
            created++;
          }
        } else {
          await api('/api/print', { method: 'POST', body: { ...body, file_path: f.path } });
          created++;
        }
      }
      toast(`已加入打印队列（${created} 个任务）`);
      m.classList.remove('open');
      state.selectMode = false;
      state.selected.clear();
      location.hash = '#/queue';
    } catch (e) { toast(e.message, 4200); }
    finally { btn.disabled = false; btn.textContent = oldText; }
  };

  if (isPDF) {
    loadPdfjs().then(async pdfjs => {
      const doc = await pdfjs.getDocument({
        url: '/api/files/content?path=' + encodeURIComponent(first.path),
        cMapUrl: '/vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      }).promise;
      const input = $('#pr-pages');
      if (input) input.placeholder = `全部（共 ${doc.numPages} 页）；例如 1-3,5`;
      try { doc.destroy(); } catch (e) {}
    }).catch(() => {});
  }
}

function loadScriptOnce(src, globalName) {
  return new Promise((resolve, reject) => {
    if (window[globalName]) { resolve(window[globalName]); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(window[globalName]);
    s.onerror = () => reject(new Error('加载组件失败：' + src));
    document.head.appendChild(s);
  });
}

function renderPreviewPage(idx) {
  const cache = state.previewCache;
  const pre = $('#pr-preview');
  if (!cache || !pre) return;
  const total = cache.data.blobs.length;
  idx = Math.max(0, Math.min(idx, total - 1));
  state.previewCache.index = idx;
  const url = URL.createObjectURL(cache.data.blobs[idx].blob);
  const nav = total > 1 ? `<div class="actions" style="justify-content:center;margin-top:8px;flex-wrap:wrap">
      <button class="btn small" id="pg-prev" ${idx <= 0 ? 'disabled' : ''}>上一页</button>
      <span class="hint" style="align-self:center">第 ${idx + 1} / ${total} 页</span>
      <button class="btn small" id="pg-next" ${idx >= total - 1 ? 'disabled' : ''}>下一页</button>
      <input id="pg-jump" type="number" min="1" max="${total}" value="${idx + 1}" style="width:64px;padding:4px 6px;border-radius:6px;border:1px solid var(--line);background:var(--card-2);color:var(--text)">
      <button class="btn small" id="pg-go">跳转</button>
    </div>` : `<div class="hint" style="padding:6px">共 ${total} 页</div>`;
  pre.innerHTML = `<div style="width:100%;text-align:center">
    <img src="${url}" style="max-width:100%;max-height:400px;object-fit:contain">${nav}</div>`;
  const prev = $('#pg-prev'), next = $('#pg-next');
  if (prev) prev.onclick = () => renderPreviewPage(idx - 1);
  if (next) next.onclick = () => renderPreviewPage(idx + 1);
  const go = $('#pg-go');
  if (go) go.onclick = () => {
    const n = parseInt(($('#pg-jump') || {}).value, 10);
    if (!isNaN(n)) renderPreviewPage(n - 1);
  };
  const jump = $('#pg-jump');
  if (jump) jump.onkeydown = e => { if (e.key === 'Enter') { const n = parseInt(jump.value, 10); if (!isNaN(n)) renderPreviewPage(n - 1); } };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 把 HTML 渲染为分页 JPEG
async function renderHtmlToBlobs(html, onProgress) {
  const host = document.createElement('div');
  host.setAttribute('data-pb-host', '1');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1240px;box-sizing:border-box;background:#fff;color:#111;padding:56px;font:16px/1.65 "Microsoft YaHei","PingFang SC",Arial,sans-serif;';
  host.innerHTML = `<style>
    h1,h2,h3,h4{font-size:20px;margin:14px 0 8px}
    p{margin:8px 0}
    table{border-collapse:collapse;width:100%;margin:8px 0 18px}
    td{border:1px solid #bbb;padding:5px 7px;font-size:12.5px;word-break:break-all;vertical-align:top}
    hr{border:none;border-top:1px dashed #ccc;margin:18px 0}
    img{max-width:100%}
  </style>` + html;
  document.body.appendChild(host);
  try {
    const html2canvas = await loadScriptOnce('/vendor/office/html2canvas.min.js', 'html2canvas');
    const width = 1240;
    const canvas = await html2canvas(host, {
      scale: 1, backgroundColor: '#ffffff', width, windowWidth: width,
      scrollX: 0, scrollY: 0, logging: false,
      onclone: doc => {
        const el = doc.querySelector('[data-pb-host]');
        if (el) { el.style.position = 'fixed'; el.style.left = '0'; el.style.top = '0'; el.style.zIndex = '0'; }
      },
    });
    const pageH = Math.round(width * 1.414);
    const total = Math.max(1, Math.ceil(canvas.height / pageH));
    const blobs = [];
    for (let i = 0; i < total; i++) {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = Math.min(pageH, canvas.height - i * pageH);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(canvas, 0, i * pageH, canvas.width, c.height, 0, 0, c.width, c.height);
      const blob = await new Promise((resolve, reject) => {
        c.toBlob(b => b ? resolve(b) : reject(new Error('生成页面图片失败')), 'image/jpeg', 0.92);
      });
      blobs.push({ page: i + 1, blob });
      if (onProgress) onProgress(i + 1, total);
    }
    return { blobs, total };
  } finally {
    host.remove();
  }
}

// 解析 Office / 文本并渲染为分页 JPEG
async function renderDocToBlobs(path, onProgress) {
  const ext = fileExt(path);
  if (ext === 'txt') return renderTextToBlobs(path, onProgress);
  const res = await fetch('/api/files/content?path=' + encodeURIComponent(path));
  if (!res.ok) throw new Error('读取文件失败');
  const buf = await res.arrayBuffer();
  let html = '';
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await loadScriptOnce('/vendor/office/xlsx.full.min.js', 'XLSX');
    const wb = XLSX.read(buf, { type: 'array' });
    const sheets = (wb.SheetNames || []).slice(0, 6);
    html = sheets.map(name => {
      const ws = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      const body = rows.map(row => '<tr>' + row.map(cell => `<td>${escapeHtml(cell == null ? '' : String(cell))}</td>`).join('') + '</tr>').join('');
      return `<h3>${escapeHtml(name)}</h3><table>${body}</table>`;
    }).join('<hr style="page-break-after:always;border:none;height:24px">');
  } else if (ext === 'ods' || ext === 'odt') {
    html = await odfToHtml(buf, ext);
  } else if (ext === 'docx' || ext === 'doc') {
    const head = new Uint8Array(buf.slice(0, 4));
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    if (ext === 'doc' && !isZip) {
      const text = await docToText(buf);
      const html = `<pre style="white-space:pre-wrap;word-break:break-all;font:14px/1.75 'Microsoft YaHei',sans-serif">${escapeHtml(text)}</pre>`;
      return renderHtmlToBlobs(html, onProgress);
    }
    const mammoth = await loadScriptOnce('/vendor/office/mammoth.browser.min.js', 'mammoth');
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = result.value || '<p>（空文档）</p>';
  } else {
    throw new Error('暂不支持该类型，请先转换为 PDF');
  }
  return renderHtmlToBlobs(html, onProgress);
}

// 旧版 .doc（OLE2 复合文档）文本提取
async function docToText(buf) {
  const CFB = await loadScriptOnce('/vendor/office/cfb.js', 'CFB');
  const files = CFB.read(new Uint8Array(buf), { type: 'array' });
  const find = name => (files.FileIndex || []).find(f => f.name === name);
  const wd = find('WordDocument');
  if (!wd) throw new Error('不是有效的 Word 文档');
  const doc = new Uint8Array(wd.content);
  const u16 = o => doc[o] | (doc[o + 1] << 8);
  const u32 = o => (doc[o] | (doc[o + 1] << 8) | (doc[o + 2] << 16) | (doc[o + 3] << 24)) >>> 0;
  const flags = u16(0x0A);
  const table = find(((flags >> 9) & 1) ? '1Table' : '0Table');
  const fcClx = u32(0x01A2), lcbClx = u32(0x01A6);
  if (!table || !lcbClx) {
    const fcMin = u32(0x18), fcMac = u32(0x1C);
    let out = '';
    for (let i = fcMin; i < fcMac && i < doc.length; i++) out += String.fromCharCode(doc[i]);
    return cleanWordText(out);
  }
  const t = new Uint8Array(table.content);
  let p = fcClx;
  const end = Math.min(fcClx + lcbClx, t.length);
  while (p < end) {
    const tag = t[p];
    if (tag === 0x01) {
      const cb = t[p + 1] | (t[p + 2] << 8);
      p += 3 + cb;
    } else if (tag === 0x02) {
      const lcb = (t[p + 1] | (t[p + 2] << 8) | (t[p + 3] << 16) | (t[p + 4] << 24)) >>> 0;
      const plc = p + 5;
      const n = (lcb - 4) / 12;
      const cps = [];
      for (let i = 0; i <= n; i++) {
        cps.push((t[plc + i * 4] | (t[plc + i * 4 + 1] << 8) | (t[plc + i * 4 + 2] << 16) | (t[plc + i * 4 + 3] << 24)) >>> 0);
      }
      const pcd = plc + (n + 1) * 4;
      let out = '';
      for (let i = 0; i < n; i++) {
        const chars = cps[i + 1] - cps[i];
        if (!(chars > 0)) continue;
        const off = pcd + i * 8;
        let fc = (t[off + 2] | (t[off + 3] << 8) | (t[off + 4] << 16) | (t[off + 5] << 24)) >>> 0;
        const compressed = (fc & 0x40000000) !== 0;
        fc = compressed ? (fc & 0x3FFFFFFF) / 2 : fc;
        if (compressed) {
          for (let j = 0; j < chars && fc + j < doc.length; j++) out += String.fromCharCode(doc[fc + j]);
        } else {
          for (let j = 0; j < chars && fc + j * 2 + 1 < doc.length; j++) {
            const o = fc + j * 2;
            out += String.fromCharCode(doc[o] | (doc[o + 1] << 8));
          }
        }
      }
      return cleanWordText(out);
    } else {
      break;
    }
  }
  throw new Error('无法解析 Word 文档结构');
}

function cleanWordText(s) {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function odfToHtml(buf, ext) {
  const fflate = await loadScriptOnce('/vendor/office/fflate.min.js', 'fflate');
  let files;
  try { files = fflate.unzipSync(new Uint8Array(buf)); } catch (e) { throw new Error('无法解压 OpenDocument 文件'); }
  const content = files['content.xml'];
  if (!content) throw new Error('无法读取 OpenDocument 内容');
  const xml = new TextDecoder('utf-8').decode(content);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (ext === 'ods') {
    const tables = doc.getElementsByTagName('table:table');
    let html = '';
    for (let ti = 0; ti < tables.length && ti < 8; ti++) {
      const t = tables[ti];
      const rows = t.getElementsByTagName('table:table-row');
      let body = '';
      for (let ri = 0; ri < rows.length; ri++) {
        const cells = rows[ri].getElementsByTagName('table:table-cell');
        let tr = '';
        for (let ci = 0; ci < cells.length; ci++) {
          const c = cells[ci];
          const text = (c.textContent || '').trim();
          const rep = parseInt(c.getAttribute('table:number-columns-repeated') || '1', 10);
          const n = Math.min(isNaN(rep) ? 1 : rep, 50);
          tr += `<td>${escapeHtml(text)}</td>`.repeat(n);
        }
        body += `<tr>${tr}</tr>`;
      }
      html += `<h3>${escapeHtml(t.getAttribute('table:name') || ('工作表 ' + (ti + 1)))}</h3><table>${body}</table>`;
    }
    return html || '<p>（空表格）</p>';
  }
  // ODT：按文档顺序输出标题与段落
  const body = doc.getElementsByTagName('office:text')[0] || doc.documentElement;
  let html = '';
  const walk = node => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const n = node.childNodes[i];
      if (n.nodeName === 'text:h') html += `<h3>${escapeHtml((n.textContent || '').trim())}</h3>`;
      else if (n.nodeName === 'text:p') html += `<p>${escapeHtml((n.textContent || '').trim())}</p>`;
      else if (n.nodeName === 'table:table') {
        const rows = n.getElementsByTagName('table:table-row');
        let tb = '';
        for (let ri = 0; ri < rows.length; ri++) {
          const cells = rows[ri].getElementsByTagName('table:table-cell');
          let tr = '';
          for (let ci = 0; ci < cells.length; ci++) tr += `<td>${escapeHtml((cells[ci].textContent || '').trim())}</td>`;
          tb += `<tr>${tr}</tr>`;
        }
        html += `<table>${tb}</table>`;
      } else if (n.childNodes && n.childNodes.length) {
        walk(n);
      }
    }
  };
  walk(body);
  return html || '<p>（空文档）</p>';
}

async function renderTextToBlobs(path, onProgress) {
  const res = await fetch('/api/files/content?path=' + encodeURIComponent(path));
  if (!res.ok) throw new Error('读取文件失败');
  const buf = await res.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { text = new TextDecoder('gbk').decode(buf); } catch (e2) { text = new TextDecoder().decode(buf); }
  }
  const html = `<pre style="white-space:pre-wrap;word-break:break-all;font:13.5px/1.75 'Consolas','Menlo',monospace;margin:0">${escapeHtml(text)}</pre>`;
  return renderHtmlToBlobs(html, onProgress);
}

let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/pdfjs/pdf.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('加载 PDF 组件失败'));
      document.head.appendChild(s);
    });
  }
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
  _pdfjs = lib;
  return lib;
}

function parsePageInput(input, total) {
  input = (input || '').trim();
  if (!input) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [];
  const seen = new Set();
  for (const part of input.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes('-')) {
      const segs = p.split('-');
      const a = parseInt(segs[0], 10);
      const b = parseInt(segs[1], 10);
      if (isNaN(a) || isNaN(b) || a <= 0 || b < a) throw new Error('页码范围格式不正确');
      for (let i = a; i <= Math.min(b, total); i++) { if (!seen.has(i)) { seen.add(i); out.push(i); } }
    } else {
      const n = parseInt(p, 10);
      if (isNaN(n) || n <= 0) throw new Error('页码范围格式不正确');
      if (n <= total && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  if (!out.length) throw new Error('页码范围为空');
  return out;
}

async function renderPdfToBlobs(path, pageInput, onProgress) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    url: '/api/files/content?path=' + encodeURIComponent(path),
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  }).promise;
  try {
    const pages = parsePageInput(pageInput, doc.numPages);
    const blobs = [];
    for (let i = 0; i < pages.length; i++) {
      const pageNo = pages[i];
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 3 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('生成页面图片失败')), 'image/jpeg', 0.92);
      });
      blobs.push({ page: pageNo, blob });
      if (onProgress) onProgress(i + 1, pages.length);
    }
    return { blobs, total: doc.numPages };
  } finally {
    try { doc.destroy(); } catch (e) {}
  }
}

// 目录选择器：返回选中的目录路径（取消返回 null）
function pickDirectory(startPath) {
  return new Promise(resolve => {
    const m = $('#modal');
    let cur = startPath || (state.roots[0] && state.roots[0].path) || '';
    const render = async () => {
      let subdirs = [], parent = '';
      try {
        const d = await api('/api/files/list?path=' + encodeURIComponent(cur));
        cur = d.path;
        parent = d.parent;
        subdirs = (d.entries || []).filter(e => e.is_dir);
      } catch (e) { toast(e.message); }
      const roots = state.roots.map(r => `<button class="btn small" data-dp-root="${esc(r.path)}">${esc(r.name)}</button>`).join('');
      m.innerHTML = `<div class="modal-box"><h3 style="margin:0 0 10px;font-size:16px">选择保存位置</h3>
        <div class="hint" style="margin-bottom:8px;word-break:break-all">${esc(cur)}</div>
        <div class="actions" style="margin-bottom:8px">${parent ? '<button class="btn small" id="dp-up">↑ 上一级</button>' : ''}${roots}</div>
        <div class="list" id="dp-list" style="max-height:40vh;overflow:auto"></div>
        <div class="actions" style="justify-content:flex-end;margin-top:12px">
          <button class="btn" id="dp-cancel">取消</button>
          <button class="btn primary" id="dp-ok">保存到此处</button>
        </div></div>`;
      const box = $('#dp-list');
      if (box) {
        box.innerHTML = subdirs.length ? subdirs.map(d => `<div class="rowitem" data-dp-dir="${esc(d.path)}" style="cursor:pointer"><span class="grow"><div class="fname">${esc(d.name)}</div><div class="fsub">文件夹</div></span></div>`).join('') : '<div class="empty">没有子文件夹</div>';
        $$('#dp-list [data-dp-dir]').forEach(el => el.onclick = () => { cur = el.dataset.dpDir; render(); });
      }
      $$('[data-dp-root]').forEach(el => el.onclick = () => { cur = el.dataset.dpRoot; render(); });
      const up = $('#dp-up');
      if (up) up.onclick = () => { cur = parent; render(); };
      $('#dp-cancel').onclick = () => { m.classList.remove('open'); resolve(null); };
      $('#dp-ok').onclick = () => { m.classList.remove('open'); resolve(cur); };
    };
    m.classList.add('open');
    render().catch(() => {});
  });
}

function openFileMenu(path) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-box" style="max-width:420px">
    <div style="font-size:14px;margin-bottom:12px" class="hint">${esc(path)}</div>
    <div class="actions" style="flex-direction:column">
      <button class="btn" id="fm-print">打印</button>
      <button class="btn" id="fm-fav">收藏 / 取消收藏</button>
      <button class="btn" id="fm-close">取消</button>
    </div></div>`;
  m.classList.add('open');
  $('#fm-print').onclick = () => { m.classList.remove('open'); openPrintDialog([{ path, name: path.split('/').pop() }]); };
  $('#fm-fav').onclick = async () => {
    try {
      if (state.favorites && state.favorites.includes(path)) {
        await api('/api/favorites?path=' + encodeURIComponent(path), { method: 'DELETE' });
      } else {
        await api('/api/favorites', { method: 'POST', body: { path, name: path.split('/').pop() } });
      }
      await loadFavorites();
      m.classList.remove('open');
      toast('已更新收藏');
    } catch (e) { toast(e.message); }
  };
  $('#fm-close').onclick = () => m.classList.remove('open');
}

// ---------- 扫描 ----------
async function loadScanners() {
  try { state.scanners = await api('/api/scanners'); } catch (e) { state.scanners = []; }
  if (!state.currentScanner) {
    const def = (state.scanners || []).find(x => x.is_default) || (state.scanners || [])[0];
    state.currentScanner = def ? def.ip : '';
  }
}

async function renderScan(view) {
  view.innerHTML = `<div class="panel"><div class="page-head"><button class="btn ghost small" id="btn-back">← 返回</button><h2 style="margin:0">扫描</h2></div><div class="hint"><span class="spinner"></span> 正在加载扫描仪…</div></div>`;
  await loadScanners();
  view.innerHTML = `<div class="panel">
    <div class="page-head"><button class="btn ghost small" id="btn-back">← 返回</button><h2 style="margin:0">扫描</h2></div>
    <div class="settings-grid">
      <div class="section">
        <h3>扫描仪</h3>
        <div class="list" id="sc-list">加载中…</div>
        <div class="actions" style="margin-top:12px">
          <button class="btn" id="sc-discover">发现扫描仪</button>
          <button class="btn" id="sc-add">手动添加</button>
        </div>
        <div class="hint" id="sc-found" style="margin-top:8px"></div>
        <div class="hint" id="sc-status" style="margin-top:6px"></div>
      </div>
      <div class="section">
        <h3>扫描参数</h3>
        <div class="form">
          <div class="row2">
            <label class="field"><span>分辨率</span><select id="sc-dpi">
              <option value="150">150 dpi（快速）</option>
              <option value="300" selected>300 dpi（标准）</option>
              <option value="600">600 dpi（高清）</option>
            </select></label>
            <label class="field"><span>颜色</span><select id="sc-mode">
              <option value="RGB24">彩色</option>
              <option value="Grayscale8">灰度 / 黑白</option>
            </select></label>
          </div>
          <div class="actions"><button class="btn primary" id="sc-start">开始扫描</button></div>
          <div class="hint" id="sc-progress"></div>
        </div>
      </div>
      <div class="section" style="grid-column:1/-1">
        <h3>扫描结果</h3>
        <div id="sc-result" class="hint">尚未扫描。玻璃板放置文档后点击「开始扫描」。</div>
      </div>
    </div></div>`;
  $('#btn-back').onclick = () => { location.hash = '#/files'; };
  renderScannerList();
  const checkStatus = async () => {
    if (!state.currentScanner) return;
    const el = $('#sc-status');
    el.textContent = '状态检测中…';
    try {
      const r = await api('/api/scanners/status?ip=' + encodeURIComponent(state.currentScanner));
      el.textContent = r.state === 'offline' ? '离线：' + (r.error || '') : '状态：' + r.state;
    } catch (e) { el.textContent = '检测失败：' + e.message; }
  };
  checkStatus();
  $('#sc-discover').onclick = async () => {
    const hint = $('#sc-found');
    let sec = 0;
    hint.innerHTML = '<span class="spinner"></span><span class="search-text">正在搜索扫描仪（优先检查打印机）… 已用 0 秒</span>';
    const timer = setInterval(() => {
      sec++;
      const t = hint.querySelector('.search-text');
      if (t) t.textContent = `正在搜索扫描仪（优先检查打印机）… 已用 ${sec} 秒`;
    }, 1000);
    try {
      const r = await api('/api/scanners/discover');
      clearInterval(timer);
      const list = r.scanners || [];
      if (!list.length) { hint.textContent = `搜索完成（${sec} 秒）：未发现扫描仪`; return; }
      hint.innerHTML = `搜索完成（${sec} 秒），发现 ${list.length} 台，点击添加：` + list.map(x =>
        `<button class="btn small" data-sadd='${esc(JSON.stringify(x))}'>${esc(x.ip)}${x.from_printer ? ' ⭐' : ''}</button>`).join(' ');
      $$('#sc-found [data-sadd]').forEach(b => b.onclick = async () => {
        const x = JSON.parse(b.dataset.sadd);
        try {
          await api('/api/scanners', { method: 'POST', body: { ip: x.ip, name: x.model || x.ip, model: x.model || '' } });
          await loadScanners();
          state.currentScanner = x.ip;
          renderScannerList();
          checkStatus();
          toast('已添加扫描仪');
        } catch (e) { toast(e.message); }
      });
    } catch (e) { clearInterval(timer); hint.textContent = '搜索失败：' + e.message; }
  };
  $('#sc-add').onclick = async () => {
    const ip = prompt('输入扫描仪 IP（如 192.168.3.161）');
    if (!ip) return;
    try {
      await api('/api/scanners', { method: 'POST', body: { ip: ip.trim(), name: ip.trim() } });
      await loadScanners();
      state.currentScanner = ip.trim();
      renderScannerList();
      checkStatus();
    } catch (e) { toast(e.message); }
  };
  $('#sc-start').onclick = async () => {
    if (!state.currentScanner) { toast('请先添加并选择扫描仪'); return; }
    const btn = $('#sc-start');
    btn.disabled = true; btn.textContent = '扫描中…';
    $('#sc-progress').innerHTML = '<span class="spinner"></span> 正在扫描，请稍候…';
    try {
      const r = await api('/api/scanners/scan', { method: 'POST', body: {
        ip: state.currentScanner,
        dpi: Number($('#sc-dpi').value) || 300,
        color_mode: $('#sc-mode').value,
        format: 'image/jpeg',
      } });
      $('#sc-progress').textContent = '';
      $('#sc-result').innerHTML = `<div class="hint">已保存：${esc(r.name)} · ${fmtSize(r.size)} · ${r.dpi} dpi</div>
        <img src="/api/files/content?path=${encodeURIComponent(r.path)}" style="max-width:100%;border-radius:10px;margin-top:10px;display:block">
        <div class="actions" style="margin-top:12px">
          <button class="btn primary" id="sc-print">打印这份扫描件</button>
          <button class="btn" id="sc-again">继续扫描</button>
        </div>`;
      $('#sc-print').onclick = () => openPrintDialog([{ path: r.path, name: r.name }]);
      $('#sc-again').onclick = () => $('#sc-start').click();
      openPrintDialog([{ path: r.path, name: r.name }]);
    } catch (e) { toast(e.message, 5000); $('#sc-progress').textContent = ''; }
    finally { btn.disabled = false; btn.textContent = '开始扫描'; }
  };
}

function renderScannerList() {
  const box = $('#sc-list');
  if (!box) return;
  const list = state.scanners || [];
  if (!list.length) {
    box.innerHTML = '<div class="hint">尚未添加扫描仪，点「发现扫描仪」或「手动添加」。</div>';
    return;
  }
  box.innerHTML = list.map(x => `<div class="rowitem">
    <span class="grow" data-pick="${esc(x.ip)}" style="cursor:pointer">
      <div class="fname">${esc(x.name || x.ip)} ${state.currentScanner === x.ip ? '<span class="badge done">已选</span>' : ''} ${x.is_default ? '<span class="badge">默认</span>' : ''}</div>
      <div class="fsub">${esc(x.ip)}${x.model ? ' · ' + esc(x.model) : ''}</div>
    </span>
    <button class="btn small" data-sdef="${esc(x.id)}">设为默认</button>
    <button class="btn small danger" data-sdel="${esc(x.id)}">删除</button>
  </div>`).join('');
  $$('#sc-list [data-pick]').forEach(el => el.onclick = () => {
    state.currentScanner = el.dataset.pick;
    renderScannerList();
    const st = $('#sc-status');
    if (st) st.textContent = '状态检测中…';
    api('/api/scanners/status?ip=' + encodeURIComponent(state.currentScanner)).then(r => {
      if (st) st.textContent = r.state === 'offline' ? '离线：' + (r.error || '') : '状态：' + r.state;
    }).catch(() => {});
  });
  $$('#sc-list [data-sdef]').forEach(b => b.onclick = async () => {
    try { await api('/api/scanners/default', { method: 'POST', body: { id: b.dataset.sdef } }); await loadScanners(); renderScannerList(); toast('已设为默认'); } catch (e) { toast(e.message); }
  });
  $$('#sc-list [data-sdel]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('确认删除该扫描仪？', '删除')) return;
    try {
      await api('/api/scanners/' + encodeURIComponent(b.dataset.sdel), { method: 'DELETE' });
      await loadScanners();
      if (!state.scanners.some(x => x.ip === state.currentScanner)) state.currentScanner = (state.scanners[0] || {}).ip || '';
      renderScannerList();
    } catch (e) { toast(e.message); }
  });
}

// ---------- 队列与历史 ----------
async function renderQueue(view) {
  view.innerHTML = `<div class="panel"><div class="page-head"><button class="btn ghost small" id="btn-back">← 返回</button><h3 style="margin:0">打印队列</h3></div><div class="hint" style="margin-bottom:10px">队列每 3 秒自动刷新；排队中的任务可取消。</div><div class="list" id="job-list">加载中…</div></div>`;
  await loadJobs();
  state.queueTimer = setInterval(() => { if (location.hash === '#/queue') loadJobs(); }, 3000);
}

async function loadJobs() {
  try { state.jobs = await api('/api/jobs'); } catch (e) { state.jobs = []; }
  renderJobList();
}

function renderJobList() {
  const box = $('#job-list');
  if (!box) return;
  const jobs = state.jobs || [];
  if (!jobs.length) { box.innerHTML = '<div class="empty">暂无打印任务</div>'; return; }
  box.innerHTML = jobs.map(j => {
    const badgeCls = j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : (j.status === 'printing' || j.status === 'processing') ? 'printing' : 'queued';
    const statusText = { queued: '排队中', processing: '处理中', printing: '打印中', done: '已完成', failed: '失败', canceled: '已取消' }[j.status] || j.status;
    const actions = j.status === 'queued' ? `<button class="btn small danger" data-cancel="${esc(j.id)}">取消</button>`
      : j.status === 'failed' || j.status === 'canceled' ? `<button class="btn small" data-retry="${esc(j.id)}">重试</button>` : '';
    return `<div class="rowitem">
      <span class="grow"><div class="fname">${esc(j.file_name)}</div>
      <div class="fsub">${esc(j.printer_name || j.printer_ip)} · ${j.copies} 份 · ${esc(j.paper)}${j.pages ? ' · 第 ' + esc(j.pages) + ' 页' : ''} · ${fmtTime(j.created_at)}${j.error ? ' · ' + esc(j.error) : ''}</div></span>
      <span class="badge ${badgeCls}">${statusText}</span>${actions}</div>`;
  }).join('');
  $$('#job-list [data-cancel]').forEach(b => b.onclick = async () => {
    try { await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('已取消'); loadJobs(); } catch (e) { toast(e.message); }
  });
  $$('#job-list [data-retry]').forEach(b => b.onclick = async () => {
    try { await api(`/api/jobs/${b.dataset.retry}/retry`, { method: 'POST' }); toast('已重新排队'); loadJobs(); } catch (e) { toast(e.message); }
  });
}

async function renderHistory(view) {
  view.innerHTML = `<div class="panel"><div class="page-head"><button class="btn ghost small" id="btn-back">← 返回</button><h3 style="margin:0">打印历史</h3></div><div class="list" id="job-list">加载中…</div></div>`;
  await loadJobs();
  const box = $('#job-list');
  if (!box) return;
  const jobs = (state.jobs || []).filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'canceled');
  if (!jobs.length) { box.innerHTML = '<div class="empty">暂无历史记录</div>'; return; }
  box.innerHTML = jobs.map(j => {
    const badgeCls = j.status === 'done' ? 'done' : 'failed';
    const statusText = { done: '已完成', failed: '失败', canceled: '已取消', processing: '处理中', printing: '打印中' }[j.status] || j.status;
    return `<div class="rowitem">
      <span class="grow"><div class="fname">${esc(j.file_name)}</div>
      <div class="fsub">${esc(j.printer_name || j.printer_ip)} · ${j.copies} 份 · ${esc(j.paper)}${j.pages ? ' · 第 ' + esc(j.pages) + ' 页' : ''} · ${fmtTime(j.created_at)}${j.error ? ' · ' + esc(j.error) : ''}</div></span>
      <span class="badge ${badgeCls}">${statusText}</span></div>`;
  }).join('');
}

// ---------- 设置 ----------
async function renderSettings(view) {
  view.innerHTML = `<div class="panel"><div class="page-head"><button class="btn ghost small" id="btn-back">← 返回</button><h2 style="margin:0">设置</h2></div><div class="hint"><span class="spinner"></span> 正在加载设置…</div></div>`;
  let status = null;
  if (state.defaultPrinter) {
    try { status = await api('/api/printers/status?ip=' + encodeURIComponent(state.defaultPrinter.ip)); } catch (e) {}
  }
  view.innerHTML = `<div class="panel">
    <div class="page-head">
      <button class="btn ghost small" id="btn-back">← 返回</button>
      <h2 style="margin:0">设置</h2>
    </div>
    <div class="settings-grid">
      <div class="section">
        <h3>可访问文件夹</h3>
        <div class="hint" style="margin-bottom:8px">授权步骤：<b>控制面板 → 关于本机 → 应用 → 打印 → 可访问文件夹</b>，添加需要打印的文件夹并保存，然后重启应用。</div>
        <div class="hint" id="access-status">检测中…</div>
        <div class="actions" style="margin-top:10px">
          <button class="btn" id="btn-refresh-access">刷新授权状态</button>
        </div>
      </div>
      <div class="section">
        <h3>打印机</h3>
        <div id="printer-list" class="list">加载中…</div>
        <div class="actions" style="margin-top:12px">
          <button class="btn" id="btn-discover">发现打印机</button>
          <button class="btn" id="btn-add-printer">手动添加</button>
          <button class="btn" id="btn-test">打印测试页</button>
        </div>
        <div class="hint" id="discover-hint" style="margin-top:8px"></div>
        ${status ? `<div class="hint" style="margin-top:8px">当前状态：${esc(status.state)}${status.reasons && status.reasons.length ? ' · ' + esc(status.reasons.join(', ')) : ''}</div>` : ''}
      </div>
      <div class="section">
        <h3>默认打印参数</h3>
        <div class="form">
          <div class="row2">
            <label class="field"><span>份数</span><input id="set-copies" type="number" min="1" value="${esc(state.settings.default_copies || '1')}"></label>
            <label class="field"><span>纸张</span><select id="set-paper">
              <option value="A4" ${state.settings.default_paper !== 'Letter' ? 'selected' : ''}>A4</option>
              <option value="Letter" ${state.settings.default_paper === 'Letter' ? 'selected' : ''}>Letter</option>
            </select></label>
          </div>
          <div class="row2">
            <label class="field"><span>单双面</span><select id="set-duplex">
              <option value="false" ${state.settings.default_duplex !== 'true' ? 'selected' : ''}>单面</option>
              <option value="true" ${state.settings.default_duplex === 'true' ? 'selected' : ''}>双面</option>
            </select></label>
            <label class="field"><span>颜色</span><select id="set-color">
              <option value="false" ${state.settings.default_color !== 'true' ? 'selected' : ''}>黑白</option>
              <option value="true" ${state.settings.default_color === 'true' ? 'selected' : ''}>彩色</option>
            </select></label>
          </div>
          <label class="field"><span>缩放</span><select id="set-scale">
            <option value="fit" ${state.settings.default_scale !== 'actual' ? 'selected' : ''}>适应页面</option>
            <option value="actual" ${state.settings.default_scale === 'actual' ? 'selected' : ''}>实际大小</option>
          </select></label>
          <div class="actions"><button class="btn primary" id="btn-save-settings">保存</button></div>
        </div>
      </div>
      <div class="section">
        <h3>快捷入口</h3>
        <div class="actions">
          <button class="btn" id="btn-recents">最近打印</button>
          <button class="btn" id="btn-favorites">我的收藏</button>
          <button class="btn" id="btn-upload2">上传文件</button>
        </div>
        <div class="list" id="quick-list" style="margin-top:10px"></div>
      </div>
    </div>
    <div class="hint" style="margin-top:14px;text-align:center">打印助手 v${esc((state.meta && state.meta.version) || '')}</div>
  </div>`;
  renderPrinterList();
  refreshAccessStatus();
  $('#btn-refresh-access').onclick = async () => { await refreshMeta(); refreshAccessStatus(); toast('已刷新授权状态'); };
  $('#btn-discover').onclick = discoverPrinters;
  $('#btn-add-printer').onclick = addPrinterDialog;
  $('#btn-test').onclick = async () => {
    if (!state.printers.length) { toast('请先添加打印机', 3200); return; }
    try {
      await api('/api/print/test', { method: 'POST', body: {} });
      toast('测试页已加入队列');
      location.hash = '#/queue';
    } catch (e) { toast(e.message, 3600); }
  };
  $('#btn-save-settings').onclick = async () => {
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: {
        default_copies: $('#set-copies').value,
        default_paper: $('#set-paper').value,
        default_duplex: $('#set-duplex').value,
        default_color: $('#set-color').value,
        default_scale: $('#set-scale').value,
      } });
      toast('已保存');
    } catch (e) { toast(e.message); }
  };
  $('#btn-recents').onclick = () => showQuick('recents');
  $('#btn-favorites').onclick = () => showQuick('favorites');
  $('#btn-upload2').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.pdf,.jpg,.jpeg,.png,.webp';
    inp.onchange = async () => {
      const uploaded = [];
      for (const f of Array.from(inp.files || [])) {
        const fd = new FormData(); fd.append('file', f);
        try {
          const r = await api('/api/files/upload?temp=1', { method: 'POST', body: fd });
          uploaded.push({ path: r.path, name: r.name, temp: true });
        } catch (e) { toast(f.name + '：' + e.message); }
      }
      if (uploaded.length) openPrintDialog(uploaded);
    };
    inp.click();
  };
}

function renderPrinterList() {
  const box = $('#printer-list');
  if (!box) return;
  if (!state.printers.length) {
    box.innerHTML = '<div class="empty">尚未添加打印机，点「发现打印机」或「手动添加」</div>';
    return;
  }
  box.innerHTML = state.printers.map(p => `<div class="rowitem">
    <span class="grow"><div class="fname">${esc(p.name)} ${p.is_default ? '· 默认' : ''}</div>
    <div class="fsub">${esc(p.ip)} · ${esc(p.model || p.protocol)}</div></span>
    <button class="btn small" data-def="${esc(p.id)}">设为默认</button>
    <button class="btn small danger" data-del="${esc(p.id)}">删除</button>
  </div>`).join('');
  $$('#printer-list [data-def]').forEach(b => b.onclick = async () => {
    try { await api('/api/printers/default', { method: 'POST', body: { id: b.dataset.def } }); await loadPrinters(); renderSettings($('#view')); toast('已设为默认'); } catch (e) { toast(e.message); }
  });
  $$('#printer-list [data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmDialog('确认删除该打印机？', '删除')) return;
    try { await api('/api/printers/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); await loadPrinters(); renderSettings($('#view')); } catch (e) { toast(e.message); }
  });
}

async function discoverPrinters() {
  const hint = $('#discover-hint');
  const listBox = $('#printer-list');
  let sec = 0;
  if (hint) hint.innerHTML = '<span class="spinner"></span><span class="search-text">正在搜索局域网打印机… 已用 0 秒</span>';
  const timer = setInterval(() => {
    sec++;
    const t = hint && hint.querySelector('.search-text');
    if (t) t.textContent = `正在搜索局域网打印机… 已用 ${sec} 秒`;
  }, 1000);
  try {
    const r = await api('/api/printers/discover');
    clearInterval(timer);
    const list = r.printers || [];
    if (!list.length) {
      if (hint) hint.textContent = `搜索完成（${sec} 秒）：未发现打印机，可手动添加 IP`;
      return;
    }
    if (hint) hint.innerHTML = `搜索完成（${sec} 秒），发现 ${list.length} 台，点击添加：`;
    const items = list.map(p => `<button class="btn small" data-found='${esc(JSON.stringify(p))}'>${esc(p.name)}（${esc(p.ip)}）</button>`).join(' ');
    if (hint) hint.innerHTML += ' ' + items;
    if (listBox) {
      listBox.innerHTML = list.map(p => `<div class="rowitem">
        <span class="grow"><div class="fname">${esc(p.name)}</div>
        <div class="fsub">${esc(p.ip)} · ${esc(p.model || '')} ${p.protocol ? '· ' + esc(p.protocol) : ''}</div></span>
        <button class="btn small primary" data-addfound='${esc(JSON.stringify(p))}'>添加</button></div>`).join('');
      $$('#printer-list [data-addfound]').forEach(b => b.onclick = () => addFoundPrinter(JSON.parse(b.dataset.addfound)));
    }
    $$('#discover-hint [data-found]').forEach(b => b.onclick = () => addFoundPrinter(JSON.parse(b.dataset.found)));
  } catch (e) {
    clearInterval(timer);
    if (hint) hint.textContent = '搜索失败：' + e.message;
  }
}

async function addFoundPrinter(p) {
  try {
    await api('/api/printers', { method: 'POST', body: { ip: p.ip, name: p.name, model: p.model, protocol: p.protocol } });
    toast('已添加 ' + p.ip);
    await loadPrinters();
    renderSettings($('#view'));
  } catch (e) { toast(e.message); }
}

function addPrinterDialog() {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-box" style="max-width:440px">
    <h3 style="margin:0 0 12px;font-size:16px">手动添加打印机</h3>
    <div class="form">
      <label class="field"><span>IP 地址</span><input id="np-ip" placeholder="192.168.3.161"></label>
      <label class="field"><span>名称（可选）</span><input id="np-name" placeholder="客厅打印机"></label>
      <label class="field"><span>协议</span><select id="np-proto"><option value="ipp">IPP / AirPrint（推荐）</option><option value="raw">RAW 9100</option></select></label>
      <div class="actions"><button class="btn" id="np-cancel">取消</button><button class="btn primary" id="np-ok">添加</button></div>
    </div></div>`;
  m.classList.add('open');
  $('#np-cancel').onclick = () => m.classList.remove('open');
  $('#np-ok').onclick = async () => {
    const ip = $('#np-ip').value.trim();
    if (!ip) { toast('请填写 IP'); return; }
    try {
      await api('/api/printers', { method: 'POST', body: { ip, name: $('#np-name').value.trim() || ip, protocol: $('#np-proto').value } });
      toast('已添加');
      m.classList.remove('open');
      await loadPrinters();
      renderSettings($('#view'));
    } catch (e) { toast(e.message); }
  };
}

async function showQuick(kind) {
  const box = $('#quick-list');
  if (!box) return;
  const path = kind === 'favorites' ? '/api/favorites' : '/api/recents';
  try {
    const items = await api(path);
    if (!items || !items.length) { box.innerHTML = '<div class="empty">暂无记录</div>'; return; }
    box.innerHTML = items.map(it => `<div class="rowitem">
      <span class="grow"><div class="fname">${esc(it.name)}</div><div class="fsub">${esc(it.path)}</div></span>
      <button class="btn small primary" data-print="${esc(it.path)}">打印</button>
    </div>`).join('');
    $$('#quick-list [data-print]').forEach(b => b.onclick = () => openPrintDialog([{ path: b.dataset.print, name: b.dataset.print.split('/').pop() }]));
  } catch (e) { box.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}

async function loadFavorites() {
  try { state.favorites = (await api('/api/favorites') || []).map(f => f.path); } catch (e) { state.favorites = []; }
}

async function refreshMeta() {
  try { state.meta = await api('/api/meta'); } catch (e) {}
}

function refreshAccessStatus() {
  const el = $('#access-status');
  if (!el) return;
  const m = state.meta || {};
  if (m.shared_ready) {
    el.innerHTML = `已检测到授权文件夹：<b>${esc((m.shared_entries || []).join('、'))}</b>`;
  } else if (m.shared_dir) {
    el.innerHTML = `授权目录已挂载（${esc(m.shared_dir)}），但尚未添加具体文件夹；请按上方步骤添加并重启应用。`;
  } else {
    el.innerHTML = '尚未检测到授权文件夹。当前仅可使用「上传文件」中的内容。';
  }
}

async function showQuick2(kind) {
  const m = $('#modal');
  const path = kind === 'favorites' ? '/api/favorites' : '/api/recents';
  m.innerHTML = `<div class="modal-box"><h3 style="margin:0 0 12px;font-size:16px">${kind === 'favorites' ? '我的收藏' : '最近打印'}</h3>
    <div class="list" id="quick2-list">加载中…</div>
    <div class="actions" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="quick2-close">关闭</button></div></div>`;
  m.classList.add('open');
  $('#quick2-close').onclick = () => m.classList.remove('open');
  try {
    const items = await api(path);
    const box = $('#quick2-list');
    if (!items || !items.length) { box.innerHTML = '<div class="empty">暂无记录</div>'; return; }
    box.innerHTML = items.map(it => `<div class="rowitem">
      <span class="grow"><div class="fname">${esc(it.name)}</div><div class="fsub">${esc(it.path)}</div></span>
      <button class="btn small primary" data-qprint="${esc(it.path)}">打印</button></div>`).join('');
    $$('#quick2-list [data-qprint]').forEach(b => b.onclick = () => {
      m.classList.remove('open');
      openPrintDialog([{ path: b.dataset.qprint, name: b.dataset.qprint.split('/').pop() }]);
    });
  } catch (e) { $('#quick2-list').innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}

// ---------- 初始化 ----------
function bindNav() {
  $$('#tabbar [data-nav], #topbar [data-nav]').forEach(el => {
    el.onclick = e => {
      e.preventDefault();
      const target = el.dataset.nav;
      if (location.hash !== target) location.hash = target;
      else route();
    };
  });
}

// 顶栏：logo 回主页、打印机列表、多选
function bindTopbar() {
  document.addEventListener('click', e => {
    if (e.target.closest('#btn-home')) {
      e.preventDefault();
      if ((location.hash || '#/files') !== '#/files') location.hash = '#/files';
      else route();
      return;
    }
    if (e.target.closest('#btn-printer')) { e.preventDefault(); openPrinterDialog(); return; }
  });
}

function toggleSelectMode() {
  if ((location.hash || '#/files') !== '#/files') { location.hash = '#/files'; }
  state.selectMode = !state.selectMode;
  if (!state.selectMode) state.selected.clear();
  setTimeout(() => { renderFilesView(); renderSelBar(); }, 40);
}

async function openPrinterDialog() {
  try {
    const m = $('#modal');
    m.classList.add('open');
    m.innerHTML = `<div class="modal-box"><h3 style="margin:0 0 12px;font-size:16px">打印机与队列</h3>
      <div class="list" id="pd-list">加载中…</div>
      <h3 style="margin:16px 0 8px;font-size:14px">最近任务</h3>
      <div class="list" id="pd-jobs">加载中…</div>
      <div class="actions" style="justify-content:space-between;margin-top:14px">
        <button class="btn" id="pd-queue">查看打印队列</button>
        <div class="actions">
          <button class="btn" id="pd-settings">打印机设置</button>
          <button class="btn" id="pd-close">关闭</button>
        </div>
      </div></div>`;
    $('#pd-close').onclick = () => m.classList.remove('open');
    $('#pd-settings').onclick = () => { m.classList.remove('open'); location.hash = '#/settings'; };
    $('#pd-queue').onclick = () => { m.classList.remove('open'); location.hash = '#/queue'; };
    const list = await api('/api/printers');
    const box = $('#pd-list');
    if (!list.length) { box.innerHTML = '<div class="empty">尚未添加打印机，请到设置页发现或添加</div>'; return; }
    box.innerHTML = list.map(p => `<div class="rowitem">
      <span class="grow"><div class="fname">${esc(p.name)} ${p.is_default ? '<span class="badge done">默认</span>' : ''}</div>
      <div class="fsub">${esc(p.ip)} · ${esc(p.model || p.protocol)}</div></span>
      ${p.is_default ? '' : `<button class="btn small" data-pdef="${esc(p.id)}">设为默认</button>`}
    </div>`).join('');
    $$('#pd-list [data-pdef]').forEach(b => b.onclick = async () => {
      try { await api('/api/printers/default', { method: 'POST', body: { id: b.dataset.pdef } }); await loadPrinters(); openPrinterDialog(); toast('已设为默认'); } catch (e) { toast(e.message); }
    });
    try {
      const jobs = await api('/api/jobs');
      const jb = $('#pd-jobs');
      if (jb) {
        const recent = (jobs || []).slice(0, 3);
        jb.innerHTML = recent.length ? recent.map(j => {
          const t = { queued: '排队中', processing: '处理中', printing: '打印中', done: '已完成', failed: '失败', canceled: '已取消' }[j.status] || j.status;
          return `<div class="rowitem"><span class="grow"><div class="fname">${esc(j.file_name)}</div>
            <div class="fsub">${esc(j.printer_name || j.printer_ip)} · ${fmtTime(j.created_at)}</div></span>
            <span class="badge ${j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : 'queued'}">${t}</span></div>`;
        }).join('') : '<div class="empty">暂无打印任务</div>';
      }
    } catch (e2) {}
  } catch (e) {
    try { $('#pd-list').innerHTML = `<div class="hint">${esc(e.message)}</div>`; } catch (e3) {}
  }
}

async function init() {
  bindNav();
  bindTopbar();
  const pb = $('#btn-printer');
  if (pb) pb.addEventListener('click', () => openPrinterDialog());
  $$('#topbar [data-nav]').forEach(el => {
    el.onclick = e => { e.preventDefault(); if (location.hash !== el.dataset.nav) location.hash = el.dataset.nav; };
  });
  const hb = $('#btn-home');
  if (hb) hb.addEventListener('click', () => { if ((location.hash || '#/files') !== '#/files') location.hash = '#/files'; else route(); });
  try {
    state.meta = await api('/api/meta');
    state.settings = state.meta.settings || {};
  } catch (e) { toast('初始化失败：' + e.message, 4000); }
  await loadPrinters();
  await loadFavorites();
  route();
}

document.addEventListener('click', e => {
  if (e.target.id === 'modal') $('#modal').classList.remove('open');
});
window.addEventListener('hashchange', () => { if (location.hash !== '#/queue' && state.queueTimer) { clearInterval(state.queueTimer); state.queueTimer = null; } });

init();
