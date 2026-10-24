// Analyze's pillars and where they sit.
//
// The coach, the evaluation (graph and win meter), the engine's lines and the
// game report own the screen around the board; the score sheet and the game
// sources are secondary. A wide screen shows every pillar at once, with the
// evaluation under the board on the game's time axis. A short or narrow panel
// keeps the coach and the evaluation fixed and puts the engine, the report and
// the moves behind tabs; a phone adds the coach to the tabs, under a pinned
// board. The layout is CSS (analyze-chart.css); this module owns the two things
// CSS cannot do: which tab is open, and moving the evaluation card next to the
// board or into the panel (one element, so its listeners and observers stay).

export const PANES = ["coach", "engine", "report", "moves"];
const KEY = "prepforge.analyze.pane";

// The same bands analyze-chart.css lays out. The evaluation sits under the board
// on a wide screen, a stacked tablet and a phone; beside the board on a short
// or narrow side-by-side panel it joins the panel's fixed column instead.
export const LAYOUT_QUERIES = {
  phone: "(max-width: 760px)",
  stacked:
    "(min-width: 761px) and (max-width: 860px) and (orientation: portrait), (min-width: 761px) and (max-width: 860px) and (min-height: 521px), (min-width: 761px) and (max-width: 1100px) and (aspect-ratio < 5/6)",
  wide: "(min-width: 1101px) and (min-height: 700px)",
};

/** The open pane for a stored value: the phone may open the coach; every other
 *  layout shows the coach above the tabs, so a stored "coach" reads as the report. */
export function paneFor(stored, { phone = false } = {}) {
  const pane = PANES.includes(stored) ? stored : phone ? "coach" : "report";
  // A phone has no move-list tab, so a stored "moves" opens the coach.
  if (phone && pane === "moves") return "coach";
  return !phone && pane === "coach" ? "report" : pane;
}

function readStored() {
  try {
    return localStorage.getItem(KEY);
  } catch (_) {
    return null;
  }
}

export function installAnalyzePanes({ onEvalMoved = () => {} } = {}) {
  const view = document.getElementById?.("view-analyze");
  const tabs = document.getElementById?.("analyze-tabs");
  if (!view || !tabs || typeof window.matchMedia !== "function") return { select: () => {} };
  const media = Object.fromEntries(Object.entries(LAYOUT_QUERIES).map(([k, q]) => [k, window.matchMedia(q)]));

  function select(pane, { store = true, focus = false } = {}) {
    const open = paneFor(pane, { phone: media.phone.matches });
    view.dataset.pane = open;
    tabs.querySelectorAll("[role=tab]").forEach((tab) => {
      const on = tab.dataset.pane === open;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    if (store) {
      try {
        localStorage.setItem(KEY, pane);
      } catch (_) {
        /* private mode: the choice lasts the session */
      }
    }
    // The score sheet keeps the current move in view when it opens.
    if (open === "moves") document.querySelector("#analysis-moves .mtree-move.is-current")?.scrollIntoView({ block: "nearest" });
  }

  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[role=tab]");
    if (tab) select(tab.dataset.pane);
  });
  // Arrow keys move along the tabs (the ones the layout shows), as a tablist does.
  tabs.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const shown = [...tabs.querySelectorAll("[role=tab]")].filter((t) => t.offsetParent !== null);
    const at = shown.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const next = Number.isFinite(step) ? shown[(at + step + shown.length) % shown.length] : step < 0 ? shown[0] : shown[shown.length - 1];
    if (next) select(next.dataset.pane, { focus: true });
  });

  // The evaluation card: under the board, or in the panel's fixed column.
  const card = document.getElementById("analysis-eval-card");
  const boardArea = view.querySelector(".board-area");
  const coach = document.getElementById("analysis-explain");
  function placeEval() {
    if (!card || !boardArea || !coach) return;
    const underBoard = media.phone.matches || media.stacked.matches || media.wide.matches;
    const home = underBoard ? boardArea : coach.parentElement;
    const after = underBoard ? boardArea.querySelector(".board-bar") : coach;
    if (!after) return;
    if (card.parentElement === home && card.previousElementSibling === after) return;
    after.after(card);
    onEvalMoved();
  }
  const relayout = () => {
    placeEval();
    select(view.dataset.pane || readStored(), { store: false });
  };
  Object.values(media).forEach((m) => m.addEventListener?.("change", relayout));
  placeEval();
  select(readStored(), { store: false });
  return { select };
}
