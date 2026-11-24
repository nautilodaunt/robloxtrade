const { test } = require('node:test');
const assert = require('node:assert/strict');
const TradeValues = require('../src/values.js');
const R = require('../src/portfolio-risk.js');

// Rolimon's itemdetails rows: [name, acronym, rap, value, default, demand, trend, projected, hyped, rare]
const ROWS = {
  1: ['Steady A', 'SA', 20000, 20000, 20000, 3, 2, -1, -1, -1],
  2: ['Steady B', 'SB', 20000, 20000, 20000, 3, 2, -1, -1, -1],
  3: ['Steady C', 'SC', 20000, 20000, 20000, 3, 2, -1, -1, -1],
  4: ['Steady D', 'SD', 20000, 20000, 20000, 3, 2, -1, -1, -1],
  5: ['Steady E', 'SE', 20000, 20000, 20000, 3, 2, -1, -1, -1],
  6: ['Pumped', 'PU', 40000, -1, 40000, -1, -1, 1, -1, -1],
  7: ['Whale', 'WH', 80000, 80000, 80000, 2, 2, -1, -1, -1],
  8: ['Junk', '', 1000, 1000, 1000, 1, 2, -1, -1, -1],
  9: ['Riser', 'RI', 30000, 25000, 25000, 3, 3, -1, -1, -1],
  10: ['Modeled', 'MO', 20000, 20000, 20000, 3, 2, -1, -1, -1]
};
const CATALOG = TradeValues.parseItems({ success: true, items: ROWS });
let n = 0;
const copy = (assetId, isOnHold = false, serialNumber = null) => ({ instanceId: `copy-${String(++n).padStart(4, '0')}-aaaa`, assetId, name: ROWS[assetId][0], serialNumber, isOnHold });
const steady = () => [1, 2, 3, 4, 5].map(id => copy(id));
const kinds = analysis => analysis.actions.map(a => a.kind);
const prediction = (down, up = 0.05) => ({ prediction: { horizons: {
  7: { up, down: down * 0.6, baseUp: 0.03, baseDown: 0.08 }, 14: { up, down: down * 0.8, baseUp: 0.05, baseDown: 0.1 },
  30: { up, down, baseUp: 0.09, baseDown: 0.17 } } }, at: Date.now() });

test('groups copies into holdings with hold status, serials and weights', () => {
  const copies = [copy(1, false, 12), copy(1, true, 40), copy(7)];
  const list = R.holdings(copies, CATALOG);
  assert.deepEqual(list.map(h => [h.assetId, h.copies, h.onHold, h.tradable, h.total]), [[7, 1, 0, 1, 80000], [1, 2, 1, 1, 40000]]);
  assert.deepEqual(list[1].serials, [12, 40]);
  assert.deepEqual(list[1].tradableInstanceIds, [copies[0].instanceId]);
  const a = R.analyze(copies, CATALOG);
  assert.equal(a.totals.value, 120000);
  assert.equal(a.totals.held, 20000);
  assert.equal(a.totals.copies, 3);
  assert.ok(Math.abs(a.holdings.reduce((s, h) => s + h.weight, 0) - 1) < 1e-9);
});

test('a spread, healthy portfolio says sit tight', () => {
  const a = R.analyze(steady(), CATALOG);
  assert.deepEqual(kinds(a), ['clear']);
  assert.equal(a.verdict.level, 'green');
  assert.equal(a.risk.level, 'Low');
  assert.equal(a.outlook.stable, 1);
  assert.match(a.actions[0].detail, /deep model scan/); // no model coverage yet
  assert.deepEqual(R.analyze([], CATALOG).verdict.level, 'none');
});

test('projected items are exits and push the risk up', () => {
  const copies = [...steady(), copy(6)];
  const a = R.analyze(copies, CATALOG);
  const exit = a.actions[0];
  assert.equal(exit.kind, 'exit');
  assert.equal(exit.assetId, 6);
  assert.deepEqual(exit.instanceIds, [copies[5].instanceId]);
  assert.equal(a.verdict.level, 'red');
  const pumped = a.holdings.find(h => h.assetId === 6);
  assert.ok(pumped.risk.score >= 85);
  assert.equal(pumped.risk.outlook, 'drop');
  assert.ok(a.risk.score > R.analyze(steady(), CATALOG).risk.score);
});

