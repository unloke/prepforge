// Phone Home: the opponent cards and the Drill / Practice panes.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { paintTrainPane, setTrainPane, trainBotsHtml, trainPane } from "./train-bots.js";

const usable = { maia: true, explorer: false, repertoire: true };
const reasons = { explorer: "Link Lichess", repertoire: "Sign in" };

it("renders one card per opponent, the picked one pressed and an unusable one disabled with its reason", () => {
  const out = trainBotsHtml({ usable, selected: "repertoire", reasons }).join("");
  expect(out.match(/<button type="button" class="train-bot/g)).toHaveLength(3);
  expect(out.indexOf('data-book="maia"')).toBeLessThan(out.indexOf('data-book="explorer"'));
  expect(out).toMatch(/class="train-bot is-on" data-book="repertoire" aria-pressed="true"/);
  expect(out).toMatch(/data-book="explorer" aria-pressed="false" disabled/);
  expect(out).toContain('<span class="train-bot-sub">Link Lichess</span>');
  expect(out).not.toContain("Sign in");
});

// A plain fake DOM: the view and its two tab buttons, and a localStorage.
let view, tabs;
beforeEach(() => {
  const store = new Map();
  vi.stubGlobal("localStorage", { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), clear: () => store.clear() });
  const tab = (pane) => {
    const attrs = {}; const cls = new Set();
    return { dataset: { pane }, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] ?? null, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) } };
  };
  view = { dataset: {} };
  tabs = [tab("drill"), tab("play")];
  vi.stubGlobal("document", { getElementById: (id) => (id === "view-train" ? view : null), querySelectorAll: () => tabs });
});
afterEach(() => vi.unstubAllGlobals());

it("the pane defaults to Drill, persists a switch and marks its tab", () => {
  expect(trainPane()).toBe("drill");
  setTrainPane("play");
  expect(trainPane()).toBe("play");
  expect(view.dataset.trainPane).toBe("play");
  const [drill, play] = tabs;
  expect(play.getAttribute("aria-pressed")).toBe("true");
  expect(drill.classList.contains("is-active")).toBe(false);
  setTrainPane("anything");
  paintTrainPane();
  expect(view.dataset.trainPane).toBe("drill");
});
