import { html } from "../html.js";

// While a whole-game pass runs it holds every Stockfish worker (the pass takes a
// batch on the shared budget), so the Analyze engine card cannot search. It reads
// instead: the eval, depth and top line the pass has saved for the position on
// the board, or one line saying the pass has not reached that position yet.
// Nothing here starts a search, and the pass itself is untouched.
//
// The feed drives the widget it belongs to (engine-widget.js): `host` is that
// widget, and the only things it calls are the widget's own paint and restart
// paths, so a pass result reaches the card exactly as a search result does.
export function createPassFeed({ host, store: loadStore }) {
  let store = null;
  let off = null;
  let shown = false;
  const ready = loadStore().catch(() => null);

  // No number, no line, no search: the pass has not reached this position yet.
  function waiting() {
    host.pvsEl.classList.remove("is-analysis-read");
    host.pvsEl.innerHTML =
      html`<div class="engine-pv is-waiting"><span class="engine-pv-line">Analyze is still running</span></div>`;
    host.depthReadout.textContent = "";
    host.depthReadout.hidden = true;
    host.evalHead.textContent = "...";
    delete host.evalHead.dataset.side;
    delete host.evalHead.dataset.pending;
    host.evalBarText.textContent = "...";
  }

  // Paint the pass's answer for the position on the board. True when a pass is
  // running, so the caller must not search: the workers are already taken.
  async function read() {
    store ||= await ready;
    if (!store?.passing || !host.open) return false;
    shown = true;
    const snap = store.passRead(host.lastFen);
    if (!snap) {
      waiting();
      return true;
    }
    // The line is the analysis's own read, not a search this card ran: the row
    // says so (styles.css), or the number reads as live.
    host.pvsEl.classList.add("is-analysis-read");
    host._renderSnapshot(snap);
    return true;
  }

  // The pass ended: the card searches its position as it does with no pass at all.
  function onPassChange() {
    if (!store || !host.open || !host.lastFen) return;
    if (store.passing) return void read();
    if (!shown) return;
    shown = false;
    host.pvsEl.classList.remove("is-analysis-read");
    void host._restartForCurrentBoard();
    host._watch();
  }

  return {
    read,
    async attach() {
      store ||= await ready;
      off ||= store?.onPassChange(onPassChange);
    },
    detach() {
      off?.();
      off = null;
      shown = false;
    },
  };
}
