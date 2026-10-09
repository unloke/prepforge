import { html } from "../html.js";
// Train sessions: the smart queue, line rehearsal, practice games and Feeling Lucky.
// Lazy-loaded by app.js the first time Train is used. The functions stay at module
// level; createTrainSession binds the app.js state and helpers they share, once.

import { isAuthError } from "../auth-gate.js";
import { isStartFen, localBoardInfo } from "../chess-local.js";
import { getSharedMaia3Provider } from "../engine/maia3-provider.js";
import { describeMove } from "../explain.js";
import { pendingHandoffs, trackPreparationPractice, transitionHandoff } from "../handoff-context.js";
import { countOf } from "../plural.js";
import { coachTipMayReplace, wrongMoveTip } from "../train-hint.js";
import { pickOpponentReply, playPositionAfterReply, replyReasonNote, unavailableExplorer } from "../train-opponent.js";
import { formatPlayTrail, playSessionPgn, resolvePlayColor, takebackToUserMove } from "../train-play.js";
import { trainStartDisabled } from "../train-start.js";

let accountService, api, appState, BLITZ_SECONDS, blitzEnabled, boardAfterMove, boardInfo, boards,
  currentOwnerId, effectiveMaiaRating, ensureExplorerClient, ensureTrainView, flushTrainSync, hardFlushBuild, lichessAccounts, loadPgnIntoAnalyze, loadPhaseCoach,
  loadTrainResume, localDateString, maiaPhaseCoach, markTrainPositionDirty, openAuthModal,
  optimisticBoardMove, PLAY_COLOR_KEY, playSound, postJson, preloadTrainView, queueTrainAttempt,
  refreshAuthStatus, renderTrainStats, requireSignIn, setStatus, setStatusError, setTrainBanner,
  setTrainSyncState, sleep, START_FEN, switchView, syncViewHeads,
  syncWorkspaceUrl, updateTrainTurnBadge;

export function createTrainSession(deps) {
  ({
    accountService, api, appState, BLITZ_SECONDS, blitzEnabled, boardAfterMove, boardInfo,
    boards, currentOwnerId, effectiveMaiaRating, ensureExplorerClient, ensureTrainView,
    flushTrainSync, hardFlushBuild, lichessAccounts, loadPgnIntoAnalyze,
    loadPhaseCoach, loadTrainResume, localDateString, maiaPhaseCoach, markTrainPositionDirty,
    openAuthModal, optimisticBoardMove, PLAY_COLOR_KEY, playSound, postJson, preloadTrainView,
    queueTrainAttempt, refreshAuthStatus, renderTrainStats, requireSignIn, setStatus,
    setStatusError, setTrainBanner, setTrainSyncState, sleep, START_FEN,
    switchView, syncViewHeads, syncWorkspaceUrl, updateTrainTurnBadge,
  } = deps);
  initTrainControls();
  return {
    clearBlitzTimer, loadTrainRepertoireOptions, onFeelingLucky, openPlayInAnalyze,
    persistPlayRepertoireIds, renderPlayRepertoirePicker, resetTrainBoardIdle,
    resignPlaySession, selectedTrainRepertoireIds, setBlitzBarVisible, setPlayPickerColor,
    skipTrainingLine, startPlaySessionTracked, startTraining, submitTrainingMove,
    syncTrainPickerVisibility, takebackPlaySession, trainHint,
  };
}

// Startup work that used to run in app.js's bindEvents: the play colour the player
// last picked, and which setup controls the current mode shows.
function initTrainControls() {
  try {
    if (localStorage.getItem(PLAY_COLOR_KEY) === "black") setPlayPickerColor("black");
  } catch (_) { /* private mode */ }
  syncTrainPickerVisibility();
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
      setStatus("Skipped to next line");
    } else {
      appState.training.prompt = null;
      if (appState.trainReview && appState.trainReview.queue.length) {
        enterReviewRound();
      } else {
        finishTrainingSession();
      }
      setStatus("Session complete");
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

async function renderTraining(payloadOrPrompt) {
  const prompt = payloadOrPrompt?.prompt || payloadOrPrompt;
  if (!prompt) return;
  applyTrainingPromptState(prompt);
  const out = await (await ensureTrainView()).renderTraining(prompt);
  syncTrainSessionControls();
  return out;
}

async function renderSmartQueueStrip() {
  return (await ensureTrainView()).renderSmartQueueStrip();
}

async function renderSmartProgress(prompt) {
  return (await ensureTrainView()).renderSmartProgress(prompt);
}

async function renderSmartSummary(smart, stats, after) {
  if (after?.day_streak) appState.dayStreak = after.day_streak;
  const dayStreak = after?.day_streak || appState.dayStreak;
  return (await ensureTrainView()).renderSmartSummary(smart, stats, after, dayStreak);
}

async function loadTrainRepertoireOptions() {
  const select = document.getElementById("train-repertoire-select");
  if (!select && !document.getElementById("train-play-repertoire-picker")) return;
  let active = [];
  try {
    // Signed out there is no owner-scoped listing: the picker shows its empty
    // option instead of surfacing the API's 401 as a sticky top-bar error.
    if (!appState.signedIn) throw Object.assign(new Error("signed out"), { signedOut: true });
    const payload = await api("/api/repertoires");
    appState.repertoireList = payload.repertoires || [];
    active = appState.repertoireList.filter(
      (r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id)),
    );
  } catch (error) {
    if (!error.signedOut) setStatusError(error.message);
    active = (appState.repertoireList || []).filter(
      (r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id)),
    );
  }
  if (select) {
    const previous = appState.trainingRepertoireId || (active.length ? active[0].id : "");
    const options = active.length
      ? active.map(
          (r) =>
            html`<option value="${r.id}">${r.name} (${r.color})</option>`,
        )
      : [
          appState.signedIn
            ? html`<option value="" disabled selected>Create a repertoire first</option>`
            : html`<option value="" disabled selected>Sign in to train your repertoires</option>`,
        ];
    select.innerHTML = html`${options}`;
    const valid = new Set(active.map((r) => r.id));
    select.value = valid.has(previous) ? previous : active.length ? active[0].id : "";
    appState.trainingRepertoireId = select.value || null;
  }
  const preferenceKey = playRepertoireStorageKey();
  if (appState.playRepertoirePreferenceKey !== preferenceKey) {
    appState.playRepertoirePreferenceKey = preferenceKey;
    appState.playRepertoireIds = null;
  }
  const valid = new Set(active.map((r) => String(r.id)));
  if (!Array.isArray(appState.playRepertoireIds)) {
    const stored = readStoredPlayRepertoireIds();
    appState.playRepertoireIds = stored
      ? stored.filter((id) => valid.has(String(id)))
      : active.map((r) => String(r.id));
  } else {
    appState.playRepertoireIds = appState.playRepertoireIds.filter((id) => valid.has(String(id)));
  }
  persistPlayRepertoireIds();
  renderPlayRepertoirePicker(active);
  syncTrainPickerVisibility();
}

