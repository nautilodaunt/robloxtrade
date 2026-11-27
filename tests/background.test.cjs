const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('worker coalesces requests, caches responses and marks stale data on failure', async () => {
  let handler, cache, requests = 0, now = 1000000, fail = false;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    AbortSignal,
    fetch: async () => {
      requests++;
      if (fail) throw new Error('Offline');
      return { ok: true, json: async () => ({ success: true, items: { 1: ['Item', '', 500, 1000] } }) };
    },
    chrome: { permissions: { contains: async () => true }, storage: { local: {
      get: async () => ({ rolimonsV2Cache: cache }),
      set: async data => { cache = data.rolimonsV2Cache; }
    } }, runtime: { id: 'test', onMessage: { addListener: fn => { handler = fn; } } } }
  });
  context.importScripts = () => vm.runInContext(fs.readFileSync('src/values.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/background.js', 'utf8'), context);
  const request = () => new Promise(resolve => handler({ type: 'GET_ROLIMONS_VALUES' }, { id: 'test' }, resolve));
  const responses = await Promise.all([request(), request()]);
  assert.equal(requests, 1);
  assert.equal(responses[0].items[1].value, 1000);
  await request();
  assert.equal(requests, 1);
  now += 6 * 60 * 1000;
  fail = true;
  assert.equal((await request()).stale, true);
  assert.equal(requests, 2);
  await request();
  assert.equal(requests, 2);
});


test('missing Chrome API host access is reported before any fetch', async () => {
  let handler;
  const context = vm.createContext({
    chrome: { permissions: { contains: async () => false },
      runtime: { id: 'test', onMessage: { addListener: fn => { handler = fn; } } } }
  });
  context.importScripts = () => vm.runInContext(fs.readFileSync('src/values.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/background.js', 'utf8'), context);
  const result = await new Promise(resolve => handler({ type: 'GET_ROLIMONS_VALUES' }, { id: 'test' }, resolve));
  assert.equal(result.ok, false);
  assert.match(result.error, /has not granted/);
});

test('cooldown retains the original error and expires despite repeated checks', async () => {
  let handler, now = 1000000, requests = 0;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } }, AbortSignal,
    fetch: async () => { requests++; throw new Error('Connection test failure'); },
    chrome: { permissions: { contains: async () => true }, storage: { local: { get: async () => ({}) } },
      runtime: { id: 'test', onMessage: { addListener: fn => { handler = fn; } } } }
  });
  context.importScripts = () => vm.runInContext(fs.readFileSync('src/values.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/background.js', 'utf8'), context);
  const request = (force = false) => new Promise(resolve => handler({ type: 'GET_ROLIMONS_VALUES', force }, { id: 'test' }, resolve));
  assert.match((await request()).error, /Connection test failure/);
  now += 30000;
  assert.match((await request()).error, /Connection test failure/);
  assert.equal(requests, 1);
  now += 31000;
  await request();
  assert.equal(requests, 2);
  await request(true);
  assert.equal(requests, 3);
});

test('trade data requests come only from Roblox top frames with numeric IDs', async () => {
  let handler;
  const fetched = [];
  const context = vm.createContext({
    AbortSignal,
    fetch: async url => { fetched.push(url); return { ok: true, json: async () => ({ id: 123 }) }; },
    chrome: { runtime: { id: 'test', onMessage: { addListener: fn => { handler = fn; } } } }
  });
  context.importScripts = () => vm.runInContext(fs.readFileSync('src/values.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/background.js', 'utf8'), context);
  const page = { id: 'test', url: 'https://www.roblox.com/trades', frameId: 0, tab: { id: 1, url: 'https://www.roblox.com/trades' } };
  const ask = (message, sender) => new Promise(resolve => { if (handler(message, sender, resolve) !== true) resolve(undefined); });
  assert.equal((await ask({ type: 'GET_TRADE_DATA', tradeId: '123' }, page)).ok, true);
  assert.equal(fetched[0], 'https://trades.roblox.com/v2/trades/123');
  assert.equal(await ask({ type: 'GET_TRADE_DATA', tradeId: '1/../../v1/users' }, page), undefined);
  // Another site's frame inside a Roblox tab is not a Roblox page.
  assert.equal(await ask({ type: 'GET_TRADE_DATA', tradeId: '123' }, { ...page, url: 'https://evil.example/', frameId: 3 }), undefined);
  assert.equal(await ask({ type: 'GET_TRADE_DATA', status: 'Inbound' }, { id: 'test', url: 'chrome-extension://test/src/popup.html' }), undefined);
  assert.equal(fetched.length, 1);
});

