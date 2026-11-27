#!/usr/bin/env node
/* Trains the long-range Rolimon's value forecast from data saved by
   tools/collect-rolimons.cjs and writes src/value-forecast-data.js, which the
   value forecast page (src/forecast.html) uses.

   For each horizon (30, 90, 180, 365, 730 days) one gradient boosted tree
   model per outcome event: value at most 0.5x / 0.75x / 0.9x / any lower, or
   any higher / at least 1.1x / 1.25x / 1.5x / 2x / 3x after N days.
   src/value-forecast.js turns the event odds into a value range.

   Honest testing (rolling origin): for each test year the models are trained
   only on snapshots whose outcome was already known on Jan 1 of that year and
   are scored on that year's snapshots, which they never saw. Settings are
   fixed in advance, not tuned on the test years. Baselines: "no change"
   (today's value) and what usually happened to any item before the test year.
   The shipped models are trained on everything with the same settings. Where
   a horizon's item model did not beat the usual range in the backtest, the
   page shows the usual range instead (see useModel).

   Usage: node tools/train-value-forecast.cjs [--step 14] [--rounds 150]
          [--lr 0.05] [--depth 3] [--min-hess 40] [--no-backtest] */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VF = require(path.join(ROOT, 'src', 'value-forecast.js'));
const { createGBM, auc, round, exportTrees } = require('./gbm.cjs');
const DATA = path.join(ROOT, 'tools', 'data');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const ts = s => Date.parse(s + 'T00:00:00Z') / 1000;
const DAY = VF.DAY;
// Fixed in advance, not tuned on the test years.
const STEP = Number(opt('step', 14));
const DEPTH = Number(opt('depth', 3));
const LR = Number(opt('lr', 0.05));
const ROUNDS = Number(opt('rounds', 150));
const MIN_HESS = Number(opt('min-hess', 40));
const LAMBDA = 1;
const ROW_SUB = 0.6;
const COL_SUB = 0.8;
const BINS = 63;
const SNAP_START = ts('2018-10-01');
const BACKTEST = !args.includes('--no-backtest');
// A test year needs a year of earlier snapshots with known outcomes to train
// on, and 90+ days of its own snapshots with known outcomes.
const MIN_TRAIN = 365 * DAY;
const MIN_TEST = 90 * DAY;
const F = VF.FEATURES.length;
const EVENTS = VF.EVENTS;
const UP = EVENTS.findIndex(e => e.key === 'up');
const DOWN = EVENTS.findIndex(e => e.key === 'down');
const EPS = 1e-9;

fs.mkdirSync(DATA, { recursive: true });
const logPath = path.join(DATA, 'forecast-train.log');
fs.writeFileSync(logPath, '');
const log = msg => {
  const text = `${new Date().toISOString()} ${msg}`;
  console.log(text);
  fs.appendFileSync(logPath, text + '\n');
};
const day = t => new Date(t * 1000).toISOString().slice(0, 10);

const { makeEdges, binAll, boost, predictRows } = createGBM({
  features: F, bins: BINS, depth: DEPTH, lr: LR, lambda: LAMBDA, minHess: MIN_HESS,
  rowSub: ROW_SUB, colSub: COL_SUB, maxRounds: ROUNDS, seed: 12345
});

// ---------- snapshots ----------
// Every STEP days per item: features, and the log value change after each
// horizon (null when the outcome is not known yet).
function buildSnapshots() {
  const dir = path.join(DATA, 'items');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const X = [], T = [], U = Object.fromEntries(VF.HORIZONS.map(h => [h, []]));
  const ends = [];
  let dataEnd = 0;
  for (const file of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!s.daily?.t?.length) continue;
    const fetched = typeof s.fetchedAt === 'number' ? (s.fetchedAt > 1e11 ? s.fetchedAt / 1000 : s.fetchedAt) : Date.parse(s.fetchedAt) / 1000;
    const end = Math.min(Number.isFinite(fetched) ? fetched : Infinity, s.daily.t.at(-1) + DAY);
    dataEnd = Math.max(dataEnd, end);
    ends.push(end);
    // Spread items over weekdays so snapshots are not all on one weekday.
    for (let t = SNAP_START + (Number(s.id) % STEP) * DAY; t <= end - DAY; t += STEP * DAY) {
      const x = VF.features(s, t);
      if (!x) continue;
      X.push(x); T.push(t);
      for (const h of VF.HORIZONS) U[h].push(t + h * DAY <= end ? VF.change(s, t, h) : null);
    }
  }
  // Model age is measured from the median item's data end.
  ends.sort((a, b) => a - b);
  const dataAt = ends.length ? ends[Math.floor(ends.length / 2)] : dataEnd;
  log(`items ${files.length}, snapshots ${X.length}, data end ${day(dataEnd)}, median item data ${new Date(dataAt * 1000).toISOString()}`);
  return { X, T, U, dataEnd, dataAt, items: files.length };
}

