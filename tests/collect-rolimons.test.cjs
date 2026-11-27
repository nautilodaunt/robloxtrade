const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickTodo } = require('../tools/collect-rolimons.cjs');

const DAY = 86400e3;
const now = Date.UTC(2026, 10, 23);
const list = ['1', '2', '3', '4'].map(id => ({ id, name: `Item ${id}`, value: 1000 }));
// 1 never saved, 2 saved 40 days ago, 3 saved 10 days ago, 4 saved an hour ago.
const savedAt = { 2: now - 40 * DAY, 3: now - 10 * DAY, 4: now - 3600e3 };
const ids = items => items.map(item => item.id);

test('without refresh only items never saved are fetched', () => {
  const { missing, stale, todo } = pickTodo(list, savedAt, { now });
  assert.deepEqual(ids(missing), ['1']);
  assert.deepEqual(ids(stale), []);
  assert.deepEqual(ids(todo), ['1']);
});

test('refresh re-fetches items older than max age, oldest first, after new ones', () => {
  assert.deepEqual(ids(pickTodo(list, savedAt, { refresh: true, now }).todo), ['1', '2', '3']);
  assert.deepEqual(ids(pickTodo(list, savedAt, { refresh: true, maxAgeDays: 30, now }).todo), ['1', '2']);
  assert.deepEqual(ids(pickTodo(list, savedAt, { refresh: true, limit: 2, now }).todo), ['1', '2']);
});

test('a stopped refresh resumes: items saved during the run are not fetched again', () => {
  const resumed = { ...savedAt, 1: now - 600e3, 2: now - 300e3 };
  assert.deepEqual(ids(pickTodo(list, resumed, { refresh: true, now }).todo), ['3']);
});

test('a face is read from its bundle page, directly once its bundle ID is saved', async () => {
  const { fetchSeries } = require('../tools/collect-rolimons.cjs');
  const t = Date.UTC(2020, 0, 1) / 1000;
  const history = best => JSON.stringify({ timestamp: [t, t + 86400], rap: [100, 110], best_price: [best, best], num_sellers: [5, 5], favorited: [10, 11] });
  const face = 'https://www.rolimons.com/item/1', bundle = 'https://www.rolimons.com/bundle/77', hat = 'https://www.rolimons.com/item/2';
  const pages = {
    [face]: `var item_details_data = {"item_name":"Face","value":100,"migrated_to_bundle_id":77};\nvar history_data = ${history(500)};`,
    [bundle]: `var bundle_details_data = {"bundle_id":77,"bundle_name":"Face","migrated_from_asset_id":1,"value":100};\nvar history_data = ${history(90)};`,
    [hat]: `var item_details_data = {"item_name":"Hat","value":100};\nvar history_data = ${history(120)};`
  };
  const fetched = [], realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    fetched.push(url);
    return pages[url] ? { ok: true, status: 200, text: async () => pages[url] } : { ok: false, status: 404, text: async () => '' };
  };
  try {
    let { series } = await fetchSeries({ id: '1' }, null, 0);
    assert.equal(series.daily.best.at(-1), 90);
    assert.equal(series.bundleId, '77');
    ({ series } = await fetchSeries({ id: '1' }, '77', 0));
    assert.equal(series.daily.best.at(-1), 90);
    ({ series } = await fetchSeries({ id: '2' }, null, 0));
    assert.equal(series.daily.best.at(-1), 120);
    assert.equal(series.bundleId, null);
    assert.deepEqual(fetched, [face, bundle, bundle, hat]);
    assert.deepEqual(await fetchSeries({ id: '3' }, null, 0), { error: '404' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
