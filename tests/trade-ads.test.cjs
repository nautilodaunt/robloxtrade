const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function buildCreatorHtml({ seconds = 0, disabled = false, dailyUsed = 2, dailyLimit = 60, cooldownMinutes = 15, lastAdTime = 0 } = {}) {
  return `
    <div class="ad-stat-header">Daily Ads Used</div><div class="ad-stat-data">${dailyUsed} / ${dailyLimit}</div>
    <div class="ad-stat-header">Ad Cooldown</div><div class="ad-stat-data">${cooldownMinutes} Minutes</div>
    <script>
      var last_trade_ad_time = ${lastAdTime};
      var seconds_until_next_trade_ad = ${seconds};
      var trade_ads_currently_disabled = ${disabled};
    </script>`;
}

function setup(saved, reply = { success: true }, creator = {}, responseOptions = {}, siteConfig = {}) {
  let now = 200000000, state = saved, alarm, onAlarm, onStartup, onMessage;
  let siteCooldownUntil = siteConfig.cooldownUntil ?? 0;
  let siteState = {
    disabled: false,
    dailyUsed: 2,
    dailyLimit: 60,
    cooldownMinutes: 15,
    unavailable: false,
    signedOut: false,
    ...siteConfig
  };
  const calls = [], siteCalls = [];
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } }, AbortSignal, console,
    fetch: async (url, options = {}) => {
      if (url === 'https://www.rolimons.com/tradeadcreate') {
        siteCalls.push({ url, ...options });
        if (siteState.unavailable) throw new Error('Offline');
        if (siteState.signedOut) {
          return { ok: true, status: 200, text: async () => buildCreatorHtml({ seconds: 0, dailyUsed: 0, dailyLimit: 0, cooldownMinutes: 0 }) };
        }
        const seconds = siteState.seconds !== undefined
          ? siteState.seconds
          : Math.max(0, Math.ceil((siteCooldownUntil - now) / 1000));
        return { ok: true, status: 200, text: async () => buildCreatorHtml({ ...siteState, seconds }) };
      }
      calls.push({ url, ...options });
      const currentReply = typeof reply === 'function' ? reply() : reply;
      if (responseOptions.ok !== false && (currentReply.success === true || currentReply.success === 1) && siteState.autoCooldownOnPost !== false) {
        siteCooldownUntil = now + (siteState.cooldownMinutes || 15) * 60000;
      }
      return { ok: true, status: 200, json: async () => currentReply, ...responseOptions };
    },
    chrome: {
      scripting: {
        executeScript: async ({ func }) => [{
          result: vm.runInNewContext(`(${func.toString()})()`, { Date: { now: () => now }, ...creator })
        }]
      },
      storage: { local: { get: async () => ({ rolimonsTradeAds: state && structuredClone(state) }), set: async data => { state = structuredClone(data.rolimonsTradeAds); } } },
      alarms: { clear: async () => { alarm = undefined; }, create: async (name, options) => { alarm = { name, ...options }; }, onAlarm: { addListener: fn => { onAlarm = fn; } } },
      runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onStartup: { addListener: fn => { onStartup = fn; } }, onInstalled: { addListener() {} }, onMessage: { addListener: fn => { onMessage = fn; } } }
    }
  });
  vm.runInContext(fs.readFileSync('src/trade-ads.js', 'utf8'), context);
  const sender = { id: 'test', url: 'chrome-extension://test/src/popup.html' };
  return {
    TradeAds: vm.runInContext('TradeAds', context),
    calls, siteCalls,
    get state() { return state; }, get alarm() { return alarm; },
    advance: ms => { now += ms; },
    setSite: patch => { siteState = { ...siteState, ...patch }; if (patch.cooldownUntil !== undefined) siteCooldownUntil = patch.cooldownUntil; },
    command: (type, config) => new Promise(resolve => onMessage({ type, config }, sender, resolve)),
    fire: () => onAlarm({ name: 'rolimons-trade-ad' }), startup: () => onStartup(),
    pageCommand: (type, url = 'https://www.rolimons.com/tradeadcreate') => new Promise(resolve => {
      const accepted = onMessage({ type, minutes: 15 }, { id: 'test', url, tab: { id: 7 }, frameId: 0 }, resolve);
      if (!accepted) resolve(undefined);
    }),
    untrusted: () => onMessage({ type: 'START_ADS' }, { ...sender, tab: { id: 1 } }, () => { throw new Error('Unexpected response'); })
  };
}

