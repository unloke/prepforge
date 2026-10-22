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

/**
 * One line's preparation value. Reach and engine safety are the only evidence
 * about the opponent; the weakness it exploits is Maia's leaf score for how they
 * play from there, never their whole-game results.
 *
 * A candidate with no Maia read has no weakness signal, so it is not eligible
 * (it can still fill a slot through `softValue`). Maia's probability is used as a
 * probability: it is never added to the W/D/L counts as a pseudo-game.
 */
export function preparationValue(route, baseline = 50) {
  const support = Math.max(0, route.routeSupportGames ?? route.games ?? 0);
  const total = Math.max(support, route.evidenceGames ?? support);
  const coverage = opponentMoveProbability(support, total, "wilson");
  const b = route.selectionBaseline?.score ?? baseline / 100;
  const maiaScore = Number.isFinite(route.maiaScorePct) ? route.maiaScorePct / 100 : null;
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
  const supported = support >= 3 && reach >= 0.1 &&
    (route.routeReach == null || route.routeReach >= 0.1) && engineOk;
  const weakness = maiaScore == null ? 0 : Math.max(0, b - maiaScore);
  const value = supported && maiaScore != null ? reach * weakness * opportunity / cost : 0;
  // Fills the remaining slots once weak spots run out: the lines they reach
  // most often first, tilted toward the ones Maia rates below their usual level.
  const softValue = reach * Math.max(0, 1 + (b - (maiaScore ?? b)) / (b || 1)) * opportunity / cost;
  return { support, total, coverage, maiaScore, baseline: b, weakness, engine, engineOk, cost,
    conditionalReach: reach, rawReach: decisions.at(-1)?.reach ?? null, decisionCoverage, opportunity,
    terminalValue: value, value, softValue };
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
  // line through it. A weak anchor is shown by a line that is itself weak (its
  // own Maia leaf), never by a continuation where they do well.
  const anchorRows = new Map();
  for (const row of rows) if (!anchorRows.has(row.anchor)) anchorRows.set(row.anchor, row);
  for (const anchorRow of anchorRows.values()) {
    if (picked.length >= budget) break;
    // A branch already shown by a picked line needs no second row.
    if (picked.some(route => anchorRow.anchorUcis.every((move, i) => route.ucis[i] === move))) continue;
    const through = rows.filter(row => full(row) && free(row) && distinct(row) &&
      anchorRow.anchorUcis.every((move, i) => row.route.ucis[i] === move));
    const weakThrough = through.filter(row => row.evidence.value > 0);
    const line = (weakThrough.length ? weakThrough : through).sort(typical(anchorRow.anchorUcis.length))[0];
    if (line) take(line);
  }
  // Pass 2: further lines, strongest evidence first; then shorter ones.
  for (const row of rows) if (full(row)) take(row);
  for (const row of rows) take(row);
  return picked;
}
