// Bounded, engine-independent selection math. No browser or chess dependencies.
import { opponentMoveProbability } from "./scout-probability.js";

export const routeKey = (r) => (r.ucis || []).join(">");
export const routeFamily = (r) => (r.ucis || []).slice(0, 2).join(">");
const prefix = (a, b) => a === b || b.startsWith(`${a}>`);
export const nestedRoutes = (a, b) => prefix(routeKey(a), routeKey(b)) || prefix(routeKey(b), routeKey(a));

/** Conservative observed coverage, NOT the probability under a chosen user policy. */
export function preparationValue(route, baseline = 50) {
  const support = Math.max(0, route.routeSupportGames ?? route.games ?? 0);
  const total = Math.max(support, route.evidenceGames ?? support);
  const coverage = opponentMoveProbability(support, total, "wilson");
  const personalScore = route.routeScorePct ?? route.scorePct ?? baseline;
  // Maia WDL supplies at most two pseudo-games to opportunity, never to coverage.
  const prior = route.maiaScorePct ?? baseline;
  const expectedScore = (support * personalScore + 2 * prior) / (support + 2);
  const weakness = Math.max(0, baseline - expectedScore) / 100;
  const cp = route.prefilterScore;
  const engine = route.mateIn > 0 ? 1 : Number.isFinite(cp)
    ? Math.max(0, cp) / (100 + Math.max(0, cp)) : 0.1;
  const opportunity = engine * (1 + weakness);
  return { support, total, coverage, opportunity, value: coverage * opportunity };
}

/**
 * An antichain has disjoint observed prefix coverage: no game counts twice.
 * Each route contributes conservative coverage times preparation opportunity.
 * Family sqrt utility gives diminishing returns without arbitrary family quotas.
 * Greedy marginal gain with an antichain constraint avoids all nested duplicates.
 * The constraint means this is a heuristic, not the unconstrained 1-1/e guarantee.
 */
export function selectPreparationRoutes(routes, { limit = 12, baseline = 50 } = {}) {
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
