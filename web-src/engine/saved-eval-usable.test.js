import { describe, it, expect } from "vitest";

import { engineIdentity, savedEvalUsable } from "./stockfish-provider.js";

// A review saved on one Stockfish net keeps its numbers when it is opened on the
// other one (a desktop review read on a phone): both are this app's Stockfish.
describe("savedEvalUsable", () => {
  it("takes a saved eval from either shipped net", () => {
    expect(engineIdentity("big")).not.toBe(engineIdentity("lite"));
    expect(savedEvalUsable(engineIdentity("big"))).toBe(true);
    expect(savedEvalUsable(engineIdentity("lite"))).toBe(true);
  });

  it("refuses an eval from another engine build or with no engine named", () => {
    expect(savedEvalUsable("stockfish-15 t1 h16")).toBe(false);
    expect(savedEvalUsable(`${engineIdentity("big")} extra`)).toBe(false);
    expect(savedEvalUsable(null)).toBe(false);
    expect(savedEvalUsable("")).toBe(false);
  });
});
