/*
 * PS4/PS5 游戏资源同步脚本
 * 抓取 https://2468c.com 的 PS4 / PS5 游戏列表，
 * 与本地快照对比，识别每日新增游戏，并保存到状态文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCAL = path.join(ROOT, 'local');
const STATE_DIR = path.join(LOCAL, 'state');

const SNAPSHOT_PATH = path.join(STATE_DIR, 'games-snapshot.json');
const DAILY_PATH = path.join(STATE_DIR, 'games-daily.json');
const LATEST_PATH = path.join(STATE_DIR, 'games-latest-sync.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const PLATFORMS = {
  ps5: { name: 'PS5', url: 'https://2468c.com/ps5game' },
  ps4: { name: 'PS4', url: 'https://2468c.com/ps4' }
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

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function nowLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

// 首次请求会返回 403 并下发 cookie，携带该 cookie 再次请求才能拿到真实页面
async function fetchHtml(url, retries = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = { 'User-Agent': UA };
      let res = await fetch(url, { headers });
      if (res.status === 403) {
        const cookie = res.headers.get('set-cookie') || '';
        res = await fetch(url, {
          headers: {
            ...headers,
            Cookie: cookie,
            Accept: 'text/html,application/xhtml+xml',
            Referer: 'https://2468c.com/'
          }
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastErr;
}

// 从单页 HTML 解析游戏列表
function parseGames(html) {
  const games = [];
  const re = /<article[^>]*id="post-(\d+)"[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const id = m[1];
    const titleM = block.match(
      /<h2 class="entry-title"><a[^>]*href="https:\/\/2468c\.com\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/
    );
    const imgM = block.match(/data-src="([^"]+)"/);
    const dateM = block.match(/<time datetime="([^"]+)"/);
    if (!titleM) continue;
    games.push({
      id,
      title: titleM[1].replace(/\s+/g, ' ').trim(),
      url: `https://2468c.com/${id}.html`,
      cover: imgM ? imgM[1] : '',
      publishedAt: dateM ? dateM[1] : ''
    });
  }
  return games;
}

// 抓取某个平台的所有页面
async function fetchPlatformGames(platformKey, maxPages) {
  const base = PLATFORMS[platformKey].url;
  const all = [];
  const pageSize = 25;
  let page = 1;
  const limit = maxPages || 200;

  while (page <= limit) {
    const url = page === 1 ? base : `${base}/page/${page}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[${platformKey}] 第 ${page} 页抓取失败：${err.message}`);
      break;
    }
    const games = parseGames(html);
    if (!games.length) break;
    all.push(...games);
    if (games.length < pageSize) break; // 最后一页
    page++;
    await new Promise((r) => setTimeout(r, 200)); // 礼貌延迟
  }

  return all;
}

async function main() {
  ensureDir(STATE_DIR);

  const args = new Set(process.argv.slice(2));
  const quickPages = args.has('--quick') ? 3 : 0; // 快速模式：只抓前 N 页检测新增
  const onlyNew = args.has('--new-only');

  const syncInfo = {
    at: nowLocal(),
    ok: false,
    firstRun: false,
    ps5Total: 0,
    ps4Total: 0,
    ps5New: 0,
    ps4New: 0,
    error: null
  };

  try {
    const snapshot = readJson(SNAPSHOT_PATH, { ps5: [], ps4: [] });
    const isFirstRun =
      !snapshot.ps5 || snapshot.ps5.length === 0 || !snapshot.ps4 || snapshot.ps4.length === 0;
    syncInfo.firstRun = isFirstRun;

    const today = todayLocal();
    const daily = readJson(DAILY_PATH, { days: {} });
    if (!daily.days || typeof daily.days !== 'object') daily.days = {};

    const newDay = daily.days[today] || { date: today, ps5: [], ps4: [] };

    const results = {};
    const pageLimit = quickPages > 0 ? quickPages : 0;
    for (const key of Object.keys(PLATFORMS)) {
      const games = await fetchPlatformGames(key, pageLimit);
      results[key] = games;
      syncInfo[`${key}Total`] = games.length;
      console.log(`[${key}] 抓取 ${games.length} 个游戏`);

      const prevMap = new Map((snapshot[key] || []).map((g) => [g.id, g]));
      const newGames = [];
      for (const g of games) {
        if (!prevMap.has(g.id)) {
          newGames.push({ ...g, firstSeen: today });
        }
      }
      syncInfo[`${key}New`] = newGames.length;

      if (!isFirstRun && newGames.length) {
        const daySet = new Map(newDay[key].map((g) => [g.id, g]));
        for (const g of newGames) daySet.set(g.id, g);
        newDay[key] = [...daySet.values()];
      }
    }

    // 更新快照
    const merged = {};
    for (const key of Object.keys(PLATFORMS)) {
      const prevMap = new Map((snapshot[key] || []).map((g) => [g.id, g]));
      for (const g of results[key]) {
        const prev = prevMap.get(g.id);
        prevMap.set(g.id, {
          ...g,
          firstSeen: prev ? prev.firstSeen : today
        });
      }
      merged[key] = [...prevMap.values()];
    }
    writeJson(SNAPSHOT_PATH, { updatedAt: nowLocal(), ...merged }, false);

    // 保存当日新增
    daily.days[today] = newDay;
    // 只保留 90 天
    const dayKeys = Object.keys(daily.days).sort();
    while (dayKeys.length > 90) delete daily.days[dayKeys.shift()];
    writeJson(DAILY_PATH, daily, false);

    syncInfo.ok = true;
    writeJson(LATEST_PATH, syncInfo);

    console.log('');
    console.log('===== 游戏资源同步完成 =====');
    console.log(`时间：${syncInfo.at}`);
    console.log(`PS5 总数：${syncInfo.ps5Total}，新增：${syncInfo.ps5New}`);
    console.log(`PS4 总数：${syncInfo.ps4Total}，新增：${syncInfo.ps4New}`);
    console.log(`首次同步：${syncInfo.firstRun ? '是（已建立基线）' : '否'}`);
    console.log('=============================');

    if (!isFirstRun && (syncInfo.ps5New || syncInfo.ps4New)) {
      console.log('');
      console.log('今日新增：');
      for (const g of newDay.ps5) console.log(`  [PS5] ${g.title} - ${g.url}`);
      for (const g of newDay.ps4) console.log(`  [PS4] ${g.title} - ${g.url}`);
    }
  } catch (err) {
    syncInfo.error = err && err.message ? err.message : String(err);
    writeJson(LATEST_PATH, syncInfo);
    console.error('[游戏同步] 失败：', err);
    process.exit(1);
  }
}

main();
