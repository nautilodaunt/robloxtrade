(() => {
  const ROW_CLASS = "rta-value-row";
  const ITEM_LINK = 'a[href*="/catalog/"], a[href*="/library/"], a[href*="/bundles/"]';
  const CARD = '.item-card-container, .item-card, .list-item, li, [data-user-asset-id], [data-userasset-id]';
  const SIDE = '.trade-offer, .trade-request, .trade-offer-container, .trade-request-container';
  function createLogo() {
    // Exact navigation logo from https://rolimons.com/.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 1094 1466.2');
    svg.setAttribute('class', 'rta-logo');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', '#0084dd');
    path.setAttribute('d', 'M1094 521.6 0 0v469.5l141-67.4 250 119.2L0 707.8v369.7l815.6 388.7L315 893l779-371.4z');
    svg.append(path);
    return svg;
  }

  let data = null;
  let loading = false;
  let nextFetch = 0;
  let timer;

  function assetId(link) {
    try {
      const url = new URL(link.getAttribute("href"), location.href);
      if (!/(^|\.)roblox\.com$/.test(url.hostname)) return null;
      if (url.pathname.startsWith('/bundles/')) {
        return TradeValues.resolveBundle(url.href, data?.items || {}) || `bundle:${url.pathname.split('/')[2]}`;
      }
      return url.pathname.match(/^\/(?:catalog|library)\/(\d+)(?:\/|$)/)?.[1] ?? null;
    } catch { return null; }
  }

  function itemIds(links) {
    const cardsSeen = new Set();
    const ids = [];
    for (const link of links) {
      const id = assetId(link);
      if (!id) continue;
      // Image and title links in one card count once. Separate copies of an
      // identical limited in different cards must each contribute to the total.
      const card = link.closest(CARD);
      const key = card || id;
      if (cardsSeen.has(key)) continue;
      cardsSeen.add(key);
      ids.push(id);
    }
    return ids;
  }

  function robuxRows() {
    const candidates = [...document.querySelectorAll(
      '.robux-line, .trade-robux, .trade-currency, .robux-container'
    )];
    // Text labels also support trade layouts without the older class names.
    for (const label of document.querySelectorAll('span, label, div, p')) {
      if (label.closest(`.${ROW_CLASS}`) || label.children.length) continue;
      if (/^Robux(?:\s*\([^)]*\))?\s*:?$/i.test(label.textContent.trim())) {
        candidates.push(label.parentElement);
      }
    }
    return [...new Set(candidates)].filter(row =>
      !row.closest(`.${ROW_CLASS}`) &&
      !candidates.some(other => other !== row && row.contains(other))
    );
  }

  function modernSides() {
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
      .filter(el => /^Items you (?:will give|will receive|gave|received)$/i.test(el.textContent.trim()));
    if (headings.length !== 2) return [];
    let boundary = headings[0].parentElement;
    while (boundary && !boundary.contains(headings[1])) boundary = boundary.parentElement;
    if (!boundary) return [];
    return headings.map((heading, index) => {
      const range = document.createRange();
      range.setStartAfter(heading);
      if (headings[index + 1]) range.setEndBefore(headings[index + 1]);
      else range.setEnd(boundary, boundary.childNodes.length);
      const inside = el => range.intersectsNode(el) && !el.contains(heading);
      const links = [...boundary.querySelectorAll(ITEM_LINK)].filter(inside);
      const labels = [...boundary.querySelectorAll('span, label, div, p')].filter(el =>
        !el.children.length && /^(?:Total Value|Robux(?:\s*\([^)]*\))?)\s*:?$/i.test(el.textContent.trim()) && inside(el));
      const label = labels.at(-1);
      let anchor = label?.parentElement;
      // Never insert after a wrapper containing either entire offer.
      if (anchor && headings.some(h => anchor.contains(h))) anchor = label;
      if (!anchor) anchor = links.at(-1)?.closest('ul, .item-cards') || links.at(-1)?.parentElement;
      const currency = range.cloneContents().textContent.match(/Robux(?:\s+Offered)?(?:\s*\([^)]*\))?\s*:?\s*([\d,]+)/i);
      return anchor ? { key: heading, links, anchor, robux: currency ? Number(currency[1].replaceAll(',', '')) : 0 } : null;
    }).filter(Boolean);
  }

  function tradeSides() {
    const modern = modernSides();
    if (modern.length) return modern;
    const rows = robuxRows();
    const result = new Map();
    for (const robux of rows) {
      let side = robux.closest(SIDE);
      if (!side) {
        // Stop at the smallest section with offered item cards and one Robux
        // row, so the two offers and the inventory are never summed together.
        for (let parent = robux.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (rows.filter(row => parent.contains(row)).length > 1) break;
          if (parent.querySelector(ITEM_LINK)) { side = parent; break; }
        }
      }
      if (!side || result.has(side)) continue;
      if (rows.filter(row => side.contains(row)).length !== 1) continue;
      result.set(side, robux);
    }
    return [...result].map(([side, anchor]) => ({ key: side, links: [...side.querySelectorAll(ITEM_LINK)], anchor }));
  }

  const tradeCache = new Map();
  let listCache = { status: null, expires: 0, result: [] };
  let listLoading = false;
  let listError = '';
  const summaries = new Map();
  const number = n => n.toLocaleString('en-US');
  function comparison(offer, receive) {
    const delta = receive - offer;
    const percent = offer ? ` (${delta > 0 ? '+' : ''}${(delta / offer * 100).toFixed(1)}%)` : '';
    return { state: delta > 0 ? 'gain' : delta < 0 ? 'loss' : 'even',
      text: `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${number(Math.abs(delta))} Robux${percent} · ${delta > 0 ? 'Gain' : delta < 0 ? 'Loss' : 'Even'}` };
  }
  function paintSummary(host, give, receive, extra = '') {
    let box = summaries.get(host);
    if (!box) { box = document.createElement('div'); box.className = 'rta-trade-summary'; summaries.set(host, box); }
    const result = comparison(give, receive);
    box.dataset.result = result.state;
    const isList = tradeListRows().includes(host);
    const text = isList ? `Give ${number(give)}\nReceive ${number(receive)}\n${result.text.split(' · ')[0]}` : `Give ${number(give)} · Receive ${number(receive)}\n${result.text}${extra}`;
    if (box.textContent !== text) box.textContent = text;
    box.title = 'Estimated using current Rolimon’s values plus Robux. List receipts account for the 30% Robux fee; detail receipts use Roblox’s displayed amount. Not historical profit.';
    if (isList) {
      host.classList.add('rta-list-host');
      box.classList.add('rta-list-summary');
    }
    if (box.parentElement !== host) host.append(box);
    return box;
  }
  function tradeListStatus() {
    const statuses = { received: 'Inbound', inbound: 'Inbound', sent: 'Outbound', outbound: 'Outbound',
      completed: 'Completed', closed: 'Inactive', inactive: 'Inactive' };
    const selected = document.querySelector('[role="tab"][aria-selected="true"], [role="tab"][aria-current="page"], .rbx-tab.active, .nav-tabs .active');
    const dropdown = document.querySelector('#trade-type-dropdown, select[name="tradeType"], select[name="tradeStatus"]');
    const candidates = [selected?.textContent, dropdown?.selectedOptions?.[0]?.textContent,
      dropdown?.value, dropdown?.querySelector('.dropdown-toggle')?.textContent,
      dropdown?.getAttribute('aria-label'), dropdown?.textContent];
    const url = new URL(location.href);
    candidates.push(url.searchParams.get('tab'), url.searchParams.get('tradeType'), url.searchParams.get('tradeStatus'),
      ...url.hash.replace(/^#/, '').split(/[/?=&]/));
    for (const candidate of candidates) {
      const status = statuses[candidate?.trim().toLowerCase()];
      if (status) return status;
    }
    return 'Inbound';
  }
  function tradeListRows() {
    const legacy = [...document.querySelectorAll('.trade-row, .trade-list-item, .trade-row-container, [data-trade-id]')];
    // Current Roblox renders trade entries as buttons containing a partner link.
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(row =>
      row.querySelector('a[href*="/users/"]') &&
      /\b(Open|Pending|Completed|Expired|Declined|Closed|Inactive|Countered|Rejected|Processing)\b/i.test(row.textContent) &&
      /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(row.textContent));
    const candidates = [...new Set([...buttons, ...legacy])];
    return candidates.filter(row => !candidates.some(other => other !== row && other.contains(row)));
  }
  function normalizeTrade(result) {
    if (!result?.participantAOffer || !result?.participantBOffer) return result;
    return { ...result, offers: [result.participantAOffer, result.participantBOffer].map(offer => ({
      user: offer.user, robux: offer.robux,
      userAssets: offer.items.map(item => ({
        assetId: item.itemTarget?.itemType === 'Asset' ? item.itemTarget.targetId : `bundle:${item.itemTarget?.targetId}`,
        name: item.itemName, recentAveragePrice: item.recentAveragePrice
      }))
    })) };
  }
  async function getTradeData(query) {
    // Use Roblox's existing page origin and signed-in session. Chrome may withhold
    // a newly added extension host permission until the user grants it.
    if (typeof fetch === 'function') {
      const path = query.tradeId ? `v2/trades/${query.tradeId}` : `v1/trades/${query.status}?limit=100&sortOrder=Desc`;
      try {
        const response = await fetch(`https://trades.roblox.com/${path}`, {
          credentials: 'include', signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) return { ok: false, error: `Trade API returned ${response.status}` };
        return { ok: true, result: normalizeTrade(await response.json()) };
      } catch { /* Background request can work when page CORS is unavailable. */ }
    }
    const response = await chrome.runtime.sendMessage({ type: 'GET_TRADE_DATA', ...query });
    if (response?.ok) response.result = normalizeTrade(response.result);
    return response;
  }
  async function renderTradeList() {
    const rows = tradeListRows();
    if (!rows.length) return;
    if (Date.now() >= nextFetch) load();
    if (!data?.ok || listLoading) return;
    const status = tradeListStatus();
    listLoading = true;
    try {
      if (listCache.status !== status || Date.now() > listCache.expires) {
        const response = await getTradeData({ status });
        listError = response?.ok ? '' : response?.error || 'No trade API response';
        listCache = { status, expires: Date.now() + 60000, result: response?.ok ? response.result.data || [] : [] };
      }
      if (tradeListStatus() !== status) return;
      for (const row of rows) {
        // Roblox can reuse the same row when switching trade categories.
        summaries.get(row)?.remove();
        let id = row.getAttribute('data-trade-id') || row.querySelector('a[href*="tradeId="]')?.href.match(/tradeId=(\d+)/)?.[1];
        const partner = row.querySelector('a[href*="/users/"]')?.getAttribute('href')?.match(/\/users\/(\d+)/)?.[1];
        const username = row.querySelector('.trade-partner-name, .text-name, .trade-name')?.textContent.trim();
        if (!id) {
          let matches = listCache.result.filter(t => partner ? String(t.user?.id) === partner : username && [t.user?.name, t.user?.displayName].includes(username));
          const date = row.textContent.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0];
          if (matches.length > 1 && date) matches = matches.filter(t => new Date(t.created).toLocaleDateString('en-US') === date);
          if (matches.length === 1) id = String(matches[0].id);
        }
        if (!id) continue;
        let detail = tradeCache.get(id);
        if (!detail || Date.now() > detail.expires) {
          const response = await getTradeData({ tradeId: id });
          detail = { result: response?.ok ? response.result : null, error: response?.error, expires: Date.now() + 60000 };
          tradeCache.set(id, detail);
        }
        if (tradeListStatus() !== status || !row.isConnected) return;
        const offers = detail.result?.offers;
        const viewer = document.querySelector('meta[name="user-data"]')?.getAttribute('data-userid') ||
          document.querySelector('a[href*="/users/"][class*="nav"], #navbar a[href*="/users/"], .navbar a[href*="/users/"]')?.getAttribute('href')?.match(/\/users\/(\d+)/)?.[1];
        if (!viewer) listError = 'Cannot identify signed-in Roblox user';
        if (!detail.result) listError = detail.error || 'Trade details unavailable';
        if (offers?.length !== 2 || !viewer) continue;
        const own = offers.find(o => String(o.user?.id) === viewer);
        const other = offers.find(o => String(o.user?.id) !== viewer);
        if (!own || !other) continue;
        const totals = [own, other].map(o => {
          const items = { ...data.items };
          const ids = o.userAssets.map(a => {
            const id = String(a.assetId);
            if (items[id]?.value != null || items[id]?.rap != null) return id;
            const normalize = name => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const matches = Object.keys(data.items).filter(key => normalize(data.items[key].name) === normalize(a.name) && normalize(a.name));
            if (matches.length === 1) return matches[0];
            // Roblox supplies RAP even for assets missing from the value feed.
            if (Number.isFinite(a.recentAveragePrice) && a.recentAveragePrice >= 0)
              items[id] = { rap: a.recentAveragePrice, value: null };
            return id;
          });
          const result = TradeValues.totalItems(ids, items);
          return { ...result, total: result.total + (o === own ? o.robux : Math.round(o.robux * 0.7)) };
        });
        if (totals.some(t => t.missing || !Number.isFinite(t.total))) {
          summaries.get(row)?.remove(); continue;
        }
        paintSummary(row, totals[0].total, totals[1].total, `${totals.some(t => t.rapFallbacks) ? ' · RAP fallback' : ''}${data.stale ? ' · cached' : ''}`);
      }
    } finally {
      listLoading = false;
      if (tradeListStatus() !== status) { clearTimeout(timer); timer = setTimeout(render, 0); }
    }
  }

  const rendered = new Map();
  const itemRows = new Map();

  function renderItemValues(sides) {
    const active = new Set();
    for (const { links } of sides) {
      const cards = new Map();
      for (const link of links) {
        const id = assetId(link);
        if (!id) continue;
        const card = link.closest(CARD) || link;
        // A card can have separate thumbnail and title links.
        if (!cards.has(card)) cards.set(card, id);
      }
      for (const [card, id] of cards) {
        active.add(card);
        let row = itemRows.get(card);
        if (!row) {
          row = document.createElement('div');
          row.className = 'rta-item-value';
          itemRows.set(card, row);
        }
        const host = card.querySelector('.item-card-caption, .item-card-info') || card;
        if (row.parentElement !== host) host.append(row);
        const item = data?.items?.[id];
        const value = item?.value ?? item?.rap;
        let text = 'Loading…';
        let title = "Rolimon's item value";
        if (data?.ok) {
          text = value == null ? 'Unavailable' : value.toLocaleString('en-US');
          if (item?.value == null && item?.rap != null) { text += ' (RAP)'; title += ' — RAP fallback; no assigned value'; }
          if (value == null) title += ` — no data for ${id}`;
          if (data.stale) { text += ' · cached'; title += ' — latest fetch failed'; }
        } else if (data) { text = 'Unavailable'; title += ` — ${data.error || 'API data unavailable'}`; }
        row.setAttribute('aria-label', `${title}: ${text}`);
        if (row.textContent !== text || !row.querySelector(".rta-logo")) row.replaceChildren(createLogo(), document.createTextNode(text));
        if (row.title !== title) row.title = title;
      }
    }
    for (const [card, row] of itemRows) {
      if (!active.has(card)) { row.remove(); itemRows.delete(card); }
    }
  }
  let detailSummary;
  function renderDetailSummary(sides) {
    document.querySelectorAll('.rta-robux-total').forEach(el => el.remove());
    detailSummary?.remove();
    if (!data?.ok || sides.length !== 2) return;
    const totals = sides.map(({ links, anchor, robux: detectedRobux }) => {
      const result = TradeValues.totalItems(itemIds(links), data.items);
      const isRobux = /Robux/i.test(anchor.textContent);
      const raw = isRobux ? (anchor.querySelector('input')?.value || anchor.textContent.replace(/Robux(?:\s*\([^)]*\))?\s*:?/i, '').trim()) : '0';
      const robux = detectedRobux ?? (/^[\d,]+$/.test(raw) ? Number(raw.replaceAll(',', '')) : null);
      if (result.missing || robux == null) return null;
      const el = document.createElement('div');
      el.className = 'rta-robux-total';
      el.textContent = `Robux: ${number(robux)} · Items + Robux: ${number(result.total + robux)}`;
      rendered.get(sides.find(side => side.anchor === anchor).key)?.insertAdjacentElement('afterend', el);
      return result.total + robux;
    });
    if (totals.some(t => t == null)) return;
    const host = rendered.get(sides[1].key)?.parentElement;
    if (host) detailSummary = paintSummary(host, totals[0], totals[1], data.stale ? ' · cached' : '');
  }
  function render() {
    renderTradeList().catch(() => {});
    const sides = tradeSides();
    renderItemValues(sides);
    const active = new Set(sides.map(side => side.key));
    for (const [key, row] of rendered) {
      if (!active.has(key)) { row.remove(); rendered.delete(key); }
    }
    for (const { key, links, anchor } of sides) {
      let row = rendered.get(key);
      if (!row) {
        row = document.createElement('div');
        row.className = ROW_CLASS;
        row.setAttribute('role', 'status');
        rendered.set(key, row);
      }
      if (anchor.nextElementSibling !== row) anchor.insertAdjacentElement('afterend', row);
      let text = "Rolimon's value: Loading…";
      let title = 'Item values only; Robux is displayed separately by Roblox.';
      if (data?.ok) {
        const { total, rapFallbacks, missing } = TradeValues.totalItems(itemIds(links), data.items);
        const ids = itemIds(links);
        const missingIds = ids.filter(id => !data.items[id] || (data.items[id].value == null && data.items[id].rap == null));
        text = `Rolimon's value: ${missing ? `Unavailable — no data for ${missingIds.join(', ')}` : total.toLocaleString('en-US')}`;
        if (rapFallbacks) text += ` (${rapFallbacks} RAP fallback${rapFallbacks === 1 ? '' : 's'})`;
        if (missing) title += ` ${missing} item(s) have no available data; no complete total can be shown.`;
        if (data.stale) text += ' · cached';
        title += ` Updated ${new Date(data.fetchedAt).toLocaleString()}.`;
      } else if (data) {
        text = `Rolimon's value: Unavailable — ${data.error || "no background response"}`;
        title += ` ${data.error || 'Background worker did not return item data.'} Click the extension icon for status.`;
      }
      if (row.textContent !== text) {
        const label = document.createElement('span');
        label.className = 'rta-sr-only';
        label.textContent = "Rolimon's value: ";
        row.replaceChildren(createLogo(), label, document.createTextNode(text.replace(/^Rolimon's value: /, '')));
      }
      if (row.title !== title) row.title = title;
    }
    renderDetailSummary(sides);
    if (sides.length && Date.now() >= nextFetch) load();
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      data = await chrome.runtime.sendMessage({ type: 'GET_ROLIMONS_VALUES' });
      if (!data) data = { ok: false, error: "No response from background worker" };
    } catch (error) { data = { ok: false, error: error.message }; }
    nextFetch = Date.now() + (data.ok && !data.stale ? 5 * 60 * 1000 : 60 * 1000);
    loading = false;
    render();
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'GET_TRADE_STATUS') return;
    respond({
      version: chrome.runtime.getManifest().version,
      sides: tradeSides().length,
      rows: document.querySelectorAll(`.${ROW_CLASS}`).length,
      listRows: tradeListRows().length,
      summaries: document.querySelectorAll('.rta-trade-summary').length,
      category: tradeListStatus(),
      listError,
      messages: [...document.querySelectorAll(`.${ROW_CLASS}`)].map(row => row.textContent + '\n' + row.title)
    });
  });

  const observer = new MutationObserver(mutations => {
    // Ignore our own rendering to avoid an observer/render loop.
    if (mutations.every(m => m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].length && [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.matches('.rta-robux-total, .rta-trade-summary')))) return;
    if (mutations.every(m => m.target.nodeType === 1 && m.target.closest(`.${ROW_CLASS}, .rta-item-value, .rta-trade-summary`))) return;
    clearTimeout(timer);
    timer = setTimeout(render, 100);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true,
    characterData: true, attributeFilter: ['href', 'class', 'aria-selected', 'data-trade-id', 'data-user-asset-id'] });
  window.addEventListener('hashchange', render);
  window.addEventListener('popstate', render);
  document.addEventListener('change', render);
  document.addEventListener('click', () => { clearTimeout(timer); timer = setTimeout(render, 100); });
  document.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 100); });
  setInterval(render, 30 * 1000);
  render();
})();
