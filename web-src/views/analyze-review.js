import { html } from "../html.js";
import { classBadgeSymbol } from "../move-grades.js";
import { reviewState } from "./analyze-report.js";

// The review bar under the coach (Chess.com's Next and Retry): step to the
// previous or next key moment of the report, and at a mistake try to find the
// better move on the board. The engine's own line already shows that move.
export function createReviewBar({ appState, getReport, showAnalysisPly, selectAnalysisNode }) {
  // A Retry in progress: the position before the moment (`fromId`), the move
  // the engine wanted there, and the moment's ply. It ends when the reader
  // leaves that position and its replies.
  let retry = null;
  const STEP_ICON = { prev: "M15 5l-7 7 7 7", next: "M9 5l7 7-7 7" };
  const GRADE_WORD = { brilliant: "Brilliant", great: "Great", mistake: "Mistake", blunder: "Blunder" };

  // The game ply the review reads from: a branch counts as the move it
  // replaces, so a line played at a moment keeps that moment in focus.
  function reviewPly() {
    const id = appState.analysisCurrentNodeId || "root";
    if (retry && id === retry.fromId) return retry.ply;
    let node = appState.analysisTree?.byId?.get(id);
    if (!node || node.isMainline) return Number(appState.analysisPly) || 0;
    while (node.parent && !node.parent.isMainline) node = node.parent;
    return (Number(node.parent?.ply) || 0) + 1;
  }

  // "try" at the Retry position, "right" on the engine's move played there,
  // "wrong" on another move played during a Retry.
  function triedState(moment) {
    const id = appState.analysisCurrentNodeId || "root";
    if (retry && id === retry.fromId) return "try";
    const node = appState.analysisTree?.byId?.get(id);
    const best = moment?.best?.uci;
    if (best && node?.isVariation && node.parent?.id === `m${moment.ply - 1}`.replace(/^m0$/, "root")) {
      if (node.uci === best) return "right";
      if (retry) return "wrong";
    }
    retry = null;
    return null;
  }

  // The review bar under the coach: ‹ the moment in focus › and, at a mistake
  // with a better move, Retry.
  function paintReviewBar() {
    const bar = typeof document !== "undefined" && document.getElementById("coach-review");
    if (!bar) return;
    const moments = getReport()?.moments || [];
    if (!moments.length) {
      retry = null;
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    const ply = reviewPly();
    const state = reviewState(moments, ply);
    const m = state.focus;
    if (!state.current) retry = null;
    const tried = state.current ? triedState(m) : null;
    const step = (kind) => html`<button type="button" class="cr-step" data-review="${kind}" aria-label="${kind === "prev" ? "Previous key moment" : "Next key moment"}" title="${kind === "prev" ? "Previous key moment (Shift+←)" : "Next key moment (Shift+→)"}"${state[kind] ? "" : " disabled"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STEP_ICON[kind]}"/></svg></button>`;
    const kind = m.grade ? GRADE_WORD[m.grade] : "Left prep";
    const glyph = m.grade ? classBadgeSymbol(m.move?.classification) : "";
    const words = {
      try: `Find a better move than ${m.move.san}`,
      right: `${m.best?.san} is the best move`,
      wrong: "Not the best move",
    }[tried] || `${state.current ? "" : m.ply > ply ? "Next: " : "Back to "}${m.label} ${kind}`;
    const canFix = m.loss != null && m.best && (state.current || tried);
    const actions = canFix && tried !== "try" && tried !== "right"
      ? html`<button type="button" class="btn sm" data-review="retry" title="Find the better move yourself">Retry</button>`
      : "";
    bar.hidden = false;
    bar.dataset.ply = String(m.ply);
    bar.innerHTML = html`${step("prev")}<button type="button" class="cr-label g-${m.grade || "none"}${tried === "right" ? " is-right" : tried === "wrong" ? " is-wrong" : ""}" data-review="go" title="${words}">${tried ? "" : html`<i class="rp-glyph" aria-hidden="true">${glyph}</i>`}<span class="cr-text">${words}</span><span class="cr-count">${state.index + 1}/${state.count}</span></button>${step("next")}${actions}`;
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
    const fromId = appState.analysisTree?.byId?.get(`m${ply}`)?.parent?.id;
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

  return { paint: paintReviewBar, step: reviewStep };
}
