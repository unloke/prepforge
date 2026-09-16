import { describe, it, expect } from "vitest";

import { mapTrainUiSession, shouldResetTrainStats } from "./train-resume.js";

function smartPayload(overrides = {}) {
  return {
    repertoire_id: "rep-1",
    repertoire_name: "King's Pawn",
    color: "white",
    mixed: true,
    session_id: "sess-9",
    seed: 13,
    mode: "smart",
    total_cards: 3,
    card_index: 0,
    counts: { new: 2, due: 1, weak: 0 },
    health: { mastery_pct: 10 },
    cards: [
      { kind: "new", targets: [{ uci: "e2e4", san: "e4" }] },
      { kind: "due", targets: [{ uci: "g1f3", san: "Nf3" }] },
      { kind: "weak", targets: [{ uci: "d2d4", san: "d4" }] },
    ],
    prompt: { session_id: "sess-9", card_index: 0 },
    ...overrides,
  };
}

function linePayload(overrides = {}) {
  return {
    repertoire_id: "rep-2",
    repertoire_name: "Italian",
    color: "black",
    session_id: "line-4",
    seed: 7,
    mode: "all_lines",
    line_order: ["n1", "n2"],
    lines: [{ line_node_id: "n1" }, { line_node_id: "n2" }],
    prompt: {
      session_id: "line-4",
      current_index: 0,
      total_lines: 2,
      fen_before: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    },
    ...overrides,
  };
}

describe("mapTrainUiSession", () => {
  it("maps a fresh smart start to index 0 with the payload session id", () => {
    const mapped = mapTrainUiSession(smartPayload(), { fresh: true });
    expect(mapped.sessionId).toBe("sess-9");
    expect(mapped.cardIndex).toBe(0);
    expect(mapped.resumed).toBe(false);
    expect(mapped.queue).toHaveLength(3);
    expect(mapped.cardsDone).toBe(0);
    expect(shouldResetTrainStats(mapped)).toBe(true);
  });

  it("continues an unfinished smart session at the server card_index", () => {
    const payload = smartPayload({ card_index: 2, resumed: true });
    const mapped = mapTrainUiSession(payload, { fresh: false });
    expect(mapped.sessionId).toBe("sess-9");
    expect(mapped.cardIndex).toBe(2);
    expect(mapped.cardsDone).toBe(2);
    expect(mapped.resumed).toBe(true);
    expect(mapped.queue[2].kind).toBe("weak");
    expect(shouldResetTrainStats(mapped)).toBe(false);
  });

  it("fresh still starts new even when the payload still carries a mid-queue index", () => {
    const mapped = mapTrainUiSession(smartPayload({ card_index: 2, resumed: true }), {
      fresh: true,
    });
    expect(mapped.cardIndex).toBe(0);
    expect(mapped.resumed).toBe(false);
    expect(mapped.cardsDone).toBe(0);
  });

  it("drops cards that have no targets so the queue matches what Train can play", () => {
    const mapped = mapTrainUiSession(
      smartPayload({
        cards: [
          { kind: "new", targets: [{ uci: "e2e4" }] },
          { kind: "empty", targets: [] },
        ],
      }),
    );
    expect(mapped.queue).toHaveLength(1);
    expect(mapped.queue[0].kind).toBe("new");
  });

  it("resumes a line-rehearsal session from prompt.current_index", () => {
    const mapped = mapTrainUiSession(
      linePayload({
        resumed: true,
        prompt: {
          session_id: "line-4",
          current_index: 1,
          total_lines: 2,
        },
      }),
      { fresh: false },
    );
    expect(mapped.mode).toBe("all_lines");
    expect(mapped.sessionId).toBe("line-4");
    expect(mapped.cardIndex).toBe(1);
    expect(mapped.color).toBe("black");
    expect(mapped.resumed).toBe(true);
  });
});
