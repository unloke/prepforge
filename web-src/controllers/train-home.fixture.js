// Test fixture for train-home.js: a fake document that hands out one plain
// element per id, and a Home bound to mocked app deps. Test files using setup()
// declare these mocks (vi.mock is hoisted per test file):
//   vi.mock("./core/api.js", async (orig) => ({ ...await orig(), api: vi.fn(), localDateString: vi.fn() }));
//   vi.mock("./train-play.js", async (orig) => ({ ...await orig(), confirmAbandonGame: vi.fn() }));
//   vi.mock("./controllers/train-session.js", () => import("./controllers/train-session.fixture.js"));
import { vi } from "vitest";
import { createTrainHome } from "./train-home.js";
import * as session from "./train-session.js";
import { appState } from "../core/state.js";
import { api, localDateString } from "../core/api.js";
import { provideApp } from "../core/app-context.js";
import { confirmAbandonGame } from "../train-play.js";

export function fakeElement(id) {
  const el = {
    id, hidden: false, textContent: "", innerHTML: "", dataset: {}, style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    listeners: {}, attributes: {},
    setAttribute(name, value) { el.attributes[name] = String(value); }, getAttribute(name) { return el.attributes[name] ?? null; }, focus() {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    click() { return el.listeners.click?.({ currentTarget: el, target: el }); },
    querySelector: () => el.child || (el.child = fakeElement(`${id} > *`)),
  };
  return el;
}

export function fakeDocument() {
  const els = new Map();
  return {
    els,
    getElementById(id) {
      if (!els.has(id)) els.set(id, fakeElement(id));
      return els.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { classList: { add() {}, remove() {} } },
  };
}

// Home under test: the real appState reset to `state`, the shell's entry points
// registered as fakes, and the core/api, train-play and train-session mocks the
// test file declares (see the top of this file) given their defaults.
export function setup(state = {}) {
  for (const key of Object.keys(appState)) delete appState[key];
  Object.assign(appState, { signedIn: true, accountUserId: "u1", currentView: "dashboard", repertoireList: [
    { id: "r1", name: "Italian", color: "white", is_active: true, health: { trainable: 4 } },
  ], sharedRepertoireList: [{ id: "s1", name: "Coach QGD", color: "black" }], ...state });
  vi.clearAllMocks();
  api.mockImplementation(async () => ({ next_session: { cards: 3, new: 3 }, outlook: { now: 1, today: 2, week: 5 } }));
  localDateString.mockReturnValue("2026-10-22");
  confirmAbandonGame.mockResolvedValue(true);
  const switchView = vi.fn((view) => { appState.currentView = view; });
  provideApp({ switchView, lichessAccounts: () => [], requireSignIn: vi.fn() });
  const deps = { api, localDateString, confirmAbandonGame, switchView, ...session };
  createTrainHome();
  return { appState, deps };
}
