import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrainView, lineTail } from "./train.js";

// Characterization for the ui-prototype-v2 "Up next" preview on Train:
//  - the rows come from the live smart queue only (appState.smart.queue);
//  - each row carries the card's real kind chip and repertoire (with color dot);
//  - hidden when there is no session, no queue, or the card is the last one.

function makeHost() {
  return { hidden: true, get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); } };
}

function makeElements() {
  return {
    "train-upnext": makeHost(),
    "train-line-label": { textContent: "" },
    "train-progress-fill": { style: {} },
    "train-card-dots": { get innerHTML() { return this._html ?? ""; }, set innerHTML(value) { this._html = String(value); } },
  };
}

function makeView(appState, elements) {
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  if (appState.smart) appState.smart.cardKinds = Object.fromEntries(
    Object.entries({ weak: "Weak spot", due: "Due review", new: "New move", polish: "Polish" })
      .map(([key, label]) => [key, { key, label, title: "" }]),
  );
  return createTrainView({
    appState,
    boards: {},
    renderSyncChip: () => {},
    setTrainBanner: () => {},
    updateTrainTurnBadge: () => {},
    onStreakRendered: () => {},
  });
}

function card(kind, rep, color, san, line = "1.e4 c6 2.d4 d5") {
  return {
    kind,
    repertoire_name: rep,
    color,
    targets: [{ san, line }],
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
    appState.smart.cardKinds.weak.label = "Server label";
    view.renderSmartProgress({ total_cards: 4, card_index: 0, kind: "due", targets_total: 1, target_index: 0 });
    const host = elements["train-upnext"];
    expect(host.hidden).toBe(false);
    expect((host.innerHTML.match(/un-row/g) || []).length).toBe(3);
    expect(String(host.innerHTML)).toContain("Server label");
    expect(String(host.innerHTML)).toContain("London System");
    expect(String(host.innerHTML)).toContain("Najdorf");
    expect(String(host.innerHTML)).toContain("color-dot black");
  });

  it("names each upcoming position, never its answer, new moves included", () => {
    const appState = {
      smart: {
        cardIndex: 0,
        repertoireName: "Caro-Kann: Advance",
        queue: [
          card("new", "Caro-Kann: Advance", "white", "Nc3"),
          card("weak", "London System", "white", "Qxb7", "1.d4 d5 2.Bf4 c5 3.e3 Qb6"),
          card("due", "Caro-Kann: Advance", "white", "Bd3"),
          card("new", "Najdorf — 6.Bg5 prep", "black", "Be7", "5.Nc3 a6 6.Bg5 e6 7.f4"),
        ],
      },
    };
    const view = makeView(appState, elements);
    view.renderSmartProgress({ total_cards: 4, card_index: 0, kind: "new", targets_total: 1, target_index: 0 });
    const html = String(elements["train-upnext"].innerHTML);
    for (const answer of ["Qxb7", "Bd3", "Be7"]) expect(html).not.toContain(answer);
    expect(html).toContain("3.e3 Qb6");
    expect(html).toContain("6...e6 7.f4");
  });

  it("lineTail keeps the move number of a black move", () => {
    expect(lineTail("1.e4 c6 2.d4 d5")).toBe("2.d4 d5");
    expect(lineTail("1.e4 c6 2.d4 d5 3.e5")).toBe("2...d5 3.e5");
    expect(lineTail("5...exd4")).toBe("5...exd4");
    expect(lineTail("")).toBe("");
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
    expect(String(host.innerHTML)).toBe("");
  });

  it("hides when no smart session exists (setup screen, legacy line mode)", () => {
    const view = makeView({ smart: null }, elements);
    view.renderSmartProgress({ total_cards: 2, card_index: 0, kind: "due", targets_total: 1, target_index: 0 });
    const host = elements["train-upnext"];
    expect(host.hidden).toBe(true);
    expect(String(host.innerHTML)).toBe("");
  });
});
