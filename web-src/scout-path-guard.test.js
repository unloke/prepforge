import { describe, it, expect } from "vitest";
import { selectPreparationRoutes, routeKey } from "./scout-preparation-value.js";
import {
  AUDIT_NODE_BUDGET,
  createPathGuard,
  knownVerdict,
  ownDecisionPlies,
  replayGuardedRoutes,
  selectGuardedRoutes,
  unsafeRead,
} from "./scout-path-guard.js";
import { createPathGuardEngine, terminalRead } from "./scout-path-guard-engine.js";
import { fensAlongLine, fenAfterLine, rankGamePlan } from "./scout.js";
import * as scout from "./scout.js";
import { buildScoutSectionReport } from "./scout-report.js";

const prior = { w: 0.5, d: 0, l: 0.5 };
function mk(anchor, tail, { weak = true, games = 10, typical = 5 } = {}) {
  const ucis = [...anchor, ...tail];
  const wdl = weak ? { w: 0, d: 0, l: 5 } : { w: 5, d: 0, l: 0 };
  return {
    ucis, anchorUcis: anchor, terminalFen: `t:${ucis.join(">")}`, routeSupportGames: 5, routeWdl: wdl,
    selectionWdl: { ...wdl, weight: 5, weightSquared: 5 }, selectionBaseline: { score: 0.5, prior },
    conditionalReach: 0.5, routeReach: 0.5, prefilterScore: 20,
    pathGames: ucis.map((_, i) => (i < anchor.length ? games : typical)),
  };
}
const fensFor = (ucis) => Array.from({ length: ucis.length + 1 }, (_, i) => `f:${ucis.slice(0, i).join(">")}`);
function fakeEngine(unsafeFens = []) {
  const bad = new Set(unsafeFens);
  const engine = { reads: [], lines: 0 };
  engine.newLine = async () => { engine.lines++; };
  engine.read = async (fen) => {
    engine.reads.push(fen);
    return { whiteCp: bad.has(fen) ? -200 : 0, whiteMate: null, winner: null, nodes: 10 };
  };
  return engine;
}
const A = ["a1", "x2", "a3", "x4"], B = ["b1", "x2", "b3", "x4"], C = ["c1", "x2", "c3", "x4"];
const D = ["d1", "x2", "d3", "x4"], E = ["e1", "x2", "e3", "x4"], F = ["f1", "x2", "f3", "x4"];
const tail = (t) => [`${t}5`, `${t}6`, `${t}7`, `${t}8`];
const L1 = mk(A, tail("p"), { typical: 8 }), L2 = mk(A, tail("q"), { typical: 3 });
const routes = [L1, L2, mk(B, tail("r")), mk(C, tail("s"), { games: 9 }), mk(D, tail("u"), { weak: false }),
  mk(E, tail("v"), { games: 4 }), mk(F, tail("w"), { games: 4 })];
const keys = (r) => r.picked.map(routeKey);
const run = (input, unsafe, opts = {}) => {
  const engine = fakeEngine(unsafe);
  const guard = createPathGuard({ engine, fensFor, oppColor: "black", ...opts });
  return selectGuardedRoutes(input, { baseline: 50, limit: opts.limit ?? 12 }, guard).then((r) => ({ r, engine, guard }));
};

describe("path guard verdicts", () => {
  it("reads only positions after the preparing side's moves, deepest first", () => {
    expect(ownDecisionPlies(8, "black")).toEqual([7, 5, 3, 1]);
    expect(ownDecisionPlies(8, "white")).toEqual([6, 4, 2]);
  });
  it("applies the v10 leaf rule from the preparing side", () => {
    expect(unsafeRead({ whiteCp: -80 }, "black")).toBe(true);
    expect(unsafeRead({ whiteCp: -70 }, "black")).toBe(false);
    expect(unsafeRead({ whiteCp: 80 }, "white")).toBe(true);
    expect(unsafeRead({ whiteMate: -3 }, "black")).toBe(true);
    expect(unsafeRead({ whiteMate: 3 }, "black")).toBe(false);
    expect(unsafeRead({ winner: "white" }, "black")).toBe(false);
    expect(unsafeRead({ winner: "black" }, "black")).toBe(true);
    expect(unsafeRead({ whiteCp: -40 }, "black", 50)).toBe(true);
  });
});

