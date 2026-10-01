// Regression for UX walkthrough 2026-10-01 P0-2: a guest's Explorer request
// came back 401 and the Play panel said "sample too thin, Maia stepped in".
// A failed read must be reported as unavailable, never as a thin sample.
import { describe, expect, it } from "vitest";

import {
  explorerFailureKind,
  pickOpponentReply,
  replyReasonNote,
  unavailableExplorer,
} from "./train-opponent.js";
import { ExplorerRateLimited } from "./explorer.js";

const LEGAL = ["e7e5", "c7c5", "e7e6"];
const MAIA = [{ move_uci: "e7e5", probability: 0.6 }, { move_uci: "c7c5", probability: 0.4 }];

describe("Explorer failure is not a thin sample", () => {
  it("classifies the proxy's failure modes", () => {
    expect(explorerFailureKind(new Error("Explorer responded 401"))).toBe("sign-in");
    expect(explorerFailureKind(new ExplorerRateLimited(1000))).toBe("rate-limit");
    expect(explorerFailureKind(new Error("link your Lichess account to use the opening explorer"))).toBe("link");
    expect(explorerFailureKind(new Error("Explorer responded 502"))).toBe("error");
    expect(explorerFailureKind(new TypeError("Failed to fetch"))).toBe("error");
  });

  it("a 401 read makes Maia step in with an 'unavailable' reason", () => {
    const reply = pickOpponentReply({
      book: "explorer",
      legalUcis: LEGAL,
      explorer: unavailableExplorer(new Error("Explorer responded 401")),
      maiaPredictions: MAIA,
      rng: () => 0.1,
    });
    expect(reply.source).toBe("maia");
    expect(reply.reason).toBe("explorer-unavailable");
    expect(reply.explorerUnavailable).toBe("sign-in");
    const note = replyReasonNote(reply);
    expect(note).not.toMatch(/too thin/);
    expect(note).toMatch(/sign-in/);
    // The panel already reads "Maia played …"; the note gives only the reason.
    expect(note).not.toMatch(/Maia/);
  });

  it("a genuinely thin sample still says so", () => {
    const reply = pickOpponentReply({
      book: "explorer",
      legalUcis: LEGAL,
      explorer: { totalGames: 2, moves: [{ uci: "e7e5", share: 1, total: 2 }] },
      maiaPredictions: MAIA,
      rng: () => 0.1,
    });
    expect(reply.reason).toBe("thin-sample");
    expect(replyReasonNote(reply)).toBe(" · explorer sample too thin here");
  });

  it("keeps the Explorer failure reason when the repertoire falls out of book", () => {
    const reply = pickOpponentReply({
      book: "repertoire", legalUcis: LEGAL,
      explorer: unavailableExplorer(new Error("link your Lichess account to use the opening explorer")),
      maiaPredictions: MAIA, rng: () => 0.1,
    });
    expect(reply.source).toBe("maia");
    expect(replyReasonNote(reply)).toContain("needs a linked Lichess account");
  });

  it("keeps the existing out-of-book and plain notes", () => {
    expect(replyReasonNote({ reason: "out-of-book" })).toBe(" · out of book");
    expect(replyReasonNote({ reason: null })).toBe("");
  });
});
