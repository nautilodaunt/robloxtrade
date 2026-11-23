const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function buildPlayerHtml(userId, name, tradeAdCount, viaCardOnly = false) {
  if (viaCardOnly) {
    return `<h6 class="card-subtitle mt-1 text-muted text-wrap stat-header">Trade Ads Created</h6><span class="card-title mb-1 text-light stat-data text-nowrap">${tradeAdCount.toLocaleString()}</span>`;
  }
  return `<script>var player_details_data = ${JSON.stringify({ player_id: userId, player_name: name, trade_ad_count: tradeAdCount })};</script>`;
}

function setup() {
  let now = 1_700_000_000_000, handler, alarmHandler, alarm;
  const store = {};
  const calls = [];
  const state = {
    catalog: {
      10159600649: ['8-Bit Royal Crown', '8BRC', 35859, 38000, 38000, 4, 2, -1, -1, -1],
      494291269: ['Super Super Happy Face', 'SSHF', 84908, 90000, 90000, 3, 0, -1, -1, -1],
      1029025: ['The Classic ROBLOX Fedora', 'CF', 446325, 450000, 450000, 4, 2, -1, -1, -1],
      999: ['Projected Fedora', 'PF', 25000, 30000, 30000, 4, 2, 1, -1, -1],
      500: ['Low Demand Hat', '', 20000, 20000, 20000, 1, 1, -1, -1, -1]
    },
    ads: [
      [101, now / 1000 - 30, 11, 'veteranTrader', { items: [10159600649] }, { tags: [6] }],
      [102, now / 1000 - 20, 22, 'casualNewbie', { items: [10159600649, 500] }, { items: [494291269], tags: [5] }],
      [103, now / 1000 - 10, 33, 'sshfOwner', { items: [494291269] }, { tags: [1, 6] }],
      [104, now / 1000 - 15, 44, 'richLowTrader', { items: [1029025] }, { tags: [6] }],
      [105, now / 1000 - 5, 55, 'projSeller', { items: [999] }, { tags: [1] }],
      [106, now / 1000 - 5, 66, 'lowDemandSeller', { items: [500] }, { tags: [1] }]
    ],
    playerCounts: {
      11: 2450,
      22: 14,
      33: 7,
      44: 5,
      55: 2,
      66: 1
    }
  };

  const context = vm.createContext({
    console,
    AbortSignal,
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (url.endsWith('/items/v2/itemdetails')) {
        return { ok: true, status: 200, json: async () => ({ success: true, items: state.catalog }) };
      }
      if (url.endsWith('/tradeads/v1/getrecentads')) {
        return { ok: true, status: 200, json: async () => ({ success: true, trade_ads: state.ads }) };
      }
      const playerMatch = url.match(/\/player\/(\d+)$/);
      if (playerMatch) {
        const id = Number(playerMatch[1]);
        const count = state.playerCounts[id] ?? 0;
        return { ok: true, status: 200, text: async () => buildPlayerHtml(id, `u${id}`, count, id === 33) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    chrome: {
      storage: {
        local: {
          get: async key => ({ [key]: structuredClone(store[key]) }),
          set: async data => { Object.assign(store, structuredClone(data)); }
        }
      },
      alarms: {
        clear: async () => { alarm = null; },
        create: async (name, options) => { alarm = { name, ...options }; },
        onAlarm: { addListener: fn => { alarmHandler = fn; } }
      },
      runtime: {
        id: 'test',
        getURL: path => `chrome-extension://test/${path}`,
        onMessage: { addListener: fn => { handler = fn; } },
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} }
      }
    }
  });
  vm.runInContext(fs.readFileSync('src/values.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/ad-finder.js', 'utf8'), context);
  const sender = { id: 'test', url: 'chrome-extension://test/src/popup.html' };
  const command = (type, extra = {}) => new Promise(resolve => handler({ type, ...extra }, sender, resolve));
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  return {
    state,
    store,
    calls,
    command,
    AdFinder: vm.runInContext('AdFinder', context),
    get alarm() { return alarm; },
    advance: ms => { now += ms; },
    fireAlarm: async () => { alarmHandler({ name: 'rolimons-ad-finder' }); await settle(); },
    untrusted: customSender => handler({ type: 'FINDER_SCAN' }, { ...sender, ...customSender }, () => assert.fail('Untrusted accepted'))
  };
}

