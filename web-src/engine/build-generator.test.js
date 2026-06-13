import { describe, it, expect } from "vitest";

import { generateBuildPlan, buildExistingSubtreeFromFlatNodes, SOURCE } from "./build-generator.js";

// The planner is PURE (only injected adapters), so we drive it with a fully-controlled fake
// `chess` whose FENs encode side-to-move in the first char ("w|..." / "b|...") and whose
// applyUci flips the side and appends the move — every move is legal except the sentinel
// "ILLEGAL". This isolates the recursion / threshold / merge logic from real chess legality
// (which is Stage 2's adapter concern). Parity oracle: tests/test_opening_builder.py.

function makeChess() {
  return {
    sideToMove: (fen) => (fen[0] === "w" ? "white" : "black"),
    applyUci: (fen, uci) => {
      if (uci === "ILLEGAL") return null;
      const turn = fen[0] === "w" ? "b" : "w";
      return { uci, fenAfter: `${turn}|${fen.slice(2)}>${uci}` };
    },
  };
}

const W_ROOT = "w|root"; // white to move
const B_ROOT = "b|root"; // black to move

const cand = (moveUci, i = 1) => ({ moveUci, evaluation: { score_cp: 30 - i }, rank: i });
const pred = (move_uci, probability, rank = 1) => ({ move_uci, probability, rank });

const plannedAdds = (plan) => plan.changes.filter((c) => c.action === "planned_add");
const updates = (plan) => plan.changes.filter((c) => c.action === "updated");

// Default args; override per test.
function run(overrides = {}) {
  return generateBuildPlan({
    repertoireColor: "white",
    rootNodeId: "anchor",
    plyDepth: 1,
    detailMode: "balanced",
    maiaRating: 1500,
    chess: makeChess(),
    engine: { candidates: async () => [] },
    maia: { predictions: async () => [] },
    ...overrides,
  });
}

// The contract: the plan proposes INTENT only; the server recomputes final flags.
function assertNoFinalFlags(plan) {
  for (const c of plannedAdds(plan)) {
    expect(c).not.toHaveProperty("isMainline");
    expect(c).not.toHaveProperty("is_mainline");
    expect(c).not.toHaveProperty("isUserPreparedMove");
    expect(c).not.toHaveProperty("is_user_prepared_move");
    expect(c).toHaveProperty("intendedMainline");
  }
}

describe("user turn — manual prepared preservation (golden, mirrors _expand)", () => {
  it("does NOT skip the node; preserves the manual move and adds a branch off the mainline", async () => {
    const calls = [];
    // White (user) candidates only; the opponent turn under d2d4 gets no Stockfish move, so
    // the opponent mainline falls back to Maia — isolating the Maia branch-threshold logic.
    const engine = {
      candidates: async (fen, count) => {
        calls.push({ fen, count });
        return fen[0] === "w" ? [cand("e2e4", 1), cand("d2d4", 2)] : [];
      },
    };
    // Under d2d4 (black to move = opponent, OFF the mainline path because a manual move owns
    // the parent), Maia returns one move ≥0.30 and one in (0.10,0.30). The branch threshold
    // (0.30) must drop the second → exactly one child; the mainline threshold (0.10) would
    // have kept both.
    const maia = { predictions: async () => [pred("a7a6", 0.5), pred("b7b6", 0.2)] };
    const existingSubtree = {
      id: "anchor",
      fen: W_ROOT,
      side_to_move: "white",
      children: [
        {
          id: "n-e4",
          fen: "b|root>e2e4",
          side_to_move: "black",
          move_uci: "e2e4",
          source: SOURCE.MANUAL,
          is_mainline: true,
          is_user_prepared_move: true,
          children: [],
        },
      ],
    };

    const plan = await run({ engine, maia, existingSubtree, plyDepth: 2 });

    // requested count = branchLimit(1) + manualPrepared(1)
    expect(calls[0].count).toBe(2);
    // e2e4 (manual) is fully skipped — no change references it
    expect(plan.changes.some((c) => c.moveUci === "e2e4")).toBe(false);
    // d2d4 added as a non-mainline branch
    const d4 = plannedAdds(plan).find((c) => c.moveUci === "d2d4");
    expect(d4).toBeTruthy();
    expect(d4.source).toBe(SOURCE.GENERATED_STOCKFISH);
    expect(d4.intendedMainline).toBe(false);
    expect(d4.parentRef).toBe("anchor");
    // branch threshold under d2d4 → exactly one Maia child (a7a6), b7b6 dropped
    const underD4 = plannedAdds(plan).filter((c) => c.parentRef === d4.tempId);
    expect(underD4.map((c) => c.moveUci)).toEqual(["a7a6"]);
    assertNoFinalFlags(plan);
  });
});

