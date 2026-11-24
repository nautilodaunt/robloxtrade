/* Item history from a Rolimon's item page. Shared by the service worker,
   content script, trainer and tests. Value predictions live in value-model.js. */
(function (root) {
  const DAY = 86400;
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

  // Reads the JSON assigned to a page variable (`var name = {...};`) without
  // running any page script: brackets are matched while skipping strings.
  function extract(html, name) {
    const match = new RegExp(`\\b${name}\\s*=\\s*`).exec(html);
    if (!match) return undefined;
    const start = match.index + match[0].length;
    const open = html[start];
    let end;
    if (open === '{' || open === '[') {
      let depth = 0, inString = false;
      for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
        if (c === '"') inString = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (!depth) { end = i + 1; break; } }
      }
    } else {
      end = html.slice(start).search(/[;\r\n]/);
      end = end < 0 ? html.length : start + end;
    }
    if (end == null) return undefined;
    try { return JSON.parse(html.slice(start, end)); } catch { return undefined; }
  }

  // Keep a year of history, denser for the last 30 days, small enough to message.
  function thin(points, max) {
    if (points.length <= max) return points;
    const step = Math.ceil(points.length / max);
    return points.filter((_, i) => i % step === 0 || i === points.length - 1);
  }

  // Daily series and the full change log, the shape the value model reads.
  // The collector stores this for training; the extension builds it live.
  // changes rows: [time, type, from, to]; 1 value, 2 demand, 3 trend,
  // 4 projected, 5 hyped (as Rolimon's value_changes log records them).
  function normalizePage(html, sinceSec = 0) {
    const daily = { t: [], rap: [], best: [], sellers: [], fav: [] };
    const h = extract(html, 'history_data');
    if (h && Array.isArray(h.timestamp)) {
      let day = null;
      h.timestamp.forEach((t, i) => {
        if (!valid(t) || t < sinceSec) return;
        const d = Math.floor(t / DAY) * DAY;
        const row = [d, h.rap?.[i], h.best_price?.[i], h.num_sellers?.[i], h.favorited?.[i]].map(v => valid(v) ? v : null);
        if (d === day) { daily.rap[daily.t.length - 1] = row[1]; daily.best[daily.t.length - 1] = row[2]; daily.sellers[daily.t.length - 1] = row[3]; daily.fav[daily.t.length - 1] = row[4]; return; }
        day = d;
        daily.t.push(d); daily.rap.push(row[1]); daily.best.push(row[2]); daily.sellers.push(row[3]); daily.fav.push(row[4]);
      });
    }
    const sales = { t: [], price: [], volume: [] };
    const s = extract(html, 'sales_data');
    if (s && Array.isArray(s.timestamp)) {
      s.timestamp.forEach((t, i) => {
        if (!valid(t) || t < sinceSec) return;
        sales.t.push(t);
        sales.price.push(valid(s.avg_daily_sales_price?.[i]) ? s.avg_daily_sales_price[i] : null);
        sales.volume.push(valid(s.sales_volume?.[i]) ? s.sales_volume[i] : 0);
      });
    }
    const raw = extract(html, 'value_changes');
    const changes = Array.isArray(raw) ? raw.filter(c => Array.isArray(c) && valid(c[0]) && c[1] >= 1 && c[1] <= 5)
      .map(([t, type, from, to]) => [t, type, from ?? null, to ?? null]) : [];
    const d = extract(html, 'item_details_data') || {};
    return {
      created: valid(d.created) ? d.created : null,
      value: valid(d.value) ? d.value : null,
      demand: Number.isInteger(d.demand) ? d.demand : null,
      trend: Number.isInteger(d.trend) ? d.trend : null,
      projected: d.projected === 1 || d.projected === true,
      hyped: d.hyped === 1 || d.hyped === true,
      daily, sales, changes
    };
  }

  function parseItemPage(html) {
    const raw = extract(html, 'item_details_data') || {};
    const details = {
      name: typeof raw.item_name === 'string' ? raw.item_name : null,
      value: valid(raw.value) ? raw.value : null,
      rap: valid(raw.rap) ? raw.rap : null,
      bestPrice: valid(raw.best_price) && raw.best_price > 0 ? raw.best_price : null,
      demand: Number.isInteger(raw.demand) && raw.demand >= 0 && raw.demand <= 4 ? raw.demand : null,
      trend: Number.isInteger(raw.trend) && raw.trend >= 0 && raw.trend <= 4 ? raw.trend : null,
      projected: raw.projected === 1 || raw.projected === true,
      hyped: raw.hyped === 1 || raw.hyped === true,
      rare: raw.rare === 1 || raw.rare === true,
      sellers: valid(raw.num_sellers) ? raw.num_sellers : null,
      owners: valid(raw.owners) ? raw.owners : null,
      copies: valid(raw.copies) ? raw.copies : null
    };
    const h = extract(html, 'history_data');
    let history = [];
    if (h && Array.isArray(h.timestamp)) {
      const points = h.timestamp.map((t, i) => ({
        t, rap: valid(h.rap?.[i]) ? h.rap[i] : null,
        best: valid(h.best_price?.[i]) ? h.best_price[i] : null,
        sellers: valid(h.num_sellers?.[i]) ? h.num_sellers[i] : null
      })).filter(p => valid(p.t));
      const last = points.at(-1)?.t || 0;
      const year = points.filter(p => p.t >= last - 365 * DAY && p.t < last - 30 * DAY);
      const month = points.filter(p => p.t >= last - 30 * DAY);
      history = [...thin(year, 260), ...thin(month, 240)];
    }
    const changes = extract(html, 'value_changes');
    const valueChanges = Array.isArray(changes) ? changes
      .filter(c => Array.isArray(c) && valid(c[0]) && (c[1] === 1 || c[1] === 2))
      .slice(-6).reverse()
      .map(([t, type, from, to]) => ({ t, type: type === 1 ? 'value' : 'demand', from, to })) : [];
    const sales = extract(html, 'avg_daily_sales_volume_30_days');
    if (!details.name && !history.length) throw new Error('No item data on the Rolimon’s page');
    return { details, history, valueChanges, salesPerDay: valid(sales) ? sales : null };
  }

  // Percent RAP change across the last `days` of history.
  function rapChange(history, days) {
    const last = history.at(-1);
    if (!last?.rap) return null;
    const first = history.find(p => p.t >= last.t - days * DAY && p.rap > 0);
    return first && first !== last ? (last.rap - first.rap) / first.rap * 100 : null;
  }

  // How old the value model is, measured from the Rolimon's data it was
  // trained on (dataAt, an ISO date/time). A backtest showed its odds drift
  // after about 2-3 months, so 60+ days is "old" and 90+ days is "stale".
  function modelAge(dataAt, now = Date.now() / 1000) {
    const t = Date.parse(dataAt) / 1000;
    if (!Number.isFinite(t)) return null;
    const seconds = Math.max(0, now - t);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds / 3600);
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    const age = days >= 1 ? plural(days, 'day') : hours >= 1 ? plural(hours, 'hour') : 'less than 1 hour';
    const level = days >= 90 ? 'stale' : days >= 60 ? 'old' : 'ok';
    const hint = level === 'stale' ? ' · odds are less reliable, retrain it' : level === 'old' ? ' · retrain soon' : '';
    return { days, level, text: `Model is ${age} old${hint}` };
  }

  root.ItemInsights = { extract, normalizePage, parseItemPage, rapChange, modelAge };
  if (typeof module !== 'undefined') module.exports = root.ItemInsights;
})(globalThis);
