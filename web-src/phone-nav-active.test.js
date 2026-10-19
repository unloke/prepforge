import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { appSource } from "./test-app-source.js";

// The phone bottom bar's Review tab names the whole Review destination (Games
// OR Scout). setReplaySection painted every .tab[data-replay-section] from the
// active section only, which switched the Review tab off on Scout and left the
// bottom bar with nothing lit after a #/scout route or a More > Scout tap.
const source = appSource();
const REVIEW_PAINT = `
  // switchView's bottom-bar branch: Review lights up for either section.
  for (const button of document.querySelectorAll("[data-review-tab]")) {
    const active = appState.currentView === "replay";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
`;
const SET_REPLAY_SECTION = source.slice(
  source.indexOf("function setReplaySection("),
  source.indexOf("\n// Top-bar title follows"),
);
const DRIVER = `
globalThis.nav = (view, section) => {
  appState.currentView = view;
  ${REVIEW_PAINT}
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
function nav(view, section, { buttons, currentView } = {}) {
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
    },
  };
  runInNewContext(`${SET_REPLAY_SECTION}\n${DRIVER}`, context);
  context.nav(view, section);
  return context;
}

it("keeps the phone bar's Review tab lit on Scout", () => {
  const review = REVIEW(), railGames = RAIL_GAMES(), railScout = RAIL_SCOUT();
  const ctx = nav("replay", "scout", { buttons: [review, railGames, railScout] });
  expect(ctx.appState.replaySection).toBe("scout");
  expect(review.classList.contains("is-active")).toBe(true);
  expect(review.getAttribute("aria-current")).toBe("page");
  expect(railGames.classList.contains("is-active")).toBe(false);
  expect(railScout.classList.contains("is-active")).toBe(true);
});

it("keeps the Review tab lit on Games", () => {
  const review = REVIEW();
  nav("replay", "games", { buttons: [review, RAIL_GAMES()] });
  expect(review.classList.contains("is-active")).toBe(true);
  expect(review.getAttribute("aria-current")).toBe("page");
});

it("darkens the Review tab once Review is left", () => {
  const review = REVIEW();
  nav("train", "games", { buttons: [review] });
  expect(review.classList.contains("is-active")).toBe(false);
  expect(review.getAttribute("aria-current")).toBe("false");
});
