import { describe, it, expect } from "vitest";

import {
  resolveSan,
  applySanKey,
  createSanBuffer,
  isSanChar,
} from "./san-entry.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const PROMO = "8/P7/8/8/8/8/8/k6K w - - 0 1";
const CASTLE = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";

describe("resolveSan", () => {
  it("plays e4 from the start position as e2e4", () => {
    const out = resolveSan(START, "e4");
    expect(out.status).toBe("play");
    expect(out.uci).toBe("e2e4");
    expect(out.san).toBe("e4");
  });

  it("plays Nf3 from the start position as g1f3", () => {
    const out = resolveSan(START, "Nf3");
    expect(out.status).toBe("play");
    expect(out.uci).toBe("g1f3");
    expect(out.san).toBe("Nf3");
  });

  it("rejects e5 (Black's move) while White to move", () => {
    const out = resolveSan(START, "e5");
    expect(out.status).toBe("illegal");
    expect(out.uci).toBeNull();
  });

  it("treats a lone N as a prefix, not a play", () => {
    expect(resolveSan(START, "N").status).toBe("prefix");
  });

  it("plays a promotion SAN", () => {
    const out = resolveSan(PROMO, "a8=Q");
    expect(out.status).toBe("play");
    expect(out.uci).toBe("a7a8q");
  });

  it("keeps O-O as a prefix while O-O-O is also legal", () => {
    expect(resolveSan(CASTLE, "O-O").status).toBe("prefix");
    expect(resolveSan(CASTLE, "O-O").uci).toBeNull();
  });

  it("plays queenside castling once O-O-O is complete", () => {
    const out = resolveSan(CASTLE, "O-O-O");
    expect(out.status).toBe("play");
    expect(out.uci).toBe("e1c1");
  });

  it("commits kingside on Enter while queenside is still a longer option", () => {
    const out = resolveSan(CASTLE, "O-O", { commit: true });
    expect(out.status).toBe("play");
    expect(out.uci).toBe("e1g1");
  });

  it("auto-plays O-O when queenside is not legal", () => {
    const kingsideOnly = "r3k2r/8/8/8/8/8/8/R3K2R w K - 0 1";
    const out = resolveSan(kingsideOnly, "O-O");
    expect(out.status).toBe("play");
    expect(out.uci).toBe("e1g1");
  });

  it("plays Black's e5 after 1.e4", () => {
    const out = resolveSan(AFTER_E4, "e5");
    expect(out.status).toBe("play");
    expect(out.uci).toBe("e7e5");
  });
});

describe("applySanKey", () => {
  it("accumulates a prefix then plays the completed SAN", () => {
    const n = applySanKey("", "N", START);
    expect(n.action).toBe("buffer");
    expect(n.buffer).toBe("N");
    const nf = applySanKey("N", "f", START);
    expect(nf.action).toBe("buffer");
    expect(nf.buffer).toBe("Nf");
    const nf3 = applySanKey("Nf", "3", START);
    expect(nf3.action).toBe("play");
    expect(nf3.uci).toBe("g1f3");
    expect(nf3.buffer).toBe("");
  });

  it("plays e4 as soon as the SAN is unique", () => {
    const e = applySanKey("", "e", START);
    expect(e.action).toBe("buffer");
    const e4 = applySanKey("e", "4", START);
    expect(e4.action).toBe("play");
    expect(e4.uci).toBe("e2e4");
  });

  it("rejects an illegal token without throwing and clears the buffer", () => {
    expect(() => applySanKey("e", "5", START)).not.toThrow();
    const out = applySanKey("e", "5", START);
    expect(out.action).toBe("reject");
    expect(out.buffer).toBe("");
    expect(out.uci).toBeNull();
  });

  it("Escape clears the buffer", () => {
    const out = applySanKey("Nf", "Escape", START);
    expect(out.action).toBe("clear");
    expect(out.buffer).toBe("");
  });

  it("Escape with an empty buffer is ignored so other shortcuts still run", () => {
    expect(applySanKey("", "Escape", START).action).toBe("ignore");
  });

  it("ignores unrelated keys so shortcuts still work", () => {
    const out = applySanKey("", "ArrowLeft", START);
    expect(out.action).toBe("ignore");
    expect(out.buffer).toBe("");
  });

  it("does not auto-play O-O when O-O-O is still legal", () => {
    let buf = "";
    for (const key of ["O", "-", "O"]) {
      const step = applySanKey(buf, key, CASTLE);
      expect(step.action).toBe("buffer");
      buf = step.buffer;
    }
    expect(buf).toBe("O-O");
    const queenside = applySanKey("O-O", "-", CASTLE);
    expect(queenside.action).toBe("buffer");
    const played = applySanKey("O-O-", "O", CASTLE);
    expect(played.action).toBe("play");
    expect(played.uci).toBe("e1c1");
  });

  it("Enter on O-O plays kingside instead of waiting for O-O-O", () => {
    const out = applySanKey("O-O", "Enter", CASTLE);
    expect(out.action).toBe("play");
    expect(out.uci).toBe("e1g1");
    expect(out.buffer).toBe("");
  });
});

describe("createSanBuffer", () => {
  it("holds state across keys and clears on Escape", () => {
    const buf = createSanBuffer();
    buf.handleKey("N", START);
    expect(buf.text).toBe("N");
    buf.handleKey("Escape", START);
    expect(buf.text).toBe("");
  });

  it("does not crash on a malformed FEN", () => {
    const buf = createSanBuffer();
    const out = buf.handleKey("e", "not-a-fen");
    expect(out.action).toBe("reject");
  });
});

describe("isSanChar", () => {
  it("accepts files, pieces, captures, and promotion punctuation", () => {
    expect(isSanChar("e")).toBe(true);
    expect(isSanChar("N")).toBe(true);
    expect(isSanChar("x")).toBe(true);
    expect(isSanChar("=")).toBe(true);
    expect(isSanChar("-")).toBe(true);
    expect(isSanChar("Enter")).toBe(false);
  });
});
