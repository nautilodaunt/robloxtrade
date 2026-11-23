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
