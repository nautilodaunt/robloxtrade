(() => {
  const el = id => document.getElementById(`mass-${id}`);
  const wanted = [1, 2, 3, 4].map(i => el(`wanted-${i}`));
  let catalog = {}, previewId = null, busy = false, running = false;
  const message = async (type, extra = {}) => {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Reload the extension and try again.');
    return result.state;
  };
  function invalidate() {
    previewId = null; el('confirm').checked = false; el('start').disabled = true;
    el('review').textContent = '';
  }
  function render(state) {
    running = state.enabled === true;
    el('status').textContent = state.status;
    const offer = state.giving?.map(i => `${i.name} [catalog ${i.assetId}, copy ${i.userAssetId}${i.serialNumber ? `, serial #${i.serialNumber}` : ''}]`).join('\n');
    const receive = state.receiving?.map(i => `${i.name} [catalog ${i.assetId}]`).join('\n');
    el('review').textContent = offer ?
      `Account: ${state.username} (${state.userId})\n\nYOU GIVE (${state.giving.length}):\n${offer}\n\nYOU RECEIVE (${state.receiving.length}):\n${receive}\n\nRobux: 0 on each side\nEstimated value: ${state.estimate.give.toLocaleString()} → ${state.estimate.receive.toLocaleString()}${state.estimate.rapFallbacks ? '\nIncludes RAP fallback estimates.' : ''}\n\nRecipients:\n${state.targets.map(t => `${t.name} (${t.userId}): ${t.outcome}${t.tradeId ? ` — trade ${t.tradeId}` : ''}`).join('\n') || 'No exact matches in this recent-ad snapshot.'}` : '';
    el('offer').disabled = state.enabled === true;
    wanted.forEach(input => { input.disabled = state.enabled === true; });
    el('preview').disabled = busy || state.enabled === true || !Object.keys(catalog).length;
    el('load').disabled = busy || state.enabled === true;
    if (state.enabled || !state.previewId) previewId = null;
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
  el('load').addEventListener('click', () => run(async () => {
    invalidate();
    const data = await message('MASS_LOAD');
    catalog = data.catalog;
    el('account').textContent = `Signed in: ${data.user.name} (${data.user.id})`;
    el('offer').replaceChildren(...data.inventory.filter(i => i.isOnHold === false).map(i => {
      const option = document.createElement('option'); option.value = i.userAssetId;
      option.textContent = `${i.name} — ${i.serialNumber ? `#${i.serialNumber} — ` : ''}copy ${i.userAssetId}`;
      return option;
    }));
    el('status').textContent = 'Inventory loaded. Choose your exact trade.';
  }));
  el('offer').addEventListener('change', invalidate);
  wanted.forEach(input => input.addEventListener('input', () => {
    invalidate();
    const query = input.value.trim().toLowerCase();
    const options = Object.entries(catalog).filter(([id, item]) => query && (id.includes(query) || item.name.toLowerCase().includes(query))).slice(0, 40);
    el('items').replaceChildren(...options.map(([id, item]) => {
      const option = document.createElement('option'); option.value = id; option.label = item.name; return option;
    }));
  }));
  el('preview').addEventListener('click', () => run(async () => {
    invalidate();
    const requested = wanted.map(input => input.value.trim()).filter(Boolean);
    if (requested.some(id => !/^[1-9]\d*$/.test(id) || !catalog[id])) throw new Error('Choose each requested item from the search suggestions (catalog ID).');
    const state = await message('MASS_PREVIEW', { config: {
      offerCopyIds: [...el('offer').selectedOptions].map(option => Number(option.value)), wanted: requested.map(Number)
    } });
    previewId = state.targets.length ? state.previewId : null; render(state);
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
  refresh(); setInterval(() => { if (running) refresh(); }, 3000);
})();
