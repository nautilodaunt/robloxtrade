// Service worker module: scrapes Rolimon's recent trade ads to find low-trade-count
// players offering high/amazing demand items within a customizable value range.
const AdFinder = (() => {
  const KEY = 'lowTraderAdFinder';
  const PLAYER_CACHE_KEY = 'rolimonsPlayerTradeCounts';
  const ALARM = 'rolimons-ad-finder';
  const ITEMS_URL = 'https://api.rolimons.com/items/v2/itemdetails';
  const RECENT_ADS_URL = 'https://api.rolimons.com/tradeads/v1/getrecentads';
  const PLAYER_URL = 'https://www.rolimons.com/player';
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const PLAYER_TTL_MS = 30 * 60 * 1000;
  const MATCH_RETENTION_MS = 30 * 60 * 1000;
  const MAX_PLAYER_LOOKUPS = 25;
  const LOOKUP_CONCURRENCY = 4;

  const TAG_LABELS = {
    1: 'Any',
    2: 'Demand',
    3: 'Rares',
    4: 'Robux',
    5: 'Upgrade',
    6: 'Downgrade',
    7: 'RAP',
    8: 'Wishlist',
    9: 'Projecteds',
    10: 'Adds'
  };

  const DEFAULT_FILTERS = {
    minValue: 10000,
    maxValue: 150000,
    maxTradeAds: 150,
    minDemand: 4,
    itemQuery: ''
  };

  let queue = Promise.resolve();
  const serial = async fn => {
    const prev = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await prev;
    try { return await fn(); }
    finally { release(); }
  };

  const defaultState = () => ({
    enabled: false,
    filters: { ...DEFAULT_FILTERS },
    matches: [],
    lastScannedAt: null,
    status: 'Set your value range and max trade ads, then click Scan trade ads.'
  });

  async function read() {
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    if (!stored) return defaultState();
    return {
      ...defaultState(),
      ...stored,
      filters: { ...DEFAULT_FILTERS, ...(stored.filters || {}) },
      matches: Array.isArray(stored.matches) ? stored.matches : []
    };
  }

  const write = state => chrome.storage.local.set({ [KEY]: state });

  function validateFilters(input = {}) {
    const minValue = input.minValue === '' || input.minValue == null ? 0 : Number(input.minValue);
    if (!Number.isSafeInteger(minValue) || minValue < 0) {
      throw new Error('Min value must be a whole number (0 or greater).');
    }
    const hasMax = input.maxValue !== '' && input.maxValue != null;
    const maxValue = hasMax ? Number(input.maxValue) : null;
    if (hasMax && (!Number.isSafeInteger(maxValue) || maxValue < minValue)) {
      throw new Error('Max value must be blank (no max) or at least Min value.');
    }
    const maxTradeAds = input.maxTradeAds === '' || input.maxTradeAds == null ? 150 : Number(input.maxTradeAds);
    if (!Number.isSafeInteger(maxTradeAds) || maxTradeAds < 0 || maxTradeAds > 1000000) {
      throw new Error('Max trade ads must be a non-negative whole number.');
    }
    const minDemand = input.minDemand == null ? 4 : Number(input.minDemand);
    if (![2, 3, 4].includes(minDemand)) {
      throw new Error('Choose a valid minimum demand rating.');
    }
    const itemQuery = String(input.itemQuery || '').trim().slice(0, 200);
    return { minValue, maxValue, maxTradeAds, minDemand, itemQuery };
  }

  function parseQueryTerms(itemQuery) {
    return String(itemQuery || '')
      .split(',')
      .map(term => term.trim().toLowerCase())
      .filter(Boolean);
  }

  function effectiveValue(item) {
    if (!item) return null;
    if (typeof item.value === 'number' && item.value >= 0) return item.value;
    if (typeof item.rap === 'number' && item.rap >= 0) return item.rap;
    return null;
  }

  function itemMatchesFilters(id, item, filters, terms) {
    if (!item || item.projected) return false;
    const val = effectiveValue(item);
    if (val == null || val < filters.minValue) return false;
    if (filters.maxValue != null && val > filters.maxValue) return false;
    if (terms.length > 0) {
      const idStr = String(id);
      const acronym = (item.acronym || '').toLowerCase();
      const name = (item.name || '').toLowerCase();
      return terms.some(term => idStr === term || acronym === term || (term.length >= 2 && name.includes(term)));
    }
    return typeof item.demand === 'number' && item.demand >= filters.minDemand;
  }

  function parsePlayerTradeCount(html) {
    if (typeof html !== 'string') return null;
    const jsonMatch = html.match(/\bvar\s+player_details_data\s*=\s*(\{[\s\S]*?\});/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Number.isSafeInteger(parsed?.trade_ad_count) && parsed.trade_ad_count >= 0) {
          return parsed.trade_ad_count;
        }
      } catch {}
    }
    const propMatch = html.match(/"trade_ad_count"\s*:\s*(\d+)/);
    if (propMatch) {
      const count = Number(propMatch[1]);
      if (Number.isSafeInteger(count)) return count;
    }
    const cardMatch = html.match(/Trade Ads Created<\/h\d>\s*<span[^>]*>\s*([\d,]+)\s*<\/span>/i);
    if (cardMatch) {
      const count = Number(cardMatch[1].replaceAll(',', ''));
      if (Number.isSafeInteger(count)) return count;
    }
    return null;
  }

  async function loadCatalog() {
    const { rolimonsV2Cache: cached } = await chrome.storage.local.get('rolimonsV2Cache');
    if (cached?.items && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const sample = Object.values(cached.items)[0];
      if (sample && 'demand' in sample) return cached.items;
    }
    const response = await fetch(ITEMS_URL, {
      credentials: 'omit',
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Rolimon's item catalog failed (HTTP ${response.status}).`);
    const items = TradeValues.parseItems(await response.json());
    await chrome.storage.local.set({ rolimonsV2Cache: { items, fetchedAt: Date.now() } });
    return items;
  }

  async function fetchRecentAds() {
    const response = await fetch(RECENT_ADS_URL, {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Rolimon's recent ads failed (HTTP ${response.status}).`);
    const payload = await response.json();
    if (payload?.success !== true || !Array.isArray(payload.trade_ads)) {
      throw new Error('Unexpected Rolimon’s recent-ads response.');
    }
    return payload.trade_ads;
  }

  async function resolvePlayerTradeCounts(userIds) {
    const now = Date.now();
    const rawCache = (await chrome.storage.local.get(PLAYER_CACHE_KEY))[PLAYER_CACHE_KEY] || {};
    const cache = {};
    for (const [id, entry] of Object.entries(rawCache)) {
      if (entry && Number.isSafeInteger(entry.tradeAdCount) && now - entry.fetchedAt < PLAYER_TTL_MS) {
        cache[id] = entry;
      }
    }
    const counts = new Map();
    const missing = [];
    for (const id of userIds) {
      const key = String(id);
      if (cache[key]) counts.set(id, cache[key].tradeAdCount);
      else if (missing.length < MAX_PLAYER_LOOKUPS) missing.push(id);
    }

    let cursor = 0;
    async function worker() {
      while (cursor < missing.length) {
        const userId = missing[cursor++];
        try {
          const response = await fetch(`${PLAYER_URL}/${userId}`, {
            credentials: 'omit',
            signal: AbortSignal.timeout(12000)
          });
          if (!response.ok) continue;
          const count = parsePlayerTradeCount(await response.text());
          if (count != null) {
            counts.set(userId, count);
            cache[String(userId)] = { tradeAdCount: count, fetchedAt: Date.now() };
          }
        } catch {}
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, missing.length) }, () => worker()));

    const entries = Object.entries(cache)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, 400);
    await chrome.storage.local.set({ [PLAYER_CACHE_KEY]: Object.fromEntries(entries) });
    return counts;
  }

  function formatSideItems(ids, catalog) {
    if (!Array.isArray(ids)) return [];
    return ids.filter(id => Number.isSafeInteger(id) && id > 0).map(id => {
      const item = catalog[id];
      const value = effectiveValue(item);
      const demand = item?.demand ?? null;
      return {
        id,
        name: item?.name || `Item ${id}`,
        acronym: item?.acronym || '',
        value,
        demand,
        demandLabel: demand != null ? TradeValues.DEMAND_LABELS[demand] || '' : '',
        projected: Boolean(item?.projected)
      };
    });
  }

  function extractCandidates(rows, catalog, filters) {
    const terms = parseQueryTerms(filters.itemQuery);
    const byUser = new Map();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [adId, timestamp, userId, username, giving, receiving] = row;
      if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(timestamp)) continue;
      const offerIds = Array.isArray(giving?.items) ? giving.items : [];
      if (!offerIds.length) continue;
      const matchedIds = [...new Set(offerIds)].filter(id => itemMatchesFilters(id, catalog[id], filters, terms));
      if (!matchedIds.length) continue;
      const prev = byUser.get(userId);
      if (prev && prev.timestamp >= timestamp) continue;

      const offerItems = formatSideItems(offerIds, catalog);
      const requestItems = formatSideItems(receiving?.items || [], catalog);
      const requestTags = Array.isArray(receiving?.tags)
        ? receiving.tags.map(tag => TAG_LABELS[tag]).filter(Boolean)
        : [];
      const offerRobux = Number.isSafeInteger(giving?.robux) && giving.robux > 0 ? giving.robux : 0;
      const requestRobux = Number.isSafeInteger(receiving?.robux) && receiving.robux > 0 ? receiving.robux : 0;
      byUser.set(userId, {
        adId: Number.isSafeInteger(adId) ? adId : 0,
        timestamp: timestamp * 1000,
        userId,
        username: String(username || `User ${userId}`),
        matchedItems: formatSideItems(matchedIds, catalog),
        offerItems,
        offerTotal: TradeValues.totalItems(offerIds, catalog).total,
        offerRobux,
        requestItems,
        requestTotal: TradeValues.totalItems(receiving?.items || [], catalog).total,
        requestTags,
        requestRobux,
        tradeUrl: `https://www.roblox.com/users/${userId}/trade`,
        rolimonsUrl: `${PLAYER_URL}/${userId}`
      });
    }
    return [...byUser.values()];
  }

  function matchStillQualifies(match, catalog, filters, terms) {
    if (Date.now() - match.timestamp > MATCH_RETENTION_MS) return false;
    if (!Number.isSafeInteger(match.tradeAdCount) || match.tradeAdCount > filters.maxTradeAds) return false;
    const offerIds = (match.offerItems || []).map(item => item.id);
    const matchedIds = [...new Set(offerIds)].filter(id => itemMatchesFilters(id, catalog[id], filters, terms));
    if (!matchedIds.length) return false;
    match.matchedItems = formatSideItems(matchedIds, catalog);
    return true;
  }

  async function schedule(state) {
    await chrome.alarms.clear(ALARM);
    if (state.enabled) {
      await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    }
  }

  async function scan(nextFilters) {
    const state = await read();
    if (nextFilters !== undefined) {
      state.filters = validateFilters(nextFilters);
    }
    const filters = state.filters;
    const terms = parseQueryTerms(filters.itemQuery);
    const [catalog, rows] = await Promise.all([loadCatalog(), fetchRecentAds()]);
    const candidates = extractCandidates(rows, catalog, filters);
    const tradeCounts = await resolvePlayerTradeCounts(candidates.map(c => c.userId));

    const merged = new Map();
    for (const prev of state.matches || []) {
      const copy = { ...prev };
      if (matchStillQualifies(copy, catalog, filters, terms)) {
        merged.set(copy.userId, copy);
      }
    }
    let freshHits = 0;
    for (const candidate of candidates) {
      const tradeAdCount = tradeCounts.get(candidate.userId);
      if (tradeAdCount == null || tradeAdCount > filters.maxTradeAds) continue;
      freshHits++;
      const existing = merged.get(candidate.userId);
      if (!existing || candidate.timestamp >= existing.timestamp) {
        merged.set(candidate.userId, { ...candidate, tradeAdCount });
      }
    }

    state.matches = [...merged.values()]
      .sort((a, b) => a.tradeAdCount - b.tradeAdCount || b.timestamp - a.timestamp)
      .slice(0, 40);
    state.lastScannedAt = Date.now();
    state.status = `Scanned ${rows.length} recent ads (${candidates.length} demand-range candidates): ${state.matches.length} low-trade match${state.matches.length === 1 ? '' : 'es'} (≤ ${filters.maxTradeAds.toLocaleString()} ads posted${freshHits !== state.matches.length ? `, ${freshHits} from latest feed` : ''}).`;
    await write(state);
    await schedule(state);
    return state;
  }

  async function command(message) {
    if (message.type === 'FINDER_STATUS') return read();
    if (message.type === 'FINDER_CLEAR') {
      const state = await read();
      state.matches = [];
      state.status = 'Cleared saved matches.';
      await write(state);
      return state;
    }
    if (message.type === 'FINDER_SCAN') {
      return scan(message.filters);
    }
    if (message.type === 'FINDER_SET_AUTO') {
      const state = await read();
      if (message.filters !== undefined) state.filters = validateFilters(message.filters);
      state.enabled = Boolean(message.enabled);
      if (!state.enabled) {
        state.status = 'Auto-scan stopped.';
        await write(state);
        await schedule(state);
        return state;
      }
      await write(state);
      return scan();
    }
    throw new Error('Unknown ad finder command.');
  }

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) {
      (async () => {
        try {
          await serial(async () => {
            const state = await read();
            if (!state.enabled) return;
            try {
              await scan();
            } catch (error) {
              const latest = await read();
              latest.status = `Auto-scan error: ${error.message || 'Scan failed'}`;
              await write(latest);
            }
          });
        } catch (error) { console.error(error); }
      })();
    }
  });

  const restore = () => {
    (async () => {
      try {
        await serial(async () => schedule(await read()));
      } catch (error) { console.error(error); }
    })();
  };
  chrome.runtime.onStartup.addListener(restore);
  chrome.runtime.onInstalled.addListener(restore);

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['FINDER_STATUS', 'FINDER_SCAN', 'FINDER_SET_AUTO', 'FINDER_CLEAR'].includes(message?.type)) return;
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('src/popup.html')) return;
    (async () => {
      try {
        const state = await serial(() => command(message));
        respond({ ok: true, state });
      } catch (error) {
        respond({ ok: false, error: error.message });
      }
    })();
    return true;
  });

  return { validateFilters, parsePlayerTradeCount, extractCandidates, itemMatchesFilters };
})();
