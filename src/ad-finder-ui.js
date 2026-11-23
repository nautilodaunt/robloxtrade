(() => {
  const el = id => document.getElementById(`finder-${id}`);
  if (!el('scan')) return;
  let busy = false;
  let hydrated = false;

  async function send(type, extra = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || 'Reload the extension and try again.');
    return result.state;
  }

  function readFilters() {
    return {
      minValue: el('min-value').value.trim(),
      maxValue: el('max-value').value.trim(),
      maxTradeAds: el('max-ads').value.trim(),
      minDemand: Number(el('demand').value),
      itemQuery: el('items').value.trim()
    };
  }

  function hydrateFilters(filters) {
    if (!filters || hydrated) return;
    hydrated = true;
    el('min-value').value = filters.minValue ?? 10000;
    el('max-value').value = filters.maxValue ?? '';
    el('max-ads').value = filters.maxTradeAds ?? 150;
    el('demand').value = String(filters.minDemand ?? 4);
    el('items').value = filters.itemQuery || '';
  }

  function formatAge(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }

  function formatItemLabel(item) {
    const prefix = item.acronym ? `${item.acronym} (${item.name})` : item.name;
    const price = item.value != null ? item.value.toLocaleString() : 'N/A';
    return `${prefix} — ${price}${item.demandLabel ? ` · ${item.demandLabel}` : ''}`;
  }

  function renderMatchCard(match) {
    const card = document.createElement('article');
    card.className = 'finder-card';

    const top = document.createElement('div');
    top.className = 'finder-card-top';

    const badge = document.createElement('span');
    badge.className = 'finder-badge';
    badge.textContent = `${match.tradeAdCount.toLocaleString()} trade ad${match.tradeAdCount === 1 ? '' : 's'}`;

    const user = document.createElement('strong');
    user.textContent = match.username;

    const age = document.createElement('span');
    age.className = 'finder-age';
    age.textContent = formatAge(match.timestamp);

    top.append(badge, user, age);

    const highlight = document.createElement('div');
    highlight.className = 'finder-highlight';
    highlight.textContent = `Target: ${(match.matchedItems || []).map(formatItemLabel).join(', ')}`;

    const offerLine = document.createElement('div');
    offerLine.className = 'finder-side';
    const offerParts = (match.offerItems || []).map(i => i.acronym || i.name);
    if (match.offerRobux) offerParts.push(`${match.offerRobux.toLocaleString()} R$`);
    offerLine.textContent = `Offering (${match.offerTotal.toLocaleString()}): ${offerParts.join(', ')}`;

    const requestLine = document.createElement('div');
    requestLine.className = 'finder-side';
    const requestParts = [
      ...(match.requestItems || []).map(i => i.acronym || i.name),
      ...(match.requestTags || []).map(tag => `[${tag}]`)
    ];
    if (match.requestRobux) requestParts.push(`${match.requestRobux.toLocaleString()} R$`);
    requestLine.textContent = `Requesting${match.requestTotal ? ` (${match.requestTotal.toLocaleString()})` : ''}: ${requestParts.join(', ') || 'None'}`;

    const links = document.createElement('div');
    links.className = 'finder-links';

    // Build links from the numeric user ID; never trust URLs read from storage.
    const userId = /^[1-9]\d*$/.test(String(match.userId)) ? String(match.userId) : '';
    if (userId) {
      const tradeLink = document.createElement('a');
      tradeLink.href = `https://www.roblox.com/users/${userId}/trade`;
      tradeLink.target = '_blank';
      tradeLink.rel = 'noopener';
      tradeLink.textContent = 'Send Roblox trade ↗';

      const profileLink = document.createElement('a');
      profileLink.href = `https://www.rolimons.com/player/${userId}`;
      profileLink.target = '_blank';
      profileLink.rel = 'noopener';
      profileLink.textContent = 'Rolimon’s profile ↗';
      links.append(tradeLink, profileLink);
    }
    card.append(top, highlight, offerLine, requestLine, links);
    return card;
  }

  function render(state) {
    hydrateFilters(state.filters);
    el('auto').textContent = state.enabled ? 'Stop auto-scan' : 'Auto-scan (1m)';
    el('status').textContent = `${state.enabled ? 'Auto-scan ON · ' : ''}${state.status || ''}`;
    const list = el('results');
    if (!state.matches?.length) {
      list.replaceChildren();
      return;
    }
    list.replaceChildren(...state.matches.map(renderMatchCard));
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    el('scan').disabled = true;
    el('auto').disabled = true;
    el('clear').disabled = true;
    try {
      await action();
    } catch (error) {
      el('status').textContent = error.message;
    } finally {
      busy = false;
      el('scan').disabled = false;
      el('auto').disabled = false;
      el('clear').disabled = false;
    }
  }

  el('scan').addEventListener('click', () => run(async () => {
    el('status').textContent = 'Scanning Rolimon’s recent trade ads & checking poster trade counts…';
    render(await send('FINDER_SCAN', { filters: readFilters() }));
  }));

  el('auto').addEventListener('click', () => run(async () => {
    const current = await send('FINDER_STATUS');
    const nextEnabled = !current.enabled;
    if (nextEnabled) el('status').textContent = 'Starting auto-scan & checking poster trade counts…';
    render(await send('FINDER_SET_AUTO', { enabled: nextEnabled, filters: readFilters() }));
  }));

  el('clear').addEventListener('click', () => run(async () => {
    render(await send('FINDER_CLEAR'));
  }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lowTraderAdFinder?.newValue && !busy) {
      render(changes.lowTraderAdFinder.newValue);
    }
  });

  (async () => {
    try { render(await send('FINDER_STATUS')); }
    catch (error) { el('status').textContent = error.message; }
  })();
})();
