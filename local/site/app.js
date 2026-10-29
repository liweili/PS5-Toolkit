/*
 * PS5 插件更新中心 - 前端逻辑
 * 纯原生 JS，无外部依赖。
 */
const $ = (id) => document.getElementById(id);

const SYNC_ICON =
  '<svg viewBox="0 0 24 24" class="icon"><path d="M20 11a8 8 0 1 0-2.3 5.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const state = {
  overview: null,
  categories: [],
  repos: [],
  today: null,
  todayDate: '',
  config: { downloadDir: '', deleteOldVersions: true, autoSyncOnStart: true },
  downloads: {},
  activeCategory: 'all',
  search: '',
  filter: 'all',
  sort: 'recent',
  selected: new Set(),
  todayAdded: new Set(),
  todayUpdated: new Set(),
  todayTab: 'all',
  syncRunning: false,
  currentJob: null,
  pollTimer: null,
  jobDoneFor: null,
  cheats: null,
  cheatsPollTimer: null,
  games: null,
  gamesPollTimer: null,
  gamesTab: 'new',
  gamesSearch: '',
  downloadHistory: [],
  historyRange: 'all',
  historySearch: ''
};

let repoByKey = new Map();
let catByKey = new Map();

/* ---------- 工具函数 ---------- */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[ch] || ch;
  });
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function toast(message, type) {
  const wrap = $('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s ease';
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showModal(id) {
  const el = $(id);
  if (!el) return;
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}

function hideModal(id) {
  const el = $(id);
  if (!el) return;
  el.hidden = true;
  const anyOpen = [...document.querySelectorAll('.modal-backdrop')].some((m) => !m.hidden);
  if (!anyOpen) document.body.style.overflow = '';
}

function showLoading(text) {
  let el = $('loadingMask');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loadingMask';
    el.className = 'loading-mask';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="loading-box"><div class="spinner"></div><div>${esc(text)}</div></div>`;
  el.hidden = false;
}

function hideLoading() {
  const el = $('loadingMask');
  if (el) el.remove();
}

/* ---------- 数据加载 ---------- */
async function refreshData(silent) {
  const data = await api('/api/overview');
  state.overview = data;
  state.categories = Array.isArray(data.categories) ? data.categories : [];
  state.repos = Array.isArray(data.repos) ? data.repos : [];
  state.today = data.today || null;
  state.todayDate = data.todayDate || todayLocal();
  state.config = data.config || state.config;
  state.downloads = data.downloads || {};
  repoByKey = new Map(state.repos.map((r) => [r.key, r]));
  catByKey = new Map(state.categories.map((c) => [c.id, c]));
  state.todayAdded = new Set(((state.today && state.today.added) || []).map((x) => x.key));
  state.todayUpdated = new Set(((state.today && state.today.updated) || []).map((x) => x.key));

  const valid = new Set(state.repos.map((r) => r.key));
  for (const key of [...state.selected]) {
    if (!valid.has(key)) state.selected.delete(key);
  }

  renderAll();
  if (!silent) maybeShowToday();
  return data;
}

function renderAll() {
  renderStats();
  renderCategories();
  renderHead();
  renderRepos();
  renderToday();
  renderGamesBadge();
  updateSelectionUI();
  updateSyncUI((state.overview && state.overview.sync) || {});
}

function renderGamesBadge() {
  const g = state.overview && state.overview.games ? state.overview.games : null;
  const count = g ? g.todayTotal || 0 : 0;
  const badge = $('gamesCount');
  if (badge) {
    badge.textContent = count;
    badge.hidden = count === 0;
  }
}

/* ---------- 概览 ---------- */
function renderStats() {
  const total = state.repos.length;
  // 近期提交：与上游页面的 Alerte 逻辑一致，最近 3 天内有提交的插件
  const recent = state.repos.filter((r) => r.hasNewCommitsAlert).length;
  const updated = (state.today && state.today.updated ? state.today.updated.length : 0);
  const downloaded = Object.keys(state.downloads || {}).length;
  const source = state.overview && state.overview.sourceExportedAt ? formatDate(state.overview.sourceExportedAt) : '—';

  $('stats').innerHTML = `
    <div class="stat">
      <div class="label">收录插件</div>
      <div class="value">${formatNumber(total)}</div>
      <div class="hint">上游数据：${esc(source)}</div>
    </div>
    <div class="stat highlight">
      <div class="label">近期提交（< 3 天）</div>
      <div class="value">${formatNumber(recent)}</div>
      <div class="hint">最近 3 天内有提交的插件</div>
    </div>
    <div class="stat highlight">
      <div class="label">今日更新</div>
      <div class="value">${formatNumber(updated)}</div>
      <div class="hint">有新版本或新附件的插件</div>
    </div>
    <div class="stat">
      <div class="label">已下载</div>
      <div class="value">${formatNumber(downloaded)}</div>
      <div class="hint">本地下载记录中的插件</div>
    </div>
  `;
}

function renderCategories() {
  const total = state.repos.length;
  const items = state.categories
    .filter((c) => c.repoCount > 0)
    .slice()
    .sort((a, b) => b.repoCount - a.repoCount);

  const allItem = `
    <button class="category-item ${state.activeCategory === 'all' ? 'active' : ''}" data-cat="all">
      <span class="swatch" style="background:#5ee7ff;color:#5ee7ff"></span>
      <span class="label">全部分类</span>
      <span class="num">${total}</span>
    </button>`;

  $('categoryTotal').textContent = `${state.categories.length} 类`;
  $('categoryList').innerHTML =
    allItem +
    items
      .map(
        (c) => `
      <button class="category-item ${state.activeCategory === c.id ? 'active' : ''}" data-cat="${esc(c.id)}" title="${esc(c.description || c.name)}">
        <span class="swatch" style="background:${esc(c.color || '#5ee7ff')};color:${esc(c.color || '#5ee7ff')}"></span>
        <span class="label">${esc(c.name)}</span>
        <span class="num">${c.repoCount}</span>
      </button>`
      )
      .join('');
}

function renderHead() {
  const cat = state.activeCategory !== 'all' ? catByKey.get(state.activeCategory) : null;
  const shown = filteredRepos().length;
  const title = cat ? cat.name : '全部插件';
  const desc = cat
    ? `${cat.description || '暂无分类简介'}${cat.originalName ? ` · 原始分类：${cat.originalName}` : ''}`
    : `共 ${state.repos.length} 个插件，来自 ${state.categories.filter((c) => c.repoCount > 0).length} 个分类。`;
  $('categoryHead').innerHTML = `
    <div>
      <h2>${esc(title)}</h2>
      <p>${esc(desc)}</p>
    </div>
    <div class="count-pill">当前显示 ${shown} 个</div>
  `;
}

/* ---------- 插件列表 ---------- */
function filteredRepos() {
  let list = state.repos.slice();
  const q = state.search.trim().toLowerCase();

  if (state.activeCategory !== 'all') {
    list = list.filter((r) => r.categoryId === state.activeCategory);
  }
  if (q) {
    list = list.filter((r) => {
      const haystack = [
        r.name,
        r.fullName,
        r.owner,
        r.description,
        r.descriptionOriginal,
        r.categoryName,
        Array.isArray(r.tags) ? r.tags.join(' ') : ''
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }
  if (state.filter === 'downloadable') {
    list = list.filter((r) => r.latestRelease && r.latestRelease.assets && r.latestRelease.assets.length);
  } else if (state.filter === 'recent') {
    list = list.filter((r) => r.hasNewCommitsAlert);
  } else if (state.filter === 'updated') {
    list = list.filter((r) => state.todayUpdated.has(r.key));
  }

  if (state.sort === 'stars') {
    list.sort((a, b) => (b.stars || 0) - (a.stars || 0));
  } else if (state.sort === 'name') {
    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  } else {
    list.sort((a, b) => {
      const ta = new Date(a.pushedAt || a.updatedAt || 0).getTime() || 0;
      const tb = new Date(b.pushedAt || b.updatedAt || 0).getTime() || 0;
      return tb - ta;
    });
  }
  return list;
}

function cardHtml(r) {
  const selected = state.selected.has(r.key);
  const download = state.downloads[r.key];
  const release = r.latestRelease;
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  const canDownload = assets.length > 0;
  const isNew = state.todayAdded.has(r.key);
  const isUpdated = state.todayUpdated.has(r.key);
  const needsTranslation = !r.hasZhDescription && Boolean(r.descriptionOriginal);

  const badges = [];
  if (isNew) badges.push('<span class="badge new">今日新增</span>');
  if (isUpdated) badges.push('<span class="badge updated">今日更新</span>');
  if (download) badges.push(`<span class="badge downloaded" title="已下载 ${esc(download.tagName || '')} 到本地">已下载</span>`);
  if (needsTranslation) badges.push('<span class="badge updated" title="该简介暂未翻译，可稍后同步">待翻译</span>');

  const releaseLine = release
    ? `<div class="release-line">
         <span class="tag">${esc(release.tagName || '—')}</span>
         <span>${esc(formatDate(release.publishedAt))}</span>
         <span>·</span>
         <span>${assets.length} 个附件</span>
         <span>·</span>
         <span>${formatSize(release.assetSize)}</span>
       </div>`
    : '<div class="release-line none">该插件暂无可下载的 Release 附件</div>';

  const assetRows = assets
    .map(
      (a) => `
      <div class="asset-row">
        <span class="name" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="size">${formatSize(a.size)}</span>
        <span class="dl">${formatNumber(a.downloadCount)} 次</span>
      </div>`
    )
    .join('');

  return `
    <article class="repo-card ${selected ? 'selected' : ''}" data-key="${esc(r.key)}">
      <div class="card-top">
        <label class="check" title="${canDownload ? '选择该插件' : '暂无可下载附件'}">
          <input type="checkbox" data-check="${esc(r.key)}" ${selected ? 'checked' : ''} ${canDownload ? '' : 'disabled'} />
          <span>选择</span>
        </label>
        <span class="category-chip">${esc(r.categoryName || '未分类')}</span>
        ${badges.join('')}
      </div>
      <div class="card-title-row">
        <h3 title="${esc(r.name)}">${esc(r.name)}</h3>
      </div>
      <div class="card-owner" title="${esc(r.fullName)}">${esc(r.fullName)}</div>
      <p class="desc ${r.description ? '' : 'empty'}">${esc(r.description || '暂无简介。')}</p>
      ${
        r.descriptionOriginal && r.descriptionOriginal !== r.description
          ? `<details class="original"><summary>英文原文</summary><p>${esc(r.descriptionOriginal)}</p></details>`
          : ''
      }
      <div class="meta">
        <span class="star">★ ${formatNumber(r.stars)}</span>
        ${r.language ? `<span>${esc(r.language)}</span>` : ''}
        ${r.license ? `<span>${esc(r.license)}</span>` : ''}
        ${r.hasNewCommitsAlert ? '<span>近期有提交</span>' : ''}
      </div>
      ${releaseLine}
      <div class="card-actions">
        <a href="${esc(release ? release.htmlUrl : r.htmlUrl)}" target="_blank" rel="noreferrer">Release 页面</a>
        ${canDownload ? `<button type="button" data-assets="${esc(r.key)}">查看附件</button>` : ''}
      </div>
      ${canDownload ? `<div class="asset-list" hidden>${assetRows}</div>` : ''}
    </article>
  `;
}

function renderRepos() {
  const list = filteredRepos();
  $('repoGrid').innerHTML = list.map(cardHtml).join('');
  $('emptyState').hidden = list.length > 0;
}

/* ---------- 今日更新 ---------- */
function todayItems() {
  const map = new Map();
  for (const item of (state.today && state.today.added) || []) map.set(item.key, { ...item, kind: 'added' });
  for (const item of (state.today && state.today.updated) || []) {
    if (!map.has(item.key)) map.set(item.key, { ...item, kind: 'updated' });
  }
  return [...map.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'added' ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
  });
}

function isDownloadable(item) {
  const repo = repoByKey.get(item.key);
  return Boolean(repo && repo.latestRelease && repo.latestRelease.assets && repo.latestRelease.assets.length);
}

function todayItemHtml(item) {
  const repo = repoByKey.get(item.key);
  const assets = repo && repo.latestRelease && repo.latestRelease.assets ? repo.latestRelease.assets : item.assets || [];
  const canDownload = Boolean(repo && assets.length);
  const selected = state.selected.has(item.key);
  const name = repo ? repo.name : item.name || item.fullName;
  const category = (repo && repo.categoryName) || item.categoryName || '未分类';
  const description = (repo && repo.description) || item.description || '暂无简介。';
  const htmlUrl = (repo && repo.htmlUrl) || item.htmlUrl || '';
  const isAdded = item.kind === 'added';
  const tag = item.tagName || (repo && repo.latestRelease && repo.latestRelease.tagName) || null;
  const prevTag = item.previousTag || null;

  const files = assets.slice(0, 4)
    .map(
      (a) => `<div class="file"><span title="${esc(a.name)}">${esc(a.name)}</span><span>${formatSize(a.size)}</span></div>`
    )
    .join('');

  const version = isAdded
    ? `<span class="version-change">新版本 <span class="arrow">${esc(tag || '—')}</span></span>`
    : `<span class="version-change">${esc(prevTag || '—')} <span class="arrow">→</span> ${esc(tag || '—')}</span>`;

  return `
    <div class="update-item ${selected ? 'selected' : ''}" data-key="${esc(item.key)}">
      <div class="row">
        <label class="check" title="${canDownload ? '选择该插件' : '暂无可下载附件'}">
          <input type="checkbox" data-check="${esc(item.key)}" ${selected ? 'checked' : ''} ${canDownload ? '' : 'disabled'} />
          <span>选择</span>
        </label>
        <span class="title">${esc(name)}</span>
        <span class="category-chip">${esc(category)}</span>
        <span class="badge ${isAdded ? 'new' : 'updated'}">${isAdded ? '新增' : '更新'}</span>
        ${version}
      </div>
      <p class="desc">${esc(description)}</p>
      ${
        assets.length
          ? `<div class="update-files">${files}${assets.length > 4 ? `<div class="file"><span>还有 ${assets.length - 4} 个文件</span><span></span></div>` : ''}</div>`
          : '<div class="update-files"><div class="file"><span>该插件暂无可下载附件</span><span></span></div></div>'
      }
      <div class="card-actions">
        ${htmlUrl ? `<a href="${esc(htmlUrl)}" target="_blank" rel="noreferrer">Release 页面</a>` : ''}
        ${!repo ? '<span class="muted" style="font-size:11px">该插件已不在当前列表中</span>' : ''}
      </div>
    </div>
  `;
}

function renderToday() {
  const items = todayItems();
  const addedCount = (state.today && state.today.added ? state.today.added.length : 0);
  const updatedCount = (state.today && state.today.updated ? state.today.updated.length : 0);

  $('todayCount').textContent = items.length;
  $('todayBtn').classList.toggle('has-updates', items.length > 0);
  $('todaySub').textContent = items.length
    ? `${state.todayDate} · 新增 ${addedCount} 个 / 更新 ${updatedCount} 个`
    : `${state.todayDate} · 暂无新增或更新`;

  $('todayTabs').innerHTML = `
    <button data-tab="all" class="${state.todayTab === 'all' ? 'active' : ''}">全部 ${items.length}</button>
    <button data-tab="added" class="${state.todayTab === 'added' ? 'active' : ''}">新增 ${addedCount}</button>
    <button data-tab="updated" class="${state.todayTab === 'updated' ? 'active' : ''}">更新 ${updatedCount}</button>
  `;

  const filtered =
    state.todayTab === 'all' ? items : items.filter((item) => item.kind === state.todayTab);

  $('todayList').innerHTML = filtered.map(todayItemHtml).join('');
  $('todayEmpty').hidden = filtered.length > 0;

  const sync = (state.overview && state.overview.sync) || {};
  let notice = '';
  if (sync.firstRun) {
    notice = '首次同步完成，已建立版本基线。之后上游新增的插件或新版本会自动出现在这里。';
  } else if (sync.ok === false && (sync.lastError || sync.error)) {
    notice = `上次同步未完全成功：${sync.lastError || sync.error}`;
  }
  $('todayNotice').hidden = !notice;
  $('todayNotice').textContent = notice;

  $('todaySelectAll').disabled = !items.some(isDownloadable);
  updateTodayFooter();
}

function updateTodayFooter() {
  const chosen = todayItems().filter((item) => state.selected.has(item.key) && isDownloadable(item));
  $('todaySelInfo').textContent = `已选 ${chosen.length} 个`;
  $('todayDownloadBtn').disabled = chosen.length === 0;
}

/* ---------- 选择与下载 ---------- */
function setSelected(key, on) {
  if (on) state.selected.add(key);
  else state.selected.delete(key);
  syncCheckboxes();
  updateSelectionUI();
}

function toggleSelect(key) {
  const repo = repoByKey.get(key);
  if (!repo || !repo.latestRelease || !repo.latestRelease.assets || !repo.latestRelease.assets.length) return;
  setSelected(key, !state.selected.has(key));
}

function syncCheckboxes() {
  document.querySelectorAll('input[data-check]').forEach((cb) => {
    cb.checked = state.selected.has(cb.getAttribute('data-check'));
  });
  document.querySelectorAll('.repo-card[data-key]').forEach((card) => {
    card.classList.toggle('selected', state.selected.has(card.getAttribute('data-key')));
  });
  document.querySelectorAll('.update-item[data-key]').forEach((item) => {
    item.classList.toggle('selected', state.selected.has(item.getAttribute('data-key')));
  });
}

function selectedRepos() {
  return [...state.selected]
    .map((key) => repoByKey.get(key))
    .filter((repo) => repo && repo.latestRelease && repo.latestRelease.assets && repo.latestRelease.assets.length);
}

function updateSelectionUI() {
  const keys = [...state.selected].filter((key) => repoByKey.has(key));
  const repos = selectedRepos();
  const size = repos.reduce((sum, repo) => sum + (repo.latestRelease.assetSize || 0), 0);

  $('selectionBar').hidden = keys.length === 0;
  $('selCount').textContent = `已选 ${keys.length} 个插件`;
  $('selSize').textContent = formatSize(size);
  $('selTarget').textContent = `下载到：${state.config.downloadDir || '未设置'}`;
  $('selTarget').title = state.config.downloadDir || '';
  $('downloadBtn').disabled = repos.length === 0;
  updateTodayFooter();
}

async function startDownload(keys) {
  // 已有进行中的下载任务：不重复创建，直接展示当前任务
  if (state.currentJob && state.currentJob.status === 'running') {
    toast('已有下载任务正在进行，请先在下载窗口中处理', 'error');
    showDownloadModal(state.currentJob);
    return;
  }
  const list = [...new Set(keys)].filter((key) => {
    const repo = repoByKey.get(key);
    return repo && repo.latestRelease && repo.latestRelease.assets && repo.latestRelease.assets.length;
  });
  if (!list.length) {
    toast('所选插件暂无可下载的 Release 附件', 'error');
    return;
  }
  // 勾选的项目里有多个文件时，先弹出文件选择，让用户挑选要下载的版本/文件
  const hasMulti = list.some((key) => repoByKey.get(key).latestRelease.assets.length > 1);
  if (hasMulti) {
    openAssetPicker(list);
    return;
  }
  doDownload(list.map((key) => ({ key })));
}

async function doDownload(items) {
  try {
    const res = await api('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
    // 服务端返回 busy：说明已有运行任务，直接接管显示
    if (res.busy) {
      toast('已有下载任务正在进行，已切换到该任务', 'info');
    }
    state.jobDoneFor = null;
    state.currentJob = res.job;
    showDownloadModal(res.job);
    pollJob(res.job.id);
  } catch (err) {
    toast(`下载失败：${err.message}`, 'error');
  }
}

/* ---------- 文件选择弹窗 ---------- */
function openAssetPicker(keys) {
  const html = keys
    .map((key) => {
      const repo = repoByKey.get(key);
      const rel = repo.latestRelease;
      const multi = rel.assets.length > 1;
      const files = rel.assets
        .map(
          (a) => `
        <label class="ap-file">
          <input type="checkbox" data-pick-file="${esc(key)}" value="${esc(a.name)}" />
          <span class="ap-name" title="${esc(a.name)}">${esc(a.name)}</span>
          <span class="ap-size mono">${formatSize(a.size)}</span>
        </label>`
        )
        .join('');
      return `
      <div class="ap-group${multi ? ' multi' : ''}">
        <div class="ap-head">
          <span class="ap-repo">${esc(repo.name || repo.fullName)}</span>
          <span class="ap-tag mono">${esc(rel.tagName || '')}</span>
          <span class="muted">${rel.assets.length} 个文件${multi ? '，请挑选' : ''}</span>
        </div>
        <div class="ap-files">${files}</div>
      </div>`;
    })
    .join('');
  $('assetList').innerHTML = html;
  updateAssetPickMeta();
  showModal('assetModal');
}

function updateAssetPickMeta() {
  const checked = [...$('assetList').querySelectorAll('input[data-pick-file]:checked')];
  let size = 0;
  for (const cb of checked) {
    const repo = repoByKey.get(cb.getAttribute('data-pick-file'));
    const asset = repo && repo.latestRelease.assets.find((a) => a.name === cb.value);
    if (asset) size += asset.size || 0;
  }
  $('assetPickMeta').textContent = checked.length
    ? `已选 ${checked.length} 个文件 · ${formatSize(size)}`
    : '请至少勾选一个文件';
  $('assetPickConfirm').disabled = checked.length === 0;
}

function confirmAssetPick() {
  const byKey = new Map();
  $('assetList').querySelectorAll('input[data-pick-file]:checked').forEach((cb) => {
    const key = cb.getAttribute('data-pick-file');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(cb.value);
  });
  if (!byKey.size) {
    toast('请至少勾选一个文件', 'error');
    return;
  }
  const items = [...byKey.entries()].map(([key, assetNames]) => ({ key, assetNames }));
  hideModal('assetModal');
  doDownload(items);
}

function showDownloadModal(job) {
  $('downloadTitle').textContent = '正在下载插件';
  $('downloadSub').textContent = `${job.totalFiles} 个文件 · ${formatSize(job.totalBytes)}`;
  $('downloadTarget').textContent = `保存到：${job.targetDir}`;
  renderJob(job);
  showModal('downloadModal');
}

function jobStatusText(status) {
  return {
    pending: '等待',
    downloading: '下载中',
    done: '完成',
    skipped: '已存在',
    failed: '失败',
    cancelled: '已取消'
  }[status] || status;
}

function filePercent(f) {
  if (!f.size) return f.status === 'done' || f.status === 'skipped' ? 100 : 0;
  return Math.min(100, Math.round(((f.received || 0) / f.size) * 100));
}

function renderJob(job) {
  const percent =
    job.totalBytes > 0
      ? Math.min(100, Math.round((job.doneBytes / job.totalBytes) * 100))
      : job.totalFiles
        ? Math.min(100, Math.round((job.doneFiles / job.totalFiles) * 100))
        : 0;

  const isRunning = job.status === 'running';
  $('downloadTitle').textContent =
    job.status === 'running'
      ? '正在下载插件'
      : job.status === 'completed'
        ? '下载完成'
        : job.status === 'completed_with_errors'
          ? '下载完成，部分文件失败'
          : job.status === 'cancelled'
            ? '已取消下载'
            : '下载失败';
  $('downloadSub').textContent = `${job.totalFiles} 个文件 · ${formatSize(job.totalBytes)}`;
  $('downloadTarget').textContent = `保存到：${job.targetDir}`;
  $('overallLabel').textContent =
    job.status === 'running'
      ? `正在下载（${job.doneFiles}/${job.totalFiles} 个文件）`
      : job.status === 'completed'
        ? '全部文件已处理完成'
        : job.status === 'completed_with_errors'
          ? '部分文件处理失败'
          : job.status === 'cancelled'
            ? '下载已取消，未完成的文件已删除'
            : '下载失败，请查看失败原因';
  $('overallPercent').textContent = `${percent}%`;
  $('overallBar').style.width = `${percent}%`;
  const cancelled = job.cancelledFiles || 0;
  $('overallMeta').textContent = `已传输 ${formatSize(job.doneBytes)} / ${formatSize(job.totalBytes)} · 完成 ${job.doneFiles} · 跳过 ${job.skippedFiles} · 失败 ${job.failedFiles}${cancelled ? ' · 取消 ' + cancelled : ''}`;

  // 顶部“取消全部”按钮
  const cancelAllBtn = $('downloadCancelAll');
  if (cancelAllBtn) cancelAllBtn.hidden = !isRunning;

  // 底部“重试失败文件”按钮：任务结束且有失败文件时出现
  const retryBtn = $('downloadRetryFailed');
  if (retryBtn) retryBtn.hidden = isRunning || !(job.failedFiles > 0);

  if (!job.items || !job.items.length) {
    $('downloadList').innerHTML = '<div class="muted" style="font-size:12px;padding:10px 0">正在准备下载任务...</div>';
  } else {
    $('downloadList').innerHTML = job.items
      .map((item) => {
        const files = item.files || [];
        const itemStatus = files.some((f) => f.status === 'failed')
          ? 'failed'
          : files.some((f) => f.status === 'cancelled') && files.every((f) => f.status === 'cancelled' || f.status === 'done' || f.status === 'skipped')
            ? 'cancelled'
            : files.length && files.every((f) => f.status === 'done' || f.status === 'skipped')
              ? 'done'
              : files.some((f) => f.status === 'downloading')
                ? 'downloading'
                : 'pending';
        const fileRows = files
          .map((f) => {
            const fp = filePercent(f);
            const canCancel = isRunning && (f.status === 'downloading' || f.status === 'pending');
            const canRetry = !isRunning && f.status === 'failed';
            const canOpen = (f.status === 'done' || f.status === 'skipped') && f.path;
            return `
          <div class="download-file" data-file-id="${esc(f.id)}">
            <div class="df-main">
              <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>
              <span class="df-meta">${formatSize(f.received || 0)} / ${formatSize(f.size || 0)} · ${fp}%</span>
              <span class="status-pill ${esc(f.status)}">${esc(jobStatusText(f.status))}</span>
              ${canOpen ? `<button type="button" class="file-open" data-open-file="${esc(f.path)}">打开</button>` : ''}
              ${canCancel ? `<button type="button" class="file-cancel" data-cancel-file="${esc(f.id)}">取消</button>` : ''}
              ${canRetry ? `<button type="button" class="file-retry" data-retry-file="${esc(f.id)}">重试</button>` : ''}
            </div>
            <div class="df-bar"><div class="df-bar-inner" style="width:${fp}%"></div></div>
            ${f.error ? `<div class="err">${esc(f.error)}</div>` : ''}
          </div>`;
          })
          .join('');
        return `
          <div class="download-item">
            <div class="download-item-head">
              <span class="name">${esc(item.name || item.fullName)}</span>
              <span class="status-pill ${itemStatus}">${esc(jobStatusText(itemStatus))}</span>
            </div>
            <div class="muted" style="font-size:11px;margin-top:4px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(item.dir)}">
              ${esc(item.flatPrefix ? item.flatPrefix.replace(/_$/, '') : (item.tagName || ''))}
            </div>
            ${fileRows}
          </div>
        `;
      })
      .join('');
  }

  if (job.status !== 'running') handleJobDone(job);
}

async function pollJob(id) {
  clearInterval(state.pollTimer);
  const tick = async () => {
    try {
      const res = await api(`/api/download/${id}`);
      state.currentJob = res.job;
      renderJob(res.job);
      if (res.job.status !== 'running') {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      toast(`获取下载进度失败：${err.message}`, 'error');
    }
  };
  await tick();
  if (!state.pollTimer) {
    state.pollTimer = setInterval(tick, 900);
  }
}

function handleJobDone(job) {
  if (state.jobDoneFor === job.id) return;
  state.jobDoneFor = job.id;
  clearInterval(state.pollTimer);
  state.pollTimer = null;

  if (job.status === 'completed') {
    toast(`下载完成：${job.doneFiles} 个文件`, 'success');
  } else if (job.status === 'completed_with_errors') {
    toast(`下载完成，但有 ${job.failedFiles} 个文件失败`, 'error');
  } else if (job.status === 'cancelled') {
    toast('下载已取消，未完成的文件已自动删除', 'info');
  } else {
    toast('下载失败，请查看任务详情', 'error');
  }
  refreshData(true).catch(() => {});
}

async function cancelJobAll() {
  if (!state.currentJob || state.currentJob.status !== 'running') return;
  try {
    await api(`/api/download/${state.currentJob.id}/cancel`, { method: 'POST' });
    toast('已发送取消指令', 'info');
  } catch (err) {
    toast(`取消失败：${err.message}`, 'error');
  }
}

async function cancelJobFile(fileId) {
  if (!state.currentJob) return;
  try {
    await api(`/api/download/${state.currentJob.id}/file/${encodeURIComponent(fileId)}/cancel`, { method: 'POST' });
  } catch (err) {
    toast(`取消失败：${err.message}`, 'error');
  }
}

// 重试失败的文件：以新任务形式只下载这些文件（服务端会跳过已完成、续传未完成的部分）
function retryFailedFiles(fileIds) {
  const job = state.currentJob;
  if (!job || job.status === 'running') return;
  const byKey = new Map();
  for (const item of job.items || []) {
    for (const f of item.files || []) {
      if (f.status === 'failed' && (!fileIds || fileIds.includes(f.id))) {
        if (!byKey.has(item.key)) byKey.set(item.key, []);
        byKey.get(item.key).push(f.name);
      }
    }
  }
  if (!byKey.size) {
    toast('没有可重试的失败文件', 'error');
    return;
  }
  const items = [...byKey.entries()].map(([key, assetNames]) => ({ key, assetNames }));
  doDownload(items);
}

async function openDownloadFolder() {
  const dir = (state.currentJob && state.currentJob.targetDir) || state.config.downloadDir;
  try {
    await api('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir })
    });
    toast('已打开下载目录', 'success');
  } catch (err) {
    toast(`打开目录失败：${err.message}`, 'error');
  }
}

async function openDownloadedFile(filePath, dir) {
  try {
    const data = await api('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: filePath, dir: dir || '' })
    });
    if (data && data.fallback) toast('文件已不在，已打开所在目录');
  } catch (err) {
    toast(`打开文件失败：${err.message}`, 'error');
  }
}

/* ---------- 同步 ---------- */
function updateSyncButton() {
  const btn = $('syncBtn');
  btn.disabled = state.syncRunning;
  btn.innerHTML = `${SYNC_ICON}${state.syncRunning ? '同步中...' : '立即同步'}`;
}

function updateSyncUI(sync) {
  const el = $('syncState');
  const text = $('syncText');
  const running = Boolean(sync && sync.running);
  const at = sync && sync.at ? String(sync.at) : '';
  const isToday = at.slice(0, 10) === todayLocal();
  const stale = !running && (!at || !isToday || sync.ok === false);

  el.classList.toggle('running', running);
  el.classList.toggle('stale', stale);
  if (running) text.textContent = '正在同步上游仓库...';
  else if (at) text.textContent = `上次同步：${at}`;
  else text.textContent = '尚未同步';

  state.syncRunning = running;
  updateSyncButton();
}

async function pollSync() {
  for (let i = 0; i < 300; i++) {
    const sync = await api('/api/sync');
    updateSyncUI(sync);
    if (!sync.running) return sync;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('同步超时，请稍后重试');
}

async function runSync(silent) {
  state.syncRunning = true;
  updateSyncButton();
  try {
    // 服务端已在同步时会直接返回 running，不会重复启动；这里仍发起请求，
    // 随后统一轮询等待，避免页面加载时因「已在同步」而直接跳过、卡在同步中。
    await api('/api/sync', { method: 'POST' });
    const sync = await pollSync();
    if (sync.ok) {
      if (!silent) toast(`同步完成：新增 ${sync.added || 0} 个，更新 ${sync.updated || 0} 个`, 'success');
    } else {
      toast(`同步失败：${sync.lastError || sync.error || '请查看日志'}`, 'error');
    }
    await refreshData(true);
    if (!silent) maybeShowToday();
    return sync;
  } catch (err) {
    toast(`同步失败：${err.message}`, 'error');
    return null;
  } finally {
    state.syncRunning = false;
    updateSyncButton();
  }
}

/* ---------- 金手指同步 ---------- */
async function fetchCheats() {
  const data = await api('/api/cheats');
  state.cheats = data;
  renderCheatsModal();
  return data;
}

function renderCheatsModal() {
  const data = state.cheats;
  if (!data) return;
  $('cheatsPath').textContent = data.localPath || '—';
  $('cheatsOk').textContent = data.exists
    ? data.gitOk ? '已同步（git 仓库完整）' : '目录存在但非 git 仓库'
    : '尚未同步';
  $('cheatsOk').className = 'cs-val ' + (data.exists && data.gitOk ? 'ok' : 'err');
  $('cheatsGit').textContent = data.gitAvailable ? '已安装 ✓' : '未安装 ✗';
  $('cheatsGit').className = 'cs-val ' + (data.gitAvailable ? 'ok' : 'err');
  $('cheatsCommit').textContent = data.commit || '—';
  $('cheatsFileCount').textContent = data.fileCount + ' / 总计 ' + data.totalFileCount;
  $('cheatsLastAt').textContent = data.lastSyncedAt || '—';
  $('cheatsOutput').textContent = data.output || '—';
  if (data.lastError) {
    $('cheatsOutput').textContent += '\n[错误] ' + data.lastError;
  }

  const files = data.files || [];
  const more = data.totalFileCount > files.length ? `（仅显示前 ${files.length} 个）` : '';
  $('cheatsFilesMeta').textContent = `共 ${data.totalFileCount} 个文件${more}`;
  $('cheatsFiles').innerHTML = files.length
    ? files.map((f) => `<div class="cf-item">${esc(f)}</div>`).join('')
    : '<div class="muted" style="font-size:12px;padding:10px 0">尚未同步，暂无文件。</div>';

  // 版本历史
  const hist = data.history || {};
  const entries = hist.entries || [];
  const tr = hist.translation || {};
  const trText = tr.totalTitles
    ? ` · 已翻译 ${tr.translated}/${tr.totalTitles}${tr.running ? `（进行中 ${tr.done}）` : ''}`
    : '';
  $('cheatsHistoryMeta').textContent = entries.length
    ? `共 ${entries.length} 条记录${trText}${hist.updatedAt ? ` · 上次解析 ${hist.updatedAt}` : ''}`
    : '—';
  const trBtn = $('cheatsTranslate');
  if (trBtn) {
    trBtn.disabled = !entries.length || !!tr.running || !tr.pending;
    trBtn.textContent = tr.running ? `翻译中 ${tr.done}/${tr.totalTitles}...` : tr.pending ? '翻译游戏名' : '已全部翻译';
  }
  if (!entries.length) {
    $('cheatsHistory').innerHTML = '<div class="muted" style="font-size:12px;padding:10px 0">尚未同步，暂无版本历史。</div>';
  } else {
    // 按日期分组
    const byDate = {};
    for (const e of entries) {
      if (!byDate[e.date]) byDate[e.date] = [];
      byDate[e.date].push(e);
    }
    const html = Object.keys(byDate)
      .sort((a, b) => b.localeCompare(a))
      .map((date) => {
        const rows = byDate[date]
          .map(
            (e) => `
          <div class="ch-row">
            <span class="ch-badge ${esc(e.status)}">${esc(e.status)}</span>
            <span class="ch-status-zh">${esc(e.statusZh)}</span>
            <span class="ch-id">${esc(e.id)}</span>
            <span class="ch-version">${esc(e.version)}</span>
            <span class="ch-title"><a href="${esc('https://www.baidu.com/s?wd=' + encodeURIComponent(e.title))}" target="_blank" rel="noopener" title="在百度搜索该游戏名">${esc(e.title)}</a>${e.titleZh ? `<span class="ch-title-zh">${esc(e.titleZh)}</span>` : ''}</span>
          </div>`
          )
          .join('');
        return `<div class="ch-day"><div class="ch-date">${esc(date)}</div>${rows}</div>`;
      })
      .join('');
    $('cheatsHistory').innerHTML = html;
  }

  const syncBtn = $('cheatsSync');
  if (syncBtn) {
    if (data.running) {
      syncBtn.disabled = true;
      syncBtn.textContent = '同步中...';
    } else {
      syncBtn.disabled = !data.gitAvailable;
      syncBtn.textContent = data.exists && data.gitOk ? '更新金手指' : '同步金手指';
    }
  }
}

function cheatsBusy(data) {
  const tr = data && data.history && data.history.translation;
  return !!(data && (data.running || (tr && tr.running)));
}

function openCheatsModal() {
  showModal('cheatsModal');
  fetchCheats().then((data) => {
    // 同步或翻译进行中时自动轮询刷新进度
    if (cheatsBusy(data)) {
      clearInterval(state.cheatsPollTimer);
      state.cheatsPollTimer = setInterval(async () => {
        try {
          const d = await fetchCheats();
          if (!cheatsBusy(d)) {
            clearInterval(state.cheatsPollTimer);
            state.cheatsPollTimer = null;
          }
        } catch {}
      }, 1500);
    }
  });
}

async function openCheatsDir() {
  try {
    await api('/api/open-cheats', { method: 'POST' });
  } catch (err) {
    toast(`打开目录失败：${err.message}`, 'error');
  }
}

async function runCheatsSync() {
  if (!state.cheats || cheatsBusy(state.cheats)) return;
  const syncBtn = $('cheatsSync');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = '同步中...'; }
  try {
    await api('/api/cheats/sync', { method: 'POST' });
    // 轮询直到同步与翻译都结束
    clearInterval(state.cheatsPollTimer);
    state.cheatsPollTimer = setInterval(async () => {
      try {
        const data = await fetchCheats();
        if (!cheatsBusy(data)) {
          clearInterval(state.cheatsPollTimer);
          state.cheatsPollTimer = null;
          if (data.lastError) toast(`同步失败：${data.lastError}`, 'error');
          else toast(`金手指同步完成，共 ${data.fileCount} 个文件`, 'success');
        }
      } catch {}
    }, 1500);
  } catch (err) {
    toast(`同步启动失败：${err.message}`, 'error');
    // 即使启动失败也刷新一下状态
    fetchCheats();
  }
}

async function runTitleTranslate() {
  if (!state.cheats) return;
  const btn = $('cheatsTranslate');
  if (btn) { btn.disabled = true; btn.textContent = '翻译中...'; }
  try {
    const res = await api('/api/cheats/translate', { method: 'POST' });
    if (!res.started) {
      toast(res.message || '没有待翻译的游戏名');
      await fetchCheats();
      return;
    }
    toast(`开始翻译 ${res.total} 个游戏名，请稍候`);
    clearInterval(state.cheatsPollTimer);
    state.cheatsPollTimer = setInterval(async () => {
      try {
        const data = await fetchCheats();
        const tr = data.history && data.history.translation;
        if (!tr || !tr.running) {
          clearInterval(state.cheatsPollTimer);
          state.cheatsPollTimer = null;
          toast('游戏名翻译完成', 'success');
        }
      } catch {}
    }, 1500);
  } catch (err) {
    toast(`启动翻译失败：${err.message}`, 'error');
    fetchCheats();
  }
}

/* ---------- 游戏资源（PS4/PS5） ---------- */
async function fetchGames() {
  const data = await api('/api/games');
  state.games = data;
  renderGamesModal();
  return data;
}

function renderGamesModal() {
  const data = state.games;
  if (!data) return;

  const ps5Total = data.ps5Total || 0;
  const ps4Total = data.ps4Total || 0;
  const todayNew = data.todayTotal || 0;
  const snapshotAt = data.snapshotUpdatedAt || '—';

  $('gamesStats').innerHTML = `
    <div class="gs-item"><span class="gs-label">今日新增</span><span class="gs-val highlight">${todayNew}</span></div>
    <div class="gs-item"><span class="gs-label">PS5 收录</span><span class="gs-val">${formatNumber(ps5Total)}</span></div>
    <div class="gs-item"><span class="gs-label">PS4 收录</span><span class="gs-val">${formatNumber(ps4Total)}</span></div>
    <div class="gs-item"><span class="gs-label">快照时间</span><span class="gs-val muted">${esc(snapshotAt)}</span></div>
  `;

  const ps5New = data.todayPs5 || [];
  const ps4New = data.todayPs4 || [];
  $('gamesTabs').innerHTML = `
    <button data-tab="new" class="${state.gamesTab === 'new' ? 'active' : ''}">今日新增 ${todayNew}</button>
    <button data-tab="ps5" class="${state.gamesTab === 'ps5' ? 'active' : ''}">PS5 ${formatNumber(ps5Total)}</button>
    <button data-tab="ps4" class="${state.gamesTab === 'ps4' ? 'active' : ''}">PS4 ${formatNumber(ps4Total)}</button>
  `;

  // 输出日志
  const out = $('gamesOutput');
  if (data.running) {
    out.hidden = false;
    out.textContent = data.output || '同步中...';
  } else {
    out.hidden = true;
  }

  // 渲染列表
  renderGamesList();

  // 同步按钮状态
  const syncBtn = $('gamesSync');
  const quickBtn = $('gamesSyncQuick');
  if (syncBtn) {
    syncBtn.disabled = data.running;
    syncBtn.textContent = data.running ? '同步中...' : '同步游戏';
  }
  if (quickBtn) {
    quickBtn.disabled = data.running;
    quickBtn.textContent = data.running ? '同步中...' : '快速同步';
  }

  $('gamesMeta').textContent = data.running
    ? '正在同步，请稍候...'
    : (data.lastError ? `上次失败：${data.lastError}` : `数据来源：2468c.com`);
}

function renderGamesList() {
  const data = state.games;
  if (!data) return;

  let list = [];
  if (state.gamesTab === 'new') {
    list = [
      ...(data.todayPs5 || []).map((g) => ({ ...g, platform: 'PS5' })),
      ...(data.todayPs4 || []).map((g) => ({ ...g, platform: 'PS4' }))
    ];
  } else {
    // 全量列表从快照加载（按需：通过 API 单独获取）
    list = state.gamesFullList ? state.gamesFullList.filter((g) => g.platform === state.gamesTab.toUpperCase()) : [];
    if (!list.length) {
      // 提示用户同步后才能浏览全量
      $('gamesList').innerHTML = `<div class="muted" style="padding:20px;text-align:center">请先点击「同步游戏」拉取完整列表。</div>`;
      $('gamesEmpty').hidden = true;
      return;
    }
  }

  // 搜索过滤
  const q = state.gamesSearch.trim().toLowerCase();
  if (q) list = list.filter((g) => (g.title || '').toLowerCase().includes(q));

  $('gamesEmpty').hidden = list.length > 0;
  if (!list.length) {
    $('gamesList').innerHTML = '';
    return;
  }

  $('gamesList').innerHTML = list
    .map((g) => {
      const platform = g.platform || (state.gamesTab === 'ps5' ? 'PS5' : 'PS4');
      const platClass = platform === 'PS5' ? 'plat-ps5' : 'plat-ps4';
      const cover = g.cover
        ? `<img class="gm-cover" src="${esc(g.cover)}" alt="" loading="lazy" onerror="this.style.display='none'"/>`
        : `<div class="gm-cover gm-cover-placeholder">🎮</div>`;
      return `
        <a class="gm-card" href="${esc(g.url)}" target="_blank" rel="noopener">
          ${cover}
          <div class="gm-body">
            <div class="gm-title">${esc(g.title || '(无标题)')}</div>
            <div class="gm-meta">
              <span class="gm-plat ${platClass}">${platform}</span>
              <span class="gm-date muted">${esc((g.publishedAt || g.firstSeen || '').slice(0, 10))}</span>
            </div>
          </div>
        </a>`;
    })
    .join('');
}

function openGamesModal() {
  showModal('gamesModal');
  fetchGames().then((data) => {
    // 如果全量列表不存在，尝试加载快照
    if (state.gamesTab !== 'new' && (!state.gamesFullList || !state.gamesFullList.length)) {
      loadGamesSnapshot();
    }
    if (data.running) {
      clearInterval(state.gamesPollTimer);
      state.gamesPollTimer = setInterval(async () => {
        try {
          const d = await fetchGames();
          if (!d.running) {
            clearInterval(state.gamesPollTimer);
            state.gamesPollTimer = null;
            refreshData(true); // 刷新顶部徽章
          }
        } catch {}
      }, 1500);
    }
  });
}

async function loadGamesSnapshot() {
  try {
    const res = await api('/api/games?full=1');
    const ps5 = (res.ps5List || []).map((g) => ({ ...g, platform: 'PS5' }));
    const ps4 = (res.ps4List || []).map((g) => ({ ...g, platform: 'PS4' }));
    state.gamesFullList = [...ps5, ...ps4];
  } catch {}
}

async function runGamesSync(quick) {
  if (!state.games || state.games.running) return;
  try {
    await api('/api/games/sync', { method: 'POST', body: JSON.stringify({ quick: !!quick }) });
    clearInterval(state.gamesPollTimer);
    state.gamesPollTimer = setInterval(async () => {
      try {
        const data = await fetchGames();
        if (!data.running) {
          clearInterval(state.gamesPollTimer);
          state.gamesPollTimer = null;
          state.gamesFullList = null; // 强制重新加载快照
          loadGamesSnapshot();
          refreshData(true);
          if (data.lastError) toast(`同步失败：${data.lastError}`, 'error');
          else toast(`游戏同步完成，今日新增 ${data.todayTotal} 个`, 'success');
        }
      } catch {}
    }, 1500);
  } catch (err) {
    toast(`同步启动失败：${err.message}`, 'error');
    fetchGames();
  }
}

/* ---------- 下载记录 ---------- */
async function openHistoryModal() {
  showModal('historyModal');
  try {
    const res = await api('/api/download-history');
    state.downloadHistory = res.history || [];
    state.historyRange = 'all';
    state.historySearch = '';
    $('historySearch').value = '';
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === 'all'));
    renderHistory();
  } catch (err) {
    toast(`加载下载记录失败：${err.message}`, 'error');
  }
}

function renderHistory() {
  const all = state.downloadHistory || [];
  // 范围过滤
  let list = all;
  const now = Date.now();
  if (state.historyRange === 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    list = list.filter((e) => e.ts >= today.getTime());
  } else if (state.historyRange === 'week') {
    list = list.filter((e) => now - e.ts <= 7 * 24 * 3600 * 1000);
  } else if (state.historyRange === 'month') {
    list = list.filter((e) => now - e.ts <= 30 * 24 * 3600 * 1000);
  }
  // 搜索过滤
  const q = state.historySearch.trim().toLowerCase();
  if (q) {
    list = list.filter((e) =>
      [e.name, e.fullName, e.categoryName, e.tagName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q) ||
      (e.files || []).some((f) => (f.name || '').toLowerCase().includes(q))
    );
  }

  $('historyCount').textContent = `共 ${list.length} 条${list.length !== all.length ? `（筛选自全部 ${all.length}）` : ''}`;
  if (!list.length) {
    $('historyList').innerHTML = '<div class="muted" style="font-size:12px;padding:20px 0;text-align:center">暂无下载记录。</div>';
    return;
  }
  // 按日期分组
  const byDate = {};
  for (const e of list) {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  }
  const html = Object.keys(byDate)
    .sort((a, b) => b.localeCompare(a))
    .map((date) => {
      const cards = byDate[date]
        .map((e) => {
          const filesHtml = (e.files || [])
            .map((f) => `<span class="h-file"><span class="h-file-name" title="${esc(f.flatName || f.name)}">${esc(f.name)}</span><span class="h-file-size">${formatSize(f.size || 0)}</span></span>`)
            .join('');
          return `
          <div class="h-card">
            <div class="h-card-head">
              <span class="h-name">${esc(e.name || e.fullName)}</span>
              ${e.tagName ? `<span class="h-tag">${esc(e.tagName)}</span>` : ''}
              <span class="h-cat">${esc(e.categoryName || '')}</span>
              ${e.files && e.files.length === 1 && (e.files[0].path || e.files[0].flatName)
                ? `<button class="file-open h-open-file" data-open-file="${esc(e.files[0].path || e.files[0].flatName)}" data-open-dir="${esc(e.targetDir || '')}">打开</button>`
                : ''}
              <span class="h-time">${esc(e.time || '')}</span>
            </div>
            <div class="h-files">${filesHtml}</div>
          </div>`;
        })
        .join('');
      return `<div class="h-day"><div class="h-day-head">${esc(date)}</div>${cards}</div>`;
    })
    .join('');
  $('historyList').innerHTML = html;
}

/* ---------- 今日弹窗 ---------- */
function maybeShowToday(force) {
  const items = todayItems();
  // 当天没有新增/更新时不弹出空的今日更新（即使强制打开也跳过）
  if (!items.length) return;
  const signature = `${state.todayDate}|${items.map((i) => `${i.key}:${i.kind}:${i.tagName}`).join(',')}|${state.overview && state.overview.sync && state.overview.sync.firstRun ? 'first' : ''}`;
  const seenDate = localStorage.getItem('ps5hub.today.date');
  const seenSignature = localStorage.getItem('ps5hub.today.signature');

  if (force || seenDate !== state.todayDate || seenSignature !== signature) {
    openTodayModal();
    try {
      localStorage.setItem('ps5hub.today.date', state.todayDate);
      localStorage.setItem('ps5hub.today.signature', signature);
    } catch {}
  }
}

function openTodayModal() {
  state.todayTab = 'all';
  renderToday();
  showModal('todayModal');
}

/* ---------- 设置 ---------- */
function openSettings() {
  $('settingsDir').value = state.config.downloadDir || '';
  $('settingsKeepOld').checked = !state.config.deleteOldVersions;
  $('settingsAutoSync').checked = Boolean(state.config.autoSyncOnStart);
  showModal('settingsModal');
}

async function saveSettings() {
  const dir = $('settingsDir').value.trim();
  if (!dir) {
    toast('下载目录不能为空', 'error');
    return;
  }
  try {
    const res = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        downloadDir: dir,
        deleteOldVersions: !$('settingsKeepOld').checked,
        autoSyncOnStart: $('settingsAutoSync').checked
      })
    });
    state.config = { ...state.config, ...res.config };
    hideModal('settingsModal');
    updateSelectionUI();
    toast('设置已保存', 'success');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error');
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('syncBtn').addEventListener('click', () => runSync(false));
  $('todayBtn').addEventListener('click', openTodayModal);
  $('cheatsBtn').addEventListener('click', openCheatsModal);
  $('cheatsSync').addEventListener('click', runCheatsSync);
  $('cheatsOpenDir').addEventListener('click', openCheatsDir);
  $('cheatsTranslate').addEventListener('click', runTitleTranslate);
  $('gamesBtn').addEventListener('click', openGamesModal);
  $('gamesSync').addEventListener('click', () => runGamesSync(false));
  $('gamesSyncQuick').addEventListener('click', () => runGamesSync(true));
  $('gamesTabs').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-tab]');
    if (!btn) return;
    state.gamesTab = btn.dataset.tab;
    if (state.gamesTab !== 'new' && (!state.gamesFullList || !state.gamesFullList.length)) {
      loadGamesSnapshot().then(renderGamesList);
    } else {
      renderGamesList();
    }
    renderGamesModal();
  });
  $('gamesSearch').addEventListener('input', (e) => {
    state.gamesSearch = e.target.value;
    renderGamesList();
  });
  $('historyBtn').addEventListener('click', openHistoryModal);
  $('historySearch').addEventListener('input', (e) => {
    state.historySearch = e.target.value;
    renderHistory();
  });
  document.querySelectorAll('.range-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.historyRange = b.dataset.range;
      renderHistory();
    });
  });
  $('settingsBtn').addEventListener('click', openSettings);
  $('clearSelBtn').addEventListener('click', () => {
    state.selected.clear();
    syncCheckboxes();
    updateSelectionUI();
  });
  $('downloadBtn').addEventListener('click', () => {
    startDownload([...state.selected]);
  });
  $('openDirBtn').addEventListener('click', openDownloadFolder);
  $('downloadOpenDir').addEventListener('click', openDownloadFolder);
  $('downloadCancelAll').addEventListener('click', () => {
    if (confirm('确定要取消全部下载吗？未完成的文件将被删除。')) cancelJobAll();
  });
  // 逐文件取消 / 失败重试（事件委托）
  $('downloadList').addEventListener('click', (event) => {
    const cancelBtn = event.target.closest('button[data-cancel-file]');
    if (cancelBtn) {
      cancelJobFile(cancelBtn.getAttribute('data-cancel-file'));
      return;
    }
    const retryBtn = event.target.closest('button[data-retry-file]');
    if (retryBtn) retryFailedFiles([retryBtn.getAttribute('data-retry-file')]);
    const openBtn = event.target.closest('button[data-open-file]');
    if (openBtn) openDownloadedFile(openBtn.getAttribute('data-open-file'), openBtn.getAttribute('data-open-dir') || '');
  });
  $('historyList').addEventListener('click', (event) => {
    const openBtn = event.target.closest('button[data-open-file]');
    if (openBtn) openDownloadedFile(openBtn.getAttribute('data-open-file'), openBtn.getAttribute('data-open-dir') || '');
  });
  $('downloadRetryFailed').addEventListener('click', () => retryFailedFiles(null));
  // 文件选择弹窗
  $('assetPickConfirm').addEventListener('click', confirmAssetPick);
  $('assetPickAll').addEventListener('click', () => {
    $('assetList').querySelectorAll('input[data-pick-file]').forEach((cb) => (cb.checked = true));
    updateAssetPickMeta();
  });
  $('assetPickNone').addEventListener('click', () => {
    $('assetList').querySelectorAll('input[data-pick-file]').forEach((cb) => (cb.checked = false));
    updateAssetPickMeta();
  });
  $('assetList').addEventListener('change', (event) => {
    if (event.target.closest('input[data-pick-file]')) updateAssetPickMeta();
  });
  $('selTarget').addEventListener('click', openSettings);
  $('settingsSave').addEventListener('click', saveSettings);
  $('todayDownloadBtn').addEventListener('click', () => {
    const keys = todayItems()
      .filter((item) => state.selected.has(item.key) && isDownloadable(item))
      .map((item) => item.key);
    if (!keys.length) {
      toast('请先勾选要下载的插件', 'error');
      return;
    }
    startDownload(keys);
  });
  $('todaySelectAll').addEventListener('click', () => {
    for (const item of todayItems()) {
      if (isDownloadable(item)) state.selected.add(item.key);
    }
    syncCheckboxes();
    updateSelectionUI();
    toast('已选中今日全部可下载插件', 'success');
  });

  $('categoryList').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-cat]');
    if (!btn) return;
    state.activeCategory = btn.getAttribute('data-cat');
    renderCategories();
    renderHead();
    renderRepos();
  });

  $('filterChips').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-filter]');
    if (!btn) return;
    state.filter = btn.getAttribute('data-filter');
    [...$('filterChips').querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    renderHead();
    renderRepos();
  });

  let searchTimer = null;
  $('searchInput').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      state.search = value.trim().toLowerCase();
      renderHead();
      renderRepos();
    }, 150);
  });

  $('sortSelect').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderRepos();
  });

  $('repoGrid').addEventListener('change', (event) => {
    const cb = event.target.closest('input[data-check]');
    if (!cb) return;
    setSelected(cb.getAttribute('data-check'), cb.checked);
  });

  $('repoGrid').addEventListener('click', (event) => {
    const assetBtn = event.target.closest('button[data-assets]');
    if (assetBtn) {
      const card = assetBtn.closest('.repo-card');
      const list = card && card.querySelector('.asset-list');
      if (list) {
        list.hidden = !list.hidden;
        assetBtn.textContent = list.hidden ? '查看附件' : '收起附件';
      }
      return;
    }
    if (event.target.closest('a,button,input,label,summary,details')) return;
    const card = event.target.closest('.repo-card');
    if (card) toggleSelect(card.getAttribute('data-key'));
  });

  $('todayTabs').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-tab]');
    if (!btn) return;
    state.todayTab = btn.getAttribute('data-tab');
    renderToday();
  });

  $('todayList').addEventListener('change', (event) => {
    const cb = event.target.closest('input[data-check]');
    if (!cb) return;
    setSelected(cb.getAttribute('data-check'), cb.checked);
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => hideModal(btn.getAttribute('data-close')));
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) hideModal(backdrop.id);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const id of ['downloadModal', 'todayModal', 'settingsModal']) {
      const el = $(id);
      if (el && !el.hidden) {
        hideModal(id);
        break;
      }
    }
  });
}

/* ---------- 启动 ---------- */
async function init() {
  bindEvents();
  showLoading('正在加载本地数据...');
  try {
    await refreshData(true);
    const forceToday = new URLSearchParams(location.search).get('today') === '1';
    let needSync = !state.overview || !state.overview.ok;

    // 自动同步：每天第一次打开页面时，先同步一次再看今日更新，
    // 避免打开时今日更新还是空数据。同步成功后才记录当天已同步。
    const today = state.todayDate || todayLocal();
    const lastAutoSync = localStorage.getItem('ps5_auto_sync_date');
    const syncConfig = state.config || {};
    if (!needSync && syncConfig.autoSyncOnStart && lastAutoSync !== today) {
      needSync = true;
    }

    if (needSync) {
      showLoading('正在同步上游仓库并生成中文数据...');
      try {
        const result = await runSync(true);
        if (result && result.ok) localStorage.setItem('ps5_auto_sync_date', today);
      } catch (err) {
        toast(`自动同步失败：${err.message}`, 'error');
      }
      await refreshData(true);
    }

    // 页面加载时服务端可能已在后台同步（如刚启动服务触发的自动同步），
    // 此时上面不一定会走 runSync，这里统一等待结束并刷新，避免停留在「同步中」。
    if (state.syncRunning) {
      showLoading('正在等待后台同步完成...');
      try {
        const sync = await pollSync();
        if (sync && !sync.ok) {
          toast(`后台同步失败：${sync.lastError || sync.error || '请查看日志'}`, 'error');
        }
      } catch (err) {
        toast(`等待同步失败：${err.message}`, 'error');
      }
      await refreshData(true);
    }

    hideLoading();
    if (state.overview && state.overview.ok) {
      maybeShowToday(forceToday);
    } else {
      toast('本地数据尚未建立，请点击「立即同步」。', 'error');
    }
  } catch (err) {
    hideLoading();
    toast(`加载失败：${err.message}`, 'error');
  }
}

init();
