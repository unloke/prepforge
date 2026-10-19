// The Train panel's controls must go dead when a click on them would throw away
// the session the player is in. Both states live in one source-space extraction,
// the way the other train-session regression tests run the real functions.
import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { rehearsalStartBlockReason, trainStartBlockReason, trainStartDisabled } from "./train-start.js";

const source = appSource();
function body(marker) {
  const start = source.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

const PREVIEW = body("const trainPreviewCache = {")
  .replace("const trainPreviewCache = {", "const previewCache = {")
  .replace(/trainPreviewCache/g, "previewCache")
  .replace("nextSession: null", "nextSession /* bound by the harness */");
const ACTIVE = body("function activeTrainRepertoires()");
const PAINT = body("function paintTrainStartDisabled()").replace(/trainPreviewCache/g, "previewCache");
const SELECTED = body("function selectedTrainRepertoire()");
const CONTROLS = body("function syncTrainSessionControls()");

function runTrainControls(appState) {
  const lucky = { disabled: false, title: "" };
  const start = { disabled: false, title: "" };
  const summary = { hidden: appState.__summaryHidden !== false };
  const modeTabs = ["smart", "all_lines", "play"].map((mode) => {
    const tab = { disabled: false, title: mode === "play" ? "Play a game" : "", dataset: { mode } };
    return tab;
  });
  // Hint/Skip: the board bar's pair, disabled exactly when no session of the
  // current mode is live.
  const hint = { disabled: false, title: "" };
  const skip = { disabled: false, title: "" };
  const modeName = { textContent: "" };
  const doc = {
    getElementById: (id) => (id === "feeling-lucky" ? lucky
      : id === "start-train" ? start
      : id === "train-summary" ? summary
      : id === "train-hint" ? hint
      : id === "train-skip" ? skip
      : id === "train-mode-name" ? modeName
      : null),
    querySelector: (sel) => (sel === "#train-modes .train-mode.is-active"
      ? { textContent: { smart: "Smart queue", all_lines: "Line rehearsal", play: "Practice game" }[appState.trainMode] }
      : null),
    querySelectorAll: (sel) => (sel === "#train-modes .train-mode" ? modeTabs : []),
  };
  const deps = {
    appState, document: doc, syncViewHeads: vi.fn(), blitzEnabled: () => false,
    trainStartBlockReason,
  };
  const build = new Function(
    "trainStartBlockReason", "rehearsalStartBlockReason", "trainStartDisabled", "selectedTrainRepertoireId",
    "appState", "document", "syncViewHeads", "blitzEnabled", "nextSession",
    `${PREVIEW}\n${ACTIVE}\n${SELECTED}\n${PAINT}\n${CONTROLS}\npreviewCache.nextSession = nextSession;\nreturn { syncTrainSessionControls, paintTrainStartDisabled };`,
  );
  const controls = build(trainStartBlockReason, rehearsalStartBlockReason, trainStartDisabled, () => appState.selectedRepertoireId ?? null, appState, doc, deps.syncViewHeads, deps.blitzEnabled, appState.nextSession ?? null);
  controls.syncTrainSessionControls();
  controls.paintTrainStartDisabled();
  return { lucky, start, modeTabs, hint, skip, modeName };
}

describe("syncTrainSessionControls", () => {
  it("disables Lucky mid-game and says why", () => {
    const { lucky } = runTrainControls({
      trainMode: "play",
      signedIn: true,
      repertoireList: [],
      pendingRepDeletes: new Set(),
      play: { active: true, history: [{ uci: "e2e4" }] },
    });
    expect(lucky.disabled).toBe(true);
    expect(lucky.title).toMatch(/resign/i);
  });

  it("keeps Lucky live outside a game with its original tooltip", () => {
    const { lucky } = runTrainControls({
      trainMode: "play",
      signedIn: true,
      repertoireList: [],
      pendingRepDeletes: new Set(),
      play: { active: false, history: [] },
    });
    expect(lucky.disabled).toBe(false);
    expect(lucky.title).toBe("Jump to a key position instead of move 1");
  });

  it("names the running session's mode in the card head", () => {
    const { modeName } = runTrainControls({
      trainMode: "all_lines",
      signedIn: true,
      repertoireList: [],
      pendingRepDeletes: new Set(),
      smart: null,
      training: { prompt: { card_index: 0 } },
      nextSession: { cards: 4, resumed: 0 },
    });
    expect(modeName.textContent).toBe("Line rehearsal");
  });
});

describe("Hint / Skip live state", () => {
  const base = { signedIn: true, repertoireList: [], pendingRepDeletes: new Set() };

  it("goes live for the smart queue's first card even with an open practice game", () => {
    // The play session used to count as "live" for every mode, so the queue's
    // first card started with Hint and Skip disabled.
    const { hint, skip } = runTrainControls({
      ...base,
      trainMode: "smart",
      play: { active: true, history: [{ uci: "e2e4" }] },
      smart: { prompt: { card_index: 0 }, queue: [], cardIndex: 0, cardKinds: {} },
      training: null,
      nextSession: { cards: 4, resumed: 0 },
    });
    expect(hint.disabled).toBe(false);
    expect(skip.disabled).toBe(false);
  });

  it("stays dead before a smart session starts, whatever the play state", () => {
    const { hint, skip } = runTrainControls({
      ...base,
      trainMode: "smart",
      play: { active: true, history: [] },
      smart: null,
      training: null,
      nextSession: { cards: 4, resumed: 0 },
    });
    expect(hint.disabled).toBe(true);
    expect(skip.disabled).toBe(true);
  });
});

describe("paintTrainStartDisabled", () => {
  const state = (appState) => runTrainControls(appState).start;

  it("disables Start when the smart queue has nothing due", () => {
    const start = state({
      trainMode: "smart",
      signedIn: true,
      repertoireList: [{ id: "r1", is_active: true }],
      pendingRepDeletes: new Set(),
      nextSession: { cards: 0, resumed: 0 },
    });
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Nothing due. Add lines in Repertoire.");
  });

  it("names the missing repertoire when none is active", () => {
    const start = state({
      trainMode: "smart",
      signedIn: true,
      repertoireList: [],
      pendingRepDeletes: new Set(),
      nextSession: { cards: 0, resumed: 0 },
    });
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("No active repertoire. Create one in Library.");
  });

  it("keeps Start live for a queue with cards, and clears the tooltip", () => {
    const start = state({
      trainMode: "smart",
      signedIn: true,
      repertoireList: [{ id: "r1", is_active: true }],
      pendingRepDeletes: new Set(),
      nextSession: { cards: 7, resumed: 0 },
    });
    expect(start.disabled).toBe(false);
    expect(start.title).toBe("");
  });

  it("leaves Start to Line rehearsal / play modes and guests alone", () => {
    const base = {
      signedIn: true,
      repertoireList: [{ id: "r1", is_active: true }],
      pendingRepDeletes: new Set(),
      nextSession: { cards: 0, resumed: 0 },
    };
    expect(state({ ...base, trainMode: "all_lines", selectedRepertoireId: "r1" }).disabled).toBe(false);
    expect(state({ ...base, trainMode: "all_lines" }).disabled).toBe(true); // waits on the picker
    expect(state({ ...base, trainMode: "play" }).disabled).toBe(false);
    expect(state({ ...base, signedIn: false }).disabled).toBe(false);
  });

  it("disables Line rehearsal's Start when the picked repertoire has no moves to walk", () => {
    const base = {
      trainMode: "all_lines",
      signedIn: true,
      pendingRepDeletes: new Set(),
      selectedRepertoireId: "r1",
    };
    const empty = state({ ...base, repertoireList: [{ id: "r1", is_active: true, health: { trainable: 0 } }] });
    expect(empty.disabled).toBe(true);
    expect(empty.title).toBe("No moves to train. Add lines in Repertoire.");
    const ready = state({ ...base, repertoireList: [{ id: "r1", is_active: true, health: { trainable: 6 } }] });
    expect(ready.disabled).toBe(false);
    expect(ready.title).toBe("");
  });
});
