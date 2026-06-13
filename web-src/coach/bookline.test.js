import { describe, expect, it } from "vitest";
import {
  BOOK_OPPONENT_NOVELTY,
  BOOK_USER_DEPARTS,
  buildBookline,
} from "./bookline.js";

const userArgs = {
  kind: "user",
  san: "d5",
  uci: "d7d5",
  ply: 2,
  repName: "Caro-Kann",
  expectedSan: "c6",
};

const oppArgs = {
  kind: "opponent",
  san: "Nc6",
  uci: "b8c6",
  ply: 4,
  repName: "Italian",
};

describe("bookline", () => {
  it("fills every placeholder for a user departure", () => {
    const text = buildBookline(userArgs);
    expect(text).toMatch(/Caro-Kann/);
    expect(text).toMatch(/c6/);
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it("fills every placeholder for an opponent novelty", () => {
    const text = buildBookline(oppArgs);
    expect(text).toMatch(/Italian/);
    expect(text).toMatch(/Nc6/);
    expect(text).not.toMatch(/\{\w+\}/);
  });

  it("is deterministic per move", () => {
    expect(buildBookline(userArgs)).toBe(buildBookline(userArgs));
    expect(buildBookline(oppArgs)).toBe(buildBookline(oppArgs));
  });

  it("varies across different moves", () => {
    const texts = new Set(
      [1, 2, 3, 4, 5, 6].map((ply) =>
        buildBookline({ ...userArgs, ply, uci: `u${ply}` })
      )
    );
    expect(texts.size).toBeGreaterThan(1);
  });

  it("house style: no em-dashes or double hyphens anywhere", () => {
    for (const t of [...BOOK_USER_DEPARTS, ...BOOK_OPPONENT_NOVELTY]) {
      expect(t).not.toMatch(/—|--/);
    }
  });
});
