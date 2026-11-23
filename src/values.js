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
        projected: row[7] === 1
      };
    }
    if (!Object.keys(items).length) throw new Error("Rolimon's returned no items");
    return items;
  }

  function resolveBundle(link, items) {
    // Migrated faces now link to bundles. Only resolve an exact, unique name
    // match from the bundle's Roblox URL slug; never confuse bundle IDs with assets.
    const normalize = name => name.toLowerCase().replace(/[^a-z0-9]/g, "");
    let slug;
    try { slug = decodeURIComponent(new URL(link, "https://www.roblox.com").pathname.split("/")[3] || ""); }
    catch { return null; }
    const name = normalize(slug);
    if (!name) return null;
    const matches = Object.keys(items).filter(id => normalize(items[id].name || "") === name);
    return matches.length === 1 ? matches[0] : null;
  }

  function totalItems(ids, items) {
    let total = 0, rapFallbacks = 0, missing = 0;
    for (const id of ids) {
      const item = items[id];
      if (item?.value != null) total += item.value;
      else if (item?.rap != null) { total += item.rap; rapFallbacks++; }
      else missing++;
    }
    return { total, rapFallbacks, missing };
  }

  root.TradeValues = { parseItems, totalItems, resolveBundle, DEMAND_LABELS };
  if (typeof module !== "undefined") module.exports = root.TradeValues;
})(globalThis);
