// The Train panel's controls must go dead when a click on them would throw away
// the session the player is in. Both states live in one source-space extraction,
// the way the other train-session regression tests run the real functions.
import { describe, expect, it, vi } from "vitest";
import { appSource } from "./test-app-source.js";
import { trainStartBlockReason } from "./train-start.js";

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
const LIVE = body("function trainSessionLive()");
const CONTROLS = body("function syncTrainSessionControls()");

function runTrainControls(appState) {
  const lucky = { disabled: false, title: "" };
  const start = { disabled: false, title: "" };
  const doc = {
    getElementById: (id) => (id === "feeling-lucky" ? lucky : id === "start-train" ? start : null),
    querySelector: () => null,
  };
  const deps = {
    appState, document: doc, syncViewHeads: vi.fn(), blitzEnabled: () => false,
    trainStartBlockReason,
  };
  const build = new Function(
    "trainStartBlockReason", "appState", "document",
    "syncViewHeads", "blitzEnabled", "nextSession",
    `${PREVIEW}\n${ACTIVE}\n${PAINT}\n${LIVE}\n${CONTROLS}\npreviewCache.nextSession = nextSession;\nreturn { syncTrainSessionControls, paintTrainStartDisabled };`,
  );
  const controls = build(trainStartBlockReason, appState, doc, deps.syncViewHeads, deps.blitzEnabled, appState.nextSession ?? null);
  controls.syncTrainSessionControls();
  controls.paintTrainStartDisabled();
  return { lucky, start };
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
    expect(state({ ...base, trainMode: "all_lines" }).disabled).toBe(false);
    expect(state({ ...base, trainMode: "play" }).disabled).toBe(false);
    expect(state({ ...base, signedIn: false }).disabled).toBe(false);
  });
});