const config = { playerId: '123', offers: '1029025, 1365767', requests: '', tags: ['upgrade'], minutes: 30 };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('validates ad slots, IDs and intervals before enabling', async () => {
  const app = setup();
  for (const change of [{ minutes: 1 }, { offers: 'x' }, { playerId: '0' }, { offers: '' }, { tags: [] }, { requests: '1,2,3,4' }, { tags: ['unknown'] }]) {
    assert.equal((await app.command('START_ADS', { ...config, ...change })).ok, false);
  }
  assert.equal(app.calls.length, 0);
  assert.equal(app.untrusted(), undefined);
});

test('posts with session credentials, queries website cooldown and respects repeat schedule', async () => {
  const app = setup();
  const result = await app.command('START_ADS', config);
  assert.equal(result.state.enabled, true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.siteCalls[0].credentials, 'include');
  assert.equal(app.siteCalls[0].cache, 'no-store');
  assert.equal(app.calls[0].credentials, 'include');
  assert.deepEqual(JSON.parse(app.calls[0].body), { player_id: 123, offer_item_ids: [1029025, 1365767], request_item_ids: [], request_tags: ['upgrade'] });
  // Second start while website cooldown is active waits for website cooldown instead of duplicating.
  await Promise.all([app.command('START_ADS', config), app.command('START_ADS', config)]);
  assert.equal(app.calls.length, 1);
  assert.match(app.state.status, /cooldown/);
  app.advance(15 * 60000 + 2000);
  app.fire(); await settle();
  assert.equal(app.calls.length, 2);
  await app.command('STOP_ADS');
  assert.equal(app.alarm, undefined);
  app.advance(30 * 60000); app.fire(); await settle();
  assert.equal(app.calls.length, 2);
});

test('failed API response pauses without leaving a local cooldown behind', async () => {
  const app = setup(undefined, { success: false, code: 5 });
  const result = await app.command('START_ADS', config);
  assert.equal(result.state.enabled, false);
  assert.equal(result.state.nextAt, 0);
  assert.match(result.state.status, /verify/);
  assert.equal(app.alarm, undefined);
  // Once verified, starting again when website has no cooldown posts immediately!
  const verified = setup(app.state, { success: true });
  const retry = await verified.command('START_ADS', config);
  assert.equal(verified.calls.length, 1);
  assert.equal(retry.state.status, 'Ad posted successfully.');
});

test('ignores stale local cooldowns when website reports zero cooldown', async () => {
  const staleLocal = {
    enabled: true,
    config,
    nextAt: 200000000 + 45 * 60000,
    attempts: Array(55).fill(200000000 - 1000),
    status: 'Waiting for cooldown. Your ad will post automatically.'
  };
  const app = setup(staleLocal, { success: true }, {}, {}, { seconds: 0 });
  // Even checking status syncs with website and clears false local cooldown immediately.
  const statusResult = await app.command('GET_AD_STATUS');
  assert.equal(app.calls.length, 1);
  assert.equal(statusResult.state.status, 'Ad posted successfully.');

  // Clicking Start after a previous long repeat interval also posts immediately if website has no cooldown.
  app.setSite({ seconds: 0, cooldownUntil: 0 });
  const startResult = await app.command('START_ADS', { ...config, minutes: 15 });
  assert.equal(app.calls.length, 2);
  assert.equal(startResult.state.status, 'Ad posted successfully.');
});

test('startup restores alarms and website daily limit pauses posting', async () => {
  const app = setup();
  await app.command('START_ADS', config);
  const restarted = setup(app.state);
  restarted.startup(); await settle();
  assert.equal(restarted.alarm.when, app.state.nextAt);
  assert.equal(restarted.calls.length, 0);

  const capped = setup(undefined, { success: true }, {}, {}, { dailyUsed: 60, dailyLimit: 60 });
  const result = await capped.command('START_ADS', config);
  assert.equal(capped.calls.length, 0);
  assert.equal(result.state.enabled, false);
  assert.match(result.state.status, /daily ad limit/i);
});

