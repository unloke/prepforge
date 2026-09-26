// Research comparator, superseded by exact prefix-tree DP.
import { preparationValue, routeKey, nestedRoutes } from "../web-src/scout-preparation-value.js";
const routeFamily = r => r.ucis.slice(0, 2).join(">");
export function greedyPreparationRoutes(routes, { limit = 12, baseline = 50 } = {}) {
  const unique = new Map();
  for (const route of routes || []) {
    if (route.ucis?.length && (route.routeReach == null || route.routeReach >= 0.1)) {
      const key = routeKey(route);
      const previous = unique.get(key);
      if (!previous || preparationValue(route, baseline).value > preparationValue(previous, baseline).value) unique.set(key, route);
    }
  }
  const rows = [...unique.values()].map((route) => ({ route, key: routeKey(route),
    family: routeFamily(route), ...preparationValue(route, baseline) })).sort((a, b) => a.key.localeCompare(b.key));
  const families = new Map();
  const selected = [];
  const budget = Math.min(12, Math.max(0, limit));
  while (selected.length < budget) {
    let best = null;
    for (const row of rows) {
      if (selected.some((r) => nestedRoutes(r, row.route))) continue;
      const increment = row.value;
      const current = families.get(row.family) || 0;
      const gain = Math.sqrt(current + increment) - Math.sqrt(current);
      if (gain > 0 && (!best || gain > best.gain + 1e-12 ||
        (Math.abs(gain - best.gain) <= 1e-12 && row.key < best.row.key))) best = { row, gain, increment };
    }
    if (!best) break;
    const { row, gain, increment } = best;
    selected.push({ ...row.route, preparationEvidence: preparationValue(row.route, baseline), preparationGain: gain });
    families.set(row.family, (families.get(row.family) || 0) + increment);
  }
  return selected;
}
