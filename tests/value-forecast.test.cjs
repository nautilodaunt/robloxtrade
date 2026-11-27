const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const VM = require('../src/value-model.js');
const VF = require('../src/value-forecast.js');

const DAY = VF.DAY;
const T0 = 1700000000 - (1700000000 % DAY);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const at = name => VF.FEATURES.indexOf(name);
const logit = p => Math.log(p / (1 - p));
// 500 days of daily rows and a sale every 10 days. The value starts at 1000,
// is lowered to 800 on day 200 and raised to 1500 on day 450.
function series({ value = 1500, changes } = {}) {
  const t = [], rap = [], best = [], sellers = [], fav = [];
  for (let i = 0; i < 500; i++) {
    t.push(T0 + i * DAY);
    rap.push(900 + i);
    best.push(1000 + i);
    sellers.push(20 + (i % 7));
    fav.push(100 + i);
  }
  const sales = { t: [], price: [], volume: [] };
  for (let i = 5; i < 500; i += 10) { sales.t.push(T0 + i * DAY); sales.price.push(950 + i); sales.volume.push(1 + (i % 3)); }
  return {
    created: T0 - 400 * DAY, value, demand: 3, trend: 2, projected: false, hyped: false,
    daily: { t, rap, best, sellers, fav }, sales,
    changes: changes ?? [[T0 - 10 * DAY, 1, null, 1000], [T0 - 10 * DAY + 2, 2, null, '3'], [T0 + 200 * DAY + 500, 1, 1000, 800], [T0 + 450 * DAY + 500, 1, 800, 1500]]
  };
}
const cut = (s, t) => ({
  ...s,
  daily: Object.fromEntries(Object.entries(s.daily).map(([k, a]) => [k, a.filter((_, i) => s.daily.t[i] < t - DAY + 1)])),
  sales: Object.fromEntries(Object.entries(s.sales).map(([k, a]) => [k, a.filter((_, i) => s.sales.t[i] < t - DAY + 1)])),
  changes: s.changes.filter(c => c[0] < t)
});
// 1 month from the item model (odds from fixed biases), 1 year from the usual range.
function fakeModel() {
  const odds = { d50: 0.01, d75: 0.03, d90: 0.08, down: 0.15, up: 0.3, u110: 0.12, u125: 0.06, u150: 0.02, u200: 0.005, u300: 0.001 };
  return {
    trainedAt: '2026-11-24T00:00:00Z', dataAt: '2026-11-23T00:00:00Z', features: VF.FEATURES,
    horizons: {
      30: {
        use: 'model', tails: [Math.log(0.4), Math.log(4)],
        events: Object.fromEntries(Object.entries(odds).map(([k, p]) => [k, { bias: logit(p), trees: [] }])),
        base: { n: 9, up: 0.2, down: 0.15, same: 0.65, low: 0.9, q25: 1, median: 1, q75: 1, high: 1.1, mean: 1.01 },
        backtest: { years: [2020, 2026], n: 9, inside80: 0.82, usualInside80: 0.8, skill: 0.08 }
      },
      365: {
        use: 'usual',
        base: { n: 9, up: 0.64, down: 0.23, same: 0.13, low: 0.77, q25: 1, median: 1.25, q75: 1.79, high: 2.75, mean: 1.58 },
        backtest: { years: [2021, 2025], n: 9, inside80: 0.57, usualInside80: 0.77, skill: -0.2 }
      }
    }
  };
}

test('forecast features add longer history to the short-term ones, from past data only', () => {
  assert.deepEqual(VF.FEATURES, [...VM.FEATURES, ...VF.EXTRA]);
  const s = series();
  for (const t of [T0 + 400 * DAY, T0 + 450 * DAY, T0 + 451 * DAY + 3600, T0 + 499 * DAY]) {
    const full = VF.features(s, t), past = VF.features(cut(s, t), t);
    assert.equal(full.length, VF.FEATURES.length);
    assert.deepEqual(full.map(String), past.map(String));
    assert.deepEqual(full.slice(0, VM.FEATURES.length).map(String), VM.features(s, t).map(String));
  }
  // After the day-450 raise to 1500: up from 800 three months before and 1000 a year before, a new 1-year peak.
  const x = VF.features(s, T0 + 451 * DAY);
  close(x[at('valueMom90')], Math.log(1500 / 800));
  close(x[at('valueMom365')], Math.log(1500 / 1000));
  assert.equal(x[at('fromPeak365')], 0);
  assert.equal(x[at('valueChanges730')], 2);
  close(x[at('valueSwing730')], Math.log(1000 / 800) + Math.log(1500 / 800));
  close(x[at('rapMom365')], Math.log(1350 / 985));
  // The day before, it was 800, below the 1000 of a year before.
  const y = VF.features(s, T0 + 450 * DAY);
  close(y[at('fromPeak365')], Math.log(800 / 1000));
  assert.equal(y[at('valueChanges730')], 1);
  // No value, or no recent daily rows: no features.
  assert.equal(VF.features(series({ value: null, changes: [] }), T0 + 450 * DAY), null);
  assert.equal(VF.features(s, T0 + 540 * DAY), null);
});

