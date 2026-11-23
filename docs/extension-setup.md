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

## Mass send exact trades (0.4.0)

1. Reload the extension at `chrome://extensions`. Allow the added `users.roblox.com` and `inventory.roblox.com` host access if Chrome prompts, and sign in to Roblox in the same profile.
2. Open the extension popup, find **Mass send exact trades**, and click **Load my inventory & items**.
3. Select up to four owned copies to offer (Command/Ctrl selects multiple). Each option identifies the copy and serial. Search for requested items in the four request slots and select catalog IDs from the suggestions. Repeat a requested ID in multiple slots for multiple copies.
4. Click **Find & preview matches**. The preview shows the account, both sides with quantities and IDs, estimated values, and recipients. Only recent ads offering exactly your requested combination and requesting exactly your offered combination qualify. Extra items, tags, Robux terms, and stale ads are excluded. This scans a recent feed snapshot, not every Roblox owner; zero matches is possible. Batches contain up to 20 distinct users.
5. Review the preview, check the review box, then click **Send reviewed batch**. Editing selections invalidates the preview; previews expire after five minutes. Sending uses the saved preview, never later form changes.
6. **Stop batch** cancels future sends. Already submitted offers remain actionable on Roblox; inspect/cancel them in **Outbound**. Stop cannot retract an in-flight request.

The sender fixes Robux to zero on both sides and locks your exact owned copy IDs. Before every send, it verifies the signed-in account, your selected copies and hold status, the recipient's availability to trade, and their exact requested item quantities and hold status. It never substitutes another copy of your item. Missing or unverifiable data pauses the batch. A recipient who cannot trade is skipped; other preflight failures pause the batch.

Fresh Rolimon’s values are fetched before preview and each send without a stale-cache fallback. Receiving value must be at least offered value; missing or zero totals block sending. Assigned values fall back to RAP, with this indicated in the preview. These estimates do not measure demand, projected status, or future sale price and cannot guarantee a profitable trade. Verify the actual requested items before starting. This version intentionally has no value-loss override.

At most one recipient is attempted per minute. API failures, rate limits, and verification challenges pause the batch without automatic retries or challenge bypass. The only retry allowed is an explicit CSRF-token rejection, using the same payload with the returned token. Attempts are recorded locally before submission, so an uncertain result or worker restart cannot silently duplicate a send. The same account/item combination/recipient is excluded from future batches after an attempted submission, including rejected or timed-out attempts. Restarting Chrome or updating the extension requires a new preview; closing the popup alone does not stop a running batch. Chrome sleep may delay sends.

Local storage holds previews, recipients, outcomes, and attempted-combination records. Session cookies remain managed by Chrome; no cookie export or manual token entry is used. Website content scripts cannot invoke the mass sender; only this extension's popup is accepted. Live authentication depends on Chrome cookie settings and Roblox account eligibility.

Research references: [Roblox trade API schema](https://trades.roblox.com/docs/json/v1) (`TradeRequest`, owned `userAssetIds`, `can-trade-with`, `trades/send`); [inventory API schema](https://inventory.roblox.com/docs/json/v1) (`assetId`, `userAssetId`, `isOnHold`, pagination); [users API schema](https://users.roblox.com/docs/json/v1) (authenticated account); [Rolimon’s recent-ad feed](https://api.rolimons.com/tradeads/v1/getrecentads) (live public response inspected November 11, 2026). The feed is not a version-stable published contract; unexpected terms are excluded rather than guessed.

Automated checks exercise exact payloads, duplicate quantities, item substitutions, holds, ownership/account/value changes, sender restrictions, stale previews, stop, CSRF, rate limits, challenges, uncertain delivery, and restart behavior. **No authenticated live trades were sent during implementation.** Test fixtures cannot verify Roblox’s current session or verification requirements in your Chrome profile.

## Low-trader demand ad finder

1. Open the extension popup and locate **Low-trader demand ad finder**.
2. Set your **Min item value** and **Max item value** range (leave Max blank for no upper cap), **Max trade ads posted** threshold, and **Minimum demand** (**Amazing only** by default, or **High & Amazing** to include High-demand items like `SSHF`). Optionally enter specific acronyms, names, or asset IDs (e.g. `SSHF, 8BRC`).
3. Click **Scan trade ads** for an immediate scrape, or **Auto-scan (1m)** to scan recent Rolimon’s trade ads every minute in the background.
4. Matching ads show each poster’s exact Rolimon’s **Trade Ads Created** count (sorted lowest first), the matched demand item(s), full offer/request breakdown, and direct links to their Roblox trade window and Rolimon’s profile. Projected items are excluded automatically.
