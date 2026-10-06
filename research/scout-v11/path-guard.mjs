// Scout v11 research: v10 selection plus a bounded in-loop check of each shown line.
// Production-portable core: no file IO, engine supplied by the caller.
import { preparationValue, routeKey, canonicalPosition } from "../../web-src/scout-preparation-value.js";

// The existing v10 leaf gate, applied to every position after a preparing-side move.
export const PATH_FLOOR_CP = -75;
export const MAX_ANCHOR_REJECTIONS = 4;
export const MAX_CONTINUATION_TRIES = 3;
// Extra Stockfish nodes allowed per colour, as a share of that colour's v10 leaf nodes.
export const AUDIT_NODE_SHARE = 0.3;
const MIN_ROW_PLIES = 8;

const moverOf = ply => (ply % 2 ? "white" : "black");

/** Plies whose position follows a preparing-side move, deepest first. The leaf is v10-gated already. */
export function ownDecisionPlies(length, oppColor) {
  const out = [];
  for (let ply = length - 1; ply >= 1; ply--) if (moverOf(ply) !== oppColor) out.push(ply);
  return out;
}

/** Preparing-side verdict for one engine read ({whiteCp, whiteMate, winner}). */
export function unsafeRead(read, oppColor) {
  const prep = oppColor === "white" ? "black" : "white", sign = prep === "white" ? 1 : -1;
  if (read.winner) return read.winner !== prep;
  if (Number.isFinite(read.whiteMate) && read.whiteMate !== 0) return sign * read.whiteMate < 0;
  return Number.isFinite(read.whiteCp) && sign * read.whiteCp < PATH_FLOOR_CP;
}

/**
 * Reads a line backwards from its deepest preparing-side position (fishnet-style: one
 * new game per line, hash kept between consecutive positions). Stops at the first
 * unsafe position or when the node budget is spent. Verdicts are shared by position.
 * engine: { newLine(), read(fen) -> {whiteCp, whiteMate, winner, nodes} }
 */
export function createPathGuard({ engine, fensFor, oppColor, budgetNodes = Infinity }) {
  const verdicts = new Map();
  const guard = { spentNodes: 0, reads: 0, budgetNodes, exhausted: false, checks: 0 };
  guard.check = async (route) => {
    guard.checks++;
    const fens = fensFor(route.ucis), plies = ownDecisionPlies(route.ucis.length, oppColor);
    const known = plies.filter(p => verdicts.get(canonicalPosition(fens[p])) === true);
    if (known.length) return { status: "unsafe", failPly: Math.min(...known), cached: true };
    let started = false;
    for (const ply of plies) {
      const key = canonicalPosition(fens[ply]);
      if (verdicts.has(key)) continue;
      if (guard.spentNodes >= guard.budgetNodes) { guard.exhausted = true; return { status: "unverified" }; }
      if (!started) { await engine.newLine(); started = true; }
      const read = await engine.read(fens[ply]);
      guard.spentNodes += read.nodes; guard.reads++;
      const unsafe = unsafeRead(read, oppColor);
      verdicts.set(key, unsafe);
      if (unsafe) return { status: "unsafe", failPly: ply };
    }
    return { status: "safe" };
  };
  return guard;
}

/**
 * v10 `selectPreparationRoutes` with an optional path guard. With guard null it must
 * return exactly the v10 rows (asserted on real data by the replay).
 * Unsafe after the anchor: try the next most common continuation (<= 3 per anchor).
 * Unsafe at or before the anchor: drop the anchor (<= 4 per colour; a weak anchor only
 * while another weak anchor remains). Past a cap, the v10 row stays, marked pathRisk.
 * Budget spent: rows commit exactly as v10 picks them, marked pathUnverified.
 */
