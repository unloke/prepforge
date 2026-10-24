// The review bar under the board (index.html, #analysis-review): the key moments
// of the report it was last given, the moment the board is on, and the bar's DOM.
// The model is analyze-review.js. The arrows step the view; the stop's action is
// the coach line's own button; "Find great moves" turns Maia analysis on and runs
// the game again.
import { setPref } from "../core/prefs.js";
import { reviewBarModel } from "./analyze-review.js";
import { reviewState } from "./analyze-report.js";

export function createReviewBar({ appState, showAnalysisPly }) {
  let moments = [];
  let graded = false;

  function step(kind) {
    const st = reviewState(moments, Number(appState.analysisPly) || 0);
    const target = kind === "next" ? st.next : st.prev;
    return target ? showAnalysisPly(target.ply) : undefined;
  }

  function bind(bar) {
    if (bar.dataset.reviewBound) return;
    bar.dataset.reviewBound = "1";
    bar.addEventListener("click", (event) => {
      const arrow = event.target.closest?.("[data-rv]");
      if (arrow) {
        if (!arrow.disabled) void step(arrow.dataset.rv);
        return;
      }
      // The coach line already holds this stop's action, so the bar triggers that
      // button and the book's add and drill paths stay in one place.
      const act = event.target.closest?.("[data-rv-act]");
      if (act) {
        document.querySelector(`#coach-bookline [data-act="${act.dataset.act}"]`)?.click();
      } else if (event.target.closest?.("[data-rv-maia]")) {
        setPref("maiaAnalysis", true);
        document.getElementById("run-analysis")?.click();
      }
    });
  }

  function paint() {
    // Unit tests load the module with no DOM; there is nothing to paint then.
    const bar = globalThis.document?.getElementById("analysis-review");
    if (!bar) return;
    bind(bar);
    // "Find great moves" runs the PGN box again, so it needs a game in the box.
    const maia = appState.analysis?.quality?.maia;
    const boxed = !!document.getElementById("pgn-input")?.value.trim();
    const m = reviewBarModel({
      moments,
      ply: Number(appState.analysisPly) || 0,
      graded,
      running: !!document.querySelector('#analysis-eval-card .notice[data-state="running"]'),
      signedIn: !!appState.signedIn,
      maiaOff: !!maia && maia.available === false && boxed,
    });
    bar.hidden = m.hidden;
    if (m.hidden) return;
    const put = (sel, text) => {
      const el = bar.querySelector(sel);
      if (el.textContent !== text) el.textContent = text;
    };
    bar.querySelector('[data-rv="prev"]').disabled = m.prevDisabled;
    bar.querySelector('[data-rv="next"]').disabled = m.nextDisabled;
    bar.querySelector(".rv-now").className = `rv-now g-${m.grade}`;
    put(".rp-glyph", m.glyph);
    put(".rv-move", m.label);
    put(".rv-kind", m.kind);
    put(".rv-count", m.count);
    const act = bar.querySelector("[data-rv-act]");
    act.hidden = !m.act;
    act.dataset.act = m.act || "";
    put("[data-rv-act]", m.actLabel);
    bar.querySelector("[data-rv-maia]").hidden = !m.maia;
  }

  // The report's moments are the bar's list, so the two always name the same moves.
  function set(report) {
    moments = report ? report.moments : [];
    graded = !!report?.graded;
    paint();
  }

  return { set, paint, step };
}
