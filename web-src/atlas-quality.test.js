import { describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { atlasPreparation } from "./atlas-quality.js";

// Same chess.js-verified tree construction as coverage.test.js; no invented FENs.
function tree(lines, fen) {
  const nodes = [{ id: "root", parent_id: null, depth: 0,
    fen: new Chess(fen).fen(), is_enabled: true }];
  for (const line of lines) {
    const chess = new Chess(fen);
    let parent = nodes[0];
    for (const san of line) {
      const own = chess.turn() === "w";
      const move = chess.move(san);
      const uci = move.from + move.to + (move.promotion || "");
      let node = nodes.find((n) => n.parent_id === parent.id && n.uci === uci);
      if (!node) {
        node = { id: `n${nodes.length}`, parent_id: parent.id, depth: parent.depth + 1,
          uci, san, fen: chess.fen(), is_prepared: own, is_enabled: true,
          is_mainline: !nodes.some((n) => n.parent_id === parent.id) };
        nodes.push(node);
      }
      parent = node;
    }
  }
  return nodes;
}

const line16 = "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O".split(" ");
const assess = (nodes, options = {}) => atlasPreparation({ nodes, myColor: "white", ...options });
const facet = (result, label) => result.facets.find((f) => f.label === label).value;
const values = (result) => ({ score: result.score, facets: result.facets.map((f) => f.value) });

describe("Atlas move preparation", () => {
  it("leaves an empty tree and root-only tree entirely unmeasured", () => {
    for (const nodes of [[], tree([])]) {
      const result = assess(nodes);
      expect(result.score).toBeNull();
      expect(result.facets.map((f) => f.label)).toEqual(["Replies", "Reach", "Depth", "Move orders"]);
      expect(result.facets.every((f) => f.value === null)).toBe(true);
    }
  });

  it("loses Replies and Reach when an own response is deleted", () => {
    const nodes = tree([line16]);
    const complete = assess(nodes);
    const removed = new Set(nodes.filter((n) => n.depth >= 3).map((n) => n.id));
    const incomplete = assess(nodes.filter((n) => !removed.has(n.id)));
    expect(facet(complete, "Reach")).toBe(100);
    expect(facet(incomplete, "Replies")).toBeLessThan(facet(complete, "Replies"));
    expect(facet(incomplete, "Reach")).toBeLessThan(facet(complete, "Reach"));
  });

  it("joins continuations across different legal move orders", () => {
    const first = ["d4", "Nf6", "Nf3", "d5"];
    const second = ["Nf3", "d5", "d4", "Nf6", "c4"];
    const isolated = assess(tree([first]));
    const joined = assess(tree([first, second]));
    expect(facet(joined, "Depth")).toBeGreaterThan(facet(isolated, "Depth"));
    // One occurrence has no response; union traversal must not pretend both do.
    expect(facet(joined, "Move orders")).toBe(0);
  });

  it("credits a coherent real transposition even when its reply sets are identical", () => {
    const nodes = tree([
      ["d4", "Nf6", "Nf3", "d5", "c4"],
      ["Nf3", "d5", "d4", "Nf6", "c4"],
    ]);
    expect(facet(assess(nodes), "Move orders")).toBe(100);
    const copies = nodes.slice(1).map((n) => ({ ...n, id: `copy-${n.id}`,
      parent_id: n.parent_id === "root" ? "root" : `copy-${n.parent_id}` }));
    expect(values(assess([...nodes, ...copies]))).toEqual(values(assess(nodes)));
  });

  it("intersects reply sets rather than requiring identical alternatives", () => {
    const nodes = tree([
      ["d4", "Nf6", "Nf3", "d5", "c4"],
      ["Nf3", "d5", "d4", "Nf6", "c4"],
      ["Nf3", "d5", "d4", "Nf6", "e3"],
    ]);
    expect(facet(assess(nodes), "Move orders")).toBe(100);
  });

  it("gives no graph-score bonus for duplicating an identical stored branch", () => {
    const nodes = tree([line16]);
    const duplicates = nodes.slice(1).map((n) => ({ ...n, id: `copy-${n.id}`,
      parent_id: n.parent_id === "root" ? "root" : `copy-${n.parent_id}` }));
    expect(values(assess([...nodes, ...duplicates]))).toEqual(values(assess(nodes)));
  });

  it("ignores annotations, numeric notes, engine directives and training metadata", () => {
    const nodes = tree([line16]);
    for (const comment of [undefined, "1", "[%eval 3.5]", "Long explanation ".repeat(100)]) {
      const annotated = nodes.map((n) => ({ ...n, comment, typical_plan: comment,
        strategic_idea: comment, tactical_warning: comment, tags: ["plan"],
        arrows: ["a1a8"], circles: ["e4"], mastery: "mastered", maia_probability: 0.99 }));
      expect(values(assess(annotated))).toEqual(values(assess(nodes)));
    }
  });

  it("does not read any external source", () => {
    const fetch = vi.fn(() => { throw new Error("No external reads permitted"); });
    vi.stubGlobal("fetch", fetch);
    try {
      assess(tree([line16]));
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("excludes descendants of a disabled ancestor", () => {
    const nodes = tree([line16]);
    nodes[2].is_enabled = false;
    expect(values(assess(nodes))).toEqual(values(assess(nodes.slice(0, 2))));
  });

  it("averages opponent alternatives but chooses one own continuation", () => {
    const nodes = tree([line16, ["e4", "c5"], ["d4"]]);
    const result = assess(nodes);
    expect(facet(result, "Reach")).toBe(50);
    // An unused alternative at our turn cannot dilute survival as an opponent fork does.
    expect(facet(assess(tree([line16, ["d4"]])), "Reach")).toBe(100);
    expect(values(assess([...nodes].reverse()))).toEqual(values(result));
  });

  it("honours prepared mainline preference over a different UCI-first choice", () => {
    const nodes = tree([["d4"], line16]);
    nodes.find((n) => n.san === "d4").is_prepared = false;
    const e4 = nodes.find((n) => n.san === "e4");
    e4.is_prepared = true;
    e4.is_mainline = true;
    expect(facet(assess(nodes), "Reach")).toBe(100);
  });

  it("does not pad a repeating knight shuffle to the horizon", () => {
    const cycle = ["Nf3", "Nf6", "Ng1", "Ng8"];
    const once = assess(tree([cycle]));
    const repeated = assess(tree([[...cycle, ...cycle, ...cycle, ...cycle]]));
    expect(facet(once, "Reach")).toBe(0);
    expect(facet(once, "Depth")).toBeLessThan(100);
    expect(facet(repeated, "Depth")).toBe(facet(once, "Depth"));
  });

  it("credits the 16th ply without demanding a 17th-ply reply", () => {
    const short = assess(tree([line16.slice(0, 15)]));
    const exact = assess(tree([line16]));
    expect(facet(short, "Reach")).toBe(0);
    expect(facet(exact, "Reach")).toBe(100);
    expect(facet(exact, "Depth")).toBe(100);
  });

  it("measures depth as survival area rather than the longest stored line", () => {
    const result = assess(tree([["e4", "e5", "Nf3", "Nc6"], ["e4", "c5"]]));
    // Survival is 1, 1, 1/2, 1/2, then zero: area 3 over 16 plies.
    expect(facet(result, "Depth")).toBeCloseTo(100 * 3 / 16);
    expect(facet(result, "Reach")).toBe(0);
  });

  it("keeps a current-position scope local and measures its horizon relatively", () => {
    const nodes = tree([line16]);
    const result = assess(nodes, { rootNodeId: nodes[14].id });
    expect(facet(result, "Depth")).toBeCloseTo(100 * 2 / 16);
    expect(facet(result, "Reach")).toBe(0);
    nodes[1].is_enabled = false;
    expect(() => assess(nodes, { rootNodeId: nodes[14].id })).toThrow(/disabled/i);
  });

  it("credits checkmate and stalemate as actual terminal success", () => {
    expect(facet(assess(tree([["f3", "e5", "g4", "Qh4#"]])), "Reach")).toBe(100);
    const fen = "7k/5K2/8/6Q1/8/8/8/8 w - - 0 1";
    expect(facet(assess(tree([["Qg6"]], fen)), "Reach")).toBe(100);
  });

  it("rejects an illegal edge rather than scoring an invented route", () => {
    const nodes = tree([["e4"]]);
    nodes[1].uci = "e2e5";
    expect(() => assess(nodes)).toThrow();
  });

  it("rejects a legal move paired with the wrong resulting position", () => {
    const nodes = tree([["e4"]]);
    nodes[1].fen = nodes[0].fen;
    expect(() => assess(nodes)).toThrow(/position/i);
  });

  it("keeps castling rights and en-passant rights in position identity", () => {
    // A rook returns to h1, but white has lost kingside castling rights.
    const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
    const nodes = tree([["Rh2", "Rh7", "Rh1", "Rh8", "O-O-O"]], fen);
    expect(facet(assess(nodes), "Move orders")).toBeNull();
    // Same pieces and turn after a reversible king shuffle; e.p. has expired.
    const epFen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2";
    const epNodes = tree([["Kf1", "Kf8", "Ke1", "Ke8", "Kd1"]], epFen);
    expect(facet(assess(epNodes), "Move orders")).toBeNull();
  });
});