export async function selectPreparationRoutesV11(routes, { limit = 12, baseline = 50, guard = null } = {}) {
  const budget = Math.min(12, Math.max(0, Math.floor(limit)));
  const log = [];
  if (!budget) return { picked: [], log };
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
  const free = row => !keys.has(routeKey(row.route)) &&
    !positions.has(canonicalPosition(row.route.terminalFen) ?? routeKey(row.route));
  const shared = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  const distinct = row => picked.every(route => shared(row.route.ucis, route.ucis) <= row.anchorUcis.length);
  const commit = (row, pathStatus) => {
    keys.add(routeKey(row.route));
    positions.add(canonicalPosition(row.route.terminalFen) ?? routeKey(row.route));
    picked.push({ ...row.route, preparationEvidence: row.evidence, ...(guard ? { pathStatus } : {}) });
  };
  const open = row => picked.length < budget && free(row) && distinct(row);
  const full = row => row.route.ucis.length >= MIN_ROW_PLIES;
  const typical = (from) => (a, b) => {
    const x = a.route.pathGames ?? [], y = b.route.pathGames ?? [];
    for (let i = from; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return y[i] - x[i];
    return b.share - a.share || routeKey(a.route).localeCompare(routeKey(b.route));
  };
  const anchorRows = new Map();
  for (const row of rows) if (!anchorRows.has(row.anchor)) anchorRows.set(row.anchor, row);
  const covered = anchorRow => picked.some(route => anchorRow.anchorUcis.every((move, i) => route.ucis[i] === move));
  const throughLines = (anchorRow) => {
    const weak = anchorRow.evidence.value > 0;
    return rows.filter(row => full(row) && free(row) && distinct(row) &&
      (row.anchor === anchorRow.anchor || (weak ? row.evidence.value > 0 : true)) &&
      anchorRow.anchorUcis.every((move, i) => row.route.ucis[i] === move)).sort(typical(anchorRow.anchorUcis.length));
  };
  // Another weak anchor that could still take a slot (no reads; geometry only).
  const spareWeak = (current) => [...anchorRows.values()].some(a => a !== current && a.evidence.value > 0 &&
    !rejectedAnchors.has(a.anchor) && !covered(a) && !picked.some(r => routeKey(r) === routeKey(a.route)) &&
    throughLines(a).length > 0);

  // Pass 1: one line per anchor, best anchor first.
  for (const anchorRow of anchorRows.values()) {
    if (picked.length >= budget) break;
    if (covered(anchorRow)) continue;
    const through = throughLines(anchorRow);
    if (!through.length) continue;
    if (!guard) { commit(through[0]); continue; }
    let done = false, tries = 0;
    for (const line of through) {
      if (tries >= MAX_CONTINUATION_TRIES) break;
      if (!open(line)) continue;
      tries++;
      const v = await guard.check(line.route);
      if (v.status === "safe" || v.status === "unverified") { commit(line, v.status === "safe" ? "safe" : "unverified"); done = true; break; }
      log.push({ pass: 1, key: routeKey(line.route), anchor: anchorRow.anchor, failPly: v.failPly, anchorPlies: anchorRow.anchorUcis.length, cached: !!v.cached });
      if (v.failPly <= anchorRow.anchorUcis.length) break;
    }
    if (done) continue;
    const weak = anchorRow.evidence.value > 0;
    if (anchorRejections < MAX_ANCHOR_REJECTIONS && (!weak || spareWeak(anchorRow))) {
      anchorRejections++; rejectedAnchors.add(anchorRow.anchor);
      log.push({ pass: 1, rejectedAnchor: anchorRow.anchor, weak });
      continue;
    }
    if (open(through[0])) commit(through[0], "risk");
  }
  // Pass 2: further lines, strongest evidence first; then shorter ones. Unsafe rows are skipped.
  const fill = async (row) => {
    if (!open(row) || rejectedAnchors.has(row.anchor)) return;
    if (!guard) return commit(row);
    const v = await guard.check(row.route);
    if (v.status === "unsafe") { log.push({ pass: 2, key: routeKey(row.route), failPly: v.failPly, cached: !!v.cached }); return; }
    commit(row, v.status === "safe" ? "safe" : "unverified");
  };
  for (const row of rows) if (full(row)) await fill(row);
  for (const row of rows) await fill(row);
  // Never fewer rows than v10 would return: fall back to the skipped rows, marked.
  if (guard) {
    const target = (await selectPreparationRoutesV11(routes, { limit, baseline })).picked.length;
    for (const row of rows) if (picked.length < target && open(row)) commit(row, "risk");
  }
  return { picked, log, anchorRejections };
}