// With NO engine candidate on the opponent's turn (default `run` engine returns []), the
// mainline falls back to the most human-likely Maia move and the rest are branches — the
// pre-Stockfish-mainline behavior, still the path when Stockfish offers nothing.
describe("opponent turn — Maia threshold selection (engine-less fallback)", () => {
  it("keeps moves ≥0.10 on the mainline path; mainline = top, rest = branches", async () => {
    const maia = { predictions: async () => [pred("e7e5", 0.5), pred("c7c5", 0.2), pred("g8f6", 0.05)] };
    const plan = await run({ rootFen: B_ROOT, maia });

    const adds = plannedAdds(plan);
    expect(adds.map((c) => c.moveUci)).toEqual(["e7e5", "c7c5"]); // g8f6 (0.05) dropped
    expect(adds[0].intendedMainline).toBe(true);
    expect(adds[1].intendedMainline).toBe(false);
    expect(adds.every((c) => c.source === SOURCE.GENERATED_MAIA3)).toBe(true);
    expect(adds[0].maiaProbability).toBe(0.5);
    assertNoFinalFlags(plan);
  });

  it("falls back to the single top move when none clear the threshold", async () => {
    const maia = { predictions: async () => [pred("e7e5", 0.05), pred("c7c5", 0.03)] };
    const plan = await run({ rootFen: B_ROOT, maia });

    const adds = plannedAdds(plan);
    expect(adds.map((c) => c.moveUci)).toEqual(["e7e5"]);
    expect(adds[0].intendedMainline).toBe(true);
  });
});

