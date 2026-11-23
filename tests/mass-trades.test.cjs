const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const DAY = 86400000;
const toItem = c => {
  const target = { itemType: c.type || 'Asset', targetId: String(c.assetId) };
  const instance = { collectibleItemInstanceId: c.id, itemTarget: target, itemName: c.name || `Item ${c.assetId}`, serialNumber: c.serial ?? null };
  if ('isOnHold' in c) instance.isOnHold = c.isOnHold;
  return { collectibleItemId: `item-${c.assetId}`, itemTarget: target, itemName: instance.itemName, instances: [instance] };
};

function setup() {
  let now = 2000000000, handler, alarmHandler, startup, alarm;
  const store = {}, calls = [], listeners = {};
  const state = { account: 1, own: [{ id: 'own-copy-101', assetId: 10, name: 'Offer', serial: 7, isOnHold: false }],
    others: { 2: [{ id: 'their-copy-201', assetId: 20, name: 'Wanted', isOnHold: false }] },
    catalog: { 10: ['Offer', 'OF', 100, 100, 100, 3, 0, -1, -1, -1], 20: ['Wanted', 'WA', 150, 150, 150, 3, 0, -1, -1, -1] },
    ads: [[1, now / 1000, 2, 'partner', { items: [20] }, { items: [10] }]],
    sendStatus: 200, csrf: false, challenge: false, canTrade: true, inventoryStatus: {}, canTradeWith: {} };
  const area = { get: async key => ({ [key]: structuredClone(store[key]) }), set: async data => { Object.assign(store, structuredClone(data)); } };
  const context = vm.createContext({ console, AbortSignal, crypto: { randomUUID: () => 'preview-id' },
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      if (state.beforeFetch) await state.beforeFetch(url);
      let data, status = 200, headers = {};
      const user = Number(url.match(/users\/(\d+)\//)?.[1]);
      if (url.endsWith('/authenticated')) {
        status = state.authStatus || 200;
        data = status === 200 ? { id: state.account, name: 'me' } : { errors: [{ code: 0, message: 'Authorization has been denied for this request.' }] };
      } else if (url.includes('/tradableItems')) {
        status = state.inventoryStatus[user] || 200;
        const list = user === 1 ? state.own : state.others[user] || [], size = state.pageSize || 1000;
        const page = Number(url.match(/cursor=(\d+)/)?.[1] || 0);
        data = status !== 200 ? { errors: [{ code: 4, message: 'You are not authorized.' }] } : { userId: user,
          items: list.slice(page * size, (page + 1) * size).map(toItem), nextPageCursor: (page + 1) * size < list.length ? String(page + 1) : null };
      } else if (url.endsWith('/itemdetails')) { status = state.valuesDown ? 503 : 200; data = { success: true, items: state.catalog }; }
      else if (url.endsWith('/getrecentads')) { status = state.feedStatus || 200; data = { success: true, trade_ads: state.ads }; }
      else if (url.endsWith('/can-trade-with')) data = state.canTradeWith[user] || { canTrade: state.canTrade, mutualTradeEligibility: 'Eligible' };
      else if (url.endsWith('/v2/trades/send')) {
        if (state.timeout) throw new Error('timeout');
        status = state.sendStatus;
        data = status === 200 ? { tradeId: 123 } : { errors: [{ code: state.sendCode ?? 0, message: state.sendMessage || 'Token Validation Failed' }] };
        if (state.csrf && options.headers['x-csrf-token'] !== 'csrf') { status = 403; headers['x-csrf-token'] = 'csrf'; data = { errors: [{ code: 0, message: 'Token Validation Failed' }] }; }
        if (state.challenge) headers['rblx-challenge-id'] = 'challenge';
      } else throw new Error(`Unexpected URL ${url}`);
      return { ok: status === 200, status, headers: { get: key => headers[key] || null }, json: async () => structuredClone(data) };
    },
    chrome: {
      storage: { local: area, session: area },
      alarms: { clear: async () => { alarm = null; }, create: async (name, options) => { alarm = { name, ...options }; }, onAlarm: { addListener: fn => { alarmHandler = fn; } } },
      runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`,
        onMessage: { addListener: fn => { handler = fn; } }, onStartup: { addListener: fn => { startup = fn; } }, onInstalled: { addListener: fn => { listeners.installed = fn; } } }
    }
  });
  vm.runInContext(fs.readFileSync('src/values.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/mass-trades.js', 'utf8'), context);
  const sender = { id: 'test', url: 'chrome-extension://test/src/popup.html' };
  // Chrome serializes message responses; this also turns vm-realm arrays into ordinary test arrays.
  const command = (type, extra = {}) => new Promise(resolve => handler({ type, ...extra }, sender,
    response => resolve(response === undefined ? undefined : JSON.parse(JSON.stringify(response)))));
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  const app = { state, store, calls, command, pure: vm.runInContext('MassTrades', context),
    get now() { return now; }, get alarm() { return alarm; }, get sends() { return calls.filter(c => c.url.endsWith('/send')); },
    preview: config => command('MASS_PREVIEW', { config: config || { offerInstanceIds: ['own-copy-101'], wanted: [20] } }),
    start: () => command('MASS_START', { previewId: store.massTrades.previewId }),
    tick: async () => { now += 60000; alarmHandler({ name: 'mass-trades' }); await settle(); },
    advance: ms => { now += ms; },
    startup: async () => { startup(); await settle(); },
    // Another poster offering the wanted item for your offer, who owns a copy.
    partner: userId => {
      state.others[userId] = [{ id: `their-copy-${userId}`, assetId: 20, isOnHold: false }];
      state.ads.push([userId, now / 1000, userId, `user${userId}`, { items: [20] }, { items: [10] }]);
    },
    untrusted: s => handler({ type: 'MASS_START' }, { ...sender, ...s }, () => assert.fail('Untrusted sender accepted')) };
  return app;
}
const base = { offerInstanceIds: ['own-copy-101'], wanted: [20] };

test('preview performs no mutation request; send uses the v2 payload with locked copies and zero Robux', async () => {
  const app = setup();
  assert.equal((await app.preview()).ok, true);
  assert.equal(app.sends.length, 0);
  assert.equal(app.store.massTrades.targets.length, 1);
  await app.start(); await app.tick();
  assert.equal(app.sends.length, 1);
  assert.deepEqual(JSON.parse(app.sends[0].body), {
    senderOffer: { userId: 1, robux: 0, collectibleItemInstanceIds: ['own-copy-101'] },
    recipientOffer: { userId: 2, robux: 0, collectibleItemInstanceIds: ['their-copy-201'] } });
  assert.equal(app.store.massTrades.targets[0].tradeId, 123);
  assert.equal(app.store.massTrades.enabled, false);
  assert.match(app.store.massTrades.status, /Finished: 1 sent/);
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
  assert.equal(app.pure.subset([10, 10], [10]), false);
  assert.equal(app.pure.subset([10], [10, 11]), true);
});

test('flexible mode matches numeric request tags only when the offer fits, never Robux or wishlist', async () => {
  const app = setup(), t = app.now / 1000;
  app.state.ads = [
    [1, t, 3, 'any', { items: [20] }, { tags: [1] }],
    [1, t, 4, 'robux tag', { items: [20] }, { tags: [4] }],
    [1, t, 5, 'wishlist', { items: [20] }, { tags: [8] }],
    [1, t, 6, 'upgrade', { items: [20] }, { tags: [5] }],
    [1, t, 7, 'downgrade', { items: [20] }, { tags: [6] }],
    [1, t, 8, 'demand', { items: [20] }, { tags: [2] }],
    [1, t, 9, 'no adds', { items: [20] }, { items: [10], tags: [10] }],
    [1, t, 10, 'other item', { items: [20] }, { items: [99], tags: [1] }],
    [1, t, 11, 'their robux', { items: [20], robux: 50 }, { tags: [1] }],
    [1, t, 12, 'unknown key', { items: [20] }, { tags: [1], robux: 5 }]
  ];
  const flexible = tags => app.preview({ ...base, mode: 'flexible', tags });
  assert.deepEqual((await flexible(['any', 'demand', 'upgrade', 'downgrade', 'adds'])).state.targets.map(x => x.userId), [3, 8, 11]);
  assert.deepEqual((await flexible(['demand'])).state.targets.map(x => x.userId), [8]);
  assert.equal((await app.preview(base)).state.targets.length, 0);
  const fits = app.pure.tagSatisfied;
  assert.equal(fits('upgrade', [10], [20, 21], [], {}), true);
  assert.equal(fits('downgrade', [10, 11], [20], [], {}), true);
  assert.equal(fits('rares', [10], [20], [], { 10: { rare: true } }), true);
  assert.equal(fits('robux', [10], [20], [], {}), false);
  assert.equal(fits('wishlist', [10], [20], [], {}), false);
});

test('preview rejects invalid IDs, repeated copies, overlap, unavailable copies, bad rules and losing or projected values', async () => {
  const app = setup();
  for (const config of [ { offerInstanceIds: ['own-copy-101', 'own-copy-101'], wanted: [20] }, { offerInstanceIds: [], wanted: [20] },
    { offerInstanceIds: ['own-copy-101'], wanted: [10] }, { offerInstanceIds: ['missing-copy-1'], wanted: [20] },
    { offerInstanceIds: [101], wanted: [20] }, { offerInstanceIds: ['bad id!'], wanted: [20] },
    { ...base, wanted: [NaN] }, { ...base, wanted: [] }, { ...base, maxTrades: 0 }, { ...base, minutes: 999 } ]) {
    assert.equal((await app.preview(config)).ok, false);
  }
  app.state.catalog[20][3] = 50;
  assert.match((await app.preview()).error, /Value guard/);
  app.advance(300001); app.state.catalog[20] = ['Wanted', '', -1, -1];
  assert.match((await app.preview()).error, /Missing/);
  app.advance(300001); app.state.catalog[20] = ['Wanted', '', 150, 150, 150, 3, 0, 1, -1, -1];
  assert.match((await app.preview()).error, /projected/);
  assert.equal(app.sends.length, 0);
});

test('problems on your side pause before any send', async () => {
  const mutations = [s => { s.account = 3; }, s => { s.own = []; }, s => { s.own[0].isOnHold = true; },
    s => { delete s.own[0].isOnHold; }, s => { s.own[0].assetId = 99; }, (s, app) => { s.catalog[20][3] = 50; app.advance(300001); },
    s => { s.canTradeWith[2] = { canTrade: false, mutualTradeEligibility: 'CallingUserIneligible' }; }];
  for (const mutate of mutations) {
    const app = setup(); app.partner(3); await app.preview(); await app.start(); mutate(app.state, app); await app.tick();
    assert.equal(app.sends.length, 0);
    assert.equal(app.store.massTrades.enabled, false);
    assert.match(app.store.massTrades.status, /Paused/);
  }
});

test('recipient problems skip that person instead of pausing the batch', async () => {
  const mutations = [s => { s.others[2][0].assetId = 30; }, s => { s.others[2][0].isOnHold = true; },
    s => { s.inventoryStatus[2] = 403; }, s => { s.canTradeWith[2] = { canTrade: false, mutualTradeEligibility: 'TargetUserIneligible' }; }];
  for (const mutate of mutations) {
    const app = setup(); app.partner(3); await app.preview(); await app.start(); mutate(app.state); await app.tick();
    assert.match(app.store.massTrades.targets[0].outcome, /Skipped/);
    assert.equal(app.sends.length, 1);
    assert.equal(JSON.parse(app.sends[0].body).recipientOffer.userId, 3);
    assert.match(app.store.massTrades.status, /Finished: 1 sent, 1 skipped/);
  }
});

test('attempt history is filtered before the max-trades limit and pruned after 30 days', async () => {
  const app = setup();
  for (let id = 3; id <= 6; id++) app.partner(id);
  app.store.massTradeAttempts = Object.fromEntries([2, 3, 4].map(id => [JSON.stringify([1, [10], [20], id]), app.now]));
  assert.deepEqual((await app.preview({ ...base, maxTrades: 2 })).state.targets.map(x => x.userId), [5, 6]);
  const old = setup();
  old.store.massTradeAttempts = { stale: old.now - 31 * DAY, [JSON.stringify([1, [10], [20], 2])]: old.now - 31 * DAY };
  await old.preview(); await old.start(); await old.tick();
  assert.equal(old.sends.length, 1);
  assert.deepEqual(Object.keys(old.store.massTradeAttempts), [JSON.stringify([1, [10], [20], 2])]);
});

test('keeps watching the ad feed and sends to new matches; without a watch time an empty preview cannot start', async () => {
  const none = setup(); none.state.ads = [];
  await none.preview(); assert.equal((await none.start()).ok, false);
  const app = setup(); app.state.ads = [];
  assert.equal((await app.preview({ ...base, minutes: 15 })).state.targets.length, 0);
  assert.equal((await app.start()).ok, true);
  await app.tick();
  assert.equal(app.sends.length, 0); assert.equal(app.store.massTrades.enabled, true);
  app.state.ads = [[1, app.now / 1000, 2, 'partner', { items: [20] }, { items: [10] }]];
  await app.tick();
  assert.equal(app.sends.length, 1);
  for (let i = 0; i < 15; i++) await app.tick();
  assert.equal(app.sends.length, 1);
  assert.equal(app.store.massTrades.enabled, false);
  assert.match(app.store.massTrades.status, /Finished: 1 sent/);
});

test('ad feed failures while watching are retried; five in a row pause', async () => {
  const app = setup(); app.state.ads = [];
  await app.preview({ ...base, minutes: 30 }); await app.start();
  app.state.feedStatus = 503;
  for (let i = 0; i < 4; i++) await app.tick();
  assert.equal(app.store.massTrades.enabled, true);
  assert.match(app.store.massTrades.status, /Ad scan failed/);
  await app.tick();
  assert.equal(app.store.massTrades.enabled, false);
  assert.match(app.store.massTrades.status, /5 times in a row/);
});

test('CSRF is retried only for explicit token rejection, then the token is reused', async () => {
  const app = setup(); app.state.csrf = true; app.partner(3);
  await app.preview(); await app.start(); await app.tick();
  assert.equal(app.sends.length, 2);
  assert.equal(app.sends[0].body, app.sends[1].body);
  assert.equal(app.sends[1].headers['x-csrf-token'], 'csrf');
  await app.tick();
  assert.equal(app.sends.length, 3);
  assert.equal(app.sends[2].headers['x-csrf-token'], 'csrf');
});

test('rate limits, verification challenges and uncertain sends pause without retry or future duplicates', async () => {
  for (const change of [{ sendStatus: 429 }, { sendStatus: 403, csrf: true, challenge: true }, { timeout: true }, { sendStatus: 500 }]) {
    const app = setup(); Object.assign(app.state, change); app.partner(3);
    await app.preview(); await app.start(); await app.tick(); await app.tick();
    assert.equal(app.sends.length, 1);
    assert.equal(app.store.massTrades.enabled, false);
    assert.match(app.store.massTrades.status, /Paused/);
    assert.deepEqual((await app.preview()).state.targets.map(x => x.userId), [3]);
  }
});

test('Roblox 400 rejections skip the recipient; three in a row pause', async () => {
  const app = setup(); app.partner(3); app.partner(4); app.partner(5);
  Object.assign(app.state, { sendStatus: 400, sendCode: 7, sendMessage: 'The user cannot trade.' });
  await app.preview(); await app.start(); await app.tick();
  assert.equal(app.store.massTrades.enabled, true);
  assert.match(app.store.massTrades.targets[0].outcome, /Rejected/);
  await app.tick(); await app.tick();
  assert.equal(app.sends.length, 3);
  assert.equal(app.store.massTrades.enabled, false);
  assert.match(app.store.massTrades.status, /rejected 3 trades in a row/);
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
  assert.equal((await app.preview({ ...base, wanted: [20, 20] })).ok, true);
  await app.start(); await app.tick(); assert.equal(app.sends.length, 0);
  assert.match(app.store.massTrades.targets[0].outcome, /Skipped/);
  const other = setup(); other.state.ads[0][4].items = [20, 20];
  other.state.others[2].push({ id: 'their-copy-202', assetId: 20, isOnHold: false });
  await other.preview({ ...base, wanted: [20, 20] }); await other.start(); await other.tick();
  assert.deepEqual(JSON.parse(other.sends[0].body).recipientOffer.collectibleItemInstanceIds, ['their-copy-201', 'their-copy-202']);
});

test('loading follows pagination, skips unidentifiable rows and reports value or sign-in problems clearly', async () => {
  const app = setup(); app.state.pageSize = 1;
  app.state.own = [{ id: 'bundle-copy-1', assetId: 5, type: 'Bundle', isOnHold: false }, { id: 'x', assetId: 11, isOnHold: false },
    { id: 'own-copy-102', assetId: 11, isOnHold: true }, { id: 'own-copy-101', assetId: 10, isOnHold: false }];
  const loaded = await app.command('MASS_LOAD');
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.state.inventory.map(c => [c.instanceId, c.isOnHold]), [['own-copy-102', true], ['own-copy-101', false]]);
  assert.equal(Object.keys(loaded.state.catalog).length, 2);
  assert.equal((await app.preview()).ok, true);
  const down = setup(); down.state.valuesDown = true;
  const partial = await down.command('MASS_LOAD');
  assert.equal(partial.state.inventory.length, 1);
  assert.match(partial.state.valuesError, /503/);
  const out = setup(); out.state.authStatus = 401;
  assert.match((await out.command('MASS_LOAD')).error, /Sign in to roblox.com/);
});
