// Test fixture for train-home.js: a fake document that hands out one plain
// element per id, and a Home bound to mocked app deps.
import { vi } from "vitest";
import { createTrainHome } from "./train-home.js";

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

export function setup(state = {}) {
  const appState = { signedIn: true, currentView: "dashboard", repertoireList: [
    { id: "r1", name: "Italian", color: "white", is_active: true, health: { trainable: 4 } },
  ], sharedRepertoireList: [{ id: "s1", name: "Coach QGD", color: "black" }], ...state };
  const deps = {
    appState,
    api: vi.fn(async () => ({ next_session: { cards: 3, new: 3 }, outlook: { now: 1, today: 2, week: 5 } })),
    confirmAbandonGame: vi.fn(async () => true),
    showConfirmModal: vi.fn(),
    switchView: vi.fn((view) => { appState.currentView = view; }),
    startTraining: vi.fn(async () => {}),
    startPlaySessionTracked: vi.fn(async () => {}),
    clearBlitzTimer: vi.fn(),
    setBlitzBarVisible: vi.fn(),
    resetTrainBoardIdle: vi.fn(async () => {}),
    localDateString: () => "2026-10-22",
    lichessAccounts: () => [],
    blitzEnabled: () => false,
    currentOwnerId: () => "u1",
    PLAY_COLOR_KEY: "prepforge.play_color",
  };
  createTrainHome(deps);
  return { appState, deps };
}