test('saving an edited ad stops automatic posting without sending it', async () => {
  const app = setup();
  await app.command('START_ADS', config);
  const result = await app.command('SAVE_AD', { ...config, offers: '42' });
  assert.equal(result.state.enabled, false);
  assert.equal(result.state.nextAt, 0);
  assert.equal(result.state.config.offers, '42');
  assert.equal(app.calls.length, 1);
  assert.equal(app.alarm, undefined);
});

test('on-site button reads creator selections, preserves Robux and uses live website cooldown over stale tab timer', async () => {
  const creator = {
    jwt_player_id: 456, trade_object: { offer_robux: 100 },
    generate_trade_ad_data_from_trade_object() {}, is_trade_ad_valid: () => true,
    trade_ad_offer_item_ids: [101], trade_ad_request_item_ids: [202], trade_ad_request_tags: ['adds'],
    cooldown_active: true,
    cooldown_complete_time: 200900000 // stale 15-min tab timer
  };
  // Live website says only 60s of cooldown remain.
  const app = setup(undefined, { success: true }, creator, {}, { cooldownUntil: 200060000 });
  const result = await app.pageCommand('START_ADS_FROM_PAGE');
  assert.equal(result.ok, true);
  assert.equal(app.calls.length, 0);
  assert.equal(app.state.config.playerId, '456');
  assert.equal(app.state.config.payload.offer_robux, 100);
  assert.equal(app.alarm.when, 200061000);
  app.advance(61000); app.fire(); await settle();
  assert.deepEqual(JSON.parse(app.calls[0].body), {
    player_id: 456, offer_item_ids: [101], request_item_ids: [202], request_tags: ['adds'], offer_robux: 100
  });
  assert.equal((await app.pageCommand('STOP_ADS')).state.enabled, false);
});

test('on-site button posts immediately when cooldown_active is false or live website cooldown is zero', async () => {
  const creator = {
    jwt_player_id: 456, trade_object: { offer_robux: 0 },
    generate_trade_ad_data_from_trade_object() {}, is_trade_ad_valid: () => true,
    trade_ad_offer_item_ids: [101], trade_ad_request_item_ids: [], trade_ad_request_tags: ['any'],
    cooldown_active: false,
    cooldown_complete_time: 200900000
  };
  const app = setup(undefined, { success: true }, creator, {}, { unavailable: true });
  const result = await app.pageCommand('START_ADS_FROM_PAGE');
  assert.equal(result.ok, true);
  assert.equal(app.calls.length, 1);
  assert.equal(result.state.status, 'Ad posted successfully.');
});

test('on-site flow reports missing sign-in and rejects unrelated origins and direct config commands', async () => {
  const app = setup();
  assert.match((await app.pageCommand('START_ADS_FROM_PAGE')).error, /Sign in/);
  assert.match((await app.pageCommand('START_ADS_FROM_PAGE', 'https://www.rolimons.com/trades')).error, /creator/);
  assert.equal(await app.pageCommand('START_ADS_FROM_PAGE', 'https://example.com/'), undefined);
  assert.equal(await app.pageCommand('START_ADS'), undefined);
  assert.equal(app.calls.length, 0);
});

test('server 7105 cooldown syncs exact remaining seconds from website instead of forcing 15 minutes', async () => {
  let postCount = 0;
  const exactApp = setup(
    undefined,
    () => {
      postCount++;
      if (postCount === 1) {
        exactApp.setSite({ cooldownUntil: 200045000 });
        return { success: false, code: 7105 };
      }
      return { success: true };
    },
    {},
    {},
    { cooldownUntil: 0 }
  );
  const result = await exactApp.command('START_ADS', { ...config, minutes: 15 });
  assert.equal(result.state.enabled, true);
  assert.match(result.state.status, /cooldown/);
  assert.equal(exactApp.calls.length, 1);
  assert.equal(exactApp.alarm.when, 200046000); // 45s + 1s buffer, not 15 minutes!
  exactApp.advance(44000); exactApp.fire(); await settle();
  assert.equal(exactApp.calls.length, 1);
  exactApp.advance(2000); exactApp.fire(); await settle();
  assert.equal(exactApp.calls.length, 2);
  assert.equal(exactApp.state.status, 'Ad posted successfully.');
  assert.equal(exactApp.state.enabled, true);
});

