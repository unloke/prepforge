import { html } from "../html.js";
// Train sessions: the smart queue, line rehearsal, practice games and Feeling Lucky.
// Lazy-loaded by app.js the first time Train is used. Shared state and services
// come from their own modules; the shell's entry points from core/app-context.js.
//
// Smart queue (Train v2): a card-based scheduler client over /api/train/smart/*.
// Per card: run-in animation (the approach plays itself, the opponent's last
// move is the recall cue) → prompt. New cards are taught first; everything else
// is tested cold. First miss auto-hints and allows a retry (attempt 2, ungraded
// server-side); a second miss reveals the answer and the card returns a few
// positions later. Only attempt 1 is graded.

import { isAuthError } from "../auth-gate.js";
import { localBoardInfo, localPremoveMoves } from "../chess-local.js";
import { getSharedMaia3Provider } from "../engine/maia3-provider.js";
import { maiaErrorText, watchMaiaInit } from "../maia-init-notice.js";
import { pendingHandoffs, trackPreparationPractice, transitionHandoff } from "../handoff-context.js";
import { countOf } from "../plural.js";
import { coachTipMayReplace, promptCueSan, teachWhy, trainTeachLine, wrongMoveBanner, wrongMoveTip } from "../train-hint.js";
import { createTrainRecovery } from "../train-recovery.js";
import { pickOpponentReply, playPositionAfterReply, replyReasonNote, unavailableExplorer } from "../train-opponent.js";
import { playBookName, playTrailRows, playSessionPgn, resolvePlayColor, takebackToUserMove } from "../train-play.js";
import { beginLuckyDiscovery, finishLuckyDiscovery, luckyDiscoveryCurrent } from "../train-lucky-control.js";
import { createPlayMoveHandler } from "../train-play-input.js";
import { analysisRecallSeq, invalidateAnalysisSource } from "./analyze-entry.js";
import { isNothingToTrainError } from "../train-start.js";
import { planTrainRunIn, playTrainRunIn } from "../train-flow.js";
import { createTrainHome, invalidateTrainPreview, loadTrainRepertoireOptions, playBook, playPickerColor, playRepertoireMeta, selectedTrainRepertoireIds, setPlayPickerColor, showTrainResult, syncTrainScreen, trainRowError, trainScopeLabel } from "./train-home.js";
import { drillResult, playResult, smartResult } from "../train-result.js";
import { saveRun } from "../train-history.js";
import { restoreRehearsal, saveRehearsal } from "../train-rehearsal.js";
import { appState, buildState, trainState, boards, notices, START_FEN } from "../core/state.js";
import { api, currentOwnerId, localDateString, postJson, setStatus, setStatusError, sleep } from "../core/api.js";
import { effectiveMaiaRating } from "../core/prefs.js";
import { playSound } from "../core/sound.js";
import { boardAfterMove, boardInfo, optimisticBoardMove } from "../board/ui.js";
import { maiaPhaseCoach } from "../coach/coach-loader.js";
import { ensureExplorerClient } from "../build-entry.js";
import { ensureTrainView, renderTrainStats, setTrainSyncState } from "../train-entry.js";
import { hideBlitzClock, showBlitzClock } from "../train-blitz-clock.js";
import { accountService, flushTrainSync, hardFlushBuild, loadPgnIntoAnalyze, markTrainPositionDirty, openAuthModal,
  queueTrainAttempt, refreshAuthStatus, refreshDashboardRepertoires, refreshRepertoireHead, requireSignIn,
  runAnalysis, setTrainBanner, switchView, syncViewHeads, syncWorkspaceUrl, updateTrainTurnBadge } from "../core/app-context.js";

// The session's answer-recovery flow (train-recovery.js), bound to the
// session functions it repaints through.
const trainRecovery = createTrainRecovery({
  api, appState, trainState, boards, currentOwnerId, notices, setStatus, setStatusError,
  setTrainBanner, syncTrainSessionControls, renderTraining, finishTrainingSession,
});

const loadTrainResume = () => import("../train-resume.js");

// Blitz mode: an answer clock per card (smart queue only). Entirely
// client-side: a timeout submits the null move "0000" as attempt 1, so the
// server grades an honest first-attempt miss. Teach prompts and retries are
// untimed; the toggle is read once at session start.
const BLITZ_KEY = "prepforge-blitz";
export const BLITZ_SECONDS = 10;

export function blitzEnabled() {
  try {
    return localStorage.getItem(BLITZ_KEY) === "1";
  } catch {
    return false;
  }
}

export function setBlitzEnabled(on) {
  try {
    if (on) localStorage.setItem(BLITZ_KEY, "1");
    else localStorage.removeItem(BLITZ_KEY);
  } catch { /* private mode: the toggle just won't persist */ }
}

// Binds Train's Home screen (once, when app.js first loads Train) and returns
// the entry points the shell calls.
export function createTrainSession() {
  const entries = { clearBlitzTimer, onFeelingLucky, openPlayInAnalyze, resetTrainBoardIdle, resignPlaySession,
    setBlitzBarVisible, skipTrainingLine, startPlaySessionTracked, startTraining, takebackPlaySession, trainHint };
  const home = createTrainHome({ ...entries, blitzEnabled, setBlitzEnabled });
  return {
    ...entries, loadTrainRepertoireOptions, openTrain: home.openTrain, setPlayPickerColor, submitTrainingMove,
    syncTrainControls: syncTrainSessionControls,
  };
}

export async function skipTrainingLine() {
  if (trainState.play && trainState.play.active) {
    setStatus("Skip is for the spaced-repetition queue. Start or Random position to change position.");
    return;
  }
  if (trainState.smart) {
    await skipSmartCard();
    return;
  }
  if (trainState.trainBusy) return;
  const prompt = currentTrainingPrompt();
  if (!prompt) {
    setStatus("No active training line");
    return;
  }
  const training = trainState.training;
  const owner = currentOwnerId();
  const mode = trainState.trainMode;
  const stillCurrent = () => trainState.training === training && !trainState.smart
    && currentOwnerId() === owner && trainState.trainMode === mode;
  trainState.trainBusy = true;
  syncTrainSessionControls();
  let result;
  try {
    result = await postJson("/api/train/skip", { session_id: prompt.session_id });
  } catch (error) {
    // A lost answer may have skipped already: the server's prompt decides, as for a lost move.
    if (stillCurrent()) await trainRecovery.recoverSkip(error, prompt, () => !stillCurrent());
    return;
  }
  if (!stillCurrent()) return;
  trainState.trainStats.skipped += 1;
  trainState.trainAttempt = 1;
  trainState.trainBusy = false;
  if (result.prompt) {
    trainState.training.prompt = result.prompt;
    await renderTraining(result.prompt);
  } else {
    finishTrainingSession();
  }
  if (stillCurrent()) syncTrainSessionControls();
}

function applyTrainingPromptState(prompt) {
  if (trainState.training) trainState.training.prompt = prompt;
  trainState.trainHintLevel = 0;
  trainState.trainHintInfo = null;
}

async function renderTraining(payloadOrPrompt, options) {
  const prompt = payloadOrPrompt?.prompt || payloadOrPrompt;
  if (!prompt) return;
  applyTrainingPromptState(prompt);
  saveRehearsal(currentOwnerId(), trainState.training, trainState.trainStats, trainState.trainAttempt);
  const out = await (await ensureTrainView()).renderTraining(prompt, options);
  syncTrainSessionControls();
  return out;
}

async function renderSmartProgress(prompt) {
  return (await ensureTrainView()).renderSmartProgress(prompt);
}

// The session's transient control states (busy, teaching); which controls
// exist at all is the screen's business (train-home.js).
function syncTrainSessionControls() {
  const banner = document.getElementById("train-banner");
  const state = banner && banner.dataset.state;
  const busy = !!trainState.trainBusy;
  const teaching = state === "teach" || state === "reveal" || state === "runin";
  document.getElementById("train-hint").disabled = busy || teaching;
  document.getElementById("train-skip").disabled = busy;
  const history = trainState.play && trainState.play.history;
  document.getElementById("play-takeback").disabled = !(history && history.length);
  document.getElementById("play-resign").disabled = !(trainState.play && trainState.play.active);
  syncTrainScreen();
  syncViewHeads();
}

export async function resetTrainBoardIdle(label) {
  updateTrainTurnBadge(null);
  const labelEl = document.getElementById("train-board-label");
  if (labelEl) labelEl.textContent = label || "";
  if (!boards.train) return;
  boards.train.setEngineArrow(null);
  try {
    const info = await boardInfo(START_FEN);
    boards.train.setPosition({
      fen: START_FEN,
      legalMoves: info.legal_moves || [],
      lastMove: null,
    });
  } catch {
    boards.train.setPosition({ fen: START_FEN, legalMoves: [], lastMove: null });
  }
}

// Score a first-try answer in the session's accuracy chips; a miss ends the run.
function tallyAnswer(stats, recalled) {
  if (recalled) {
    stats.correct += 1;
    stats.streak += 1;
    stats.best = Math.max(stats.best, stats.streak);
  } else {
    stats.mistakes += 1;
    stats.streak = 0;
  }
  stats.history.push(recalled);
}

