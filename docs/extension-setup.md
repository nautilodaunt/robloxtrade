# Load and try the value display

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the project root folder (the one containing `manifest.json`).
4. Open or refresh Roblox, then open a trade or the trade creation window.
5. Look for **Rolimon's value** beneath each side's Robux row.

After editing the extension, click its reload button in `chrome://extensions` and refresh the Roblox tab.

## What the total means

Each side adds up the selected items' Rolimon's assigned values. Items without an assigned value use RAP, and the row explicitly shows how many RAP fallbacks were used. Separate copies of the same item count separately. Robux is not added to this item-only total.

If an item has no data, the total says **Unavailable** rather than presenting an incomplete sum. The tooltip explains missing data and shows the fetch time. Network failures use a previous cached response, if available, labeled **cached**.

The background worker fetches `https://api.rolimons.com/items/v2/itemdetails` with credentials omitted. Display responses are cached for five minutes, simultaneous requests share one fetch, and failed requests wait at least a minute before retrying. The extension also supports explicitly started trade-ad posting and reviewed trade batches as described below. It never accepts incoming trades automatically.

## Verification

Run `npm ci` then `npm test` to run the automated checks. Tests cover two offer sections, duplicate item cards and links, inventory exclusion, dynamic item changes, missing values, RAP fallback, network failures, caching, and simultaneous requests.

The live Rolimon's endpoint was checked during implementation. Trade placement has been tested against DOM fixtures, **not a signed-in Roblox trade page**. Roblox can change its markup. If no row appears, inspect the trade section's markup so the selectors in `src/content.js` can be adjusted to the current layout. Empty offers are supported when the page exposes a recognized trade-offer/trade-request container; the generic label fallback requires at least one item link to identify a side safely.

## Data and platform references

