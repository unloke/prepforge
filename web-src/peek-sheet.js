// Phone peek sheet (board screens). The pane switch under the board is the
// head of a sheet that peeks (the board keeps the screen, the open pane shows
// its first line) or rises (the board shrinks and the pane gets the room), as
// in the Lichess and Chess.com game screens. The view's home pane
// (data-peek-home: the coach, the line tree) reads in the peek; any other pane
// rises when it opens. Tapping the open tab or dragging the switch overrides
// that: the view's data-sheet is then "up" or "peek" until another pane opens.
// CSS sizes the board from the state. Phones only.

const PHONE = "(max-width: 760px)";
const DRAG = 24;

/** Whether the view's sheet is up: an explicit choice, else up off the home pane. */
export function sheetIsUp(view, home) {
  if (view.dataset.sheet) return view.dataset.sheet === "up";
  return Boolean(view.dataset.pane) && view.dataset.pane !== home;
}

function mark(list, view, home) {
  const up = sheetIsUp(view, home);
  list.querySelectorAll("[role=tab]").forEach((tab) => {
    if (tab.getAttribute("aria-selected") === "true") tab.setAttribute("aria-expanded", String(up));
    else tab.removeAttribute("aria-expanded");
  });
}

export function wirePeekSheets(root = document) {
  const phone = typeof window.matchMedia === "function" ? window.matchMedia(PHONE) : { matches: false };
  for (const list of root.querySelectorAll("[data-peek]")) {
    const view = list.closest(".view");
    if (!view) continue;
    const home = list.dataset.peekHome;
    const set = (up) => {
      view.dataset.sheet = up ? "up" : "peek";
      mark(list, view, home);
    };
    let start = null;
    let dragged = false;
    if (phone.matches) mark(list, view, home);
    // Capture: read which tab was open before the view's own handler switches it.
    list.addEventListener("click", (event) => {
      const tab = event.target.closest("[role=tab]");
      if (!tab || !phone.matches) return;
      if (dragged) {
        dragged = false;
        event.stopImmediatePropagation();
        event.preventDefault();
        return;
      }
      if (tab.getAttribute("aria-selected") === "true") set(!sheetIsUp(view, home));
      else {
        delete view.dataset.sheet;
        // After the view's own handler has moved the selection (a microtask
        // would run between the two listeners of a real tap).
        setTimeout(() => mark(list, view, home));
      }
    }, true);
    list.addEventListener("pointerdown", (event) => {
      if (!phone.matches) return;
      start = event.clientY;
      dragged = false;
    });
    list.addEventListener("pointermove", (event) => {
      if (start === null) return;
      const dy = event.clientY - start;
      if (Math.abs(dy) < DRAG) return;
      dragged = true;
      start = null;
      set(dy < 0);
    });
    for (const type of ["pointerup", "pointercancel"]) list.addEventListener(type, () => { start = null; });
  }
}
