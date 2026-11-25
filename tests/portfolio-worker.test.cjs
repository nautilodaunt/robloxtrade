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
  6: ['Projected Thing', '', 40000, -1, 40000, -1, -1, 1, -1, -1]
};
const copy = (n, assetId, isOnHold = false) => ({ instanceId: `copy-${String(n).padStart(4, '0')}-aaaa`, assetId, name: CATALOG[assetId][0], isOnHold });
const INVENTORIES = { 1: [copy(1, 2), copy(2, 3), copy(3, 1, true)], 42: [copy(10, 1), copy(11, 6)] };
const PAGE = { id: 'test', url: 'chrome-extension://test/src/portfolio.html?user=42', tab: { id: 3 } };

function setup() {
  let now = NOW;
  const handlers = [], session = {}, local = {}, calls = [], insightCalls = [];
  const state = { rateLimit: false };
  const area = store => ({ get: async key => ({ [key]: structuredClone(store[key]) }), set: async data => { Object.assign(store, structuredClone(data)); } });
  const json = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });
  const context = vm.createContext({
    console, AbortSignal, structuredClone, setTimeout,
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/v1/users/authenticated')) return json({ id: 1, name: 'me' });
      if (url.endsWith('/v1/users/42')) return json({ id: 42, name: 'friend', displayName: 'Friendly' });
      if (url.endsWith('/v1/users/43')) return json({ id: 43, name: 'private' });
      if (/\/v1\/users\/\d+$/.test(url)) return json({ errors: [{ message: 'The user id is invalid.' }] }, 404);
      if (url.endsWith('/v1/usernames/users')) {
        const name = JSON.parse(options.body).usernames[0];
        return json({ data: name.toLowerCase() === 'friend' ? [{ id: 42, name: 'friend', displayName: 'Friendly', requestedUsername: name }] : [] });
      }
      const inv = url.match(/\/v2\/users\/(\d+)\/tradableItems/);
      if (inv) {
        if (!INVENTORIES[inv[1]]) return json({ errors: [{ message: 'Forbidden' }] }, 403);
        return json({ items: INVENTORIES[inv[1]].map(c => ({ itemTarget: { itemType: 'Asset', targetId: c.assetId }, itemName: c.name,
          instances: [{ collectibleItemInstanceId: c.instanceId, serialNumber: null, isOnHold: c.isOnHold, itemTarget: { itemType: 'Asset', targetId: c.assetId } }] })), nextPageCursor: null });
      }
      if (url.endsWith('/items/v2/itemdetails')) return json({ success: true, items: CATALOG });
      throw new Error(`Unexpected URL ${url}`);
    },
    // Stands in for background.js's Rolimon's item page reader.
    getInsight: async id => {
      insightCalls.push(id);
      if (state.rateLimit) throw new Error("Rolimon's item page failed (429)");
      return { details: { value: 60000, rap: 55000, demand: 3, trend: 2, sellers: 7 }, salesPerDay: 2.5,
        history: [{ t: NOW / 1000 - 40 * 86400, rap: 50000 }, { t: NOW / 1000 - 20 * 86400, rap: 50000 }, { t: NOW / 1000, rap: 55000 }],
        prediction: { horizons: { 7: { up: 0.02, down: 0.3, baseUp: 0.03, baseDown: 0.08, test: {} }, 14: { up: 0.03, down: 0.4, baseUp: 0.05, baseDown: 0.1 },
          30: { up: 0.04, down: 0.5, baseUp: 0.09, baseDown: 0.17 } }, trainedAt: '2026-11-01', dataAt: '2026-11-01', testPeriod: 'x' } };
    },
    VALUE_MODEL: { trainedAt: '2026-11-02T00:00:00Z', dataAt: '2026-11-01T00:00:00Z' },
    chrome: {
      storage: { session: area(session), local: area(local) },
      alarms: { clear: async () => {}, create: async () => {}, onAlarm: { addListener() {} } },
      runtime: {
        id: 'test', getURL: path => `chrome-extension://test/${path}`,
        onMessage: { addListener: fn => handlers.push(fn) },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} }
      }
    }
  });
  for (const file of ['values.js', 'item-insights.js', 'mass-trades.js', 'deal-finder.js', 'portfolio-risk.js', 'portfolio-worker.js']) {
    vm.runInContext(fs.readFileSync(`src/${file}`, 'utf8'), context);
  }
  const dispatch = (message, sender, respond) => handlers.map(fn => fn(message, sender, respond)).find(r => r === true);
  return {
    state, session, local, calls, insightCalls,
    command: (type, extra = {}) => new Promise(resolve => dispatch({ type, ...extra }, PAGE, r => resolve(JSON.parse(JSON.stringify(r))))),
    from: (sender, type, extra = {}) => new Promise((resolve, reject) => {
      const handled = dispatch({ type, ...extra }, sender, r => resolve(JSON.parse(JSON.stringify(r))));
      if (handled !== true) resolve(undefined);
    }),
    untrusted: sender => dispatch({ type: 'PORTFOLIO_LOAD' }, sender, () => assert.fail('Untrusted sender accepted')),
    advance: ms => { now += ms; }
  };
}

