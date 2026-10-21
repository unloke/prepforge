// The teach/reveal explanation and the "answer <san>" cue were private to
// controllers/train-session.js; they live in train-hint.js so a test can read
// them directly. Behaviour is unchanged: the repertoire author's annotation
// wins, otherwise the move is described on the board, and the cue names the
// opponent move the card answers.
import { describe, expect, it } from "vitest";

import { promptCueSan, teachWhy, trainTeachLine } from "./train-hint.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("teachWhy", () => {
  it("prefers the repertoire author's own annotated idea", () => {
    expect(teachWhy({
      fen_before: START, expected_uci: "e2e4", expected_san: "e4",
      hint: { annotated: true, strategy: "Grab the centre before c5." },
    }, "fallback")).toBe("Grab the centre before c5.");
  });

  it("describes the move itself when the annotation is generic", () => {
    const why = teachWhy({
      fen_before: START, expected_uci: "e2e4", expected_san: "e4",
      hint: { annotated: false, strategy: "Follow your preparation" },
    }, "fallback");
    expect(why).toBe("Takes the centre.");
  });

  it("falls back to the server's strategy when the board says nothing", () => {
    expect(teachWhy({
      fen_before: START, expected_uci: "a2a3", expected_san: "a3",
      hint: { annotated: false, strategy: "Prepare b4." },
    }, "fallback")).toBe("Prepare b4.");
  });
});

describe("trainTeachLine", () => {
  it("drops the phase coach's canned tip and keeps a position-specific one", () => {
    const prompt = { fen_before: START, expected_uci: "e2e4", expected_san: "e4", hint: {} };
    expect(trainTeachLine(prompt, { tip: "Develop your pieces.", generic: true })).toBe("Takes the centre.");
    expect(trainTeachLine(prompt, { tip: "This stops ...d5.", generic: false }))
      .toBe("Takes the centre. This stops ...d5.");
  });
});

describe("promptCueSan", () => {
  it("names the opponent move the card answers, numbered from its position", () => {
    // 1.e4 e5 2.Nf3: white to move on move 2 answers Black's 1...e5.
    const smart = { cardIndex: 0, targetIndex: 0, queue: [{ targets: [{}] }] };
    expect(promptCueSan(smart, {
      fen_before: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      run_in: [{ san: "e5" }],
    })).toBe("1...e5");
  });

  it("uses the previous step of the same card when there is no run-in", () => {
    const smart = { cardIndex: 0, targetIndex: 1, queue: [{ targets: [{ reply: { san: "Nf6" } }, {}] }] };
    expect(promptCueSan(smart, {
      fen_before: "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2",
      run_in: [],
    })).toBe("1...Nf6");
  });

  it("says nothing for a card that starts from the initial position", () => {
    expect(promptCueSan({ cardIndex: 0, targetIndex: 0, queue: [{ targets: [{}] }] },
      { fen_before: START, run_in: [] })).toBe("");
  });
});
