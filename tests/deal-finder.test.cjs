const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const NOW = 1_700_000_000_000;
// Rolimon's itemdetails rows: [name, acronym, rap, value, default, demand, trend, projected, hyped, rare]
const CATALOG = {
  1: ['Big Hat', 'BH', 90000, 100000, 100000, 3, 2, -1, -1, -1],
  2: ['Mid Hat', 'MH', 55000, 60000, 60000, 3, 2, -1, -1, -1],
  3: ['Small Hat', 'SH', 28000, 30000, 30000, 2, 2, -1, -1, -1],
  4: ['Tiny Hat', 'TH', 9000, 10000, 10000, 4, 2, -1, -1, -1],
  5: ['Trash RAP', '', 5000, -1, 5000, -1, -1, -1, -1, -1],
  6: ['Projected Thing', '', 40000, -1, 40000, -1, -1, 1, -1, -1],
  7: ['Their A', 'TA', 48000, 50000, 50000, 3, 2, -1, -1, -1],
  8: ['Their B', 'TB', 44000, 45000, 45000, 2, 2, -1, -1, -1],
  9: ['Low Demand Thing', 'LD', 70000, 80000, 80000, 0, 2, -1, -1, -1]
};
const copy = (n, assetId, isOnHold = false) => ({ instanceId: `copy-${String(n).padStart(4, '0')}-aaaa`, assetId, name: CATALOG[assetId][0], serialNumber: null, isOnHold });
const INVENTORY = [copy(1, 2), copy(2, 3), copy(3, 3), copy(4, 4), copy(5, 5), copy(6, 1, true)];
const ad = (adId, userId, get, receiving, ageSec = 30) => [adId, NOW / 1000 - ageSec, userId, `user${userId}`, { items: get }, receiving];

function setup(ads) {
  let now = NOW;
  const handlers = [], alarmHandlers = [], session = {}, local = {}, calls = [];
  let alarm = null;
  const state = { ads, inventory: INVENTORY };
  const area = store => ({ get: async key => ({ [key]: structuredClone(store[key]) }), set: async data => { Object.assign(store, structuredClone(data)); } });
  const json = data => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data });
  const context = vm.createContext({
    console, AbortSignal, structuredClone, setTimeout,
    Date: class extends Date { static now() { return now; } },
    fetch: async url => {
      calls.push(url);
      if (url.endsWith('/v1/users/authenticated')) return json({ id: 1, name: 'me' });
      if (url.includes('/v2/users/1/tradableItems')) {
        return json({ items: state.inventory.map(c => ({ itemTarget: { itemType: 'Asset', targetId: c.assetId }, itemName: c.name,
          instances: [{ collectibleItemInstanceId: c.instanceId, serialNumber: null, isOnHold: c.isOnHold, itemTarget: { itemType: 'Asset', targetId: c.assetId } }] })), nextPageCursor: null });
      }
      if (url.endsWith('/items/v2/itemdetails')) return json({ success: true, items: CATALOG });
      if (url.endsWith('/tradeads/v1/getrecentads')) return json({ success: true, trade_ads: state.ads });
      throw new Error(`Unexpected URL ${url}`);
    },
    chrome: {
      storage: { session: area(session), local: area(local) },
      alarms: {
        clear: async () => { alarm = null; },
        create: async (name, options) => { alarm = { name, ...options }; },
        onAlarm: { addListener: fn => alarmHandlers.push(fn) }
      },
      runtime: {
        id: 'test', getURL: path => `chrome-extension://test/${path}`,
        onMessage: { addListener: fn => handlers.push(fn) },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} }
      }
    }
  });
  for (const file of ['values.js', 'mass-trades.js', 'deal-finder.js']) vm.runInContext(fs.readFileSync(`src/${file}`, 'utf8'), context);
  const page = { id: 'test', url: 'chrome-extension://test/src/deals.html', tab: { id: 3 } };
  const dispatch = (message, sender, respond) => handlers.map(fn => fn(message, sender, respond)).find(r => r === true);
  return {
    state, session, calls,
    DealFinder: vm.runInContext('DealFinder', context),
    catalog: vm.runInContext('TradeValues', context).parseItems({ success: true, items: CATALOG }),
    command: (type, extra = {}) => new Promise(resolve => dispatch({ type, ...extra }, page, resolve)),
    untrusted: sender => dispatch({ type: 'DEALS_SCAN' }, sender, () => assert.fail('Untrusted sender accepted')),
    get alarm() { return alarm; },
    advance: ms => { now += ms; },
    fireAlarm: async () => { alarmHandlers.forEach(fn => fn({ name: 'value-deals' })); await new Promise(r => setTimeout(r, 20)); }
  };
}

const ADS = [
  ad(101, 11, [7, 8], { items: [2, 3] }),          // asks for items you own: 95k for 90k
  ad(102, 12, [7], { items: [1] }),                // asks for an item you only have on hold
  ad(103, 13, [1], { tags: [4] }),                 // wants Robux
  ad(104, 14, [7, 8], { tags: [5] }),              // upgrade: 2 items -> 2 items with a bigger top item
  ad(105, 15, [1], { tags: [2] }),                 // demand: only Mid + Tiny qualify (70k = 30% gain)
  ad(106, 16, [6], { tags: [1] }),                 // projected offer
  ad(107, 17, [7, 5], { tags: [1] }),              // RAP-only item on their side counts 0
  ad(108, 1, [1], { tags: [1] }),                  // your own ad
  ad(109, 18, [9], { tags: [1] }),                 // low demand item
  ad(110, 19, [1], { tags: [1] }, 40 * 60)         // older than 30 minutes
];