function trainStatsReset() {
  trainState.trainStats = { correct: 0, mistakes: 0, skipped: 0, streak: 0, best: 0, history: [], lastStreak: 0, learned: 0, learnedRetry: 0, startedAt: Date.now() };
}

function cancelStaleTrainStart(options) { if (!trainState.trainStarting || trainState.trainStartToken !== options.entryToken) return; trainState.trainStarting = false; trainState.trainStartToken = null; setTrainBanner("move", "", ""); syncTrainSessionControls(); }

function sideToMoveFromFen(fen) {
  return (fen || "").split(" ")[1] === "b" ? "black" : "white";
}

export async function startTraining(mode, options = {}) {
  mode = mode || trainState.trainMode || "smart";
  // Practice game starts via startPlaySession; never post "play" to /api/train/start (422).
  if (mode === "play") return;
  trainState.trainMode = mode;
  trainState.trainResult = null;
  // Training runs against your own repertoires and review schedule, so a
  // guest gets the sign-in gate — not a "Nothing to train yet" that blames an
  // empty repertoire and a raw "not authenticated".
  if (!appState.signedIn) {
    trainState.trainStarting = false;
    syncTrainSessionControls();
    requireSignIn("Sign in to start training", "train");
    return;
  }
  if (mode === "smart") {
    await startSmartTraining(options);
    return;
  }
  // ----- line rehearsal (all_lines) below -----
  const seq = ++smartStartSeq;
  const owner = currentOwnerId();
  const entryCurrent = options.isCurrent || (() => true), isCurrent = () => entryCurrent() && seq === smartStartSeq && owner === currentOwnerId() && trainState.trainMode === mode;
  trainState.smart = null;
  clearBlitzTimer();
  setBlitzBarVisible(false);
  // A caller that names the repertoire (a deep link, a repertoire's own Train
  // action) is the source of truth; otherwise Start follows the Home row.
  const repertoireId = options.repertoireId || trainState.trainingRepertoireId;
  trainState.trainingRepertoireId = repertoireId;
  const failed = (text) => {
    trainState.trainStarting = false;
    trainState.training = null;
    trainRowError(mode, text);
    syncTrainSessionControls();
  };
  if (!repertoireId) return failed("Pick a repertoire to rehearse.");
  setTrainBanner("runin", "Opening your lines…", "");
  // Same freshness rule as the smart queue: unsynced Build edits must land
  // before the server walks the tree into lines.
  try {
    await hardFlushBuild();
    if (!isCurrent()) return cancelStaleTrainStart(options);
  } catch (error) {
    if (!isCurrent()) return cancelStaleTrainStart(options);
    failed(error.message);
    return;
  }
  const fresh = !!options.fresh;
  const body = { seed: 13, mode, repertoire_id: repertoireId, fresh };
  try {
    const payload = await postJson("/api/train/start", body);
    if (!isCurrent()) return cancelStaleTrainStart(options);
    if (!payload.prompt) return failed("No moves to rehearse. Add lines in Repertoire.");
    trainState.training = payload;
    trainState.trainAttempt = 1;
    trainStatsReset();
    const saved = !fresh && restoreRehearsal(currentOwnerId(), payload);
    if (saved) {
      trainState.trainStats = saved.stats;
      trainState.trainAttempt = saved.attempt;
    }
    if (boards.train && payload.color) {
      boards.train.setOrientation(payload.color === "black" ? "black" : "white");
    }
    trainState.trainStarting = false;
    await renderTrainStats();
    await renderTraining(payload);
    syncWorkspaceUrl();
  } catch (error) {
    if (!isCurrent()) return cancelStaleTrainStart(options);
    failed(isNothingToTrainError(error) ? "No moves to rehearse. Add lines in Repertoire." : error.message);
  }
}

function playBookLabel(play) {
  const session = play || trainState.play;
  const book = playBookName(session && session.book);
  const color = session && session.userColor === "black" ? "Black" : "White";
  const they = session && session.lastOppSan ? ` · they ${session.lastOppSan}` : "";
  const reps =
    session && session.book === "repertoire" && Array.isArray(session.repertoires)
      ? session.repertoires.map((rep) => rep.name).filter(Boolean)
      : [];
  const repLabel = reps.length ? ` · ${reps.length === 1 ? reps[0] : `${reps.length} active repertoires`}` : "";
  return `${book}${repLabel} · you ${color}${they}`;
}

function renderPlayTrail() {
  const el = document.getElementById("train-play-trail");
  if (!el) return;
  const play = trainState.play;
  const rows = play ? playTrailRows(play.history, play.startFen) : [];
  el.hidden = !play;
  // A score sheet: the number, White's move, Black's move. Inline on a phone,
  // a numbered two-column list beside the board (train-shell.css).
  el.innerHTML = rows.map(([n, w, b]) => html`<span class="pt-n">${n}${w ? "." : "…"}</span> <span class="pt-m">${w}</span> <span class="pt-m">${b}</span> `).join("");
  [...el.querySelectorAll(".pt-m:not(:empty)")].pop()?.classList.add("is-last");
  // A Feeling Lucky game names where its position came from in the scope chip.
  if (play && play.luckyReason) document.getElementById("train-scope-chip").textContent = trainScopeLabel();
  syncTrainSessionControls();
}

function recordPlayPly(ply) {
  const play = trainState.play;
  if (!play) return;
  play.history = play.history || [];
  play.history.push(ply);
  renderPlayTrail();
}

function playChildren(nodeId) {
  if (!buildState.build || !nodeId) return [];
  return (buildState.build.nodes || []).filter(
    (node) => node.parent_id === nodeId && node.is_enabled !== false && node.uci,
  );
}

function normalizePlayRepertoire(payload, meta = {}) {
  const nodes = Array.isArray(payload && payload.nodes) ? payload.nodes : [];
  const byId = new Map(nodes.filter((node) => node && node.id).map((node) => [node.id, node]));
  const kids = new Map();
  for (const node of nodes) {
    if (!node || !node.parent_id || node.is_enabled === false || !node.uci) continue;
    if (!kids.has(node.parent_id)) kids.set(node.parent_id, []);
    kids.get(node.parent_id).push(node);
  }
  const root = nodes.find((node) => node && !node.parent_id);
  return {
    id: String(payload?.repertoire_id || meta.id || ""),
    name: payload?.name || meta.name || "Untitled repertoire",
    color: payload?.color === "black" || meta.color === "black" ? "black" : "white",
    rootId: root ? root.id : null,
    nodes,
    byId,
    kids,
  };
}

function playCursorSnapshot(play) {
  const out = {};
  for (const rep of play?.repertoires || []) {
    out[rep.id] = [...(play.repertoireCursors?.[rep.id] || [])];
  }
  return out;
}

function playCursorsAtFen(repertoires, fen) {
  const key = (value) => String(value || "").trim().split(/\s+/).slice(0, 4).join(" ");
  const target = key(fen);
  const out = {};
  for (const rep of repertoires || []) {
    const matching = (rep.nodes || [])
      .filter((node) => node && key(node.fen) === target && node.is_enabled !== false)
      .map((node) => node.id);
    out[rep.id] = matching;
  }
  return out;
}

function playRepertoireReplies(play, legalUcis) {
  const out = [];
  const userColor = play?.userColor === "black" ? "black" : "white";
  const legal = new Set((legalUcis || []).map((uci) => String(uci).toLowerCase()));
  for (const rep of play?.repertoires || []) {
    // A repertoire is authored for the side the user plays. With mixed-color
    // selections, only the books matching the chosen side answer this game.
    if (rep.color !== userColor) continue;
    const cursors = play.repertoireCursors?.[rep.id] || [];
    for (const nodeId of cursors) {
      for (const child of rep.kids.get(nodeId) || []) {
        if (!legal.has(String(child.uci || "").toLowerCase())) continue;
        out.push({
          ...child,
          repertoireId: rep.id,
          repertoireName: rep.name,
          color: rep.color,
        });
      }
    }
  }
  return out;
}

function playAdvanceNode(uci) {
  const play = trainState.play;
  if (!play) return {};
  const before = playCursorSnapshot(play);
  if (play.repertoires?.length) {
    const next = {};
    for (const rep of play.repertoires) {
      const children = [];
      for (const nodeId of play.repertoireCursors?.[rep.id] || []) {
        for (const child of rep.kids.get(nodeId) || []) {
          if (String(child.uci).toLowerCase() === String(uci).toLowerCase()) children.push(child.id);
        }
      }
      next[rep.id] = [...new Set(children)];
    }
    play.repertoireCursors = next;
    play.nodeId = Object.values(next).find((ids) => ids.length)?.[0] || null;
    return before;
  }
  if (play.nodeId) {
    const child = playChildren(play.nodeId).find((node) => node.uci === uci);
    play.nodeId = child ? child.id : null;
  }
  return before;
}

