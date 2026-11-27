#!/usr/bin/env node
/* Collects Rolimon's history for every valued item, for training the value
   change model. Polite and resumable: one page at a time with a pause between
   requests; existing files are skipped. It stops (rather than retrying hard)
   on rate limits, blocks or verification pages; run it again later to resume.

   --refresh re-downloads items saved more than --max-age days ago (default 1)
   and refreshes the valued item list, so retraining needs no manual delete.
   A stopped refresh resumes where it left off when run again.

   Classic faces (Roblox bundles since 2026) are read from their bundle page.

   Usage: node tools/collect-rolimons.cjs [--refresh] [--max-age DAYS]
          [--limit N] [--delay MS]                                          */
const fs = require('node:fs');
const path = require('node:path');
const { normalizePage } = require('../src/item-insights.js');

const DATA = path.join(__dirname, 'data');
const ITEMS = path.join(DATA, 'items');
const LOG = path.join(DATA, 'collect.log');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const LIMIT = arg('--limit', Infinity);
const DELAY = arg('--delay', 1500);
const REFRESH = args.includes('--refresh') || args.includes('--max-age');
const MAX_AGE_DAYS = arg('--max-age', 1);
const HEADERS = { 'User-Agent': 'RobloxTradeAssistant/0.5 (value research; one request every ~2s)' };
const SINCE = Date.UTC(2018, 0, 1) / 1000;

const log = msg => { const line = `${new Date().toISOString()} ${msg}`; fs.appendFileSync(LOG, line + '\n'); console.log(line); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Stop extends Error {}

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      if (attempt >= 3) throw new Error(`network: ${error.message}`);
      await sleep(10000 * attempt); continue;
    }
    if (response.status === 429) {
      const wait = Math.min(600, Number(response.headers.get('retry-after')) || 60);
      if (attempt >= 3) throw new Stop('Rate limited (429) three times in a row');
      log(`429 rate limited; waiting ${wait}s as asked`);
      await sleep(wait * 1000); continue;
    }
    if (response.status === 403) throw new Stop('Blocked (403). Stopping instead of retrying.');
    if (response.status >= 500 && attempt < 3) { await sleep(15000 * attempt); continue; }
    return response;
  }
}

async function fetchPage(url) {
  const response = await get(url);
  if (!response.ok) return { status: response.status, html: null };
  const html = await response.text();
  if (/cf-chl|challenge-platform|Just a moment|captcha/i.test(html) && !/\b(item|bundle)_details_data\b/.test(html)) {
    throw new Stop('Rolimon’s returned a verification page. Stopping; do not bypass it.');
  }
  return { status: response.status, html };
}

// One item's history. Classic faces became Roblox bundles in 2026: a face's
// old item page stopped updating (best price, favorites) and names the bundle
// page, which has the live data and the full history from before the move.
// The bundle ID is saved with the item, so a refresh fetches only that page.
async function fetchSeries(item, savedBundle, delay = DELAY) {
  const hasData = s => s && (s.daily.t.length || s.changes.length);
  if (savedBundle) {
    const page = await fetchPage(`https://www.rolimons.com/bundle/${savedBundle}`);
    const series = page.html && normalizePage(page.html, SINCE);
    if (hasData(series)) return { series };
    await sleep(delay);
  }
  const page = await fetchPage(`https://www.rolimons.com/item/${item.id}`);
  if (!page.html) return { error: page.status === 404 ? '404' : `HTTP ${page.status}` };
  let series = normalizePage(page.html, SINCE);
  if (series.bundleId && series.bundleId !== savedBundle) {
    await sleep(delay);
    const bundle = await fetchPage(`https://www.rolimons.com/bundle/${series.bundleId}`);
    const moved = bundle.html && normalizePage(bundle.html, SINCE);
    if (hasData(moved)) series = moved;
    else log(`bundle ${series.bundleId} unavailable (HTTP ${bundle.status}); kept the item page of ${item.id}`);
  }
  return hasData(series) ? { series } : { error: 'no data' };
}