test('Stop cancels an ad waiting on a server cooldown', async () => {
  const app = setup(undefined, { success: false, code: 7105 }, {}, {}, { cooldownUntil: 200300000 });
  await app.command('START_ADS', config);
  await app.command('STOP_ADS');
  app.advance(20 * 60000); app.fire(); await settle();
  assert.equal(app.calls.length, 0);
  assert.equal(app.alarm, undefined);
});

test('rate limits respect both shorter and longer Retry-After headers without stopping the schedule', async () => {
  const shortLimit = setup(undefined, {}, {}, { ok: false, status: 429, headers: { get: name => name === 'Retry-After' ? '120' : null } });
  const r1 = await shortLimit.command('START_ADS', config);
  assert.equal(r1.state.enabled, true);
  assert.equal(shortLimit.alarm.when, 200000000 + 120000 + 1000);

  const longLimit = setup(undefined, {}, {}, { ok: false, status: 429, headers: { get: name => name === 'Retry-After' ? '1800' : null } });
  const r2 = await longLimit.command('START_ADS', config);
  assert.equal(r2.state.enabled, true);
  assert.equal(longLimit.alarm.when, 200000000 + 1800000 + 1000);
  longLimit.advance(900000); longLimit.fire(); await settle();
  assert.equal(longLimit.calls.length, 1);
});

test('parseSiteCooldown distinguishes signed-out pages from signed-in zero cooldown', () => {
  const { TradeAds } = setup();
  assert.equal(TradeAds.parseSiteCooldown(buildCreatorHtml({ seconds: 0, dailyUsed: 0, dailyLimit: 0, cooldownMinutes: 0 }), 1000), null);
  const ready = TradeAds.parseSiteCooldown(buildCreatorHtml({ seconds: 0, dailyUsed: 0, dailyLimit: 60, cooldownMinutes: 10 }), 1000);
  assert.equal(ready.nextAt, 0);
  assert.equal(ready.cooldownMs, 600000);
  assert.equal(ready.dailyLimitReached, false);
  const active = TradeAds.parseSiteCooldown(buildCreatorHtml({ seconds: 90, dailyUsed: 5, dailyLimit: 60, cooldownMinutes: 15 }), 1000);
  assert.equal(active.nextAt, 92000);
});

test('worker rebuilds the stored ad request and pauses on invalid saved settings', async () => {
  const app = setup();
  await app.command('SAVE_AD', config);
  // Another extension context rewrites the stored payload.
  const tampered = { ...app.state, enabled: true, config: { ...app.state.config, payload: { player_id: 1, offer_item_ids: [5], request_tags: ['evil'] } } };
  const restarted = setup(tampered);
  restarted.startup(); await settle();
  assert.equal(restarted.calls.length, 1);
  assert.deepEqual(JSON.parse(restarted.calls[0].body), { player_id: 123, offer_item_ids: [1029025, 1365767], request_item_ids: [], request_tags: ['upgrade'] });

  const broken = setup({ ...tampered, config: { ...tampered.config, offers: '1; 2' } });
  broken.startup(); await settle();
  assert.equal(broken.calls.length, 0);
  assert.equal(broken.state.enabled, false);
  assert.match(broken.state.status, /invalid/i);
  assert.equal(broken.alarm, undefined);
});

test('a page-supplied cooldown is used only if it ends within a day', async () => {
  const creator = completeAt => ({
    jwt_player_id: 456, trade_object: { offer_robux: 0 },
    generate_trade_ad_data_from_trade_object() {}, is_trade_ad_valid: () => true,
    trade_ad_offer_item_ids: [101], trade_ad_request_item_ids: [], trade_ad_request_tags: ['any'],
    cooldown_active: true, cooldown_complete_time: completeAt
  });
  // The live website check fails, so only the page's value is available.
  const near = setup(undefined, { success: true }, creator(200060000), {}, { unavailable: true });
  assert.equal((await near.pageCommand('START_ADS_FROM_PAGE')).ok, true);
  assert.equal(near.calls.length, 0);
  assert.equal(near.alarm.when, 200060000);
  const far = setup(undefined, { success: true }, creator(200000000 + 10 * 86400000), {}, { unavailable: true });
  assert.equal((await far.pageCommand('START_ADS_FROM_PAGE')).ok, true);
  assert.equal(far.calls.length, 1);
});