test('refuses messages from anything but the portfolio page', () => {
  const app = setup();
  assert.equal(app.untrusted({ id: 'test', url: 'chrome-extension://test/src/deals.html' }), undefined);
  assert.equal(app.untrusted({ id: 'test', url: 'https://www.roblox.com/users/1/profile', tab: { id: 1 } }), undefined);
  assert.equal(app.untrusted({ id: 'other', url: 'chrome-extension://test/src/portfolio.html' }), undefined);
});

test('loads your own inventory and records daily history', async () => {
  const app = setup();
  const r = await app.command('PORTFOLIO_LOAD', { target: '' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.isSelf, true);
  assert.deepEqual([r.owner.id, r.owner.name, r.me.id], [1, 'me', 1]);
  assert.equal(r.copies.length, 3);
  assert.equal(r.catalog[2].name, 'Mid Hat');
  assert.deepEqual(r.keep, []);
  assert.deepEqual(r.recent, []); // your own inventory isn't a "recent lookup"
  assert.deepEqual(r.history, [{ d: '2023-11-14', value: 190000, rap: 173000, risk: r.history[0].risk }]);
  assert.equal(r.model.dataAt, '2026-11-01T00:00:00Z');
  assert.equal(app.local.portfolioHistory[1].points.length, 1);
  // Your own ID counts as you.
  assert.equal((await app.command('PORTFOLIO_LOAD', { target: '1' })).isSelf, true);
});

test('looks up other users by ID or username and validates input', async () => {
  const app = setup();
  const byId = await app.command('PORTFOLIO_LOAD', { target: ' 42 ' });
  assert.equal(byId.ok, true, byId.error);
  assert.deepEqual([byId.isSelf, byId.owner.id, byId.owner.displayName, byId.copies.length], [false, 42, 'Friendly', 2]);
  assert.deepEqual(byId.keep, []);
  assert.deepEqual(byId.recent, [{ id: 42, name: 'friend' }]);
  const byName = await app.command('PORTFOLIO_LOAD', { target: 'FRIEND' });
  assert.equal(byName.owner.id, 42);
  const post = app.calls.find(c => c.url.endsWith('/v1/usernames/users'));
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.credentials, 'omit');

  const cases = [['bad name!', /username/], ['ab', /username/], ['404404', /No Roblox user with ID 404404/], ['nobody_here', /No Roblox user named/], ['43', /won’t show their inventory/]];
  for (const [target, error] of cases) {
    const r = await app.command('PORTFOLIO_LOAD', { target });
    assert.equal(r.ok, false, target);
    assert.match(r.error, error);
  }
  const status = await app.command('PORTFOLIO_STATUS');
  assert.deepEqual(status.recent, [{ id: 42, name: 'friend' }]);
});

