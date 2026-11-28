import { html } from "../html.js";
import { reviewState } from "./analyze-report.js";
import { classBadgeSymbol } from "../move-grades.js";
import { createAnalyzeRetry, GRADE_WORD, retryExercises, retryPlan } from "../analyze-retry.js";
import { retryPracticeControls } from "./analyze-retry-controls.js";

export { retryExercises, retryPlan };

function nextMoment(moments, state) {
  return state.next ?? (state.current && moments.length === 1 ? null : moments[0] || null);
}

const REVIEW_ICON = {
  prev: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  retry: "M4 11a8 8 0 1 1 2 6M4 5v6h6",
};

// Key-moment browsing bar, wired to the standalone Analyze Retry engine
// (analyze-retry.js). Ordinary previous/next navigation leaves the engine,
// coach and report visible; only an explicit Retry conceals spoilers.
export function createReviewBar({
  analysisState,
  getReport,
  showAnalysisPly,
  selectAnalysisNode,
  selectPane,
  isPhone = () => typeof globalThis.innerWidth === "number" && globalThis.innerWidth <= 760,
  previewPosition = () => {},
  gradeAttempt = () => {},
  retryHooks = {},
}) {
  let pgnDirty = false;
  let lastReport = null;

  function viewEl() {
    return typeof document !== "undefined" ? document.getElementById("view-analyze") : null;
  }
  function setBlind(on) {
    const view = viewEl();
    if (!view) return;
    if (on) {
      previewPosition(null);
      view.dataset.reviewBlind = "1";
      view.dataset.reviewReplay = "1";
    } else {
      delete view.dataset.reviewBlind;
      delete view.dataset.reviewReplay;
      delete view.dataset.retryArrow;
      delete view.dataset.retryBadge;
    }
  }
  function setBoardOverlay({ arrow = false, badge = false } = {}) {
    const view = viewEl();
    if (!view) return;
    if (arrow) view.dataset.retryArrow = "1";
    else delete view.dataset.retryArrow;
    if (badge) view.dataset.retryBadge = "1";
    else delete view.dataset.retryBadge;
  }

  function currentNodeId() {
    return analysisState.analysisCurrentNodeId || "root";
  }

  function reviewPly() {
    const id = currentNodeId();
    let node = analysisState.analysisTree?.byId?.get(id);
    if (!node || node.isMainline) return Number(analysisState.analysisPly) || 0;
    while (node.parent && !node.parent.isMainline) node = node.parent;
    return (Number(node.parent?.ply) || 0) + 1;
  }

  const retry = createAnalyzeRetry({
    analysisState,
    getReport,
    currentNodeId,
    reviewPly,
    showAnalysisPly,
    selectAnalysisNode,
    selectPane,
    isPhone,
    clearHoverPeek: () => previewPosition(null),
    gradeAttempt,
    setBlind,
    setBoardOverlay,
    onPaint: () => paintReviewBar(),
    ...retryHooks,
  });

  function endReview() {
    if (!retry.session) return;
    retry.exit({ restore: false });
  }

  function syncActionButton(state, moments = getReport()?.moments || []) {
    const btn = typeof document !== "undefined" && document.getElementById("run-analysis");
    if (!btn) return;
    const labelEl = btn.querySelector?.(".bl");
    if (state) {
      const target = nextMoment(moments, state);
      btn.dataset.action = "next-key";
      const text = !target ? "Only key" : state.next ? "Next key" : "First key";
      if (labelEl) labelEl.textContent = text;
      btn.title = !target ? "Already on the only key moment" : state.next ? "Jump to next key moment (Shift+→)" : "Back to first key moment";
      if (target) btn.removeAttribute("aria-disabled");
      else btn.setAttribute("aria-disabled", "true");
    } else {
      delete btn.dataset.action;
      btn.removeAttribute("aria-disabled");
      if (labelEl) labelEl.textContent = "Review";
      btn.title = "Review the full game";
    }
    if (!btn.dataset.nextKeyBound && typeof btn.addEventListener === "function") {
      btn.dataset.nextKeyBound = "1";
      btn.addEventListener("click", (event) => {
        if (btn.dataset.forceReview === "1") {
          delete btn.dataset.forceReview;
          return;
        }
        if (btn.getAttribute("aria-disabled") === "true") {
          event.preventDefault();
          event.stopImmediatePropagation?.();
          return;
        }
        if (btn.dataset.action === "next-key" && stepOrWrap()) event.stopImmediatePropagation?.();
      }, true);
    }
    const pgnInput = typeof document !== "undefined" && document.getElementById("pgn-input");
    if (pgnInput && !pgnInput.dataset?.reviewPgnBound && typeof pgnInput.addEventListener === "function") {
      pgnInput.dataset.reviewPgnBound = "1";
      pgnInput.addEventListener("input", () => {
        pgnDirty = true;
        retry.exit({ restore: false });
        syncActionButton(null);
      });
    }
  }

  function icon(name) {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${REVIEW_ICON[name]}"/></svg>`;
  }
  const grade = (moment) => GRADE_WORD[moment.grade] || "Left prep";
  const describe = (moment) => `${moment.label}, ${grade(moment)}`;

  function browseControls(state, moments, m) {
    const upcoming = nextMoment(moments, state);
    const returnToLast = !state.next && !state.current;
    const target = upcoming;
    const report = getReport();
    const plan = retryPlan(moments, reviewPly(), report?.selfSide);
    const disabled = plan.exercises.length ? "" : " disabled";
    const retryWord = plan.wrapped ? "Retry all" : "Retry";
    const retryTitle = !plan.exercises.length
      ? "No retry positions in this game"
      : plan.wrapped
        ? `Practice all ${plan.exercises.length} key positions from the start`
        : "Practice the next positions";
    const retryLabel = !plan.exercises.length
      ? "No retry positions"
      : plan.wrapped
        ? "Retry all positions"
        : "Retry positions";
    const nextLabel = !target
      ? moments.length ? "Only key move" : "No key moves"
      : state.current
        ? `${state.next ? "Next" : "First"} key move: ${describe(target)}`
        : returnToLast
          ? `Back to key move: ${describe(target)}`
          : `Next key move: ${describe(target)}`;
    const shown = target ?? m;
    const glyph = (moment) => moment?.grade ? classBadgeSymbol(moment.move?.classification || moment.grade) : moment ? "◇" : "";
    return html`
      <button type="button" class="cr-control cr-step" data-review="prev" aria-label="Previous key move${state.prev ? `: ${describe(state.prev)}` : ""}"${state.prev ? "" : " disabled"}>${icon("prev")}</button>
      <button type="button" class="cr-control cr-preview g-${shown?.grade || "departure"}" data-review="next" aria-label="${nextLabel}" title="${nextLabel}${target ? " (Shift+→)" : ""}"${target ? "" : " disabled"}>
        <span class="cr-notation">${shown?.label || "No key moves"}</span><span class="cr-grade" aria-hidden="true">${glyph(shown)}</span>${icon("next")}
      </button>
      <button type="button" class="cr-control cr-retry" data-review="retry" aria-label="${retryLabel}" title="${retryTitle}"${disabled}>${icon("retry")}<span>${retryWord}</span></button>`;
  }

  function paintReviewBar() {
    const bar = typeof document !== "undefined" && document.getElementById("coach-review");
    if (!bar) return;
    const report = getReport();
    if (report !== lastReport) {
      lastReport = report;
      pgnDirty = false;
    }
    const moments = report?.moments || [];
    if (!report) {
      if (retry.session) retry.exit({ repaint: false, restore: false });
      setBlind(false);
      bar.hidden = true;
      bar.replaceChildren();
      syncActionButton(null);
      return;
    }
    retry.reconcile();
    const active = retry.session;
    const ply = reviewPly();
    const state = reviewState(moments, ply);
    syncActionButton(pgnDirty || active || !moments.length ? null : state, moments);
    if (active) {
      bar.hidden = false;
      const focused = typeof document !== "undefined" && bar.contains?.(document.activeElement)
        ? document.activeElement?.dataset?.review
        : null;
      bar.dataset.ply = String(active.item.ply);
      bar.innerHTML = html`<div class="cr-replay">${retryPracticeControls(active)}</div>`;
      if (focused) (bar.querySelector?.(`[data-review="${focused}"]`) || bar.querySelector?.("button"))?.focus?.({ preventScroll: true });
      bindBar(bar);
      return;
    }
    const m = state.focus;
    bar.hidden = false;
    const focused = typeof document !== "undefined" && bar.contains?.(document.activeElement)
      ? document.activeElement?.dataset?.review
      : null;
    bar.dataset.ply = String(ply || 0);
    bar.innerHTML = browseControls(state, moments, m || moments[0]);
    if (focused) (bar.querySelector?.(`[data-review="${focused}"]:not([disabled])`) || bar.querySelector?.(".cr-preview"))?.focus?.({ preventScroll: true });
    bindBar(bar);
  }

  function bindBar(bar) {
    if (bar.dataset.bound) return;
    bar.dataset.bound = "1";
    bar.addEventListener("click", (event) => {
      const btn = event.target.closest?.("[data-review]");
      if (btn && !btn.disabled && btn.getAttribute?.("aria-disabled") !== "true") {
        const idx = btn.dataset.index != null ? Number(btn.dataset.index) : null;
        void reviewAction(btn.dataset.review, idx).catch(() => {});
      }
    });
  }

  async function reviewAction(kind, idx = null) {
    if (kind === "prev" || kind === "next") return reviewStep(kind);
    return retry.action(kind, idx);
  }

  function restoreExitedPosition(exited) {
    if (!exited || exited.analysis !== analysisState.analysis) return;
    if (currentNodeId() !== exited.preId) return;
    void selectAnalysisNode(exited.preId).catch(() => {});
  }

  function reviewStep(kind) {
    const session = retry.session;
    if (session) retry.exit({ repaint: false, restore: false });
    const moments = getReport()?.moments || [];
    const state = reviewState(moments, reviewPly());
    const target = kind === "next" ? nextMoment(moments, state) : state[kind];
    if (target) {
      void showAnalysisPly(target.ply).catch(() => {});
    } else if (session) {
      paintReviewBar();
      restoreExitedPosition(session);
    }
  }

  function stepOrWrap() {
    const session = retry.session;
    if (session) retry.exit({ repaint: false, restore: false });
    const moments = getReport()?.moments || [];
    if (!moments.length) return false;
    const state = reviewState(moments, reviewPly());
    const target = nextMoment(moments, state);
    if (!target) {
      if (session) {
        paintReviewBar();
        restoreExitedPosition(session);
      }
      return false;
    }
    void showAnalysisPly(target.ply).catch(() => {});
    return true;
  }

  return { paint: paintReviewBar, step: reviewStep, stepOrWrap, endReview, tryReviewMove: retry.tryMove };
}
