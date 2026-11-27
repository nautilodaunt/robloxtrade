/* Long-range Rolimon's value forecast: features, outcome events and the value
   distribution built from their odds. Shared by the trainer
   (tools/train-value-forecast.cjs), the forecast page and tests, so training
   and live forecasts compute everything the same way. The trained trees live
   in value-forecast-data.js (generated). Extends the short-term odds model's
   features (value-model.js, which must load first in a page). */
(function (root) {
  const VM = root.ValueModel || (typeof require === 'function' ? require('./value-model.js') : null);
  const DAY = 86400;
  const HORIZONS = [30, 90, 180, 365, 730];
  // One boosted tree model per event: the chance that the value after N days
  // is at most `ratio` x today's (down) or at least `ratio` x (up); ratio 1
  // means any lower / any higher. Ordered from the lowest outcome up.
  const EVENTS = [
    { key: 'd50', down: true, ratio: 0.5 },
    { key: 'd75', down: true, ratio: 0.75 },
    { key: 'd90', down: true, ratio: 0.9 },
    { key: 'down', down: true, ratio: 1 },
    { key: 'up', down: false, ratio: 1 },
    { key: 'u110', down: false, ratio: 1.1 },
    { key: 'u125', down: false, ratio: 1.25 },
    { key: 'u150', down: false, ratio: 1.5 },
    { key: 'u200', down: false, ratio: 2 },
    { key: 'u300', down: false, ratio: 3 }
  ];
  // Longer-run history on top of the short-term model's features.
  const EXTRA = [
    'valueMom90', 'valueMom365', 'fromPeak365', 'valueSwing730', 'valueChanges730',
    'rap180', 'rap365', 'rapMom90', 'rapMom365', 'sale365', 'vol365', 'sellersMom365', 'favMom365'
  ];
  const FEATURES = [...VM.FEATURES, ...EXTRA];
  const EPS = 1e-9;

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
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const valueAt = (s, t) => num(VM.stateAt(s.changes, 1, t, s.value).value);

  // Features for a snapshot at time t, using only data from before t (same
  // day rules as ValueModel.features). null when the item has no value or no
  // recent daily data.
  function features(s, t) {
    const base = VM.features(s, t);
    if (!base) return null;
    const value = valueAt(s, t);
    const d = s.daily;
    const last = before(d.t, t - DAY + 1);
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
    const sales = s.sales;
    let vol = 0, sum = 0;
    for (let i = before(sales.t, t - DAY + 1); i >= 0 && sales.t[i] > t - DAY - 365 * DAY; i--) {
      vol += sales.volume[i] || 0;
      if (sales.price[i] > 0) sum += sales.price[i] * (sales.volume[i] || 1);
    }
    // Value moves of the last 2 years and the highest value of the last year.
    let swing = 0, moves = 0, peak = Math.max(value, valueAt(s, t - 365 * DAY) || 0);
    for (const c of s.changes) {
      if (c[0] >= t) break;
      if (c[1] !== 1 || c[0] < t - 730 * DAY) continue;
      const from = num(c[2]), to = num(c[3]);
      if (!(from > 0 && to > 0)) continue;
      swing += Math.abs(Math.log(to / from));
      moves++;
      if (c[0] >= t - 365 * DAY) peak = Math.max(peak, to);
    }
    const sellers = d.sellers[last], sellersAgo = ago(d.sellers, 365);
    const f = {
      valueMom90: ratio(value, valueAt(s, t - 90 * DAY)),
      valueMom365: ratio(value, valueAt(s, t - 365 * DAY)),
      fromPeak365: ratio(value, peak),
      valueSwing730: swing,
      valueChanges730: moves,
      rap180: ratio(mean(window(d.rap, 180)), value),
      rap365: ratio(mean(window(d.rap, 365)), value),
      rapMom90: ratio(d.rap[last], ago(d.rap, 90)),
      rapMom365: ratio(d.rap[last], ago(d.rap, 365)),
      sale365: clip(ratio(vol ? sum / vol : NaN, value), -3, 3),
      vol365: Math.log1p(vol),
      sellersMom365: sellers != null && sellersAgo != null ? Math.log((sellers + 1) / (sellersAgo + 1)) : NaN,
      favMom365: ratio(d.fav[last], ago(d.fav, 365))
    };
    return base.concat(EXTRA.map(name => (Number.isFinite(f[name]) ? f[name] : NaN)));
  }

  // log(value h days after t / value at t), or null when either is unknown.
  function change(s, t, h) {
    const a = valueAt(s, t), b = valueAt(s, t + h * DAY);
    return a > 0 && b > 0 ? Math.log(b / a) : null;
  }

  // Did a log change u count as the event?
  function hit(event, u) {
    if (event.ratio === 1) return event.down ? u < -EPS : u > EPS;
    const cut = Math.log(event.ratio);
    return event.down ? u <= cut + EPS : u >= cut - EPS;
  }

  // Closest non-decreasing sequence (pool adjacent violators).
  function isotonic(ys) {
    const blocks = [];
    for (const y of ys) {
      blocks.push({ sum: y, n: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
        const b = blocks.pop();
        blocks[blocks.length - 1].sum += b.sum;
        blocks[blocks.length - 1].n += b.n;
      }
    }
    return blocks.flatMap(b => Array(b.n).fill(b.sum / b.n));
  }

  // Distribution of the log change from the event odds (in EVENTS order):
  // the cumulative chance at each cut point, made non-decreasing (separately
  // trained models can disagree a little), spread evenly between cut points,
  // a point mass at 0 for "unchanged", and open-ended tails whose averages
  // (tails = [low, high], from training) match what really happened.
  function distribution(probs, tails = []) {
    const cuts = EVENTS.map(e => Math.log(e.ratio));
    const F = isotonic(EVENTS.map((e, i) => {
      const p = Math.min(1, Math.max(0, Number(probs[i]) || 0));
      return e.down ? p : 1 - p;
    }));
    const first = cuts[0], end = cuts[cuts.length - 1];
    const low = Number.isFinite(tails[0]) ? tails[0] : first - 0.35;
    const high = Number.isFinite(tails[1]) ? tails[1] : end + 0.35;
    const segments = [{ lo: Math.min(first - 0.05, 2 * low - first), hi: first, mass: F[0] }];
    for (let i = 1; i < cuts.length; i++) segments.push({ lo: cuts[i - 1], hi: cuts[i], mass: Math.max(0, F[i] - F[i - 1]) });
    segments.push({ lo: end, hi: Math.max(end + 0.05, 2 * high - end), mass: Math.max(0, 1 - F[F.length - 1]) });
    const iDown = EVENTS.findIndex(e => e.key === 'down'), iUp = EVENTS.findIndex(e => e.key === 'up');
    // cdf[i]: chance of ending at or below cut i (below, for the up events).
    return { segments, cdf: F, down: F[iDown], up: 1 - F[iUp], same: Math.max(0, F[iUp] - F[iDown]) };
  }

  // Log change at cumulative chance p.
  function quantile(dist, p) {
    let c = 0;
    for (const s of dist.segments) {
      if (!(s.mass > 0)) continue;
      if (p <= c + s.mass) return s.hi === s.lo ? s.lo : s.lo + Math.min(1, Math.max(0, (p - c) / s.mass)) * (s.hi - s.lo);
      c += s.mass;
    }
    return dist.segments[dist.segments.length - 1].hi;
  }

  // Average of value later / value now.
  function meanRatio(dist) {
    let m = 0;
    for (const s of dist.segments) {
      if (!(s.mass > 0)) continue;
      m += s.mass * (s.hi === s.lo ? Math.exp(s.lo) : (Math.exp(s.hi) - Math.exp(s.lo)) / (s.hi - s.lo));
    }
    return m;
  }

  // Log changes: low/high = 10%/90% (the "likely range"), q25/q75, median.
  function summarize(dist) {
    const q = p => quantile(dist, p);
    return { low: q(0.1), q25: q(0.25), median: q(0.5), q75: q(0.75), high: q(0.9), mean: Math.log(meanRatio(dist)), up: dist.up, down: dist.down, same: dist.same };
  }

  const sigmoid = z => 1 / (1 + Math.exp(-z));
  function eventProbs(m, x) {
    return EVENTS.map(e => {
      const ev = m?.events?.[e.key];
      return ev ? sigmoid(ev.bias + VM.scoreTrees(ev.trees, x)) : NaN;
    });
  }

  // Forecast of a valued item's Rolimon's value for each horizon, from its
  // history (ItemInsights.normalizePage with at least 13 months of daily
  // rows). A horizon uses the item model (source 'model') where it beat the
  // usual range in the trainer's backtest, else what usually happened to any
  // item (source 'usual', the same ratios for every item). Item-model
  // horizons are skipped without recent daily data. null without a model or
  // a value.
  function forecast(series, model = root.VALUE_FORECAST, now = Date.now() / 1000) {
    if (!model?.horizons || (model.features && model.features.join() !== FEATURES.join())) return null;
    const value = valueAt(series, now);
    if (!(value > 0)) return null;
    let x;
    const horizons = {};
    for (const h of HORIZONS) {
      const m = model.horizons[h];
      if (!m) continue;
      let s;
      if (m.use === 'usual') {
        const b = m.base || {};
        if (![b.low, b.q25, b.median, b.q75, b.high].every(r => r > 0)) continue;
        s = {
          low: Math.log(b.low), q25: Math.log(b.q25), median: Math.log(b.median), q75: Math.log(b.q75), high: Math.log(b.high),
          mean: Math.log(b.mean > 0 ? b.mean : b.median), up: b.up, down: b.down, same: b.same
        };
      } else {
        if (x === undefined) x = features(series, now);
        if (!x) continue;
        const probs = eventProbs(m, x);
        if (!probs.every(Number.isFinite)) continue;
        s = summarize(distribution(probs, m.tails));
      }
      const at = u => Math.round(value * Math.exp(u));
      horizons[h] = {
        days: h, source: m.use === 'usual' ? 'usual' : 'model',
        low: at(s.low), q25: at(s.q25), median: at(s.median), q75: at(s.q75), high: at(s.high), mean: at(s.mean),
        up: s.up, down: s.down, same: s.same, base: m.base || null, backtest: m.backtest || null
      };
    }
    return { value, at: now, horizons, trainedAt: model.trainedAt || null, dataAt: model.dataAt || model.trainedAt || null };
  }

  root.ValueForecast = { DAY, HORIZONS, EVENTS, EXTRA, FEATURES, features, change, hit, isotonic, distribution, quantile, meanRatio, summarize, eventProbs, forecast };
  if (typeof module !== 'undefined') module.exports = root.ValueForecast;
})(globalThis);