describe("guarded selection", () => {
  const v10 = selectPreparationRoutes(routes, { baseline: 50, limit: 12 });

  it("keeps v10's rows when every line is safe, one new game per audited line", async () => {
    const { r, engine } = await run(routes, []);
    expect(keys(r)).toEqual(v10.map(routeKey));
    expect(r.picked.every((x) => x.pathStatus === "safe")).toBe(true);
    expect(engine.reads[0]).toBe(fensFor(r.picked[0].ucis)[7]);
    expect(engine.lines).toBe(r.picked.length);
  });

  it("swaps the continuation when the failure is after the anchor", async () => {
    const { r } = await run(routes, [fensFor(L1.ucis)[7]], { limit: 4 });
    expect(selectPreparationRoutes(routes, { baseline: 50, limit: 4 }).map(routeKey)[0]).toBe(routeKey(L1));
    expect(keys(r)).toContain(routeKey(L2));
    expect(keys(r)).not.toContain(routeKey(L1));
    expect(r.picked).toHaveLength(4);
    expect(r.anchorRejections).toBe(0);
  });

  it("drops the anchor when the failure is at or before it", async () => {
    const { r } = await run(routes, [fensFor(L1.ucis)[3]], { limit: 4 });
    expect(keys(r).some((k) => k.startsWith("a1"))).toBe(false);
    expect(keys(r).some((k) => k.startsWith("e1"))).toBe(true);
    expect(r.anchorRejections).toBe(1);
    expect(r.picked).toHaveLength(4);
  });

  it("keeps the only weak anchor and marks it risk", async () => {
    const only = [L1, mk(D, tail("u"), { weak: false })];
    const { r } = await run(only, [fensFor(L1.ucis)[1]]);
    expect(r.picked.find((x) => routeKey(x) === routeKey(L1))?.pathStatus).toBe("risk");
  });

  it("commits exactly v10's rows unverified when there is no budget", async () => {
    const { r, engine } = await run(routes, [fensFor(L1.ucis)[3]], { budgetNodes: 0 });
    expect(keys(r)).toEqual(v10.map(routeKey));
    expect(r.picked.every((x) => x.pathStatus === "unverified")).toBe(true);
    expect(engine.reads).toHaveLength(0);
  });

  it("uses the fixed per-colour allowance by default", async () => {
    const { guard } = await run(routes, []);
    expect(guard.budgetNodes).toBe(AUDIT_NODE_BUDGET);
    expect(AUDIT_NODE_BUDGET).toBe(450000);
  });

  it("never reads more than the budget allows", async () => {
    const { r, guard } = await run(routes, [fensFor(L1.ucis)[3]], { budgetNodes: 45, leafMeanNodes: 10 });
    expect(guard.spentNodes).toBeLessThanOrEqual(45);
    expect(guard.exhausted).toBe(true);
    expect(r.picked.length).toBeGreaterThanOrEqual(v10.length);
  });
});

