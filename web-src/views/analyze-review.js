import { html } from "../html.js";
import { classBadgeSymbol } from "../move-grades.js";
import { reviewState } from "./analyze-report.js";
import { onTriedGrade, triedGrade, UNGRADED } from "../analyze-tried-grade.js";

// The review bar under the coach (Chess.com's Next and Retry): step to the
// previous or next key moment of the report, and at a mistake try to find the
// better move on the board. The engine's own line already shows that move.
export function createReviewBar({ analysisState, getReport, showAnalysisPly, selectAnalysisNode, selectPane }) {
  // A Retry in progress: the position before the moment (`fromId`), the move
  // the engine wanted there, and the moment's ply. It ends when the reader
  // leaves that position and its replies.
  let retry = null;
  let pgnDirty = false;
  let lastReport = null;
  const STEP_ICON = { prev: "M15 5l-7 7 7 7", next: "M9 5l7 7-7 7" };
  const GRADE_WORD = { brilliant: "Brilliant", great: "Great", mistake: "Mistake", blunder: "Blunder" };
  // The coach's grades that mean a Retry move holds the engine's evaluation: "best"
  // covers any move within the classifier's excellent loss of the top one.
  const FOUND_GRADES = new Set(["best", "great", "brilliant", "forced"]);
  // A tried move's grade lands after the coach reads it; repaint the Retry then.
  onTriedGrade(() => { if (retry) paintReviewBar(); });

  function syncActionButton(state) {
    const btn = typeof document !== "undefined" && document.getElementById("run-analysis");
    if (!btn) return;
    const labelEl = btn.querySelector?.(".bl");
    if (state) {
      btn.dataset.action = "next-key";
      const text = state.next ? "Next key" : "First key";
      if (labelEl) labelEl.textContent = text;
      btn.title = state.next ? "Jump to next key moment (Shift+→)" : "Back to first key moment";
    } else {
      delete btn.dataset.action;
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
        if (btn.dataset.action === "next-key" && stepOrWrap()) {
          event.stopImmediatePropagation?.();
        }
      }, true);
    }
    const pgnInput = typeof document !== "undefined" && document.getElementById("pgn-input");
    if (pgnInput && !pgnInput.dataset?.reviewPgnBound && typeof pgnInput.addEventListener === "function") {
      pgnInput.dataset.reviewPgnBound = "1";
      pgnInput.addEventListener("input", () => {
        pgnDirty = true;
        syncActionButton(null);
      });
    }
  }

  // The game ply the review reads from: a branch counts as the move it
  // replaces, so a line played at a moment keeps that moment in focus.
  function reviewPly() {
    const id = analysisState.analysisCurrentNodeId || "root";
    if (retry && id === retry.fromId) return retry.ply;
    let node = analysisState.analysisTree?.byId?.get(id);
    if (!node || node.isMainline) return Number(analysisState.analysisPly) || 0;
    while (node.parent && !node.parent.isMainline) node = node.parent;
    return (Number(node.parent?.ply) || 0) + 1;
  }

  // "try" at the Retry position, "right" on the engine's move played there, and on
  // another move played during a Retry: "also" when the coach grades it as good as
  // the engine's move, "wrong" when it grades it worse, "checking" until it reads it,
  // and "unchecked" when the coach will not grade it (Grade moves off, no engine read).
  function triedState(moment) {
    const id = analysisState.analysisCurrentNodeId || "root";
    if (retry && id === retry.fromId) return "try";
    const node = analysisState.analysisTree?.byId?.get(id);
    const best = moment?.best?.uci;
    if (best && node?.isVariation && node.parent?.id === `m${moment.ply - 1}`.replace(/^m0$/, "root")) {
      if (node.uci === best) return "right";
      if (retry) {
        const grade = triedGrade(node.fenBefore, node.uci);
        return !grade ? "checking" : grade === UNGRADED ? "unchecked" : FOUND_GRADES.has(grade) ? "also" : "wrong";
      }
    }
    retry = null;
    return null;
  }

  // The review bar under the coach: ‹ the moment in focus › and, at a mistake
  // with a better move, Retry.
  function paintReviewBar() {
    const bar = typeof document !== "undefined" && document.getElementById("coach-review");
    if (!bar) return;
    const report = getReport();
    if (report !== lastReport) {
      lastReport = report;
      pgnDirty = false;
    }
    const moments = report?.moments || [];
    if (!moments.length) {
      retry = null;
      bar.hidden = true;
      bar.replaceChildren();
      syncActionButton(null);
      return;
    }
    const ply = reviewPly();
    const state = reviewState(moments, ply);
    syncActionButton(pgnDirty ? null : state);
    const m = state.focus;
    if (!state.current) retry = null;
    const tried = state.current ? triedState(m) : null;
    const step = (kind) => html`<button type="button" class="cr-step" data-review="${kind}" aria-label="${kind === "prev" ? "Previous key moment" : "Next key moment"}" title="${kind === "prev" ? "Previous key moment (Shift+←)" : "Next key moment (Shift+→)"}"${state[kind] ? "" : " disabled"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STEP_ICON[kind]}"/></svg></button>`;
    const kind = m.grade ? GRADE_WORD[m.grade] : "Left prep";
    const glyph = m.grade ? classBadgeSymbol(m.move?.classification) : "";
    const words = {
      try: `Find a better move than ${m.move.san}`,
      right: `${m.best?.san} is the best move`,
      also: `As good as ${m.best?.san}`,
      checking: "Checking that move…",
      unchecked: "Could not check that move",
      wrong: "Not the best move",
    }[tried] || `${state.current ? "" : m.ply > ply ? "Next: " : "Back to "}${m.label} ${kind}`;
    const canFix = m.loss != null && m.best && (state.current || tried);
    const found = tried === "right" || tried === "also";
    const actions = canFix && tried !== "try" && !found
      ? html`<button type="button" class="btn sm" data-review="retry" title="Find the better move yourself">Retry</button>`
      : "";
    bar.hidden = false;
    bar.dataset.ply = String(m.ply);
    bar.dataset.onMoment = state.current && !tried ? "true" : "false";
    // On the moment itself the move is the title: "9…b5??" then its grade.
    const label = tried ? html`<span class="cr-text">${words}</span>`
      : state.current ? html`<span class="cr-move">${m.label}<i aria-hidden="true">${glyph}</i></span><span class="cr-text">${kind}</span>`
        : html`<i class="rp-glyph" aria-hidden="true">${glyph}</i><span class="cr-text">${words}</span>`;
    bar.innerHTML = html`<button type="button" class="cr-label g-${m.grade || "none"}${found ? " is-right" : tried === "wrong" ? " is-wrong" : ""}" data-review="go" title="${words}">${label}<span class="cr-count">${state.index + 1}/${state.count}</span></button>${actions}${step("prev")}${step("next")}`;
    if (!bar.dataset.bound) {
      bar.dataset.bound = "1";
      bar.addEventListener("click", (event) => {
        const btn = event.target.closest?.("[data-review]");
        if (btn && !btn.disabled) void reviewAction(btn.dataset.review, Number(bar.dataset.ply)).catch(() => {});
      });
    }
  }

  async function reviewAction(kind, ply) {
    if (kind === "prev" || kind === "next") {
      retry = null;
      return reviewStep(kind);
    }
    const moment = getReport()?.moments?.find((m) => m.ply === ply);
    if (!moment) return;
    if (kind === "go") {
      retry = null;
      return showAnalysisPly(ply);
    }
    const fromId = analysisState.analysisTree?.byId?.get(`m${ply}`)?.parent?.id;
    if (!fromId || !moment.best) return;
    if (kind === "retry") {
      retry = { fromId, best: moment.best.uci, san: moment.best.san, ply };
      await selectAnalysisNode(fromId);
      paintReviewBar();
    }
  }

  // `kind` is "next" or "prev".
  function reviewStep(kind) {
    const target = reviewState(getReport()?.moments, reviewPly())[kind];
    if (target) showAnalysisPly(target.ply);
  }

  // Context-aware primary CTA once a game is reviewed: step to the next key
  // moment, wrapping cleanly to the first when already at the end.
  function stepOrWrap() {
    const moments = getReport()?.moments || [];
    if (!moments.length) return false;
    const state = reviewState(moments, reviewPly());
    const target = state.next || moments[0];
    retry = null;
    showAnalysisPly(target.ply);
    if (typeof globalThis.innerWidth === "number" && globalThis.innerWidth <= 760) {
      selectPane?.("coach");
    }
    return true;
  }

  return { paint: paintReviewBar, step: reviewStep, stepOrWrap };
}
