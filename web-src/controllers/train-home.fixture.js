// Test fixture for train-home.js: a fake document that hands out one plain
// element per id, and a Home bound to mocked app deps. Test files using setup()
// declare these mocks (vi.mock is hoisted per test file):
//   vi.mock("./core/api.js", async (orig) => ({ ...await orig(), api: vi.fn(), localDateString: vi.fn() }));
//   vi.mock("./train-play.js", async (orig) => ({ ...await orig(), confirmAbandonGame: vi.fn() }));
//   vi.mock("./controllers/train-session.js", () => import("./controllers/train-session.fixture.js"));
//   vi.mock("./account-entry.js", async (orig) => ({ ...await orig(), requireSignIn: vi.fn() }));
//   vi.mock("./train-banner.js", () => ({ setTrainBanner: vi.fn(), updateTrainTurnBadge: vi.fn() }));
import { vi } from "vitest";
import { createTrainHome } from "./train-home.js";
import * as session from "./train-session.js";
import { resetState, stateView as appState } from "../state/state-view.fixture.js";
import { api, localDateString } from "../core/api.js";
import { provideApp } from "../core/app-context.js";
import { confirmAbandonGame } from "../train-play.js";

export function fakeElement(id) {
  const el = {
    id, hidden: false, textContent: "", innerHTML: "", dataset: {}, style: {}, disabled: false,
    classList: {
      add(...names) { for (const name of names) el.classes.add(name); },
      remove(...names) { for (const name of names) el.classes.delete(name); },
      toggle(name, force) {
        const on = force === undefined ? !el.classes.has(name) : !!force;
        if (on) el.classes.add(name);
        else el.classes.delete(name);
        return on;
      },
      contains(name) { return el.classes.has(name); },
    },
    classes: new Set(),
    listeners: {}, attributes: {},
    getAnimations: () => [],
    setAttribute(name, value) { el.attributes[name] = String(value); }, getAttribute(name) { return el.attributes[name] ?? null; }, removeAttribute(name) { delete el.attributes[name]; }, focus() {},
    addEventListener(type, fn) { el.listeners[type] = fn; },
    click() { return el.listeners.click?.({ currentTarget: el, target: el }); },
    querySelector: () => el.child || (el.child = fakeElement(`${id} > *`)),
  };
  return el;
}

const STATIC_SKELETON_CONTROLS = new Set([
  "start-train", "train-due-scope", "start-rehearse", "train-rehearse-scope",
  "start-play", "train-play-book", "feeling-lucky",
]);

export function fakeDocument() {
  const els = new Map();
  return {
    els,
    getElementById(id) {
      if (!els.has(id)) {
        const el = fakeElement(id);
        if (STATIC_SKELETON_CONTROLS.has(id)) {
          el.classes.add("skeleton-control");
          el.attributes.inert = "";
        }
        if (id === "train-home") {
          el.classes.add("is-loading");
          el.attributes["aria-busy"] = "true";
        }
        if (id === "train-due-next") el.hidden = true;
        els.set(id, el);
      }
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
  if (!globalThis.localStorage) {
    const memory = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: (key) => memory.delete(key),
      clear: () => memory.clear(),
    });
  }
  resetState({ signedIn: true, accountUserId: "u1", currentView: "dashboard", ownerGeneration: 7, repertoireListGeneration: 7, trainHomeReady: false, repertoireList: [
    { id: "r1", name: "Italian", color: "white", is_active: true, health: { trainable: 4 } },
  ], sharedRepertoireList: [{ id: "s1", name: "Coach QGD", color: "black" }], ...state });
  vi.clearAllMocks();
  api.mockImplementation(async () => ({ next_session: { cards: 3, new: 3 }, outlook: { now: 1, today: 2, week: 5 } }));
  localDateString.mockReturnValue("2026-10-22");
  confirmAbandonGame.mockResolvedValue(true);
  const switchView = vi.fn((view) => { appState.currentView = view; });
  provideApp({ shell: { switchView, syncWorkspaceUrl: vi.fn() }, persistence: { flushTrainSync: vi.fn(async () => true) } });
  const deps = { api, localDateString, confirmAbandonGame, switchView, ...session };
  createTrainHome(session);
  return { appState, deps };
}
