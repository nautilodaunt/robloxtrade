// Runs only in the extension service worker. Session cookies stay in Chrome.
const TradeAds = (() => {
  const KEY = 'rolimonsTradeAds';
  const ALARM = 'rolimons-trade-ad';
  const CREATOR_URL = 'https://www.rolimons.com/tradeadcreate';
  const CREATE_AD_URL = 'https://api.rolimons.com/tradeads/v1/createad';
  const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
  let queue = Promise.resolve();
  const read = async () => (await chrome.storage.local.get(KEY))[KEY] || { enabled: false };
  const write = state => chrome.storage.local.set({ [KEY]: state });
  const serial = async fn => {
    const prev = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await prev;
    try { return await fn(); }
    finally { release(); }
  };
  const isWaitingForCooldown = state =>
    state.waitingForCooldown === true ||
    (state.waitingForCooldown === undefined && (/cooldown/i.test(state.status || '') || state.config?.minutes === 15));

  function parseSiteCooldown(html, now = Date.now()) {
    if (typeof html !== 'string') return null;
    const disabledMatch = html.match(/\bvar\s+trade_ads_currently_disabled\s*=\s*(true|false)\b/);
    const secondsMatch = html.match(/\bvar\s+seconds_until_next_trade_ad\s*=\s*(-?\d+(?:\.\d+)?)\b/);
    if (!secondsMatch && !disabledMatch) return null;
    const disabled = disabledMatch?.[1] === 'true';
    const seconds = secondsMatch ? Math.max(0, Math.ceil(Number(secondsMatch[1]))) : 0;
    const lastMatch = html.match(/\bvar\s+last_trade_ad_time\s*=\s*(\d+)\b/);
    const lastAdTime = lastMatch ? Number(lastMatch[1]) : 0;
    const cooldownMatch = html.match(/Ad Cooldown<\/div>\s*<div[^>]*>\s*(\d+)\s*Minutes?\s*<\/div>/i);
    const cooldownMinutes = cooldownMatch ? Number(cooldownMatch[1]) : 0;
    const dailyMatch = html.match(/Daily Ads Used<\/div>\s*<div[^>]*>\s*(\d+)\s*\/\s*(\d+)\s*<\/div>/i);
    const dailyUsed = dailyMatch ? Number(dailyMatch[1]) : 0;
    const dailyLimit = dailyMatch ? Number(dailyMatch[2]) : 0;
    // Signed-out /tradeadcreate renders "0 / 0" Daily Ads Used and "0 Minutes" Ad Cooldown.
    if (dailyMatch && dailyLimit === 0 && cooldownMinutes === 0 && seconds === 0 && lastAdTime === 0 && !disabled) {
      return null;
    }
    return {
      disabled,
      seconds,
      nextAt: seconds > 0 ? now + seconds * 1000 + 1000 : 0,
      cooldownMs: cooldownMinutes > 0 ? cooldownMinutes * 60000 : 0,
      dailyLimitReached: dailyLimit > 0 && dailyUsed >= dailyLimit
    };
  }

  async function fetchSiteCooldown() {
    try {
      const response = await fetch(CREATOR_URL, {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok || typeof response.text !== 'function') return null;
      return parseSiteCooldown(await response.text());
    } catch {
      return null;
    }
  }

  function validate(input) {
    const id = Number(input?.playerId);
    if (!/^[1-9]\d*$/.test(String(input?.playerId)) || !Number.isSafeInteger(id)) throw new Error('Enter a valid Roblox user ID.');
    const parse = (value, label) => {
      const parts = String(value || '').trim().split(/[\s,]+/).filter(Boolean);
      if (parts.length > 4 || parts.some(x => !/^[1-9]\d*$/.test(x) || !Number.isSafeInteger(Number(x)))) throw new Error(`${label}: enter up to four numeric item IDs.`);
      return parts.map(Number);
    };
    const offers = parse(input.offers, 'Offer');
    const requests = parse(input.requests, 'Request');
    const tags = Array.isArray(input.tags) ? [...new Set(input.tags)] : [];
    const allowed = ['any', 'demand', 'rares', 'robux', 'upgrade', 'downgrade', 'rap', 'wishlist', 'projecteds', 'adds'];
    if (!offers.length) throw new Error('Add at least one offer item.');
    if (tags.some(x => !allowed.includes(x)) || requests.length + tags.length < 1 || requests.length + tags.length > 4) throw new Error('Choose one to four request items/tags combined.');
    const minutes = Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) throw new Error('Choose an interval from 15 to 1440 minutes.');
    const offerRobux = Number(input.offerRobux || 0);
    if (!Number.isSafeInteger(offerRobux) || offerRobux < 0) throw new Error('Invalid offered Robux amount.');
    return { offerRobux, playerId: String(id), offers: offers.join(', '), requests: requests.join(', '), tags, minutes,
      payload: { player_id: id, offer_item_ids: offers, request_item_ids: requests, request_tags: tags, ...(offerRobux ? { offer_robux: offerRobux } : {}) } };
  }

  async function schedule(state) {
    await chrome.alarms.clear(ALARM);
    if (state.enabled && state.nextAt > 0) {
      await chrome.alarms.create(ALARM, { when: Math.max(Date.now() + 1000, state.nextAt) });
    }
  }

  async function post(prefetchedSite) {
    const state = await read();
    if (!state.enabled) return state;
    const waitingCooldown = isWaitingForCooldown(state);
    if (!waitingCooldown && state.nextAt && Date.now() < state.nextAt) {
      await schedule(state);
      return state;
    }
    const site = prefetchedSite !== undefined ? prefetchedSite : await fetchSiteCooldown();
    if (site?.disabled) {
      state.enabled = false;
      state.nextAt = 0;
      state.waitingForCooldown = false;
      state.status = 'Paused: Rolimon’s has temporarily disabled trade ads. Try again later.';
      await write(state); await schedule(state); return state;
    }
    if (site?.dailyLimitReached) {
      state.enabled = false;
      state.nextAt = 0;
      state.waitingForCooldown = false;
      state.status = 'Paused: Rolimon’s daily ad limit was reached. Try again later.';
      await write(state); await schedule(state); return state;
    }
    const websiteNextAt = site
      ? site.nextAt
      : (state.fallbackSiteNextAt || (waitingCooldown ? state.nextAt || 0 : 0));
    state.fallbackSiteNextAt = 0;
    if (websiteNextAt > Date.now()) {
      state.nextAt = websiteNextAt;
      state.waitingForCooldown = true;
      if (!state.lastPostedAt || /cooldown|Checking|enabled/i.test(state.status || '')) {
        state.status = 'Waiting for Rolimon’s cooldown. Your ad will post automatically.';
      }
      await write(state); await schedule(state); return state;
    }
    state.waitingForCooldown = false;
    state.nextAt = 0;
    state.status = 'Posting…';
    await write(state);
    try {
      const response = await fetch(CREATE_AD_URL, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.config.payload), signal: AbortSignal.timeout(15000)
      });
      const result = await response.json().catch(() => ({}));
      if (Number(result.code) === 7105 || response.status === 429) {
        const refreshed = await fetchSiteCooldown();
        const retryHeader = response.headers?.get?.('Retry-After');
        let retryAt = refreshed?.nextAt || 0;
        let retryHeaderUsed = false;
        if (retryHeader) {
          const seconds = Number(retryHeader);
          const supplied = Number.isFinite(seconds) ? Date.now() + seconds * 1000 + 1000 : Date.parse(retryHeader);
          if (Number.isFinite(supplied) && supplied > retryAt) {
            retryAt = supplied;
            retryHeaderUsed = true;
          }
        }
        if (retryAt <= Date.now()) {
          retryAt = Date.now() + (refreshed ? 5000 : (site?.cooldownMs || DEFAULT_COOLDOWN_MS) + 1000);
        }
        state.nextAt = retryAt;
        state.waitingForCooldown = !retryHeaderUsed;
        state.status = 'Waiting for Rolimon’s cooldown. Your ad will post automatically.';
        await write(state); await schedule(state); return state;
      }
      if (!response.ok || (result.success !== true && result.success !== 1)) {
        const messages = {
          2: 'The ad is invalid. Check your item IDs and inventory.',
          4: 'Sign in and verify your account on Rolimon’s, then start again.',
          5: 'Sign in and verify your account on Rolimon’s, then start again.',
          9: 'Rolimon’s could not create the trade ad right now. Try again later.',
          10: 'Rolimon’s could not create the trade ad right now. Try again later.',
          14: 'Rolimon’s daily ad limit was reached. Try again later.',
          7100: 'Invalid item ID in trade ad.',
          7101: 'Player account is terminated; trade ad cannot be submitted.',
          7102: 'Your trade ad posting capability is currently disabled on Rolimon’s.',
          7103: 'Player name is not yet scanned on Rolimon’s. Try again later.',
          7104: 'An offered item is no longer in Rolimon’s scan of your inventory. Refresh Rolimon’s and start again.',
          7106: 'Your inventory has not been scanned on Rolimon’s. Refresh the ad creator and start again.',
          7107: 'Your inventory scan on Rolimon’s is outdated. Refresh the ad creator and start again.',
          7108: 'Roblox Premium is required to create trade ads on Rolimon’s.',
          7109: 'Your Rolimon’s wishlist is empty. Add wishlist items on Rolimon’s first.',
          7110: 'Offered Robux exceeds 50% of current offered RAP. Refresh Rolimon’s and start again.',
          7111: 'Requested value exceeds 5x offered value. Adjust your ad and start again.',
          7112: 'Player ID does not match your verified Rolimon’s account.'
        };
        throw new Error(messages[result.code] || `Rolimon’s rejected the ad (HTTP ${response.status}, code ${result.code ?? 'unknown'}). Check the site for restrictions.`);
      }
      const postedAt = Date.now();
      const refreshed = await fetchSiteCooldown();
      const websiteCooldownAt = refreshed?.nextAt || (postedAt + (site?.cooldownMs || DEFAULT_COOLDOWN_MS) + 1000);
      const intervalNextAt = state.config.minutes > 15 ? postedAt + state.config.minutes * 60000 : 0;
      state.lastPostedAt = postedAt;
      state.nextAt = Math.max(websiteCooldownAt, intervalNextAt);
      state.waitingForCooldown = intervalNextAt <= websiteCooldownAt;
      state.status = 'Ad posted successfully.';
    } catch (error) {
      state.enabled = false;
      state.nextAt = 0;
      state.waitingForCooldown = false;
      state.status = `Paused: ${error.message || 'Posting failed'}`;
    }
    await write(state); await schedule(state);
    return state;
  }

  async function command(message) {
    if (message.type === 'GET_AD_STATUS') {
      const state = await read();
      if (!state.enabled) return state;
      if (isWaitingForCooldown(state)) {
        const site = await fetchSiteCooldown();
        if (site) return post(site);
      } else if (state.nextAt && Date.now() >= state.nextAt) {
        return post();
      }
      return state;
    }
    if (message.type === 'STOP_ADS') {
      const state = await read();
      state.enabled = false;
      state.nextAt = 0;
      state.waitingForCooldown = false;
      state.status = 'Auto posting stopped.';
      await write(state); await schedule(state); return state;
    }
    const config = validate(message.config);
    const state = await read();
    state.config = config;
    delete state.attempts;
    if (message.type === 'SAVE_AD') {
      state.enabled = false;
      state.nextAt = 0;
      state.waitingForCooldown = false;
      state.status = 'Ad saved. Click Start auto posting when ready.';
      await write(state); await schedule(state); return state;
    }
    if (message.type === 'START_ADS') {
      state.enabled = true;
      state.nextAt = 0;
      state.waitingForCooldown = true;
      state.fallbackSiteNextAt = message.siteNextAt > Date.now() ? message.siteNextAt : 0;
      state.status = 'Checking Rolimon’s cooldown…';
      await write(state);
      return post();
    }
    throw new Error('Unknown ad command.');
  }

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) {
      (async () => {
        try { await serial(() => post()); } catch (error) { console.error(error); }
      })();
    }
  });
  const restore = () => {
    (async () => {
      try {
        await serial(async () => {
          const state = await read();
          if (state.enabled && (!state.nextAt || Date.now() >= state.nextAt)) await post();
          else await schedule(state);
        });
      } catch (error) { console.error(error); }
    })();
  };
  chrome.runtime.onStartup.addListener(restore);
  chrome.runtime.onInstalled.addListener(restore);

  // Executed in the creator's main world only after the extension button is clicked.
  // Return ad selections, never cookies or other session data.
  function readCreator() {
    if (typeof jwt_player_id === 'undefined' || !jwt_player_id) throw new Error('Sign in on Rolimon’s first, then try again.');
    if (typeof generate_trade_ad_data_from_trade_object !== 'function' || typeof trade_object === 'undefined') throw new Error('Open Create Ad on Rolimon’s and choose your items first.');
    generate_trade_ad_data_from_trade_object();
    if (typeof is_trade_ad_valid !== 'function' || !is_trade_ad_valid()) throw new Error('Choose your offer and request using the ad creator. Check the Robux limit too.');
    if (typeof trade_ads_currently_disabled !== 'undefined' && trade_ads_currently_disabled) throw new Error('Rolimon’s has temporarily disabled trade ads. Try again later.');
    const onCooldown = typeof cooldown_active === 'boolean' ? cooldown_active : true;
    const completeAt = typeof cooldown_complete_time !== 'undefined' ? Number(cooldown_complete_time) : 0;
    return {
      playerId: String(jwt_player_id), offers: trade_ad_offer_item_ids.join(', '),
      requests: trade_ad_request_item_ids.join(', '), tags: [...trade_ad_request_tags],
      offerRobux: trade_object.offer_robux || 0,
      siteNextAt: onCooldown && completeAt > Date.now() ? completeAt : 0
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['GET_AD_STATUS', 'SAVE_AD', 'START_ADS', 'STOP_ADS', 'START_ADS_FROM_PAGE'].includes(message?.type)) return;
    if (sender.id !== chrome.runtime.id) return;
    const popup = !sender.tab && sender.url === chrome.runtime.getURL('src/popup.html');
    const site = sender.tab && /^https:\/\/www\.rolimons\.com\//.test(sender.url || '') && sender.frameId === 0;
    if (!popup && !site) return;
    if (site && !['GET_AD_STATUS', 'STOP_ADS', 'START_ADS_FROM_PAGE'].includes(message.type)) return;
    (async () => {
      try {
        const state = await serial(async () => {
          if (message.type !== 'START_ADS_FROM_PAGE') return command(message);
          if (!site || !/^https:\/\/www\.rolimons\.com\/tradeadcreate(?:[?#]|$)/.test(sender.url)) throw new Error('Open the Rolimon’s ad creator first.');
          const [snapshot] = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: 'MAIN', func: readCreator });
          if (snapshot?.error || !snapshot?.result) throw new Error(snapshot?.error?.message || 'Could not read your ad. Refresh Rolimon’s and try again.');
          return command({ type: 'START_ADS', config: { ...snapshot.result, minutes: message.minutes }, siteNextAt: snapshot.result.siteNextAt });
        });
        respond({ ok: true, state });
      } catch (error) {
        respond({ ok: false, error: error.message });
      }
    })();
    return true;
  });
  return { validate, parseSiteCooldown };
})();
