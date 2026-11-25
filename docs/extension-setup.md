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

- **Trade overlay:** items are matched to Rolimon’s values by ID. Migrated face bundles are matched to their original item by name and use its migrated value. Items Rolimon’s marks as projected get a **Projected** tag on their thumbnail (and a **Projected** line in the trade list). In the trade list, items Rolimon’s does not list are valued at Roblox’s own RAP, which can be pumped; if what you receive includes any of these, a gain is shown in amber with **⚠ Verify** instead of green. Trade IDs read from the page must be numeric.
- **Demand:** Rolimon’s demand is shown on a 0–5 scale (0 None, 1 Terrible, 2 Low, 3 Normal, 4 High, 5 Amazing). Items with no Rolimon’s value (RAP-only) or no assigned demand count as 0. Each side shows **Avg demand** below its total, and the trade summary shows give → receive average demand.
- **Item details on hover:** hover an item in a trade for about half a second to open a panel with its value, RAP, best price, demand, trend, sellers, sales per day, a RAP / best-price chart (30 days, 90 days or 1 year), recent Rolimon’s value and demand changes, and the odds of a Rolimon’s value change. Click the panel to pin it; press Esc or click elsewhere to close. History is read from the item’s rolimons.com page and cached for 10 minutes.
- **Rolimon’s value change odds:** for valued items, the panel shows the chance that Rolimon’s raises or lowers the value within **7, 14 or 30 days** (toggle 7D / 14D / 30D), next to how often that usually happens and the model’s backtest hit rate. Unvalued (RAP-only) items show “No prediction (unvalued item)”. See [Value change model](#value-change-model).
- **Auto trade ads:** the panel on Rolimon’s uses a closed shadow root, so page scripts cannot click its buttons. Each post is rebuilt from the saved selections and checked again; invalid saved data pauses posting. A cooldown time supplied by the page is ignored unless it ends within a day.
- **Ad finder:** trade and profile links are built from the numeric user ID, not read from storage.
- **Manifest:** requires Chrome 110 or later and cannot be enabled in Incognito, where the worker would use your regular profile’s Roblox and Rolimon’s sessions.

## Value change model

The odds come from gradient boosted trees (`src/value-model.js` for features and scoring, `src/value-model-data.js` for the generated trees), run in the service worker. For each horizon there are two models: “value higher after N days” and “value lower after N days”. Inputs are only data from before the prediction time: RAP and best price against value (7/30/90 days), RAP momentum, sellers, favorites, sales prices and volume, time since and size of the last value change, raises and lowers in the past year, Rolimon’s demand, trend, projected and hyped flags, and item age.

Training uses every valued item’s full Rolimon’s history since 2018 as weekly snapshots. It is tested honestly: tuned on data before the last six months, then scored on those months, which it never saw, against two simple rules (RAP vs value, and Rolimon’s own trend tag). The shipped model is then retrained on all data. Results are in `tools/data/model-report.json`.

To retrain (every 1–2 months; a backtest showed the ranking of items barely ages, but the shown percentages drift noticeably after about 3 months). The item panel shows the model’s age (“Model is 3 days old”), measured from the Rolimon’s data it was trained on; it turns yellow at 60 days and red at 90 days.

1. `node tools/collect-rolimons.cjs --refresh` saves each valued item’s rolimons.com page data to `tools/data/` (one request about every 2 seconds; it stops if rate limited repeatedly or shown a verification page). `--refresh` re-downloads items saved more than a day ago (change with `--max-age DAYS`) and refreshes the valued item list. If it stops, run the same command later and it continues where it left off. Without `--refresh` it only downloads items not saved yet.
2. `node tools/train-value-model.cjs` writes `src/value-model-data.js`, `tools/data/train.log` and `tools/data/model-report.json`. Optional: `--test 2026-05-01 --valid 2025-11-01` to move the test window.
3. Reload the extension.

Limitations: value changes are rare (most weeks nothing changes), Rolimon’s decisions can follow events the data doesn’t show (owner leaks, hoards, community discussion), and the rates drift over time, so treat the odds as a signal, not a promise.

## Value deal finder (0.6.0)

Finds recent Rolimon’s trade ads where you would **gain Rolimon’s value** with items you actually own. It never sends trades: each result links to the poster’s Roblox trade page so you make the offer yourself.

1. In the popup, click **Open value deal finder ↗**. It opens in its own tab.
2. Click **Load my inventory**. It reads your tradable copies from Roblox (you must be signed in to roblox.com in this Chrome profile).
3. Set **Min gain %**, **Max gain %**, the minimum demand of what you get, which ad types and request tags to fill, and any items to **never offer**. Then click **Find deals**, optionally watching new ads for 15 minutes to 2 hours.

How deals are found:

- **Ads asking for items you own:** you give exactly the requested copies (plus the cheapest single extra item if a tag such as **Adds** requires it), and the gain is their offer minus your items.
- **Tag-only ads** (Any, Upgrade, Downgrade, Adds, Demand, Rares, RAP, Projecteds): it tries every combination of one to four of your 30 most valuable copies and picks the one **closest to fair** that still gains at least the minimum and stays within the maximum. It only counts a tag your items really fit (Upgrade = they receive fewer items, or the same number with a bigger top item; Downgrade = more items; Demand = all your items are High or Amazing).
- What you get counts at **Rolimon’s value only**; RAP-only items count as 0 and are flagged. What you give uses value, or RAP if unvalued, so gains are understated rather than overstated.
- Skipped: ads asking for Robux or Wishlist only, ads offering projected or unknown items, your own ads, items on hold, and ads older than 30 minutes.
- Results are ranked by how likely the poster is to accept: **They asked for this** (the ad names exactly what you give) first, then **Upgrade premium** (upgraders often pay extra to consolidate), then **Your lowball offer** (Any/Downgrade/other tags, where you propose the gain). Within each group, bigger gains come first. Cards show both sides with demand, warnings when you would receive lower average demand, and how many times the poster reposted while you watched.

Limits: Rolimon’s recent-ads feed covers only the last few minutes, so watching finds far more. Watching scans once a minute, reloads your inventory every 10 minutes, and stops on a rate limit or after 5 failed scans in a row. A value gain on paper doesn’t mean the poster will accept or that the items will hold value: check demand and the hover panel’s value odds first.



## Portfolio & risk analyzer (0.7.0)

Scores a Roblox inventory for risk and answers **“should I do anything?”**. It's read-only: it never sends trades.

1. In the popup, click **Open portfolio & risk analyzer ↗**.
2. **Lookup:** enter a Roblox **user ID** or **username** and click **Analyze**. Leave it blank, or click **My inventory**, to analyze your own. You must be signed in to roblox.com. Other users whose inventory is private or who can't trade show a clear message instead. Recent lookups appear as chips.
3. The report shows:
   - Total value (Rolimon's value, or RAP for unvalued items), RAP, holdings, value on trade hold and a 0–100 **risk score** (Low < 35 ≤ Moderate < 65 ≤ High).
   - **Should I do anything?** gives a verdict (Yes / Maybe / No) plus prioritized action cards:
     - **Trade away soon:** projected items, or items with high model odds of a value lower.
     - **At risk but on hold:** the same, but the copies can't be traded yet.
     - **Spread risk:** one weaker item is over 50% of the value, or 3+ copies of one item are over 35%.
     - **Upgrade clutter:** 4+ low-demand or RAP-only copies.
     - **Hold:** likely risers. For your own inventory, a **Protect in deal finder** button adds them to the deal finder's *Never offer* list. That list syncs both ways.
   - **30-day outlook:** the share of value that's likely to rise, stay stable or drop. **Value history** keeps one point per day each time you load a portfolio (180 days, 20 users).
   - **Risk breakdown:** value drop / projected, concentration (HHI and top holding), low demand / liquidity, and value locked on hold. Each comes with the points it adds.
   - **Holdings:** filter and sort by risk, value, odds of a lower or raise, or RAP under value. Each row shows demand, trend, RAP gap, signals, model odds and serials. Rows in your own inventory also have a *Never offer* toggle.
4. **Deep model scan** (separate button): fetches each valued item's Rolimon's page, most valuable first, about one every 1.2 seconds, and runs the built-in value model for 7/14/30-day raise and lower odds. Results are cached for 6 hours. It never runs on its own. It stops on a rate limit (429), a block (403) or 3 failures in a row, and **Stop** ends it after the current item. Items without model odds are scored from Rolimon's trend, demand and RAP vs value.
5. **What-if trade simulator:** pick up to 4 of the copies to give and up to 4 items to get (name, acronym or ID). It compares value, RAP, risk score and meters before and after, and lists warnings: projected or RAP-only items, drop risk, giving away a likely riser, lower demand, losing value, or items on hold. It also shows which advisor actions the trade would resolve or create. **Get model odds for items you'd receive** deep-scans just those items.

Risk scores are estimates from Rolimon's data and the value model, not guarantees. Always check the item page before trading.

## Limiteds browser (0.8.0)

Browse **valued** limiteds (items with a Rolimon's value; RAP-only items are left out) in a value range, ranked by the value model's odds of a value **raise**. It doesn't need a Roblox sign-in.

1. In the popup, click **Open limiteds browser ↗**.
2. Set **Min / Max value** (`25000`, `25k` or `1.5m`; blank means no limit). Optionally set a minimum demand, a name or acronym search, and whether to include projected items. Click **Show items**. Filtering is instant because it only uses Rolimon's value list.
3. Pick **Raise within** (7, 14 or 30 days) and **Sort by**:
   - **Raise odds** (default)
   - **Raise vs usual** (how many times the normal rate)
   - **Raise − lower odds**
   - **Lowest lower odds**
   - **Value**
4. Click **Scan model odds**. Model odds need each item's Rolimon's page, so the scan takes about one new item per 1.2 seconds, up to the **Scan up to** limit you pick (25–500). **Scan all** does every unscanned item in the current filter, with the same pacing; the button shows the count and estimated time, and runs over 100 items ask to confirm first. Keep the tab open while it runs; anything scanned before you stop or close it stays saved. It starts with the most promising items: Raising trend, RAP above value, hyped, high demand. The list re-ranks live as odds arrive. Click **Stop** any time; the scan also stops on a rate limit or block.

The odds cache (6 hours) is shared with the portfolio analyzer, so items either page has scanned are free. Each row shows:

- a **Likely raise / Possible raise / Likely lower** label (same thresholds as the hover panel)
- the raise odds next to the usual rate, and the odds of a lower
- 7/14/30-day odds
- value, RAP gap, demand, trend, 30-day RAP change, sales per day and sellers

Items without enough recent data get no model odds and rank after scanned items.
