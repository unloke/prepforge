import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { atlasClarity } from "./atlas-quality.js";

function tree(lines) {
  const nodes = [{ id: "root", parent_id: null, fen: new Chess().fen(), is_enabled: true }];
  for (const line of lines) {
    const chess = new Chess();
    let parent = nodes[0];
    for (const san of line) {
      const move = chess.move(san), uci = move.from + move.to + (move.promotion || "");
      let child = nodes.find((n) => n.parent_id === parent.id && n.uci === uci);
      if (!child) {
        child = { id: `n${nodes.length}`, parent_id: parent.id, fen: chess.fen(), uci,
          is_prepared: true, is_mainline: !nodes.some((n) => n.parent_id === parent.id) };
        nodes.push(child);
      }
      parent = child;
    }
  }
  return nodes;
}
const assess = (nodes, extra = {}) => atlasClarity({ nodes, myColor: "white", ...extra });
const facet = (r, key) => r.facets.find((f) => f.key === key);

describe("Atlas documentation clarity", () => {
  it("averages applicable ratios equally and leaves absent forks null", () => {
    const nodes = tree([["e4", "e5", "Nf3"]]);
    nodes[1].comment = "Control the centre";
    nodes[3].typical_plan = "Develop and castle";
    const r = assess(nodes);
    expect(r.score).toBeCloseTo(200 / 3);
    expect(facet(r, "decisionNotes")).toMatchObject({ numerator: 2, denominator: 2, value: 100 });
    expect(facet(r, "forkSignposts").value).toBeNull();
    expect(r.algorithmVersion).toBe("documentation-clarity-v1");
  });
  it("does not turn an empty tree or root note into a score", () => {
    expect(assess([]).score).toBeNull();
    const r = assess(tree([]), { notes: "Overview" });
    expect(r.score).toBeNull();
    expect(facet(r, "startingNotes").value).toBe(100);
    expect(facet(r, "decisionNotes").value).toBeNull();
  });
  it.each(["[%cal Ge2e4] [%csl Ge4]", "https://lichess.org/study/abc", "1. e4 e5 2. Nf3 Nc6 $1 !? +0.34", "[%eval 0.4]", "<b></b> **123**", "&nbsp; &#160;", "1-0 0-1 1/2-1/2", "e2e4 g8f6"])("excludes notation/directive-only note %s", (comment) => {
    const nodes = tree([["e4"]]);
    nodes.forEach((n) => { n.comment = comment; });
    expect(assess(nodes).score).toBe(0);
  });
  it.each(["控制中心，然後易位", "White resigns", "Don't do this!", "Развивайте фигуры", "<b>Plan</b> [%eval 0.3]", "**Plan:** e4 then castle"])("counts language-independent local letters: %s", (comment) => {
    const nodes = tree([["e4"]]);
    nodes.forEach((n) => { n.comment = comment; });
    expect(assess(nodes).score).toBe(100);
  });
  it("requires every fork alternative signposted; a parent note is insufficient", () => {
    const nodes = tree([["e4"], ["d4"]]);
    nodes[0].comment = "Choose a system";
    nodes[1].comment = "Open game";
    nodes[2].tags = ["source:import", "auto", "engine:stockfish"];
    expect(facet(assess(nodes), "forkSignposts").value).toBe(0);
    nodes[2].tags.push("Queen pawn system");
    expect(facet(assess(nodes), "forkSignposts").value).toBe(100);
    expect(facet(assess(nodes), "endpointNotes").value).toBe(50);
  });
  it("uses the deterministic selected child for a decision and respects FEN parity", () => {
    const nodes = tree([["e4"], ["d4"]]);
    nodes[2].comment = "Alternative explanation";
    expect(facet(assess(nodes), "decisionNotes").value).toBe(0);
    nodes[1].is_prepared = false;
    expect(facet(assess(nodes), "decisionNotes").value).toBe(100);
    expect(facet(assess(nodes, { myColor: "black" }), "decisionNotes").value).toBeNull();
    nodes[2].is_prepared = false;
    expect(facet(assess(nodes), "decisionNotes").value).toBe(0);
    nodes[1].is_mainline = false;
    nodes[2].is_mainline = true;
    expect(facet(assess(nodes), "decisionNotes").value).toBe(100);
    delete nodes[1].is_prepared;
    delete nodes[2].is_prepared;
    expect(facet(assess(nodes), "decisionNotes").value).toBe(100);
    nodes[2].is_mainline = false;
    nodes[1].comment = "First child context";
    expect(facet(assess(nodes), "decisionNotes").value).toBe(100);
  });
  it("prunes disabled ancestors and scopes starting notes locally", () => {
    const nodes = tree([["e4", "e5"], ["d4", "d5"]]);
    nodes[1].is_enabled = false;
    expect(assess(nodes).counts.occurrences).toBe(3);
    expect(() => assess(nodes, { rootNodeId: nodes[2].id })).toThrow("disabled ancestor");
    nodes[0].comment = "Global root";
    const r = assess(nodes, { rootNodeId: nodes[3].id });
    expect(r.counts.occurrences).toBe(2);
    expect(facet(r, "startingNotes").value).toBe(0);
    expect(facet(assess(nodes, { rootNodeId: nodes[3].id, notes: "Scoped overview" }), "startingNotes").value).toBe(100);
  });
  it("deduplicates counter variants and does not inflate a ratio with copies", () => {
    const nodes = tree([["e4"], ["d4"]]);
    nodes[1].comment = "Develop";
    const before = assess(nodes);
    nodes.push({ ...nodes[1], id: "copy", fen: nodes[1].fen.replace(/ 0 1$/, " 19 42") });
    const after = assess(nodes);
    expect(after.facets).toEqual(before.facets);
    nodes[nodes.length - 1].comment = "";
    expect(facet(assess(nodes), "endpointNotes").value).toBe(0);
  });
  it("does not invent a fork from duplicate move copies", () => {
    const nodes = tree([["e4"]]);
    const before = assess(nodes);
    nodes.push({ ...nodes[1], id: "copy", comment: "" });
    expect(assess(nodes).facets).toEqual(before.facets);
    expect(assess(nodes).score).toBe(before.score);
  });
  it("deduplicates real transpositions conservatively per metric", () => {
    const nodes = tree([["Nf3", "Nf6", "g3", "g6"], ["g3", "g6", "Nf3", "Nf6"]]);
    nodes.forEach((n) => { n.comment = "Plan"; });
    const r = assess(nodes);
    expect(facet(r, "endpointNotes").denominator).toBe(1);
    expect(r.counts.positions).toBeLessThan(r.counts.occurrences);
    nodes[8].comment = "";
    expect(facet(assess(nodes), "endpointNotes").value).toBe(0);
  });
  it("accepts structured notes, ignores engine evidence and has JSON-stable results", () => {
    const nodes = tree([["f3", "e5", "g4", "Qh4#"]]);
    nodes.forEach((n) => { n.tactical_warning = "Illustrated mistake, not a recommendation"; n.engine_evaluation = -10000; });
    const r = assess(nodes);
    expect(r.score).toBe(100);
    expect(assess(JSON.parse(JSON.stringify(nodes)))).toEqual(r);
  });
});
