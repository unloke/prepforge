// Standalone mistake-retry state machine for Analyze ("Learn from your mistakes").
// Drives the real board directly (piece slides, move-grade badges, animated
// snapbacks, reveal arrows, follow-up PV playback, and red-vs-green recap
// comparison arrows) — never hover-peek (`board.peek()`).
import { localBoardAfterMove } from "./chess-local.js";
import { positionKey } from "./board/move-motion.js";
import { classBadgeSymbol } from "./move-grades.js";
import { onTriedGrade, triedGrade, UNGRADED } from "./analyze-tried-grade.js";
import {
  continuationSteps, describeRetryAnswer, describeRetryHint, GRADE_WORD,
  legalMovesAt, prevMoveInfo, promptSub, RETRY_ERROR_GRADES, retryExercises,
  retryPlan, retryStats, wrongGradeDetail,
} from "./analyze-retry-plan.js";

export {
  continuationSteps, describeRetryAnswer, describeRetryHint, GRADE_WORD,
  RETRY_ERROR_GRADES, retryExercises, retryPlan, retryStats,
};

const FOUND_GRADES = new Set(["best", "great", "brilliant", "forced"]);
const preIdFor = (ply) => (ply <= 1 ? "root" : `m${ply - 1}`);

export function createAnalyzeRetry({
  analysisState, getReport, currentNodeId, reviewPly, showAnalysisPly, selectAnalysisNode, selectPane,
  isPhone = () => false, clearHoverPeek = () => {}, renderBoard = () => {}, gradeAttempt = () => {},
  setBlind = () => {}, setBoardOverlay = () => {}, onPaint = () => {},
  selectHintSquare = () => {}, setHintArrow = () => {}, setComparisonArrows = () => {},
  getOrientation = () => null, setOrientation = () => {}, playCue = () => {},
  canTrainPrep = () => false, recordPrepMiss = null,
}) {
  let replay = null;
  let actionSeq = 0;

  function clearTimers(session) {
    for (const key of ["timer", "snapTimer", "followTimer"]) {
      if (session?.[key]) clearTimeout(session[key]);
      if (session) session[key] = null;
    }
  }

  function clearAssists() {
    selectHintSquare(null);
    setHintArrow(null);
    setComparisonArrows([]);
    setBoardOverlay({ arrow: false, badge: false });
  }

  function restoreSessionPosition(session) {
    if (!session || session.analysis !== analysisState.analysis || currentNodeId() !== session.preId) return;
    void selectAnalysisNode(session.preId).catch(() => {});
  }

  function exit({ repaint = true, restore = true } = {}) {
    const session = replay;
    if (!session) return;
    actionSeq += 1;
    clearTimers(session);
    replay = null;
    clearAssists();
    clearHoverPeek();
    if (session.autoOrient && session.savedOrientation) setOrientation(session.savedOrientation);
    setBlind(false);
    if (repaint) onPaint();
    if (restore) restoreSessionPosition(session);
  }

  function paintPreBoard(session, { back = false } = {}) {
    if (!session?.preFen) return;
    renderBoard({
      fen: session.preFen,
      legalMoves: legalMovesAt(session.preFen),
      lastMove: prevMoveInfo(session.analysis, session.item.ply).uci,
      badge: null,
      back,
    });
  }

  function prepareItem(session, index) {
    const item = session.sequence[index];
    Object.assign(session, {
      index, item, preId: preIdFor(item.ply), preFen: item.move?.fen_before,
      phase: "guess", mistake: false, tries: 0, hintLevel: 0, attempt: null,
      followingUp: false, feedback: "", sub: promptSub(session.analysis, item),
    });
  }

  async function selectPrePosition(session) {
    const token = ++actionSeq;
    clearTimers(session);
    session.entering = true;
    session.phase = "loading";
    clearAssists();
    clearHoverPeek();
    if (session.autoOrient && session.item?.side) setOrientation(session.item.side);
    setBlind(true);
    onPaint();
    try {
      const ok = await selectAnalysisNode(session.preId);
      if (replay !== session || token < actionSeq) return;
      if (ok === false) await showAnalysisPly(Math.max(0, session.item.ply - 1));
    } catch {
      if (replay === session && token >= actionSeq) exit({ restore: false });
      return;
    }
    if (replay !== session || token < actionSeq) return;
    clearAssists();
    paintPreBoard(session);
    Object.assign(session, {
      entering: false, phase: "guess", mistake: false, attempt: null,
      followingUp: false, sub: promptSub(session.analysis, session.item),
    });
    onPaint();
  }

  async function launchSequence(sequence, { round = 1, initialSequence = sequence } = {}) {
    if (!sequence.length) return;
    const savedOrientation = replay?.savedOrientation ?? getOrientation();
    const autoOrient = !getReport()?.selfSide;
    exit({ repaint: false, restore: false });
    if (isPhone()) selectPane?.("coach", { store: false });
    replay = {
      analysis: analysisState.analysis, initialSequence, sequence, round,
      outcomes: sequence.map(() => null), index: 0, inspectIndex: 0, item: sequence[0],
      preId: preIdFor(sequence[0].ply), preFen: sequence[0].move?.fen_before,
      phase: "loading", entering: true, advancing: false, mistake: false, followingUp: false,
      tries: 0, hintLevel: 0, feedback: "", sub: promptSub(analysisState.analysis, sequence[0]),
      attempt: null, attemptSeq: 0, gradingSeq: 0, timer: null, snapTimer: null, followTimer: null,
      autoOrient, savedOrientation,
      canTrainPrep: Boolean(canTrainPrep() && recordPrepMiss), prepSaved: false, prepSaving: false,
    };
    await selectPrePosition(replay);
  }

  async function start() {
    const report = getReport();
    const { exercises } = retryPlan(report?.moments || [], reviewPly(), report?.selfSide);
    await launchSequence(exercises, { round: 1, initialSequence: exercises });
  }

  function showRecapPosition(session, idx) {
    const item = session.sequence[idx];
    const fen = item?.move?.fen_before;
    if (!item || !fen) return;
    session.inspectIndex = idx;
    if (session.autoOrient && item.side) setOrientation(item.side);
    renderBoard({ fen, legalMoves: [], lastMove: prevMoveInfo(session.analysis, item.ply).uci, badge: null });
    const arrows = [];
    if (item.move?.uci) arrows.push(`R${item.move.uci.slice(0, 4)}`);
    if (item.answers?.[0]?.uci) arrows.push(`G${item.answers[0].uci.slice(0, 4)}`);
    setComparisonArrows(arrows);
    setBoardOverlay({ arrow: arrows.length > 0, badge: false });
  }

  function completePractice(session) {
    if (replay !== session) return;
    clearTimers(session);
    clearAssists();
    const firstMissed = session.outcomes.findIndex((o) => o !== "clean");
    const focusIdx = firstMissed >= 0 ? firstMissed : Math.max(0, session.sequence.length - 1);
    const { total, clean, recovered, missed } = retryStats(session);
    const parts = [`${clean} / ${total} first try`];
    if (clean < total && recovered) parts.push(`${recovered} recovered`);
    if (clean < total && missed) parts.push(`${missed} missed`);
    Object.assign(session, { phase: "complete", attempt: null, followingUp: false, sub: parts.join(" · ") });
    showRecapPosition(session, focusIdx);
    playCue("complete");
    onPaint();
  }

  async function advancePractice(session) {
    if (replay !== session || session.advancing) return;
    clearTimers(session);
    if (session.index + 1 >= session.sequence.length) return completePractice(session);
    session.advancing = true;
    prepareItem(session, session.index + 1);
    await selectPrePosition(session);
    if (replay === session) session.advancing = false;
  }

  function scheduleAdvance(session, ms = 700) {
    clearTimers(session);
    session.timer = setTimeout(() => {
      if (replay !== session) return;
      session.timer = null;
      if (session.analysis !== analysisState.analysis || currentNodeId() !== session.preId) {
        exit({ restore: false });
        return;
      }
      void advancePractice(session);
    }, ms);
  }

  function answerDetail(session, uci, san) {
    const steps = continuationSteps(session.analysis, session.preFen, uci);
    const line = steps.length > 1 ? `Line: ${steps.slice(1).map((s) => s.label).join(" ")}` : "";
    const parts = [describeRetryAnswer(session.preFen, uci, san), line].filter(Boolean);
    if (!parts.length && session.item.kind === "prep" && session.item.repName) return `In ${session.item.repName}`;
    return parts.join(" ");
  }

  function landMoveOnBoard(fenAfter, uci, grade = "best") {
    const glyph = grade ? classBadgeSymbol(grade) : "";
    setBoardOverlay({ arrow: false, badge: Boolean(grade) });
    renderBoard({
      fen: fenAfter,
      legalMoves: [],
      lastMove: uci,
      badge: grade ? { square: uci.slice(2, 4), classification: grade, label: glyph } : null,
      cue: false,
    });
  }

  function succeed(session, feedback, uci, san, badgeGrade = "best") {
    const attempt = session.attempt;
    clearTimers(session);
    session.outcomes[session.index] = session.tries === 0 && session.hintLevel === 0 ? "clean" : "recovered";
    Object.assign(session, { phase: "success", feedback, sub: answerDetail(session, uci, san), mistake: false });
    selectHintSquare(null);
    setHintArrow(null);
    setComparisonArrows([]);
    if (attempt) landMoveOnBoard(attempt.fenAfter, attempt.uci, badgeGrade);
    playCue("right");
    onPaint();
    scheduleAdvance(session, 700);
  }

  function wrong(session, feedback, detail = "", badGrade = "mistake") {
    const attempt = session.attempt;
    const firstUci = session.item?.answers?.[0]?.uci;
    const keepHint = session.hintLevel >= 1 && firstUci ? describeRetryHint(session.preFen, firstUci) : "";
    clearTimers(session);
    session.tries += 1;
    Object.assign(session, {
      phase: "guess", feedback, sub: [detail, keepHint].filter(Boolean).join(" · "),
      mistake: true, attempt: null,
    });
    selectHintSquare(null);
    setHintArrow(null);
    if (attempt) {
      landMoveOnBoard(attempt.fenAfter, attempt.uci, badGrade);
      session.snapTimer = setTimeout(() => {
        if (replay !== session || session.phase !== "guess") return;
        session.snapTimer = null;
        setBoardOverlay({ arrow: false, badge: false });
        paintPreBoard(session, { back: true });
        if (session.hintLevel >= 1 && firstUci) selectHintSquare(firstUci.slice(0, 2));
      }, 520);
    } else {
      setBoardOverlay({ arrow: false, badge: false });
      paintPreBoard(session, { back: true });
      if (session.hintLevel >= 1 && firstUci) selectHintSquare(firstUci.slice(0, 2));
    }
    playCue("wrong");
    onPaint();
  }

  function evaluateAttempt(session) {
    const attempt = session.attempt;
    if (!attempt || replay !== session) return;
    const item = session.item;
    if (item.kind === "prep") {
      if (item.answers.some((a) => a.uci === attempt.uci)) {
        succeed(session, `${attempt.san} is a prepared move`, attempt.uci, attempt.san, "best");
      } else {
        wrong(session, "That's not in your repertoire. What did you prepare?",
          `Played ${attempt.san}${item.repName ? ` · left ${item.repName}` : ""}`, "inaccuracy");
      }
      return;
    }
    const best = item.answers[0];
    if (attempt.uci === best.uci) return succeed(session, `${best.san} is the best move`, best.uci, best.san, "best");
    if (attempt.uci === item.move?.uci) {
      const word = GRADE_WORD[item.grade] || "Mistake";
      return wrong(session, "What else would you try?", `Played ${attempt.san} in the game (${word})`, item.grade || "mistake");
    }
    const grade = triedGrade(attempt.fenBefore, attempt.uci);
    if (grade && grade !== UNGRADED) {
      if (FOUND_GRADES.has(grade)) succeed(session, `As good as ${best.san}`, attempt.uci, attempt.san, grade);
      else wrong(session, "What else would you try?", wrongGradeDetail(attempt.san, grade), grade);
      return;
    }
    if (grade === UNGRADED) return wrong(session, "Not graded. What else would you try?", `Played ${attempt.san}`, null);
    Object.assign(session, {
      phase: "checking", gradingSeq: attempt.seq, feedback: "Checking that move…", sub: `Evaluating ${attempt.san}`,
    });
    landMoveOnBoard(attempt.fenAfter, attempt.uci, null);
    gradeAttempt(attempt.fenAfter, {
      fen: attempt.fenAfter, prevFen: attempt.fenBefore, lastUci: attempt.uci, lastSan: attempt.san, ply: null,
    });
    onPaint();
  }

  onTriedGrade((fenBefore, uci) => {
    const s = replay;
    if (s?.attempt && s.phase === "checking" && s.attempt.seq === s.gradingSeq
      && s.attempt.fenBefore === fenBefore && s.attempt.uci === uci) {
      evaluateAttempt(s);
    }
  });

  function tryMove(uci, fen) {
    const session = replay;
    if (!session) return false;
    if (currentNodeId() !== session.preId || session.entering || session.advancing) return true;
    if (session.phase === "revealed" && positionKey(fen) === positionKey(session.preFen)) {
      if (session.item.answers?.some((a) => a.uci === uci)) {
        try {
          const after = localBoardAfterMove(session.preFen, uci);
          clearAssists();
          landMoveOnBoard(after.board.fen, uci, "best");
          playCue("right");
          scheduleAdvance(session, 420);
        } catch { /* ignore */ }
      }
      return true;
    }
    if ((session.phase !== "guess" && session.phase !== "checking") || positionKey(fen) !== positionKey(session.preFen)) {
      return true;
    }
    clearTimers(session);
    let after;
    try { after = localBoardAfterMove(session.preFen, uci); } catch { return true; }
    session.attemptSeq += 1;
    session.attempt = { uci, san: after.move.san, fenBefore: session.preFen, fenAfter: after.board.fen, seq: session.attemptSeq };
    session.mistake = false;
    evaluateAttempt(session);
    return true;
  }

  function showHint() {
    const session = replay;
    const first = session?.item?.answers?.[0];
    if (!session || session.phase !== "guess" || session.hintLevel >= 1 || !first?.uci) return;
    clearTimers(session);
    setBoardOverlay({ arrow: false, badge: false });
    paintPreBoard(session);
    Object.assign(session, { hintLevel: 1, mistake: false, sub: describeRetryHint(session.preFen, first.uci) });
    selectHintSquare(first.uci.slice(0, 2));
    onPaint();
  }

  function reveal() {
    const session = replay;
    if (!session || session.phase === "complete") return;
    clearTimers(session);
    const { item } = session;
    const answers = item.answers || [];
    const first = answers[0];
    const followSteps = first ? continuationSteps(session.analysis, session.preFen, first.uci) : [];
    session.outcomes[session.index] = "missed";
    Object.assign(session, {
      phase: "revealed", attempt: null, followingUp: false, followSteps,
      feedback: item.kind === "prep"
        ? `Your repertoire: ${answers.map((a) => a.san).join(" / ")}`
        : `Best move: ${first?.san || ""}`,
      sub: first ? `${answerDetail(session, first.uci, first.san)} Play it or continue.`.trim() : "",
    });
    selectHintSquare(null);
    setComparisonArrows([]);
    paintPreBoard(session);
    if (first?.uci) {
      setHintArrow(first.uci);
      setBoardOverlay({ arrow: true, badge: false });
    }
    onPaint();
  }

  function playFollowUp() {
    const session = replay;
    const steps = session?.followSteps;
    if (!session || session.phase !== "revealed" || !steps?.length || session.followingUp) return;
    clearTimers(session);
    session.followingUp = true;
    selectHintSquare(null);
    setHintArrow(null);
    let i = 0;
    const step = () => {
      if (replay !== session || session.phase !== "revealed") return;
      const cur = steps[i];
      landMoveOnBoard(cur.fen, cur.uci, i === 0 ? "best" : null);
      i += 1;
      if (i < steps.length) session.followTimer = setTimeout(step, 340);
      else { session.followTimer = null; session.followingUp = false; onPaint(); }
    };
    onPaint();
    step();
  }

  async function trainPrep() {
    const session = replay;
    if (!session || session.prepSaved || session.prepSaving || !recordPrepMiss) return;
    const target = session.phase === "complete" ? retryStats(session).prepTarget : session.item?.kind === "prep" ? session.item : null;
    if (!target?.repId || !target?.prescribedNodeId) return;
    session.prepSaving = true;
    onPaint();
    try {
      const ok = await recordPrepMiss(target);
      if (replay === session && ok !== false) session.prepSaved = true;
    } finally {
      if (replay === session) { session.prepSaving = false; onPaint(); }
    }
  }

  async function action(kind, indexArg = null) {
    if (kind === "retry") return start();
    if (!replay) return;
    if (kind === "hint") return showHint();
    if (kind === "show-move") return reveal();
    if (kind === "follow-up") return playFollowUp();
    if (kind === "inspect" && replay.phase === "complete" && Number.isInteger(indexArg)) {
      showRecapPosition(replay, indexArg);
      onPaint();
      return;
    }
    if (kind === "skip" && (replay.phase === "guess" || replay.phase === "checking")) {
      replay.outcomes[replay.index] = "missed";
      return advancePractice(replay);
    }
    if (kind === "exit") return exit();
    if (kind === "continue") return advancePractice(replay);
    if (kind === "back-analysis") {
      const targetItem = replay.sequence[replay.inspectIndex] || replay.item;
      const ply = targetItem.ply;
      exit({ repaint: true, restore: false });
      return showAnalysisPly(ply);
    }
    if (kind === "retry-missed") {
      return launchSequence(retryStats(replay).retryable, { round: replay.round + 1, initialSequence: replay.initialSequence });
    }
    if (kind === "retry-all") {
      return launchSequence(replay.initialSequence, { round: 1, initialSequence: replay.initialSequence });
    }
    if (kind === "train-prep") return trainPrep();
  }

  function reconcile() {
    if (!replay) return false;
    if (replay.analysis !== analysisState.analysis || (!replay.entering && currentNodeId() !== replay.preId)) {
      exit({ repaint: false, restore: false });
      return false;
    }
    return true;
  }

  return { get session() { return replay; }, start, action, exit, reconcile, tryMove };
}