test('model odds of a lower make an exit, or a held-risk note when every copy is on hold', () => {
  const insights = { 10: prediction(0.5) };
  const a = R.analyze([...steady(), copy(10)], CATALOG, insights);
  const h = a.holdings.find(x => x.assetId === 10);
  assert.equal(h.risk.source, 'model');
  assert.equal(h.risk.outlook, 'drop');
  assert.ok(h.risk.signals.some(s => /50% model odds of a value lower/.test(s)));
  assert.equal(a.actions[0].kind, 'exit');
  assert.deepEqual([a.coverage.items, a.coverage.of], [1, 6]);

  const held = R.analyze([...steady(), copy(10, true)], CATALOG, insights);
  assert.deepEqual(kinds(held), ['held-risk']);
  assert.equal(held.verdict.level, 'yellow');
  assert.ok(held.risk.meters.hold > 0);
  // Low odds keep it stable.
  assert.equal(R.analyze([copy(10)], CATALOG, { 10: prediction(0.05) }).holdings[0].risk.outlook, 'stable');
});

test('flags concentration in one weaker item and clutter of low-demand items', () => {
  const whale = R.analyze([copy(7), copy(1)], CATALOG);
  const c = whale.actions.find(a => a.kind === 'concentration');
  assert.ok(c);
  assert.equal(c.assetId, 7);
  assert.match(c.title, /80%/);
  assert.equal(whale.verdict.level, 'yellow');
  assert.ok(whale.risk.meters.concentration > 50);

  const cluttered = R.analyze([...steady(), copy(8), copy(8), copy(8), copy(8)], CATALOG);
  const clutter = cluttered.actions.find(a => a.kind === 'clutter');
  assert.ok(clutter);
  assert.equal(clutter.instanceIds.length, 4);
  assert.match(clutter.title, /Upgrade 4/);
});

test('likely risers get a hold action with their tradable copies', () => {
  const copies = [...steady(), copy(9), copy(9, true)];
  const a = R.analyze(copies, CATALOG);
  const hold = a.actions.find(x => x.kind === 'hold');
  assert.equal(hold.assetId, 9);
  assert.deepEqual(hold.instanceIds, [copies[5].instanceId]);
  assert.equal(a.actions[0].kind, 'clear'); // nothing urgent, so the all-clear card leads
  assert.equal(a.verdict.level, 'green');
  assert.ok(a.outlook.raise > 0);
});

test('what-if trade compares before/after and warns about bad swaps', () => {
  const copies = [...steady(), copy(9), copy(1, true)];
  const giveRiser = R.simulate(copies, CATALOG, {}, [copies[5].instanceId], [6]);
  assert.equal(giveRiser.giveValue, 25000);
  assert.equal(giveRiser.getValue, 40000); // projected counts at RAP
  assert.equal(giveRiser.gain, 15000);
  assert.ok(giveRiser.warnings.some(w => /projected/.test(w)));
  assert.ok(giveRiser.warnings.some(w => /likely to rise/.test(w)));
  assert.ok(giveRiser.newActions.some(a => a.kind === 'exit' && a.assetId === 6));
  assert.ok(giveRiser.resolvedActions.some(a => a.kind === 'hold'));
  assert.ok(giveRiser.after.risk.score > giveRiser.before.risk.score);

  const lowball = R.simulate(copies, CATALOG, {}, [copies[0].instanceId, copies[1].instanceId], [8]);
  assert.equal(lowball.gain, -39000);
  assert.ok(lowball.warnings.some(w => /lose 39,000/.test(w)));
  assert.ok(lowball.warnings.some(w => /lower demand/.test(w)));
  assert.ok(R.simulate(copies, CATALOG, {}, [copies[6].instanceId], [2]).warnings.some(w => /on trade hold/.test(w)));

  assert.throws(() => R.simulate(copies, CATALOG, {}, [], []), /at least one/);
  assert.throws(() => R.simulate(copies, CATALOG, {}, ['copy-9999-zzzz'], []), /not in this inventory/);
  assert.throws(() => R.simulate(copies, CATALOG, {}, [], [999]), /Unknown item/);
  assert.throws(() => R.simulate(copies, CATALOG, {}, [], [1, 1, 1, 1, 1]), /up to 4/);
  assert.throws(() => R.simulate(copies, CATALOG, {}, [copies[0].instanceId, copies[0].instanceId], []), /twice/);
});

test('daily history keeps one point per day, sorted and capped', () => {
  const a = R.analyze(steady(), CATALOG);
  const day = Date.UTC(2026, 10, 20);
  const p1 = R.snapshot(a, day);
  assert.deepEqual(p1, { d: '2026-11-20', value: 100000, rap: 100000, risk: a.risk.score });
  let points = R.recordHistory([], p1);
  points = R.recordHistory(points, { ...p1, value: 90000 });
  assert.deepEqual(points.map(p => p.value), [90000]);
  points = R.recordHistory(points, { d: '2026-11-18', value: 1, rap: 1, risk: 1 });
  assert.deepEqual(points.map(p => p.d), ['2026-11-18', '2026-11-20']);
  assert.equal(R.recordHistory(points, { d: '2026-11-21', value: 2, rap: 2, risk: 2 }, 2)[0].d, '2026-11-20');
  assert.deepEqual(R.recordHistory(null, p1), [p1]);
});
