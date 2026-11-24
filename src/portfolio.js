const $ = id => document.getElementById(id);
const R = PortfolioRisk;
const DEMAND = ['None', 'Terrible', 'Low', 'Normal', 'High', 'Amazing']; // 0–5 demand score
const TREND = { 0: 'Lowering', 1: 'Unstable', 2: 'Stable', 3: 'Raising', 4: 'Fluctuating' };
const OUTLOOK = { drop: 'Likely drop', raise: 'Likely raise', stable: 'Stable' };
const fmt = n => Math.round(Number(n) || 0).toLocaleString();
const pct = p => `${p > 0 && p < 0.01 ? '<1' : Math.round(p * 100)}%`;
const signed = (n, f = fmt) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${f(Math.abs(n))}`;
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
const itemUrl = id => `https://www.rolimons.com/item/${id}`;
const AD_URL = 'https://www.rolimons.com/tradeadcreate';
const DEALS_URL = chrome.runtime.getURL('src/deals.html');

let data = null, analysis = null, busy = false, scan = null, lastSim = null, items = [];

async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw Object.assign(new Error(result?.error || 'No response. Reload the extension.'), { stop: result?.stop === true });
  return result;
}
const status = text => { $('status').textContent = text; };
const fresh = x => !!x && Date.now() - x.at < R.INSIGHT_TTL_MS;
const keepSet = () => new Set(data?.keep || []);
const kept = h => h.instanceIds.length > 0 && h.instanceIds.every(id => keepSet().has(id));
const label = h => (h.acronym ? `${h.name} (${h.acronym})` : h.name);

function setBusy() {
  for (const id of ['analyze', 'mine']) $(id).disabled = busy;
  $('deep-run').disabled = busy || !!scan || !data;
  $('deep-stop').disabled = !scan;
  $('sim-odds').disabled = !!scan;
}

// ---------- loading ----------
async function load(target) {
  if (busy) return;
  cancelScan();
  busy = true; setBusy();
  status(target ? `Looking up ${target}…` : 'Loading your inventory…');
  try {
    data = await send('PORTFOLIO_LOAD', { target });
    lastSim = null;
    fillRecent(data.recent);
    fillWhatIf();
    $('sim-result').replaceChildren();
    $('report').hidden = false;
    refresh();
    status(`Loaded ${data.copies.length} tradable cop${data.copies.length === 1 ? 'y' : 'ies'} for ${data.owner.name} at ${new Date(data.loadedAt).toLocaleTimeString()}.`);
  } catch (error) { status(error.message); }
  finally { busy = false; setBusy(); }
}

function fillRecent(list = []) {
  $('recent').replaceChildren(...list.map(u => {
    const b = el('button', u.name); b.type = 'button'; b.title = `User ID ${u.id}`;
    b.addEventListener('click', () => { $('target').value = String(u.id); load(String(u.id)); });
    return b;
  }));
}

// Re-score with whatever insights we have and redraw everything except the what-if inputs.
function refresh() {
  if (!data) return;
  analysis = R.analyze(data.copies, data.catalog, data.insights);
  renderKpis(); renderAdvisor(); renderOutlook(); renderHistory(); renderDeep(); renderRisk(); renderHoldings();
  if (lastSim) simulate(true);
}

// ---------- KPIs ----------
function kpi(k, v, s, cls) {
  const box = el('div', null, `kpi${cls ? ` ${cls}` : ''}`);
  box.append(el('div', k, 'k'), typeof v === 'string' ? el('div', v, 'v') : v);
  if (s) box.append(typeof s === 'string' ? el('div', s, 's') : s);
  return box;
}
function renderKpis() {
  const { owner, isSelf } = data, t = analysis.totals, r = analysis.risk;
  const links = el('div', null, 'links');
  // Links are built only from the numeric user ID.
  if (Number.isSafeInteger(owner.id) && owner.id > 0) {
    links.append(link('Profile ↗', `https://www.roblox.com/users/${owner.id}/profile`), link('Rolimon’s ↗', `https://www.rolimons.com/player/${owner.id}`));
    if (!isSelf) links.append(link('Trade ↗', `https://www.roblox.com/users/${owner.id}/trade`));
  }
  const who = el('div', `${owner.displayName && owner.displayName !== owner.name ? `${owner.displayName} (@${owner.name})` : owner.name}${isSelf ? ' · you' : ''}`, 'v');
  const badge = el('div', `${r.score} · ${r.level}`, 'v');
  badge.style.color = { High: '#a40e26', Moderate: '#7d4e00', Low: '#116329' }[r.level] || '';
  $('kpis').replaceChildren(
    kpi('Owner', who, links, 'owner'),
    kpi('Total value', fmt(t.value), `${fmt(t.valued)} Rolimon’s value + RAP for unvalued`),
    kpi('RAP', fmt(t.rap), t.value ? `${signed(Math.round((t.rap / t.value - 1) * 100), String)}% vs value` : ''),
    kpi('Holdings', `${t.unique} items`, `${t.copies} copies${t.unknown ? ` · ${t.unknown} not on Rolimon’s` : ''}`),
    kpi('On trade hold', fmt(t.held), t.value ? `${pct(t.held / t.value)} of value` : ''),
    kpi('Risk score', badge, 'out of 100')
  );
}

