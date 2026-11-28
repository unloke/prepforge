import { html } from "../html.js";
import { reviewState } from "./analyze-report.js";
import { classBadgeSymbol } from "../move-grades.js";
import { onTriedGrade, triedGrade, UNGRADED } from "../analyze-tried-grade.js";
import { localBoardAfterMove } from "../chess-local.js";
import { positionKey } from "../board/move-motion.js";
import { retryPracticeControls } from "./analyze-retry-controls.js";

function nextMoment(moments, state) {
  return state.next ?? (state.current && moments.length === 1 ? null : moments[0] || null);
}

const REVIEW_ICON = {
  prev: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  retry: "M4 11a8 8 0 1 1 2 6M4 5v6h6",
};
const GRADE_WORD = { brilliant: "Brilliant", great: "Great", mistake: "Mistake", blunder: "Blunder" };
const FOUND_GRADES = new Set(["best", "great", "brilliant", "forced"]);
// The practice queue is strictly ahead of the position being browsed. A known
// player's session drills only their own moves; with the side unknown the old
// ordinary engine exercise set is unchanged. A personal missed preparation
// outranks the independent engine verdict on the same move.
export function retryExercises(moments, ply, selfSide) {
  return moments
    .filter((m) => m.ply > ply && (!selfSide || selfSide === m.side))
    .flatMap((m) => {
      if (m.preparedMoves?.length && m.by === "you") return [{ ...m, kind: "prep", answers: m.preparedMoves }];
      if (["mistake", "blunder"].includes(m.grade) && m.best?.uci) return [{ ...m, kind: "engine", answers: [m.best] }];
      return [];
    });
}