async function fetchPlayExplorer(fen) {
  try {
    const client = await ensureExplorerClient();
    return await client.fetchStats("lichess", fen, { rating: effectiveMaiaRating() });
  } catch (error) {
    // Keep why it failed: a 401/unlinked/rate-limited read is not a thin sample.
    return unavailableExplorer(error);
  }
}

// Returns Maia's predictions, or { error } when it produced none. The caller must
// tell the two apart: "the opponent has no legal move" is only true when the move
// generator really came back empty, while an engine failure owes the user the
// actual reason and a retry, not a misleading book message.
async function fetchPlayMaia(fen, onProgress) {
  // Train Play opponent fallback is Maia-by-design (thin Explorer positions
  // fall back to human-like replies), independent of the Analyze-layer switch.
  try {
    const provider = getSharedMaia3Provider();
    // The Result card names the failure and owns the retry (Play again).
    const maiaNotice = watchMaiaInit(provider, { notices, onProgress, quietFail: true });
    try {
      const predictions = await provider.predictions({ fen, rating: effectiveMaiaRating() });
      maiaNotice.succeed();
      return predictions;
    } catch (error) {
      maiaNotice.fail(error);
      return { error };
    }
  } catch (error) {
    return { error };
  }
}

async function loadPlayRepertoirePayload(repertoireId) {
  return api(`/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`);
}

function paintPlayPosition({ fen, legalMoves, lastMove, banner, sub, label, state, back = false }) {
  boards.train.setEngineArrow(null);
  boards.train.setPosition({
    fen,
    legalMoves: legalMoves || [],
    lastMove: lastMove || null, back,
  });
  // Keep the current board position inspectable for acceptance tooling and
  // assistive diagnostics without adding another visible control.
  const boardEl = document.getElementById("train-board");
  if (boardEl) boardEl.dataset.fen = fen || "";
  const side = (fen || "").split(" ")[1] === "b" ? "black" : "white";
  updateTrainTurnBadge(side);
  setTrainBanner(state || "move", banner, sub || "");
  const labelEl = document.getElementById("train-board-label");
  if (labelEl) labelEl.textContent = label || playBookLabel();
}

// Start a practice game and remember the in-flight start, so a move made on the
// board while it sets up is played into the new game instead of being dropped.
export function startPlaySessionTracked(options) {
  trainState.trainStarting = true;
  const pending = startPlaySession(options).finally(() => {
    if (trainState.playStarting === pending) {
      trainState.playStarting = null;
      trainState.trainStarting = false;
      syncTrainScreen();
    }
  });
  trainState.playStarting = pending;
  syncTrainScreen();
  return pending;
}

async function startPlaySession({
  fen,
  reason,
  phase,
  gameId: luckyGameId,
  white: luckyWhite,
  black: luckyBlack,
  sourceUrl: luckySourceUrl,
} = {}) {
  if (trainState.trainMode !== "play") return false;
  const startToken = trainState.playStartToken = (trainState.playStartToken || 0) + 1;
  const isCurrentStart = () => trainState.playStartToken === startToken && trainState.trainMode === "play";
  trainState.smart = null;
  trainState.training = null;
  trainState.trainResult = null;
  const startFen = fen || START_FEN;
  const book = playBook();
  let nodeId = null;
  let playRepertoires = [];
  let repertoireCursors = {};
  if (book === "repertoire") {
    const selectedIds = selectedTrainRepertoireIds();
    if (!selectedIds.length) {
      trainRowError("play", "Pick at least one repertoire for the opponent.");
      return false;
    }
    // Build edits are local-first. Flush the currently open tree before reading
    // it for a Play session, but never load repertoire trees until Start is
    // pressed (no Train-load or idle prefetch).
    try {
      await hardFlushBuild();
    } catch (error) {
      if (isCurrentStart()) trainRowError("play", error.message);
      return false;
    }
    try {
      const metas = playRepertoireMeta(selectedIds);
      const metasById = new Map(metas.map((rep) => [String(rep.id), rep]));
      const payloads = await Promise.all(selectedIds.map((id) => loadPlayRepertoirePayload(id)));
      if (!isCurrentStart()) return false;
      playRepertoires = payloads
        .map((payload, index) => normalizePlayRepertoire(payload, metasById.get(String(selectedIds[index])) || { id: selectedIds[index] }))
        .filter((rep) => rep.id && rep.rootId);
      if (!playRepertoires.length) {
        trainRowError("play", "Those repertoires have no playable lines yet.");
        return false;
      }
      repertoireCursors = playCursorsAtFen(playRepertoires, startFen);
      nodeId = playRepertoires.find((rep) => repertoireCursors[rep.id]?.length)?.rootId || null;
    } catch (error) {
      if (isCurrentStart()) trainRowError("play", error.message);
      return false;
    }
  }
  const selectedMeta = book === "repertoire" ? playRepertoireMeta(selectedTrainRepertoireIds()) : [];
  const userColor = resolvePlayColor({
    book,
    pickerColor: playPickerColor(),
    repertoireColor: selectedMeta[0] && selectedMeta[0].color,
    repertoireColors: selectedMeta.map((rep) => rep.color),
    luckyFen: reason ? startFen : null,
  });
  if (book === "repertoire") {
    // A Lucky FEN may not be a node in the selected trees. Keep cursors empty
    // for those books so the normal Explorer → Maia fallback still works.
    repertoireCursors = playCursorsAtFen(playRepertoires, startFen);
    nodeId = Object.values(repertoireCursors).find((ids) => ids.length)?.[0] || nodeId;
  }
  let info;
  try {
    info = await boardInfo(startFen);
  } catch (error) {
    if (isCurrentStart()) trainRowError("play", error.message || "Could not open that position");
    return false;
  }
  if (!isCurrentStart()) return false;
  trainState.play = {
    active: true,
    fen: info.fen,
    startFen: info.fen,
    book,
    rating: book === "repertoire" ? null : effectiveMaiaRating(),
    userColor,
    nodeId,
    rootNodeId: nodeId,
    repertoires: playRepertoires,
    repertoireCursors,
    ply: 0,
    history: [],
    startedAt: Date.now(),
    lastOppSan: null,
    luckyReason: reason || null,
    luckyPhase: phase || null,
    luckyGameId: luckyGameId || null,
    luckyWhite: luckyWhite || null,
    luckyBlack: luckyBlack || null,
    luckySourceUrl: luckySourceUrl || null,
  };
  if (boards.train) {
    boards.train.setOrientation(userColor);
  }
  const why =
    reason === "db-critical"
      ? `Master game, critical ${phase || "moment"}: your move`
      : reason === "titled-game"
        ? `Live Lichess game, critical ${phase || "moment"}: your move`
        : "";
  const luckyMeta =
    reason === "titled-game" && luckyGameId
      ? ` · ${[luckyWhite, luckyBlack].filter(Boolean).join(" vs ") || "Lichess game"} (${luckyGameId})`
      : "";
  paintPlayPosition({
    fen: info.fen,
    legalMoves: sideToMoveFromFen(info.fen) === userColor ? info.legal_moves : localPremoveMoves(info.fen, userColor),
    banner: sideToMoveFromFen(info.fen) === userColor ? "Your move" : "Opponent thinking…",
    state: "idle",
    sub: `${why}${luckyMeta}`,
    label: playBookLabel(trainState.play),
  });
  renderPlayTrail();
  syncTrainSessionControls();
  // Start the same shared initialization during the player's first turn.
  // The reply awaits it when needed; opening the board never waits on a download.
  if (book === "maia") void getSharedMaia3Provider().warmup().catch(() => {});
  if (sideToMoveFromFen(info.fen) !== userColor) {
    await playOpponentReply();
  }
  return true;
}

// Where the next reply comes from, shown while the opponent thinks.
function playThinkingSub(play) {
  if (play.book === "maia") return "Maia";
  const explorer = play.explorerOff ? "" : "Explorer → ";
  return play.book === "explorer" ? `${explorer}Maia` : `Repertoire → ${explorer}Maia`;
}

