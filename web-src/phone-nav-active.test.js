import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { appSource } from "./test-app-source.js";

// The phone bottom bar's tab is labelled Games: it is lit on Games only. Scout
// lives in the More sheet, so More is what lights up on Scout (and on Teams
// and Settings); the bar always has exactly the open destination lit.
const source = appSource();
const PHONE_TABS = readFileSync(new URL("./phone-tabs.js", import.meta.url), "utf8").replace(/^export /m, "");
const SET_REPLAY_SECTION = PHONE_TABS + source.slice(
  source.indexOf("function setReplaySection("),
  source.indexOf("\n// Top-bar title follows"),
);
const DRIVER = `
globalThis.nav = (view, section) => {
  appState.currentView = view;
  paintPhoneTabs(view, section);
  setReplaySection(section);
};
`;

// Minimal .tab button stand-in: attribute get/set plus the class list.
function tab(dataset) {
  const attrs = {};
  const classes = new Set();
  const camel = {};
  for (const [k, v] of Object.entries(dataset)) {
    camel[k.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return {
    dataset: camel,
    reviewTab: "data-review-tab" in dataset,
    classList: {
      toggle: (cls, on) => (on ? classes.add(cls) : classes.delete(cls)),
      contains: (cls) => classes.has(cls),
    },
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    setAttribute: (n, v) => { attrs[n] = v; },
  };
}

const REVIEW = () => tab({ "data-replay-section": "games", "data-review-tab": "" });
const RAIL_GAMES = () => tab({ "data-replay-section": "games" });
const RAIL_SCOUT = () => tab({ "data-replay-section": "scout" });

// Paint a view switch to `view` plus the replay section, in app order.
function nav(view, section, { buttons, currentView, more = null } = {}) {
  const context = {
    appState: { currentView: currentView ?? view, replaySection: section },
    notices: { clearStatusOnNavigate() {} },
    resetViewScroll: () => {},
    syncPageTitle: () => {},
    preloadScoutUi: () => Promise.resolve(),
    syncWorkspaceUrl: () => {},
    document: {
      querySelectorAll: (sel) => {
        if (sel.includes("data-replay-panel")) return [];
        if (sel === "[data-review-tab]") return buttons.filter((b) => b.reviewTab);
        if (!sel.includes("data-replay-section")) return [];
        if (sel.includes(":not([data-review-tab])")) return buttons.filter((b) => !b.reviewTab);
        return buttons;
      },
      querySelector: () => null,
      getElementById: (id) => (id === "more-nav-btn" ? more : null),
    },
  };
  runInNewContext(`${SET_REPLAY_SECTION}\n${DRIVER}`, context);
  context.nav(view, section);
  return context;
}

it("lights More, not the Games tab, on Scout", () => {
  const review = REVIEW(), railGames = RAIL_GAMES(), railScout = RAIL_SCOUT(), more = tab({});
  const ctx = nav("replay", "scout", { buttons: [review, railGames, railScout], more });
  expect(ctx.appState.replaySection).toBe("scout");
  expect(review.classList.contains("is-active")).toBe(false);
  expect(more.classList.contains("is-active")).toBe(true);
  expect(more.getAttribute("aria-current")).toBe("page");
  expect(railGames.classList.contains("is-active")).toBe(false);
  expect(railScout.classList.contains("is-active")).toBe(true);
});

it("keeps the Games tab lit on Games, and More dark", () => {
  const review = REVIEW(), more = tab({});
  nav("replay", "games", { buttons: [review, RAIL_GAMES()], more });
  expect(review.classList.contains("is-active")).toBe(true);
  expect(review.getAttribute("aria-current")).toBe("page");
  expect(more.classList.contains("is-active")).toBe(false);
});

it("darkens the Games tab once Review is left", () => {
  const review = REVIEW();
  nav("train", "games", { buttons: [review] });
  expect(review.classList.contains("is-active")).toBe(false);
  expect(review.getAttribute("aria-current")).toBe("false");
});

it("never lights More beside the Analyze tab", () => {
  const more = tab({});
  nav("analyze", "games", { buttons: [], more });
  expect(more.classList.contains("is-active")).toBe(false);
});
