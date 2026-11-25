/* Limiteds browser: filter Rolimon's valued limiteds by value range and rank them by the
   value model's raise odds. Pure functions shared by the page and tests. */
(function (root) {
  const HORIZONS = [7, 14, 30];
  const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

  // "25000", "25,000", "25k", "1.5m" -> number; blank -> null.
  function parseAmount(text, label = 'Value') {
    const t = String(text ?? '').trim().toLowerCase().replace(/[,\s_]/g, '');
    if (!t) return null;
    const m = t.match(/^(\d{1,12}(?:\.\d{1,3})?)([km]?)$/);
    if (!m) throw new Error(`${label}: enter a number like 25000, 25k or 1.5m.`);
    return Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
  }

  // Valued limiteds only (Rolimon's value assigned), optionally within a value range.
  function filter(catalog, { min = null, max = null, minDemand = -1, projected = false, query = '' } = {}) {
    if (min != null && max != null && max < min) throw new Error('Max value must be at least the min value.');
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const [id, x] of Object.entries(catalog || {})) {
      if (!/^\d+$/.test(id) || !x || x.value == null || !(x.value > 0)) continue;
      if ((min != null && x.value < min) || (max != null && x.value > max)) continue;
      if (!projected && x.projected) continue;
      if (minDemand >= 0 && !(x.demand >= minDemand)) continue;
      if (q && !String(x.name).toLowerCase().includes(q) && String(x.acronym || '').toLowerCase() !== q) continue;
      out.push({ assetId: Number(id), name: String(x.name), acronym: x.acronym || '', value: x.value, rap: x.rap ?? null,
        demand: x.demand ?? null, trend: x.trend ?? null, projected: x.projected === true, hyped: x.hyped === true, rare: x.rare === true });
    }
    return out;
  }

  // Before the model has looked at an item, catalog hints decide what to scan first:
  // Raising trend, RAP above value, hype and demand up; Lowering trend down.
  function prior(x) {
    let s = 0;
    if (x.trend === 3) s += 3; else if (x.trend === 0) s -= 2; else if (x.trend === 1) s -= 0.5;
    if (x.rap != null && x.value > 0) { const gap = x.rap / x.value; if (gap >= 1.1) s += 2; else if (gap <= 0.85) s -= 1; }
    if (x.hyped) s += 1;
    if (x.projected) s -= 3;
    return s + (x.demand ?? 0) * 0.5;
  }
  const scanOrder = list => [...list].sort((a, b) => prior(b) - prior(a) || b.value - a.value || a.assetId - b.assetId);

  function oddsAt(insight, h) {
    const x = insight?.prediction?.horizons?.[h];
    return x && Number.isFinite(x.up) && Number.isFinite(x.down) ? x : null;
  }

  // Same thresholds as the hover panel's rise / fall highlighting.
  function signal(o) {
    if (!o) return 'none';
    const baseUp = o.baseUp || 0, baseDown = o.baseDown || 0;
    if (o.up >= 0.5 || (o.up >= 0.2 && o.up >= 2 * baseUp && o.up > o.down)) return 'likely-raise';
    if (o.down >= 0.5 || (o.down >= 0.2 && o.down >= 2 * baseDown)) return 'likely-lower';
    if (o.up >= 1.5 * baseUp && o.up > o.down && o.up >= 0.05) return 'possible-raise';
    return 'neutral';
  }

  const SORTS = ['up', 'lift', 'edge', 'safe', 'value', 'value-asc'];
  // Items with model odds always rank above unscanned ones for the odds-based sorts.
  function rank(list, insights = {}, { horizon = 30, sort = 'up' } = {}) {
    if (!HORIZONS.includes(horizon)) throw new Error('Choose a 7, 14 or 30 day horizon.');
    if (!SORTS.includes(sort)) throw new Error('Unknown sort.');
    const rows = list.map(x => {
      const insight = own(insights, String(x.assetId)) || null, odds = oddsAt(insight, horizon);
      return { ...x, insight, odds, scanned: !!insight, signal: signal(odds), prior: prior(x),
        lift: odds && odds.baseUp > 0 ? odds.up / odds.baseUp : null, edge: odds ? odds.up - odds.down : null };
    });
    const byOdds = key => (a, b) => (b.odds ? 1 : 0) - (a.odds ? 1 : 0) || (a.odds && b.odds ? key(b) - key(a) : b.prior - a.prior) || b.value - a.value;
    const sorters = {
      up: byOdds(r => r.odds.up),
      lift: byOdds(r => r.lift ?? 0),
      edge: byOdds(r => r.edge),
      safe: byOdds(r => -r.odds.down),
      value: (a, b) => b.value - a.value || a.assetId - b.assetId,
      'value-asc': (a, b) => a.value - b.value || a.assetId - b.assetId
    };
    return rows.sort(sorters[sort]);
  }

  root.LimitedsRank = { HORIZONS, SORTS, parseAmount, filter, prior, scanOrder, oddsAt, signal, rank };
  if (typeof module !== 'undefined') module.exports = root.LimitedsRank;
})(globalThis);