describe("opponent turn — Stockfish mainline + Maia branches (merge)", () => {
  it("uses the engine's best move as the mainline even when Maia's top move differs", async () => {
    const engine = { candidates: async () => [cand("e7e5")] }; // Stockfish best
    const maia = { predictions: async () => [pred("c7c5", 0.5), pred("g8f6", 0.2)] }; // Maia top = c7c5
    const plan = await run({ rootFen: B_ROOT, engine, maia, plyDepth: 1 });

    const adds = plannedAdds(plan);
    const main = adds.find((c) => c.intendedMainline);
    expect(main.moveUci).toBe("e7e5");
    expect(main.source).toBe(SOURCE.GENERATED_STOCKFISH);
    // Maia branches survive the 10% mainline-path threshold, distinct from the SF mainline.
    const branches = adds.filter((c) => !c.intendedMainline);
    expect(branches.map((c) => c.moveUci)).toEqual(["c7c5", "g8f6"]);
    expect(branches.every((c) => c.source === SOURCE.GENERATED_MAIA3)).toBe(true);
    assertNoFinalFlags(plan);
  });

  it("a move that is BOTH the engine's best and a Maia reply yields ONE child carrying both", async () => {
    // The spec example: Stockfish e7e5; Maia e7e5 0.45, c7c5 0.22, g8f6 0.08; threshold 0.10.
    const engine = { candidates: async () => [cand("e7e5")] };
    const maia = {
      predictions: async () => [pred("e7e5", 0.45), pred("c7c5", 0.22), pred("g8f6", 0.08)],
    };
    const plan = await run({ rootFen: B_ROOT, engine, maia, plyDepth: 1 });

    const adds = plannedAdds(plan);
    expect(adds.filter((c) => c.moveUci === "e7e5")).toHaveLength(1); // never two e7e5 children
    const main = adds.find((c) => c.moveUci === "e7e5");
    expect(main.intendedMainline).toBe(true);
    expect(main.source).toBe(SOURCE.GENERATED_STOCKFISH);
    expect(main.maiaProbability).toBe(0.45); // Maia probability supplemented onto the SF mainline
    expect(main.engineEvaluation).not.toBeNull();
    // c7c5 kept as a branch; g8f6 (0.08) is below the 10% mainline threshold and dropped.
    const branches = adds.filter((c) => !c.intendedMainline);
    expect(branches.map((c) => c.moveUci)).toEqual(["c7c5"]);
  });

  it("merges eval + probability into an EXISTING child instead of duplicating (upgrades source)", async () => {
    const engine = { candidates: async () => [cand("e7e5")] };
    const maia = { predictions: async () => [pred("e7e5", 0.45)] };
    const existingSubtree = {
      id: "anchor",
      fen: B_ROOT,
      side_to_move: "black",
      children: [
        {
          id: "ex",
          fen: "w|root>e7e5",
          side_to_move: "white",
          move_uci: "e7e5",
          source: SOURCE.GENERATED_MAIA3,
          maia_probability: 0.45, // already set → must NOT be re-written
          is_mainline: true,
          is_user_prepared_move: false,
          children: [],
        },
      ],
    };
    const plan = await run({ rootFen: B_ROOT, engine, maia, existingSubtree, plyDepth: 1 });

    expect(plan.addedCount).toBe(0); // no new node
    const u = updates(plan).find((c) => c.nodeId === "ex");
    expect(u.engineEvaluation).toBeTruthy(); // Stockfish eval filled (was null)
    expect(u.source).toBe(SOURCE.GENERATED_STOCKFISH); // upgraded from MAIA3
    expect(u).not.toHaveProperty("maiaProbability"); // already present → left untouched
  });

  it("falls back to the Maia top as a branch when nothing clears threshold and it ≠ the SF mainline", async () => {
    const engine = { candidates: async () => [cand("a7a6")] }; // SF mainline
    const maia = { predictions: async () => [pred("e7e5", 0.05), pred("c7c5", 0.03)] }; // none ≥0.10
    const plan = await run({ rootFen: B_ROOT, engine, maia, plyDepth: 1 });

    const adds = plannedAdds(plan);
    expect(adds.find((c) => c.intendedMainline).moveUci).toBe("a7a6");
    const branches = adds.filter((c) => !c.intendedMainline);
    expect(branches.map((c) => c.moveUci)).toEqual(["e7e5"]); // fallback top, ≠ SF mainline
  });

  it("adds NO duplicate fallback branch when the Maia top equals the Stockfish mainline", async () => {
    const engine = { candidates: async () => [cand("e7e5")] };
    const maia = { predictions: async () => [pred("e7e5", 0.05), pred("c7c5", 0.03)] }; // none ≥0.10
    const plan = await run({ rootFen: B_ROOT, engine, maia, plyDepth: 1 });

    const adds = plannedAdds(plan);
    expect(adds).toHaveLength(1); // just the mainline; no fallback duplicate
    expect(adds[0].moveUci).toBe("e7e5");
    expect(adds[0].intendedMainline).toBe(true);
    expect(adds[0].source).toBe(SOURCE.GENERATED_STOCKFISH);
    expect(adds[0].maiaProbability).toBe(0.05); // still supplemented from Maia
  });

  // Regression (peer review P1): regenerating must REBALANCE the mainline. When Stockfish's
  // best is an EXISTING generated branch, that branch becomes the mainline (the old generated
  // mainline is demoted) — not just an eval/source merge that leaves is_mainline stale.
  it("promotes an EXISTING generated branch to mainline when it becomes Stockfish's best", async () => {
    const engine = { candidates: async () => [cand("g8f6")] }; // Stockfish now prefers the branch
    const maia = { predictions: async () => [pred("e7e5", 0.5), pred("g8f6", 0.3)] };
    const kid = (id, move_uci, is_mainline) => ({
      id,
      fen: `w|root>${move_uci}`,
      side_to_move: "white",
      move_uci,
      source: SOURCE.GENERATED_MAIA3,
      maia_probability: is_mainline ? 0.5 : 0.3,
      is_mainline,
      is_user_prepared_move: false,
      children: [],
    });
    const existingSubtree = {
      id: "anchor",
      fen: B_ROOT,
      side_to_move: "black",
      children: [kid("old-main", "e7e5", true), kid("old-branch", "g8f6", false)],
    };
    const plan = await run({ rootFen: B_ROOT, engine, maia, existingSubtree, plyDepth: 1 });

    expect(plan.addedCount).toBe(0); // both moves already exist — nothing added
    const setMain = plan.changes.filter((c) => c.action === "set_mainline");
    expect(setMain).toHaveLength(1);
    expect(setMain[0].nodeRef).toBe("old-branch"); // the existing g8f6 node is promoted
  });

  it("promotes a NEW Stockfish best to mainline even when an old generated mainline exists", async () => {
    const engine = { candidates: async () => [cand("a7a6")] }; // brand-new opponent best
    const maia = { predictions: async () => [pred("e7e5", 0.5)] };
    const existingSubtree = {
      id: "anchor",
      fen: B_ROOT,
      side_to_move: "black",
      children: [
        {
          id: "old-main",
          fen: "w|root>e7e5",
          side_to_move: "white",
          move_uci: "e7e5",
          source: SOURCE.GENERATED_MAIA3,
          maia_probability: 0.5,
          is_mainline: true,
          is_user_prepared_move: false,
          children: [],
        },
      ],
    };
    const plan = await run({ rootFen: B_ROOT, engine, maia, existingSubtree, plyDepth: 1 });

    const a6 = plannedAdds(plan).find((c) => c.moveUci === "a7a6");
    expect(a6).toBeTruthy();
    const setMain = plan.changes.filter((c) => c.action === "set_mainline");
    expect(setMain).toHaveLength(1);
    expect(setMain[0].nodeRef).toBe(a6.tempId); // the freshly-planned node is promoted
  });

  it("never demotes a MANUAL mainline sibling (no set_mainline emitted)", async () => {
    const engine = { candidates: async () => [cand("g8f6")] };
    const maia = { predictions: async () => [pred("g8f6", 0.3)] };
    const existingSubtree = {
      id: "anchor",
      fen: B_ROOT,
      side_to_move: "black",
      children: [
        {
          id: "manual-main",
          fen: "w|root>e7e5",
          side_to_move: "white",
          move_uci: "e7e5",
          source: SOURCE.MANUAL,
          is_mainline: true,
          is_user_prepared_move: false,
          children: [],
        },
        {
          id: "gen-branch",
          fen: "w|root>g8f6",
          side_to_move: "white",
          move_uci: "g8f6",
          source: SOURCE.GENERATED_MAIA3,
          maia_probability: 0.3,
          is_mainline: false,
          is_user_prepared_move: false,
          children: [],
        },
      ],
    };
    const plan = await run({ rootFen: B_ROOT, engine, maia, existingSubtree, plyDepth: 1 });
    expect(plan.changes.filter((c) => c.action === "set_mainline")).toHaveLength(0);
  });
});

