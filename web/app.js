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
  await loadDir(state.cwd);
  renderTree();
}

async function loadDir(path) {
  try {
    const data = await api('/api/files/list?path=' + encodeURIComponent(path));
    state.cwd = data.path;
    state.entries = data.entries || [];
    state.parent = data.parent;
    renderFilesView();
  } catch (e) { toast(e.message); }
}

function renderTree() {
  const tree = $('#tree');
  if (!tree) return;
  const roots = state.roots.map(r => `
    <div class="tree-item ${state.cwd === r.path ? 'active' : ''}" data-root="${esc(r.path)}">
      <span class="ico">📁</span><span class="name">${esc(r.name)}</span>
    </div>`).join('');
  const subDirs = state.entries.filter(e => e.is_dir).map(e => `
    <div class="tree-item tree-sub" data-dir="${esc(e.path)}">
      <span class="ico">📁</span><span class="name">${esc(e.name)}</span>
    </div>`).join('');
  tree.innerHTML = `<div class="tree-title">存储位置</div>${roots}${subDirs ? `<div class="tree-title" style="margin-top:10px">当前目录</div>${subDirs}` : ''}`;
  $$('#tree .tree-item').forEach(el => {
    el.onclick = () => {
      if (el.dataset.root) loadDir(el.dataset.root);
      else loadDir(el.dataset.dir);
    };
  });
}

function renderBreadcrumb() {
  const box = $('#crumbs');
  if (!box) return;
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
  let entries = state.entries;
  if (state.filter !== 'all') entries = entries.filter(e => e.is_dir || e.kind === state.filter);
  if (!entries.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">此目录没有可显示的文件</div>`;
  } else {
    grid.innerHTML = entries.map(e => {
      if (e.is_dir) {
        return `<div class="file-card" data-dir="${esc(e.path)}">
          <div class="thumb" style="font-size:34px">📁</div>
          <div class="meta"><div class="fname">${esc(e.name)}</div><div class="fsub">文件夹</div></div>
        </div>`;
      }
      const sel = state.selected.has(e.path);
      const thumb = e.kind === 'image'
        ? `<img loading="lazy" src="/api/files/content?path=${encodeURIComponent(e.path)}" alt="">`
        : e.kind === 'pdf' ? `<span class="badge">PDF</span>`
        : e.kind === 'office' ? `<span class="badge office">OFFICE</span>`
        : `<span class="badge" style="background:#8e8e93">文件</span>`;
      const star = state.favorites && state.favorites.includes(e.path) ? '<span class="star">★</span>' : '';
      return `<div class="file-card ${sel ? 'selected' : ''}" data-file="${esc(e.path)}" data-kind="${esc(e.kind)}">
        <div class="thumb">${thumb}${state.selectMode ? '<span class="pick"></span>' : ''}${star}</div>
        <div class="meta"><div class="fname" title="${esc(e.name)}">${esc(e.name)}</div>
        <div class="fsub">${fmtSize(e.size)} · ${fmtTime(e.mod_time)}</div></div>
      </div>`;
    }).join('');
  }
  $$('#grid .file-card').forEach(card => {
    card.onclick = e => {
      if (card.dataset.dir) { loadDir(card.dataset.dir); return; }
      const path = card.dataset.file;
      if (state.selectMode) { toggleSelect(path); return; }
      if (card.dataset.kind === 'office') {
        toast('暂不支持直接打印 Office 文件，请先转换为 PDF', 3200);
        return;
      }
      openPrintDialog([{ path, name: card.querySelector('.fname').textContent }]);
    };
    card.oncontextmenu = e => { e.preventDefault(); openFileMenu(card.dataset.file); };
  });
  renderFileActions();
}

