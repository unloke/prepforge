import { describe, expect, it } from "vitest";

import { repertoireChildLookup } from "./scout.js";
import {
  bestCoveringRepertoireId,
  divergenceNote,
  lineGap,
  ownMoveDivergence,
  plyMoveLabel,
  prepGapText,
} from "./scout-prep-divergence.js";

// Black repertoire: 1.e4 c5 (your prepared reply), 1.d4 Nf6.
const BLACK_NODES = [
  { id: "r", depth: 0 },
  { id: "a", parent_id: "r", uci: "e2e4", depth: 1 },
  { id: "b", parent_id: "a", uci: "c7c5", depth: 2, is_mainline: true },
  { id: "c", parent_id: "r", uci: "d2d4", depth: 1 },
  { id: "d", parent_id: "c", uci: "g8f6", depth: 2 },
];
const lookup = repertoireChildLookup(BLACK_NODES);

describe("own-move divergence", () => {
  it("finds a line that would add a second Black reply beside 1…c5", () => {
    const line = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"];
    const divergence = ownMoveDivergence(lookup, line, "black");
    expect(divergence).toMatchObject({ ply: 1, lineUci: "e7e5", yourUci: "c7c5",
      lineLabel: "1…e5", yourLabel: "1…c5" });
    expect(divergenceNote(divergence)).toBe("branches from your 1…c5 (adds 1…e5)");
  });

  it("is not a divergence where the gap is their move or your tree has no move yet", () => {
    expect(ownMoveDivergence(lookup, ["e2e4", "c7c5", "g1f3"], "black")).toBeNull();
    expect(lineGap(lookup, ["e2e4", "c7c5", "g1f3"], "black")).toMatchObject({ onYourMove: false, lineLabel: "2.Nf3" });
    expect(ownMoveDivergence(lookup, ["c2c4", "e7e5"], "black")).toBeNull();
    expect(ownMoveDivergence(lookup, ["e2e4", "c7c5"], "black")).toBeNull();
  });

  it("words the report gap by whose move it is", () => {
    const own = { covered: 1, repName: "Sicilian", gap: lineGap(lookup, ["e2e4", "e7e5"], "black") };
    expect(prepGapText(own)).toBe("Branches from your 1…c5 in Sicilian (line plays 1…e5)");
    const theirs = { covered: 2, repName: "Sicilian", gap: lineGap(lookup, ["e2e4", "c7c5", "g1f3"], "black") };
    expect(prepGapText(theirs)).toBe("Gap in Sicilian: no answer to their 2.Nf3");
    expect(lineGap(lookup, ["d2d4", "g8f6", "c2c4"], "white")).toMatchObject({ onYourMove: true, yourUci: null });
    expect(prepGapText({ covered: 3, repName: null, gap: { ply: 3, onYourMove: true, yourLabel: null, lineLabel: "2…e6" } }))
      .toBe("Gap in your prep: no move of yours chosen at move 2");
    expect(prepGapText({ covered: 4 })).toBe("Gap in your prep after 4 plies");
    expect(plyMoveLabel(0, "e4")).toBe("1.e4");
  });

  it("prefers the repertoire that follows the lines furthest", () => {
    const other = repertoireChildLookup([{ id: "r", depth: 0 }, { id: "x", parent_id: "r", uci: "d2d4", depth: 1 }]);
    const reps = [{ id: "dutch" }, { id: "sicilian" }];
    const lookups = [{ rep: reps[0], lookup: other }, { rep: reps[1], lookup }];
    const lines = [{ ucis: ["e2e4", "c7c5", "g1f3"] }, { ucis: ["e2e4", "e7e5"] }];
    expect(bestCoveringRepertoireId(reps, lookups, lines)).toBe("sicilian");
    expect(bestCoveringRepertoireId(reps, lookups, [{ ucis: ["c2c4"] }])).toBeNull();
  });
});
