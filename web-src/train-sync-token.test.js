import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapTrainUiSession } from "./train-resume.js";

// The smart session's position (card index, requeues) syncs only with the
// state_version token the start payload hands out. The live session object
// dropped it, so /smart/sync never applied the position and a finished queue
// came back from its first card on the next Start.
const source = readFileSync(new URL("./controllers/train-session.js", import.meta.url), "utf8");

describe("smart session sync token", () => {
  it("carries the start payload's state_version into the live session", () => {
    const start = source.slice(source.indexOf("async function startSmartTraining("));
    const literal = start.slice(start.indexOf("appState.smart = {"), start.indexOf("\n  };", start.indexOf("appState.smart = {")));
    expect(literal).toMatch(/stateVersion: mapped\.stateVersion,/);
    const mapped = mapTrainUiSession({ mode: "smart", session_id: "s", session_generation: "g", state_version: 7, cards: [], total_cards: 0 }, {});
    expect(mapped.stateVersion).toBe(7);
  });
});
