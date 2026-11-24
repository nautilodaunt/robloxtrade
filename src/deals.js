const $ = id => document.getElementById(id);
const DEMAND = { 0: 'Terrible', 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Amazing' };
const fmt = n => Number(n || 0).toLocaleString();
let busy = false, current = null;

async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'No response. Reload the extension.');
  return result.state;
}

function settings() {
  return {
    minGainPct: $('min-gain').value, maxGainPct: $('max-gain').value, minDemand: $('min-demand').value,
    specific: $('specific').checked, tagOnly: $('tag-only').checked,
    tags: [...document.querySelectorAll('#tags input:checked')].map(x => x.value),
    // Before the inventory list exists, keep the saved list instead of wiping it.
    keep: $('keep').options.length ? [...$('keep').selectedOptions].map(o => o.value) : [...(current?.settings?.keep || [])]
  };
}

function fillSettings(s) {
  $('min-gain').value = s.minGainPct; $('max-gain').value = s.maxGainPct; $('min-demand').value = String(s.minDemand);
  $('specific').checked = s.specific; $('tag-only').checked = s.tagOnly;
  for (const box of document.querySelectorAll('#tags input')) box.checked = s.tags.includes(box.value);
}

function fillInventory(state, useSaved) {
  const keep = new Set(useSaved ? state.settings.keep : [...$('keep').selectedOptions].map(o => o.value));
  const select = $('keep');
  select.replaceChildren(...[...state.inventory].sort((a, b) => (b.worth || 0) - (a.worth || 0)).map(c => {
    const label = `${c.name}${c.serialNumber ? ` #${c.serialNumber}` : ''} (${c.worth == null ? 'no value' : fmt(c.worth)}${c.valued ? '' : ' RAP'})${c.isOnHold ? ' · on hold' : ''}`;
    const option = new Option(label, c.instanceId, false, keep.has(c.instanceId));
    option.disabled = c.isOnHold;
    return option;
  }));
  $('account').textContent = state.username
    ? `${state.username}: ${state.inventory.length} tradable copies (${state.inventory.filter(c => c.isOnHold).length} on hold).`
    : 'Not loaded.';
}

const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
function itemLine(item, worth) {
  const demand = item.demand != null && item.value != null ? `, ${DEMAND[item.demand]}` : '';
  const amount = item.value != null ? fmt(item.value) : item.rap != null ? `${fmt(item.rap)} RAP` : 'no value';
  return el('li', `${item.name}${item.acronym ? ` (${item.acronym})` : ''}: ${worth != null && item.value == null ? `${fmt(worth)} RAP` : amount}${demand}`);
}
function ago(at) {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

function card(deal) {
  const box = el('article', null, 'card');
  const top = el('div', null, 'top');
  const CONFIDENCE = { 3: 'They asked for this', 2: 'Upgrade premium', 1: 'Your lowball offer' };
  top.append(el('span', deal.name, 'who'), el('span', CONFIDENCE[deal.confidence] || 'Offer', 'badge'),
    el('span', deal.tags.join(' / '), 'badge'), el('span', `posted ${ago(deal.at)}`));
  if (deal.posts > 1) top.append(el('span', `reposted ×${deal.posts}`, 'badge'));
  top.append(el('span', `+${fmt(deal.gain)} (${deal.gainPct}%)`, 'gain'));
  const sides = el('div', null, 'sides');
  const side = (title, items, total, worthKey) => {
    const wrap = el('div', null, 'side'), list = el('ul');
    list.append(...items.map(item => itemLine(item, worthKey ? item[worthKey] : null)));
    wrap.append(el('h3', title), list, el('div', `Total ${fmt(total)}`, 'total'));
    return wrap;
  };
  sides.append(side('You get', deal.get, deal.getValue), side('You give', deal.give, deal.giveValue, 'worth'));
  box.append(top, sides);
  const warnings = [];
  if (deal.getDemand != null && deal.giveDemand != null && deal.getDemand < deal.giveDemand) warnings.push(`You'd get lower demand (${deal.getDemand} vs ${deal.giveDemand} out of 5).`);
  if (deal.rapIgnored) warnings.push(`${deal.rapIgnored} RAP-only item${deal.rapIgnored > 1 ? 's' : ''} on their side counted as 0.`);
  if (deal.overMax) warnings.push('Gain is bigger than your max %: double-check the values before offering.');
  if (warnings.length) box.append(el('div', warnings.join(' '), 'warn'));
  // Links are built only from the numeric user ID.
  if (Number.isSafeInteger(deal.userId) && deal.userId > 0) {
    const links = el('div', null, 'links');
    const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
    links.append(link('Open Roblox trade ↗', `https://www.roblox.com/users/${deal.userId}/trade`),
      link('Rolimon’s profile ↗', `https://www.rolimons.com/player/${deal.userId}`));
    box.append(links);
  }
  return box;
}

function render(state) {
  const first = !current;
  // The portfolio page can change "never offer"; take the saved list instead of the old selection.
  const keepChanged = !first && JSON.stringify(current.settings?.keep || []) !== JSON.stringify(state.settings?.keep || []);
  current = state;
  if (first) fillSettings(state.settings);
  fillInventory(state, first || keepChanged);
  $('status').textContent = state.status || '';
  $('scan').disabled = busy || !state.userId;
  $('stop').disabled = busy || !(state.watchUntil > Date.now());
  $('results').replaceChildren(...(state.deals.length ? state.deals.map(card)
    : [el('div', state.userId ? 'No value deals yet. Try watching for a while, widening the gain range, or enabling more tags.' : 'Load your inventory to begin.', 'empty')]));
}

async function run(type, extra) {
  if (busy) return;
  busy = true; $('load').disabled = $('scan').disabled = true;
  $('status').textContent = type === 'DEALS_LOAD' ? 'Loading your inventory…' : type === 'DEALS_SCAN' ? 'Scanning trade ads…' : 'Working…';
  try { const state = await send(type, extra); busy = false; render(state); }
  catch (error) { busy = false; $('status').textContent = error.message; if (current) render({ ...current, status: error.message }); }
  finally { busy = false; $('load').disabled = false; }
}

$('load').addEventListener('click', () => run('DEALS_LOAD'));
$('scan').addEventListener('click', () => run('DEALS_SCAN', { settings: settings(), minutes: Number($('minutes').value) }));
$('stop').addEventListener('click', () => run('DEALS_STOP'));
$('clear').addEventListener('click', () => run('DEALS_CLEAR'));
// Live updates while watching (the worker rescans every minute).
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'session' && changes.valueDeals?.newValue && !busy) render(changes.valueDeals.newValue);
});
setInterval(() => { if (current && !busy) render(current); }, 30000);
send('DEALS_STATUS').then(render, error => { $('status').textContent = error.message; });
