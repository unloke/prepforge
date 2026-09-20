import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { localBoardInfo, localBoardAfterMove } from "./chess-local.js";

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(root, "app.js"), "utf8");
const chessLocal = readFileSync(join(root, "chess-local.js"), "utf8");
const css = readFileSync(join(root, "styles.css"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");

// Promotion-heavy positions: white pawn ready to push, white pawn ready to
// capture, black pawn ready to push. All three boards share one picker.
const WHITE_PUSH = "8/P7/8/8/8/8/8/k6K w - - 0 1";
const WHITE_CAPTURE = "1r6/P7/8/8/8/8/8/k6K w - - 0 1";
const BLACK_PUSH = "k6K/8/8/8/8/8/1p6/8 b - - 0 1";

describe("promotion move plumbing (UCI/SAN/board state)", () => {
  it("lists all four promotion pieces for a push", () => {
    const info = localBoardInfo(WHITE_PUSH);
    for (const piece of ["q", "r", "b", "n"]) {
      expect(info.legal_moves).toContain(`a7a8${piece}`);
    }
  });

  it("lists all four promotion pieces for a capture", () => {
    const info = localBoardInfo(WHITE_CAPTURE);
    for (const piece of ["q", "r", "b", "n"]) {
      expect(info.legal_moves).toContain(`a7b8${piece}`);
    }
  });

  it("lists black promotions with the suffix preserved", () => {
    const info = localBoardInfo(BLACK_PUSH);
    for (const piece of ["q", "r", "b", "n"]) {
      expect(info.legal_moves).toContain(`b2b1${piece}`);
    }
  });

  it("applies each promotion UCI and keeps SAN + board state correct", () => {
    const expectedSan = { q: "a8=Q+", r: "a8=R+", b: "a8=B", n: "a8=N" };
    for (const piece of ["q", "r", "b", "n"]) {
      const out = localBoardAfterMove(WHITE_PUSH, `a7a8${piece}`);
      expect(out.move.uci).toBe(`a7a8${piece}`);
      expect(out.move.san).toBe(expectedSan[piece]);
      expect(out.move.fen_after).toContain(" b ");
      expect(out.board.fen).toBe(out.move.fen_after);
      expect(out.board.side_to_move).toBe("black");
    }
  });

  it("applies capture promotions and knight underpromotion history", () => {
    const capture = localBoardAfterMove(WHITE_CAPTURE, "a7b8n");
    expect(capture.move.uci).toBe("a7b8n");
    expect(capture.move.san).toBe("axb8=N");
    const black = localBoardAfterMove(BLACK_PUSH, "b2b1r");
    expect(black.move.uci).toBe("b2b1r");
    expect(black.move.san).toBe("b1=R");
  });
});

describe("shared promotion picker wiring", () => {
  it("defines one shared picker covering Queen/Rook/Bishop/Knight", () => {
    expect(app).toContain("PROMOTION_PIECES = [\"q\", \"r\", \"b\", \"n\"]");
    expect(app).toContain("PROMOTION_LABELS = { q: \"Queen\", r: \"Rook\", b: \"Bishop\", n: \"Knight\" }");
    expect(app).toContain("function showPromotionPicker(");
    expect(app).toContain("function resolveBoardMove(");
    expect(app).toContain("function isPromotionMove(");
  });

  it("routes click, keyboard-square, and drag paths through the picker", () => {
    const hits = app.match(/resolveBoardMove\(\{/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("does not auto-commit a piece: cancel resolves null, choice explicit", () => {
    expect(app).toContain("dismiss(null)");
    expect(app).toContain("dismiss(btn.dataset.uci)");
  });

  it("focuses Queen first but never submits without a player choice", () => {
    const picker = app.slice(app.indexOf("function showPromotionPicker("));
    const focusAt = picker.indexOf("queenBtn.focus(");
    const clickAt = picker.indexOf("dismiss(btn.dataset.uci)");
    expect(focusAt).toBeGreaterThan(-1);
    expect(clickAt).toBeGreaterThan(-1);
    // Queen is option[0] in q/r/b/n order, so focusing buttons[0] is Queen.
    expect(picker).toContain("const queenBtn = buttons[0]");
  });

  it("keeps the promotion UCI intact through history-relevant shapes", () => {
    // UCI (not SAN) is the canonical move token everywhere the picker feeds:
    // onMove handlers take (uci, fen) and chess-local round-trips from+to+promo.
    expect(app).toContain("play: (uci) => board.play(uci)");
    expect(chessLocal).toContain("moveUci.slice(4)");
  });
});

describe("promotion picker styles and markup", () => {
  it("styles the picker with site tokens (no detached modal look)", () => {
    for (const selector of [".promotion-picker-overlay", ".promotion-picker", ".promotion-option"]) {
      expect(css).toContain(selector);
    }
    const picker = css.slice(css.indexOf(".promotion-picker {"));
    expect(picker).toMatch(/var\(--panel\)/);
    expect(picker).toMatch(/var\(--accent\)/);
  });

  it("offers mouse, touch, and keyboard operation", () => {
    const picker = app.slice(app.indexOf("function showPromotionPicker("));
    // Mouse/touch: real buttons with click handlers.
    expect(picker).toContain('class="promotion-option"');
    expect(picker).toContain('role="dialog"');
    expect(picker).toContain('aria-label="Promote to');
    // Keyboard: Queen auto-focus + Escape cancels.
    expect(picker).toContain("queenBtn.focus(");
    expect(picker).toContain('"Escape"');
  });
});

describe("typed SAN entry is gone, F flips reliably", () => {
  it("removes the type-to-move path and its UI", () => {
    for (const token of [
      "san-entry",
      "createSanBuffer",
      "resolveSan",
      "applySanKey",
      "sanBuffer",
      "handleSanKey",
      "playTypedSan",
      "paintSanBuffer",
      "Illegal SAN",
    ]) {
      expect(app, `app.js should not contain ${token}`).not.toContain(token);
    }
    expect(html).not.toContain("san-buffer");
    expect(html).not.toContain("analysis-san");
    expect(css).not.toContain(".san-buffer");
  });

  it("keeps F as an unconditional flip shortcut on all three boards", () => {
    expect(app).toContain('if (event.key === "f" || event.key === "F")');
    const flip = app.slice(app.indexOf('// F flips the active tab'));
    expect(flip).toContain("board.flip()");
    // No SAN interception sits between the keydown and the flip.
    expect(app).not.toContain("legal SAN prefix");
  });

  it("still lets real inputs receive keystrokes, including editable regions", () => {
    expect(app).toContain('["TEXTAREA", "INPUT", "SELECT"]');
    expect(app).toContain("isContentEditable");
  });
});
