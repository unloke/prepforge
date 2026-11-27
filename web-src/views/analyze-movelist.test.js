import { describe, expect, it } from "vitest";

import { moveDecoration } from "./analyze-variation-grade.js";

describe("Analyze move list signs", () => {
  // A check after every sound move buried the marks that matter in a long game.
  it("signs only the moves that stand out, not every sound one", () => {
    expect(moveDecoration({ classification: "best", side: "white" }).suffix).toBeFalsy();
    expect(moveDecoration({ classification: "good", side: "white" }).suffix).toBeFalsy();
    expect(moveDecoration({ classification: "forced", side: "white" }).suffix).toBeFalsy();
    expect(String(moveDecoration({ classification: "mistake", side: "white" }).suffix)).toContain("?");
    expect(String(moveDecoration({ classification: "brilliant", side: "white" }).suffix)).toContain("!!");
  });

  it("uses one effective grade decoration for mainline and branches", () => {
    const mainline = moveDecoration({ classification: "mistake", side: "black", isVariation: false });
    const branch = moveDecoration({ classification: "mistake", side: "black", isVariation: true });
    expect(String(mainline.suffix)).toBe(String(branch.suffix));
    expect(mainline.label).toBe("Mistake");
    expect(branch.label).toBe("variation, Mistake");
    expect(branch.classes).toContain("is-variation");
    expect(branch.classes).toContain("is-black");
  });
});