describe("replay", () => {
  it("reproduces the live run from its trace without reads", async () => {
    const { r, guard } = await run(routes, [fensFor(L1.ucis)[7], fensFor(routes[2].ucis)[1]], { limit: 6 });
    const replay = replayGuardedRoutes(routes, { baseline: 50, limit: 6 },
      { trace: guard.trace, verdicts: guard.verdicts, fensFor, oppColor: "black" });
    expect(replay.diverged).toBe(false);
    expect(replay.picked.map((x) => [routeKey(x), x.pathStatus])).toEqual(r.picked.map((x) => [routeKey(x), x.pathStatus]));
  });

  it("falls back to cached verdicts and reports divergence when the input changed", async () => {
    const { guard } = await run(routes, [fensFor(L1.ucis)[3]], { limit: 4 });
    const replay = replayGuardedRoutes(routes.slice(1), { baseline: 50, limit: 4 },
      { trace: guard.trace, verdicts: guard.verdicts, fensFor, oppColor: "black" });
    expect(replay.diverged).toBe(true);
    expect(replay.picked.length).toBeGreaterThan(0);
  });

  it("derives verdicts from known positions only", () => {
    const verdicts = new Map();
    const opts = { verdicts, fensFor, oppColor: "black" };
    expect(knownVerdict(L1, opts).status).toBe("unverified");
    for (const p of ownDecisionPlies(L1.ucis.length, "black")) verdicts.set(fensFor(L1.ucis)[p], false);
    expect(knownVerdict(L1, opts).status).toBe("safe");
    verdicts.set(fensFor(L1.ucis)[3], true);
    expect(knownVerdict(L1, opts)).toEqual({ status: "unsafe", failPly: 3 });
  });
});

describe("production wiring", () => {
  it("lists the position after every ply", () => {
    const ucis = ["e2e4", "e7e5", "g1f3"];
    expect(fensAlongLine(ucis)).toEqual([0, 1, 2, 3].map((n) => fenAfterLine(ucis.slice(0, n))));
  });

  it("rankGamePlan replays a recorded run and is v10 without one", () => {
    const ucis = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5"];
    const line = { ucis, sans: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "d3", "Bc5"], games: 6, routeSupportGames: 6, scorePct: 20, routeScorePct: 20,
      routeWdl: { w: 1, d: 0, l: 5 }, conditionalReach: 0.5, routeReach: 0.5, prefilterScore: 30 };
    const plain = rankGamePlan([line], 50, { oppColor: "black" });
    expect(plain).toHaveLength(1);
    expect(plain[0].pathStatus).toBeUndefined();
    let seen = null;
    const guarded = rankGamePlan([line], 50, { oppColor: "black",
      pathGuard: { trace: [{ key: routeKey(line), verdict: { status: "safe" } }], verdicts: new Map(), onReplay: (r) => { seen = r; } } });
    expect(guarded[0].pathStatus).toBe("safe");
    expect(seen.diverged).toBe(false);
  });

  it("game-over positions need no engine", () => {
    expect(terminalRead("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")).toMatchObject({ winner: "black", nodes: 0 });
    expect(terminalRead("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")).toBeNull();
  });

  it("the engine adapter starts a new game per line and reports White-POV reads with nodes", async () => {
    const calls = [];
    let state = { pvs: [], running: false, current_depth: 0, nodes: 0 };
    const provider = {
      async open(req) { calls.push(["open", req.newGame]); state = { pvs: [{ score_cp: -90, mate_in: null }], running: false, current_depth: req.depth, nodes: 4321 }; return state; },
      async update(req) { calls.push(["update", req.newGame]); state = { pvs: [{ score_cp: 12, mate_in: null }], running: false, current_depth: req.depth, nodes: 99 }; return state; },
      snapshot: () => state,
      close() { calls.push(["close"]); },
    };
    const engine = createPathGuardEngine({ createProvider: () => provider });
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    await engine.newLine();
    expect(await engine.read(fen, 6)).toEqual({ whiteCp: -90, whiteMate: null, winner: null, nodes: 4321 });
    expect((await engine.read(fen, 8)).nodes).toBe(99);
    await engine.newLine();
    await engine.read(fen, 6);
    await engine.close();
    expect(calls).toEqual([["open", true], ["update", false], ["update", true], ["close"]]);
  });
});

