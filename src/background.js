importScripts("values.js");

const ENDPOINT = "https://api.rolimons.com/items/v2/itemdetails";
const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
let pending;
let retryAfter = 0;
let lastError = null;

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