// What to fetch: items never saved first, then (with refresh) items saved more
// than maxAgeDays ago, oldest first. savedAt maps item id -> save time (ms).
function pickTodo(list, savedAt, { refresh = false, maxAgeDays = 1, limit = Infinity, now = Date.now() } = {}) {
  const missing = list.filter(item => savedAt[item.id] == null);
  const stale = refresh
    ? list.filter(item => savedAt[item.id] != null && now - savedAt[item.id] > maxAgeDays * 86400e3)
      .sort((a, b) => savedAt[a.id] - savedAt[b.id])
    : [];
  return { missing, stale, todo: [...missing, ...stale].slice(0, limit) };
}

async function main() {
  fs.mkdirSync(ITEMS, { recursive: true });
  const listFile = path.join(DATA, 'valued-items.json');
  let list;
  // A refresh also re-downloads the valued item list (new or devalued items).
  if (!REFRESH && fs.existsSync(listFile) && Date.now() - fs.statSync(listFile).mtimeMs < 24 * 3600e3) {
    list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  } else {
    const response = await get('https://api.rolimons.com/items/v2/itemdetails');
    if (!response.ok) throw new Stop(`Item list failed (${response.status})`);
    const payload = await response.json();
    // Valued items only (index 3 is the value; -1 means none), highest value first.
    list = Object.entries(payload.items).filter(([id, row]) => /^\d+$/.test(id) && row[3] > 0)
      .sort((a, b) => b[1][3] - a[1][3]).map(([id, row]) => ({ id, name: row[0], value: row[3] }));
    fs.writeFileSync(listFile, JSON.stringify(list));
  }
  const savedAt = {};
  for (const item of list) {
    try { savedAt[item.id] = fs.statSync(path.join(ITEMS, `${item.id}.json`)).mtimeMs; } catch { /* not saved yet */ }
  }
  const { missing, stale, todo } = pickTodo(list, savedAt, { refresh: REFRESH, maxAgeDays: MAX_AGE_DAYS, limit: LIMIT });
  log(`${list.length} valued items: ${missing.length} not saved yet` +
    (REFRESH ? `, ${stale.length} saved over ${MAX_AGE_DAYS} day(s) ago` : `, ${list.length - missing.length} already saved`) +
    `; fetching ${todo.length}`);
  let done = 0, failed = 0;
  for (const item of todo) {
    const started = Date.now();
    try {
      const file = path.join(ITEMS, `${item.id}.json`);
      let savedBundle = null;
      try { savedBundle = JSON.parse(fs.readFileSync(file, 'utf8')).bundleId ?? null; } catch { /* not saved yet */ }
      if (!/^\d{1,20}$/.test(savedBundle || '')) savedBundle = null;
      const { series, error } = await fetchSeries(item, savedBundle);
      if (error) { failed++; log(`${error} ${item.id} ${item.name}`); continue; }
      // Write to a temp file first so a crash never leaves a half-written item
      // (on refresh, the old file stays until the new one is complete).
      fs.writeFileSync(file + '.tmp', JSON.stringify({ id: item.id, name: item.name, fetchedAt: Math.floor(Date.now() / 1000), ...series }));
      fs.renameSync(file + '.tmp', file);
      done++;
      if (done % 25 === 0) log(`progress ${done}/${todo.length} (${failed} skipped)`);
    } catch (error) {
      if (error instanceof Stop) { log(`STOP: ${error.message} (${done} saved this run)`); process.exitCode = 2; return; }
      failed++; log(`error ${item.id}: ${error.message}`);
    }
    await sleep(Math.max(0, DELAY + Math.random() * 500 - (Date.now() - started) / 4));
  }
  log(`finished: ${done} saved, ${failed} skipped`);
}

if (require.main === module) main().catch(error => { log(`FATAL ${error.stack}`); process.exitCode = 1; });
module.exports = { pickTodo, fetchSeries };
