/* Shared by the service worker, content script, and tests. */
(function (root) {
  const DEMAND_LABELS = {
    0: "Terrible",
    1: "Low",
    2: "Normal",
    3: "High",
    4: "Amazing"
  };
  const TREND_LABELS = { 0: "Lowering", 1: "Unstable", 2: "Stable", 3: "Raising", 4: "Fluctuating" };
  // Rolimon's demand shown on a 0–5 scale: 0 = none assigned (or RAP-only item).
  const DEMAND_SCALE = { 0: "None", 1: "Terrible", 2: "Low", 3: "Normal", 4: "High", 5: "Amazing" };

  function parseItems(payload) {
    if (payload?.success !== true || !payload.items || typeof payload.items !== "object") {
      throw new Error("Unexpected Rolimon's response");
    }
    const items = {};
    for (const [id, row] of Object.entries(payload.items)) {
      if (!/^\d+$/.test(id) || !Array.isArray(row)) continue;
      const valid = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
      const demand = Number.isInteger(row[5]) && row[5] >= 0 && row[5] <= 4 ? row[5] : null;
      items[id] = {
        name: typeof row[0] === "string" ? row[0] : id,
        acronym: typeof row[1] === "string" ? row[1] : "",
        rap: valid(row[2]) ? row[2] : null,
        value: valid(row[3]) ? row[3] : null,
        demand,
        trend: Number.isInteger(row[6]) && row[6] >= 0 && row[6] <= 4 ? row[6] : null,
        projected: row[7] === 1,
        hyped: row[8] === 1,
        rare: row[9] === 1
      };
    }
    if (!Object.keys(items).length) throw new Error("Rolimon's returned no items");
    return items;
  }

  // 0–5 demand: items without a Rolimon's value (RAP-only) or demand count as 0.
  function demandScore(item) {
    if (item?.value == null || item.demand == null) return 0;
    return item.demand + 1;
  }

  // Average 0–5 demand across the items Rolimon's lists; unlisted items are skipped.
  function averageDemand(ids, items) {
    const scores = ids.filter(id => Object.hasOwn(items, id)).map(id => demandScore(items[id]));
    return { average: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, count: scores.length };
  }

  const normalize = name => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // Exact, unique name match. Use it only for bundles: migrated faces keep their
  // old asset entry on Rolimon's, so the name is the only link between them.
  // Callers must flag the result, because a look-alike item can copy a name.
  function matchName(name, items) {
    const target = normalize(name);
    if (!target) return null;
    const matches = Object.keys(items).filter(id => normalize(items[id]?.name) === target);
    return matches.length === 1 ? matches[0] : null;
  }

  function resolveBundle(link, items) {
    // Migrated faces now link to bundles. Only resolve an exact, unique name
    // match from the bundle's Roblox URL slug; never confuse bundle IDs with assets.
    let slug;
    try { slug = decodeURIComponent(new URL(link, "https://www.roblox.com").pathname.split("/")[3] || ""); }
    catch { return null; }
    return matchName(slug, items);
  }

  function totalItems(ids, items) {
    let total = 0, rapFallbacks = 0, missing = 0, projected = 0;
    for (const id of ids) {
      // Own keys only: "__proto__" or "constructor" must never resolve to a price.
      const item = Object.hasOwn(items, id) ? items[id] : undefined;
      if (item?.value != null) total += item.value;
      else if (item?.rap != null) {
        total += item.rap; rapFallbacks++;
        // Rolimon's marks projected RAP as inflated; callers should warn about it.
        if (item.projected === true) projected++;
      }
      else missing++;
    }
    return { total, rapFallbacks, missing, projected };
  }

  root.TradeValues = { parseItems, totalItems, resolveBundle, matchName, demandScore, averageDemand, DEMAND_LABELS, DEMAND_SCALE, TREND_LABELS };
  if (typeof module !== "undefined") module.exports = root.TradeValues;
})(globalThis);
