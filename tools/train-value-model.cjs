#!/usr/bin/env node
/* Trains the Rolimon's value change model from data saved by
   tools/collect-rolimons.cjs and writes src/value-model-data.js.

   For each horizon (7, 14, 30 days) two gradient boosted tree models are
   trained: "value higher after N days" and "value lower after N days".

   Honest testing: models are tuned on data before TEST_START and scored on
   the months after it, which they never saw. A simple RAP rule is scored on
   the same months for comparison. The shipped model is then retrained on
   everything with the same settings.

   Usage: node tools/train-value-model.cjs [--step 7] [--depth 3] [--lr 0.08]
          [--rounds 500] [--valid 2025-11-01] [--test 2026-05-01] */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VM = require(path.join(ROOT, 'src', 'value-model.js'));
const { createGBM, logloss, auc, evaluate, topK, round, exportTrees } = require('./gbm.cjs');
const DATA = path.join(ROOT, 'tools', 'data');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const ts = s => Date.parse(s + 'T00:00:00Z') / 1000;
const DAY = VM.DAY;
const STEP = Number(opt('step', 7));
const DEPTH = Number(opt('depth', 3));
const LR = Number(opt('lr', 0.08));
const MAX_ROUNDS = Number(opt('rounds', 500));
const PATIENCE = 50;
const LAMBDA = 1;
const MIN_HESS = Number(opt('min-hess', 20));
const ROW_SUB = 0.7;
const COL_SUB = 0.8;
const BINS = 63;
const SNAP_START = ts('2018-10-01');
const RECENT_START = ts('2023-01-01');
const VALID_START = ts(opt('valid', '2025-11-01'));
const TEST_START = ts(opt('test', '2026-05-01'));
const F = VM.FEATURES.length;
const RAP30 = VM.FEATURES.indexOf('rap30');

const logPath = path.join(DATA, 'train.log');
fs.writeFileSync(logPath, '');
const log = msg => fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
const day = t => new Date(t * 1000).toISOString().slice(0, 10);

// Seeded boosting, shared with the forecast trainer (tools/gbm.cjs).
const { makeEdges, binAll, boost, predictRows } = createGBM({
  features: F, bins: BINS, depth: DEPTH, lr: LR, lambda: LAMBDA, minHess: MIN_HESS,
  rowSub: ROW_SUB, colSub: COL_SUB, maxRounds: MAX_ROUNDS, patience: PATIENCE, seed: 12345
});

// ---------- snapshots ----------
function buildSnapshots() {
  const dir = path.join(DATA, 'items');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const X = [], T = [], ID = [], Y = { 7: [], 14: [], 30: [] };
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
      const x = VM.features(s, t);
      if (!x) continue;
      X.push(x); T.push(t); ID.push(Number(s.id));
      for (const h of VM.HORIZONS) Y[h].push(t + h * DAY <= end ? VM.label(s, t, h) : null);
    }
  }
  // Model age is measured from the median item's data end, so a half-finished
  // refresh does not make an old model look new.
  ends.sort((a, b) => a - b);
  const dataAt = ends.length ? ends[Math.floor(ends.length / 2)] : dataEnd;
  const behind = ends.filter(e => e < dataAt - 7 * DAY).length;
  log(`items ${files.length}, snapshots ${X.length}, data end ${day(dataEnd)}, median item data ${new Date(dataAt * 1000).toISOString()}` +
    (behind ? `; ${behind} items are 7+ days older (run the collector with --refresh)` : ''));
  return { X, T, ID, Y, dataEnd, dataAt, items: files.length };
}

// Simple rules to beat: (1) recent RAP well above value means a raise, well
// below means a lower; (2) Rolimon's own trend tag (Raising / Lowering).
const TREND = VM.FEATURES.indexOf('trend');
const RULES = {
  rap: {
    score: (x, dir) => (Number.isNaN(x[RAP30]) ? -Infinity : dir === 'up' ? x[RAP30] : -x[RAP30]),
    flag: (x, dir) => !Number.isNaN(x[RAP30]) && (dir === 'up' ? x[RAP30] >= Math.log(1.2) : x[RAP30] <= Math.log(0.8))
  },
  trend: {
    score: (x, dir) => (x[TREND] === (dir === 'up' ? 3 : 0) ? 1 : 0),
    flag: (x, dir) => x[TREND] === (dir === 'up' ? 3 : 0)
  }
};
function scoreRule(rule, X, rows, ys, ps, dir) {
  const flags = rows.map(r => rule.flag(X[r], dir));
  const flagged = flags.filter(Boolean).length;
  const hits = ys.filter((y, i) => flags[i] && y).length;
  const positives = ys.reduce((a, b) => a + b, 0);
  return {
    flagged,
    precision: flagged ? hits / flagged : null,
    recall: positives ? hits / positives : null,
    auc: auc(ys, rows.map(r => rule.score(X[r], dir))),
    modelPrecisionSameCount: topK(ys, ps, flagged)
  };
}

