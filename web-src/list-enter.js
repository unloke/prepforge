// One rule for entrances: a thing enters once, when it first arrives.
//
// - Rows that were already on screen (same key) never replay, whatever
//   re-rendered them: a refetch, a cached paint followed by the fresh one.
// - Content painted while its view is still cross-fading in rides that fade;
//   a second rise on top of it is what read as "everything animates twice".
// - Content painted into a hidden view does not wait to play when the view
//   shows: that arrival happened off screen.
// - Loading skeletons never enter: the content replacing them is the arrival.
// - The marker comes off when the entrance ends, so re-showing a view (which
//   restarts every CSS animation under it) cannot replay it.
//
// The CSS keys every entrance off `.is-enter`; nothing animates in without it.
export const ENTER = "is-enter";
const CAP = 8;
const shown = new WeakMap();

const rowKey = (row) => row.dataset?.key ?? row.textContent ?? "";

// True while the node cannot show an entrance of its own: its view is still
// cross-fading in, or it is not rendered at all.
export function entranceCovered(node) {
  if (typeof node?.getClientRects === "function" && !node.getClientRects().length) return true;
  // view-swap.js marks the incoming view for the length of the route fade.
  return Boolean(node?.closest?.(".view")?.classList?.contains("is-arriving"));
}

// A list painted (or repainted): mark the rows that are new since the last
// paint of this container and number them so each waits its turn in place.
export function enterRows(container, { key = rowKey } = {}) {
  if (!container?.children) return;
  const rows = [...container.children].filter((row) => !row.classList?.contains("is-skeleton"));
  // A skeleton-only paint says nothing about what was shown.
  if (!rows.length && container.children.length) return;
  const before = shown.get(container);
  const covered = entranceCovered(container);
  const now = new Set();
  let i = 0;
  for (const row of rows) {
    const k = key(row);
    now.add(k);
    // A row still mid-entrance from the previous paint keeps it running.
    if (covered || before?.has(k)) continue;
    row.classList?.add(ENTER);
    row.style?.setProperty("--i", String(Math.min(i++, CAP)));
  }
  shown.set(container, now);
}

// One element arriving (a card un-hidden, a detail swapped): enter it unless
// the view's own fade already carries it.
export function enterOnce(el) {
  if (!el?.classList) return;
  if (entranceCovered(el)) {
    el.classList.remove(ENTER);
    return;
  }
  // Restart even when the marker is still on from a previous arrival.
  el.classList.remove(ENTER);
  void el.offsetWidth;
  el.classList.add(ENTER);
}

// Show a hidden element as an arrival; an element already showing is only
// repainted in place.
export function reveal(el) {
  if (!el || !el.hidden) return;
  el.hidden = false;
  enterOnce(el);
}

function settle(event) {
  const el = event.target;
  if (el?.classList?.contains(ENTER)) el.classList.remove(ENTER);
}

// Installed once at boot.
export function settleEntrances(root = document) {
  root.addEventListener("animationend", settle);
  root.addEventListener("animationcancel", settle);
}