function playRepertoireStorageKey() {
  const identity = appState.accountUsername || appState.accountUserId || "guest";
  const safe = String(identity).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_") || "guest";
  return `prepforge.play_repertoires.${safe}`;
}

function readStoredPlayRepertoireIds() {
  try {
    const raw = localStorage.getItem(playRepertoireStorageKey());
    const parsed = JSON.parse(raw || "null");
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && Array.isArray(parsed.ids)) return parsed.ids.map(String);
  } catch (_) {
    /* private mode or malformed old preference */
  }
  return null;
}

function persistPlayRepertoireIds() {
  if (!Array.isArray(appState.playRepertoireIds)) return;
  try {
    localStorage.setItem(
      playRepertoireStorageKey(),
      JSON.stringify(appState.playRepertoireIds.map(String)),
    );
  } catch (_) {
    /* private mode */
  }
}

function selectedTrainRepertoireIds() {
  const active = new Set(
    (appState.repertoireList || [])
      .filter((r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id)))
      .map((r) => String(r.id)),
  );
  return (Array.isArray(appState.playRepertoireIds) ? appState.playRepertoireIds : [])
    .map(String)
    .filter((id) => active.has(id));
}

function playRepertoireMeta(ids = selectedTrainRepertoireIds()) {
  const wanted = new Set((ids || []).map(String));
  return (appState.repertoireList || []).filter((rep) => wanted.has(String(rep.id)));
}

function renderPlayRepertoirePicker(active = null) {
  const list = Array.isArray(active)
    ? active
    : (appState.repertoireList || []).filter(
        (r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id)),
      );
  const host = document.getElementById("train-repertoire-options");
  const empty = document.getElementById("train-repertoire-empty");
  const selectAll = document.getElementById("train-repertoire-select-all");
  const summary = document.getElementById("train-repertoire-summary-label");
  const selected = new Set(selectedTrainRepertoireIds());
  if (host) {
    host.innerHTML = html`${list
      .map((rep) => {
        const id = rep.id;
        const checked = selected.has(String(rep.id)) ? " checked" : "";
        const color = rep.color === "black" ? "Black" : "White";
        return html`<label class="train-repertoire-option" data-repertoire-id="${id}">
          <input type="checkbox" data-repertoire-id="${id}"${checked} />
          <span class="rep-option-name">${rep.name || "Untitled repertoire"}</span>
          <span class="rep-option-color">${color}</span>
        </label>`;
      })}`;
  }
  if (empty) empty.hidden = list.length > 0;
  if (selectAll) {
    selectAll.checked = list.length > 0 && selected.size === list.length;
    selectAll.indeterminate = selected.size > 0 && selected.size < list.length;
    selectAll.disabled = list.length === 0;
  }
  if (summary) {
    summary.textContent = !list.length
      ? "No active repertoires"
      : selected.size === list.length
        ? list.length === 1
          ? list[0].name || "1 repertoire"
          : `All ${list.length} repertoires`
        : selected.size
          ? `${selected.size} of ${list.length} repertoire${list.length === 1 ? "" : "s"}`
          : "Select repertoires";
  }
}

// The smart queue trains ALL active repertoires in one mixed session, so its
// setup needs no repertoire picker; line rehearsal keeps it.
function syncTrainPickerVisibility() {
  const mode = appState.trainMode || "smart";
  const smart = mode === "smart";
  const play = mode === "play";
  const select = document.getElementById("train-repertoire-select");
  const picker = document.getElementById("train-srs-picker");
  const srs = document.getElementById("train-srs-start");
  const playSetup = document.getElementById("train-play-setup");
  const blitzRow = document.getElementById("train-blitz-row");
  const book = document.getElementById("train-play-book");
  const progress = document.getElementById("train-progress-panel");
  const summary = document.getElementById("train-summary");
  const hint = document.getElementById("train-hint");
  const skip = document.getElementById("train-skip");
  const wantRep = !smart && !play;
  if (book && !(appState.play && appState.play.active)) syncPlayBookOptions(book);
  const wantPlayRep = play && book && book.value === "repertoire";
  if (select) select.hidden = !wantRep;
  if (picker) picker.hidden = !wantRep;
  const playPicker = document.getElementById("train-play-repertoire-picker");
  if (playPicker) {
    playPicker.hidden = !wantPlayRep;
    if (wantPlayRep) renderPlayRepertoirePicker();
  }
  if (srs) srs.hidden = play;
  if (playSetup) playSetup.hidden = !play;
  if (blitzRow) blitzRow.hidden = mode !== "smart";
  const setupTitle = document.getElementById("train-setup-title");
  if (setupTitle) {
    setupTitle.hidden = play;
    setupTitle.textContent = smart ? "Smart queue" : "Line rehearsal";
  }
  if (play) {
    if (progress) progress.hidden = true;
    if (summary) summary.hidden = true;
  }
  // Keep hint/skip in the board bar so hiding them cannot shove the label.
  if (hint) hint.hidden = false;
  if (skip) skip.hidden = false;
  const startBtn = document.getElementById("start-train");
  if (startBtn) {
    startBtn.disabled = trainStartDisabled({
      mode: smart ? "smart" : play ? "play" : "all_lines",
      signedIn: appState.signedIn,
      hasRepertoire: !!selectedTrainRepertoireId(),
    });
    // A guest's Start opens the sign-in gate; say so on the button instead of
    // promising a session that cannot begin.
    startBtn.textContent = appState.signedIn ? "Start" : "Sign in to start";
  }
  const startPlay = document.getElementById("start-play");
  const bookEl = document.getElementById("train-play-book");
  const livePlay = !!(appState.play && appState.play.active);
  if (bookEl) {
    bookEl.disabled = livePlay;
    if (!livePlay) syncPlayBookOptions(bookEl);
  }
  if (startPlay) {
    const needRep = wantPlayRep && !selectedTrainRepertoireIds().length;
    startPlay.disabled = !!needRep;
    startPlay.textContent = livePlay ? "New game" : "Start";
    // Mid-game the board is the main action; the restart button steps back.
    startPlay.classList.toggle("primary", !livePlay);
  }
  syncPlayColorLock();
  paintPlayBookHint();
  syncTrainSessionControls();
  void refreshTrainSessionPreview().catch(() => {});
}