// ---------- advisor ----------
function renderAdvisor() {
  const v = analysis.verdict;
  $('verdict').textContent = v.text;
  $('verdict').className = `lv-${v.level}`;
  $('actions').replaceChildren(...analysis.actions.map(actionCard));
}
function keepButton(ids, on, text) {
  const b = el('button', text); b.type = 'button';
  b.addEventListener('click', () => setKeep(ids, on, b));
  return b;
}
function actionCard(a) {
  const box = el('article', null, `action ${a.level}`);
  box.append(el('h3', a.title), el('div', a.detail));
  const links = el('div', null, 'links'), keep = keepSet();
  const self = data.isSelf;
  if (a.kind === 'exit') {
    if (self) links.append(link('Find value deals ↗', DEALS_URL));
    links.append(link('Rolimon’s item ↗', itemUrl(a.assetId)), link('Post a trade ad ↗', AD_URL));
    const protectedIds = a.instanceIds.filter(id => keep.has(id));
    if (self && protectedIds.length) links.append(keepButton(protectedIds, false, 'Unprotect so the deal finder can offer it'));
  } else if (a.kind === 'held-risk') links.append(link('Rolimon’s item ↗', itemUrl(a.assetId)));
  else if (a.kind === 'concentration') links.append(link('Rolimon’s item ↗', itemUrl(a.assetId)), link('Post a downgrade ad ↗', AD_URL));
  else if (a.kind === 'clutter') { if (self) links.append(link('Find value deals ↗', DEALS_URL)); links.append(link('Post an upgrade ad ↗', AD_URL)); }
  else if (a.kind === 'hold') {
    links.append(link('Rolimon’s item ↗', itemUrl(a.assetId)));
    if (self && a.instanceIds.length) {
      if (a.instanceIds.every(id => keep.has(id))) links.append(el('span', 'Protected in deal finder', 'badge good'));
      else links.append(keepButton(a.instanceIds, true, 'Protect in deal finder'));
    }
  }
  if (links.childNodes.length) box.append(links);
  return box;
}

async function setKeep(ids, on, button) {
  if (!data?.isSelf) return;
  if (button) button.disabled = true;
  try {
    const result = await send('PORTFOLIO_KEEP', { instanceIds: ids.slice(0, 100), keep: on });
    data.keep = result.keep;
    status(on ? 'Protected: the deal finder will never offer it.' : 'Unprotected: the deal finder may offer it again.');
    refresh();
  } catch (error) { status(error.message); if (button) button.disabled = false; }
}

// ---------- outlook & history ----------
function renderOutlook() {
  const o = analysis.outlook, bar = $('outlook-bar');
  bar.replaceChildren(...['raise', 'stable', 'drop'].filter(k => o[k] > 0).map(k => {
    const s = el('span', null, k); s.style.width = `${o[k] * 100}%`; s.title = `${OUTLOOK[k]}: ${pct(o[k])}`; return s;
  }));
  $('lg-raise').textContent = `Likely raise ${pct(o.raise)}`;
  $('lg-stable').textContent = `Stable ${pct(o.stable)}`;
  $('lg-drop').textContent = `Likely drop ${pct(o.drop)}`;
}

