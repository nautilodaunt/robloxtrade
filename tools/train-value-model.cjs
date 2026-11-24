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

let seed = 12345;
const rand = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

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

// ---------- binning ----------
function makeEdges(X, rows) {
  const edges = [];
  for (let f = 0; f < F; f++) {
    const vals = [];
    for (const r of rows) if (!Number.isNaN(X[r][f])) vals.push(X[r][f]);
    vals.sort((a, b) => a - b);
    const e = [];
    for (let q = 1; q <= BINS; q++) {
      const v = vals[Math.min(vals.length - 1, Math.floor(q * vals.length / (BINS + 1)))];
      if (v !== undefined && (e.length === 0 || v > e[e.length - 1])) e.push(v);
    }
    edges.push(e);
  }
  return edges;
}
// bin 0 = missing, else 1 + first index with edge >= x, so x <= edges[b-1]
// exactly when bin <= b.
function binAll(X, edges) {
  const cols = edges.map(() => new Uint8Array(X.length));
  for (let f = 0; f < F; f++) {
    const e = edges[f], col = cols[f];
    for (let r = 0; r < X.length; r++) {
      const x = X[r][f];
      if (Number.isNaN(x)) continue;
      let lo = 0, hi = e.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (e[mid] >= x) hi = mid; else lo = mid + 1; }
      col[r] = lo + 1;
    }
  }
  return cols;
}

// ---------- gradient boosting ----------
const sigmoid = z => 1 / (1 + Math.exp(-z));
function scoreBinned(tree, cols, r) {
  let node = tree[0];
  while (node.length === 4) node = tree[cols[node[0]][r] <= node[1] ? node[2] : node[3]];
  return node[0];
}

function growTree(cols, edges, grad, hess, rows, gainOut) {
  const tree = [null];
  const feats = [];
  for (let f = 0; f < F; f++) if (rand() < COL_SUB) feats.push(f);
  const hg = new Float64Array(BINS + 2), hh = new Float64Array(BINS + 2);
  const stack = [{ rows, depth: 0, idx: 0 }];
  while (stack.length) {
    const { rows: rs, depth, idx } = stack.pop();
    let G = 0, H = 0;
    for (let i = 0; i < rs.length; i++) { G += grad[rs[i]]; H += hess[rs[i]]; }
    let best = null;
    if (depth < DEPTH && H >= 2 * MIN_HESS) {
      const parent = G * G / (H + LAMBDA);
      for (const f of feats) {
        const nb = edges[f].length + 1;
        if (nb < 2) continue;
        hg.fill(0); hh.fill(0);
        const col = cols[f];
        for (let i = 0; i < rs.length; i++) { const r = rs[i], b = col[r]; hg[b] += grad[r]; hh[b] += hess[r]; }
        let gl = 0, hl = 0;
        for (let b = 0; b < nb; b++) {
          gl += hg[b]; hl += hh[b];
          if (b === 0) continue;
          const gr = G - gl, hr = H - hl;
          if (hl < MIN_HESS || hr < MIN_HESS) continue;
          const gain = gl * gl / (hl + LAMBDA) + gr * gr / (hr + LAMBDA) - parent;
          if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, f, b };
        }
      }
    }
    if (!best) { tree[idx] = [-G / (H + LAMBDA) * LR]; continue; }
    gainOut[best.f] += best.gain;
    const col = cols[best.f];
    const left = [], right = [];
    for (let i = 0; i < rs.length; i++) (col[rs[i]] <= best.b ? left : right).push(rs[i]);
    const li = tree.length, ri = li + 1;
    tree.push(null, null);
    tree[idx] = [best.f, best.b, li, ri];
    stack.push({ rows: Int32Array.from(left), depth: depth + 1, idx: li });
    stack.push({ rows: Int32Array.from(right), depth: depth + 1, idx: ri });
  }
  return tree;
}

