/* Value forecast page: pick an item, read its live Rolimon's page through the
   service worker (FORECAST_SERIES), forecast its Rolimon's value with
   value-forecast.js and show it as summary boxes, a chart, a table and the
   backtest results. Texts and number formats come from forecast-view.js. */
const $ = id => document.getElementById(id);
const V = ForecastView;
const SVG = 'http://www.w3.org/2000/svg';
const fmt = n => (n == null || !Number.isFinite(Number(n)) ? '–' : Math.round(Number(n)).toLocaleString('en-US'));
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
const svg = (tag, attrs = {}) => { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); return node; };
const tone = ratio => (ratio > 1.005 ? 'up' : ratio < 0.995 ? 'down' : 'flat');
const changeSpan = ratio => el('span', V.change(ratio), tone(ratio));

let list = [], busy = false;

async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw Object.assign(new Error(result?.error || 'No response. Reload the extension.'), { stop: result?.stop === true, access: result?.access === true });
  return result;
}
const status = text => { $('status').textContent = text; };

// ---------- result ----------
function headline(h, fc) {
  const f = fc.horizons[h], box = el('div', null, 'headline');
  const big = el('div', null, 'big');
  big.append(`${V.money(f.median)} `, changeSpan(f.median / fc.value));
  box.append(
    el('div', `In ${V.label(h)} · ${V.monthYear(fc.at + h * V.DAY)}`, 'when'), big,
    el('div', `Likely ${V.money(f.low)} – ${V.money(f.high)}`),
    el('div', `Higher ${V.pct(f.up)} · Same ${V.pct(f.same)} · Lower ${V.pct(f.down)}`),
    el('div', f.source === 'usual'
      ? 'The usual odds for any valued item: forecasts for one item this far ahead didn’t beat them in tests.'
      : 'From this item’s own history (tested on past years, see below).', 'src'));
  return box;
}

function renderHead(item, d, fc) {
  const top = el('div', null, 'top');
  const page = d.bundleId ? `https://www.rolimons.com/bundle/${d.bundleId}` : `https://www.rolimons.com/item/${item.assetId}`;
  const name = link(item.acronym ? `${item.name} (${item.acronym})` : item.name, page);
  name.className = 'name';
  top.append(name);
  if (d.projected ?? item.projected) top.append(el('span', 'Projected', 'badge warn'));
  if (d.hyped ?? item.hyped) top.append(el('span', 'Hyped', 'badge warn'));
  if (d.rare ?? item.rare) top.append(el('span', 'Rare', 'badge'));
  const rap = Number(d.rap ?? item.rap), demand = d.demand ?? item.demand, trend = d.trend ?? item.trend;
  const meta = [
    `Value ${fmt(fc.value)}`,
    rap > 0 ? `RAP ${fmt(rap)} (${V.change(rap / fc.value)} vs value)` : null,
    d.bestPrice > 0 ? `Best price ${fmt(d.bestPrice)}` : null,
    V.DEMAND[demand] ? `Demand ${V.DEMAND[demand]}` : null,
    V.TREND[trend] ? `Trend ${V.TREND[trend]}` : null
  ].filter(Boolean);
  const boxes = el('div', null, 'headlines');
  for (const h of V.headlines(fc)) boxes.append(headline(h, fc));
  $('head').replaceChildren(top, el('div', meta.join(' · '), 'meta'), boxes);
}

