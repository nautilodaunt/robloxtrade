importScripts("values.js");
importScripts("item-insights.js");
importScripts("value-model.js");
importScripts("value-model-data.js");

const ENDPOINT = "https://api.rolimons.com/items/v2/itemdetails";
const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
let pending;
let retryAfter = 0;
let lastError = null;

// Item history for the hover panel, read from the item's Rolimon's page.
// Classic faces are Roblox bundles now: their old item page stopped updating
// the best price and names the bundle page, which has the live data and the
// full history. A face is read from there (remembered for next time).
const insights = new Map();
const bundlePages = new Map();
async function readPage(path) {
  const response = await fetch(`https://www.rolimons.com/${path}`, { credentials: "omit", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Rolimon's ${path.split("/")[0]} page failed (${response.status})`);
  const html = await response.text();
  return { html, result: ItemInsights.parseItemPage(html) };
}
// The item's live Rolimon's page: the bundle page for a classic face.
async function loadItemPage(id) {
  id = String(id);
  if (chrome.permissions && !await chrome.permissions.contains({ origins: ['https://www.rolimons.com/*'] })) {
    throw new Error("Chrome has not granted rolimons.com access.");
  }
  const known = bundlePages.get(id);
  let page = known ? await readPage(`bundle/${known}`).catch(() => null) : null;
  if (!page) {
    page = await readPage(`item/${id}`);
    const bundleId = page.result.details.bundleId;
    if (bundleId) {
      bundlePages.set(id, bundleId);
      if (bundleId !== known) {
        try { page = await readPage(`bundle/${bundleId}`); } catch { /* keep the old item page */ }
      }
    }
  }
  return page;
}
function getInsight(id) {
  const hit = insights.get(id);
  if (hit && Date.now() < hit.expires) return hit.promise;
  const promise = (async () => {
    const { html, result } = await loadItemPage(id);
    result.prediction = null;
    if (globalThis.ValueModel) {
      try {
        const series = ItemInsights.normalizePage(html, Date.now() / 1000 - 120 * 86400);
        // Best price Rolimon's seems to have stopped updating (the odds ignore it).
        const last = series.daily.t.length - 1;
        result.details.bestPriceStale = result.details.bestPrice != null && result.details.bestPrice === series.daily.best[last] && ValueModel.staleBest(series, last);
        // Value change odds, for valued items only (RAP-only items get none).
        if (result.details.value > 0) result.prediction = ValueModel.predict(series);
      } catch { /* the chart still works without a prediction */ }
    }
    return result;
  })();
  insights.set(id, { promise, expires: Date.now() + 10 * 60 * 1000 });
  promise.catch(() => { if (insights.get(id)?.promise === promise) insights.get(id).expires = Date.now() + RETRY_MS; });
  if (insights.size > 60) insights.delete(insights.keys().next().value);
  return promise;
}

// Three years of an item's Rolimon's history (the full value change log is
// always included) for the value forecast page, which runs the forecast
// itself. Cached 10 minutes; failures are not cached.
const seriesCache = new Map();
function getSeries(id) {
  id = String(id);
  const hit = seriesCache.get(id);
  if (hit && Date.now() < hit.expires) return hit.promise;
  const promise = loadItemPage(id).then(({ html, result }) => ({
    details: result.details,
    series: ItemInsights.normalizePage(html, Date.now() / 1000 - 3 * 365 * 86400)
  }));
  seriesCache.set(id, { promise, expires: Date.now() + 10 * 60 * 1000 });
  promise.catch(() => { if (seriesCache.get(id)?.promise === promise) seriesCache.delete(id); });
  if (seriesCache.size > 10) seriesCache.delete(seriesCache.keys().next().value);
  return promise;
}

async function getValues(force = false) {
  if (chrome.permissions && !await chrome.permissions.contains({ origins: ['https://api.rolimons.com/*'] })) {
    throw new Error("Chrome has not granted Rolimon's API access. Click the extension icon, then Allow Rolimon's access.");
  }
  const { rolimonsV2Cache: cache } = await chrome.storage.local.get("rolimonsV2Cache");
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return { ...cache, stale: false };
  // A cooldown check must not enter the failure handler and extend itself.
  if (!force && Date.now() < retryAfter) {
    if (cache) return { ...cache, stale: true };
    throw new Error(lastError || "Rolimon's request failed");
  }
  try {
    const response = await fetch(ENDPOINT, {
      credentials: "omit",
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Rolimon's request failed (${response.status})`);
    const items = TradeValues.parseItems(await response.json());
    const fresh = { items, fetchedAt: Date.now() };
    await chrome.storage.local.set({ rolimonsV2Cache: fresh });
    retryAfter = 0;
    lastError = null;
    return { ...fresh, stale: false };
  } catch (error) {
    retryAfter = Date.now() + RETRY_MS;
    lastError = error.message;
    if (cache) return { ...cache, stale: true };
    if (error.message === 'Failed to fetch') {
      lastError = "Chrome could not connect to api.rolimons.com (Failed to fetch). Open the API link in the popup to check whether Chrome can reach it.";
      throw new Error(lastError);
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'GET_TRADE_DATA') {
    // Check the sending frame's own URL, not the tab's: content scripts run only
    // in Roblox top frames, and another site's frame can sit inside a Roblox tab.
    if (!sender.tab || sender.frameId !== 0 || !/^https:\/\/(www|web)\.roblox\.com\//.test(sender.url || '')) return;
    const id = String(message.tradeId || '');
    const status = message.status;
    if (!/^\d+$/.test(id) && !['Inbound', 'Outbound', 'Completed', 'Inactive'].includes(status)) return;
    const path = /^\d+$/.test(id) ? `v2/trades/${id}` : `v1/trades/${status}?limit=100&sortOrder=Desc`;
    fetch(`https://trades.roblox.com/${path}`, { credentials: 'include', signal: AbortSignal.timeout(15000) })
      .then(async response => {
        if (!response.ok) throw new Error(`Trade data unavailable (${response.status})`);
        return response.json();
      }).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'GET_ITEM_INSIGHT') {
    // Only a numeric item ID reaches the fixed Rolimon's item URL.
    const id = String(message.itemId || '');
    if (!/^\d{1,20}$/.test(id)) return;
    getInsight(id).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type !== "GET_ROLIMONS_VALUES") return;
  // Fixed endpoint only: messages cannot turn this worker into a fetch proxy.
  if (!pending) pending = getValues(message.force === true && !sender.tab).finally(() => { pending = null; });
  pending.then(
    (data) => respond({ ok: true, ...data }),
    (error) => respond({ ok: false, error: error.message || "Rolimon's data unavailable" })
  );
  return true;
});

importScripts("trade-ads.js");
importScripts("mass-trades.js");
importScripts("ad-finder.js");
importScripts("deal-finder.js");
importScripts("portfolio-risk.js");
importScripts("portfolio-worker.js");
