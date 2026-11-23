const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const values = fs.readFileSync('src/values.js', 'utf8');
const content = fs.readFileSync('src/content.js', 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 180));
const card = (id) => `<div class="item-card"><a href="/catalog/${id}/item">Image</a><a href="/catalog/${id}/item">Title</a></div>`;
async function page(html, response) {
  const dom = new JSDOM(html, { url: 'https://www.roblox.com/trades', runScripts: 'outside-only' });
  dom.window.chrome = { runtime: { sendMessage: async () => response, onMessage: { addListener() {} }, getManifest: () => ({ version: '0.1.2' }) } };
  dom.window.eval(values);
  dom.window.eval(content);
  await pause();
  return dom;
}
const data = { ok: true, fetchedAt: Date.now(), items: {
  1: { value: 1000, rap: 500 }, 2: { value: null, rap: 200 }
}};

test('both sides render below Robux; duplicate copies count, title links and inventory do not', async () => {
  const dom = await page(`<div class="trade-offer">${card(1)}${card(1)}<div class="robux-line">Robux: 10</div></div>
    <div class="trade-request">${card(2)}<div class="robux-line">Robux: 20</div></div>
    <div class="inventory">${card(1)}</div>`, data);
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('.rta-value-row').length, 2);
    assert.equal(doc.querySelector('.trade-offer .robux-line').nextElementSibling.textContent, "Rolimon's value: 2,000");
    assert.match(doc.querySelector('.trade-request .rta-value-row').textContent, /200 \(1 RAP fallback\)/);
    doc.querySelector('.trade-offer .item-card').remove();
    await pause();
    assert.equal(doc.querySelector('.trade-offer .rta-value-row').textContent, "Rolimon's value: 1,000");
    assert.equal(doc.querySelectorAll('.rta-value-row').length, 2);
    doc.querySelectorAll('.trade-offer .item-card').forEach(el => el.remove());
    await pause();
    assert.equal(doc.querySelector('.trade-offer .rta-value-row').textContent, "Rolimon's value: 0");
  } finally { dom.window.close(); }
});

test('label-based layout detection keeps each side separate and shows missing data honestly', async () => {
  const dom = await page(`<main><section>${card(1)}<div><span>Robux</span><span>10</span></div></section>
    <section>${card(99)}<div><span>Robux</span><span>20</span></div></section></main>`, data);
  try {
    const rows = [...dom.window.document.querySelectorAll('.rta-value-row')];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].textContent, "Rolimon's value: 1,000");
    assert.equal(rows[1].textContent, "Rolimon's value: Unavailable — no data for 99");
  } finally { dom.window.close(); }
});

test('network failure leaves an unavailable row instead of a misleading zero', async () => {
  const dom = await page(`<div class="trade-offer">${card(1)}<div class="robux-line">Robux: 0</div></div>`, { ok: false });
  try { assert.match(dom.window.document.querySelector('.rta-value-row').textContent, /Unavailable/); }
  finally { dom.window.close(); }
});

test('current trade layout supports hidden Robux, migrated bundles and newer limiteds', async () => {
  const current = { ok: true, fetchedAt: Date.now(), items: {
    2409285794: { name: 'Playful Vampire', value: 42000, rap: 39772 },
    87983592197138: { name: 'Lord of the Buxeration', value: 4500, rap: 4552 },
    65417235: { name: 'Azure Pinstripe Fedora', value: 38000, rap: 36062 }
  } };
  const dom = await page(`<main>
    <h3>Items you will give</h3>
    <ul><li><a href="/bundles/105919952545574/Playful-Vampire">#6107 Playful Vampire 39,772</a></li></ul>
    <div class="total"><span>Total Value:</span><strong>39,772</strong></div>
    <h3>Items you will receive</h3>
    <ul><li><a href="/catalog/87983592197138/Lord-of-the-Buxeration">Lord of the Buxeration</a></li>
    <li><a href="/catalog/65417235/Azure-Pinstripe-Fedora">Azure Pinstripe Fedora</a></li></ul>
    <div class="total"><span>Total Value:</span><strong>40,614</strong></div>
    </main><button>Accept</button>`, current);
  try {
    const rows = [...dom.window.document.querySelectorAll('.rta-value-row')];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].textContent, "Rolimon's value: 42,000");
    assert.equal(rows[1].textContent, "Rolimon's value: 42,500");
    assert(rows.every(row => row.previousElementSibling.className === 'total'));
    const itemValues = [...dom.window.document.querySelectorAll('.rta-item-value')];
    assert.deepEqual(itemValues.map(row => row.textContent), ['42,000', '4,500', '38,000']);
    for (const row of [...rows, ...itemValues]) {
      const logo = row.querySelector('svg.rta-logo');
      assert(logo);
      assert.equal(logo.namespaceURI, 'http://www.w3.org/2000/svg');
      assert.equal(logo.querySelector('path').getAttribute('fill'), '#0084dd');
      assert.equal(logo.getAttribute('viewBox'), '0 0 1094 1466.2');
    }
    assert(itemValues.every(row => row === row.parentElement.lastElementChild));
    assert.equal(rows[0].querySelector('.rta-sr-only').textContent, "Rolimon's value: ");
    // A bundle that cannot be uniquely resolved must not silently vanish.
    dom.window.document.querySelector('a[href*="/bundles/"]').href = '/bundles/999/Unknown-Face';
    await pause();
    assert.match(rows[0].textContent, /Unavailable/);
    assert.equal(dom.window.document.querySelectorAll('.rta-value-row').length, 2);
  } finally { dom.window.close(); }
});

