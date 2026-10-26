import { html, raw } from "../html.js";
// Practice's opponent as a row of cards on a phone (the Chess.com bot picker):
// one card per opponent, the picked one ringed, an unusable one disabled with
// the reason. The desktop row keeps its chip; both set appState.playBook.
// Phone Home also splits into two panes, Drill and Practice, so each pane has
// one primary action; the pane is #view-train[data-train-pane].

const ICONS = {
  // Maia plays like a person: a head and shoulders.
  maia: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6"/>',
  // The Lichess explorer is a database of games: stacked discs.
  explorer: '<ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6"/>',
  // Your repertoires: a book.
  repertoire: '<path d="M5 4.5h9.5A2.5 2.5 0 0 1 17 7v12.5H7.5A2.5 2.5 0 0 1 5 17zM5 17a2.5 2.5 0 0 1 2.5-2.5H17"/>',
};
const SHORT = { maia: "Maia", explorer: "Lichess", repertoire: "Repertoire" };
// Phone order: the one that always works first.
const ORDER = ["maia", "explorer", "repertoire"];

export function trainBotsHtml({ usable, selected, reasons }) {
  return ORDER.map((id) => {
    const on = id === selected;
    return html`<button type="button" class="train-bot${on ? " is-on" : ""}" data-book="${id}" aria-pressed="${String(on)}" ${usable[id] ? "" : "disabled"}>
      <svg class="train-bot-icon" viewBox="0 0 24 24" aria-hidden="true">${raw(ICONS[id])}</svg>
      <span class="train-bot-name">${SHORT[id]}</span>
      ${usable[id] ? "" : html`<span class="train-bot-sub">${reasons[id]}</span>`}
    </button>`;
  });
}

const PANE_KEY = "prepforge.train-pane";

export function trainPane() {
  try { return localStorage.getItem(PANE_KEY) === "play" ? "play" : "drill"; } catch (_) { return "drill"; }
}

export function setTrainPane(pane) {
  const want = pane === "play" ? "play" : "drill";
  try { localStorage.setItem(PANE_KEY, want); } catch (_) { /* private mode */ }
  paintTrainPane(want);
}

export function paintTrainPane(pane = trainPane()) {
  const view = document.getElementById("view-train");
  if (view) view.dataset.trainPane = pane;
  document.querySelectorAll("#train-tabs .seg-btn").forEach((btn) => {
    const on = btn.dataset.pane === pane;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
}
