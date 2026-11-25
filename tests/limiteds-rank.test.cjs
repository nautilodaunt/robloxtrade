const { test } = require('node:test');
const assert = require('node:assert/strict');
const TradeValues = require('../src/values.js');
const L = require('../src/limiteds-rank.js');

// Rolimon's itemdetails rows: [name, acronym, rap, value, default, demand, trend, projected, hyped, rare]
const CATALOG = TradeValues.parseItems({ success: true, items: {
  1: ['Cheap Hat', 'CH', 4000, 5000, 5000, 2, 2, -1, -1, -1],
  2: ['Riser Hat', 'RH', 33000, 30000, 30000, 3, 3, -1, -1, -1],
  3: ['Steady Hat', 'SH', 40000, 40000, 40000, 3, 2, -1, -1, -1],
  4: ['Falling Hat', 'FH', 30000, 45000, 45000, 1, 0, -1, -1, -1],
  5: ['RAP Only', '', 20000, -1, 20000, -1, -1, -1, -1, -1],
  6: ['Pumped Hat', 'PH', 50000, 35000, 35000, 2, 2, 1, -1, -1],
  7: ['Big Hat', 'BH', 900000, 1000000, 1000000, 4, 2, -1, -1, -1]
} });
const odds = (up, down, baseUp = 0.09, baseDown = 0.17) => ({ at: Date.now(), prediction: { horizons: {
  7: { up: up / 3, down: down / 3, baseUp: 0.03, baseDown: 0.08 }, 14: { up: up / 2, down: down / 2, baseUp: 0.05, baseDown: 0.1 }, 30: { up, down, baseUp, baseDown } } } });

test('parses value amounts with k / m suffixes and rejects junk', () => {
  assert.equal(L.parseAmount(''), null);
  assert.equal(L.parseAmount(' 25,000 '), 25000);
  assert.equal(L.parseAmount('25k'), 25000);
  assert.equal(L.parseAmount('1.5M'), 1500000);
  assert.throws(() => L.parseAmount('abc', 'Min value'), /Min value/);
  assert.throws(() => L.parseAmount('-5'));
  assert.throws(() => L.parseAmount('5kk'));
});

test('filters to valued limiteds in range, excluding projected by default', () => {
  const ids = opts => L.filter(CATALOG, opts).map(x => x.assetId).sort((a, b) => a - b);
  assert.deepEqual(ids(), [1, 2, 3, 4, 7]); // RAP-only and projected are out
  assert.deepEqual(ids({ min: 10000, max: 50000 }), [2, 3, 4]);
  assert.deepEqual(ids({ min: 10000, max: 50000, projected: true }), [2, 3, 4, 6]);
  assert.deepEqual(ids({ minDemand: 3 }), [2, 3, 7]);
  assert.deepEqual(ids({ query: 'steady' }), [3]);
  assert.deepEqual(ids({ query: 'rh' }), [2]); // exact acronym
  assert.throws(() => L.filter(CATALOG, { min: 50000, max: 10000 }), /at least the min/);
});

test('unscanned items are scanned most promising first', () => {
  const order = L.scanOrder(L.filter(CATALOG, { min: 10000, max: 50000 })).map(x => x.assetId);
  assert.equal(order[0], 2);          // Raising trend + RAP above value
  assert.equal(order.at(-1), 4);      // Lowering trend + RAP well under value
});

test('ranks scanned items by raise odds and keeps unscanned ones after them', () => {
  const list = L.filter(CATALOG, {});
  const insights = { 3: odds(0.4, 0.05), 4: odds(0.1, 0.6), 7: odds(0.15, 0.02, 0.05) };
  const up = L.rank(list, insights, { horizon: 30, sort: 'up' });
  assert.deepEqual(up.map(r => r.assetId), [3, 7, 4, 2, 1]);
  assert.equal(up[0].signal, 'likely-raise');
  assert.equal(up[2].signal, 'likely-lower');
  assert.equal(up[3].signal, 'none');
  assert.equal(up[3].scanned, false);
  // 7 is 3x its usual rate, 3 is about 4.4x.
  assert.deepEqual(L.rank(list, insights, { sort: 'lift' }).slice(0, 3).map(r => r.assetId), [3, 7, 4]);
  assert.deepEqual(L.rank(list, insights, { sort: 'safe' }).slice(0, 3).map(r => r.assetId), [7, 3, 4]);
  assert.deepEqual(L.rank(list, insights, { sort: 'edge' }).slice(0, 3).map(r => r.assetId), [3, 7, 4]);
  assert.deepEqual(L.rank(list, insights, { sort: 'value' }).map(r => r.assetId), [7, 4, 3, 2, 1]);
  assert.deepEqual(L.rank(list, insights, { sort: 'value-asc' }).map(r => r.assetId), [1, 2, 3, 4, 7]);
  // Horizon changes which odds are used.
  assert.ok(Math.abs(L.rank(list, insights, { horizon: 7 })[0].odds.up - 0.4 / 3) < 1e-9);
  // A scanned item without model odds (not enough data) ranks with the unscanned ones.
  const noOdds = L.rank(list, { 2: { at: Date.now(), prediction: null } }, { sort: 'up' }).find(r => r.assetId === 2);
  assert.deepEqual([noOdds.scanned, noOdds.odds, noOdds.signal], [true, null, 'none']);
  assert.throws(() => L.rank(list, {}, { horizon: 9 }));
  assert.throws(() => L.rank(list, {}, { sort: 'nope' }));
});

test('signal thresholds match the hover panel', () => {
  assert.equal(L.signal(null), 'none');
  assert.equal(L.signal({ up: 0.55, down: 0.1, baseUp: 0.3, baseDown: 0.1 }), 'likely-raise');
  assert.equal(L.signal({ up: 0.21, down: 0.05, baseUp: 0.1, baseDown: 0.1 }), 'likely-raise');
  assert.equal(L.signal({ up: 0.15, down: 0.05, baseUp: 0.09, baseDown: 0.17 }), 'possible-raise');
  assert.equal(L.signal({ up: 0.05, down: 0.5, baseUp: 0.09, baseDown: 0.17 }), 'likely-lower');
  assert.equal(L.signal({ up: 0.05, down: 0.1, baseUp: 0.09, baseDown: 0.17 }), 'neutral');
});
