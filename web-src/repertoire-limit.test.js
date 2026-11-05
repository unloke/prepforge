import { describe, expect, it } from "vitest";
import { repertoireLimitMessage } from "./repertoire-limit.js";

const state = (limit, ids, pending = []) => ({
  account: { repertoireLimit: limit },
  repertoireList: ids.map((id) => ({ id })),
  pendingRepDeletes: new Set(pending),
});

describe("repertoireLimitMessage", () => {
  it("stops a create at the cap, before anything opens", () => {
    expect(repertoireLimitMessage(state(5, [1, 2, 3, 4, 5]))).toBe("You can keep up to 5 repertoires. Delete one to add another.");
  });
  it("lets it through below the cap, counting a pending delete as gone", () => {
    expect(repertoireLimitMessage(state(5, [1, 2, 3, 4]))).toBeNull();
    expect(repertoireLimitMessage(state(5, [1, 2, 3, 4, 5], ["5"]))).toBeNull();
  });
  it("has no cap without a limit", () => {
    expect(repertoireLimitMessage(state(null, [1, 2, 3, 4, 5, 6]))).toBeNull();
  });
});
