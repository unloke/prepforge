// Route-level view swap. Where View Transitions exist the outgoing page
// cross-fades into the incoming one (styles.css names .workspace and styles the
// pair; the rail and the board get no name of their own). The page stays as it
// is until the browser has captured it, so `.is-active` moves inside the
// transition's update; route state (appState.currentView, activeViewName) is
// current at once. The incoming view is `.is-arriving` until the fade ends,
// which list-enter.js reads so rows painted meanwhile ride the fade instead of
// rising a second time. Without the API, or with reduced motion, the swap is
// instant.
let seq = 0;

const reduced = () => Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

export function swapView(views, id, { animate = true, onSwap = () => {} } = {}) {
  const list = [...views];
  const token = ++seq;
  const next = list.find((v) => v.id === id) || null;
  const apply = () => {
    for (const view of list) view.classList.toggle("is-active", view === next);
    onSwap();
  };
  for (const view of list) view.classList.remove("is-arriving");
  const shown = list.find((v) => v.classList.contains("is-active"));
  const doc = globalThis.document;
  if (!animate || !shown || !next || shown === next || typeof doc?.startViewTransition !== "function"
      || doc.visibilityState === "hidden" || reduced()) {
    apply();
    return null;
  }
  const transition = doc.startViewTransition(() => {
    // A newer switch replaced this one before the capture: it applies itself.
    if (token !== seq) return;
    apply();
    next.classList.add("is-arriving");
  });
  transition.finished.finally(() => {
    if (token === seq) next.classList.remove("is-arriving");
  });
  return transition;
}