describe("detail mode — branch recursion", () => {
  // Opponent root: Stockfish gives the opponent mainline (a7a6); Maia gives two human
  // branches. The engine answers the user's (white) turn with g1f3 so a branch that recurses
  // leaves a detectable Stockfish child under it.
  const engine = { candidates: async (fen) => (fen[0] === "w" ? [cand("g1f3")] : [cand("a7a6")]) };
  const maia = { predictions: async () => [pred("e7e5", 0.5), pred("c7c5", 0.4)] };

  const childrenUnder = (plan, parentUci) => {
    const parent = plannedAdds(plan).find((c) => c.moveUci === parentUci);
    return plannedAdds(plan).filter((c) => c.parentRef === parent.tempId);
  };

  it("simple: creates branches but does not recurse into them", async () => {
    const plan = await run({ rootFen: B_ROOT, maia, engine, detailMode: "simple", plyDepth: 2 });
    expect(childrenUnder(plan, "c7c5")).toHaveLength(0); // branch node created, not recursed
  });

  it("balanced: recurses into branches off the mainline path", async () => {
    const plan = await run({ rootFen: B_ROOT, maia, engine, detailMode: "balanced", plyDepth: 2 });
    expect(childrenUnder(plan, "c7c5").length).toBeGreaterThan(0); // branch recursed
  });
});