test('Robux affects the gain/loss amount and missing values suppress the comparison', async () => {
  const dom = await page(`<div class="trade-offer">${card(1)}<div class="robux-line">Robux: 10</div></div>
    <div class="trade-request">${card(2)}<div class="robux-line">Robux: 900</div></div>`, data);
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelector('.rta-trade-summary').dataset.result, 'gain');
    assert.match(doc.querySelector('.rta-trade-summary').textContent, /\+90 Robux/);
    assert.match(doc.querySelector('.rta-robux-total').textContent, /Items \+ Robux: 1,010/);
    doc.querySelector('.trade-request .robux-line').textContent = 'Robux: 0';
    await pause();
    assert.equal(doc.querySelector('.rta-trade-summary').dataset.result, 'loss');
    assert.match(doc.querySelector('.rta-trade-summary').textContent, /−810 Robux/);
    doc.querySelector('.trade-request a').href = '/catalog/99/unknown';
    await pause();
    assert.equal(doc.querySelector('.rta-trade-summary'), null);
  } finally { dom.window.close(); }
});

test('trade list matches the viewer offer and shows both totals', async () => {
  const dom = new JSDOM(`<meta name="user-data" data-userid="10"><div data-trade-id="123" class="trade-row">Partner</div>`, {
    url: 'https://www.roblox.com/trades', runScripts: 'outside-only'
  });
  dom.window.chrome = { runtime: {
    onMessage: { addListener() {} }, getManifest: () => ({ version: '0.1.7' }),
    sendMessage: async message => message.type === 'GET_ROLIMONS_VALUES' ? data : {
      ok: true, result: message.tradeId ? { offers: [
        { user: { id: 20 }, userAssets: [{ assetId: 1 }], robux: 100 },
        { user: { id: 10 }, userAssets: [{ assetId: 2 }], robux: 0 }
      ] } : { data: [] }
    }
  } };
  dom.window.eval(values); dom.window.eval(content);
  try {
    await pause();
    const box = dom.window.document.querySelector('.rta-trade-summary');
    assert.equal(box.dataset.result, 'gain');
    assert.match(box.textContent, /Give 200\nReceive 1,070/);
    assert.match(box.textContent, /\+870 Robux/);
    assert.match(box.title, /Not historical profit/);
    await pause();
    assert.equal(dom.window.document.querySelectorAll('.rta-trade-summary').length, 1);
  } finally { dom.window.close(); }
});

for (const [label, status] of [['Received', 'Inbound'], ['Completed', 'Completed'], ['Sent', 'Outbound'], ['Closed', 'Inactive']]) {
  test(`${label} tab requests ${status} trades and renders its comparison`, async () => {
    const dom = new JSDOM(`<meta name="user-data" data-userid="10">
      <button role="tab" aria-selected="true">${label}</button>
      <div class="trade-row"><a class="trade-partner-name" href="/users/20/profile">Partner</a></div>`,
    { url: 'https://www.roblox.com/trades', runScripts: 'outside-only' });
    const requested = [];
    dom.window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type === 'GET_ROLIMONS_VALUES') return data;
      if (message.status) { requested.push(message.status); return { ok: true, result: { data: [{ id: 123, user: { id: 20 } }] } }; }
      return { ok: true, result: { offers: [
        { user: { id: 10 }, userAssets: [{ assetId: 2 }], robux: 0 },
        { user: { id: 20 }, userAssets: [{ assetId: 1 }], robux: 0 }
      ] } };
    } } };
    dom.window.eval(values); dom.window.eval(content);
    try {
      await pause();
      assert.deepEqual(requested, [status]);
      assert.equal(dom.window.document.querySelector('.rta-trade-summary').dataset.result, 'gain');
      const tab = dom.window.document.querySelector('[role="tab"]');
      tab.textContent = label === 'Sent' ? 'Closed' : 'Sent';
      await pause();
      assert.equal(requested.at(-1), label === 'Sent' ? 'Inactive' : 'Outbound');
      assert.equal(dom.window.document.querySelectorAll('.rta-trade-summary').length, 1);
    } finally { dom.window.close(); }
  });
}

