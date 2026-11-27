/* Gradient boosted trees shared by the trainers (tools/train-value-model.cjs
   and tools/train-value-forecast.cjs): quantile binning, binary logistic
   Newton boosting with a learned side for missing values, metrics, and the
   compact tree export the extension scores with ValueModel.scoreTrees.
   Seeded, so the same data, settings and call order give the same trees. */
'use strict';

const sigmoid = z => 1 / (1 + Math.exp(-z));

// Tree nodes: [feature, bin, left, right] (bin <= split goes left; a fifth
// entry 1 sends missing values right) or a leaf [score].
function scoreBinned(tree, cols, r) {
  let node = tree[0];
  while (node.length >= 4) {
    const b = cols[node[0]][r];
    node = tree[(b === 0 ? node[4] !== 1 : b <= node[1]) ? node[2] : node[3]];
  }
  return node[0];
}

function createGBM({
  features: F, bins: BINS = 63, depth: DEPTH = 3, lr: LR = 0.08, lambda: LAMBDA = 1, minHess: MIN_HESS = 20,
  rowSub: ROW_SUB = 0.7, colSub: COL_SUB = 0.8, maxRounds: MAX_ROUNDS = 500, patience: PATIENCE = 50, seed = 12345
} = {}) {
  if (!(F > 0)) throw new Error('createGBM needs the number of features');
  let state = seed;
  const rand = () => {
    state = (state + 0x6D2B79F5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

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
          // Missing values (bin 0) go to whichever side gains more.
          const g0 = hg[0], h0 = hh[0];
          let gl = 0, hl = 0;
          for (let b = 1; b < nb; b++) {
            gl += hg[b]; hl += hh[b];
            for (let missRight = 0; missRight < (h0 > 0 ? 2 : 1); missRight++) {
              const GL = missRight ? gl : gl + g0, HL = missRight ? hl : hl + h0;
              const GR = G - GL, HR = H - HL;
              if (HL < MIN_HESS || HR < MIN_HESS) continue;
              const gain = GL * GL / (HL + LAMBDA) + GR * GR / (HR + LAMBDA) - parent;
              if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, f, b, missRight };
            }
          }
        }
      }
      if (!best) { tree[idx] = [-G / (H + LAMBDA) * LR]; continue; }
      gainOut[best.f] += best.gain;
      const col = cols[best.f];
      const left = [], right = [];
      for (let i = 0; i < rs.length; i++) {
        const bin = col[rs[i]];
        ((bin === 0 ? !best.missRight : bin <= best.b) ? left : right).push(rs[i]);
      }
      const li = tree.length, ri = li + 1;
      tree.push(null, null);
      // A trailing 1 marks nodes that send missing values right.
      tree[idx] = best.missRight ? [best.f, best.b, li, ri, 1] : [best.f, best.b, li, ri];
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

  return { makeEdges, binAll, growTree, boost, predictRows };
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

// ---------- export ----------
const round = (x, digits) => Number(x.toPrecision(digits));
// Smallest number with `digits` significant digits that is >= x. Thresholds
// are rounded up so a value equal to the bin edge still goes left like in
// training (plain rounding can land just below the edge: log1p(3) to 7
// digits is 1.386294 < 1.38629436..., which would send vol30 = 3 right).
function roundUp(x, digits) {
  const t = round(x, digits);
  if (t >= x) return t;
  const up = round(t + 10 ** (Math.floor(Math.log10(Math.abs(x))) - digits + 1), digits);
  return up >= x ? up : x;
}
// Bins become real thresholds (the bin's upper edge) for scoring raw values.
function exportTrees(trees, edges, { threshold = 7, leaf = 5 } = {}) {
  return trees.map(tree => tree.map(node => node.length >= 4
    ? [node[0], roundUp(edges[node[0]][node[1] - 1], threshold), ...node.slice(2)]
    : [round(node[0], leaf)]));
}

module.exports = { createGBM, sigmoid, scoreBinned, logloss, auc, evaluate, topK, round, roundUp, exportTrees };