test('a face that became a Roblox bundle is read from its Rolimon\'s bundle page', async () => {
  let handler, now = Date.UTC(2026, 10, 26), bundleDown = false;
  const fetched = [];
  const DAY = 86400, end = Math.floor(now / 1000 / DAY) * DAY;
  const history = best => JSON.stringify({ timestamp: Array.from({ length: 40 }, (_, i) => end - (39 - i) * DAY),
    rap: Array(40).fill(49326), best_price: Array(40).fill(best), num_sellers: Array(40).fill(99), favorited: Array(40).fill(7000) });
  const item = 'https://www.rolimons.com/item/2409285794', bundle = 'https://www.rolimons.com/bundle/105919952545574';
  const pages = {
    [item]: `<script>var item_details_data = ${JSON.stringify({ item_name: 'Playful Vampire', value: 50000, rap: 49326, best_price: 110000, migrated_to_bundle_id: 105919952545574 })};\nvar history_data = ${history(110000)};</script>`,
    [bundle]: `<script>var bundle_details_data = ${JSON.stringify({ bundle_id: 105919952545574, bundle_name: 'Playful Vampire', migrated_from_asset_id: 2409285794, value: 50000, rap: 49326, best_price: 46000 })};\nvar history_data = ${history(46000)};</script>`
  };
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } }, AbortSignal,
    fetch: async url => {
      fetched.push(url);
      const body = bundleDown && url === bundle ? null : pages[url];
      return body ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 503 };
    },
    chrome: { permissions: { contains: async () => true }, runtime: { id: 'test', onMessage: { addListener: fn => { handler = fn; } } } }
  });
  context.importScripts = file => {
    if (['values.js', 'item-insights.js', 'value-model.js'].includes(file)) vm.runInContext(fs.readFileSync(`src/${file}`, 'utf8'), context);
  };
  vm.runInContext(fs.readFileSync('src/background.js', 'utf8'), context);
  const ask = () => new Promise(resolve => handler({ type: 'GET_ITEM_INSIGHT', itemId: '2409285794' }, { id: 'test' }, resolve));
  let response = await ask();
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(fetched, [item, bundle]);
  assert.equal(response.result.details.bestPrice, 46000);
  assert.equal(response.result.details.bundleId, '105919952545574');
  assert.equal(response.result.details.bestPriceStale, false);
  // After the 10 minute cache it goes straight to the bundle page.
  now += 11 * 60 * 1000;
  response = await ask();
  assert.equal(response.result.details.bestPrice, 46000);
  assert.deepEqual(fetched.slice(2), [bundle]);
  // If the bundle page fails, the old item page still answers.
  now += 11 * 60 * 1000;
  bundleDown = true;
  response = await ask();
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.details.bestPrice, 110000);
  assert.deepEqual(fetched.slice(3), [bundle, item]);
  // The value forecast page gets the bundle page's history, cached for 10 minutes.
  now += 11 * 60 * 1000;
  bundleDown = false;
  const before = fetched.length;
  const { details, series } = await context.getSeries('2409285794');
  assert.deepEqual([details.bundleId, details.bestPrice, series.value, series.daily.t.length], ['105919952545574', 46000, 50000, 40]);
  assert.deepEqual(fetched.slice(before), [bundle]);
  assert.equal((await context.getSeries(2409285794)).series.value, 50000);
  assert.equal(fetched.length, before + 1);
});
