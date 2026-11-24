// Service worker only. Finds Rolimon's trade ads where you would GAIN Rolimon's value using
// items you actually own. Read-only: it never sends trades, it links you to the trade page.
const DealFinder = (() => {
  const KEY = 'valueDeals', ALARM = 'value-deals', PAGE = 'src/deals.html';
  const FEED = 'https://api.rolimons.com/tradeads/v1/getrecentads';
  const MINUTE = 60000, AD_TTL = 30 * MINUTE, INVENTORY_TTL = 10 * MINUTE;
  const MAX_ADS = 1000, MAX_DEALS = 50, MAX_CANDIDATES = 30, MAX_GIVE = 4, MAX_FAILURES = 5;
  const WATCH_OPTIONS = [0, 15, 30, 60, 120];
  const TAGS = { 1: 'any', 2: 'demand', 3: 'rares', 4: 'robux', 5: 'upgrade', 6: 'downgrade', 7: 'rap', 8: 'wishlist', 9: 'projecteds', 10: 'adds' };
  const USABLE = ['any', 'upgrade', 'downgrade', 'adds', 'demand', 'rares', 'rap', 'projecteds'];
  const TYPES = ['DEALS_STATUS', 'DEALS_LOAD', 'DEALS_SCAN', 'DEALS_STOP', 'DEALS_CLEAR'];

  const validId = id => Number.isSafeInteger(id) && id > 0;
  const validInstance = id => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
  // Your side: Rolimon's value, else RAP (overstates what you give, so gains are conservative).
  const giveWorth = item => item?.value ?? item?.rap ?? null;

  let queue = Promise.resolve();
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const area = () => chrome.storage.session || chrome.storage.local;
  const defaults = () => ({ minGainPct: 5, maxGainPct: 25, minDemand: -1, tags: [...USABLE], specific: true, tagOnly: true, keep: [] });
  async function read() {
    const stored = (await area().get(KEY))[KEY] || {};
    return { ads: {}, deals: [], inventory: [], watchUntil: 0, failures: 0, status: 'Load your inventory to begin.',
      ...stored, settings: { ...defaults(), ...(stored.settings || {}) } };
  }
  const write = state => area().set({ [KEY]: state });

  function settingsFrom(input = {}) {
    const int = (v, min, max, fallback, label) => {
      if (v === undefined || v === '' || v === null) return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
      return n;
    };
    const minGainPct = int(input.minGainPct, 0, 90, 5, 'Min gain %'), maxGainPct = int(input.maxGainPct, 1, 95, 25, 'Max gain %');
    if (maxGainPct <= minGainPct) throw new Error('Max gain % must be higher than min gain %.');
    if (input.tags !== undefined && !Array.isArray(input.tags)) throw new Error('Invalid tag list.');
    if (input.keep !== undefined && (!Array.isArray(input.keep) || !input.keep.every(validInstance))) throw new Error('Invalid "never offer" list.');
    return { minGainPct, maxGainPct, minDemand: int(input.minDemand, -1, 4, -1, 'Min demand'),
      tags: input.tags === undefined ? [...USABLE] : USABLE.filter(t => input.tags.includes(t)),
      specific: input.specific !== false, tagOnly: input.tagOnly !== false, keep: [...new Set(input.keep || [])].slice(0, 500) };
  }

  function parseAd(row) {
    if (!Array.isArray(row) || row.length < 6) return null;
    const [adId, timestamp, userId, name, giving, receiving] = row;
    if (!validId(userId) || !Number.isFinite(timestamp) || !giving || typeof giving !== 'object' || !receiving || typeof receiving !== 'object') return null;
    const get = Array.isArray(giving.items) ? giving.items : [], want = Array.isArray(receiving.items) ? receiving.items : [];
    const tags = Array.isArray(receiving.tags) ? receiving.tags : [];
    if (!get.length || get.length > 4 || want.length > 4 || ![...get, ...want].every(validId) || !tags.every(Number.isInteger)) return null;
    return { adId: Number.isSafeInteger(adId) ? adId : 0, at: timestamp * 1000, userId, name: String(name || userId).slice(0, 40),
      get: [...get], want: [...want], tags: [...new Set(tags)].sort((a, b) => a - b), robuxWanted: Number(receiving.robux) > 0 };
  }

  // Keeps the latest ad per poster for 30 minutes; `posts` counts distinct ads (reposting = keen to trade).
  function mergeAds(store, rows, now) {
    const ads = { ...(store || {}) };
    for (const row of rows) {
      const ad = parseAd(row);
      if (!ad || now - ad.at > AD_TTL) continue;
      const prev = ads[ad.userId];
      if (prev && prev.at >= ad.at) continue;
      ads[ad.userId] = { ...ad, posts: prev ? prev.posts + (prev.adId !== ad.adId ? 1 : 0) : 1, firstSeen: prev?.firstSeen ?? ad.at };
    }
    const kept = Object.values(ads).filter(a => now - a.at <= AD_TTL).sort((a, b) => b.at - a.at).slice(0, MAX_ADS);
    return Object.fromEntries(kept.map(a => [a.userId, a]));
  }

  // Their side: Rolimon's value only. RAP-only items count as 0; projected or unknown items void the ad.
  function theirSide(ids, catalog, minDemand) {
    let value = 0, rapIgnored = 0;
    for (const id of ids) {
      const item = catalog[id];
      if (!item || item.projected) return null;
      if (item.value == null) { if (item.rap == null) return null; rapIgnored++; continue; }
      if (minDemand >= 0 && !(item.demand >= minDemand)) return null;
      value += item.value;
    }
    return value > 0 ? { value, rapIgnored } : null;
  }

  const tagMet = (tags, offer, ad, catalog) => tags.filter(tag => MassTrades.tagSatisfied(tag, offer, ad.get, ad.want, catalog));

  // Ad names specific items: you must own every requested copy. Tags (e.g. Adds) may need one extra item.
  function specificPick(ad, tags, pool, catalog) {
    const used = new Set(), base = [];
    for (const id of ad.want) {
      const copy = pool.find(c => c.assetId === id && !used.has(c.instanceId));
      if (!copy) return null;
      used.add(copy.instanceId); base.push(copy);
    }
    if (!ad.tags.length) return { give: base, met: ['exact'] };
    const options = [base];
    if (base.length < MAX_GIVE) for (const extra of [...pool].sort((a, b) => a.worth - b.worth)) if (!used.has(extra.instanceId)) options.push([...base, extra]);
    for (const give of options) {
      const met = tagMet(tags, give.map(c => c.assetId), ad, catalog);
      if (met.length) return { give, met };
    }
    return null;
  }

  // Every 1–4 item combination of your most valuable copies, sorted by total.
  function buildCombos(pool) {
    const list = [...pool].sort((a, b) => b.worth - a.worth).slice(0, MAX_CANDIDATES), combos = [];
    const walk = (start, picked, total) => {
      if (picked.length) combos.push({ items: picked, total });
      if (picked.length === MAX_GIVE) return;
      for (let i = start; i < list.length; i++) walk(i + 1, [...picked, list[i]], total + list[i].worth);
    };
    walk(0, [], 0);
    return combos.sort((a, b) => a.total - b.total);
  }

  // Tag-only ad: the closest-to-fair offer that still gains at least minGain% and fits a request tag.
  function tagPick(ad, tags, theirValue, combos, catalog, settings) {
    const hi = theirValue * (1 - settings.minGainPct / 100), lo = theirValue * (1 - settings.maxGainPct / 100);
    let a = 0, b = combos.length;
    while (a < b) { const m = (a + b) >> 1; combos[m].total <= hi ? a = m + 1 : b = m; }
    for (let i = a - 1; i >= 0 && combos[i].total >= lo; i--) {
      const offer = combos[i].items.map(c => c.assetId);
      if (offer.some(id => ad.get.includes(id))) continue; // never swap an item for a copy of itself
      const met = tagMet(tags, offer, ad, catalog);
      if (met.length) return { give: combos[i].items, met };
    }
    return null;
  }

  function findDeals(ads, inventory, catalog, input, ownId, now = Date.now()) {
    const settings = settingsFrom(input), keep = new Set(settings.keep);
    const pool = (inventory || []).filter(c => !c.isOnHold && !keep.has(c.instanceId) && giveWorth(catalog[c.assetId]) > 0)
      .map(c => ({ ...c, worth: giveWorth(catalog[c.assetId]) }));
    const view = id => { const item = catalog[id] || {}; return { id, name: item.name || String(id), acronym: item.acronym || '', value: item.value ?? null, rap: item.rap ?? null, demand: item.demand ?? null }; };
    let combos = null;
    const deals = [];
    for (const ad of ads) {
      if (!ad || ad.userId === ownId || now - ad.at > AD_TTL) continue;
      if (ad.robuxWanted || ad.tags.includes(4)) continue; // they want Robux on top: not a value gain
      const specific = ad.want.length > 0;
      if (specific ? !settings.specific : !settings.tagOnly) continue;
      const tags = [...new Set(ad.tags.map(t => TAGS[t]).filter(t => settings.tags.includes(t)))];
      if (ad.tags.length && !tags.length) continue;
      if (!specific && !tags.length) continue;
      const theirs = theirSide(ad.get, catalog, settings.minDemand);
      if (!theirs) continue;
      const pick = specific ? specificPick(ad, tags, pool, catalog) : tagPick(ad, tags, theirs.value, combos ||= buildCombos(pool), catalog, settings);
      if (!pick) continue;
      const giveValue = pick.give.reduce((sum, c) => sum + c.worth, 0), gain = theirs.value - giveValue;
      const gainPct = Math.round(gain / theirs.value * 1000) / 10;
      if (gainPct < settings.minGainPct) continue;
      const giveIds = pick.give.map(c => c.assetId);
      // 0–5 scale (RAP-only = 0), same as the hover panel.
      const getDemand = TradeValues.averageDemand(ad.get, catalog).average, giveDemand = TradeValues.averageDemand(giveIds, catalog).average;
      deals.push({ adId: ad.adId, userId: ad.userId, name: ad.name, at: ad.at, posts: ad.posts || 1, kind: specific ? 'specific' : 'tags',
        tags: pick.met, get: ad.get.map(view),
        give: pick.give.map(c => ({ ...view(c.assetId), instanceId: c.instanceId, serialNumber: c.serialNumber ?? null, worth: c.worth })),
        getValue: theirs.value, giveValue, gain, gainPct, rapIgnored: theirs.rapIgnored,
        getDemand: getDemand == null ? null : Math.round(getDemand * 10) / 10, giveDemand: giveDemand == null ? null : Math.round(giveDemand * 10) / 10,
        overMax: gainPct > settings.maxGainPct,
        // 3 = they named these exact terms, 2 = upgrade (upgraders often pay a premium), 1 = you'd be proposing a lowball.
        confidence: specific ? 3 : pick.met.includes('upgrade') ? 2 : 1 });
    }
    return deals.sort((x, y) => y.confidence - x.confidence || y.gain - x.gain || y.at - x.at).slice(0, MAX_DEALS);
  }

  async function loadInventory(state) {
    const user = await MassTrades.account(), copies = await MassTrades.tradable(user.id), catalog = await MassTrades.values();
    if (state.userId && state.userId !== user.id) { state.ads = {}; state.deals = []; state.settings.keep = []; }
    Object.assign(state, { userId: user.id, username: user.name, inventoryAt: Date.now(),
      inventory: copies.map(c => ({ ...c, worth: giveWorth(catalog[c.assetId]), valued: catalog[c.assetId]?.value != null })) });
    return catalog;
  }

  async function scan(state) {
    let catalog = null;
    if (!state.userId || !(Date.now() - state.inventoryAt < INVENTORY_TTL)) catalog = await loadInventory(state);
    const feed = await MassTrades.request(FEED, { credentials: 'omit' });
    if (feed?.success !== true || !Array.isArray(feed.trade_ads)) throw new Error("Unrecognized Rolimon's trade-ad feed.");
    catalog ||= await MassTrades.values();
    const now = Date.now();
    state.ads = mergeAds(state.ads, feed.trade_ads, now);
    const ads = Object.values(state.ads);
    state.deals = findDeals(ads, state.inventory, catalog, state.settings, state.userId, now);
    state.lastScanAt = now; state.failures = 0;
    const watching = state.watchUntil > now ? ` Watching until ${new Date(state.watchUntil).toLocaleTimeString()}.` : '';
    state.status = `${state.deals.length} value deal${state.deals.length === 1 ? '' : 's'} from ${ads.length} ads seen in the last 30 min.${watching}`;
  }

  async function schedule(state) {
    await chrome.alarms.clear(ALARM);
    if (state.watchUntil > Date.now()) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  }

  async function command(message) {
    const state = await read();
    if (message.type === 'DEALS_STATUS') return state;
    if (message.type === 'DEALS_LOAD') { await loadInventory(state); state.status = `Loaded ${state.inventory.length} tradable copies. Pick settings, then Find deals.`; }
    else if (message.type === 'DEALS_SCAN') {
      if (message.settings !== undefined) state.settings = settingsFrom(message.settings);
      const minutes = Number(message.minutes ?? 0);
      if (!WATCH_OPTIONS.includes(minutes)) throw new Error('Choose a valid watch time.');
      state.watchUntil = minutes ? Date.now() + minutes * MINUTE : 0;
      await scan(state);
    } else if (message.type === 'DEALS_STOP') { state.watchUntil = 0; state.status = 'Stopped watching. Results stay until cleared.'; }
    else if (message.type === 'DEALS_CLEAR') { state.ads = {}; state.deals = []; state.status = 'Cleared.'; }
    await write(state); await schedule(state);
    return state;
  }

  async function tick() {
    const state = await read();
    if (!(state.watchUntil > Date.now())) {
      if (state.watchUntil) { state.watchUntil = 0; state.status = `Watch finished. ${state.deals.length} deal${state.deals.length === 1 ? '' : 's'} found.`; await write(state); }
      await schedule(state); return;
    }
    try { await scan(state); }
    catch (error) {
      state.failures = (state.failures || 0) + 1;
      // Rate limits and repeated failures stop watching instead of retrying harder.
      if (error.status === 429 || state.failures >= MAX_FAILURES) { state.watchUntil = 0; state.status = `Stopped watching: ${error.message}`; }
      else state.status = `Scan failed, will retry in a minute: ${error.message}`;
    }
    await write(state); await schedule(state);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!TYPES.includes(message?.type)) return;
    // Only the extension's own deal finder page; web pages and content scripts are refused.
    if (sender.id !== chrome.runtime.id || String(sender.url || '').split(/[?#]/)[0] !== chrome.runtime.getURL(PAGE)) return;
    serial(() => command(message)).then(state => respond({ ok: true, state }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) serial(tick).catch(console.error); });
  const restore = () => serial(async () => schedule(await read())).catch(console.error);
  chrome.runtime.onStartup.addListener(restore);
  chrome.runtime.onInstalled.addListener(restore);

  // "Never offer" list shared with the portfolio page (same queue, so it can't race a scan).
  const getKeep = () => serial(async () => (await read()).settings.keep);
  const setKeep = (ids, on, userId) => serial(async () => {
    if (!Array.isArray(ids) || !ids.every(validInstance) || typeof on !== 'boolean') throw new Error('Invalid "never offer" list.');
    const state = await read();
    // Loading another account in the deal finder resets its list, so don't mix accounts.
    if (state.userId && userId && state.userId !== userId) throw new Error('The deal finder is loaded for another Roblox account. Open it and load your inventory first.');
    const keep = new Set(state.settings.keep);
    for (const id of ids) on ? keep.add(id) : keep.delete(id);
    state.settings.keep = [...keep].slice(0, 500);
    await write(state);
    return state.settings.keep;
  });

  return { settingsFrom, parseAd, mergeAds, theirSide, buildCombos, findDeals, getKeep, setKeep, TAGS };
})();
