// Synthetic regression for the v11 path guard. Runs on Kaggle before the replay.
import assert from "node:assert/strict";
import { selectPreparationRoutes, routeKey } from "../../web-src/scout-preparation-value.js";
import { selectPreparationRoutesV11, createPathGuard, ownDecisionPlies, unsafeRead } from "./path-guard.mjs";

const prior = { w: 0.5, d: 0, l: 0.5 };
function mk(anchor, tail, { weak = true, games = 10, typical = 5 } = {}) {
  const ucis = [...anchor, ...tail], wdl = weak ? { w: 0, d: 0, l: 5 } : { w: 5, d: 0, l: 0 };
  return { ucis, anchorUcis: anchor, terminalFen: `t:${ucis.join(">")}`, routeSupportGames: 5, routeWdl: wdl,
    selectionWdl: { ...wdl, weight: 5, weightSquared: 5 }, selectionBaseline: { score: 0.5, prior },
    conditionalReach: 0.5, routeReach: 0.5, prefilterScore: 20,
    pathGames: ucis.map((_, i) => (i < anchor.length ? games : typical)) };
}
const fensFor = ucis => Array.from({ length: ucis.length + 1 }, (_, i) => `f:${ucis.slice(0, i).join(">")}`);
function fakeEngine(unsafeFens = []) {
  const bad = new Set(unsafeFens), engine = { reads: [], lines: 0 };
  engine.newLine = async () => { engine.lines++; };
  engine.read = async fen => { engine.reads.push(fen); return { whiteCp: bad.has(fen) ? -200 : 0, whiteMate: null, winner: null, nodes: 10 }; };
  return engine;
}
const A = ["a1", "x2", "a3", "x4"], B = ["b1", "x2", "b3", "x4"], C = ["c1", "x2", "c3", "x4"], D = ["d1", "x2", "d3", "x4"], E = ["e1", "x2", "e3", "x4"];
const tail = t => [`${t}5`, `${t}6`, `${t}7`, `${t}8`];
const L1 = mk(A, tail("p"), { typical: 8 }), L2 = mk(A, tail("q"), { typical: 3 });
const routes = [L1, L2, mk(B, tail("r")), mk(C, tail("s"), { games: 9 }), mk(D, tail("u"), { weak: false }), mk(E, tail("v"), { weak: false, games: 4 })];
const keys = r => r.picked.map(routeKey);

// Own-decision plies and verdicts.
assert.deepEqual(ownDecisionPlies(8, "black"), [7, 5, 3, 1]);
assert.deepEqual(ownDecisionPlies(8, "white"), [6, 4, 2]);
assert.equal(unsafeRead({ whiteCp: -80 }, "black"), true);
assert.equal(unsafeRead({ whiteCp: -70 }, "black"), false);
assert.equal(unsafeRead({ whiteCp: 80 }, "white"), true);
assert.equal(unsafeRead({ whiteMate: -3 }, "black"), true);
assert.equal(unsafeRead({ whiteMate: 3 }, "black"), false);
assert.equal(unsafeRead({ winner: "white" }, "black"), false);
assert.equal(unsafeRead({ winner: "black" }, "black"), true);

// No guard: exactly v10.
const v10 = selectPreparationRoutes(routes, { baseline: 50, limit: 12 });
assert.deepEqual(keys(await selectPreparationRoutesV11(routes, { baseline: 50 })), v10.map(routeKey));
assert(v10.map(routeKey).includes(routeKey(L1)));

// Safe everywhere: same rows, one new line per audited row, deepest position read first.
{
  const engine = fakeEngine(), guard = createPathGuard({ engine, fensFor, oppColor: "black" });
  const r = await selectPreparationRoutesV11(routes, { baseline: 50, guard });
  assert.deepEqual(keys(r), v10.map(routeKey));
  assert(r.picked.every(x => x.pathStatus === "safe"));
  assert.equal(engine.reads[0], fensFor(r.picked[0].ucis)[7]);
}

// Failure after the anchor: next continuation through the same anchor.
{
  const engine = fakeEngine([fensFor(L1.ucis)[7]]), guard = createPathGuard({ engine, fensFor, oppColor: "black" });
  const r = await selectPreparationRoutesV11(routes, { baseline: 50, limit: 4, guard });
  assert.deepEqual(selectPreparationRoutes(routes, { baseline: 50, limit: 4 }).map(routeKey)[0], routeKey(L1));
  assert(keys(r).includes(routeKey(L2)) && !keys(r).includes(routeKey(L1)));
  assert.equal(r.picked.length, 4);
  assert.equal(r.anchorRejections, 0);
}

// Failure at or before the anchor: anchor dropped while another weak anchor remains; cached thereafter.
{
  const engine = fakeEngine([fensFor(L1.ucis)[3]]), guard = createPathGuard({ engine, fensFor, oppColor: "black" });
  const r = await selectPreparationRoutesV11(routes, { baseline: 50, limit: 4, guard });
  assert(!keys(r).some(k => k.startsWith("a1")));
  assert(keys(r).some(k => k.startsWith("e1")));
  assert.equal(r.anchorRejections, 1);
  assert.equal(r.picked.length, 4);
}

// Only weak anchor left: kept and marked, never dropped.
{
  const only = [L1, mk(D, tail("u"), { weak: false })];
  const engine = fakeEngine([fensFor(L1.ucis)[1]]), guard = createPathGuard({ engine, fensFor, oppColor: "black" });
  const r = await selectPreparationRoutesV11(only, { baseline: 50, guard });
  const row = r.picked.find(x => routeKey(x) === routeKey(L1));
  assert.equal(row?.pathStatus, "risk");
}

// Zero budget: exactly v10 rows, all unverified, no reads.
{
  const engine = fakeEngine([fensFor(L1.ucis)[3]]), guard = createPathGuard({ engine, fensFor, oppColor: "black", budgetNodes: 0 });
  const r = await selectPreparationRoutesV11(routes, { baseline: 50, guard });
  assert.deepEqual(keys(r), v10.map(routeKey));
  assert(r.picked.every(x => x.pathStatus === "unverified"));
  assert.equal(engine.reads.length, 0);
}
console.log("test_path_guard PASS");