test('outcomes are the log change of the value after N days', () => {
  const s = series();
  close(VF.change(s, T0 + 100 * DAY, 365), Math.log(1.5));
  close(VF.change(s, T0 + 100 * DAY, 200), Math.log(0.8));
  assert.equal(VF.change(s, T0 + 300 * DAY, 30), 0);
  assert.equal(VF.change(series({ value: null, changes: [] }), T0, 30), null);
  const event = key => VF.EVENTS.find(e => e.key === key);
  assert.deepEqual([0.01, 0, -0.01].map(u => VF.hit(event('up'), u)), [true, false, false]);
  assert.deepEqual([0.01, 0, -0.01].map(u => VF.hit(event('down'), u)), [false, false, true]);
  // Exactly x1.5 or x0.75 counts.
  assert.deepEqual([1.5, 1.49].map(r => VF.hit(event('u150'), Math.log(r))), [true, false]);
  assert.deepEqual([0.75, 0.76].map(r => VF.hit(event('d75'), Math.log(r))), [true, false]);
});

test('event odds become one consistent distribution of the value change', () => {
  assert.deepEqual(VF.isotonic([0.1, 0.3, 0.2, 0.4]), [0.1, 0.25, 0.25, 0.4]);
  const pooled = VF.isotonic([0.5, 0.4, 0.3]);
  assert.equal(pooled.length, 3);
  pooled.forEach(p => close(p, 0.4));
  // Odds in EVENTS order: <=x0.5, <=x0.75, <=x0.9, lower, higher, >=x1.1, x1.25, x1.5, x2, x3.
  const d = VF.distribution([0.02, 0.08, 0.15, 0.25, 0.55, 0.45, 0.3, 0.18, 0.08, 0.03], [Math.log(0.4), Math.log(4)]);
  close(d.segments.reduce((a, s) => a + s.mass, 0), 1, 1e-12);
  close(d.down, 0.25);
  close(d.up, 0.55);
  close(d.same, 0.2);
  const qs = [0.01, 0.1, 0.25, 0.4, 0.5, 0.75, 0.9, 0.985].map(p => VF.quantile(d, p));
  qs.forEach((q, i) => assert.ok(!i || q >= qs[i - 1], 'quantiles rise'));
  assert.equal(VF.quantile(d, 0.4), 0, '25% lower, then 20% unchanged');
  close(VF.quantile(d, 0.5), Math.log(1.1) / 2);
  // The open-ended tails average what happened beyond x0.5 and x3.
  close(VF.quantile(d, 0.01), Math.log(0.4));
  close(VF.quantile(d, 0.985), Math.log(4));
  const sum = VF.summarize(d);
  assert.ok(sum.low <= sum.q25 && sum.q25 <= sum.median && sum.median <= sum.q75 && sum.q75 <= sum.high);
  assert.ok(sum.mean > sum.median, 'a long upper tail lifts the average');
  // Separately trained models can disagree; the chances are made consistent.
  const odd = VF.distribution([0.3, 0.2, 0.5, 0.4, 0.7, 0.2, 0.25, 0.1, 0.12, 0.01]);
  assert.ok(odd.segments.every(s => s.mass >= 0));
  close(odd.segments.reduce((a, s) => a + s.mass, 0), 1, 1e-12);
  odd.cdf.forEach((c, i) => assert.ok(!i || c >= odd.cdf[i - 1]));
  // Nothing but "unchanged".
  const flat = VF.distribution([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([flat.up, flat.down, flat.same], [0, 0, 1]);
  assert.deepEqual([VF.quantile(flat, 0.1), VF.quantile(flat, 0.9), VF.meanRatio(flat)], [0, 0, 1]);
});

test('each span uses the item model where it won its backtest, else the usual range', () => {
  const s = series(), now = T0 + 480 * DAY;
  const fc = VF.forecast(s, fakeModel(), now);
  assert.deepEqual([fc.value, fc.at, fc.dataAt], [1500, now, '2026-11-23T00:00:00Z']);
  assert.deepEqual(Object.keys(fc.horizons), ['30', '365']);
  const m = fc.horizons[30];
  assert.equal(m.source, 'model');
  close(m.up, 0.3);
  close(m.down, 0.15);
  close(m.same, 0.55);
  assert.equal(m.median, 1500, 'the middle outcome is "unchanged"');
  assert.ok(m.low < m.q25 && m.q25 <= m.median && m.median < m.q75 && m.q75 < m.high);
  assert.equal(m.backtest.skill, 0.08);
  const u = fc.horizons[365];
  assert.equal(u.source, 'usual');
  assert.deepEqual([u.low, u.q25, u.median, u.q75, u.high, u.mean], [1155, 1500, 1875, 2685, 4125, 2370]);
  assert.deepEqual([u.up, u.down, u.same], [0.64, 0.23, 0.13]);
  // Without recent daily rows only the usual range is left.
  assert.deepEqual(Object.keys(VF.forecast(s, fakeModel(), T0 + 540 * DAY).horizons), ['365']);
});

test('event odds come from the trees; missing models, values or features give no forecast', () => {
  const s = series(), now = T0 + 480 * DAY;
  const x = VF.features(s, now);
  assert.equal(x[at('lastDir')], 1);
  const up = VF.EVENTS.findIndex(e => e.key === 'up');
  const tree = [[at('lastDir'), 0.5, 1, 2], [-1], [1]];
  const probs = VF.eventProbs({ events: { up: { bias: 0.5, trees: [tree] } } }, x);
  close(probs[up], 1 / (1 + Math.exp(-1.5)));
  assert.ok(probs.filter((_, i) => i !== up).every(Number.isNaN));
  // A span missing an event model is left out.
  const partial = fakeModel();
  delete partial.horizons[30].events.u300;
  assert.deepEqual(Object.keys(VF.forecast(s, partial, now).horizons), ['365']);
  assert.equal(VF.forecast(series({ value: null, changes: [] }), fakeModel(), now), null);
  assert.equal(VF.forecast(s, { ...fakeModel(), features: ['other'] }, now), null);
  assert.equal(VF.forecast(s, null, now), null);
});

test('the shipped forecast model fits the code and follows its backtest rule', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('src/value-forecast-data.js', 'utf8'), context);
  const model = context.VALUE_FORECAST;
  // Copied out of the sandbox, whose arrays have their own prototype.
  assert.deepEqual([...model.features], VF.FEATURES);
  assert.ok(Date.parse(model.dataAt) <= Date.parse(model.trainedAt));
  for (const h of VF.HORIZONS) {
    const m = model.horizons[h], b = m.backtest, base = m.base;
    // The item model only where it beat the usual range overall and its 80% range held about as often.
    assert.equal(m.use, b.skill > 0 && b.inside80 >= b.usualInside80 - 0.02 ? 'model' : 'usual', `${h} days`);
    assert.ok(b.n > 1000 && b.years[0] <= b.years[1] && b.worst80 && b.usualWorst80, `${h} days backtest`);
    const qs = [base.low, base.q25, base.median, base.q75, base.high];
    assert.ok(qs.every((q, i) => q > 0 && (!i || q >= qs[i - 1])), `${h} days usual range`);
    close(base.up + base.down + base.same, 1, 0.01);
    if (m.use === 'usual') { assert.equal(m.events, undefined); continue; }
    assert.ok(m.tails[0] < Math.log(0.5) && m.tails[1] > Math.log(3), `${h} days tails`);
    for (const e of VF.EVENTS) {
      const ev = m.events[e.key];
      assert.ok(Number.isFinite(ev.bias) && ev.trees.length > 0, `${h} days ${e.key}`);
      for (const tree of ev.trees) {
        tree.forEach((node, i) => {
          if (node.length === 1) return assert.ok(Number.isFinite(node[0]));
          const [f, threshold, left, right, missRight] = node;
          assert.ok(Number.isInteger(f) && f >= 0 && f < VF.FEATURES.length && Number.isFinite(threshold));
          assert.ok(left > i && right > i && left < tree.length && right < tree.length && (node.length === 4 || missRight === 1));
        });
      }
    }
  }
  // A synthetic item gets an ordered forecast for every span.
  const fc = VF.forecast(series(), model, T0 + 480 * DAY);
  for (const h of VF.HORIZONS) {
    const f = fc.horizons[h];
    assert.equal(f.source, model.horizons[h].use);
    assert.ok(f.low > 0 && f.low <= f.q25 && f.q25 <= f.median && f.median <= f.q75 && f.q75 <= f.high, `${h} days`);
    close(f.up + f.down + f.same, 1, 0.01);
  }
});