describe("upsert/merge into existing nodes (mirrors _upsert_child)", () => {
  it("fills eval/prob only when null; never overwrites MANUAL source; upgrades generated source", async () => {
    const maia = {
      predictions: async () => [pred("m1", 0.5), pred("m2", 0.4), pred("m3", 0.4), pred("m4", 0.4)],
    };
    const kid = (id, move_uci, source, maia_probability = null) => ({
      id,
      fen: `w|root>${move_uci}`,
      side_to_move: "white",
      move_uci,
      source,
      maia_probability,
      is_mainline: false,
      is_user_prepared_move: source === SOURCE.MANUAL,
      children: [],
    });
    const existingSubtree = {
      id: "anchor",
      fen: B_ROOT,
      side_to_move: "black",
      children: [
        kid("a", "m1", SOURCE.GENERATED_MAIA3, null), // prob filled
        kid("b", "m2", SOURCE.MANUAL, null), // prob filled, source NOT touched
        kid("c", "m3", SOURCE.GENERATED_MAIA3, 0.7), // already has prob → no change
        kid("d", "m4", SOURCE.GENERATED_STOCKFISH, null), // prob filled + source upgraded
      ],
    };

    const plan = await run({ rootFen: B_ROOT, maia, existingSubtree, plyDepth: 1 });

    expect(plan.addedCount).toBe(0);
    expect(plan.updatedCount).toBe(3);
    const byId = Object.fromEntries(updates(plan).map((u) => [u.nodeId, u]));
    expect(byId.a).toMatchObject({ maiaProbability: 0.5 });
    expect(byId.a).not.toHaveProperty("source");
    expect(byId.b).toMatchObject({ maiaProbability: 0.4 });
    expect(byId.b).not.toHaveProperty("source"); // MANUAL protected
    expect(byId.c).toBeUndefined(); // unchanged
    expect(byId.d).toMatchObject({ maiaProbability: 0.4, source: SOURCE.GENERATED_MAIA3 });
  });
});

describe("final flags are server-side; the plan carries intent only", () => {
  it("emits intendedMainline (never a final flag) even with an existing mainline sibling", async () => {
    const maia = { predictions: async () => [pred("m1", 0.5), pred("x", 0.4)] };
    const existingSubtree = {
      id: "anchor",
      fen: B_ROOT,
      side_to_move: "black",
      children: [
        {
          id: "ex",
          fen: "w|root>x",
          side_to_move: "white",
          move_uci: "x",
          source: SOURCE.GENERATED_MAIA3,
          maia_probability: 0.9,
          is_mainline: true,
          is_user_prepared_move: false,
          children: [],
        },
      ],
    };
    const plan = await run({ rootFen: B_ROOT, maia, existingSubtree, plyDepth: 1 });

    const m1 = plannedAdds(plan).find((c) => c.moveUci === "m1");
    expect(m1.intendedMainline).toBe(true); // intent stays true; server decides final is_mainline
    assertNoFinalFlags(plan);
  });
});

describe("topological ordering of changes", () => {
  it("a planned child's parentRef tempId always appears earlier in the change list", async () => {
    const maia = { predictions: async () => [pred("m1", 0.6)] };
    const engine = { candidates: async () => [cand("c1")] };
    const plan = await run({ rootFen: B_ROOT, maia, engine, plyDepth: 3 });

    const seenTemp = new Set();
    for (const c of plan.changes) {
      if (c.action === "planned_add") {
        // if parentRef is a temp id, it must have been declared earlier
        if (typeof c.parentRef === "string" && c.parentRef.startsWith("tmp-")) {
          expect(seenTemp.has(c.parentRef)).toBe(true);
        }
        seenTemp.add(c.tempId);
      }
    }
    expect(plan.changes.length).toBeGreaterThan(1);
  });
});