- [Rolimon's item data endpoint](https://api.rolimons.com/items/v2/itemdetails)
- [Rolimon's item table](https://www.rolimons.com/itemtable)
- [Chrome extension cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

This is an independent implementation of a trade-value display. No RoValk code or assets are included.


## Updating from version 0.1.0

Reload **Roblox Trade Assistant** at `chrome://extensions`, then refresh the Roblox trade tab. Version 0.1.1 uses the newer Rolimon's feed (including newer limiteds) and handles migrated face bundle links by matching their URL names to a unique Rolimon's item name. Unresolvable bundles remain unavailable. In the current trade layout, each value row appears below that side's Total Value when no separate Robux row is shown.

## Automatic Rolimon’s trade ads (0.3.1)

1. Reload the extension at `chrome://extensions`, then refresh your Rolimon’s tab. This version adds access to `www.rolimons.com` and the scripting permission to read the ad you select.
2. Open [Rolimon’s ad creator](https://www.rolimons.com/tradeadcreate) while signed in. On other Rolimon’s pages, the extension’s **Choose items** button takes you there.
3. Select your offer and request with Rolimon’s normal inventory/catalog picker.
4. In the **Auto trade ads** panel at the bottom right, leave **As soon as cooldown ends** selected and click **Auto post this ad** once. The panel shows a live countdown; no further click is needed when it reaches zero. Longer repeat intervals are also available. Your current account, offer items, request items/tags, and offered Robux are captured automatically. No IDs or cookies need to be entered.
5. Click **Stop** in the panel or extension popup to cancel future posts. Use the minus button to minimize the panel.

Starting checks Rolimon’s website cooldown (`/tradeadcreate`), posts immediately when eligible, and repeats the captured ad. Changing selections on the site does not change a running ad until you click **Auto post this ad** again. Merely visiting Rolimon’s does not start posting. The popup links directly to the ad creator and shows the saved posting status.

Chrome must remain running; sleep and browser shutdown can delay alarms. Startup restores the saved schedule without sending missed posts in a burst. The extension uses your existing Rolimon’s session with credentialed requests to its fixed ad creator and ad creation endpoints; it never asks for or stores session cookies. Chrome’s cookie settings may prevent authentication; if posting pauses, check that you can create an ad on Rolimon’s in the same profile.

Cooldown and daily ad limits are read directly from Rolimon’s website (`seconds_until_next_trade_ad`, `Ad Cooldown`, and `Daily Ads Used` on `/tradeadcreate`) rather than enforced through local timers, so failed attempts or earlier repeat intervals never falsely block posting when your site cooldown is clear. A cooldown rejection (Rolimon’s code 7105) or HTTP 429 keeps posting enabled and syncs the next attempt to the remaining cooldown reported by Rolimon’s (or `Retry-After` header). Other failures pause posting without leaving a local cooldown behind. Resolve those problems and click **Auto post this ad** again. A network failure can leave delivery uncertain; check your ads on the site before restarting. Stop cannot retract a request already sent. Configuration and timing are stored locally in this Chrome profile.

The request format and creator selections were checked against [Rolimon’s ad creator client script](https://www.rolimons.com/js/tradeadcatalog4.js). Automated tests cover reading the selected ad, Robux, site cooldowns, authentication errors, sender restrictions, panel controls, scheduling, duplicate starts, stopping, restart recovery, and the local daily cap. **A real authenticated ad submission has not been tested.**

## Mass send trades (0.5.0)

1. Reload the extension at `chrome://extensions` and sign in to roblox.com in the same Chrome profile. If the popup shows **Allow value and trade API access**, click it (Rolimon’s API, `trades.roblox.com` and `users.roblox.com`).
2. In the popup, find **Mass send trades** and click **Load my inventory & values**. Progress and errors appear directly under the button. Copies on hold are hidden (their count is shown). If Rolimon’s values fail, your inventory still loads; retry in a minute before previewing.
3. Select up to four copies to give (Ctrl on Windows, ⌘ on Mac); the list is sorted by value. In the request boxes, search by name, acronym or asset ID and pick from the suggestions. Repeat an item to ask for two copies.
4. Choose which ads count as a match:
   - **Only ads asking for exactly your items**: the ad offers exactly what you request and asks for exactly your offer, with no tags or Robux.
   - **Exact ads + tags** (default): also matches ads that offer exactly what you request and ask for part of your offer plus a request tag your offer objectively fits. Any = always; Upgrade = they get fewer items, or the same number with a higher top value; Downgrade = they get more items; Adds = you give more items than they listed; Demand = every offered item has High or Amazing demand; Rares = an offered item is rare; RAP = an offered item has RAP but no value; Projecteds = an offered item is projected. Robux and Wishlist tags never match. An ad that adds Robux on their side can match, but the trade never asks for their Robux.
5. **Keep watching new ads** (default 30 minutes): Rolimon’s recent-ad feed only covers the last few minutes, so a one-time scan rarely finds anyone. While watching, the feed is rescanned every minute and new matching posters are queued until the time ends or **Max trades** (1–50, default 20) is reached. Ads older than 15 minutes are ignored.
6. Click **Find matches**, review the account, both sides, values, rules and recipients, tick the confirmation and click **Start sending**. Changing any setting invalidates the preview; previews expire after five minutes. Sending uses the saved preview, never later form changes.
7. **Stop** cancels future sends. Sent trades stay in Roblox **Outbound**; Stop cannot retract a request already in flight.

Trades use Roblox’s v2 trade API (`tradableItems`, `can-trade-with`, `trades/send`) with your exact collectible instance IDs and zero Robux on both sides. At most one trade is sent per minute. Before each send it rechecks your signed-in account, that your offered copies are still yours and not on hold, and fresh values (at most five minutes old, held in worker memory only). Sending is blocked if what you get is worth less than what you give (Rolimon’s value, RAP if unvalued), if a value is missing, or if a requested item is projected. These estimates cannot guarantee a good trade.

Recipient problems **skip** that person and the batch continues (up to five people are checked per minute): they can’t trade with you, no longer have the items, have them on hold, or their inventory returns 400/403/404. A Roblox 400 rejection on send is recorded and skipped; three in a row pause. Problems that would repeat for everyone **pause** the batch: signed out or account changed, your account can’t trade (including Roblox trade-eligibility limits), rate limits (429), verification challenges, server or network errors, five failed ad scans in a row, or an uncertain send result. Nothing is retried automatically except one explicit CSRF token refresh, and that token is reused for later sends.

Every attempt is recorded before the request is sent, so timeouts or worker restarts cannot cause duplicates. The same account/offer/request/recipient combination is not attempted again for 30 days, and older records are pruned. People already attempted are filtered out before the max-trades limit applies. Restarting Chrome or reloading the extension requires a new preview. Closing the popup does not stop a running batch; Chrome sleep can delay sends.

The running batch is stored in `chrome.storage.session`, which content scripts cannot read or write; only the attempt history (combination fingerprints and times) is in local storage. Prices are never taken from the shared local cache. Only the extension popup can control the mass sender. Session cookies stay with Chrome and are never read or stored.

References: [Roblox trades API v2](https://trades.roblox.com/docs/json/v2), [users API](https://users.roblox.com/docs/json/v1), [Rolimon’s recent-ad feed](https://api.rolimons.com/tradeads/v1/getrecentads) and [item details](https://api.rolimons.com/items/v2/itemdetails). A November 2026 sample of the feed had about 340 ads spanning roughly 3–4 minutes, most using numeric request tags (1 Any, 2 Demand, 3 Rares, 4 Robux, 5 Upgrade, 6 Downgrade, 7 RAP, 8 Wishlist, 9 Projecteds, 10 Adds). The feed is not a published stable contract; unknown fields are excluded rather than guessed.

Automated tests cover the v2 payload, exact and tag matching, value and projected guards, skip-versus-pause handling, history filtering and pruning, continuous watching, feed failures, CSRF reuse, rate limits, challenges, uncertain sends, stop, restart and inventory loading. **No authenticated live trades were sent during implementation**; try it first with cheap items. Mass trading can get an account trade-limited.

## Low-trader demand ad finder

1. Open the extension popup and locate **Low-trader demand ad finder**.
2. Set your **Min item value** and **Max item value** range (leave Max blank for no upper cap), **Max trade ads posted** threshold, and **Minimum demand** (**Amazing only** by default, or **High & Amazing** to include High-demand items like `SSHF`). Optionally enter specific acronyms, names, or asset IDs (e.g. `SSHF, 8BRC`).
3. Click **Scan trade ads** for an immediate scrape, or **Auto-scan (1m)** to scan recent Rolimon’s trade ads every minute in the background.
4. Matching ads show each poster’s exact Rolimon’s **Trade Ads Created** count (sorted lowest first), the matched demand item(s), full offer/request breakdown, and direct links to their Roblox trade window and Rolimon’s profile. Projected items are excluded automatically.

## Security hardening (0.5.1)

- **Trade overlay:** items are matched to Rolimon’s values by ID. Only migrated face bundles are still matched by name, and they are counted as **name-matched**. Items valued at a RAP that Rolimon’s marks as projected show **projected RAP**. In the trade list, items Rolimon’s does not list are valued at Roblox’s own RAP, which can be pumped, so they are flagged too. If what you receive includes any of these, a gain is shown in amber with **⚠ Verify** instead of green. Trade IDs read from the page must be numeric.
- **Auto trade ads:** the panel on Rolimon’s uses a closed shadow root, so page scripts cannot click its buttons. Each post is rebuilt from the saved selections and checked again; invalid saved data pauses posting. A cooldown time supplied by the page is ignored unless it ends within a day.
- **Ad finder:** trade and profile links are built from the numeric user ID, not read from storage.
- **Manifest:** requires Chrome 110 or later and cannot be enabled in Incognito, where the worker would use your regular profile’s Roblox and Rolimon’s sessions.
