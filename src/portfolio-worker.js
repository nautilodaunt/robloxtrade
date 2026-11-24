// Service worker only. Backend for the portfolio & risk analyzer page. Read-only: it looks up a
// Roblox user's tradable limiteds, caches per-item model odds (one paced Rolimon's page at a time,
// only when the page asks), and syncs "never offer" with the deal finder for your own items.
const PortfolioWorker = (() => {
  const PAGE = 'src/portfolio.html', USERS = 'https://users.roblox.com';
  const TYPES = ['PORTFOLIO_STATUS', 'PORTFOLIO_LOAD', 'PORTFOLIO_INSIGHT', 'PORTFOLIO_KEEP'];
  const INSIGHTS = 'portfolioInsights', HISTORY = 'portfolioHistory', RECENT = 'portfolioRecent';
  const DEEP_GAP_MS = 1200, PRUNE_MS = 24 * 3600e3, MAX_INSIGHTS = 2000, MAX_USERS = 20, MAX_RECENT = 8, MAX_KEEP = 100;

  const validId = id => Number.isSafeInteger(id) && id > 0;
  const validInstance = id => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
  const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const local = () => chrome.storage.local;
  const get = async key => (await local().get(key))[key];
  const fail = (message, stop = false) => Object.assign(new Error(message), { stop });

  // Read-modify-write of local storage happens one at a time.
  let store = Promise.resolve();
  const serial = fn => { const result = store.then(fn); store = result.catch(() => {}); return result; };
  // Deep scan: one Rolimon's item page at a time, at least 1.2 s apart, to stay polite.
  let deep = Promise.resolve(), lastFetch = 0;
  const paced = fn => {
    const result = deep.then(async () => {
      const wait = lastFetch + DEEP_GAP_MS - Date.now();
      if (wait > 0) await sleep(Math.min(wait, DEEP_GAP_MS));
      try { return await fn(); } finally { lastFetch = Date.now(); }
    });
    deep = result.catch(() => {});
    return result;
  };

  const userView = u => ({ id: u.id, name: String(u.name || u.id).slice(0, 40), displayName: String(u.displayName || u.name || u.id).slice(0, 40) });
  const fresh = cache => Object.fromEntries(Object.entries(cache || {})
    .filter(([id, x]) => /^\d+$/.test(id) && x && Date.now() - x.at < PortfolioRisk.INSIGHT_TTL_MS));

  // Blank = you; digits = user ID; otherwise a username. Lookups go without cookies (public data, no CSRF).
  async function resolveUser(target, me) {
    const text = String(target ?? '').trim();
    if (!text) return me;
    if (/^\d{1,19}$/.test(text)) {
      const id = Number(text);
      if (!validId(id)) throw fail('Enter a valid Roblox user ID.');
      if (id === me.id) return me;
      const user = await MassTrades.request(`${USERS}/v1/users/${id}`, { credentials: 'omit' }).catch(error => {
        throw error.status === 404 || error.status === 400 ? fail(`No Roblox user with ID ${id}.`) : error;
      });
      if (user?.id !== id) throw fail(`No Roblox user with ID ${id}.`);
      return userView(user);
    }
    if (!/^[A-Za-z0-9_]{3,20}$/.test(text)) throw fail('Enter a Roblox username (3–20 letters, numbers or _) or a numeric user ID.');
    const data = await MassTrades.request(`${USERS}/v1/usernames/users`, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [text], excludeBannedUsers: false })
    });
    const user = Array.isArray(data?.data) ? data.data[0] : null;
    if (!validId(user?.id)) throw fail(`No Roblox user named “${text}”.`);
    return user.id === me.id ? me : userView(user);
  }

  const saveHistory = (userId, point) => serial(async () => {
    const all = (await get(HISTORY)) || {};
    const points = PortfolioRisk.recordHistory(own(all, String(userId))?.points, point);
    all[userId] = { points, at: Date.now() };
    const kept = Object.entries(all).filter(([id, x]) => /^\d+$/.test(id) && x && Array.isArray(x.points))
      .sort((a, b) => b[1].at - a[1].at).slice(0, MAX_USERS);
    await local().set({ [HISTORY]: Object.fromEntries(kept) });
    return points;
  });

  const recentList = async () => ((await get(RECENT)) || []).filter(u => validId(u?.id)).slice(0, MAX_RECENT);
  const remember = user => serial(async () => {
    const list = [{ id: user.id, name: user.name }, ...(await recentList()).filter(u => u.id !== user.id)].slice(0, MAX_RECENT);
    await local().set({ [RECENT]: list });
    return list;
  });

  function modelInfo() {
    const m = globalThis.VALUE_MODEL;
    return m ? { trainedAt: m.trainedAt ?? null, dataAt: m.dataAt || m.trainedAt || null } : null;
  }

  async function load(message) {
    const me = { ...(await MassTrades.account()) };
    me.displayName = me.name;
    const owner = await resolveUser(message.target, me), isSelf = owner.id === me.id;
    let copies;
    try { copies = await MassTrades.tradable(owner.id); }
    catch (error) {
      if (!isSelf && [400, 403, 404].includes(error.status)) throw fail(`${owner.name} won’t show their inventory (private, banned or trading unavailable).`);
      throw error;
    }
    const catalog = await MassTrades.values();
    const insights = fresh(await get(INSIGHTS));
    const analysis = PortfolioRisk.analyze(copies, catalog, insights);
    const history = await saveHistory(owner.id, PortfolioRisk.snapshot(analysis));
    const recent = isSelf ? await recentList() : await remember(owner);
    const keep = isSelf ? await DealFinder.getKeep() : [];
    return { owner, isSelf, me, copies, catalog, insights, history, keep, recent, loadedAt: Date.now(), model: modelInfo() };
  }

  // Only what the risk scoring and page need from the full item page.
  function summarize(page) {
    const d = page?.details || {}, p = page?.prediction, horizons = {};
    for (const [h, x] of Object.entries(p?.horizons || {})) {
      if (Number.isFinite(x?.up) && Number.isFinite(x?.down)) horizons[h] = { up: x.up, down: x.down, baseUp: x.baseUp ?? null, baseDown: x.baseDown ?? null };
    }
    return {
      at: Date.now(), value: d.value ?? null, rap: d.rap ?? null, demand: d.demand ?? null, trend: d.trend ?? null,
      projected: d.projected === true, sellers: d.sellers ?? null, salesPerDay: page?.salesPerDay ?? null,
      rap30: ItemInsights.rapChange(page?.history || [], 30),
      prediction: Object.keys(horizons).length ? { horizons, dataAt: p.dataAt ?? null, testPeriod: p.testPeriod ?? null } : null
    };
  }

  function prune(cache) {
    const kept = Object.entries(cache).filter(([id, x]) => /^\d+$/.test(id) && x && Date.now() - x.at < PRUNE_MS)
      .sort((a, b) => b[1].at - a[1].at).slice(0, MAX_INSIGHTS);
    return Object.fromEntries(kept);
  }

  async function insight(message) {
    const id = message.assetId;
    if (!validId(id)) throw fail('Invalid item ID.');
    const hit = own(await get(INSIGHTS), String(id));
    if (hit && Date.now() - hit.at < PortfolioRisk.INSIGHT_TTL_MS) return { assetId: id, insight: hit, cached: true };
    let page;
    try { page = await paced(() => getInsight(id)); }
    catch (error) {
      // Rate limits, blocks and missing site access would repeat for every item: tell the page to stop.
      throw fail(error.message, /\((429|403)\)|not granted/.test(error.message));
    }
    const summary = summarize(page);
    await serial(async () => {
      const cache = (await get(INSIGHTS)) || {};
      cache[id] = summary;
      await local().set({ [INSIGHTS]: prune(cache) });
    });
    return { assetId: id, insight: summary, cached: false };
  }

  async function keep(message) {
    const ids = message.instanceIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_KEEP || !ids.every(validInstance) || typeof message.keep !== 'boolean') {
      throw fail('Invalid protect request.');
    }
    const me = await MassTrades.account();
    return { keep: await DealFinder.setKeep(ids, message.keep, me.id) };
  }

  async function command(message) {
    if (message.type === 'PORTFOLIO_STATUS') return { recent: await recentList(), model: modelInfo() };
    if (message.type === 'PORTFOLIO_LOAD') return load(message);
    if (message.type === 'PORTFOLIO_INSIGHT') return insight(message);
    return keep(message);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!TYPES.includes(message?.type)) return;
    // Only the extension's own portfolio page; web pages and content scripts are refused.
    if (sender.id !== chrome.runtime.id || String(sender.url || '').split(/[?#]/)[0] !== chrome.runtime.getURL(PAGE)) return;
    command(message).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message, stop: error.stop === true }));
    return true;
  });

  return { resolveUser, summarize, prune };
})();
