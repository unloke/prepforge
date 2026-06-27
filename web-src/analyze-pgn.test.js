import { describe, it, expect } from "vitest";

import { parsePgn, treeToMovetext } from "./analyze-pgn.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const LEAF_KEYS = ["children", "fenAfter", "fenBefore", "moveNumber", "san", "side", "uci"];

function mainlineChain(root) {
  const chain = [];
  let node = root.children[0];
  while (node) {
    chain.push(node);
    node = node.children[0];
  }
  return chain;
}

function mainlineSans(root) {
  return mainlineChain(root).map((n) => n.san);
}

function variationSans(root) {
  const result = [];
  function walk(node) {
    for (const alt of (node.children || []).slice(1)) {
      const seq = [alt.san];
      let cur = alt;
      while (cur.children && cur.children[0]) {
        cur = cur.children[0];
        seq.push(cur.san);
      }
      result.push(seq);
      walk(alt);
    }
    if (node.children && node.children[0]) {
      walk(node.children[0]);
    }
  }
  if (root.children[0]) walk(root.children[0]);
  return result;
}

function treesEquivalent(a, b) {
  expect(mainlineSans(a)).toEqual(mainlineSans(b));
  expect(variationSans(a).sort()).toEqual(variationSans(b).sort());
}

describe("parsePgn", () => {
  it("parses a simple mainline with correct node fields", () => {
    const { ok, root } = parsePgn("1. e4 e5 2. Nf3 Nc6");
    expect(ok).toBe(true);

    const chain = mainlineChain(root);
    expect(chain).toHaveLength(4);
    expect(chain.map((n) => n.san)).toEqual(["e4", "e5", "Nf3", "Nc6"]);

    expect(chain[0].uci).toBe("e2e4");
    expect(chain[0].side).toBe("white");
    expect(chain[0].moveNumber).toBe(1);
    expect(chain[0].fenBefore).toBe(START);
    expect(chain[0].fenAfter).toContain(" b ");

    expect(chain[1].uci).toBe("e7e5");
    expect(chain[1].side).toBe("black");
    expect(chain[1].moveNumber).toBe(1);

    expect(chain[2].uci).toBe("g1f3");
    expect(chain[2].side).toBe("white");
    expect(chain[2].moveNumber).toBe(2);

    expect(chain[3].uci).toBe("b8c6");
    expect(chain[3].side).toBe("black");
    expect(chain[3].children).toEqual([]);
  });

  it("parses headers and ignores the result token", () => {
    const pgn = `[Event "Test"]
[White "Magnus"]
[Black "Hikaru"]
[Result "1-0"]

1. d4 d5 2. c4 1-0`;
    const { ok, root, headers } = parsePgn(pgn);
    expect(ok).toBe(true);
    expect(headers).toEqual({
      Event: "Test",
      White: "Magnus",
      Black: "Hikaru",
      Result: "1-0",
    });
    expect(mainlineSans(root)).toEqual(["d4", "d5", "c4"]);
  });

  it("parses a variation as a sibling of the mainline move", () => {
    const { ok, root } = parsePgn("1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6");
    expect(ok).toBe(true);

    const e4 = root.children[0];
    expect(e4.san).toBe("e4");
    expect(e4.children.map((n) => n.san)).toEqual(["e5", "c5"]);

    const c5 = e4.children[1];
    expect(c5.children[0].san).toBe("Nf3");
    expect(mainlineSans(root)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });

  it("parses nested variations", () => {
    const pgn = "1. e4 e5 (1... c5 2. Nf3 (2. Bc4) 2... Nc6) 2. Nf3";
    const { ok, root } = parsePgn(pgn);
    expect(ok).toBe(true);

    const e4 = root.children[0];
    const e5 = e4.children[0];
    const c5 = e4.children[1];
    const nf3InVar = c5.children[0];

    expect(e5.san).toBe("e5");
    expect(c5.san).toBe("c5");
    expect(c5.children.map((n) => n.san)).toEqual(["Nf3", "Bc4"]);
    expect(nf3InVar.san).toBe("Nf3");
    expect(nf3InVar.children.map((n) => n.san)).toEqual(["Nc6"]);

    expect(mainlineSans(root)).toEqual(["e4", "e5", "Nf3"]);
    expect(variationSans(root)).toEqual(
      expect.arrayContaining([["c5", "Nf3", "Nc6"], ["Bc4"]]),
    );
  });

  it("strips comments, line comments, and NAGs without affecting moves", () => {
    const pgn = `1. e4 { king pawn } e5 ; Sicilian declined
$1 2. Nf3 $15 Nc6`;
    const { ok, root } = parsePgn(pgn);
    expect(ok).toBe(true);
    expect(mainlineSans(root)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
  });

  it("preserves semicolons inside brace comments", () => {
    const pgn = "1. e4 { clock 0:05; eval +0.2 } e5";
    const { ok, root } = parsePgn(pgn);
    expect(ok).toBe(true);
    expect(mainlineSans(root)).toEqual(["e4", "e5"]);
  });

  it("parses promotions with correct uci and san", () => {
    const pgn = "1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q";
    const { ok, root } = parsePgn(pgn);
    expect(ok).toBe(true);

    const chain = mainlineChain(root);
    const promo = chain[chain.length - 1];
    expect(promo.san).toBe("bxa8=Q");
    expect(promo.uci).toBe("b7a8q");
  });

  it("parses FEN-only PGN (no moves)", () => {
    const pgn =
      '[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"]';
    const { ok, root, headers } = parsePgn(pgn);
    expect(ok).toBe(true);
    expect(root.children).toHaveLength(0);
    expect(headers.FEN).toBe(
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    );
  });

  it("returns an empty tree for empty or whitespace input", () => {
    for (const input of ["", "   ", "\n\n"]) {
      const result = parsePgn(input);
      expect(result).toEqual({
        ok: true,
        root: { san: null, children: [] },
        headers: {},
      });
    }
  });

  it("returns ok:false for an illegal move", () => {
    const result = parsePgn("1. e4 e5 2. Ke2 Ke7 3. Qz9");
    expect(result.ok).toBe(false);
    expect(result.error).toEqual(expect.any(String));
  });

  it("returns ok:false for unmatched opening parenthesis", () => {
    const result = parsePgn("1. e4 e5 (1... c5");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unmatched opening parenthesis");
  });

  it("returns ok:false for unmatched closing parenthesis", () => {
    const result = parsePgn("1. e4 e5 2. Nf3)");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unmatched closing parenthesis");
  });

  it("returned nodes contain only documented fields", () => {
    const { root } = parsePgn("1. e4 e5 2. Nf3");
    const leaf = mainlineChain(root)[1];
    const internal = mainlineChain(root)[0];
    expect(Object.keys(leaf).sort()).toEqual(LEAF_KEYS);
    expect(Object.keys(internal).sort()).toEqual(LEAF_KEYS);
    expect(leaf._parent).toBeUndefined();
    expect(internal._parent).toBeUndefined();
  });
});

describe("treeToMovetext", () => {
  it("serializes the e4/e5/(c5)/Nf3 variation tree", () => {
    const { root } = parsePgn("1. e4 e5 (1... c5) 2. Nf3");
    expect(treeToMovetext(root)).toBe("1. e4 e5 (1... c5) 2. Nf3");
  });

  it("returns empty string for an empty root", () => {
    expect(treeToMovetext({ san: null, children: [] })).toBe("");
  });
});

describe("round-trip", () => {
  const games = [
    "1. e4 e5 2. Nf3 Nc6 3. Bb5",
    "1. d4 d5 2. c4 e6 3. Nc3",
    "1. e4 e5 (1... c5 2. Nf3) 2. Nf3 Nc6",
    "1. e4 e5 (1... c5 2. Nf3 (2. Bc4) 2... Nc6) 2. Nf3",
    `[Event "R"]
1. e4 { comment } e5 ; line
(1... c5) 2. Nf3 $1 *`,
  ];

  for (const [i, pgn] of games.entries()) {
    it(`parse → serialize → parse preserves structure (game ${i + 1})`, () => {
      const first = parsePgn(pgn);
      expect(first.ok).toBe(true);

      const movetext = treeToMovetext(first.root);
      const second = parsePgn(movetext);
      expect(second.ok).toBe(true);

      treesEquivalent(first.root, second.root);
    });
  }
});