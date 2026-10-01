import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrainView } from "./train.js";

// Characterization for the ui-prototype-v2 "Up next" preview on Train:
//  - the rows come from the live smart queue only (appState.smart.queue);
//  - each row carries the card's real kind chip and repertoire (with color dot);
//  - hidden when there is no session, no queue, or the card is the last one.

function makeHost() {
  return { hidden: true, innerHTML: "" };
}

function makeElements() {
  return {
    "train-upnext": makeHost(),
    "train-line-label": { textContent: "" },
    "train-progress-fill": { style: {} },
    "train-card-dots": { innerHTML: "" },
  };
}

function makeView(appState, elements) {
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return createTrainView({
    appState,
    boards: {},
    escapeHtml: (s) => String(s),
    renderSyncChip: () => {},
    setTrainBanner: () => {},
    updateTrainTurnBadge: () => {},
    smartKindLabels: { weak: "Weak spot", due: "Due review", new: "New move", polish: "Polish" },
    smartKindTitles: {},
    onStreakRendered: () => {},
  });
}

function card(kind, rep, color, san) {
  return {
    kind,
    repertoire_name: rep,
    color,
    targets: [{ san }],
  };
}

describe("train up-next preview", () => {
  it("updates the accessible progress value as cards advance", () => {
    const els = makeElements();
    const values = {};
    els["train-progress"] = { setAttribute: (name, value) => { values[name] = value; } };
    const view = makeView({ smart: null }, els);
    view.renderSmartProgress({ total_cards: 6, card_index: 2, kind: "due", targets_total: 1 });
    expect(values).toMatchObject({ "aria-valuemin": "0", "aria-valuemax": "6", "aria-valuenow": "2" });
    view.renderSmartProgress({ total_cards: 6, card_index: 6, kind: "due", targets_total: 1 });
    expect(values["aria-valuenow"]).toBe("6");
  });
  let elements;
  beforeEach(() => {
    elements = makeElements();
  });
  afterEach(() => {
    globalThis.document = undefined;
  });

  it("renders the next three cards from the live queue", () => {
    const appState = {
      smart: {
        cardIndex: 0,
        repertoireName: "Caro-Kann: Advance",
        queue: [
          card("due", "Caro-Kann: Advance", "black", "c6"),
          card("weak", "London System", "white", "c4"),
          card("new", "Najdorf — 6.Bg5 prep", "black", "e6"),
          card("polish", "Ruy Lopez — Closed", "white", "Bb3"),
        ],
      },
    };
    const view = makeView(appState, elements);
    view.renderSmartProgress({ total_cards: 4, card_index: 0, kind: "due", targets_total: 1, target_index: 0 });
    const host = elements["train-upnext"];
    expect(host.hidden).toBe(false);
    expect((host.innerHTML.match(/un-row/g) || []).length).toBe(3);
    expect(host.innerHTML).toContain("Weak spot");
    expect(host.innerHTML).toContain("London System");
    expect(host.innerHTML).toContain("Najdorf");
    expect(host.innerHTML).toContain("color-dot black");
  });

  it("never prints the answer of an upcoming recall card (UX 2026-10-01 P1-2)", () => {
    const appState = {
      smart: {
        cardIndex: 0,
        repertoireName: "Caro-Kann: Advance",
        queue: [
          card("new", "Caro-Kann: Advance", "white", "Nc3"),
          card("weak", "London System", "white", "Qxb7"),
          card("due", "Caro-Kann: Advance", "white", "Bd3"),
          card("new", "Najdorf — 6.Bg5 prep", "black", "Be7"),
        ],
      },
    };
    const view = makeView(appState, elements);
    view.renderSmartProgress({ total_cards: 4, card_index: 0, kind: "new", targets_total: 1, target_index: 0 });
    const html = elements["train-upnext"].innerHTML;
    expect(html).not.toContain("Qxb7");
    expect(html).not.toContain("Bd3");
    // A new move is demonstrated by its card anyway, so it may be previewed.
    expect(html).toContain("Be7");
  });

  it("hides entirely on the last card", () => {
    const appState = {
      smart: {
        cardIndex: 3,
        repertoireName: "Caro-Kann: Advance",
        queue: [
          card("due", "Caro-Kann: Advance", "black", "c6"),
          card("weak", "London System", "white", "c4"),
          card("new", "Najdorf — 6.Bg5 prep", "black", "e6"),
          card("polish", "Ruy Lopez — Closed", "white", "Bb3"),
        ],
      },
    };
    const view = makeView(appState, elements);
    view.renderSmartProgress({ total_cards: 4, card_index: 3, kind: "polish", targets_total: 1, target_index: 0 });
    const host = elements["train-upnext"];
    expect(host.hidden).toBe(true);
    expect(host.innerHTML).toBe("");
  });

  it("hides when no smart session exists (setup screen, legacy line mode)", () => {
    const view = makeView({ smart: null }, elements);
    view.renderSmartProgress({ total_cards: 2, card_index: 0, kind: "due", targets_total: 1, target_index: 0 });
    const host = elements["train-upnext"];
    expect(host.hidden).toBe(true);
    expect(host.innerHTML).toBe("");
  });
});