async function playOpponentReply() {
  const play = trainState.play;
  if (!play || !play.active) return;
  const fen = play.fen;
  const seq = (play.replySeq || 0) + 1;
  play.replySeq = seq;
  const isCurrent = () => trainState.play === play && play.active && play.fen === fen && play.replySeq === seq;
  const info = await boardInfo(fen);
  if (!isCurrent()) return;
  const alreadyOver = playPositionAfterReply(info);
  if (alreadyOver.terminal) {
    play.result = alreadyOver.result;
    boards.train.setPosition({ fen: info.fen, legalMoves: [], lastMove: null });
    endPlayGame(alreadyOver.banner);
    return;
  }
  setTrainBanner(
    "runin",
    "Opponent thinking…",
    playThinkingSub(play),
  );
  const repertoireReplies = play.book === "repertoire" ? playRepertoireReplies(play, info.legal_moves) : [];
  let explorer = { totalGames: 0, moves: [] };
  // A repertoire hit is local and immediate. Only ask Explorer when every
  // selected book is out of book; Maia is fetched only if that Explorer read
  // is thin/unavailable (or has no legal move).
  if (play.book === "explorer" || (play.book === "repertoire" && !repertoireReplies.length)) {
    if (play.explorerOff) {
      // Once out of book, the game belongs to Maia. Authentication failures
      // also stay off, but retain their distinct unavailable reason.
      explorer = { totalGames: 0, moves: [], ...(play.explorerOff === "out-of-book" ? {} : { unavailable: play.explorerOff }) };
    } else {
      explorer = await fetchPlayExplorer(fen);
      if (!isCurrent()) return;
      if (explorer.unavailable === "sign-in" || explorer.unavailable === "link") {
        play.explorerOff = explorer.unavailable;
      }
    }
  }
  const pick = (maiaPredictions) => pickOpponentReply({
    book: play.book,
    legalUcis: info.legal_moves,
    explorer,
    repertoireReplies,
    repertoireChildren: play.book === "repertoire" ? [] : playChildren(play.nodeId),
    maiaPredictions,
  });
  let reply = pick([]);
  if (!reply.uci) {
    if (play.book !== "maia" && !explorer.unavailable) play.explorerOff = "out-of-book";
    const maia = await fetchPlayMaia(fen, (text) => {
      if (isCurrent()) setTrainBanner("runin", "Opponent thinking…", text);
    });
    if (!isCurrent()) return;
    // Maia could not start at all: the Result card names the reason instead of
    // blaming the book, and Play again retries.
    if (maia.error) {
      endPlayGame("Opponent unavailable", maiaErrorText(maia.error));
      return;
    }
    reply = pick(maia);
  }
  if (!reply.uci) {
    endPlayGame("No reply from the opponent", "The opponent has no legal move from this book.");
    return;
  }
  const nodeIdBefore = play.nodeId;
  const after = await boardAfterMove(fen, reply.uci);
  if (!isCurrent()) return;
  play.fen = after.board.fen;
  play.ply += 1;
  const repertoireCursorsBefore = playAdvanceNode(reply.uci);
  play.lastOppSan = after.move.san;
  recordPlayPly({
    uci: reply.uci,
    san: after.move.san,
    fenBefore: info.fen,
    fenAfter: after.board.fen,
    by: "opp",
    nodeIdBefore,
    nodeIdAfter: play.nodeId,
    repertoireCursorsBefore,
    repertoireCursorsAfter: playCursorSnapshot(play),
  });
  const ended = playPositionAfterReply(after.board);
  if (ended.terminal) {
    play.result = ended.result;
    boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: reply.uci });
    endPlayGame(ended.banner);
    return;
  }
  const sourceLabel =
    reply.source === "explorer"
      ? "Explorer"
      : reply.source === "repertoire"
        ? reply.repertoireNames?.length
          ? `Repertoire · ${reply.repertoireNames.length === 1 ? reply.repertoireNames[0] : `${reply.repertoireNames[0]} +${reply.repertoireNames.length - 1}`}`
          : "Repertoire"
        : "Maia";
  // Say once per game why the explorer is out; later Maia replies speak for themselves.
  let reason = replyReasonNote(reply);
  if (reply.reason === "explorer-unavailable") {
    if (play.explorerNoted) reason = "";
    play.explorerNoted = true;
  }
  paintPlayPosition({
    fen: after.board.fen,
    legalMoves: ended.legalMoves,
    lastMove: reply.uci,
    banner: "Your move",
    sub: `${sourceLabel} played ${after.move.san}${reason}`,
    label: playBookLabel(play),
  });
  const premove = play.premove;
  play.premove = null;
  boards.train.setPremove(null);
  if (premove && ended.legalMoves.includes(premove)) await submitPlayMove(premove);
}

const submitPlayMove = createPlayMoveHandler({
  trainState, boards, advanceNode: playAdvanceNode, recordPly: recordPlayPly,
  cursorSnapshot: playCursorSnapshot, endGame: endPlayGame, opponentReply: playOpponentReply,
});

export async function onFeelingLucky() {
  const run = beginLuckyDiscovery(trainState);
  if (!run) return;
  try {
    return await runFeelingLuckyClick(run);
  } finally {
    finishLuckyDiscovery(trainState, run);
  }
}

// Feeling Lucky: a fresh titled-player Lichess feed replayed and scored
// locally, with the slower Masters walk as a quality fallback. Sign-in gates
// it because that fallback and the resulting session need an account; the
// sign-in modal is transient, so tab navigation dismisses it.
async function runFeelingLuckyClick(run) {
  const luckyCurrent = () => luckyDiscoveryCurrent(trainState, run);
  if (!appState.accountUsername) {
    try {
      await refreshAuthStatus();
    } catch {
      // fall through to the sign-in prompt below
    }
    if (!luckyCurrent()) return;
  }
  if (!appState.accountUsername) {
    if (luckyCurrent()) openAuthModal("login", { notice: "Sign in first, then try a random position." });
    return;
  }
  try {
    setTrainBanner("runin", "Finding a position…", "Discovering a fresh titled player");
    const { runFeelingLucky } = await import("../feeling-lucky.js");
    if (!luckyCurrent()) return;
    await runFeelingLucky({
      signal: run.controller.signal,
      storage: typeof localStorage === "undefined" ? null : localStorage,
      exclude: [trainState.lastLuckyFen, trainState.play && trainState.play.startFen].filter(Boolean),
      rating: effectiveMaiaRating(),
      ensureExplorer: ensureExplorerClient,
      onStatus: (...args) => luckyCurrent() && setStatus(...args),
      setBanner: (...args) => luckyCurrent() && setTrainBanner(...args),
      startSession: async (session) => {
        if (!luckyCurrent()) return false;
        trainState.lastLuckyFen = session.fen;
        return startPlaySessionTracked(session);
      },
    });
  } catch (error) {
    // runFeelingLucky already painted the banner for every outcome, so only
    // the status line reports a failure here.
    if (luckyCurrent()) setStatus(error && error.message ? error.message : String(error));
  }
}

export async function takebackPlaySession() {
  const play = trainState.play;
  if (!play || !play.history || !play.history.length) return;
  play.premove = null;
  boards.train.setPremove(null);
  play.replySeq = (play.replySeq || 0) + 1;
  const undone = takebackToUserMove(play.history);
  play.history = undone.history;
  play.active = true;
  play.result = null;
  play.fen = undone.fen || play.startFen;
  if (play.explorerOff === "out-of-book") play.explorerOff = null;
  play.nodeId = undone.nodeId || play.rootNodeId;
  if (play.repertoires?.length) {
    play.repertoireCursors = undone.repertoireCursors || playCursorsAtFen(play.repertoires, play.fen);
    play.nodeId = Object.values(play.repertoireCursors).find((ids) => ids.length)?.[0] || null;
  }
  play.ply = play.history.length;
  const lastUserOrOpp = play.history.filter((ply) => ply.by === "opp").pop();
  play.lastOppSan = lastUserOrOpp ? lastUserOrOpp.san : null;
  const info = await boardInfo(play.fen);
  const yourMove = sideToMoveFromFen(play.fen) === play.userColor;
  paintPlayPosition({
    fen: play.fen,
    legalMoves: yourMove ? info.legal_moves : [],
    lastMove: undone.lastMove, back: true, // a takeback: pieces go home, quietly
    banner: yourMove ? "Your move" : "Opponent thinking…",
    sub: yourMove
      ? "Move taken back"
      : playThinkingSub(play),
    label: playBookLabel(play),
    state: yourMove ? "move" : "runin",
  });
  renderPlayTrail();
  if (!yourMove) await playOpponentReply();
}

export function resignPlaySession() {
  const play = trainState.play;
  if (!play || !play.active) return;
  play.result = play.userColor === "black" ? "1-0" : "0-1";
  const last = play.history && play.history[play.history.length - 1];
  boards.train.setPosition({ fen: play.fen, legalMoves: [], lastMove: last ? last.uci : null });
  endPlayGame("Resigned");
}

// Every way a practice game ends goes to the shared Result card.
// A game that could not go on (no opponent) names why and is not a run.
function endPlayGame(title, failure = "") {
  const play = trainState.play;
  if (!play) return;
  play.premove = null;
  boards.train.setPremove(null);
  play.active = false;
  play.ended = title;
  play.failure = failure;
  updateTrainTurnBadge(null);
  if (play.history?.length && !failure) {
    saveRun(currentOwnerId(), {
      id: `play:${play.startedAt}`, mode: "play", blitz: false, result: title,
      pgn: playSessionPgn(play, appState.lichessUsername), userColor: play.userColor,
      repertoires: (play.repertoires || []).map((rep) => rep.name).filter(Boolean),
      startedAt: new Date(play.startedAt).toISOString(), finishedAt: new Date().toISOString(),
      cards: play.history.filter((ply) => ply.by === "user").length, correct: 0, mistakes: 0, skipped: 0, learned: 0,
    });
  }
  showTrainResult({ ...playResult(play), runId: `play:${play.startedAt}` });
}

