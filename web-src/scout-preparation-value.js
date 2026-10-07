// Bounded, engine-independent selection math. No browser or chess dependencies.
import { opponentMoveProbability } from "./scout-probability.js";

export const routeKey = (r) => (r.ucis || []).join(">");
const prefix = (a, b) => a === b || b.startsWith(`${a}>`);
export const nestedRoutes = (a, b) => prefix(routeKey(a), routeKey(b)) || prefix(routeKey(b), routeKey(a));

/** Observed decisions under the user's chosen moves; not a calibrated forecast.
 * Raw decision coverage is diagnostic only in v10. Neither user-move
 * frequency nor unobserved plies earn value.
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

/** Empirical opponent-only product; user choices never lower reach. */
export function opponentOnlyReach(route) {
  if (!route.preparationDecisions?.length) return route.conditionalReach ?? 0;
  return route.preparationDecisions.reduce((reach, d) => reach *
    ((d.parentWeight ?? d.parentGames) > 0
      ? Math.min(1, (d.moveWeight ?? d.moveGames) / (d.parentWeight ?? d.parentGames)) : 0), 1);
}

/** Baseline-centred W/D/L posterior; Maia is supplemental, never a pseudo-game. */
export function preparationValue(route, baseline = 50) {
  const support = Math.max(0, route.routeSupportGames ?? route.games ?? 0);
  const total = Math.max(support, route.evidenceGames ?? support);
  const coverage = opponentMoveProbability(support, total, "wilson");
  const rawWdl = route.routeWdl ?? ((route.w ?? 0) + (route.d ?? 0) + (route.l ?? 0) === support ? route : null);
  const rawScore = rawWdl && support > 0 ? ((rawWdl.w ?? 0) + 0.5 * (rawWdl.d ?? 0)) / support
    : (route.routeScorePct ?? route.scorePct ?? baseline) / 100;
  const x = route.selectionWdl ?? { w: rawWdl?.w ?? support * rawScore,
    d: rawWdl?.d ?? 0, l: rawWdl?.l ?? support * (1 - rawScore), weight: support, weightSquared: support };
  const weightedSupport = x.weight;
  const effectiveSupport = x.weightSquared > 0 ? weightedSupport ** 2 / x.weightSquared : 0;
  const b = route.selectionBaseline?.score ?? baseline / 100;
  const q = route.selectionBaseline?.prior ?? { w: b, d: 0, l: 1 - b };
  const aw = x.w + 8 * q.w, ad = x.d + 8 * q.d, al = x.l + 8 * q.l;
  const a = aw + ad + al;
  const shrunkScore = a > 0 ? (aw + 0.5 * ad) / a : b;
  const sigma = Math.sqrt(Math.max(0, ((aw + 0.25 * ad) / a - shrunkScore ** 2) / (a + 1)));
  const weakness = Math.max(0, b - shrunkScore - 0.5 * sigma);
  const cp = route.prefilterScore;
  const engine = route.mateIn > 0 ? 1 : Number.isFinite(cp)
    ? Math.max(0, cp) / (100 + Math.max(0, cp)) : 0.1;
  const decisions = preparationDecisionWeights(route);
  const reach = opponentOnlyReach(route);
  const decisionCoverage = decisions.reduce((sum, d) => sum + d.weight, 0);
  // Evidence comes from the route's anchor (deepest supported prefix); the
  // rest of the line is its observed continuation and is not charged as depth.
  const cost = 1 + 0.03 * Math.max(0, Math.ceil((route.evidencePlies ?? route.ucis?.length ?? 0) / 2) - 4);
  const opportunity = 1 + 0.2 * engine;
  const engineOk = !(route.userMate < 0) && !(Number.isFinite(cp) && cp < -75);
  const eligible = support >= 3 && effectiveSupport >= 2 && reach >= 0.1 &&
    (route.routeReach == null || route.routeReach >= 0.1) && engineOk;
  const value = eligible ? reach * weakness * opportunity / cost : 0;
  // Fills the remaining slots once weak spots run out: likely lines first,
  // tilted toward where they score below their usual result. Always >= 0.
  const softValue = b > 0 ? reach * Math.max(0, 1 + (b - shrunkScore - 0.5 * sigma) / b) * opportunity / cost : 0;
  return { support, total, coverage, rawScore, weightedSupport, effectiveSupport, shrunkScore, sigma,
    baseline: b, weakness, engine, engineOk, cost, conditionalReach: reach, rawReach: decisions.at(-1)?.reach ?? null,
    decisionCoverage, opportunity, terminalValue: value, value, softValue };
}

