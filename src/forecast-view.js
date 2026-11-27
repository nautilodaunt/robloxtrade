/* Pure helpers for the value forecast page (src/forecast.js): item search,
   labels and texts, number formatting, the past value / RAP lines and chart
   scales. No DOM, so tests can load it in Node. Uses ValueModel.stateAt. */
(function (root) {
  const VM = root.ValueModel || (typeof require === 'function' ? require('./value-model.js') : null);
  const DAY = 86400;
  const LABELS = { 30: '1 month', 90: '3 months', 180: '6 months', 365: '1 year', 730: '2 years' };
  const DEMAND = { 0: 'Terrible', 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Amazing' };
  const TREND = { 0: 'Lowering', 1: 'Unstable', 2: 'Stable', 3: 'Raising', 4: 'Fluctuating' };
  const label = days => LABELS[days] || `${days} days`;

  // Valued limiteds from the Rolimon's catalog, biggest value first.
  function items(catalog) {
    const out = [];
    for (const [id, x] of Object.entries(catalog || {})) {
      if (!/^\d+$/.test(id) || !x || !(x.value > 0)) continue;
      out.push({
        assetId: Number(id), name: String(x.name ?? id), acronym: x.acronym ? String(x.acronym) : '', value: x.value,
        rap: x.rap ?? null, demand: x.demand ?? null, trend: x.trend ?? null,
        projected: x.projected === true, hyped: x.hyped === true, rare: x.rare === true
      });
    }
    return out.sort((a, b) => b.value - a.value || a.assetId - b.assetId);
  }
  // A search suggestion; the trailing ID makes a picked suggestion exact.
  const optionText = x => `${x.name}${x.acronym ? ` (${x.acronym})` : ''} · #${x.assetId}`;

  // The item for what was typed or picked: a suggestion, an ID, an acronym or
  // a name (exact, then start, then anywhere; biggest value first). A bare ID
  // that is not in the list still counts, so the page works without the
  // catalog; the forecast then says whether it has a value.
  function find(list, text) {
    const q = String(text ?? '').trim();
    if (!q) return null;
    const tag = q.match(/#(\d{1,20})$/) || q.match(/^(\d{1,20})$/);
    if (tag) return list.find(x => x.assetId === Number(tag[1])) || { assetId: Number(tag[1]), name: `Item ${tag[1]}`, acronym: '' };
    const lower = q.toLowerCase();
    const name = x => x.name.toLowerCase();
    return list.find(x => x.acronym.toLowerCase() === lower) || list.find(x => name(x) === lower) ||
      list.find(x => name(x).startsWith(lower)) || list.find(x => name(x).includes(lower)) || null;
  }

  // Forecasts are estimates: 3 significant digits, with thousands separators.
  function money(n) {
    if (!Number.isFinite(n)) return '–';
    return (Math.abs(n) >= 1000 ? Number(n.toPrecision(3)) : Math.round(n)).toLocaleString('en-US');
  }
  // Axis labels: 950, 12K, 1.5M.
  function compact(n) {
    for (const [unit, size] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) if (n >= size) return `${Number((n / size).toPrecision(3))}${unit}`;
    return String(Math.round(n));
  }
  function change(ratio) {
    const p = Math.round((ratio - 1) * 100);
    return p === 0 ? '±0%' : `${p > 0 ? '+' : '−'}${Math.abs(p)}%`;
  }
  const pct = p => (!Number.isFinite(p) ? '–' : p > 0 && p < 0.01 ? '<1%' : p < 1 && p > 0.99 ? '>99%' : `${Math.round(p * 100)}%`);

  // Rolimon's value over [from, to] as steps [{ t, value }] from the change log.
  function valueSteps(series, from, to) {
    const changes = series?.changes || [];
    const start = Number(VM.stateAt(changes, 1, from, series?.value).value);
    const out = start > 0 ? [{ t: from, value: start }] : [];
    for (const c of changes) {
      if (c[1] !== 1 || c[0] < from || c[0] > to) continue;
      const v = Number(c[3]);
      if (v > 0) out.push({ t: c[0], value: v });
    }
    return out;
  }
  // Daily RAP over [from, to], about one point a week plus the latest day.
  function rapPoints(series, from, to) {
    const d = series?.daily || { t: [], rap: [] };
    const out = [];
    for (let i = 0; i < d.t.length; i++) {
      if (d.t[i] < from || d.t[i] > to || !(d.rap[i] > 0)) continue;
      const lastRow = i === d.t.length - 1;
      if (out.length && d.t[i] - out[out.length - 1].t < 7 * DAY && !lastRow) continue;
      out.push({ t: d.t[i], value: d.rap[i] });
    }
    return out;
  }
  // The forecast fan: today's value, then each horizon's range and source.
  function fan(forecast) {
    const v = forecast.value;
    const out = [{ t: forecast.at, days: 0, source: null, low: v, q25: v, median: v, q75: v, high: v }];
    for (const h of horizons(forecast)) {
      const x = forecast.horizons[h];
      out.push({ t: forecast.at + h * DAY, days: h, source: x.source || 'model', low: x.low, q25: x.q25, median: x.median, q75: x.q75, high: x.high });
    }
    return out;
  }
  const horizons = forecast => Object.keys(forecast?.horizons || {}).map(Number).sort((a, b) => a - b);
  // Summary boxes: the longest horizon from the item's own forecast, and 1
  // year (or the longest there is).
  function headlines(forecast) {
    const hs = horizons(forecast);
    const own = hs.filter(h => forecast.horizons[h].source !== 'usual');
    const out = own.length ? [own[own.length - 1]] : [];
    const long = hs.includes(365) ? 365 : hs[hs.length - 1];
    if (long != null && !out.includes(long)) out.push(long);
    return out;
  }
  const monthYear = t => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  // Why a horizon shows the usual range instead of the item's own forecast
  // (the trainer's rule: better overall and an 80% range that held as often).
  function whyUsual(b) {
    if (!b) return 'The item forecast was not tested for this span.';
    const why = [];
    if (!(b.skill > 0)) why.push(b.skill < -0.01 ? `scored ${pct(-b.skill)} worse overall` : 'scored no better overall');
    if (b.inside80 < b.usualInside80 - 0.02) why.push(`caught the real value in its likely range only ${pct(b.inside80)} of the time`);
    return `The item’s own forecast ${why.length ? why.join(' and ') : 'did no better'} in these tests, so the usual range is shown.`;
  }
  const years = b => (b.years[0] === b.years[1] ? String(b.years[0]) : `${b.years[0]}–${b.years[1]}`);
  const score = a => (Number.isFinite(a) ? a.toFixed(2) : '–');
  // One "How reliable is this?" line: the backtest of what the page shows.
  function reliability(h, f) {
    const b = f.backtest;
    const usual = f.source === 'usual';
    const head = `${label(h)} (${usual ? 'usual for any item' : 'this item’s forecast'})`;
    if (!b) return `${head}: not tested.`;
    const tested = `tested on ${years(b)}, ${b.n.toLocaleString('en-US')} past forecasts`;
    if (usual) {
      const worst = b.usualWorst80 ? ` (worst year ${b.usualWorst80.year}: ${pct(b.usualWorst80.value)})` : '';
      return `${head}, ${tested}: the likely range held ${pct(b.usualInside80)} of the time${worst}; the real value typically ended ${pct(b.missUsual)} away from the typical value (${pct(b.missSame)} away from the value at the time). ${whyUsual(b)}`;
    }
    return `${head}, ${tested}: the likely range held ${pct(b.inside80)} of the time (worst year ${b.worst80.year}: ${pct(b.worst80.value)}); the real value typically ended ${pct(b.miss)} away from the typical value (${pct(b.missSame)} away from the value at the time). ` +
      `Spotting raises ${score(b.aucUp)}, drops ${score(b.aucDown)} (0.5 = coin flip, 1 = perfect); ${b.skill > 0 ? `${pct(b.skill)} better` : 'no better'} than the usual odds for any item.`;
  }
  // The model line under the item picker.
  function modelNote(model, now = Date.now()) {
    if (!model?.horizons) return 'The forecast model is missing from this build: run node tools/train-value-forecast.cjs, then reload the extension.';
    const t = Date.parse(model.dataAt || model.trainedAt);
    if (!Number.isFinite(t)) return 'Each forecast starts from the item’s live Rolimon’s page.';
    const days = Math.max(0, Math.floor((now - t) / 864e5));
    const date = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const age = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
    return `Forecast model built from Rolimon’s history up to ${date} (${age})${days >= 90 ? '; retrain it soon with node tools/train-value-forecast.cjs' : ''}. Each forecast starts from the item’s live Rolimon’s page.`;
  }

  // Round numbers between lo and hi for a log axis (3 to 8 of them).
  function ticks(lo, hi) {
    const pick = steps => {
      const out = [];
      for (let k = Math.floor(Math.log10(lo)) - 1; k <= Math.ceil(Math.log10(hi)); k++) {
        for (const m of steps) { const v = Number((m * 10 ** k).toPrecision(6)); if (v >= lo && v <= hi) out.push(v); }
      }
      return out;
    };
    let out = pick([1, 2, 5]);
    if (out.length < 3) out = pick([1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9]);
    if (out.length < 3) out = pick([1, 1.2, 1.4, 1.6, 1.8, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9]);
    while (out.length > 8) out = out.filter((_, i) => i % 2 === 0);
    return out;
  }

  // Chart scales: time on x, log value on y. The y range covers the past
  // value and the forecast's 80% range, and the RAP line within reason (a
  // far-off RAP would squash the rest; it is clipped instead).
  function scales({ steps, rap = [], fan: points, now, width = 900, height = 320, pad = { l: 58, r: 18, t: 16, b: 30 }, pastDays = 730, futureDays = 730 }) {
    const t0 = now - pastDays * DAY, t1 = now + futureDays * DAY;
    const core = [...steps.map(p => p.value), ...points.flatMap(p => [p.low, p.high])].filter(v => v > 0);
    let lo = Math.min(...core), hi = Math.max(...core);
    const raps = rap.map(p => p.value).filter(v => v > 0);
    if (raps.length) { lo = Math.min(lo, Math.max(Math.min(...raps), lo / 2)); hi = Math.max(hi, Math.min(Math.max(...raps), hi * 2)); }
    if (!(lo > 0 && hi > 0)) { lo = 1; hi = 10; }
    if (hi / lo < 1.5) { const mid = Math.sqrt(lo * hi); lo = mid / 1.25; hi = mid * 1.25; }
    lo /= 1.08; hi *= 1.08;
    const x = t => pad.l + (t - t0) / (t1 - t0) * (width - pad.l - pad.r);
    const y = v => pad.t + (Math.log(hi) - Math.log(v)) / (Math.log(hi) - Math.log(lo)) * (height - pad.t - pad.b);
    return { t0, t1, lo, hi, x, y, ticks: ticks(lo, hi), width, height, pad };
  }

  root.ForecastView = {
    DAY, LABELS, DEMAND, TREND, label, items, optionText, find, money, compact, change, pct, valueSteps, rapPoints,
    fan, horizons, headlines, monthYear, whyUsual, reliability, modelNote, ticks, scales
  };
  if (typeof module !== 'undefined') module.exports = root.ForecastView;
})(globalThis);
