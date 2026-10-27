// The engine pane's saved line: the run's eval, line and depth for the shown
// position, as move links; nothing when the run saved no line there.
import { describe, expect, it } from "vitest";
import { savedLineHtml } from "./analyze-saved-line.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("savedLineHtml", () => {
  it("writes the eval, the numbered line as move links and the depth", () => {
    const out = String(savedLineHtml({ [START]: { score_cp: 39, depth: 12, pv: ["e2e4", "c7c5", "g1f3"] } }, START));
    expect(out).toMatch(/^<b class="sl-eval">\+0\.39<\/b>/);
    expect(out).toContain(">e4<");
    expect(out).toContain(">c5<");
    expect(out).toContain(">Nf3<");
    expect(out).toMatch(/<span class="sl-depth" title="Search depth">d12<\/span>$/);
  });

  it("is empty with no saved line, and stops a line at an illegal step", () => {
    expect(String(savedLineHtml({}, START))).toBe("");
    expect(String(savedLineHtml({ [START]: { score_cp: 0, depth: 0, pv: [] } }, START))).toBe("");
    const cut = String(savedLineHtml({ [START]: { score_cp: 10, depth: 8, pv: ["e2e4", "e2e4"] } }, START));
    expect(cut).toContain(">e4<");
    expect(cut.match(/data-p=/g)).toHaveLength(1);
  });
});
