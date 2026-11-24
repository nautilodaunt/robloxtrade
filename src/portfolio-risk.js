/* Portfolio risk scoring, "should I do anything?" advice and what-if trades.
   Pure functions shared by the service worker (history snapshots), the
   portfolio page and tests. Inputs:
   - copies: Roblox tradable copies [{ instanceId, assetId, name, serialNumber, isOnHold }]
   - catalog: TradeValues.parseItems() output, keyed by asset ID
   - insights: { [assetId]: compact item insight with optional model prediction } */
(function (root) {
  // Rolimon's trend codes: 0 Lowering, 1 Unstable, 2 Stable, 3 Raising, 4 Fluctuating.
  const TREND_DROP = { 0: 22, 1: 12, 2: 4, 3: 0, 4: 10 };
  // Illiquidity points by 0–5 demand score (0 = none assigned or RAP-only, 5 = Amazing).
  const ILLIQUID = [25, 25, 18, 10, 4, 0];
  const INSIGHT_TTL_MS = 6 * 3600e3;
  const MAX_SIDE = 4;

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
  const sum = (list, fn) => list.reduce((a, x) => a + fn(x), 0);
  const pct = p => `${p > 0 && p < 0.01 ? '<1' : Math.round(p * 100)}%`;
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const demandScore = item => (item?.value == null || item.demand == null ? 0 : item.demand + 1);
  const worth = item => item?.value ?? item?.rap ?? 0;
  const label = h => (h.acronym ? `${h.name} (${h.acronym})` : h.name);
  const levelOf = score => (score >= 65 ? 'High' : score >= 35 ? 'Moderate' : 'Low');

  // One row per item, with copies grouped (serials, hold status, instance IDs).
  function holdings(copies, catalog) {
    const map = new Map();
    for (const c of copies || []) {
      const id = String(c.assetId);
      let h = map.get(id);
      if (!h) {
        const item = own(catalog, id) || null;
        h = {
          assetId: Number(id), name: item?.name || String(c.name || id), acronym: item?.acronym || '', known: !!item,
          value: item?.value ?? null, rap: item?.rap ?? null, unit: worth(item), valued: item?.value != null,
          demand: item?.demand ?? null, demandScore: demandScore(item), trend: item?.trend ?? null,
          projected: item?.projected === true, hyped: item?.hyped === true, rare: item?.rare === true,
          copies: 0, onHold: 0, tradable: 0, total: 0, serials: [], instanceIds: [], tradableInstanceIds: []
        };
        map.set(id, h);
      }
      h.copies++; h.total += h.unit; h.instanceIds.push(c.instanceId);
      if (c.isOnHold) h.onHold++; else { h.tradable++; h.tradableInstanceIds.push(c.instanceId); }
      if (Number.isSafeInteger(c.serialNumber)) h.serials.push(c.serialNumber);
    }
    return [...map.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  // Model odds summary: drop uses the worse of 14D/30D, raise uses 30D.
  function odds(insight) {
    const hz = insight?.prediction?.horizons;
    if (!hz) return null;
    const h30 = hz[30] || hz[14] || hz[7], h14 = hz[14] || h30;
    if (!h30 || !Number.isFinite(h30.up) || !Number.isFinite(h30.down)) return null;
    return {
      down: Math.max(h14.down, h30.down), up30: h30.up, down30: h30.down,
      baseUp: Number.isFinite(h30.baseUp) ? h30.baseUp : 0, baseDown: Number.isFinite(h30.baseDown) ? h30.baseDown : 0,
      horizons: hz
    };
  }

  function itemRisk(h, insight) {
    const signals = [];
    const o = h.valued ? odds(insight) : null;
    const gap = h.valued && h.rap > 0 && h.value > 0 ? h.rap / h.value : null;
    let drop;
    if (o) {
      drop = o.down * 110;
      if (o.down >= 0.15 && o.down / Math.max(o.baseDown, 0.01) >= 2.5) drop += 8;
      if (o.up30 >= 0.35 && o.up30 > 2 * o.down) drop -= 8;
      if (o.down >= 0.15) signals.push(`${pct(o.down)} model odds of a value lower (usually ${pct(o.baseDown)})`);
      if (o.up30 >= 0.15) signals.push(`${pct(o.up30)} model odds of a value raise within 30 days (usually ${pct(o.baseUp)})`);
    } else {
      drop = h.valued ? TREND_DROP[h.trend] ?? 8 : 15;
      if (gap != null) drop += gap <= 0.82 ? 18 : gap <= 0.92 ? 9 : gap >= 1.12 ? -5 : 0;
      if (h.hyped) drop += 6;
    }
    if (h.trend === 0) signals.push('Rolimon’s trend: Lowering');
    else if (h.trend === 1) signals.push('Rolimon’s trend: Unstable');
    else if (h.trend === 3) signals.push('Rolimon’s trend: Raising');
    if (gap != null && gap <= 0.92) signals.push(`RAP is ${pct(1 - gap)} under value`);
    if (gap != null && gap >= 1.12) signals.push(`RAP is ${pct(gap - 1)} over value`);
    if (h.hyped) signals.push('Marked hyped on Rolimon’s');
    if (!h.known) signals.push('Not listed on Rolimon’s: no value data');
    else if (!h.valued) signals.push('RAP-only (no Rolimon’s value): price can swing');
    drop = clamp(Math.round(drop), 0, 55);
    const illiquid = ILLIQUID[h.demandScore] ?? 25;
    let score = drop + illiquid, dropRisk = drop / 55 * 100;
    if (h.projected) {
      score = Math.max(score + 35, h.valued ? 75 : 85);
      dropRisk = h.valued ? 90 : 100;
      signals.unshift('Marked projected on Rolimon’s (inflated RAP)');
    }
    const dropSignal = h.projected || (o
      ? o.down >= 0.35 || (o.down >= 0.2 && o.down >= 2.5 * o.baseDown)
      : h.valued && h.trend === 0 && gap != null && gap <= 0.82);
    const raiseSignal = !h.projected && (o
      ? o.up30 >= 0.35 || (o.up30 >= 0.2 && o.up30 >= 2 * o.baseUp && o.up30 > o.down)
      : h.valued && (h.trend === 3 || h.hyped) && gap != null && gap >= 1.12);
    return {
      score: clamp(Math.round(score), 0, 100), drop, illiquid, dropRisk: Math.round(dropRisk),
      outlook: dropSignal ? 'drop' : raiseSignal ? 'raise' : 'stable',
      signals, odds: o, source: o ? 'model' : 'catalog', rapGap: gap
    };
  }

  function analyze(copies, catalog, insights = {}) {
    const list = holdings(copies, catalog).map(h => ({ ...h, risk: itemRisk(h, own(insights, String(h.assetId))) }));
    const total = sum(list, h => h.total);
    for (const h of list) h.weight = total > 0 ? h.total / total : 0;
    const held = sum(list, h => h.unit * h.onHold);
    const totals = {
      value: total, rap: sum(list, h => (h.rap ?? 0) * h.copies), valued: sum(list, h => (h.value ?? 0) * h.copies),
      held, tradable: total - held, copies: sum(list, h => h.copies), unique: list.length,
      unknown: list.filter(h => !h.known).length
    };
    const w = fn => sum(list, h => h.weight * fn(h));
    const hhi = w(h => h.weight), top1 = list[0]?.weight ?? 0, top3 = sum(list.slice(0, 3), h => h.weight);
    const concentration = total > 0 ? Math.max(100 * clamp((hhi - 0.08) / 0.52, 0, 1), 100 * clamp((top1 - 0.25) / 0.6, 0, 1)) : 0;
    const heldDrop = total > 0 ? sum(list.filter(h => h.risk.outlook === 'drop'), h => h.unit * h.onHold) / total : 0;
    const hold = total > 0 ? clamp(held / total * 60 + heldDrop * 150, 0, 100) : 0;
    const meters = {
      drop: Math.round(w(h => h.risk.dropRisk)),
      concentration: Math.round(concentration),
      liquidity: Math.round(w(h => h.risk.illiquid / 25 * 100)),
      hold: Math.round(hold)
    };
    const outlook = { raise: 0, stable: 0, drop: 0 };
    for (const h of list) outlook[h.risk.outlook] += h.weight;
    let score = 0.65 * w(h => h.risk.score) + 0.25 * concentration + 0.10 * hold;
    if (outlook.drop > 0.3) score = Math.max(score, 60);
    score = total > 0 ? clamp(Math.round(score), 0, 100) : 0;
    const drivers = [
      { key: 'drop', label: 'Value-drop & projected exposure', points: 0.65 * w(h => h.risk.score - h.risk.illiquid) },
      { key: 'liquidity', label: 'Low demand / hard to trade', points: 0.65 * w(h => h.risk.illiquid) },
      { key: 'concentration', label: 'Concentration in few items', points: 0.25 * concentration },
      { key: 'hold', label: 'Value locked on trade hold', points: 0.10 * hold }
    ].map(d => ({ ...d, points: Math.round(d.points * 10) / 10 })).sort((a, b) => b.points - a.points);
    const valued = list.filter(h => h.valued), modeled = valued.filter(h => h.risk.source === 'model');
    const valuedTotal = sum(valued, h => h.total);
    const coverage = {
      items: modeled.length, of: valued.length,
      share: valuedTotal > 0 ? sum(modeled, h => h.total) / valuedTotal : 0
    };
    const risk = {
      score, level: total > 0 ? levelOf(score) : 'None', meters, drivers, hhi, top1, top3,
      effectiveN: hhi > 0 ? 1 / hhi : 0, avgDemand: total > 0 ? w(h => h.demandScore) : null
    };
    const result = { holdings: list, totals, risk, outlook, coverage };
    result.actions = advise(result);
    result.verdict = verdictOf(result.actions, total);
    return result;
  }

  // Prioritized actions. Priority 1 is most urgent; 0 is the all-clear card.
  function advise({ holdings: list, totals, risk, coverage }) {
    const actions = [];
    if (!totals.value) return actions;
    for (const h of list) {
      if (h.risk.outlook !== 'drop' || h.total <= 0) continue;
      const why = h.risk.signals.slice(0, 3).join('; ');
      const share = `${pct(h.weight)} of the portfolio (${fmt(h.total)})`;
      if (h.tradable > 0) {
        actions.push({ kind: 'exit', level: 'red', priority: 1, assetId: h.assetId, weight: h.weight, instanceIds: [...h.tradableInstanceIds],
          title: `Trade away ${label(h)} soon`,
          detail: `${why}. ${share}${h.onHold ? `; ${h.onHold} more cop${h.onHold === 1 ? 'y is' : 'ies are'} on hold` : ''}.` });
      } else {
        actions.push({ kind: 'held-risk', level: 'orange', priority: 2, assetId: h.assetId, weight: h.weight, instanceIds: [],
          title: `${label(h)} is at risk but on trade hold`,
          detail: `${why}. It can’t be traded yet, so don’t spend time looking for swaps; check again when the hold ends. ${share}.` });
      }
    }
    const top = list[0];
    const stacked = list.find(h => h.copies >= 3 && h.weight > 0.35);
    if (top && top.weight > 0.5 && (top.demandScore < 4 || ![2, 3].includes(top.trend))) {
      actions.push({ kind: 'concentration', level: 'yellow', priority: 3, assetId: top.assetId, weight: top.weight, instanceIds: [],
        title: `Spread risk: ${label(top)} is ${pct(top.weight)} of the portfolio`,
        detail: `A 15% value cut on it would lower the total by ${fmt(top.total * 0.15)} (${pct(top.weight * 0.15)}). Consider downgrading it into 2–3 solid Normal+ demand items.` });
    } else if (stacked) {
      actions.push({ kind: 'concentration', level: 'yellow', priority: 3, assetId: stacked.assetId, weight: stacked.weight, instanceIds: [],
        title: `Spread risk: ${stacked.copies} copies of ${label(stacked)} are ${pct(stacked.weight)} of the portfolio`,
        detail: `One value change hits every copy at once. A 15% cut would lower the total by ${fmt(stacked.total * 0.15)}. Consider trading one or two copies for different items.` });
    }
    const weak = list.filter(h => h.tradable > 0 && h.demandScore <= 2 && !h.projected && h.unit > 0 && h.risk.outlook !== 'drop');
    const weakCopies = sum(weak, h => h.tradable), weakValue = sum(weak, h => h.unit * h.tradable);
    if (weakCopies >= 4 && weakValue / totals.value < 0.25) {
      const names = weak.slice(0, 5).map(label).join(', ') + (weak.length > 5 ? ', …' : '');
      actions.push({ kind: 'clutter', level: 'yellow', priority: 4, weight: weakValue / totals.value,
        instanceIds: weak.flatMap(h => h.tradableInstanceIds),
        title: `Upgrade ${weakCopies} low-demand / RAP-only items`,
        detail: `${names}: together ${fmt(weakValue)} (${pct(weakValue / totals.value)}). Bundling 3–4 into one Normal+ demand item makes the portfolio easier to trade.` });
    }
    for (const h of list) {
      if (h.risk.outlook !== 'raise' || h.total <= 0) continue;
      actions.push({ kind: 'hold', level: 'green', priority: 5, assetId: h.assetId, weight: h.weight, instanceIds: [...h.tradableInstanceIds],
        title: `Hold ${label(h)} (only take strong overpays)`,
        detail: `${h.risk.signals.slice(0, 3).join('; ')}. Trading it away at today’s value could miss a raise.` });
    }
    actions.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
    if (!actions.some(a => a.priority <= 4)) {
      const demandText = risk.avgDemand == null ? '' : `, and value-weighted demand is ${risk.avgDemand.toFixed(1)} / 5`;
      const deeper = coverage.of && coverage.share < 0.5 ? ' Run the deep model scan for item-level value odds.' : '';
      actions.unshift({ kind: 'clear', level: 'green', priority: 0, weight: 1, instanceIds: [],
        title: 'Sit tight: no urgent moves needed',
        detail: `No projected or likely-drop items, the top holding is ${pct(risk.top1)} of the value${demandText}.${deeper}` });
    }
    return actions;
  }

  function verdictOf(actions, total) {
    if (!total) return { level: 'none', text: 'Nothing to analyze: no valued tradable limiteds found.' };
    const red = actions.filter(a => a.level === 'red').length;
    if (red) return { level: 'red', text: `Yes: ${red} item${red === 1 ? '' : 's'} to move soon.` };
    if (actions.some(a => a.level === 'orange' || a.level === 'yellow')) return { level: 'yellow', text: 'Maybe: a few things to tidy up, nothing urgent to sell.' };
    return { level: 'green', text: 'No: sit tight.' };
  }

  // What-if: remove the given copies, add the received items, compare analyses.
  function simulate(copies, catalog, insights, give = [], get = []) {
    if (!Array.isArray(give) || !Array.isArray(get)) throw new Error('Invalid what-if trade.');
    if (give.length > MAX_SIDE || get.length > MAX_SIDE) throw new Error(`Pick up to ${MAX_SIDE} items on each side.`);
    if (!give.length && !get.length) throw new Error('Pick at least one item to give or get.');
    const giveSet = new Set(give);
    if (giveSet.size !== give.length) throw new Error('The same copy cannot be given twice.');
    const given = copies.filter(c => giveSet.has(c.instanceId));
    if (given.length !== giveSet.size) throw new Error('A selected item is not in this inventory.');
    const received = get.map((id, i) => {
      const item = own(catalog, String(id));
      if (!item) throw new Error(`Unknown item ${id}.`);
      return { instanceId: `whatif-${i}`, assetId: Number(id), name: item.name, serialNumber: null, isOnHold: false };
    });
    const before = analyze(copies, catalog, insights);
    const after = analyze([...copies.filter(c => !giveSet.has(c.instanceId)), ...received], catalog, insights);
    const view = c => {
      const item = own(catalog, String(c.assetId)) || {};
      return { assetId: c.assetId, name: item.name || c.name, acronym: item.acronym || '', worth: worth(item), value: item.value ?? null,
        rap: item.rap ?? null, demandScore: demandScore(item), projected: item.projected === true, isOnHold: c.isOnHold === true };
    };
    const giveView = given.map(view), getView = received.map(view);
    const giveValue = sum(giveView, x => x.worth), getValue = sum(getView, x => x.worth), gain = getValue - giveValue;
    const avg = list => (list.length ? sum(list, x => x.demandScore) / list.length : null);
    const warnings = [];
    for (const x of giveView) if (x.isOnHold) warnings.push(`${x.name} is on trade hold and can’t be traded right now.`);
    for (const x of getView) {
      if (x.projected) warnings.push(`${x.name} is marked projected on Rolimon’s (inflated RAP).`);
      else if (x.value == null) warnings.push(`${x.name} has no Rolimon’s value (RAP only), so its price can swing.`);
      const h = after.holdings.find(r => r.assetId === x.assetId);
      if (h && !x.projected && h.risk.outlook === 'drop') warnings.push(`${x.name} has elevated drop risk: ${h.risk.signals.slice(0, 2).join('; ')}.`);
    }
    for (const x of giveView) {
      const h = before.holdings.find(r => r.assetId === x.assetId);
      if (h?.risk.outlook === 'raise') warnings.push(`You’d give away ${x.name}, which looks likely to rise.`);
    }
    const gd = avg(giveView), rd = avg(getView);
    if (gd != null && rd != null && rd < gd) warnings.push(`You’d get lower demand (${rd.toFixed(1)} vs ${gd.toFixed(1)} out of 5).`);
    if (giveView.length && getView.length && gain < 0) warnings.push(`You’d lose ${fmt(-gain)} value (${pct(-gain / giveValue)}).`);
    const key = a => `${a.kind}:${a.assetId ?? ''}`;
    const beforeKeys = new Set(before.actions.map(key)), afterKeys = new Set(after.actions.map(key));
    return {
      before, after, give: giveView, get: getView, giveValue, getValue, gain,
      gainPct: giveValue > 0 ? Math.round(gain / giveValue * 1000) / 10 : null,
      warnings: [...new Set(warnings)],
      newActions: after.actions.filter(a => a.priority > 0 && !beforeKeys.has(key(a))),
      resolvedActions: before.actions.filter(a => a.priority > 0 && !afterKeys.has(key(a)))
    };
  }

  // Daily portfolio history (one point per UTC day, latest wins).
  function snapshot(analysis, nowMs = Date.now()) {
    return { d: new Date(nowMs).toISOString().slice(0, 10), value: Math.round(analysis.totals.value),
      rap: Math.round(analysis.totals.rap), risk: analysis.risk.score };
  }
  function recordHistory(points, point, max = 180) {
    const list = (Array.isArray(points) ? points : []).filter(p => p && typeof p.d === 'string' && p.d !== point.d);
    list.push(point);
    list.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    return list.slice(-max);
  }

  root.PortfolioRisk = { holdings, odds, itemRisk, analyze, advise, simulate, snapshot, recordHistory, levelOf, INSIGHT_TTL_MS, MAX_SIDE };
  if (typeof module !== 'undefined') module.exports = root.PortfolioRisk;
})(globalThis);
