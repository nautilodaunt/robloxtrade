(() => {
  const el = id => document.getElementById(`mass-${id}`);
  const wanted = [1, 2, 3, 4].map(i => el(`wanted-${i}`));
  const tagBoxes = [...document.querySelectorAll('#mass-tags input[type="checkbox"]')];
  const settings = [el('mode'), el('minutes'), el('max')];
  let catalog = {}, previewId = null, busy = false, running = false;
  const fmt = n => (Number.isFinite(n) ? n.toLocaleString() : '?');
  const worth = id => catalog[id]?.value ?? catalog[id]?.rap ?? null;
  const message = async (type, extra = {}) => {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Reload the extension and try again.');
    return result.state;
  };
  function lock(locked) {
    [el('offer'), ...wanted, ...settings].forEach(input => { input.disabled = locked; });
    tagBoxes.forEach(box => { box.disabled = locked || el('mode').value !== 'flexible'; });
  }
  function invalidate() {
    previewId = null; el('confirm').checked = false; el('start').disabled = true;
    el('review').textContent = '';
  }
  // Everything is rendered as text: names come from Roblox/Rolimon's and are never parsed as HTML.
  function describe(state) {
    const rule = state.rules, item = i => `${i.name}${i.serialNumber ? ` #${i.serialNumber}` : ''} (${fmt(i.value)})`;
    const watch = !rule.minutes ? 'current ads only' : state.enabled && state.endsAt
      ? `watching new ads until ${new Date(state.endsAt).toLocaleTimeString()}` : `keeps watching new ads for ${rule.minutes} min`;
    const rows = state.targets.map(t => `• ${t.name} (${t.userId}): ${t.outcome}${t.tradeId ? `, trade ${t.tradeId}` : ''}${t.why ? ` [${t.why}]` : ''}`);
    return [`Account: ${state.username} (${state.userId})`,
      `YOU GIVE: ${state.giving.map(item).join(', ')}`,
      `YOU GET: ${state.receiving.map(item).join(', ')}`,
      `Value: ${fmt(state.estimate?.give)} → ${fmt(state.estimate?.receive)}${state.estimate?.rapFallbacks ? ' (some use RAP)' : ''}. Robux: 0 on both sides.`,
      `Rules: ${rule.mode === 'flexible' ? `exact ads + tags (${rule.tags.join(', ') || 'none'})` : 'exact ads only'}; ${watch}; max ${rule.maxTrades} trades, 1 per minute.`,
      '', `Recipients (${rows.length}):`,
      ...(rows.length ? rows : [rule.minutes ? 'None yet. New matching ads are added while it runs.' : 'None.'])].join('\n');
  }
  function render(state) {
    running = state.enabled === true;
    el('status').textContent = state.status || '';
    el('review').textContent = state.giving && state.rules && state.targets ? describe(state) : '';
    lock(running);
    el('preview').disabled = busy || running || !Object.keys(catalog).length;
    el('load').disabled = busy || running;
    if (running || !state.previewId) previewId = null;
    el('start').disabled = busy || !previewId || !el('confirm').checked;
  }
  async function run(fn) {
    busy = true; el('load').disabled = true; el('preview').disabled = true; el('start').disabled = true;
    try { await fn(); } catch (error) { invalidate(); el('status').textContent = error.message; }
    finally {
      busy = false;
      // Preserve errors while unlocking controls.
      el('load').disabled = running;
      el('preview').disabled = running || !Object.keys(catalog).length;
      el('start').disabled = !previewId || !el('confirm').checked;
    }
  }
  const resolve = text => {
    if (/^[1-9]\d*$/.test(text)) return catalog[text] ? Number(text) : null;
    const query = text.toLowerCase();
    const hits = Object.keys(catalog).filter(id => catalog[id].name.toLowerCase() === query || catalog[id].acronym?.toLowerCase() === query);
    return hits.length === 1 ? Number(hits[0]) : null;
  };
  el('load').addEventListener('click', () => run(async () => {
    invalidate();
    el('status').textContent = 'Loading your tradable items…';
    const data = await message('MASS_LOAD');
    catalog = data.catalog || {};
    el('account').textContent = `Signed in: ${data.user.name} (${data.user.id})`;
    const usable = data.inventory.filter(i => !i.isOnHold).sort((a, b) => (worth(b.assetId) ?? -1) - (worth(a.assetId) ?? -1));
    el('offer').replaceChildren(...usable.map(i => {
      const option = document.createElement('option'); option.value = i.instanceId;
      option.textContent = `${i.name}${i.serialNumber ? ` #${i.serialNumber}` : ''} (${worth(i.assetId) == null ? 'no value' : fmt(worth(i.assetId))})`;
      return option;
    }));
    const held = data.inventory.length - usable.length;
    el('status').textContent = data.valuesError ? `Loaded ${usable.length} items, but Rolimon's values failed: ${data.valuesError} Try again in a minute.`
      : usable.length ? `Loaded ${usable.length} tradable items${held ? ` (${held} on hold hidden)` : ''}. Pick what you give and what you want.`
      : `No tradable limiteds found for ${data.user.name}${held ? ` (${held} on hold)` : ''}.`;
  }));
  el('offer').addEventListener('change', () => {
    invalidate();
    if (el('offer').selectedOptions.length > 4) el('status').textContent = 'You can give at most 4 items.';
  });
  [...settings, ...tagBoxes].forEach(input => input.addEventListener('change', () => { invalidate(); lock(running); }));
  wanted.forEach(input => input.addEventListener('input', () => {
    invalidate();
    const query = input.value.trim().toLowerCase();
    const options = query ? Object.entries(catalog).filter(([id, item]) => id.startsWith(query) ||
      item.name.toLowerCase().includes(query) || item.acronym?.toLowerCase().startsWith(query)).slice(0, 40) : [];
    el('items').replaceChildren(...options.map(([id, item]) => {
      const option = document.createElement('option'); option.value = id;
      option.label = `${item.name}${item.acronym ? ` (${item.acronym})` : ''}: ${fmt(item.value ?? item.rap)}`; return option;
    }));
  }));
  el('preview').addEventListener('click', () => run(async () => {
    invalidate();
    const typed = wanted.map(input => input.value.trim()).filter(Boolean), requested = typed.map(resolve);
    if (!typed.length || requested.includes(null)) throw new Error('Pick each item you want from the suggestions (name, acronym or ID).');
    const state = await message('MASS_PREVIEW', { config: {
      offerInstanceIds: [...el('offer').selectedOptions].map(option => option.value), wanted: requested,
      mode: el('mode').value, tags: tagBoxes.filter(box => box.checked).map(box => box.value),
      minutes: Number(el('minutes').value), maxTrades: Number(el('max').value) } });
    previewId = state.targets.length || state.rules.minutes ? state.previewId : null; render(state);
  }));
  el('confirm').addEventListener('change', () => { el('start').disabled = busy || !previewId || !el('confirm').checked; });
  el('start').addEventListener('click', () => run(async () => {
    const id = previewId; previewId = null;
    render(await message('MASS_START', { previewId: id }));
  }));
  el('stop').addEventListener('click', async () => {
    invalidate();
    try { render(await message('MASS_STOP')); } catch (error) { el('status').textContent = error.message; }
  });
  const refresh = async () => {
    if (busy) return;
    try { render(await message('MASS_STATUS')); } catch (error) { el('status').textContent = error.message; }
  };
  lock(false);
  refresh(); setInterval(() => { if (running) refresh(); }, 3000);
})();