// Past 2 years of value (steps) and RAP, then the forecast fan to +2 years,
// on a log scale so that +50% and -33% look the same size.
function renderChart(item, series, fc) {
  const D = V.DAY, now = fc.at;
  const steps = V.valueSteps(series, now - 730 * D, now);
  const rap = V.rapPoints(series, now - 730 * D, now);
  const fan = V.fan(fc);
  const sc = V.scales({ steps, rap, fan, now });
  const { x, y, width: W, height: H, pad } = sc;
  const year = fc.horizons[365] ? 365 : V.horizons(fc).at(-1);
  const f = fc.horizons[year];
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `${item.name}: Rolimon’s value over the past 2 years (now ${fmt(fc.value)}) and the forecast` +
      (f ? `; in ${V.label(year)} typically ${V.money(f.median)}, likely ${V.money(f.low)} to ${V.money(f.high)}.` : '.')
  });
  const clip = svg('clipPath', { id: 'plot' });
  clip.append(svg('rect', { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b }));
  const defs = svg('defs');
  defs.append(clip);
  root.append(defs);
  const text = (content, attrs) => { const t = svg('text', { class: 'tick', ...attrs }); t.textContent = content; return t; };
  for (const v of sc.ticks) {
    root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }), text(V.compact(v), { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }));
  }
  for (const k of [-730, -365, 0, 365, 730]) {
    const X = x(now + k * D);
    root.append(svg('line', { x1: X, x2: X, y1: pad.t, y2: H - pad.b, class: k === 0 ? 'today' : 'grid' }),
      text(k === 0 ? 'Today' : V.monthYear(now + k * D), { x: X, y: H - pad.b + 18, 'text-anchor': k === -730 ? 'start' : k === 730 ? 'end' : 'middle' }));
  }
  const plot = svg('g', { 'clip-path': 'url(#plot)' });
  const band = (lo, hi, cls) => svg('polygon', {
    class: cls, points: [...fan.map(p => `${x(p.t)},${y(p[hi])}`), ...fan.slice().reverse().map(p => `${x(p.t)},${y(p[lo])}`)].join(' ')
  });
  plot.append(band('low', 'high', 'band80'), band('q25', 'q75', 'band50'));
  if (rap.length > 1) plot.append(svg('polyline', { class: 'rap', points: rap.map(p => `${x(p.t)},${y(p.value)}`).join(' ') }));
  if (steps.length) {
    let d = `M${x(steps[0].t)},${y(steps[0].value)}`;
    for (const p of steps.slice(1)) d += ` H${x(p.t)} V${y(p.value)}`;
    plot.append(svg('path', { class: 'past', d: `${d} H${x(now)}` }));
  }
  plot.append(svg('polyline', { class: 'median', points: fan.map(p => `${x(p.t)},${y(p.median)}`).join(' ') }));
  root.append(plot);
  for (const p of fan) {
    const dot = svg('circle', { cx: x(p.t), cy: y(p.median), r: p.days ? 4.5 : 4, class: `dot ${p.days ? p.source : 'now'}` });
    const title = svg('title');
    title.textContent = p.days
      ? `In ${V.label(p.days)} (${V.monthYear(p.t)}): typically ${V.money(p.median)} (${V.change(p.median / fc.value)}), likely ${V.money(p.low)} – ${V.money(p.high)}${p.source === 'usual' ? ' · usual for any item' : ''}`
      : `Today: value ${fmt(fc.value)}`;
    dot.append(title);
    root.append(dot);
  }
  $('chart').replaceChildren(root);
}

function renderTable(fc) {
  const headRow = el('tr');
  for (const t of ['In', 'Typical value', 'Likely range (80%)', 'Middle half', 'Higher · Same · Lower', 'Based on']) headRow.append(el('th', t));
  const thead = el('thead'), body = el('tbody');
  thead.append(headRow);
  for (const h of V.horizons(fc)) {
    const f = fc.horizons[h], tr = el('tr');
    const when = el('td');
    when.append(el('div', V.label(h), 'nowrap'), el('div', V.monthYear(fc.at + h * V.DAY), 'sub'));
    const typical = el('td', null, 'nowrap');
    typical.append(`${V.money(f.median)} `, changeSpan(f.median / fc.value));
    const range = el('td');
    range.append(el('div', `${V.money(f.low)} – ${V.money(f.high)}`, 'nowrap'), el('div', `${V.change(f.low / fc.value)} to ${V.change(f.high / fc.value)}`, 'sub'));
    const odds = el('td'), bar = el('div', null, 'bar');
    for (const [cls, p, name] of [['u', f.up, 'Higher'], ['s', f.same, 'Same'], ['d', f.down, 'Lower']]) {
      const part = el('span', null, cls);
      part.style.width = `${Math.max(0, Number(p) || 0) * 100}%`;
      part.title = `${name} ${V.pct(p)}`;
      bar.append(part);
    }
    odds.append(el('div', `${V.pct(f.up)} · ${V.pct(f.same)} · ${V.pct(f.down)}`, 'nowrap'), bar);
    const source = el('td');
    if (f.source === 'usual') source.append(el('div', 'Any valued item'), el('div', 'The item’s own forecast didn’t beat this in tests', 'sub'));
    else source.append(el('div', 'This item'), el('div', f.base ? `Usual for any item: ${V.change(f.base.median)}, higher ${V.pct(f.base.up)}` : '', 'sub'));
    tr.append(when, typical, range, el('td', `${V.money(f.q25)} – ${V.money(f.q75)}`, 'nowrap'), odds, source);
    body.append(tr);
  }
  const table = el('table');
  table.append(thead, body);
  $('table').replaceChildren(table);
}

