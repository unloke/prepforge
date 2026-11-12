// The sheet under a phone board: its tab row is a handle. Dragged up (or the grab
// bar tapped) the sheet rises over the board for the whole list; dragged down
// it settles back under the board. The page itself never scrolls.
const PULL = 24;

export function bindSheet(view, row, grab) {
  if (!view || !row) return;
  const set = (raised) => view.classList.toggle("is-raised", raised);
  // The finger ends over the board, not the row, so the release is read on the window.
  row.addEventListener("pointerdown", (down) => {
    if (!down.isPrimary) return;
    const end = (up) => {
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
      if (up.type !== "pointerup") return;
      const dy = up.clientY - down.clientY;
      if (dy < -PULL) set(true);
      else if (dy > PULL) set(false);
    };
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
  });
  grab?.addEventListener("click", () => set(!view.classList.contains("is-raised")));
}

// A held arrow jumps to its end of the line (the first / last move), as on
// Lichess mobile; a tap still steps one move.
const HOLD_MS = 450;

export function bindHoldToEnd(arrow, end) {
  if (!arrow || !end) return;
  let timer = 0;
  let jumped = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  arrow.addEventListener("pointerdown", () => {
    jumped = false;
    cancel();
    timer = setTimeout(() => { jumped = true; end.click(); }, HOLD_MS);
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) arrow.addEventListener(type, cancel);
  arrow.addEventListener("click", (event) => {
    if (!jumped) return;
    jumped = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }, true);
}

// A held finger opens a row's menu, as on iOS lists: Safari never fires
// `contextmenu` on touch, and where Android does, the first of the two wins.
// The tap that ends the hold opens nothing.
export function bindLongPress(el, open) {
  let timer = 0;
  let held = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  el.addEventListener("pointerdown", (event) => {
    held = false;
    cancel();
    if (event.pointerType !== "touch") return;
    const { clientX, clientY } = event;
    timer = setTimeout(() => { held = true; open({ preventDefault() {}, currentTarget: el, clientX, clientY }); }, HOLD_MS);
  });
  for (const type of ["pointerup", "pointercancel"]) el.addEventListener(type, cancel);
  el.addEventListener("contextmenu", (event) => {
    if (!held && !timer) return;
    cancel();
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!held) { held = true; open(event); }
  }, true);
  el.addEventListener("click", (event) => {
    if (!held) return;
    held = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }, true);
}