function deals(app, settings = {}) {
  const ads = Object.values(app.DealFinder.mergeAds({}, ADS, NOW));
  return JSON.parse(JSON.stringify(app.DealFinder.findDeals(ads, INVENTORY, app.catalog, settings, 1, NOW))); // plain arrays across the vm realm
}
const byUser = list => Object.fromEntries(list.map(d => [d.userId, d]));

test('finds value gains on specific-item and tag ads and skips Robux, projected, own, old and on-hold cases', () => {
  const app = setup(ADS), found = byUser(deals(app));
  assert.deepEqual(Object.keys(found).map(Number).sort((a, b) => a - b), [11, 14, 17, 18]);
  assert.equal(found[11].kind, 'specific');
  assert.deepEqual([found[11].getValue, found[11].giveValue, found[11].gain, found[11].gainPct], [95000, 90000, 5000, 5.3]);
  assert.deepEqual(found[14].give.map(x => x.id).sort(), [2, 3]);
  assert.deepEqual(found[14].tags, ['upgrade']);
  // Their RAP-only item counts as 0 and copies of items they're offering are never used.
  assert.equal(found[17].getValue, 50000);
  assert.equal(found[17].rapIgnored, 1);
  assert.deepEqual(found[17].give.map(x => x.id).sort(), [3, 4]);
  assert.equal(found[17].gain, 10000);
  // Ads that named the terms rank first, then upgrades, then lowball offers by gain.
  assert.deepEqual(deals(app).map(d => [d.userId, d.confidence]), [[11, 3], [14, 2], [17, 1], [18, 1]]);
});

test('tag rules, gain window, demand filter and never-offer list', () => {
  const app = setup(ADS);
  // Demand tag needs all-High/Amazing items: Mid + Tiny = 70k is a 30% gain, outside the default 25% window.
  assert.equal(byUser(deals(app))[15], undefined);
  const wide = byUser(deals(app, { maxGainPct: 35 }));
  assert.deepEqual(wide[15].give.map(x => x.id).sort(), [2, 4]);
  assert.deepEqual(wide[15].tags, ['demand']);
  // Only items with at least Normal demand on their side.
  assert.equal(byUser(deals(app, { minDemand: 2 }))[18], undefined);
  // Disabled tag types are not filled.
  assert.equal(byUser(deals(app, { tags: ['any'] }))[14], undefined);
  // Keeping Mid Hat blocks the specific ad that needs it.
  assert.equal(byUser(deals(app, { keep: ['copy-0001-aaaa'] }))[11], undefined);
  // Higher min gain drops the 5% deals; the any-tag ads re-size to a bigger (still in-window) gain.
  const strict = byUser(deals(app, { minGainPct: 10, maxGainPct: 25 }));
  assert.deepEqual(Object.keys(strict).map(Number), [17, 18]);
  assert.equal(strict[18].gain, 10000);
  assert.throws(() => app.DealFinder.settingsFrom({ minGainPct: 30, maxGainPct: 20 }));
  assert.throws(() => app.DealFinder.settingsFrom({ keep: ['bad id!'] }));
});

test('extra item fills an Adds tag on a specific ad only when the gain survives', () => {
  const app = setup([]);
  const one = [ad(201, 21, [7, 8], { items: [2], tags: [10] })]; // 95k for Mid (60k) + adds
  const list = JSON.parse(JSON.stringify(app.DealFinder.findDeals(Object.values(app.DealFinder.mergeAds({}, one, NOW)), INVENTORY, app.catalog, {}, 1, NOW)));
  assert.equal(list.length, 1);
  // Cheapest extra that satisfies Adds is the RAP-only item (5k at RAP).
  assert.deepEqual(list[0].give.map(x => x.id), [2, 5]);
  assert.equal(list[0].gain, 30000);
  assert.equal(list[0].overMax, true);
});

test('watch mode tracks reposts, refuses untrusted senders and stops cleanly', async () => {
  const app = setup(ADS);
  assert.equal(app.untrusted({ id: 'test', url: 'chrome-extension://test/src/popup.html' }), undefined);
  assert.equal(app.untrusted({ id: 'test', url: 'https://www.roblox.com/trades', tab: { id: 1 } }), undefined);
  assert.equal(app.untrusted({ id: 'other', url: 'chrome-extension://test/src/deals.html' }), undefined);

  const loaded = await app.command('DEALS_LOAD');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state.inventory.length, 6);
  assert.equal(loaded.state.inventory.find(c => c.assetId === 5).valued, false);

  const bad = await app.command('DEALS_SCAN', { minutes: 7 });
  assert.equal(bad.ok, false);
  const started = await app.command('DEALS_SCAN', { settings: {}, minutes: 15 });
  assert.equal(started.ok, true, started.error);
  assert.equal(app.alarm.periodInMinutes, 1);
  assert.equal(started.state.deals.length, 4);

  app.advance(60000);
  app.state.ads = [ad(301, 11, [7, 8], { items: [2, 3] }, -60)];
  await app.fireAlarm();
  const status = await app.command('DEALS_STATUS');
  const repost = status.state.deals.find(d => d.userId === 11);
  assert.equal(repost.posts, 2);
  assert.equal(status.state.deals.length, 4, 'older ads are kept for 30 minutes');

  const stopped = await app.command('DEALS_STOP');
  assert.equal(stopped.state.watchUntil, 0);
  assert.equal(app.alarm, null);
  const cleared = await app.command('DEALS_CLEAR');
  assert.equal(cleared.state.deals.length, 0);
});