// Before Start: the card counts of the queue Start will serve. Cached briefly
// so the many syncTrainPickerVisibility() calls don't each refetch.
const trainPreviewCache = { at: 0, text: "", loading: null };
function invalidateTrainSessionPreview() {
  trainPreviewCache.at = 0;
}
async function refreshTrainSessionPreview() {
  const el = document.getElementById("train-session-preview");
  if (!el) return;
  const smartIdle = (appState.trainMode || "smart") === "smart" && !(appState.smart && appState.smart.prompt);
  if (!smartIdle || !appState.signedIn) {
    el.hidden = true;
    return;
  }
  const paint = (text) => {
    el.textContent = text;
    el.hidden = !text;
  };
  if (Date.now() - trainPreviewCache.at < 30000) {
    paint(trainPreviewCache.text);
    return;
  }
  if (!trainPreviewCache.loading) {
    trainPreviewCache.loading = (async () => {
      const [mod, payload] = await Promise.all([
        preloadTrainView(),
        api(`/api/train/smart/summary?mixed=true&preview=true&local_date=${encodeURIComponent(localDateString())}`),
      ]);
      trainPreviewCache.text = mod.sessionPreviewText(payload && payload.next_session);
      trainPreviewCache.at = Date.now();
    })().finally(() => {
      trainPreviewCache.loading = null;
    });
  }
  await trainPreviewCache.loading;
  paint(trainPreviewCache.text);
}

function trainSessionLive() {
  if (appState.trainMode === "play") return !!(appState.play && appState.play.active);
  if (appState.smart && appState.smart.prompt) return true;
  if (appState.training && appState.training.prompt) return true;
  return false;
}