describe("depth is measured from the clicked anchor, not from the deepest existing node", () => {
  // Regression guard: generating from a node that already has a DEEP descendant line
  // must run a fresh plyDepth-deep generation FROM THE CLICKED NODE and merge with the
  // existing nodes — never re-root at the repertoire root, and never append past the
  // rearmost existing node. plyDepth caps relativePly counted from the anchor (ply 0),
  // so no planned_add may land deeper than plyDepth plies below the anchor even though
  // the existing line already runs deeper than that.
  it("does not append beyond plyDepth even when an existing line is deeper", async () => {
    // Existing line, 3 plies deep below the anchor: anchor(w,user) → A(e2e4) → B(e7e5) → C(g1f3)
    const existingSubtree = {
      id: "anchor",
      fen: W_ROOT,
      side_to_move: "white",
      source: SOURCE.GENERATED_STOCKFISH,
      children: [
        {
          id: "A",
          move_uci: "e2e4",
          fen: "b|root>e2e4",
          side_to_move: "black",
          source: SOURCE.GENERATED_STOCKFISH,
          children: [
            {
              id: "B",
              move_uci: "e7e5",
              fen: "w|root>e2e4>e7e5",
              side_to_move: "white",
              source: SOURCE.GENERATED_MAIA3,
              children: [
                {
                  id: "C",
                  move_uci: "g1f3",
                  fen: "b|root>e2e4>e7e5>g1f3",
                  side_to_move: "black",
                  source: SOURCE.GENERATED_STOCKFISH,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    // Engine re-picks the existing e2e4 (so we descend into A, not branch away).
    const engine = { candidates: async () => [cand("e2e4")] };
    // Maia at A keeps the existing e7e5 mainline AND a new branch c7c5.
    const maia = { predictions: async () => [pred("e7e5", 0.6), pred("c7c5", 0.4)] };

    const plan = await run({ existingSubtree, engine, maia, plyDepth: 2 });

    // The plan is anchored at the clicked node, not the repertoire root.
    expect(plan.rootNodeId).toBe("anchor");

    // Depth of each node below the anchor: existing ids carry known depths; a planned
    // add is one deeper than its parentRef.
    const existingDepth = { anchor: 0, A: 1, B: 2, C: 3 };
    const tempDepth = new Map();
    let deepestAdd = 0;
    for (const c of plannedAdds(plan)) {
      const parentDepth = existingDepth[c.parentRef] ?? tempDepth.get(c.parentRef);
      expect(parentDepth).toBeDefined(); // parent must be the anchor, an existing node, or an earlier temp
      const depth = parentDepth + 1;
      tempDepth.set(c.tempId, depth);
      deepestAdd = Math.max(deepestAdd, depth);
    }

    // A new node WAS generated within budget (the c7c5 branch at depth 2)…
    expect(plannedAdds(plan).some((c) => c.moveUci === "c7c5")).toBe(true);
    // …and NOTHING was appended beyond plyDepth from the anchor (would be ≥3 if it had
    // continued from the rearmost existing node C).
    expect(deepestAdd).toBeLessThanOrEqual(2);
  });
});

describe("ownColor independent of repertoireColor", () => {
  it("recursion follows ownColor; persisted flags are not baked into the plan", async () => {
    // repertoire white, but generate the BLACK side's lines: white-to-move is the opponent.
    const maia = { predictions: async () => [pred("e2e4", 0.6)] };
    const engine = { candidates: async () => [cand("g8f6")] };
    const plan = await run({
      rootFen: W_ROOT,
      repertoireColor: "white",
      ownColor: "black",
      maia,
      engine,
      plyDepth: 2,
    });

    const adds = plannedAdds(plan);
    // root (white to move) is the OPPONENT under ownColor=black → Stockfish best is the
    // mainline (g8f6), with Maia's e2e4 kept as a human branch.
    const rootMain = adds.find((c) => c.parentRef === "anchor" && c.intendedMainline);
    expect(rootMain.moveUci).toBe("g8f6");
    expect(rootMain.source).toBe(SOURCE.GENERATED_STOCKFISH);
    expect(adds.some((c) => c.moveUci === "e2e4" && c.source === SOURCE.GENERATED_MAIA3)).toBe(true);
    // deeper, the next ply (black to move) is the USER → Stockfish
    expect(adds.some((c) => c.parentRef !== "anchor" && c.source === SOURCE.GENERATED_STOCKFISH)).toBe(true);
    assertNoFinalFlags(plan);
  });
});

describe("own_side_candidate_count", () => {
  it("requests branchLimit + manualCount candidates and adds up to branchLimit branches", async () => {
    const calls = [];
    const engine = {
      candidates: async (fen, count) => {
        calls.push(count);
        return [cand("e2e4"), cand("d2d4"), cand("c2c4"), cand("g1f3")];
      },
    };
    const existingSubtree = {
      id: "anchor",
      fen: W_ROOT,
      side_to_move: "white",
      children: [
        {
          id: "n-e4",
          fen: "b|root>e2e4",
          side_to_move: "black",
          move_uci: "e2e4",
          source: SOURCE.MANUAL,
          is_mainline: true,
          is_user_prepared_move: true,
          children: [],
        },
      ],
    };
    const plan = await run({ engine, existingSubtree, ownSideCandidateCount: 2, plyDepth: 1 });

    expect(calls[0]).toBe(3); // 2 + 1 manual
    const adds = plannedAdds(plan).map((c) => c.moveUci);
    expect(adds).toEqual(["d2d4", "c2c4"]); // e2e4 skipped (manual), g1f3 beyond branchLimit
    expect(plannedAdds(plan).every((c) => c.intendedMainline === false)).toBe(true); // manual present
  });
});

describe("abort", () => {
  it("throws AbortError when aborted during an engine call (no partial plan)", async () => {
    const controller = new AbortController();
    const engine = {
      candidates: async () => {
        controller.abort();
        return [cand("e2e4")];
      },
    };
    await expect(
      run({ rootFen: W_ROOT, engine, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws AbortError when aborted during a Maia call", async () => {
    const controller = new AbortController();
    const maia = {
      predictions: async () => {
        controller.abort();
        return [pred("e7e5", 0.5)];
      },
    };
    await expect(
      run({ rootFen: B_ROOT, maia, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws AbortError if already aborted before the first call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      run({ rootFen: B_ROOT, maia: { predictions: async () => [pred("e7e5", 0.5)] }, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("terminal / empty adapter results", () => {
  it("returns no children when Maia has no predictions (opponent turn)", async () => {
    const plan = await run({ rootFen: B_ROOT, maia: { predictions: async () => [] } });
    expect(plan.addedCount).toBe(0);
    expect(plan.changes).toEqual([]);
  });

  it("returns no children when the engine has no candidates (user turn)", async () => {
    const plan = await run({ rootFen: W_ROOT, engine: { candidates: async () => [] } });
    expect(plan.addedCount).toBe(0);
    expect(plan.changes).toEqual([]);
  });
});

describe("illegal adapter move", () => {
  it("fails fast (throws) instead of silently skipping", async () => {
    const engine = { candidates: async () => [cand("ILLEGAL")] };
    await expect(run({ rootFen: W_ROOT, engine })).rejects.toThrow(/illegal move ILLEGAL/);
  });
});

describe("anchor id is required", () => {
  it("throws when neither existingSubtree.id nor rootNodeId is given", async () => {
    await expect(
      generateBuildPlan({
        repertoireColor: "white",
        rootFen: B_ROOT, // no rootNodeId, no existingSubtree
        plyDepth: 1,
        maiaRating: 1500,
        chess: makeChess(),
        engine: { candidates: async () => [] },
        maia: { predictions: async () => [pred("e7e5", 0.5)] },
      }),
    ).rejects.toThrow(/anchor node id/);
  });
});

describe("buildExistingSubtreeFromFlatNodes (real /api/build/load shape)", () => {
  // The real payload is FLAT `nodes` with `uci`, `is_prepared`, `parent_id` — not nested
  // `children` with `is_user_prepared_move`. Feeding it through the helper must preserve a
  // manual move and surface existing engine evals so merge stays fill-only-when-null.
  const flatNodes = [
    { id: "anchor", parent_id: null, depth: 0, fen: W_ROOT, side_to_move: "white", uci: null, source: "manual", is_mainline: true, is_prepared: false, maia_probability: null, engine_evaluation: null },
    { id: "n-e4", parent_id: "anchor", depth: 1, fen: "b|root>e2e4", side_to_move: "black", uci: "e2e4", source: "manual", is_mainline: true, is_prepared: true, maia_probability: null, engine_evaluation: null },
  ];

  it("nests the flat payload and maps is_prepared/uci so the manual move is preserved", async () => {
    const subtree = buildExistingSubtreeFromFlatNodes(flatNodes, "anchor");
    expect(subtree.id).toBe("anchor");
    expect(subtree.children[0]).toMatchObject({
      move_uci: "e2e4",
      is_user_prepared_move: true,
      source: "manual",
    });

    const engine = { candidates: async () => [cand("e2e4"), cand("d2d4")] };
    const plan = await run({ existingSubtree: subtree, rootFen: W_ROOT, engine, plyDepth: 1 });
    // manual e2e4 preserved (skipped), d2d4 added as non-mainline branch
    expect(plan.changes.some((c) => c.moveUci === "e2e4")).toBe(false);
    const d4 = plannedAdds(plan).find((c) => c.moveUci === "d2d4");
    expect(d4).toMatchObject({ intendedMainline: false, parentRef: "anchor" });
  });

  it("treats an existing engine_evaluation as present (no redundant update)", async () => {
    const nodes = [
      { id: "anchor", parent_id: null, fen: B_ROOT, side_to_move: "black", uci: null, source: "manual", is_mainline: true, is_prepared: false },
      // existing generated child for m1 that ALREADY has an engine eval and a maia prob
      { id: "c-m1", parent_id: "anchor", fen: "w|root>m1", side_to_move: "white", uci: "m1", source: SOURCE.GENERATED_MAIA3, is_mainline: false, is_prepared: false, maia_probability: 0.5, engine_evaluation: { engine: "sf", score_cp: 12 } },
    ];
    const subtree = buildExistingSubtreeFromFlatNodes(nodes, "anchor");
    // Maia re-proposes m1 with a probability; both eval and prob already set → no change.
    const maia = { predictions: async () => [pred("m1", 0.6)] };
    const plan = await run({ existingSubtree: subtree, rootFen: B_ROOT, maia, plyDepth: 1 });
    expect(plan.updatedCount).toBe(0);
    expect(plan.addedCount).toBe(0);
  });

  it("throws when the anchor id is missing from the flat nodes", () => {
    expect(() => buildExistingSubtreeFromFlatNodes(flatNodes, "nope")).toThrow(/anchor node nope not found/);
  });
});

describe("maiaRating clamping (mirrors _clamp_rating)", () => {
  const capture = () => {
    const seen = [];
    return { seen, maia: { predictions: async (_fen, rating) => { seen.push(rating); return [pred("e7e5", 0.5)]; } } };
  };

  it("clamps above the max to 2600", async () => {
    const { seen, maia } = capture();
    await run({ rootFen: B_ROOT, maia, maiaRating: 99999 });
    expect(seen[0]).toBe(2600);
  });
  it("clamps below the min to 600", async () => {
    const { seen, maia } = capture();
    await run({ rootFen: B_ROOT, maia, maiaRating: 100 });
    expect(seen[0]).toBe(600);
  });
  it("defaults garbage to 2200", async () => {
    const { seen, maia } = capture();
    await run({ rootFen: B_ROOT, maia, maiaRating: "abc" });
    expect(seen[0]).toBe(2200);
  });
});
