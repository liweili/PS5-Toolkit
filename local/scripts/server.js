/*
 * PS5 插件更新中心 - 本地服务端
 * 仅监听本机 127.0.0.1，提供页面、同步、按需下载与配置接口。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCAL = path.join(ROOT, 'local');

// 部分环境（公司代理 / 杀毒软件）会替换 HTTPS 证书，Node 默认不信任系统证书库。
// 统一带上 --use-system-ca，避免下载 Release 附件时出现 fetch failed。
const NODE_TLS_ARGS = ['--use-system-ca'];
const SITE = path.join(LOCAL, 'site');
const DATA_FILE = path.join(SITE, 'data', 'repos-database.json');
const STATE_DIR = path.join(LOCAL, 'state');
const LOG_DIR = path.join(LOCAL, 'logs');
const CONFIG_PATH = path.join(LOCAL, 'config.json');
const DAILY_PATH = path.join(STATE_DIR, 'daily-updates.json');
const SYNC_PATH = path.join(STATE_DIR, 'latest-sync.json');
const DOWNLOADS_PATH = path.join(STATE_DIR, 'downloads.json');
const SYNC_SCRIPT = path.join(__dirname, 'sync.js');

const DEFAULT_CONFIG = {
  port: 8123,
  host: '127.0.0.1',
  downloadDir: path.join(LOCAL, 'downloads'),
  deleteOldVersions: true,
  autoSyncOnStart: true,
  syncIfOlderThanHours: 6,
  maxAutoTranslate: 30,
  translateEmail: ''
};

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

function loadConfig() {
  const cfg = readJson(CONFIG_PATH, {});
  return { ...DEFAULT_CONFIG, ...cfg };
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  writeJson(CONFIG_PATH, cfg);
  return cfg;
}

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function nowLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

function sanitizeSegment(value, fallback) {
  let s = String(value == null ? '' : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  if (!s) s = fallback || 'unknown';
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

// 打开文件时的路径解析：下载记录里的扁平文件名可能与磁盘实际文件名不一致，
// 先精确匹配，再按分词包含关系宽松匹配一次，避免「文件不存在」。
function resolveExistingFile(file, dir) {
  try {
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  } catch {}
  if (!dir) return null;
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return null;
  }
  const wanted = path.basename(file || '');
  if (!wanted) return null;
  const low = wanted.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === low);
  if (exact) return path.join(dir, exact);

  const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const wantedTokens = new Set(tokens(wanted));
  if (!wantedTokens.size) return null;
  const ext = path.extname(wanted).toLowerCase();
  const loose = names.find((n) => {
    if (ext && path.extname(n).toLowerCase() !== ext) return false;
    const ct = tokens(n);
    if (ct.length < 2) return false;
    return ct.every((t) => wantedTokens.has(t));
  });
  return loose ? path.join(dir, loose) : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const target = path.resolve(SITE, '.' + rel);
  const siteLower = SITE.toLowerCase();
  if (!target.toLowerCase().startsWith(siteLower + path.sep) && target.toLowerCase() !== siteLower) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未找到文件');
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.json' ? 'no-store' : 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ---------- 同步 ----------
const syncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  output: '',
  lastError: null,
  process: null
};

// 金手指同步（HEN Cheats Collection）
const CHEATS_REPO_URL = 'https://github.com/TeeKay87/HEN-Cheats-Collection.git';
const CHEATS_DIR = path.join(LOCAL, 'cheats', 'HEN-Cheats-Collection');
const CHEATS_HISTORY_PATH = path.join(STATE_DIR, 'cheats-history.json');
const CHEATS_TITLE_ZH_PATH = path.join(STATE_DIR, 'cheats-title-zh.json');
const DOWNLOAD_HISTORY_PATH = path.join(STATE_DIR, 'download-history.json');
const cheatsState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  output: '',
  lastError: null,
  commit: null
};

// ---------- 游戏资源同步（2468c.com PS4/PS5） ----------
const GAMES_SYNC_SCRIPT = path.join(__dirname, 'sync-games.js');
const GAMES_SNAPSHOT_PATH = path.join(STATE_DIR, 'games-snapshot.json');
const GAMES_DAILY_PATH = path.join(STATE_DIR, 'games-daily.json');
const GAMES_LATEST_PATH = path.join(STATE_DIR, 'games-latest-sync.json');
const gamesState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  output: '',
  lastError: null,
  process: null
};

function gamesStatus() {
  const snapshot = readJson(GAMES_SNAPSHOT_PATH, { ps5: [], ps4: [] });
  const daily = readJson(GAMES_DAILY_PATH, { days: {} });
  const latest = readJson(GAMES_LATEST_PATH, { at: null, ok: false });
  const today = todayLocal();
  const todayGames = daily.days && daily.days[today] ? daily.days[today] : { ps5: [], ps4: [] };
  return {
    ok: true,
    snapshotUpdatedAt: snapshot.updatedAt || null,
    ps5Total: (snapshot.ps5 || []).length,
    ps4Total: (snapshot.ps4 || []).length,
    todayDate: today,
    todayPs5: todayGames.ps5 || [],
    todayPs4: todayGames.ps4 || [],
    todayTotal: (todayGames.ps5 || []).length + (todayGames.ps4 || []).length,
    latest,
    running: gamesState.running,
    startedAt: gamesState.startedAt,
    finishedAt: gamesState.finishedAt,
    lastError: gamesState.lastError,
    output: gamesState.output.slice(-4000)
  };
}

function startGamesSync(quick) {
  if (gamesState.running) return { started: false, running: true, message: '游戏同步已在进行' };
  gamesState.running = true;
  gamesState.startedAt = nowLocal();
  gamesState.finishedAt = null;
  gamesState.output = '';
  gamesState.lastError = null;

  const args = [...NODE_TLS_ARGS, GAMES_SYNC_SCRIPT];
  if (quick) args.push('--quick');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  gamesState.process = child;

  const collect = (buf) => {
    gamesState.output += buf.toString('utf8');
    if (gamesState.output.length > 12000) gamesState.output = gamesState.output.slice(-12000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('close', (code) => {
    gamesState.running = false;
    gamesState.finishedAt = nowLocal();
    gamesState.process = null;
    if (code !== 0) gamesState.lastError = `游戏同步脚本退出码 ${code}`;
  });
  child.on('error', (err) => {
    gamesState.running = false;
    gamesState.finishedAt = nowLocal();
    gamesState.lastError = err.message;
    gamesState.process = null;
  });
  return { started: true, running: true };
}

function gitExistsSync() {
  // 用 spawnSync 查 git 版本，判断是否安装
  try {
    const { status } = require('child_process').spawnSync('git', ['--version'], { windowsHide: true });
    return status === 0;
  } catch {
    return false;
  }
}

function listCheatFiles() {
  if (!fs.existsSync(CHEATS_DIR)) return [];
  const result = [];
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) result.push(rel);
    }
  }
  try { walk(CHEATS_DIR, ''); } catch {}
  return result;
}

function cheatsStatus() {
  const exists = fs.existsSync(CHEATS_DIR);
  const files = listCheatFiles();
  const gitOk = exists && fs.existsSync(path.join(CHEATS_DIR, '.git'));
  let commit = null;
  if (gitOk) {
    try {
      const { stdout, status } = require('child_process').spawnSync('git', ['-C', CHEATS_DIR, 'rev-parse', '--short', 'HEAD'], { windowsHide: true, encoding: 'utf8' });
      if (status === 0) commit = stdout.trim();
    } catch {}
  }
  let lastAt = null;
  if (exists && files.length) {
    try {
      const st = fs.statSync(CHEATS_DIR);
      lastAt = st.mtimeMs;
    } catch {}
  }
  return {
    localPath: CHEATS_DIR,
    exists,
    gitOk,
    commit,
    gitAvailable: gitExistsSync(),
    fileCount: files.length,
    files: files.slice(0, 200), // 最多返回前 200 个给前端预览
    totalFileCount: files.length,
    lastSyncedAt: cheatsState.finishedAt,
    running: cheatsState.running,
    output: cheatsState.output.slice(-4000),
    lastError: cheatsState.lastError
  };
}

function startCheatsSync() {
  if (cheatsState.running) return { started: false, running: true, message: '金手指同步已在进行' };
  if (!gitExistsSync()) return { started: false, message: '未检测到 git，请先安装 git 并确保在系统 PATH 中' };

  cheatsState.running = true;
  cheatsState.startedAt = nowLocal();
  cheatsState.finishedAt = null;
  cheatsState.output = '';
  cheatsState.lastError = null;
  cheatsState.commit = null;

  const needsClone = !fs.existsSync(CHEATS_DIR) || !fs.existsSync(path.join(CHEATS_DIR, '.git'));

  // 如果目录存在但没有 .git，说明上次 clone 中断了，清掉重来
  if (!needsClone) {
    const entries = fs.readdirSync(CHEATS_DIR);
    if (entries.length === 0 || !fs.existsSync(path.join(CHEATS_DIR, '.git'))) {
      try { fs.rmSync(CHEATS_DIR, { recursive: true, force: true }); } catch {}
      needsClone = true;
    }
  }

  ensureDir(path.dirname(CHEATS_DIR));
  // 浅克隆仓库不能直接 pull（会报 refusing to merge unrelated histories），
  // 更新模式改为 fetch 最新提交后 reset --hard 对齐远端。
  const args = needsClone
    ? ['clone', '--depth', '1', CHEATS_REPO_URL, CHEATS_DIR]
    : ['-C', CHEATS_DIR, 'fetch', '--depth', '1', 'origin', 'HEAD'];

  const child = spawn('git', args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const collect = (buf) => {
    cheatsState.output += buf.toString('utf8');
    if (cheatsState.output.length > 12000) cheatsState.output = cheatsState.output.slice(-12000);
  };

  const finishOk = () => {
    cheatsState.running = false;
    cheatsState.finishedAt = nowLocal();
    // 记录最新 commit
    try {
      const { stdout } = require('child_process').spawnSync('git', ['-C', CHEATS_DIR, 'rev-parse', '--short', 'HEAD'], { windowsHide: true, encoding: 'utf8' });
      cheatsState.commit = stdout.trim();
    } catch {}
    cheatsState.lastError = null;
    cheatsState.output += `\n[完成] ${needsClone ? '克隆' : '更新'}成功 ✓ (commit ${cheatsState.commit || 'unknown'})`;
    // 成功后解析 README.md 的 Version History
    try {
      const result = parseCheatsVersionHistory();
      cheatsState.output += `\n[版本历史] 解析 ${result.count} 条记录，本次新增 ${result.newSinceLastSync} 条（上次同步后）`;
      // 后台补齐未翻译的游戏名，不阻塞同步流程
      const tr = startTitleTranslation();
      if (tr.started) cheatsState.output += `\n[翻译] 已启动游戏名翻译，共 ${tr.total} 条待处理`;
    } catch (err) {
      cheatsState.output += `\n[版本历史] 解析失败：${err.message}`;
    }
  };

  const failSync = (message) => {
    cheatsState.running = false;
    cheatsState.finishedAt = nowLocal();
    cheatsState.lastError = message;
    cheatsState.output += `\n[失败] ${message}`;
  };

  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (err) => failSync(err.message));
  child.on('close', (code) => {
    if (code !== 0) {
      // clone 失败时清理可能产生的半残目录
      if (needsClone && fs.existsSync(CHEATS_DIR) && !fs.existsSync(path.join(CHEATS_DIR, '.git'))) {
        try { fs.rmSync(CHEATS_DIR, { recursive: true, force: true }); } catch {}
      }
      failSync(`git 命令退出码 ${code}`);
      return;
    }
    if (needsClone) {
      finishOk();
      return;
    }
    // 更新模式：把工作区强制对齐到刚刚 fetch 下来的最新提交
    const reset = spawn('git', ['-C', CHEATS_DIR, 'reset', '--hard', 'FETCH_HEAD'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    reset.stdout.on('data', collect);
    reset.stderr.on('data', collect);
    reset.on('error', (err) => failSync(err.message));
    reset.on('close', (code2) => {
      if (code2 === 0) finishOk();
      else failSync(`git reset 退出码 ${code2}`);
    });
  });

  return { started: true, action: needsClone ? 'clone' : 'pull' };
}

// ---------- 金手指版本历史 ----------
const STATUS_ZH = { ADDED: '新增', UPDATE: '更新', REMOVED: '移除' };

function parseCheatsVersionHistory() {
  const readme = path.join(CHEATS_DIR, 'README.md');
  if (!fs.existsSync(readme)) return { count: 0, newSinceLastSync: 0, entries: [] };
  const text = fs.readFileSync(readme, 'utf8');

  // 定位 ## Version History 章节
  const mh = text.match(/##\s+Version History\s*\r?\n([\s\S]*?)(?:\r?\n##\s|$)/);
  if (!mh) return { count: 0, newSinceLastSync: 0, entries: [] };
  const section = mh[1];

  const entries = [];
  // 逐行处理 markdown 表格：| Date | Status | ID | Version | [Title](url) |
  for (const line of section.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/.test(t)) continue; // 表头分隔线
    const cols = t.split('|').map((c) => c.trim()).filter((_, i, a) => i !== 0 && i !== a.length - 1);
    if (cols.length < 5) continue;
    const [date, status, id, version, titleMd] = cols;
    // 提取 [Title](url)
    const tm = titleMd.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!tm) continue;
    const title = tm[1];
    const url = tm[2];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!/^(ADDED|UPDATE|REMOVED)$/.test(status)) continue;
    entries.push({
      date,
      status,
      statusZh: STATUS_ZH[status] || status,
      id,
      version,
      title,
      url
    });
  }

  // 去重（同一天可能有重复的 ADDED + UPDATE 组合）
  const seen = new Set();
  const unique = [];
  for (const e of entries) {
    const k = `${e.date}|${e.id}|${e.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(e);
  }
  unique.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    const order = { ADDED: 0, UPDATE: 1, REMOVED: 2 };
    return (order[a.status] || 9) - (order[b.status] || 9);
  });

  // 对比上次保存的，算本次新增的条数
  let prevEntries = [];
  try { prevEntries = readJson(CHEATS_HISTORY_PATH, { entries: [] }).entries || []; } catch {}
  const prevKeys = new Set(prevEntries.map((e) => `${e.date}|${e.id}|${e.version}`));
  let newSinceLastSync = 0;
  for (const e of unique) if (!prevKeys.has(`${e.date}|${e.id}|${e.version}`)) newSinceLastSync++;

  writeJson(CHEATS_HISTORY_PATH, { updatedAt: nowLocal(), entryCount: unique.length, entries: unique });
  return { count: unique.length, newSinceLastSync, entries: unique };
}

// 如果仓库里的 README 比上次解析结果更新，则自动重新解析版本历史。
// 用于兜底：定时任务或手动 git 更新后，页面一打开就能看到最新记录。
function maybeParseOnRead() {
  const readme = path.join(CHEATS_DIR, 'README.md');
  if (!fs.existsSync(readme)) return;
  let readmeMs = 0;
  try { readmeMs = fs.statSync(readme).mtimeMs; } catch { return; }
  const hist = readJson(CHEATS_HISTORY_PATH, { updatedAt: null });
  const lastMs = hist.updatedAt ? Date.parse(String(hist.updatedAt).replace(' ', 'T')) : 0;
  if (!(readmeMs > (Number.isFinite(lastMs) ? lastMs : 0) + 1000)) return;
  try {
    const result = parseCheatsVersionHistory();
    cheatsState.output += `\n[版本历史] 检测到 README 更新，重新解析 ${result.count} 条记录，新增 ${result.newSinceLastSync} 条`;
    if (cheatsState.output.length > 12000) cheatsState.output = cheatsState.output.slice(-12000);
    const tr = startTitleTranslation();
    if (tr.started) cheatsState.output += `\n[翻译] 已启动游戏名翻译，共 ${tr.total} 条待处理`;
  } catch {}
}

// ---------- 游戏名中文翻译 ----------
const titleTranslateState = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null
};

function loadTitleZhMap() {
  const data = readJson(CHEATS_TITLE_ZH_PATH, { map: {} });
  return data && data.map && typeof data.map === 'object' ? data.map : {};
}

function saveTitleZhMap(map) {
  writeJson(CHEATS_TITLE_ZH_PATH, { updatedAt: nowLocal(), count: Object.keys(map).length, map });
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// 单个游戏名翻译：优先 Google 免费接口（简体中文、质量好），失败回退 MyMemory
async function translateGameTitle(text) {
  try {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' +
      encodeURIComponent(text);
    const res = await fetch(url, { headers: { 'User-Agent': 'PS5-Local-Hub/1.0' } });
    if (res.ok) {
      const data = await res.json();
      const parts = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
      const zh = parts.map((p) => (p && p[0] ? p[0] : '')).join('').trim();
      if (zh && zh !== text) return decodeHtmlEntities(zh);
    }
  } catch {}

  const url2 =
    'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en%7Czh-CN';
  const res2 = await fetch(url2, { headers: { 'User-Agent': 'PS5-Local-Hub/1.0' } });
  if (!res2.ok) throw new Error('翻译接口 HTTP ' + res2.status);
  const d2 = await res2.json();
  const zh2 = decodeHtmlEntities(
    d2 && d2.responseData && d2.responseData.translatedText ? d2.responseData.translatedText : ''
  ).trim();
  if (!zh2 || /MYMEMORY WARNING|QUERY LENGTH LIMIT|PLEASE SELECT TWO DISTINCT/i.test(zh2)) {
    throw new Error('翻译接口返回无效结果');
  }
  return zh2;
}

function collectCheatsTitles() {
  const hist = readJson(CHEATS_HISTORY_PATH, { entries: [] });
  const set = new Set();
  for (const e of hist.entries || []) {
    if (e && e.title) set.add(e.title);
  }
  return [...set];
}

function startTitleTranslation(limit = 3000) {
  if (titleTranslateState.running) return { started: false, running: true, message: '翻译任务已在进行' };
  const map = loadTitleZhMap();
  const targets = collectCheatsTitles().filter((t) => !map[t]);
  if (!targets.length) return { started: false, message: '所有游戏名均已翻译' };

  const queue = targets.slice(0, limit);
  titleTranslateState.running = true;
  titleTranslateState.total = targets.length;
  titleTranslateState.done = 0;
  titleTranslateState.failed = 0;
  titleTranslateState.startedAt = nowLocal();
  titleTranslateState.finishedAt = null;
  titleTranslateState.lastError = null;

  const CONCURRENCY = 4;
  let cursor = 0;
  let consecutiveFailures = 0;
  let aborted = false;

  const flush = () => saveTitleZhMap(map);

  async function worker() {
    while (!aborted && cursor < queue.length) {
      const title = queue[cursor++];
      try {
        const zh = await translateGameTitle(title);
        map[title] = zh;
        titleTranslateState.done++;
        consecutiveFailures = 0;
        if (titleTranslateState.done % 20 === 0) flush();
      } catch (err) {
        titleTranslateState.failed++;
        consecutiveFailures++;
        titleTranslateState.lastError = err.message;
        // 连续失败过多，说明接口被限流或网络异常，停止本次翻译
        if (consecutiveFailures >= 15) aborted = true;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  Promise.all(Array.from({ length: CONCURRENCY }, () => worker())).then(() => {
    flush();
    titleTranslateState.running = false;
    titleTranslateState.finishedAt = nowLocal();
    const suffix = aborted ? '（连续失败过多，已提前停止）' : '';
    cheatsState.output +=
      `\n[翻译] 成功 ${titleTranslateState.done} 条，失败 ${titleTranslateState.failed} 条${suffix}`;
    if (cheatsState.output.length > 12000) cheatsState.output = cheatsState.output.slice(-12000);
  });

  return { started: true, total: queue.length, pending: targets.length - queue.length };
}

function titleTranslateSummary(map, titles) {
  const dict = map || loadTitleZhMap();
  const list = titles || collectCheatsTitles();
  let translated = 0;
  for (const t of list) if (dict[t]) translated++;
  return {
    totalTitles: list.length,
    translated,
    pending: list.length - translated,
    running: titleTranslateState.running,
    done: titleTranslateState.done,
    failed: titleTranslateState.failed,
    startedAt: titleTranslateState.startedAt,
    finishedAt: titleTranslateState.finishedAt,
    lastError: titleTranslateState.lastError
  };
}

function cheatsHistory() {
  const hist = readJson(CHEATS_HISTORY_PATH, { updatedAt: null, entryCount: 0, entries: [] });
  const map = loadTitleZhMap();
  const entries = (hist.entries || []).map((e) => ({ ...e, titleZh: map[e.title] || '' }));
  const titles = [...new Set(entries.map((e) => e.title).filter(Boolean))];
  return { ...hist, entries, translation: titleTranslateSummary(map, titles) };
}

function latestSync() {
  return readJson(SYNC_PATH, { at: null, ok: false, firstRun: false });
}

function startSync() {
  if (syncState.running) {
    return { started: false, running: true, message: '同步任务已在运行' };
  }
  syncState.running = true;
  syncState.startedAt = nowLocal();
  syncState.finishedAt = null;
  syncState.output = '';
  syncState.lastError = null;

  const child = spawn(process.execPath, [...NODE_TLS_ARGS, SYNC_SCRIPT], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  syncState.process = child;

  const collect = (buf) => {
    syncState.output += buf.toString('utf8');
    if (syncState.output.length > 12000) syncState.output = syncState.output.slice(-12000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('close', (code) => {
    syncState.running = false;
    syncState.finishedAt = nowLocal();
    syncState.process = null;
    if (code !== 0) syncState.lastError = `同步脚本退出码 ${code}`;
  });
  child.on('error', (err) => {
    syncState.running = false;
    syncState.finishedAt = nowLocal();
    syncState.lastError = err.message;
    syncState.process = null;
  });

  return { started: true, running: true };
}

function maybeAutoSync() {
  const cfg = loadConfig();
  if (!cfg.autoSyncOnStart) return;
  const sync = latestSync();
  let needed = false;
  if (!sync || !sync.at) needed = true;
  else {
    const last = new Date(String(sync.at).replace(' ', 'T'));
    const hours = (Date.now() - last.getTime()) / 3600000;
    const sameDay = String(sync.at).slice(0, 10) === todayLocal();
    if (!sameDay || !Number.isFinite(hours) || hours >= Number(cfg.syncIfOlderThanHours || 6)) needed = true;
  }
  if (needed) {
    setTimeout(() => {
      console.log('[服务端] 数据不是今天或已过期，自动开始同步...');
      startSync();
    }, 800);
  }
}

// ---------- 下载 ----------
const jobs = new Map();

function summarizeJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    targetDir: job.targetDir,
    totalFiles: job.totalFiles,
    doneFiles: job.doneFiles,
    failedFiles: job.failedFiles,
    skippedFiles: job.skippedFiles,
    cancelledFiles: job.cancelledFiles || 0,
    totalBytes: job.totalBytes,
    doneBytes: job.doneBytes,
    cancelRequested: Boolean(job.cancelRequested),
    items: job.items,
    errors: job.errors
  };
}

// 取消单个文件：立即中断下载并删除 .part
function cancelFile(job, file) {
  if (!file) return false;
  if (file.status === 'done' || file.status === 'skipped' || file.status === 'cancelled') return false;
  file.cancelled = true;
  if (job.activeControllers) {
    for (const [key, ctrl] of job.activeControllers) {
      // 多连接下载时，同一文件的分块控制器以 file.id#序号 注册
      if (key === file.id || key.startsWith(file.id + '#')) {
        try { ctrl.abort(); } catch {}
      }
    }
  }
  return true;
}

// 取消整个任务：中断当前下载 + 跳过未开始的
function cancelJob(job) {
  if (!job || job.cancelRequested) return false;
  job.cancelRequested = true;
  if (job.activeControllers) {
    for (const ctrl of job.activeControllers.values()) {
      try { ctrl.abort(); } catch {}
    }
  }
  return true;
}

// ---------- 断点续传 / 多连接下载 ----------
// ≥16MB 的文件用 4 个连接分段并行下载；所有未完成的分片在失败时保留，重试时自动续传
const MULTI_CONN_MIN_SIZE = 16 * 1024 * 1024;
const CONN_COUNT = 4;

// 读取网络流并用 writeSync 直接写文件（避免流缓冲在慢速网络下长时间不落盘）
// fd 以 'w' 或 'a' 打开，写入位置由系统自动推进
async function pumpStream(job, file, res, fd, controller) {
  const reader = res.body.getReader();
  const started = Date.now();
  for (;;) {
    if (file.cancelled || job.cancelRequested) {
      controller.abort();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    fs.writeSync(fd, buf);
    file.received += buf.length;
    job.doneBytes += buf.length;
    if (Date.now() - started > 30 * 60 * 1000) throw new Error('下载超时');
  }
  if (file.cancelled || job.cancelRequested) {
    throw Object.assign(new Error('已取消'), { code: 'CANCELLED' });
  }
}

// 单连接下载（支持 .part 断点续传）
async function downloadSingle(job, file, url, tmp) {
  let existing = 0;
  try { if (fs.existsSync(tmp)) existing = fs.statSync(tmp).size; } catch {}
  // 残片比目标还大：数据异常，删除重下
  if (file.size > 0 && existing > file.size) {
    try { fs.unlinkSync(tmp); } catch {}
    existing = 0;
  }
  // 上次其实已经下完，只是没来得及改名
  if (file.size > 0 && existing === file.size) {
    file.received = existing;
    job.doneBytes += existing;
    return;
  }

  const headers = { 'User-Agent': 'PS5-Local-Hub/1.0' };
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  const controller = new AbortController();
  job.activeControllers.set(file.id, controller);
  let timer = null;
  let fd = null;
  try {
    timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const res = await fetch(url, { redirect: 'follow', headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('响应没有内容');
    // 服务器忽略 Range 返回 200（全量）：从头重写
    const append = existing > 0 && res.status === 206;
    if (append) {
      file.received = existing;
      job.doneBytes += existing;
    }
    fd = fs.openSync(tmp, append ? 'a' : 'w');
    await pumpStream(job, file, res, fd, controller);
    fs.closeSync(fd);
    fd = null;
  } catch (err) {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    job.activeControllers.delete(file.id);
  }
}

// 多连接分块下载：每块写到 tmp.0 / tmp.1 ...，完成后按顺序拼接成 tmp
async function downloadChunked(job, file, url, tmp) {
  const size = file.size;
  const cs = Math.ceil(size / CONN_COUNT);
  const chunks = [];
  for (let i = 0; i < CONN_COUNT; i++) {
    const start = i * cs;
    const end = Math.min((i + 1) * cs, size) - 1;
    if (start > end) break;
    chunks.push({ index: i, start, end, len: end - start + 1, part: `${tmp}.${i}`, have: 0 });
  }
  // 续传：统计已有分块进度
  let received = 0;
  for (const c of chunks) {
    try { if (fs.existsSync(c.part)) c.have = fs.statSync(c.part).size; } catch {}
    if (c.have > c.len) {
      try { fs.unlinkSync(c.part); } catch {}
      c.have = 0;
    }
    received += c.have;
  }
  file.received = received;
  job.doneBytes += received;

  await Promise.all(
    chunks
      .filter((c) => c.have < c.len)
      .map((c) => withRetry(() => downloadChunk(job, file, url, c), `${file.name} 分块${c.index}`))
  );

  // 拼接（同步读写，8MB 缓冲）
  const out = fs.openSync(tmp, 'w');
  try {
    for (const c of chunks) {
      const inFd = fs.openSync(c.part, 'r');
      try {
        const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
        let n;
        while ((n = fs.readSync(inFd, buf, 0, buf.length, null)) > 0) {
          fs.writeSync(out, buf.subarray(0, n));
        }
      } finally {
        fs.closeSync(inFd);
      }
    }
  } finally {
    fs.closeSync(out);
    for (const c of chunks) { try { fs.unlinkSync(c.part); } catch {} }
  }
}

// 网络抖动自动重试：取消和不支持分段的错误不重试，其余错误最多 3 次
async function withRetry(fn, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err && (err.code === 'CANCELLED' || err.code === 'FALLBACK_SINGLE')) throw err;
      if (attempt < 3) {
        console.log(`[下载] ${label} 第 ${attempt} 次失败（${err && err.message}），2 秒后重试`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastErr;
}

async function downloadChunk(job, file, url, chunk) {
  const key = `${file.id}#${chunk.index}`;
  const controller = new AbortController();
  job.activeControllers.set(key, controller);
  let timer = null;
  let fd = null;
  try {
    timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const from = chunk.start + chunk.have;
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'PS5-Local-Hub/1.0', Range: `bytes=${from}-${chunk.end}` },
      signal: controller.signal
    });
    // 服务器不支持 Range：抛出让上层回退到单连接
    if (res.status === 200) throw Object.assign(new Error('服务器不支持分段下载'), { code: 'FALLBACK_SINGLE' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('响应没有内容');
    console.log(`[下载] ${file.name} 分块${chunk.index} 开始（${from}-${chunk.end}，HTTP ${res.status}）`);
    fd = fs.openSync(chunk.part, chunk.have > 0 ? 'a' : 'w');
    await pumpStream(job, file, res, fd, controller);
    fs.closeSync(fd);
    fd = null;
    chunk.have = chunk.len;
    console.log(`[下载] ${file.name} 分块${chunk.index} 完成`);
  } catch (err) {
    try { if (fd !== null) fs.closeSync(fd); } catch {}
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    job.activeControllers.delete(key);
  }
}

async function downloadOneFile(job, file, url, destDir) {
  ensureDir(destDir);
  // 扁平下载优先使用外层预先算好的 flatName，否则回退到原始文件名
  const finalName = file.flatName || sanitizeSegment(file.name, 'asset');
  const dest = path.join(destDir, finalName);
  file.path = dest;

  // 已取消：直接标记，不下载
  if (file.cancelled || job.cancelRequested) {
    file.status = 'cancelled';
    file.error = '已取消';
    job.cancelledFiles = (job.cancelledFiles || 0) + 1;
    return false;
  }

  try {
    if (file.size > 0 && fs.existsSync(dest)) {
      const st = fs.statSync(dest);
      if (st.size === file.size) {
        file.status = 'skipped';
        file.received = st.size;
        job.doneFiles++;
        job.skippedFiles++;
        job.doneBytes += st.size;
        return true;
      }
    }
  } catch {}

  const tmp = dest + '.part';
  file.status = 'downloading';
  file.received = 0;
  job.activeControllers = job.activeControllers || new Map();

  try {
    if (file.size >= MULTI_CONN_MIN_SIZE) {
      console.log(`[下载] ${file.name}（${(file.size / 1048576).toFixed(1)}MB）使用 ${CONN_COUNT} 连接分段下载`);
      try {
        await downloadChunked(job, file, url, tmp);
      } catch (err) {
        if (err && err.code === 'FALLBACK_SINGLE' && !file.cancelled && !job.cancelRequested) {
          // 回退单连接：清掉分块和已计入的进度，从头下
          job.doneBytes -= file.received;
          file.received = 0;
          for (let i = 0; i < CONN_COUNT; i++) { try { fs.unlinkSync(`${tmp}.${i}`); } catch {} }
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
          await downloadSingle(job, file, url, tmp);
        } else {
          throw err;
        }
      }
    } else {
      await withRetry(() => downloadSingle(job, file, url, tmp), file.name);
    }

    if (file.size > 0 && file.received !== file.size) {
      throw new Error(`文件大小不一致（期望 ${file.size}，实际 ${file.received}）`);
    }
    // 目标已存在但大小不对（旧版本/残次）：先删再改名
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
    fs.renameSync(tmp, dest);
    file.status = 'done';
    job.doneFiles++;
    return true;
  } catch (err) {
    const isCancelled = err && (err.code === 'CANCELLED' || err.name === 'AbortError') && (file.cancelled || job.cancelRequested);
    if (isCancelled) {
      // 取消：删除未完成的所有分片
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      for (let i = 0; i < CONN_COUNT; i++) { try { fs.unlinkSync(`${tmp}.${i}`); } catch {} }
      file.status = 'cancelled';
      file.error = '已取消';
      job.cancelledFiles = (job.cancelledFiles || 0) + 1;
    } else {
      // 失败：保留 .part / 分块，重试时断点续传
      file.status = 'failed';
      file.error = err && err.name === 'AbortError' ? '下载超时' : (err && err.message) || String(err);
      job.failedFiles++;
      job.errors.push({ fullName: file.fullName, name: file.name, error: file.error });
    }
    return false;
  }
}

async function runJob(job, tasks) {
  const byRepo = new Map();
  for (const task of tasks) {
    if (!byRepo.has(task.repo.key)) byRepo.set(task.repo.key, { repo: task.repo, assets: [] });
    byRepo.get(task.repo.key).assets.push(task.asset);
  }

  // 扁平下载：所有文件都放在 targetDir 根目录，文件名拼上 {owner_repo}_{tag}_{originalFilename}
  // 方便用户浏览和查找
  const groups = [...byRepo.values()];
  groups.forEach(({ repo, assets }, itemIndex) => {
    const tag = sanitizeSegment(repo.latestRelease ? repo.latestRelease.tagName : 'no-release', 'no-release');
    const ownerRepo = sanitizeSegment(String(repo.fullName || repo.name || 'repo').replace(/\//g, '_'), 'repo');
    job.items.push({
      key: repo.key,
      fullName: repo.fullName,
      name: repo.name,
      categoryName: repo.categoryName,
      tagName: repo.latestRelease ? repo.latestRelease.tagName : null,
      dir: job.targetDir,
      repo,
      flatPrefix: `${ownerRepo}_${tag}_`,
      files: assets.map((a, fi) => {
        const originalName = sanitizeSegment(a.name, 'asset');
        const flatName = `${ownerRepo}_${tag}_${originalName}`;
        return {
          id: `i${itemIndex}f${fi}`,
          fullName: repo.fullName,
          name: a.name,
          flatName,
          size: a.size || 0,
          status: 'pending',
          received: 0,
          error: null,
          path: null,
          cancelled: false
        };
      })
    });
  });

  // 再逐个下载
  for (const item of job.items) {
    if (job.cancelRequested) break;
    const repo = item.repo;
    const assets = groups.find((g) => g.repo.key === repo.key).assets;

    let repoOk = true;
    for (let i = 0; i < assets.length; i++) {
      if (job.cancelRequested) {
        // 整个任务被取消：剩余文件统一标记为取消
        for (let j = i; j < assets.length; j++) {
          if (item.files[j].status === 'pending') {
            item.files[j].status = 'cancelled';
            item.files[j].error = '已取消';
            job.cancelledFiles = (job.cancelledFiles || 0) + 1;
          }
        }
        break;
      }
      const file = item.files[i];
      if (file.cancelled) {
        file.status = 'cancelled';
        file.error = '已取消';
        job.cancelledFiles = (job.cancelledFiles || 0) + 1;
        repoOk = false;
        continue;
      }
      // 扁平下载：直接把 flatName 传给 downloadOneFile，它内部用 path.join(targetDir, flatName) 拼路径
      const ok = await downloadOneFile(job, file, assets[i].downloadUrl, job.targetDir);
      if (!ok) repoOk = false;
    }

    if (repoOk && !job.cancelRequested) {
      const cfg = loadConfig();
      const downloads = readJson(DOWNLOADS_PATH, {});

      // 旧版本清理：根据 downloads.json 里该 repo 的上一条 fileMap，删除旧的 flat 文件
      if (cfg.deleteOldVersions && downloads[repo.key] && Array.isArray(downloads[repo.key].fileMap)) {
        try {
          const oldFlatNames = new Set(downloads[repo.key].fileMap.map((m) => m.flatName));
          const currentFlatNames = new Set(item.files.filter((f) => f.status === 'done' || f.status === 'skipped').map((f) => f.flatName));
          for (const oldName of oldFlatNames) {
            if (currentFlatNames.has(oldName)) continue; // 同名文件说明是同版本，不动
            const full = path.join(job.targetDir, oldName);
            try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch {}
            // 同时清掉该文件可能遗留的 .part / .part.N
            try { if (fs.existsSync(full + '.part')) fs.unlinkSync(full + '.part'); } catch {}
            for (let n = 0; n < CONN_COUNT; n++) { try { if (fs.existsSync(`${full}.part.${n}`)) fs.unlinkSync(`${full}.part.${n}`); } catch {} }
          }
        } catch (err) {
          job.errors.push({ fullName: repo.fullName, name: '(清理旧版本)', error: err.message });
        }
      }

      const flatFiles = item.files.filter((f) => f.status === 'done' || f.status === 'skipped');
      downloads[repo.key] = {
        key: repo.key,
        fullName: repo.fullName,
        name: repo.name,
        categoryName: repo.categoryName,
        tagName: repo.latestRelease ? repo.latestRelease.tagName : null,
        dir: job.targetDir,
        files: flatFiles.map((f) => f.name),
        fileMap: flatFiles.map((f) => ({ original: f.name, flatName: f.flatName, path: f.path })),
        at: nowLocal()
      };
      writeJson(DOWNLOADS_PATH, downloads);

      // 下载历史日志：追加一条（保留所有历史，用于前端"下载记录"页面）
      try {
        const hist = readJson(DOWNLOAD_HISTORY_PATH, []);
        hist.push({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          date: nowLocal().slice(0, 10),
          time: nowLocal().slice(11),
          ts: Date.now(),
          jobId: job.id,
          repoKey: repo.key,
          fullName: repo.fullName,
          name: repo.name,
          categoryName: repo.categoryName,
          tagName: repo.latestRelease ? repo.latestRelease.tagName : null,
          files: flatFiles.map((f) => ({ name: f.name, flatName: f.flatName, size: f.size || 0, path: f.path })),
          targetDir: job.targetDir,
          status: 'ok'
        });
        writeJson(DOWNLOAD_HISTORY_PATH, hist.length > 2000 ? hist.slice(-2000) : hist);
      } catch (err) {
        job.errors.push({ fullName: repo.fullName, name: '(写入下载历史)', error: err.message });
      }
    }
  }

  // 把所有尚未开始（pending）的文件标记为取消
  for (const item of job.items) {
    for (const f of item.files) {
      if (f.status === 'pending') {
        f.status = 'cancelled';
        f.error = '已取消';
        job.cancelledFiles = (job.cancelledFiles || 0) + 1;
      }
    }
  }

  if (job.cancelRequested) {
    job.status = 'cancelled';
  } else if (job.failedFiles > 0) {
    job.status = 'completed_with_errors';
  } else {
    job.status = 'completed';
  }
  job.finishedAt = nowLocal();
}

function startDownload(body) {
  // 并发守卫：同一时间只允许一个下载任务，避免“下载中重新开始”的错觉
  const running = [...jobs.values()].find((j) => j.status === 'running');
  if (running) {
    return { __busy: true, job: summarizeJob(running) };
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new Error('没有选择要下载的插件');
  const db = readJson(DATA_FILE, null);
  if (!db || !Array.isArray(db.repos)) throw new Error('本地数据尚未生成，请先同步');

  const map = new Map(db.repos.map((r) => [r.key, r]));
  const tasks = [];
  const errors = [];

  for (const item of items) {
    const repo = map.get(item.key);
    if (!repo) {
      errors.push({ key: item.key, error: '未找到插件数据' });
      continue;
    }
    if (!repo.latestRelease || !repo.latestRelease.assets || !repo.latestRelease.assets.length) {
      errors.push({ key: item.key, fullName: repo.fullName, error: '该项目暂无可下载的 Release 附件' });
      continue;
    }
    const names = Array.isArray(item.assetNames) && item.assetNames.length ? new Set(item.assetNames) : null;
    const assets = repo.latestRelease.assets.filter((a) => !names || names.has(a.name));
    if (!assets.length) {
      errors.push({ key: item.key, fullName: repo.fullName, error: '未找到指定的附件' });
      continue;
    }
    for (const asset of assets) tasks.push({ repo, asset });
  }

  if (!tasks.length) {
    throw new Error(errors.length ? errors.map((e) => `${e.fullName || e.key}: ${e.error}`).join('；') : '没有可下载的文件');
  }

  const cfg = loadConfig();
  let targetDir = body.dir ? String(body.dir).trim() : cfg.downloadDir;
  if (!path.isAbsolute(targetDir)) targetDir = path.resolve(LOCAL, targetDir);
  ensureDir(targetDir);

  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    status: 'running',
    createdAt: nowLocal(),
    finishedAt: null,
    targetDir,
    totalFiles: tasks.length,
    doneFiles: 0,
    failedFiles: 0,
    skippedFiles: 0,
    cancelledFiles: 0,
    totalBytes: tasks.reduce((s, t) => s + (t.asset.size || 0), 0),
    doneBytes: 0,
    items: [],
    errors,
    cancelRequested: false,
    activeControllers: new Map()
  };
  jobs.set(job.id, job);
  runJob(job, tasks).catch((err) => {
    job.status = 'failed';
    job.finishedAt = nowLocal();
    job.errors.push({ error: err.message || String(err) });
  });
  return job;
}

// ---------- 路由 ----------
async function handleApi(req, res, pathname, searchParams) {
  const method = req.method;

  if (pathname === '/api/ping' && method === 'GET') {
    return sendJson(res, 200, { ok: true, time: nowLocal() });
  }

  if (pathname === '/api/overview' && method === 'GET') {
    const db = readJson(DATA_FILE, null);
    const daily = readJson(DAILY_PATH, { days: {} });
    const sync = latestSync();
    const cfg = loadConfig();
    const today = todayLocal();
    const day = daily.days && daily.days[today] ? daily.days[today] : null;
    const downloads = readJson(DOWNLOADS_PATH, {});
    const games = gamesStatus();
    return sendJson(res, 200, {
      ok: Boolean(db && db.repos),
      needsSync: !db || !Array.isArray(db.repos),
      todayDate: today,
      generatedAt: db ? db.generatedAt : null,
      sourceExportedAt: db ? db.sourceExportedAt : null,
      categories: db ? db.categories : [],
      repos: db ? db.repos : [],
      today: day,
      sync: { ...sync, running: syncState.running, liveOutput: syncState.output.slice(-4000), lastError: syncState.lastError },
      games: {
        todayTotal: games.todayTotal,
        ps5Total: games.ps5Total,
        ps4Total: games.ps4Total,
        running: games.running
      },
      config: {
        downloadDir: cfg.downloadDir,
        deleteOldVersions: cfg.deleteOldVersions,
        autoSyncOnStart: cfg.autoSyncOnStart,
        syncIfOlderThanHours: cfg.syncIfOlderThanHours,
        port: cfg.port
      },
      downloads
    });
  }

  if (pathname === '/api/sync' && method === 'GET') {
    return sendJson(res, 200, {
      ...latestSync(),
      running: syncState.running,
      startedAt: syncState.startedAt,
      finishedAt: syncState.finishedAt,
      lastError: syncState.lastError,
      output: syncState.output.slice(-4000)
    });
  }

  if (pathname === '/api/sync' && method === 'POST') {
    const result = startSync();
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, loadConfig());
  }

  if (pathname === '/api/config' && method === 'PUT') {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) patch.downloadDir = body.downloadDir.trim();
    if (typeof body.deleteOldVersions === 'boolean') patch.deleteOldVersions = body.deleteOldVersions;
    if (typeof body.autoSyncOnStart === 'boolean') patch.autoSyncOnStart = body.autoSyncOnStart;
    if (typeof body.syncIfOlderThanHours === 'number' && body.syncIfOlderThanHours >= 0) patch.syncIfOlderThanHours = body.syncIfOlderThanHours;
    const cfg = saveConfig(patch);
    ensureDir(cfg.downloadDir);
    return sendJson(res, 200, { ok: true, config: cfg });
  }

  if (pathname === '/api/download' && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = startDownload(body);
      if (result && result.__busy) {
        return sendJson(res, 200, { ok: true, busy: true, jobId: result.job.id, job: result.job });
      }
      return sendJson(res, 200, { ok: true, jobId: result.id, job: summarizeJob(result) });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message || String(err) });
    }
  }

  if (pathname.startsWith('/api/download/') && method === 'GET') {
    const id = pathname.split('/')[3];
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: '下载任务不存在或已过期' });
    return sendJson(res, 200, { ok: true, job: summarizeJob(job) });
  }

  // 取消整个下载任务
  if (pathname.match(/^\/api\/download\/[^/]+\/cancel$/) && method === 'POST') {
    const id = pathname.split('/')[3];
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: '下载任务不存在或已过期' });
    const cancelled = cancelJob(job);
    return sendJson(res, 200, { ok: true, cancelled, job: summarizeJob(job) });
  }

  // 取消单个文件：POST /api/download/:id/file/:fileId/cancel
  if (pathname.match(/^\/api\/download\/[^/]+\/file\/[^/]+\/cancel$/) && method === 'POST') {
    const parts = pathname.split('/');
    const id = parts[3];
    const fileId = parts[5];
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { ok: false, error: '下载任务不存在或已过期' });
    let target = null;
    for (const item of job.items) {
      for (const f of item.files) {
        if (f.id === fileId) { target = f; break; }
      }
      if (target) break;
    }
    if (!target) return sendJson(res, 404, { ok: false, error: '文件不存在' });
    const cancelled = cancelFile(job, target);
    return sendJson(res, 200, { ok: true, cancelled, job: summarizeJob(job) });
  }

  if (pathname === '/api/open-folder' && method === 'POST') {
    const body = await readBody(req);
    let dir = body.dir ? String(body.dir) : loadConfig().downloadDir;
    if (!path.isAbsolute(dir)) dir = path.resolve(LOCAL, dir);
    try {
      ensureDir(dir);
      const child = spawn('explorer.exe', [dir], { detached: true, windowsHide: false });
      child.unref();
      return sendJson(res, 200, { ok: true, dir });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/open-file' && method === 'POST') {
    const body = await readBody(req);
    const dir = body.dir ? String(body.dir) : '';
    let file = body.file ? String(body.file) : '';
    if (!file) return sendJson(res, 400, { ok: false, error: '缺少文件路径' });
    if (dir && !path.isAbsolute(file)) file = path.join(dir, file);
    const target = resolveExistingFile(file, dir || path.dirname(file));
    if (!target) {
      // 文件确实不在了（被清理或移动）：目录存在时直接打开目录，避免只报错
      const folder = dir || path.dirname(file);
      if (folder && fs.existsSync(folder)) {
        try {
          const child = spawn('explorer.exe', [folder], { detached: true, windowsHide: false });
          child.unref();
          return sendJson(res, 200, { ok: true, fallback: true, dir: folder });
        } catch {}
      }
      return sendJson(res, 404, { ok: false, error: '文件不存在，可能已被清理或移动' });
    }
    try {
      // explorer /select 会打开资源管理器并选中目标文件；引号包裹路径处理空格
      const child = spawn('explorer.exe', ['/select,"' + target + '"'], { detached: true, windowsHide: false, shell: true });
      child.unref();
      return sendJson(res, 200, { ok: true, file: target });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const date = searchParams.get('date') || todayLocal();
    const file = path.join(LOG_DIR, `${sanitizeSegment(date, 'date')}.md`);
    if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: '当天日报不存在' });
    return sendJson(res, 200, { ok: true, date, markdown: fs.readFileSync(file, 'utf8') });
  }

  // ---------- 金手指同步 ----------
  if (pathname === '/api/cheats' && method === 'GET') {
    maybeParseOnRead();
    const status = cheatsStatus();
    const hist = cheatsHistory();
    return sendJson(res, 200, { ok: true, ...status, history: hist });
  }

  if (pathname === '/api/cheats/sync' && method === 'POST') {
    const result = startCheatsSync();
    return sendJson(res, result.started ? 200 : 400, result);
  }

  // 手动触发游戏名翻译（补齐未翻译的标题）
  if (pathname === '/api/cheats/translate' && method === 'POST') {
    const result = startTitleTranslation();
    return sendJson(res, result.started ? 200 : 400, result);
  }

  if (pathname === '/api/open-cheats' && method === 'POST') {
    try {
      ensureDir(CHEATS_DIR);
      const child = spawn('explorer.exe', [CHEATS_DIR], { detached: true, windowsHide: false });
      child.unref();
      return sendJson(res, 200, { ok: true, dir: CHEATS_DIR });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ---------- 游戏资源同步（PS4/PS5） ----------
  if (pathname === '/api/games' && method === 'GET') {
    const status = gamesStatus();
    if (searchParams.get('full') === '1') {
      const snapshot = readJson(GAMES_SNAPSHOT_PATH, { ps5: [], ps4: [] });
      return sendJson(res, 200, {
        ...status,
        ps5List: (snapshot.ps5 || []).map((g) => ({ ...g, platform: 'PS5' })),
        ps4List: (snapshot.ps4 || []).map((g) => ({ ...g, platform: 'PS4' }))
      });
    }
    return sendJson(res, 200, status);
  }

  if (pathname === '/api/games/sync' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const result = startGamesSync(Boolean(body && body.quick));
    return sendJson(res, result.started ? 200 : 400, result);
  }

  // 下载历史
  if (pathname === '/api/download-history' && method === 'GET') {
    let hist = readJson(DOWNLOAD_HISTORY_PATH, []);
    // 支持按 repoKey / 日期范围过滤
    const qRepo = searchParams.get('repo');
    const qDate = searchParams.get('date');
    if (qRepo) hist = hist.filter((e) => e.repoKey === qRepo);
    if (qDate) hist = hist.filter((e) => e.date === qDate);
    // 默认按时间倒序
    hist = hist.slice().sort((a, b) => b.ts - a.ts);
    return sendJson(res, 200, { ok: true, total: hist.length, history: hist });
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, url.searchParams).catch((err) => {
      console.error('[服务端] 接口错误：', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message || String(err) });
      else res.end();
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }
  serveStatic(req, res, pathname);
});

ensureDir(STATE_DIR);
ensureDir(LOG_DIR);
ensureDir(SITE);
ensureDir(path.join(SITE, 'data'));

// 启动时清理下载目录中的残片：.part / .part.N 且超过 24 小时（24 小时内的保留用于断点续传）
function cleanupStaleParts(dir) {
  let removed = 0;
  const maxAge = 24 * 3600 * 1000;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.part(\.\d+)?$/.test(entry.name)) {
        try {
          const st = fs.statSync(full);
          if (Date.now() - st.mtimeMs > maxAge) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch {}
      }
    }
  };
  walk(dir);
  return removed;
}

const cfg = loadConfig();
try {
  const cleaned = cleanupStaleParts(cfg.downloadDir);
  if (cleaned > 0) console.log(`[服务端] 已清理 ${cleaned} 个未完成的 .part 临时文件`);
} catch {}
if (!process.execArgv.includes('--use-system-ca') && !process.env.NODE_EXTRA_CA_CERTS) {
  console.log('[服务端] 提示：如果下载附件出现 fetch failed / 证书错误，请通过 local\\start.ps1 启动（会自动带上 --use-system-ca）。');
}
server.listen(Number(cfg.port) || 8123, cfg.host || '127.0.0.1', () => {
  console.log(`[服务端] PS5 插件更新中心已启动：http://${cfg.host || '127.0.0.1'}:${cfg.port || 8123}/`);
  console.log(`[服务端] 下载目录：${cfg.downloadDir}`);
  console.log(`[服务端] 按 Ctrl+C 停止服务`);
  maybeAutoSync();
  // 启动时后台补齐金手指游戏名的中文翻译
  try {
    const tr = startTitleTranslation();
    if (tr.started) console.log(`[服务端] 已启动游戏名翻译，共 ${tr.total} 条待处理`);
  } catch {} 
});

process.on('SIGINT', () => {
  console.log('\n[服务端] 正在停止...');
  server.close(() => process.exit(0));
});
