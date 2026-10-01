// UX walkthrough 2026-09-30, P1-6: the coach read
//   "A costly blunder, this one. a3 hands over the initiative. After d5, claiming the
//    centre, and now eyes the bishop on c4, That leaves Black about level. ..."
// — a fragment with no main clause, a capital after a comma, and a "costly blunder"
// that the same paragraph then calls "about level". These pin the scenario's shape: a
// quiet blunder (no piece hangs) whose win% drop is a blunder but which only throws away
// an edge, answered by a central pawn push with a follow-up idea.
import { describe, it, expect } from "vitest";
import { Chess } from "chess.js";

import { buildMoveFeatures } from "./features.js";
import { buildCommentary } from "./commentary.js";

function scenario(ply, { before = 200, after = 0 } = {}) {
  const c = new Chess();
  for (const m of ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "d3", "Be7", "O-O", "O-O", "Nc3", "d6", "Re1", "Bg4"]) {
    c.move(m);
  }
  const fenBefore = c.fen();
  const mv = c.move("a3");
  const fenAfter = c.fen();
  const reply = new Chess(fenAfter).move("d5");
  return buildMoveFeatures({
    ply,
    mover: "white",
    uci: mv.from + mv.to,
    san: "a3",
    fenBefore,
    fenAfter,
    beforeEval: { lines: [{ uci: "c4b3", san: "Bb3", cp: before, mate: null, pvUci: ["c4b3"], pvSan: ["Bb3"] }] },
    afterEval: { cp: after, mate: null, pvUci: [reply.from + reply.to], pvSan: ["d5"] },
  });
}

// Every seed picks different templates; sweep enough plies to cover each bank entry.
const PLIES = Array.from({ length: 40 }, (_, i) => i + 1);

describe("coach prose — an edge-losing blunder (P1-6 regression)", () => {
  it("is a blunder by the win% drop but leaves the game about level", () => {
    const f = scenario(27);
    expect(f.classification.code).toBe("blunder");
    expect(f.winAfterMover).toBeGreaterThan(43);
    expect(f.winAfterMover).toBeLessThan(57);
  });

  it("never pairs a 'costly' severity with an 'about level' verdict", () => {
    for (const ply of PLIES) {
      const prose = buildCommentary(scenario(ply)).prose;
      const lead = prose.split(/(?<=[.!])\s/)[0];
      expect(lead, prose).toMatch(/blunder/i);
      expect(lead, prose).not.toMatch(/costly|hurt|heavy|serious|stings|trouble|ouch|yikes|oof/i);
      // The standing is told from the honest "level" read, not as Black's reward.
      expect(prose, prose).not.toMatch(/leaves Black about level|Black is (now )?about level/);
      expect(prose, prose).toMatch(/level|even|equal/i);
    }
  });

  it("folds the reply's idea into a full sentence (no fragment, no capital after a comma)", () => {
    for (const ply of PLIES) {
      const prose = buildCommentary(scenario(ply)).prose;
      expect(prose, prose).not.toMatch(/, [A-Z][a-z]/); // "..., That leaves"
      expect(prose, prose).not.toMatch(/\band now eyes\b/); // finite verb left dangling
      expect(prose, prose).not.toMatch(/^After d5,|\. After d5, claiming/); // subjectless reply clause
      expect(prose, prose).toMatch(/d5, claiming the centre and /);
      expect(prose, prose).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(prose, prose).not.toMatch(/  |[ ,]\./);
      expect(prose, prose).toMatch(/^[A-Z].*[.!]$/);
    }
  });

  it("still names the better move with the edge it kept", () => {
    const prose = buildCommentary(scenario(27)).prose;
    expect(prose).toMatch(/Bb3/);
    expect(prose).toMatch(/keeping White a little better/);
  });

  it("keeps the costly read when the opponent really is better afterwards", () => {
    const prose = buildCommentary(scenario(27, { before: 0, after: -250 })).prose;
    expect(prose).toMatch(/blunder/i);
    expect(prose).toMatch(/Black/);
    expect(prose).toMatch(/better|winning/);
    expect(prose).not.toMatch(/about level|roughly equal|about even/);
  });

  it("says the mover is still ahead when the blunder only trims the edge", () => {
    const prose = buildCommentary(scenario(27, { before: 700, after: 250 })).prose;
    expect(prose).toMatch(/blunder/i);
    expect(prose).toMatch(/White (is still|stays)/);
    expect(prose).not.toMatch(/Black is (now )?(clearly |a little )?better/);
  });
});
