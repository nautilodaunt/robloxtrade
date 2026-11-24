const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const VM = require('../src/value-model.js');

const DAY = VM.DAY;
const T0 = 1700000000 - (1700000000 % DAY);
// 200 days of daily rows with value 1000, raised to 1500 on day 150.
function series({ value = 1000, changes } = {}) {
  const t = [], rap = [], best = [], sellers = [], fav = [];
  for (let i = 0; i < 200; i++) {
    t.push(T0 + i * DAY);
    rap.push(900 + i * 2);
    best.push(1000 + i);
    sellers.push(20);
    fav.push(100 + i);
  }
  return {
    created: T0 - 400 * DAY, value, demand: 3, trend: 2, projected: false, hyped: false,
    daily: { t, rap, best, sellers, fav },
    sales: { t: [T0 + 100 * DAY, T0 + 170 * DAY], price: [950, 1200], volume: [2, 3] },
    changes: changes ?? [[T0 - 10 * DAY, 1, null, 1000], [T0 - 10 * DAY + 2, 2, null, '3'], [T0 + 150 * DAY + 500, 1, 1000, 1500]]
  };
}
const cut = (s, t) => ({
  ...s,
  daily: Object.fromEntries(Object.entries(s.daily).map(([k, a]) => [k, a.filter((_, i) => s.daily.t[i] < t - DAY + 1)])),
  sales: Object.fromEntries(Object.entries(s.sales).map(([k, a]) => [k, a.filter((_, i) => s.sales.t[i] < t - DAY + 1)])),
  changes: s.changes.filter(c => c[0] < t)
});

test('labels compare the value after N days with the value now', () => {
  const s = series();
  assert.equal(VM.label(s, T0 + 140 * DAY, 14), 1);
  assert.equal(VM.label(s, T0 + 140 * DAY, 7), 0);
  assert.equal(VM.label(s, T0 + 151 * DAY, 7), 0);
  const lowered = series({ changes: [[T0 - DAY, 1, null, 1000], [T0 + 50 * DAY, 1, 1000, 800]] });
  assert.equal(VM.label(lowered, T0 + 45 * DAY, 7), -1);
});

test('features use only data from before the snapshot time', () => {
  const s = series();
  for (const t of [T0 + 60 * DAY, T0 + 150 * DAY, T0 + 151 * DAY, T0 + 171 * DAY]) {
    const full = VM.features(s, t), past = VM.features(cut(s, t), t);
    assert.ok(full);
    assert.equal(full.length, VM.FEATURES.length);
    assert.deepEqual(full.map(String), past.map(String));
  }
  // The day-150 raise shows up only after it happened.
  const at = name => VM.FEATURES.indexOf(name);
  assert.equal(VM.features(s, T0 + 150 * DAY)[at('logValue')], 3);
  assert.equal(VM.features(s, T0 + 151 * DAY)[at('logValue')], Math.log10(1500));
  assert.equal(VM.features(s, T0 + 151 * DAY)[at('lastDir')], 1);
});

test('unvalued items and stale data get no features or prediction', () => {
  const unvalued = series({ value: null, changes: [] });
  assert.equal(VM.features(unvalued, T0 + 100 * DAY), null);
  assert.equal(VM.features(series(), T0 + 230 * DAY), null);
  const model = { horizons: { 7: { up: { bias: 0, trees: [], baseRate: 0.1 }, down: { bias: 0, trees: [], baseRate: 0.05 }, test: {} } } };
  assert.equal(VM.predict(unvalued, model, T0 + 100 * DAY), null);
  assert.equal(VM.predict(series(), null, T0 + 100 * DAY), null);
});

test('trees go left on missing values and predictions are probabilities', () => {
  const tree = [[0, 5, 1, 2], [-1], [1]];
  assert.equal(VM.scoreTrees([tree], [3]), -1);
  assert.equal(VM.scoreTrees([tree], [5]), -1);
  assert.equal(VM.scoreTrees([tree], [NaN]), -1);
  assert.equal(VM.scoreTrees([tree, tree], [6]), 2);
  const model = {
    trainedAt: '2026-01-01', testPeriod: ['2025-06-01', '2026-01-01'],
    horizons: { 7: { up: { bias: 0, trees: [], baseRate: 0.1 }, down: { bias: Math.log(1 / 3), trees: [], baseRate: 0.05 }, test: { up: {} } } }
  };
  const p = VM.predict(series(), model, T0 + 120 * DAY + 3600);
  assert.equal(p.horizons[7].up, 0.5);
  assert.ok(Math.abs(p.horizons[7].down - 0.25) < 1e-9);
  assert.equal(p.horizons[7].baseUp, 0.1);
  assert.deepEqual(p.testPeriod, ['2025-06-01', '2026-01-01']);
  assert.equal(p.dataAt, '2026-01-01');
  assert.equal(VM.predict(series(), { ...model, dataAt: '2025-12-30T10:00:00Z' }, T0 + 120 * DAY).dataAt, '2025-12-30T10:00:00Z');
});

test('the shipped model has valid trees for every horizon', { skip: !fs.existsSync('src/value-model-data.js') }, () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('src/value-model-data.js', 'utf8'), context);
  const model = context.VALUE_MODEL;
  assert.deepEqual([...model.features], VM.FEATURES);
  for (const h of VM.HORIZONS) {
    for (const dir of ['up', 'down']) {
      const m = model.horizons[h][dir];
      assert.ok(Number.isFinite(m.bias) && m.trees.length > 0 && m.baseRate >= 0 && m.baseRate <= 1);
      for (const tree of m.trees) {
        for (const node of tree) {
          if (node.length === 1) { assert.ok(Number.isFinite(node[0])); continue; }
          assert.equal(node.length, 4);
          assert.ok(node[0] >= 0 && node[0] < VM.FEATURES.length && Number.isFinite(node[1]));
          assert.ok(tree[node[2]] && tree[node[3]]);
        }
      }
    }
  }
  const p = VM.predict(series(), model, T0 + 120 * DAY);
  for (const h of VM.HORIZONS) assert.ok(p.horizons[h].up > 0 && p.horizons[h].up < 1 && p.horizons[h].down > 0 && p.horizons[h].down < 1);
});