// Binary logistic boosting. With validRows it stops early on validation
// log loss; otherwise it trains exactly `rounds` trees.
function boost(cols, edges, y, trainRows, { validRows = null, rounds = MAX_ROUNDS } = {}) {
  let pos = 0;
  for (const r of trainRows) pos += y[r];
  const base = Math.min(0.999, Math.max(0.001, pos / trainRows.length));
  const bias = Math.log(base / (1 - base));
  const n = y.length;
  const score = new Float64Array(n).fill(bias);
  const grad = new Float64Array(n), hess = new Float64Array(n);
  const gains = new Float64Array(F);
  const trees = [];
  let bestLoss = Infinity, bestRounds = 0;
  for (let k = 0; k < rounds; k++) {
    for (const r of trainRows) {
      const p = sigmoid(score[r]);
      grad[r] = p - y[r];
      hess[r] = Math.max(p * (1 - p), 1e-6);
    }
    const sample = trainRows.filter(() => rand() < ROW_SUB);
    const tree = growTree(cols, edges, grad, hess, sample, gains);
    trees.push(tree);
    for (const r of trainRows) score[r] += scoreBinned(tree, cols, r);
    if (validRows) {
      let loss = 0;
      for (const r of validRows) {
        score[r] += scoreBinned(tree, cols, r);
        loss += logloss(y[r], sigmoid(score[r]));
      }
      loss /= validRows.length;
      if (loss < bestLoss - 1e-7) { bestLoss = loss; bestRounds = k + 1; }
      else if (k + 1 - bestRounds >= PATIENCE) break;
    }
  }
  if (validRows) trees.length = Math.max(1, bestRounds);
  return { bias, base, trees, bestLoss, bestRounds: validRows ? Math.max(1, bestRounds) : rounds, gains };
}

function predictRows(model, cols, rows) {
  return rows.map(r => {
    let z = model.bias;
    for (const tree of model.trees) z += scoreBinned(tree, cols, r);
    return sigmoid(z);
  });
}

// ---------- metrics ----------
function logloss(y, p) {
  p = Math.min(1 - 1e-12, Math.max(1e-12, p));
  return -(y ? Math.log(p) : Math.log(1 - p));
}
function auc(ys, ps) {
  const idx = ys.map((_, i) => i).sort((a, b) => ps[a] - ps[b]);
  let rankSum = 0, pos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && ps[idx[j + 1]] === ps[idx[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (ys[idx[k]]) { rankSum += rank; pos++; }
    i = j + 1;
  }
  const neg = ys.length - pos;
  return pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : NaN;
}
function evaluate(ys, ps) {
  const n = ys.length;
  const base = ys.reduce((a, b) => a + b, 0) / n;
  const ll = ys.reduce((a, y, i) => a + logloss(y, ps[i]), 0) / n;
  const baseLl = ys.reduce((a, y) => a + logloss(y, base), 0) / n;
  const at = th => {
    let flagged = 0, hit = 0;
    ys.forEach((y, i) => { if (ps[i] >= th) { flagged++; hit += y; } });
    return { threshold: th, flagged, precision: flagged ? hit / flagged : null, recall: base ? hit / (base * n) : null };
  };
  const buckets = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 1.01];
  const calib = [];
  for (let b = 0; b + 1 < buckets.length; b++) {
    let c = 0, sp = 0, sy = 0;
    ys.forEach((y, i) => { if (ps[i] >= buckets[b] && ps[i] < buckets[b + 1]) { c++; sp += ps[i]; sy += y; } });
    if (c) calib.push({ range: [buckets[b], Math.min(1, buckets[b + 1])], n: c, predicted: sp / c, actual: sy / c });
  }
  return {
    n, baseRate: base, logloss: ll, baseLogloss: baseLl,
    skill: baseLl ? 1 - ll / baseLl : 0,
    auc: auc(ys, ps),
    brier: ys.reduce((a, y, i) => a + (ps[i] - y) ** 2, 0) / n,
    at30: at(0.3), at50: at(0.5), calib
  };
}
// Precision of the model's top k picks.
function topK(ys, ps, k) {
  if (!k) return null;
  const idx = ys.map((_, i) => i).sort((a, b) => ps[b] - ps[a]).slice(0, k);
  return idx.reduce((a, i) => a + ys[i], 0) / k;
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

// ---------- export ----------
const round = (x, digits) => Number(x.toPrecision(digits));
function exportTrees(trees, edges) {
  return trees.map(tree => tree.map(node => node.length === 4
    ? [node[0], round(edges[node[0]][node[1] - 1], 7), node[2], node[3]]
    : [round(node[0], 5)]));
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
