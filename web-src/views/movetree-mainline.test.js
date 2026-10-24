// Regression: the move tree follows the repertoire's mainline, not array order.
//
// Build's fork bar and the server both treat the child flagged `is_mainline`
// as the line (and paint it "mainline / active"), but the shared renderer used
// to walk children[0] at every fork. When the payload listed an alternative
// first (3...Na6 before 3...Bf5) the tree rendered Na6 as the main line while
// the fork bar marked Bf5 as the mainline — two answers on one screen.
import { beforeEach, describe, expect, it } from "vitest";
import { createMoveTreeRenderer } from "./shared/movetree.js";

let seq = 0;
function node(id, san, { mainline = false, children = [] } = {}) {
  return { id, san, moveNumber: 1, side: "black", raw: { is_mainline: mainline }, children };
}
const ids = (html) => [...String(html).matchAll(/data-node-id="([^"]+)"/g)].map((m) => m[1]);

describe("move tree mainline order", () => {
  beforeEach(() => { globalThis.document = undefined; });

  it("walks the is_mainline child first when an alternative is listed first", () => {
    const na6 = node("n7", "Na6");
    const bf5 = node("n6", "Bf5", { mainline: true });
    const { renderMoveTree } = createMoveTreeRenderer();
    expect(ids(renderMoveTree({ children: [na6, bf5] }, {}))).toEqual(["n6", "n7"]);
  });

  it("picks the mainline at a deeper fork too, and keeps each branch's own line together", () => {
    // Main line e5 with two answers, d4 (main) and Nf6; the c5 variation with
    // its own continuation. c5 sits first in the payload, d4 second.
    const nf3 = node("c-nf3", "Nf3");
    const c5 = node("c5", "c5", { children: [nf3] });
    const d4 = node("d4", "d4", { mainline: true });
    const nf6 = node("nf6", "Nf6");
    const e5 = node("e5", "e5", { mainline: true, children: [nf6, d4] });
    const { renderMoveTree } = createMoveTreeRenderer();
    // PGN order: e5, then the c5 variation it replaces with its own
    // continuation, then the main answer d4, then its alternative Nf6.
    expect(ids(renderMoveTree({ children: [c5, e5] }, {}))).toEqual(["e5", "c5", "c-nf3", "d4", "nf6"]);
  });

  it("keeps the given order when no child is flagged (Analyze variations)", () => {
    const a = node("a", "Bg4");
    const b = node("b", "Bf5");
    const { renderMoveTree } = createMoveTreeRenderer();
    expect(ids(renderMoveTree({ children: [a, b] }, {}))).toEqual(["a", "b"]);
  });

  it("keeps array order when the flagged child is already first", () => {
    const main = node("n6", "Bf5", { mainline: true });
    const alt = node("n7", "Na6");
    const { renderMoveTree } = createMoveTreeRenderer();
    expect(ids(renderMoveTree({ children: [main, alt] }, {}))).toEqual(["n6", "n7"]);
  });
});
