const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/forecast-view.js');

const DAY = V.DAY;
const NOW = 1_800_000_000;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const CATALOG = {
  2409285794: { name: 'Playful Vampire', acronym: 'PV', value: 50000, rap: 49326, demand: 3, trend: 2 },
  1: { name: 'Vampire Hat', acronym: '', value: 1000, rap: 900 },
  2: { name: 'Big Vampire Cape', acronym: 'BVC', value: 50000, rap: 1, projected: true },
  3: { name: 'Unvalued Hat', acronym: 'UH', value: -1, rap: 5 },
  junk: { name: 'Not an item', value: 5 }
};
// A forecast as ValueForecast.forecast returns it: 1 month from the item model, longer spans usual.
const FC = {
  value: 50000, at: NOW,
  horizons: {
    30: {
      days: 30, source: 'model', low: 46900, q25: 50000, median: 50900, q75: 56700, high: 63100, up: 0.55, same: 0.29, down: 0.16, base: { median: 1, up: 0.215 },
      backtest: { years: [2020, 2026], n: 73364, inside80: 0.82, usualInside80: 0.803, worst80: { year: 2020, value: 0.681 }, miss: 0.061, missSame: 0.061, missUsual: 0.061, skill: 0.08, aucUp: 0.754, aucDown: 0.811 }
    },
    365: {
      days: 365, source: 'usual', low: 38600, q25: 50000, median: 62500, q75: 89500, high: 138000, up: 0.64, same: 0.13, down: 0.23,
      backtest: { years: [2021, 2025], n: 53114, inside80: 0.57, usualInside80: 0.769, usualWorst80: { year: 2025, value: 0.497 }, miss: 0.581, missSame: 0.547, missUsual: 0.508, skill: -0.229 }
    },
    730: {
      days: 730, source: 'usual', low: 42900, q25: 54700, median: 83400, q75: 125000, high: 197000, up: 0.79, same: 0.06, down: 0.15,
      backtest: { years: [2022, 2024], n: 31925, inside80: 0.624, usualInside80: 0.759, usualWorst80: { year: 2024, value: 0.595 }, miss: 0.611, missSame: 0.919, missUsual: 0.648, skill: 0.0048 }
    }
  }
};

test('the item picker lists valued items and finds what was typed or picked', () => {
  const list = V.items(CATALOG);
  assert.deepEqual(list.map(x => x.assetId), [2, 2409285794, 1], 'valued only, biggest value first');
  assert.deepEqual([list[0].projected, list[1].projected, list[1].rap], [true, false, 49326]);
  assert.equal(V.optionText(list[1]), 'Playful Vampire (PV) · #2409285794');
  assert.equal(V.optionText(list[2]), 'Vampire Hat · #1');
  const find = text => V.find(list, text)?.assetId;
  assert.equal(find('Playful Vampire (PV) · #2409285794'), 2409285794);
  assert.equal(find(' 2409285794 '), 2409285794);
  assert.equal(find('pv'), 2409285794);
  assert.equal(find('Vampire Hat'), 1);
  assert.equal(find('vamp'), 1, 'names starting with it first');
  assert.equal(find('pire'), 2, 'then names containing it, biggest value first');
  assert.equal(find('cape'), 2);
  assert.deepEqual(V.find(list, '777'), { assetId: 777, name: 'Item 777', acronym: '' }, 'an ID works without the catalog');
  assert.equal(V.find(list, 'zzz'), null);
  assert.equal(V.find(list, '  '), null);
  assert.deepEqual(V.items(null), []);
});

test('numbers and labels read like estimates', () => {
  assert.deepEqual([62500, 138333, 110000000, 950.4, 0].map(n => V.money(n)), ['62,500', '138,000', '110,000,000', '950', '0']);
  assert.equal(V.money(NaN), '–');
  assert.deepEqual([950, 12000, 1500000, 2e9].map(n => V.compact(n)), ['950', '12K', '1.5M', '2B']);
  assert.deepEqual([1.25, 0.77, 1.004, 1].map(r => V.change(r)), ['+25%', '−23%', '±0%', '±0%']);
  assert.deepEqual([0.55, 0.004, 0.996, 0, 1, undefined].map(p => V.pct(p)), ['55%', '<1%', '>99%', '0%', '100%', '–']);
  assert.deepEqual([30, 365, 730, 45].map(d => V.label(d)), ['1 month', '1 year', '2 years', '45 days']);
  assert.equal(V.monthYear(Date.UTC(2027, 10, 26) / 1000), 'Nov 2027');
});

test('the chart gets past value steps, weekly RAP points and the forecast fan', () => {
  const T = NOW - (NOW % DAY);
  const series = {
    value: 1500,
    changes: [[T - 400 * DAY, 1, null, 900], [T - 300 * DAY, 2, null, 3], [T - 100 * DAY, 1, 900, 1000], [T - 10 * DAY, 1, 1000, 1500], [T - 5 * DAY, 1, 1500, null]],
    daily: { t: Array.from({ length: 30 }, (_, i) => T - (29 - i) * DAY), rap: Array.from({ length: 30 }, (_, i) => (i === 3 ? null : 800 + i)) }
  };
  assert.deepEqual(V.valueSteps(series, T - 200 * DAY, T), [{ t: T - 200 * DAY, value: 900 }, { t: T - 100 * DAY, value: 1000 }, { t: T - 10 * DAY, value: 1500 }]);
  assert.deepEqual(V.valueSteps({}, T - DAY, T), []);
  assert.deepEqual(V.rapPoints(series, T - 40 * DAY, T).map(p => (T - p.t) / DAY), [29, 22, 15, 8, 1, 0]);
  const fan = V.fan(FC);
  assert.deepEqual(fan.map(p => [p.days, p.source, (p.t - NOW) / DAY]), [[0, null, 0], [30, 'model', 30], [365, 'usual', 365], [730, 'usual', 730]]);
  assert.deepEqual([fan[0].low, fan[0].high, fan[2].median], [50000, 50000, 62500]);
  assert.deepEqual(V.horizons(FC), [30, 365, 730]);
});

