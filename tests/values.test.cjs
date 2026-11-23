const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseItems, totalItems } = require('../src/values.js');

test('assigned value takes precedence over RAP; unvalued items fall back to RAP and parse demand/acronym', () => {
  const items = parseItems({ success: true, items: {
    1: ['Valued', 'VAL', 500, 1000, 1000, 4, 2, -1, -1, -1],
    2: ['Unvalued', '', 200, -1, 200, -1, -1, 1, -1, -1],
    3: ['Missing', '', -1, -1],
    4: ['Zero', '', 10, 0]
  }});
  assert.deepEqual(totalItems(['1', '1', '2', '4'], items), {
    total: 2200, rapFallbacks: 1, missing: 0
  });
  assert.equal(items[1].acronym, 'VAL');
  assert.equal(items[1].demand, 4);
  assert.equal(items[1].projected, false);
  assert.equal(items[2].demand, null);
  assert.equal(items[2].projected, true);
  assert.equal(totalItems(['3', '999'], items).missing, 2);
  assert.throws(() => parseItems({ success: false }));
  assert.throws(() => parseItems({ success: true, items: {} }));
});
