import { describe, it, expect } from "vitest";
import MOVES from "./fixtures/reason-moves.json";
import RATED from "./fixtures/rated-moves.json";
import { soundReason, betterReason, reasonPhrase, reasonParticiple } from "./reasons.js";
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
    ["CrzPv5JQ/6", betterReason, { kind: "defend", type: "p", square: "e5" }],
    ["AgjLtJi2/65", betterReason, { kind: "defend", type: "p", square: "a4" }],
    ["AgjLtJi2/45", betterReason, { kind: "escape", type: "b", square: "h5", from: "f7" }],
    ["9oLH8Czy/18", betterReason, { kind: "attack", type: "b", square: "b5" }],
    ["iIbxaesL/94", betterReason, { kind: "stops", reply: "48.h5" }],
    ["Qgb5C4uK/54", betterReason, { kind: "stops", reply: "28.f5" }],
  ])("%s", (id, detect, expected) => {
    expect(detect(move(id))).toEqual(expected);
  });

  it("errors get no sound-move reason and sound moves no error reason", () => {
    expect(soundReason(move("CrzPv5JQ/6"))).toBeNull();
    expect(betterReason(move("CrzPv5JQ/5"))).toBeNull();
  });

  it("stays silent when the engine line doesn't keep the pieces in place", () => {
    const f = move("CrzPv5JQ/5");
    expect(soundReason({ ...f, playedPvUci: [f.uci] })).toBeNull();
    const b = move("Qgb5C4uK/49");
    expect(soundReason({ ...b, playedPvUci: b.playedPvUci.slice(0, 2) })).toBeNull();
  });

  it("a better move's attack the line ignores is not the reason (Rc6: Rd7 dodges the fork, a7 is incidental)", () => {
    const rc6 = RATED.find((r) => r.input.san === "Rc6").input;
    expect(betterReason(buildMoveFeatures(rc6))).toBeNull();
  });

  it("a better move's defence needs the played line to take that piece", () => {
    const f = move("AgjLtJi2/65");
    expect(betterReason({ ...f, replyUci: null })).toBeNull();
  });
});

describe("wording", () => {
  it("names whose pieces they are", () => {
    expect(reasonPhrase({ kind: "defend", type: "p", square: "b7" }, { mine: "their", theirs: "your" })).toBe("defends their pawn on b7");
    expect(reasonPhrase({ kind: "block", type: "p", square: "e2" }, { mine: "their", theirs: "your" })).toBe("blocks your passed pawn on e2");
    expect(reasonPhrase({ kind: "escape", type: "b", square: "h5" })).toBe("moves the bishop out of attack");
    expect(reasonParticiple("moves the bishop out of attack")).toBe("moving the bishop out of attack");
    expect(reasonParticiple("defends their pawn on e5")).toBe("defending their pawn on e5");
    expect(reasonParticiple(reasonPhrase({ kind: "stops", reply: "28.f5" }))).toBe("stopping 28.f5");
  });

  it("reads in the coach, in the user's voice and for the opponent's move", () => {
    const read = (id) => {
      const { features: f, read } = MOVES.find((m) => m.id === id);
      const opponent = read === "opponent";
      const selfSide = opponent ? (f.mover === "white" ? "black" : "white") : f.mover;
      return buildCommentary(opponent ? { ...f, opponentRead: true } : f, { selfSide }).prose;
    };
    expect(read("CrzPv5JQ/6")).toBe("3...Bc5 is a little loose. Nc6 was better for them, defending their pawn on e5. Punish it with 4.Nxe5 and you're slightly better.");
    expect(read("ehz1gRmt/75")).toContain("38.Ke1 blocks your passed pawn on e2.");
    expect(read("iIbxaesL/70")).toBe("Nxe5 trades knights. Nf6 was the move.");
    expect(read("AgjLtJi2/45")).toBe("Mistake. Rxe3 leaves the bishop on f7 open to the king. Bh5 was the move.");
    expect(read("iIbxaesL/94")).toBe("Blunder. Qf8 is not the best move. h5 was the move: it stops 48.h5.");
    expect(read("Qgb5C4uK/54")).toBe("27...Qc7 is a mistake. They should have played f5, stopping 28.f5. Punish it with 28.f5 and you're slightly better.");
    expect(read("AgjLtJi2/65")).toBe("Rxe7 leaves the pawn on a4 open to the bishop on d7. Kb3 was the move.");
  });
});
