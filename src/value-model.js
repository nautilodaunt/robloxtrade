/* Rolimon's value change model: features and scoring.
   Shared by the trainer (tools/train-value-model.cjs), the service worker and
   tests, so training and live predictions compute features identically.
   The trained trees live in value-model-data.js (generated). */
(function (root) {
  const DAY = 86400;
  const HORIZONS = [7, 14, 30];
  const FEATURES = [
    'logValue', 'rapRatio', 'rap7', 'rap30', 'rap90', 'rapMom7', 'rapMom30',
    'rapAbove30', 'rapBelow30', 'bestRatio', 'bestMin7', 'sellers', 'sellersMom30', 'favMom30',
    'sale7', 'sale30', 'sale90', 'vol7', 'vol30', 'volTrend',
    'daysSinceValue', 'lastDir', 'lastPct', 'ups365', 'downs365',
    'demand', 'trend', 'daysSinceDemand', 'projected', 'hyped', 'ageYears'
  ];

  // Last index with arr[i] < t (arrays are sorted ascending), or -1.
  function before(arr, t) {
    let lo = 0, hi = arr.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }
  const ratio = (a, b) => (a > 0 && b > 0 ? Math.log(a / b) : NaN);
  const clip = (x, lo, hi) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : NaN);

  // State of a logged field (value, demand, ...) just before time t.
  function stateAt(changes, type, t, fallback) {
    let last = null, next = null;
    for (const c of changes) {
      if (c[1] !== type) continue;
      if (c[0] < t) last = c; else { next = c; break; }
    }
    if (last) return { value: last[3], since: last[0], change: last };
    if (next) return { value: next[2], since: null, change: null };
    return { value: fallback, since: null, change: null };
  }
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  // Features for a snapshot at time t, using only data from before t.
  // Daily rows are day starts, so a day counts once it has fully ended.
  function features(s, t) {
    const value = num(stateAt(s.changes, 1, t, s.value).value);
    if (!(value > 0)) return null;
    const d = s.daily;
    const last = before(d.t, t - DAY + 1);
    if (last < 0 || !(d.rap[last] > 0) || t - d.t[last] > 10 * DAY) return null;
    const window = (arr, days) => {
      const out = [];
      for (let i = last; i >= 0 && d.t[i] > d.t[last] - days * DAY; i--) if (arr[i] > 0) out.push(arr[i]);
      return out;
    };
    const ago = (arr, days) => {
      const i = before(d.t, d.t[last] - days * DAY + 1);
      for (let j = i; j >= 0 && j > i - 5; j--) if (arr[j] > 0) return arr[j];
      return null;
    };
    const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const rap = d.rap[last];
    const rap30 = window(d.rap, 30);
    const best7 = window(d.best, 7);
    const sales = s.sales;
    const saleWindow = days => {
      let vol = 0, sum = 0;
      for (let i = before(sales.t, t - DAY + 1); i >= 0 && sales.t[i] > t - DAY - days * DAY; i--) {
        vol += sales.volume[i] || 0;
        if (sales.price[i] > 0) sum += sales.price[i] * (sales.volume[i] || 1);
      }
      return { vol, price: vol ? sum / vol : NaN };
    };
    const s7 = saleWindow(7), s30 = saleWindow(30), s90 = saleWindow(90);
    const v = stateAt(s.changes, 1, t, s.value);
    const valueChanges = s.changes.filter(c => c[1] === 1 && c[0] < t && c[0] >= t - 365 * DAY && num(c[2]) > 0 && num(c[3]) > 0);
    const from = num(v.change?.[2]), to = num(v.change?.[3]);
    const demand = stateAt(s.changes, 2, t, s.demand);
    const trend = num(stateAt(s.changes, 3, t, s.trend).value);
    const firstDay = d.t[0];
    const sinceValue = v.since ?? Math.min(firstDay, s.changes[0]?.[0] ?? firstDay);
    const sinceDemand = demand.since ?? Math.min(firstDay, s.changes[0]?.[0] ?? firstDay);
    const f = {
      logValue: Math.log10(value),
      rapRatio: ratio(rap, value),
      rap7: ratio(mean(window(d.rap, 7)), value),
      rap30: ratio(mean(rap30), value),
      rap90: ratio(mean(window(d.rap, 90)), value),
      rapMom7: ratio(rap, ago(d.rap, 7)),
      rapMom30: ratio(rap, ago(d.rap, 30)),
      rapAbove30: rap30.length ? rap30.filter(x => x > value * 1.1).length / rap30.length : NaN,
      rapBelow30: rap30.length ? rap30.filter(x => x < value * 0.9).length / rap30.length : NaN,
      bestRatio: clip(ratio(d.best[last], value), -3, 3),
      bestMin7: clip(ratio(best7.length ? Math.min(...best7) : NaN, value), -3, 3),
      sellers: d.sellers[last] != null ? Math.log1p(d.sellers[last]) : NaN,
      sellersMom30: d.sellers[last] != null && ago(d.sellers, 30) != null ? Math.log((d.sellers[last] + 1) / (ago(d.sellers, 30) + 1)) : NaN,
      favMom30: ratio(d.fav[last], ago(d.fav, 30)),
      sale7: clip(ratio(s7.price, value), -3, 3),
      sale30: clip(ratio(s30.price, value), -3, 3),
      sale90: clip(ratio(s90.price, value), -3, 3),
      vol7: Math.log1p(s7.vol),
      vol30: Math.log1p(s30.vol),
      volTrend: Math.log((s7.vol * 30 / 7 + 1) / (s30.vol + 1)),
      daysSinceValue: Math.log1p(Math.max(0, (t - sinceValue) / DAY)),
      lastDir: from > 0 && to > 0 ? Math.sign(to - from) : 0,
      lastPct: from > 0 && to > 0 ? (to - from) / from : NaN,
      ups365: valueChanges.filter(c => num(c[3]) > num(c[2])).length,
      downs365: valueChanges.filter(c => num(c[3]) < num(c[2])).length,
      demand: num(demand.value) ?? NaN,
      trend: trend ?? NaN,
      daysSinceDemand: Math.log1p(Math.max(0, (t - sinceDemand) / DAY)),
      projected: stateAt(s.changes, 4, t, s.projected).value ? 1 : 0,
      hyped: stateAt(s.changes, 5, t, s.hyped).value ? 1 : 0,
      ageYears: s.created ? (t - s.created) / (365 * DAY) : NaN
    };
    return FEATURES.map(name => (Number.isFinite(f[name]) ? f[name] : NaN));
  }

  // Value at time t+h compared with time t: 1 raised, -1 lowered, 0 unchanged.
  function label(s, t, h) {
    const a = num(stateAt(s.changes, 1, t, s.value).value);
    const b = num(stateAt(s.changes, 1, t + h * DAY, s.value).value);
    if (!(a > 0) || !(b > 0)) return null;
    return b > a ? 1 : b < a ? -1 : 0;
  }

  // Trees: node [feature, threshold, left, right] (left when x <= threshold or
  // missing) or leaf [score].
  function scoreTrees(trees, x) {
    let sum = 0;
    for (const tree of trees) {
      let node = tree[0];
      while (node.length === 4) {
        const v = x[node[0]];
        node = tree[Number.isNaN(v) || v <= node[1] ? node[2] : node[3]];
      }
      sum += node[0];
    }
    return sum;
  }
  const sigmoid = z => 1 / (1 + Math.exp(-z));

  // Chance of a Rolimon's value raise / lower within each horizon, for a
  // valued item. Returns null when there is no model or not enough data.
  function predict(series, model = root.VALUE_MODEL, now = Date.now() / 1000) {
    if (!model?.horizons) return null;
    // Features at "now" use full days up to yesterday and every change so far.
    const x = features(series, now);
    if (!x) return null;
    const out = {};
    for (const h of HORIZONS) {
      const m = model.horizons[h];
      if (!m) continue;
      out[h] = {
        up: sigmoid(m.up.bias + scoreTrees(m.up.trees, x)),
        down: sigmoid(m.down.bias + scoreTrees(m.down.trees, x)),
        baseUp: m.up.baseRate, baseDown: m.down.baseRate,
        test: m.test
      };
    }
    return { horizons: out, trainedAt: model.trainedAt, dataAt: model.dataAt || model.trainedAt, testPeriod: model.testPeriod };
  }

  root.ValueModel = { DAY, HORIZONS, FEATURES, features, label, stateAt, scoreTrees, predict };
  if (typeof module !== 'undefined') module.exports = root.ValueModel;
})(globalThis);
