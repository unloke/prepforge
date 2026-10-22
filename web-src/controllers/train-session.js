import { html } from "../html.js";
// Train sessions: the smart queue, line rehearsal, practice games and Feeling Lucky.
// Lazy-loaded by app.js the first time Train is used. The functions stay at module
// level; createTrainSession binds the app.js state and helpers they share, once.

import { isAuthError } from "../auth-gate.js";
import { localBoardInfo } from "../chess-local.js";
import { getSharedMaia3Provider } from "../engine/maia3-provider.js";
import { maiaErrorText, watchMaiaInit } from "../maia-init-notice.js";
import { pendingHandoffs, trackPreparationPractice, transitionHandoff } from "../handoff-context.js";
import { countOf } from "../plural.js";
import { coachTipMayReplace, promptCueSan, teachWhy, trainTeachLine, wrongMoveBanner, wrongMoveTip } from "../train-hint.js";
import { createTrainRecovery } from "../train-recovery.js";
import { pickOpponentReply, playPositionAfterReply, replyReasonNote, unavailableExplorer } from "../train-opponent.js";
import { formatPlayTrail, playBookName, playSessionPgn, resolvePlayColor, takebackToUserMove } from "../train-play.js";
import { isNothingToTrainError } from "../train-start.js";
import { createTrainHome, invalidateTrainPreview, loadTrainRepertoireOptions, playBook, playPickerColor, playRepertoireMeta, selectedTrainRepertoireIds, setPlayPickerColor, syncTrainScreen, trainRowError } from "./train-home.js";
import { drillResult, playResult, smartResult } from "../train-result.js";
import { saveRun } from "../train-history.js";

let accountService, api, appState, BLITZ_SECONDS, blitzEnabled, boardAfterMove, boardInfo, boards,
  currentOwnerId, effectiveMaiaRating, ensureExplorerClient, ensureTrainView, flushTrainSync, hardFlushBuild, loadPgnIntoAnalyze,
  loadTrainResume, localDateString, maiaPhaseCoach, markTrainPositionDirty, openAuthModal,
  notices, optimisticBoardMove, playSound, postJson, queueTrainAttempt,
  refreshAuthStatus, refreshDashboardRepertoires, refreshRepertoireHead, renderTrainStats, requireSignIn, setStatus, setStatusError, setTrainBanner,
  setTrainSyncState, sleep, START_FEN, switchView, syncViewHeads,
  syncWorkspaceUrl, updateTrainTurnBadge, trainRecovery, home;

export function createTrainSession(deps) {
  ({
    accountService, api, appState, BLITZ_SECONDS, blitzEnabled, boardAfterMove, boardInfo,
    boards, currentOwnerId, effectiveMaiaRating, ensureExplorerClient, ensureTrainView,
    flushTrainSync, hardFlushBuild, loadPgnIntoAnalyze,
    loadTrainResume, localDateString, maiaPhaseCoach, markTrainPositionDirty,
    notices, openAuthModal, optimisticBoardMove, playSound, postJson,
    queueTrainAttempt, refreshAuthStatus, refreshDashboardRepertoires, refreshRepertoireHead,
    renderTrainStats, requireSignIn,
    setStatus, setStatusError, setTrainBanner, setTrainSyncState, sleep, START_FEN,
    switchView, syncViewHeads, syncWorkspaceUrl, updateTrainTurnBadge,
  } = deps);
  trainRecovery = createTrainRecovery({
    api, appState, boards, currentOwnerId, notices, setStatus, setStatusError,
    setTrainBanner, syncTrainSessionControls, renderTraining, finishTrainingSession,
  });
  home = createTrainHome({
    ...deps, startTraining, startPlaySessionTracked, onFeelingLucky, trainHint, skipTrainingLine,
    takebackPlaySession, resignPlaySession, openPlayInAnalyze, clearBlitzTimer, setBlitzBarVisible, resetTrainBoardIdle,
  });
  return {
    clearBlitzTimer, loadTrainRepertoireOptions, onFeelingLucky, openPlayInAnalyze, openTrain: home.openTrain,
    resetTrainBoardIdle, resignPlaySession, setBlitzBarVisible, setPlayPickerColor,
    skipTrainingLine, startPlaySessionTracked, startTraining, submitTrainingMove,
    syncTrainControls: syncTrainSessionControls, takebackPlaySession, trainHint,
  };
}


async function skipTrainingLine() {
  if (appState.play && appState.play.active) {
    setStatus("Skip is for the spaced-repetition queue. Start or Feeling Lucky to change position.");
    return;
  }
  if (appState.smart) {
    await skipSmartCard();
    return;
  }
  const prompt = currentTrainingPrompt();
  if (!prompt) {
    setStatus("No active training line");
    return;
  }
  try {
    const result = await postJson("/api/train/skip", { session_id: prompt.session_id });
    if (result.prompt) {
      appState.training.prompt = result.prompt;
      await renderTraining(result.prompt);
    } else {
      finishTrainingSession();
    }
  } catch (error) {
    setStatusError(error.message);
  }
}

function applyTrainingPromptState(prompt) {
  if (appState.training) appState.training.prompt = prompt;
  appState.trainHintLevel = 0;
  appState.trainHintInfo = null;
}

async function renderTraining(payloadOrPrompt, options) {
  const prompt = payloadOrPrompt?.prompt || payloadOrPrompt;
  if (!prompt) return;
  applyTrainingPromptState(prompt);
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
  const busy = !!appState.trainBusy;
  const teaching = state === "teach" || state === "reveal" || state === "runin";
  document.getElementById("train-hint").disabled = busy || teaching;
  document.getElementById("train-skip").disabled = busy;
  const history = appState.play && appState.play.history;
  document.getElementById("play-takeback").disabled = !(history && history.length);
  document.getElementById("play-resign").disabled = !(appState.play && appState.play.active);
  syncTrainScreen();
  syncViewHeads();
}