function renderHistory() {
  const points = (data.history || []).filter(p => Number.isFinite(p.value));
  const box = $('history');
  if (points.length < 2) { box.replaceChildren(el('small', 'History builds up each day you load this portfolio (one point per day).')); return; }
  const NS = 'http://www.w3.org/2000/svg', W = 600, H = 90, pad = 6;
  const values = points.map(p => p.value), lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const xy = points.map((p, i) => [pad + i * (W - 2 * pad) / (points.length - 1), H - pad - (p.value - lo) / span * (H - 2 * pad)]);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Portfolio value history');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#0969da'); line.setAttribute('stroke-width', '2');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  const first = points[0], last = points.at(-1), change = last.value - first.value;
  const text = el('small', `${first.d} → ${last.d}: ${signed(change)} (${first.value ? signed(Math.round(change / first.value * 1000) / 10, String) : '±0'}%) · low ${fmt(lo)}, high ${fmt(hi)} · risk ${first.risk} → ${last.risk}`);
  box.replaceChildren(svg, text);
}

// ---------- deep scan (separate button; paced by the worker) ----------
const pendingDeep = () => analysis.holdings.filter(h => h.valued && !fresh(data.insights[h.assetId])).sort((a, b) => b.unit - a.unit).map(h => h.assetId);

function renderDeep() {
  const c = analysis.coverage;
  $('coverage').textContent = c.of
    ? `Model odds for ${c.items} of ${c.of} valued items (${pct(c.share)} of valued worth). The rest are scored from Rolimon’s trend, demand and RAP gap.`
    : 'No valued items to scan.';
  const age = data.model?.dataAt ? ItemInsights.modelAge(data.model.dataAt) : null;
  $('model-age').textContent = age ? `${age.text}.` : 'The value model is not available in this build.';
  if (scan) {
    const left = scan.total - scan.done;
    $('deep-bar').style.width = `${scan.total ? scan.done / scan.total * 100 : 0}%`;
    $('deep-status').textContent = `${scan.done} of ${scan.total} scanned${left ? ` · about ${Math.ceil(left * 1.3)} s left` : ''}${scan.failed ? ` · ${scan.failed} failed` : ''}`;
  } else if (!$('deep-status').dataset.final) {
    const todo = pendingDeep().length;
    $('deep-bar').style.width = c.of ? `${c.items / c.of * 100}%` : '0';
    $('deep-status').textContent = todo ? `${todo} valued item${todo === 1 ? '' : 's'} not scanned yet (about ${Math.ceil(todo * 1.3)} s).` : 'All valued items have fresh model odds.';
  }
  setBusy();
}

function cancelScan() { if (scan) scan.stop = true; scan = null; }

async function deepScan(ids, done) {
  if (scan || !data || !ids.length) return;
  const token = scan = { stop: false, done: 0, total: ids.length, failed: 0, streak: 0 }, target = data;
  delete $('deep-status').dataset.final;
  renderDeep();
  let reason = '';
  for (const assetId of ids) {
    if (token.stop) { reason = 'Stopped.'; break; }
    try {
      const result = await send('PORTFOLIO_INSIGHT', { assetId });
      if (scan !== token || data !== target) return; // a new inventory was loaded
      data.insights[assetId] = result.insight;
      token.streak = 0;
    } catch (error) {
      if (scan !== token || data !== target) return;
      token.failed++; token.streak++;
      if (error.stop || token.streak >= 3) { reason = `Stopped: ${error.message}${error.stop ? ' Try again later.' : ''}`; token.done++; break; }
    }
    token.done++;
    refresh();
  }
  if (scan !== token) return;
  scan = null;
  $('deep-status').dataset.final = '1';
  refresh();
  $('deep-status').textContent = reason || `Deep scan finished: ${token.done - token.failed} of ${token.total} items have model odds${token.failed ? ` (${token.failed} failed)` : ''}.`;
  setTimeout(() => { delete $('deep-status').dataset.final; }, 0);
  if (done) done();
}