test('dropdown uses selected category rather than all menu option text', async () => {
  const dom = new JSDOM(`<select id="trade-type-dropdown"><option>Received</option><option selected>Sent</option><option>Completed</option><option>Closed</option></select><div data-trade-id="123"></div>`,
    { url: 'https://www.roblox.com/trades', runScripts: 'outside-only' });
  const statuses = [];
  dom.window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async m => {
    if (m.type === 'GET_ROLIMONS_VALUES') return data;
    if (m.status) statuses.push(m.status);
    return { ok: true, result: { data: [] } };
  } } };
  dom.window.eval(values); dom.window.eval(content);
  try {
    await pause();
    assert.equal(statuses[0], 'Outbound');
    const select = dom.window.document.querySelector('select');
    select.value = 'Closed'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await pause();
    assert.equal(statuses.at(-1), 'Inactive');
  } finally { dom.window.close(); }
});

test('current Roblox button rows and tab URL display list comparisons', async () => {
  const dom = new JSDOM(`<meta name="user-data" data-userid="10">
    <button aria-pressed="true">Completed</button>
    <button><div><a href="/users/20/profile"><img></a><span>Partner Completed 11/1/2026</span></div></button>`,
    { url: 'https://www.roblox.com/trades?tab=Completed', runScripts: 'outside-only' });
  const requests = [];
  dom.window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
    if (message.type === 'GET_ROLIMONS_VALUES') return data;
    requests.push(message);
    return { ok: true, result: message.status ? { data: [{ id: 123, user: { id: 20 } }] } : { offers: [
      { user: { id: 10 }, userAssets: [{ assetId: 2 }], robux: 5 },
      { user: { id: 20 }, userAssets: [{ assetId: 1 }], robux: 10 }
    ] } };
  } } };
  dom.window.eval(values); dom.window.eval(content);
  try {
    await pause();
    assert.equal(requests[0].status, 'Completed');
    const summary = dom.window.document.querySelector('button .rta-trade-summary');
    assert(summary);
    assert.match(summary.textContent, /Give 205\nReceive 1,007/);
  } finally { dom.window.close(); }
});

test('modern completed detail includes Robux Offered after fee before Total Value', async () => {
  const dom = await page(`<main><h3>Items you gave</h3><ul><li>${card(1)}</li></ul>
    <div><span>Total Value:</span><strong>500</strong></div>
    <h3>Items you received</h3><ul><li>${card(2)}</li></ul>
    <div><span>Robux Offered (After 30% fee):</span><span>246</span></div>
    <div><span>Total Value:</span><strong>446</strong></div></main>`, data);
  try {
    const doc = dom.window.document;
    assert.match(doc.querySelectorAll('.rta-robux-total')[1].textContent, /Robux: 246 · Items \+ Robux: 446/);
    assert.match(doc.querySelector('.rta-trade-summary').textContent, /Receive 446/);
  } finally { dom.window.close(); }
});

test('v2 bundle trades render once in nested list rows and include received Robux', async () => {
  const dom = new JSDOM(`<meta name="user-data" data-userid="10"><button data-trade-id="123"><div class="trade-row"><a href="/users/20/profile">Partner</a>Completed 11/1/2026</div></button>`,
    { url: 'https://www.roblox.com/trades?tab=Completed', runScripts: 'outside-only' });
  const current = { ...data, items: { 1: { name: 'Playful Vampire', value: 42000 }, 2: { name: 'Other', value: 47000 } } };
  dom.window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async m => {
    if (m.type === 'GET_ROLIMONS_VALUES') return current;
    if (m.status) return { ok: true, result: { data: [] } };
    return { ok: true, result: {
      participantAOffer: { user: { id: 10 }, robux: 0, items: [{ itemName: 'Playful Vampire', itemTarget: { itemType: 'Bundle', targetId: '99' }, recentAveragePrice: 39000 }] },
      participantBOffer: { user: { id: 20 }, robux: 351, items: [{ itemName: 'Other', itemTarget: { itemType: 'Asset', targetId: '2' } }] }
    } };
  } } };
  dom.window.eval(values); dom.window.eval(content);
  try {
    await pause(); await pause();
    const boxes = dom.window.document.querySelectorAll('.rta-list-summary');
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].parentElement.tagName, 'BUTTON');
    assert.match(boxes[0].textContent, /Give 42,000\nReceive 47,246/);
  } finally { dom.window.close(); }
});