async function resetTrainBoardIdle(label) {
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
  } catch (_) {
    boards.train.setPosition({ fen: START_FEN, legalMoves: [], lastMove: null });
  }
}


function trainStatsReset() {
  appState.trainStats = { correct: 0, mistakes: 0, skipped: 0, streak: 0, best: 0, history: [], lastStreak: 0, learned: 0, learnedRetry: 0 };
}

function sideToMoveFromFen(fen) {
  return (fen || "").split(" ")[1] === "b" ? "black" : "white";
}

async function startTraining(mode, options = {}) {
  mode = mode || appState.trainMode || "smart";
  // Practice game starts via startPlaySession; never post "play" to /api/train/start (422).
  if (mode === "play") return;
  appState.trainMode = mode;
  appState.trainResult = null;
  // Training runs against your own repertoires and review schedule, so a
  // guest gets the sign-in gate — not a "Nothing to train yet" that blames an
  // empty repertoire and a raw "not authenticated".
  if (!appState.signedIn) {
    appState.trainStarting = false;
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
  const isCurrent = () => seq === smartStartSeq && owner === currentOwnerId() && appState.trainMode === mode;
  appState.smart = null;
  clearBlitzTimer();
  setBlitzBarVisible(false);
  // A caller that names the repertoire (a deep link, a repertoire's own Train
  // action) is the source of truth; otherwise Start follows the Home row.
  const repertoireId = options.repertoireId || appState.trainingRepertoireId;
  appState.trainingRepertoireId = repertoireId;
  const failed = (text) => {
    appState.trainStarting = false;
    appState.training = null;
    trainRowError(mode, text);
    syncTrainSessionControls();
  };
  if (!repertoireId) return failed("Pick a repertoire to rehearse.");
  setTrainBanner("runin", "Opening your lines…", "");
  // Same freshness rule as the smart queue: unsynced Build edits must land
  // before the server walks the tree into lines.
  try {
    await hardFlushBuild();
    if (!isCurrent()) return;
  } catch (error) {
    if (isCurrent()) failed(error.message);
    return;
  }
  const fresh = !!options.fresh;
  const body = { seed: 13, mode, repertoire_id: repertoireId, fresh };
  try {
    const { mapTrainUiSession, shouldResetTrainStats } = await loadTrainResume();
    if (!isCurrent()) return;
    const payload = await postJson("/api/train/start", body);
    if (!isCurrent()) return;
    if (!payload.prompt) return failed("No moves to rehearse. Add lines in Repertoire.");
    appState.training = payload;
    appState.trainAttempt = 1;
    const mapped = mapTrainUiSession(payload, { fresh });
    if (shouldResetTrainStats(mapped)) trainStatsReset();
    if (boards.train && payload.color) {
      boards.train.setOrientation(payload.color === "black" ? "black" : "white");
    }
    appState.trainStarting = false;
    await renderTrainStats();
    await renderTraining(payload);
    syncWorkspaceUrl();
  } catch (error) {
    if (!isCurrent()) return;
    failed(isNothingToTrainError(error) ? "No moves to rehearse. Add lines in Repertoire." : error.message);
  }
}







function playBookLabel(play) {
  const session = play || appState.play;
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
  const play = appState.play;
  const text = play && play.history && play.history.length
    ? formatPlayTrail(play.history, play.startFen)
    : "";
  el.hidden = !play;
  el.innerHTML = text ? html`<span class="play-trail-sans">${text}</span>` : "";
  const chip = document.getElementById("train-play-chip");
  if (chip) {
    const reason = play && play.luckyReason;
    if (reason) {
      chip.hidden = false;
      chip.textContent =
        reason === "miss"
          ? "Engine miss"
          : reason === "departure"
            ? "Left prep"
            : reason === "fork"
              ? "Repertoire fork"
                : reason === "db-critical"
                  ? `Master game · ${play && play.luckyPhase ? play.luckyPhase : "critical"}`
                : reason === "titled-game"
                  ? `${play && String(play.luckySource || "").startsWith("lichess-") ? "Live Lichess game" : "Titled reference"} · ${play && play.luckyPhase ? play.luckyPhase : "critical"}`
                  : reason;
    } else {
      chip.hidden = true;
      chip.textContent = "";
    }
  }
  syncTrainSessionControls();
}

function recordPlayPly(ply) {
  const play = appState.play;
  if (!play) return;
  play.history = play.history || [];
  play.history.push(ply);
  renderPlayTrail();
}

function playChildren(nodeId) {
  if (!appState.build || !nodeId) return [];
  return (appState.build.nodes || []).filter(
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
  const play = appState.play;
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
async function fetchPlayMaia(fen) {
  // Train Play opponent fallback is Maia-by-design (thin Explorer positions
  // fall back to human-like replies), independent of the Analyze-layer switch.
  try {
    const provider = getSharedMaia3Provider();
    const maiaNotice = watchMaiaInit(provider, {
      notices,
      onRetry: () => {
        // The failure above sets play.active = false, so gating on it would make
        // the notice's Retry a dead button exactly when it is needed. Re-asking
        // the same position is what the user asked for.
        const play = appState.play;
        if (play?.fen === fen) {
          play.active = true;
          void playOpponentReply();
        }
      },
    });
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
function startPlaySessionTracked(options) {
  const pending = startPlaySession(options).finally(() => {
    if (appState.playStarting === pending) appState.playStarting = null;
  });
  appState.playStarting = pending;
  return pending;
}

async function startPlaySession({
  fen,
  reason,
  phase,
  nodeId: luckyNodeId,
  gameId: luckyGameId,
  white: luckyWhite,
  black: luckyBlack,
  source: luckySource,
  sourceUrl: luckySourceUrl,
} = {}) {
  if (appState.trainMode !== "play") return false;
  const startToken = appState.playStartToken = (appState.playStartToken || 0) + 1;
  const isCurrentStart = () => appState.playStartToken === startToken && appState.trainMode === "play";
  appState.smart = null;
  appState.training = null;
  appState.trainResult = null;
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
      trainRowError("play", error.message);
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
  if (luckyNodeId) nodeId = luckyNodeId;
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
  appState.play = {
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
    luckySource: luckySource || null,
    luckySourceUrl: luckySourceUrl || null,
  };
  if (boards.train) {
    boards.train.setOrientation(userColor);
  }
  const why =
    reason === "miss"
      ? "Engine miss: your move"
      : reason === "departure"
        ? "You left prep here: your move"
        : reason === "fork"
          ? "A real fork: more than one human reply"
              : reason === "db-critical"
                ? `Master game, critical ${phase || "moment"}: your move`
              : reason === "titled-game"
                  ? `${String(luckySource || "").startsWith("lichess-") ? "Live Lichess game" : "Titled reference"}, critical ${phase || "moment"}: your move`
              : "";
  const luckyMeta =
    reason === "titled-game" && luckyGameId
      ? ` · ${[luckyWhite, luckyBlack].filter(Boolean).join(" vs ") || "Lichess game"} (${luckyGameId})`
      : "";
  paintPlayPosition({
    fen: info.fen,
    legalMoves: sideToMoveFromFen(info.fen) === userColor ? info.legal_moves : [],
    banner: "Your move",
    sub: `${why}${luckyMeta}`,
    label: playBookLabel(appState.play),
  });
  renderPlayTrail();
  syncTrainSessionControls();
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
  const play = appState.play;
  if (!play || !play.active) return;
  const fen = play.fen;
  const seq = (play.replySeq || 0) + 1;
  play.replySeq = seq;
  const isCurrent = () => appState.play === play && play.active && play.fen === fen && play.replySeq === seq;
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
      // Already known to need sign-in / a linked account: don't ask every move.
      explorer = { totalGames: 0, moves: [], unavailable: play.explorerOff };
    } else {
      explorer = await fetchPlayExplorer(fen);
      if (!isCurrent()) return;
      if (explorer.unavailable === "sign-in" || explorer.unavailable === "link") {
        play.explorerOff = explorer.unavailable;
      }
    }
  }
  let maiaPredictions = [];
  let reply = pickOpponentReply({
    book: play.book,
    legalUcis: info.legal_moves,
    explorer,
    repertoireReplies,
    repertoireChildren: play.book === "repertoire" ? [] : playChildren(play.nodeId),
    maiaPredictions,
  });
  if (!reply.uci) {
    const maia = await fetchPlayMaia(fen);
    if (!isCurrent()) return;
    // Maia could not start at all: say so and keep the session retryable. The
    // download/init failure already carries a Retry notice, so this only names
    // the reason on the board instead of blaming the book.
    if (maia.error) {
      endPlayGame("Opponent unavailable", maiaErrorText(maia.error));
      return;
    }
    maiaPredictions = maia;
    reply = pickOpponentReply({
      book: play.book,
      legalUcis: info.legal_moves,
      explorer,
      repertoireReplies,
      repertoireChildren: play.book === "repertoire" ? [] : playChildren(play.nodeId),
      maiaPredictions,
    });
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
}

async function submitPlayMove(playedUci) {
  const play = appState.play;
  if (!play || !play.active || !playedUci) return;
  const info = await boardInfo(play.fen);
  if (!info.legal_moves.includes(playedUci)) return;
  const nodeIdBefore = play.nodeId;
  await optimisticBoardMove(boards.train, play.fen, playedUci);
  const after = await boardAfterMove(play.fen, playedUci);
  play.fen = after.board.fen;
  play.ply += 1;
  const repertoireCursorsBefore = playAdvanceNode(playedUci);
  recordPlayPly({
    uci: playedUci,
    san: after.move.san,
    fenBefore: info.fen,
    fenAfter: after.board.fen,
    by: "user",
    nodeIdBefore,
    nodeIdAfter: play.nodeId,
    repertoireCursorsBefore,
    repertoireCursorsAfter: playCursorSnapshot(play),
  });
  boards.train.setPosition({
    fen: after.board.fen,
    legalMoves: [],
    lastMove: playedUci,
  });
  const ended = playPositionAfterReply(after.board);
  if (ended.terminal) {
    play.result = ended.result;
    endPlayGame(ended.banner);
    return;
  }
  await playOpponentReply();
}

async function onFeelingLucky() {
  if (appState.luckyBusy) return;
  appState.luckyBusy = true;
  const luckyButton = document.getElementById("feeling-lucky");
  if (luckyButton) {
    luckyButton.disabled = true;
    luckyButton.setAttribute("aria-busy", "true");
  }
  try {
    return await runFeelingLuckyClick();
  } finally {
    appState.luckyBusy = false;
    if (luckyButton) {
      luckyButton.disabled = false;
      luckyButton.removeAttribute("aria-busy");
    }
  }
}

async function runFeelingLuckyClick() {
  // Feeling Lucky is on-demand live-data discovery: after this click, Lichess
  // supplies a fresh titled-player feed and the client replays/scores it
  // locally. The slower Masters walk remains a quality fallback when live
  // feeds are empty. Personal repertoire picks live in train-lucky.js.
  //
  // Sign-in still gates the button because the optional Masters fallback uses
  // the Explorer proxy and the resulting position starts a training session.
  // The live game feed itself is anonymous, but keeping this gate preserves
  // the existing training/account contract. The modal this opens is transient —
  // tab navigation dismisses it (dismissTransientOverlays).
  if (!appState.accountUsername) {
    try {
      await refreshAuthStatus();
    } catch (_) {
      // fall through to the sign-in prompt below
    }
  }
  if (!appState.accountUsername) {
    openAuthModal("login", { notice: "Sign in first, then try Feeling Lucky." });
    return;
  }
  // No Lichess-link hard gate: the live Lichess game-feed endpoints are
  // public/anonymous. Do not refresh link status here; that would add a
  // needless network round trip before the actual on-demand game request.
  let dbPicked = null;
  try {
    setTrainBanner("runin", "Finding a position…", "Discovering a fresh titled player");
    const { runFeelingLucky } = await import("../feeling-lucky.js");
    dbPicked = await runFeelingLucky({
      storage: typeof localStorage === "undefined" ? null : localStorage,
      exclude: [appState.lastLuckyFen, appState.play && appState.play.startFen].filter(Boolean),
      rating: effectiveMaiaRating(),
      ensureExplorer: ensureExplorerClient,
      onStatus: setStatus,
      setBanner: (state, title, sub) => setTrainBanner(state, title, sub),
      startSession: async (session) => {
        appState.lastLuckyFen = session.fen;
        return startPlaySessionTracked(session);
      },
    });
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    setStatus(msg);
    // Lucky's own runFeelingLucky already painted the right banner for every
    // outcome (Database unavailable vs Nothing sharp vs Play session). Do not
    // repaint here — a stale overwrite is exactly how "Database unavailable"
    // used to mask the real "Nothing sharp" state.
    return;
  }
  if (!dbPicked) {
    return;
  }
}

async function takebackPlaySession() {
  const play = appState.play;
  if (!play || !play.history || !play.history.length) return;
  play.replySeq = (play.replySeq || 0) + 1;
  const undone = takebackToUserMove(play.history);
  play.history = undone.history;
  play.active = true;
  play.result = null;
  play.fen = undone.fen || play.startFen;
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
      ? "Takeback: play again"
      : playThinkingSub(play),
    label: playBookLabel(play),
    state: yourMove ? "move" : "runin",
  });
  renderPlayTrail();
  if (!yourMove) await playOpponentReply();
}

function resignPlaySession() {
  const play = appState.play;
  if (!play || !play.active) return;
  play.result = play.userColor === "black" ? "1-0" : "0-1";
  const last = play.history && play.history[play.history.length - 1];
  boards.train.setPosition({ fen: play.fen, legalMoves: [], lastMove: last ? last.uci : null });
  endPlayGame("Resigned");
}

// Every way a practice game ends goes to the shared Result card.
// A game that could not go on (no opponent) names why and is not a run.
function endPlayGame(title, failure = "") {
  const play = appState.play;
  if (!play) return;
  play.active = false;
  play.ended = title;
  play.failure = failure;
  updateTrainTurnBadge(null);
  if (play.history?.length && !failure) {
    saveRun(currentOwnerId(), {
      id: `play:${play.startedAt}`, mode: "play", blitz: false, result: title,
      repertoires: (play.repertoires || []).map((rep) => rep.name).filter(Boolean),
      startedAt: new Date(play.startedAt).toISOString(), finishedAt: new Date().toISOString(),
      cards: play.history.filter((ply) => ply.by === "user").length, correct: 0, mistakes: 0, skipped: 0, learned: 0,
    });
  }
  home.showTrainResult({ ...playResult(play), runId: `play:${play.startedAt}` });
}

async function openPlayInAnalyze() {
  const play = appState.play;
  if (!play) return;
  const pgn = playSessionPgn(play);
  const input = document.getElementById("pgn-input");
  if (input) input.value = pgn;
  const drawer = document.getElementById("pgn-drawer");
  if (drawer) drawer.open = true;
  switchView("analyze");
  if (boards.analysis) boards.analysis.setOrientation(play.userColor === "black" ? "black" : "white");
  if (input) {
    await loadPgnIntoAnalyze(input.value, { goToEnd: true, quiet: true }).catch(() => {});
  }
  setStatus("Loaded this Practice game in Analyze");
}

// Another repertoire move at this position is prep, not a miss: it lands,
// slides back, and the same prompt reopens ungraded (Due and Rehearse alike).
async function answerAlternative({ fen, playedUci, san, still, reopen }) {
  appState.trainBusy = true;
  try {
    const after = await boardAfterMove(fen, playedUci);
    boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: playedUci, cue: false });
  } catch (_) {
    // The banner still explains; the board just stays put.
  }
  setTrainBanner("review", "Also in your repertoire", `${san} is your prep too. This card drills another move.`);
  await sleep(900);
  if (!still()) return;
  await reopen();
  appState.trainBusy = false;
}

