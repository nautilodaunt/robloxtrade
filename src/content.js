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

  function assetInfo(link) {
    try {
      const url = new URL(link.getAttribute("href"), location.href);
      if (!/(^|\.)roblox\.com$/.test(url.hostname)) return null;
      if (url.pathname.startsWith('/bundles/')) {
        // Migrated faces link to bundles that Rolimon's lists under the old asset;
        // resolve them to that asset so they use its (migrated) value.
        const id = TradeValues.resolveBundle(url.href, data?.items || {});
        return { id: id || `bundle:${url.pathname.split('/')[2]}` };
      }
      const id = url.pathname.match(/^\/(?:catalog|library)\/(\d+)(?:\/|$)/)?.[1];
      return id ? { id } : null;
    } catch { return null; }
  }

  // The element holding one copy of an item. Known card classes come first.
  // Otherwise climb while the ancestor still holds just this item and at most
  // one thumbnail, so an image link and a title link in one card stay together
  // while two copies of the same item (two thumbnails) stay separate.
  function cardOf(link, id) {
    const known = link.closest(CARD);
    if (known) return known;
    let card = link;
    for (let parent = link.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.matches(SIDE) || parent.querySelector('.rta-value-row, .rta-trade-summary, .rta-demand-row, h1, h2, h3, h4, h5, h6')) break;
      const images = parent.querySelectorAll('img').length;
      const links = [...parent.querySelectorAll(ITEM_LINK)];
      if (images > 1 || (images === 0 && links.length > 1)) break;
      if (links.some(other => assetInfo(other)?.id !== id)) break;
      card = parent;
    }
    return card;
  }

  function itemInfos(links) {
    const cardsSeen = new Set();
    const infos = [];
    for (const link of links) {
      const info = assetInfo(link);
      if (!info) continue;
      // Image and title links in one card count once. Separate copies of an
      // identical limited in different cards must each contribute to the total.
      const card = cardOf(link, info.id);
      if (cardsSeen.has(card)) continue;
      cardsSeen.add(card);
      infos.push(info);
    }
    return infos;
  }
  // Own keys only, so names like "__proto__" never resolve to an item.
  const lookup = (items, id) => (items && Object.hasOwn(items, id) ? items[id] : undefined);

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
  // Projected items, from both sides of a trade.
  function flagNotes(sides) {
    const projected = sides.reduce((sum, side) => sum + side.projected, 0);
    return projected ? ` · ${projected} projected` : '';
  }
  // Only the received side can make a bad trade look good. Projected items are
  // tagged instead; only unvetted Roblox RAP needs a second look.
  function cautionFor(side) {
    return side.robloxRap ? `${side.robloxRap} item${side.robloxRap === 1 ? '' : 's'} not on Rolimon’s (Roblox RAP)` : '';
  }
  function paintSummary(host, give, receive, extra = '', caution = '', projected = 0, demand = null) {
    let box = summaries.get(host);
    if (!box) { box = document.createElement('div'); box.className = 'rta-trade-summary'; summaries.set(host, box); }
    const result = comparison(give, receive);
    // A pumpable Roblox RAP can make a bad trade look profitable, so such a gain
    // is shown as a caution instead of green.
    const warn = Boolean(caution) && result.state === 'gain';
    box.dataset.result = warn ? 'caution' : result.state;
    const isList = tradeListRows().includes(host);
    const avg = v => v == null ? '–' : v.toFixed(1);
    const demandLine = demand && demand.some(v => v != null) ? `\n${isList ? 'Demand' : 'Avg demand'} ${avg(demand[0])} → ${avg(demand[1])}${isList ? '' : ' / 5'}` : '';
    const text = isList
      ? `Give ${number(give)}\nReceive ${number(receive)}\n${result.text.split(' · ')[0]}${projected ? '\nProjected' : ''}${warn ? '\n⚠ Verify items' : ''}${demandLine}`
      : `Give ${number(give)} · Receive ${number(receive)}\n${result.text}${extra}${warn ? `\n⚠ Verify: ${caution}` : ''}${demandLine}`;
    if (box.textContent !== text) box.textContent = text;
    box.title = 'Estimated using current Rolimon’s values plus Robux. List receipts account for the 30% Robux fee; detail receipts use Roblox’s displayed amount. Not historical profit.' +
      (caution ? ` What you receive includes ${caution}; check those items before accepting.` : '');
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
    // IDs can come from page attributes; only digits may become part of the API path.
    const tradeId = query.tradeId == null ? '' : String(query.tradeId);
    if (tradeId && !/^\d+$/.test(tradeId)) return { ok: false, error: 'Invalid trade ID' };
    if (!tradeId && !['Inbound', 'Outbound', 'Completed', 'Inactive'].includes(query.status)) return { ok: false, error: 'Invalid trade category' };
    // Use Roblox's existing page origin and signed-in session. Chrome may withhold
    // a newly added extension host permission until the user grants it.
    if (typeof fetch === 'function') {
      const path = tradeId ? `v2/trades/${tradeId}` : `v1/trades/${query.status}?limit=100&sortOrder=Desc`;
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
        // The page controls these attributes; accept only a numeric trade ID.
        let id = [row.getAttribute('data-trade-id'), row.querySelector('a[href*="tradeId="]')?.href.match(/tradeId=(\d+)/)?.[1]]
          .find(value => /^\d+$/.test(value || ''));
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
          const unvetted = new Set();
          const ids = o.userAssets.map(a => {
            const id = String(a.assetId);
            const known = lookup(items, id);
            if (known?.value != null || known?.rap != null) return id;
            // Assets need an exact ID: a look-alike can copy a limited's name. Only
            // bundles (migrated faces) fall back to the name, using the migrated value.
            if (id.startsWith('bundle:')) {
              const match = TradeValues.matchName(a.name, data.items);
              if (match) return match;
            }
            // Roblox supplies RAP even for assets missing from the value feed. Nobody
            // vets that RAP (it can be pumped), so it is flagged like a projected item.
            if (/^(?:bundle:)?\d+$/.test(id) && Number.isFinite(a.recentAveragePrice) && a.recentAveragePrice >= 0) {
              items[id] = { rap: a.recentAveragePrice, value: null };
              unvetted.add(id);
            }
            return id;
          });
          const result = TradeValues.totalItems(ids, items);
          return { ...result, robloxRap: ids.filter(id => unvetted.has(id)).length,
            demand: TradeValues.averageDemand(ids, items).average,
            total: result.total + (o === own ? o.robux : Math.round(o.robux * 0.7)) };
        });
        if (totals.some(t => t.missing || !Number.isFinite(t.total))) {
          summaries.get(row)?.remove(); continue;
        }
        paintSummary(row, totals[0].total, totals[1].total,
          `${totals.some(t => t.rapFallbacks) ? ' · RAP fallback' : ''}${flagNotes(totals)}${data.stale ? ' · cached' : ''}`, cautionFor(totals[1]), totals[1].projected, totals.map(t => t.demand));
      }
    } finally {
      listLoading = false;
      if (tradeListStatus() !== status) { clearTimeout(timer); timer = setTimeout(render, 0); }
    }
  }

  const rendered = new Map();
  const itemRows = new Map();
  const projectedTags = new Map();
  const demandRows = new Map();
  const cardIds = new Map();

  function renderItemValues(sides) {
    const active = new Set();
    for (const { links } of sides) {
      const cards = new Map();
      for (const link of links) {
        const info = assetInfo(link);
        if (!info) continue;
        const card = cardOf(link, info.id);
        // A card can have separate thumbnail and title links.
        if (!cards.has(card)) cards.set(card, info);
      }
      for (const [card, { id }] of cards) {
        active.add(card);
        cardIds.set(card, id);
        let row = itemRows.get(card);
        if (!row) {
          row = document.createElement('div');
          row.className = 'rta-item-value';
          itemRows.set(card, row);
        }
        const host = card.querySelector('.item-card-caption, .item-card-info') || card;
        if (row.parentElement !== host) host.append(row);
        const item = lookup(data?.items, id);
        const value = item?.value ?? item?.rap;
        let text = 'Loading…';
        let title = "Rolimon's item value";
        if (data?.ok) {
          text = value == null ? 'Unavailable' : value.toLocaleString('en-US');
          if (item?.value == null && item?.rap != null) {
            text += ' (RAP)';
            title += ' — RAP fallback; no assigned value';
          }
          if (item?.projected === true) title += ' — Rolimon’s marks this item as projected (likely inflated)';
          if (value == null) title += ` — no data for ${id}`;
          if (data.stale) { text += ' · cached'; title += ' — latest fetch failed'; }
        } else if (data) { text = 'Unavailable'; title += ` — ${data.error || 'API data unavailable'}`; }
        row.setAttribute('aria-label', `${title}: ${text}`);
        const projected = Boolean(data?.ok && item?.projected === true);
        // Projected items also get a badge beside the Rolimon's value below the item.
        if (row.textContent !== text + (projected ? 'Projected' : '') || !row.querySelector(".rta-logo")) {
          const parts = [createLogo(), document.createTextNode(text)];
          if (projected) {
            const badge = document.createElement('span');
            badge.className = 'rta-projected-badge';
            badge.textContent = 'Projected';
            parts.push(badge);
          }
          row.replaceChildren(...parts);
        }
        if (row.title !== title) row.title = title;
        // ...and a tag in the top-left corner of the item's thumbnail.
        let tag = projectedTags.get(card);
        if (projected) {
          if (!tag) {
            tag = document.createElement('span');
            tag.className = 'rta-projected-tag';
            tag.textContent = 'Projected';
            tag.title = 'Rolimon’s marks this item as projected (likely inflated)';
            projectedTags.set(card, tag);
          }
          const thumb = card.querySelector('.item-card-thumb-container, .thumbnail-2d-container, .item-card-thumb') ||
            card.querySelector('img')?.parentElement || card;
          if (!thumb.classList.contains('rta-tag-host')) thumb.classList.add('rta-tag-host');
          if (tag.parentElement !== thumb) thumb.prepend(tag);
        } else if (tag) { tag.remove(); projectedTags.delete(card); }
      }
    }
    for (const [card, row] of itemRows) {
      if (!active.has(card)) { row.remove(); itemRows.delete(card); }
    }
    for (const [card, tag] of projectedTags) {
      if (!active.has(card)) { tag.remove(); projectedTags.delete(card); }
    }
    for (const card of cardIds.keys()) {
      if (!active.has(card)) cardIds.delete(card);
    }
    if (insightCard && !active.has(insightCard)) closeInsight();
  }
  let detailSummary;
  function renderDetailSummary(sides) {
    document.querySelectorAll('.rta-robux-total').forEach(el => el.remove());
    detailSummary?.remove();
    if (!data?.ok || sides.length !== 2) return;
    const totals = sides.map(({ links, anchor, robux: detectedRobux }) => {
      const infos = itemInfos(links);
      const result = TradeValues.totalItems(infos.map(info => info.id), data.items);
      const isRobux = /Robux/i.test(anchor.textContent);
      const raw = isRobux ? (anchor.querySelector('input')?.value || anchor.textContent.replace(/Robux(?:\s*\([^)]*\))?\s*:?/i, '').trim()) : '0';
      const robux = detectedRobux ?? (/^[\d,]+$/.test(raw) ? Number(raw.replaceAll(',', '')) : null);
      if (result.missing || robux == null) return null;
      const el = document.createElement('div');
      el.className = 'rta-robux-total';
      el.textContent = `Robux: ${number(robux)} · Items + Robux: ${number(result.total + robux)}`;
      const key = sides.find(side => side.anchor === anchor).key;
      (demandRows.get(key) || rendered.get(key))?.insertAdjacentElement('afterend', el);
      return { total: result.total + robux, projected: result.projected,
        demand: TradeValues.averageDemand(infos.map(info => info.id), data.items).average };
    });
    if (totals.some(t => t == null)) return;
    const host = rendered.get(sides[1].key)?.parentElement;
    if (host) detailSummary = paintSummary(host, totals[0].total, totals[1].total, `${flagNotes(totals)}${data.stale ? ' · cached' : ''}`, cautionFor(totals[1]),
      0, totals.map(t => t.demand));
  }
  function render() {
    renderTradeList().catch(() => {});
    const sides = tradeSides();
    renderItemValues(sides);
    const active = new Set(sides.map(side => side.key));
    for (const [key, row] of rendered) {
      if (!active.has(key)) { row.remove(); rendered.delete(key); }
    }
    for (const [key, row] of demandRows) {
      if (!active.has(key)) { row.remove(); demandRows.delete(key); }
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
      let demandText = '', demandTitle = '';
      if (data?.ok) {
        const infos = itemInfos(links);
        const ids = infos.map(info => info.id);
        const { total, rapFallbacks, missing, projected } = TradeValues.totalItems(ids, data.items);
        const demand = TradeValues.averageDemand(ids, data.items);
        if (demand.average != null) {
          demandText = `Avg demand: ${demand.average.toFixed(1)} / 5 (${TradeValues.DEMAND_SCALE[Math.round(demand.average)]})`;
          demandTitle = `Rolimon’s demand on a 0–5 scale (0 None or RAP-only, 1 Terrible, 2 Low, 3 Normal, 4 High, 5 Amazing), averaged over ${demand.count} item${demand.count === 1 ? '' : 's'}.`;
        }
        const missingIds = ids.filter(id => { const item = lookup(data.items, id); return item?.value == null && item?.rap == null; });
        text = `Rolimon's value: ${missing ? `Unavailable — no data for ${missingIds.join(', ')}` : total.toLocaleString('en-US')}`;
        const notes = [];
        if (rapFallbacks) notes.push(`${rapFallbacks} RAP fallback${rapFallbacks === 1 ? '' : 's'}`);
        if (projected) notes.push(`${projected} projected`);
        if (notes.length) text += ` (${notes.join(', ')})`;
        if (projected) title += ` ${projected} item(s) are marked projected by Rolimon’s (likely inflated).`;
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
      // Average demand goes directly below the side's total.
      let demandRow = demandRows.get(key);
      if (demandText) {
        if (!demandRow) { demandRow = el('div', 'rta-demand-row'); demandRows.set(key, demandRow); }
        if (demandRow.textContent !== demandText) demandRow.textContent = demandText;
        if (demandRow.title !== demandTitle) demandRow.title = demandTitle;
        if (row.nextElementSibling !== demandRow) row.insertAdjacentElement('afterend', demandRow);
      } else if (demandRow) { demandRow.remove(); demandRows.delete(key); }
    }
    renderDetailSummary(sides);
    if (sides.length && Date.now() >= nextFetch) load();
  }

  // ---- Item insight panel: hover an item for its chart, stats and prediction ----
  let insightPanel = null, insightCard = null, insightPinned = false, hoverTimer, hideTimer;
  const insightRequests = new Map();
  const DAY = 86400;
  const compact = n => n >= 1e6 ? `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(Math.round(n));
  const shortDate = t => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function requestInsight(id) {
    if (!insightRequests.has(id)) {
      const promise = chrome.runtime.sendMessage({ type: 'GET_ITEM_INSIGHT', itemId: id }).then(response => {
        if (!response?.ok) throw new Error(response?.error || 'No response');
        return response.result;
      });
      promise.catch(() => insightRequests.delete(id));
      insightRequests.set(id, promise);
    }
    return insightRequests.get(id);
  }
  function cardFor(node) {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) if (cardIds.has(n)) return n;
    return null;
  }
  function closeInsight() {
    clearTimeout(hoverTimer); clearTimeout(hideTimer);
    insightPanel?.remove();
    insightPanel = insightCard = null;
    insightPinned = false;
  }
  function placeInsight() {
    if (!insightPanel || !insightCard) return;
    if (!insightCard.isConnected) { closeInsight(); return; }
    const r = insightCard.getBoundingClientRect();
    const w = insightPanel.offsetWidth || 360, h = insightPanel.offsetHeight || 320;
    let left = r.right + 10;
    if (left + w > innerWidth - 8) left = r.left - w - 10;
    if (left < 8) left = Math.max(8, Math.min(innerWidth - w - 8, r.left));
    insightPanel.style.left = `${left}px`;
    insightPanel.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, r.top))}px`;
  }
  function stat(grid, label, value, cls = '', title = '') {
    if (value == null || value === '') return;
    const cell = el('div', 'rta-insight-stat');
    if (title) cell.title = title;
    cell.append(el('span', 'rta-insight-label', label), el('span', `rta-insight-value ${cls}`.trim(), value));
    grid.append(cell);
  }
  function fillStats(grid, item, insight) {
    const d = { ...item, ...Object.fromEntries(Object.entries(insight?.details || {}).filter(([, v]) => v != null)) };
    grid.replaceChildren();
    const flags = el('div', 'rta-insight-flags');
    for (const [on, label] of [[d.projected, 'Projected'], [d.hyped, 'Hyped'], [d.rare, 'Rare']]) {
      if (on) flags.append(el('span', `rta-flag rta-flag-${label.toLowerCase()}`, label));
    }
    if (flags.childElementCount) grid.append(flags);
    stat(grid, 'Value', d.value != null ? number(d.value) : 'None');
    stat(grid, 'RAP', d.rap != null ? number(d.rap) : null);
    if (d.bestPriceStale && d.bestPrice != null) {
      stat(grid, 'Best price', `${number(d.bestPrice)} (stale)`, 'rta-stale',
        'Rolimon’s hasn’t updated this lowest price in 7+ days while copies sold well below it. The value odds ignore it; check the real listings on Roblox.');
    } else stat(grid, 'Best price', d.bestPrice != null ? number(d.bestPrice) : null);
    const score = TradeValues.demandScore(d);
    stat(grid, 'Demand', `${score} / 5 · ${TradeValues.DEMAND_SCALE[score]}`, `rta-demand-${score}`);
    stat(grid, 'Trend', d.trend != null ? TradeValues.TREND_LABELS[d.trend] : 'None');
    if (insight) {
      for (const [days, label] of [[7, '7d RAP'], [30, '30d RAP']]) {
        const change = ItemInsights.rapChange(insight.history, days);
        if (change != null) stat(grid, label, `${change > 0 ? '+' : ''}${change.toFixed(1)}%`, change > 0 ? 'rta-up' : change < 0 ? 'rta-down' : '');
      }
      stat(grid, 'Sellers', d.sellers != null ? number(d.sellers) : null);
      stat(grid, 'Sales / day', insight.salesPerDay != null ? insight.salesPerDay.toFixed(1) : null);
      stat(grid, 'Owners', d.owners != null ? number(d.owners) : null);
    }
  }
  function drawChart(box, readout, history, days) {
    const NS = 'http://www.w3.org/2000/svg';
    const last = history.at(-1)?.t || 0;
    const points = history.filter(p => p.t >= last - days * DAY);
    box.replaceChildren();
    const raps = points.map(p => p.rap).filter(v => v > 0);
    if (points.length < 2 || !raps.length) { box.append(el('div', 'rta-insight-empty', 'Not enough history for this range.')); readout.textContent = ''; return; }
    const W = 340, H = 130, PAD = 4;
    // Best-price spikes are clipped so they do not flatten the RAP line.
    const bests = points.map(p => p.best).filter(v => v > 0);
    const maxRap = Math.max(...raps), minRap = Math.min(...raps);
    const max = Math.max(maxRap, Math.min(bests.length ? Math.max(...bests) : 0, maxRap * 1.5));
    const min = Math.min(minRap, Math.max(bests.length ? Math.min(...bests) : Infinity, minRap * 0.6));
    const t0 = points[0].t, t1 = points.at(-1).t;
    const x = t => PAD + (t - t0) / ((t1 - t0) || 1) * (W - 2 * PAD);
    const y = v => H - PAD - (Math.min(max, Math.max(min, v)) - min) / ((max - min) || 1) * (H - 2 * PAD);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'rta-chart');
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const [key, cls] of [['best', 'rta-line-best'], ['rap', 'rta-line-rap']]) {
      const coords = points.filter(p => p[key] > 0).map(p => `${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
      if (!coords) continue;
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', coords);
      line.setAttribute('class', cls);
      svg.append(line);
    }
    const cursor = document.createElementNS(NS, 'line');
    cursor.setAttribute('class', 'rta-chart-cursor');
    cursor.setAttribute('y1', '0'); cursor.setAttribute('y2', String(H));
    svg.append(cursor);
    const wrap = el('div', 'rta-chart-wrap');
    const axis = el('div', 'rta-chart-axis');
    axis.append(el('span', '', compact(max)), el('span', '', compact(min)));
    const dates = el('div', 'rta-chart-dates');
    dates.append(el('span', '', shortDate(t0)), el('span', '', shortDate(t1)));
    wrap.append(svg, axis);
    box.append(wrap, dates);
    const show = p => {
      cursor.setAttribute('x1', x(p.t).toFixed(1)); cursor.setAttribute('x2', x(p.t).toFixed(1));
      readout.textContent = `${shortDate(p.t)} · RAP ${p.rap != null ? number(p.rap) : '–'} · Best ${p.best ? number(p.best) : '–'}${p.sellers != null ? ` · ${p.sellers} sellers` : ''}`;
    };
    svg.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      const t = t0 + (e.clientX - rect.left) / (rect.width || 1) * (t1 - t0);
      show(points.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    });
    svg.addEventListener('mouseleave', () => show(points.at(-1)));
    show(points.at(-1));
  }
  // Odds of a Rolimon's value raise / lower from the trained model, with a
  // 7D / 14D / 30D toggle. Unvalued (RAP-only) items get no prediction.
  let forecastDays = 30;
  const pct = p => `${p < 0.01 ? '<1' : Math.round(p * 100)}%`;
  function forecastSection(insight, item) {
    const box = el('div', 'rta-forecast');
    const value = insight.details?.value ?? item.value;
    const head = el('div', 'rta-forecast-head');
    head.append(el('strong', '', 'Rolimon’s value change'));
    box.append(head);
    if (!(value > 0)) {
      box.append(el('div', 'rta-forecast-none', 'No prediction (unvalued item).'));
      return box;
    }
    const prediction = insight.prediction;
    if (!prediction?.horizons || !Object.keys(prediction.horizons).length) {
      box.append(el('div', 'rta-forecast-none', 'Not enough recent data to predict this item.'));
      return box;
    }
    const toggle = el('div', 'rta-forecast-days');
    const content = el('div', 'rta-forecast-content');
    const show = days => {
      forecastDays = days;
      toggle.querySelectorAll('.rta-range').forEach(b => b.classList.toggle('rta-active', Number(b.dataset.days) === days));
      const h = prediction.horizons[days];
      box.classList.toggle('rta-forecast-rise', h.up >= 0.5 || (h.up >= 0.2 && h.up >= 2 * h.baseUp && h.up > h.down));
      box.classList.toggle('rta-forecast-fall', !box.classList.contains('rta-forecast-rise') && (h.down >= 0.5 || (h.down >= 0.2 && h.down >= 2 * h.baseDown)));
      content.replaceChildren();
      const verdict = h.up >= 0.5 ? '▲ Raise likely' : h.down >= 0.5 ? '▼ Lower likely'
        : box.classList.contains('rta-forecast-rise') ? '▲ Raise more likely than usual'
          : box.classList.contains('rta-forecast-fall') ? '▼ Lower more likely than usual' : '► Most likely no change';
      content.append(el('div', 'rta-forecast-verdict', `${verdict} within ${days} days`));
      for (const [label, p, base, cls] of [['Raise', h.up, h.baseUp, 'rta-up'], ['Lower', h.down, h.baseDown, 'rta-down']]) {
        const row = el('div', 'rta-odds-row');
        const bar = el('span', 'rta-odds-bar');
        const fill = el('span', `rta-odds-fill ${cls}`);
        fill.style.width = `${Math.max(2, Math.round(p * 100))}%`;
        bar.append(fill);
        row.append(el('span', `rta-odds-label ${cls}`, label), bar, el('strong', 'rta-odds-pct', pct(p)), el('span', 'rta-odds-base', `usually ${pct(base)}`));
        content.append(row);
      }
      const test = h.test || {};
      const tested = [['raises', test.up], ['lowers', test.down]].map(([name, t]) => {
        const at = t?.at50?.flagged >= 10 ? ['50', t.at50] : t?.at30?.flagged ? ['30', t.at30] : null;
        return at && at[1].precision != null ? `${name} ≥${at[0]}%: right ${Math.round(at[1].precision)}% of ${at[1].flagged} calls` : null;
      }).filter(Boolean);
      if (tested.length && prediction.testPeriod) {
        content.append(el('div', 'rta-forecast-test', `Backtest on ${prediction.testPeriod.join(' to ')}, months the test model never saw: ${tested.join('; ')}.`));
      }
    };
    for (const days of [7, 14, 30]) {
      if (!prediction.horizons[days]) continue;
      const button = el('button', 'rta-range', `${days}D`);
      button.type = 'button';
      button.dataset.days = String(days);
      button.addEventListener('click', e => { e.stopPropagation(); show(days); });
      toggle.append(button);
    }
    head.append(toggle);
    box.append(content);
    const age = globalThis.ItemInsights?.modelAge?.(prediction.dataAt);
    if (age) {
      const line = el('div', `rta-model-age rta-model-age-${age.level}`, age.text);
      line.title = `Trained on Rolimon’s data up to ${new Date(prediction.dataAt).toLocaleString()}. Retrain every 1–2 months.`;
      box.append(line);
    }
    show(prediction.horizons[forecastDays] ? forecastDays : Number(toggle.lastChild.dataset.days));
    return box;
  }
  function fillBody(body, insight, item) {
    body.replaceChildren();
    const ranges = el('div', 'rta-insight-ranges');
    const chartBox = el('div', 'rta-chart-box');
    const readout = el('div', 'rta-chart-readout');
    const legend = el('div', 'rta-chart-legend');
    legend.append(el('span', 'rta-key-rap', 'RAP'), el('span', 'rta-key-best', 'Best price'));
    for (const [days, label] of [[30, '30D'], [90, '90D'], [365, '1Y']]) {
      const button = el('button', 'rta-range', label);
      button.type = 'button';
      button.addEventListener('click', e => {
        e.stopPropagation();
        ranges.querySelectorAll('.rta-range').forEach(b => b.classList.toggle('rta-active', b === button));
        drawChart(chartBox, readout, insight.history, days);
      });
      if (days === 30) button.classList.add('rta-active');
      ranges.append(button);
    }
    ranges.append(legend);
    body.append(ranges, chartBox, readout);
    drawChart(chartBox, readout, insight.history, 30);

    body.append(forecastSection(insight, item));

    if (insight.valueChanges.length) {
      const changes = el('div', 'rta-insight-changes');
      changes.append(el('div', 'rta-insight-label', 'Recent Rolimon’s changes'));
      for (const c of insight.valueChanges.slice(0, 4)) {
        const fmt = v => c.type === 'value' ? (Number.isFinite(Number(v)) && v != null ? compact(Number(v)) : 'None')
          : TradeValues.DEMAND_LABELS[Number(v)] ?? 'None';
        const up = c.type === 'value' ? Number(c.to) > Number(c.from || 0) : Number(c.to) > Number(c.from ?? -1);
        changes.append(el('div', up ? 'rta-up' : 'rta-down', `${shortDate(c.t)} · ${c.type === 'value' ? 'Value' : 'Demand'} ${fmt(c.from)} → ${fmt(c.to)}`));
      }
      body.append(changes);
    }
  }
  function openInsight(card) {
    const id = cardIds.get(card);
    if (!id || !/^\d+$/.test(id) || !card.isConnected) return;
    closeInsight();
    insightCard = card;
    const item = lookup(data?.items, id) || {};
    const panel = insightPanel = el('div', 'rta-insight');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${item.name || 'Item'} details`);
    const head = el('div', 'rta-insight-head');
    const link = el('a', 'rta-insight-link', 'Rolimon’s ↗');
    link.href = `https://www.rolimons.com/item/${id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const close = el('button', 'rta-insight-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', e => { e.stopPropagation(); closeInsight(); });
    head.append(createLogo(), el('strong', 'rta-insight-name', item.name || `Item ${id}`), link, close);
    const stats = el('div', 'rta-insight-stats');
    const body = el('div', 'rta-insight-body', 'Loading history…');
    panel.append(head, stats, body, el('div', 'rta-insight-note', 'Click the panel to pin it. Value odds come from a model trained on past Rolimon’s changes. They are estimates, not guarantees.'));
    panel.addEventListener('click', e => {
      if (e.target.closest('a, button')) return;
      insightPinned = true;
      panel.classList.add('rta-pinned');
    });
    fillStats(stats, item, null);
    document.body.append(panel);
    placeInsight();
    requestInsight(id).then(insight => {
      if (insightPanel !== panel) return;
      // Faces became Roblox bundles; Rolimon's main page for one is the bundle page.
      if (/^\d{1,20}$/.test(insight.details?.bundleId || '')) link.href = `https://www.rolimons.com/bundle/${insight.details.bundleId}`;
      fillStats(stats, item, insight);
      fillBody(body, insight, item);
      placeInsight();
    }, error => { if (insightPanel === panel) body.textContent = `History unavailable — ${error.message}`; });
  }
  document.addEventListener('mouseover', e => {
    if (e.target.closest?.('.rta-insight')) { clearTimeout(hideTimer); return; }
    const card = cardFor(e.target);
    if (!card) return;
    clearTimeout(hideTimer);
    if (card === insightCard || insightPinned) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => openInsight(card), 450);
  });
  document.addEventListener('mouseout', e => {
    const to = e.relatedTarget;
    const from = cardFor(e.target);
    if (to && (to.closest?.('.rta-insight') || (insightCard && insightCard.contains(to)) || (from && cardFor(to) === from))) return;
    clearTimeout(hoverTimer);
    if (insightPanel && !insightPinned) { clearTimeout(hideTimer); hideTimer = setTimeout(closeInsight, 300); }
  });
  document.addEventListener('mousedown', e => {
    if (insightPanel && !e.target.closest?.('.rta-insight') && cardFor(e.target) !== insightCard) closeInsight();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && insightPanel) closeInsight(); });
  window.addEventListener('scroll', placeInsight, true);
  window.addEventListener('resize', placeInsight);

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
    if (mutations.every(m => m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].length && [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType === 1 && n.matches('.rta-robux-total, .rta-trade-summary, .rta-projected-tag, .rta-demand-row, .rta-insight')))) return;
    if (mutations.every(m => m.target.nodeType === 1 && m.target.closest(`.${ROW_CLASS}, .rta-item-value, .rta-trade-summary, .rta-projected-tag, .rta-demand-row, .rta-insight`))) return;
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