export async function openPlayInAnalyze(play = trainState.play) {
  if (!play?.pgn && !play?.history?.length) return;
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const sourceSeq = invalidateAnalysisSource();
  const isCurrent = () => sourceSeq === analysisRecallSeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const pgn = play.pgn || playSessionPgn(play, appState.lichessUsername);
  const input = document.getElementById("pgn-input");
  if (input) input.value = pgn;
  const drawer = document.getElementById("pgn-drawer");
  if (drawer) drawer.open = false;
  switchView("analyze");
  if (boards.analysis) boards.analysis.setOrientation(play.userColor === "black" ? "black" : "white");
  if (!input) return;
  try {
    const loaded = await loadPgnIntoAnalyze(pgn, { goToEnd: false, quiet: true, sourceSeq });
    if (!isCurrent()) return;
    if (!loaded) { setStatusError("Could not load this Practice game. Try Analyze game again."); return; }
    setStatus("Loaded this Practice game · analyzing");
    await runAnalysis();
  } catch (error) {
    if (isCurrent()) setStatusError(error.message);
  }
}

// Another repertoire move at this position is prep, not a miss: it lands,
// slides back, and the same prompt reopens ungraded (Due and Rehearse alike).
async function answerAlternative({ fen, playedUci, san, still, reopen }) {
  trainState.trainBusy = true;
  await optimisticBoardMove(boards.train, fen, playedUci, false);
  setTrainBanner("review", "Also in your repertoire", `${san} is your prep too. This card drills another move.`);
  await sleep(900);
  if (!still()) return;
  try {
    await reopen();
  } finally {
    if (still()) {
      trainState.trainBusy = false;
      syncTrainSessionControls();
    }
  }
}

async function submitTrainingMove(playedUci) {
  if ((trainState.trainMode || "smart") === "play") {
    if (!(trainState.play && trainState.play.active)) {
      // A move made while Start is still setting up, or on the idle start board,
      // opens the game with that move rather than vanishing.
      if (trainState.playStarting) {
        const pending = trainState.playStarting;
        if (!await pending || trainState.trainMode !== "play") return;
      }
      else if (!trainState.play && playPickerColor() === "white") await startPlaySessionTracked();
    }
    if (trainState.play && trainState.play.active) return submitPlayMove(playedUci);
    return;
  }
  if (trainState.smart) {
    return submitSmartMove(playedUci);
  }
  const prompt = currentTrainingPrompt();
  if (!prompt || !playedUci || trainState.trainBusy) return;
  // A mode switch, another account, or a smart session replaces the training
  // state; every await below re-checks it so an abandoned rehearsal never paints
  // onto whatever took the board (a late failure included).
  const training = trainState.training;
  const owner = currentOwnerId();
  const mode = trainState.trainMode;
  const superseded = () => trainState.training !== training || trainState.smart
    || currentOwnerId() !== owner || trainState.trainMode !== mode;
  // Land the dragged move on the board right away; the server response below
  // decides whether it advances (correct) or resets (wrong), and its right/wrong
  // cue covers the move, so the landing itself stays quiet.
  await optimisticBoardMove(boards.train, prompt.fen_before, playedUci, false);
  // An answer after a hint advances the line and grades Hard. Only the first
  // attempt at a prompt is graded (the shared wrong-move rule).
  const hinted = trainState.trainHintLevel > 0;
  const attempt = trainState.trainAttempt || 1;
  let result;
  try {
    result = await api("/api/train/move", {
      method: "POST",
      body: JSON.stringify({
        session_id: prompt.session_id,
        played_uci: playedUci,
        hinted,
        attempt,
        local_date: localDateString(),
      }),
    });
  } catch (error) {
    // A rejected answer (the server answered 4xx) provably did not grade, so the
    // same card comes back. A lost response may already be saved: the server's
    // current prompt is fetched before the board reopens, because replaying the
    // old answer would grade the next card wrong and record a false miss.
    await trainRecovery.recoverAnswer(error, prompt, superseded);
    return;
  }
  if (result.day_streak) appState.dayStreak = result.day_streak;
  if (result.alternative) {
    const hintLevel = trainState.trainHintLevel;
    return answerAlternative({
      fen: prompt.fen_before, playedUci, san: result.played_san || playedUci, still: () => !superseded(),
      reopen: async () => {
        await renderTraining(result.prompt || prompt, { keepBanner: true });
        trainState.trainHintLevel = hintLevel;
        if (attempt >= 3) boards.train.setEngineArrow(prompt.expected_uci);
      },
    });
  }
  const stats = trainState.trainStats || (trainStatsReset(), trainState.trainStats);

  if (!result.correct) {
    if (attempt === 1) {
      tallyAnswer(stats, false);
      await renderTrainStats();
    }
    trainState.trainBusy = true;
    let playedSan = result.played_san || "";
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      playedSan = after.move?.san || playedSan;
      boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: playedUci, cue: false });
    } catch {
      // Keep SAN-only feedback even if the preview move cannot be rendered.
    }
    playSound("wrong");
    const banner = wrongMoveBanner({ attempt, playedSan, expectedSan: result.expected_san });
    setTrainBanner(banner.state, banner.title, banner.sub);
    if (trainState.training) trainState.training.prompt = result.prompt;
    await sleep(950);
    if (superseded()) return;
    trainState.trainBusy = false;
    trainState.trainAttempt = attempt + 1;
    if (result.prompt) await renderTraining(result.prompt, { keepBanner: true });
    if (attempt >= 2) boards.train.setEngineArrow(result.expected_uci);
    return;
  }
  trainState.trainAttempt = 1;
  // An answer played after a miss or the reveal moves on and scores nothing.
  if (attempt === 1) tallyAnswer(stats, !hinted);
  await renderTrainStats();
  if (trainState.training) trainState.training.prompt = result.prompt;
  trainState.trainBusy = true;
  boards.train.setEngineArrow(null);

  // 1) Land the player's own move on the board (board animates), then the
  // answer's cue.
  boards.train.setPosition({
    fen: result.fen_after_player || prompt.fen_before,
    legalMoves: [],
    lastMove: result.played_uci,
    cue: false,
  });
  playSound("right");
  setTrainBanner("correct", hinted ? "Correct, with a hint" : "Correct", result.played_san ? `You played ${result.played_san}` : "");

  // 2) After a beat, let the opponent reply as its own animated step.
  if (result.reply_uci && result.fen_after_reply) {
    await sleep(520);
    if (superseded()) return;
    boards.train.setPosition({
      fen: result.fen_after_reply,
      legalMoves: [],
      lastMove: result.reply_uci,
    });
    setTrainBanner("move", "Opponent replies", result.reply_san || "");
    await sleep(440);
  } else {
    await sleep(480);
  }
  if (superseded()) return;

  trainState.trainBusy = false;
  if (result.prompt) {
    await renderTraining(result.prompt);
  } else {
    finishTrainingSession();
  }
}

function finishTrainingSession() {
  const training = trainState.training;
  const stats = trainState.trainStats;
  if (training) training.prompt = null;
  saveRehearsal(currentOwnerId(), training, stats, trainState.trainAttempt);
  boards.train.setEngineArrow(null);
  updateTrainTurnBadge(null);
  document.getElementById("train-board-label").textContent = "";
  const runId = `${training?.session_id}:${training?.session_generation || Date.now()}`;
  saveRun(currentOwnerId(), {
    id: runId, mode: "all_lines", blitz: false,
    repertoires: [training?.repertoire_name].filter(Boolean), startedAt: new Date(stats.startedAt || Date.now()).toISOString(), finishedAt: new Date().toISOString(),
    cards: Number(training?.lines?.length) || 0, correct: stats.correct, mistakes: stats.mistakes, skipped: stats.skipped || 0, learned: 0,
  });
  showTrainResult({ ...drillResult(training, stats), runId });
  celebrate();
}

// Lightweight confetti burst, no library, just falling coloured chips, and the
// cue that says the run is over.
function celebrate() {
  playSound("complete");
  const host = document.getElementById("view-train");
  if (!host) return;
  const colors = ["#d18b3f", "#4a8964", "#b9722a", "#c4524d", "#e6c34a"];
  const layer = document.createElement("div");
  layer.className = "confetti-layer";
  for (let i = 0; i < 36; i += 1) {
    const bit = document.createElement("span");
    bit.className = "confetti-bit";
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = `${Math.random() * 250}ms`;
    bit.style.animationDuration = `${900 + Math.random() * 700}ms`;
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.appendChild(bit);
  }
  host.appendChild(layer);
  window.setTimeout(() => layer.remove(), 1900);
}

// Progressive hint: idea, piece, full answer (with arrow). Each click reveals
// one more level, so it teaches rather than just spoiling the move.
export async function trainHint() {
  if (trainState.smart) {
    smartHint();
    return;
  }
  const prompt = currentTrainingPrompt();
  if (!prompt) {
    setStatus("Start a session first");
    return;
  }
  // One hint read per position: clicks made while it is in flight wait on the
  // same read and each still reveals one more level.
  let pending = trainState.trainHintInfo;
  if (!pending || pending.forFen !== prompt.fen_before) {
    pending = trainState.trainHintInfo = {
      forFen: prompt.fen_before,
      read: postJson("/api/train/hint", { session_id: prompt.session_id }),
    };
    trainState.trainHintLevel = 0;
  }
  let info;
  try {
    info = await pending.read;
  } catch (error) {
    if (trainState.trainHintInfo === pending) trainState.trainHintInfo = null;
    setStatusError(error.message);
    return;
  }
  if (trainState.trainHintInfo === pending) showHint(info);
}

