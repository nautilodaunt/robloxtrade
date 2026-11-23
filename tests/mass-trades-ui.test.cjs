const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('popup requires review, invalidates on edits and sends only the reviewed preview ID', async () => {
  const dom = new JSDOM(fs.readFileSync('src/popup.html', 'utf8'), { runScripts: 'outside-only' });
  const messages = [];
  const state = { previewId: 'reviewed', userId: 1, username: 'me', enabled: false,
    giving: [{ assetId: 10, instanceId: 'own-copy-101', serialNumber: 7, name: '<img src=x onerror=alert(1)>', value: 100 }],
    receiving: [{ assetId: 20, name: 'Wanted', value: 150 }], estimate: { give: 100, receive: 150 },
    rules: { mode: 'flexible', tags: ['any'], minutes: 30, maxTrades: 20 },
    targets: [{ userId: 2, name: '<script>bad()</script>', why: 'exact', outcome: 'Queued' }], status: '1 matching ad right now.' };
  dom.window.chrome = { runtime: { sendMessage: async message => {
    messages.push(JSON.parse(JSON.stringify(message)));
    if (message.type === 'MASS_LOAD') return { ok: true, state: {
      user: { id: 1, name: 'me' }, valuesError: '',
      catalog: { 10: { name: 'Offer', acronym: '', value: 100 }, 20: { name: 'Wanted', acronym: 'WA', value: 150 } },
      inventory: [{ assetId: 10, instanceId: 'own-copy-101', name: 'Offer', serialNumber: 7, isOnHold: false },
        { assetId: 10, instanceId: 'own-copy-102', name: 'Held', serialNumber: null, isOnHold: true }]
    } };
    if (message.type === 'MASS_STATUS') return { ok: true, state: { status: 'Ready' } };
    return { ok: true, state: message.type === 'MASS_START' ? { ...state, enabled: true, previewId: null } : state };
  } } };
  const el = id => dom.window.document.getElementById(`mass-${id}`);
  const input = id => el(id).dispatchEvent(new dom.window.Event('input'));
  dom.window.eval(fs.readFileSync('src/mass-trades-ui.js', 'utf8'));
  await settle();
  assert.equal(messages.some(m => m.type === 'MASS_START'), false);
  el('load').click(); await settle();
  assert.equal(el('offer').options.length, 1);
  assert.match(el('status').textContent, /Loaded 1 tradable items \(1 on hold hidden\)/);
  el('offer').options[0].selected = true;
  el('wanted-1').value = 'wa'; input('wanted-1');
  el('preview').click(); await settle();
  assert.equal(el('start').disabled, true);
  assert.match(el('review').textContent, /#7/);
  assert.equal(el('review').querySelector('img, script'), null);
  el('confirm').click(); assert.equal(el('start').disabled, false);
  input('wanted-1'); assert.equal(el('start').disabled, true);
  el('preview').click(); await settle(); el('confirm').click(); el('start').click(); await settle();
  assert.deepEqual(messages.find(m => m.type === 'MASS_PREVIEW').config, { offerInstanceIds: ['own-copy-101'], wanted: [20],
    mode: 'flexible', tags: ['any', 'upgrade', 'downgrade', 'adds', 'demand', 'rares', 'rap', 'projecteds'], minutes: 30, maxTrades: 20 });
  assert.deepEqual(messages.find(m => m.type === 'MASS_START'), { type: 'MASS_START', previewId: 'reviewed' });
  assert.equal(el('offer').disabled, true);
  assert.equal(el('mode').disabled, true);
  el('stop').click(); await settle();
  assert.equal(messages.at(-1).type, 'MASS_STOP');
  dom.window.close();
});
