const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(path) {
  const dom = new JSDOM('<body></body>', { url: `https://www.rolimons.com/${path}`, runScripts: 'outside-only' });
  const messages = [];
  dom.window.chrome = {
    runtime: { sendMessage: async message => { messages.push(message); return { ok: true, state: { enabled: message.type === 'START_ADS_FROM_PAGE', nextAt: Date.now() + 900000 } }; } },
    storage: { onChanged: { addListener() {} } }
  };
  dom.window.eval(fs.readFileSync('src/rolimons-ads-ui.js', 'utf8'));
  return { dom, messages, root: dom.window.document.getElementById('rta-auto-ads').shadowRoot };
}
test('creator panel starts from selected page ad, stops and minimizes', async () => {
  const { dom, root, messages } = setup('tradeadcreate');
  await settle();
  assert.equal(messages.length, 1); // Opening a page never starts posting.
  root.getElementById('interval').value = '15';
  root.getElementById('start').click(); await settle();
  assert.equal(messages[1].type, 'START_ADS_FROM_PAGE');
  assert.equal(messages[1].minutes, 15);
  assert.match(root.getElementById('status').textContent, /Running/);
  root.getElementById('stop').click(); await settle();
  assert.equal(messages[2].type, 'STOP_ADS');
  root.getElementById('toggle').click();
  assert.equal(root.getElementById('body').hidden, true);
  dom.window.close();
});
test('other Rolimons pages link to item picker and allow stopping an existing schedule', async () => {
  const { dom, root } = setup('trades');
  await settle();
  assert.equal(root.getElementById('start'), null);
  assert.equal(root.querySelector('a').href, 'https://www.rolimons.com/tradeadcreate');
  assert.ok(root.getElementById('stop'));
  dom.window.close();
});
