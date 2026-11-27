const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extract, normalizePage, parseItemPage, rapChange } = require('../src/item-insights.js');
const { demandScore, averageDemand, parseItems } = require('../src/values.js');

const DAY = 86400;
function page({ rapStart = 1000, rapEnd = 1300, details = {}, sellers = [50, 40] } = {}) {
  const now = 1795453200;
  const timestamp = [], rap = [], best = [], numSellers = [];
  for (let i = 0; i <= 60; i++) {
    timestamp.push(now - (60 - i) * DAY);
    const p = i < 30 ? rapStart : rapStart + (rapEnd - rapStart) * (i - 30) / 30;
    rap.push(Math.round(p));
    best.push(Math.round(p * 1.05));
    numSellers.push(Math.round(sellers[0] + (sellers[1] - sellers[0]) * i / 60));
  }
  const item = { item_id: 1, item_name: 'Test "Hat" {x}', value: 1200, rap: rapEnd, best_price: Math.round(rapEnd * 1.05),
    demand: 3, trend: 2, projected: null, hyped: null, rare: null, num_sellers: sellers[1], owners: 500, ...details };
  return `<script>var item_details_data = ${JSON.stringify(item)};
var history_data = ${JSON.stringify({ num_points: timestamp.length, timestamp, favorited: [], rap, best_price: best, num_sellers: numSellers })};
var value_changes = [[1530253064,0,null,"Hat"],[1530253066,1,null,1000],[1600000000,2,"2","3"],[1700000000,1,1000,1200]];
var avg_daily_sales_volume_30_days = 2.5;
</script>`;
}

test('reads page variables without running scripts, including braces inside strings', () => {
  assert.deepEqual(extract('var a = {"b":"}{[","c":[1,2]};', 'a'), { b: '}{[', c: [1, 2] });
  assert.equal(extract('var n = 2.5;\n', 'n'), 2.5);
  assert.equal(extract('var x = {broken', 'x'), undefined);
  assert.equal(extract('nothing here', 'x'), undefined);
});

test('parses item details, history, value changes and sales volume', () => {
  const insight = parseItemPage(page());
  assert.equal(insight.details.name, 'Test "Hat" {x}');
  assert.equal(insight.details.demand, 3);
  assert.equal(insight.details.projected, false);
  assert.equal(insight.history.length, 61);
  assert.equal(insight.history.at(-1).rap, 1300);
  assert.equal(insight.salesPerDay, 2.5);
  assert.deepEqual(insight.valueChanges.map(c => c.type), ['value', 'demand', 'value']);
  assert.equal(insight.valueChanges[0].to, 1200);
  assert.ok(Math.abs(rapChange(insight.history, 30) - 30) < 0.5);
  assert.throws(() => parseItemPage('<html></html>'));
});

test('normalizes a page into daily rows and the full change log for the value model', () => {
  const s = normalizePage(page(), 1795453200 - 30 * DAY);
  assert.equal(s.value, 1200);
  assert.equal(s.demand, 3);
  assert.equal(s.daily.t.length, 31);
  assert.ok(s.daily.t.every(t => t % DAY === 0));
  assert.equal(s.daily.rap.at(-1), 1300);
  assert.equal(s.changes.filter(c => c[1] === 1).length, 2);
});