// Reveal the next hint level on the board and banner; returns its line.
function showHint({ strategy, piece, expected_uci: uci, expected_san: san }) {
  const level = trainState.trainHintLevel = Math.min(3, (trainState.trainHintLevel || 0) + 1);
  const text = level === 1 ? strategy || "Follow your preparation"
    : level === 2 ? piece || "Find the move"
      : san ? `Play ${san}` : "Here it is";
  if (level < 3) boards.train.setEngineArrow(null);
  setTrainBanner("move", `Hint ${level} · ${["Idea", "Piece", "Answer"][level - 1]}`, text);
  if (uci && level === 2) boards.train.selectSquare(uci.slice(0, 2));
  if (uci && level === 3) boards.train.setEngineArrow(uci);
  return `Hint ${level} · ${text}`;
}

function currentTrainingPrompt() {
  return trainState.training ? trainState.training.prompt : null;
}

// Mount/unmount the clock for a whole session. During a blitz session the bar
// stays in the layout (merely emptied between cards) so the board never jumps.
export function setBlitzBarVisible(on) {
  const bar = document.getElementById("train-blitz");
  if (bar) bar.hidden = !on;
}

export function clearBlitzTimer() {
  if (trainState.blitzTimer) {
    window.clearTimeout(trainState.blitzTimer);
    trainState.blitzTimer = null;
  }
  hideBlitzClock();
}

function startBlitzTimer(smart, prompt) {
  clearBlitzTimer();
  showBlitzClock(BLITZ_SECONDS);
  trainState.blitzTimer = window.setTimeout(() => {
    trainState.blitzTimer = null;
    const current = trainState.smart;
    // Fire only when this exact first attempt is still waiting on screen;
    // a backgrounded tab or a navigated-away view forfeits the clock, not
    // the card.
    const live =
      current === smart &&
      current.prompt === prompt &&
      current.attempt === 1 &&
      !trainState.trainBusy &&
      appState.currentView === "train" &&
      !document.hidden;
    clearBlitzTimer();
    if (!live) return;
    smart.timeouts = (smart.timeouts || 0) + 1;
    submitSmartMove("0000", { timedOut: true });
  }, BLITZ_SECONDS * 1000);
}

let smartStartSeq = 0;

async function startSmartTraining(options = {}) {
  const seq = ++smartStartSeq;
  const owner = currentOwnerId();
  const entryCurrent = options.isCurrent || (() => true), isCurrent = () => entryCurrent() && seq === smartStartSeq && owner === currentOwnerId() && (trainState.trainMode || "smart") === "smart";
  const fresh = !!options.fresh;
  trainState.trainResult = null;
  const failed = (text) => {
    trainState.trainStarting = false;
    if (text) trainRowError("smart", text);
    syncTrainSessionControls();
  };
  setTrainBanner(
    "runin",
    "Preparing session…",
    "",
  );
  // Train must see the latest tree: drain unsynced Build edits (adds + deletes)
  // before the server builds the queue, else a just-added line wouldn't be in
  // it and a just-deleted one would.
  const [buildSaved, trainSaved, resumeLoaded, memoLoaded] = await Promise.allSettled([
    hardFlushBuild(), flushTrainSync(), loadTrainResume(),
    trainSessionMemo || import("../train-session-memo.js"),
  ]);
  if (!isCurrent()) return cancelStaleTrainStart(options);
  if (buildSaved.status === "rejected" || buildSaved.value === false) {
    failed("Couldn't save your repertoire edits. Try again in a moment.");
    return;
  }
  // Land any leftover graded attempts (an abandoned previous session) before
  // the new queue is scheduled from SR state. Strict: starting anyway would
  // schedule the queue off stale SR state, so block until the sync lands.
  if (trainSaved.status === "rejected" || !trainSaved.value) {
    failed("Couldn't sync your last session. Check your connection and try again.");
    return;
  }
  let payload;
  let trainResume;
  const targets = options.targetNodeIds || [];
  try {
    if (resumeLoaded.status === "rejected") throw resumeLoaded.reason;
    trainResume = resumeLoaded.value;
    if (memoLoaded.status === "fulfilled") trainSessionMemo = memoLoaded.value;
    // The scope is explicit: the entry's repertoire, else the Due row's scope.
    const repertoireId = options.repertoireId || trainState.trainScope?.repertoireId || null;
    payload = await postJson("/api/train/smart/start", {
      mixed: !repertoireId,
      fresh: fresh || !!targets.length,
      ...(repertoireId ? { repertoire_id: repertoireId } : {}),
      ...(targets.length ? { target_node_ids: targets } : {}),
    });
  } catch (error) {
    if (!isCurrent()) return cancelStaleTrainStart(options);
    if (isAuthError(error)) {
      failed("");
      accountService().handleAuthRequired("Sign in to start training");
      return;
    }
    failed(isNothingToTrainError(error) ? "Nothing to train here. Add lines in Repertoire." : "Couldn't build your queue. Try again in a moment.");
    return;
  }
  if (!isCurrent()) return cancelStaleTrainStart(options);
  // The URL names the repertoire the queue drills; a mixed queue drills all of
  // them, so it names none. Keeping the anchor here would write ?rep=<anchor>
  // into a Train link that is not about that repertoire.
  trainState.trainingRepertoireId = payload.mixed ? null : payload.repertoire_id;
  const mapped = trainResume.mapTrainUiSession(payload, { fresh });
  // A resumed session without a memo must not inherit unrelated counters.
  trainStatsReset();
  invalidateTrainPreview(); // the queue it described is being played now
  trainState.training = null; // leave line rehearsal if it was active
  // A restart can interrupt an in-flight run-in; its early-return leaves the
  // busy flag set, so clear it before the new session takes the board.
  trainState.trainBusy = false;
  clearBlitzTimer();
  // The whole session runs locally off this card bundle (grading, advancement,
  // requeue, skip); only graded attempts + the position sync back, batched.
  const queue = mapped.queue;
  if (!queue.length) {
    failed("Nothing to train here. Add lines in Repertoire.");
    return;
  }
  trainState.smart = {
    sessionId: mapped.sessionId,
    generation: mapped.generation,
    // The position sync's token: without it the server never applies the
    // session's position, so a finished queue resumed from its first card.
    stateVersion: mapped.stateVersion,
    seed: mapped.seed,
    repertoireId: mapped.repertoireId,
    repertoireName: mapped.repertoireName,
    color: mapped.color,
    mixed: mapped.mixed,
    scopeLabel: targets.length ? countOf(targets.length, "picked move") : payload.repertoire_name,
    queue,
    requeueGap: payload.requeue_gap,
    cardKinds: Object.fromEntries(payload.card_kinds.map((kind) => [kind.key, kind])),
    cardIndex: mapped.cardIndex,
    targetIndex: mapped.targetIndex,
    totalCards: mapped.totalCards,
    counts: { ...(mapped.counts || {}) },
    healthBefore: mapped.healthBefore,
    prompt: null,
    attempt: 1,
    cardsDone: mapped.cardsDone,
    retriesFixed: 0,
    // Snapshot the toggle so flipping it mid-session can't change the rules.
    blitz: blitzEnabled(),
    timeouts: 0,
  };
  // A reload resumes at the server's card index; bring back this session's
  // own first-try stats and starting health so the summary covers all of it.
  trainState.trainStats = trainSessionMemo?.restoreSmartSession(currentOwnerId(), mapped, trainState.smart) || trainState.trainStats;
  rememberSmartSession();
  // F-06: this session is the first practice for every queued "train this
  // mistake" handoff — stamp takenAt so the mistake→practice time is measurable.
  for (const handoff of pendingHandoffs({ reason: "practice-missed-move" })) {
    const scheduled = queue.some((card) =>
      (!handoff.repertoireId || String(card.repertoire_id || payload.repertoire_id) === String(handoff.repertoireId)) &&
      card.targets?.some((target) => target.fen_before === handoff.anchorFen));
    if (scheduled && ["pending", "prepared"].includes(handoff.status)) transitionHandoff(handoff.key, "queued");
  }
  setBlitzBarVisible(trainState.smart.blitz);
  if (boards.train && payload.color) {
    boards.train.setOrientation(payload.color === "black" ? "black" : "white");
  }
  await renderTrainStats();
  if (!isCurrent()) return;
  setTrainSyncState("saved");
  document.getElementById("train-board-label").textContent =
    `${payload.repertoire_name} · you play ${payload.color}`;
  syncWorkspaceUrl();
  const resumedAttempt = trainState.smart.attempt;
  const prompt = smartLocalPrompt(trainState.smart);
  if (!prompt) {
    await finishSmartSession();
    return;
  }
  await presentSmartPrompt(prompt, { attempt: resumedAttempt });
}

