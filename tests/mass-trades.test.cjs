const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup() {
  let now = 2000000000, handler, alarmHandler, startup, alarm;
  const store = {}, calls = [], listeners = {};
  const state = { account: 1, own: [{ assetId: 10, userAssetId: 101, name: 'Offer', isOnHold: false }],
    other: [{ assetId: 20, userAssetId: 201, name: 'Wanted', isOnHold: false }],
    catalog: { 10: ['Offer', '', 100, 100], 20: ['Wanted', '', 150, 150] },
    ads: [[1, now / 1000, 2, 'partner', { items: [20] }, { items: [10] }]],
    sendStatus: 200, csrf: false, challenge: false, canTrade: true };
  const context = vm.createContext({ console, AbortSignal, crypto: { randomUUID: () => 'preview-id' },
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (state.beforeFetch) await state.beforeFetch(url);
      let data, status = 200, headers = {};
      if (url.endsWith('/authenticated')) data = { id: state.account, name: 'me' };
      else if (url.includes('/assets/collectibles')) data = { data: url.includes('/users/1/') ? state.own : state.other };
      else if (url.endsWith('/itemdetails')) data = { success: true, items: state.catalog };
      else if (url.endsWith('/getrecentads')) data = { success: true, trade_ads: state.ads };
      else if (url.endsWith('/can-trade-with')) data = { canTrade: state.canTrade };
      else if (url.endsWith('/send')) {
        if (state.timeout) throw new Error('timeout');
        status = state.sendStatus;
        data = status === 200 ? { id: 123 } : { errors: [{ code: 0, message: 'Token Validation Failed' }] };
        if (state.csrf && !options.headers['x-csrf-token']) { status = 403; headers['x-csrf-token'] = 'csrf'; data = { errors: [{ code: 0, message: 'Token Validation Failed' }] }; }
        if (state.challenge) headers['rblx-challenge-id'] = 'challenge';
      } else throw new Error(`Unexpected URL ${url}`);
      return { ok: status === 200, status, headers: { get: key => headers[key] || null }, json: async () => structuredClone(data) };
    },
    chrome: {
      storage: { local: { get: async key => ({ [key]: structuredClone(store[key]) }), set: async data => { Object.assign(store, structuredClone(data)); } } },
      alarms: { clear: async () => { alarm = null; }, create: async (name, options) => { alarm = { name, ...options }; }, onAlarm: { addListener: fn => { alarmHandler = fn; } } },
      runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`,
        onMessage: { addListener: fn => { handler = fn; } }, onStartup: { addListener: fn => { startup = fn; } }, onInstalled: { addListener: fn => { listeners.installed = fn; } } }
    }
  });
  vm.runInContext(fs.readFileSync('src/values.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/mass-trades.js', 'utf8'), context);
  const sender = { id: 'test', url: 'chrome-extension://test/src/popup.html' };
  const command = (type, extra = {}) => new Promise(resolve => handler({ type, ...extra }, sender, resolve));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { state, store, calls, command, pure: vm.runInContext('MassTrades', context),
    get alarm() { return alarm; }, get sends() { return calls.filter(c => c.url.endsWith('/send')); },
    preview: config => command('MASS_PREVIEW', { config: config || { offerCopyIds: [101], wanted: [20] } }),
    start: () => command('MASS_START', { previewId: store.massTrades.previewId }),
    tick: async () => { now += 60000; alarmHandler({ name: 'mass-trades' }); await settle(); },
    advance: ms => { now += ms; },
    startup: async () => { startup(); await settle(); },
    untrusted: s => handler({ type: 'MASS_START' }, { ...sender, ...s }, () => assert.fail('Untrusted sender accepted')) };
}

test('preview performs no mutation request; send contains only locked owned copies and zero Robux', async () => {
  const app = setup();
  assert.equal((await app.preview()).ok, true);
  assert.equal(app.sends.length, 0);
  assert.equal(app.store.massTrades.targets.length, 1);
  await app.start(); await app.tick();
  assert.equal(app.sends.length, 1);
  assert.deepEqual(JSON.parse(app.sends[0].body), { offers: [
    { userId: 1, userAssetIds: [101], robux: 0 }, { userId: 2, userAssetIds: [201], robux: 0 }
  ] });
  assert.equal(app.store.massTrades.targets[0].tradeId, 123);
  assert.equal(app.store.massTrades.enabled, false);
  await app.tick(); assert.equal(app.sends.length, 1);
  assert.equal((await app.preview()).state.targets.length, 0);
});

test('exact matching rejects subsets, additional items, wrong quantities, tags, Robux, stale ads and self', async () => {
  const app = setup(), good = app.state.ads[0];
  const bad = [
    [1, good[1], 3, 'extra', { items: [20, 21] }, { items: [10] }],
    [1, good[1], 4, 'quantity', { items: [20] }, { items: [10, 10] }],
    [1, good[1], 5, 'tag', { items: [20] }, { items: [10], tags: [1] }],
    [1, good[1], 6, 'robux', { items: [20], robux: 100 }, { items: [10] }],
    [1, 1, 7, 'stale', { items: [20] }, { items: [10] }],
    [1, good[1], 1, 'self', { items: [20] }, { items: [10] }]
  ];
  app.state.ads = [...bad, good, good];
  assert.equal((await app.preview()).state.targets.length, 1);
  assert.equal(app.pure.same([10, 10], [10]), false);
});

test('preview rejects invalid IDs, repeated offered copies, overlap, unavailable copies and losing values', async () => {
  const app = setup();
  for (const config of [ { offerCopyIds: [101, 101], wanted: [20] }, { offerCopyIds: [], wanted: [20] },
    { offerCopyIds: [101], wanted: [10] }, { offerCopyIds: [999], wanted: [20] },
    { offerCopyIds: [101], wanted: [NaN] }, { offerCopyIds: [101], wanted: [] } ]) {
    assert.equal((await app.preview(config)).ok, false);
  }
  app.state.catalog[20][3] = 50;
  assert.match((await app.preview()).error, /Value guard/);
  app.state.catalog[20] = ['Wanted', '', -1, -1];
  assert.match((await app.preview()).error, /Missing/);
  assert.equal(app.sends.length, 0);
});

test('rechecks account, offer copy, hold status, recipient quantity and prices before every send', async () => {
  const mutations = [s => { s.account = 3; }, s => { s.own = []; }, s => { s.own[0].isOnHold = true; },
    s => { delete s.own[0].isOnHold; }, s => { s.own[0].assetId = 99; },
    s => { s.other[0].assetId = 30; }, s => { s.other[0].isOnHold = true; },
    s => { s.catalog[20][3] = 50; }];
  for (const mutate of mutations) {
    const app = setup(); await app.preview(); await app.start(); mutate(app.state); await app.tick();
    assert.equal(app.sends.length, 0);
    assert.equal(app.store.massTrades.enabled, false);
    assert.match(app.store.massTrades.status, /Paused/);
  }
});

test('CSRF is retried only for explicit token rejection and identical payload', async () => {
  const app = setup(); app.state.csrf = true;
  await app.preview(); await app.start(); await app.tick();
  assert.equal(app.sends.length, 2);
  assert.equal(app.sends[0].body, app.sends[1].body);
  assert.equal(app.sends[1].headers['x-csrf-token'], 'csrf');
});

test('rate limits, verification challenges and uncertain sends pause without retry or future duplicates', async () => {
  for (const change of [{ sendStatus: 429 }, { sendStatus: 403, csrf: true, challenge: true }, { timeout: true }]) {
    const app = setup(); Object.assign(app.state, change);
    await app.preview(); await app.start(); await app.tick(); await app.tick();
    assert.equal(app.sends.length, 1);
    assert.equal(app.store.massTrades.enabled, false);
    assert.equal((await app.preview()).state.targets.length, 0);
  }
});

test('start requires a current single-use preview and ignores supplied payload changes', async () => {
  const app = setup();
  assert.equal((await app.command('MASS_START', { previewId: 'fake' })).ok, false);
  await app.preview();
  assert.equal((await app.command('MASS_START', { previewId: 'wrong' })).ok, false);
  await app.command('MASS_START', { previewId: 'preview-id', config: { wanted: [] }, payload: {} });
  assert.equal((await app.start()).ok, false);
  await app.tick(); assert.equal(app.sends.length, 1);
  assert.equal(app.untrusted({ tab: { id: 1 } }), undefined);
  assert.equal(app.untrusted({ id: 'other' }), undefined);
  assert.equal(app.untrusted({ url: 'https://www.roblox.com/' }), undefined);
});

test('stop prevents scheduled sends and cancellation during preflight prevents the POST', async () => {
  const app = setup(); await app.preview(); await app.start();
  await app.command('MASS_STOP'); await app.tick(); assert.equal(app.sends.length, 0);
  const next = setup(); await next.preview(); await next.start();
  let stopping;
  next.state.beforeFetch = async url => {
    if (url.endsWith('/can-trade-with')) stopping = next.command('MASS_STOP');
  };
  await next.tick(); await stopping;
  assert.equal(next.sends.length, 0);
  assert.equal(next.store.massTrades.enabled, false);
});

test('interrupted in-flight work and browser restart cannot automatically resend', async () => {
  const app = setup(); await app.preview(); await app.start();
  app.store.massTrades.inFlight = 2;
  await app.tick(); assert.equal(app.sends.length, 0);
  assert.match(app.store.massTrades.status, /interrupted/);
  await app.start(); await app.startup(); await app.tick();
  assert.equal(app.sends.length, 0);
  assert.equal(app.store.massTrades.previewId, null);
});

test('expired preview cannot start and repeated wanted items require distinct recipient copies', async () => {
  const expired = setup(); await expired.preview(); expired.advance(300001);
  assert.equal((await expired.start()).ok, false);
  assert.equal(expired.sends.length, 0);
  const app = setup();
  app.state.ads[0][4].items = [20, 20];
  assert.equal((await app.preview({ offerCopyIds: [101], wanted: [20, 20] })).ok, true);
  await app.start(); await app.tick(); assert.equal(app.sends.length, 0);
  const other = setup(); other.state.ads[0][4].items = [20, 20];
  other.state.other.push({ assetId: 20, userAssetId: 202, isOnHold: false });
  await other.preview({ offerCopyIds: [101], wanted: [20, 20] }); await other.start(); await other.tick();
  assert.deepEqual(JSON.parse(other.sends[0].body).offers[1].userAssetIds, [201, 202]);
});