test('reads a face from its bundle page, and the old item page link to it', () => {
  // A face's old item page names the Roblox bundle it became.
  const legacy = page({ details: { migrated_to_bundle_id: 105919952545574 } });
  assert.equal(parseItemPage(legacy).details.bundleId, '105919952545574');
  assert.equal(normalizePage(legacy).bundleId, '105919952545574');
  assert.equal(parseItemPage(page()).details.bundleId, null);
  assert.equal(parseItemPage(page({ details: { migrated_to_bundle_id: '1/../x' } })).details.bundleId, null);
  // The bundle page: bundle_details_data, a 2026 bundle creation date, and a
  // favorites count that restarts at the move (one bad reading is no restart).
  const now = 1795453200, timestamp = [], favorited = [];
  for (let i = 0; i <= 60; i++) {
    timestamp.push(now - (60 - i) * DAY);
    favorited.push(i < 40 ? 730000 + i : 1600 + 10 * (i - 40));
  }
  favorited[20] = 5;
  const details = { bundle_id: 105919952545574, bundle_name: 'Playful Vampire', migrated_from_asset_id: 2409285794,
    created: now - 300 * DAY, first_timestamp: now - 3000 * DAY, value: 50000, rap: 49326, best_price: 46000, num_sellers: 99, demand: 3, trend: 2 };
  const history = { timestamp, favorited, rap: timestamp.map(() => 49326), best_price: timestamp.map((_, i) => 50000 - 50 * i), num_sellers: timestamp.map(() => 99) };
  const bundle = `<script>var bundle_details_data = ${JSON.stringify(details)};\nvar history_data = ${JSON.stringify(history)};\nvar avg_daily_sales_volume_30_days = 4.2;\n</script>`;
  const insight = parseItemPage(bundle);
  assert.equal(insight.details.name, 'Playful Vampire');
  assert.equal(insight.details.bestPrice, 46000);
  assert.equal(insight.details.value, 50000);
  assert.equal(insight.details.bundleId, '105919952545574');
  assert.equal(insight.salesPerDay, 4.2);
  const s = normalizePage(bundle);
  assert.equal(s.value, 50000);
  assert.equal(s.bundleId, '105919952545574');
  assert.equal(s.created, now - 3000 * DAY);
  assert.equal(s.daily.best.at(-1), 47000);
  assert.equal(s.daily.fav[20], 5);
  assert.equal(s.daily.fav[40], 730039);
  assert.equal(s.daily.fav.at(-1), 730039 + 200);
  // Item pages keep their own counts and dates.
  assert.equal(normalizePage(page({ details: { created: 1000, first_timestamp: 500 } })).created, 1000);
});

test('demand uses a 0–5 scale and RAP-only items count as 0', () => {
  const items = parseItems({ success: true, items: {
    1: ['Amazing', '', 100, 200, 200, 4, 3, -1, 1, -1],
    2: ['RapOnly', '', 100, -1, 100, 2, -1, -1, -1, -1],
    3: ['NoDemand', '', 100, 150, 150, -1, -1, -1, -1, -1]
  } });
  assert.equal(items[1].trend, 3);
  assert.equal(items[1].hyped, true);
  assert.equal(demandScore(items[1]), 5);
  assert.equal(demandScore(items[2]), 0);
  assert.equal(demandScore(items[3]), 0);
  assert.deepEqual(averageDemand(['1', '2', '999'], items), { average: 2.5, count: 2 });
  assert.deepEqual(averageDemand([], items), { average: null, count: 0 });
});

test('model age counts real hours and days and warns when old', () => {
  const { modelAge } = require('../src/item-insights.js');
  const at = '2026-11-01T12:00:00Z';
  const t = Date.parse(at) / 1000;
  assert.equal(modelAge(at, t + 600).text, 'Model is less than 1 hour old');
  assert.equal(modelAge(at, t + 3600).text, 'Model is 1 hour old');
  assert.equal(modelAge(at, t + 5 * 3600).text, 'Model is 5 hours old');
  assert.equal(modelAge(at, t + DAY).text, 'Model is 1 day old');
  assert.deepEqual({ ...modelAge(at, t + 2.5 * DAY) }, { days: 2, level: 'ok', text: 'Model is 2 days old' });
  assert.equal(modelAge(at, t + 60 * DAY).level, 'old');
  assert.match(modelAge(at, t + 60 * DAY).text, /^Model is 60 days old · retrain soon$/);
  assert.equal(modelAge(at, t + 95 * DAY).level, 'stale');
  assert.match(modelAge(at, t + 95 * DAY).text, /odds are less reliable/);
  assert.equal(modelAge('2026-11-23', Date.parse('2026-11-24T06:00:00Z') / 1000).text, 'Model is 1 day old');
  assert.equal(modelAge(undefined), null);
  assert.equal(modelAge('not a date'), null);
});
