/* Shared by the service worker, content script, and tests. */
(function (root) {
  const DEMAND_LABELS = {
    0: "Terrible",
    1: "Low",
    2: "Normal",
    3: "High",
    4: "Amazing"
  };

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
        projected: row[7] === 1,
        rare: row[9] === 1
      };
    }
    if (!Object.keys(items).length) throw new Error("Rolimon's returned no items");
    return items;
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

  root.TradeValues = { parseItems, totalItems, resolveBundle, matchName, DEMAND_LABELS };
  if (typeof module !== "undefined") module.exports = root.TradeValues;
})(globalThis);
