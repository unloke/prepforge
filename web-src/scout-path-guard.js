// Scout path guard (feature-flagged prototype, research/scout-v11). v10 selection plus a
// bounded check that no position after a preparing-side move in a shown line is below
// the existing leaf gate. No browser dependencies: the engine is supplied by the caller.
import {
  preparationValue,
  routeKey,
  canonicalPosition,
  selectPreparationRoutes,
} from "./scout-preparation-value.js";

// The existing v10 leaf gate, applied to every position after a preparing-side move.
export const PATH_FLOOR_CP = -75;
export const MAX_ANCHOR_REJECTIONS = 4;
export const MAX_CONTINUATION_TRIES = 3;
// Extra Stockfish nodes per colour: 30% of v10's full leaf queue (300 depth-8 reads at
// ~5,000 nodes each), so no scan exceeds ~1.3x the v10 worst case.
export const V10_QUEUE_READS = 300;
export const NODES_PER_GATE_READ = 5000;
export const AUDIT_NODE_SHARE = 0.3;
export const AUDIT_NODE_BUDGET = AUDIT_NODE_SHARE * V10_QUEUE_READS * NODES_PER_GATE_READ;
// Cheap first read; only positions near the floor are confirmed at the gate depth.
export const SCREEN_DEPTH = 6;
export const GATE_DEPTH = 8;
export const SCREEN_MARGIN_CP = 50;
const MIN_ROW_PLIES = 8;

const moverOf = (ply) => (ply % 2 ? "white" : "black");

/** Plies whose position follows a preparing-side move, deepest first. The leaf is v10-gated already. */
export function ownDecisionPlies(length, oppColor) {
  const out = [];
  for (let ply = length - 1; ply >= 1; ply--) if (moverOf(ply) !== oppColor) out.push(ply);
  return out;
}

/** Preparing-side verdict for one White-POV read ({whiteCp, whiteMate, winner}); margin widens the floor. */
export function unsafeRead(read, oppColor, margin = 0) {
  const prep = oppColor === "white" ? "black" : "white";
  const sign = prep === "white" ? 1 : -1;
  if (read.winner) return read.winner !== prep;
  if (Number.isFinite(read.whiteMate) && read.whiteMate !== 0) return sign * read.whiteMate < 0;
  return Number.isFinite(read.whiteCp) && sign * read.whiteCp < PATH_FLOOR_CP + margin;
}

/**
 * Reads a line backwards from its deepest preparing-side position, one new game per line
 * so the hash carries back along it. Each position gets a depth-6 screen; screens within
 * 50cp of the floor (or any adverse mate) are confirmed at depth 8, which decides. Stops
 * at the first unsafe position. A read starts only if its predicted nodes fit the budget.
 * engine: { newLine(), read(fen, depth) -> {whiteCp, whiteMate, winner, nodes} }
 * `verdicts` (canonical position -> unsafe) may be shared across runs of the same scope.
 * Every check is appended to `trace` so a render can replay the selection without reads.
 */
export function createPathGuard({
  engine,
  fensFor,
  oppColor,
  budgetNodes = AUDIT_NODE_BUDGET,
  leafMeanNodes = NODES_PER_GATE_READ,
  verdicts = new Map(),
}) {
  const seen = { [SCREEN_DEPTH]: 0, [GATE_DEPTH]: 0 };
  const guard = {
    spentNodes: 0, reads: 0, screens: 0, confirms: 0, checks: 0,
    budgetNodes, exhausted: false, verdicts, trace: [],
  };
  const estimate = (depth) => Math.max(seen[depth], depth === GATE_DEPTH ? leafMeanNodes : leafMeanNodes / 4);
  const fits = (depth) => guard.spentNodes < guard.budgetNodes && guard.spentNodes + estimate(depth) <= guard.budgetNodes;
  const read = async (fen, depth) => {
    const r = await engine.read(fen, depth);
    guard.spentNodes += r.nodes || 0;
    guard.reads++;
    seen[depth] = Math.max(seen[depth], r.nodes || 0);
    return r;
  };
  const run = async (route) => {
    const fens = fensFor(route.ucis);
    const plies = ownDecisionPlies(route.ucis.length, oppColor);
    const known = plies.filter((p) => verdicts.get(canonicalPosition(fens[p])) === true);
    if (known.length) return { status: "unsafe", failPly: Math.min(...known), cached: true };
    let started = false;
    for (const ply of plies) {
      const key = canonicalPosition(fens[ply]);
      if (verdicts.has(key)) continue;
      if (!fits(SCREEN_DEPTH)) { guard.exhausted = true; return { status: "unverified" }; }
      if (!started) { await engine.newLine(); started = true; }
      guard.screens++;
      const first = await read(fens[ply], SCREEN_DEPTH);
      let unsafe = false;
      if (unsafeRead(first, oppColor, SCREEN_MARGIN_CP)) {
        if (!fits(GATE_DEPTH)) { guard.exhausted = true; return { status: "unverified" }; }
        guard.confirms++;
        unsafe = unsafeRead(await read(fens[ply], GATE_DEPTH), oppColor);
      }
      verdicts.set(key, unsafe);
      if (unsafe) return { status: "unsafe", failPly: ply };
    }
    return { status: "safe" };
  };
  guard.check = async (route) => {
    guard.checks++;
    const verdict = await run(route);
    guard.trace.push({ key: routeKey(route), verdict });
    return verdict;
  };
  return guard;
}

