/*
 * PS5 插件更新中心 - 本地同步脚本
 * 作用：
 *  1. 拉取上游项目最新数据（git pull）
 *  2. 与本地快照对比，识别新增插件 / 新版本
 *  3. 生成中文分类、中文简介的本地页面数据
 *  4. 生成当日更新清单与中文日报
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCAL = path.join(ROOT, 'local');
const UPSTREAM_DB = path.join(ROOT, 'json', 'repos-database.json');
const I18N_DIR = path.join(LOCAL, 'i18n');
const STATE_DIR = path.join(LOCAL, 'state');
const LOG_DIR = path.join(LOCAL, 'logs');
const SITE_DATA = path.join(LOCAL, 'site', 'data');

const DESC_ZH_PATH = path.join(I18N_DIR, 'descriptions-zh.json');
const CATEGORY_ZH_PATH = path.join(I18N_DIR, 'categories-zh.json');
const SNAPSHOT_PATH = path.join(STATE_DIR, 'snapshot.json');
const DAILY_PATH = path.join(STATE_DIR, 'daily-updates.json');
const LATEST_SYNC_PATH = path.join(STATE_DIR, 'latest-sync.json');
const CONFIG_PATH = path.join(LOCAL, 'config.json');

// 上游仓库原始数据地址（git pull 不可用时的兜底下载源）
const UPSTREAM_DB_URL =
  'https://raw.githubusercontent.com/nexgen999/PS5-Repository-List/main/json/repos-database.json';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, pretty = true) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, pretty ? 2 : 0), 'utf8');
}

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function nowLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

function repoKey(repo) {
  return `${repo.fullName}@${repo.categoryId || 'unassigned'}`;
}

function assetKey(release) {
  if (!release || !Array.isArray(release.assets)) return '';
  return release.assets
    .map((a) => `${a.id || ''}:${a.name}:${a.size}:${a.updatedAt || ''}`)
    .sort()
    .join('|');
}

function gitPull() {
  try {
    const out = execFileSync('git', ['-C', ROOT, 'pull', '--ff-only'], {
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true
    });
    return { ok: true, message: out.trim() || '已是最新' };
  } catch (err) {
    const msg = String(err.stderr || err.stdout || err.message || 'git pull 失败').trim();
    return { ok: false, message: msg.split('\n').slice(0, 4).join(' ') };
  }
}

// 兜底：git pull 失败或未安装 git 时，直接从 GitHub 下载上游数据文件
async function fetchUpstreamDb() {
  try {
    const res = await fetch(UPSTREAM_DB_URL, {
      headers: { 'User-Agent': 'PS5-Local-Hub/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || !text.includes('"repos"')) throw new Error('返回内容不是有效的仓库数据');
    ensureDir(path.dirname(UPSTREAM_DB));
    fs.writeFileSync(UPSTREAM_DB, text, 'utf8');
    return { ok: true, message: '已从 GitHub 下载最新数据' };
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '');
}

function splitText(text, size) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= size) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > size) {
    let cut = -1;
    for (const sep of ['. ', '; ', ', ', ' ']) {
      const idx = rest.lastIndexOf(sep, size);
      if (idx > size * 0.4) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function translateText(text, email) {
  const chunks = splitText(text, 450);
  const out = [];
  for (const chunk of chunks) {
    const url =
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(chunk) +
      '&langpair=en%7Czh-CN' +
      (email ? '&de=' + encodeURIComponent(email) : '');
    const res = await fetch(url, { headers: { 'User-Agent': 'PS5-Local-Hub/1.0' } });
    if (!res.ok) throw new Error('翻译接口 HTTP ' + res.status);
    const data = await res.json();
    const translated = decodeEntities(data && data.responseData && data.responseData.translatedText ? data.responseData.translatedText : '').trim();
    if (!translated || /MYMEMORY WARNING|QUERY LENGTH LIMIT|PLEASE SELECT TWO DISTINCT/i.test(translated)) {
      throw new Error('翻译接口返回无效结果');
    }
    out.push(translated);
  }
  return out.join(' ');
}

function makeDailyEntry(repo, prevTag, kind, categoryName, description) {
  const rel = repo.latestRelease || null;
  return {
    key: repoKey(repo),
    kind,
    fullName: repo.fullName,
    name: repo.name,
    owner: repo.owner,
    url: repo.url,
    htmlUrl: repo.htmlUrl,
    categoryId: repo.categoryId || 'unassigned',
    categoryName,
    description,
    descriptionOriginal: repo.description || '',
    stars: repo.stars || 0,
    language: repo.language || '',
    tagName: rel ? rel.tagName : null,
    previousTag: prevTag || null,
    publishedAt: rel ? rel.publishedAt : null,
    releaseName: rel ? rel.name || rel.tagName : null,
    assets: rel
      ? (rel.assets || []).map((a) => ({
          name: a.name,
          size: a.size,
          downloadUrl: a.downloadUrl,
          contentType: a.contentType || '',
          downloadCount: a.downloadCount || 0
        }))
      : []
  };
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderMarkdown(day, syncInfo) {
  const lines = [];
  lines.push(`# PS5 插件更新日报 - ${day.date}`);
  lines.push('');
  lines.push(`- 同步时间：${syncInfo.at}`);
  lines.push(`- 上游数据时间：${syncInfo.sourceExportedAt || '未知'}`);
  lines.push(`- 新增插件：${day.added.length}`);
  lines.push(`- 更新插件：${day.updated.length}`);
  lines.push(`- 下架/移除：${day.removed.length}`);
  if (syncInfo.firstRun) lines.push('- 说明：本次为首次同步，已建立版本基线，后续同步将显示新增与更新。');
  lines.push('');

  if (!day.added.length && !day.updated.length && !day.removed.length) {
    lines.push('今日暂无新增或更新。');
    lines.push('');
  }

  if (day.added.length) {
    lines.push('## 新增插件');
    lines.push('');
    lines.push('| 插件 | 分类 | 版本 | 附件 | 中文简介 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of day.added) {
      const files = item.assets.length ? `${item.assets.length} 个 / ${formatSize(item.assets.reduce((s, a) => s + (a.size || 0), 0))}` : '暂无附件';
      lines.push(`| [${item.fullName}](${item.htmlUrl}) | ${item.categoryName} | ${item.tagName || '-'} | ${files} | ${(item.description || '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  if (day.updated.length) {
    lines.push('## 更新插件');
    lines.push('');
    lines.push('| 插件 | 分类 | 版本变化 | 附件 | 中文简介 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of day.updated) {
      const files = item.assets.length ? `${item.assets.length} 个 / ${formatSize(item.assets.reduce((s, a) => s + (a.size || 0), 0))}` : '暂无附件';
      lines.push(`| [${item.fullName}](${item.htmlUrl}) | ${item.categoryName} | ${item.previousTag || '-'} → ${item.tagName || '-'} | ${files} | ${(item.description || '').replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  if (day.removed.length) {
    lines.push('## 下架/移除');
    lines.push('');
    for (const item of day.removed) lines.push(`- ${item.fullName}`);
    lines.push('');
  }

  const notices = [];
  if (syncInfo.gitPull && !syncInfo.gitPull.ok) notices.push(`上游拉取失败：${syncInfo.gitPull.message}`);
  if (syncInfo.translateError) notices.push(`自动翻译提示：${syncInfo.translateError}`);
  if (notices.length) {
    lines.push('## 同步提示');
    lines.push('');
    for (const n of notices) lines.push(`- ${n}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  ensureDir(STATE_DIR);
  ensureDir(LOG_DIR);
  ensureDir(SITE_DATA);

  const args = new Set(process.argv.slice(2));
  const skipPull = args.has('--no-pull');

  const syncInfo = {
    at: nowLocal(),
    ok: false,
    firstRun: false,
    gitPull: { ok: true, message: '已跳过拉取' },
    sourceExportedAt: null,
    added: 0,
    updated: 0,
    removed: 0,
    translated: 0,
    error: null
  };

  if (!skipPull) {
    syncInfo.gitPull = gitPull();
    console.log(`[同步] 拉取上游：${syncInfo.gitPull.ok ? '成功' : '失败'} - ${syncInfo.gitPull.message}`);
    // git pull 失败时（未安装 git / 非 git 仓库 / 网络问题），尝试从 GitHub 直接下载数据
    if (!syncInfo.gitPull.ok) {
      console.log('[同步] git pull 失败，尝试从 GitHub 直接下载数据...');
      const fetchResult = await fetchUpstreamDb();
      syncInfo.gitPull.message += `；兜底下载：${fetchResult.ok ? '成功' : '失败 - ' + fetchResult.message}`;
      console.log(`[同步] 兜底下载：${fetchResult.ok ? '成功' : '失败 - ' + fetchResult.message}`);
    }
  }

  let db = readJson(UPSTREAM_DB, null);
  if (!db || !Array.isArray(db.repos)) {
    // 本地没有可用数据（首次安装 / 非 git 仓库），尝试从 GitHub 在线下载
    console.log('[同步] 本地无上游数据，尝试从 GitHub 下载...');
    const fetchResult = await fetchUpstreamDb();
    console.log(`[同步] 在线下载：${fetchResult.ok ? '成功' : '失败 - ' + fetchResult.message}`);
    if (fetchResult.ok) db = readJson(UPSTREAM_DB, null);
  }
  if (!db || !Array.isArray(db.repos)) {
    syncInfo.error = '无法读取上游数据文件 json/repos-database.json，请检查网络或安装 Git';
    writeJson(LATEST_SYNC_PATH, syncInfo);
    console.error(`[同步] ${syncInfo.error}`);
    process.exit(1);
  }

  const config = readJson(CONFIG_PATH, {});
  const categoriesZh = readJson(CATEGORY_ZH_PATH, {});
  const descriptionsZh = readJson(DESC_ZH_PATH, {});
  const snapshot = readJson(SNAPSHOT_PATH, null);
  const daily = readJson(DAILY_PATH, { days: {} });
  const today = todayLocal();

  const isFirstRun = !snapshot || !snapshot.repos || Object.keys(snapshot.repos).length === 0;
  syncInfo.firstRun = isFirstRun;
  syncInfo.sourceExportedAt = db.exportedAt || null;

  // 去重：同一 fullName + categoryId 只保留一条
  const seen = new Set();
  const repos = [];
  for (const repo of db.repos) {
    const key = repoKey(repo);
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(repo);
  }

  const categoryMap = new Map();
  for (const cat of db.categories || []) {
    const zh = categoriesZh[cat.id] || {};
    categoryMap.set(cat.id, {
      id: cat.id,
      name: zh.name || cat.name,
      originalName: cat.name,
      description: zh.description || '',
      color: cat.color || '#3b82f6',
      parentId: cat.parentId || null
    });
  }
  if (!categoryMap.has('unassigned')) {
    categoryMap.set('unassigned', {
      id: 'unassigned',
      name: (categoriesZh.unassigned && categoriesZh.unassigned.name) || '未分类',
      originalName: 'unassigned',
      description: (categoriesZh.unassigned && categoriesZh.unassigned.description) || '暂未归类的项目。',
      color: '#64748b',
      parentId: null
    });
  }

  // 自动翻译新增且暂无中文说明的插件（每日请求量很小）
  let translatedNow = 0;
  let translateError = null;
  const needTranslate = isFirstRun
    ? []
    : repos.filter((r) => r.description && r.description.trim() && !descriptionsZh[r.fullName]);
  const limit = Math.max(0, Number(config.maxAutoTranslate) || 0);
  for (const repo of needTranslate.slice(0, limit)) {
    try {
      const zh = await translateText(repo.description, config.translateEmail || '');
      if (zh) {
        descriptionsZh[repo.fullName] = zh;
        translatedNow++;
      }
    } catch (err) {
      translateError = err.message || String(err);
      break;
    }
  }
  if (translatedNow > 0) {
    const sorted = {};
    for (const key of Object.keys(descriptionsZh).sort()) sorted[key] = descriptionsZh[key];
    writeJson(DESC_ZH_PATH, sorted);
  }
  syncInfo.translated = translatedNow;
  if (translateError) syncInfo.translateError = translateError;

  // 计算差异
  const current = {};
  for (const repo of repos) {
    const key = repoKey(repo);
    const rel = repo.latestRelease || null;
    current[key] = {
      fullName: repo.fullName,
      categoryId: repo.categoryId || 'unassigned',
      name: repo.name,
      tagName: rel ? rel.tagName : null,
      assetKey: assetKey(rel),
      publishedAt: rel ? rel.publishedAt : null,
      description: repo.description || '',
      htmlUrl: repo.htmlUrl
    };
  }

  const addedKeys = [];
  const updatedKeys = [];
  const removedKeys = [];
  const prevRepos = snapshot && snapshot.repos ? snapshot.repos : {};

  if (!isFirstRun) {
    for (const key of Object.keys(current)) {
      const prev = prevRepos[key];
      if (!prev) addedKeys.push(key);
      else if (prev.tagName !== current[key].tagName || prev.assetKey !== current[key].assetKey) updatedKeys.push(key);
    }
    for (const key of Object.keys(prevRepos)) {
      if (!current[key]) removedKeys.push(key);
    }
  }

  // 组装本地化数据
  const localizedRepos = repos.map((repo) => {
    const cat = categoryMap.get(repo.categoryId || 'unassigned') || categoryMap.get('unassigned');
    const zhDesc = repo.description ? descriptionsZh[repo.fullName] || '' : '';
    const rel = repo.latestRelease || null;
    const assets = rel
      ? (rel.assets || []).map((a) => ({
          name: a.name,
          size: a.size || 0,
          downloadUrl: a.downloadUrl,
          contentType: a.contentType || '',
          downloadCount: a.downloadCount || 0,
          updatedAt: a.updatedAt || ''
        }))
      : [];
    return {
      key: repoKey(repo),
      fullName: repo.fullName,
      name: repo.name,
      owner: repo.owner,
      ownerAvatar: repo.ownerAvatar || '',
      url: repo.url,
      htmlUrl: repo.htmlUrl,
      categoryId: repo.categoryId || 'unassigned',
      categoryName: cat.name,
      description: zhDesc || repo.description || '',
      descriptionOriginal: repo.description || '',
      hasZhDescription: Boolean(zhDesc),
      customNotes: repo.customNotes || '',
      tags: Array.isArray(repo.tags) ? repo.tags : [],
      stars: repo.stars || 0,
      forks: repo.forks || 0,
      openIssues: repo.openIssues || 0,
      language: repo.language || '',
      license: repo.license || '',
      pushedAt: repo.pushedAt || '',
      updatedAt: repo.updatedAt || '',
      hasNewCommitsAlert: Boolean(repo.hasNewCommitsAlert),
      latestRelease: rel
        ? {
            tagName: rel.tagName,
            name: rel.name || rel.tagName,
            publishedAt: rel.publishedAt || '',
            htmlUrl: rel.htmlUrl,
            assetCount: assets.length,
            assetSize: assets.reduce((s, a) => s + (a.size || 0), 0),
            assets
          }
        : null
    };
  });

  const categoryList = [...categoryMap.values()].map((cat) => ({
    ...cat,
    repoCount: localizedRepos.filter((r) => r.categoryId === cat.id).length
  })).filter((cat) => cat.repoCount > 0 || cat.id !== 'unassigned');

  const localized = {
    generatedAt: new Date().toISOString(),
    localizedAt: nowLocal(),
    sourceExportedAt: db.exportedAt || null,
    categories: categoryList,
    repos: localizedRepos
  };

  writeJson(path.join(SITE_DATA, 'repos-database.json'), localized, false);

  // 生成当日更新记录
  if (!daily.days || typeof daily.days !== 'object') daily.days = {};
  const day = daily.days[today] || { date: today, generatedAt: nowLocal(), added: [], updated: [], removed: [] };
  day.generatedAt = nowLocal();

  const addedByKey = new Map(day.added.map((x) => [x.key, x]));
  const updatedByKey = new Map(day.updated.map((x) => [x.key, x]));
  const removedByKey = new Map(day.removed.map((x) => [x.key, x]));

  for (const key of addedKeys) {
    const repo = repos.find((r) => repoKey(r) === key);
    if (!repo) continue;
    const cat = categoryMap.get(repo.categoryId || 'unassigned') || categoryMap.get('unassigned');
    const zhDesc = repo.description ? descriptionsZh[repo.fullName] || '' : '';
    const entry = makeDailyEntry(repo, null, 'added', cat.name, zhDesc || repo.description || '');
    addedByKey.set(key, entry);
    updatedByKey.delete(key);
  }

  for (const key of updatedKeys) {
    const repo = repos.find((r) => repoKey(r) === key);
    if (!repo) continue;
    const cat = categoryMap.get(repo.categoryId || 'unassigned') || categoryMap.get('unassigned');
    const zhDesc = repo.description ? descriptionsZh[repo.fullName] || '' : '';
    const prev = prevRepos[key];
    const entry = makeDailyEntry(repo, prev ? prev.tagName : null, 'updated', cat.name, zhDesc || repo.description || '');
    if (!addedByKey.has(key)) updatedByKey.set(key, entry);
  }

  for (const key of removedKeys) {
    const prev = prevRepos[key];
    if (!prev) continue;
    removedByKey.set(key, { key, fullName: prev.fullName, name: prev.name });
  }

  day.added = [...addedByKey.values()];
  day.updated = [...updatedByKey.values()];
  day.removed = [...removedByKey.values()];

  daily.days[today] = day;

  // 只保留最近 90 天
  const dayKeys = Object.keys(daily.days).sort();
  while (dayKeys.length > 90) {
    delete daily.days[dayKeys.shift()];
  }
  writeJson(DAILY_PATH, daily);

  // 保存快照
  writeJson(SNAPSHOT_PATH, {
    updatedAt: nowLocal(),
    sourceExportedAt: db.exportedAt || null,
    repos: current
  });

  syncInfo.added = day.added.length;
  syncInfo.updated = day.updated.length;
  syncInfo.removed = day.removed.length;
  syncInfo.ok = true;
  syncInfo.error = null;

  writeJson(LATEST_SYNC_PATH, syncInfo);

  // 中文日报
  const md = renderMarkdown(day, syncInfo);
  fs.writeFileSync(path.join(LOG_DIR, `${today}.md`), md, 'utf8');
  fs.appendFileSync(path.join(LOG_DIR, 'sync.log'), `[${syncInfo.at}] ok=${syncInfo.ok} added=${syncInfo.added} updated=${syncInfo.updated} removed=${syncInfo.removed} translated=${syncInfo.translated} git=${syncInfo.gitPull.ok}\n`, 'utf8');

  // 控制台输出
  console.log('');
  console.log('===== PS5 插件同步完成 =====');
  console.log(`时间：${syncInfo.at}`);
  console.log(`上游数据：${syncInfo.sourceExportedAt || '未知'}`);
  console.log(`首次同步：${syncInfo.firstRun ? '是（已建立基线）' : '否'}`);
  console.log(`新增插件：${syncInfo.added}，更新插件：${syncInfo.updated}，移除：${syncInfo.removed}`);
  if (translateError) console.log(`自动翻译提示：${translateError}`);
  console.log(`页面数据：${path.join(SITE_DATA, 'repos-database.json')}`);
  console.log(`中文日报：${path.join(LOG_DIR, today + '.md')}`);
  console.log('==============================');

  if (syncInfo.added || syncInfo.updated) {
    console.log('');
    console.log('今日更新：');
    for (const item of day.added) console.log(`  [新增] ${item.fullName} (${item.categoryName}) ${item.tagName || ''}`);
    for (const item of day.updated) console.log(`  [更新] ${item.fullName} ${item.previousTag || '-'} → ${item.tagName || '-'}`);
  }
}

main().catch((err) => {
  console.error('[同步] 未处理的错误：', err);
  const info = {
    at: nowLocal(),
    ok: false,
    error: err && err.message ? err.message : String(err)
  };
  try {
    writeJson(LATEST_SYNC_PATH, info);
  } catch {}
  process.exit(1);
});