// ---------- helpers ----------
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function quantileOf(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const r3 = x => (Number.isFinite(x) ? round(x, 3) : null);
const r4 = x => (Number.isFinite(x) ? round(x, 4) : null);
// exp(mean |log error|) - 1: the typical miss as a fraction of the value.
const typical = errs => Math.exp(mean(errs)) - 1;
const inside = (v, lo, hi) => v >= lo - EPS && v <= hi + EPS;
// The page uses the item model for a horizon only where it beat the usual
// range in the backtest: better overall (ranked probability skill above 0)
// and an 80% range that held about as often (within 2 points). Elsewhere it
// shows the usual range for any item. Untested models are used as they are.
const useModel = bt => !bt || (bt.skill > 0 && bt.inside80 >= bt.usualInside80 - 0.02);

// What usually happened to any item (log changes): event rates, the
// up/same/down split, median and ranges, and the tail averages.
function usual(us) {
  const sorted = Float64Array.from(us).sort();
  const n = sorted.length;
  const rates = EVENTS.map(e => sorted.reduce((a, v) => a + (VF.hit(e, v) ? 1 : 0), 0) / n);
  const tail = e => mean(Array.from(sorted).filter(v => VF.hit(e, v)));
  return {
    n, rates, up: rates[UP], down: rates[DOWN], same: Math.max(0, 1 - rates[UP] - rates[DOWN]),
    low: quantileOf(sorted, 0.1), q25: quantileOf(sorted, 0.25), median: quantileOf(sorted, 0.5),
    q75: quantileOf(sorted, 0.75), high: quantileOf(sorted, 0.9),
    tails: [tail(EVENTS[0]), tail(EVENTS[EVENTS.length - 1])]
  };
}

// One scored test snapshot: what happened (v, log change) and the forecast.
function record(v, probs, base) {
  const dist = VF.distribution(probs, base.tails);
  // Ranked probability score over the cut points, and the same for the usual
  // rates (a forecast that ignores the item).
  let rps = 0, rpsUsual = 0;
  EVENTS.forEach((e, k) => {
    const below = (e.down ? VF.hit(e, v) : !VF.hit(e, v)) ? 1 : 0;
    const usualCdf = e.down ? base.rates[k] : 1 - base.rates[k];
    rps += (dist.cdf[k] - below) ** 2;
    rpsUsual += (usualCdf - below) ** 2;
  });
  return { v, s: VF.summarize(dist), rps: rps / EVENTS.length, rpsUsual: rpsUsual / EVENTS.length, base };
}

function metrics(recs) {
  const errs = recs.map(r => Math.abs(r.v - r.s.median));
  const errsSame = recs.map(r => Math.abs(r.v));
  const errsUsual = recs.map(r => Math.abs(r.v - r.base.median));
  const med = xs => Math.exp(quantileOf(Float64Array.from(xs).sort(), 0.5)) - 1;
  const rps = mean(recs.map(r => r.rps)), rpsUsual = mean(recs.map(r => r.rpsUsual));
  const calib = Array.from({ length: 10 }, (_, b) => ({ range: [b / 10, (b + 1) / 10], n: 0, predicted: 0, actual: 0 }));
  for (const r of recs) {
    const c = calib[Math.min(9, Math.floor(r.s.up * 10))];
    c.n++; c.predicted += r.s.up; c.actual += r.v > EPS ? 1 : 0;
  }
  return {
    n: recs.length,
    inside80: mean(recs.map(r => (inside(r.v, r.s.low, r.s.high) ? 1 : 0))),
    inside50: mean(recs.map(r => (inside(r.v, r.s.q25, r.s.q75) ? 1 : 0))),
    usualInside80: mean(recs.map(r => (inside(r.v, r.base.low, r.base.high) ? 1 : 0))),
    below80: mean(recs.map(r => (r.v < r.s.low - EPS ? 1 : 0))),
    above80: mean(recs.map(r => (r.v > r.s.high + EPS ? 1 : 0))),
    width80: Math.exp(mean(recs.map(r => r.s.high - r.s.low))),
    usualWidth80: Math.exp(mean(recs.map(r => r.base.high - r.base.low))),
    miss: typical(errs), missSame: typical(errsSame), missUsual: typical(errsUsual),
    medianMiss: med(errs), medianMissSame: med(errsSame), medianMissUsual: med(errsUsual),
    rps, rpsUsual, skill: 1 - rps / rpsUsual,
    aucUp: auc(recs.map(r => (r.v > EPS ? 1 : 0)), recs.map(r => r.s.up)),
    aucDown: auc(recs.map(r => (r.v < -EPS ? 1 : 0)), recs.map(r => r.s.down)),
    predicted: { up: mean(recs.map(r => r.s.up)), down: mean(recs.map(r => r.s.down)), median: Math.exp(mean(recs.map(r => r.s.median))) },
    actual: {
      up: mean(recs.map(r => (r.v > EPS ? 1 : 0))), down: mean(recs.map(r => (r.v < -EPS ? 1 : 0))),
      median: Math.exp(quantileOf(Float64Array.from(recs.map(r => r.v)).sort(), 0.5))
    },
    calib: calib.filter(c => c.n).map(c => ({ range: c.range, n: c.n, predicted: c.predicted / c.n, actual: c.actual / c.n }))
  };
}

const f1 = x => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '-');
const f3 = x => (Number.isFinite(x) ? x.toFixed(3) : '-');
const describe = m =>
  `n ${m.n} | inside 80% range ${f1(m.inside80)} (below ${f1(m.below80)}, above ${f1(m.above80)}; usual range ${f1(m.usualInside80)}) 50% ${f1(m.inside50)}` +
  ` | width x${m.width80.toFixed(2)} (usual x${m.usualWidth80.toFixed(2)}) | miss ${f1(m.miss)} vs no change ${f1(m.missSame)} vs usual ${f1(m.missUsual)}` +
  ` | skill ${f1(m.skill)} | auc up ${f3(m.aucUp)} down ${f3(m.aucDown)} | up ${f1(m.predicted.up)} predicted vs ${f1(m.actual.up)} real` +
  ` | median x${m.predicted.median.toFixed(3)} predicted vs x${m.actual.median.toFixed(3)} real`;