// ---------- main ----------
function main() {
  const started = Date.now();
  const snap = buildSnapshots();
  const { X, T, Y } = snap;
  const all = X.map((_, i) => i);
  const earlyEdges = makeEdges(X, all.filter(r => T[r] < VALID_START));
  const earlyCols = binAll(X, earlyEdges);
  const fullEdges = makeEdges(X, all);
  const fullCols = binAll(X, fullEdges);
  const out = { horizons: {}, trainedAt: new Date().toISOString(), dataAt: new Date(snap.dataAt * 1000).toISOString(), testPeriod: [day(TEST_START), day(snap.dataEnd)], features: VM.FEATURES };
  const report = { settings: { STEP, DEPTH, LR, MAX_ROUNDS, MIN_HESS, ROW_SUB, COL_SUB, VALID_START: day(VALID_START), TEST_START: day(TEST_START) }, items: snap.items, snapshots: X.length, horizons: {} };

  for (const h of VM.HORIZONS) {
    const H = h * DAY;
    const labeled = all.filter(r => Y[h][r] != null);
    out.horizons[h] = { test: {} };
    report.horizons[h] = {};
    for (const dir of ['up', 'down']) {
      const want = dir === 'up' ? 1 : -1;
      const y = Uint8Array.from(Y[h], v => (v === want ? 1 : 0));
      const testRows = labeled.filter(r => T[r] >= TEST_START);
      const validRows = labeled.filter(r => T[r] >= VALID_START && T[r] + H <= TEST_START);
      // Pick the training start (all years vs recent years) on validation.
      const choices = [];
      for (const start of [SNAP_START, RECENT_START]) {
        const trainRows = labeled.filter(r => T[r] >= start && T[r] + H <= VALID_START);
        const m = boost(earlyCols, earlyEdges, y, trainRows, { validRows });
        const base = trainRows.reduce((a, r) => a + y[r], 0) / trainRows.length;
        const baseLl = validRows.reduce((a, r) => a + logloss(y[r], base), 0) / validRows.length;
        choices.push({ from: day(start), rounds: m.bestRounds, validLogloss: m.bestLoss, validBaseLogloss: baseLl, trainRows: trainRows.length });
        log(`h${h} ${dir} from ${day(start)}: rounds ${m.bestRounds}, valid loss ${m.bestLoss.toFixed(5)} (base ${baseLl.toFixed(5)})`);
      }
      const pick = choices.reduce((a, b) => (b.validLogloss < a.validLogloss ? b : a));
      const start = ts(pick.from);
      const rounds = Math.max(1, Math.round(pick.rounds * 1.15));

      // Honest test: train on everything before the test months.
      const preRows = labeled.filter(r => T[r] >= start && T[r] + H <= TEST_START);
      const testModel = boost(earlyCols, earlyEdges, y, preRows, { rounds });
      const ys = testRows.map(r => y[r]);
      const ps = predictRows(testModel, earlyCols, testRows);
      const metrics = evaluate(ys, ps);
      // Skill against the rate the model could have known (pre-test months),
      // not only against the test months' own rate.
      const preRate = preRows.reduce((a, r) => a + y[r], 0) / preRows.length;
      metrics.preRate = preRate;
      metrics.preLogloss = ys.reduce((a, v) => a + logloss(v, preRate), 0) / ys.length;
      metrics.skillVsPre = 1 - metrics.logloss / metrics.preLogloss;
      const rules = { rap: scoreRule(RULES.rap, X, testRows, ys, ps, dir), trend: scoreRule(RULES.trend, X, testRows, ys, ps, dir) };
      const f3 = v => (v == null || Number.isNaN(v) ? '-' : v.toFixed(3));
      log(`h${h} ${dir} TEST n ${metrics.n} base ${(metrics.baseRate * 100).toFixed(1)}% (pre ${(preRate * 100).toFixed(1)}%) auc ${f3(metrics.auc)} skill ${(metrics.skill * 100).toFixed(1)}% vsPre ${(metrics.skillVsPre * 100).toFixed(1)}% | model>=50% ${metrics.at50.flagged} prec ${f3(metrics.at50.precision)} | ` +
        Object.entries(rules).map(([k, r]) => `${k}: auc ${f3(r.auc)} flags ${r.flagged} prec ${f3(r.precision)} vs model ${f3(r.modelPrecisionSameCount)}`).join(' | '));

      // Shipped model: same settings, all labeled data.
      const shipRows = labeled.filter(r => T[r] >= start);
      const ship = boost(fullCols, fullEdges, y, shipRows, { rounds });
      const recent = labeled.filter(r => T[r] >= snap.dataEnd - 365 * DAY);
      const recentRate = recent.reduce((a, r) => a + y[r], 0) / recent.length;
      out.horizons[h][dir] = { bias: round(ship.bias, 6), trees: exportTrees(ship.trees, fullEdges), baseRate: round(recentRate, 4) };
      const pct = x => (x == null ? null : Math.round(x * 1000) / 10);
      out.horizons[h].test[dir] = {
        n: metrics.n, baseRate: pct(metrics.baseRate), auc: round(metrics.auc, 3),
        at30: { flagged: metrics.at30.flagged, precision: pct(metrics.at30.precision) },
        at50: { flagged: metrics.at50.flagged, precision: pct(metrics.at50.precision) }
      };
      const totalGain = ship.gains.reduce((a, b) => a + b, 0) || 1;
      const importance = [...ship.gains].map((g, f) => [VM.FEATURES[f], g]).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([name, g]) => [name, round(g / totalGain, 3)]);
      report.horizons[h][dir] = { choices, picked: pick.from, rounds, test: metrics, rules, ship: { rows: shipRows.length, trees: ship.trees.length, recentRate }, importance };
    }
  }

  const js = `/* Generated by tools/train-value-model.cjs on ${out.trainedAt}. Do not edit. */\n` +
    `globalThis.VALUE_MODEL = ${JSON.stringify(out)};\n`;
  fs.writeFileSync(path.join(ROOT, 'src', 'value-model-data.js'), js);
  report.seconds = Math.round((Date.now() - started) / 1000);
  report.modelBytes = js.length;
  fs.writeFileSync(path.join(DATA, 'model-report.json'), JSON.stringify(report, null, 2));
  log(`done in ${report.seconds}s, model ${Math.round(js.length / 1024)} KB`);
}

try { main(); } catch (err) { log('ERROR ' + (err.stack || err)); process.exitCode = 1; }
