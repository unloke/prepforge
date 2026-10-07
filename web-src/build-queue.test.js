import { describe, expect, it } from "vitest";

import { orderPendingBuildAdds } from "./sync-queue.js";

// R-05: per-op isolation replays the batch one move at a time. A move whose
// parent is another move from the same batch can only be sent AFTER that
// parent (its real id comes back from the parent's response), so the order has
// to be parent-before-child no matter how the queue was assembled.

describe("orderPendingBuildAdds", () => {
  it("keeps a queue that is already in order untouched", () => {
    const entries = [
      { tempId: "tmp-1", parentRef: "root" },
      { tempId: "tmp-2", parentRef: "tmp-1" },
    ];
    expect(orderPendingBuildAdds(entries)).toEqual(entries);
  });

  it("pulls a child ahead of an unrelated sibling that precedes its parent", () => {
    const entries = [
      { tempId: "tmp-2", parentRef: "tmp-1" }, // child first (a requeued batch)
      { tempId: "tmp-1", parentRef: "root" },
    ];
    expect(orderPendingBuildAdds(entries).map((e) => e.tempId)).toEqual(["tmp-1", "tmp-2"]);
  });

  it("orders a whole chain, keeping relative order within a pass", () => {
    const entries = [
      { tempId: "c", parentRef: "b" },
      { tempId: "x", parentRef: "root" },
      { tempId: "b", parentRef: "a" },
      { tempId: "a", parentRef: "root" },
    ];
    expect(orderPendingBuildAdds(entries).map((e) => e.tempId)).toEqual([
      "x",
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps an unresolvable cycle instead of dropping it", () => {
    const entries = [
      { tempId: "a", parentRef: "b" },
      { tempId: "b", parentRef: "a" },
    ];
    expect(orderPendingBuildAdds(entries).map((e) => e.tempId)).toEqual(["a", "b"]);
  });

  it("does not mutate its input and tolerates junk", () => {
    const entries = [{ tempId: "b", parentRef: "a" }, { tempId: "a", parentRef: "root" }];
    const snapshot = JSON.stringify(entries);
    orderPendingBuildAdds(entries);
    expect(JSON.stringify(entries)).toBe(snapshot);
    expect(orderPendingBuildAdds(null)).toEqual([]);
  });
});