// Service worker only. Never accepts payloads or credentials from a web page.
const MassTrades = (() => {
  const KEY = 'massTrades', HISTORY = 'massTradeAttempts', ALARM = 'mass-trades';
  const USERS = 'https://users.roblox.com', INVENTORY = 'https://inventory.roblox.com';
  const TRADES = 'https://trades.roblox.com';
  let queue = Promise.resolve(), generation = 0;
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const read = async () => (await chrome.storage.local.get(KEY))[KEY] || { enabled: false, status: 'Choose items to begin.' };
  const write = state => chrome.storage.local.set({ [KEY]: state });
  const validId = id => Number.isSafeInteger(id) && id > 0;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    [...a].sort((x, y) => x - y).every((id, i) => id === [...b].sort((x, y) => x - y)[i]);
  function ids(list, label) {
    if (!Array.isArray(list) || !list.length || list.length > 4 || !list.every(validId)) throw new Error(`${label}: select one to four items.`);
    return [...list];
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`API ${response.status}: ${data.errors?.[0]?.message || 'request failed; check Roblox before trying again.'}`);
    return data;
  }
  async function account() {
    const user = await request(`${USERS}/v1/users/authenticated`);
    if (!validId(user.id)) throw new Error('Sign in to Roblox first.');
    return user;
  }
  async function inventory(userId) {
    const result = [], seen = new Set();
    let cursor = '';
    for (let page = 0; page < 100; page++) {
      const data = await request(`${INVENTORY}/v1/users/${userId}/assets/collectibles?limit=100&sortOrder=Asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(data.data)) throw new Error('Unrecognized inventory response.');
      for (const item of data.data) {
        if (!validId(item.assetId) || !validId(item.userAssetId) || seen.has(item.userAssetId)) throw new Error('Invalid or duplicate inventory copy ID.');
        seen.add(item.userAssetId); result.push(item);
      }
      cursor = data.nextPageCursor;
      if (!cursor) return result;
    }
    throw new Error('Inventory too large to verify completely.');
  }
  function ownCopies(items, selected) {
    ids(selected, 'Your offer');
    if (new Set(selected).size !== selected.length) throw new Error('The same owned copy cannot be offered twice.');
    return selected.map(id => {
      const item = items.find(x => x.userAssetId === id);
      if (!item || item.isOnHold !== false) throw new Error('An offered copy is missing, on hold, or its hold status cannot be verified.');
      return item;
    });
  }
  function requestedCopies(items, wanted) {
    const used = new Set();
    return wanted.map(id => {
      const item = items.find(x => x.assetId === id && x.isOnHold === false && !used.has(x.userAssetId));
      if (!item) throw new Error('Recipient no longer has the exact requested items available.');
      used.add(item.userAssetId); return item;
    });
  }
  function matches(ads, offer, wanted, viewer) {
    if (ads?.success !== true || !Array.isArray(ads.trade_ads)) throw new Error('Unrecognized trade-ad feed.');
    const found = new Map();
    for (const row of ads.trade_ads) {
      if (!Array.isArray(row) || row.length !== 6) continue;
      const [, timestamp, userId, name, giving, receiving] = row;
      // Fail closed if the feed grows fields that might carry additional terms.
      const plain = side => side && Object.keys(side).every(k => k === 'items' || k === 'tags') &&
        (!side.tags || (Array.isArray(side.tags) && side.tags.length === 0));
      if (!validId(userId) || userId === viewer || !Number.isFinite(timestamp) ||
          Math.abs(Date.now() - timestamp * 1000) > 15 * 60000 || !plain(giving) || !plain(receiving)) continue;
      if (same(giving.items, wanted) && same(receiving.items, offer)) found.set(userId, { userId, name: String(name), outcome: 'Queued' });
    }
    return [...found.values()].slice(0, 20);
  }
  async function values() {
    // Separate from the display cache: never fall back to stale prices when sending.
    return TradeValues.parseItems(await request('https://api.rolimons.com/items/v2/itemdetails', { credentials: 'omit' }));
  }
  function valuation(offer, wanted, catalog) {
    const give = TradeValues.totalItems(offer, catalog), receive = TradeValues.totalItems(wanted, catalog);
    if (give.missing || receive.missing || give.total <= 0 || receive.total <= 0) throw new Error('Missing item values; sending is blocked.');
    if (receive.total < give.total) throw new Error(`Value guard: requesting ${receive.total.toLocaleString()} for ${give.total.toLocaleString()} offered. Choose a request worth at least your offer.`);
    return { give: give.total, receive: receive.total, rapFallbacks: give.rapFallbacks + receive.rapFallbacks };
  }
  const fingerprint = (userId, offer, wanted, target) => JSON.stringify([userId, [...offer].sort((a,b) => a-b), [...wanted].sort((a,b) => a-b), target]);
  async function preview(config) {
    if ((await read()).enabled) throw new Error('Stop the current batch first.');
    const version = generation;
    const selected = ids(config?.offerCopyIds, 'Your offer'), wanted = ids(config?.wanted, 'Your request');
    const user = await account(), own = ownCopies(await inventory(user.id), selected);
    const offer = own.map(x => x.assetId);
    if (offer.some(id => wanted.includes(id))) throw new Error('Choose different items on each side of the trade.');
    const catalog = await values(), estimate = valuation(offer, wanted, catalog);
    const ads = await request('https://api.rolimons.com/tradeads/v1/getrecentads', { credentials: 'omit' });
    const history = (await chrome.storage.local.get(HISTORY))[HISTORY] || {};
    const targets = matches(ads, offer, wanted, user.id).filter(t => !history[fingerprint(user.id, offer, wanted, t.userId)]);
    if (version !== generation) throw new Error('Preview cancelled.');
    const state = { enabled: false, previewId: crypto.randomUUID(), createdAt: Date.now(), userId: user.id,
      username: user.name, offerCopyIds: selected, offer, wanted, estimate,
      giving: own.map(x => ({ assetId: x.assetId, userAssetId: x.userAssetId, name: x.name, serialNumber: x.serialNumber })),
      receiving: wanted.map(id => ({ assetId: id, name: catalog[id].name })), targets,
      status: `${targets.length} exact matches in recent ads (up to 20 per batch).` };
    await write(state); return state;
  }
  async function schedule(state) {
    await chrome.alarms.clear(ALARM);
    if (state.enabled) await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, state.nextAt || 0) });
  }
  async function tick() {
    const state = await read(), version = generation;
    if (!state.enabled) return;
    const current = () => { if (version !== generation) throw new Error('Stopped.'); };
    if (state.inFlight) {
      state.enabled = false; state.status = 'Previous send was interrupted. Check Roblox Outbound; it will not be retried.';
      await write(state); await schedule(state); return;
    }
    if (Date.now() < state.nextAt) return schedule(state);
    const target = state.targets.find(t => t.outcome === 'Queued');
    if (!target) { state.enabled = false; state.status = 'Batch finished.'; await write(state); await schedule(state); return; }
    try {
      if ((await account()).id !== state.userId) throw new Error('Signed-in account changed.');
      ownCopies(await inventory(state.userId), state.offerCopyIds).forEach((item, i) => {
        if (item.assetId !== state.offer[i]) throw new Error('Offered copy no longer matches preview.');
      });
      valuation(state.offer, state.wanted, await values());
      if ((await request(`${TRADES}/v1/users/${target.userId}/can-trade-with`)).canTrade !== true) {
        target.outcome = 'Skipped: trading unavailable';
      } else {
        const receiving = requestedCopies(await inventory(target.userId), state.wanted);
        // No caller-provided payload: both sides are built only from the locked preview.
        const payload = { offers: [
          { userId: state.userId, userAssetIds: [...state.offerCopyIds], robux: 0 },
          { userId: target.userId, userAssetIds: receiving.map(x => x.userAssetId), robux: 0 }
        ] };
        current();
        const history = (await chrome.storage.local.get(HISTORY))[HISTORY] || {};
        const key = fingerprint(state.userId, state.offer, state.wanted, target.userId);
        if (history[key]) throw new Error('This recipient/combination was already attempted.');
        // Persist before POST. Timeouts or worker termination must never cause duplicate retries.
        history[key] = Date.now();
        await chrome.storage.local.set({ [HISTORY]: history });
        state.inFlight = target.userId;
        await write(state);
        const post = async token => {
          current();
          return fetch(`${TRADES}/v1/trades/send`, { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
        };
        let response = await post();
        // Retry only an explicit CSRF rejection, never challenges or uncertain sends.
        const token = response.headers.get('x-csrf-token');
        const challenge = response.headers.get('rblx-challenge-id');
        if (response.status === 403 && token && !challenge) {
          const error = await response.json().catch(() => ({}));
          if (error.errors?.some(e => e.code === 0 && /token/i.test(e.message))) response = await post(token);
        }
        if (!response.ok || response.headers.get('rblx-challenge-id')) throw new Error(`Send stopped (HTTP ${response.status}). Check Roblox for limits or verification; no automatic retry.`);
        const result = await response.json();
        if (!validId(result.id)) throw new Error('Uncertain send result. Check Roblox Outbound; no automatic retry.');
        target.outcome = 'Sent'; target.tradeId = result.id;
      }
      state.inFlight = null;
      state.status = `${target.name}: ${target.outcome}.`;
      state.nextAt = Date.now() + 60000;
      if (!state.targets.some(t => t.outcome === 'Queued')) { state.enabled = false; state.status += ' Batch finished.'; }
    } catch (error) {
      state.enabled = false;
      if (state.inFlight) target.outcome = 'Uncertain / rejected — check Roblox';
      state.inFlight = null;
      state.status = `Paused: ${error.message}`;
    }
    if (version !== generation) { state.enabled = false; state.status = 'Stopped. A request already submitted may still complete; check Roblox Outbound.'; }
    await write(state); await schedule(state);
  }
  async function command(message) {
    if (message.type === 'MASS_STATUS') return read();
    if (message.type === 'MASS_LOAD') {
      const user = await account();
      return { user, inventory: await inventory(user.id), catalog: await values() };
    }
    if (message.type === 'MASS_PREVIEW') return preview(message.config);
    const state = await read();
    if (message.type === 'MASS_STOP') {
      state.enabled = false; state.previewId = null;
      state.status = 'Stopped. Submitted trades remain in Roblox Outbound.';
    } else if (message.type === 'MASS_START') {
      if (state.enabled) throw new Error('Batch is already running.');
      if (!message.previewId || message.previewId !== state.previewId || Date.now() - state.createdAt > 5 * 60000) throw new Error('Create a fresh preview before sending.');
      if (!state.targets.length) throw new Error('No exact matches to send to.');
      state.enabled = true; state.previewId = null; state.nextAt = Date.now() + 1000;
      state.status = 'Sending the reviewed combination, at most once per minute.';
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
  return { same, matches, ownCopies, requestedCopies, valuation };
})();
