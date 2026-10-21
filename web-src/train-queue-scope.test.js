// "New session" means another queue like this one. A queue drilled for one
// repertoire (a Train link, the repertoire's own Train action) used to widen
// to every active repertoire, so the user asked for another queue and got a
// different subject.
import { describe, expect, it } from "vitest";
import { queueRepertoireForStart } from "./train-start.js";

describe("the scope a new queue keeps", () => {
  it("keeps the repertoire of a queue drilled for one repertoire", () => {
    expect(queueRepertoireForStart({
      fresh: true,
      current: { mixed: false, repertoireId: "rep-2" },
    })).toBe("rep-2");
  });

  it("leaves a mixed queue mixed", () => {
    expect(queueRepertoireForStart({
      fresh: true,
      current: { mixed: true, repertoireId: null },
    })).toBeNull();
  });

  it("lets an explicit request win", () => {
    expect(queueRepertoireForStart({
      requested: "rep-9",
      fresh: true,
      current: { mixed: false, repertoireId: "rep-2" },
    })).toBe("rep-9");
  });

  it("does not narrow a plain start", () => {
    expect(queueRepertoireForStart({
      current: { mixed: false, repertoireId: "rep-2" },
    })).toBeNull();
  });
});
