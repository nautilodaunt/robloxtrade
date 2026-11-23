const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(path) {
  const dom = new JSDOM('<body></body>', { url: `https://www.rolimons.com/${path}`, runScripts: 'outside-only' });
  const messages = [];
  // The panel's shadow root is closed; capture it the way only the content script can.
  let root;
  const attachShadow = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (init) { root = attachShadow.call(this, init); return root; };
  dom.window.chrome = {
    runtime: { sendMessage: async message => { messages.push(message); return { ok: true, state: { enabled: message.type === 'START_ADS_FROM_PAGE', nextAt: Date.now() + 900000 } }; } },
    storage: { onChanged: { addListener() {} } }
  };
  dom.window.eval(fs.readFileSync('src/rolimons-ads-ui.js', 'utf8'));
  return { dom, messages, root, host: dom.window.document.getElementById('rta-auto-ads') };
}
test('creator panel starts from selected page ad, stops and minimizes', async () => {
  const { dom, root, host, messages } = setup('tradeadcreate');
  await settle();
  assert.equal(host.shadowRoot, null); // Page scripts cannot reach the buttons.
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