function syncTrainSessionControls() {
  const live = trainSessionLive();
  const play = (appState.trainMode || "smart") === "play";
  const sidebar = document.querySelector("#view-train .train-sidebar");
  const summaryVisible = !document.getElementById("train-summary")?.hidden;
  if (sidebar) sidebar.dataset.sessionState = !play && summaryVisible ? "summary" : !play && live ? "active" : "setup";
  const hint = document.getElementById("train-hint");
  const skip = document.getElementById("train-skip");
  const fresh = document.getElementById("train-fresh");
  const blitzToggle = document.getElementById("train-blitz-toggle");
  const blitzRow = document.getElementById("train-blitz-row");
  const banner = document.getElementById("train-banner");
  const state = banner && banner.dataset.state;
  const busy = !!appState.trainBusy;
  const teaching = state === "teach" || state === "reveal" || state === "runin";
  if (hint) {
    hint.hidden = false;
    hint.disabled = play || !live || busy || teaching;
    hint.title = play
      ? "Hints are for the spaced-repetition queue"
      : "Hint (show the piece to move)";
  }
  if (skip) {
    skip.hidden = false;
    skip.disabled = play || !live || busy;
    skip.title = play
      ? "Skip is for the spaced-repetition queue"
      : "Skip this card";
  }
  if (fresh) fresh.disabled = !(appState.smart || appState.training);
  syncViewHeads();
  if (blitzToggle) {
    blitzToggle.disabled = !!appState.smart;
    blitzToggle.classList.toggle("is-on", blitzEnabled());
    blitzToggle.setAttribute("aria-checked", String(blitzEnabled()));
  }
  if (blitzRow) {
    blitzRow.title = appState.smart
      ? "Blitz is locked for this session — applies on next Start"
      : "10s per move · a timeout counts as a miss";
  }
  const takeback = document.getElementById("play-takeback");
  const resign = document.getElementById("play-resign");
  const analyze = document.getElementById("play-analyze");
  const history = appState.play && appState.play.history;
  const hasMoves = !!(history && history.length);
  if (takeback) takeback.disabled = !play || !hasMoves;
  if (resign) resign.disabled = !play || !appState.play || !appState.play.active;
  if (analyze) analyze.disabled = !play || !hasMoves;
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

function selectedTrainRepertoireId() {
  const select = document.getElementById("train-repertoire-select");
  if (!select) return appState.trainingRepertoireId;
  const value = select.value;
  if (!value || value === "__demo__") return null;
  return value;
}

function trainStatsReset() {
  appState.trainStats = { correct: 0, mistakes: 0, streak: 0, best: 0, history: [], lastStreak: 0 };
  appState.trainReview = { queue: [], index: 0, active: false, savedStreak: 0, recovered: 0 };
}

function sideToMoveFromFen(fen) {
  return (fen || "").split(" ")[1] === "b" ? "black" : "white";
}

async function startTraining(mode, options = {}) {
  mode = mode || appState.trainMode || "smart";
  appState.trainMode = mode;
  // Training runs against your own repertoires and review schedule, so a
  // guest gets the sign-in gate — not a "Nothing to train yet" that blames an
  // empty repertoire and a raw "not authenticated".
  if (!appState.signedIn) {
    // Never repaint the banner over a live game (Practice game runs for guests).
    if (!(appState.play && appState.play.active)) {
      setTrainBanner("done", "Sign in to train", "Your repertoires live in your account.");
    }
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
  setSmartPanelsHidden();
  setStatus("Starting trainer");
  const repertoireId = selectedTrainRepertoireId();
  appState.trainingRepertoireId = repertoireId;
  // No unauthenticated demo in the SaaS model: training is always against one of the
  // user's own repertoires. Without one, prompt them to build first instead of
  // hitting a (now-removed) demo endpoint.
  if (!repertoireId) {
    setStatus("Create a repertoire in Repertoire first, then train it.");
    setTrainBanner("done", "No repertoire to train", "Create a repertoire, then start the trainer.");
    return;
  }
  // Same freshness rule as the smart queue: unsynced Build edits must land
  // before the server walks the tree into lines.
  try {
    await hardFlushBuild();
    if (!isCurrent()) return;
  } catch (error) {
    if (isCurrent()) setStatusError(error.message);
    return;
  }
  const fresh = !!options.fresh;
  const body = { seed: 13, mode, repertoire_id: repertoireId, fresh };
  try {
    const { mapTrainUiSession, shouldResetTrainStats } = await loadTrainResume();
    if (!isCurrent()) return;
    const payload = await postJson("/api/train/start", body);
    if (!isCurrent()) return;
    appState.training = payload;
    const mapped = mapTrainUiSession(payload, { fresh });
    if (shouldResetTrainStats(mapped)) trainStatsReset();
    if (boards.train && payload.color) {
      boards.train.setOrientation(payload.color === "black" ? "black" : "white");
    }
    document.getElementById("train-progress-panel").hidden = false;
    await renderTrainStats();
    if (payload.prompt) {
      await renderTraining(payload);
    } else {
      boards.train.setEngineArrow(null);
      setTrainBanner("done", "No trainable lines here", "Add prepared moves in Repertoire, then train.");
      document.getElementById("train-board-label").textContent = "Nothing to train yet";
    }
    setStatus(
      mapped.resumed
        ? `Resumed trainer: line ${mapped.cardIndex + 1} / ${mapped.totalCards}`
        : `Trainer ready: ${payload.lines.length} line${payload.lines.length === 1 ? "" : "s"}`,
    );
    syncWorkspaceUrl();
  } catch (error) {
    if (isCurrent()) setStatusError(error.message);
  }
}

function playBook() {
  const el = document.getElementById("train-play-book");
  const value = el && el.value;
  return value === "repertoire" || value === "maia" ? value : "explorer";
}

// The Lichess explorer answers only for a signed-in user with a linked Lichess
// account; My repertoire needs an account. Unusable books are disabled, and a
// book that became unusable falls back to Maia (and returns once usable again).
function syncPlayBookOptions(bookEl) {
  const linked = appState.signedIn && (!!appState.lichessUsername || lichessAccounts().length > 0);
  const usable = { explorer: linked, repertoire: !!appState.signedIn, maia: true };
  const reasons = { explorer: appState.signedIn ? "Link a Lichess account in Settings" : "Sign in and link a Lichess account", repertoire: "Sign in to use your repertoires" };
  for (const option of bookEl.options) {
    const ok = usable[option.value] !== false;
    option.disabled = !ok;
    option.title = ok ? "" : reasons[option.value] || "";
  }
  if (!usable[bookEl.value]) {
    bookEl.dataset.autoFrom = bookEl.value;
    bookEl.value = "maia";
  } else if (bookEl.dataset.autoFrom && usable[bookEl.dataset.autoFrom] && bookEl.value === "maia") {
    bookEl.value = bookEl.dataset.autoFrom;
    delete bookEl.dataset.autoFrom;
  }
  bookEl.title = bookEl.value === "maia" && bookEl.dataset.autoFrom ? reasons[bookEl.dataset.autoFrom] || "" : "";
}

function playPickerColor() {
  const active = document.querySelector("#train-play-color .train-mode.is-active");
  if (active && active.dataset.color === "black") return "black";
  try {
    return localStorage.getItem(PLAY_COLOR_KEY) === "black" ? "black" : "white";
  } catch (_) {
    return "white";
  }
}

function setPlayPickerColor(color, { persist = true } = {}) {
  const want = color === "black" ? "black" : "white";
  if (persist) {
    try {
      localStorage.setItem(PLAY_COLOR_KEY, want);
    } catch (_) { /* private mode */ }
  }
  document.querySelectorAll("#train-play-color .train-mode").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.color === want);
  });
}

function syncPlayColorLock() {
  const book = playBook();
  const live = !!(appState.play && appState.play.active);
  const selectedMeta = playRepertoireMeta();
  const colors = [...new Set(selectedMeta.map((rep) => (rep.color === "black" ? "black" : "white")))];
  const lockRep = book === "repertoire" && colors.length === 1;
  if (lockRep) {
    setPlayPickerColor(colors[0], { persist: false });
  } else if (!live) {
    try {
      const stored = localStorage.getItem(PLAY_COLOR_KEY);
      if (stored === "black" || stored === "white") {
        setPlayPickerColor(stored, { persist: false });
      }
    } catch (_) { /* private mode */ }
  }
  document.querySelectorAll("#train-play-color .train-mode").forEach((btn) => {
    btn.disabled = live || lockRep;
    btn.title = lockRep
      ? `Locked to your ${colors[0]} repertoire${colors.length > 1 ? "s" : ""}`
      : live
        ? "Color is locked for this game"
        : "You play this color from the opening";
  });
}

// Only a blocking state gets a line here: the repertoire book with nothing selected.
function paintPlayBookHint() {
  const hint = document.getElementById("train-play-book-hint");
  if (!hint) return;
  const blocked = playBook() === "repertoire" && !selectedTrainRepertoireIds().length;
  hint.hidden = !blocked;
  hint.textContent = blocked ? "Select at least one active repertoire, or switch back to Lichess explorer." : "";
}

