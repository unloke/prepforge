// Regression: the move tree follows the repertoire's mainline, not array order.
//
// Build's fork bar and the server both treat the child flagged `is_mainline`
// as the line (and paint it "mainline / active"), but the shared renderer used
// to walk children[0] at every fork. When the payload listed an alternative
// first (3...Na6 before 3...Bf5) the tree rendered Na6 as the main line while
// the fork bar marked Bf5 as the mainline — two answers on one screen. The
// first fix only reordered the root; a deeper fork still walked the first
// sibling and rendered one branch's continuation inside another branch.
import { beforeEach, describe, expect, it } from "vitest";
import { createMoveTreeRenderer } from "./shared/movetree.js";

let seq = 0;
function node(san, { mainline = false, children = [] } = {}) {
  return { id: `n${++seq}`, san, moveNumber: 1, side: "black", raw: { is_mainline: mainline }, children };
}
const ids = (html) => [...String(html).matchAll(/data-node-id="([^"]+)"/g)].map((m) => m[1]);

describe("move tree mainline order", () => {
  beforeEach(() => { globalThis.document = undefined; });

  it("walks the is_mainline child first when an alternative is listed first", () => {
    const na6 = node("Na6");
    const bf5 = node("Bf5", { mainline: true });
    const { renderMoveTree } = createMoveTreeRenderer();
    expect(ids(renderMoveTree({ children: [na6, bf5] }, {}))).toEqual([bf5.id, na6.id]);
  });

  it("picks the mainline at a deeper fork too, and keeps each branch's own line together", () => {
    // Main line: e5, and next to it the variation c5. e5 has two answers;
    // d4 is the main one. c5 continues with Nf3.
    const nf3 = node("Nf3");
    const c5 = node("c5", { children: [nf3] });
    const d4 = node("d4", { mainline: true });
    const nf6 = node("Nf6");
    const e5 = node("e5", { mainline: true, children: [nf6, d4] });
    const { renderMoveTree } = createMoveTreeRenderer();
    // e5, its main answer d4 and the alternative Nf6, then the c5 variation.
    expect(ids(renderMoveTree({ children: [c5, e5] }, {}))).toEqual([e5.id, d4.id, nf6.id, c5.id, nf3.id]);
  });

  it("keeps the given order when no child is flagged (Analyze variations)", () => {
    const a = node("Bg4");
    const b = node("Bf5");
    const { renderMoveTree } = createMoveTreeRenderer();
    expect(ids(renderMoveTree({ children: [a, b] }, {}))).toEqual([a.id, b.id]);
  });

  it("keeps array order when the flagged child is already first", () => {
    const main = node("Bf5", { mainline: true });
    const alt = node("Na6");
    const { renderMoveTree } = createMoveTreeRenderer();
    expect(ids(renderMoveTree({ children: [main, alt] }, {}))).toEqual([main.id, alt.id]);
  });
});
