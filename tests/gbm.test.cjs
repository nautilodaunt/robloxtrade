const { test } = require('node:test');
const assert = require('node:assert/strict');
const VM = require('../src/value-model.js');
const { createGBM, round, roundUp, exportTrees, auc, sigmoid } = require('../tools/gbm.cjs');

test('thresholds round up, so a value on a bin edge still goes left', () => {
  const x = Math.log1p(3);
  assert.equal(round(x, 7), 1.386294);
  assert.ok(round(x, 7) < x, 'plain rounding lands below the edge');
  assert.equal(roundUp(x, 7), 1.386295);
  for (const v of [x, -x, 0, 5, 0.25, 0.1 + 0.2, 123456789, 1e-9 * Math.PI, -2.5e-7]) {
    const r = roundUp(v, 7);
    assert.ok(r >= v, `${v}`);
    assert.ok(r - v <= Math.abs(v) * 1e-6, `${v} within the 7th digit`);
    assert.equal(Number(r.toPrecision(7)), r);
  }
  assert.deepEqual([roundUp(5, 7), roundUp(0.25, 7), roundUp(-x, 7)], [5, 0.25, -1.386294]);
});

test('exported trees score raw values like the binned training trees', () => {
  // x0 takes few exact values (many sit on bin edges); x1 is sometimes missing.
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const X = [], y = [];
  for (let i = 0; i < 2000; i++) {
    const a = Math.log1p(Math.floor(rnd() * 12)), b = rnd() < 0.2 ? NaN : Math.round((rnd() * 2 - 1) * 1000) / 1000;
    X.push([a, b]);
    y.push(rnd() < sigmoid(2 * a - 2.5 + (Number.isNaN(b) ? 1 : b)) ? 1 : 0);
  }
  const gbm = createGBM({ features: 2, minHess: 5 });
  const rows = X.map((_, i) => i);
  const edges = gbm.makeEdges(X, rows);
  const cols = gbm.binAll(X, edges);
  const model = gbm.boost(cols, edges, y, rows, { rounds: 40 });
  assert.equal(model.trees.length, 40);
  const binned = gbm.predictRows(model, cols, rows);
  assert.ok(auc(y, binned) > 0.7);
  const raw = trees => rows.map(r => sigmoid(model.bias + VM.scoreTrees(trees, X[r])));
  const exported = raw(exportTrees(model.trees, edges));
  rows.forEach(r => assert.ok(Math.abs(exported[r] - binned[r]) < 1e-4, `row ${r}`));
  // Plain rounding would send some edge values the wrong way.
  const plain = raw(model.trees.map(tree => tree.map(node => (node.length >= 4 ? [node[0], round(edges[node[0]][node[1] - 1], 7), ...node.slice(2)] : [round(node[0], 5)]))));
  assert.ok(rows.some(r => Math.abs(plain[r] - binned[r]) > 1e-3));
});
