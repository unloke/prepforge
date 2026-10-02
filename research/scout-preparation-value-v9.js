// Frozen scoring v9; benchmark only.
// Bounded, engine-independent selection math. No browser or chess dependencies.
import { opponentMoveProbability } from "../web-src/scout-probability.js";

export const routeKey = (r) => (r.ucis || []).join(">");
const prefix = (a, b) => a === b || b.startsWith(`${a}>`);
export const nestedRoutes = (a, b) => prefix(routeKey(a), routeKey(b)) || prefix(routeKey(b), routeKey(a));

/** Observed decisions under the user's chosen moves; not a calibrated forecast.
 * Raw conditional reach avoids repeatedly penalizing the same sparse trajectory
 * with posterior pseudo-counts. Reliability is charged once at each covered
 * decision instead. Neither user-move frequency nor unobserved plies earn value.
 */
export function preparationDecisionWeights(route) {
  let reach = 1;
  let previousSupport = null;
  let repeatedEvidence = 0;
  return (route.preparationDecisions || []).map(({ ply, moveGames, parentGames }) => {
    reach *= parentGames > 0 ? Math.min(1, Math.max(0, moveGames / parentGames)) : 0;
    // Along a prefix path equal counts mean the same nested game set. More
    // moves from that set add content, not independent samples. Its total
    // decision credit is bounded by twice its reliability, even for a long game.
    repeatedEvidence = moveGames === previousSupport ? repeatedEvidence + 1 : 0;
    previousSupport = moveGames;
    return { ply, reach, weight: reach * moveGames / (moveGames + 2) * 0.5 ** repeatedEvidence };
  });
}

/** Decision coverage plus a bounded terminal opportunity. */
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
  const decisions = preparationDecisionWeights(route);
  const conditionalReach = decisions.at(-1)?.reach ?? null;
  const decisionCoverage = decisions.reduce((sum,d) => sum+d.weight,0);
  // Evidence-poor callers cannot invent conditional tendencies: retain a
  // conservative observed-frequency fallback, with no decision coverage credit.
  const terminalValue = (conditionalReach == null ? coverage : conditionalReach * support/(support+2)) * opportunity;
  const value = support > 0 && engine > 0 ? decisionCoverage + terminalValue : 0;
  return { support, total, coverage, conditionalReach, decisionCoverage, opportunity, terminalValue, value };
}

/**
 * Exact maximum UNIQUE observed-decision coverage plus terminal opportunities
 * under a slot budget and prefix antichain. Shared edges are rewarded once per
 * nonempty subtree, not once per route. User choices are controllable alternatives
 * in this preparation portfolio; they are not random events or a forced repertoire.
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
    const weights = new Map(preparationDecisionWeights(route).map(d=>[d.ply,d.weight]));
    route.ucis.forEach((move,i) => {
      if (!node.children.has(move)) node.children.set(move, { children: new Map() });
      node = node.children.get(move);
      node.weight = Math.max(node.weight || 0, weights.get(i+1) || 0);
    });
    if (!node.route || evidence.value > node.route.preparationEvidence.value) {
      node.route = { ...route, preparationEvidence: evidence };
      node.value = evidence.terminalValue;
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
    for (let k=1;k<table.length;k++) if (table[k]) table[k].value += node.weight || 0;
    return table;
  };
  const table = solve(root);
  let best = table[0];
  for (const entry of table) if (entry && entry.value > best.value + 1e-12) best = entry;
  return best.routes
    .sort((a, b) => b.preparationEvidence.value - a.preparationEvidence.value || routeKey(a).localeCompare(routeKey(b)));
}
