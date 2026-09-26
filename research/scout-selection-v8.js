// Bounded, engine-independent selection math. No browser or chess dependencies.
import { opponentMoveProbability } from "../web-src/scout-probability.js";

export const routeKey = (r) => (r.ucis || []).join(">");
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
 * Exact maximum preparation value under a slot budget and prefix antichain.
 * Non-nested observed prefixes have disjoint historical game coverage, so their
 * conservative expected values add. Opening family is deliberately irrelevant.
 * At every node, compare preparing that route with all feasible child sets.
 */
export function selectPreparationRoutes(routes, { limit = 12, baseline = 50 } = {}) {
  const budget = Math.min(12, Math.max(0, Math.floor(limit)));
  if (!budget) return [];
  const root = { children: new Map() };
  for (const route of routes || []) {
    if (!route.ucis?.length || (route.routeReach != null && route.routeReach < 0.1)) continue;
    const evidence = preparationValue(route, baseline);
    if (!(evidence.value > 0)) continue;
    let node = root;
    route.ucis.forEach((move) => {
      if (!node.children.has(move)) node.children.set(move, { children: new Map() });
      node = node.children.get(move);
    });
    if (!node.route || evidence.value > node.value) {
      node.route = { ...route, preparationEvidence: evidence };
      node.value = evidence.value;
    }
  }
  const combine = (left, right) => {
    const out = [];
    for (let i = left.length - 1; i >= 0; i--) for (let j = 0; j < right.length && i+j <= budget; j++) {
      if (!left[i] || !right[j]) continue;
      const value = left[i].value + right[j].value;
      if (!out[i+j] || value > out[i+j].value + 1e-12) out[i+j] = { value, routes: [...left[i].routes, ...right[j].routes] };
    }
    return out;
  };
  const solve = (node) => {
    let table = [{ value: 0, routes: [] }];
    for (const [,child] of [...node.children].sort(([a],[b]) => a.localeCompare(b))) table = combine(table, solve(child));
    if (node.route) {
      const value = node.value;
      if (!table[1] || value >= table[1].value - 1e-12) table[1] = { value, routes: [node.route] };
    }
    return table;
  };
  const table = solve(root);
  let best = table[0];
  for (const entry of table) if (entry && entry.value > best.value + 1e-12) best = entry;
  return best.routes
    .sort((a, b) => b.preparationEvidence.value - a.preparationEvidence.value || routeKey(a).localeCompare(routeKey(b)));
}

