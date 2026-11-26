import { describe, expect, it, vi } from "vitest";

import { repertoireChildLookup, lineCoverage } from "../scout.js";
import { createScoutPrepWriter } from "./scout-prep-writer.js";

// Black repertoire "Sicilian": 1.e4 c5. A second, empty Black repertoire "Spare".
function setup({ modalAnswers = [] } = {}) {
  const build = {
    repertoire_id: "sicilian",
    nodes: [
      { id: "r", depth: 0, parent_id: null, uci: null, fen: "start" },
      { id: "a", depth: 1, parent_id: "r", uci: "e2e4", fen: "fen-e4" },
      { id: "b", depth: 2, parent_id: "a", uci: "c7c5", fen: "fen-c5", is_mainline: true },
    ],
  };
  const reps = [{ id: "spare", name: "Spare", color: "black" }, { id: "sicilian", name: "Sicilian", color: "black" }];
  const scoutState = {
    username: "rival",
    lookups: { black: [
      { rep: reps[0], lookup: repertoireChildLookup([{ id: "s", depth: 0 }]) },
      { rep: reps[1], lookup: repertoireChildLookup(build.nodes) },
    ], white: [] },
  };
  const answers = [...modalAnswers];
  const deps = {
    api: vi.fn(async () => ({ repertoires: reps })),
    setStatus: vi.fn(),
    switchView: vi.fn(),
    showInputModal: vi.fn(async ({ fields }) => {
      const next = answers.shift();
      return typeof next === "function" ? next(fields) : next;
    }),
    createRepertoirePrompt: vi.fn(),
    editRepertoire: vi.fn(async () => {}),
    boardAfterMove: vi.fn(async (fen, uci) => `${fen}:${uci}`),
    buildProvisionalNode: vi.fn((parent, uci, after) => ({ id: `tmp-${uci}`, parent_id: parent.id, uci, fen: after })),
    hardFlushBuild: vi.fn(async () => {}),
    selectBuildNode: vi.fn(async () => {}),
    resolveBuildId: (id) => id,
    setBuildSync: vi.fn(),
    notices: { isBusy: () => false, startJob: vi.fn(), updateJob: vi.fn(), completeJob: vi.fn() },
    getBuildState: () => build,
    getBuildNodeById: (id) => build.nodes.find((n) => n.id === id) || null,
    queueBuildAdd: vi.fn((node) => build.nodes.push(node)),
    loadScoutModule: async () => ({ repertoireChildLookup, lineCoverage }),
    getScoutState: () => scoutState,
  };
  return { deps, build, writer: createScoutPrepWriter(deps) };
}

const BRANCHING = { ucis: ["e2e4", "e7e5", "g1f3"], sans: ["e4", "e5", "Nf3"] };
const EXTENDING = { ucis: ["e2e4", "c7c5", "g1f3"], sans: ["e4", "c5", "Nf3"] };

describe("Scout add to prep at your own move", () => {
  it("defaults to the repertoire that covers the lines and skips a branching line by default", async () => {
    let pickerDefault;
    let divergenceFields;
    const { deps, writer } = setup({ modalAnswers: [
      (fields) => { pickerDefault = fields[0].default; return { repertoire: fields[0].default }; },
      (fields) => { divergenceFields = fields; return { divergent: "skip" }; },
    ] });
    await writer.prepareAll([BRANCHING, EXTENDING], "white");
    expect(pickerDefault).toBe("sicilian");
    expect(divergenceFields.map((f) => f.label)).toContain("1. e4 e5 2. Nf3 — branches from your 1…c5 (adds 1…e5)");
    expect(deps.queueBuildAdd.mock.calls.map(([node]) => node.uci)).toEqual(["g1f3"]);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Added 1 line to prep · 1 skipped");
  });

  it("adds it as an alternative when chosen", async () => {
    const { deps, writer } = setup({ modalAnswers: [{ repertoire: "sicilian" }, { divergent: "add" }] });
    await writer.prepareAll([BRANCHING, EXTENDING], "white");
    expect(deps.queueBuildAdd.mock.calls.map(([node]) => node.uci)).toEqual(["e7e5", "g1f3", "g1f3"]);
  });

  it("asks before a single line adds a second move of yours, and writes nothing on cancel", async () => {
    const { deps, writer } = setup({ modalAnswers: [{ repertoire: "sicilian" }, null] });
    await writer.addToPrep(BRANCHING, "white");
    const [, [ask]] = deps.showInputModal.mock.calls;
    expect(ask.title).toBe("Add as an alternative move?");
    expect(ask.fields[0].label).toBe("This line branches from your 1…c5 (adds 1…e5) as an alternative move.");
    expect(deps.queueBuildAdd).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenLastCalledWith("Nothing added to prep.");
  });

  it("writes a line that only extends your prep without asking", async () => {
    const { deps, writer } = setup({ modalAnswers: [{ repertoire: "sicilian" }] });
    await writer.addToPrep(EXTENDING, "white");
    expect(deps.showInputModal).toHaveBeenCalledTimes(1);
    expect(deps.queueBuildAdd.mock.calls.map(([node]) => node.uci)).toEqual(["g1f3"]);
  });
});