// Build the current prompt from the local queue — the client-side counterpart
// of the server's _prompt_from_context. Legal moves come from chess.js, the
// rest is precomputed in the start bundle.
function smartLocalPrompt(smart) {
  const card = smart.queue[smart.cardIndex];
  if (!card) return null;
  const target = card.targets[smart.targetIndex];
  if (!target) return null;
  let legal = [];
  try {
    legal = localBoardInfo(target.fen_before).legal_moves;
  } catch {
    /* malformed FEN: the board just won't accept moves */
  }
  return {
    session_id: smart.sessionId,
    card_index: smart.cardIndex,
    total_cards: smart.queue.length,
    kind: card.kind,
    target_index: smart.targetIndex,
    targets_total: card.targets.length,
    expected_node_id: target.node_id,
    expected_uci: target.uci,
    expected_san: target.san,
    fen_before: target.fen_before,
    start_fen: target.start_fen,
    run_in: target.run_in || [],
    hint: target.hint || {},
    legal_moves: legal,
    target,
  };
}

// Show one card prompt: animate the run-in (unless the board is already on the
// position, i.e. mid-card right after the opponent's reply), then open the
// board for the answer — teach-first when the card is new.
async function presentSmartPrompt(prompt, { attempt = 1 } = {}) {
  const smart = trainState.smart;
  if (!smart || !prompt) return;
  smart.prompt = prompt;
  smart.attempt = attempt;
  trainState.trainStarting = false;
  trainState.trainHintLevel = 0;
  setTrainHintLine("");
  await renderSmartProgress(prompt);
  const board = boards.train;
  board.setEngineArrow(null);
  // Mixed sessions hop between repertoires: orient the board and name the
  // repertoire per card (the bundle carries color/name on every card).
  const cardMeta = smart.queue[smart.cardIndex];
  if (cardMeta && cardMeta.color) {
    board.setOrientation(cardMeta.color === "black" ? "black" : "white");
    document.getElementById("train-board-label").textContent =
      `${cardMeta.repertoire_name || smart.repertoireName} · you play ${cardMeta.color}`;
  }
  // The previous card's last move only counts as the cue when the board is
  // already sitting on this prompt's position; a jump to a new position (e.g.
  // a move-1 card back at the start) must not keep the old highlight.
  let cueUci = board.fen === prompt.fen_before ? board.lastMove || null : null;
  if (board.fen !== prompt.fen_before) {
    trainState.trainBusy = true;
    syncTrainSessionControls();
    const plan = planTrainRunIn(prompt, board.fen, smart.contextPath);
    smart.contextPath = plan.path;
    const runIn = plan.moves;
    if (runIn.length || plan.rewind?.length) {
      const cue = runIn[runIn.length - 1];
      // The board label already names the repertoire and side.
      setTrainBanner("runin", prompt.target_index ? "Continue the line" : "Next line", cue?.san || "");
      const played = await playTrainRunIn(board, plan, {
        active: () => trainState.smart === smart && smart.prompt === prompt,
        sleep,
      });
      if (played.stopped) return;
      cueUci = played.cueUci;
    }
    if (trainState.smart !== smart || smart.prompt !== prompt) return;
    trainState.trainBusy = false;
  }
  board.setPosition({
    fen: prompt.fen_before,
    legalMoves: prompt.legal_moves || [],
    lastMove: cueUci,
  });
  if (!smart.contextPath || prompt.target_index === 0) smart.contextPath = prompt.run_in || [];
  const side = sideToMoveFromFen(prompt.fen_before);
  updateTrainTurnBadge(side);
  if (prompt.kind === "new") {
    // Teach-then-test: show the move and its idea; playing it (graded) is the
    // first, easy rep — the real test comes when spaced repetition brings it back.
    setTrainBanner(
      "teach",
      `New move: ${prompt.expected_san}`,
      teachWhy(prompt, "")
    );
    board.setEngineArrow(prompt.expected_uci);
    clearBlitzTimer(); // learning is never against the clock
  } else {
    const cueSan = promptCueSan(smart, prompt);
    setTrainBanner(
      "move",
      "Your move",
      `${trainState.smart.cardKinds[prompt.kind]?.label || "Review"} · ${cueSan ? `answer ${cueSan}` : "play your prep"}`,
    );
    if (smart.blitz && smart.attempt === 1) startBlitzTimer(smart, prompt);
    else clearBlitzTimer();
  }
  trackPreparationPractice({ repertoireId: cardMeta?.repertoire_id || smart.repertoireId,
    nodeId: prompt.expected_node_id, fen: prompt.fen_before });
  prefetchTrainCoach(prompt);
  syncTrainSessionControls();
}

function prefetchTrainCoach(prompt) {
  void import("./train-coach.js").then((mod) => {
    if (trainState.smart?.prompt !== prompt) return;
    return mod.prefetchTrainCoach(prompt, { trainState, maiaPhaseCoach, setTrainBanner, trainTeachLine });
  }).catch((error) => { if (trainState.smart?.prompt === prompt) console.warn("Train coach unavailable", error); });
}

// After a second wrong attempt the card returns a few positions later — unless
// an identical copy is already pending, so a stubborn miss queues one retry at
// a time. Parity with SmartTrainingService._requeue_card.
function requeueSmartCard(smart) {
  const card = smart.queue[smart.cardIndex];
  if (!card) return false;
  const pendingAhead = smart.queue.slice(smart.cardIndex + 1);
  if (pendingAhead.some((c) => c.encoded === card.encoded)) return false;
  const insertAt = Math.min(smart.cardIndex + smart.requeueGap, smart.queue.length);
  smart.queue.splice(insertAt, 0, card);
  return true;
}

