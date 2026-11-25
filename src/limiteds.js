const $ = id => document.getElementById(id);
const L = LimitedsRank;
const TTL_MS = 6 * 3600e3, SHOW = 200, SECONDS_PER_ITEM = 1.3;
const DEMAND = { 0: 'Terrible', 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Amazing' };
const TREND = { 0: 'Lowering', 1: 'Unstable', 2: 'Stable', 3: 'Raising', 4: 'Fluctuating' };
const SIGNAL = { 'likely-raise': 'Likely raise', 'possible-raise': 'Possible raise', 'likely-lower': 'Likely lower', neutral: 'No clear signal', none: 'Not scanned' };
const fmt = n => Math.round(Number(n) || 0).toLocaleString();
// Scan-all can take tens of minutes, so show long waits in minutes / hours.
const dur = items => { const s = Math.ceil(items * SECONDS_PER_ITEM); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`; };
const pct = p => `${p > 0 && p < 0.01 ? '<1' : Math.round(p * 100)}%`;
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };

let catalog = null, insights = {}, list = [], scan = null, model = null;

async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw Object.assign(new Error(result?.error || 'No response. Reload the extension.'), { stop: result?.stop === true });
  return result;
}
const status = text => { $('status').textContent = text; };
const fresh = x => !!x && Date.now() - x.at < TTL_MS;
const freshInsights = () => Object.fromEntries(Object.entries(insights).filter(([, x]) => fresh(x)));

function options() {
  return {
    min: L.parseAmount($('min').value, 'Min value'), max: L.parseAmount($('max').value, 'Max value'),
    minDemand: Number($('demand').value), projected: $('projected').checked, query: $('query').value
  };
}

// Re-filter the catalog (instant, no network) and redraw.
function apply() {
  if (!catalog) return;
  try { list = L.filter(catalog, options()); }
  catch (error) { status(error.message); return; }
  render();
  if (!scan) status(list.length ? 'Showing catalog order until items are scanned. Click Scan model odds to rank by the model.' : 'No valued limiteds match these filters.');
}

const pending = () => L.scanOrder(list).filter(x => !fresh(insights[x.assetId]));

function render() {
  const rows = L.rank(list, freshInsights(), { horizon: Number($('horizon').value), sort: $('sort').value });
  const scanned = rows.filter(r => r.scanned).length, withOdds = rows.filter(r => r.odds).length;
  const likely = rows.filter(r => r.signal === 'likely-raise').length, todo = rows.length - scanned;
  $('summary').textContent = rows.length
    ? `${fmt(rows.length)} valued limiteds match · ${fmt(scanned)} scanned (${fmt(withOdds)} with model odds) · ${likely} likely raise${todo ? ` · ${fmt(todo)} not scanned (~${dur(Math.min(todo, Number($('cap').value)))} for the next ${Math.min(todo, Number($('cap').value))})` : ''}${rows.length > SHOW ? ` · showing top ${SHOW}` : ''}`
    : '';
  $('results').replaceChildren(...(rows.length ? rows.slice(0, SHOW).map((r, i) => row(r, i + 1)) : [el('div', catalog ? 'No valued limiteds match these filters.' : 'Loading…', 'empty')]));
  if (!scan) $('bar').style.width = rows.length ? `${scanned / rows.length * 100}%` : '0';
  buttons();
}

function buttons() {
  const todo = catalog ? pending().length : 0;
  $('scan').disabled = $('scan-all').disabled = !catalog || !!scan || !todo;
  $('scan-all').textContent = todo ? `Scan all (${fmt(todo)}, ~${dur(todo)})` : 'Scan all';
  $('stop').disabled = !scan;
}

function row(r, n) {
  const h = Number($('horizon').value);
  const box = el('article', null, `row ${r.signal}`), top = el('div', null, 'top');
  const name = link(r.acronym ? `${r.name} (${r.acronym})` : r.name, `https://www.rolimons.com/item/${r.assetId}`); name.className = 'name';
  top.append(el('span', `#${n}`, 'rank'), name, el('span', SIGNAL[r.signal], `badge ${r.signal}`));
  if (r.projected) top.append(el('span', 'Projected', 'badge warn'));
  if (r.hyped) top.append(el('span', 'Hyped', 'badge warn'));
  if (r.rare) top.append(el('span', 'Rare', 'badge'));
  const odds = el('div', null, 'odds');
  if (r.odds) {
    odds.append(el('div', `↑ ${pct(r.odds.up)} in ${h}D`, 'big'),
      el('div', `usual ${pct(r.odds.baseUp || 0)}${r.lift ? ` · ${r.lift.toFixed(1)}× usual` : ''} · lower ${pct(r.odds.down)}`, 'base'));
  } else odds.append(el('div', r.scanned ? 'No model odds' : 'Not scanned', 'base'));
  top.append(odds);
  box.append(top);
  const gap = r.rap != null && r.value > 0 ? Math.round((r.rap / r.value - 1) * 100) : null;
  const meta = [`Value ${fmt(r.value)}`, r.rap != null ? `RAP ${fmt(r.rap)}${gap != null ? ` (${gap > 0 ? '+' : ''}${gap}%)` : ''}` : null,
    `Demand ${DEMAND[r.demand] ?? 'None'}`, r.trend != null ? `Trend ${TREND[r.trend]}` : null].filter(Boolean);
  box.append(el('div', meta.join(' · '), 'meta'));
  const i = r.insight;
  if (i) {
    const hz = i.prediction?.horizons || {};
    const all = L.HORIZONS.filter(k => L.oddsAt(i, k)).map(k => `${k}D ↑${pct(hz[k].up)} ↓${pct(hz[k].down)}`).join(' · ');
    const extra = [all || 'Not enough recent data for model odds',
      i.rap30 != null ? `RAP 30D ${i.rap30 > 0 ? '+' : ''}${Math.round(i.rap30 * 10) / 10}%` : null,
      i.salesPerDay != null ? `${i.salesPerDay} sales/day` : null, i.sellers != null ? `${i.sellers} sellers` : null,
      `scanned ${Math.max(0, Math.round((Date.now() - i.at) / 60000))} min ago`].filter(Boolean);
    box.append(el('div', extra.join(' · '), 'sub'));
  }
  const tools = el('div', null, 'tools');
  if (!r.scanned) {
    const b = el('button', 'Get odds'); b.type = 'button'; b.disabled = !!scan;
    b.addEventListener('click', () => runScan([r.assetId]));
    tools.append(b);
  }
  tools.append(link('Rolimon’s ↗', `https://www.rolimons.com/item/${r.assetId}`), link('Roblox catalog ↗', `https://www.roblox.com/catalog/${r.assetId}`));
  box.append(tools);
  return box;
}

// Paced by the service worker (about one uncached page per 1.2 s); cached items return at once.
async function runScan(ids) {
  if (scan || !ids.length) return;
  const token = scan = { stop: false, done: 0, total: ids.length, failed: 0, streak: 0 };
  buttons();
  let reason = '';
  for (const assetId of ids) {
    if (token.stop) { reason = 'Stopped.'; break; }
    try {
      const result = await send('PORTFOLIO_INSIGHT', { assetId });
      insights[assetId] = result.insight;
      token.streak = 0;
    } catch (error) {
      token.failed++; token.streak++;
      if (error.stop || token.streak >= 3) { token.done++; reason = `Stopped: ${error.message}${error.stop ? ' Try again later.' : ''}`; break; }
    }
    token.done++;
    const left = token.total - token.done;
    $('bar').style.width = `${token.done / token.total * 100}%`;
    status(`Scanning ${token.done} of ${token.total}${left ? ` · about ${dur(left)} left` : ''}${token.failed ? ` · ${token.failed} failed` : ''}`);
    render();
  }
  scan = null;
  render();
  status(reason || `Scan finished: ${token.done - token.failed} of ${token.total} items scanned${token.failed ? ` (${token.failed} failed)` : ''}.`);
}

$('filters').addEventListener('submit', event => { event.preventDefault(); apply(); });
for (const id of ['horizon', 'sort', 'demand', 'projected']) $(id).addEventListener('change', apply);
$('cap').addEventListener('change', () => catalog && render());
$('scan').addEventListener('click', () => runScan(pending().slice(0, Number($('cap').value)).map(x => x.assetId)));
// Same pacing and auto-stop as a capped scan, just no cap; big runs get a confirm with the time.
$('scan-all').addEventListener('click', () => {
  const ids = pending().map(x => x.assetId);
  if (ids.length > 100 && typeof confirm === 'function' && !confirm(`Scan all ${fmt(ids.length)} unscanned items? This takes about ${dur(ids.length)}. Keep this tab open; progress is saved if you stop or close it.`)) return;
  runScan(ids);
});
$('stop').addEventListener('click', () => { if (scan) { scan.stop = true; status('Stopping after the current item…'); } });

send('LIMITEDS_CATALOG').then(result => {
  catalog = result.catalog; insights = result.insights || {}; model = result.model;
  const age = model?.dataAt ? ItemInsights.modelAge(model.dataAt) : null;
  $('model-age').textContent = age ? `${age.text}.` : 'The value model is not available in this build.';
  apply();
}, error => status(error.message));
