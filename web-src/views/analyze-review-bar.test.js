// The review bar's stepping (web-src/views/analyze-review-bar.js): an arrow goes to
// the neighbouring key moment on the mainline, and never past either end.
import { describe, expect, it, vi } from "vitest";

import { createReviewBar } from "./analyze-review-bar.js";

const moment = (ply) => ({ ply, label: `${ply}`, grade: "blunder", move: {}, departure: false });
const REPORT = { moments: [moment(4), moment(8), moment(12)], graded: true };

function barAt(ply) {
  const appState = { analysisPly: ply };
  const showAnalysisPly = vi.fn();
  const bar = createReviewBar({ appState, showAnalysisPly });
  bar.set(REPORT);
  return { bar, showAnalysisPly, appState };
}

describe("review bar stepping", () => {
  it("steps to the next and the previous moment from between two of them", () => {
    const { bar, showAnalysisPly } = barAt(6);
    bar.step("next");
    expect(showAnalysisPly).toHaveBeenLastCalledWith(8);
    bar.step("prev");
    expect(showAnalysisPly).toHaveBeenLastCalledWith(4);
  });

  it("steps off a moment to its neighbour, not to itself", () => {
    const { bar, showAnalysisPly } = barAt(8);
    bar.step("next");
    expect(showAnalysisPly).toHaveBeenLastCalledWith(12);
    bar.step("prev");
    expect(showAnalysisPly).toHaveBeenLastCalledWith(4);
  });

  it("does nothing past either end, and before the first moment", () => {
    const start = barAt(0);
    start.bar.step("prev");
    expect(start.showAnalysisPly).not.toHaveBeenCalled();
    const end = barAt(12);
    end.bar.step("next");
    expect(end.showAnalysisPly).not.toHaveBeenCalled();
  });

  it("has nothing to step through with no moments", () => {
    const showAnalysisPly = vi.fn();
    const bar = createReviewBar({ appState: { analysisPly: 3 }, showAnalysisPly });
    bar.set({ moments: [], graded: true });
    bar.step("next");
    expect(showAnalysisPly).not.toHaveBeenCalled();
  });
});
