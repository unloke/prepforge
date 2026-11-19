// Animate live content, not captured pages: input stays on the real controls.
let stopArrival = () => {};

const reduced = () => Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

export function animateView(view, update, { animate = true, target = view } = {}) {
  stopArrival();
  const root = globalThis.document?.documentElement;
  if (!animate || !view || !target || document.visibilityState === "hidden" || reduced()) {
    update();
    return null;
  }
  root?.classList.add("view-swap");
  view.classList.add("is-arriving");
  update();
  target.classList.add("is-view-entering");
  const animation = target.getAnimations().find((a) => a.animationName === "view-enter");
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    view.classList.remove("is-arriving");
    target.classList.remove("is-view-entering");
    root?.classList.remove("view-swap");
    stopArrival = () => {};
  };
  if (!animation) {
    finish();
    return null;
  }
  stopArrival = () => { animation.cancel(); finish(); };
  animation.finished.then(finish, finish);
  return animation;
}

export function swapView(views, id, { animate = true, onSwap = () => {} } = {}) {
  const list = [...views];
  const shown = list.find((v) => v.classList.contains("is-active"));
  const next = list.find((v) => v.id === id) || null;
  return animateView(next, () => {
    for (const view of list) view.classList.toggle("is-active", view === next);
    onSwap();
  }, { animate: animate && Boolean(shown && next && shown !== next) });
}