// Key-moment browsing plus the blind practice session. Only an explicit Retry
// conceals the analysis: the bar's ordinary previous/next navigation is just
// navigation and leaves the engine, coach and report available.
export function createReviewBar({
  analysisState,
  getReport,
  showAnalysisPly,
  selectAnalysisNode,
  selectPane,
  isPhone = () => typeof globalThis.innerWidth === "number" && globalThis.innerWidth <= 760,
  previewPosition = () => {},
  gradeAttempt = () => {},
}) {
  let pgnDirty = false;
  let lastReport = null;
  let replay = null;
  let actionSeq = 0;

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
    }
  }

  function currentNodeId() {
    return analysisState.analysisCurrentNodeId || "root";
  }

  function clearTimer(session) {
    if (session?.timer) clearTimeout(session.timer);
    if (session) session.timer = null;
  }

  function restoreSessionPosition(session) {
    if (!session || session.analysis !== analysisState.analysis) return;
    if (currentNodeId() !== session.preId) return;
    void selectAnalysisNode(session.preId).catch(() => {});
  }

  function exitReplay({ repaint = true, restore = true } = {}) {
    const session = replay;
    if (!session) return;
    actionSeq += 1;
    clearTimer(session);
    replay = null;
    previewPosition(null);
    setBlind(false);
    if (repaint) paintReviewBar();
    if (restore) restoreSessionPosition(session);
  }

  function endReview() {
    if (!replay) return;
    exitReplay({ restore: false });
  }

  onTriedGrade((fenBefore, uci) => {
    const session = replay;
    if (!session?.attempt || session.phase !== "checking") return;
    if (session.attempt.seq !== session.gradingSeq) return;
    if (session.attempt.fenBefore !== fenBefore || session.attempt.uci !== uci) return;
    evaluateAttempt(session);
  });

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
        exitReplay({ restore: false });
        syncActionButton(null);
      });
    }
  }

  function reviewPly() {
    const id = currentNodeId();
    let node = analysisState.analysisTree?.byId?.get(id);
    if (!node || node.isMainline) return Number(analysisState.analysisPly) || 0;
    while (node.parent && !node.parent.isMainline) node = node.parent;
    return (Number(node.parent?.ply) || 0) + 1;
  }

  function preIdFor(ply) {
    return ply <= 1 ? "root" : `m${ply - 1}`;
  }

  function icon(name) {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${REVIEW_ICON[name]}"/></svg>`;
  }
  const grade = (moment) => GRADE_WORD[moment.grade] || "Left prep";
  const describe = (moment) => `${moment.label}, ${grade(moment)}`;

  function openCoachOnPhone() {
    if (isPhone()) selectPane?.("coach", { store: false });
  }

  async function selectPrePosition(session) {
    const token = ++actionSeq;
    clearTimer(session);
    session.entering = true;
    session.phase = "loading";
    previewPosition(null);
    setBlind(true);
    paintReviewBar();
    try {
      const ok = await selectAnalysisNode(session.preId);
      if (replay !== session || token < actionSeq) return;
      if (ok === false) await showAnalysisPly(Math.max(0, session.item.ply - 1));
    } catch {
      if (replay === session && token >= actionSeq) exitReplay({ restore: false });
      return;
    }
    if (replay !== session || token < actionSeq) return;
    session.entering = false;
    session.phase = "guess";
    session.mistake = false;
    session.attempt = null;
    paintReviewBar();
  }

  async function startReplay() {
    const report = getReport();
    const moments = report?.moments || [];
    const sequence = retryExercises(moments, reviewPly(), report?.selfSide);
    if (!sequence.length) return;
    exitReplay({ repaint: false, restore: false });
    openCoachOnPhone();
    replay = {
      analysis: analysisState.analysis,
      sequence,
      index: 0,
      item: sequence[0],
      preId: preIdFor(sequence[0].ply),
      preFen: sequence[0].move?.fen_before,
      phase: "loading",
      entering: true,
      mistake: false,
      attempt: null,
      attemptSeq: 0,
      gradingSeq: 0,
      timer: null,
    };
    await selectPrePosition(replay);
  }

  function prepareItem(session, index) {
    session.index = index;
    session.item = session.sequence[index];
    session.preId = preIdFor(session.item.ply);
    session.preFen = session.item.move?.fen_before;
    session.phase = "guess";
    session.mistake = false;
    session.attempt = null;
  }

  function completePractice(session) {
    if (replay !== session) return;
    clearTimer(session);
    session.phase = "complete";
    session.attempt = null;
    paintReviewBar();
  }

  async function advancePractice(session) {
    if (replay !== session || session.advancing) return;
    if (session.index + 1 >= session.sequence.length) {
      completePractice(session);
      return;
    }
    session.advancing = true;
    prepareItem(session, session.index + 1);
    await selectPrePosition(session);
    if (replay === session) session.advancing = false;
  }

  function scheduleAdvance(session) {
    clearTimer(session);
    session.timer = setTimeout(() => {
      if (replay !== session) return;
      session.timer = null;
      if (session.analysis !== analysisState.analysis || currentNodeId() !== session.preId) {
        exitReplay({ restore: false });
        return;
      }
      void advancePractice(session);
    }, 700);
  }

  function succeed(session, feedback) {
    const attempt = session.attempt;
    session.phase = "success";
    session.feedback = feedback;
    session.mistake = false;
    if (attempt) previewPosition({ fen: attempt.fenAfter, lastMove: attempt.uci });
    paintReviewBar();
    scheduleAdvance(session);
  }

  function wrong(session, feedback) {
    session.phase = "guess";
    session.feedback = feedback;
    session.mistake = true;
    session.attempt = null;
    previewPosition(null);
    paintReviewBar();
  }

  function evaluateAttempt(session) {
    const attempt = session.attempt;
    if (!attempt || replay !== session) return;
    const item = session.item;
    if (item.kind === "prep") {
      if (item.answers.some((answer) => answer.uci === attempt.uci)) {
        succeed(session, `${attempt.san} is a prepared move`);
      } else {
        wrong(session, "That's not in your repertoire. What did you prepare?");
      }
      return;
    }

    const best = item.answers[0];
    if (attempt.uci === best.uci) {
      succeed(session, `${best.san} is the best move`);
      return;
    }
    if (attempt.uci === item.move?.uci) {
      wrong(session, "What else would you try?");
      return;
    }
    const grade = triedGrade(attempt.fenBefore, attempt.uci);
    if (grade && grade !== UNGRADED) {
      if (FOUND_GRADES.has(grade)) succeed(session, `As good as ${best.san}`);
      else wrong(session, "What else would you try?");
      return;
    }
    if (grade === UNGRADED) {
      wrong(session, "Not graded. What else would you try?");
      return;
    }
    session.phase = "checking";
    session.gradingSeq = attempt.seq;
    session.feedback = "Checking that move…";
    gradeAttempt(attempt.fenAfter, {
      fen: attempt.fenAfter,
      prevFen: attempt.fenBefore,
      lastUci: attempt.uci,
      lastSan: attempt.san,
      ply: null,
    });
    paintReviewBar();
  }

  // Consume board input for the live drill before analysis turns it into a
  // variation. The real analysis node stays at the exercise's pre-position;
  // only a correct or revealed answer is previewed with board.peek().
  function attemptMove(uci, fen) {
    const session = replay;
    if (!session) return false;
    if (currentNodeId() !== session.preId || positionKey(fen) !== positionKey(session.preFen)) return true;
    if (session.entering || session.advancing || session.phase !== "guess" && session.phase !== "checking") return true;
    previewPosition(null);
    let after;
    try {
      after = localBoardAfterMove(fen, uci);
    } catch {
      return true;
    }
    session.attemptSeq += 1;
    session.attempt = {
      uci,
      san: after.move.san,
      fenBefore: fen,
      fenAfter: after.board.fen,
      seq: session.attemptSeq,
    };
    session.mistake = false;
    evaluateAttempt(session);
    return true;
  }

  function revealReplay() {
    const session = replay;
    if (!session || session.phase === "complete") return;
    const item = session.item;
    const answers = item.answers || [];
    session.phase = "revealed";
    session.feedback = item.kind === "prep"
      ? `Your repertoire: ${answers.map((answer) => answer.san).join(" / ")}`
      : `Best move: ${answers[0]?.san || ""}`;
    session.attempt = null;
    const first = answers[0];
    try {
      if (first) {
        const after = localBoardAfterMove(session.preFen, first.uci);
        previewPosition({ fen: after.board.fen, lastMove: first.uci });
      }
    } catch {
      previewPosition(null);
    }
    paintReviewBar();
  }

  async function finishToAnalysis() {
    const session = replay;
    if (!session) return;
    const ply = session.item.ply;
    exitReplay({ repaint: true, restore: false });
    await showAnalysisPly(ply);
  }

  function browseControls(state, moments, m) {
    const upcoming = nextMoment(moments, state);
    const returnToLast = !state.next && !state.current;
    const target = upcoming;
    const report = getReport();
    const exercises = retryExercises(moments, reviewPly(), report?.selfSide);
    const disabled = exercises.length ? "" : " disabled";
    const retryTitle = exercises.length ? "Practice the next positions" : "No more retry positions ahead";
    const retryLabel = exercises.length ? "Retry positions" : "No retry positions ahead";
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
      <button type="button" class="cr-control cr-retry" data-review="retry" aria-label="${retryLabel}" title="${retryTitle}"${disabled}>${icon("retry")}<span>Retry</span></button>`;
  }

  function replayControls() {
    return retryPracticeControls(replay);
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
      if (replay) exitReplay({ repaint: false, restore: false });
      setBlind(false);
      bar.hidden = true;
      bar.replaceChildren();
      syncActionButton(null);
      return;
    }
    if (replay && replay.analysis !== analysisState.analysis) exitReplay({ repaint: false, restore: false });
    if (replay && !replay.entering && currentNodeId() !== replay.preId) {
      exitReplay({ repaint: false, restore: false });
    }
    const ply = reviewPly();
    const state = reviewState(moments, ply);
    syncActionButton(pgnDirty || replay || !moments.length ? null : state, moments);
    if (replay) {
      bar.hidden = false;
      const focused = typeof document !== "undefined" && bar.contains?.(document.activeElement)
        ? document.activeElement?.dataset?.review
        : null;
      bar.dataset.ply = String(replay.item.ply);
      bar.innerHTML = html`<div class="cr-replay">${replayControls()}</div>`;
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
        void reviewAction(btn.dataset.review).catch(() => {});
      }
    });
  }

  async function reviewAction(kind) {
    if (kind === "prev" || kind === "next") return reviewStep(kind);
    if (kind === "retry") return startReplay();
    if (!replay) return;
    if (kind === "show-move") return revealReplay();
    if (kind === "exit") return exitReplay();
    if (kind === "continue") return advancePractice(replay);
    if (kind === "back-analysis") return finishToAnalysis();
  }

  function reviewStep(kind) {
    const session = replay;
    if (session) exitReplay({ repaint: false, restore: false });
    const moments = getReport()?.moments || [];
    const state = reviewState(moments, reviewPly());
    const target = kind === "next" ? nextMoment(moments, state) : state[kind];
    if (target) {
      void showAnalysisPly(target.ply).catch(() => {});
    } else if (session) {
      paintReviewBar();
      restoreSessionPosition(session);
    }
  }

  function stepOrWrap() {
    const session = replay;
    if (session) exitReplay({ repaint: false, restore: false });
    const moments = getReport()?.moments || [];
    if (!moments.length) return false;
    const state = reviewState(moments, reviewPly());
    const target = nextMoment(moments, state);
    if (!target) {
      if (session) {
        paintReviewBar();
        restoreSessionPosition(session);
      }
      return false;
    }
    void showAnalysisPly(target.ply).catch(() => {});
    return true;
  }

  return { paint: paintReviewBar, step: reviewStep, stepOrWrap, endReview, tryReviewMove: attemptMove };
}
