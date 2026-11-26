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

// Review of #326: the check read the tree Scout loaded at Start, so a move you added
// since, or one queued earlier in the same batch, went in beside a new one unasked.
describe("Scout add to prep checks your latest tree", () => {
  const D4_D5 = { ucis: ["d2d4", "d7d5"], sans: ["d4", "d5"] };
  const D4_NF6 = { ucis: ["d2d4", "g8f6"], sans: ["d4", "Nf6"] };

  it("asks when the open repertoire gained your move after Scout started", async () => {
    const { deps, build, writer } = setup({ modalAnswers: [{ repertoire: "sicilian" }, null] });
    build.nodes.push(
      { id: "d4", depth: 1, parent_id: "r", uci: "d2d4", fen: "fen-d4" },
      { id: "d5", depth: 2, parent_id: "d4", uci: "d7d5", fen: "fen-d5", is_mainline: true },
    );
    await writer.addToPrep(D4_NF6, "white");
    const [, [ask]] = deps.showInputModal.mock.calls;
    expect(ask.fields[0].label).toBe("This line branches from your 1…d5 (adds 1…Nf6) as an alternative move.");
    expect(deps.queueBuildAdd).not.toHaveBeenCalled();
  });

  it("reads a repertoire that isn't open from the server, not from Scout's start-up copy", async () => {
    const { deps, writer } = setup({ modalAnswers: [{ repertoire: "spare" }, null] });
    deps.api.mockImplementation(async (path) => (path.startsWith("/api/build/load")
      ? { repertoire_id: "spare", nodes: [
        { id: "s", depth: 0, parent_id: null, uci: null },
        { id: "s1", depth: 1, parent_id: "s", uci: "d2d4" },
        { id: "s2", depth: 2, parent_id: "s1", uci: "d7d5", is_mainline: true },
      ] }
      : { repertoires: [{ id: "spare", name: "Spare", color: "black" }, { id: "sicilian", name: "Sicilian", color: "black" }] }));
    await writer.addToPrep(D4_NF6, "white");
    expect(deps.api).toHaveBeenCalledWith("/api/build/load?repertoire_id=spare", expect.anything());
    const [, [ask]] = deps.showInputModal.mock.calls;
    expect(ask.title).toBe("Add as an alternative move?");
    expect(deps.queueBuildAdd).not.toHaveBeenCalled();
  });

  it("writes nothing when the latest tree can't be read", async () => {
    const { deps, writer } = setup({ modalAnswers: [{ repertoire: "spare" }] });
    deps.api.mockImplementation(async (path) => {
      if (path.startsWith("/api/build/load")) throw new Error("offline");
      return { repertoires: [{ id: "spare", name: "Spare", color: "black" }] };
    });
    await writer.addToPrep(D4_NF6, "white");
    expect(deps.queueBuildAdd).not.toHaveBeenCalled();
    expect(deps.editRepertoire).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenLastCalledWith("Couldn't read the repertoire, so nothing was added: offline", { severity: "error" });
  });

  it("counts a move queued earlier in the same batch", async () => {
    let divergenceFields;
    const { deps, writer } = setup({ modalAnswers: [
      { repertoire: "sicilian" },
      (fields) => { divergenceFields = fields; return { divergent: "skip" }; },
    ] });
    await writer.prepareAll([D4_D5, D4_NF6], "white");
    expect(divergenceFields.map((f) => f.label)).toContain("1. d4 Nf6 — branches from your 1…d5 (adds 1…Nf6)");
    expect(deps.queueBuildAdd.mock.calls.map(([node]) => node.uci)).toEqual(["d2d4", "d7d5"]);
    expect(deps.setStatus).toHaveBeenLastCalledWith("Added 1 line to prep · 1 skipped");
  });
});

// Review of #326 (second round): Build can hold a stale copy of the open repertoire
// while another tab added 1.d4 d5. The preview passed on that copy, and the write
// (which reloads the tree) then added 1.d4 Nf6 unasked. The write now checks the tree
// it reloaded, the one it writes to.
describe("Scout add to prep checks the tree it writes to", () => {
  const D4_NF6 = { ucis: ["d2d4", "g8f6"], sans: ["d4", "Nf6"] };
  const reloadAddsD4D5 = (build) => vi.fn(async () => {
    if (!build.nodes.some((n) => n.id === "d4")) {
      build.nodes.push(
        { id: "d4", depth: 1, parent_id: "r", uci: "d2d4", fen: "fen-d4" },
        { id: "d5", depth: 2, parent_id: "d4", uci: "d7d5", fen: "fen-d5", is_mainline: true },
      );
    }
  });

  it("asks again when the reloaded tree branches where the stale copy did not, and writes nothing on cancel", async () => {
    const { deps, build } = setup({ modalAnswers: [{ repertoire: "sicilian" }, null] });
    deps.editRepertoire = reloadAddsD4D5(build);
    await createScoutPrepWriter(deps).addToPrep(D4_NF6, "white");
    const asks = deps.showInputModal.mock.calls.map(([opts]) => opts.title);
    expect(asks).toEqual(["Add line to prep", "Add as an alternative move?"]);
    expect(deps.queueBuildAdd).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenLastCalledWith("Nothing added to prep.");
  });

  it("writes it once you say yes to the second ask", async () => {
    const { deps, build } = setup({ modalAnswers: [{ repertoire: "sicilian" }, {}] });
    deps.editRepertoire = reloadAddsD4D5(build);
    await createScoutPrepWriter(deps).addToPrep(D4_NF6, "white");
    expect(deps.queueBuildAdd.mock.calls.map(([node]) => node.uci)).toEqual(["g8f6"]);
  });

  it("holds back a batch line that branches only in the reloaded tree", async () => {
    const EXTENDING = { ucis: ["e2e4", "c7c5", "g1f3"], sans: ["e4", "c5", "Nf3"] };
    const { deps, build } = setup({ modalAnswers: [{ repertoire: "sicilian" }] });
    deps.editRepertoire = reloadAddsD4D5(build);
    await createScoutPrepWriter(deps).prepareAll([D4_NF6, EXTENDING], "white");
    expect(deps.queueBuildAdd.mock.calls.map(([node]) => node.uci)).toEqual(["g1f3"]);
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      "Added 1 line to prep · 1 held back: your repertoire changed since the check");
  });
});