function playBookLabel(play) {
  const session = play || appState.play;
  const book =
    session && session.book === "repertoire" ? "My repertoire" : session && session.book === "maia" ? "Maia" : "Lichess explorer";
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
  el.innerHTML = text
    ? html`<span class="play-trail-sans">${text}</span>`
    : html`<span class="trail-empty">No moves yet</span>`;
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

async function fetchPlayMaia(fen) {
  // Train Play opponent fallback is Maia-by-design (thin Explorer positions
  // fall back to human-like replies), independent of the Analyze-layer switch.
  try {
    const provider = getSharedMaia3Provider();
    return await provider.predictions({ fen, rating: effectiveMaiaRating() });
  } catch (_) {
    return [];
  }
}

async function loadPlayRepertoirePayload(repertoireId) {
  return api(`/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`);
}

function paintPlayPosition({ fen, legalMoves, lastMove, banner, sub, label, state }) {
  boards.train.setEngineArrow(null);
  boards.train.setPosition({
    fen,
    legalMoves: legalMoves || [],
    lastMove: lastMove || null,
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
  const startFen = fen || START_FEN;
  const book = playBook();
  let nodeId = null;
  let playRepertoires = [];
  let repertoireCursors = {};
  if (book === "repertoire") {
    const selectedIds = selectedTrainRepertoireIds();
    if (!selectedIds.length) {
      setStatus("Select at least one active repertoire, or switch the opponent book to Lichess explorer.");
      return false;
    }
    // Build edits are local-first. Flush the currently open tree before reading
    // it for a Play session, but never load repertoire trees until Start is
    // pressed (no Train-load or idle prefetch).
    try {
      await hardFlushBuild();
    } catch (error) {
      setStatusError(error.message);
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
        setStatus("Those repertoires have no playable lines yet.");
        return false;
      }
      repertoireCursors = playCursorsAtFen(playRepertoires, startFen);
      nodeId = playRepertoires.find((rep) => repertoireCursors[rep.id]?.length)?.rootId || null;
    } catch (error) {
      if (isCurrentStart()) setStatusError(error.message);
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
    if (isCurrentStart()) setStatusError(error.message || "Could not open that position");
    return false;
  }
  if (!isCurrentStart()) return false;
  appState.play = {
    active: true,
    fen: info.fen,
    startFen: info.fen,
    book,
    userColor,
    nodeId,
    rootNodeId: nodeId,
    repertoires: playRepertoires,
    repertoireCursors,
    ply: 0,
    history: [],
    lastOppSan: null,
    luckyReason: reason || null,
    luckyPhase: phase || null,
    luckyGameId: luckyGameId || null,
    luckyWhite: luckyWhite || null,
    luckyBlack: luckyBlack || null,
    luckySource: luckySource || null,
    luckySourceUrl: luckySourceUrl || null,
  };
  document.getElementById("train-progress-panel").hidden = true;
  const summary = document.getElementById("train-summary");
  if (summary) summary.hidden = true;
  if (boards.train) {
    boards.train.setOrientation(userColor);
  }
  const why =
    reason === "miss"
      ? "Engine miss — your move"
      : reason === "departure"
        ? "You left prep here — your move"
        : reason === "fork"
          ? "A real fork — more than one human reply"
              : reason === "db-critical"
                ? `Master game, critical ${phase || "moment"} — your move`
              : reason === "titled-game"
                  ? `${String(luckySource || "").startsWith("lichess-") ? "Live Lichess game" : "Titled reference"}, critical ${phase || "moment"} — your move`
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
  setStatus(isStartFen(info.fen) ? "Your move" : `Started from a key position (${reason || "book"})`);
  renderPlayTrail();
  syncTrainPickerVisibility();
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
    play.active = false;
    updateTrainTurnBadge(null);
    setTrainBanner("done", alreadyOver.banner, "Start or Feeling Lucky for another round");
    boards.train.setPosition({ fen: info.fen, legalMoves: [], lastMove: null });
    syncTrainSessionControls();
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
    maiaPredictions = await fetchPlayMaia(fen);
    if (!isCurrent()) return;
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
    play.active = false;
    updateTrainTurnBadge(null);
    setTrainBanner("done", "No reply", "The opponent has no legal move from this book.");
    syncTrainSessionControls();
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
    play.active = false;
    updateTrainTurnBadge(null);
    boards.train.setPosition({
      fen: after.board.fen,
      legalMoves: [],
      lastMove: reply.uci,
    });
    setTrainBanner("done", ended.banner, after.move.san);
    syncTrainSessionControls();
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
    play.active = false;
    updateTrainTurnBadge(null);
    setTrainBanner("done", ended.banner, after.move.san);
    syncTrainSessionControls();
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
    lastMove: undone.lastMove,
    banner: yourMove ? "Your move" : "Opponent thinking…",
    sub: yourMove
      ? "Takeback — play again"
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
  play.active = false;
  updateTrainTurnBadge(null);
  const last = play.history && play.history[play.history.length - 1];
  boards.train.setPosition({
    fen: play.fen,
    legalMoves: [],
    lastMove: last ? last.uci : null,
  });
  setTrainBanner("done", "Resigned", "Start or Feeling Lucky for another round");
  syncTrainPickerVisibility();
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
  if (appState.trainReview && appState.trainReview.active) {
    return submitReviewMove(playedUci);
  }
  const prompt = currentTrainingPrompt();
  if (!prompt || !playedUci || appState.trainBusy) return;
  // A mode switch replaces appState.training; every await below re-checks it so
  // an abandoned session never paints onto the new mode's board.
  const training = appState.training;
  const superseded = () => appState.training !== training || appState.smart;
  // Land the dragged move on the board right away; the server response below
  // decides whether it advances (correct) or resets (wrong).
  await optimisticBoardMove(boards.train, prompt.fen_before, playedUci);
  // An answer after a hint advances the line but is graded as a miss.
  const hinted = appState.trainHintLevel > 0;
  let result;
  try {
    result = await api("/api/train/move", {
      method: "POST",
      body: JSON.stringify({
        session_id: prompt.session_id,
        played_uci: playedUci,
        hinted,
        local_date: localDateString(),
      }),
    });
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  if (result.day_streak) appState.dayStreak = result.day_streak;
  const stats = appState.trainStats || (trainStatsReset(), appState.trainStats);
  const review = appState.trainReview;
  appState.trainHintLevel = 0;

  if (!result.correct) {
    stats.mistakes += 1;
    // Remember the best streak so the recovery round can hand it back, then
    // break the running streak (it's "at risk", not gone for good).
    if (stats.streak > review.savedStreak) review.savedStreak = stats.streak;
    stats.streak = 0;
    stats.history.push(false);
    // Queue this missed position for the end-of-session recovery round.
    if (!review.queue.some((it) => it.fen === prompt.fen_before)) {
      review.queue.push({
        fen: prompt.fen_before,
        expected_uci: result.expected_uci,
        expected_san: result.expected_san,
      });
    }
    await renderTrainStats();
    appState.trainBusy = true;
    let playedSan = result.played_san || "";
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      playedSan = after.move?.san || playedSan;
      boards.train.setPosition({
        fen: after.board.fen,
        legalMoves: [],
        lastMove: playedUci,
      });
    } catch (_) {
      // Keep SAN-only feedback even if the preview move cannot be rendered.
    }
    const expectedSan = result.expected_san || "the prepared move";
    const sub = review.savedStreak > 0
      ? `Prepared move: ${expectedSan}. Fix it in recovery to win your run back.`
      : `Prepared move: ${expectedSan}.`;
    setTrainBanner(
      "wrong",
      playedSan ? `Not ${playedSan}` : "Not the prepared move",
      sub
    );
    playSound("capture");
    if (appState.training) appState.training.prompt = result.prompt;
    await sleep(1450);
    if (superseded()) return;
    appState.trainBusy = false;
    if (result.prompt) await renderTraining(result.prompt);
    return;
  }

  if (hinted) {
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

  // 1) Land the player's own move on the board (board animates + sounds).
  boards.train.setPosition({
    fen: result.fen_after_player || prompt.fen_before,
    legalMoves: [],
    lastMove: result.played_uci,
  });
  setTrainBanner("correct", hinted ? "Correct, with a hint" : "Correct!", result.played_san ? `You played ${result.played_san}` : "");

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
  } else if (review.queue.length) {
    enterReviewRound();
  } else {
    finishTrainingSession();
  }
}

// ----- Recovery round: replay the moves you missed until they're clean ------

async function enterReviewRound() {
  const review = appState.trainReview;
  review.active = true;
  review.index = 0;
  boards.train.setEngineArrow(null);
  setTrainBanner("review", "Recovery round", `Fix ${countOf(review.queue.length, "missed move")} to win your run back`);
  await sleep(700);
  showReviewItem();
}

async function showReviewItem() {
  const review = appState.trainReview;
  if (review.index >= review.queue.length) {
    finishReviewRound();
    return;
  }
  const item = review.queue[review.index];
  let info;
  try {
    info = await boardInfo(item.fen);
  } catch (_) {
    info = { legal_moves: [] };
  }
  boards.train.setEngineArrow(null);
  boards.train.setPosition({ fen: item.fen, legalMoves: info.legal_moves || [], lastMove: null });
  const side = sideToMoveFromFen(item.fen);
  updateTrainTurnBadge(side);
  setTrainBanner("review", `Recovery · ${review.index + 1} / ${review.queue.length}`, `${side === "white" ? "White" : "Black"} to move`);
  document.getElementById("train-board-label").textContent = "Recovery round";
}

async function submitReviewMove(playedUci) {
  const review = appState.trainReview;
  const item = review.queue[review.index];
  if (!item || !playedUci || appState.trainBusy) return;
  const stats = appState.trainStats;
  if (playedUci === item.expected_uci) {
    appState.trainBusy = true;
    let after;
    try {
      after = await boardAfterMove(item.fen, playedUci);
    } catch (_) {
      after = null;
    }
    if (after) {
      boards.train.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: playedUci });
    }
    review.recovered += 1;
    // The trail mirrors the first-try counters; recovery answers are not graded.
    await renderTrainStats();
    setTrainBanner("correct", "Recovered!", "Mistake fixed");
    playSound("move");
    await sleep(640);
    appState.trainBusy = false;
    review.index += 1;
    showReviewItem();
  } else {
    setTrainBanner("wrong", "Still not it", "Try again");
    playSound("capture");
  }
}

function finishReviewRound() {
  const review = appState.trainReview;
  const stats = appState.trainStats;
  review.active = false;
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  if (review.savedStreak > 0) {
    stats.streak = review.savedStreak;
    stats.best = Math.max(stats.best, review.savedStreak);
    void renderTrainStats().catch(() => {});
    setTrainBanner("done", "Run recovered!", `Fixed ${review.recovered} · back to ${review.savedStreak} in a row · best ${stats.best}`);
  } else {
    setTrainBanner("done", "All cleaned up!", `Fixed ${countOf(review.recovered, "missed move")}`);
  }
  document.getElementById("train-board-label").textContent = "Session complete";
  celebrate();
}

function finishTrainingSession() {
  const stats = appState.trainStats;
  if (appState.training) appState.training.prompt = null;
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  setTrainBanner("done", "Session complete!", `${stats.correct} correct · ${countOf(stats.mistakes, "mistake")} · best run ${stats.best}`);
  document.getElementById("train-board-label").textContent = "Session complete";
  syncTrainSessionControls();
  celebrate();
}

// Lightweight confetti burst, no library, just falling coloured chips.
function celebrate() {
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
  try {
    if (!appState.trainHintInfo || appState.trainHintInfo.forFen !== prompt.fen_before) {
      const res = await postJson("/api/train/hint", { session_id: prompt.session_id });
      appState.trainHintInfo = { ...res, forFen: prompt.fen_before };
      appState.trainHintLevel = 0;
    }
    const info = appState.trainHintInfo;
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
  } catch (error) {
    setStatusError(error.message);
  }
}

function currentTrainingPrompt() {
  return appState.training ? appState.training.prompt : null;
}

// "Why this move", engine-free, for the moments the answer is on screen (teach
// cards and the second-miss reveal). The repertoire author's own annotation wins;
// otherwise describe what the move actually does on the board (chess.js only, so
// Train keeps needing no engine); the server's generic heuristic is the last resort.
function teachWhy(prompt, fallback) {
  const hint = (prompt && prompt.hint) || {};
  if (hint.annotated && hint.strategy) return hint.strategy;
  const did = describeMove(prompt.fen_before, prompt.expected_uci, prompt.expected_san);
  if (did) return `${did.charAt(0).toUpperCase()}${did.slice(1)}.`;
  return hint.strategy || fallback;
}

// Teach/reveal explanation: the move's own description (teachWhy) plus the phase
// coach's note only when that note is specific to the position (model.generic marks
// the canned phase advice, which is dropped instead of repeated on every card).
function trainTeachLine(prompt, model) {
  const parts = [teachWhy(prompt, "")];
  if (model && model.tip && !model.generic) parts.push(model.tip);
  return parts.filter(Boolean).join(" ");
}

function setSmartPanelsHidden() {
  const queue = document.getElementById("train-queue");
  if (queue) queue.hidden = true;
  const summary = document.getElementById("train-summary");
  if (summary) summary.hidden = true;
  const dots = document.getElementById("train-card-dots");
  if (dots) dots.innerHTML = "";
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
  setStatus(fresh ? "Building a new queue" : "Building your queue");
  setTrainBanner(
    "runin",
    fresh ? "Building a new queue…" : "Building your queue…",
    "",
  );
  // Train must see the latest tree: drain unsynced Build edits (adds + deletes)
  // before the server builds the queue, else a just-added line wouldn't be in
  // it and a just-deleted one would.
  try {
    await hardFlushBuild();
  } catch (error) {
    if (!isCurrent()) return;
    setStatusError(error.message);
    return;
  }
  // Land any leftover graded attempts (an abandoned previous session) before
  // the new queue is scheduled from SR state. Strict: starting anyway would
  // schedule the queue off stale SR state, so block until the sync lands.
  const trainSynced = await flushTrainSync().catch(() => false);
  if (!isCurrent()) return;
  if (!trainSynced) {
    setStatus("Couldn't sync your last session — check your connection and try again.");
    return;
  }
  let payload;
  let trainResume;
  try {
    // mixed: one queue over ALL active repertoires (the picker only matters
    // for line rehearsal). fresh: always rebuild the queue from the current
    // tree + SR state — a resumed stale queue is exactly the desync this avoids.
    trainResume = await loadTrainResume();
    const targets = options.targetNodeIds || [];
    payload = await postJson("/api/train/smart/start", {
      mixed: !targets.length,
      fresh: fresh || !!targets.length,
      ...(targets.length ? { repertoire_id: options.repertoireId, target_node_ids: targets } : {}),
    });
  } catch (error) {
    if (!isCurrent()) return;
    if (isAuthError(error)) {
      setTrainBanner("done", "Sign in to train", "Your repertoires and review schedule live in your account.");
      accountService().handleAuthRequired("Sign in to start training");
      return;
    }
    if (error.status === 400 && /no active repertoires to train/i.test(error.message)) {
      setStatus("Nothing to train yet");
      setTrainBanner("done", "Nothing to train yet", "Create or activate a repertoire in Library.");
      return;
    }
    setStatusError(error.message);
    setTrainBanner("done", "Couldn't build your queue", "Try Start again in a moment.");
    return;
  }
  if (!isCurrent()) return;
  appState.trainingRepertoireId = payload.repertoire_id;
  try {
    trainSessionMemo ||= await import("../train-session-memo.js");
  } catch (_) { /* recovery is optional if the chunk cannot load */ }
  if (!isCurrent()) return;
  const mapped = trainResume.mapTrainUiSession(payload, { fresh });
  // A resumed session without a memo must not inherit unrelated counters.
  trainStatsReset();
  invalidateTrainSessionPreview(); // the queue it described is being played now
  appState.training = null; // leave line rehearsal if it was active
  // A restart can interrupt an in-flight run-in; its early-return leaves the
  // busy flag set, so clear it before the new session takes the board.
  appState.trainBusy = false;
  clearBlitzTimer();
  // The whole session runs locally off this card bundle (grading, advancement,
  // requeue, skip); only graded attempts + the position sync back, batched.
  const queue = mapped.queue;
  if (!queue.length) {
    setStatus("Nothing to train yet");
    setTrainBanner("done", "Nothing to train yet", "Add prepared moves in Repertoire, then train.");
    return;
  }
  appState.smart = {
    sessionId: mapped.sessionId,
    generation: mapped.generation,
    seed: mapped.seed,
    repertoireId: mapped.repertoireId,
    repertoireName: mapped.repertoireName,
    color: mapped.color,
    mixed: mapped.mixed,
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
  const smart = appState.smart;
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
  const preview = document.getElementById("train-session-preview");
  if (preview) preview.hidden = true;
  if (boards.train && payload.color) {
    boards.train.setOrientation(payload.color === "black" ? "black" : "white");
  }
  document.getElementById("train-progress-panel").hidden = false;
  setSmartPanelsHidden();
  await renderSmartQueueStrip();
  await renderTrainStats();
  if (!isCurrent()) return;
  setTrainSyncState("saved");
  document.getElementById("train-board-label").textContent =
    `${payload.repertoire_name} · you play ${payload.color}`;
  loadPhaseCoach()
    .then((m) => {
      if (appState.smart !== smart) return;
      smart.phaseCluster = m.clusterQueueByPhase(smart.queue);
      return renderSmartQueueStrip();
    })
    .catch(() => {});
  setStatus(
    mapped.resumed
      ? `Resumed queue: card ${smart.cardIndex + 1} / ${smart.queue.length}`
      : `Queue ready: ${countOf(smart.queue.length, "card")}`,
  );
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
  appState.trainHintLevel = 0;
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
      const who = cardMeta && cardMeta.color === "black" ? "Black" : "White";
      setTrainBanner(
        "runin",
        `${cardMeta && cardMeta.repertoire_name ? cardMeta.repertoire_name : "Finding the position"} · you play ${who.toLowerCase()}`,
        cue && cue.san ? `Watch ${cue.san}` : "Watch the last move",
      );
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
    const cueSan = smartPromptCueSan(smart, prompt);
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

// The opponent move this card answers ("answer 3...Nf6"), from the run-in or the
// previous step of the same card. "" when the card starts from the initial position.
function smartPromptCueSan(smart, prompt) {
  const runIn = prompt.run_in || [];
  let san = runIn.length ? runIn[runIn.length - 1].san : "";
  if (!san) {
    const card = smart.queue[smart.cardIndex];
    const prev = card && smart.targetIndex > 0 ? card.targets[smart.targetIndex - 1] : null;
    san = prev && prev.reply ? prev.reply.san : "";
  }
  if (!san) return "";
  const parts = String(prompt.fen_before || "").split(" ");
  const num = Number(parts[5]) || 1;
  // The cue was played by the other side: number it from the prompt's position.
  return parts[1] === "w" ? `${num - 1}...${san}` : `${num}.${san}`;
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
  if (!timedOut) await optimisticBoardMove(boards.train, prompt.fen_before, playedUci);
  // Grade locally — the prompt carries the answer (it's the player's own
  // repertoire). Only the first attempt writes spaced repetition; it lands on
  // the server in the next debounced /smart/sync batch, not per move.
  const correct = playedUci === prompt.expected_uci;
  // Recall means unaided: an answer after a hint is graded as a miss, and a new
  // move's demonstration (the arrow shows it) is not a recall at all, so it stays
  // out of the first-try stats. Its SR write still marks it learned.
  const hinted = appState.trainHintLevel > 0;
  const scored = prompt.kind !== "new";
  if (attempt === 1) queueTrainAttempt(smart, prompt.expected_node_id, correct && !hinted);
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
    try {
      const after = await boardAfterMove(prompt.fen_before, playedUci);
      boards.train.setPosition({
        fen: after.board.fen,
        legalMoves: [],
        lastMove: playedUci,
      });
    } catch (_) {
      // Wrong-move preview is cosmetic (a blitz timeout has no move to show);
      // grading already happened above.
    }
    playSound("capture");
    if (attempt === 1) {
      // First miss: auto-hint and a free retry, no reveal.
      // The blitz retry is deliberately untimed — the clock tests recall,
      // the retry rebuilds it.
      const cached = prompt.phaseCoach;
      setTrainBanner(
        "wrong",
        timedOut ? "Time's up · try again" : "Not your prep · try again",
        wrongMoveTip({
          hintLevel: appState.trainHintLevel,
          hint: prompt.hint,
          expectedSan: prompt.expected_san,
          coachTip: cached && cached.promptTip,
        }),
      );
      maiaPhaseCoach({
        fen: prompt.fen_before,
        expectedUci: prompt.expected_uci,
        expectedSan: prompt.expected_san,
        playedUci,
      })
        .then((model) => {
          if (appState.smart && appState.smart.prompt === prompt && model) {
            prompt.phaseCoach = model;
            if (!coachTipMayReplace(appState.trainHintLevel)) return;
            // A retry can already have succeeded or revealed the answer while
            // this inference was pending; its feedback owns the banner now.
            if (document.getElementById("train-banner")?.dataset.state !== "wrong") return;
            if (!model.tip) return;
            setTrainBanner(
              "wrong",
              timedOut ? "Time's up · try again" : "Not your prep · try again",
              model.tip,
            );
          }
        })
        .catch(() => {});
    } else {
      // Second miss: reveal, let the answer be played, and the card returns
      // a few positions later (replaces the old end-of-session recovery round).
      stats.streak = 0;
      await renderTrainStats();
      const requeued = requeueSmartCard(smart);
      if (requeued) {
        smart.totalCards = smart.queue.length;
        smart.counts[prompt.kind] = (smart.counts[prompt.kind] || 0) + 1;
        await renderSmartQueueStrip();
        markTrainPositionDirty();
      }
      rememberSmartSession({ attempt: attempt + 1 });
      // The answer is on screen anyway, so say WHY it's the move — a reveal that
      // teaches sticks better than a bare "it's Nf3".
      const why = trainTeachLine(prompt, prompt.phaseCoach);
      setTrainBanner(
        "reveal",
        `It's ${prompt.expected_san}`,
        `${why ? `${why} ` : ""}${requeued ? "Play it to continue; this card comes back soon." : "Play it to continue."}`
      );
    }
    await sleep(950);
    if (appState.smart !== smart || smart.prompt !== prompt) return;
    boards.train.setPosition({
      fen: prompt.fen_before,
      legalMoves: prompt.legal_moves || [],
      lastMove: null,
    });
    if (attempt >= 2) boards.train.setEngineArrow(prompt.expected_uci);
    appState.trainBusy = false;
    smart.attempt = attempt + 1;
    return;
  }

  if (attempt > 1) {
    smart.retriesFixed += 1;
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
  boards.train.setPosition({
    fen: target.fen_after || prompt.fen_before,
    legalMoves: [],
    lastMove: playedUci,
  });
  const praise =
    attempt > 1 ? "Got it this time" : prompt.kind === "new" ? "Learned!" : hinted ? "Correct, with a hint" : "Correct!";
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
  // Local advance — the position syncs with the next debounced flush.
  smart.cardIndex += 1;
  smart.targetIndex = 0;
  smart.attempt = 1;
  rememberSmartSession();
  markTrainPositionDirty();
  const next = smartLocalPrompt(smart);
  if (next) {
    setStatus("Skipped to the next card");
    await presentSmartPrompt(next);
  } else {
    setStatus("Session complete");
    await finishSmartSession();
  }
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
}

let trainSessionMemo = null;
function rememberSmartSession(progress = {}) {
  const smart = appState.smart;
  if (!smart || !smart.sessionId || !appState.trainStats) return;
  trainSessionMemo?.saveSmartSession(currentOwnerId(), smart, appState.trainStats, progress);
}

async function finishSmartSession() {
  const smart = appState.smart;
  if (!smart) return;
  const stats = appState.trainStats || {};
  smart.prompt = null;
  trainSessionMemo?.clearSessionMemo(currentOwnerId(), smart.sessionId, smart.generation);
  syncTrainSessionControls();
  clearBlitzTimer();
  setBlitzBarVisible(false);
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  const dots = document.getElementById("train-card-dots");
  if (dots) dots.innerHTML = "";
  const fixed = smart.retriesFixed ? ` · ${smart.retriesFixed} fixed on retry` : "";
  const blitzed = smart.blitz && smart.timeouts ? ` (${smart.timeouts} timed out)` : "";
  setTrainBanner(
    "done",
    smart.blitz ? "Blitz session complete!" : "Session complete!",
    `${stats.correct || 0} first-try correct · ${stats.mistakes || 0} missed${blitzed}${fixed}`
  );
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
    });
  }
  document.getElementById("train-board-label").textContent = finalFen ? "Final position of the last card" : "";
  invalidateTrainSessionPreview();
  celebrate();
  // End-of-session report: what this session changed, and what lands tomorrow.
  // Flush the graded attempts FIRST so the "after" health actually includes
  // this session's spaced-repetition writes.
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
  // The flush + summary fetch take a moment; if the user already moved on
  // (switched to Line rehearsal / Play, or restarted), the report belongs to a
  // session that is no longer on screen — don't paint it over the new mode.
  if (appState.smart !== smart || (appState.trainMode || "smart") !== "smart") return;
  await renderSmartSummary(smart, stats, after);
  syncTrainSessionControls();
}
