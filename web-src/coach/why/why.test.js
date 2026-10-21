import { describe, expect, it } from "vitest";
import CARDS from "../fixtures/why-cards.json";
import { why } from "./index.js";

// Pool cards (production-depth Stockfish lines) with the frozen Python path's sentence
// (research/coach-relations/why/export_js.py parity), one or two per reason type.
describe("the reason sentence matches the frozen research path", () => {
  it.each(CARDS.map((c) => [c.id, c]))("%s", (_, card) => {
    expect(why(card)).toBe(card.text);
  });
});