/**
 * The v11 selection as a generator: it yields a route whenever it needs a verdict and is
 * resumed with `{status, failPly}`. Unsafe after the anchor: next most common continuation
 * (<= 3 per anchor). Unsafe at or before the anchor: drop the anchor (<= 4 per colour) while
 * enough weak anchors remain for v10's weak count. A row v10 would not show needs a safe
 * verdict; v10's own rows commit `unverified` when the budget is spent. Past a cap the v10
 * row stays, marked `risk`. Never fewer rows or weak rows than v10.
 */
function* guardedSelection(routes, { limit = 12, baseline = 50 } = {}) {
  const budget = Math.min(12, Math.max(0, Math.floor(limit)));
  const log = [];
  if (!budget) return { picked: [], log, anchorRejections: 0, control: [] };
  const control = selectPreparationRoutes(routes, { limit, baseline });
  const v10Keys = new Set(control.map(routeKey));
  const weakTarget = control.filter((r) => r.preparationEvidence.value > 0).length;
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
  const picked = [], keys = new Set(), positions = new Set(), rejectedAnchors = new Set();
  let anchorRejections = 0;
  const positionOf = (route) => canonicalPosition(route.terminalFen) ?? routeKey(route);
  const free = (row) => !keys.has(routeKey(row.route)) && !positions.has(positionOf(row.route));
  const shared = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  const distinct = (row) => picked.every((route) => shared(row.route.ucis, route.ucis) <= row.anchorUcis.length);
  const commit = (row, pathStatus) => {
    keys.add(routeKey(row.route));
    positions.add(positionOf(row.route));
    picked.push({ ...row.route, preparationEvidence: row.evidence, pathStatus });
  };
  const open = (row) => picked.length < budget && free(row) && distinct(row);
  const full = (row) => row.route.ucis.length >= MIN_ROW_PLIES;
  const typical = (from) => (a, b) => {
    const x = a.route.pathGames ?? [], y = b.route.pathGames ?? [];
    for (let i = from; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return y[i] - x[i];
    return b.share - a.share || routeKey(a.route).localeCompare(routeKey(b.route));
  };
  const anchorRows = new Map();
  for (const row of rows) if (!anchorRows.has(row.anchor)) anchorRows.set(row.anchor, row);
  const covered = (anchorRow) => picked.some((route) => anchorRow.anchorUcis.every((move, i) => route.ucis[i] === move));
  const throughLines = (anchorRow) => {
    const weak = anchorRow.evidence.value > 0;
    return rows.filter((row) => full(row) && free(row) && distinct(row) &&
      (row.anchor === anchorRow.anchor || (weak ? row.evidence.value > 0 : true)) &&
      anchorRow.anchorUcis.every((move, i) => row.route.ucis[i] === move)).sort(typical(anchorRow.anchorUcis.length));
  };
  const weakPicked = () => picked.filter((r) => r.preparationEvidence.value > 0).length;
  // Weak anchors after `current` that could still take a slot (geometry only, no reads).
  const spareWeak = (current) => {
    const all = [...anchorRows.values()];
    return all.slice(all.indexOf(current) + 1).filter((a) => a.evidence.value > 0 && !rejectedAnchors.has(a.anchor) &&
      !covered(a) && throughLines(a).length > 0).length;
  };
  // Lines v10 would not show must be verified safe; v10's own lines may stand unverified.
  const accept = (row, v) => v.status === "safe" || (v.status === "unverified" && v10Keys.has(routeKey(row.route)));

  // Pass 1: one line per anchor, best anchor first.
  for (const anchorRow of anchorRows.values()) {
    if (picked.length >= budget) break;
    if (covered(anchorRow)) continue;
    const through = throughLines(anchorRow);
    if (!through.length) continue;
    const weak = anchorRow.evidence.value > 0;
    let done = false, tries = 0, unverified = false;
    for (const line of through) {
      if (tries >= MAX_CONTINUATION_TRIES) break;
      // A weak anchor keeps a weak line, so a continuation swap never costs a weak row.
      if (!open(line) || (weak && line !== through[0] && !(line.evidence.value > 0))) continue;
      tries++;
      const v = yield line.route;
      if (accept(line, v)) { commit(line, v.status); done = true; break; }
      if (v.status === "unverified") { unverified = true; break; }
      log.push({ pass: 1, key: routeKey(line.route), anchor: anchorRow.anchor, failPly: v.failPly, anchorPlies: anchorRow.anchorUcis.length });
      if (v.failPly <= anchorRow.anchorUcis.length) break;
    }
    if (done) continue;
    if (unverified) {
      // Budget spent on a line v10 would not show: keep v10's choice for this anchor if it has one.
      const own = through.find((line) => v10Keys.has(routeKey(line.route)) && open(line));
      if (own) commit(own, "unverified");
      continue;
    }
    if (anchorRejections < MAX_ANCHOR_REJECTIONS && (!weak || spareWeak(anchorRow) >= weakTarget - weakPicked())) {
      anchorRejections++;
      rejectedAnchors.add(anchorRow.anchor);
      log.push({ pass: 1, rejectedAnchor: anchorRow.anchor, weak });
      continue;
    }
    if (open(through[0])) commit(through[0], "risk");
  }
  // Pass 2: further lines, strongest evidence first; then shorter ones. Unsafe rows are skipped.
  function* fill(row) {
    if (!open(row) || rejectedAnchors.has(row.anchor)) return;
    const v = yield row.route;
    if (accept(row, v)) commit(row, v.status);
    else if (v.status === "unsafe") log.push({ pass: 2, key: routeKey(row.route), failPly: v.failPly });
  }
  for (const row of rows) if (full(row)) yield* fill(row);
  for (const row of rows) yield* fill(row);
  // Never fewer weak rows than v10: put back a v10 weak row in place of a replacement fill.
  const uncommit = (route) => {
    picked.splice(picked.indexOf(route), 1);
    keys.delete(routeKey(route));
    positions.delete(positionOf(route));
  };
  const byKey = new Map(rows.map((r) => [routeKey(r.route), r]));
  for (const lost of control.filter((r) => r.preparationEvidence.value > 0 && !keys.has(routeKey(r)))) {
    if (weakPicked() >= weakTarget) break;
    const row = byKey.get(routeKey(lost));
    for (const out of [...picked].reverse().filter((r) => !(r.preparationEvidence.value > 0) && !v10Keys.has(routeKey(r)))) {
      uncommit(out);
      if (row && free(row) && distinct(row)) {
        commit(row, "risk");
        log.push({ restoredWeak: routeKey(lost), removed: routeKey(out) });
        break;
      }
      commit(byKey.get(routeKey(out)), out.pathStatus);
    }
  }
  // Never fewer rows than v10: v10's own rows first, marked.
  const fallback = [...control.map((r) => byKey.get(routeKey(r))).filter(Boolean), ...rows];
  for (const row of fallback) if (picked.length < control.length && open(row)) commit(row, "risk");
  return { picked, log, anchorRejections, control };
}

/** Runs the guarded selection against a live guard (engine reads). */
export async function selectGuardedRoutes(routes, options, guard) {
  const steps = guardedSelection(routes, options);
  let step = steps.next();
  while (!step.done) step = steps.next(await guard.check(step.value));
  return { ...step.value, stats: guardStats(guard) };
}

export function guardStats(guard) {
  return {
    spentNodes: guard.spentNodes, budgetNodes: guard.budgetNodes, reads: guard.reads,
    screens: guard.screens, confirms: guard.confirms, checks: guard.checks, exhausted: guard.exhausted,
  };
}

/** Verdict for a route from cached position verdicts only: an unread position is unverified. */
export function knownVerdict(route, { verdicts, fensFor, oppColor }) {
  const fens = fensFor(route.ucis);
  const plies = ownDecisionPlies(route.ucis.length, oppColor);
  const unsafe = plies.filter((p) => verdicts.get(canonicalPosition(fens[p])) === true);
  if (unsafe.length) return { status: "unsafe", failPly: Math.min(...unsafe) };
  return plies.every((p) => verdicts.has(canonicalPosition(fens[p]))) ? { status: "safe" } : { status: "unverified" };
}

/**
 * Re-runs the selection without engine reads. While the requests match the recorded trace
 * the result equals the live run exactly; after the first mismatch (the input changed) it
 * answers from cached position verdicts and reports `diverged` so the caller can re-run.
 */
export function replayGuardedRoutes(routes, options, { trace, verdicts, fensFor, oppColor }) {
  const steps = guardedSelection(routes, options);
  let step = steps.next(), at = 0, diverged = false;
  while (!step.done) {
    const key = routeKey(step.value);
    let verdict;
    if (!diverged && trace[at]?.key === key) verdict = trace[at++].verdict;
    else {
      diverged = true;
      verdict = knownVerdict(step.value, { verdicts, fensFor, oppColor });
    }
    step = steps.next(verdict);
  }
  return { ...step.value, diverged: diverged || at !== trace.length };
}