async function submitTrainingMove(playedUci) {
  if ((appState.trainMode || "smart") === "play") {
    if (!(appState.play && appState.play.active)) {
      // A move made while Start is still setting up, or on the idle start board,
      // opens the game with that move rather than vanishing.
      if (appState.playStarting) {
        const pending = appState.playStarting;
        if (!await pending || appState.trainMode !== "play") return;
      }
      else if (!appState.play && playPickerColor() === "white") await startPlaySessionTracked();
    }
    if (appState.play && appState.play.active) return submitPlayMove(playedUci);
    return;
  }
  if (appState.smart) {
    return submitSmartMove(playedUci);
  }
  const prompt = currentTrainingPrompt();
  if (!prompt || !playedUci || appState.trainBusy) return;
  // A mode switch, another account, or a smart session replaces the training
  // state; every await below re-checks it so an abandoned rehearsal never paints
  // onto whatever took the board (a late failure included).
  const training = appState.training;
  const owner = currentOwnerId();
  const mode = appState.trainMode;
  const superseded = () => appState.training !== training || appState.smart
    || currentOwnerId() !== owner || appState.trainMode !== mode;
  // Land the dragged move on the board right away; the server response below
  // decides whether it advances (correct) or resets (wrong), and its right/wrong
  // cue covers the move, so the landing itself stays quiet.
  await optimisticBoardMove(boards.train, prompt.fen_before, playedUci, false);
  // An answer after a hint advances the line and grades Hard. Only the first
  // attempt at a prompt is graded (the shared wrong-move rule).
  const hinted = appState.trainHintLevel > 0;
  const attempt = appState.trainAttempt || 1;
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
    const hintLevel = appState.trainHintLevel;
    return answerAlternative({
      fen: prompt.fen_before, playedUci, san: result.played_san || playedUci, still: () => !superseded(),
      reopen: async () => {
        await renderTraining(result.prompt || prompt, { keepBanner: true });
        appState.trainHintLevel = hintLevel;
        if (attempt >= 3) boards.train.setEngineArrow(prompt.expected_uci);
      },
    });
  }
  const stats = appState.trainStats || (trainStatsReset(), appState.trainStats);

  if (!result.correct) {
    if (attempt === 1) {
      stats.mistakes += 1;
      stats.streak = 0;
      stats.history.push(false);
      await renderTrainStats();
    }
    appState.trainBusy = true;
    let playedSan = result.played_san || "";
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      playedSan = after.move?.san || playedSan;
      boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: playedUci, cue: false });
    } catch (_) {
      // Keep SAN-only feedback even if the preview move cannot be rendered.
    }
    playSound("wrong");
    const banner = wrongMoveBanner({ attempt, playedSan, expectedSan: result.expected_san });
    setTrainBanner(banner.state, banner.title, banner.sub);
    if (appState.training) appState.training.prompt = result.prompt;
    await sleep(950);
    if (superseded()) return;
    appState.trainBusy = false;
    appState.trainAttempt = attempt + 1;
    if (result.prompt) await renderTraining(result.prompt, { keepBanner: true });
    if (attempt >= 2) boards.train.setEngineArrow(result.expected_uci);
    return;
  }
  appState.trainAttempt = 1;
  if (attempt > 1) {
    // played after a miss or the reveal: moves on, scores nothing
  } else if (hinted) {
    stats.mistakes += 1;
    stats.streak = 0;
    stats.history.push(false);
  } else {
    stats.correct += 1;
    stats.streak += 1;
    stats.best = Math.max(stats.best, stats.streak);
    stats.history.push(true);
  }
  await renderTrainStats();
  if (appState.training) appState.training.prompt = result.prompt;
  appState.trainBusy = true;
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

  appState.trainBusy = false;
  if (result.prompt) {
    await renderTraining(result.prompt);
  } else {
    finishTrainingSession();
  }
}