// ---------- risk breakdown ----------
function renderRisk() {
  const r = analysis.risk;
  const color = v => (v >= 65 ? '#cf222e' : v >= 35 ? '#d4a72c' : '#2da44e');
  const rows = [['Value drop / projected', r.meters.drop], ['Concentration', r.meters.concentration], ['Low demand / liquidity', r.meters.liquidity], ['Locked on hold', r.meters.hold]];
  $('meters').replaceChildren(...rows.map(([name, v]) => {
    const row = el('div', null, 'meter'), track = el('div', null, 'track'), fill = el('div', null, 'fill');
    fill.style.width = `${v}%`; fill.style.background = color(v); track.append(fill);
    row.append(el('span', name), track, el('span', String(v)));
    return row;
  }));
  $('drivers').replaceChildren(...r.drivers.filter(d => d.points > 0).map(d => el('li', `${d.label}: ${d.points} points`)));
  $('stats').textContent = analysis.totals.value
    ? `Top holding ${pct(r.top1)} · top 3 ${pct(r.top3)} · acts like ${r.effectiveN.toFixed(1)} equal-size items · value-weighted demand ${r.avgDemand == null ? 'n/a' : `${r.avgDemand.toFixed(1)} / 5`}`
    : '';
}

// ---------- holdings ----------
function oddsText(o) {
  if (!o) return '';
  return [7, 14, 30].filter(h => o.horizons[h]).map(h => `${h}D ↑${pct(o.horizons[h].up)} ↓${pct(o.horizons[h].down)}`).join(' · ');
}
function holdingRow(h) {
  const box = el('article', null, 'row'), top = el('div', null, 'top');
  const name = link(label(h), itemUrl(h.assetId)); name.className = 'name';
  top.append(name);
  if (h.copies > 1) top.append(el('span', `×${h.copies}`, 'badge'));
  if (h.onHold) top.append(el('span', `${h.onHold} on hold`, 'badge'));
  if (h.projected) top.append(el('span', 'Projected', 'badge warn'));
  if (h.hyped) top.append(el('span', 'Hyped', 'badge warn'));
  if (h.rare) top.append(el('span', 'Rare', 'badge'));
  if (!h.known) top.append(el('span', 'Not on Rolimon’s', 'badge warn'));
  else if (!h.valued) top.append(el('span', 'RAP only', 'badge'));
  if (data.isSelf && kept(h)) top.append(el('span', 'Protected', 'badge good'));
  top.append(el('span', `Risk ${h.risk.score}`, `pill ${R.levelOf(h.risk.score)}`));
  const out = el('span', OUTLOOK[h.risk.outlook], `out-${h.risk.outlook}`);
  top.append(out);
  box.append(top);
  const gap = h.risk.rapGap != null ? ` (${signed(Math.round((h.risk.rapGap - 1) * 100), String)}%)` : '';
  const worth = h.valued ? `Value ${fmt(h.value)}` : h.rap != null ? `RAP ${fmt(h.rap)}` : 'No value';
  const parts = [`${worth}${h.valued && h.rap != null ? ` · RAP ${fmt(h.rap)}${gap}` : ''}`, `${pct(h.weight)} of portfolio (${fmt(h.total)})`,
    `Demand ${DEMAND[h.demandScore]}`, h.trend != null ? `Trend ${TREND[h.trend]}` : null].filter(Boolean);
  box.append(el('div', parts.join(' · '), 'meta'));
  const insight = data.insights[h.assetId];
  const extra = [];
  if (h.risk.odds) extra.push(`Model odds: ${oddsText(h.risk.odds)}`);
  if (fresh(insight)) {
    if (insight.rap30 != null) extra.push(`RAP 30D ${signed(Math.round(insight.rap30 * 10) / 10, String)}%`);
    if (insight.salesPerDay != null) extra.push(`${insight.salesPerDay} sales/day`);
    if (insight.sellers != null) extra.push(`${insight.sellers} sellers`);
  }
  if (extra.length) box.append(el('div', extra.join(' · '), 'meta'));
  if (h.risk.signals.length) box.append(el('div', h.risk.signals.join(' · '), 'sig'));
  if (h.serials.length) box.append(el('div', `Serials: ${h.serials.slice(0, 10).map(s => `#${s}`).join(', ')}${h.serials.length > 10 ? ', …' : ''}`, 'sig'));
  const tools = el('div', null, 'tools');
  if (h.valued && !fresh(insight)) {
    const b = el('button', 'Get model odds'); b.type = 'button'; b.disabled = !!scan;
    b.addEventListener('click', () => deepScan([h.assetId]));
    tools.append(b);
  }
  if (data.isSelf && h.instanceIds.length) {
    const box2 = el('label'), check = el('input');
    check.type = 'checkbox'; check.checked = kept(h);
    check.addEventListener('change', () => setKeep(h.instanceIds, check.checked, check));
    box2.append(check, document.createTextNode(' Never offer in deal finder'));
    tools.append(box2);
  }
  if (tools.childNodes.length) box.append(tools);
  return box;
}

function renderHoldings() {
  const f = $('filter').value, s = $('sort').value, keep = keepSet();
  const acted = new Set(analysis.actions.filter(a => a.priority > 0 && a.kind !== 'hold').flatMap(a => [String(a.assetId ?? ''), ...a.instanceIds]));
  let list = analysis.holdings.filter(h =>
    f === 'action' ? acted.has(String(h.assetId)) || h.instanceIds.some(id => acted.has(id))
      : f === 'raise' ? h.risk.outlook === 'raise'
        : f === 'held' ? h.onHold > 0
          : f === 'protected' ? h.instanceIds.some(id => keep.has(id)) : true);
  const down = h => h.risk.odds?.down ?? h.risk.dropRisk / 100 * 0.5, up = h => h.risk.odds?.up30 ?? -1;
  const sorters = {
    risk: (a, b) => b.risk.score - a.risk.score || b.total - a.total,
    value: (a, b) => b.total - a.total,
    down: (a, b) => down(b) - down(a) || b.total - a.total,
    up: (a, b) => up(b) - up(a) || b.total - a.total,
    gap: (a, b) => (a.risk.rapGap ?? 9) - (b.risk.rapGap ?? 9) || b.total - a.total
  };
  list = [...list].sort(sorters[s] || sorters.risk);
  $('holdings').replaceChildren(...(list.length ? list.map(holdingRow) : [el('div', data.copies.length ? 'No items match this filter.' : 'No tradable limiteds in this inventory.', 'empty')]));
}

// ---------- what-if ----------
function fillWhatIf() {
  const catalog = data.catalog;
  const worth = c => catalog[c.assetId]?.value ?? catalog[c.assetId]?.rap ?? 0;
  $('give').replaceChildren(...[...data.copies].sort((a, b) => worth(b) - worth(a)).map(c => {
    const item = catalog[c.assetId];
    const text = `${item?.name || c.name}${c.serialNumber ? ` #${c.serialNumber}` : ''} (${item ? fmt(worth(c)) : 'no value'}${item && item.value == null ? ' RAP' : ''})${c.isOnHold ? ' · on hold' : ''}`;
    const option = new Option(text, c.instanceId); option.disabled = c.isOnHold;
    return option;
  }));
  items = Object.entries(catalog).map(([id, x]) => ({ id: Number(id), name: x.name, acronym: x.acronym || '', worth: x.value ?? x.rap ?? 0 }))
    .sort((a, b) => b.worth - a.worth);
  $('items').replaceChildren(...items.map(x => new Option(`${x.name}${x.acronym ? ` (${x.acronym})` : ''} · #${x.id}`)));
  for (let i = 1; i <= 4; i++) $(`get-${i}`).value = '';
  $('sim-odds').hidden = true;
}

// Accepts "Name (ACR) · #id", a bare ID, an exact acronym or an exact name.
function resolveItem(text) {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/#(\d{1,15})\s*$/) || t.match(/^(\d{1,15})$/);
  if (m && Object.hasOwn(data.catalog, m[1])) return Number(m[1]);
  const low = t.toLowerCase();
  const by = fn => items.filter(fn);
  const acr = by(x => x.acronym && x.acronym.toLowerCase() === low);
  if (acr.length === 1) return acr[0].id;
  const named = by(x => x.name.toLowerCase() === low);
  if (named.length === 1) return named[0].id;
  throw new Error(acr.length > 1 || named.length > 1 ? `“${t}” matches several items. Pick one from the list.` : `Couldn’t find “${t}”. Pick an item from the list.`);
}

function simInputs() {
  const give = [...$('give').selectedOptions].map(o => o.value);
  const get = [1, 2, 3, 4].map(i => resolveItem($(`get-${i}`).value)).filter(id => id != null);
  return { give, get };
}

function simulate(silent = false) {
  if (!data) return;
  let result;
  try {
    const input = silent && lastSim ? lastSim : simInputs();
    result = R.simulate(data.copies, data.catalog, data.insights, input.give, input.get);
    lastSim = input;
  } catch (error) {
    if (!silent) $('sim-result').replaceChildren(el('p', error.message, 'warnings'));
    return;
  }
  const b = result.before, a = result.after;
  const rows = [
    ['Total value', b.totals.value, a.totals.value, fmt, 1],
    ['RAP', b.totals.rap, a.totals.rap, fmt, 1],
    ['Risk score', b.risk.score, a.risk.score, String, -1],
    ['Value-drop meter', b.risk.meters.drop, a.risk.meters.drop, String, -1],
    ['Concentration', b.risk.meters.concentration, a.risk.meters.concentration, String, -1],
    ['Low demand / liquidity', b.risk.meters.liquidity, a.risk.meters.liquidity, String, -1],
    ['Top holding', b.risk.top1 * 100, a.risk.top1 * 100, n => `${Math.round(n)}%`, -1],
    ['Items', b.totals.unique, a.totals.unique, String, 0]
  ];
  const table = el('table'), head = el('tr');
  head.append(el('th', ''), el('th', 'Before'), el('th', 'After'), el('th', 'Change'));
  table.append(head);
  for (const [name, x, y, f, good] of rows) {
    const tr = el('tr'), d = y - x;
    const cell = el('td', d ? signed(d, f === String ? n => String(Math.round(n)) : f) : '–', good && d ? (d * good > 0 ? 'up' : 'down') : '');
    tr.append(el('td', name), el('td', f(x)), el('td', f(y)), cell);
    table.append(tr);
  }
  const names = list => list.map(x => x.name).join(', ') || 'nothing';
  const summary = el('p', `You give ${names(result.give)} (${fmt(result.giveValue)}) and get ${names(result.get)} (${fmt(result.getValue)}): ${signed(result.gain)}${result.gainPct != null ? ` (${signed(result.gainPct, String)}%)` : ''}.`);
  summary.style.fontWeight = '600';
  const out = [summary, table];
  if (result.warnings.length) { const ul = el('ul', null, 'warnings'); ul.append(...result.warnings.map(w => el('li', w))); out.push(ul); }
  if (result.newActions.length || result.resolvedActions.length) {
    const ul = el('ul', null, 'changes');
    ul.append(...result.resolvedActions.map(x => el('li', `Resolves: ${x.title}`, 'up')), ...result.newActions.map(x => el('li', `New: ${x.title}`, 'down')));
    out.push(ul);
  } else if (!result.warnings.length) out.push(el('p', 'No new warnings or advisor changes from this trade.', 'changes'));
  out.push(el('small', `Verdict after: ${a.verdict.text}`));
  $('sim-result').replaceChildren(...out);
  // Offer model odds for received items we haven't scanned.
  const missing = [...new Set(result.get.filter(x => x.value != null && !fresh(data.insights[x.assetId])).map(x => x.assetId))];
  $('sim-odds').hidden = !missing.length;
  $('sim-odds').dataset.ids = missing.join(',');
}

// ---------- events ----------
$('lookup').addEventListener('submit', event => { event.preventDefault(); load($('target').value.trim()); });
$('mine').addEventListener('click', () => { $('target').value = ''; load(''); });
$('deep-run').addEventListener('click', () => deepScan(pendingDeep()));
$('deep-stop').addEventListener('click', () => { if (scan) { scan.stop = true; $('deep-status').textContent = 'Stopping after the current item…'; } });
$('filter').addEventListener('change', () => data && renderHoldings());
$('sort').addEventListener('change', () => data && renderHoldings());
$('simulate').addEventListener('click', () => simulate(false));
$('sim-reset').addEventListener('click', () => {
  for (const o of $('give').options) o.selected = false;
  for (let i = 1; i <= 4; i++) $(`get-${i}`).value = '';
  lastSim = null; $('sim-result').replaceChildren(); $('sim-odds').hidden = true;
});
$('sim-odds').addEventListener('click', () => {
  const ids = ($('sim-odds').dataset.ids || '').split(',').map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  deepScan(ids, () => simulate(true));
});

const query = new URLSearchParams(location.search).get('user');
if (query && /^[A-Za-z0-9_]{1,25}$/.test(query)) $('target').value = query;
send('PORTFOLIO_STATUS').then(result => {
  fillRecent(result.recent);
  status('Enter a Roblox user ID or username and press Analyze, or load your own inventory.');
}, error => status(error.message));
setBusy();