test('deep insights are cached for 6 hours and rate limits tell the page to stop', async () => {
  const app = setup();
  const first = await app.command('PORTFOLIO_INSIGHT', { assetId: 2 });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.cached, false);
  assert.deepEqual(first.insight.prediction.horizons[30], { up: 0.04, down: 0.5, baseUp: 0.09, baseDown: 0.17 });
  assert.equal(first.insight.rap30, 10);
  assert.equal(first.insight.salesPerDay, 2.5);
  assert.equal(app.local.portfolioInsights[2].value, 60000);

  const again = await app.command('PORTFOLIO_INSIGHT', { assetId: 2 });
  assert.equal(again.cached, true);
  assert.deepEqual(app.insightCalls, [2]);

  // Cached odds flow into the next load and the risk model.
  const loaded = await app.command('PORTFOLIO_LOAD', { target: '' });
  assert.ok(loaded.insights[2]);

  assert.equal((await app.command('PORTFOLIO_INSIGHT', { assetId: 'x' })).ok, false);
  app.advance(7 * 3600e3); // past the 6 h cache and the 1.2 s pacing gap
  app.state.rateLimit = true;
  const limited = await app.command('PORTFOLIO_INSIGHT', { assetId: 2 });
  assert.equal(limited.ok, false);
  assert.equal(limited.stop, true);
  assert.match(limited.error, /429/);
});

test('protect / unprotect syncs with the deal finder never-offer list', async () => {
  const app = setup();
  const on = await app.command('PORTFOLIO_KEEP', { instanceIds: ['copy-0001-aaaa'], keep: true });
  assert.equal(on.ok, true, on.error);
  assert.deepEqual(on.keep, ['copy-0001-aaaa']);
  assert.deepEqual(app.session.valueDeals.settings.keep, ['copy-0001-aaaa']);
  assert.deepEqual((await app.command('PORTFOLIO_LOAD', { target: '' })).keep, ['copy-0001-aaaa']);
  const off = await app.command('PORTFOLIO_KEEP', { instanceIds: ['copy-0001-aaaa'], keep: false });
  assert.deepEqual(off.keep, []);
  for (const bad of [{ instanceIds: ['bad id!'], keep: true }, { instanceIds: [], keep: true }, { instanceIds: ['copy-0001-aaaa'], keep: 'yes' }]) {
    assert.equal((await app.command('PORTFOLIO_KEEP', bad)).ok, false);
  }
  // Deal finder loaded for another account: don't mix lists.
  app.session.valueDeals.userId = 99;
  const mixed = await app.command('PORTFOLIO_KEEP', { instanceIds: ['copy-0001-aaaa'], keep: true });
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /another Roblox account/);
});

test('the limiteds browser gets values and odds without sign-in, and nothing else', async () => {
  const app = setup();
  const browser = { id: 'test', url: 'chrome-extension://test/src/limiteds.html' };
  await app.command('PORTFOLIO_INSIGHT', { assetId: 2 });
  const r = await app.from(browser, 'LIMITEDS_CATALOG');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.catalog[1].name, 'Big Hat');
  assert.ok(r.insights[2].prediction);
  assert.equal(r.model.dataAt, '2026-11-01T00:00:00Z');
  assert.equal(app.calls.some(c => c.url.includes('/users/authenticated')), false, 'no Roblox account needed');
  assert.equal((await app.from(browser, 'PORTFOLIO_INSIGHT', { assetId: 2 })).cached, true);
  // Inventory lookups and the never-offer list stay portfolio-only; the catalog stays extension-only.
  assert.equal(await app.from(browser, 'PORTFOLIO_LOAD', { target: '42' }), undefined);
  assert.equal(await app.from(browser, 'PORTFOLIO_KEEP', { instanceIds: ['copy-0001-aaaa'], keep: true }), undefined);
  assert.equal(await app.from({ id: 'test', url: 'https://www.rolimons.com/' }, 'LIMITEDS_CATALOG'), undefined);
  assert.equal(await app.from({ id: 'other', url: 'chrome-extension://test/src/limiteds.html' }, 'LIMITEDS_CATALOG'), undefined);
});