test('finds Amazing demand items in value range, filters by low trade ad count, excludes projecteds and caches player lookups', async () => {
  const app = setup();
  const res = await app.command('FINDER_SCAN', {
    filters: { minValue: 20000, maxValue: 100000, maxTradeAds: 50, minDemand: 4, itemQuery: '' }
  });
  assert.equal(res.ok, true);
  // Only user 22 (8BRC = 38k Amazing, 14 trade ads) qualifies:
  // - user 11 has 2450 trade ads (> 50)
  // - user 33 has SSHF (High = 3, below Amazing = 4)
  // - user 44 has CF (450k > 100k maxValue)
  // - user 55 has projected item (excluded)
  // - user 66 has Low demand item (excluded)
  assert.equal(res.state.matches.length, 1);
  assert.equal(res.state.matches[0].username, 'casualNewbie');
  assert.equal(res.state.matches[0].tradeAdCount, 14);
  assert.equal(res.state.matches[0].matchedItems[0].acronym, '8BRC');
  assert.deepEqual(res.state.matches[0].requestTags, ['Upgrade']);

  // Only candidate users (11 and 22) should have had /player/{id} fetched!
  const playerFetches = app.calls.filter(c => c.url.includes('/player/')).map(c => c.url);
  assert.deepEqual(playerFetches.sort(), [
    'https://www.rolimons.com/player/11',
    'https://www.rolimons.com/player/22'
  ]);

  // Re-scanning uses cached player trade counts without re-fetching /player/11 or /player/22.
  await app.command('FINDER_SCAN', {
    filters: { minValue: 20000, maxValue: 100000, maxTradeAds: 50, minDemand: 4, itemQuery: '' }
  });
  assert.equal(app.calls.filter(c => c.url.includes('/player/')).length, 2);
});

test('supports High+ demand or explicit item queries (SSHF, 8BRC) and sorts lowest trade count first', async () => {
  const app = setup();
  const byQuery = await app.command('FINDER_SCAN', {
    filters: { minValue: 10000, maxValue: 120000, maxTradeAds: 100, minDemand: 4, itemQuery: 'sshf, 8brc' }
  });
  assert.equal(byQuery.ok, true);
  // Both user 33 (7 trade ads, SSHF, parsed from HTML card fallback) and user 22 (14 trade ads, 8BRC) match, sorted 7 then 14!
  assert.deepEqual(Array.from(byQuery.state.matches, m => [m.username, m.tradeAdCount]), [
    ['sshfOwner', 7],
    ['casualNewbie', 14]
  ]);

  // Widening value range with blank maxValue includes CF (450k, 5 trade ads) at the top.
  const noMax = await app.command('FINDER_SCAN', {
    filters: { minValue: 30000, maxValue: '', maxTradeAds: 100, minDemand: 3, itemQuery: '' }
  });
  assert.deepEqual(Array.from(noMax.state.matches, m => [m.username, m.tradeAdCount]), [
    ['richLowTrader', 5],
    ['sshfOwner', 7],
    ['casualNewbie', 14]
  ]);
});

test('auto-scan schedules repeating alarm, accumulates new low-trader ads, and validates inputs/senders', async () => {
  const app = setup();
  for (const invalid of [{ minValue: -5 }, { minValue: 50000, maxValue: 10000 }, { maxTradeAds: -1 }, { minDemand: 9 }]) {
    assert.equal((await app.command('FINDER_SCAN', { filters: invalid })).ok, false);
  }
  assert.equal(app.untrusted({ tab: { id: 2 } }), undefined);
  assert.equal(app.untrusted({ id: 'other' }), undefined);

  const started = await app.command('FINDER_SET_AUTO', {
    enabled: true,
    filters: { minValue: 10000, maxValue: 100000, maxTradeAds: 20, minDemand: 4, itemQuery: '' }
  });
  assert.equal(started.state.enabled, true);
  assert.equal(app.alarm.periodInMinutes, 1);
  assert.equal(started.state.matches.length, 1);

  // New low-trader ad arrives before next alarm tick.
  app.advance(60000);
  app.state.ads = [[200, (1_700_000_000_000 + 60000) / 1000, 77, 'brandNewTrader', { items: [10159600649] }, { tags: [1] }]];
  app.state.playerCounts[77] = 2;
  await app.fireAlarm();
  const status = await app.command('FINDER_STATUS');
  assert.deepEqual(Array.from(status.state.matches, m => [m.username, m.tradeAdCount]), [
    ['brandNewTrader', 2],
    ['casualNewbie', 14]
  ]);

  const stopped = await app.command('FINDER_SET_AUTO', { enabled: false });
  assert.equal(stopped.state.enabled, false);
  assert.equal(app.alarm, null);
  const cleared = await app.command('FINDER_CLEAR');
  assert.equal(cleared.state.matches.length, 0);
});