function renderFileActions() {
  const box = $('#file-actions');
  if (!box) return;
  box.innerHTML = `
    <button class="btn small" id="btn-recent">最近</button>
    <button class="btn small" id="btn-favs">收藏</button>
    <button class="btn small" id="btn-refresh">刷新</button>
    <button class="btn small primary" id="btn-upload">上传</button>
    <input type="file" id="file-input" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp">
    <button class="btn small" id="btn-url">链接</button>`;
  $('#btn-recent').onclick = () => showQuick2('recents');
  $('#btn-favs').onclick = () => showQuick2('favorites');
  $('#btn-refresh').onclick = () => loadDir(state.cwd);
  $('#btn-upload').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async () => {
    const files = Array.from($('#file-input').files || []);
    if (!files.length) return;
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      try { await api('/api/files/upload', { method: 'POST', body: fd }); } catch (e) { toast(f.name + '：' + e.message); }
    }
    toast('上传完成');
    loadDir(state.cwd);
  };
  $('#btn-url').onclick = async () => {
    const url = prompt('输入文件链接（http/https）');
    if (!url) return;
    try {
      const r = await api('/api/files/fetch-url', { method: 'POST', body: { url } });
      toast('已下载：' + r.name);
      loadDir(state.cwd);
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
  const preview = isImage
    ? `<img src="/api/files/content?path=${encodeURIComponent(first.path)}" alt="">`
    : `<iframe src="/api/files/content?path=${encodeURIComponent(first.path)}"></iframe>`;
  const m = $('#modal');
  m.innerHTML = `<div class="modal-box">
    <h3 style="margin:0 0 12px;font-size:16px">打印${files.length > 1 ? `（${files.length} 个文件）` : ''}</h3>
    <div class="print-dialog">
      <div class="preview">${preview}</div>
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
        <label class="field"><span>缩放</span><select id="pr-scale">
          <option value="fit" ${s.default_scale !== 'actual' ? 'selected' : ''}>适应页面</option>
          <option value="actual" ${s.default_scale === 'actual' ? 'selected' : ''}>实际大小</option>
        </select></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="pr-save" style="width:auto"> <span>保存为默认参数</span>
        </label>
        <div class="actions">
          <button class="btn" id="pr-cancel">取消</button>
          <button class="btn" id="pr-test">打印测试页</button>
          <button class="btn primary" id="pr-ok">打印</button>
        </div>
      </div>
    </div></div>`;
  m.classList.add('open');
  $('#pr-cancel').onclick = () => m.classList.remove('open');
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
      save_as_default: $('#pr-save').checked,
    };
    const btn = $('#pr-ok');
    const oldText = btn.textContent;
    btn.disabled = true;
    try {
      let created = 0;
      for (const f of files) {
        if (/\.pdf$/i.test(f.path)) {
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
      const doc = await pdfjs.getDocument({ url: '/api/files/content?path=' + encodeURIComponent(first.path) }).promise;
      const input = $('#pr-pages');
      if (input) input.placeholder = `全部（共 ${doc.numPages} 页）；例如 1-3,5`;
      try { doc.destroy(); } catch (e) {}
    }).catch(() => {});
  }
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
  const doc = await pdfjs.getDocument({ url: '/api/files/content?path=' + encodeURIComponent(path) }).promise;
  try {
    const pages = parsePageInput(pageInput, doc.numPages);
    const blobs = [];
    for (let i = 0; i < pages.length; i++) {
      const pageNo = pages[i];
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 2 });
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
async function renderScan(view) {
  const st = state.settings || {};
  view.innerHTML = `<div class="panel">
    <div class="page-head"><button class="btn ghost small" id="btn-back">← 返回</button><h2 style="margin:0">扫描</h2></div>
    <div class="settings-grid">
      <div class="section">
        <h3>扫描仪</h3>
        <div class="row2">
          <input id="sc-ip" value="${esc(st.scanner_host || '')}" placeholder="扫描仪 IP，如 192.168.3.161">
          <button class="btn" id="sc-discover">发现扫描仪</button>
        </div>
        <div class="hint" id="sc-status" style="margin-top:8px">${st.scanner_host ? '检测中…' : '请先填写或发现扫描仪'}</div>
        <div class="hint" id="sc-found" style="margin-top:6px"></div>
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
  const ipInput = $('#sc-ip');
  $('#sc-discover').onclick = async () => {
    const hint = $('#sc-found');
    let sec = 0;
    hint.innerHTML = '<span class="spinner"></span><span class="search-text">正在搜索扫描仪… 已用 0 秒</span>';
    const timer = setInterval(() => {
      sec++;
      const t = hint.querySelector('.search-text');
      if (t) t.textContent = `正在搜索扫描仪… 已用 ${sec} 秒`;
    }, 1000);
    try {
      const r = await api('/api/scanners/discover');
      clearInterval(timer);
      const list = r.scanners || [];
      if (!list.length) { hint.textContent = `搜索完成（${sec} 秒）：未发现扫描仪`; return; }
      hint.innerHTML = `搜索完成（${sec} 秒），发现 ${list.length} 台：` + list.map(x =>
        `<button class="btn small" data-sip="${esc(x.ip)}">${esc(x.ip)} · ${esc(x.model)}</button>`).join(' ');
      $$('#sc-found [data-sip]').forEach(b => b.onclick = () => {
        ipInput.value = b.dataset.sip;
        checkScannerStatus();
      });
    } catch (e) { clearInterval(timer); hint.textContent = '搜索失败：' + e.message; }
  };
  const checkScannerStatus = async () => {
    const ip = ipInput.value.trim();
    if (!ip) return;
    const el = $('#sc-status');
    el.textContent = '检测中…';
    try {
      const r = await api('/api/scanners/status?ip=' + encodeURIComponent(ip));
      el.textContent = r.state === 'offline' ? '离线：' + (r.error || '') : '状态：' + r.state;
    } catch (e) { el.textContent = '检测失败：' + e.message; }
  };
  ipInput.onchange = checkScannerStatus;
  if (st.scanner_host) checkScannerStatus();
  $('#sc-start').onclick = async () => {
    const ip = ipInput.value.trim();
    if (!ip) { toast('请填写扫描仪 IP'); return; }
    const btn = $('#sc-start');
    btn.disabled = true; btn.textContent = '扫描中…';
    $('#sc-progress').innerHTML = '<span class="spinner"></span> 正在扫描，请稍候…';
    try {
      const r = await api('/api/scanners/scan', { method: 'POST', body: {
        ip,
        dpi: Number($('#sc-dpi').value) || 300,
        color_mode: $('#sc-mode').value,
        format: 'image/jpeg',
      } });
      try { await api('/api/settings', { method: 'PUT', body: { scanner_host: ip } }); } catch (e2) {}
      if (state.settings) state.settings.scanner_host = ip;
      $('#sc-progress').textContent = '';
      $('#sc-result').innerHTML = `<div class="hint">已保存：${esc(r.name)} · ${fmtSize(r.size)} · ${r.dpi} dpi</div>
        <img src="/api/files/content?path=${encodeURIComponent(r.path)}" style="max-width:100%;border-radius:10px;margin-top:10px;display:block">
        <div class="actions" style="margin-top:12px">
          <button class="btn primary" id="sc-print">打印这份扫描件</button>
          <button class="btn" id="sc-again">继续扫描</button>
        </div>`;
      $('#sc-print').onclick = () => openPrintDialog([{ path: r.path, name: r.name }]);
      $('#sc-again').onclick = () => $('#sc-start').click();
    } catch (e) { toast(e.message, 5000); $('#sc-progress').textContent = ''; }
    finally { btn.disabled = false; btn.textContent = '开始扫描'; }
  };
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
      for (const f of Array.from(inp.files || [])) {
        const fd = new FormData(); fd.append('file', f);
        try { await api('/api/files/upload', { method: 'POST', body: fd }); } catch (e) { toast(f.name + '：' + e.message); }
      }
      toast('上传完成'); loadDir(state.cwd);
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
    if (e.target.closest('#btn-select')) { e.preventDefault(); toggleSelectMode(); return; }
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
  const sb = $('#btn-select');
  if (sb) sb.addEventListener('click', () => toggleSelectMode());
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
