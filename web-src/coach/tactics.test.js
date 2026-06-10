import { describe, it, expect } from "vitest";

import { detectTactics, describeThreat, describeAnyThreat } from "./tactics.js";

describe("tactics — forks", () => {
  it("sees a knight forking the king and a rook", () => {
    // Black king e8, rook a8; White knight just landed on c7 (Nc7+).
    const m = describeThreat("r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1", "e6c7", "w");
    expect(m).toEqual({ kind: "fork", targets: "the king and the rook" });
  });

  it("collapses a double-rook fork to 'both rooks'", () => {
    // White knight e6 hits rooks on d8 and f8.
    const m = describeThreat("3r1rk1/8/4N3/8/8/8/6K1/8 w - - 0 1", "d4e6", "w");
    expect(m).toEqual({ kind: "fork", targets: "both rooks" });
  });

  it("does not invent a fork from a king's attacks", () => {
    const { forks } = detectTactics("4k3/8/8/8/8/8/3rr3/4K3 w - - 0 1", "w");
    expect(forks).toHaveLength(0);
  });
});

describe("tactics — pins and skewers", () => {
  it("calls an absolute pin a pin to the king", () => {
    // Bishop g5, knight f6, king d8 behind on the long diagonal.
    const m = describeThreat("3k4/8/5n2/6B1/8/8/8/4K3 b - - 0 1", "h4g5", "w");
    expect(m).toEqual({ kind: "pin", front: "knight", back: "king", absolute: true });
  });

  it("calls a relative pin a pin to the bigger piece", () => {
    const m = describeThreat("3q2k1/8/5n2/6B1/8/8/8/4K3 b - - 0 1", "h4g5", "w");
    expect(m).toEqual({ kind: "pin", front: "knight", back: "queen", absolute: false });
  });

  it("sees a rook skewer the queen, winning the rook behind it", () => {
    const m = describeThreat("4r1k1/8/8/4q3/8/8/8/4R1K1 b - - 0 1", "e2e1", "w");
    expect(m).toEqual({ kind: "skewer", front: "queen", back: "rook" });
  });
});

describe("tactics — quiet positions", () => {
  it("reports nothing when there is nothing", () => {
    expect(describeThreat("6k1/8/8/8/8/8/8/4K3 w - - 0 1", "e1e2", "w")).toBeNull();
    expect(describeAnyThreat("6k1/8/8/8/8/8/8/4K3 w - - 0 1", "w")).toBeNull();
  });
});