function renderReliability(fc) {
  const ul = el('ul', null, 'reliability');
  for (const h of V.horizons(fc)) ul.append(el('li', V.reliability(h, fc.horizons[h])));
  $('reliability').replaceChildren(
    el('p', 'Each past forecast was rebuilt as if it were made at the time, from data before that year only, then checked against what really happened. The likely range should hold about 80% of the time.', 'note'),
    ul,
    el('p', 'Longer spans swing with the whole market: for forecasts made during 2023 the typical value was unchanged a year later, while for those made during 2025 it nearly doubled. One item’s history can’t predict those swings, which is why longer spans show the usual range for any item. The hover panel’s 7/14/30-day odds come from a separate short-term model and count any raise or drop during those days, while this page shows where the value ends up, so the numbers differ.', 'note'));
}

// ---------- actions ----------
async function run(text) {
  if (busy) return;
  const item = V.find(list, text);
  if (!item) {
    status(String(text ?? '').trim() ? `No valued limited matches “${String(text).trim()}”. Try the full name, the acronym or the item ID.` : 'Type an item name, acronym or ID.');
    return;
  }
  busy = true;
  $('go').disabled = true;
  status(`Reading ${item.name}’s Rolimon’s page…`);
  try {
    const { details = {}, series = null } = await send('FORECAST_SERIES', { assetId: item.assetId });
    const named = { ...item, name: details.name || item.name };
    const fc = series ? ValueForecast.forecast(series) : null;
    if (!fc || !V.horizons(fc).length) {
      $('result').hidden = true;
      const valued = Number(details.value) > 0 || Number(series?.value) > 0;
      status(!globalThis.VALUE_FORECAST?.horizons ? V.modelNote(null)
        : !valued ? `${named.name} has no Rolimon’s value, so there is nothing to forecast: this page forecasts Rolimon’s value, not RAP.`
          : `Not enough recent Rolimon’s data to forecast ${named.name}.`);
      return;
    }
    history.replaceState(null, '', `?id=${item.assetId}`);
    document.title = `${named.name} · Value forecast`;
    renderHead(named, details, fc);
    renderChart(named, series, fc);
    renderTable(fc);
    renderReliability(fc);
    $('result').hidden = false;
    const missing = ValueForecast.HORIZONS.filter(h => globalThis.VALUE_FORECAST.horizons[h] && !fc.horizons[h]);
    status(missing.length ? `${missing.map(V.label).join(', ')}: not enough recent data for this item’s own forecast.` : '');
  } catch (error) {
    status(/not granted/.test(error.message) ? `${error.message} Allow it in chrome://extensions → Trade Assistant → Details → Site access, then try again.`
      : error.stop ? `${error.message}. Rolimon’s is limiting requests: wait a minute, then try again.` : error.message);
  } finally {
    busy = false;
    $('go').disabled = false;
  }
}

$('pick').addEventListener('submit', event => { event.preventDefault(); run($('item').value); });
// Picking a suggestion runs it at once.
$('item').addEventListener('input', event => { if (event.inputType === 'insertReplacementText' && /#\d+$/.test($('item').value)) run($('item').value); });
$('model-note').textContent = V.modelNote(globalThis.VALUE_FORECAST);

const catalogReady = send('LIMITEDS_CATALOG').then(result => {
  list = V.items(result.catalog);
  $('items').replaceChildren(...list.map(x => { const option = document.createElement('option'); option.value = V.optionText(x); return option; }));
  $('catalog-note').textContent = `${list.length.toLocaleString('en-US')} valued limiteds: type part of a name or an acronym, or paste an item ID.`;
}, error => {
  $('catalog-note').textContent = `Couldn’t load the item list (${error.message}). You can still enter an item ID.`;
});

// forecast.html?id=123 (from the limiteds browser) forecasts that item.
const deepId = new URLSearchParams(location.search).get('id');
if (deepId && /^\d{1,20}$/.test(deepId)) {
  catalogReady.finally(() => {
    const item = list.find(x => x.assetId === Number(deepId));
    $('item').value = item ? V.optionText(item) : deepId;
    run($('item').value);
  });
}
