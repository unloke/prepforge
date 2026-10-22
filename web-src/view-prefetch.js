// Warms the lazily imported view chunks so a view switch never waits on the
// network: every view's chunks once the browser is idle after first paint, and
// a view's own as soon as the pointer (or focus) reaches its nav link. Same-
// document hash routing has no navigation to speculate on, so this is the
// whole of it. import() is memoised by the module map, so a warm-up and the
// real visit share one request; only fetching and evaluating happens here, the
// views still build themselves on first entry.
const CHUNKS = {
  dashboard: () => [import("./views/dashboard.js")],
  build: () => [import("./views/build.js"), import("./controllers/build-session.js"), import("./explorer.js"), import("./engine/position-analysis-store.js")],
  analyze: () => [import("./views/analyze.js"), import("./controllers/analyze-session.js"), import("./coach/bundle.js"), import("./analyze-book.js"), import("./engine/position-analysis-store.js")],
  train: () => [import("./views/train.js"), import("./controllers/train-session.js"), import("./train-resume.js"), import("./engine/position-analysis-store.js")],
  games: () => [import("./views/games-controller.js"), import("./views/replay.js")],
  scout: () => [import("./views/scout-controller.js"), import("./views/scout.js")],
  teams: () => [import("./views/teams-controller.js"), import("./views/teams.js")],
  settings: () => [import("./views/settings-controller.js"), import("./views/settings.js")],
};
// Idle order: where people go next most often first.
const IDLE_ORDER = ["build", "analyze", "train", "games", "scout", "dashboard", "settings", "teams"];

const warmed = new Set();

export function warmView(name) {
  const load = CHUNKS[name];
  if (!load || warmed.has(name)) return;
  warmed.add(name);
  // A failed warm-up is forgotten, so the real visit (or the next hover) retries.
  Promise.all(load()).catch(() => warmed.delete(name));
}

const chunkFor = (el) => {
  const tab = el?.closest?.("[data-view]");
  if (!tab) return null;
  return tab.dataset.view === "replay" ? tab.dataset.replaySection || "games" : tab.dataset.view;
};

function saveData(nav = globalThis.navigator) {
  const conn = nav?.connection;
  return Boolean(conn?.saveData) || /(^|-)2g$/.test(conn?.effectiveType || "");
}

export function prefetchViews({ root = globalThis.document, idle = globalThis.requestIdleCallback } = {}) {
  const onIntent = (event) => { const name = chunkFor(event.target); if (name) warmView(name); };
  root.addEventListener("pointerover", onIntent, { passive: true });
  root.addEventListener("focusin", onIntent);
  if (saveData()) return;
  // One view per idle slot, so warming never competes with the user's own work.
  const queue = [...IDLE_ORDER];
  const schedule = idle || ((cb) => setTimeout(() => cb({ timeRemaining: () => 0 }), 200));
  const next = () => {
    const name = queue.shift();
    if (!name) return;
    warmView(name);
    schedule(next, { timeout: 4000 });
  };
  // First paint has happened once the frame after this one starts.
  requestAnimationFrame(() => setTimeout(() => schedule(next, { timeout: 4000 }), 0));
}