function finishTrainingSession() {
  const training = appState.training;
  const stats = appState.trainStats;
  if (training) training.prompt = null;
  boards.train.setEngineArrow(null);
  updateTrainTurnBadge(null);
  document.getElementById("train-board-label").textContent = "";
  const runId = `${training?.session_id}:${training?.session_generation || Date.now()}`;
  saveRun(currentOwnerId(), {
    id: runId, mode: "all_lines", blitz: false,
    repertoires: [training?.repertoire_name].filter(Boolean), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    cards: Number(training?.lines?.length) || 0, correct: stats.correct, mistakes: stats.mistakes, skipped: stats.skipped || 0, learned: 0,
  });
  home.showTrainResult({ ...drillResult(training, stats), runId });
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
async function trainHint() {
  if (appState.smart) {
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
  let pending = appState.trainHintInfo;
  if (!pending || pending.forFen !== prompt.fen_before) {
    pending = appState.trainHintInfo = {
      forFen: prompt.fen_before,
      read: postJson("/api/train/hint", { session_id: prompt.session_id }),
    };
    appState.trainHintLevel = 0;
  }
  let info;
  try {
    info = await pending.read;
  } catch (error) {
    if (appState.trainHintInfo === pending) appState.trainHintInfo = null;
    setStatusError(error.message);
    return;
  }
  if (appState.trainHintInfo !== pending) return;
  appState.trainHintLevel = Math.min(3, (appState.trainHintLevel || 0) + 1);
  const level = appState.trainHintLevel;
  if (level === 1) {
    boards.train.setEngineArrow(null);
    setTrainBanner("move", "Hint 1 · Idea", info.strategy || "Follow your preparation");
  } else if (level === 2) {
    boards.train.setEngineArrow(null);
    setTrainBanner("move", "Hint 2 · Piece", info.piece || "Find the move");
  } else {
    setTrainBanner("move", "Hint 3 · Answer", info.expected_san ? `Play ${info.expected_san}` : "Here it is");
    if (info.expected_uci) boards.train.setEngineArrow(info.expected_uci);
  }
}

function currentTrainingPrompt() {
  return appState.training ? appState.training.prompt : null;
}


// Mount/unmount the clock for a whole session. During a blitz session the bar
// stays in the layout (merely emptied between cards) so the board never jumps.
function setBlitzBarVisible(on) {
  const bar = document.getElementById("train-blitz");
  if (bar) bar.hidden = !on;
}

function clearBlitzTimer() {
  if (appState.blitzTimer) {
    window.clearTimeout(appState.blitzTimer);
    appState.blitzTimer = null;
  }
  const fill = document.getElementById("train-blitz-fill");
  if (fill) {
    fill.style.transition = "none";
    fill.style.width = "0%";
  }
}

function startBlitzTimer(smart, prompt) {
  clearBlitzTimer();
  const fill = document.getElementById("train-blitz-fill");
  if (fill) {
    // Restart the shrink from full: kill the transition, snap to 100%, reflow,
    // then let one linear transition spend the whole budget.
    fill.style.transition = "none";
    fill.style.width = "100%";
    void fill.offsetWidth;
    fill.style.transition = `width ${BLITZ_SECONDS}s linear`;
    fill.style.width = "0%";
  }
  appState.blitzTimer = window.setTimeout(() => {
    appState.blitzTimer = null;
    const current = appState.smart;
    // Fire only when this exact first attempt is still waiting on screen;
    // a backgrounded tab or a navigated-away view forfeits the clock, not
    // the card.
    const live =
      current === smart &&
      current.prompt === prompt &&
      current.attempt === 1 &&
      !appState.trainBusy &&
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
  const isCurrent = () => seq === smartStartSeq && owner === currentOwnerId() && (appState.trainMode || "smart") === "smart";
  const fresh = !!options.fresh;
  appState.trainResult = null;
  const failed = (text) => {
    appState.trainStarting = false;
    if (text) trainRowError("smart", text);
    syncTrainSessionControls();
  };
  setTrainBanner(
    "runin",
    fresh ? "Building a new queue…" : "Building your queue…",
    "Saving repertoire edits…",
  );
  // Train must see the latest tree: drain unsynced Build edits (adds + deletes)
  // before the server builds the queue, else a just-added line wouldn't be in
  // it and a just-deleted one would.
  try {
    await hardFlushBuild();
  } catch (_) {
    if (!isCurrent()) return;
    failed("Couldn't save your repertoire edits. Try again in a moment.");
    return;
  }
  if (!isCurrent()) return;
  setTrainBanner(
    "runin",
    fresh ? "Building a new queue…" : "Building your queue…",
    "Syncing your last session…",
  );
  // Land any leftover graded attempts (an abandoned previous session) before
  // the new queue is scheduled from SR state. Strict: starting anyway would
  // schedule the queue off stale SR state, so block until the sync lands.
  const trainSynced = await flushTrainSync().catch(() => false);
  if (!isCurrent()) return;
  if (!trainSynced) {
    failed("Couldn't sync your last session. Check your connection and try again.");
    return;
  }
  let payload;
  let trainResume;
  const targets = options.targetNodeIds || [];
  try {
    trainResume = await loadTrainResume();
    if (!isCurrent()) return;
    setTrainBanner(
      "runin",
      fresh ? "Building a new queue…" : "Building your queue…",
      "Choosing the cards…",
    );
    // The scope is explicit: the entry's repertoire, else the Due row's scope.
    const repertoireId = options.repertoireId || appState.trainScope?.repertoireId || null;
    payload = await postJson("/api/train/smart/start", {
      mixed: !repertoireId,
      fresh: fresh || !!targets.length,
      ...(repertoireId ? { repertoire_id: repertoireId } : {}),
      ...(targets.length ? { target_node_ids: targets } : {}),
    });
  } catch (error) {
    if (!isCurrent()) return;
    if (isAuthError(error)) {
      failed("");
      accountService().handleAuthRequired("Sign in to start training");
      return;
    }
    failed(isNothingToTrainError(error) ? "Nothing to train here. Add lines in Repertoire." : "Couldn't build your queue. Try again in a moment.");
    return;
  }
  if (!isCurrent()) return;
  // The URL names the repertoire the queue drills; a mixed queue drills all of
  // them, so it names none. Keeping the anchor here would write ?rep=<anchor>
  // into a Train link that is not about that repertoire.
  appState.trainingRepertoireId = payload.mixed ? null : payload.repertoire_id;
  setTrainBanner(
    "runin",
    fresh ? "Building a new queue…" : "Building your queue…",
    "Loading session tools…",
  );
  try {
    trainSessionMemo ||= await import("../train-session-memo.js");
  } catch (_) { /* recovery is optional if the chunk cannot load */ }
  if (!isCurrent()) return;
  const mapped = trainResume.mapTrainUiSession(payload, { fresh });
  // A resumed session without a memo must not inherit unrelated counters.
  trainStatsReset();
  invalidateTrainPreview(); // the queue it described is being played now
  appState.training = null; // leave line rehearsal if it was active
  // A restart can interrupt an in-flight run-in; its early-return leaves the
  // busy flag set, so clear it before the new session takes the board.
  appState.trainBusy = false;
  clearBlitzTimer();
  // The whole session runs locally off this card bundle (grading, advancement,
  // requeue, skip); only graded attempts + the position sync back, batched.
  const queue = mapped.queue;
  if (!queue.length) {
    failed("Nothing to train here. Add lines in Repertoire.");
    return;
  }
  setTrainBanner(
    "runin",
    fresh ? "Building a new queue…" : "Building your queue…",
    "Opening your first card…",
  );
  appState.smart = {
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
  appState.trainStats = trainSessionMemo?.restoreSmartSession(currentOwnerId(), mapped, appState.smart) || appState.trainStats;
  rememberSmartSession();
  // F-06: this session is the first practice for every queued "train this
  // mistake" handoff — stamp takenAt so the mistake→practice time is measurable.
  for (const handoff of pendingHandoffs({ reason: "practice-missed-move" })) {
    const scheduled = queue.some((card) =>
      (!handoff.repertoireId || String(card.repertoire_id || payload.repertoire_id) === String(handoff.repertoireId)) &&
      card.targets?.some((target) => target.fen_before === handoff.anchorFen));
    if (scheduled && ["pending", "prepared"].includes(handoff.status)) transitionHandoff(handoff.key, "queued");
  }
  setBlitzBarVisible(appState.smart.blitz);
  if (boards.train && payload.color) {
    boards.train.setOrientation(payload.color === "black" ? "black" : "white");
  }
  await renderTrainStats();
  if (!isCurrent()) return;
  setTrainSyncState("saved");
  document.getElementById("train-board-label").textContent =
    `${payload.repertoire_name} · you play ${payload.color}`;
  syncWorkspaceUrl();
  const resumedAttempt = appState.smart.attempt;
  const prompt = smartLocalPrompt(appState.smart);
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
  } catch (_) {
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
  const smart = appState.smart;
  if (!smart || !prompt) return;
  smart.prompt = prompt;
  smart.attempt = attempt;
  appState.trainStarting = false;
  appState.trainHintLevel = 0;
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
    appState.trainBusy = true;
    syncTrainSessionControls();
    const runIn = prompt.run_in || [];
    if (runIn.length) {
      let fen = prompt.start_fen;
      board.setPosition({ fen, legalMoves: [], lastMove: null });
      const cue = runIn[runIn.length - 1];
      // The board label already names the repertoire and side.
      setTrainBanner("runin", "Finding the position", cue && cue.san ? `Watch ${cue.san}` : "Watch the last move");
      await sleep(480);
      for (const mv of runIn) {
        if (appState.smart !== smart || smart.prompt !== prompt) return; // superseded
        try {
          const after = await boardAfterMove(fen, mv.uci);
          fen = after.board.fen;
          board.setPosition({ fen, legalMoves: [], lastMove: mv.uci });
          cueUci = mv.uci;
        } catch (_) {
          break; // jump-cut to fen_before below
        }
        await sleep(430);
      }
      await sleep(160);
    }
    if (appState.smart !== smart || smart.prompt !== prompt) return;
    appState.trainBusy = false;
  }
  board.setPosition({
    fen: prompt.fen_before,
    legalMoves: prompt.legal_moves || [],
    lastMove: cueUci,
  });
  const side = sideToMoveFromFen(prompt.fen_before);
  updateTrainTurnBadge(side);
  if (prompt.kind === "new") {
    // Teach-then-test: show the move and its idea; playing it (graded) is the
    // first, easy rep — the real test comes when spaced repetition brings it back.
    setTrainBanner(
      "teach",
      `New move: ${prompt.expected_san}`,
      teachWhy(prompt, "Watch the arrow, then play the move.")
    );
    board.setEngineArrow(prompt.expected_uci);
    clearBlitzTimer(); // learning is never against the clock
  } else {
    const cueSan = promptCueSan(smart, prompt);
    setTrainBanner(
      "move",
      "Your move",
      `${appState.smart.cardKinds[prompt.kind]?.label || "Review"} · ${cueSan ? `answer ${cueSan}` : "play your prep"}`,
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
    if (appState.smart?.prompt !== prompt) return;
    return mod.prefetchTrainCoach(prompt, { appState, maiaPhaseCoach, setTrainBanner, trainTeachLine });
  }).catch((error) => { if (appState.smart?.prompt === prompt) console.warn("Train coach unavailable", error); });
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
  const smart = appState.smart;
  if (!smart || !smart.prompt || !playedUci || appState.trainBusy) return;
  clearBlitzTimer(); // answered (or timed out) — stop the countdown right away
  const prompt = smart.prompt;
  const attempt = smart.attempt;
  // Land the dragged move immediately; a blitz timeout has no real move to show.
  // The graded cue below covers the landing, so it stays quiet.
  if (!timedOut) await optimisticBoardMove(boards.train, prompt.fen_before, playedUci, false);
  const other = !timedOut && (prompt.target?.alternatives || []).find((alt) => alt.uci === playedUci);
  if (other) {
    return answerAlternative({
      fen: prompt.fen_before, playedUci, san: other.san,
      still: () => appState.smart === smart && smart.prompt === prompt,
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
  const hinted = appState.trainHintLevel > 0;
  const scored = prompt.kind !== "new";
  if (attempt === 1) queueTrainAttempt(smart, prompt.expected_node_id, correct, hinted);
  if (correct) trackPreparationPractice({
    repertoireId: smart.queue[smart.cardIndex]?.repertoire_id || smart.repertoireId,
    nodeId: prompt.expected_node_id, fen: prompt.fen_before, completed: true,
  });
  const stats = appState.trainStats || (trainStatsReset(), appState.trainStats);

  if (!correct) {
    // Only the first answer is graded (matches the synced SR write); the
    // accuracy chips therefore never count retries.
    if (attempt === 1) {
      if (scored) {
        stats.mistakes += 1;
        // A first-try miss ends the run, same as Line rehearsal.
        stats.streak = 0;
        stats.history.push(false);
      }
      rememberSmartSession({ attempt: attempt + 1 });
      await renderTrainStats();
    }
    appState.trainBusy = true;
    let playedSan = "";
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      playedSan = after.move?.san || "";
      boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: playedUci, cue: false });
    } catch (_) {
      // Wrong-move preview is cosmetic (a blitz timeout has no move to show);
      // grading already happened above.
    }
    playSound("wrong");
    if (attempt === 1) {
      // First miss: a free retry with the idea as a tip, no reveal. The blitz
      // retry is untimed — the clock tests recall, the retry rebuilds it.
      const missTip = () => wrongMoveTip({
        hintLevel: appState.trainHintLevel, hint: prompt.hint, expectedSan: prompt.expected_san,
        coachTip: prompt.phaseCoach && prompt.phaseCoach.promptTip,
      });
      const show = (tip) => {
        const banner = wrongMoveBanner({ attempt, playedSan, expectedSan: prompt.expected_san, tip, timedOut });
        setTrainBanner(banner.state, banner.title, banner.sub);
      };
      show(missTip());
      maiaPhaseCoach({ fen: prompt.fen_before, expectedUci: prompt.expected_uci, expectedSan: prompt.expected_san, playedUci })
        .then((model) => {
          if (!(appState.smart && appState.smart.prompt === prompt && model)) return;
          prompt.phaseCoach = model;
          // A retry can already have succeeded or revealed the answer while
          // this inference was pending; its feedback owns the banner now.
          if (!coachTipMayReplace(appState.trainHintLevel) || !model.tip) return;
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
    if (appState.smart !== smart || smart.prompt !== prompt) return;
    boards.train.setPosition({
      fen: prompt.fen_before,
      legalMoves: prompt.legal_moves || [],
      lastMove: null, back: true, // the tried move travels home, not again
    });
    if (attempt >= 2) boards.train.setEngineArrow(prompt.expected_uci);
    appState.trainBusy = false;
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
  } else if (scored && hinted) {
    stats.mistakes += 1;
    stats.streak = 0;
    stats.history.push(false);
  } else if (scored) {
    stats.correct += 1;
    stats.streak += 1;
    stats.best = Math.max(stats.best, stats.streak);
    stats.history.push(true);
  }
  // Store the next cursor before animating an already-counted answer.
  rememberSmartSession({ advance: true });
  await renderTrainStats();
  appState.trainBusy = true;
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
    await sleep(520);
    if (appState.smart !== smart) return; // mode switched mid-animation
    boards.train.setPosition({
      fen: target.reply.fen_after,
      legalMoves: [],
      lastMove: target.reply.uci,
    });
    setTrainBanner("move", "Opponent replies", target.reply.san || "");
    await sleep(440);
  } else {
    await sleep(480);
  }
  if (appState.smart !== smart) return;
  // Advance the local session: next target inside the card, else next card.
  const card = smart.queue[smart.cardIndex];
  if (card && smart.targetIndex + 1 < card.targets.length) {
    smart.targetIndex += 1;
  } else {
    smart.cardsDone += 1;
    smart.cardIndex += 1;
    smart.targetIndex = 0;
  }
  markTrainPositionDirty();
  appState.trainBusy = false;
  const next = smartLocalPrompt(smart);
  if (next) {
    await presentSmartPrompt(next);
  } else {
    await finishSmartSession();
  }
}

async function skipSmartCard() {
  const smart = appState.smart;
  if (!smart || !smart.prompt) {
    setStatus("No active card");
    return;
  }
  if (appState.trainBusy) return;
  clearBlitzTimer();
  appState.trainStats.skipped += 1;
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
  const smart = appState.smart;
  const prompt = smart && smart.prompt;
  if (!prompt) {
    setStatus("Start a session first");
    return;
  }
  if (appState.trainBusy) return;
  appState.trainHintLevel = Math.min(3, (appState.trainHintLevel || 0) + 1);
  const level = appState.trainHintLevel;
  if (level === 1) {
    boards.train.setEngineArrow(null);
    setTrainBanner("move", "Hint 1 · Idea", prompt.hint.strategy || "Follow your preparation");
  } else if (level === 2) {
    boards.train.setEngineArrow(null);
    setTrainBanner("move", "Hint 2 · Piece", prompt.hint.piece || "Find the move");
  } else {
    setTrainBanner("move", "Hint 3 · Answer", `Play ${prompt.expected_san}`);
    boards.train.setEngineArrow(prompt.expected_uci);
  }
  setTrainHintLine(`Hint ${level} · ${level === 1 ? prompt.hint.strategy || "Follow your preparation" : level === 2 ? prompt.hint.piece || "Find the move" : `Play ${prompt.expected_san}`}`);
}

let trainSessionMemo = null;
function rememberSmartSession(progress = {}) {
  const smart = appState.smart;
  if (!smart || !smart.sessionId || !appState.trainStats) return;
  trainSessionMemo?.saveSmartSession(currentOwnerId(), smart, appState.trainStats, progress);
}


// The finished queue's Result is up the moment the last card is answered; the
// flush and the server summary then fill in what changed (the card reserves
// that line's height, so nothing shifts).
async function finishSmartSession() {
  const smart = appState.smart;
  if (!smart) return;
  const stats = appState.trainStats || {};
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
  home.showTrainResult({ ...smartResult(smart, stats), runId: `${smart.sessionId}:${smart.generation}` });
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
  } catch (_) {
    // The summary is a bonus — never block the finish on it.
  }
  if (after?.day_streak) appState.dayStreak = after.day_streak;
  // The user may have moved on while the summary loaded.
  if (appState.smart !== smart || appState.trainResult?.mode !== "smart") return;
  appState.smart = null;
  home.showTrainResult({ ...smartResult(smart, stats, after), runId: `${smart.sessionId}:${smart.generation}` });
  // Every cached count of what is left to train is now stale.
  refreshRepertoireHead();
  void refreshDashboardRepertoires().catch(() => {});
  invalidateTrainPreview();
}
