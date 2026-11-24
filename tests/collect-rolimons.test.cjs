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
