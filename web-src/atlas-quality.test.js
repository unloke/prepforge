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
const assess = (nodes, options = {}) => atlasPreparation({ nodes, myColor: "white", horizon: 16, ...options });
const tiedRoots = (nodes) => nodes.map((n) => n.parent_id === "root" ? { ...n, is_mainline: true, is_prepared: true } : n);
function chapters(lines) {
  return [tree([])[0], ...lines.flatMap((line, i) => tree([line]).slice(1).map((n) => ({
    ...n, id: `${i}-${n.id}`, parent_id: n.parent_id === "root" ? "root" : `${i}-${n.parent_id}`,
  })))];
}
// Raw observations retain their arithmetic contract; calibrated values are
// tested separately below rather than asserting historical fitted constants.
const rawFacet = (result, label) => {
  const f = result.facets.find((f) => f.label === label);
  return f.denominator ? 100 * f.numerator / f.denominator : null;
};
const rated = (result, label) => result.facets.find((f) => f.label === label).value;
const values = (result) => ({ score: result.score, facets: result.facets.map((f) => f.value) });

describe("Atlas move preparation", () => {
  it("does not mistake one stored move for complete response preparation", () => {
    const result = assess(tree([["e4"]]));
    expect(rated(result, "Replies")).toBeLessThan(50);
    expect(rated(result, "Depth")).toBeLessThan(10);
    expect(result.score).toBeLessThan(10);
  });

  it("keeps calibrated values independent of moves beyond the scoped bound", () => {
    expect(values(assess(tree([line16]), { horizon: 8 })))
      .toEqual(values(assess(tree([line16.slice(0, 8)]), { horizon: 8 })));
  });

  it("treats alternative complete systems as choice load rather than zero consistency", () => {
    const italian = "e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 O-O d6 c3 O-O Re1 a6 Bb3 Ba7".split(" ");
    const result = assess(chapters([line16, italian]));
    expect(rated(result, "Consistency")).toBeGreaterThan(40);
    expect(rated(result, "Consistency")).toBeLessThan(rated(assess(tree([line16])), "Consistency"));
    expect(result.score).toBeGreaterThanOrEqual(assess(tree([line16])).score);
  });

  it("leaves an empty tree and root-only tree entirely unmeasured", () => {
    for (const nodes of [[], tree([])]) {
      const result = assess(nodes);
      expect(result.score).toBeNull();
      expect(result.facets.map((f) => f.label)).toEqual(["Replies", "Reach", "Depth", "Consistency", "Ease"]);
      expect(result.facets.every((f) => f.value === null)).toBe(true);
    }
  });

  it("loses Replies and Depth when a core own response is deleted", () => {
    const nodes = tree([line16]);
    const complete = assess(nodes);
    const removed = new Set(nodes.filter((n) => n.depth >= 3).map((n) => n.id));
    const incomplete = assess(nodes.filter((n) => !removed.has(n.id)));
    expect(rawFacet(complete, "Depth")).toBe(100);
    expect(rawFacet(incomplete, "Replies")).toBeLessThan(rawFacet(complete, "Replies"));
    expect(rawFacet(incomplete, "Depth")).toBeLessThan(rawFacet(complete, "Depth"));
    for (const label of ["Replies", "Depth"]) expect(rated(incomplete, label)).toBeLessThan(rated(complete, label));
  });

  it("joins continuations across different legal move orders", () => {
    const first = ["d4", "Nf6", "Nf3", "d5"];
    const second = ["Nf3", "d5", "d4", "Nf6", "c4"];
    const isolated = assess(tree([first]));
    const joined = assess(tiedRoots(tree([first, second])));
    expect(rawFacet(joined, "Depth")).toBeGreaterThan(rawFacet(isolated, "Depth"));
    // A chapter endpoint is not a conflicting recommendation.
    expect(rawFacet(joined, "Consistency")).toBe(100);
  });

  it("credits a coherent real transposition even when its reply sets are identical", () => {
    const nodes = tree([
      ["d4", "Nf6", "Nf3", "d5", "c4"],
      ["Nf3", "d5", "d4", "Nf6", "c4"],
    ]);
    expect(rawFacet(assess(tiedRoots(nodes)), "Consistency")).toBe(100);
    const copies = nodes.slice(1).map((n) => ({ ...n, id: `copy-${n.id}`,
      parent_id: n.parent_id === "root" ? "root" : `copy-${n.parent_id}` }));
    expect(values(assess([...tiedRoots(nodes), ...tiedRoots(copies)]))).toEqual(values(assess(tiedRoots(nodes))));
  });

  it("intersects reply sets rather than requiring identical alternatives", () => {
    const nodes = tree([
      ["d4", "Nf6", "Nf3", "d5", "c4"],
      ["Nf3", "d5", "d4", "Nf6", "c4"],
      ["Nf3", "d5", "d4", "Nf6", "e3"],
    ]);
    nodes.find((n) => n.san === "e3").is_mainline = true;
    expect(rawFacet(assess(tiedRoots(nodes)), "Consistency")).toBe(100);
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

  it("keeps a short unselected opponent illustration from diluting core preparation", () => {
    const nodes = tree([line16, ["e4", "c5"], ["d4"]]);
    const result = assess(nodes);
    expect(rawFacet(result, "Depth")).toBe(100);
    expect(rawFacet(result, "Replies")).toBe(100);
    expect(rawFacet(result, "Reach")).toBe(20);
    expect(rawFacet(assess(tree([line16, ["d4"]])), "Depth")).toBe(100);
    expect(values(assess([...nodes].reverse()))).toEqual(values(result));
  });

  it("honours prepared mainline preference over a different UCI-first choice", () => {
    const nodes = tree([["d4"], line16]);
    nodes.find((n) => n.san === "d4").is_prepared = false;
    const e4 = nodes.find((n) => n.san === "e4");
    e4.is_prepared = true;
    e4.is_mainline = true;
    expect(rawFacet(assess(nodes), "Depth")).toBe(100);
  });

  it("does not pad a repeating knight shuffle to the horizon", () => {
    const cycle = ["Nf3", "Nf6", "Ng1", "Ng8"];
    const once = assess(tree([cycle]));
    const repeated = assess(tree([[...cycle, ...cycle, ...cycle, ...cycle]]));
    expect(rawFacet(once, "Reach")).toBe(20);
    expect(rawFacet(once, "Depth")).toBeLessThan(100);
    expect(rawFacet(repeated, "Depth")).toBe(rawFacet(once, "Depth"));
  });

  it("credits the 16th ply without demanding a 17th-ply reply", () => {
    const short = assess(tree([line16.slice(0, 15)]));
    const exact = assess(tree([line16]));
    expect(rawFacet(short, "Depth")).toBe(93.75);
    expect(rawFacet(exact, "Depth")).toBe(100);
  });

  it("averages distinct chapter core plans instead of selecting an arbitrary first plan", () => {
    const result = assess(chapters([["e4", "e5", "Nf3", "Nc6"], ["d4", "d5"]]));
    expect(rawFacet(result, "Depth")).toBeCloseTo(100 * 2 / 16);
    expect(rawFacet(result, "Reach")).toBe(20);
  });

  it("does not interpret a short nonpreferred opponent variation as the core target", () => {
    const result = assess(tree([["e4", "e5", "Nf3", "Nc6"], ["e4", "c5"]]));
    expect(rawFacet(result, "Depth")).toBeCloseTo(100 * 3 / 16);
    expect(rawFacet(result, "Reach")).toBe(20);
  });

  it("keeps a current-position scope local and measures its horizon relatively", () => {
    const nodes = tree([line16]);
    const result = assess(nodes, { rootNodeId: nodes[14].id });
    expect(rawFacet(result, "Depth")).toBeCloseTo(100 * 1 / 16);
    expect(rawFacet(result, "Reach")).toBe(20);
    nodes[1].is_enabled = false;
    expect(() => assess(nodes, { rootNodeId: nodes[14].id })).toThrow(/disabled/i);
  });

  it("does not reward a stored loss as terminal success", () => {
    expect(rawFacet(assess(tree([["f3", "e5", "g4", "Qh4#"]])), "Depth")).toBe(25);
    expect(rawFacet(assess(tree([["e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"]])), "Depth")).toBe(100);
    const fen = "7k/5K2/8/6Q1/8/8/8/8 w - - 0 1";
    expect(rawFacet(assess(tree([["Qg6"]], fen)), "Depth")).toBe(100);
  });

  it("rejects an illegal edge rather than scoring an invented route", () => {
    const nodes = tree([["e4"]]);
    nodes[1].uci = "e2e5";
    expect(() => assess(nodes)).toThrow();
  });

  it("prefers answered breadth to a single equally long route", () => {
    const narrow = assess(tree([line16]));
    const broad = assess(tree([line16, "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7 O-O O-O".split(" ")]));
    expect(broad.score).toBeGreaterThan(narrow.score);
    expect(rawFacet(broad, "Reach")).toBeGreaterThan(rawFacet(narrow, "Reach"));
    expect(rated(broad, "Reach")).toBeGreaterThan(rated(narrow, "Reach"));
  });

  it("ignores an unpreferred own demonstration even when it is a stored loss", () => {
    const nodes = tree([line16, ["f3", "e5", "g4", "Qh4#"]]);
    expect(values(assess(nodes))).toEqual(values(assess(tree([line16]))));
  });

  it("shows divergent chapter choices without calling intentional alternatives poor preparation", () => {
    const second = "e4 e5 Nf3 Nc6 Bc4 Bc5 d3 Nf6 O-O d6 c3 O-O Re1 a6 Bb3 Ba7".split(" ");
    const alternatives = assess(chapters([line16, second]));
    expect(rawFacet(alternatives, "Consistency")).toBe(0);
    expect(alternatives.score).toBeGreaterThanOrEqual(assess(tree([line16])).score);
  });

  it("measures reused plans only in comparable setups and leaves no-pair Ease unknown", () => {
    const same = assess(tree(["d4 d5 Bf4 Nf6 e3".split(" "), "d4 d6 Bf4 Nf6 e3".split(" ")]));
    const different = assess(tree(["d4 d5 Bf4 Nf6 e3".split(" "), "d4 d6 Nf3 Nf6 e3".split(" ")]));
    expect(rawFacet(same, "Ease")).toBe(100);
    expect(rawFacet(different, "Ease")).toBeLessThan(100);
    expect(rawFacet(assess(tree([["e4", "e5", "Nf3"]])), "Ease")).toBeNull();
    expect(rated(same, "Ease")).toBeGreaterThan(rated(different, "Ease"));
    expect(rated(assess(tree([["e4", "e5", "Nf3"]])), "Ease")).toBeNull();
  });

  it("finishes an opening at a stable phase transition and ignores later model-game length", () => {
    const setup = "d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6 Bd3 O-O O-O Nbd7 Nbd2 c5 c3 Qc7 Qe2 b6".split(" ");
    const done = assess(tree([setup]), { horizon: 32 });
    const extended = assess(tree([[...setup, "Rac1", "Bb7"]]), { horizon: 32 });
    expect(done.stopReasons).toContain("opening-complete");
    expect(rawFacet(done, "Depth")).toBe(100);
    expect(values(extended)).toEqual(values(done));
  });

  it("does not improve the total by hiding a newly exposed unanswered opponent move", () => {
    const complete = "e4 e5 Nf3 Nc6 Bc4 Bc5".split(" ");
    const before = assess(tree([complete]), { myColor: "black", horizon: 32 });
    const exposed = assess(tree([[...complete, "d3"]]), { myColor: "black", horizon: 32 });
    expect(rawFacet(exposed, "Replies")).toBeLessThan(rawFacet(before, "Replies"));
    expect(exposed.stopReasons).toContain("missing-reply");
    expect(exposed.score).toBe(before.score);
    expect(rated(exposed, "Replies")).toBe(rated(before, "Replies"));
  });

  it("does not stop at a phase transition while an exchange is still happening", () => {
    const line = "e4 d5 exd5 Qxd5 Nc3 Qe5+ Be2 Bg4 Nf3 Bxf3 gxf3".split(" ");
    const result = assess(tree([line]), { horizon: 32 });
    expect(result.stopReasons).not.toContain("opening-complete");
    expect(rawFacet(result, "Depth")).toBeLessThan(100);
  });

  it("recognizes the same two-action plan played in a different order", () => {
    const nodes = tiedRoots(tree([["d4", "d5", "Nf3"], ["Nf3", "d5", "d4"]]));
    const result = assess(nodes);
    expect(result.counts.identicalPositionPairs).toBeGreaterThan(0);
    expect(rawFacet(result, "Ease")).toBe(100);
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
    expect(rawFacet(assess(nodes), "Consistency")).toBeNull();
    // Same pieces and turn after a reversible king shuffle; e.p. has expired.
    const epFen = "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2";
    const epNodes = tree([["Kf1", "Kf8", "Ke1", "Ke8", "Kd1"]], epFen);
    expect(rawFacet(assess(epNodes), "Consistency")).toBeNull();
  });
});
