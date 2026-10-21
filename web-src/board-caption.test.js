// The board bar's caption (web-src/board-caption.js, web-src/analyze-name.js).
// The bar under the board used to name the position ("Initial position",
// "3... a6"); it names the game now, and the position text lives only where a
// phone reads it (its eval row). These pin the string and the empty state.
import { describe, expect, it } from "vitest";

import { analysisGameName } from "./analyze-name.js";
import { setBoardCaption, setPositionCaption } from "./board-caption.js";

function stubDocument(ids) {
  globalThis.document = { getElementById: (id) => ids[id] || null };
  return ids;
}

const el = () => ({ textContent: "", title: "" });

describe("the game named under the board", () => {
  it("names the players, then the result, event and date the PGN carries", () => {
    const pgn = [
      '[White "MagnusCarlsen"]', '[Black "HikaruNakamura"]', '[Result "1-0"]',
      '[Event "Speed Chess Championship"]', '[Date "2026.09.28"]', '', '1. e4 e5',
    ].join("\n");
    const name = analysisGameName(
      { analysis: { moves: [{ ply: 1, san: "e4" }, { ply: 2, san: "e5" }] } },
      pgn,
    );
    expect(name).toBe("MagnusCarlsen vs HikaruNakamura · 1-0 · Speed Chess Championship · 2026.09.28");
  });

  it("falls back to the half-move count when the PGN has no tags", () => {
    const name = analysisGameName({ analysis: { moves: [{ ply: 1 }, { ply: 2 }, { ply: 3 }] } }, "1. e4 e5 2. Nf3");
    expect(name).toBe("3 half-moves");
  });

  it("says nothing at all while no game is loaded", () => {
    // The board shows a start position; a label saying "Initial position" was a
    // standing explanation of what the reader can already see.
    expect(analysisGameName({ analysis: null }, "")).toBe("");
    expect(analysisGameName({ analysis: { moves: [] } }, "1. e4 e5")).toBe("");
  });

  it("ignores the unloaded demo PGN sitting in the source box", () => {
    // The prefilled PGN must not title an empty board "PrepForge vs Demo".
    const pgn = '[White "PrepForge"]\n[Black "Demo"]\n\n1. e4 e5';
    expect(analysisGameName({ analysis: null }, pgn)).toBe("");
  });
});

describe("the caption slots", () => {
  it("writes the name and its tooltip into the bar, and clears both", () => {
    const caption = el();
    stubDocument({ "analysis-board-caption": caption });
    setBoardCaption("me_user vs opp_one · 0-1");
    expect(caption.textContent).toBe("me_user vs opp_one · 0-1");
    // A long name is cut by the layout, so the whole of it is the tooltip.
    expect(caption.title).toBe("me_user vs opp_one · 0-1");
    setBoardCaption("");
    expect(caption.textContent).toBe("");
    expect(caption.title).toBe("");
    delete globalThis.document;
  });

  it("keeps the position text in the phone's eval row only", () => {
    const move = el();
    stubDocument({ "analysis-ev-move": move });
    setPositionCaption("3... a6");
    expect(move.textContent).toBe("3... a6");
    setPositionCaption("");
    expect(move.textContent).toBe("");
    delete globalThis.document;
  });
});
