import { describe, expect, it } from "vitest";
import { selectSmokeShard } from "./sharding.mjs";

describe("smoke shards", () => {
  const suite = Array.from({ length: 17 }, (_, i) => `smoke-${i}`);
  it("partitions every smoke exactly once, including the remainder", () => {
    const shards = [1, 2, 3, 4].map((i) => selectSmokeShard(suite, `${i}/4`));
    expect(shards.map((s) => s.length)).toEqual([5, 4, 4, 4]);
    expect(shards.flat().sort()).toEqual([...suite].sort());
    expect(selectSmokeShard(suite, undefined)).toEqual(suite);
  });
  it.each(["", "0/4", "5/4", "1/0", "1/18", "1.5/4", "1/4junk"])("rejects invalid configuration %s", (shard) => {
    expect(() => selectSmokeShard(suite, shard)).toThrow();
  });
});