const MIN_ROW_PLIES = 8;

export const canonicalPosition = fen => fen ? fen.trim().split(/\s+/).slice(0, 4).join(" ") : null;

/**
 * Up to `limit` full opening lines. A row's evidence is its anchor (the
 * deepest prefix with enough games); each anchor is shown by the most common
 * observed line through it to the end of the opening. Weak anchors
 * come first, one line each, best utility first; remaining slots go to
 * unused anchors, then further lines, ranked by likelihood tilted toward
 * weakness. Never two lines ending in the same position, and every row parts
 * from the others no later than its own anchor, so slots stay empty rather
 * than repeat a branch.
 */
export function selectPreparationRoutes(routes, { limit = 12, baseline = 50 } = {}) {
  const budget = Math.min(12, Math.max(0, Math.floor(limit)));
  if (!budget) return [];
  const rows = [];
  for (const route of routes || []) {
    if (!route.ucis?.length) continue;
    const evidence = preparationValue(route, baseline);
    if (!evidence.engineOk) continue;
    if (route.routeReach != null && route.routeReach < 0.1) continue;
    const anchorUcis = route.anchorUcis ?? route.ucis;
    rows.push({ route, evidence, anchorUcis, anchor: anchorUcis.join(">"), share: route.continuationShare ?? 1 });
  }
  const order = (a, b) => b.evidence.value - a.evidence.value || b.evidence.softValue - a.evidence.softValue ||
    b.share - a.share || routeKey(a.route).localeCompare(routeKey(b.route));
  rows.sort(order);
  const picked = [], keys = new Set(), positions = new Set();
  const free = row => !keys.has(routeKey(row.route)) &&
    !positions.has(canonicalPosition(row.route.terminalFen) ?? routeKey(row.route));
  // A row parts from every picked line no later than its own anchor.
  const shared = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  const distinct = row => picked.every(route => shared(row.route.ucis, route.ucis) <= row.anchorUcis.length);
  const take = (row) => {
    if (picked.length >= budget || !free(row) || !distinct(row)) return;
    keys.add(routeKey(row.route));
    positions.add(canonicalPosition(row.route.terminalFen) ?? routeKey(row.route));
    picked.push({ ...row.route, preparationEvidence: row.evidence });
  };
  // Lines that stop within the first moves are a last resort: rows reach the end of the opening.
  const full = row => row.route.ucis.length >= MIN_ROW_PLIES;
  // More games behind the first differing move after the anchor = more common.
  const typical = (from) => (a, b) => {
    const x = a.route.pathGames ?? [], y = b.route.pathGames ?? [];
    for (let i = from; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return y[i] - x[i];
    return b.share - a.share || routeKey(a.route).localeCompare(routeKey(b.route));
  };
  // Pass 1: one line per anchor, best anchor first: the most common observed
  // line through it. Every row keeps its own (most specific) evidence, so a weak
  // anchor is shown by a line that stays weak, never one that runs into a
  // sub-branch where they do well.
  const anchorRows = new Map();
  for (const row of rows) if (!anchorRows.has(row.anchor)) anchorRows.set(row.anchor, row);
  for (const anchorRow of anchorRows.values()) {
    if (picked.length >= budget) break;
    const weak = anchorRow.evidence.value > 0;
    // A branch already shown by a picked line needs no second row.
    if (picked.some(route => anchorRow.anchorUcis.every((move, i) => route.ucis[i] === move))) continue;
    const through = rows.filter(row => full(row) && free(row) && distinct(row) &&
      (row.anchor === anchorRow.anchor || (weak ? row.evidence.value > 0 : true)) &&
      anchorRow.anchorUcis.every((move, i) => row.route.ucis[i] === move));
    const line = through.sort(typical(anchorRow.anchorUcis.length))[0];
    if (line) take(line);
  }
  // Pass 2: further lines, strongest evidence first; then shorter ones.
  for (const row of rows) if (full(row)) take(row);
  for (const row of rows) take(row);
  return picked;
}
