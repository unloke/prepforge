// Analyze's pillars and where they sit.
//
// The coach, the evaluation (graph and win meter), the engine's lines and the
// game report own the screen around the board; the score sheet and the game
// sources are secondary. The evaluation joins the panel's fixed column except
// on a portrait phone, where it sits above the pinned board. A short or narrow
// panel keeps the coach and the evaluation fixed and puts the engine, the
// report and the moves behind tabs; a phone adds the coach to the tabs. The
// layout is CSS (analyze-chart.css); this module owns the two things
// CSS cannot do: which tab is open, and moving the evaluation card above the
// phone board or into the panel (one element, so its listeners and observers stay),
// and the game's name between the thumb bar and the phone's top strip.

export const PANES = ["coach", "engine", "report", "moves"];
const KEY = "prepforge.analyze.pane";

// The same bands analyze-chart.css lays out. The evaluation sits above the
// board on a portrait phone; otherwise it joins the panel's column.
export const LAYOUT_QUERIES = {
  phone: "(max-width: 760px) and (orientation: portrait), (max-width: 760px) and (min-height: 521px)",
  desktop: "(min-width: 1180px)",
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

  // A dedicated Report tab is already its disclosure control. Only the wide
  // layout folds the score strip to make room for the move list below it.
  function syncReport() {
    const report = document.getElementById("analysis-summary");
    const summary = report?.querySelector("[data-toggle-summary]");
    if (!summary) return;
    const alwaysOpen = tabs.offsetParent !== null || Boolean(media.desktop?.matches);
    summary.disabled = alwaysOpen;
    if (alwaysOpen) report.dataset.open = "true";
    summary.setAttribute("aria-expanded", String(report.dataset.open === "true"));
  }

  function select(pane, { store = true, focus = false } = {}) {
    const open = paneFor(pane, { phone: media.phone.matches });
    view.dataset.pane = open;
    syncReport();
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

  // The evaluation card: above the board on a phone, or in the panel's fixed column.
  const card = document.getElementById("analysis-eval-card");
  const boardArea = view.querySelector(".board-area");
  const coach = document.getElementById("analysis-explain");
  function placeEval() {
    if (!card || !boardArea || !coach) return;
    const onPhone = media.phone.matches;
    const home = onPhone ? boardArea : coach.parentElement;
    const after = onPhone ? boardArea.querySelector(".board-bar") : coach;
    if (!after) return;
    if (card.parentElement === home && card.previousElementSibling === after) return;
    after.after(card);
    onEvalMoved();
  }
  // The grading switch: in the coach's head row beside a pointer's panel; on a
  // phone that row is the review bar's, so the switch joins the engine pane's
  // head, beside Live (both are Stockfish settings).
  const gradeLabel = document.getElementById("explain-engine-label");
  const gradeSwitch = document.getElementById("explain-engine-toggle");
  const engineHead = document.querySelector("#analysis-engine-pane .an-pane-head");
  const movesHead = document.getElementById("analysis-moves-head");
  function placeGrade() {
    if (!gradeLabel || !gradeSwitch || !engineHead || !coach) return;
    const phone = media.phone.matches;
    const desktop = Boolean(media.desktop?.matches && movesHead);
    const target = phone ? engineHead : desktop ? movesHead : null;
    if (target) {
      if (target.contains(gradeSwitch)) return;
      target.append(gradeLabel, gradeSwitch);
    } else if (engineHead.contains(gradeSwitch) || movesHead?.contains(gradeSwitch)) {
      coach.querySelector("#analyze-actions")?.before(gradeLabel, gradeSwitch);
    }
  }
  // The game's name: the bar's text slot beside a pointer's panel; on a phone
  // it is the top strip over the board when there is no evaluation band to
  // hold that place, so the board starts at the same height in every state.
  const caption = document.getElementById("analysis-board-caption");
  const barNav = boardArea?.querySelector(".board-bar .bb-nav");
  function placeCaption() {
    if (!caption || !boardArea || !barNav) return;
    const phone = media.phone.matches;
    if (phone === (caption.parentElement === boardArea)) return;
    if (phone) boardArea.prepend(caption);
    else barNav.after(caption);
  }
  const relayout = () => {
    placeEval();
    placeGrade();
    placeCaption();
    select(view.dataset.pane || readStored(), { store: false });
  };
  // The report's overlay thumb appears only while its own scroller is moving;
  // a pointer merely left over the pane must not keep it painted.
  for (const el of [
    document.getElementById("analysis-report"),
    document.querySelector("#analyze-sidebar > .panel-scroll"),
  ]) {
    if (!el || el.dataset.scrollThumbBound) continue;
    el.dataset.scrollThumbBound = "1";
    let hideTimer = null;
    let pointer = null;
    // WebKit reports a scrollbar pseudo-element as hovered for the scroller's
    // own hover state, so hit-test the actual thumb instead of using
    // ::-webkit-scrollbar-thumb:hover (which kept the thumb painted under a
    // stationary pointer anywhere in the report).
    const syncThumbHover = (event) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || el.scrollHeight <= el.clientHeight || event.clientX < rect.right - 8) {
        delete el.dataset.scrollbarThumb;
        return;
      }
      const thumbHeight = Math.max(24, rect.height * (el.clientHeight / el.scrollHeight));
      const thumbTravel = Math.max(0, rect.height - thumbHeight);
      const scrollRange = Math.max(1, el.scrollHeight - el.clientHeight);
      const thumbTop = rect.top + (el.scrollTop / scrollRange) * thumbTravel;
      if (event.clientY >= thumbTop && event.clientY <= thumbTop + thumbHeight) el.dataset.scrollbarThumb = "";
      else delete el.dataset.scrollbarThumb;
    };
    el.addEventListener("scroll", () => {
      el.dataset.scrolling = "";
      if (pointer) syncThumbHover(pointer);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => delete el.dataset.scrolling, 650);
    }, { passive: true });
    el.addEventListener("pointermove", (event) => {
      pointer = event;
      syncThumbHover(event);
    }, { passive: true });
    el.addEventListener("pointerleave", () => {
      pointer = null;
      delete el.dataset.scrollbarThumb;
    }, { passive: true });
  }
  Object.values(media).forEach((m) => m.addEventListener?.("change", relayout));
  placeEval();
  placeGrade();
  placeCaption();
  select(readStored(), { store: false });
  return { select, syncReport, isPhone: () => media.phone.matches };
}
