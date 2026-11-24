// Service worker only. Never accepts payloads or credentials from a web page.
const MassTrades = (() => {
  const KEY = 'massTrades', HISTORY = 'massTradeAttempts', ALARM = 'mass-trades';
  const USERS = 'https://users.roblox.com', TRADES = 'https://trades.roblox.com', ROLIMONS = 'https://api.rolimons.com';
  const MINUTE = 60000, SEND_GAP = MINUTE, SCAN_GAP = MINUTE, AD_AGE = 15 * MINUTE, PREVIEW_TTL = 5 * MINUTE, PRICE_TTL = 5 * MINUTE;
  const HISTORY_TTL = 30 * 24 * 60 * MINUTE, MAX_TRADES = 50, MAX_MINUTES = 180, MAX_TARGETS = 200, MAX_PAGES = 60;
  // Rolimon's numeric request tags. Robux/wishlist can never be satisfied: this tool never adds Robux.
  const TAGS = { 1: 'any', 2: 'demand', 3: 'rares', 4: 'robux', 5: 'upgrade', 6: 'downgrade', 7: 'rap', 8: 'wishlist', 9: 'projecteds', 10: 'adds' };
  const USABLE_TAGS = ['any', 'upgrade', 'downgrade', 'adds', 'demand', 'rares', 'rap', 'projecteds'];
  let queue = Promise.resolve(), generation = 0, csrf = '';
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  // Campaign state lives in session storage, which content scripts cannot read or write by default.
  const area = () => chrome.storage.session || chrome.storage.local;
  const read = async () => (await area().get(KEY))[KEY] || { enabled: false, status: 'Load your inventory to begin.' };
  const write = state => area().set({ [KEY]: state });
  const validId = id => Number.isSafeInteger(id) && id > 0;
  const validInstance = id => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
  const sorted = list => [...list].sort((x, y) => x - y);
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && sorted(a).every((id, i) => id === sorted(b)[i]);
  function subset(small, big) {
    const left = [...big];
    return small.every(id => { const i = left.indexOf(id); if (i < 0) return false; left.splice(i, 1); return true; });
  }
  class Pause extends Error {}
  // Errors that would repeat for every recipient stop the batch instead of skipping through the list.
  const systemic = error => error instanceof Pause || !error.status || error.status === 401 || error.status === 429 || error.status >= 500;
  async function request(url, options = {}) {
    const host = url.split('/')[2];
    let response;
    try { response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15000), ...options }); }
    catch (error) { throw Object.assign(new Error(`Could not reach ${host} (${error.message}). Check your connection and the extension's site access.`), { status: 0 }); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const hint = response.status === 401 ? ' Sign in to roblox.com in this Chrome profile.' : response.status === 429 ? ' Rate limited; wait a minute.' : '';
      throw Object.assign(new Error(`${host} returned ${response.status}: ${data.errors?.[0]?.message || 'request failed'}.${hint}`), { status: response.status });
    }
    return data;
  }
  async function account() {
    const user = await request(`${USERS}/v1/users/authenticated`).catch(error => {
      throw error.status === 401 ? new Pause('Sign in to roblox.com in this Chrome profile first.') : error;
    });
    if (!validId(user.id)) throw new Pause('Sign in to roblox.com in this Chrome profile first.');
    return { id: user.id, name: String(user.name || user.id) };
  }
  // Roblox's v2 trade inventory lists only tradable copies, keyed by collectible instance ID.
  async function tradable(userId, enough = () => false) {
    const copies = [], seen = new Set();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await request(`${TRADES}/v2/users/${userId}/tradableItems?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(data.items)) throw new Error('Unrecognized Roblox inventory response.');
      for (const item of data.items) {
        for (const copy of Array.isArray(item?.instances) ? item.instances : []) {
          const target = copy?.itemTarget || item.itemTarget || {}, assetId = Number(target.targetId), id = copy?.collectibleItemInstanceId;
          // Skip rows that cannot be identified exactly (bundles, odd data) instead of failing the whole inventory.
          if (target.itemType !== 'Asset' || !validId(assetId) || !validInstance(id) || seen.has(id)) continue;
          seen.add(id);
          copies.push({ instanceId: id, assetId, name: String(copy.itemName || item.itemName || assetId).slice(0, 80),
            serialNumber: Number.isSafeInteger(copy.serialNumber) ? copy.serialNumber : null, isOnHold: copy.isOnHold !== false });
        }
      }
      cursor = data.nextPageCursor;
      if (!cursor || enough(copies)) break;
    }
    return copies;
  }
  function offerIds(selected) {
    if (!Array.isArray(selected) || !selected.length || selected.length > 4 || !selected.every(validInstance)) throw new Error('You give: select one to four of your items.');
    if (new Set(selected).size !== selected.length) throw new Error('The same copy cannot be offered twice.');
    return [...selected];
  }
  const hasAll = ids => list => ids.every(id => list.some(x => x.instanceId === id && !x.isOnHold));
  function ownCopies(copies, selected) {
    return offerIds(selected).map(id => {
      const copy = copies.find(x => x.instanceId === id);
      if (!copy || copy.isOnHold) throw new Pause('An offered item is no longer tradable (traded away or on hold).');
      return copy;
    });
  }
  function requestedCopies(copies, wanted) {
    const used = new Set(), picked = wanted.map(id => {
      const copy = copies.find(x => x.assetId === id && !x.isOnHold && !used.has(x.instanceId));
      if (copy) used.add(copy.instanceId);
      return copy;
    });
    return picked.every(Boolean) ? picked : null;
  }
  function wantedIds(list) {
    if (!Array.isArray(list) || !list.length || list.length > 4 || !list.every(validId)) throw new Error('You get: choose one to four items from the suggestions.');
    return [...list];
  }
  function rules(config) {
    const number = (value, min, max, fallback, label) => {
      if (value === undefined) return fallback;
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
      return value;
    };
    if (config?.tags !== undefined && !Array.isArray(config.tags)) throw new Error('Invalid tag list.');
    return { mode: config?.mode === 'flexible' ? 'flexible' : 'exact', tags: USABLE_TAGS.filter(tag => config?.tags?.includes(tag)),
      minutes: number(config?.minutes, 0, MAX_MINUTES, 0, 'Watch time'), maxTrades: number(config?.maxTrades, 1, MAX_TRADES, 20, 'Max trades') };
  }
  const worth = (catalog, id) => catalog?.[id]?.value ?? catalog?.[id]?.rap ?? null;
  // Is a request tag objectively met by your offer? (Poster gives `wanted`, receives `offer`.)
  function tagSatisfied(tag, offer, wanted, requested, catalog) {
    const info = id => catalog?.[id] || {}, top = ids => Math.max(0, ...ids.map(id => worth(catalog, id) || 0));
    switch (tag) {
      case 'any': return true;
      case 'upgrade': return offer.length < wanted.length || (offer.length === wanted.length && top(offer) > top(wanted));
      case 'downgrade': return offer.length > wanted.length;
      case 'adds': return offer.length > requested.length;
      case 'demand': return offer.every(id => info(id).demand >= 3);
      case 'rares': return offer.some(id => info(id).rare === true);
      case 'rap': return offer.some(id => info(id).value == null && info(id).rap != null);
      case 'projecteds': return offer.some(id => info(id).projected === true);
      default: return false;
    }
  }
  function terms(giving, receiving, offer, wanted, rule, catalog) {
    const flexible = rule.mode === 'flexible';
    const only = (side, keys) => side && typeof side === 'object' && Object.keys(side).every(k => keys.includes(k));
    // Fail closed if the feed grows fields that might carry additional terms.
    if (!only(giving, flexible ? ['items', 'robux'] : ['items']) || !only(receiving, ['items', 'tags'])) return null;
    // Their side must be exactly what you want: never ask for part of someone's offer.
    if (!same(giving.items, wanted)) return null;
    const requested = receiving.items ?? [], tags = receiving.tags ?? [];
    if (!Array.isArray(requested) || !Array.isArray(tags) || !requested.every(validId)) return null;
    if (!tags.length) return same(requested, offer) ? 'exact' : null;
    if (!flexible || !subset(requested, offer)) return null;
    const met = tags.map(t => TAGS[t]).filter(tag => rule.tags.includes(tag) && tagSatisfied(tag, offer, wanted, requested, catalog));
    return met.length ? `${requested.length ? 'their items + ' : ''}${[...new Set(met)].join('/')}` : null;
  }
  function matches(ads, plan, catalog) {
    if (ads?.success !== true || !Array.isArray(ads.trade_ads)) throw new Error("Unrecognized Rolimon's trade-ad feed.");
    const found = new Map();
    for (const row of ads.trade_ads) {
      if (!Array.isArray(row) || row.length !== 6) continue;
      const [, timestamp, userId, name, giving, receiving] = row;
      if (!validId(userId) || userId === plan.userId || found.has(userId) || !Number.isFinite(timestamp) ||
          Math.abs(Date.now() - timestamp * 1000) > AD_AGE) continue;
      const why = terms(giving, receiving, plan.offer, plan.wanted, plan.rules, catalog);
      if (why) found.set(userId, { userId, name: String(name).slice(0, 40), why, outcome: 'Queued' });
    }
    return [...found.values()];
  }
  let prices = null;
  async function values() {
    // Worker memory only: pages can't tamper with it, and sends never use prices older than five minutes.
    if (prices && Date.now() - prices.at < PRICE_TTL) return prices.items;
    const items = TradeValues.parseItems(await request(`${ROLIMONS}/items/v2/itemdetails`, { credentials: 'omit' }));
    prices = { items, at: Date.now() };
    return items;
  }
  function valuation(offer, wanted, catalog) {
    const give = TradeValues.totalItems(offer, catalog), receive = TradeValues.totalItems(wanted, catalog);
    if (give.missing || receive.missing || give.total <= 0 || receive.total <= 0) throw new Pause('Missing item values; sending is blocked.');
    if (wanted.some(id => catalog[id]?.projected)) throw new Pause("A requested item is marked projected on Rolimon's (inflated price); sending is blocked.");
    if (receive.total < give.total) throw new Pause(`Value guard: requesting ${receive.total.toLocaleString()} for ${give.total.toLocaleString()} offered. Choose a request worth at least your offer.`);
    return { give: give.total, receive: receive.total, rapFallbacks: give.rapFallbacks + receive.rapFallbacks };
  }
  const fingerprint = (userId, offer, wanted, target) => JSON.stringify([userId, sorted(offer), sorted(wanted), target]);
  async function attempts() {
    const history = (await chrome.storage.local.get(HISTORY))[HISTORY] || {}, cutoff = Date.now() - HISTORY_TTL;
    for (const [key, at] of Object.entries(history)) if (!(at > cutoff)) delete history[key];
    return history;
  }
  const feed = () => request(`${ROLIMONS}/tradeads/v1/getrecentads`, { credentials: 'omit' });
  // History is filtered before any limit is applied, so old attempts never crowd out new matches.
  function fresh(found, state, history) {
    const have = new Set(state.targets.map(t => t.userId));
    return found.filter(t => !have.has(t.userId) && !history[fingerprint(state.userId, state.offer, state.wanted, t.userId)]);
  }
  function counts(state) {
    const c = { sent: 0, queued: 0, skipped: 0 };
    for (const t of state.targets || []) t.outcome === 'Sent' ? c.sent++ : t.outcome === 'Queued' ? c.queued++ : c.skipped++;
    return c;
  }
  async function preview(config) {
    if ((await read()).enabled) throw new Error('Stop the running batch first.');
    const version = generation, wanted = wantedIds(config?.wanted), rule = rules(config), selected = offerIds(config?.offerInstanceIds);
    const user = await account(), own = ownCopies(await tradable(user.id, hasAll(selected)), selected);
    const offer = own.map(x => x.assetId);
    if (offer.some(id => wanted.includes(id))) throw new Error('Choose different items on each side of the trade.');
    const catalog = await values(), estimate = valuation(offer, wanted, catalog);
    const plan = { userId: user.id, offer, wanted, rules: rule, targets: [] };
    const found = fresh(matches(await feed(), plan, catalog), plan, await attempts());
    if (version !== generation) throw new Error('Preview cancelled.');
    const targets = found.slice(0, rule.maxTrades);
    const state = { ...plan, targets, enabled: false, previewId: crypto.randomUUID(), createdAt: Date.now(), username: user.name,
      offerInstanceIds: selected, estimate,
      giving: own.map(x => ({ assetId: x.assetId, instanceId: x.instanceId, name: x.name, serialNumber: x.serialNumber, value: worth(catalog, x.assetId) })),
      receiving: wanted.map(id => ({ assetId: id, name: catalog[id].name, value: worth(catalog, id) })),
      status: `${found.length} matching ad${found.length === 1 ? '' : 's'} right now${found.length > targets.length ? ` (first ${targets.length} queued)` : ''}. ` +
        (rule.minutes ? `Will keep watching new ads for ${rule.minutes} min.` : 'Current ads only.') };
    await write(state); return state;
  }
  async function schedule(state) {
    await chrome.alarms.clear(ALARM);
    if (!state.enabled) return;
    const next = Math.min(state.targets.some(t => t.outcome === 'Queued') ? state.nextSendAt : Infinity,
      Date.now() < state.endsAt ? state.nextScanAt : Infinity, state.endsAt);
    await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, next || 0) });
  }
  async function rescan(state) {
    state.nextScanAt = Date.now() + SCAN_GAP;
    let found;
    try { found = matches(await feed(), state, await values()); }
    catch (error) {
      state.scanFailures = (state.scanFailures || 0) + 1;
      if (state.scanFailures >= 5) throw new Pause(`Rolimon's ad feed failed 5 times in a row (${error.message})`);
      state.notice = `Ad scan failed, will retry: ${error.message}`; return;
    }
    state.scanFailures = 0; state.notice = '';
    const { sent, queued } = counts(state), room = Math.min(state.rules.maxTrades - sent - queued, MAX_TARGETS - state.targets.length);
    if (room > 0) state.targets.push(...fresh(found, state, await attempts()).slice(0, room));
  }
  // Recipient problems skip that person; only systemic problems pause the batch.
  async function prepare(state, target) {
    try {
      const check = await request(`${TRADES}/v2/users/${target.userId}/can-trade-with`);
      if (check.canTrade !== true) {
        const reason = String(check.mutualTradeEligibility || 'Unknown');
        if (reason.startsWith('Calling')) throw new Pause(`Roblox says your account can't trade right now (${reason}).`);
        return { skip: `can't trade with them (${reason})` };
      }
      const picked = requestedCopies(await tradable(target.userId, list => requestedCopies(list, state.wanted)), state.wanted);
      return picked ? { picked } : { skip: 'no longer has the items, or they are on hold' };
    } catch (error) {
      if (systemic(error)) throw error;
      return { skip: `inventory or trading unavailable (Roblox ${error.status})` };
    }
  }
  async function submit(state, target, picked, current) {
    // Built only from the locked preview and the recipient's live inventory, never from a message payload.
    const body = JSON.stringify({
      senderOffer: { userId: state.userId, robux: 0, collectibleItemInstanceIds: [...state.offerInstanceIds] },
      recipientOffer: { userId: target.userId, robux: 0, collectibleItemInstanceIds: picked.map(x => x.instanceId) } });
    const send = async () => {
      current();
      const response = await fetch(`${TRADES}/v2/trades/send`, { method: 'POST', credentials: 'include', cache: 'no-store', body,
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }, signal: AbortSignal.timeout(15000) });
      return { response, data: await response.json().catch(() => null) };
    };
    let { response, data } = await send();
    const token = response.headers.get('x-csrf-token');
    // Retry only an explicit CSRF rejection (token is then cached), never challenges or uncertain sends.
    if (response.status === 403 && token && !response.headers.get('rblx-challenge-id') &&
        data?.errors?.some(e => e.code === 0 && /token/i.test(e.message))) {
      csrf = token; ({ response, data } = await send());
    }
    state.inFlight = null;
    const reason = data?.errors?.[0]?.message || `HTTP ${response.status}`;
    if (response.headers.get('rblx-challenge-id')) {
      target.outcome = 'Not sent: verification needed';
      throw new Pause('Roblox asked for verification. Send one trade by hand on roblox.com, then start a new batch.');
    }
    if (response.ok && validId(data?.tradeId)) { target.outcome = 'Sent'; target.tradeId = data.tradeId; state.rejections = 0; return; }
    if (response.status === 429) { target.outcome = 'Not sent: rate limited'; throw new Pause('Roblox is rate-limiting your trades (429). Wait before starting again.'); }
    if (response.status === 401) { target.outcome = 'Not sent: signed out'; throw new Pause('Roblox signed you out.'); }
    if (response.status === 400) {
      target.outcome = `Rejected by Roblox: ${reason}`;
      state.rejections = (state.rejections || 0) + 1;
      if (state.rejections >= 3) throw new Pause(`Roblox rejected 3 trades in a row (last: ${reason}).`);
      return;
    }
    target.outcome = 'Uncertain: check Roblox Outbound';
    throw new Pause(`Uncertain result (${reason}). Check Roblox Outbound; it will not be retried.`);
  }
  async function sendNext(state, current) {
    // Your own side is rechecked every round; any problem here pauses everything.
    if ((await account()).id !== state.userId) throw new Pause('Signed-in Roblox account changed.');
    const own = ownCopies(await tradable(state.userId, hasAll(state.offerInstanceIds)), state.offerInstanceIds);
    if (own.some((copy, i) => copy.assetId !== state.offer[i])) throw new Pause('Offered item no longer matches the preview.');
    valuation(state.offer, state.wanted, await values());
    for (let tries = 0; tries < 5; tries++) {
      const target = state.targets.find(t => t.outcome === 'Queued');
      if (!target) return;
      const history = await attempts(), key = fingerprint(state.userId, state.offer, state.wanted, target.userId);
      if (history[key]) { target.outcome = 'Skipped: already sent this trade before'; continue; }
      const { picked, skip } = await prepare(state, target);
      if (skip) { target.outcome = `Skipped: ${skip}`; continue; }
      current();
      // Persist before POST: timeouts or worker restarts must never cause duplicate sends.
      history[key] = Date.now();
      await chrome.storage.local.set({ [HISTORY]: history });
      state.inFlight = target.userId;
      await write(state);
      await submit(state, target, picked, current);
      state.nextSendAt = Date.now() + SEND_GAP;
      return;
    }
  }
  async function tick() {
    const state = await read(), version = generation;
    if (!state.enabled) return;
    const current = () => { if (version !== generation) throw new Pause('Stopped.'); };
    if (state.inFlight) {
      state.enabled = false; state.status = 'Previous send was interrupted. Check Roblox Outbound; it will not be retried.';
      await write(state); await schedule(state); return;
    }
    try {
      if (Date.now() < state.endsAt && Date.now() >= state.nextScanAt) await rescan(state);
      if (Date.now() >= state.nextSendAt && state.targets.some(t => t.outcome === 'Queued')) await sendNext(state, current);
      const { sent, queued, skipped } = counts(state);
      if (sent >= state.rules.maxTrades || (!queued && Date.now() >= state.endsAt)) {
        state.enabled = false; state.status = `Finished: ${sent} sent, ${skipped} skipped.`;
      } else state.status = `Running: ${sent} sent, ${queued} queued, ${skipped} skipped.${state.notice ? ` ${state.notice}` : ''}`;
    } catch (error) {
      state.enabled = false;
      const target = state.inFlight && state.targets.find(t => t.userId === state.inFlight);
      if (target) target.outcome = 'Uncertain: check Roblox Outbound';
      state.inFlight = null;
      state.status = `Paused: ${error.message}`;
    }
    if (version !== generation) { state.enabled = false; state.status = 'Stopped. A request already submitted may still complete; check Roblox Outbound.'; }
    await write(state); await schedule(state);
  }
  async function command(message) {
    if (message.type === 'MASS_STATUS') return read();
    if (message.type === 'MASS_LOAD') {
      const user = await account(), inventory = await tradable(user.id);
      let catalog = {}, valuesError = '';
      try { catalog = await values(); } catch (error) { valuesError = error.message; }
      return { user, inventory, catalog, valuesError };
    }
    if (message.type === 'MASS_PREVIEW') return preview(message.config);
    const state = await read();
    if (message.type === 'MASS_STOP') {
      state.enabled = false; state.previewId = null;
      state.status = 'Stopped. Submitted trades remain in Roblox Outbound.';
    } else if (message.type === 'MASS_START') {
      if (state.enabled) throw new Error('Batch is already running.');
      if (!message.previewId || message.previewId !== state.previewId || Date.now() - state.createdAt > PREVIEW_TTL) throw new Error('Create a fresh preview before sending.');
      if (!state.targets.length && !state.rules.minutes) throw new Error('No matching ads right now. Pick a watch time so it can wait for new ads.');
      const now = Date.now();
      Object.assign(state, { enabled: true, previewId: null, startedAt: now, endsAt: now + state.rules.minutes * MINUTE,
        nextSendAt: now + 1000, nextScanAt: now + SCAN_GAP, scanFailures: 0, rejections: 0, notice: '' });
      state.status = 'Running: sends at most one trade per minute.';
    }
    await write(state); await schedule(state); return state;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['MASS_LOAD', 'MASS_PREVIEW', 'MASS_START', 'MASS_STOP', 'MASS_STATUS'].includes(message?.type)) return;
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('src/popup.html')) return;
    if (message.type === 'MASS_STOP') generation++;
    serial(() => command(message)).then(state => respond({ ok: true, state }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) serial(tick).catch(console.error); });
  const restore = () => serial(async () => {
    const state = await read();
    // Require another preview after restarting Chrome or updating the extension.
    state.enabled = false; state.previewId = null;
    state.status = 'Create a new preview to send. Previous attempts will not be repeated.';
    await write(state); await schedule(state);
  }).catch(console.error);
  chrome.runtime.onStartup.addListener(restore);
  chrome.runtime.onInstalled.addListener(restore);
  // request/account/tradable/values are reused by the value deal finder (same worker, read-only calls).
  return { same, subset, matches, tagSatisfied, ownCopies, requestedCopies, valuation, rules, TAGS, request, account, tradable, values };
})();