async function submitSmartMove(playedUci, { timedOut = false } = {}) {
  const smart = trainState.smart;
  if (!smart || !smart.prompt || !playedUci || trainState.trainBusy) return;
  clearBlitzTimer(); // answered (or timed out) — stop the countdown right away
  const prompt = smart.prompt;
  const attempt = smart.attempt;
  // Land the dragged move immediately; a blitz timeout has no real move to show.
  // The graded cue below covers the landing, so it stays quiet.
  trainState.trainBusy = true;
  if (!timedOut) await optimisticBoardMove(boards.train, prompt.fen_before, playedUci, false);
  if (trainState.smart !== smart || smart.prompt !== prompt) return;
  const other = !timedOut && (prompt.target?.alternatives || []).find((alt) => alt.uci === playedUci);
  if (other) {
    return answerAlternative({
      fen: prompt.fen_before, playedUci, san: other.san,
      still: () => trainState.smart === smart && smart.prompt === prompt,
      reopen: () => {
        boards.train.setPosition({ fen: prompt.fen_before, legalMoves: prompt.legal_moves || [], lastMove: null, back: true });
        if (prompt.kind === "new" || attempt >= 3) boards.train.setEngineArrow(prompt.expected_uci);
        if (smart.blitz && attempt === 1 && prompt.kind !== "new") startBlitzTimer(smart, prompt);
      },
    });
  }
  // Grade locally — the prompt carries the answer (it's the player's own
  // repertoire). Only the first attempt writes spaced repetition; it lands on
  // the server in the next debounced /smart/sync batch, not per move.
  const correct = playedUci === prompt.expected_uci;
  // Recall means unaided: an answer after a hint grades Hard on the server and
  // stays out of the first-try stats, and a new move's demonstration (the arrow
  // shows it) is not a recall at all. Its SR write still marks it learned.
  const hinted = trainState.trainHintLevel > 0;
  const scored = prompt.kind !== "new";
  if (attempt === 1) queueTrainAttempt(smart, prompt.expected_node_id, correct, hinted);
  if (correct) trackPreparationPractice({
    repertoireId: smart.queue[smart.cardIndex]?.repertoire_id || smart.repertoireId,
    nodeId: prompt.expected_node_id, fen: prompt.fen_before, completed: true,
  });
  const stats = trainState.trainStats || (trainStatsReset(), trainState.trainStats);

  if (!correct) {
    // Only the first answer is graded (matches the synced SR write); the
    // accuracy chips therefore never count retries.
    if (attempt === 1) {
      // A first-try miss ends the run, same as Line rehearsal.
      if (scored) tallyAnswer(stats, false);
      rememberSmartSession({ attempt: attempt + 1 });
      await renderTrainStats();
    }
    trainState.trainBusy = true;
    let playedSan = "";
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      playedSan = after.move?.san || "";
      boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: playedUci, cue: false });
    } catch {
      // Wrong-move preview is cosmetic (a blitz timeout has no move to show);
      // grading already happened above.
    }
    playSound("wrong");
    if (attempt === 1) {
      // First miss: a free retry with the idea as a tip, no reveal. The blitz
      // retry is untimed — the clock tests recall, the retry rebuilds it.
      const missTip = () => wrongMoveTip({
        hintLevel: trainState.trainHintLevel, hint: prompt.hint, expectedSan: prompt.expected_san,
      });
      const show = (tip) => {
        const banner = wrongMoveBanner({ attempt, playedSan, expectedSan: prompt.expected_san, tip, timedOut });
        setTrainBanner(banner.state, banner.title, banner.sub);
      };
      show(missTip());
      maiaPhaseCoach({ fen: prompt.fen_before, expectedUci: prompt.expected_uci, expectedSan: prompt.expected_san, playedUci })
        .then((model) => {
          if (!(trainState.smart && trainState.smart.prompt === prompt && model)) return;
          prompt.phaseCoach = model;
          // A retry can already have succeeded or revealed the answer while
          // this inference was pending; its feedback owns the banner now.
          if (!coachTipMayReplace(trainState.trainHintLevel) || !model.tip) return;
          if (document.getElementById("train-banner")?.dataset.state === "wrong") show(model.tip);
        })
        .catch(() => {});
    } else {
      // Second miss: reveal, let the answer be played, and the card returns
      // a few positions later.
      stats.streak = 0;
      await renderTrainStats();
      const requeued = requeueSmartCard(smart);
      if (requeued) {
        smart.totalCards = smart.queue.length;
        smart.counts[prompt.kind] = (smart.counts[prompt.kind] || 0) + 1;
        markTrainPositionDirty();
      }
      rememberSmartSession({ attempt: attempt + 1 });
      const banner = wrongMoveBanner({ attempt, expectedSan: prompt.expected_san, tip: trainTeachLine(prompt, prompt.phaseCoach) });
      setTrainBanner(banner.state, banner.title, requeued ? `${banner.sub} It comes back soon.` : banner.sub);
    }
    await sleep(950);
    if (trainState.smart !== smart || smart.prompt !== prompt) return;
    boards.train.setPosition({
      fen: prompt.fen_before,
      legalMoves: prompt.legal_moves || [],
      lastMove: null, back: true, // the tried move travels home, not again
    });
    if (attempt >= 2) boards.train.setEngineArrow(prompt.expected_uci);
    trainState.trainBusy = false;
    smart.attempt = attempt + 1;
    return;
  }

  if (prompt.kind === "new") {
    stats.learned = (stats.learned || 0) + 1;
    if (attempt > 1) stats.learnedRetry = (stats.learnedRetry || 0) + 1;
  }
  if (attempt > 1) {
    // "Fixed on retry" is a scored miss recovered on the free retry; a revealed
    // answer was not recalled and a New move's demonstration was never scored.
    if (scored && attempt === 2) smart.retriesFixed += 1;
  } else if (scored) {
    tallyAnswer(stats, !hinted);
  }
  // Store the next cursor before animating an already-counted answer.
  rememberSmartSession({ advance: true });
  await renderTrainStats();
  trainState.trainBusy = true;
  boards.train.setEngineArrow(null);

  // 1) Land the player's move, 2) after a beat the opponent replies, 3) flow
  // straight into the next prompt (same-card prompts skip the run-in because
  // the board is already on the position).
  const target = prompt.target;
  // A "new" card is a demonstration, not an answer: it keeps the board's own
  // move sound, and only a real recall gets the success cue.
  const demonstrating = prompt.kind === "new";
  boards.train.setPosition({
    fen: target.fen_after || prompt.fen_before,
    legalMoves: [],
    lastMove: playedUci,
    cue: demonstrating ? undefined : false,
  });
  if (!demonstrating) playSound("right");
  const praise =
    prompt.kind === "new" ? "Learned" : attempt > 1 ? "Got it this time" : hinted ? "Correct, with a hint" : "Correct";
  setTrainBanner("correct", praise, target.san ? `You played ${target.san}` : "");
  if (target.reply && target.reply.uci && target.reply.fen_after) {
    await sleep(240);
    if (trainState.smart !== smart) return; // mode switched mid-animation
    boards.train.setPosition({
      fen: target.reply.fen_after,
      legalMoves: [],
      lastMove: target.reply.uci,
    });
    await sleep(220);
  } else {
    await sleep(300);
  }
  if (trainState.smart !== smart) return;
  // Advance the local session: next target inside the card, else next card.
  const card = smart.queue[smart.cardIndex];
  const lineDone = !(card && smart.targetIndex + 1 < card.targets.length);
  smart.contextPath = [...(smart.contextPath || []),
    { uci: playedUci, fen_after: target.fen_after },
    ...(target.reply ? [target.reply] : [])];
  if (!lineDone) {
    smart.targetIndex += 1;
  } else {
    smart.cardsDone += 1;
    smart.cardIndex += 1;
    smart.targetIndex = 0;
  }
  markTrainPositionDirty();
  trainState.trainBusy = false;
  const next = smartLocalPrompt(smart);
  if (next) {
    await presentSmartPrompt(next);
  } else {
    await finishSmartSession();
  }
}

async function skipSmartCard() {
  const smart = trainState.smart;
  if (!smart || !smart.prompt) {
    setStatus("No active card");
    return;
  }
  if (trainState.trainBusy) return;
  clearBlitzTimer();
  trainState.trainStats.skipped += 1;
  // Local advance — the position syncs with the next debounced flush.
  smart.cardIndex += 1;
  smart.targetIndex = 0;
  smart.attempt = 1;
  rememberSmartSession();
  markTrainPositionDirty();
  const next = smartLocalPrompt(smart);
  if (next) {
    await presentSmartPrompt(next);
  } else {
    setStatus("Session complete");
    await finishSmartSession();
  }
}

// The hint the player asked for, held in the stats card next to the board (the
// coach strip above the board is out of sight on a phone). Cleared with the card.
function setTrainHintLine(text) {
  const el = document.getElementById("train-hint-line");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
  if (text) el.scrollIntoView({ block: "nearest" });
}

// Progressive hint, fully local — the prompt already carries the idea, the
// piece, and the answer (it's the player's own repertoire, not a quiz).
function smartHint() {
  const prompt = trainState.smart && trainState.smart.prompt;
  if (!prompt) {
    setStatus("Start a session first");
    return;
  }
  if (trainState.trainBusy) return;
  setTrainHintLine(showHint({ ...prompt.hint, expected_uci: prompt.expected_uci, expected_san: prompt.expected_san }));
}

let trainSessionMemo = null;
function rememberSmartSession(progress = {}) {
  const smart = trainState.smart;
  if (!smart || !smart.sessionId || !trainState.trainStats) return;
  trainSessionMemo?.saveSmartSession(currentOwnerId(), smart, trainState.trainStats, progress);
}

// The finished queue's Result is up the moment the last card is answered; the
// flush and the server summary then fill in what changed (the card reserves
// that line's height, so nothing shifts).
async function finishSmartSession() {
  const smart = trainState.smart;
  if (!smart) return;
  const stats = trainState.trainStats || {};
  smart.prompt = null;
  trainSessionMemo?.finishSmartSessionMemo(currentOwnerId(), smart, stats);
  clearBlitzTimer();
  setBlitzBarVisible(false);
  boards.train.setEngineArrow(null);
  updateTrainTurnBadge(null);
  // End on the last card's final position (its last answer, plus the reply when the
  // line has one) instead of wherever the board happened to be mid-line.
  const lastCard = smart.queue[smart.queue.length - 1];
  const lastTarget = lastCard && lastCard.targets && lastCard.targets[lastCard.targets.length - 1];
  const finalReply = lastTarget && lastTarget.reply && lastTarget.reply.fen_after ? lastTarget.reply : null;
  const finalFen = finalReply ? finalReply.fen_after : lastTarget && lastTarget.fen_after;
  if (finalFen) {
    boards.train.setPosition({
      fen: finalFen,
      legalMoves: [],
      lastMove: finalReply ? finalReply.uci : lastTarget.uci,
      cue: false, // the completion cue covers the last move
    });
  }
  document.getElementById("train-board-label").textContent = finalFen ? "Final position" : "";
  showTrainResult({ ...smartResult(smart, stats), runId: `${smart.sessionId}:${smart.generation}` });
  invalidateTrainPreview();
  celebrate();
  // Flush the graded attempts FIRST so the "after" health includes this session.
  await flushTrainSync().catch(() => {});
  let after = null;
  try {
    const ld = encodeURIComponent(localDateString());
    after = await api(
      smart.mixed
        ? `/api/train/smart/summary?mixed=true&local_date=${ld}`
        : `/api/train/smart/summary?repertoire_id=${encodeURIComponent(smart.repertoireId)}&local_date=${ld}`
    );
  } catch {
    // The summary is a bonus — never block the finish on it.
  }
  if (after?.day_streak) appState.dayStreak = after.day_streak;
  // Every cached count of what is left to train is now stale, even if the user has left.
  refreshRepertoireHead();
  void refreshDashboardRepertoires().catch(() => {});
  invalidateTrainPreview();
  // The user may have moved on while the summary loaded.
  if (trainState.smart !== smart || trainState.trainResult?.mode !== "smart") return;
  trainState.smart = null;
  showTrainResult({ ...smartResult(smart, stats, after), runId: `${smart.sessionId}:${smart.generation}` });
}
