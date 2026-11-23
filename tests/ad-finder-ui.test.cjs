const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');

const settle = () => new Promise(resolve => setImmediate(resolve));

test('ad finder popup UI sends customizable filters, renders trade counts safely and toggles auto-scan', async () => {
  const dom = new JSDOM(fs.readFileSync('src/popup.html', 'utf8'), { runScripts: 'outside-only' });
  const messages = [];
  let autoEnabled = false;
  const sampleMatch = {
    adId: 1,
    timestamp: Date.now() - 120000,
    userId: 99,
    username: '<img src=x onerror=alert(1)>',
    tradeAdCount: 9,
    matchedItems: [{ id: 10159600649, name: '8-Bit Royal Crown', acronym: '8BRC', value: 38000, demandLabel: 'Amazing' }],
    offerItems: [{ id: 10159600649, name: '8-Bit Royal Crown', acronym: '8BRC' }],
    offerTotal: 38000,
    offerRobux: 0,
    requestItems: [],
    requestTotal: 0,
    requestTags: ['Downgrade'],
    requestRobux: 0,
    tradeUrl: 'https://www.roblox.com/users/99/trade',
    rolimonsUrl: 'https://www.rolimons.com/player/99'
  };

  dom.window.chrome = {
    storage: { onChanged: { addListener() {} } },
    runtime: {
      sendMessage: async message => {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (message.type === 'FINDER_STATUS') {
          return {
            ok: true,
            state: {
              enabled: autoEnabled,
              filters: { minValue: 10000, maxValue: 150000, maxTradeAds: 150, minDemand: 4, itemQuery: '' },
              matches: [],
              status: 'Ready'
            }
          };
        }
        if (message.type === 'FINDER_SET_AUTO') autoEnabled = message.enabled;
        return {
          ok: true,
          state: {
            enabled: autoEnabled,
            filters: message.filters || {},
            matches: message.type === 'FINDER_CLEAR' ? [] : [sampleMatch],
            status: '1 match'
          }
        };
      }
    }
  };

  dom.window.eval(fs.readFileSync('src/ad-finder-ui.js', 'utf8'));
  await settle();

  const el = id => dom.window.document.getElementById(`finder-${id}`);
  el('min-value').value = '25000';
  el('max-value').value = '100000';
  el('max-ads').value = '40';
  el('demand').value = '3';
  el('items').value = 'SSHF, 8BRC';

  el('scan').click();
  await settle();

  const scanMsg = messages.find(m => m.type === 'FINDER_SCAN');
  assert.deepEqual(scanMsg.filters, {
    minValue: '25000',
    maxValue: '100000',
    maxTradeAds: '40',
    minDemand: 3,
    itemQuery: 'SSHF, 8BRC'
  });

  assert.match(el('results').textContent, /9 trade ads/);
  assert.match(el('results').textContent, /8BRC/);
  assert.equal(el('results').querySelector('img, script'), null);
  assert.equal(el('results').querySelector('a').href, 'https://www.roblox.com/users/99/trade');

  el('auto').click();
  await settle();
  assert.equal(el('auto').textContent, 'Stop auto-scan');

  el('clear').click();
  await settle();
  assert.equal(el('results').children.length, 0);
  dom.window.close();
});
