import { describe, it, expect } from "vitest";
import MOVES from "./fixtures/reason-moves.json";
import RATED from "./fixtures/rated-moves.json";
import { soundReason, reasonPhrase } from "./reasons.js";
import { buildMoveFeatures } from "./features.js";
import { buildCommentary } from "./commentary.js";

// Real positions and Stockfish 19 lines (depth 14), as sampled in research/coach-precision.
const move = (id) => MOVES.find((m) => m.id === id).features;

describe("proven reasons on real positions", () => {
  it.each([
    ["CrzPv5JQ/5", soundReason, { kind: "defend", type: "p", square: "e4" }],
    ["iIbxaesL/77", soundReason, { kind: "defend", type: "p", square: "h4" }],
    ["CrzPv5JQ/24", soundReason, { kind: "escape", type: "q", square: "c7", from: "b6" }],
    ["Qgb5C4uK/49", soundReason, { kind: "block", type: "p", square: "c4" }],
    ["ehz1gRmt/75", soundReason, { kind: "block", type: "p", square: "e2" }],
  ])("%s", (id, detect, expected) => {
    expect(detect(move(id))).toEqual(expected);
  });

  it("errors get no sound-move reason", () => {
    expect(soundReason(move("CrzPv5JQ/6"))).toBeNull();
  });

  it("stays silent when the engine line doesn't keep the pieces in place", () => {
    const f = move("CrzPv5JQ/5");
    expect(soundReason({ ...f, playedPvUci: [f.uci] })).toBeNull();
    const b = move("Qgb5C4uK/49");
    expect(soundReason({ ...b, playedPvUci: b.playedPvUci.slice(0, 2) })).toBeNull();
  });
});

describe("wording", () => {
  it("names whose pieces they are", () => {
    expect(reasonPhrase({ kind: "defend", type: "p", square: "b7" }, { mine: "their", theirs: "your" })).toBe("defends their pawn on b7");
    expect(reasonPhrase({ kind: "block", type: "p", square: "e2" }, { mine: "their", theirs: "your" })).toBe("blocks your passed pawn on e2");
    expect(reasonPhrase({ kind: "escape", type: "b", square: "h5" })).toBe("moves the bishop out of attack");
  });

  it("reads in the coach, in the user's voice and for the opponent's move", () => {
    const read = (id) => {
      const { features: f, read } = MOVES.find((m) => m.id === id);
      const opponent = read === "opponent";
      const selfSide = opponent ? (f.mover === "white" ? "black" : "white") : f.mover;
      return buildCommentary(opponent ? { ...f, opponentRead: true } : f, { selfSide }).prose;
    };
    expect(read("CrzPv5JQ/6")).toBe("Bc5 leaves the pawn on e5 open to the knight on f3. Nc6 was the move. Punish it with 4.Nxe5 and you're slightly better.");
    expect(read("ehz1gRmt/75")).toContain("38.Ke1 blocks your passed pawn on e2.");
    expect(read("iIbxaesL/70")).toBe("Nxe5 trades knights. Nf6 was the move.");
    expect(read("AgjLtJi2/45")).toBe("Mistake. Rxe3 leaves the bishop on f7 open to the king. Bh5 was the move.");
    expect(read("iIbxaesL/94")).toBe("Blunder. Qf8 is not the best move. h5 was the move: it stops 48.h5.");
    expect(read("Qgb5C4uK/54")).toBe("Mistake. Qc7 misses f5, which attacks the pawn on e4. Punish it with 28.f5 and you're slightly better.");
    expect(read("AgjLtJi2/65")).toBe("Rxe7 leaves the pawn on a4 open to the bishop on d7. Kb3 was the move.");
  });
});