// ---------- main ----------
function main() {
  const started = Date.now();
  const snap = buildSnapshots();
  const { X, T, U } = snap;
  const all = X.map((_, i) => i);
  const settings = { step: STEP, depth: DEPTH, lr: LR, rounds: ROUNDS, minHess: MIN_HESS, rowSub: ROW_SUB, colSub: COL_SUB, bins: BINS, from: day(SNAP_START) };
  const out = {
    trainedAt: new Date().toISOString(), dataAt: new Date(snap.dataAt * 1000).toISOString(),
    features: VF.FEATURES, events: EVENTS.map(e => e.key), settings, horizons: {}
  };
  const report = { settings, items: snap.items, snapshots: X.length, dataEnd: day(snap.dataEnd), horizons: {} };
  const shipEdges = makeEdges(X, all);
  const shipCols = binAll(X, shipEdges);

  for (const h of VF.HORIZONS) {
    const H = h * DAY;
    const u = U[h];
    const labeled = all.filter(r => u[r] != null);
    const labels = EVENTS.map(e => Uint8Array.from(u, v => (v != null && VF.hit(e, v) ? 1 : 0)));
    const rep = report.horizons[h] = { labeled: labeled.length, folds: [] };
    let backtest = null;

    if (BACKTEST) {
      const pooled = [], folds = [];
      for (let year = 2019; ts(`${year}-01-01`) < snap.dataEnd; year++) {
        const T0 = ts(`${year}-01-01`);
        if (T0 - H - SNAP_START < MIN_TRAIN || snap.dataEnd - H - T0 < MIN_TEST) continue;
        const foldStarted = Date.now();
        const trainRows = labeled.filter(r => T[r] + H <= T0);
        const testRows = labeled.filter(r => T[r] >= T0 && T[r] < T0 + 365 * DAY);
        if (!trainRows.length || !testRows.length) continue;
        // Bins come from the training snapshots only.
        const edges = makeEdges(X, trainRows);
        const cols = binAll(X, edges);
        const base = usual(trainRows.map(r => u[r]));
        const probs = labels.map(y => predictRows(boost(cols, edges, y, trainRows, { rounds: ROUNDS }), cols, testRows));
        const recs = testRows.map((r, i) => record(u[r], probs.map(p => p[i]), base));
        for (const rec of recs) pooled.push(rec);
        const m = metrics(recs);
        folds.push({ year, m });
        rep.folds.push({ year, trainRows: trainRows.length, trainStartsUntil: day(T0 - H), testRows: testRows.length, ...m });
        log(`h${h} ${year} (train ${trainRows.length} starts until ${day(T0 - H)}, ${Math.round((Date.now() - foldStarted) / 1000)}s): ${describe(m)}`);
      }
      if (folds.length) {
        const m = metrics(pooled);
        const worst = folds.reduce((a, b) => (b.m.inside80 < a.m.inside80 ? b : a));
        rep.pooled = m;
        log(`h${h} ALL ${folds[0].year}-${folds[folds.length - 1].year}: ${describe(m)}`);
        // AUCs: average within each test year (how well items were ranked
        // against each other that year), not pooled across years.
        const yearly = key => mean(folds.map(f => f.m[key]).filter(Number.isFinite));
        const usualWorst = folds.reduce((a, b) => (b.m.usualInside80 < a.m.usualInside80 ? b : a));
        backtest = {
          years: [folds[0].year, folds[folds.length - 1].year], folds: folds.length, n: m.n,
          inside80: r3(m.inside80), inside50: r3(m.inside50), usualInside80: r3(m.usualInside80),
          worst80: { year: worst.year, value: r3(worst.m.inside80) },
          usualWorst80: { year: usualWorst.year, value: r3(usualWorst.m.usualInside80) },
          miss: r3(m.miss), missSame: r3(m.missSame), missUsual: r3(m.missUsual),
          skill: r3(m.skill), aucUp: r3(yearly('aucUp')), aucDown: r3(yearly('aucDown'))
        };
        rep.yearlyAuc = { up: yearly('aucUp'), down: yearly('aucDown') };
        log(`h${h} average within-year auc up ${f3(rep.yearlyAuc.up)} down ${f3(rep.yearlyAuc.down)}`);
      }
    }

    // Shipped models: same settings, every snapshot with a known outcome.
    const base = usual(labeled.map(r => u[r]));
    const gains = new Float64Array(F);
    const events = {};
    EVENTS.forEach((e, k) => {
      const m = boost(shipCols, shipEdges, labels[k], labeled, { rounds: ROUNDS });
      events[e.key] = { bias: round(m.bias, 6), trees: exportTrees(m.trees, shipEdges, { threshold: 6, leaf: 4 }) };
      m.gains.forEach((g, f) => { gains[f] += g; });
    });
    const totalGain = gains.reduce((a, b) => a + b, 0) || 1;
    rep.importance = Array.from(gains, (g, f) => [VF.FEATURES[f], round(g / totalGain, 3)]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    rep.usual = { n: base.n, up: base.up, down: base.down, same: base.same, low: Math.exp(base.low), q25: Math.exp(base.q25), median: Math.exp(base.median), q75: Math.exp(base.q75), high: Math.exp(base.high), tails: base.tails.map(Math.exp), rates: Object.fromEntries(EVENTS.map((e, k) => [e.key, base.rates[k]])) };
    const use = rep.use = useModel(backtest) ? 'model' : 'usual';
    // base: what happened to any item over the data (ratios are value after /
    // value before; mean is the average ratio). The event trees and tails
    // ship only where the page uses the item model.
    out.horizons[h] = {
      use,
      ...(use === 'model' ? { events, tails: base.tails.map(r4) } : {}),
      base: {
        n: base.n, up: r4(base.up), down: r4(base.down), same: r4(base.same), low: r4(Math.exp(base.low)), q25: r4(Math.exp(base.q25)),
        median: r4(Math.exp(base.median)), q75: r4(Math.exp(base.q75)), high: r4(Math.exp(base.high)), mean: r4(mean(labeled.map(r => Math.exp(u[r]))))
      },
      backtest
    };
    log(`h${h} shipped on ${labeled.length} snapshots; usual change x${Math.exp(base.median).toFixed(3)} (80%: x${Math.exp(base.low).toFixed(2)}..x${Math.exp(base.high).toFixed(2)}), up ${f1(base.up)} down ${f1(base.down)}; top features ` +
      rep.importance.slice(0, 6).map(([name, g]) => `${name} ${g}`).join(', '));
    log(`h${h} page uses ${use === 'model' ? 'the item model' : 'the usual range'}` + (backtest
      ? ` (item model skill ${f1(backtest.skill)}, its 80% range held ${f1(backtest.inside80)} vs usual range ${f1(backtest.usualInside80)})`
      : ' (not backtested)'));
  }

  const js = `/* Generated by tools/train-value-forecast.cjs on ${out.trainedAt}. Do not edit. */\n` +
    `globalThis.VALUE_FORECAST = ${JSON.stringify(out)};\n`;
  fs.writeFileSync(path.join(ROOT, 'src', 'value-forecast-data.js'), js);
  report.seconds = Math.round((Date.now() - started) / 1000);
  report.modelBytes = js.length;
  fs.writeFileSync(path.join(DATA, 'forecast-report.json'), JSON.stringify(report, null, 2));
  log(`done in ${report.seconds}s, model ${Math.round(js.length / 1024)} KB`);
}

try { main(); } catch (err) { log('ERROR ' + (err.stack || err)); process.exitCode = 1; }
