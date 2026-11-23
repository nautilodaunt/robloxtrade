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