test('summary boxes show the item model’s longest span and 1 year', () => {
  assert.deepEqual(V.headlines(FC), [30, 365]);
  assert.deepEqual(V.headlines({ ...FC, horizons: { 365: FC.horizons[365], 730: FC.horizons[730] } }), [365]);
  assert.deepEqual(V.headlines({ ...FC, horizons: { 30: FC.horizons[30], 90: { ...FC.horizons[365], days: 90 } } }), [30, 90]);
  assert.deepEqual(V.headlines({ ...FC, horizons: { 30: FC.horizons[30] } }), [30]);
});

test('reliability lines report the backtest of what is shown', () => {
  assert.equal(V.reliability(30, FC.horizons[30]),
    '1 month (this item’s forecast), tested on 2020–2026, 73,364 past forecasts: the likely range held 82% of the time (worst year 2020: 68%); ' +
    'the real value typically ended 6% away from the typical value (6% away from the value at the time). ' +
    'Spotting raises 0.75, drops 0.81 (0.5 = coin flip, 1 = perfect); 8% better than the usual odds for any item.');
  assert.equal(V.reliability(365, FC.horizons[365]),
    '1 year (usual for any item), tested on 2021–2025, 53,114 past forecasts: the likely range held 77% of the time (worst year 2025: 50%); ' +
    'the real value typically ended 51% away from the typical value (55% away from the value at the time). ' +
    'The item’s own forecast scored 23% worse overall and caught the real value in its likely range only 57% of the time in these tests, so the usual range is shown.');
  assert.equal(V.whyUsual(FC.horizons[730].backtest), 'The item’s own forecast caught the real value in its likely range only 62% of the time in these tests, so the usual range is shown.');
  assert.equal(V.whyUsual({ skill: -0.004, inside80: 0.8, usualInside80: 0.8 }), 'The item’s own forecast scored no better overall in these tests, so the usual range is shown.');
  assert.equal(V.whyUsual(null), 'The item forecast was not tested for this span.');
  assert.equal(V.reliability(90, { source: 'model', backtest: null }), '3 months (this item’s forecast): not tested.');
});

test('the model note gives the data date and asks for a retrain when old', () => {
  const model = { horizons: {}, dataAt: '2026-11-23T17:36:30.000Z' };
  assert.equal(V.modelNote(model, Date.parse('2026-11-26T08:00:00Z')),
    'Forecast model built from Rolimon’s history up to Nov 23, 2026 (2 days ago). Each forecast starts from the item’s live Rolimon’s page.');
  assert.match(V.modelNote(model, Date.parse('2026-11-23T20:00:00Z')), /\(today\)\./);
  assert.match(V.modelNote(model, Date.parse('2026-11-24T20:00:00Z')), /\(1 day ago\)\./);
  assert.match(V.modelNote(model, Date.parse('2027-03-01T00:00:00Z')), /\(97 days ago\); retrain it soon with node tools\/train-value-forecast\.cjs\./);
  assert.match(V.modelNote(null), /missing.*node tools\/train-value-forecast\.cjs/);
  assert.equal(V.modelNote({ horizons: {} }), 'Each forecast starts from the item’s live Rolimon’s page.');
});

test('chart scales fit the past value and the forecast range on a log axis', () => {
  assert.deepEqual(V.ticks(22517, 212976), [50000, 100000, 200000]);
  assert.deepEqual(V.ticks(18518519, 468547200), [2e7, 5e7, 1e8, 2e8]);
  assert.deepEqual(V.ticks(800, 1400), [800, 900, 1000]);
  const many = V.ticks(1, 1e9);
  assert.ok(many.length >= 3 && many.length <= 8 && many.every((v, i) => v >= 1 && v <= 1e9 && (!i || v > many[i - 1])));
  // A far-off RAP is clipped to half the lowest / double the highest value or forecast.
  const steps = [{ t: NOW - 700 * DAY, value: 40000 }, { t: NOW - 10 * DAY, value: 50000 }];
  const sc = V.scales({ steps, rap: [{ t: NOW - 100 * DAY, value: 10000 }, { t: NOW, value: 1e6 }], fan: V.fan(FC), now: NOW });
  close(sc.lo, 38600 / 2 / 1.08);
  close(sc.hi, 197000 * 2 * 1.08);
  close(sc.x(NOW - 730 * DAY), sc.pad.l);
  close(sc.x(NOW + 730 * DAY), sc.width - sc.pad.r);
  close(sc.y(sc.hi), sc.pad.t);
  close(sc.y(sc.lo), sc.height - sc.pad.b);
  // A flat item still gets a readable range.
  const flat = V.scales({ steps: [{ t: NOW, value: 1000 }], fan: [{ t: NOW, low: 1000, high: 1000 }], now: NOW });
  close(flat.lo, 800 / 1.08);
  close(flat.hi, 1250 * 1.08);
  assert.deepEqual(flat.ticks, [800, 900, 1000]);
});