describe("report rows", () => {
  const scoutModule = { ...scout };
  const game = (i, sans, ucis, score) => ({
    color: "white", score, sans, ucis, openingUcis: ucis, openingSans: sans, openingEndPly: ucis.length,
    rating: 1800, datestamp: 1_700_000_000_000 - i * 86_400_000, speed: "blitz", gameId: `${ucis[1]}-${i}`, result: "1-0",
  });
  const games = [
    ...Array.from({ length: 12 }, (_, i) => game(i, ["e4", "e6", "d4"], ["e2e4", "e7e6", "d2d4"], 0)),
    ...Array.from({ length: 10 }, (_, i) => game(i, ["e4", "c5", "Nf3"], ["e2e4", "c7c5", "g1f3"], i % 3 ? 1 : 0)),
    ...Array.from({ length: 8 }, (_, i) => game(i, ["e4", "c6", "d4"], ["e2e4", "c7c6", "d2d4"], 0.5)),
  ];
  const state = { games, profile: scout.opponentProfile(games), username: "rows" };
  const build = (pathGuard = null) => buildScoutSectionReport(scoutModule, state, "white", [],
    { username: "rows", escapeHtml: (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"), pathGuard });
  // Every plan row as rendered: its status attribute and the path marker inside it.
  const rows = (html) => html.split('<div class="scout-line scout-line-row').slice(1)
    .filter((chunk) => chunk.includes("scout-weakness-row"))
    .map((row) => ({
      key: row.match(/data-line-key="([^"]*)"/)?.[1],
      status: row.match(/data-path-status="([^"]*)"/)?.[1] ?? null,
      marker: row.match(/<i class="scout-err-marker path-risk" title="([^"]*)">!<\/i>/)?.[1] ?? null,
    }));
  // A real guarded run over the report's own selector input, with a scripted engine.
  async function guarded(unsafe, budgetNodes) {
    const plain = build();
    const { gamePlanSource, baselineScorePct: baseline } = plain.sectionData;
    const candidates = scout.gamePlanCandidates(gamePlanSource, baseline, { oppColor: "white" });
    const engine = {
      newLine: async () => {},
      read: async () => ({ whiteCp: unsafe ? 300 : 0, whiteMate: null, winner: null, nodes: 10 }),
    };
    const guard = createPathGuard({ engine, fensFor: fensAlongLine, oppColor: "white", budgetNodes, leafMeanNodes: 10 });
    await selectGuardedRoutes(candidates, { baseline, limit: 12 }, guard);
    return { plain, guard };
  }

  it("v10 rows carry no path status or marker", () => {
    const shown = rows(build().html);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((r) => r.status === null && r.marker === null)).toBe(true);
  });

  it("safe rows are marked in the DOM without a visible marker", async () => {
    const { plain, guard } = await guarded(false, Infinity);
    const shown = rows(build({ trace: guard.trace, verdicts: guard.verdicts }).html);
    expect(shown.map((r) => r.key)).toEqual(rows(plain.html).map((r) => r.key));
    expect(shown.every((r) => r.status === "safe" && r.marker === null)).toBe(true);
  });

  it("unverified rows keep v10's lines, marked, with no visible marker", async () => {
    const { plain, guard } = await guarded(true, 0);
    const shown = rows(build({ trace: guard.trace, verdicts: guard.verdicts }).html);
    expect(shown.map((r) => r.key)).toEqual(rows(plain.html).map((r) => r.key));
    expect(shown.every((r) => r.status === "unverified" && r.marker === null)).toBe(true);
  });

  it("risk rows show the ! marker with an explaining tooltip", async () => {
    const { plain, guard } = await guarded(true, Infinity);
    const html = build({ trace: guard.trace, verdicts: guard.verdicts }).html;
    const shown = rows(html);
    expect(shown).toHaveLength(rows(plain.html).length);
    expect(shown.every((r) => r.status === "risk")).toBe(true);
    for (const r of shown) expect(r.marker).toBe("Your side is worse than −0.75 at an earlier move of this line (depth 8)");
    // The explanation lives only in the tooltip, never as standing copy.
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("worse than");
  });

  it("the section keeps the selector input for the guard pass", () => {
    const { sectionData } = build();
    expect(Array.isArray(sectionData.gamePlanSource)).toBe(true);
    expect(sectionData.gamePlanSource.length).toBeGreaterThan(0);
  });
});
