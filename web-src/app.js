import "./styles.css";
import { buildArrowPath } from "./board-arrows.js";
import { analyzeTiered } from "./engine/tiered-analysis.js";
import { classBadgeSymbol } from "./move-grades.js";
import { countOf } from "./plural.js";
// One per-position analysis store (engine/position-analysis-store.js) behind the
// Engine panel, the Coach and the whole-game pass.
let analysisStoreReady;
function analysisStore() {
  return analysisStoreReady ||= import("./engine/position-analysis-store.js")
    .then(({ createPositionAnalysisStore }) => createPositionAnalysisStore({
      getMaia: () => (maiaAnalysisEnabled() ? getSharedMaia3Provider() : null),
      sanLine: sanLineFromUci,
      savedEval: (fen) => appState.analysis?.position_evals?.[fen],
    }));
}

function createSharedEvaluationProvider(options) {
  let handle = null;
  let seq = 0;
  const select = async (request) => {
    const token = ++seq;
    const store = await analysisStore();
    if (token !== seq) return null;
    handle ||= store.createHandle(options);
    return handle.open(request);
  };
  return { open: select, update: select, snapshot: () => handle?.snapshot(),
    close: async () => { seq += 1; await handle?.close(); } };
}
import { advanceBuildRevision, queuedBuildRevision, rebaseQueuedBuildRevision, withBuildRevision } from "./build-revision.js";
import {
  createEngineProvider,
  isBrowserEngineAvailable,
} from "./engine/stockfish-provider.js";
import {
  getSharedMaia3Provider,
  disposeSharedMaia3Provider,
  peekSharedMaia3Provider,
} from "./engine/maia3-provider.js";
import { createCsrfTokenSource, headersWithCsrf, readCsrfCookie, CSRF_HEADER } from "./csrf.js";
import { localBoardInfo, localBoardAfterMove, localGameOver } from "./chess-local.js";
import { buildPvPreview, clampPly, previewPosition, previewLabel, stepPreview } from "./pv-preview.js";
import { applyTheme } from "./theme.js";
import { bindRailCollapseOnNavigate } from "./rail-nav.js";
import { parsePgn } from "./analyze-pgn.js";
import { typedSquare } from "./board-navigation.js";
import { isReviewedMove, pgnPlayers, selfSide } from "./analyze-orient.js";
import { buildGameSummary, hasClassifiedMoves } from "./coach/game-summary.js";
import { flushGroups, groupAttempts, ungroupAttempts } from "./train-sync.js";
import { classifySyncError, describeSyncError } from "./sync-errors.js";
import { apiErrorMessage } from "./api-errors.js";
import { withRequestDeadline } from "./request-deadline.js";
import { orderPendingBuildAdds } from "./build-queue.js";
import { normalizeRepertoireColor, repertoireColorField } from "./repertoire-color.js";
import { trainStartDisabled } from "./train-start.js";
import { coachTipMayReplace, wrongMoveTip } from "./train-hint.js";
import { syncChipVariant } from "./sync-chip.js";
import { nodeMenuHeading } from "./node-menu.js";
import {
  acquireFlushLock,
  buildAddId,
  buildDeleteId,
  outboxHasRejected,
  outboxHasWork,
  outboxIsQuiescent,
  releaseFlushLock,
  trainAttemptId,
} from "./sync-outbox.js";
const outboxDatabase = () => import("./outbox-db.js");
const loadDurableOutbox = async (owner) => (await outboxDatabase()).loadDurableOutbox(owner);
const saveDurableOutbox = async (owner, state, settled) => {
  const snapshot = structuredClone(state), done = structuredClone(settled);
  return (await outboxDatabase()).saveDurableOutbox(owner, snapshot, done);
};
const clearDurableOutbox = async (owner) => (await outboxDatabase()).clearDurableOutbox(owner);
import { loadTeamDirectory } from "./team-directory.js";
import { clearCheckpoint, evalMapFrom, loadCheckpoint, markCheckpointSaved, saveCheckpoint } from "./analyze-checkpoint.js";
import {
  loadReturnState,
  pendingHandoffs,
  rememberHandoff,
  saveReturnState,
  setHandoffOwner,
  takeHandoff,
  transitionHandoff,
  trackPreparationPractice,
} from "./handoff-context.js";
import { describeMove } from "./explain.js";
import {
  activateWorkspaceTab,
  parseWorkspaceLocation,
  serializeWorkspaceLocation,
  workspaceLocationFromState,
} from "./workspace-url.js";
import {
  pickOpponentReply,
  playPositionAfterReply,
  replyReasonNote,
  unavailableExplorer,
} from "./train-opponent.js";
import { isStartFen } from "./train-lucky.js";
import {
  resolvePlayColor,
  formatPlayTrail,
  takebackToUserMove,
  playSessionPgn,
} from "./train-play.js";
import { engineUnavailableBanner, engineBannerHtml } from "./engine-banner.js";
import { fetchLichessProfile } from "./lichess-profile.js";
import {
  buildPaletteItems,
  filterPaletteItems,
  renderPaletteItems,
} from "./command-palette.js";
import { createAccountController } from "./controllers/account.js";
import {
  AUTH_REQUIRED_MESSAGE,
  isAuthError,
  isAuthRequiredMessage,
  isPendingActionId,
  isSessionAuthFailure,
  restoredAuthHref,
  stripSignedInParam,
  takeAuthReturn,
  takePendingAction,
} from "./auth-gate.js";
import { shouldClearStatusOnNavigate } from "./status-pill.js";
import {
  openSourceComposer,
  normalizeSelection,
  selectionChips,
  selectionFromStorage,
  selectionToStorage,
  resolveFetchUsernames,
  sameFetchSources,
} from "./views/shared/source-composer.js";
let _coachReady = null;
function loadTrainResume() {
  return import("./train-resume.js");
}

function preloadCoach() {
  if (!_coachReady) {
    _coachReady = import("./coach/bundle.js").catch((err) => {
      _coachReady = null;
      throw err;
    });
  }
  return _coachReady;
}

let _buildGenReady = null;
function preloadBuildGen() {
  if (!_buildGenReady) {
    _buildGenReady = import("./engine/build-generate-runner.js").catch((err) => {
      _buildGenReady = null;
      throw err;
    });
  }
  return _buildGenReady;
}

// Front-end error beacon (stability plan #1): report uncaught errors so we have a
// server-side window into browser crashes. Best-effort — sendBeacon never throws
// back into the app, and the endpoint is CSRF-exempt + needs no auth.
function reportClientError(payload) {
  try {
    navigator.sendBeacon(
      "/api/clientlog",
      new Blob([JSON.stringify(payload)], { type: "application/json" }),
    );
  } catch {
    /* best-effort, never throw from the reporter itself */
  }
}
window.addEventListener("error", (e) => {
  reportClientError({
    kind: "error",
    message: e.message,
    src: e.filename,
    line: e.lineno,
    col: e.colno,
    stack: e.error && e.error.stack,
    ua: navigator.userAgent,
    coi: !!self.crossOriginIsolated,
    t: Date.now(),
  });
});
window.addEventListener("unhandledrejection", (e) => {
  reportClientError({
    kind: "rejection",
    message: String((e.reason && e.reason.message) || e.reason),
    stack: e.reason && e.reason.stack,
    ua: navigator.userAgent,
    coi: !!self.crossOriginIsolated,
    t: Date.now(),
  });
});

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
// Piece artwork sets. Each value is the inner SVG markup for a 0 0 45 45
// viewBox; fill/stroke come from CSS (.piece). "berlin" is a cleaner,
// traditional Staunton silhouette (the default); "classic" is the original
// minimalist set, kept as an alternative.
const PIECE_SETS = {
  berlin: {
    p: `<circle cx="22.5" cy="13.5" r="4.5"></circle><path d="M19 20.2h7l1.4 8.2h-9.8z"></path><path d="M15.5 31.5h14c1.8 1.4 3 3.4 3.4 6H12.1c.4-2.6 1.6-4.6 3.4-6z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    n: `<path d="M13 38h23v3H11z"></path><path d="M15.5 34c1.1-6.8 4.9-9.4 8.2-13.1-3 .4-6.5-.5-8.9-2.4 1-6.4 6.6-10.4 13-9 5.7 1.3 9 6.1 8.4 12.4L34 34z"></path><path d="M18.1 15.6l3.9-5.3 1.2 5.5z" class="piece-cut"></path><circle cx="28.2" cy="15.1" r="1.25" class="piece-cut"></circle><path d="M22.4 20.5c2.4 1.1 5.1 1 7.5-.2" class="piece-line"></path>`,
    b: `<circle cx="22.5" cy="8.7" r="2.5"></circle><path d="M22.5 12c-4 3.7-7.1 8.8-7.1 14.1 0 3.8 3 6.2 7.1 6.2s7.1-2.4 7.1-6.2c0-5.3-3.1-10.4-7.1-14.1z"></path><path d="M26.7 16.2l-8.4 9.4" class="piece-line"></path><path d="M14 34h17c1.1 1 1.8 2.1 2 3.6H12c.2-1.5.9-2.6 2-3.6z"></path><path d="M10.8 38.2h23.4v2.8H10.8z"></path>`,
    r: `<path d="M12.5 9.5h5v3.6h3.4V9.5h3.2v3.6h3.4V9.5h5v8.6H29v11.3l3.2 3.3v3H12.8v-3l3.2-3.3V18.1h-3.5z"></path><path d="M16.5 21h12M16.3 31h12.4" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    q: `<circle cx="9.5" cy="13.2" r="2.2"></circle><circle cx="16.8" cy="9.5" r="2.2"></circle><circle cx="22.5" cy="8" r="2.4"></circle><circle cx="28.2" cy="9.5" r="2.2"></circle><circle cx="35.5" cy="13.2" r="2.2"></circle><path d="M10.2 16.2l4.3 15.5h16l4.3-15.5-6.6 8-2.8-11.2-2.9 12.2-2.9-12.2-2.8 11.2z"></path><path d="M13.5 32.2h18c.9.8 1.4 1.8 1.5 3H12c.1-1.2.6-2.2 1.5-3z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    k: `<path d="M22.5 5.5v7M19.2 8.8h6.6" class="piece-line"></path><path d="M17.8 14.5h9.4l1.4 6.7c2.2 1.7 3.6 4.2 3.6 7.1 0 2.3-1 4.1-2.8 5.2H15.6c-1.8-1.1-2.8-2.9-2.8-5.2 0-2.9 1.4-5.4 3.6-7.1z"></path><path d="M17.3 20.8h10.4M16.2 33.8h12.6" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
  },
  classic: {
    p: `<circle cx="22.5" cy="13" r="6"></circle><path d="M16 22h13l3 11H13z"></path><path d="M12 36h21v4H12z"></path>`,
    n: `<path d="M14 36h22v4H11z"></path><path d="M16 34c1-10 8-11 7-19-3 1-6 1-9-1 3-6 9-8 15-5 5 3 7 8 6 14l-2 11z"></path><circle cx="29" cy="14" r="1.4" class="piece-cut"></circle>`,
    b: `<circle cx="22.5" cy="10" r="4.5"></circle><path d="M15 31c0-7 5-12 7.5-18C25 19 30 24 30 31z"></path><path d="M13 35h19v5H13z"></path><path d="M19 20l7-7" class="piece-line"></path>`,
    r: `<path d="M12 9h6v4h4V9h6v4h5v8H12z"></path><path d="M15 21h15v14H15z"></path><path d="M11 35h23v5H11z"></path>`,
    q: `<circle cx="12" cy="12" r="3.5"></circle><circle cx="22.5" cy="9" r="3.5"></circle><circle cx="33" cy="12" r="3.5"></circle><path d="M12 17l5 16h11l5-16-8 7-2.5-9-2.5 9z"></path><path d="M13 35h19v5H13z"></path>`,
    k: `<path d="M21 7h3v7h6v3h-6v6h-3v-6h-6v-3h6z"></path><path d="M15 31c1-8 5-12 7.5-14C25 19 29 23 30 31z"></path><path d="M13 35h19v5H13z"></path>`,
  },
};

const PIECE_STYLE_KEY = "prepforge.piece_style";
const PIECE_STYLE_LABELS = { berlin: "Staunton Pro", classic: "Classic" };

function activePieceSet() {
  return PIECE_SETS[appState.pieceStyle] || PIECE_SETS.berlin;
}

const PREFS_KEY = "prepforge.prefs";
const DEFAULT_PREFS = {
  theme: "system",
  coordinates: true,
  lastMovePulse: true,
  flipAnim: true,
  moveAnim: true,
  sounds: true,
  bestArrow: true,
  // Live engine on/off, remembered per view: Build shows it inside the
  // Explorer (an eval per candidate), Analyze inside the Evaluation card.
  engineBuild: false,
  engineAnalyze: false,
  // Analysis-layer gate for the Maia3 human model. OFF by default: the Analyze
  // pipeline skips its Maia pass (classifier / human probability / coach
  // intuition / brilliant signals) and no analysis-layer Maia inference runs —
  // Stockfish analysis runs either way. Independent product capabilities that
  // ARE Maia by design (Train Play opponent fallback, Build human-like
  // branches) keep their existing behavior and never consult this.
  // Replaces the old "Detect brilliant moves" toggle: with Maia analysis ON,
  // brilliant signals ride the analysis pipeline.
  maiaAnalysis: false,
};
const PREF_LABELS = {
  coordinates: "Board coordinates",
  lastMovePulse: "Last-move pulse",
  flipAnim: "Flip animation",
  moveAnim: "Move animation",
  sounds: "Move / capture sounds",
  bestArrow: "Engine best-move arrow",
};

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch (_) {
    return { ...DEFAULT_PREFS };
  }
}

function pref(name) {
  return appState.prefs ? appState.prefs[name] : DEFAULT_PREFS[name];
}

// Analysis-layer gate for the Maia3 human model. When OFF, the Analyze
// pipeline skips its Maia pass and no analysis-layer caller (classifier /
// human probability / coach intuition / brilliant signals) initializes the
// provider or runs inference. Independent product capabilities that ARE Maia
// by design (Train Play opponent fallback, Build human-like branches) keep
// their existing behavior. Stockfish paths never consult this.
function maiaAnalysisEnabled() {
  return !!pref("maiaAnalysis");
}

function setPref(name, value) {
  appState.prefs[name] = value;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(appState.prefs));
  } catch (_) {
    // ignore storage errors
  }
  applyPref(name);
}

function applyPref(name) {
  if (name === "theme") {
    applyTheme(pref("theme"));
    syncThemeToggle();
  }
  if (name === "coordinates") {
    Object.values(boards).forEach((b) => b && b.applyCoordinates && b.applyCoordinates());
  }
  if (name === "bestArrow" && !pref("bestArrow")) {
    Object.values(boards).forEach((b) => {
      if (b && b.setEngineArrow) b.setEngineArrow(null);
      if (b && b.setBetterArrow) b.setBetterArrow(null);
    });
  }
  if (name === "maiaAnalysis" && buildDockTab === "coverage") {
    // Repaint the inspector; Coverage scans only on an explicit click.
    setBuildInspector("coverage");
  }
}

// Rail (and phone More sheet) theme toggle: flips the effective theme (an
// explicit light/dark choice). Settings keeps the full System / Light / Dark control.
function syncThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  setPref("theme", dark ? "light" : "dark");
  settingsView?.renderThemeControl?.();
}

// Draw the engine's top move as a green arrow on whichever board is showing
// the analysed position; clear it everywhere else.
function setEngineBestArrow(uci) {
  const active = activeBoardController();
  Object.values(boards).forEach((b) => {
    if (!b || !b.setEngineArrow) return;
    if (b === active && pref("bestArrow") && uci) b.setEngineArrow(uci);
    else b.setEngineArrow(null);
  });
}

// Tiny synthesized SFX so we don't ship audio assets. type: move | capture | check.
// move/capture mimic a wooden piece hitting the board: a short filtered noise
// "click" plus a low body "thump". Capture layers a second, harder knock so it
// reads as two pieces colliding.
let _audioCtx = null;

// One wooden knock = noise burst through a bandpass (the contact click) +
// a fast pitch-dropping sine (the low body). Returns nothing; best-effort.
function _woodKnock(ctx, when, opts) {
  const { dur, noiseFreq, noiseQ, noiseGain, bodyFreq, bodyGain } = opts;

  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    const t = i / frames;
    // Sharp attack, quick exponential-ish decay so it sounds like a tap.
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = noiseFreq;
  bp.Q.value = noiseQ;
  const nGain = ctx.createGain();
  nGain.gain.value = noiseGain;
  noise.connect(bp);
  bp.connect(nGain);
  nGain.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(bodyFreq, when);
  osc.frequency.exponentialRampToValueAtTime(bodyFreq * 0.5, when + dur);
  const oGain = ctx.createGain();
  oGain.gain.setValueAtTime(0.0001, when);
  oGain.gain.exponentialRampToValueAtTime(bodyGain, when + 0.004);
  oGain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(oGain);
  oGain.connect(ctx.destination);

  noise.start(when);
  noise.stop(when + dur + 0.02);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

function playSound(type) {
  if (!pref("sounds")) return;
  try {
    if (!_audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      _audioCtx = new AC();
    }
    const ctx = _audioCtx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;

    if (type === "check") {
      // Keep a clear tonal alert for check, not a wood knock.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "triangle";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.16);
      return;
    }

    if (type === "capture") {
      // Two hard knocks: pieces colliding, then settling on the square.
      _woodKnock(ctx, now, {
        dur: 0.05,
        noiseFreq: 2400,
        noiseQ: 0.7,
        noiseGain: 0.55,
        bodyFreq: 240,
        bodyGain: 0.5,
      });
      _woodKnock(ctx, now + 0.045, {
        dur: 0.08,
        noiseFreq: 1500,
        noiseQ: 0.9,
        noiseGain: 0.4,
        bodyFreq: 170,
        bodyGain: 0.42,
      });
      return;
    }

    // Plain move: one soft wooden tap.
    _woodKnock(ctx, now, {
      dur: 0.07,
      noiseFreq: 2600,
      noiseQ: 1.1,
      noiseGain: 0.32,
      bodyFreq: 250,
      bodyGain: 0.3,
    });
  } catch (_) {
    // audio is best-effort
  }
}

const appState = {
  currentView: "dashboard",
  repertoireList: [],
  analysis: null,
  // Raw PGN from the most recent in-session Analyze run (not history recall).
  analysisSourcePgn: null,
  // A finished-but-unsaved analysis held only in memory (device storage
  // refused the checkpoint) so "Retry save" can still reach it.
  analysisUnsavedCheckpoint: null,
  analysisJobId: null,
  analysisPolling: false,
  analysisPly: 0,
  analysisBoardFen: START_FEN,
  // Study variations explored on the Analyze board: a small client-side tree
  // hanging off the analyzed mainline so the player can branch out and compare
  // lines without losing the original game.
  analysisVarNodes: new Map(),
  analysisVarCounter: 0,
  analysisCurrentNodeId: "root",
  analysisTree: null,
  // Last position fed to the coach panel: { fen, lastUci, lastSan }.
  explainContext: { fen: START_FEN, lastUci: null, lastSan: null },
  evalChartPoints: [],
  build: null,
  buildLoading: false,
  buildNodeById: new Map(),
  buildCurrentNodeId: null,
  buildBranchChoiceId: null,
  // ---- Local-first Build sync (docs/local-first-sync-plan.md Phase 1) ----------
  // Moves land in the local tree instantly (no per-move round-trip) and flush to
  // the server in debounced batches via POST /api/build/add-moves.
  buildPending: [], // queued { tempId, parentRef, uci, node } awaiting a flush
  buildPendingDeletes: [], // queued subtree-root node ids awaiting a delete flush
  buildTmpCounter: 0, // monotonic source of `tmp-N` provisional ids
  buildIdMap: {}, // tmp -> real id, accumulated across reconciles this session
  buildFlushTimer: null, // idle-debounce handle
  buildFlushing: null, // in-flight flush promise (hard flush awaits it)
  buildSyncState: "saved", // saved | dirty | syncing | error
  buildSyncRetry: 0, // exponential-backoff attempt counter
  // Subtree-root ids pruned locally but still inside their undo window — not yet
  // queued for the server. A reconcile re-hydrate must re-prune these too.
  buildUndoDeletes: new Set(),
  // `${parentId}:${uci}` -> commit fn for a parked subtree delete. Lets a replay of
  // the SAME move force its delete to flush first (server still has the old node,
  // so an add ahead of the delete would dedupe into the doomed node).
  buildUndoCommitByMove: new Map(),
  // Repertoire ids hidden from lists while their delete-undo window is open.
  pendingRepDeletes: new Set(),
  trainingRepertoireId: null,
  // Practice game keeps its own multi-select independent of the legacy
  // line-rehearsal picker. `null` means the list has not been hydrated yet;
  // the first active-list load then selects every active repertoire by default.
  playRepertoireIds: null,
  playRepertoirePreferenceKey: null,
  training: null,
  // Which trainer the Start button launches: "smart" (card queue, default) or
  // "all_lines" (legacy whole-line rehearsal, kept for pre-game prep).
  trainMode: "smart",
  play: null,
  // One on-demand Lucky round at a time. This protects Lichess's one-request
  // at-a-time guidance and prevents two clicks from racing their Play boards.
  luckyBusy: false,
  // Live smart-queue session state (see the Smart queue trainer section).
  smart: null,
  // ---- Local-first Train sync (plan §2) -----------------------------------
  // The smart session runs entirely in the browser off the /smart/start card
  // bundle; graded first attempts + the session position flush in debounced
  // batches via POST /api/train/smart/sync.
  trainSync: {
    pending: [], // queued { session_id, node_id, correct } graded attempts
    dirty: false, // position (card_index/queue) changed since the last flush
    timer: null, // idle-debounce handle
    flushing: null, // in-flight flush promise
    retry: 0, // exponential-backoff attempt counter
  },
  // R-03: ops the server permanently refused. Kept for inspection/export —
  // restored on reload, never silently dropped, never auto-retried.
  buildRejected: [],
  trainRejected: [],
  // Whether the durable outbox write succeeded. False means the queue only
  // lives in this tab, which the UI must state honestly.
  outboxPersisted: true,
  outboxStorageWarned: false,
  trainSyncState: "saved", // saved | dirty | syncing | error (Train save chip)
  // The LIVE Lichess token's username (drives latest-game fetch / replay). Null when
  // the token is absent/expired even if still signed in.
  lichessUsername: null,
  // The account's stable Lichess username from auth status — persists across a token
  // drop and is what the user-name button shows. Null only for a true guest.
  accountUsername: null,
  // The account's user id (from auth status); lets the Teams view spot the caller in
  // a member list (remove-self / leave). Null for a guest.
  accountUserId: null,
  // Whether this browser's session is bound to a real PrepForge account (vs a guest).
  // Guests see the sign-in action; signed-in users get the account menu and may link
  // a Lichess account separately.
  signedIn: false,
  replayResults: null,
  replayFilter: null, // summary-chip filter: an outcome kind, or null = all
  replayOpen: new Set(), // at most one selected game in the inspector
  replaySection: "games",
  // Teams view: cache of the caller's teams (for the rep-share picker) and the
  // currently-expanded team's id (so a member add/remove re-renders the right one).
  teams: [],
  selectedTeamId: null,
  // Public share-link viewer (?shared=token). Team-shared read-only uses
  // build.writable === false instead — see isBuildReadOnly().
  sharedToken: null,
  pieceStyle: "berlin",
  // Maia3 strength: a Settings-pinned rating (null = AUTO), and the auto-resolved
  // rating from the linked Lichess account's public profile (null until fetched).
  maiaRatingPinned: null,
  maiaAutoRating: null,
  // Whether the server exposes engine/Maia compute (admin builds only). The
  // public/default flow runs compute in the browser (Analyze + Build → Generate
  // via runBrowserBuildGenerate); this flag gates legacy server-engine UI paths
  // rather than letting the user click through to a raw 403. See applyServerEngineGating.
  serverEngineEnabled: false,
};

// ---- Maia3 strength resolution ---------------------------------------------------
// A pinned Settings value wins; otherwise AUTO matches the player's own Lichess
// rating (public profile, cached locally for a day); otherwise the model default.
// Personalizes the coach's human-feel reads and the Build → Generate default.
const MAIA_FALLBACK_RATING = 1500; // mirrors engine/maia3-provider DEFAULT_RATING
const MAIA_AUTO_CACHE_KEY = "prepforge.maia_auto_rating";
const MAIA_AUTO_TTL_MS = 24 * 60 * 60 * 1000;

function effectiveMaiaRating() {
  if (Number.isFinite(appState.maiaRatingPinned)) return appState.maiaRatingPinned;
  if (Number.isFinite(appState.maiaAutoRating)) return appState.maiaAutoRating;
  return MAIA_FALLBACK_RATING;
}

// ---- Stockfish depth resolution -------------------------------------------------
// Settings is the single source of truth for how deep each browser-Stockfish search
// runs — the PER-POSITION search depth, NOT the Build tree's ply depth. Every local
// Stockfish consumer (Engine widget, Position coach, Build → Generate, Coverage
// complete) reads this so the slider in Settings actually steers them. Mirrors the
// Settings slider clamp (1-30) and falls back to 16 when unset.
const STOCKFISH_FALLBACK_DEPTH = 16;
const STOCKFISH_MIN_DEPTH = 1;
const STOCKFISH_MAX_DEPTH = 30;

function effectiveStockfishDepth() {
  const raw = appState.settings && Number(appState.settings.stockfish_depth);
  const depth = Number.isFinite(raw) ? raw : STOCKFISH_FALLBACK_DEPTH;
  return Math.max(STOCKFISH_MIN_DEPTH, Math.min(STOCKFISH_MAX_DEPTH, Math.round(depth)));
}

// Best-effort: resolve the player's strength from the linked Lichess account's public
// profile (CORS-open, no token, one tiny GET a day thanks to the cache). Uses the
// most-played live perf so a blitz player gets their blitz number, not a provisional
// classical one. Failure just leaves AUTO at the fallback — never throws.
async function refreshAutoMaiaRating() {
  const username = appState.lichessUsername;
  if (!username) {
    appState.maiaAutoRating = null;
    return;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(MAIA_AUTO_CACHE_KEY) || "null");
    if (cached && cached.username === username && Date.now() - cached.at < MAIA_AUTO_TTL_MS) {
      appState.maiaAutoRating = cached.rating;
      settingsView?.renderStrengthControls();
      return;
    }
  } catch (_) { /* corrupt cache — refetch */ }
  try {
    const profile = await fetchLichessProfile(username);
    if (!Number.isFinite(profile.maiaRating)) return;
    appState.maiaAutoRating = profile.maiaRating;
    try {
      localStorage.setItem(
        MAIA_AUTO_CACHE_KEY,
        JSON.stringify({ username, rating: profile.maiaRating, at: Date.now() }),
      );
    } catch (_) { /* storage full — fine, refetch next time */ }
    settingsView?.renderStrengthControls();
  } catch (_) { /* offline or blocked — AUTO falls back silently */ }
}

// Shown when a browser-only compute action (whole-game Analyze, Build → Generate)
// can't run because the browser engine is unavailable (page not cross-origin
// isolated). Both run browser-only — there is no server fallback.
const BROWSER_ENGINE_UNAVAILABLE =
  "Browser engine unavailable — open in a cross-origin-isolated browser to run engines locally";

// Browser Build → Generate (Phase 3c) ceilings. Deliberately conservative: the
// recursion runs on the USER's machine (deep × branches is slow) and a large tree
// risks exceeding the server apply-plan caps (≤2000 changes / depth ≤64). The
// modal enforces these; GEN_PLAN_CHANGES_SOFT_CAP mirrors the server MAX_PLAN_CHANGES
// so we fail with an actionable message instead of a raw 400 after the work is done.
const GEN_MAX_PLY_DEPTH = 20;
const GEN_PLAN_CHANGES_SOFT_CAP = 2000;

const boards = {};

// Delays (ms) for auto-dismissing a card. The countdown pauses during pointer activity.
const TOAST_DONE_DELAY = 5000;
const TOAST_FAILED_DELAY = 6000;
const TOAST_CANCELLED_DELAY = 4500;
// Minimum gap between progress repaints. A tight loop (e.g. per-ply Brilliant checks, where
// most plies are ineligible and iterate with no awaits between them) can call update() hundreds
// of times back-to-back; repainting the bar + message every tick is wasted layout. We coalesce
// to ~one repaint per this interval. Skipped ticks lose nothing — percent/message are stashed
// and the next allowed tick (or the terminal complete/fail/cancel, which paint directly) shows
// the final state — so this is a pure throughput win with no effect on what the user ends up seeing.
const TOAST_PROGRESS_RENDER_MS = 90;
// How long the pointer must rest motionless over a card before its countdown
// is allowed to resume.
const TOAST_IDLE_RESUME_MS = 1100;

// A single notification card. Each job owns its own Toast (DOM + timers) so
// consecutive jobs never cross-talk; an old card's auto-dismiss can never
// reach into a newer card the way a shared, reused element used to.
//
// Two flavours share this one card system so they stack in a single column
// instead of overlapping:
//   - "job"  : a progress card with a Stop button (Analyze / Build gen).
//   - "info" : a notification with custom action buttons (e.g. "new game").
class Toast {
  constructor(stack, opts = {}) {
    const { id, title, tab, total, variant, onCancel, message, actions } = opts;
    this.stack = stack;
    this.id = id;
    this.tab = tab || null;
    this.variant = variant === "info" ? "info" : "job";
    this.state = this.variant === "info" ? "info" : "running";
    this.minimized = false;
    this.activeTotal = Math.max(1, Number(total) || 1);
    this.lastDisplayedPercent = 0;
    // The named phase the bar is currently tracking (e.g. "stockfish" →
    // "maia-load" → "maia-inference" → "maia-traps" → "classify-save"). A job
    // that runs several phases with DIFFERENT scales resets the
    // denominator + bar when the phase label changes (see update()); null until the first
    // labelled tick.
    this._phase = null;
    // Progress-repaint coalescing (see update()): timestamp of the last DOM paint, the most
    // recent message we were asked to show but may have skipped painting, and a single
    // trailing-flush timer that guarantees the latest skipped state is eventually drawn.
    this._lastProgressRenderAt = 0;
    this._pendingMessage = null;
    this._progressFlushTimer = null;
    this.onClick = null;
    this.onCancel = typeof onCancel === "function" ? onCancel : null;
    this.cancelRequested = false;
    this.removed = false;
    // Single auto-action timer, gated by pointer activity.
    this.dismissTimer = null;
    this.dismissDelay = 0;
    this.dismissAction = null;
    this.idleTimer = null;
    this.hovering = false;
    this.pointerActive = false;
    // `dock`: an in-page host (e.g. the Analyze panel) for a job whose card would
    // otherwise float over the very result it is producing. A docked job is a panel
    // card, not a floating toast: one header row (title, live status, Stop) over a thin
    // progress track, and it never minimizes itself.
    const dock = opts.dock && opts.dock.isConnected ? opts.dock : null;
    this.dock = dock;
    this.docked = !!dock;
    this.el = this._build(title || "Working...", message, actions);
    this.el._toast = this;
    if (dock) {
      this.el.classList.add("is-docked");
      // One card per dock: a new job replaces the previous job's finished card.
      if (dock._jobToast) dock._jobToast.dismiss(true);
      dock._jobToast = this;
    }
    (dock || stack.container).appendChild(this.el);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
  }

  _build(title, message, actions) {
    const el = document.createElement("div");
    el.className = `job-toast state-${this.state} variant-${this.variant}`;
    el.dataset.state = this.state;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    const stopBtn = this.onCancel
      ? '<button class="job-toast-stop" type="button">Stop</button>'
      : "";
    let bodyInner;
    if (this.variant === "job") {
      el.innerHTML =
        '<div class="job-toast-head">' +
        `<span class="job-toast-title">${escapeHtml(title)}</span>` +
        '<span class="job-toast-message">Queued</span>' +
        stopBtn +
        "</div>" +
        '<div class="job-toast-track"><div class="job-toast-fill"></div></div>';
    } else {
      bodyInner =
        `<div class="job-toast-message">${escapeHtml(message || "")}</div>` +
        '<div class="job-toast-actions"></div>';
    }
    if (bodyInner !== undefined) {
      el.innerHTML =
        '<div class="job-toast-head">' +
        '<span class="job-toast-icon" aria-hidden="true"></span>' +
        `<span class="job-toast-title">${escapeHtml(title)}</span>` +
        '<button class="job-toast-collapse" type="button" title="Minimize" aria-label="Minimize">_</button>' +
        "</div>" +
        `<div class="job-toast-body">${bodyInner}</div>`;
    }
    this.titleEl = el.querySelector(".job-toast-title");
    this.messageEl = el.querySelector(".job-toast-message");
    this.fillEl = el.querySelector(".job-toast-fill");
    this.collapseBtn = el.querySelector(".job-toast-collapse");
    this.stopBtn = el.querySelector(".job-toast-stop");
    if (this.collapseBtn) {
      this.collapseBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleMinimize(true);
      });
    }
    if (this.stopBtn) {
      this.stopBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.requestCancel();
      });
    }
    if (this.variant === "info" && Array.isArray(actions)) {
      const host = el.querySelector(".job-toast-actions");
      actions.forEach((action) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `btn ${action.primary ? "primary" : "ghost"} toast-action`;
        btn.textContent = action.label || "OK";
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          if (typeof action.onClick === "function") action.onClick();
          if (action.closeOnClick !== false) this.dismiss();
        });
        host.appendChild(btn);
      });
    }
    el.addEventListener("click", () => {
      if (this.state === "done" && this.onClick) {
        this.onClick();
        this.dismiss();
      } else if (this.minimized) {
        this.toggleMinimize(false);
      }
    });
    this._bindHoverGating(el);
    return el;
  }

  update({ current, total, message, phase }) {
    if (this.state !== "running") return;
    if (phase && phase !== this._phase) {
      // Entering a new phase with its own scale: adopt its denominator — which may be SMALLER
      // than the previous phase's (e.g. 48 positions → 47 moves) — and restart the bar. The
      // monotonic "activeTotal only grows / percent only climbs" rule below is right WITHIN a
      // phase, but across phases it pinned a smaller-denominator phase near the 95% cap, so the
      // job looked frozen at "47/48". A phase change is the one place both may move backward.
      this._phase = phase;
      if (total) this.activeTotal = Math.max(1, total);
      this.lastDisplayedPercent = 0;
      this._lastProgressRenderAt = 0;
    } else if (total && total > this.activeTotal) {
      this.activeTotal = total;
    }
    const ratio = Math.max(0, Math.min(1, (Number(current) || 0) / this.activeTotal));
    // Slightly pessimistic curve so the final segment feels fast.
    const pessimistic = Math.pow(ratio, 1.5);
    const display = Math.min(0.95, pessimistic);
    if (display > this.lastDisplayedPercent) this.lastDisplayedPercent = display;
    if (this.fillEl) {
      const hasRealProgress = (Number(current) || 0) > 0;
      this.fillEl.classList.toggle(
        "is-indeterminate",
        !hasRealProgress && this.lastDisplayedPercent === 0,
      );
    }
    if (message) this._pendingMessage = message;
    // Coalesce rapid ticks: repaint at most once per TOAST_PROGRESS_RENDER_MS. A tick inside
    // the window doesn't paint NOW, but it arms a single trailing flush for the end of the
    // window — so the latest stashed percent/message is GUARANTEED to be drawn even if no
    // further tick (and no terminal complete/fail/cancel) ever arrives. No skipped state is lost.
    const now = Date.now();
    const elapsed = now - this._lastProgressRenderAt;
    if (elapsed < TOAST_PROGRESS_RENDER_MS) {
      if (!this._progressFlushTimer) {
        this._progressFlushTimer = setTimeout(
          () => this._flushProgress(),
          TOAST_PROGRESS_RENDER_MS - elapsed,
        );
      }
      return;
    }
    this._flushProgress();
  }

  // Paint the latest stashed progress (bar + message). Cancels any pending trailing flush so
  // the leading and trailing edges never double-paint. No-op once the job has left "running":
  // the terminal states (complete/fail/cancelled) paint their own final frame, and a late
  // trailing flush must not stomp it back to ~95% / a stale message.
  _flushProgress() {
    this._clearProgressFlush();
    if (this.state !== "running") return;
    this._lastProgressRenderAt = Date.now();
    this._renderFill(this.lastDisplayedPercent);
    if (this._pendingMessage && !this.cancelRequested) {
      this.messageEl.textContent = this._pendingMessage;
    }
  }

  _clearProgressFlush() {
    if (this._progressFlushTimer) {
      clearTimeout(this._progressFlushTimer);
      this._progressFlushTimer = null;
    }
  }

  requestCancel() {
    if (this.cancelRequested || !this.onCancel) return;
    this.cancelRequested = true;
    this.el.classList.add("is-cancelling");
    if (this.stopBtn) {
      this.stopBtn.disabled = true;
      this.stopBtn.textContent = "Stopping...";
    }
    if (this.messageEl) this.messageEl.textContent = "Stopping job...";
    try {
      this.onCancel();
    } catch (_) {
      /* best-effort */
    }
  }

  // Make the job non-cancellable from here on and remove the Stop affordance.
  // Used once a result is committed to a server save: aborting the fetch can't
  // un-persist an atomic apply, so the UI must stop implying a cancel that
  // wouldn't hold. No-op if the user already requested cancel.
  //
  // The job stays "running" through the save phase, so the _flushProgress state-guard does
  // NOT protect this message: a trailing flush armed by a throttled progress tick just before
  // the lock would otherwise fire ~90ms later and stomp the lock text back to the stale
  // progress message. Cancel that pending flush AND adopt the lock message as the new stash,
  // so neither the pending flush nor any later one can overwrite it.
  lockCancel(message) {
    this._clearProgressFlush();
    this._dropStop();
    if (message && this.messageEl && !this.cancelRequested) {
      this._pendingMessage = message;
      this.messageEl.textContent = message;
    }
  }

  // Remove the Stop affordance and detach the cancel handler. Used both by the
  // saving-phase lock and by every terminal state below: once a job is done/failed/
  // stopped, cancellation has no meaning, so the finished card must not keep a Stop
  // button that visually implies it can still be cancelled.
  _dropStop() {
    this.onCancel = null;
    if (this.stopBtn) {
      this.stopBtn.remove();
      this.stopBtn = null;
    }
  }

  complete({ title, message, onClick } = {}) {
    this.state = "done";
    this.minimized = false;
    this._clearProgressFlush();
    this._dropStop();
    this.onClick = typeof onClick === "function" ? onClick : null;
    this._applyState();
    if (title) this.titleEl.textContent = title;
    if (message) this.messageEl.textContent = message;
    this.lastDisplayedPercent = 1;
    this._renderFill(1);
    if (this.dock?.id === "analysis-job-dock") this.dismiss(true);
    else this._arm(TOAST_DONE_DELAY, () => this.dismiss());
  }

  fail(message) {
    this.state = "failed";
    this._clearProgressFlush();
    this._dropStop();
    this._applyState();
    this.titleEl.textContent = "Job failed";
    this.messageEl.textContent = message || "Unknown error";
    this._arm(TOAST_FAILED_DELAY, () => this.dismiss());
  }

  // A job the user stopped: acknowledge briefly, then fade out.
  cancelled(message) {
    this.state = "cancelled";
    this.minimized = false;
    this._clearProgressFlush();
    this._dropStop();
    this._applyState();
    this.titleEl.textContent = "Stopped";
    if (message) this.messageEl.textContent = message;
    this._renderFill(this.lastDisplayedPercent);
    this._arm(TOAST_CANCELLED_DELAY, () => this.dismiss());
  }

  toggleMinimize(force) {
    if (this.variant === "job") return;
    const next = typeof force === "boolean" ? force : !this.minimized;
    this.minimized = next;
    this.el.classList.toggle("is-minimized", next);
  }

  dismiss(immediate = false) {
    if (this.removed) return;
    this.removed = true;
    this._clearProgressFlush();
    this._clearDismiss();
    this._clearIdle();
    if (this.dock && this.dock._jobToast === this) this.dock._jobToast = null;
    if (immediate) {
      this.el.remove();
      this.stack._forget(this);
      return;
    }
    // Collapse out: slide away + shrink height so the cards below rise smoothly.
    this.el.classList.remove("is-visible");
    this.el.classList.add("is-leaving");
    setTimeout(() => {
      this.el.remove();
      this.stack._forget(this);
    }, 300);
  }

  _applyState() {
    this.el.dataset.state = this.state;
    this.el.classList.remove(
      "state-running",
      "state-done",
      "state-failed",
      "state-cancelled",
      "state-info"
    );
    this.el.classList.add(`state-${this.state}`);
    this.el.classList.toggle("is-minimized", this.minimized);
    const failed = this.state === "failed";
    this.el.setAttribute("role", failed ? "alert" : "status");
    this.el.setAttribute("aria-live", failed ? "assertive" : "polite");
  }

  _renderFill(ratio) {
    if (!this.fillEl) return;
    this.fillEl.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    if (ratio > 0) this.fillEl.classList.remove("is-indeterminate");
  }

  // ---- Pointer-gated auto-dismiss --------------------------------------
  // Arms a single deferred action (minimize or dismiss). The countdown is
  // suspended while the pointer is actively moving over the card and only
  // (re)starts once the pointer leaves or goes still — so a card never
  // collapses out from under a user who is reading or reaching for it.
  _arm(delay, action) {
    this.dismissDelay = delay;
    this.dismissAction = action;
    this._evaluateDismiss();
  }

  _evaluateDismiss() {
    if (!this.dismissAction) return;
    const hold = this.hovering && this.pointerActive;
    if (hold) {
      this._clearDismiss();
      return;
    }
    if (this.dismissTimer) return; // already counting
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      const action = this.dismissAction;
      this.dismissAction = null;
      if (action) action();
    }, this.dismissDelay);
  }

  _clearDismiss() {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  _clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _bindHoverGating(el) {
    el.addEventListener("pointerenter", () => {
      this.hovering = true;
      this.pointerActive = true;
      this._evaluateDismiss();
    });
    el.addEventListener("pointermove", () => {
      if (!this.hovering) this.hovering = true;
      this.pointerActive = true;
      this._clearIdle();
      this._evaluateDismiss();
      // Resume the countdown once the pointer rests motionless for a moment.
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.pointerActive = false;
        this._evaluateDismiss();
      }, TOAST_IDLE_RESUME_MS);
    });
    el.addEventListener("pointerleave", () => {
      this.hovering = false;
      this.pointerActive = false;
      this._clearIdle();
      this._evaluateDismiss();
    });
  }
}

// Manages a vertical stack of independent Toasts. Heavy jobs are sequential
// (the server runs one at a time), so the manager tracks the current job as
// `active` for update/complete/fail/cancel, but every card — including info
// notifications — lives and dies on its own.
class ToastStack {
  constructor() {
    this.container = null;
    this.active = null;
  }

  bind() {
    this.container = document.getElementById("toast-stack");
    // A finished job's card has said its piece: the next click anywhere else
    // clears it, so it never sits over the control the user reaches for next.
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.container || this.container.contains(event.target)) return;
        this.container
          .querySelectorAll(".job-toast.state-done, .job-toast.state-failed, .job-toast.state-cancelled")
          .forEach((el) => {
            // Cards that still offer something (open result, Retry) stay until their timer.
            if (el._toast && !el._toast.onClick && !el.querySelector(".toast-action")) el._toast.dismiss();
          });
      },
      true,
    );
  }

  isBusy() {
    return !!this.active && this.active.state === "running";
  }

  startJob(opts) {
    if (!this.container) return null;
    this.active = new Toast(this, opts);
    return this.active;
  }

  // Standalone notification card (shares the stack so nothing overlaps).
  notify(opts) {
    if (!this.container) return null;
    return new Toast(this, { ...opts, variant: "info" });
  }

  updateJob(data) {
    if (this.active) this.active.update(data);
  }

  completeJob(data) {
    if (this.active) this.active.complete(data);
  }

  failJob(message) {
    if (this.active) this.active.fail(message);
  }

  cancelJob(message) {
    if (this.active) this.active.cancelled(message);
  }

  // Disable cancellation on the active job (remove its Stop button).
  lockJob(message) {
    if (this.active) this.active.lockCancel(message);
  }

  _forget(toast) {
    if (this.active === toast) this.active = null;
  }
}

const jobToast = new ToastStack();

// ===== Undo notifications =====================================================
// Destructive actions apply to the UI instantly but only reach the server once
// the undo window closes — no type-to-confirm friction, and a mid-window Undo
// costs zero server requests. Commits are forced (commitPendingUndos) before
// anything that needs server truth or before the page goes away.
const UNDO_TOAST_MS = 5000;
const pendingUndoCommits = new Set();

function showUndoToast({ title, message, onUndo, onCommit, host = null }) {
  if (host) return showInlineUndo(host, { title, message, onUndo, onCommit });
  let settled = false;
  let toast = null;
  const commit = () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    try {
      onCommit();
    } catch (_) {
      /* best-effort */
    }
    if (toast) toast.dismiss();
  };
  pendingUndoCommits.add(commit);
  toast = jobToast.notify({
    title,
    message,
    actions: [
      {
        label: "Undo",
        primary: true,
        onClick: () => {
          if (settled) return;
          settled = true;
          pendingUndoCommits.delete(commit);
          try {
            onUndo();
          } catch (_) {
            /* best-effort */
          }
        },
      },
    ],
  });
  // Hovering the card pauses the countdown (Toast's pointer gating), so the
  // window never closes while the user is reaching for Undo.
  toast._arm(UNDO_TOAST_MS, commit);
  return commit;
}

// The same undo window rendered inside a view (`host`) instead of the toast
// stack — Build's move delete uses it so the card sits with the move tree
// rather than over the Explorer. One window per host: a newer delete commits
// the older one first. Hover pauses the countdown, like the toast.
function showInlineUndo(host, { title, message, onUndo, onCommit }) {
  if (host._undoCommit) host._undoCommit();
  let settled = false;
  let timer = null;
  let remaining = UNDO_TOAST_MS;
  let startedAt = 0;
  const close = () => {
    window.clearTimeout(timer);
    if (host._undoCommit === commit) {
      host._undoCommit = null;
      host.hidden = true;
      host.innerHTML = "";
    }
  };
  const commit = () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    close();
    try {
      onCommit();
    } catch (_) {
      /* best-effort */
    }
  };
  const arm = () => {
    startedAt = Date.now();
    timer = window.setTimeout(commit, remaining);
  };
  pendingUndoCommits.add(commit);
  host._undoCommit = commit;
  host.innerHTML =
    `<span class="inline-undo-text"><b>${escapeHtml(title)}</b> ${escapeHtml(message || "")}</span>` +
    '<button type="button" class="btn sm" data-inline-undo>Undo</button>';
  host.hidden = false;
  host.onpointerenter = () => {
    if (settled) return;
    window.clearTimeout(timer);
    remaining = Math.max(800, remaining - (Date.now() - startedAt));
  };
  host.onpointerleave = () => {
    if (!settled) arm();
  };
  host.querySelector("[data-inline-undo]").addEventListener("click", () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    close();
    try {
      onUndo();
    } catch (_) {
      /* best-effort */
    }
  });
  arm();
  return commit;
}

// Close every open undo window NOW. Called before hard flushes (an operation
// needs server truth) and on page hide/unload (the commits use keepalive-safe
// requests where needed).
function commitPendingUndos() {
  for (const commit of [...pendingUndoCommits]) commit();
}

class EngineWidget {
  constructor() {
    this.el = null;
    this.head = null;
    this.pvsEl = null;
    this.evalBarWhite = null;
    this.evalBarText = null;
    this.evalHead = null;
    this.linesReadout = null;
    this.linesUpBtn = null;
    this.linesDownBtn = null;
    this.depthReadout = null;
    this.closeBtn = null;
    this.resizeHandle = null;
    this.open = false;
    this.pollTimer = null;
    this.lastFen = null;
    this.lastSnapshot = null;
    // The engine line shown on the board (see _previewLine), or null.
    this.preview = null;
    this.multipv = 1;
    // Lines actually searched. Always the shown lines: Explorer row evals come
    // from their own worker (explorerEvalEngine), so the main line keeps the
    // full-strength single-PV search instead of being widened to every row.
    this.searchedMultipv = 1;
    this.maxMultipv = 5;
    this.minMultipv = 1;
    // Engine compute seam: browser Stockfish (WASM Worker) only. No server
    // fallback — if the browser engine is unavailable the widget shows an error.
    // Built lazily (on first open) at the Settings depth, and rebuilt if that
    // depth changes — so the slider in Settings actually steers the widget.
    this.engine = null;
    this.engineDepth = null;
  }

  // Build the provider on demand at the current Settings depth. If the depth changed
  // since we last built (the user dragged the slider), close the stale provider and
  // make a fresh one — the depth readout then naturally shows `current / new max`.
  _ensureEngine() {
    const depth = effectiveStockfishDepth();
    if (this.engine && this.engineDepth === depth) return;
    if (this.engine) {
      try {
        this.engine.close();
      } catch (_) {
        /* best-effort */
      }
    }
    this.engine = createSharedEvaluationProvider({ maxDepth: depth });
    this.engineDepth = depth;
  }

  // Settings depth changed: if open, rebuild at the new depth and re-analyze the
  // current board; if closed, drop the stale provider so the next open rebuilds.
  async onDepthSettingChanged() {
    if (this.engineDepth === effectiveStockfishDepth()) return;
    if (!this.open) {
      if (this.engine) {
        try {
          await this.engine.close();
        } catch (_) {
          /* best-effort */
        }
      }
      this.engine = null;
      this.engineDepth = null;
      return;
    }
    await this._restartForCurrentBoard();
    this._startPolling();
  }

  bind() {
    this.el = document.getElementById("engine-window");
    if (!this.el) return;
    this.head = document.getElementById("engine-window-head");
    this.pvsEl = document.getElementById("engine-window-pvs");
    this.evalBarWhite = document.getElementById("engine-eval-bar-white");
    this.evalBarText = document.getElementById("engine-eval-bar-text");
    this.evalHead = document.getElementById("engine-head-eval");
    this.linesReadout = document.getElementById("engine-lines-readout");
    this.linesUpBtn = document.getElementById("engine-lines-up");
    this.linesDownBtn = document.getElementById("engine-lines-down");
    this.depthReadout = document.getElementById("engine-window-depth-readout");
    this.closeBtn = document.getElementById("engine-window-close");
    this.resizeHandle = document.getElementById("engine-window-resize");
    this._renderLinesReadout();
    this._bindControls();
  }

  isOpen() {
    return this.open;
  }

  /** FEN of whichever board the active tab is showing. */
  currentFen() {
    if (activeViewName() === "build") {
      const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
      if (node && node.fen) return node.fen;
      // No repertoire open: analyse what the Build board shows, never the
      // Analyze board's position.
      return (boards.build && boards.build.fen) || START_FEN;
    }
    return appState.analysisBoardFen || START_FEN;
  }

  async openForCurrent() {
    // The engine widget runs its own lightweight Stockfish session and is
    // intentionally *not* gated on heavy Analyze/Build jobs — the user can keep
    // probing positions while a long job runs in the background.
    this.open = true;
    this.el.hidden = false;
    this.el.classList.add("is-visible");
    await this._restartForCurrentBoard();
    this._startPolling();
  }

  async close() {
    if (!this.open) return;
    this.exitPreview();
    this.open = false;
    this._stopPolling();
    setEngineBestArrow(null);
    this.el.classList.remove("is-visible");
    setTimeout(() => {
      if (!this.el.classList.contains("is-visible")) this.el.hidden = true;
    }, 240);
    try {
      if (this.engine) await this.engine.close();
    } catch (_) {
      // best-effort
    }
  }

  _searchMultipv() {
    return activeViewName() === "analyze" ? Math.max(2, this.multipv) : this.multipv;
  }

  /** Re-analyze whenever the active board changes. No-op if widget closed. */
  async onBoardChanged() {
    if (!this.open) return;
    const fen = this.currentFen();
    if (fen === this.lastFen) return;
    this._ensureEngine();
    const engine = this.engine;
    this.lastFen = fen;
    this._clearAnalysisView();
    try {
      this.searchedMultipv = this._searchMultipv();
      const snapshot = await engine.update({ fen, multipv: this.searchedMultipv });
      // Bail if the world moved while update() was in flight: the panel closed, a NEWER board
      // change set a different lastFen, or a depth change swapped the provider out. Otherwise we'd
      // paint this (now stale) FEN's eval onto the current board, or poll the wrong provider.
      // provider.serialize() orders engine commands, not these UI continuations.
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      this._renderSnapshot(snapshot);
      this._startPolling();
    } catch (error) {
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      this._showError(error.message);
    }
  }

  async _restartForCurrentBoard() {
    this._ensureEngine();
    const engine = this.engine;
    const fen = this.currentFen();
    this.lastFen = fen;
    this._clearAnalysisView();
    try {
      this.searchedMultipv = this._searchMultipv();
      const snapshot = await engine.open({ fen, multipv: this.searchedMultipv });
      // Bail if the panel closed, the board moved on, or a depth change swapped the provider
      // while open() was in flight (see onBoardChanged).
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      // Render the response immediately so depth/PVs appear without waiting
      // for the first poll.
      this._renderSnapshot(snapshot);
    } catch (error) {
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      this._showError(error.message);
    }
  }

  async _setMultipv(next) {
    const clamped = Math.max(this.minMultipv, Math.min(this.maxMultipv, next));
    if (clamped === this.multipv) return;
    this.multipv = clamped;
    this._renderLinesReadout();
    if (!this.open) return;
    this._clearAnalysisView();
    const engine = this.engine;
    const fen = this.lastFen || this.currentFen();
    try {
      this.searchedMultipv = this._searchMultipv();
      const snapshot = await engine.update({ fen, multipv: this.searchedMultipv });
      // Bail if the world moved while update() was in flight: panel closed, provider swapped, the
      // board changed, or the line count was clicked again (this.multipv !== clamped). See
      // onBoardChanged.
      if (
        !this.open ||
        engine !== this.engine ||
        fen !== this.lastFen ||
        this.multipv !== clamped
      ) {
        return;
      }
      this._renderSnapshot(snapshot);
      this._startPolling();
    } catch (error) {
      if (!this.open || engine !== this.engine || this.multipv !== clamped) return;
      this._showError(error.message);
    }
  }

  _showError(message) {
    setEngineBestArrow(null);
    setStatusError(message);
    if (this.pvsEl) {
      this.pvsEl.innerHTML = `<div class="empty-state">${escapeHtml(
        message || "Engine error"
      )}</div>`;
    }
  }

  _clearAnalysisView() {
    setEngineBestArrow(null);
    this.exitPreview();
    if (this.lastFen && this._renderGameOver(this.lastFen)) return;
    if (this.pvsEl) this.pvsEl.innerHTML = this._pendingRows(0);
    if (this.depthReadout) this.depthReadout.textContent = "0 / ?";
    if (this.evalBarText) this.evalBarText.textContent = "...";
    if (this.evalHead) {
      this.evalHead.textContent = "...";
      delete this.evalHead.dataset.side;
    }
  }

  // Placeholder rows so the panel keeps the same height while a search warms up:
  // one row per requested line, identical in size to a real line.
  _pendingRows(from) {
    let html = "";
    for (let i = from; i < this.multipv; i += 1) {
      html +=
        '<div class="engine-pv is-pending" aria-hidden="true">' +
        '<span class="engine-pv-eval">…</span>' +
        `<span class="engine-pv-line">${i === 0 ? "Calculating…" : ""}</span>` +
        "</div>";
    }
    return html;
  }

  // Checkmate / stalemate / draw on the board: there is no line to search, so
  // say the result instead of "Calculating…" forever. Returns true if shown.
  _renderGameOver(fen) {
    const over = localGameOver(fen);
    if (!over) return false;
    setEngineBestArrow(null);
    const text =
      over.kind === "checkmate"
        ? `Checkmate — ${over.winner === "white" ? "White" : "Black"} wins`
        : over.kind === "stalemate"
          ? "Stalemate — draw"
          : "Draw";
    if (this.pvsEl) {
      this.pvsEl.innerHTML =
        '<div class="engine-pv is-top is-final">' +
        `<span class="engine-pv-eval">${escapeHtml(over.result)}</span>` +
        `<span class="engine-pv-line">${escapeHtml(text)}</span>` +
        "</div>";
    }
    if (this.depthReadout) this.depthReadout.textContent = "—";
    if (this.evalBarWhite) {
      this.evalBarWhite.style.height =
        over.winner === "white" ? "100%" : over.winner === "black" ? "0%" : "50%";
    }
    if (this.evalBarText) this.evalBarText.textContent = over.result;
    if (this.evalHead) {
      this.evalHead.textContent = over.result;
      this.evalHead.dataset.side = over.winner || "even";
    }
    return true;
  }

  _renderLinesReadout() {
    if (!this.linesReadout) return;
    this.linesReadout.textContent = `${this.multipv}`;
    if (this.linesDownBtn) this.linesDownBtn.disabled = this.multipv <= this.minMultipv;
    if (this.linesUpBtn) this.linesUpBtn.disabled = this.multipv >= this.maxMultipv;
  }

  _bindControls() {
    this.closeBtn.addEventListener("click", () => setEngineOn(activeViewName(), false));
    this.linesUpBtn.addEventListener("click", () => this._setMultipv(this.multipv + 1));
    this.linesDownBtn.addEventListener("click", () => this._setMultipv(this.multipv - 1));
    // A line is for the board: clicking it (or one of its moves) plays it out there,
    // ◀ ▶ / ← → step through it, and "Back to game" (or Esc) returns. The game, the
    // analysis tree and repertoires are never touched.
    this.pvsEl.addEventListener("click", (event) => {
      const row = event.target.closest(".engine-pv[data-line]");
      if (!row) return;
      const move = event.target.closest(".pv-move[data-ply]");
      this._previewLine(Number(row.dataset.line), move ? Number(move.dataset.ply) + 1 : null);
    });
    // The rows are real controls, so Enter/Space must work too.
    this.pvsEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest(".engine-pv[data-line]");
      if (!row) return;
      event.preventDefault(); // Space would otherwise scroll the dock
      this._previewLine(Number(row.dataset.line), null);
    });
  }

  isPreviewing() {
    return !!this.preview;
  }

  // Put line `index` of the current search on the board at `ply` (1 = after its first
  // move). Clicking the previewed row again (not one of its moves) goes back to the game.
  _previewLine(index, ply) {
    if (!Number.isFinite(index)) return;
    if (this.preview && this.preview.index === index && ply === null) {
      this.exitPreview();
      return;
    }
    // A move in the previewed row belongs to the line shown there, not to whatever
    // the search has since put in that slot.
    const board = activeBoardController();
    const same = this.preview && this.preview.index === index && this.preview.board === board ? this.preview : null;
    const pv = same ? same.pv : (this.lastSnapshot?.pvs || [])[index];
    const data = same ? same.data : pv && board ? buildPvPreview(this.lastFen, pv.pv_uci || []) : null;
    if (!data) return;
    if (this.preview && this.preview.board !== board) this.exitPreview();
    const view = activeViewName();
    const labelEl = document.getElementById(view === "build" ? "build-board-label" : "analysis-board-label");
    const exitBtn = document.getElementById(view === "build" ? "build-pv-exit" : "analysis-pv-exit");
    if (!this.preview) {
      board.beginPreview({ onEnd: ({ restored }) => this._onPreviewEnded(restored) });
      this.preview = { labelEl, exitBtn, savedLabel: labelEl ? labelEl.textContent : "" };
    }
    Object.assign(this.preview, { index, data, pv, board, ply: clampPly(data, ply ?? 1) });
    this._showPreviewPly();
  }

  // ◀ ▶ ⏮ ⏭ and ← → while a line is on the board. Returns false when not previewing.
  stepPreview(action) {
    if (!this.preview) return false;
    this.preview.ply = stepPreview(this.preview.data, this.preview.ply, action);
    this._showPreviewPly();
    return true;
  }

  _showPreviewPly() {
    const p = this.preview;
    if (!p) return;
    p.board.showPreview(previewPosition(p.data, p.ply));
    if (p.labelEl) p.labelEl.textContent = previewLabel(p.data, p.ply, p.index);
    if (p.exitBtn) p.exitBtn.hidden = false;
    this._repaintRows();
  }

  // Back to the game position (no-op when not previewing).
  exitPreview() {
    if (!this.preview) return;
    this.preview.board.endPreview({ restore: true });
  }

  // The board left the preview: restored to the game (restored) or replaced by a new real
  // position the caller is about to label (not restored).
  _onPreviewEnded(restored) {
    const p = this.preview;
    if (!p) return;
    this.preview = null;
    if (restored && p.labelEl) p.labelEl.textContent = p.savedLabel;
    if (p.exitBtn) p.exitBtn.hidden = true;
    this._repaintRows();
  }

  _repaintRows() {
    if (this.lastSnapshot && this.lastSnapshot.fen === this.lastFen) this._renderSnapshot(this.lastSnapshot);
  }

  _startPolling() {
    // Never poll a closed panel. openForCurrent()/onDepthSettingChanged() call this right after
    // awaiting _restartForCurrentBoard(), so the user may have closed the widget mid-await — guard
    // here to cover every call site at once (a stray 450ms interval on a hidden panel otherwise).
    if (!this.open) return;
    this._stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const engine = this.engine;
        const fen = this.lastFen;
        const snapshot = await engine.snapshot();
        if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
        this._renderSnapshot(snapshot);
      } catch (_) {
        // Ignore transient polling errors.
      }
    }, 450);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _renderSnapshot(snapshot) {
    if (snapshot?.fen && snapshot.fen !== this.lastFen) return;
    if (!snapshot || !snapshot.session_id) {
      setEngineBestArrow(null);
      if (this.depthReadout) this.depthReadout.textContent = "0 / 0";
      return;
    }
    this.lastSnapshot = snapshot;
    if (snapshot.error) {
      this._showError(snapshot.error);
      return;
    }
    const pvs = Array.isArray(snapshot.pvs) ? snapshot.pvs : [];
    if (!pvs.length && this._renderGameOver(snapshot.fen || this.lastFen)) {
      this._stopPolling();
      return;
    }
    const depthText = `${snapshot.current_depth || 0} / ${snapshot.max_depth || "?"}`;
    if (this.depthReadout) this.depthReadout.textContent = depthText;
    // Render only as many PV slots as the user asked for; engines occasionally
    // emit transient extra ranks while changing multipv. Missing ranks keep a
    // placeholder row so the block never changes height mid-search.
    const sideToMove = snapshot.side_to_move || "white";
    const fullmoveNumber = this._fullmoveFromFen(snapshot.fen) || 1;
    const shown = pvs.slice(0, this.multipv);
    this.pvsEl.innerHTML =
      shown
        .map((pv, index) => this._renderPv(pv, index, sideToMove, fullmoveNumber))
        .join("") + this._pendingRows(shown.length);
    if (pvs.length) {
      this._renderEvalBar(pvs[0]);
      const best = (pvs[0].pv_uci || [])[0] || null;
      setEngineBestArrow(best);
    } else {
      setEngineBestArrow(null);
    }
    // The main line is the reference the Explorer's per-row colours compare against.
    explorerEvalEngine.repaint();
    // Keep the coach's one-line rationale in sync with this (deeper) search.
    if (typeof positionCoach !== "undefined") positionCoach.onWidgetSnapshot(snapshot);
    // Once the engine reaches max depth it stops; no point polling further
    // until the position changes (open/update restart polling).
    if (snapshot.running === false) this._stopPolling();
  }

  // One line per row, cut off at the panel edge. Clicking a row plays it out on the
  // board; the previewed row keeps the line it was clicked on (the search goes on
  // underneath) and marks the move on the board; rows stay one line.
  _renderPv(pv, index, sideToMove, fullmoveNumber) {
    const previewing = this.preview && this.preview.index === index ? this.preview : null;
    const line = previewing ? previewing.pv : pv;
    const evalText = this._formatEval(line.score_cp, line.mate_in);
    const moves = this._formatPvLine(
      line.pv_san || [],
      sideToMove,
      fullmoveNumber,
      previewing ? previewing.ply - 1 : -1
    );
    let cls = index === 0 ? "engine-pv is-top" : "engine-pv";
    if (previewing) cls += " is-previewing";
    const title = previewing ? "Back to game" : "Show on board";
    return (
      `<div class="${cls}" data-line="${index}" role="button" tabindex="0"` +
      ` aria-pressed="${!!previewing}" title="${title}">` +
      `<span class="engine-pv-eval">${escapeHtml(evalText)}</span>` +
      `<span class="engine-pv-line">${moves || "..."}</span>` +
      `</div>`
    );
  }

  _formatPvLine(moves, sideToMove, fullmoveNumber, currentPly = -1) {
    if (!moves || !moves.length) return "";
    const out = [];
    let move = fullmoveNumber;
    let whiteToMove = sideToMove === "white";
    for (let i = 0; i < moves.length; i += 1) {
      const san = `<span class="pv-move${i === currentPly ? " is-current" : ""}" data-ply="${i}">${escapeHtml(moves[i])}</span>`;
      if (whiteToMove) {
        out.push(`<span class="pv-move-num">${move}.</span>${san}`);
      } else {
        if (i === 0) {
          out.push(`<span class="pv-move-num">${move}...</span>${san}`);
        } else {
          out.push(san);
        }
        move += 1;
      }
      whiteToMove = !whiteToMove;
    }
    return out.join(" ");
  }

  _fullmoveFromFen(fen) {
    if (!fen) return 1;
    const parts = fen.split(" ");
    return Number(parts[5]) || 1;
  }

  _formatEval(cp, mate) {
    if (mate !== null && mate !== undefined) {
      if (mate > 0) return `#${mate}`;
      if (mate < 0) return `#-${Math.abs(mate)}`;
      return "#0";
    }
    if (cp === null || cp === undefined) return "...";
    const pawns = cp / 100;
    return (pawns >= 0 ? "+" : "") + pawns.toFixed(2);
  }

  _renderEvalBar(topPv) {
    // White-perspective win chance from cp / mate.
    let wc;
    if (topPv.mate_in !== null && topPv.mate_in !== undefined) {
      wc = topPv.mate_in > 0 ? 0.99 : 0.01;
    } else if (topPv.score_cp === null || topPv.score_cp === undefined) {
      wc = 0.5;
    } else {
      const cp = Math.max(-1000, Math.min(1000, Number(topPv.score_cp) || 0));
      wc = 1 / (1 + Math.exp(-0.00368208 * cp));
    }
    const evalStr = this._formatEval(topPv.score_cp, topPv.mate_in);
    if (this.evalBarWhite) {
      this.evalBarWhite.style.height = `${Math.round(wc * 100)}%`;
    }
    if (this.evalBarText) {
      this.evalBarText.textContent = evalStr;
      // The number sits at the winning side's end of the bar, in that side's
      // contrasting ink — top/light text on black, bottom/dark text on white —
      // so a big White advantage never renders white-on-white.
      this.evalBarText.classList.toggle("is-white-side", wc >= 0.5);
    }
    if (this.evalHead) {
      this.evalHead.textContent = evalStr;
      this.evalHead.dataset.side = wc > 0.52 ? "white" : wc < 0.48 ? "black" : "even";
    }
  }

}

const engineWidget = new EngineWidget();

// ---------------------------------------------------------------------------
// Position coach — the "basic explanation" layer for Analyze. Every position
// change gets instant, engine-free heuristic text (describePosition): material
// read, what the last move did, whose move it is, loose pieces. On top of that
// the engine's suggested move is drawn as a green board arrow with a one-line
// rationale — that arrow IS "the idea shown on the board".
//
// The engine half is debounced + token-cancellable so a flurry of next-clicks
// never queues stale searches. When the full Engine window is open we mirror its
// (deeper) top line via onWidgetSnapshot instead of spinning a second worker and
// fighting over the arrow.
// ---------------------------------------------------------------------------
// The saved full-game analysis move matching an exact (fen_before, played move, fen_after),
// or null. Lets the coach reuse Analyze's persisted verdict on a mainline ply instead of
// recomputing it. A free-exploration variation never matches (its fen/uci aren't on the saved
// mainline), so the coach still computes those live. Cheap linear scan — a game is well under
// a few hundred plies and this runs once per (debounced) position change.
function savedAnalysisMove(prevFen, uci, fen) {
  const analysis = appState.analysis;
  const moves = analysis && analysis.moves;
  if (!Array.isArray(moves) || !prevFen || !uci || !fen) return null;
  // Index lazily, memoised on the analysis object and rebuilt only when its `moves` array is
  // replaced (a new analysis run). Move objects are upgraded in place (markBrilliant) without
  // changing their fen/uci, so the index stays valid across those mutations. Keep first-match
  // semantics (a repeated position keeps its earliest ply) to mirror the old linear scan exactly.
  if (analysis._moveIndexSrc !== moves) {
    const index = new Map();
    for (const m of moves) {
      const key = `${m.fen_before}|${m.uci}|${m.fen_after}`;
      if (!index.has(key)) index.set(key, m);
    }
    analysis._moveIndex = index;
    analysis._moveIndexSrc = moves;
  }
  return analysis._moveIndex.get(`${prevFen}|${uci}|${fen}`) || null;
}

// The saved move for the position the coach is showing. On the analysed MAINLINE we know the
// exact `ply`, so we index straight into `moves[ply - 1]` — O(1), and immune to any future where
// a verdict stops being a pure function of the (fen_before, uci, fen_after) transition (today it
// is, so the fen-key path can't return a *wrong* verdict, but ply is the more direct, more
// robust lookup). We still verify the transition matches before trusting the index, then fall
// back to the fen-key scan for free-exploration variations (no ply) or any mismatch.
function savedMainlineMove(ply, prevFen, uci, fen) {
  const moves = appState.analysis && appState.analysis.moves;
  if (Array.isArray(moves) && Number.isInteger(ply) && ply >= 1 && ply <= moves.length) {
    const m = moves[ply - 1];
    if (m && m.fen_before === prevFen && m.uci === uci && m.fen_after === fen) return m;
  }
  return savedAnalysisMove(prevFen, uci, fen);
}

function sanLineFromUci(fen, pvUci) {
  const san = [];
  let curFen = fen;
  for (const uci of pvUci || []) {
    try {
      const result = localBoardAfterMove(curFen, uci);
      san.push(result.move.san || uci);
      curFen = result.move.fen_after;
    } catch (_) {
      break;
    }
  }
  return san;
}

function savedPositionEvalRead(fen, depth) {
  const positionEvals = appState.analysis && appState.analysis.position_evals;
  const ev = positionEvals && positionEvals[fen];
  if (!ev) return null;
  const pvUci = Array.isArray(ev.pv) ? ev.pv.slice() : [];
  const firstUci = ev.best_move_uci || pvUci[0] || null;
  if (!firstUci && ev.score_cp == null && ev.mate_in == null) return null;
  const pvSan = sanLineFromUci(fen, pvUci);
  return {
    fen,
    depth: ev.depth ?? depth ?? 0,
    lines: [
      {
        uci: firstUci,
        san: pvSan[0] || firstUci || "",
        cp: ev.score_cp ?? null,
        mate: ev.mate_in ?? null,
        pvUci,
        pvSan,
      },
    ],
  };
}

// Shallowest interrupted/borrowed search the coach reuses as a position read.
const COACH_MIN_REUSE_DEPTH = 10;

class PositionCoach {
  constructor() {
    this.engineDepth = null;
    // Store leases this coach holds; cancel() releases them so a newer move frees the lanes.
    this.leases = new Set();
    this.fen = null;
    this.ctx = {};
    this.enabled = true;
    this.timer = null;
    this.token = 0;
    // `${depth}|fen` -> engine read { lines:[{uci,san,cp,mate,pvUci,pvSan}], depth }
    // (White-POV). Cached so stepping forward (this position was last turn's "after")
    // costs one new search, not two. The depth is part of the key so a Settings depth
    // change can't serve a shallower read for a position seen at the old depth.
    this.evalCache = new Map();
  }

  // Follow the Settings depth, dropping the now-stale eval cache when it changes.
  _ensureEngine() {
    const depth = effectiveStockfishDepth();
    if (this.engineDepth === depth) return;
    this.engineDepth = depth;
    this.evalCache.clear();
  }

  bind() {
    const toggle = document.getElementById("explain-engine-toggle");
    if (!toggle) return;
    const read = () => toggle.classList.contains("is-on");
    const paint = (on) => {
      toggle.classList.toggle("is-on", on);
      toggle.setAttribute("aria-checked", String(on));
    };
    this.enabled = read();
    paint(this.enabled);
    toggle.addEventListener("click", () => {
      const next = !read();
      paint(next);
      this.enabled = next;
      if (this.enabled) this.update(this.fen, this.ctx);
      else {
        this.cancel();
        renderInstantCoach();
        setAnalysisBetterArrow(null);
      }
    });
  }

  // Both consumers subscribe to the shared position search. Keep the deeper
  // panel snapshot in the Coach's small, immediate-read cache too.
  onWidgetSnapshot(snapshot) {
    if (this.engineDepth !== effectiveStockfishDepth()) return;
    if (!snapshot || snapshot.fen !== this.fen && snapshot.fen !== this.ctx.prevFen) return;
    this._remember(snapshot.fen, snapshot, COACH_MIN_REUSE_DEPTH);
  }

  // Called on every Analyze position change. The instant plain-language read is
  // already on screen (renderInstantCoach); this replaces it with the engine's
  // verdict on the move that was JUST PLAYED — never a next-move instruction.
  cancel() {
    window.clearTimeout(this.timer);
    this.timer = null;
    this.token += 1;
    for (const lease of this.leases) lease.release();
    this.leases.clear();
  }

  update(fen, ctx) {
    this.cancel();
    this.fen = fen;
    this.ctx = ctx || {};
    setEngineBestArrow(null); // review mode: the board shows your move, not a hint
    // A saved grade draws its better move at once; the live read fills in the rest.
    setAnalysisBetterArrow(this.enabled && fen ? savedBetterMove(this.ctx) : null);
    if (!fen) return;
    if (!this.enabled) return; // engine off → leave the instant read
    if (activeViewName() !== "analyze") return;
    const hasMove = !!(this.ctx.prevFen && this.ctx.lastUci);
    if (!hasMove) return; // nothing played in → leave the instant read
    if (!isBrowserEngineAvailable()) return; // no engine → leave the instant read
    this._ensureEngine();
    const cached = (position) => this.evalCache.get(`${this.engineDepth}|${position}`) ||
      savedPositionEvalRead(position, this.engineDepth);
    if (cached(this.ctx.prevFen) && (localGameOver(fen) || cached(fen))) {
      void this._run(fen);
      return true; // cached verdict lands before the next browser paint
    }
    this.timer = window.setTimeout(() => this._run(fen), 280);
    return false;
  }

  async _run(fen) {
    if (fen !== this.fen) return;
    const ctx = this.ctx;
    const prevFen = ctx.prevFen;
    const token = ++this.token;
    const mover = fen.split(" ")[1] === "b" ? "white" : "black";
    // "Engine review" on a game the user played grades only their own mainline moves;
    // the opponent's get their own read: the threat, the slip to punish, your reply.
    const opponentRead = !isReviewedMove({ mover, selfSide: analysisSelfSide(), mainline: Number.isInteger(ctx.ply) });
    try {
      const c = await (_coachReady || preloadCoach());
      if (token !== this.token || fen !== this.fen || !this.enabled || activeViewName() !== "analyze") return;
      this._ensureEngine();
      // A move that ends the game leaves no position for the
      // engine to search, so the "after" read is synthesized instead.
      const over = localGameOver(fen);
      // The position BEFORE the move (best line + best alternative) and AFTER it, read
      // at once: the store gives each its own warm lane.
      const [before, after] = await Promise.all([
        this._eval(prevFen, token),
        over ? null : this._eval(fen, token),
      ]);
      if (token !== this.token || fen !== this.fen) return;
      if (!before || !before.lines.length) return;
      let top;
      if (over?.kind === "checkmate") {
        top = { cp: null, mate: mover === "white" ? 1 : -1, pvUci: [], pvSan: [] };
      } else if (over) {
        top = { cp: 0, mate: null, pvUci: [], pvSan: [] };
      } else {
        if (!after) return;
        top = after.lines[0] || {};
      }
      const prevMove = previousAnalysisMove();
      const features = c.buildMoveFeatures({
        ply: ctx.ply ?? null,
        moveNumber: Number(prevFen.split(" ")[5]) || null,
        mover,
        uci: ctx.lastUci,
        san: ctx.lastSan,
        prevSan: prevMove ? prevMove.san : null,
        prevUci: prevMove ? prevMove.uci : null,
        prevFenBefore: prevMove ? prevMove.fenBefore : null,
        fenBefore: prevFen,
        fenAfter: fen,
        beforeEval: { lines: before.lines },
        afterEval: { cp: top.cp ?? null, mate: top.mate ?? null, pvUci: top.pvUci || [], pvSan: top.pvSan || [] },
      });
      features.opponentRead = opponentRead;
      const saved = savedMainlineMove(ctx.ply, prevFen, ctx.lastUci, fen);
      // The saved grade is authoritative for Great both ways: the board badge and the move
      // list show it, so the coach neither drops a saved Great nor calls a saved ✓ move Great
      // off its shallower live read.
      if (saved && saved.classification === "great") c.markGreat(features);
      else if (saved && features.classification?.code === "great") {
        features.classification = { code: "best", label: "Best move", glyph: "✓", tone: "good" };
      }
      renderCoachProse(c.buildCommentary(features, { selfSide: analysisSelfSide() }));
      if (!opponentRead) offerLiveBetterArrow(features, saved, fen);
      // Read the position's "texture" from Maia's human-move distribution (one obvious
      // move vs. a rich spread) and fold it into the commentary — best-effort and async,
      // reusing the same Maia worker the brilliant check uses.
      this._checkIntuition(features, prevFen, fen, token);
      // A move can only be "brilliant" if the engine loves it but humans wouldn't. If a
      // full-game analysis already ran the complete Maia/Stockfish Brilliant check on THIS
      // exact move and saved its verdict (we're stepping through an analysed mainline), defer
      // to that verdict UNCONDITIONALLY — Analyze searched deeper than this debounced live
      // read, so it is authoritative, and deferring keeps the coach consistent with the saved
      // analysis even when the two disagree on eligibility. It also skips the per-click
      // recompute (a Maia assessment + policy read + a Stockfish eval). Only free exploration
      // (a variation with no saved move) is judged by the live brilliantCandidate gate here.
      if (saved) {
        if (saved.classification === "brilliant") {
          this._showSavedBrilliant(c, features, prevFen, ctx.lastUci, fen, token);
        }
        // Any other saved verdict is authoritative → the base read (already reconciled
        // with the saved Great grade above) stands.
      } else if (features.brilliantCandidate && maiaAnalysisEnabled()) {
        this._checkBrilliant(features, prevFen, ctx.lastUci, fen, token);
      }
    } catch (err) {
      console.warn("Coach: failed to build move commentary", err);
      if (token === this.token && fen === this.fen && activeViewName() === "analyze") renderInstantCoach();
    }
  }

  // Maia (a ~human-strength move model) confirms a brilliancy: it rates the move
  // poorly and assigns it a tiny human-probability, yet the engine had it as best.
  // Best-effort and async — Maia may be unavailable (e.g. weights not served), in
  // which case we simply keep the engine read with no brilliancy. Lazily inits Maia
  // on the first candidate; the shared provider caches the model after that.
  async _checkBrilliant(features, prevFen, uci, fen, token) {
    try {
      const c = await (_coachReady || preloadCoach());
      const provider = getSharedMaia3Provider();
      const rating = effectiveMaiaRating();
      // Personalized: "humans wouldn't find it" is judged at the player's own strength
      // (Settings → Playing strength), so a move can be brilliant FOR THEM.
      const a = await provider.moveAssessment({ fen: prevFen, moveUci: uci, rating });
      if (token !== this.token || fen !== this.fen || !a) return;
      // Brilliant has four layers, cheapest-first (see brilliant-assess.js). The cheap
      // ones gate the costly trap_gap (a Maia policy read + a Stockfish eval of the natural
      // move), so we never pay for it on a move a free check already ruled out:
      //   • Unintuitive — a human rarely finds it.
      //   • Reveal — Stockfish's truth sits far above Maia's first-glance read. (Free: both
      //     numbers are already in hand.)
      const hardFind =
        a.humanProbability <= c.BRILLIANT_MAX_HUMAN_PROB &&
        features.winAfterMover - a.winChanceAfter * 100 >= c.BRILLIANT_MIN_WIN_GAP;
      // Great's critical find, the server's second route: an only move bounds its gaps
      // (free), so it needs no search either — just a moderately unexpected move.
      const only = c.onlyMoveGaps(features, a.naturalUci);
      if (!hardFind && !(only && a.humanProbability <= c.GREAT_MAX_HUMAN_PROB)) return;
      const trapGap = hardFind ? await this._trapGap(features, prevFen, uci, fen, token, rating) : only.trapGap;
      if (token !== this.token || fen !== this.fen) return;
      //   • Trap, then Decisive — a hard find that is also the only move (or a sacrifice) is
      //     Brilliant; one that another quiet move would match is Great.
      const grade = c.gradeByMaia(features, {
        maiaHumanProb: a.humanProbability,
        maiaWinAfter: a.winChanceAfter,
        trapGap,
        twoMoveGap: only ? only.twoMoveGap : null,
      });
      const maia = { humanProb: a.humanProbability, winChanceAfter: a.winChanceAfter };
      if (grade === "brilliant") c.markBrilliant(features, maia);
      else if (grade === "great") c.markGreat(features, maia);
      else return;
      renderCoachProse(c.buildCommentary(features, { selfSide: analysisSelfSide() }));
    } catch (err) {
      console.warn("Coach: Maia brilliancy check unavailable", err);
      /* Maia unavailable → no brilliancy; the engine read stands. */
    }
  }

  // Render the Brilliant verdict a full-game analysis already saved for this move — no
  // recompute. We still fetch ONE cheap Maia move assessment (not the costly trap_gap) so the
  // prose can name how rarely a human finds it; if Maia is unavailable the star still shows,
  // just without that grounding detail. The verdict itself comes from Analyze, so the live
  // coach never disagrees with the saved analysis on a mainline move.
  async _showSavedBrilliant(c, features, prevFen, uci, fen, token) {
    // The saved verdict is authoritative and already says Brilliant, so commit the star to the
    // screen NOW — don't make the user stare at the base "Best" read while Maia loads. (On a
    // direct jump to a brilliant ply there's no warm cache; awaiting Maia FIRST meant Best
    // showed first, and if the user jumped on before it answered, the token invalidated and the
    // star never appeared at all.) We're called synchronously from _run right after the base
    // render, so the token is still current here; guard anyway for safety.
    if (token !== this.token || fen !== this.fen) return;
    c.markBrilliant(features, null);
    renderCoachProse(c.buildCommentary(features, { selfSide: analysisSelfSide() }));
    // Then enrich — non-blocking — with how rarely a human finds it. This is a cosmetic detail
    // on top of an already-shown Brilliant; a re-render only if the user is still on this move
    // when Maia answers. Analysis-layer Maia off (or unavailable) → the star
    // simply stays without the rarity grounding.
    if (!maiaAnalysisEnabled()) return;
    try {
      const provider = getSharedMaia3Provider();
      const a = await provider.moveAssessment({ fen: prevFen, moveUci: uci, rating: effectiveMaiaRating() });
      if (!a || token !== this.token || fen !== this.fen) return;
      c.markBrilliant(features, { humanProb: a.humanProbability, winChanceAfter: a.winChanceAfter });
      renderCoachProse(c.buildCommentary(features, { selfSide: analysisSelfSide() }));
    } catch (_) {
      /* Maia unavailable → brilliant read with no rarity detail */
    }
  }

  // trap_gap = sf_truth(played) − sf_truth(the move Maia thinks a human would naturally
  // play), mover POV (0..1) — the third brilliant layer. Asks Maia for the top-policy
  // move, then runs Stockfish on the position it leads to. Returns null when Maia has no
  // policy or the natural move can't be evaluated (→ not flagged, failing closed like the
  // server); 0 when the natural move IS the played one (no trap to avoid).
  async _trapGap(features, prevFen, playedUci, fen, token, rating) {
    const c = await (_coachReady || preloadCoach());
    const provider = getSharedMaia3Provider();
    const preds = await provider.predictions({ fen: prevFen, rating });
    if (token !== this.token || fen !== this.fen) return null;
    const naturalUci = preds && preds.length ? preds[0].move_uci : null;
    if (!naturalUci) return null;
    if (naturalUci.toLowerCase() === String(playedUci).toLowerCase()) return 0;
    let humanFen;
    try {
      humanFen = localBoardAfterMove(prevFen, naturalUci).move.fen_after;
    } catch (_) {
      return null; // illegal/unparseable natural move → trap un-evaluable
    }
    const read = await this._eval(humanFen, token);
    if (token !== this.token || fen !== this.fen || !read || !read.lines.length) return null;
    const line = read.lines[0];
    const humanWc = c.moverWinChanceAfter({ cp: line.cp ?? null, mate: line.mate ?? null }, features.mover);
    return features.winAfterMover / 100 - humanWc;
  }

  // Fold Maia's view of the position's TEXTURE into the read: its human-move distribution
  // over the position before the move says whether one move was obvious (a recapture) or
  // many looked reasonable (a sharp middlegame). Crossed with the move's quality, that's
  // what lets the coach call an error in an obvious spot a slip, and an error in a rich
  // one a hard choice. Best-effort and async — analysis-layer Maia OFF (or
  // unavailable) leaves the engine read standing with no texture note. One Maia
  // forward per move, reusing the shared
  // worker (the model is loaded once and cached), so it rides the existing budget.
  async _checkIntuition(features, prevFen, fen, token) {
    if (!maiaAnalysisEnabled()) return;
    try {
      const c = await (_coachReady || preloadCoach());
      // Personalized: the texture read runs at the player's own strength (Settings →
      // Playing strength), so "one obvious move" means obvious to THEM. The store batches
      // it with other pending Maia reads; Stockfish never waits on it.
      const read = await (await analysisStore()).maiaRead(prevFen, effectiveMaiaRating());
      if (token !== this.token || fen !== this.fen || !read) return;
      c.attachIntuition(features, read);
      renderCoachProse(c.buildCommentary(features, { selfSide: analysisSelfSide() }));
      paintMaiaCoachFromRead(prevFen, read, { playedUci: features.uci, bestUci: features.bestUci });
    } catch (err) {
      console.warn("Coach: Maia intuition read unavailable", err);
      /* Maia unavailable → no texture/sharpness note; the engine read stands. */
    }
  }

  // Run (or reuse a cached) MultiPV-2 read of `fen`, White-POV, on a short budget.
  async _eval(fen, token) {
    if (!fen) return null;
    const key = `${this.engineDepth}|${fen}`;
    const cached = this.evalCache.get(key);
    if (cached) return cached;
    const saved = savedPositionEvalRead(fen, this.engineDepth);
    if (saved) {
      this.evalCache.set(key, saved);
      return saved;
    }
    const store = await analysisStore();
    // Two tries: a worker that dies mid-search gets one fresh lane before the coach gives up.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (token !== this.token) return null;
      const lease = store.acquire(fen, { depth: this.engineDepth, multipv: 2 });
      this.leases.add(lease);
      // No wall-clock deadline: a busy machine is slower, not wrong. Only a newer move
      // (cancel releases the lease, resolving null) or an engine failure ends the wait.
      // An interrupted search keeps its depth in the store, so stepping back is instant.
      const snap = await lease.until((s) => s.pvs?.[0]?.pv_uci?.length && (s.running === false || s.current_depth >= 14));
      this.leases.delete(lease);
      lease.release();
      if (token !== this.token || !snap) return null;
      if (!snap.error) return this._remember(fen, snap, 0);
    }
    return null;
  }

  // Cache a snapshot of `fen` (if it is for that position and deep enough) as a
  // coach read; returns the read or null.
  _remember(fen, snap, minDepth) {
    if (!snap || snap.fen !== fen || (snap.current_depth || 0) < minDepth) return null;
    const lines = (snap.pvs || [])
      .filter((pv) => pv.pv_uci && pv.pv_uci.length)
      .map((pv) => ({
        uci: pv.pv_uci[0],
        san: (pv.pv_san && pv.pv_san[0]) || pv.pv_uci[0],
        cp: pv.score_cp ?? null,
        mate: pv.mate_in ?? null,
        pvUci: pv.pv_uci.slice(),
        pvSan: (pv.pv_san || []).slice(),
      }));
    if (!lines.length) return null;
    const result = { fen, depth: snap.current_depth || 0, lines };
    const key = `${this.engineDepth}|${fen}`;
    const existing = this.evalCache.get(key);
    if (existing && existing.depth > result.depth) return existing;
    this.evalCache.set(key, result);
    if (this.evalCache.size > 50) this.evalCache.delete(this.evalCache.keys().next().value);
    return result;
  }
}

const positionCoach = new PositionCoach();

const COACH_TONES = ["good", "warn", "danger", "info", "brilliant"];

// A grade (the saved analysis' classification or the live read's code) as the move
// list's colour group, for the coach's left rule.
const COACH_QUALITY_GROUP = {
  brilliant: "brilliant",
  great: "great",
  best: "good",
  excellent: "good",
  good: "good",
  book: "good",
  forced: "good",
  inaccuracy: "inaccuracy",
  mistake: "mistake",
  blunder: "blunder",
  missed_win: "missed",
  missed_tactic: "missed",
};

// Grades whose better move is drawn on the Analyze board.
const BETTER_ARROW_GRADES = new Set(["inaccuracy", "mistake", "blunder", "missed_win", "missed_tactic"]);

// The better move a saved analysis already names for an error the user made, so the
// arrow lands with the badge instead of waiting for the engine.
function savedBetterMove(ctx) {
  if (!ctx || !ctx.prevFen || !ctx.lastUci || !ctx.fen) return null;
  const mover = ctx.fen.split(" ")[1] === "b" ? "white" : "black";
  if (!isReviewedMove({ mover, selfSide: analysisSelfSide(), mainline: Number.isInteger(ctx.ply) })) return null;
  const saved = savedMainlineMove(ctx.ply, ctx.prevFen, ctx.lastUci, ctx.fen);
  if (!saved || !BETTER_ARROW_GRADES.has(String(saved.classification || "").toLowerCase())) return null;
  const ev = appState.analysis && appState.analysis.position_evals && appState.analysis.position_evals[ctx.prevFen];
  const best = ev && (ev.best_move_uci || (Array.isArray(ev.pv) ? ev.pv[0] : null));
  return best && best !== ctx.lastUci ? best : null;
}

// Draw (or clear) the better-move arrow on the Analyze board; with ``fen``, only while
// the board still shows that position.
function setAnalysisBetterArrow(uci, fen = null) {
  const board = boards.analysis;
  if (!board || !board.setBetterArrow) return;
  if (uci && fen && board.fen !== fen) return;
  board.setBetterArrow(uci && pref("bestArrow") ? uci : null);
}

// The live read's better move, when no saved one is drawn yet and the move (by its saved
// grade first) is an error.
function offerLiveBetterArrow(features, saved, fen) {
  if (boards.analysis?.betterArrow || !features.bestUci || features.isBest) return;
  const grade = (saved && saved.classification) || features.classification?.code;
  if (BETTER_ARROW_GRADES.has(String(grade || "").toLowerCase())) setAnalysisBetterArrow(features.bestUci, fen);
}

// The saved whole-game verdict on the move the coach is reading, when it has one.
function savedCoachQuality(ctx) {
  if (!ctx || !ctx.prevFen || !ctx.lastUci) return null;
  const saved = savedMainlineMove(ctx.ply, ctx.prevFen, ctx.lastUci, ctx.fen);
  return saved ? saved.classification || null : null;
}

// The Coach speaks in one short paragraph. Set its text + tone (subtle colour); the
// left rule takes the move's grade when there is one.
function setCoachProse(text, tone = "info", state = "instant", quality = null) {
  const el = document.getElementById("coach-prose");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.state = state;
  el.dataset.quality = COACH_QUALITY_GROUP[String(quality || "").toLowerCase()] || "";
  for (const t of COACH_TONES) el.classList.toggle(`is-${t}`, t === tone);
}

// The move before the current Analyze node (lets the coach tell a recapture from a
// fresh capture). null at the root or one move in.
function previousAnalysisMove() {
  const tree = appState.analysisTree;
  const node = tree && tree.byId ? tree.byId.get(appState.analysisCurrentNodeId || "root") : null;
  const parent = node && node.parent;
  if (!parent || !parent.uci) return null;
  return { san: parent.san, uci: parent.uci, fenBefore: parent.fenBefore };
}

// Render the engine's read of the move just played, in the coach's own voice.
function renderCoachProse(c) {
  if (!c) return;
  // A saved verdict outranks the live read's grade, so the rule matches the move list.
  const saved = savedCoachQuality(positionCoach.ctx);
  setCoachProse(c.prose, c.tone, "engine", saved || c.quality);
  // A move with no saved grade (a variation, an unanalysed game) takes the live grade's
  // badge, as long as the board still shows that move.
  const ctx = positionCoach.ctx || {};
  const board = boards.analysis;
  const glyph = saved ? "" : classBadgeSymbol(c.quality);
  if (glyph && ctx.lastUci && board && board.fen === ctx.fen && board.lastMove === ctx.lastUci) {
    board.setMoveBadge(ctx.lastUci.slice(2, 4), c.quality, glyph);
  }
}

let _phaseCoachMod = null;
function loadPhaseCoach() {
  if (!_phaseCoachMod) _phaseCoachMod = import("./coach/phase-coach.js");
  return _phaseCoachMod;
}

function paintPhaseChip(phase, label) {
  const el = document.getElementById("coach-phase");
  if (!el) return;
  if (!phase) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.dataset.phase = phase;
  el.textContent = label || phase;
}

// What players at this level pick in the position the move was played from (Maia):
// one pill per move, filled to its share, the played move outlined, the engine's
// choice ticked. A pill plays its move from that position as a variation.
function paintMaiaCoachLine(model) {
  const el = document.getElementById("coach-maia");
  if (!el) return;
  const picks = (model && model.picks) || [];
  if (!picks.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const rating = effectiveMaiaRating();
  const who = Number.isFinite(rating) ? `players around ${rating}` : "players";
  const pct = (p) => (p.pct < 1 ? "<1%" : `${Math.round(p.pct)}%`);
  el.hidden = false;
  el.title = `How ${who} choose here (Maia 3)`;
  el.innerHTML =
    `<span class="hp-label">Humans</span>` +
    picks
      .map((p) => {
        const notes = [p.played ? "played" : "", p.best ? "engine's choice" : ""].filter(Boolean).join(", ");
        return (
          `<button type="button" class="hp${p.played ? " is-played" : ""}${p.best ? " is-best" : ""}" ` +
          `data-uci="${escapeHtml(p.uci)}" style="--p:${Math.min(100, Math.max(0, p.pct))}%" ` +
          `title="${escapeHtml(`${p.san}: ${pct(p)} of ${who}${notes ? ` (${notes})` : ""}`)}">` +
          `<b>${escapeHtml(p.san)}</b><span class="hp-pct">${pct(p)}</span></button>`
        );
      })
      .join("");
  paintPhaseChip(model.phase, model.title);
}

// Play a human pick from the position before the current move (a variation, or the
// existing continuation when it is the move that was played).
async function playHumanPick(uci) {
  const tree = appState.analysisTree;
  const node = tree && tree.byId ? tree.byId.get(appState.analysisCurrentNodeId || "root") : null;
  const parent = node && node.parent;
  if (!parent || !uci) return;
  await selectAnalysisNode(parent.id);
  await onAnalysisBoardMove(uci, parent.fenAfter);
}

function paintPhaseFromFen(fen) {
  if (!fen) return;
  const ctx = appState.explainContext;
  loadPhaseCoach()
    .then((m) => {
      if (appState.explainContext !== ctx || activeViewName() !== "analyze") return;
      const model = m.buildPhaseCoach({ fen, predictions: [] });
      paintPhaseChip(model.phase, model.title);
    })
    .catch(() => {});
}

function paintMaiaCoachFromRead(fen, read, extra = {}) {
  loadPhaseCoach()
    .then((m) => {
      m.paintAnalysisCoach({
        fen,
        predictions: read?.predictions,
        rating: effectiveMaiaRating(),
        ...extra,
      }, appState.explainContext, paintMaiaCoachLine);
    })
    .catch(() => {});
}

async function maiaPhaseCoach({ fen, expectedUci, expectedSan, playedUci }) {
  const m = await loadPhaseCoach();
  let predictions = [];
  // Analysis-layer gate: with Maia analysis OFF the tip stays phase-generic
  // (no provider init, no inference).
  if (maiaAnalysisEnabled()) {
    try {
      const provider = getSharedMaia3Provider();
      predictions = await provider.predictions({ fen, rating: effectiveMaiaRating() });
    } catch (_) {
      /* engine off → still return a phase-generic tip */
    }
  }
  return m.buildPhaseCoach({
    fen,
    predictions,
    expectedUci,
    expectedSan,
    playedUci,
    rating: effectiveMaiaRating(),
  });
}

// Drive the coach from one position-change call: show an instant plain-language read
// immediately, then let the engine replace it with a graded verdict.
function refreshAnalysisExplain(ctx) {
  appState.explainContext = ctx || {};
  const cached = positionCoach.update(ctx ? ctx.fen : null, ctx || {});
  if (cached) {
    paintPhaseFromFen(ctx.prevFen);
    paintMaiaCoachLine(null);
  } else renderInstantCoach();
  updateBookline().catch(() => { /* book read is best-effort */ });
}

// Instant, engine-free sentence: what the last move did, or whose move it is. This is
// the placeholder the engine commentary upgrades a beat later.
function renderInstantCoach() {
  const ctx = appState.explainContext || {};
  const fen = ctx.fen || appState.analysisBoardFen || START_FEN;
  const turn = fen.split(" ")[1] === "b" ? "black" : "white";
  if (ctx.prevFen && ctx.lastSan) {
    paintPhaseFromFen(ctx.prevFen || fen);
    // The Maia note belongs to the previous move until this move's read lands.
    paintMaiaCoachLine(null);
    const mover = turn === "white" ? "Black" : "White"; // the side that just moved
    const did = describeMove(ctx.prevFen, ctx.lastUci, ctx.lastSan);
    setCoachProse(did ? `${mover} ${did}.` : `${mover} plays ${ctx.lastSan}.`, "info", "instant", savedCoachQuality(ctx));
  } else {
    paintPhaseChip(null);
    paintMaiaCoachLine(null);
    // A finished whole-game analysis on the start position: summarise the game instead
    // of the empty-board invitation.
    const summary = hasClassifiedMoves(appState.analysis)
      ? buildGameSummary({ moves: appState.analysis.moves, selfSide: analysisSelfSide() })
      : "";
    setCoachProse(summary || "Make a move and I'll tell you what I think.", "info");
  }
}

// ---------------------------------------------------------------------------
// Analyze ↔ repertoire sync ("the book"). Lazily loads the user's ACTIVE
// repertoire trees once per visit and, on every Analyze position change, walks
// the explored move path against them (path-based, like the recap's departure
// detection — transpositions intentionally don't count). The coach only speaks
// on the in-book → out-of-book TRANSITION: if a branch was never prepped the
// in-book state never held, so nothing nags (and in-book shows nothing at all).
//   - opponent leaves the book → "Add it in Build" inline action at the
//     departure node
//   - the player leaves their own book → "Train it" records one recall miss
//     (POST /api/train/record-miss) so the move leads the next smart session
// ---------------------------------------------------------------------------
const bookState = {
  generation: 0,
  loaded: false,
  loading: null,
  reps: [], // { id, name, color, rootId, children: Map("parentId|uci" -> node), kids: Map(parentId -> [node]) }
};

// Build edits make this copy stale; drop it so the next Analyze look refetches.
function invalidateBook() {
  bookState.generation++;
  bookState.loaded = false;
  bookState.loading = null;
  bookState.reps = [];
}

let bookActionsPromise = null;
function loadBookActions() {
  bookActionsPromise ||= import("./analyze-book.js").then(({ createBookActions }) => createBookActions({
    bookState, appState, currentOwnerId, api, loadCoach: () => (_coachReady || preloadCoach()),
    escapeHtml, rememberHandoff, postJson, setStatus, setStatusError, editRepertoire,
  })).catch((error) => { bookActionsPromise = null; throw error; });
  return bookActionsPromise;
}

async function ensureBookLoaded() {
  return (await loadBookActions()).ensureBookLoaded();
}

async function updateBookline() {
  return (await loadBookActions()).updateBookline();
}

class BoardController {
  constructor(config) {
    this.board = document.getElementById(config.boardId);
    this.overlay = document.getElementById(config.overlayId);
    this.onMove = config.onMove;
    this.onAnnotate = config.onAnnotate || null;
    this.fen = null;
    this.legalMoves = [];
    this.selected = null;
    this.lastMove = null;
    this.dragFrom = null;
    this.ghost = null;
    this.engineArrow = null;
    this.betterArrow = null;
    this.branchArrows = [];
    this.branchPick = null;
    this.moveBadge = null;
    this._hadPosition = false;
    this.annotationStart = null;
    this.highlights = new Set();
    this.arrows = [];
    this.squares = new Map();
    this._badgeEl = null;       // tracks the one square holding a .square-badge
    this._badgeKey = "";        // what that badge shows, so an unchanged one is left alone
    this._lastMoveSqs = null;   // tracks the [from, to] squares of the current last-move
    this.orientation = "white";
    this._rovingSquare = null; // tabbable-square cursor for the roving tabindex
    this._typedFile = null; // file letter typed toward a keyboard square jump ("e" of "e4")
    this._typedAt = 0;
    this._buildGrid();
    this._bindBoardEvents();
  }

  setOrientation(orientation) {
    const next = orientation === "black" ? "black" : "white";
    if (this.orientation === next) return;
    this.orientation = next;
    // Rebuilding the grid drops DOM focus (innerHTML wipe); restore it to the
    // same square so a keyboard user isn't dumped out of the board on a flip.
    const focusedSquare = document.activeElement?.dataset?.square;
    this._buildGrid();
    if (focusedSquare && this.squares.has(focusedSquare)) {
      this.squares.get(focusedSquare).focus();
    }
    if (this.fen) this._renderPieces();
    this._updateClasses();
    this._renderArrows();
    if (pref("flipAnim")) {
      this.board.classList.remove("is-flipping");
      // reflow so the class re-add restarts the animation
      void this.board.offsetWidth;
      this.board.classList.add("is-flipping");
      window.setTimeout(() => this.board.classList.remove("is-flipping"), 420);
    }
  }

  _renderArrows() {
    renderAnnotations(
      this.overlay,
      this.arrows,
      this.orientation,
      this.engineArrow,
      this.branchArrows,
      this.branchPick,
      this.betterArrow
    );
  }

  // --- Engine-line preview ---------------------------------------------------
  // Shows positions that are not the game's (an engine PV) without touching the game,
  // the analysis tree or a repertoire. The real position is saved on entry and put back
  // by endPreview(); a real setPosition() while previewing ends the preview instead (the
  // game moved on), so a stale preview can never hide the real board. Moves are off while
  // previewing (no legal moves), and engine/fork arrows meant for the real position wait.
  isPreviewing() {
    return !!this._preview;
  }

  beginPreview({ onEnd = null } = {}) {
    if (!this._preview) {
      this._preview = {
        fen: this.fen,
        legalMoves: this.legalMoves,
        lastMove: this.lastMove,
        moveBadge: this.moveBadge,
        engineArrow: this.engineArrow,
        betterArrow: this.betterArrow,
        branchArrows: this.branchArrows,
        branchPick: this.branchPick,
      };
    }
    this._preview.onEnd = onEnd;
    this.board.classList.add("is-previewing");
  }

  showPreview({ fen, lastMove = null }) {
    if (!this._preview || !fen) return;
    this._renderingPreview = true;
    try {
      this.setPosition({ fen, legalMoves: [], lastMove });
    } finally {
      this._renderingPreview = false;
    }
    this.moveBadge = null;
    this._syncMoveBadge();
    this.engineArrow = null;
    this.betterArrow = null;
    this.branchArrows = [];
    this.branchPick = null;
    this._renderArrows();
  }

  // Put the saved real position back (restore = true), or just drop the preview because
  // the caller is about to show a new real position (restore = false).
  endPreview({ restore = true } = {}) {
    const saved = this._preview;
    if (!saved) return;
    this._preview = null;
    this.board.classList.remove("is-previewing");
    if (restore) {
      this.setPosition({ fen: saved.fen, legalMoves: saved.legalMoves, lastMove: saved.lastMove });
      this.moveBadge = saved.moveBadge;
      this._syncMoveBadge();
      this.engineArrow = saved.engineArrow;
      this.betterArrow = saved.betterArrow;
      this.branchArrows = saved.branchArrows;
      this.branchPick = saved.branchPick;
      this._renderArrows();
    }
    if (saved.onEnd) saved.onEnd({ restored: restore });
  }

  setEngineArrow(uci) {
    const next = uci || null;
    if (this._preview) {
      this._preview.engineArrow = next;
      return;
    }
    if (this.engineArrow === next) return;
    this.engineArrow = next;
    this._renderArrows();
  }

  // The move the side that just moved should have played instead (Analyze, on a graded
  // error), drawn in its own colour so it never reads as the engine's next move.
  setBetterArrow(uci) {
    const next = typeof uci === "string" && uci.length >= 4 ? uci : null;
    if (this._preview) {
      this._preview.betterArrow = next;
      return;
    }
    if (this.betterArrow === next) return;
    this.betterArrow = next;
    this._renderArrows();
  }

  // Faint arrows for the fork's next-move options at the current position, so a
  // branch point is visible on the board itself (the fork picker's on-board echo).
  // ``pickUci`` is the currently picked option, drawn stronger than its siblings.
  setBranchArrows(list, pickUci = null) {
    const next = Array.isArray(list) ? list.filter((u) => typeof u === "string" && u.length >= 4) : [];
    const pick = typeof pickUci === "string" && pickUci.length >= 4 ? pickUci : null;
    if (this._preview) {
      this._preview.branchArrows = next;
      this._preview.branchPick = pick;
      return;
    }
    const same =
      pick === this.branchPick &&
      next.length === this.branchArrows.length &&
      next.every((u, i) => u === this.branchArrows[i]);
    if (same) return;
    this.branchArrows = next;
    this.branchPick = pick;
    this._renderArrows();
  }

  flip() {
    this.setOrientation(this.orientation === "white" ? "black" : "white");
  }

  _buildGrid() {
    this.board.innerHTML = "";
    this.squares.clear();
    const ranks = this.orientation === "white"
      ? [8, 7, 6, 5, 4, 3, 2, 1]
      : [1, 2, 3, 4, 5, 6, 7, 8];
    const fileIndices = this.orientation === "white"
      ? [0, 1, 2, 3, 4, 5, 6, 7]
      : [7, 6, 5, 4, 3, 2, 1, 0];
    const bottomRank = ranks[ranks.length - 1];
    const leftFile = fileIndices[0];
    for (const rank of ranks) {
      for (const fileIndex of fileIndices) {
        const squareName = `${files[fileIndex]}${rank}`;
        const square = document.createElement("button");
        square.type = "button";
        square.className = `square ${(rank + fileIndex) % 2 === 1 ? "dark" : "light"}`;
        square.dataset.square = squareName;
        square.setAttribute("aria-label", squareName);
        square.setAttribute("aria-pressed", "false");
        square.tabIndex = -1; // roving: exactly one square is tabbable; see _applyRovingTabindex
        if (rank === bottomRank) {
          square.insertAdjacentHTML("beforeend", `<span class="coord coord-file">${files[fileIndex]}</span>`);
        }
        if (fileIndex === leftFile) {
          square.insertAdjacentHTML("beforeend", `<span class="coord coord-rank">${rank}</span>`);
        }
        this.board.appendChild(square);
        this.squares.set(squareName, square);
      }
    }
    this.applyCoordinates();
    this._applyRovingTabindex();
  }

  applyCoordinates() {
    this.board.classList.toggle("show-coords", pref("coordinates"));
  }

  _bindBoardEvents() {
    this.board.addEventListener("contextmenu", (event) => event.preventDefault());

    // A mouse or touch press never focuses a square: a focused square shows the
    // keyboard focus ring, and the ring would then follow later key presses.
    // The press still blurs whatever had focus (as a normal click would), so ←/→
    // step the game right after clicking the board.
    this.board.addEventListener("mousedown", (event) => {
      if (!event.target.closest(".square")) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active && active !== document.body && typeof active.blur === "function") active.blur();
    });

    this.board.addEventListener("pointerdown", (event) => {
      const square = event.target.closest(".square");
      if (!square) return;
      const squareName = square.dataset.square;
      if (event.button === 2) {
        this.annotationStart = squareName;
        return;
      }
      if (event.button !== 0) return;
      if (event.shiftKey) {
        this._toggleHighlight(squareName);
        return;
      }
      // Clicking a legal target while a piece is selected plays the move.
      if (this.selected && this.selected !== squareName) {
        const from = this.selected;
        if (isPromotionMove(from, squareName, this.legalMoves)) {
          this._setSelected(null);
          const board = this;
          resolveBoardMove({
            from,
            to: squareName,
            moves: this.legalMoves,
            board,
            play: (uci) => board.play(uci),
          });
          return;
        }
        const move = legalMoveFor(from, squareName, this.legalMoves);
        if (move) {
          this._setSelected(null);
          this.play(move);
          return;
        }
      }
      if (this.hasLegalFrom(squareName)) {
        // Pressing the already-selected piece again arms a deselect: a plain
        // click (release on the same square) clears the legal-move dots, while
        // dragging it away still plays the move.
        const wasSelected = this.selected === squareName;
        this._setSelected(squareName);
        this._beginDrag(squareName, event);
        this._deselectOnRelease = wasSelected;
      } else {
        this._setSelected(null);
      }
    });

    this.board.addEventListener("pointerup", (event) => {
      if (event.button === 2) this._finishAnnotation(event);
    });

    // Keyboard parity for the click-to-move model. The board is one Tab stop
    // (see _applyRovingTabindex):
    //   • Arrow keys are not board-local — they bubble to the app's move
    //     navigation (← → step the game) like anywhere else on the page;
    //   • typing a square name ("e4") moves focus to that square;
    //   • Enter/Space on a square selects a movable piece, then selects a legal
    //     target to play — the pointer path minus the drag.
    this.board.addEventListener("keydown", (event) => {
      const square = event.target.closest(".square");
      if (!square) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        // Swallow the default button activation so Space doesn't also scroll and
        // Enter doesn't fire a redundant synthetic click.
        event.preventDefault();
        this._typedFile = null;
        this._keyActivatedAt = Date.now();
        this._handleSquareActivation(square.dataset.square);
        return;
      }
      const pending = this._typedFile && Date.now() - this._typedAt < 1500 ? this._typedFile : null;
      const typed = typedSquare(pending, event.key);
      this._typedFile = typed.pending;
      this._typedAt = Date.now();
      if (!typed.handled) return;
      // A file letter here is part of a square name, not a page shortcut (F flips).
      event.preventDefault();
      event.stopPropagation();
      if (typed.square && this.squares.has(typed.square)) {
        this.squares.get(typed.square).focus();
        this._applyRovingTabindex(typed.square);
      }
    });

    // Assistive tech activates a square with a click and no pointer press
    // (event.detail === 0): route it through the same select/play flow.
    this.board.addEventListener("click", (event) => {
      if (event.detail !== 0 || Date.now() - (this._keyActivatedAt || 0) < 400) return;
      const square = event.target.closest(".square");
      if (square) this._handleSquareActivation(square.dataset.square);
    });
  }

  // Shared by the keyboard handler above: activate a square — play into a legal
  // target when a piece is selected, else select/deselect the square. Split out
  // so the Enter/Space flow has one home (the pointer path intentionally keeps
  // its own drag-aware flow).
  _handleSquareActivation(squareName) {
    if (this.selected && this.selected !== squareName) {
      const from = this.selected;
      if (isPromotionMove(from, squareName, this.legalMoves)) {
        this._setSelected(null);
        const board = this;
        resolveBoardMove({
          from,
          to: squareName,
          moves: this.legalMoves,
          board,
          play: (uci) => board.play(uci),
        });
        return;
      }
      const move = legalMoveFor(from, squareName, this.legalMoves);
      if (move) {
        this._setSelected(null);
        this.play(move);
        return;
      }
    }
    if (this.hasLegalFrom(squareName) && this.selected !== squareName) {
      this._setSelected(squareName);
    } else {
      this._setSelected(null);
    }
  }

  // Roving tabindex over the 64 square buttons: exactly ONE square stays in the
  // Tab order, so keyboard users don't Tab through 64 stops — typing a square
  // name moves focus inside the board instead. The tabbable square is the
  // remembered cursor (last typed square) when it still exists,
  // else the anchor on the player's home rank (e2 for White, e7 for Black —
  // the closest thing to a natural starting point on either orientation).
  // Called from _buildGrid (constructor + every orientation flip) and after
  // typed focus moves, keeping DOM focus and the tabbable square in sync.
  _applyRovingTabindex(anchor = null) {
    let tabbable = anchor || this._rovingSquare;
    if (!tabbable || !this.squares.has(tabbable)) {
      tabbable = this.orientation === "black" ? "e7" : "e2";
    }
    for (const [name, square] of this.squares) {
      square.tabIndex = name === tabbable ? 0 : -1;
    }
    this._rovingSquare = tabbable;
  }

  _beginDrag(squareName, event) {
    this._cancelDrag();
    const squareEl = this.squares.get(squareName);
    if (!squareEl || !squareEl.dataset.piece) return;
    this.dragFrom = squareName;
    const size = this.board.getBoundingClientRect().width / 8;
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.style.width = `${size}px`;
    ghost.style.height = `${size}px`;
    ghost.innerHTML = pieceSvg(squareEl.dataset.piece);
    document.body.appendChild(ghost);
    this.ghost = ghost;
    squareEl.classList.add("dragging");
    this._moveGhost(event);
    this._dragMove = (e) => {
      this._moveGhost(e);
      this._hoverTarget(e);
    };
    this._dragUp = (e) => this._endDrag(e);
    this._dragCancel = () => this._cancelDrag();
    window.addEventListener("pointermove", this._dragMove);
    window.addEventListener("pointerup", this._dragUp);
    window.addEventListener("pointercancel", this._dragCancel);
    window.addEventListener("blur", this._dragCancel);
  }

  _moveGhost(event) {
    if (!this.ghost) return;
    this.ghost.style.left = `${event.clientX}px`;
    this.ghost.style.top = `${event.clientY}px`;
  }

  _squareAt(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    const square = el ? el.closest(".square") : null;
    return square && this.board.contains(square) ? square.dataset.square : null;
  }

  _hoverTarget(event) {
    const name = this._squareAt(event);
    this.squares.forEach((square, squareName) => {
      square.classList.toggle(
        "drag-over",
        Boolean(name) && squareName === name && squareName !== this.dragFrom
      );
    });
  }

  _endDrag(event) {
    const from = this.dragFrom;
    const deselect = this._deselectOnRelease;
    this._deselectOnRelease = false;
    this._cancelDrag();
    if (!from) return;
    const target = this._squareAt(event);
    // Same-square release is treated as a click: the piece stays selected so a
    // follow-up click on a target square plays the move — unless it was already
    // selected, in which case the second click toggles the selection off.
    if (target === from && deselect) {
      this._setSelected(null);
      return;
    }
    if (!target || target === from) return;
    if (isPromotionMove(from, target, this.legalMoves)) {
      this._setSelected(null);
      const board = this;
      const moves = this.legalMoves;
      resolveBoardMove({
        from,
        to: target,
        moves,
        board,
        play: (uci) => board.play(uci),
      });
      return;
    }
    const move = legalMoveFor(from, target, this.legalMoves);
    if (move) {
      this._setSelected(null);
      this.play(move);
    }
  }

  _cancelDrag() {
    if (this._dragMove) window.removeEventListener("pointermove", this._dragMove);
    if (this._dragUp) window.removeEventListener("pointerup", this._dragUp);
    if (this._dragCancel) {
      window.removeEventListener("pointercancel", this._dragCancel);
      window.removeEventListener("blur", this._dragCancel);
    }
    this._dragMove = null;
    this._dragUp = null;
    this._dragCancel = null;
    this.dragFrom = null;
    if (this.ghost) {
      this.ghost.remove();
      this.ghost = null;
    }
    this.squares.forEach((square) => square.classList.remove("dragging", "drag-over"));
  }

  _finishAnnotation(event) {
    if (!this.annotationStart) return;
    const start = this.annotationStart;
    this.annotationStart = null;
    const endEl = document.elementFromPoint(event.clientX, event.clientY);
    const endSquareEl = endEl ? endEl.closest(".square") : null;
    if (!endSquareEl || !this.board.contains(endSquareEl)) return;
    const end = endSquareEl.dataset.square;
    if (start === end) {
      this._toggleHighlight(start);
      return;
    }
    const arrow = `${start}${end}`;
    if (this.arrows.includes(arrow)) {
      this.arrows = this.arrows.filter((item) => item !== arrow);
    } else {
      this.arrows.push(arrow);
    }
    this._renderArrows();
    this._notifyAnnotate();
  }

  setAnnotations(arrows, circles) {
    this.arrows = Array.isArray(arrows) ? arrows.slice() : [];
    this.highlights = new Set(Array.isArray(circles) ? circles : []);
    this._updateClasses();
    this._renderArrows();
  }

  _notifyAnnotate() {
    if (this.onAnnotate) this.onAnnotate(this.arrows.slice(), [...this.highlights]);
  }

  setPosition({ fen, legalMoves = [], lastMove = null }) {
    // A real position arriving mid-preview ends the preview (see beginPreview).
    if (this._preview && !this._renderingPreview) this.endPreview({ restore: false });
    const fenChanged = this.fen !== fen;
    const prevFen = this.fen;
    // A same-position refresh (an autosave landing, a panel re-render) must not
    // yank a piece out of the user's hand: keep the drag and selection alive
    // while the dragged/selected piece still has legal moves.
    const keepInteraction =
      !fenChanged &&
      (this.dragFrom || this.selected) &&
      legalMoves.some((move) => move.startsWith(this.dragFrom || this.selected));
    if (!keepInteraction) this._cancelDrag();

    // Read slide offsets NOW, before any DOM writes, so _animateSlide never
    // triggers a mid-write forced reflow to measure layout.
    let preSlide = null;
    if (fenChanged && this._hadPosition && lastMove && pref("moveAnim")) {
      const from = lastMove.slice(0, 2);
      const to = lastMove.slice(2, 4);
      const fromSq = this.squares.get(from);
      const toSq = this.squares.get(to);
      if (fromSq && toSq) {
        preSlide = { dx: fromSq.offsetLeft - toSq.offsetLeft, dy: fromSq.offsetTop - toSq.offsetTop, to };
      }
    }

    this.fen = fen;
    this.legalMoves = legalMoves;
    if (!keepInteraction) {
      this.selected = null;
      this.dragFrom = null;
    }
    // A same-position refresh keeps the badge, so it doesn't pop in again.
    if (fenChanged || this.lastMove !== lastMove) this.moveBadge = null;
    this.lastMove = lastMove;
    this.annotationStart = null;
    if (fenChanged) {
      this._renderPieces();
      if (this._hadPosition && lastMove) {
        this._feedbackForMove(prevFen, fen, lastMove, preSlide);
      }
    }
    this._hadPosition = true;
    this._updateClasses();
    this._renderArrows();
  }

  setMoveBadge(squareName, classification, label) {
    if (this._preview) return;
    if (!squareName) {
      this.moveBadge = null;
    } else {
      this.moveBadge = {
        square: squareName,
        classification: String(classification || "unknown").toLowerCase(),
        label: label || classification || "",
      };
    }
    this._syncMoveBadge();
  }

  // Slide the moved piece in, pulse the destination, and chirp a sound, all
  // driven off the final rendered position so a quick "skip" never leaves anything stranded.
  // preSlide is pre-computed {dx, dy, to} read before DOM writes to avoid forced reflow.
  _feedbackForMove(prevFen, fen, lastMove, preSlide) {
    const to = lastMove.slice(2, 4);
    const wasCapture = (() => {
      try {
        const before = parseFenBoard(prevFen);
        const after = parseFenBoard(fen);
        return Object.keys(before).length > Object.keys(after).length;
      } catch (_) {
        return false;
      }
    })();
    playSound(wasCapture ? "capture" : "move");
    if (pref("moveAnim") && preSlide) this._animateSlide(preSlide);
    if (pref("lastMovePulse")) this._pulseSquare(to);
  }

  // preSlide = { dx, dy, to } — offsets already read before DOM writes.
  _animateSlide({ dx, dy, to }) {
    const toSq = this.squares.get(to);
    if (!toSq) return;
    const piece = toSq.querySelector(".piece");
    if (!piece) return;
    piece.style.transition = "none";
    piece.style.transform = `translate(${dx}px, ${dy}px)`;
    void piece.offsetWidth; // one reflow to commit the start state before transitioning
    piece.style.transition = "transform 170ms ease-out";
    piece.style.transform = "translate(0, 0)";
    window.setTimeout(() => {
      piece.style.transition = "";
      piece.style.transform = "";
    }, 200);
  }

  _pulseSquare(square) {
    const el = this.squares.get(square);
    if (!el) return;
    el.classList.remove("move-pulse");
    // rAF lets the removal commit to a frame before re-adding, avoiding forced reflow.
    requestAnimationFrame(() => {
      el.classList.add("move-pulse");
      window.setTimeout(() => el.classList.remove("move-pulse"), 500);
    });
  }

  clearMarkers() {
    this.highlights.clear();
    this.arrows = [];
    this._updateClasses();
    this._renderArrows();
  }

  _renderPieces() {
    const pieces = parseFenBoard(this.fen);
    this.squares.forEach((square, squareName) => {
      const piece = pieces[squareName];
      const desired = piece ? piece : "";
      if (square.dataset.piece === desired) return;
      square.dataset.piece = desired;
      // Keep the accessible name in lockstep with the rendered piece so
      // keyboard users hear what is on the square, not just its coordinates.
      square.setAttribute("aria-label", piece ? `${pieceLabel(piece)} ${squareName}` : squareName);
      // Swap only the piece element so coordinate labels survive.
      const existing = square.querySelector(".piece");
      if (existing) existing.remove();
      if (piece) square.insertAdjacentHTML("beforeend", pieceSvg(piece));
    });
  }

  // Force every piece to re-render with the current style (dataset cache busts
  // the no-op check in _renderPieces).
  redrawPieces() {
    this.squares.forEach((square) => {
      square.dataset.piece = "";
      const existing = square.querySelector(".piece");
      if (existing) existing.remove();
    });
    if (this.fen) this._renderPieces();
  }

  _updateClasses() {
    const legalTargets = new Set(
      this.selected ? legalTargetsFrom(this.selected, this.legalMoves) : []
    );
    this.squares.forEach((square, squareName) => {
      square.classList.toggle("selected", this.selected === squareName);
      square.classList.toggle("legal", legalTargets.has(squareName));
      square.classList.toggle("highlighted", this.highlights.has(squareName));
      // Keyboard selection state must be visible to assistive tech too: the
      // Enter/Space pick-and-move flow toggles .selected, so mirror it as
      // aria-pressed on the square button.
      square.setAttribute("aria-pressed", String(this.selected === squareName));
    });
    // Update last-move only on the squares that actually changed (prev vs next).
    const next = this.lastMove
      ? [this.lastMove.slice(0, 2), this.lastMove.slice(2, 4)]
      : [];
    const prev = this._lastMoveSqs || [];
    const toUpdate = new Set([...prev, ...next]);
    const nextSet = new Set(next);
    toUpdate.forEach((sq) => {
      const el = this.squares.get(sq);
      if (el) el.classList.toggle("last-move", nextSet.has(sq));
    });
    this._lastMoveSqs = next;
    this._syncMoveBadge();
  }

  _syncMoveBadge() {
    // Selecting a piece re-syncs classes: an unchanged badge stays put rather than being
    // re-inserted, which would replay its entrance animation.
    const key = this.moveBadge ? `${this.moveBadge.square}|${this.moveBadge.classification}|${this.moveBadge.label}` : "";
    if (
      key && key === this._badgeKey &&
      this._badgeEl === this.squares.get(this.moveBadge.square) &&
      this._badgeEl.querySelector(".square-badge")
    ) return;
    this._badgeKey = key;
    // Clear previous badge from exactly the one tracked square (not a 64-square scan).
    if (this._badgeEl) {
      const existing = this._badgeEl.querySelector(".square-badge");
      if (existing) existing.remove();
      this._badgeEl = null;
    }
    // The last-move squares take the grade's colour (styles.css), so the tint and the
    // badge read as one mark.
    if (this.board) delete this.board.dataset.moveClass;
    if (!this.moveBadge) return;
    const square = this.squares.get(this.moveBadge.square);
    if (!square) return;
    this._badgeEl = square;
    const cls = this.moveBadge.classification.replace(/[^a-z0-9_-]/g, "");
    if (this.board) this.board.dataset.moveClass = cls;
    const label = escapeHtml(this.moveBadge.label);
    square.insertAdjacentHTML(
      "beforeend",
      `<span class="square-badge class-${cls}">${label}</span>`
    );
  }

  _setSelected(squareName) {
    if (this.selected === squareName) return;
    this.selected = squareName;
    this._updateClasses();
  }

  _toggleHighlight(squareName) {
    if (this.highlights.has(squareName)) this.highlights.delete(squareName);
    else this.highlights.add(squareName);
    this._updateClasses();
    this._notifyAnnotate();
  }

  hasLegalFrom(squareName) {
    return this.legalMoves.some((move) => move.startsWith(squareName));
  }

  play(moveUci) {
    if (this.onMove) this.onMove(moveUci, this.fen);
  }
}

// Engine-loading lifecycle marks (dev/E2E timing only): records monotonic
// timestamps per (job) so the parallel init windows — Build runner import vs
// Maia ready, Analyze Stockfish vs Maia init — are observable without touching
// any engine result. No-op payload, never awaited by the pipeline.
const engineLifecycleMarks = new Map();
function engineLifecycleMark(name, origin = performance.now()) {
  const at = Math.round(performance.now() - origin);
  if (!engineLifecycleMarks.has(name)) engineLifecycleMarks.set(name, []);
  engineLifecycleMarks.get(name).push(at);
  try {
    console.debug("[engine-lifecycle]", name, `${at}ms`);
  } catch (_) { /* logging only */ }
  return origin;
}
const STATUS_PROGRESS_SHOW_DELAY = 700;

// True while a 401 is being turned into the sign-in modal, so the modal's own
// fallback warning can't loop back through here.
let routingAuthStatus = false;

function setStatus(message, { severity = "info" } = {}) {
  const status = document.getElementById("app-status");
  if (!status) return;
  const closeBtn = document.getElementById("app-status-close");
  const text = String(message || "");
  // A guest (or expired session) hit an account-only endpoint: the sign-in
  // modal with an explanation replaces the backend's "not authenticated".
  if (!routingAuthStatus && accountController && isAuthRequiredMessage(text)) {
    routingAuthStatus = true;
    try {
      accountController.handleAuthRequired();
    } finally {
      routingAuthStatus = false;
    }
    return;
  }
  const slot = document.getElementById("topbar-status-slot");
  status.textContent = text;
  status.title = text;
  // The floating status pill only shows messages set after load (not the
  // static "Ready" placeholder); it hides again when the text clears.
  // "Ready" is the idle state, not news: it clears the pill instead.
  const normalizedSeverity = ["info", "success", "warning", "error"].includes(severity)
    ? severity
    : "info";
  const isError = normalizedSeverity === "error";
  // In-progress messages ("Loading...") usually resolve within a moment; only
  // surface one if it is still the current message after a beat, so quick
  // steps never flash a pill in the corner.
  const inProgress = !isError && /(\.\.\.|…)$/.test(text);
  if (typeof window !== "undefined") window.clearTimeout(setStatus._showTimer);
  const showNow = !!text && text !== "Ready" && !inProgress;
  status.classList.toggle("is-fresh", showNow);
  if (slot) slot.classList.toggle("is-idle", !showNow);
  // Error pills are dropped on navigation (clearStaleStatusOnNavigate); note
  // when this one was raised so an error set by the navigation itself stays.
  setStatus._errorAt = isError && text ? Date.now() : 0;
  if (inProgress && typeof window !== "undefined") {
    setStatus._showTimer = window.setTimeout(() => {
      if (status.textContent === text) {
        status.classList.add("is-fresh");
        if (slot) slot.classList.remove("is-idle");
      }
    }, STATUS_PROGRESS_SHOW_DELAY);
  }
  status.setAttribute("role", isError ? "alert" : "status");
  status.setAttribute("aria-live", isError ? "assertive" : "polite");
  status.dataset.severity = normalizedSeverity;
  status.dataset.state = isError ? "error" : "ready";
  if (typeof window === "undefined") return;
  window.clearTimeout(setStatus._timer);
  if (closeBtn) closeBtn.hidden = !isError || !text;
  if (text && !isError) {
    setStatus._timer = window.setTimeout(() => {
      if (status.textContent !== text) return;
      clearStatus();
    }, normalizedSeverity === "warning" ? 6000 : 4000);
  }
}

// Empty the floating status pill and hide its slot (no leftover empty pill).
function clearStatus() {
  const status = document.getElementById("app-status");
  if (typeof window !== "undefined") {
    window.clearTimeout(setStatus._timer);
    window.clearTimeout(setStatus._showTimer);
  }
  setStatus._errorAt = 0;
  if (status) {
    status.textContent = "";
    status.title = "";
    status.classList.remove("is-fresh");
    status.dataset.severity = "info";
    status.dataset.state = "ready";
  }
  document.getElementById("topbar-status-slot")?.classList.add("is-idle");
  const closeBtn = document.getElementById("app-status-close");
  if (closeBtn) closeBtn.hidden = true;
}

// An error belongs to the page it happened on: leaving that page drops it,
// unless it was raised a moment ago by the very action that is navigating.
const STATUS_ERROR_NAV_GRACE_MS = 400;
function clearStaleStatusOnNavigate() {
  const status = document.getElementById("app-status");
  if (!status || status.dataset.state !== "error") return;
  if (shouldClearStatusOnNavigate(setStatus._errorAt, Date.now(), STATUS_ERROR_NAV_GRACE_MS)) clearStatus();
}

// Keep the floating status pill out of the way: it rides above the job-toast
// stack (never on top of it), is click-through unless it holds an error, and
// fades to a ghost while the pointer is over its spot — so a message never
// blocks the button underneath it.
function bindStatusPillAvoidance() {
  const slot = document.getElementById("topbar-status-slot");
  const stack = document.getElementById("toast-stack");
  if (!slot || typeof window === "undefined") return;
  if (stack && typeof ResizeObserver === "function") {
    const sync = () => {
      const h = stack.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--toast-stack-h", `${Math.round(h)}px`);
    };
    new ResizeObserver(sync).observe(stack);
    sync();
  }
  let frame = 0;
  let last = null;
  const evaluate = () => {
    frame = 0;
    if (!last) return;
    const status = document.getElementById("app-status");
    const isError = status && status.dataset.state === "error";
    const r = slot.getBoundingClientRect();
    const pad = 18;
    const near =
      !isError &&
      r.width > 0 &&
      last.x >= r.left - pad &&
      last.x <= r.right + pad &&
      last.y >= r.top - pad &&
      last.y <= r.bottom + pad;
    slot.classList.toggle("is-ghost", near);
  };
  document.addEventListener(
    "pointermove",
    (event) => {
      last = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(evaluate);
    },
    { passive: true }
  );
}

function setStatusError(message) {
  setStatus(message, { severity: "error" });
}

const getCsrfToken = createCsrfTokenSource();

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const { timeoutMs = method === "GET" ? 30_000 : 90_000, signal: callerSignal, responseType = "json", ...fetchOptions } = options;
  return withRequestDeadline(async (signal) => {
  // Merge caller headers over the JSON default, then attach the CSRF token on
  // unsafe methods (bootstrapping /api/csrf if the cookie isn't set yet). The
  // FastAPI backend 403s any unsafe request that doesn't echo the cookie.
  const headers = await headersWithCsrf(
    method,
    { "Content-Type": "application/json", ...(options.headers || {}) },
    getCsrfToken,
  );
  signal.throwIfAborted();
  const response = await fetch(path, {
    credentials: "same-origin",
    ...fetchOptions,
    signal,
    headers,
  });
  if (response.ok && responseType === "blob") return response.blob();
  // Read as text first so a non-JSON body (a 500 "Internal Server Error", a 502
  // from the proxy, an HTML error page) surfaces a clear message instead of a raw
  // "Unexpected token 'I' ... is not valid JSON" from response.json().
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      if (!response.ok) {
        const err = new Error(`Server error ${response.status} ${response.statusText}`.trim());
        err.status = response.status;
        throw err;
      }
      throw new Error("Unexpected non-JSON response from server");
    }
  }
  // Keep structured FastAPI detail for conflict recovery and flatten it for display.
  if (!response.ok) {
    const detail = payload.detail;
    // A session 401 reads as an explanation, not the backend's "not
    // authenticated"; setStatus turns it into the sign-in modal.
    const authRequired = isSessionAuthFailure(response.status, detail);
    const message = authRequired
      ? AUTH_REQUIRED_MESSAGE
      : apiErrorMessage(response.status, detail);
    const err = new Error(message);
    err.status = response.status; // lets callers (e.g. Build sync) tell 4xx from 5xx/network
    err.detail = detail;
    if (authRequired) err.authRequired = true;
    if (response.headers && typeof response.headers.get === "function") {
      err.retryAfter = response.headers.get("retry-after");
    }
    throw err;
  }
  return payload;
  }, { signal: callerSignal, timeoutMs, method });
}

// ----- Durable outbox (R-03) -----------------------------------------------
// Queued Build/Train edits persist to localStorage per OWNER, so a refresh,
// crash, or sign-out can't silently drop work the user already did. Operation
// identity survives (Build temp ids, Train attempt UUIDs) — replays after a
// lost response are recognized server-side instead of double-counted.
const OUTBOX_TAB_ID = Math.random().toString(36).slice(2);

function currentOwnerId() {
  return appState.accountUserId || null;
}

function outboxSnapshot() {
  return {
    build: {
      pending: appState.buildPending,
      pendingDeletes: appState.buildPendingDeletes,
      idMap: appState.buildIdMap,
      rejected: appState.buildRejected || [],
    },
    train: {
      pending: appState.trainSync.pending,
      rejected: appState.trainRejected || [],
    },
  };
}

// R-03/R-04: the durable copy MERGES with whatever is already stored per
// operation, so a second tab holding an older view can no longer overwrite
// ops it never saw. `settled` tombstones the operations the server just
// confirmed, so a stale snapshot can't resurrect already-saved work either.
async function persistOutbox(settled = null) {
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  let ok = false;
  try { await saveDurableOutbox(owner, outboxSnapshot(), settled); ok = true; }
  catch (error) { console.warn("Outbox persistence failed", error); }
  if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) return ok;
  // A refused write means the queue lives only in this tab: the UI must not
  // promise device recovery it cannot deliver.
  appState.outboxPersisted = ok;
  if (!ok && !appState.outboxStorageWarned) {
    appState.outboxStorageWarned = true;
    setStatus(
      "This browser is not letting us store your unsynced edits — they stay in this tab only. Don't close it.",
      { severity: "warning" },
    );
  }
  return ok;
}

// R-01: a feature finishing its own queue must never wipe the OTHER feature's
// unsynced work (nor the rejected ops kept for review). Only a state with
// nothing left for anyone may drop the owner's key.
async function clearOutboxWhenQuiescent() {
  const owner = currentOwnerId();
  if (!outboxIsQuiescent(await loadDurableOutbox(owner))) {
    await persistOutbox();
    return false;
  }
  await clearDurableOutbox(owner);
  return owner === currentOwnerId();
}

// Re-hydrate THIS owner's queued edits after a reload. Owner-scoped on
// purpose: signing in as someone else never replays another account's ops.
async function restoreOutbox() {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const outbox = await loadDurableOutbox(owner);
  if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) return null;
  const rejectedCount =
    (outbox.build.rejected || []).length + (outbox.train.rejected || []).length;
  if (!outboxHasWork(outbox) && !rejectedCount) return null;
  appState.buildPending = outbox.build.pending.concat(appState.buildPending);
  appState.buildPendingDeletes = outbox.build.pendingDeletes.concat(
    appState.buildPendingDeletes,
  );
  Object.assign(appState.buildIdMap, outbox.build.idMap);
  // R-03: rejected ops are user work too — without this they silently vanish
  // on reload (the sync chip would read "saved" with nothing left to review).
  appState.buildRejected = (outbox.build.rejected || []).concat(appState.buildRejected || []);
  appState.trainRejected = (outbox.train.rejected || []).concat(appState.trainRejected || []);
  appState.trainSync.pending = outbox.train.pending.concat(appState.trainSync.pending);
  if (appState.trainSync.pending.length) {
    appState.trainSync.dirty = true;
    setTrainSyncState("dirty");
    scheduleTrainSync();
  }
  return {
    build: appState.buildPending.length + appState.buildPendingDeletes.length,
    train: appState.trainSync.pending.length,
    rejected: rejectedCount,
  };
}

// R-03: sign-out coordination. Persist the durable outbox FIRST (it survives
// even if the flush can't run), then flush both queues while the session can
// still authenticate. Reports how much work could not be saved — those drafts
// stay in this owner's outbox and replay after the next sign-in, never to
// another account.
async function flushAllPendingForSignOut() {
  await persistOutbox();
  clearTimeout(appState.buildFlushTimer);
  appState.buildFlushTimer = null;
  clearTimeout(appState.trainSync.timer);
  appState.trainSync.timer = null;
  await Promise.all([
    flushBuildMoves().catch(() => false),
    flushTrainSync().catch(() => false),
  ]);
  await persistOutbox();
  return {
    pending:
      appState.buildPending.length +
      appState.buildPendingDeletes.length +
      appState.trainSync.pending.length,
  };
}

async function postJson(path, body, options = {}) {
  const build = appState.build;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const requestBody = withBuildRevision(path, body, build);
  const before = build?.revision;
  const mutation = requestBody?.base_revision !== undefined;
  const previous = mutation ? appState.buildMutationSaving : null;
  const task = (async () => {
    if (previous) await previous.catch(() => {});
    if (owner !== currentOwnerId() || generation !== appState.ownerGeneration) throw new Error("Account changed");
    // A queued request may follow our own acknowledged write. Preserve older
    // conflict bases; rebase only the revision current when this call was made.
    if (mutation && build === appState.build && requestBody.repertoire_id === build?.repertoire_id && requestBody.base_revision === before) {
      requestBody.base_revision = build.revision;
    }
    const payload = await api(path, { method: "POST", body: JSON.stringify(requestBody || {}), ...options });
    if (mutation && requestBody.repertoire_id === build?.repertoire_id && appState.build === build && owner === currentOwnerId() && generation === appState.ownerGeneration) {
      advanceBuildRevision(build, payload, [...appState.buildPending, ...appState.buildPendingDeletes]);
    }
    return payload;
  })();
  if (mutation) appState.buildMutationSaving = task;
  try { return await task; }
  finally { if (appState.buildMutationSaving === task) appState.buildMutationSaving = null; }
}

function downloadText(filename, mime, content) {
  const blob = new Blob([content], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "prepforge-export.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readSelectedFile(input) {
  return new Promise((resolve, reject) => {
    const file = input.files && input.files[0];
    if (!file) {
      reject(new Error("Choose a repertoire package first"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsText(file);
  });
}

function activeViewName() {
  const el = document.querySelector(".view.is-active");
  return el ? el.id.replace("view-", "") : "analyze";
}

function activeBoardController() {
  const name = activeViewName();
  if (name === "analyze") return boards.analysis || null;
  return boards[name] || null;
}

let workspaceUrlReady = false;
let workspaceNavigationSeq = 0;
// Set when the user picks a page while boot is still awaiting auth / the
// workspace: restoreWorkspaceLocation must not then snap them back to the URL
// the page loaded with (a Scout click during boot landed on the dashboard).
let navigatedDuringBoot = false;
let paletteItems = [];
let paletteActive = 0;
let paletteA11yCleanup = null;

function activateModal(overlay, { initialFocus = null, additionalRoots = [] } = {}) {
  const previouslyFocused = document.activeElement;
  const background = [...document.body.children].filter(
    (child) => child !== overlay && !additionalRoots.includes(child) && !child.inert,
  );
  for (const child of background) child.inert = true;

  const dialog = overlay.matches('[role="dialog"]')
    ? overlay
    : overlay.querySelector('[role="dialog"]');
  if (dialog && !dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) {
    const title = dialog.querySelector(".modal-title");
    if (title) {
      title.id ||= `modal-title-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      dialog.setAttribute("aria-labelledby", title.id);
    }
  }

  const focusable = () => [overlay, ...additionalRoots].flatMap((root) => [...root.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )]).filter((el) => !el.hidden && el.getClientRects().length > 0);
  const onKeyDown = (event) => {
    if (event.key !== "Tab") return;
    const items = focusable();
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const keyTarget = additionalRoots.length ? document : overlay;
  keyTarget.addEventListener("keydown", onKeyDown);
  queueMicrotask(() => (initialFocus || focusable()[0] || dialog || overlay).focus?.());

  let cleaned = false;
  const cleanup = ({ restoreFocus = true } = {}) => {
    if (cleaned) return;
    cleaned = true;
    keyTarget.removeEventListener("keydown", onKeyDown);
    for (const child of background) child.inert = false;
    overlay.remove = nativeRemove;
    if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus();
  };
  const nativeRemove = overlay.remove.bind(overlay);
  overlay.remove = () => {
    cleanup();
    nativeRemove();
  };
  return cleanup;
}

function syncWorkspaceUrl({ push = false } = {}) {
  if (!workspaceUrlReady || typeof window === "undefined") return;
  const loc = workspaceLocationFromState(appState);
  const href = serializeWorkspaceLocation(loc, window.location.href);
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current === href) return;
  if (push) history.pushState(loc, "", href);
  else history.replaceState(loc, "", href);
}

function paintEngineBanners() {
  const model = engineUnavailableBanner({
    available: isBrowserEngineAvailable(),
    isolated: !!self.crossOriginIsolated,
  });
  const html = engineBannerHtml(model, { escapeHtml });
  for (const id of ["analyze-engine-banner", "build-engine-banner"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.hidden = !model.visible;
    el.innerHTML = html;
  }
}

function paletteIsOpen() {
  const el = document.getElementById("command-palette");
  return !!(el && !el.hidden);
}

function closePalette() {
  const el = document.getElementById("command-palette");
  if (el) {
    el.hidden = true;
    document.getElementById("palette-input")?.setAttribute("aria-expanded", "false");
  }
  if (paletteA11yCleanup) paletteA11yCleanup();
  paletteA11yCleanup = null;
}

function paintPalette() {
  const box = document.getElementById("palette-results");
  if (!box) return;
  box.innerHTML = renderPaletteItems(paletteItems, paletteActive);
  const input = document.getElementById("palette-input");
  const active = box.querySelector('[aria-selected="true"]');
  if (input) {
    if (active) input.setAttribute("aria-activedescendant", active.id);
    else input.removeAttribute("aria-activedescendant");
  }
}

async function openPalette() {
  const el = document.getElementById("command-palette");
  if (!el) return;
  let repertoires = appState.repertoireList || [];
  if (appState.signedIn) {
    try {
      const payload = await api("/api/repertoires");
      repertoires = payload.repertoires || [];
      appState.repertoireList = repertoires;
    } catch (_) {
      /* keep the last cached list */
    }
  }
  paletteItems = filterPaletteItems(buildPaletteItems({ repertoires }), "");
  paletteActive = 0;
  el.hidden = false;
  const input = document.getElementById("palette-input");
  if (input) {
    input.value = "";
    input.setAttribute("aria-expanded", "true");
  }
  paintPalette();
  paletteA11yCleanup = activateModal(el, { initialFocus: input });
}

function dismissTransientOverlays() {
  // Tab/command-palette navigation always wins over transient overlays: the
  // overlay click / Escape paths share this teardown so no orphaned keydown
  // listener survives a navigation-driven dismissal.
  const overlay = document.querySelector(".modal-overlay.auth-overlay");
  if (overlay) {
    if (typeof overlay._closeAuthModal === "function") overlay._closeAuthModal();
    else overlay.remove();
  }
  if (paletteIsOpen()) closePalette();
}

async function runPaletteItem(item) {
  closePalette();
  if (!item) return;
  if (item.kind === "view") {
    dismissTransientOverlays();
    switchView(item.view);
    if (item.section) setReplaySection(item.section);
    if (item.view === "settings") loadSettings();
    return;
  }
  if (item.kind === "repertoire" && item.repertoireId) {
    editRepertoire(item.repertoireId);
    return;
  }
  if (item.action === "new-repertoire") {
    createRepertoirePrompt();
    return;
  }
  if (item.action === "start-training") {
    switchView("train");
    // A guest gets the sign-in gate only; a live game on the board stays as it is.
    if (!appState.signedIn) {
      requireSignIn("Sign in to start training", "train");
      return;
    }
    const livePlay = appState.play && appState.play.active && (appState.play.history || []).length > 0;
    if (livePlay) {
      const ok = await showConfirmModal({
        title: "Leave this game?",
        body: "The current game will be abandoned.",
        okLabel: "Start training",
        cancelLabel: "Keep playing",
      });
      if (!ok) return;
    }
    if (appState.trainMode === "play") goToSmartTraining();
    else startTraining();
    return;
  }
  if (item.action === "play-human") {
    switchView("train");
    const playBtn = document.querySelector('#train-modes .train-mode[data-mode="play"]');
    if (playBtn) playBtn.click();
    document.getElementById("start-play")?.click();
    return;
  }
  if (item.action === "feeling-lucky") {
    dismissTransientOverlays();
    switchView("train");
    const playBtn = document.querySelector('#train-modes .train-mode[data-mode="play"]');
    if (playBtn) playBtn.click();
    onFeelingLucky();
    return;
  }
  if (item.action === "analyze") {
    switchView("analyze");
    return;
  }
  if (item.action === "toggle-theme") toggleTheme();
}

function bindCommandPalette() {
  const root = document.getElementById("command-palette");
  const input = document.getElementById("palette-input");
  const results = document.getElementById("palette-results");
  const opener = document.getElementById("open-palette");
  if (opener) opener.addEventListener("click", () => openPalette());
  if (root) {
    root.addEventListener("click", (event) => {
      if (event.target === root) closePalette();
    });
  }
  if (input) {
    input.addEventListener("input", () => {
      paletteItems = filterPaletteItems(
        buildPaletteItems({ repertoires: appState.repertoireList || [] }),
        input.value,
      );
      paletteActive = 0;
      paintPalette();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        paletteActive = Math.min(paletteItems.length - 1, paletteActive + 1);
        paintPalette();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        paletteActive = Math.max(0, paletteActive - 1);
        paintPalette();
      } else if (event.key === "Enter") {
        event.preventDefault();
        // The item may open a dialog with its own document keydown handler
        // (sign-in submits on Enter); this keystroke must not reach it.
        event.stopPropagation();
        runPaletteItem(paletteItems[paletteActive]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      }
    });
  }
  if (results) {
    results.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-index]");
      if (!btn) return;
      runPaletteItem(paletteItems[Number(btn.dataset.index)]);
    });
  }
}

async function restoreWorkspaceLocation() {
  if (navigatedDuringBoot) {
    // The user already moved on: stay there, re-entering the page so it loads
    // with the now-known session (it may have painted signed-out mid-boot),
    // and record it in the URL.
    switchView(appState.currentView);
    syncWorkspaceUrl();
    if (appState.currentView === "train" && appState.signedIn) {
      await startTraining(appState.trainMode, { fresh: false });
    }
    return;
  }
  const loc = parseWorkspaceLocation(window.location.href);
  const seq = workspaceNavigationSeq;
  // F-06 return state: coming back to Games (even after a reload) restores the
  // selected game and the active filter, so the source page is where you left it.
  const replayReturn = loadReturnState("replay");
  if (replayReturn) {
    if (typeof replayReturn.filter === "string" && replayReturn.filter) {
      appState.replayFilter = replayReturn.filter;
    }
    if (Number.isFinite(replayReturn.openIndex)) {
      appState.replayOpen = new Set([replayReturn.openIndex]);
    }
  }
  if (loc.repertoireId && appState.signedIn) {
    try {
      const payload = await api(
        `/api/build/load?repertoire_id=${encodeURIComponent(loc.repertoireId)}`,
      );
      if (seq === workspaceNavigationSeq) {
        await hydrateBuild(payload, payload.selected_node_id);
        if (seq === workspaceNavigationSeq) appState.trainingRepertoireId = payload.repertoire_id;
      }
    } catch (_) {
      /* stale id — still restore the view */
    }
  }
  if (seq !== workspaceNavigationSeq) {
    syncWorkspaceUrl();
    return;
  }
  if (loc.view === "replay" && loc.replaySection) {
    appState.replaySection = loc.replaySection;
  }
  switchView(loc.view, { fromUrl: true });
  if (loc.view === "analyze" && loc.ply && appState.analysis) {
    await showAnalysisPly(loc.ply);
  }
  if (loc.view === "train" && appState.signedIn) {
    await startTraining(appState.trainMode, { fresh: false });
  }
}

function setReplaySection(section, { focus = false, syncUrl = true } = {}) {
  const next = section === "scout" ? "scout" : "games";
  // Games ↔ Scout is a page change for the user even though both live in the
  // replay view: an error from one must not follow them to the other.
  if (appState.replaySection && appState.replaySection !== next) clearStaleStatusOnNavigate();
  appState.replaySection = next;
  document.querySelectorAll("[data-replay-panel]").forEach((panel) => {
    const active = panel.dataset.replayPanel === next;
    panel.hidden = !active;
    panel.setAttribute("aria-hidden", String(!active));
  });
  document.querySelectorAll(".tab[data-replay-section]").forEach((button) => {
    const active = button.dataset.replaySection === next;
    button.classList.toggle("is-active", active && appState.currentView === "replay");
    button.setAttribute("aria-current", active && appState.currentView === "replay" ? "page" : "false");
  });
  syncPageTitle();
  // Scout is a section of Replay, and its view chunk carries its own stylesheet
  // (views/scout.css). Load it as soon as the section is shown so the pre-Start
  // panel is styled by the same rules as every other state, rather than rendering
  // on the eager sheet alone until the first click pulls the chunk in.
  if (next === "scout") preloadScoutUi().catch(() => {});
  if (focus) {
    document.querySelector(`[data-replay-panel="${next}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // The replay section is part of the deep link (#/games vs #/scout). Sync it
  // on every section change — plain pushState, not a navigation — so refresh
  // and back/forward restore the right panel without a reload loop.
  if (syncUrl && appState.currentView === "replay") syncWorkspaceUrl({ push: true });
}

// Top-bar title follows the primary navigation (prototype IA labels). The
// replay view is titled by its active section (Games vs Scout).
const VIEW_TITLES = {
  dashboard: "Library",
  build: "Repertoire",
  analyze: "Analyze",
  train: "Train",
  replay: "Games",
  teams: "Teams",
  settings: "Settings",
};

// No visible page title (the active nav item names the page): the document
// title carries it for tabs, history and screen readers.
function syncPageTitle() {
  const page = appState.currentView === "replay"
    ? (appState.replaySection === "scout" ? "Scout" : "Games")
    : VIEW_TITLES[appState.currentView] || "";
  document.title = page ? `${page} · PrepForge Chess` : "PrepForge Chess";
  syncViewHeads();
}

// Analyze head: the loaded game's identity (PGN headers, else the recalled
// analysis) in the panel head.
function analyzeHeaderTags(pgnText) {
  const tags = {};
  const re = /^\s*\[(\w+)\s+"([^"]*)"\]\s*$/gm;
  let match;
  while ((match = re.exec(pgnText)) !== null) tags[match[1]] = match[2];
  return tags;
}

function syncAnalyzeHead() {
  const title = document.getElementById("analysis-game-title");
  const meta = document.getElementById("analysis-game-meta");
  if (!title || !meta) return;
  const analysis = appState.analysis;
  // Only name a game the board actually shows: the prefilled demo PGN sitting unloaded in
  // the source box must not title an empty board "PrepForge vs Demo".
  const loaded = !!(analysis && ((analysis.moves && analysis.moves.length) || analysis.initialFen));
  const tags = loaded ? analyzeHeaderTags(document.getElementById("pgn-input")?.value || "") : {};
  const known = (v) => (v && !/^[?*.\s]+$/.test(v) ? v : "");
  const white = known(tags.White) || known(analysis?.white);
  const black = known(tags.Black) || known(analysis?.black);
  const plies = analysis?.moves?.length || 0;
  title.textContent = white || black ? `${white || "?"} vs ${black || "?"}` : "Analysis board";
  const bits = [known(tags.Result) || known(analysis?.result), known(tags.Event) || known(analysis?.event), known(tags.Date)]
    .filter(Boolean);
  meta.textContent = bits.length
    ? bits.join(" · ")
    : plies
      ? `${plies} half-move${plies === 1 ? "" : "s"}`
      : "";
}

// Per-view heads that live inside the pages: Analyze's game identity, the
// Repertoire header's size summary, and (phones) the More sheet's Library
// mirrors of Import / New.
function syncViewHeads() {
  document.querySelectorAll("[data-lib-mirror]").forEach((item) => {
    item.hidden = appState.currentView !== "dashboard";
  });
  if (appState.currentView === "analyze") syncAnalyzeHead();
  const stats = document.getElementById("build-rep-stats");
  if (!stats) return;
  const build = appState.build;
  if (!build || isBuildReadOnly()) {
    stats.textContent = "";
    stats.title = "";
  } else {
    const played = build.nodes.filter((n) => n.depth > 0);
    const parents = new Set(build.nodes.map((n) => n.parent_id));
    const lines = played.filter((n) => !parents.has(n.id)).length;
    // "to train" is the Library's count too: your own enabled moves — the
    // ones Train drills (opponent replies are context, not cards).
    const train = countBuildMovesToTrain(build);
    stats.textContent =
      `${lines} line${lines === 1 ? "" : "s"} · ${played.length} move${played.length === 1 ? "" : "s"}` +
      ` · ${train} to train`;
    stats.title = `${countOf(played.length, "move")} in the tree; ${train} of them are your moves, which Train drills. Opponent replies aren't drilled.`;
  }
  stats.hidden = !stats.textContent;
}

// Own-side moves on the enabled tree (a disabled node hides its subtree) —
// mirrors the server's trainable count shown on the Library row.
function countBuildMovesToTrain(build) {
  const byId = new Map(build.nodes.map((n) => [n.id, n]));
  const enabledMemo = new Map();
  const reachable = (node) => {
    if (!node) return true;
    if (enabledMemo.has(node.id)) return enabledMemo.get(node.id);
    const ok = node.is_enabled !== false && reachable(byId.get(node.parent_id));
    enabledMemo.set(node.id, ok);
    return ok;
  };
  return build.nodes.filter((n) => n.depth > 0 && n.move_side === build.color && reachable(n)).length;
}

function switchView(name, { fromUrl = false } = {}) {
  workspaceNavigationSeq += 1;
  if (!fromUrl && !workspaceUrlReady) navigatedDuringBoot = true;
  if (appState.currentView === "teams" && name !== "teams") {
    teamsView?.invalidateRequests();
    sharedRepertoiresSeq++;
    teamDetailSeq++;
  }
  if (appState.currentView !== name) clearStaleStatusOnNavigate();
  if (name !== "analyze") positionCoach.cancel();
  if (appState.currentView !== name && engineWidget) engineWidget.exitPreview();
  appState.currentView = name;
  // Navigating is user activity; if the Lichess watch is running, switching to
  // Analyze (where a fresh game matters most) tightens the poll cadence briefly.
  noteLichessActivity();
  document.querySelectorAll(".tab").forEach((button) => {
    const replayMatch = name === "replay"
      ? button.dataset.replaySection === (appState.replaySection || "games")
      : !button.dataset.replaySection;
    const active = button.dataset.view === name && replayMatch;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  // Mobile bottom bar: Review lights up on either replay section (Games or
  // Scout); More lights up for the destinations its sheet carries.
  document.querySelectorAll("[data-review-tab]").forEach((button) => {
    const active = name === "replay";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  const moreBtn = document.getElementById("more-nav-btn");
  if (moreBtn) {
    const active = ["analyze", "teams", "settings"].includes(name);
    moreBtn.classList.toggle("is-active", active);
    moreBtn.setAttribute("aria-current", active ? "page" : "false");
  }
  syncPageTitle();
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  if (!fromUrl) syncWorkspaceUrl({ push: true });
  if (name === "replay") setReplaySection(appState.replaySection, { syncUrl: false });
  if (name === "analyze") {
    preloadCoach().catch(() => {});
    preloadAnalyzeView().catch(() => {});
  }
  if (name === "build") {
    preloadCoach().catch(() => {});
    preloadBuildView().catch(() => {});
    // No Maia warmup here by design: the ~46 MB weights only start downloading
    // after an explicit Generate click (see generateFromCurrentNode), so merely
    // browsing Build never triggers engine/model loading.
    preloadBuildGen().catch(() => {});
  }
  if (name === "train") {
    preloadTrainView().catch(() => {});
    loadTrainRepertoireOptions();
  }
  if (name === "replay") {
    preloadReplayView().catch(() => {});
  }
  if (name === "settings") {
    preloadSettingsView().catch(() => {});
    loadSettings();
  }
  // Warm the Analyze book (active repertoire trees) so the first explored move
  // can be matched without waiting on the lazy load.
  // Recent analyses are owner-scoped: signed out the drawer is absent; signed
  // in it ships open, so it loads on entry (not only on a manual toggle).
  if (name === "analyze") {
    const historyDrawer = document.getElementById("history-drawer");
    if (historyDrawer) {
      historyDrawer.hidden = !appState.signedIn;
      if (appState.signedIn && historyDrawer.open) loadAnalysisHistory();
    }
  }
  if (name === "analyze" && appState.signedIn) {
    ensureBookLoaded()
      .then(() => updateBookline())
      .catch(() => { /* best-effort */ });
  }
  // Entering dashboard loads the view chunk; signed-in users also refresh counters.
  if (name === "dashboard") {
    ensureDashboardView().catch(() => {});
    if (appState.signedIn) {
      // Moves added in Repertoire sit in the debounced outbox for a moment;
      // send them first so the listing's move counts include them.
      settleBuildOutbox()
        .then(() => loadDashboard())
        .catch(() => { /* counters refresh is best-effort */ });
    }
  }
  // Entering Teams (re)loads the caller's teams + shared list.
  if (name === "teams") {
    // Signed out, loadTeams() makes no API call and paints the sign-in state;
    // skipping it left a deep link to #/teams on the bare "Choose a team" shell.
    loadTeams().catch(() => { /* best-effort */ });
  }
  if (name === "build") scheduleExplorerRefresh();
  // One engine session, shown inside whichever view owns a board: Build's
  // Explorer or Analyze's Evaluation card. Each view remembers its own on/off;
  // views without an analysis board close it.
  syncEngineForView(name);
}

function parseFenBoard(fen) {
  const squares = {};
  fen.split(" ")[0].split("/").forEach((rankText, rankIndex) => {
    let fileIndex = 0;
    const rank = 8 - rankIndex;
    for (const char of rankText) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
      } else {
        squares[`${files[fileIndex]}${rank}`] = char;
        fileIndex += 1;
      }
    }
  });
  return squares;
}

const PIECE_LABEL_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

function pieceLabel(piece) {
  const name = PIECE_LABEL_NAMES[piece.toLowerCase()] || "piece";
  return `${piece === piece.toUpperCase() ? "white" : "black"} ${name}`;
}

function pieceSvg(piece) {
  const colorClass = piece === piece.toUpperCase() ? "piece-white" : "piece-black";
  return `<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${activePieceSet()[piece.toLowerCase()]}</g></svg>`;
}

function setPieceStyle(style) {
  if (!PIECE_SETS[style]) return;
  appState.pieceStyle = style;
  try {
    localStorage.setItem(PIECE_STYLE_KEY, style);
  } catch (_) {
    // ignore storage errors (private mode)
  }
  Object.values(boards).forEach((board) => board && board.redrawPieces && board.redrawPieces());
  renderPieceStylePicker();
}

function renderPieceStylePicker() {
  const host = document.getElementById("piece-style-picker");
  if (!host) return;
  // A tiny sample of each set on board squares, so the choice is visible
  // before (and after) picking — the label alone didn't say what you'd get.
  const sample = ["K", "Q", "N", "p"];
  host.innerHTML = Object.keys(PIECE_SETS)
    .map((style) => {
      const active = style === appState.pieceStyle;
      const set = PIECE_SETS[style];
      const previews = sample
        .map((pc) => {
          const colorClass = pc === pc.toUpperCase() ? "piece-white" : "piece-black";
          return `<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${set[pc.toLowerCase()]}</g></svg>`;
        })
        .join("");
      return (
        `<button type="button" class="seg-btn piece-style-option${active ? " is-active" : ""}" data-style="${escapeHtml(style)}" aria-pressed="${active}">` +
        `<span class="piece-style-preview" aria-hidden="true">${previews}</span>` +
        `<span class="piece-style-name">${escapeHtml(PIECE_STYLE_LABELS[style] || style)}</span></button>`
      );
    })
    .join("");
  host.querySelectorAll(".piece-style-option").forEach((btn) => {
    btn.addEventListener("click", () => setPieceStyle(btn.dataset.style));
  });
}

function renderPrefsToggles() {
  const host = document.getElementById("board-prefs");
  if (!host) return;
  host.innerHTML = Object.keys(PREF_LABELS)
    .map((key) => {
      const on = pref(key) ? " is-on" : "";
      const label = escapeHtml(PREF_LABELS[key] || key);
      return (
        `<div class="pf-row">` +
        `<span class="pf-row-text"><span class="pf-row-label">${label}</span></span>` +
        `<button type="button" class="pf-switch${on}" data-pref="${escapeHtml(key)}" role="switch" aria-checked="${pref(key)}" aria-label="${label}">` +
        `<span class="pf-knob"></span>` +
        `</button></div>`
      );
    })
    .join("");
  host.querySelectorAll(".pf-switch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.pref;
      setPref(key, !pref(key));
      btn.classList.toggle("is-on", pref(key));
      btn.setAttribute("aria-checked", String(pref(key)));
    });
  });
}

function legalTargetsFrom(square, moves) {
  return moves.filter((move) => move.startsWith(square)).map((move) => move.slice(2, 4));
}

function legalMoveFor(from, to, moves) {
  return moves.find((move) => move.startsWith(`${from}${to}`));
}

const PROMOTION_PIECES = ["q", "r", "b", "n"];
const PROMOTION_LABELS = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };

function promotionOptions(from, to, moves) {
  return PROMOTION_PIECES.map((piece) => `${from}${to}${piece}`).filter((uci) =>
    moves.includes(uci)
  );
}

// True when `from→to` is a pawn promotion: more than one 5-char UCI shares the
// from/to prefix, or a single 5-char UCI does. Callers gate the picker on this
// so normal moves keep the instant click/drag path with zero UI.
function isPromotionMove(from, to, moves) {
  return moves.some(
    (move) => move.startsWith(`${from}${to}`) && move.length > 4
  );
}

// Shared promotion picker for Analyze / Build / Train boards (mouse, touch and
// keyboard). Mounts a small popover on the target square offering
// Queen / Rook / Bishop / Knight rendered with the active piece set; Queen is
// the initial focus but nothing is committed until the player chooses —
// Escape or an outside click cancels and leaves the position untouched.
// Returns a Promise resolving to the chosen 5-char UCI, or null on cancel.
export function showPromotionPicker({ from, to, moves, anchorBoard, color }) {
  return new Promise((resolve) => {
    const options = promotionOptions(from, to, moves);
    if (options.length === 0) {
      resolve(null);
      return;
    }
    if (options.length === 1) {
      resolve(options[0]);
      return;
    }
    const boardEl =
      typeof anchorBoard === "string"
        ? document.getElementById(anchorBoard)
        : anchorBoard && anchorBoard.board
          ? anchorBoard.board
          : anchorBoard || null;
    const dismiss = (value) => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onOutside = (event) => {
      if (!overlay.contains(event.target)) {
        event.preventDefault();
        dismiss(null);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss(null);
      }
    };
    const overlay = document.createElement("div");
    overlay.className = "promotion-picker-overlay";
    const side = color === "black" ? "black" : "white";
    overlay.innerHTML = `
      <div class="promotion-picker" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
        ${options
          .map(
            (uci) => `
          <button type="button" class="promotion-option" data-uci="${uci}"
            aria-label="Promote to ${PROMOTION_LABELS[uci[4]] || uci[4]}">
            ${pieceSvg(side === "white" ? uci[4].toUpperCase() : uci[4])}
            <span class="promotion-name">${PROMOTION_LABELS[uci[4]] || uci[4]}</span>
          </button>`
          )
          .join("")}
      </div>
    `;
    const buttons = [...overlay.querySelectorAll(".promotion-option")];
    buttons.forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        dismiss(btn.dataset.uci);
      });
    });
    if (boardEl && boardEl.parentElement) {
      boardEl.parentElement.appendChild(overlay);
    } else {
      document.body.appendChild(overlay);
      activateModal(overlay);
    }
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    const queenBtn = buttons[0];
    if (queenBtn) queenBtn.focus({ preventScroll: true });
  });
}

// Promotion-aware resolution shared by click / drag / keyboard-square paths.
// Plain moves resolve synchronously; promotions open the picker and resolve
// async. `play` is invoked exactly once with the final UCI (or never, on
// cancel) so board handlers keep a single onMove entry point.
function resolveBoardMove({ from, to, moves, board, play }) {
  if (!isPromotionMove(from, to, moves)) {
    const move = legalMoveFor(from, to, moves);
    if (move) play(move);
    return;
  }
  const sideIsBlack = (() => {
    try {
      const rank = board && board.fen ? board.fen.split(" ")[1] : "w";
      return rank === "b";
    } catch (_) {
      return false;
    }
  })();
  const boardEl = board && board.board ? board.board : null;
  void showPromotionPicker({
    from,
    to,
    moves,
    anchorBoard: boardEl,
    color: sideIsBlack ? "black" : "white",
  }).then((uci) => {
    if (uci) play(uci);
  });
}

function renderAnnotations(
  overlay,
  arrows,
  orientation = "white",
  engineArrow = null,
  branchArrows = [],
  branchPick = null,
  betterArrow = null
) {
  overlay.setAttribute("viewBox", "0 0 100 100");
  overlay.innerHTML = "";
  const NS = "http://www.w3.org/2000/svg";
  const valid = (uci) => typeof uci === "string" && uci.length >= 4 && uci.slice(0, 2) !== uci.slice(2, 4);
  // Colours and stroke come from CSS tokens (.annot-arrow rules) so board
  // arrows stay in step with the rest of the theme.
  const drawArrow = (parent, arrow, kind, opts) => {
    const from = squareCenter(arrow.slice(0, 2), orientation);
    const to = squareCenter(arrow.slice(2, 4), orientation);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", buildArrowPath(from, to, opts));
    path.setAttribute("class", `annot-arrow annot-${kind}`);
    parent.appendChild(path);
  };
  // Paint order is importance order, so a stronger mark is never buried under a weaker
  // one: idle fork options → the picked option → the engine-also-likes-this option →
  // the better move → your own arrows → the engine's move.
  const engine = valid(engineArrow) ? engineArrow : null;
  const branches = [...new Set((branchArrows || []).filter(valid))];
  const pick = branches.includes(branchPick) ? branchPick : null;
  // Idle options share one translucent group, so where two cross the overlap does not
  // darken into a third, stronger-looking arrow; they are also drawn slimmer.
  const idle = branches.filter((u) => u !== pick && u !== engine);
  if (idle.length) {
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", "annot-branches");
    idle.forEach((u) => drawArrow(group, u, "branch", { scale: 0.78 }));
    overlay.appendChild(group);
  }
  if (pick && pick !== engine) drawArrow(overlay, pick, "branch is-pick");
  // The engine's move is one of the fork options: one arrow, the engine's fill inside the
  // option's outline, instead of a green arrow hiding the option underneath.
  const engineIsBranch = !!engine && branches.includes(engine);
  if (engineIsBranch) drawArrow(overlay, engine, `branch is-engine${engine === pick ? " is-pick" : ""}`);
  if (valid(betterArrow) && betterArrow !== engine) drawArrow(overlay, betterArrow, "better");
  arrows.forEach((arrow) => drawArrow(overlay, arrow, "user"));
  // A line option you also drew yourself: its dashed outline on top, so the option
  // doesn't vanish under your arrow.
  branches.filter((u) => u !== engine && arrows.includes(u)).forEach((u) => drawArrow(overlay, u, "branch is-echo"));
  // Slimmer than a user arrow, so one you drew on the same move still shows around it.
  if (engine && !engineIsBranch) drawArrow(overlay, engine, "engine", { scale: 0.7 });
}

function squareCenter(square, orientation = "white") {
  const file = files.indexOf(square[0]);
  const rank = Number(square[1]);
  const fileSlot = orientation === "white" ? file : 7 - file;
  const rankSlot = orientation === "white" ? 8 - rank : rank - 1;
  return {
    x: fileSlot * 12.5 + 6.25,
    y: rankSlot * 12.5 + 6.25,
  };
}

// Board legality/state is computed in the browser (chess.js) — no server hop, no
// auth needed. Kept async so every existing `await boardInfo(...)` call site is
// untouched; they resolve instantly. See chess-local.js for the why.
async function boardAfterMove(fen, moveUci) {
  return localBoardAfterMove(fen, moveUci);
}

async function boardInfo(fen) {
  return localBoardInfo(fen);
}

// Optimistically land a just-dragged move on `board` using the local chess
// engine, before any server round-trip confirms it. Without this the board
// drag system restores the piece to its origin on drop and only re-renders the
// move once the handler awaits the network — so the piece visibly snaps back,
// then jumps forward a round-trip later. The handlers below all re-issue
// setPosition with the authoritative FEN afterwards; when that FEN matches the
// optimistic one (the common case) it's a no-op, so there's no second animation
// or sound. The board is locked (no legal moves) until that authoritative
// render lands, so a second drop can't race the in-flight request. Best-effort:
// a failed local apply just leaves the pre-move position for the server to fix.
async function optimisticBoardMove(board, fenBefore, moveUci) {
  if (!board || !fenBefore || !moveUci) return false;
  try {
    const after = await boardAfterMove(fenBefore, moveUci);
    board.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: moveUci });
    return true;
  } catch (_) {
    return false;
  }
}

// Deep-link into the smart queue (it already front-loads due reviews).
function goToSmartTraining(statusMessage) {
  switchView("train");
  appState.trainMode = "smart";
  const btn = document.querySelector('#train-modes .train-mode[data-mode="smart"]');
  if (btn) btn.click();
  setStatus(statusMessage || "Starting trainer");
  // Dashboard "Train now" used to dump the user on an idle Train tab. Start
  // (or resume) the smart queue immediately so one click is a real session.
  startTraining("smart", { fresh: false }).catch(() => {});
}

// ----- Dashboard tab — lazy view chunk ----------------------------------------
let dashboardModulePromise = null;
let dashboardView = null;

function preloadDashboardView() {
  if (!dashboardModulePromise) {
    dashboardModulePromise = import("./views/dashboard.js").catch((err) => {
      dashboardModulePromise = null;
      throw err;
    });
  }
  return dashboardModulePromise;
}

async function ensureDashboardView() {
  const mod = await preloadDashboardView();
  if (!dashboardView) {
    dashboardView = mod.createDashboardView({
      appState,
      api,
      postJson,
      escapeHtml,
      setStatus,
      setStatusError,
      localDateString,
      goToSmartTraining,
      editRepertoire,
      openRepertoireContextMenu,
      createRepertoirePrompt,
      hydrateBuild,
      showInputModal,
      promptImportRepertoireFromPgn,
      requireSignIn,
      openSignIn: () => openAuthModal("login"),
      onLibraryStateChange: syncViewHeads,
      goToView: switchView,
      openSettingsSection,
      // Library preview mini-board: FEN decode + the product's piece SVGs over
      // the real listing root_fen. Pure DOM helpers — no engine, no board.
      previewRenderers: { parseFenBoard, pieceSvg },
    });
    dashboardView.bind();
  }
  return dashboardView;
}

async function loadDashboard() {
  let view;
  try {
    view = await ensureDashboardView();
    if (appState.signedIn) await view.loadDashboard();
    else view.renderSignedOut();
  } catch (error) {
    // An import failure happens before the view can clear the initial spinner.
    if (!view) {
      const card = document.querySelector("#view-dashboard .lib-list");
      for (const name of ["is-loading", "is-empty", "is-error"]) {
        card?.classList.toggle(name, name !== "is-loading");
      }
      const host = document.getElementById("dashboard-repertoires");
      if (host) {
        host.innerHTML = `<div class="empty-state" role="alert"><h3>Could not load your library.</h3>` +
          `<p>${escapeHtml(error.message)}</p><button type="button" class="btn" data-library-retry>Try again</button></div>`;
        host.querySelector("[data-library-retry]")?.addEventListener("click", loadDashboard);
      }
    }
    setStatusError(error.message);
  }
}

// Refresh the repertoire list only when the dashboard chunk is already loaded —
// never pull the chunk just to update invisible DOM after CRUD elsewhere.
function refreshDashboardRepertoires() {
  if (!dashboardView) return Promise.resolve();
  return dashboardView.loadDashboardRepertoires();
}

function defaultRepertoireNameFromPgn(pgnText) {
  const pgn = String(pgnText || "");
  const event = pgn.match(/\[Event\s+"([^"]+)"/i);
  if (event) return event[1].trim().slice(0, 80);
  const white = pgn.match(/\[White\s+"([^"]+)"/i);
  const black = pgn.match(/\[Black\s+"([^"]+)"/i);
  if (white && black) return `${white[1].trim()} vs ${black[1].trim()}`.slice(0, 80);
  return "Imported game";
}

async function importRepertoireFromPgnText(pgnText, { name, color }) {
  const payload = await postJson("/api/repertoires/import-pgn", {
    pgn: pgnText,
    name,
    color,
  });
  await hydrateBuild(payload, payload.selected_node_id);
  appState.trainingRepertoireId = payload.repertoire_id;
  await refreshDashboardRepertoires();
  return payload;
}

async function promptImportRepertoireFromPgn(pgnText, { defaultName = "Imported game", switchToBuild = false } = {}) {
  const meta = await showInputModal({
    title: "Import PGN as repertoire",
    okLabel: "Import",
    fields: [
      { name: "name", label: "Name", default: defaultName },
      repertoireColorField("white"),
    ],
  });
  if (!meta) return null;
  const name = (meta.name || "").trim() || "Imported";
  const color = normalizeRepertoireColor(meta.color);
  try {
    const payload = await importRepertoireFromPgnText(pgnText, { name, color });
    if (switchToBuild) switchView("build");
    setStatus(
      switchToBuild
        ? `Repertoire “${payload.name}” created — edit it in Repertoire`
        : `Imported ${payload.name}`,
    );
    return payload;
  } catch (error) {
    setStatusError(error.message);
    throw error;
  }
}

let accountController = null;

function initAccountController() {
  accountController = createAccountController({
    appState,
    api,
    postJson,
    setStatus,
    escapeHtml,
    showConfirmModal,
    refreshAutoMaiaRating,
    onLichessConnected: startLichessGameWatch,
    // The Library setup checklist ticks "Link Lichess" from the live accounts.
    // The Games/Scout source trays resolve "Self" against the same list: painted
    // before it arrived they read "No sources" while Start still fetched every
    // linked account, so repaint them from the live list too.
    onLichessAccountsChanged: () => {
      dashboardView?.refreshSetup?.();
      scoutView?.syncSources();
      paintGamesSource();
      paintScoutSource();
    },
    onOpenSettings: () => {
      switchView("settings");
      loadSettings();
    },
    onOpenAccount: () => {
      void openSettingsSection("set-account");
    },
    beforeSignOut: flushAllPendingForSignOut,
    onOwnerChanged: () => {
      setHandoffOwner(currentOwnerId());
      coverageView?.clear();
      appState.settingsRequestSeq = (appState.settingsRequestSeq || 0) + 1;
      appState.settingsReadSeq = (appState.settingsReadSeq || 0) + 1;
      appState.settingsSaving = null;
      appState.buildMutationSaving = null;
      analysisHistorySeq++;
      sharedRepertoiresSeq++;
      appState.teamsRequestSeq = (appState.teamsRequestSeq || 0) + 1;
      appState.teams = [];
      appState.teamsCache = null;
      appState.analysisRetryCheckpoint = null;
      appState.analysisUnsavedCheckpoint = null;
      hideAnalysisRetrySave();
      for (const id of ["analysis-history", "teams-list", "teams-shared"]) {
        const host = document.getElementById(id);
        if (host) host.innerHTML = "";
      }
      hideTeamDetail();
      dashboardView?.renderSignedOut();
    },
  });
}

function accountService() {
  if (!accountController) throw new Error("Account controller is not initialized");
  return accountController;
}

function getStoredLichessUsername() {
  return accountService().getStoredLichessUsername();
}

function setLichessUsername(username) {
  return accountService().setLichessUsername(username);
}

// Which sign-in methods the server offers (Google when configured; email/password
// always). Fetched once; drives which buttons the auth modal shows.
async function refreshAuthProviders() {
  return accountService().refreshAuthProviders();
}

// Owner-scoped actions (create/import a repertoire, teams, analysis) call server endpoints
// that require an account and return 401 for guests. Guard them up front so a guest gets the
// sign-in modal instead of filling out a form only to hit a cryptic 401 in the status bar.
// `reason` is shown inside the modal; `pendingActionId` (allowlisted in
// auth-gate.js) resumes the action after sign-in — see resumePendingAction.
function requireSignIn(reason = "Sign in (or create an account) to continue", pendingActionId = null, pendingData = null) {
  return accountService().requireSignIn(reason, pendingActionId, pendingData);
}

// The sign-in / create-account modal. Google (when configured) is the primary path;
// email/password is the always-available fallback. Options ({ notice,
// pendingAction, resetToken }) pass straight through to the controller.
function openAuthModal(mode = "login", options = {}) {
  return accountService().openAuthModal(mode, options);
}

// Guest → the chip is a single Connect action (straight to OAuth). Signed in → the
// chip toggles the account menu.
function onAccountChipClick(anchor = null, options = {}) {
  return accountService().onAccountChipClick(anchor, options);
}

function closeAccountMenu(options = {}) {
  return accountService().closeAccountMenu(options);
}

function isAccountMenuOpen() {
  return accountService().isAccountMenuOpen();
}

// Ask the server whether this browser's session is a real account or a guest, and
// capture the account's stable username for the user-name button.
async function refreshAuthStatus() {
  return accountService().refreshAuthStatus();
}

function syncReplayControls() {
  try {
    accountService().syncReplayControls();
  } catch (_) {
    /* controller may not be initialised yet */
  }
  paintGamesSource();
  paintScoutSource();
}

// Pull the server's stored Lichess connection state. This is not a PrepForge sign-out;
// the browser remains bound to the account.
async function refreshLichessStatus() {
  return accountService().refreshLichessStatus();
}

// Open Lichess sign-in in a popup; the callback page postMessages back, and we
// also poll status as a fallback if the message is blocked.
function startLichessOAuth() {
  return accountService().startLichessOAuth();
}

// Background watch for "you just finished a game". Design goals (vs the old
// "latest id != last_seen → pop", which fired for ANY historical game on a fresh
// app load):
//   1. Silent baseline: on watch start we record the current latest game id
//      WITHOUT popping, so opening the app never resurfaces an old game.
//   2. Recency gate: only auto-pop a game whose true FINISH time (Lichess
//      lastMoveAt) is within LICHESS_RECENT_WINDOW_MS, so a stale baseline can
//      never surface an hours-old game. Strict: a game with no usable timestamp
//      is never auto-popped — it gets a non-intrusive status hint instead.
//   3. Adaptive cadence: short polling right after activity (focus, tab visible,
//      navigation) or on Analyze; back off to a low idle frequency otherwise —
//      instead of a fixed 90s timer that runs even on a hidden tab.
const LICHESS_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h: "recently finished"
const LICHESS_POLL_ACTIVE_MS = 25 * 1000; // short cadence while active / on Analyze
const LICHESS_POLL_IDLE_MS = 3 * 60 * 1000; // idle back-off
const LICHESS_ACTIVE_WINDOW_MS = 3 * 60 * 1000; // how long activity keeps us "active"

function startLichessGameWatch() {
  stopLichessGameWatch();
  appState.lichessWatchStartedAt = Date.now();
  appState.lichessBaselineId = null;
  appState.lichessLastActivity = Date.now();
  // Re-check promptly when the user returns to the tab/window (and treat it as
  // activity so the cadence tightens). Bound once; refs kept for clean removal.
  appState.lichessOnFocus = () => {
    noteLichessActivity();
    checkLatestLichessGame();
  };
  appState.lichessOnVisible = () => {
    if (document.visibilityState === "visible") appState.lichessOnFocus();
  };
  window.addEventListener("focus", appState.lichessOnFocus);
  document.addEventListener("visibilitychange", appState.lichessOnVisible);
  // Establish the silent baseline shortly after connecting, then start polling.
  window.setTimeout(async () => {
    await checkLatestLichessGame({ baselineOnly: true });
    scheduleLichessPoll();
  }, 5000);
}

function stopLichessGameWatch() {
  if (appState.lichessPollTimer) {
    window.clearTimeout(appState.lichessPollTimer);
    appState.lichessPollTimer = null;
  }
  if (appState.lichessOnFocus) {
    window.removeEventListener("focus", appState.lichessOnFocus);
    appState.lichessOnFocus = null;
  }
  if (appState.lichessOnVisible) {
    document.removeEventListener("visibilitychange", appState.lichessOnVisible);
    appState.lichessOnVisible = null;
  }
  appState.lichessBaselineId = null;
}

// Record user activity so the poll cadence stays short for a short window after.
function noteLichessActivity() {
  appState.lichessLastActivity = Date.now();
}

// Self-rescheduling poll: short cadence while recently active or on Analyze (where
// a just-finished game is most relevant), otherwise a low idle frequency. Skips the
// work entirely while the tab is hidden (the focus/visibility handlers catch up).
function scheduleLichessPoll() {
  if (appState.lichessPollTimer) window.clearTimeout(appState.lichessPollTimer);
  if (!appState.lichessUsername) return;
  const recentlyActive =
    Date.now() - (appState.lichessLastActivity || 0) < LICHESS_ACTIVE_WINDOW_MS;
  const active = recentlyActive || appState.currentView === "analyze";
  const delay = active ? LICHESS_POLL_ACTIVE_MS : LICHESS_POLL_IDLE_MS;
  appState.lichessPollTimer = window.setTimeout(async () => {
    if (document.visibilityState !== "hidden") await checkLatestLichessGame();
    scheduleLichessPoll();
  }, delay);
}

// Tri-state recency: true = finished within the window, false = finished but stale,
// null = no usable timestamp. We keep null distinct so the caller can degrade to a
// non-intrusive hint rather than guessing (strict gate — never auto-pop on unknown).
function finishedRecently(finishedAt) {
  if (!finishedAt) return null;
  const t = Date.parse(finishedAt);
  if (Number.isNaN(t)) return null;
  return Date.now() - t <= LICHESS_RECENT_WINDOW_MS;
}

// baselineOnly: record the current latest id without popping (used once at watch
// start so the pre-existing latest game is never treated as "just finished").
async function checkLatestLichessGame({ baselineOnly = false } = {}) {
  if (!appState.lichessUsername) return;
  let latest;
  try {
    // Lightweight NDJSON metadata probe (no move text) — fast, and enough to decide
    // whether to surface the nudge. The full PGN is fetched only if the user acts on it.
    latest = await api("/api/lichess/latest?light=1");
  } catch (_) {
    return;
  }
  if (!latest.has_game) return;
  if (baselineOnly || appState.lichessBaselineId === null) {
    // First sighting this session: adopt as baseline, never pop.
    appState.lichessBaselineId = latest.lichess_id;
    return;
  }
  const isNewerThanBaseline = latest.lichess_id !== appState.lichessBaselineId;
  // Advance the baseline regardless, so we evaluate each newly-latest game once.
  appState.lichessBaselineId = latest.lichess_id;
  if (!isNewerThanBaseline || !latest.is_new) return;
  const recent = finishedRecently(latest.finished_at);
  if (recent === true) {
    showNewGameWidget(latest);
  } else if (recent === null) {
    // Passed the baseline + is_new gates but we can't confirm it finished recently.
    // Strict gate: don't pop the widget — just surface a quiet, dismissible hint.
    setStatus(
      `New Lichess game synced: ${latest.white || "?"} vs ${latest.black || "?"}`
    );
  }
  // recent === false: a genuinely older game; stay silent.
}

// Surface a "you just finished a game" nudge. It lives in the shared toast
// stack (so it never overlaps the job cards or engine window) and auto-cleans
// itself after a while if the player ignores it.
function showNewGameWidget(game) {
  if (appState.newGameWidgetId === game.lichess_id) return;
  appState.newGameWidgetId = game.lichess_id;
  const sub =
    `${game.white || "?"} vs ${game.black || "?"}` +
    `${game.result ? " · " + game.result : ""}`;
  const toast = jobToast.notify({
    id: `newgame-${game.lichess_id}`,
    title: "You just finished a game!",
    message: sub,
    actions: [
      {
        label: "Dismiss",
        primary: false,
        onClick: () => {
          appState.newGameWidgetId = null;
          markLichessSeen(game.lichess_id);
        },
      },
      {
        label: "Analyze",
        primary: true,
        onClick: async () => {
          appState.newGameWidgetId = null;
          markLichessSeen(game.lichess_id);
          switchView("analyze");
          // Pull the full PGN now (the probe above skipped move text).
          let pgn = game.pgn || "";
          if (!pgn) {
            try {
              const full = await api("/api/lichess/latest");
              pgn = full.pgn || "";
            } catch (_) {
              /* fall through with empty pgn */
            }
          }
          document.getElementById("pgn-input").value = pgn;
          await runAnalysis();
        },
      },
    ],
  });
  // Auto-dismiss after ~45s of being ignored; the pointer-gating keeps it alive
  // while the user is actually interacting with it. Mark the game seen so the
  // watcher doesn't keep re-surfacing the same finished game.
  if (toast) toast._arm(45000, () => {
    appState.newGameWidgetId = null;
    markLichessSeen(game.lichess_id);
    toast.dismiss();
  });
}

async function markLichessSeen(lichessId) {
  if (!lichessId) return;
  try {
    await postJson("/api/lichess/seen", { lichess_id: lichessId });
  } catch (_) {
    /* ignore */
  }
}

// Linked Lichess identities for one-time per-action selection. `null` = not yet
// loaded; `[]` = none linked. Identity-changing actions (My last game,
// Replay compare, new-game watcher) resolve through resolveLichessAccountId():
// zero → connect flow, one → use it directly, many → compact chooser.
function lichessAccounts() {
  const accounts = appState.lichessAccounts;
  return Array.isArray(accounts) ? accounts : [];
}

function lichessPrimaryAccount() {
  const accounts = lichessAccounts();
  return accounts.find((a) => a.is_primary) || accounts[0] || null;
}

// One-time account chooser for a single action: compact modal listing linked
// identities, Primary defaulted/highlighted, closes on select or cancel.
// Resolves to the chosen account id, or null when cancelled.
function chooseLichessAccount(actionLabel) {
  const accounts = lichessAccounts();
  const primary = lichessPrimaryAccount();
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const rows = accounts
      .map(
        (account) => `
      <button type="button" class="btn ghost account-choice${account.is_primary ? " is-primary" : ""}" data-account-id="${escapeHtml(account.id)}">
        ${escapeHtml(account.username)}${account.is_primary ? " — Primary" : ""}
      </button>`,
      )
      .join("");
    overlay.innerHTML = `
      <div class="modal account-chooser" role="dialog" aria-modal="true" aria-label="${escapeHtml(actionLabel)}">
        <div class="modal-title">${escapeHtml(actionLabel)}</div>
        <div class="modal-body">
          <p class="modal-copy">Which Lichess account should this use? Primary is preselected.</p>
          <div class="account-chooser-list">${rows}</div>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateModal(overlay);
    const cleanup = () => overlay.remove();
    const close = (value) => {
      cleanup();
      resolve(value);
    };
    const primaryBtn = primary && overlay.querySelector(`[data-account-id="${primary.id}"]`);
    if (primaryBtn) primaryBtn.focus();
    overlay.addEventListener("click", (event) => {
      const choice = event.target.closest("[data-account-id]");
      if (choice) {
        close(choice.dataset.accountId);
        return;
      }
      if (event.target === overlay || event.target.closest('[data-action="cancel"]')) {
        close(null);
      }
    });
    document.addEventListener(
      "keydown",
      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          document.removeEventListener("keydown", onKey);
          close(null);
        }
      },
      { once: false },
    );
  });
}

// Resolve which linked identity an identity-changing action should read:
// null = caller must run the connect flow first; otherwise an account id
// (single account → immediate, multiple → one-time chooser, primary default).
async function resolveLichessAccountId(actionLabel) {
  const accounts = lichessAccounts();
  if (!accounts.length) return null;
  if (accounts.length === 1) return accounts[0].id;
  const primary = lichessPrimaryAccount();
  const chosen = await chooseLichessAccount(actionLabel);
  return chosen || null;
}

// "My game" button: pull the newest game across ALL linked Lichess identities
// ("self") straight into the PGN box — no chooser. account_id is only for
// explicit single-account callers; the default path aggregates.
// Point Analyze's board at the user's side of a game they played: match either
// player name against every linked Lichess identity (plus the account the game
// came from). Leaves the orientation alone when neither side is recognisably Self.
function orientAnalysisForSelf(white, black, extraNames = []) {
  if (!boards.analysis) return;
  const side = selfSide(white, black, [
    appState.lichessUsername,
    ...lichessAccounts().map((a) => a.username),
    ...extraNames,
  ]);
  if (side) boards.analysis.setOrientation(side);
}

// Which side of the Analyze game is the user ("white" | "black" | null): the PGN box's
// White/Black tags, else the recalled analysis, matched against linked Lichess names.
function analysisSelfSide() {
  const tags = analyzeHeaderTags(document.getElementById("pgn-input")?.value || "");
  const analysis = appState.analysis || {};
  return selfSide(tags.White || analysis.white, tags.Black || analysis.black, [
    appState.lichessUsername,
    ...lichessAccounts().map((a) => a.username),
  ]);
}

// Same, for a PGN the user pasted or dropped: read its White/Black headers.
// Only re-orients when the pair of names changes, so the debounced re-parse on
// every keystroke never undoes a manual flip.
let lastOrientedPgnPlayers = "";
function orientAnalysisFromPgn(text) {
  const { white, black } = pgnPlayers(text);
  const key = `${white}\n${black}`;
  if (!white && !black) return;
  if (key === lastOrientedPgnPlayers) return;
  lastOrientedPgnPlayers = key;
  orientAnalysisForSelf(white, black);
}

async function fetchMyLichessGame(accountId = null) {
  // Your games come from the Lichess account linked to your PrepForge account.
  if (!requireSignIn("Sign in to load your latest Lichess game", "my-last-game")) return;
  if (!appState.lichessUsername && !lichessAccounts().length) {
    setStatus("Connect a Lichess account first");
    startLichessOAuth();
    return;
  }
  const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
  setStatus("Fetching your latest game...");
  let latest;
  try {
    latest = await api(`/api/lichess/latest${query}`);
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  if (!latest.has_game) {
  setStatus("No recent games found", { severity: "warning" });
    return;
  }
  document.getElementById("pgn-input").value = latest.pgn || "";
  // Show the game in the move list right away, then analyze it in the same step —
  // "My last game" means "review my last game", not "paste it and wait for me".
  await loadPgnIntoAnalyze(latest.pgn || "", { goToEnd: false, quiet: true }).catch(() => {});
  orientAnalysisForSelf(latest.white, latest.black, [latest.source_account]);
  lastOrientedPgnPlayers = `${latest.white || ""}\n${latest.black || ""}`;
  if (latest.lichess_id) markLichessSeen(latest.lichess_id);
  const source = latest.source_account ? ` · from ${latest.source_account}` : "";
  setStatus(`Loaded ${latest.white || "?"} vs ${latest.black || "?"}${source} · analyzing`);
  await runAnalysis();
}

// Analyze "History": list previously analyzed games; click to recall a saved
// report without re-running the engine.
// A save adds a row to "Recent analyses": refresh the open drawer so it never
// keeps saying "No saved analyses yet" beside the review just saved.
function refreshAnalysisHistoryIfOpen() {
  const drawer = document.getElementById("history-drawer");
  if (appState.signedIn && drawer && drawer.open) void loadAnalysisHistory();
}

let analysisHistorySeq = 0;
async function loadAnalysisHistory() {
  const seq = ++analysisHistorySeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === analysisHistorySeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const host = document.getElementById("analysis-history");
  if (!host) return;
  host.innerHTML = '<div class="muted hint">Loading...</div>';
  const rows = new Map();
  let cursor = null, loading = false;
  async function loadPage() {
    if (loading || !isCurrent()) return;
    loading = true;
    const button = host.querySelector("[data-history-more]");
    if (button) button.disabled = true;
    try {
      const payload = await api(`/api/analyses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!isCurrent()) return;
      for (const row of payload.analyses || []) rows.set(row.game_id, row);
      cursor = payload.next_cursor || null;
      const scroll = host.scrollTop;
      host.innerHTML = [...rows.values()].map((a) =>
        `<button class="history-item" data-game-id="${escapeHtml(a.game_id)}">` +
        `<span class="hi-players">${escapeHtml(a.white || "?")} vs ${escapeHtml(a.black || "?")}</span>` +
        `<span class="hi-meta">${escapeHtml(a.result || "")} ? ${escapeHtml(localDayOf(a.analyzed_at))}</span></button>`
      ).join("") || '<div class="muted hint">No saved analyses yet.</div>';
      if (cursor) host.innerHTML += '<button class="btn sm" data-history-more>Load more</button>';
      host.scrollTop = scroll;
      host.querySelectorAll(".history-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (isCurrent()) recallAnalysis(btn.dataset.gameId, rows.get(btn.dataset.gameId));
        });
      });
      host.querySelector("[data-history-more]")?.addEventListener("click", loadPage);
    } catch (error) {
      if (!isCurrent()) return;
      if (rows.size) {
        if (button) button.textContent = "Retry load more";
        setStatusError(error.message);
      } else host.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    } finally {
      loading = false;
      if (button && isCurrent()) button.disabled = false;
    }
  }
  await loadPage();
}

// All Analyze sources share an order: a recall, paste or new review must not
// let an older request (including a lazy view load) replace the latest game.
let analysisRecallSeq = 0;

function invalidateAnalysisSource() {
  appState.analysisFileSeq = null;
  clearTimeout(analyzePgnInputTimer);
  return ++analysisRecallSeq;
}

async function recallAnalysis(gameId, listItem = null) {
  const seq = invalidateAnalysisSource();
  setStatus("Loading saved analysis...");
  appState.analysisSourcePgn = null;
  hideAnalysisHandoff();
  try {
    const payload = await api(`/api/analyses/${encodeURIComponent(gameId)}`);
    const view = await ensureAnalyzeView();
    if (seq !== analysisRecallSeq) return;
    // The saved result carries no player names; the history row does. Without
    // them the head fell back to "Analysis board" for a named game.
    for (const key of ["white", "black", "result"]) {
      if (!payload[key] && listItem?.[key]) payload[key] = listItem[key];
    }
    appState.analysis = payload;
    // Mirror the recalled game into the PGN box for further exploration.
    // Clear it before rendering: the head reads its tags first, and a leftover
    // (e.g. the demo PGN) would title the recalled game "PrepForge vs Demo".
    const pgnInput = document.getElementById("pgn-input");
    if (pgnInput) pgnInput.value = "";
    orientAnalysisForSelf(payload.white, payload.black);
    lastOrientedPgnPlayers = `${payload.white || ""}\n${payload.black || ""}`;
    resetAnalysisVariations();
    await showAnalysisPly(0);
    if (seq !== analysisRecallSeq) return;
    view.renderAnalysis(payload);
    syncViewHeads();
    revealAnalysisResults();
    await syncPgnFromTree();
    if (seq !== analysisRecallSeq) return;
    setStatus(`Recalled analysis: ${payload.moves.length} plies`);
  } catch (error) {
    if (seq !== analysisRecallSeq) return;
    setStatusError(error.message);
  }
}

// ---- Teams (Phase 5 UI) -----------------------------------------------------
// A team is a free, read-only sharing group: a repertoire owner shares to it
// (POST /api/repertoires/share) and every member can *read* (never edit) it.
// This view lists the caller's teams, drills into one to manage membership, and
// surfaces repertoires shared *to* the caller. Open to everyone — no Pro gate.

const TEAM_ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };

function teamRoleLabel(role) {
  return TEAM_ROLE_LABELS[role] || role;
}

function teamById(teamId) {
  return appState.teams.find((tm) => tm.id === teamId) || null;
}

let teamsModule = null;
let teamsView = null;

function preloadTeamsView() {
  if (!teamsModule) {
    teamsModule = import("./views/teams.js").catch((err) => {
      teamsModule = null;
      throw err;
    });
  }
  return teamsModule;
}

async function ensureTeamsView() {
  const mod = await preloadTeamsView();
  if (!teamsView) {
    teamsView = mod.createTeamsView({
      appState,
      api,
      escapeHtml,
      hideTeamDetail,
      openTeamDetail,
      loadSharedRepertoires,
      editRepertoire,
      unshareRepertoireFromTeam,
      copySharedRepertoire,
      teamRoleLabel,
      postJson,
      setStatus,
      setStatusError,
      activateModal,
      showConfirmModal,
      requireSignIn,
    });
  }
  return teamsView;
}

async function loadTeams() {
  return (await ensureTeamsView()).loadTeams();
}

function renderTeamsList() {
  if (teamsView) return teamsView.renderTeamsList();
  void ensureTeamsView().then((view) => view.renderTeamsList()).catch(() => {});
}

function hideTeamDetail() {
  appState.selectedTeamId = null;
  const card = document.getElementById("team-detail-card");
  if (card) card.hidden = true;
  renderTeamsList();
}

let teamDetailSeq = 0;
async function openTeamDetail(teamId) {
  const seq = ++teamDetailSeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === teamDetailSeq && appState.selectedTeamId === teamId && owner === currentOwnerId() && generation === appState.ownerGeneration;
  appState.selectedTeamId = teamId;
  renderTeamsList(); // reflect the selected row
  for (const id of ["team-add-member", "team-detail-invite", "team-share-rep", "team-detail-rename", "team-detail-delete"]) {
    const button = document.getElementById(id);
    if (button) { button.hidden = true; button.onclick = null; }
  }
  const name = document.getElementById("team-detail-name");
  if (name) name.textContent = "Loading?";
  const role = document.getElementById("team-detail-role");
  if (role) role.textContent = "";
  const shares = document.getElementById("team-shared-repertoires");
  if (shares) shares.innerHTML = "";
  teamsView?.renderTeamTabCounts({ members: 0, repertoires: 0 });
  teamsView?.renderTeamInviteFooter(null);
  const card = document.getElementById("team-detail-card");
  const membersEl = document.getElementById("team-members");
  if (!card || !membersEl) return;
  card.hidden = false;
  membersEl.innerHTML = '<div class="empty-state">Loading…</div>';
  let detail;
  try {
    detail = await api(`/api/teams/${encodeURIComponent(teamId)}`);
  } catch (error) {
    if (!isCurrent()) return;
    membersEl.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!isCurrent()) return;
  const myRole = detail.role;
  const canManage = myRole === "owner" || myRole === "admin";
  document.getElementById("team-detail-name").textContent = detail.name;
  const roleBadge = document.getElementById("team-detail-role");
  if (roleBadge) {
    roleBadge.textContent = teamRoleLabel(myRole);
    roleBadge.className = `team-role-badge r-${myRole}`;
  }
  const addBtn = document.getElementById("team-add-member");
  if (addBtn) {
    addBtn.hidden = !canManage;
    addBtn.onclick = () => addTeamMember(teamId);
  }
  const inviteBtn = document.getElementById("team-detail-invite");
  if (inviteBtn) {
    inviteBtn.hidden = !canManage;
    inviteBtn.onclick = () => teamInvite(teamId);
  }
  const shareBtn = document.getElementById("team-share-rep");
  if (shareBtn) {
    // Any member may share one of their OWN repertoires with the team.
    shareBtn.hidden = false;
    shareBtn.onclick = () => shareRepertoireIntoTeam(teamId);
  }
  const renameBtn = document.getElementById("team-detail-rename");
  if (renameBtn) {
    renameBtn.hidden = !canManage;
    renameBtn.onclick = () => renameTeam(teamId, detail.name);
  }
  const deleteBtn = document.getElementById("team-detail-delete");
  if (deleteBtn) {
    deleteBtn.hidden = myRole !== "owner";
    deleteBtn.onclick = () => deleteTeam(teamId, detail.name);
  }
  const members = detail.members || [];
  // Tab counts from the real payload (prototype puts them on the tabs) + the
  // manager-only invite footer, both before the member rows render.
  if (teamsView) {
    teamsView.renderTeamTabCounts({ members: members.length });
    teamsView.renderTeamInviteFooter(detail);
  }
  membersEl.innerHTML = members
    .map((m) => {
      const name = escapeHtml(m.display_name || m.lichess_username || "Member");
      const sub = m.lichess_username ? `<span class="sub">· ${escapeHtml(m.lichess_username)}</span>` : "";
      const initial = escapeHtml(Array.from(m.display_name || m.lichess_username || "M")[0].toUpperCase());
      const isMe = m.user_id === appState.accountUserId;
      const isOwner = m.role === "owner";
      const uid = escapeHtml(m.user_id);
      const uname = escapeHtml(m.display_name || m.lichess_username || "Member");
      // Owner row is fixed. Managers get an inline role control on every other row
      // (incl. their own, so an admin can step down) plus remove; a plain member only
      // sees a read-only badge and a Leave button on their own row. The server
      // enforces all of this too.
      let tail;
      if (isOwner) {
        tail = `<span class="team-role-badge r-owner">${escapeHtml(teamRoleLabel("owner"))}</span>`;
      } else if (canManage) {
        const opts = ["member", "admin"]
          .map(
            (r) =>
              `<option value="${r}"${m.role === r ? " selected" : ""}>${escapeHtml(teamRoleLabel(r))}</option>`
          )
          .join("");
        const removeBtn = `<button type="button" class="ib team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="${isMe ? "1" : "0"}"${isMe ? "" : " title=\"Remove member\""}>${isMe ? "Leave" : "×"}</button>`;
        tail = `<select class="team-role-select" data-user-id="${uid}" aria-label="Role for ${uname}">${opts}</select>${removeBtn}`;
      } else {
        const leaveBtn = isMe
          ? `<button type="button" class="ib team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="1">Leave</button>`
          : "";
        tail = `<span class="team-role-badge r-${escapeHtml(m.role)}">${escapeHtml(teamRoleLabel(m.role))}</span>${leaveBtn}`;
      }
      return `
        <div class="mem-row team-member-row">
          <span class="avatar sm" aria-hidden="true">${initial}</span>
          <span class="mem-id"><span class="name">${name}${isMe ? ' <span class="sub">(you)</span>' : ""}</span>${sub}</span>
          <span class="team-member-tail">${tail}</span>
        </div>`;
    })
    .join("");
  membersEl.querySelectorAll(".team-role-select").forEach((sel) => {
    sel.addEventListener("change", () =>
      updateMemberRole(teamId, sel.dataset.userId, sel.value)
    );
  });
  membersEl.querySelectorAll(".team-remove").forEach((btn) => {
    btn.addEventListener("click", () =>
      removeTeamMember(teamId, btn.dataset.userId, btn.dataset.userName, btn.dataset.self === "1")
    );
  });
  renderTeamSharedRepertoires(teamId, detail.shared_repertoires || []);
}

function renderTeamSharedRepertoires(teamId, sharedReps) {
  if (teamsView) return teamsView.renderTeamSharedRepertoires(teamId, sharedReps);
  void ensureTeamsView()
    .then((view) => view.renderTeamSharedRepertoires(teamId, sharedReps))
    .catch(() => {});
}

async function unshareRepertoireFromTeam(teamId, repertoireId, name) {
  const confirmed = await showConfirmModal({
    title: `Stop sharing "${name}"?`,
    body: "Team members will lose read access. You can share it again later.",
    okLabel: "Unshare",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await postJson("/api/repertoires/share", {
      repertoire_id: repertoireId,
      visibility: "private",
    });
    setStatus(`"${name}" is private again`);
    await refreshDashboardRepertoires();
    await openTeamDetail(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
}

async function createTeam() {
  if (!requireSignIn("Sign in to create a team", "new-team")) return;
  const result = await showInputModal({
    title: "New team",
    okLabel: "Create",
    fields: [{ name: "name", label: "Team name", default: "" }],
  });
  if (!result) return;
  const name = (result.name || "").trim();
  if (!name) {
    setStatus("Team name is empty");
    return;
  }
  try {
    const team = await postJson("/api/teams", { name });
    appState.selectedTeamId = team.id;
    // A fresh team starts empty: land on the Members tab (the empty Shared
    // tab would read as a glitch).
    teamsView?.selectTeamPane?.("members");
    setStatus(`Created team "${name}"`, { severity: "success" });
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function renameTeam(teamId, currentName) {
  const result = await showInputModal({
    title: "Rename team",
    okLabel: "Save",
    fields: [{ name: "name", label: "Team name", default: currentName }],
  });
  if (!result) return;
  const name = (result.name || "").trim();
  if (!name) {
    setStatus("Name is empty");
    return;
  }
  try {
    await api(`/api/teams/${encodeURIComponent(teamId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    setStatus(`Renamed to "${name}"`);
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function deleteTeam(teamId, name) {
  const confirmed = await showConfirmModal({
    title: "Delete team?",
    body: `"${name}" will be removed and all shared repertoires will become private again. Members lose access.`,
    okLabel: "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(`/api/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
    hideTeamDetail();
    setStatus(`Deleted team "${name}"`);
    await loadTeams();
    await refreshDashboardRepertoires();
  } catch (error) {
    setStatusError(error.message);
  }
}

async function addTeamMember(teamId) {
  const result = await showInputModal({
    title: "Add member",
    okLabel: "Add",
    fields: [
      { name: "lichess_username", label: "Their Lichess username", default: "" },
      {
        name: "role",
        label: "Role",
        type: "select",
        default: "member",
        options: [
          { value: "member", label: "Member" },
          { value: "admin", label: "Admin (can manage members)" },
        ],
      },
      {
        type: "note",
        label:
          "They need a PrepForge account with Lichess linked. No account yet? Send them the invite link instead.",
      },
    ],
  });
  if (!result) return;
  const handle = (result.lichess_username || "").trim();
  if (!handle) {
    setStatus("Lichess username is empty");
    return;
  }
  try {
    await postJson(`/api/teams/${encodeURIComponent(teamId)}/members`, {
      lichess_username: handle,
      role: result.role || "member",
    });
    setStatus(`Added ${handle}`);
    await loadTeams();
  } catch (error) {
    // The server returns an actionable message (e.g. "...send them an invite link").
    setStatusError(error.message);
  }
}

async function updateMemberRole(teamId, userId, role) {
  try {
    await api(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) }
    );
    setStatus(role === "admin" ? "Promoted to admin" : "Set to member");
  } catch (error) {
    setStatusError(error.message);
  }
  // Re-render either way: on success to reflect any rights change, on failure to
  // revert the <select> back to the server's truth.
  await openTeamDetail(teamId);
}

async function removeTeamMember(teamId, userId, label, isSelf) {
  const confirmed = await showConfirmModal({
    title: isSelf ? "Leave team?" : "Remove member?",
    body: isSelf
      ? "You'll lose access to repertoires shared with this team. You can be re-added later."
      : `Remove ${label} from the team? They'll lose access to its shared repertoires.`,
    okLabel: isSelf ? "Leave" : "Remove",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(
      `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    );
    setStatus(isSelf ? "Left team" : `Removed ${label}`);
    if (isSelf) {
      hideTeamDetail();
      teamsView?.selectTeamPane?.("members");
    }
    await loadTeams();
  } catch (error) {
    setStatusError(error.message);
  }
}

// The team's shareable join link. Opening the dialog reads the link's status and
// never rotates it; minting a new code is an explicit, confirmed action inside
// the dialog (views/team-invite.js).
async function teamInvite(teamId) {
  try {
    await (await ensureTeamsView()).openInviteDialog(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
  await openTeamDetail(teamId);
}

// In-team "add a repertoire": share one of the caller's OWN repertoires with this
// team. A repertoire can be shared with one team at a time, so picking one already
// shared elsewhere moves it here.
async function shareRepertoireIntoTeam(teamId) {
  let reps = [];
  try {
    const payload = await api("/api/repertoires");
    reps = payload.repertoires || [];
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  const candidates = reps.filter((r) => !(r.visibility === "team" && r.team_id === teamId));
  if (!candidates.length) {
    setStatus(
      reps.length ? "All your repertoires are already shared here" : "You have no repertoires to share"
    );
    return;
  }
  const result = await showInputModal({
    title: "Share a repertoire",
    okLabel: "Share",
    fields: [
      {
        name: "repertoire",
        label: "Repertoire",
        type: "select",
        default: candidates[0].id,
        options: candidates.map((r) => ({
          value: r.id,
          label: r.visibility === "team" ? `${r.name} (shared elsewhere → moves here)` : r.name,
        })),
      },
      {
        type: "note",
        label: "Members get read-only access. A repertoire can be shared with one team at a time.",
      },
    ],
  });
  if (!result || !result.repertoire) return;
  try {
    await postJson("/api/repertoires/share", {
      repertoire_id: result.repertoire,
      team_id: teamId,
      visibility: "team",
    });
    setStatus("Shared with the team");
    await refreshDashboardRepertoires();
    await openTeamDetail(teamId);
  } catch (error) {
    setStatusError(error.message);
  }
}

// Copy a team-shared repertoire the caller doesn't own into their own account.
async function copySharedRepertoire(repertoireId) {
  try {
    const result = await postJson("/api/repertoires/fork", { repertoire_id: repertoireId });
    setStatus(`Copied "${result.name}" to your repertoires`);
    await refreshDashboardRepertoires();
  } catch (error) {
    setStatusError(error.message);
  }
}

let sharedRepertoiresSeq = 0;
async function loadSharedRepertoires() {
  const seq = ++sharedRepertoiresSeq;
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => seq === sharedRepertoiresSeq && owner === currentOwnerId() && generation === appState.ownerGeneration;
  const container = document.getElementById("teams-shared");
  if (!container) return;
  try {
    const payload = await api("/api/repertoires");
    if (!isCurrent()) return;
    const shared = payload.shared || [];
    if (!shared.length) {
      container.innerHTML =
        '<div class="empty-state">Nothing shared with you yet.</div>';
      return;
    }
    container.innerHTML = shared
      .map((item) => {
        const id = escapeHtml(item.id);
        const name = escapeHtml(item.name);
        const color = escapeHtml(item.color || "white");
        const team = teamById(item.team_id);
        const via = `via ${escapeHtml(team ? team.name : "a team")}`;
        return `
          <div class="mem-row shared-rep-row" role="button" tabindex="0" data-repertoire-id="${id}">
            <span class="color-dot ${color}"></span>
            <span class="mem-id">
              <span class="name">${name}</span>
              <span class="sub">· ${via}</span>
            </span>
            <span class="team-member-tail">
              <span class="team-role-badge">read-only</span>
              <button type="button" class="btn sm team-copy" data-rep-id="${id}">Copy</button>
            </span>
          </div>`;
      })
      .join("");
    container.querySelectorAll(".shared-rep-row").forEach((row) => {
      const open = () => openSharedRepertoire(row.dataset.repertoireId);
      row.addEventListener("click", (event) => {
        if (event.target.closest(".team-copy")) return;
        open();
      });
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
    container.querySelectorAll(".team-copy").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        copySharedRepertoire(btn.dataset.repId);
      });
    });
  } catch (error) {
    if (!isCurrent()) return;
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function openSharedRepertoire(repertoireId) {
  await editRepertoire(repertoireId);
}

// Rep context-menu action: share (or unshare) one of the caller's OWN repertoires
// with a team. Needs the caller's team list; if they have none, nudge them to the
// Teams view to make one first.
async function shareRepertoireWithTeam(repertoireId) {
  try {
    if (!appState.teams.length) {
      const payload = await api("/api/teams");
      appState.teams = payload.teams || [];
    }
  } catch (_) {
    /* fall through with whatever we have */
  }
  if (!appState.teams.length) {
    const go = await showConfirmModal({
      title: "No teams yet",
      body: "You need a team to share a repertoire with. Create one now?",
      okLabel: "Go to Teams",
      cancelLabel: "Cancel",
    });
    if (go) {
      switchView("teams");
      loadTeams();
    }
    return;
  }
  const result = await showInputModal({
    title: "Share with team",
    okLabel: "Apply",
    fields: [
      {
        name: "team",
        label: "Share with",
        type: "select",
        default: appState.teams[0].id,
        options: [
          { value: "", label: "Private (don't share)" },
          ...appState.teams.map((tm) => ({
            value: tm.id,
            label: tm.name,
          })),
        ],
      },
      {
        type: "note",
        label:
          "Members get read-only access. A repertoire can be shared with one team at a time.",
      },
    ],
  });
  if (!result) return;
  try {
    if (result.team) {
      await postJson("/api/repertoires/share", {
        repertoire_id: repertoireId,
        team_id: result.team,
        visibility: "team",
      });
      const team = appState.teams.find((tm) => tm.id === result.team);
      setStatus(`Shared with ${team ? team.name : "team"}`);
    } else {
      await postJson("/api/repertoires/share", {
        repertoire_id: repertoireId,
        visibility: "private",
      });
      setStatus("Repertoire is now private");
    }
  } catch (error) {
    setStatusError(error.message);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

// `hint` is an on-demand tooltip on a number/text field's label; `onInput`
// (values, overlay) runs on open and on every change — e.g. to repaint a live
// note (a `note` field is addressable as [data-note="<name>"]).
function showInputModal({ title, fields, okLabel = "OK", onInput = null, cancel = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const fieldHtml = (field) => {
        const safeName = escapeHtml(field.name);
        const safeLabel = escapeHtml(field.label || field.name);
        const safeValue = escapeHtml(field.default == null ? "" : String(field.default));
        if (field.type === "note") {
          // Read-only informational line (no input, never collected).
          return `<p class="modal-note muted" data-note="${safeName}">${safeLabel}</p>`;
        }
        if (field.type === "textarea") {
          return `
            <label class="modal-field">
              <span>${safeLabel}</span>
              <textarea name="${safeName}" data-field>${safeValue}</textarea>
            </label>
          `;
        }
        if (field.type === "select") {
          const options = (field.options || [])
            .map((opt) => {
              const value = typeof opt === "string" ? opt : opt.value;
              const label = typeof opt === "string" ? opt : (opt.label || opt.value);
              const selected = String(field.default || "") === String(value) ? " selected" : "";
              return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
            })
            .join("");
          return `
            <label class="modal-field">
              <span>${safeLabel}</span>
              <select name="${safeName}" data-field>${options}</select>
            </label>
          `;
        }
        const inputType = field.type === "number" ? "number" : "text";
        const numericAttrs =
          field.type === "number"
            ? ` min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}"`
            : "";
        const hint = field.hint ? ` title="${escapeHtml(field.hint)}"` : "";
        return `
          <label class="modal-field"${hint}>
            <span>${safeLabel}</span>
            <input name="${safeName}" type="${inputType}" value="${safeValue}"${numericAttrs} data-field />
          </label>
        `;
    };
    const inputsHtml = fields.map(fieldHtml).join("");
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">${inputsHtml}</div>
        <div class="modal-footer">
          ${cancel ? '<button class="btn ghost" data-action="cancel" type="button">Cancel</button>' : ""}
          <button class="btn primary" data-action="ok" type="button">${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateModal(overlay);
    const firstInput = overlay.querySelector("[data-field]");
    if (firstInput) {
      firstInput.focus();
      if (firstInput.select) firstInput.select();
    }

    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    const close = (values) => {
      cleanup();
      resolve(values);
    };
    const collect = () => {
      const values = {};
      overlay.querySelectorAll("[data-field]").forEach((el) => {
        values[el.name] = el.value;
      });
      return values;
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      } else if (event.key === "Enter" && event.target.tagName !== "TEXTAREA") {
        event.preventDefault();
        close(collect());
      }
    };
    document.addEventListener("keydown", onKey);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="ok"]').addEventListener("click", () => close(collect()));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
    if (typeof onInput === "function") {
      const fire = () => {
        try {
          onInput(collect(), overlay);
        } catch (_) {
          /* a live hint must never break the form */
        }
      };
      overlay.addEventListener("input", fire);
      overlay.addEventListener("change", fire);
      fire();
    }
  });
}

function showConfirmModal({
  title,
  body,
  okLabel = "OK",
  cancelLabel = "Cancel",
  tone = "primary",
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const okClass = tone === "danger" ? "danger" : "primary";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">
          <p class="modal-copy">${escapeHtml(body)}</p>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">${escapeHtml(cancelLabel)}</button>
          <button class="btn ${okClass}" data-action="ok" type="button">${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateModal(overlay);
    const cancelBtn = overlay.querySelector('[data-action="cancel"]');
    const okBtn = overlay.querySelector('[data-action="ok"]');
    cancelBtn.focus();
    const cleanup = () => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    const close = (value) => {
      cleanup();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      } else if (event.key === "Enter" && document.activeElement === okBtn) {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("keydown", onKey);
    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
  });
}

function isBuildReadOnly() {
  return !!(
    appState.sharedToken || (appState.build && appState.build.writable === false)
  );
}

let buildLoadSeq = 0;
async function editRepertoire(repertoireId, nodeId = null) {
  // Picking a repertoire is navigation; its loading skeleton defers URL sync.
  workspaceNavigationSeq += 1;
  if (!workspaceUrlReady) navigatedDuringBoot = true;
  // Switching repertoires replaces the local Build tree — flush pending moves of
  // the current one first so they aren't dropped. An optional `nodeId` opens the
  // builder at that position (Analyze's "Open in Build" deep link).
  // The Repertoire view opens NOW with a skeleton; the tree fills in when the
  // load lands (it used to sit on the previous page for seconds).
  const loadSeq = ++buildLoadSeq;
  setBuildLoading(true);
  try {
    await hardFlushBuild();
  } catch (error) {
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false);
    setStatusError(error.message);
    return;
  }
  if (loadSeq !== buildLoadSeq) return;
  appState.sharedToken = null;
  try {
    const payload = await api(
      `/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`
    );
    if (loadSeq !== buildLoadSeq) return;
    const target = nodeId && payload.nodes.some((n) => n.id === nodeId) ? nodeId : null;
    await hydrateBuild(payload, target || payload.selected_node_id);
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false, { restore: false });
    appState.trainingRepertoireId = payload.repertoire_id;
    // The rail remains usable during loading; a response must not pull the
    // user back after they have navigated to another page.
    syncWorkspaceUrl();
    updateBuildReadOnlyUi(payload);
  } catch (error) {
    if (loadSeq !== buildLoadSeq) return;
    setBuildLoading(false);
    setStatusError(error.message);
  }
}

// Repertoire loading state: switch to the view (without touching the URL —
// the caller syncs it once the tree is in) and show a skeleton in place of the
// previous tree. Turning it off restores whatever is actually loaded.
function setBuildLoading(on, { restore = true } = {}) {
  appState.buildLoading = on;
  const view = document.getElementById("view-build");
  if (view) {
    view.inert = on;
    view.classList.toggle("is-loading", on);
    view.setAttribute("aria-busy", String(on));
  }
  if (!on) {
    if (!restore) return;
    const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
    if (node && boards.build) {
      const info = localBoardInfo(node.fen);
      boards.build.setPosition({ fen: node.fen, legalMoves: info.legal_moves, lastMove: node.uci });
    }
    renderBuildRepHeader();
    renderBuilderTree();
    syncViewHeads();
    return;
  }
  if (boards.build) {
    boards.build.setPosition({ fen: boards.build.fen, legalMoves: [], lastMove: null });
  }
  if (appState.currentView !== "build") switchView("build", { fromUrl: true });
  const empty = document.getElementById("build-empty");
  if (empty) empty.hidden = true;
  const nameEl = document.getElementById("build-rep-name");
  if (nameEl) nameEl.innerHTML = '<span class="skeleton-text">Loading repertoire…</span>';
  const stats = document.getElementById("build-rep-stats");
  if (stats) stats.hidden = true;
  const meta = document.getElementById("build-tree-meta");
  if (meta) meta.innerHTML = "";
  const tree = document.getElementById("builder-tree");
  if (tree) {
    tree.innerHTML =
      '<div class="tree-skeleton" role="status" aria-label="Loading repertoire">' +
      [72, 56, 84, 48, 64, 40].map((w) => `<span style="width:${w}%"></span>`).join("") +
      "</div>";
  }
}

function updateBuildReadOnlyUi(payload) {
  if (appState.sharedToken) return;
  if (payload.writable === false) {
    renderReadOnlyBanner(payload);
    setStatus(`Viewing shared repertoire "${payload.name}" (read-only)`);
  } else {
    removeReadOnlyBanner();
    setStatus(`Editing ${payload.name}`);
  }
  syncCoverageReadOnlyState();
}

function removeReadOnlyBanner() {
  const banner = document.getElementById("shared-banner");
  if (banner) banner.hidden = true;
  syncCoverageReadOnlyState();
  syncViewHeads();
}

function syncCoverageReadOnlyState() {
  coverageView?.sync();
}

async function trainRepertoire(repertoireId, options = {}) {
  // Training reads the server's repertoire tree — make sure any pending Build edits
  // are persisted before we leave the builder.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  appState.trainingRepertoireId = repertoireId;
  switchView("train");
  await startTraining(options.targetNodeIds?.length ? "smart" : undefined, {
    ...options, repertoireId,
  });
}

let repertoireMenuOpener = null;
let repertoireMenuOpenerId = null;

function openRepertoireContextMenu(event, repertoireId, isActive) {
  event.preventDefault();
  const menu = document.getElementById("repertoire-context-menu");
  closeRepertoireContextMenu(false);
  repertoireMenuOpener = event.currentTarget || document.activeElement;
  repertoireMenuOpenerId = repertoireId;
  repertoireMenuOpener?.setAttribute("aria-expanded", "true");
  const safeId = escapeHtml(repertoireId);
  const items = [
    ["train", "Start training"],
    ["edit", "Open in Repertoire"],
    ["rename", "Rename..."],
    ["share-link", "Share link..."],
    ["share-team", "Share with team..."],
    ["toggle-active", isActive ? "Disable" : "Enable"],
    ["delete", "Delete..."],
  ];
  menu.innerHTML = items
    .map(
      ([action, label]) =>
        `<button type="button" role="menuitem" tabindex="-1" data-action="${escapeHtml(action)}" data-repertoire-id="${safeId}">${escapeHtml(label)}</button>`
    )
    .join("");
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  // From the ⋯ button: drop down under it, right edges aligned, so the menu stays
  // over the row instead of running past the card. A right-click opens at the cursor.
  const opener = event.type === "contextmenu" ? null : event.currentTarget;
  const anchor = opener && opener.getBoundingClientRect ? opener.getBoundingClientRect() : null;
  const wantLeft = anchor ? anchor.right - rect.width : event.clientX;
  const wantTop = anchor ? anchor.bottom + 4 : event.clientY;
  const left = Math.max(8, Math.min(wantLeft, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(wantTop, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () =>
      handleRepertoireContextAction(button.dataset.action, button.dataset.repertoireId, isActive)
    );
  });
  const buttons = [...menu.querySelectorAll("button")];
  menu.onkeydown = (event) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      closeRepertoireContextMenu();
    }
  };
  buttons[0]?.focus();
}

function closeRepertoireContextMenu(restoreFocus = true) {
  const menu = document.getElementById("repertoire-context-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  repertoireMenuOpener?.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    // A list re-render replaces the ⋯ button: find its successor by repertoire id.
    const target = repertoireMenuOpener?.isConnected
      ? repertoireMenuOpener
      : repertoireMenuOpenerId
        ? [...document.querySelectorAll("[data-row-menu]")].find((el) => el.dataset.rowMenu === repertoireMenuOpenerId)
        : null;
    target?.focus();
  }
  repertoireMenuOpener = null;
  repertoireMenuOpenerId = null;
}

async function fetchRepertoireMeta(repertoireId) {
  try {
    const payload = await api("/api/repertoires");
    return payload.repertoires.find((r) => r.id === repertoireId) || null;
  } catch (_) {
    return null;
  }
}

async function handleRepertoireContextAction(action, repertoireId, isActive) {
  closeRepertoireContextMenu();
  try {
    if (action === "train") {
      await trainRepertoire(repertoireId);
      return;
    }
    if (action === "edit") {
      await editRepertoire(repertoireId);
      return;
    }
    if (action === "rename") {
      const meta = await fetchRepertoireMeta(repertoireId);
      const result = await showInputModal({
        title: "Rename repertoire",
        okLabel: "Save",
        fields: [{ name: "name", label: "New name", default: meta?.name || "" }],
      });
      if (!result) return;
      const name = (result.name || "").trim();
      if (!name) {
        setStatus("Name is empty");
        return;
      }
      await postJson("/api/build/rename", { repertoire_id: repertoireId, name });
      await refreshDashboardRepertoires();
      setStatus(`Renamed to ${name}`);
      return;
    }
    if (action === "share-link") {
      const payload = await postJson("/api/repertoires/share-link", {
        repertoire_id: repertoireId,
      });
      const url = `${window.location.origin}${payload.url}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (_) {
        /* clipboard blocked — the modal below still shows the URL */
      }
      await showInputModal({
        title: copied ? "Share link copied!" : "Share link",
        okLabel: "Done",
        // Nothing to cancel: the link already exists.
        cancel: false,
        fields: [
          {
            name: "url",
            label: "View-only link",
            default: url,
          },
        ],
      });
      return;
    }
    if (action === "share-team") {
      await shareRepertoireWithTeam(repertoireId);
      return;
    }
    if (action === "toggle-active") {
      const verb = isActive ? "Disable" : "Enable";
      await postJson("/api/repertoires/set-active", {
        repertoire_id: repertoireId,
        active: !isActive,
      });
      invalidateBook(); // the active set defines Analyze's book
      await refreshDashboardRepertoires();
      setStatus(`${verb}d repertoire`);
      return;
    }
    if (action === "delete") {
      // Undo-toast model (no type-to-confirm): hide the repertoire everywhere
      // immediately; the server delete only fires once the undo window closes.
      const repKey = String(repertoireId);
      if (appState.pendingRepDeletes.has(repKey)) return;
      const meta = await fetchRepertoireMeta(repertoireId).catch(() => null);
      appState.pendingRepDeletes.add(repKey);
      invalidateBook();
      if (appState.build && String(appState.build.repertoire_id) === repKey) {
        // Drop any local-first sync state — flushing into a deleted rep is pointless
        // and a pending timer would fire against a now-null tree. This happens at
        // delete time (not commit time) so the doomed tree can't keep taking edits.
        clearTimeout(appState.buildFlushTimer);
        appState.buildFlushTimer = null;
        appState.buildPending = [];
        appState.buildPendingDeletes = [];
        appState.buildUndoDeletes = new Set();
        appState.buildUndoCommitByMove = new Map();
        appState.buildIdMap = {};
        appState.buildSyncState = "saved";
        appState.build = null;
        appState.buildNodeById = new Map();
        appState.buildCurrentNodeId = null;
        renderBuilderTree();
        renderBuildSync();
        document.getElementById("build-board-label").textContent = "No repertoire";
      }
      if (String(appState.trainingRepertoireId) === repKey) {
        appState.trainingRepertoireId = null;
      }
      await refreshDashboardRepertoires();
      showUndoToast({
        title: "Repertoire deleted",
        message: `"${meta?.name || "Repertoire"}" and every move in it will be removed.`,
        onUndo: () => {
          appState.pendingRepDeletes.delete(repKey);
          setStatus("Delete undone");
          refreshDashboardRepertoires();
        },
        onCommit: () => {
          // keepalive so a commit forced by beforeunload still reaches the server.
          const token = readCsrfCookie();
          fetch("/api/repertoires/delete", {
            method: "POST",
            credentials: "same-origin",
            keepalive: true,
            headers: {
              "Content-Type": "application/json",
              ...(token ? { [CSRF_HEADER]: token } : {}),
            },
            body: JSON.stringify({ repertoire_id: repertoireId }),
          })
            .then((response) => {
              appState.pendingRepDeletes.delete(repKey);
              if (!response.ok) {
                setStatus("Delete failed — repertoire restored", { severity: "error" });
                refreshDashboardRepertoires();
              }
            })
            .catch(() => {
              appState.pendingRepDeletes.delete(repKey);
              refreshDashboardRepertoires();
            });
        },
      });
      return;
    }
  } catch (error) {
    setStatusError(error.message);
  }
}

async function runAnalysis(options = {}) {
  // Phase 2: whole-game analysis runs in the browser. The server only parses
  // the PGN (/api/analyze/prepare) and classifies + saves the browser-computed
  // evals (/api/analyze/classify-save) — it never runs an engine.
  //
  // F-04: `options.mode` is "single" (default — a multi-game paste is
  // rejected BEFORE anything is stored) or "multi" (every game is imported
  // with per-game status and `options.selectIndex` names the analyzed one).
  const importMode = options.mode === "multi" ? "multi" : "single";
  const selectIndex = Number(options.selectIndex) || 0;
  if (!isBrowserEngineAvailable()) {
    setStatusError(BROWSER_ENGINE_UNAVAILABLE);
    return;
  }
  const pgn = document.getElementById("pgn-input").value.trim();
  if (!pgn) {
    setStatus("Paste PGN before analyzing");
    return;
  }
  if (jobToast.isBusy()) {
    setStatus("Another job is already running");
    return;
  }
  // Whole-game review needs an account: the server imports the PGN and
  // classifies + stores the browser's evals (/api/analyze/prepare and
  // classify-save are owner-scoped). Live engine + coach on the board work
  // signed out.
  if (!requireSignIn("Sign in to run a full-game review — it's saved to your library", "analyze-game", {
    pgn, mode: importMode, selectIndex,
  })) return;
  const seq = invalidateAnalysisSource();
  const analysisOwnerId = currentOwnerId();
  // Keep the game on screen while the engine works: (re)load the source into the move
  // list instead of hiding it behind the "Play on the board" placeholder. Only a source
  // that won't parse here (e.g. a multi-game paste) falls back to hiding the old list.
  appState.analysisSourcePgn = null;
  hideAnalysisHandoff();
  const listed = await loadPgnIntoAnalyze(pgn, { goToEnd: false, quiet: true, sourceSeq: seq }).catch(() => false);
  if (seq !== analysisRecallSeq || analysisOwnerId !== currentOwnerId()) return;
  if (!listed) hideAnalysisResults();
  const runButton = document.getElementById("run-analysis");
  runButton.disabled = true;
  // Lifecycle origin for the timing marks below (click → stockfish/maia starts).
  const tAnalyze = engineLifecycleMark("analyze-click");

  let cancelled = false;
  // F-04: when the device refuses the checkpoint, the retry copy is built from
  // these (declared out here so the catch block can reach them).
  let inMemoryCheckpoint = null;
  let completedCheckpoint = null;
  const jobId = `browser-analysis-${Date.now()}`;
  try {
    let prep;
    try {
      prep = await postJson("/api/analyze/prepare", {
        pgn,
        mode: importMode,
        select_index: selectIndex,
      });
    } catch (prepError) {
      if (seq !== analysisRecallSeq || analysisOwnerId !== currentOwnerId()) return;
      // F-04: single mode refuses multi-game pastes BEFORE storing anything.
      // Offer the batch path explicitly instead of silently importing extras.
      if (prepError.status === 400 && /games in the PGN/i.test(prepError.message || "")) {
        const go = await showConfirmModal({
          title: "Multiple games in this PGN",
          body: `${prepError.message} Analyze them as a batch instead? You can pick which game to analyze.`,
          okLabel: "Analyze batch",
          cancelLabel: "Cancel",
        });
        runButton.disabled = false;
        if (go) void runAnalysis({ mode: "multi" });
        else setStatus("Nothing was imported");
        return;
      }
      throw prepError;
    }
    if (seq !== analysisRecallSeq || analysisOwnerId !== currentOwnerId()) return;
    const positions = prep.positions || [];
    if (!positions.length) throw new Error("No positions to analyze");
    renderImportPicker(prep.import_summary, importMode);

    // Phase instrumentation: each pipeline stage reports through one `timed`
    // wrapper so the toast label always names the work actually running (the
    // old "classifying" label covered Maia inference + classify-save +
    // render). Stages: load, stockfish, maia-load, maia-inference (+ trap
    // detail), classifying (CPU), saving analysis (DB, from the server's
    // server_timings_ms), rendering. Durations accumulate into `timings` and
    // log once as [analyze-timings] — deterministic phase attribution, no ms
    // thresholds.
    const timings = {};
    const timed = async (phase, fn) => {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        timings[`${phase}_ms`] = Math.round((timings[`${phase}_ms`] || 0) + (performance.now() - start));
      }
    };

    jobToast.startJob({
      id: jobId,
      title: "Analyzing game",
      tab: "analyze",
      // Docked in the Analyze panel (above the eval card) rather than floating
      // bottom-right, where it covered the right half of the eval graph.
      dock: document.getElementById("analysis-job-dock"),
      total: positions.length,
      onCancel: () => {
        cancelled = true;
      },
    });

    // Start the shared Maia init (worker spawn + weight fetch + ORT session) NOW,
    // in parallel with the Stockfish pass below — but only when this run can
    // actually use Maia signals. The Stockfish, classification and inference
    // algorithms are untouched; the Maia phase still awaits the same shared
    // ready promise, so inference simply finds a warm provider more often.
    const wantsMaia =
      maiaAnalysisEnabled() &&
      prep.brilliant &&
      prep.brilliant.enabled &&
      Array.isArray(prep.moves) &&
      prep.moves.length > 0;
    // Null-safe: warmup() only rejects on init failure, which the Maia phase
    // below retries through predictions(), exactly as before.
    const maiaReady = wantsMaia ? getSharedMaia3Provider().warmup() : null;
    if (wantsMaia) engineLifecycleMark("analyze-maia-init-start", tAnalyze);
    engineLifecycleMark("analyze-stockfish-start", tAnalyze);
    // Dedicated full-speed workers; positions the store already answers at this depth
    // are reused, and each result is published for the Engine panel and the Coach.
    const store = await timed("load", analysisStore);
    const live = (await ensureAnalyzeView()).liveEvalChart(positions);
    // Every job update also drives the live graph's animation for that phase.
    const job = (update) => {
      live.phase?.(update.phase, update.current, update.total);
      jobToast.updateJob(update);
    };
    // The Maia pass streams alongside Stockfish: every finished eval goes to the assessor,
    // which assesses a move as soon as both of its positions are known, so most of the Maia
    // work is done by the time the last Stockfish search lands.
    const shouldCancel = () => cancelled || analysisOwnerId !== currentOwnerId();
    let assessor = null;
    const pendingEvals = [];
    const assessorReady = wantsMaia
      ? (_coachReady || preloadCoach())
          .then((c) => {
            assessor = c.createBrilliantAssessor({
              moves: prep.moves,
              depth: prep.depth,
              rating: effectiveMaiaRating(),
              provider: getSharedMaia3Provider(),
              analyzeFn: (o) => store.analyzeGame(o),
              shouldCancel,
              onPhase: ({ phase: sub, detail }) => {
                timings[`maia_${sub}`] = detail || 1;
              },
              onProgress: (done, total) =>
                job({ current: done, total, phase: "maia-inference", message: `Maia ${done}/${total} moves` }),
              onTrapProgress: (done, total) =>
                job({ current: done, total, phase: "maia-traps", message: `Maia traps ${done}/${total}` }),
            });
            for (const [fen, ev] of pendingEvals.splice(0)) assessor.push(fen, ev);
            return assessor;
          })
          .catch(() => null)
      : null;
    // Two tiers (engine/tiered-analysis.js): every position at a screen depth, then the full
    // depth only where a grade could hinge on it. The Maia pass streams the reads that will
    // be saved.
    const { evals, screenDepth } = await timed("stockfish", () =>
      analyzeTiered({
        analyze: (o) => store.analyzeGame(o),
        positions,
        moves: prep.moves,
        depth: prep.depth,
        onResult: (fen, ev) => live(fen, ev),
        onFinal: (fen, ev) => {
          if (assessor) assessor.push(fen, ev);
          else if (wantsMaia) pendingEvals.push([fen, ev]);
        },
        onProgress: (done, total, stage) => {
          job({
            current: done,
            total,
            phase: "stockfish",
            message: stage === "screen" ? `Stockfish ${done}/${total} positions` : `Stockfish depth ${prep.depth} · ${done}/${total}`,
          });
        },
        shouldCancel,
      })
    );
    engineLifecycleMark("analyze-stockfish-done", tAnalyze);
    if (wantsMaia && maiaReady && typeof maiaReady.then === "function") {
      live.phase?.("maia-load");
      try {
        await maiaReady;
        engineLifecycleMark("analyze-maia-ready", tAnalyze);
      } catch (_) { /* init failure surfaces in the Maia phase, as before */ }
    }

    // Browser Maia pass (human probability / brilliant signals). Best-effort
    // so the server can persist them with no server compute. Skipped entirely
    // when Maia analysis is OFF — Stockfish classification runs either way.
    // Maia's ~46 MB model downloads once (then cached) when the pass runs;
    // progress shows in the toast. Any failure (no weights / inference error)
    // is swallowed → analysis without Maia signals, mirroring the server's
    // no-Maia path. Init and most of the inference already ran alongside
    // Stockfish above (the streaming assessor); this phase drains the rest and
    // runs the trap / gap batches on the same shared worker.
    let maiaAssessments = [];
    if (wantsMaia) {
      engineLifecycleMark("analyze-maia-phase-start", tAnalyze);
      try {
        const provider = getSharedMaia3Provider();
        const unsubscribeProgress = provider.subscribeInitProgress(({ phase, loaded, total }) => {
          if (phase === "download") {
            const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
            job({
              current: 0,
              total: 1,
              phase: "maia-load",
              message: `downloading Maia model · ${pct}%`,
            });
          } else if (phase === "cache") {
            job({
              current: 0,
              total: 1,
              phase: "maia-load",
              message: "loading Maia model from cache",
            });
          } else if (phase === "verify" || phase === "session") {
            // Cached weights still need an ORT session rebuild (the slow part). Say so, rather
            // than leaving the stale "downloading" message up — that's what made a cached
            // re-init (after an idle teardown) look like a fresh 46 MB download.
            job({
              current: 0,
              total: 1,
              phase: "maia-load",
              message: "preparing Maia engine…",
            });
          }
        });
        try {
          const ready = await timed("maia-load", () => assessorReady);
          if (!ready) throw new Error("Coach bundle unavailable");
          maiaAssessments = await timed("maia-inference", () => ready.finish(evals));
        } finally {
          unsubscribeProgress();
        }
      } catch (brilliantErr) {
        if (brilliantErr && brilliantErr.cancelled) throw brilliantErr;
        maiaAssessments = [];
      }
    }

    // Final cancellation checkpoint: even if eval/Maia work completed, a Stop that arrived
    // during it must prevent persistence. classify-save is the write — don't post past a Stop.
    if (cancelled) {
      const err = new Error("Analysis stopped");
      err.cancelled = true;
      throw err;
    }

    // Past this point we're persisting: server classify + local render. The
    // save is not cancellable, so remove the Stop affordance rather than
    // imply a cancel that wouldn't hold. Classifying (CPU) and saving (DB)
    // are separate phases — the server reports both in server_timings_ms.
    jobToast.lockJob();
    job({
      current: positions.length,
      total: positions.length,
      phase: "classifying",
      message: "Classifying moves",
    });
    // F-03: the engine/model compute is DONE — checkpoint it to the device so
    // a failed SAVE below never costs a re-analysis (retry = re-post only).
    // F-04: a refused write means the work lives only in THIS page — keep an
    // in-memory copy for Retry save and say so, instead of promising a
    // device-recoverable checkpoint that was never written.
    const checkpoint = {
      gameId: prep.game_id,
      requestId: crypto.randomUUID(),
      savedAt: Date.now(),
      ownerId: analysisOwnerId,
      engine: prep.engine || "stockfish (browser)",
      depth: prep.depth,
      screenDepth,
      positions,
      evals: [...evals.entries()],
      maiaAssessments,
      pgn,
    };
    completedCheckpoint = checkpoint;
    const checkpointStored = await saveCheckpoint({
      ...checkpoint,
      ownerId: analysisOwnerId,
      engine: prep.engine || "stockfish (browser)",
      depth: prep.depth,
    });
    if (!checkpointStored) inMemoryCheckpoint = { ...checkpoint, inMemoryOnly: true };
    if (analysisOwnerId !== currentOwnerId()) throw Object.assign(new Error("Account changed"), { cancelled: true });

    const payload = await timed("classify", () =>
      postJson("/api/analyze/classify-save", {
        game_id: prep.game_id,
        request_id: checkpoint.requestId,
        engine: prep.engine || "stockfish (browser)",
        depth: prep.depth,
        screen_depth: screenDepth,
        positions: positions.map((fen) => {
          const ev = evals.get(fen) || {};
          return {
            fen,
            score_cp: ev.score_cp ?? null,
            mate_in: ev.mate_in ?? null,
            best_move_uci: ev.best_move_uci ?? null,
            pv: ev.pv || [],
            // Actual depth reached (a timeout may have accepted a shallower
            // result) — the server stores this per position instead of the
            // requested `depth` above. `nodes` is the real search effort and
            // is part of the stored evaluation's identity.
            depth: ev.depth ?? null,
            nodes: ev.nodes ?? null,
          };
        }),
        maia_assessments: maiaAssessments,
      }).then((response) => {
        const server = response.server_timings_ms || {};
        for (const [key, value] of Object.entries(server)) {
          timings[`server_${key}`] = value;
        }
        if (server.save_game_ms != null || server.save_analysis_ms != null) {
          jobToast.updateJob({
            current: positions.length,
            total: positions.length,
            phase: "saving",
            message: "Saving analysis",
          });
        }
        return response;
      })
    );

    await finishAnalyzeCheckpoint(inMemoryCheckpoint || checkpoint);
    if (analysisOwnerId !== currentOwnerId()) throw Object.assign(new Error("Account changed"), { cancelled: true });
    refreshAnalysisHistoryIfOpen();
    const complete = (current = false) => jobToast.completeJob({
      title: current ? "Analysis ready" : "Analysis saved",
      message: `${payload.moves.length} plies classified`,
      onClick: current ? () => switchView("analyze") : null,
    });
    if (seq !== analysisRecallSeq || analysisOwnerId !== currentOwnerId()) {
      complete();
      return;
    }
    appState.analysis = payload;
    resetAnalysisVariations();
    await showAnalysisPly(0);
    await timed("render", () => renderAnalysis(payload, { sourceSeq: seq }));
    if (seq !== analysisRecallSeq || analysisOwnerId !== currentOwnerId()) {
      complete();
      return;
    }
    jobToast.updateJob({
      current: positions.length,
      total: positions.length,
      phase: "rendering",
      message: "rendering",
    });
    try {
      // eslint-disable-next-line no-console
      console.debug("[analyze-timings]", timings);
    } catch (_) {
      /* logging only */
    }
    setStatus(`Analysis ready: ${payload.moves.length} plies`, { severity: "success" });
    complete(true);
    appState.analysisSourcePgn = pgn;
    revealAnalysisResults();
    // The source has done its job — fold it away so the report gets the room.
    const pgnDrawer = document.getElementById("pgn-drawer");
    if (pgnDrawer) pgnDrawer.open = false;
    await updateAnalysisHandoff();
  } catch (error) {
    const current = seq === analysisRecallSeq && analysisOwnerId === currentOwnerId();
    if (error && error.cancelled) {
      if (current) {
        appState.analysisSourcePgn = null;
        hideAnalysisHandoff();
        setStatus("Analysis stopped");
      }
      jobToast.cancelJob(error.message || "Analysis stopped");
    } else if (isAuthError(error)) {
      if (current) accountService().handleAuthRequired("Sign in to run a full-game review — it's saved to your library");
      jobToast.failJob("Sign in required");
    } else {
      if (current) setStatusError(error.message);
      jobToast.failJob(error.message);
    }
    // F-03: if the compute finished but the SAVE didn't, offer "Retry save" —
    // the checkpoint holds the evals, so a retry never re-runs the engine.
    const checkpoint = current && (inMemoryCheckpoint || completedCheckpoint);
    if (checkpoint?.serverSaved) { await refreshAnalyzeRecovery(); return; }
    if (checkpoint && checkpoint.gameId && seq === analysisRecallSeq && analysisOwnerId === currentOwnerId()) {
      // Keep the in-memory-only variant reachable for Retry save — the device
      // copy doesn't exist in that case.
      appState.analysisUnsavedCheckpoint = checkpoint.inMemoryOnly ? checkpoint : null;
      showAnalysisRetrySave(checkpoint, error.message);
    }
  } finally {
    runButton.disabled = false;
  }
}

// F-04: after a batch import, name what was stored and which game is being
// analyzed, and let the user switch to another imported game.
function renderImportPicker(summary, mode) {
  const host = document.getElementById("analysis-import-picker");
  if (!host) return;
  if (!summary || mode !== "multi" || summary.total_games <= 1) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const games = summary.games || [];
  const label = (g) =>
    `Game ${g.index + 1}: ${g.white || "?"} vs ${g.black || "?"} — ${g.status}${g.error ? ` (${g.error})` : ""}`;
  host.hidden = false;
  host.innerHTML =
    `<span class="import-summary">${summary.imported_count} new · ${summary.existing_count} already present · ${summary.failed_count} failed of ${summary.total_games}</span>` +
    `<select id="analysis-import-select" aria-label="Choose analyzed game">` +
    games
      .map(
        (g) =>
          `<option value="${g.index}"${g.index === summary.selected_index ? " selected" : ""}${
            g.status === "failed" ? " disabled" : ""
          }>${escapeHtml(label(g))}</option>`,
      )
      .join("") +
    `</select>`;
  const select = host.querySelector("#analysis-import-select");
  if (select) {
    select.addEventListener("change", () => {
      void runAnalysis({ mode: "multi", selectIndex: Number(select.value) });
    });
  }
  setStatus(
    `Imported ${summary.imported_count} new, ${summary.existing_count} already present, ${summary.failed_count} failed — analyzing game ${summary.selected_index + 1}.`,
  );
}

// F-03: "Retry save" affordance for a finished-but-unsaved analysis.
function showAnalysisRetrySave(checkpoint, message) {
  appState.analysisRetryCheckpoint = checkpoint;
  const bar = document.getElementById("analysis-retry-save");
  if (!bar) return;
  const text = document.getElementById("analysis-retry-save-text");
  if (text) {
    const white = checkpoint.pgn?.match(/\[White "([^"\n]*)"\]/)?.[1];
    const black = checkpoint.pgn?.match(/\[Black "([^"\n]*)"\]/)?.[1];
    const game = white || black ? `${white || "?"} vs ${black || "?"}` : checkpoint.gameId;
    text.textContent = checkpoint.serverSaved
      ? `${game} ? Analysis saved. Device cleanup failed ? retry cleanup.`
      : `${game} ? ${message || "Unsaved analysis"} ? ${checkpoint.inMemoryOnly ? "Kept in this page only" : "Kept on this device"}`;
  }
  const button = document.getElementById("analysis-retry-save-btn");
  if (button) button.textContent = checkpoint.serverSaved ? "Retry cleanup" : "Retry save";
  bar.hidden = false;
}

function hideAnalysisRetrySave() {
  const bar = document.getElementById("analysis-retry-save");
  if (bar) bar.hidden = true;
}

async function refreshAnalyzeRecovery() {
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const seq = appState.analysisRecoverySeq = (appState.analysisRecoverySeq || 0) + 1;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration && seq === appState.analysisRecoverySeq;
  let checkpoint = appState.analysisUnsavedCheckpoint?.ownerId === owner ? appState.analysisUnsavedCheckpoint : await loadCheckpoint(null, owner);
  while (checkpoint && isCurrent()) {
    if (!checkpoint.serverSaved && !checkpoint.inMemoryOnly) {
      try {
        const status = await api(`/api/analyses/${encodeURIComponent(checkpoint.gameId)}/saves/${encodeURIComponent(checkpoint.requestId)}/status`);
        if (!isCurrent()) return;
        checkpoint.serverSaved = status.saved;
      } catch (error) {
        if (isCurrent()) showAnalysisRetrySave(checkpoint, `Save status unconfirmed: ${error.message}`);
        return;
      }
    }
    if (checkpoint.serverSaved) {
      if (!await clearCheckpoint(checkpoint.gameId, owner, checkpoint.requestId)) {
        if (isCurrent()) showAnalysisRetrySave(checkpoint);
        return;
      }
      if (!isCurrent()) return;
      checkpoint = await loadCheckpoint(null, owner);
    } else {
      showAnalysisRetrySave(checkpoint);
      return;
    }
  }
  if (isCurrent()) {
    appState.analysisRetryCheckpoint = null;
    hideAnalysisRetrySave();
  }
}

async function finishAnalyzeCheckpoint(checkpoint) {
  checkpoint.serverSaved = true;
  // Record confirmation separately; if storage is unavailable, recovery checks
  // the server's request receipt before describing the work as unsaved.
  if (!checkpoint.inMemoryOnly) await markCheckpointSaved(checkpoint.gameId, checkpoint.ownerId, checkpoint.requestId);
  const cleared = checkpoint.inMemoryOnly || await clearCheckpoint(checkpoint.gameId, checkpoint.ownerId, checkpoint.requestId);
  if (checkpoint.ownerId !== currentOwnerId()) return;
  if (appState.analysisUnsavedCheckpoint === checkpoint) appState.analysisUnsavedCheckpoint = null;
  if (!cleared) { showAnalysisRetrySave(checkpoint); return; }
  if (appState.analysisRetryCheckpoint === checkpoint) appState.analysisRetryCheckpoint = null;
  await refreshAnalyzeRecovery();
}

async function discardAnalyzeCheckpoint() {
  if (appState.analysisSaveInFlight) return;
  const checkpoint = appState.analysisRetryCheckpoint;
  if (!checkpoint || checkpoint.ownerId !== currentOwnerId()) return;
  if (!checkpoint.inMemoryOnly && !await clearCheckpoint(checkpoint.gameId, checkpoint.ownerId, checkpoint.requestId)) {
    setStatusError("Could not discard analysis: try again");
    return;
  }
  if (checkpoint.ownerId !== currentOwnerId()) return;
  if (appState.analysisUnsavedCheckpoint === checkpoint) appState.analysisUnsavedCheckpoint = null;
  if (appState.analysisRetryCheckpoint !== checkpoint) return;
  appState.analysisRetryCheckpoint = null;
  await refreshAnalyzeRecovery();
  setStatus(checkpoint.serverSaved ? "Device copy removed" : "Discarded unsaved analysis");
}

// Re-post classify-save from the checkpoint — engine/model work is NOT redone.
async function retryAnalyzeSave() {
  if (appState.analysisSaveInFlight) return;
  appState.analysisSaveInFlight = true;
  // Owner-scoped: this only ever retries work saved under the CURRENT account.
  const ownerId = currentOwnerId();
  const checkpoint = [appState.analysisRetryCheckpoint, appState.analysisUnsavedCheckpoint]
    .find((candidate) => candidate?.ownerId === ownerId) || await loadCheckpoint(null, ownerId);
  if (!checkpoint || !checkpoint.gameId || ownerId !== currentOwnerId()) {
    appState.analysisSaveInFlight = false;
    hideAnalysisRetrySave();
    return;
  }
  const retryButton = document.getElementById("analysis-retry-save-btn");
  if (retryButton) retryButton.disabled = true;
  const seq = invalidateAnalysisSource();
  const runButton = document.getElementById("run-analysis");
  if (runButton) runButton.disabled = true;
  try {
    if (checkpoint.serverSaved) {
      await finishAnalyzeCheckpoint(checkpoint);
      return;
    }
    const evals = evalMapFrom(checkpoint);
    const payload = await postJson("/api/analyze/classify-save", {
      game_id: checkpoint.gameId,
      request_id: checkpoint.requestId,
      engine: checkpoint.engine || "stockfish (browser)",
      depth: checkpoint.depth,
      screen_depth: checkpoint.screenDepth ?? null,
      positions: (checkpoint.positions || []).map((fen) => {
        const ev = evals.get(fen) || {};
        return {
          fen,
          score_cp: ev.score_cp ?? null,
          mate_in: ev.mate_in ?? null,
          best_move_uci: ev.best_move_uci ?? null,
          pv: ev.pv || [],
          depth: ev.depth ?? null,
          nodes: ev.nodes ?? null,
        };
      }),
      maia_assessments: checkpoint.maiaAssessments || [],
    });
    await finishAnalyzeCheckpoint(checkpoint);
    if (ownerId !== currentOwnerId()) return;
    refreshAnalysisHistoryIfOpen();
    if (seq !== analysisRecallSeq || ownerId !== currentOwnerId()) return;
    const input = document.getElementById("pgn-input");
    if (input && checkpoint.pgn) input.value = checkpoint.pgn;
    appState.analysis = payload;
    resetAnalysisVariations();
    await showAnalysisPly(0);
    await renderAnalysis(payload, { sourceSeq: seq });
    if (seq !== analysisRecallSeq || ownerId !== currentOwnerId()) return;
    setStatus("Analysis saved", { severity: "success" });
    appState.analysisSourcePgn = checkpoint.pgn || appState.analysisSourcePgn;
    revealAnalysisResults();
    await updateAnalysisHandoff();
  } catch (error) {
    if (ownerId !== currentOwnerId()) return;
    if (checkpoint.serverSaved) { setStatusError(error.message); return; }
    if (isAuthError(error)) {
      accountService().handleAuthRequired("Sign in to save — the analysis stays on this device until you do");
    }
    showAnalysisRetrySave(checkpoint, error.message);
  } finally {
    appState.analysisSaveInFlight = false;
    if (retryButton) retryButton.disabled = false;
    if (runButton) runButton.disabled = false;
  }
}

function hideAnalysisHandoff() {
  const handoff = document.getElementById("analysis-handoff");
  if (handoff) handoff.hidden = true;
  const btn = document.getElementById("create-repertoire-from-game");
  if (btn) btn.disabled = false;
}

async function userHasAnyRepertoire() {
  try {
    const payload = await api("/api/repertoires");
    const visible = (payload.repertoires || []).filter(
      (item) => !appState.pendingRepDeletes.has(String(item.id)),
    );
    return visible.length > 0;
  } catch (_) {
    return true;
  }
}

async function updateAnalysisHandoff() {
  const handoff = document.getElementById("analysis-handoff");
  if (!handoff) return;
  const pgn = (appState.analysisSourcePgn || "").trim();
  const show =
    appState.signedIn && pgn.length > 0 && !(await userHasAnyRepertoire());
  handoff.hidden = !show;
}

async function onCreateRepertoireFromGameClick() {
  const pgn = (appState.analysisSourcePgn || "").trim();
  if (!pgn || !appState.signedIn) return;
  const btn = document.getElementById("create-repertoire-from-game");
  const meta = await showInputModal({
    title: "Turn this game into a repertoire",
    okLabel: "Create",
    fields: [
      { name: "name", label: "Repertoire name", default: defaultRepertoireNameFromPgn(pgn) },
      repertoireColorField("white"),
    ],
  });
  if (!meta) return;
  const name = (meta.name || "").trim() || "Imported game";
  const color = normalizeRepertoireColor(meta.color);
  if (btn) btn.disabled = true;
  try {
    const payload = await importRepertoireFromPgnText(pgn, { name, color });
    switchView("build");
    setStatus(`Repertoire “${payload.name}” created — edit it in Repertoire`, { severity: "success" });
    appState.analysisSourcePgn = null;
    hideAnalysisHandoff();
  } catch (error) {
    setStatusError(error.message || "Could not create repertoire — try again");
    if (btn) btn.disabled = false;
  }
}

function hideAnalysisResults() {
  const panel = document.getElementById("analysis-results");
  if (!panel) return;
  panel.classList.remove("is-visible");
  panel.hidden = true;
  appState.analysisSourcePgn = null;
  hideAnalysisHandoff();
  syncAnalysisEvalCard();
}

function revealAnalysisResults() {
  const panel = document.getElementById("analysis-results");
  if (!panel) return;
  panel.hidden = false;
  syncAnalysisEvalCard();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      panel.classList.add("is-visible");
      // Now that the chart has real dimensions, round out the key-moment dots.
      rescaleEvalMarkers();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let analyzeModule = null;
let analyzeView = null;
let moveTreeModule = null;
let moveTreeRenderer = null;
// Resolved once init() fully finishes (including restoreWorkspaceLocation).
// The E2E hooks await this so a seeded view isn't switched away mid-boot.
let appReadyPromise = null;

function preloadAnalyzeView() {
  if (!analyzeModule) {
    analyzeModule = import("./views/analyze.js").catch((err) => {
      analyzeModule = null;
      throw err;
    });
  }
  return analyzeModule;
}

async function ensureAnalyzeView() {
  const mod = await preloadAnalyzeView();
  if (!analyzeView) {
    analyzeView = mod.createAnalyzeView({
      appState,
      escapeHtml,
      START_FEN,
      showAnalysisPly,
      selectAnalysisNode,
      revealAnalysisResults,
      onEvalChartRendered: () => syncAnalysisEvalCard(),
    });
  }
  return analyzeView;
}

function preloadMoveTreeRenderer() {
  if (!moveTreeModule) {
    moveTreeModule = import("./views/shared/movetree.js").catch((err) => {
      moveTreeModule = null;
      throw err;
    });
  }
  return moveTreeModule;
}

async function ensureMoveTreeRenderer() {
  const mod = await preloadMoveTreeRenderer();
  if (!moveTreeRenderer) {
    moveTreeRenderer = mod.createMoveTreeRenderer({ escapeHtml });
  }
  return moveTreeRenderer;
}

async function renderAnalysis(payload, { sourceSeq = analysisRecallSeq } = {}) {
  const view = await ensureAnalyzeView();
  if (sourceSeq !== analysisRecallSeq || appState.analysis !== payload) return;
  const rendered = view.renderAnalysis(payload);
  syncViewHeads();
  return rendered;
}

function analysisTreeHasContent(movesArg) {
  const moves = movesArg || (appState.analysis ? appState.analysis.moves : []);
  if (moves && moves.length) return true;
  return !!(appState.analysisVarNodes && appState.analysisVarNodes.size);
}

function renderAnalysisTreeEmptyState() {
  const container = document.getElementById("analysis-moves");
  if (!container) return;
  appState.analysisTree = null;
  container.innerHTML =
    '<div class="empty-state">Play on the board, or analyze a PGN.</div>';
}

function renderAnalysisTree(movesArg) {
  if (!analysisTreeHasContent(movesArg)) {
    renderAnalysisTreeEmptyState();
    return;
  }
  if (analyzeView) return analyzeView.renderAnalysisTree(movesArg);
  void ensureAnalyzeView()
    .then((view) => view.renderAnalysisTree(movesArg))
    .catch(() => {});
}

function rescaleEvalMarkers() {
  if (analyzeView) return analyzeView.rescaleEvalMarkers();
  void ensureAnalyzeView().then((view) => view.rescaleEvalMarkers()).catch(() => {});
}

function updateEvalChartCursor() {
  if (analyzeView) return analyzeView.updateEvalChartCursor();
  void ensureAnalyzeView().then((view) => view.updateEvalChartCursor()).catch(() => {});
}

async function showAnalysisPly(ply) {
  const analysis = appState.analysis;
  const seq = analysisRecallSeq;
  const moves = appState.analysis ? appState.analysis.moves : [];
  const boundedPly = Math.max(0, Math.min(ply, moves.length));
  appState.analysisPly = boundedPly;
  syncWorkspaceUrl();
  appState.analysisCurrentNodeId = boundedPly === 0 ? "root" : `m${boundedPly}`;
  const move = boundedPly > 0 ? moves[boundedPly - 1] : null;
  const fen = move ? move.fen_after : moves[0]?.fen_before || appState.analysis?.initialFen || START_FEN;
  const info = await boardInfo(fen);
  if (seq !== analysisRecallSeq || analysis !== appState.analysis || appState.analysisCurrentNodeId !== (boundedPly === 0 ? "root" : `m${boundedPly}`)) return;
  appState.analysisBoardFen = fen;
  boards.analysis.setPosition({
    fen,
    legalMoves: info.legal_moves,
    lastMove: move ? move.uci : null,
  });
  // Only an analysed move gets a badge; an unclassified one (a pasted PGN, a game sent
  // from Train) shows none instead of an empty placeholder dot.
  const badge = move && move.classification ? classBadgeSymbol(move.classification) : "";
  boards.analysis.setMoveBadge(badge ? move.uci.slice(2, 4) : null, badge ? move.classification : null, badge);
  document.getElementById("analysis-board-label").textContent = move
    ? `${move.move_number}${move.side === "black" ? "..." : "."} ${move.san}`
    : "Initial position";
  highlightCurrentMove();
  syncViewHeads();
  refreshAnalysisExplain({
    fen,
    lastUci: move ? move.uci : null,
    lastSan: move ? move.san : null,
    prevFen: move ? move.fen_before : null,
    // Mainline ply (1-based) so the coach can resolve the saved verdict by index rather than
    // by fen-key. Omitted for the initial position (no move); variations pass no ply.
    ply: move ? boundedPly : null,
  });
  if (engineWidget) engineWidget.onBoardChanged();
}

// Tree-aware Analyze navigation (start/prev/next/end). Works for both the analysed
// mainline and free-exploration variations, because it walks the live node tree by
// id rather than a flat ply index. `next` follows the mainline child (children[0]).
async function analysisTreeNav(kind) {
  const view = await ensureAnalyzeView();
  const tree =
    appState.analysisTree ||
    view.buildAnalysisTree(appState.analysis ? appState.analysis.moves : []);
  appState.analysisTree = tree;
  let node = tree.byId.get(appState.analysisCurrentNodeId || "root") || tree.root;
  if (kind === "start") node = tree.root;
  else if (kind === "prev") node = node.parent || node;
  else if (kind === "next") node = (node.children && node.children[0]) || node;
  else if (kind === "end") {
    while (node.children && node.children[0]) node = node.children[0];
  }
  await selectAnalysisNode(node.id);
}

function resetAnalysisVariations() {
  appState.analysisVarNodes = new Map();
  appState.analysisVarCounter = 0;
  appState.analysisCurrentNodeId = "root";
  appState.analysisTree = null;
}

// ----- Analyze PGN ↔ move-list two-way sync ------------------------------------
// The PGN drawer and the move list are two views of one game. Typing legal moves
// into the PGN box rebuilds the move list (and drives the board); playing moves on
// the board (or stepping into variations) rewrites the PGN box. The two directions
// are event-driven and guarded against feedback loops:
//   • board / move-list → PGN  : syncPgnFromTree() — skipped while the textarea is
//     focused, so a user mid-edit is never clobbered.
//   • PGN box → board / list   : loadPgnIntoAnalyze() — fired (debounced) on the
//     textarea `input` event and called directly by every importer.
// A plain typed/pasted game carries no engine classifications, so its move list
// shows neutral dots and an empty eval chart until the user presses Analyze.
let analyzePgnInputTimer = null;
// True only while we programmatically rewrite #pgn-input from the tree, so the
// defensive guard below can tell our own writes from user edits. (Assigning
// `.value` does not fire `input`, so this is belt-and-suspenders.)
let analyzePgnWriting = false;

// Board / move-list → PGN box. Serialize the current Analyze tree (analyzed or
// typed mainline + explored variations) and write it back, preserving the header
// block. No-op while the textarea is focused (board moves happen with the board
// focused, so this only fires when it's safe).
async function syncPgnFromTree() {
  const input = document.getElementById("pgn-input");
  if (!input || document.activeElement === input) return;
  const analysis = appState.analysis;
  const seq = analysisRecallSeq;
  const original = input.value;
  const moves = analysis ? analysis.moves : [];
  const hasVars = appState.analysisVarNodes && appState.analysisVarNodes.size;
  if ((!moves || !moves.length) && !hasVars) return;
  const view = await ensureAnalyzeView();
  if (seq !== analysisRecallSeq || input.value !== original || document.activeElement === input) return;
  const next = view.serializeAnalysisPgn(input.value);
  if (!next) return;
  if (next !== input.value && document.activeElement !== input) {
    analyzePgnWriting = true;
    input.value = next;
    analyzePgnWriting = false;
  }
}

// PGN box → board / move list. Parse the text and rebuild the Analyze move tree
// (mainline + variations) from it. Returns false (and, unless quiet, sets a status
// hint) when the movetext has an illegal/unparseable move — leaving the existing
// tree untouched so mid-typing never flickers the list to empty.
async function loadPgnIntoAnalyze(pgnText, { goToEnd = true, quiet = false, sourceSeq = invalidateAnalysisSource() } = {}) {
  const parsed = parsePgn(pgnText);
  if (!parsed.ok) {
    if (!quiet) setStatus(`PGN: ${parsed.error}`, { severity: "error" });
    return false;
  }
  const view = await ensureAnalyzeView();
  if (sourceSeq !== analysisRecallSeq) return false;
  const { moves, varNodes } = view.adaptParsedTree(parsed.root);
  if (!moves.length && !varNodes.size) {
    // Check for FEN-only PGN (has FEN header but no moves)
    const fenHeader = parsed.headers.FEN;
    if (fenHeader) {
      try {
        // FEN-only PGN: show the FEN position without any moves
        appState.analysis = { moves: [], eval_graph: [], engine: null, depth: null, initialFen: fenHeader };
        appState.analysisVarNodes = new Map();
        appState.analysisVarCounter = 0;
        appState.analysisCurrentNodeId = "root";
        appState.analysisTree = null;
        appState.analysisSourcePgn = null;
        view.renderAnalysisTree([]);
        view.renderEvalChart([]);
        view.renderClassificationBars([]);
        hideAnalysisHandoff();
        revealAnalysisResults();
        // Use the same guarded board path as a movetext PGN or recall.
        await showAnalysisPly(0);
        return true;
      } catch (err) {
        if (sourceSeq !== analysisRecallSeq) return false;
        // FEN is invalid or boardInfo failed; fall through to empty-box logic
        console.warn("Failed to load FEN-only PGN:", err);
      }
    }
    // Emptied box → clear the move list and eval chart, drop any analyzed game.
    appState.analysis = null;
    resetAnalysisVariations();
    appState.analysisPly = 0;
    renderAnalysisTreeEmptyState();
    view.renderEvalChart([]);
    view.renderClassificationBars([]);
    await showAnalysisPly(0);
    return true;
  }
  // A typed/edited game replaces any prior analysis (classifications are dropped
  // until the user re-runs Analyze). Synthetic payload keeps showAnalysisPly happy.
  appState.analysis = { moves, eval_graph: [], engine: null, depth: null };
  appState.analysisVarNodes = varNodes;
  appState.analysisVarCounter = varNodes.size;
  appState.analysisCurrentNodeId = "root";
  appState.analysisTree = null;
  appState.analysisSourcePgn = null;
  view.renderAnalysisTree(moves);
  view.renderEvalChart([]);
  view.renderClassificationBars([]);
  hideAnalysisHandoff();
  revealAnalysisResults();
  await showAnalysisPly(goToEnd ? moves.length : 0);
  return true;
}

// Highlight the active move + sync the eval-chart cursor. The list itself is
// re-rendered from appState.analysisCurrentNodeId so highlighting and variation
// structure can never drift apart.
function highlightCurrentMove() {
  renderAnalysisTree();
  updateEvalChartCursor();
}

// Board label for an off-mainline move. "· variation" only means something when there is
// a mainline to vary from — the first moves played on an empty board are just the game.
function analysisVariationLabel(moveNumber, side, san) {
  const base = `${moveNumber}${side === "black" ? "..." : "."} ${san}`;
  const hasMainline = !!(appState.analysis && appState.analysis.moves && appState.analysis.moves.length);
  return hasMainline ? `${base} · variation` : base;
}

async function selectAnalysisNode(nodeId) {
  const tree = appState.analysisTree;
  const node = tree ? tree.byId.get(nodeId) : null;
  if (!node) return;
  if (node.isMainline) {
    await showAnalysisPly(node.ply);
    return;
  }
  // Variation node: drive the board straight to its resulting position.
  appState.analysisCurrentNodeId = node.id;
  appState.analysisPly = -1;
  const fen = node.fenAfter;
  const info = await boardInfo(fen);
  appState.analysisBoardFen = fen;
  boards.analysis.setPosition({
    fen,
    legalMoves: info.legal_moves,
    lastMove: node.uci,
  });
  boards.analysis.setMoveBadge(null, null, "");
  document.getElementById("analysis-board-label").textContent = analysisVariationLabel(
    node.moveNumber,
    node.side,
    node.san,
  );
  highlightCurrentMove();
  refreshAnalysisExplain({ fen, lastUci: node.uci, lastSan: node.san, prevFen: node.fenBefore });
  if (engineWidget) engineWidget.onBoardChanged();
}

async function onAnalysisBoardMove(moveUci, fen) {
  try {
    const tree = appState.analysisTree;
    const currentId =
      appState.analysisCurrentNodeId ||
      (appState.analysisPly > 0 ? `m${appState.analysisPly}` : "root");
    const currentNode = tree ? tree.byId.get(currentId) : null;
    // Replaying the existing continuation (mainline or a known variation) just
    // steps forward instead of forking a duplicate line.
    if (currentNode) {
      const existing = currentNode.children.find((child) => child.uci === moveUci);
      if (existing) {
        await selectAnalysisNode(existing.id);
        return;
      }
    }
    // New move from here → record it as a study variation branching off the
    // current node.
    const payload = await boardAfterMove(fen, moveUci);
    const parts = fen.split(" ");
    const side = parts[1] === "b" ? "black" : "white";
    const moveNumber = Number(parts[5]) || 1;
    const seq = (appState.analysisVarCounter = (appState.analysisVarCounter || 0) + 1);
    const id = `v${seq}`;
    appState.analysisVarNodes.set(id, {
      id,
      seq,
      parentId: currentId,
      uci: moveUci,
      san: payload.move.san,
      fenBefore: fen,
      fenAfter: payload.board.fen,
      moveNumber,
      side,
    });
    appState.analysisCurrentNodeId = id;
    appState.analysisPly = -1;
    appState.analysisBoardFen = payload.board.fen;
    boards.analysis.setPosition({
      fen: payload.board.fen,
      legalMoves: payload.board.legal_moves,
      lastMove: moveUci,
    });
    boards.analysis.setMoveBadge(null, null, "");
    document.getElementById("analysis-board-label").textContent = analysisVariationLabel(
      moveNumber,
      side,
      payload.move.san,
    );
    highlightCurrentMove();
    refreshAnalysisExplain({
      fen: payload.board.fen,
      lastUci: moveUci,
      lastSan: payload.move.san,
      prevFen: fen,
    });
    if (engineWidget) engineWidget.onBoardChanged();
    // New branch on the board → mirror it into the PGN box.
    void syncPgnFromTree().catch(() => {});
  } catch (error) {
    setStatusError(error.message);
  }
}

function bindEvalChart() {
  // Chart interaction (click / hover tooltip / keyboard) lives with the chart
  // renderer in views/analyze.js (bound on first render); app.js only keeps the
  // viewport resize hook that rescales the key-moment markers.
  // Only a mounted Analyze chart has markers to rescale — a resize on any other
  // page must not pull the Analyze chunk (and its CSS) in.
  window.addEventListener("resize", () => {
    if (analyzeView) analyzeView.rescaleEvalMarkers();
  });
}

async function hydrateBuild(payload, selectedNodeId = null) {
  // Opening/switching to a DIFFERENT repertoire must not throw away local-first
  // sync state: callers hard-flush before switching, and anything still queued
  // (a restored queue, a flush that failed) is tagged with its target and kept
  // (R-02). A reconcile re-hydrate keeps the same id, so its pending queue +
  // id map survive — that's the load-bearing distinction for the in-flight case.
  const prevRepId = appState.build && appState.build.repertoire_id;
  if (payload.repertoire_id !== prevRepId) {
    clearTimeout(appState.buildFlushTimer);
    appState.buildFlushTimer = null;
    // R-02: opening a repertoire only changes what is DISPLAYED. Ops queued
    // for ANOTHER tree (restored after a reload, or left by a failed flush)
    // stay on the device for their own repertoire; ops for THIS tree are
    // re-applied onto the fresh payload below.
    // Stale undo windows from the old repertoire become no-ops (their commit
    // guards on repertoire id), but their ids must not prune the new tree.
    appState.buildUndoDeletes = new Set();
    appState.buildUndoCommitByMove = new Map();
    // buildIdMap is additive and tmp ids are tab-unique, so it stays: another
    // tree's queued children still need their parent translated.
    appState.buildSyncState = "saved";
    appState.buildSyncRetry = 0;
  }
  appState.build = payload;
  appState.buildNodeById = new Map(payload.nodes.map((node) => [node.id, node]));
  // Derived analysis must match this exact local tree, including optimistic edits.
  coverageView?.sync();
  invalidateBook();
  // Orient only when a repertoire opens — a reconcile re-hydrate after an
  // autosave must not undo the user's manual flip (or rebuild the grid mid-drag).
  if (boards.build && payload.repertoire_id !== prevRepId) {
    boards.build.setOrientation(payload.color === "black" ? "black" : "white");
  }
  renderBuildRepHeader();
  const nextNodeId = selectedNodeId || payload.selected_node_id || payload.nodes[0]?.id;
  await selectBuildNode(nextNodeId);
  // R-02: put this repertoire's unsynced local edits back onto the tree the
  // server just sent, and re-prune what is queued for deletion.
  reapplyPendingBuildNodes(
    appState.buildPending.filter((m) => buildOpMatchesRepertoire(m, payload.repertoire_id)),
    appState.buildIdMap,
  );
  reapplyPendingBuildDeletes();
  if (hasPendingBuildOpsFor(payload.repertoire_id)) {
    setBuildSync("dirty");
    scheduleBuildFlush();
  }
  renderBuildSync();
  syncWorkspaceUrl();
}

let buildModule = null;
let buildView = null;

function preloadBuildView() {
  if (!buildModule) {
    buildModule = import("./views/build.js").catch((err) => {
      buildModule = null;
      throw err;
    });
  }
  return buildModule;
}

async function ensureBuildView() {
  const mod = await preloadBuildView();
  if (!buildView) {
    buildView = mod.createBuildView({
      appState,
      escapeHtml,
      boards,
      getMoveTreeRenderer: () => moveTreeRenderer,
      ensureMoveTreeRenderer,
      selectBuildNode,
      openNodeContextMenu,
      buildBranchContext,
      onTreeRendered: syncViewHeads,
    });
  }
  return buildView;
}

// The sidebar's repertoire identity line: which repertoire is open and for which
// colour. The ⋯ button next to it carries the repertoire-scoped actions.
function renderBuildRepHeader() {
  const nameEl = document.getElementById("build-rep-name");
  if (!nameEl) return;
  const empty = document.getElementById("build-empty");
  if (empty) empty.hidden = !!appState.build;
  if (!appState.build) {
    nameEl.textContent = "No repertoire open";
    return;
  }
  if (buildView) return buildView.renderBuildRepHeader();
  void ensureBuildView().then((view) => view.renderBuildRepHeader()).catch(() => {});
}

// The ⋯ menu in the Repertoire header: the same repertoire actions as the
// Library row's ⋯ (minus "Open in Repertoire" — you are here), plus the
// page-only Export PGN and New repertoire. Reuses the shared context-menu
// element and the Library's action handler so the two menus cannot drift.
function buildMenuItems({ hasRep, isActive }) {
  return [
    ...(hasRep
      ? [
          ["train", "Start training"],
          ["build-rename", "Rename..."],
          ["build-export-pgn", "Export PGN"],
          ["share-link", "Share link..."],
          ["share-team", "Share with team..."],
          ["toggle-active", isActive ? "Disable" : "Enable"],
          ["delete", "Delete..."],
        ]
      : []),
    ["build-new-rep", "New repertoire..."],
  ];
}

function openBuildMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById("repertoire-context-menu");
  if (!menu) return;
  const hasRep = !!appState.build && !isBuildReadOnly();
  const repId = hasRep ? appState.build.repertoire_id : null;
  const meta = hasRep
    ? (appState.repertoireList || []).find((r) => String(r.id) === String(repId))
    : null;
  const isActive = !meta || meta.is_active !== false;
  const items = buildMenuItems({ hasRep, isActive });
  menu.innerHTML = items
    .map(
      ([action, label]) =>
        `<button type="button" data-action="${escapeHtml(action)}"${action === "build-new-rep" && hasRep ? ' class="menu-sep-before"' : ""}>${escapeHtml(label)}</button>`
    )
    .join("");
  menu.hidden = false;
  const anchor = event.currentTarget.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 8)}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async () => {
      closeRepertoireContextMenu();
      const action = button.dataset.action;
      if (action === "build-rename") await renameRepertoire();
      else if (action === "build-export-pgn") await exportBuild("pgn");
      else if (action === "build-new-rep") {
        await createRepertoirePrompt({ title: "New repertoire", defaultName: "New repertoire" });
      } else if (repId) {
        await handleRepertoireContextAction(action, repId, isActive);
      }
    });
  });
}

async function renameRepertoire() {
  if (!appState.build) {
    setStatus("Open a repertoire first");
    return;
  }
  const result = await showInputModal({
    title: "Rename repertoire",
    okLabel: "Save",
    fields: [{ name: "name", label: "New name", default: appState.build.name }],
  });
  if (!result) return;
  const name = (result.name || "").trim();
  if (!name) {
    setStatus("Name is empty");
    return;
  }
  try {
    const payload = await postJson("/api/build/rename", {
      repertoire_id: appState.build.repertoire_id,
      name,
    });
    await hydrateBuild(payload, appState.buildCurrentNodeId);
    setStatus(`Renamed to ${name}`);
  } catch (error) {
    setStatusError(error.message);
  }
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

async function selectBuildNode(nodeId) {
  if (!appState.buildNodeById.has(nodeId)) return;
  appState.buildCurrentNodeId = nodeId;
  // Landing on a position resets the fork pick to the mainline continuation.
  appState.buildBranchChoiceId = null;
  const node = appState.buildNodeById.get(nodeId);
  const info = await boardInfo(node.fen);
  boards.build.setPosition({
    fen: node.fen,
    legalMoves: info.legal_moves,
    lastMove: node.uci,
  });
  boards.build.setAnnotations(node.arrows || [], node.circles || []);
  const label =
    node.depth === 0
      ? `${appState.build.name} · ${appState.build.color}`
      : `${node.move_number}${node.move_side === "black" ? "..." : "."} ${node.san}`;
  document.getElementById("build-board-label").textContent = label;
  renderBuilderTree();
  if (engineWidget) engineWidget.onBoardChanged();
  scheduleExplorerRefresh();
}

// ----- Opening explorer (Build sidebar) ---------------------------------------
// Real-game stats for the current Build position, fetched straight from Lichess's
// public CORS-open explorer — the PrepForge server never proxies a byte. The
// module is dynamically imported on first open so its code stays out of the boot
// bundle; the client inside it handles caching, request dedup, and 429 cooldown
// (see explorer.js). Here we only debounce navigation and skip work while closed.

let explorerModule = null;
let explorerClient = null;
let explorerDb = "masters";
let explorerTimer = null;
let explorerSeq = 0;

function explorerDrawerOpen() {
  const panel = document.getElementById("explorer-drawer");
  return !!(panel && !panel.hidden && !buildDockFolded() && activeViewName() === "build");
}

const BUILD_DOCK_TABS = ["explorer", "coverage"];
let buildDockTab = "explorer";

// ---- Inspector dock: fold + drag-to-resize ---------------------------------
// The seam between the move tree and the inspector is a drag handle; the height
// (and whether the dock is folded down to its tab strip) is a per-browser
// layout convenience, so it lives in localStorage, never in synced prefs.
const BUILD_DOCK_HEIGHT_KEY = "pf.buildDock.height";
const BUILD_DOCK_FOLDED_KEY = "pf.buildDock.folded";
const BUILD_DOCK_MIN = 150; // tabs + tools row + a couple of Explorer rows
const BUILD_DOCK_TREE_MIN = 90; // matches .tree-wrap min-height

function buildDockFolded() {
  const dock = document.getElementById("build-inspector");
  return !!(dock && dock.classList.contains("is-folded"));
}

function readDockStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeDockStore(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    /* private mode / blocked storage: the layout just isn't remembered */
  }
}

// Largest dock that still leaves the move tree its minimum inside the panel.
function buildDockMaxHeight() {
  const dock = document.getElementById("build-inspector");
  const panel = dock && dock.parentElement;
  if (!panel) return 600;
  let others = 0;
  for (const child of panel.children) {
    if (child === dock || child.id === "builder-tree") continue;
    others += child.getBoundingClientRect().height;
  }
  return Math.max(BUILD_DOCK_MIN, panel.clientHeight - others - BUILD_DOCK_TREE_MIN);
}

function applyBuildDockHeight(px) {
  const dock = document.getElementById("build-inspector");
  if (!dock) return null;
  const clamped = Math.round(Math.min(Math.max(px, BUILD_DOCK_MIN), buildDockMaxHeight()));
  dock.style.flexBasis = `${clamped}px`;
  return clamped;
}

function setBuildDockFolded(folded, { remember = true } = {}) {
  const dock = document.getElementById("build-inspector");
  if (!dock) return;
  const was = dock.classList.contains("is-folded");
  dock.classList.toggle("is-folded", folded);
  const fold = document.getElementById("build-dock-fold");
  if (fold) {
    const label = folded ? "Unfold the inspector" : "Fold the inspector";
    fold.setAttribute("aria-expanded", String(!folded));
    fold.setAttribute("aria-label", label);
    fold.title = label;
  }
  if (remember) writeDockStore(BUILD_DOCK_FOLDED_KEY, folded ? "1" : null);
  if (was === folded) return;
  // Folding parks the Explorer fetch and the row-eval worker; unfolding catches up.
  if (!folded && buildDockTab === "explorer") refreshExplorerPanel();
  void explorerEvalEngine.sync();
}

function initBuildDockLayout() {
  const dock = document.getElementById("build-inspector");
  const resizer = document.getElementById("build-dock-resizer");
  const fold = document.getElementById("build-dock-fold");
  if (!dock || !resizer) return;
  const stored = Number(readDockStore(BUILD_DOCK_HEIGHT_KEY));
  if (Number.isFinite(stored) && stored > 0) dock.style.flexBasis = `${Math.round(stored)}px`;
  setBuildDockFolded(readDockStore(BUILD_DOCK_FOLDED_KEY) === "1", { remember: false });
  fold?.addEventListener("click", (event) => {
    setBuildDockFolded(!buildDockFolded());
    if (event.detail !== 0) fold.blur();
  });

  let drag = null;
  const onMove = (event) => {
    if (!drag) return;
    const want = drag.startHeight + (drag.startY - event.clientY);
    // Dragging well below the minimum folds the dock; dragging back up unfolds.
    if (want < BUILD_DOCK_MIN * 0.5) {
      if (!buildDockFolded()) setBuildDockFolded(true);
      return;
    }
    if (buildDockFolded()) setBuildDockFolded(false);
    drag.height = applyBuildDockHeight(want);
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.height) writeDockStore(BUILD_DOCK_HEIGHT_KEY, drag.height);
    drag = null;
    resizer.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-dock");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startHeight = buildDockFolded() ? BUILD_DOCK_MIN * 0.5 : dock.getBoundingClientRect().height;
    drag = { startY: event.clientY, startHeight, height: null };
    resizer.classList.add("is-dragging");
    document.body.classList.add("is-resizing-dock");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  resizer.addEventListener("dblclick", () => setBuildDockFolded(!buildDockFolded()));
  resizer.addEventListener("keydown", (event) => {
    // Up/Down are the fork picker's keys elsewhere in Build; on the focused
    // handle they resize instead, so they stop here.
    const step = event.shiftKey ? 96 : 32;
    let delta = 0;
    if (event.key === "ArrowUp") delta = step;
    else if (event.key === "ArrowDown") delta = -step;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      setBuildDockFolded(!buildDockFolded());
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (buildDockFolded()) {
      if (delta > 0) setBuildDockFolded(false);
      return;
    }
    const height = applyBuildDockHeight(dock.getBoundingClientRect().height + delta);
    if (height) writeDockStore(BUILD_DOCK_HEIGHT_KEY, height);
  });
}

// ---- Live engine placement -------------------------------------------------
// The engine never floats over the board: it lives inside the panel that
// already answers "which move?" - Build's Explorer (pinned best line + an Eval
// column per candidate) and Analyze's Evaluation card (game graph + live lines).
const ENGINE_VIEW_SLOTS = { build: "explorer-engine-slot", analyze: "analysis-engine-slot" };
const ENGINE_VIEW_PREFS = { build: "engineBuild", analyze: "engineAnalyze" };
// Most Explorer rows the eval worker scores (the most-played ones). More lines
// means a shallower search per second, so the rest show a dash.
const EXPLORER_EVAL_MAX_LINES = 8;

function dockEngine(slotId) {
  const el = document.getElementById("engine-window");
  const slot = document.getElementById(slotId);
  if (!el || !slot || el.parentNode === slot) return;
  for (const prop of ["left", "top", "right", "width", "height"]) el.style.removeProperty(prop);
  el.classList.add("is-docked");
  slot.appendChild(el);
}

function engineWantedIn(view) {
  const key = ENGINE_VIEW_PREFS[view];
  return !!key && !!pref(key);
}

function syncEngineForView(view = activeViewName()) {
  const slot = ENGINE_VIEW_SLOTS[view];
  if (slot && engineWantedIn(view)) {
    dockEngine(slot);
    if (engineWidget.isOpen()) void engineWidget.onBoardChanged();
    else void engineWidget.openForCurrent();
  } else if (engineWidget.isOpen()) {
    void engineWidget.close();
  }
  syncEngineChrome();
  void explorerEvalEngine.sync();
}

function setEngineOn(view, on) {
  const key = ENGINE_VIEW_PREFS[view];
  if (!key) return;
  setPref(key, !!on);
  syncEngineForView(view);
}

function syncEngineChrome() {
  const buildOn = engineWantedIn("build");
  const analyzeOn = engineWantedIn("analyze");
  const toggle = document.getElementById("explorer-engine-toggle");
  if (toggle) {
    toggle.classList.toggle("is-on", buildOn);
    toggle.setAttribute("aria-checked", String(buildOn));
  }
  const analyzeBtn = document.getElementById("open-engine-widget");
  if (analyzeBtn) {
    analyzeBtn.classList.toggle("is-active", analyzeOn);
    analyzeBtn.setAttribute("aria-pressed", String(analyzeOn));
  }
  const rows = document.getElementById("explorer-rows");
  if (rows) rows.classList.toggle("has-eval", buildOn);
  explorerEvalEngine.repaint();
  syncAnalysisEvalCard();
}

// The Evaluation card shows when there is a game graph or the engine is on;
// the graph itself only once an analysis has plotted points (a loaded but not
// yet analyzed game has nothing to draw, so no empty grey box).
function syncAnalysisEvalCard() {
  const card = document.getElementById("analysis-eval-card");
  const graph = document.getElementById("analysis-eval-graph");
  const results = document.getElementById("analysis-results");
  const points = Array.isArray(appState.evalChartPoints) ? appState.evalChartPoints : [];
  const hasGraph = !!results && !results.hidden && points.length > 0;
  if (graph) graph.hidden = !hasGraph;
  card?.classList.toggle("is-engine", engineWantedIn("analyze"));
}

// ---- Explorer row evals ------------------------------------------------------
// A second Stockfish worker, separate from the live engine lines: it searches the
// same position at the same depth, restricted (UCI `searchmoves`) to exactly the
// Explorer's candidate moves with one PV per candidate. The main widget keeps its
// own line count, so its best line reaches full depth as fast as a single-PV
// search; the row evals cost one extra worker, only while Build's Explorer is
// showing with the engine on.
class ExplorerEvalEngine {
  constructor() {
    this.engine = null;
    this.engineDepth = null;
    this.key = null; // fen + candidate moves of the running search
    this.snapshot = null;
    this.pollTimer = null;
  }

  wanted() {
    return (
      activeViewName() === "build" &&
      engineWantedIn("build") &&
      buildDockTab === "explorer" &&
      explorerDrawerOpen()
    );
  }

  // Candidate moves on screen for the current node, most-played first.
  _candidates() {
    const rows = document.getElementById("explorer-rows");
    const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
    const fen = (node && node.fen) || null;
    if (!rows || !fen || !sameFenPosition(rows.dataset.fen, fen)) return null;
    const moves = [];
    rows.querySelectorAll(".explorer-row").forEach((row) => {
      const uci = normalizeUci(row.dataset.uci);
      if (uci && !moves.includes(uci)) moves.push(uci);
    });
    return moves.length ? { fen, moves: moves.slice(0, EXPLORER_EVAL_MAX_LINES) } : null;
  }

  _ensureEngine() {
    const depth = effectiveStockfishDepth();
    if (this.engine && this.engineDepth === depth) return;
    this.stop();
    this.engine = createEngineProvider({ maxDepth: depth, maxMultipv: EXPLORER_EVAL_MAX_LINES, priority: "interactive" });
    this.engineDepth = depth;
  }

  // Start, retarget or stop the search to match what the Explorer shows now.
  async sync() {
    if (!this.wanted()) {
      this.stop();
      this.repaint();
      return;
    }
    const want = this._candidates();
    if (!want) {
      // No rows belong to a live position (mid-fetch, empty, or failed). The search
      // on the old position must actually STOP, not just be forgotten — otherwise it
      // burns a core at full depth on an off-screen position with nothing left to
      // poll it. Park it (worker stays warm; `_ensureEngine` rebuilds if it is gone).
      this.key = null;
      this.snapshot = null;
      this._stopPolling();
      if (this.engine) {
        try {
          this.engine.stopSearch();
        } catch (_) {
          /* best-effort */
        }
      }
      this.repaint();
      return;
    }
    this._ensureEngine();
    const key = `${want.fen}|${want.moves.join(",")}|${this.engineDepth}`;
    if (key === this.key) return;
    this.key = key;
    this.snapshot = null;
    this._stopPolling();
    this.repaint();
    const engine = this.engine;
    try {
      const snapshot = await engine.update({
        fen: want.fen,
        multipv: want.moves.length,
        searchmoves: want.moves,
      });
      if (engine !== this.engine || key !== this.key) return;
      this._accept(snapshot);
      if (snapshot.running !== false) this._poll();
    } catch (error) {
      if (engine !== this.engine || key !== this.key) return;
      this.snapshot = { error: error.message };
      this.repaint();
    }
  }

  _accept(snapshot) {
    this.snapshot = snapshot;
    this.repaint();
    if (snapshot && snapshot.running === false) this._stopPolling();
  }

  _poll() {
    this._stopPolling();
    const engine = this.engine;
    const key = this.key;
    this.pollTimer = setInterval(() => {
      if (engine !== this.engine || key !== this.key) {
        this._stopPolling();
        return;
      }
      this._accept(engine.snapshot());
    }, 450);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stop() {
    this._stopPolling();
    this.key = null;
    this.snapshot = null;
    if (this.engine) {
      const engine = this.engine;
      this.engine = null;
      this.engineDepth = null;
      Promise.resolve()
        .then(() => engine.close())
        .catch(() => {});
    }
  }

  repaint() {
    paintExplorerEvals(this.snapshot, engineWidget.isOpen() ? engineWidget.lastSnapshot : null);
  }
}
const explorerEvalEngine = new ExplorerEvalEngine();

// Explorer reports castling king-to-rook (e1h1); Stockfish king-two-squares.
const CASTLE_UCI = { e1h1: "e1g1", e1a1: "e1c1", e8h8: "e8g8", e8a8: "e8c8" };
function normalizeUci(uci) {
  const key = String(uci || "").toLowerCase();
  return CASTLE_UCI[key] || key;
}

function engineScoreCp(pv) {
  if (pv.mate_in !== null && pv.mate_in !== undefined) {
    return pv.mate_in > 0 ? 100000 - pv.mate_in : -100000 - pv.mate_in;
  }
  return Number(pv.score_cp) || 0;
}

function sameFenPosition(a, b) {
  if (!a || !b) return false;
  return a.split(" ").slice(0, 4).join(" ") === b.split(" ").slice(0, 4).join(" ");
}

// Paint each Explorer row's Eval cell from the eval worker's lines. Evals are
// White's view (like the bar); the colour says how much the mover gives up
// versus the best move: the main engine line when it is on this position,
// else the best candidate.
function paintExplorerEvals(snapshot, mainSnapshot = null) {
  const rows = document.getElementById("explorer-rows");
  if (!rows || !rows.classList.contains("has-eval")) return;
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  const fen = (node && node.fen) || START_FEN;
  const live = !!snapshot && !snapshot.error && sameFenPosition(snapshot.fen, fen);
  const failed = !!snapshot && !!snapshot.error;
  const pvs = live && Array.isArray(snapshot.pvs)
    ? snapshot.pvs.filter((pv) => Array.isArray(pv.pv_uci) && pv.pv_uci.length)
    : [];
  const byUci = new Map();
  pvs.forEach((pv) => {
    const key = normalizeUci(pv.pv_uci[0]);
    if (!byUci.has(key)) byUci.set(key, pv);
  });
  const sign = live && snapshot.side_to_move === "black" ? -1 : 1;
  // Mover's-view reference: the best of the candidates and the main line.
  let best = pvs.length ? Math.max(...pvs.map((pv) => engineScoreCp(pv) * sign)) : 0;
  const mainPv =
    mainSnapshot && !mainSnapshot.error && sameFenPosition(mainSnapshot.fen, fen)
      ? (mainSnapshot.pvs || [])[0]
      : null;
  if (pvs.length && mainPv && Array.isArray(mainPv.pv_uci) && mainPv.pv_uci.length) {
    best = Math.max(best, engineScoreCp(mainPv) * sign);
  }
  // A row the cap never asked about is genuinely "not scored"; a row we asked about
  // that has no PV yet is still calculating. `beyondCap` is what the worker could
  // never score, so the cap tooltip is only ever shown for those rows.
  const rowCount = rows.querySelectorAll(".explorer-row").length;
  const beyondCap = rowCount > EXPLORER_EVAL_MAX_LINES;
  const settled = live && (snapshot.running === false || pvs.length >= EXPLORER_EVAL_MAX_LINES);
  rows.querySelectorAll(".explorer-row").forEach((row) => {
    const cell = row.querySelector(".explorer-eval");
    if (!cell) return;
    cell.classList.remove("is-best", "is-ok", "is-weak");
    if (failed) {
      cell.textContent = "—";
      cell.title = `Engine unavailable: ${snapshot.error}`;
      return;
    }
    const pv = byUci.get(normalizeUci(row.dataset.uci));
    if (!pv) {
      cell.textContent = settled || beyondCap ? "—" : "…";
      cell.title = beyondCap
        ? `Not scored: only the ${EXPLORER_EVAL_MAX_LINES} most-played moves are evaluated`
        : settled
          ? "Not scored — the engine returned no line for this move"
          : "Calculating…";
      return;
    }
    cell.textContent = engineWidget._formatEval(pv.score_cp, pv.mate_in);
    const drop = best - engineScoreCp(pv) * sign;
    cell.classList.add(drop <= 20 ? "is-best" : drop <= 80 ? "is-ok" : "is-weak");
    cell.title = `Stockfish, depth ${pv.depth || snapshot.current_depth || 0}`;
  });
}

function setBuildInspector(tool) {
  const tab = BUILD_DOCK_TABS.includes(tool) ? tool : buildDockTab;
  const panels = {
    explorer: document.getElementById("explorer-drawer"),
    coverage: document.getElementById("coverage-drawer"),
  };
  const buttons = {
    explorer: document.getElementById("build-tool-explorer"),
    coverage: document.getElementById("build-tool-coverage"),
  };
  buildDockTab = tab;
  BUILD_DOCK_TABS.forEach((name) => {
    const on = name === tab;
    if (panels[name]) panels[name].hidden = !on;
    const button = buttons[name];
    if (!button) return;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  });
  const dbs = document.getElementById("inspector-dbs");
  const opening = document.getElementById("explorer-opening");
  const engineSwitch = document.getElementById("explorer-engine-switch");
  if (dbs) dbs.hidden = tab !== "explorer";
  if (opening) opening.hidden = tab !== "explorer";
  if (engineSwitch) engineSwitch.hidden = tab !== "explorer";
  for (const id of ["coverage-scope", "coverage-depth", "coverage-run"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = tab !== "coverage";
  }
  paintInspectorScope();
  if (tab === "explorer") refreshExplorerPanel();
  if (tab === "coverage") void ensureCoverageView().then((view) => { view.sync(); view.paint(); }).catch((error) => setStatusError(error.message));
  void explorerEvalEngine.sync();
}

// Compact scope line for the ⓘ popover: what the panel shows, nothing more.
function inspectorScopeText() {
  if (buildDockTab === "coverage") {
    return "Share of human play at your rating that reaches a move your prepared mainline does not answer, within the horizon. Pruned or unmodelled lines count as unchecked.";
  }
  if (explorerDb !== "lichess") return "Master games.";
  const rating = effectiveMaiaRating();
  const buckets =
    explorerModule && typeof explorerModule.ratingBucketsFor === "function"
      ? explorerModule.ratingBucketsFor(rating)
      : null;
  return buckets && buckets.length
    ? `Players near ~${rating} (pool ${buckets.join(", ")}).`
    : `Players near ~${rating}.`;
}

function paintInspectorScope() {
  const info = document.getElementById("inspector-info");
  if (info) info.title = inspectorScopeText();
}

function onInspectorInfo() {
  const text = inspectorScopeText();
  const info = document.getElementById("inspector-info");
  if (!info) return;
  let pop = document.getElementById("inspector-info-pop");
  if (pop) {
    pop.remove();
    return;
  }
  pop = document.createElement("div");
  pop.className = "inspector-info-pop";
  pop.id = "inspector-info-pop";
  pop.setAttribute("role", "status");
  pop.textContent = text;
  const head = document.getElementById("build-dock-tools") || info.parentElement;
  head.appendChild(pop);
  // Anchor under the ⓘ itself (not the toolbar's far edge), clamped so the
  // bubble never spills past the toolbar's right side.
  const headRect = head.getBoundingClientRect();
  const infoRect = info.getBoundingClientRect();
  const left = Math.max(
    0,
    Math.min(infoRect.left - headRect.left - 8, headRect.width - pop.offsetWidth)
  );
  pop.style.left = `${Math.round(left)}px`;
  pop.style.right = "auto";
  window.setTimeout(() => pop?.remove(), 4000);
}

// Arrow-keying through a line fires selectBuildNode per ply; one trailing fetch
// 350ms after the player settles is plenty (and most settles hit the cache).
function scheduleExplorerRefresh() {
  if (!explorerDrawerOpen()) return;
  window.clearTimeout(explorerTimer);
  explorerTimer = window.setTimeout(refreshExplorerPanel, 350);
}

async function refreshExplorerPanel() {
  const rows = document.getElementById("explorer-rows");
  if (!rows || !explorerDrawerOpen()) return;
  const node =
    appState.buildCurrentNodeId && appState.buildNodeById.get(appState.buildCurrentNodeId);
  const fen = node ? node.fen : null;
  if (!fen) {
    rows.innerHTML = '<div class="muted hint">Open a repertoire to see real-game stats.</div>';
    // No rows can belong to a position now, so park the search instead of
    // leaving the old one burning a core at full depth.
    void explorerEvalEngine.sync();
    return;
  }
  renderExplorerScope();
  const seq = ++explorerSeq;
  const db = explorerDb;
  // Same database, new position: keep the previous rows on screen (dimmed and
  // inert via .is-stale) until the new ones land, so stepping through a line
  // doesn't flash a one-line "Loading…" that collapses the panel and makes the
  // dock's scrollbar blink. Switching database still clears: the previous
  // database's rows left on screen read as Masters and Players "mixing".
  const keepRows = rows.dataset.db === db && !!rows.querySelector(".explorer-row");
  rows.dataset.db = db;
  // Rows stop being actionable here, but the re-render below that would re-sync
  // the eval engine only lands after the network round-trip. Park the search now
  // so the previous position is not still searched at full depth meanwhile.
  delete rows.dataset.fen;
  void explorerEvalEngine.sync();
  const openingEl = document.getElementById("explorer-opening");
  if (keepRows) {
    rows.classList.add("is-stale");
    rows.setAttribute("aria-busy", "true");
  } else {
    if (openingEl) openingEl.textContent = "";
    rows.classList.remove("is-stale");
    rows.innerHTML = `<div class="muted hint">Loading ${db === "lichess" ? "Players" : "Masters"}…</div>`;
  }
  try {
    if (!explorerModule) {
      rows.innerHTML = '<div class="muted hint">Loading explorer…</div>';
      explorerModule = await import("./explorer.js");
      explorerClient = explorerModule.createExplorerClient({});
      renderExplorerScope(); // now that ratingBucketsFor is available, show the pool
    }
    const stats = await explorerClient.fetchStats(db, fen, {
      rating: effectiveMaiaRating(),
    });
    if (seq !== explorerSeq || db !== explorerDb || !explorerDrawerOpen()) return; // superseded
    renderExplorerRows(stats, fen);
  } catch (error) {
    if (seq !== explorerSeq || db !== explorerDb) return;
    rows.classList.remove("is-stale");
    rows.removeAttribute("aria-busy");
    if (openingEl) openingEl.textContent = "";
    const label = db === "lichess" ? "Players" : "Masters";
    if (explorerModule && error instanceof explorerModule.ExplorerRateLimited) {
      const secs = Math.max(1, Math.ceil(error.retryInMs / 1000));
      rows.innerHTML = `<div class="muted hint">Lichess asks for a short pause - try again in ~${secs}s.</div>`;
    } else if (/link your lichess account/i.test(error.message || "")) {
      // Retrying cannot help until an account is linked: offer the link.
      rows.innerHTML =
        `<div class="muted hint">The ${label} explorer reads Lichess with your linked account. ` +
        `<button type="button" class="btn sm" data-explorer-link>Link Lichess</button></div>`;
      rows.querySelector("[data-explorer-link]")?.addEventListener("click", () => {
        openSettingsSection("set-connections").catch(() => {});
      });
    } else {
      rows.innerHTML =
        `<div class="muted hint">${label} explorer unavailable: ${escapeHtml(error.message)} ` +
        `<button type="button" class="btn sm ghost" data-explorer-retry>Retry</button></div>`;
      rows.querySelector("[data-explorer-retry]")?.addEventListener("click", () => refreshExplorerPanel());
    }
  }
}

// Compact scope: folded into the ⓘ popover (inspectorScopeText). The panel
// itself stays rows-only so moves own the height.
function renderExplorerScope() {
  paintInspectorScope();
}

function renderExplorerRows(stats, fen) {
  const rows = document.getElementById("explorer-rows");
  if (!rows) return;
  const openingEl = document.getElementById("explorer-opening");
  if (openingEl) openingEl.textContent = stats.opening || "";
  rows.dataset.fen = fen || "";
  rows.classList.remove("is-stale");
  rows.removeAttribute("aria-busy");
  if (!stats.moves.length) {
    rows.innerHTML = '<div class="muted hint">No games reached this position - true novelty territory.</div>';
    void explorerEvalEngine.sync();
    return;
  }
  // Dot the continuations already in the repertoire at this node, so gaps between
  // "what people actually play" and "what I've prepared" jump out.
  const current = appState.buildCurrentNodeId;
  const inRep = new Set(
    (appState.build ? appState.build.nodes : [])
      .filter((n) => n.parent_id === current && n.depth > 0)
      .map((n) => n.uci),
  );
  const inRepNorm = new Set([...inRep].map(normalizeUci));
  const canAdd = !isBuildReadOnly();
  rows.innerHTML =
    '<div class="explorer-head" aria-hidden="true"><span>Move</span><span class="explorer-eval">Eval</span><span>Games</span><span>White / Draw / Black</span></div>' +
    stats.moves
      .map((m) => {
        const has = inRep.has(m.uci) || inRepNorm.has(normalizeUci(m.uci));
        const games = explorerModule.formatGames(m.total);
        const thin = explorerThinSample(m);
        const action = has ? `Go to ${m.san}` : canAdd ? `Add ${m.san} to repertoire` : m.san;
        const seg = (cls, label, value) =>
          `<span class="${cls}" style="width:${value}%" title="${label} ${value}%">${explorerSegLabel(value)}</span>`;
        return `
    <div class="explorer-row${thin ? " is-thin" : ""}${has ? " is-in" : ""}" data-uci="${escapeHtml(m.uci)}">
      <button type="button" class="explorer-pick" data-explorer-pick aria-label="${escapeHtml(action)} (${countOf(games, "game")}, White ${m.whitePct}%, draw ${m.drawPct}%, Black ${m.blackPct}%)">
        <span class="explorer-san">${escapeHtml(m.san)}${has ? '<span class="explorer-inrep" title="In your repertoire">&#9679;</span>' : ""}</span>
      </button>
      <span class="explorer-eval">&hellip;</span>
      <span class="explorer-games">${games}</span>
      <span class="explorer-bar" aria-hidden="true">${seg("explorer-bar-w", "White wins", m.whitePct)}${seg("explorer-bar-d", "Draws", m.drawPct)}${seg("explorer-bar-b", "Black wins", m.blackPct)}</span>
    </div>`;
      })
      .join("");
  rows.querySelectorAll(".explorer-row").forEach((row) => {
    const uci = row.dataset.uci;
    // The whole row is the action; the Move button inside is the focusable
    // handle and its click bubbles here.
    row.addEventListener("click", () => {
      void onExplorerRowClick(rows, uci).catch(() => {});
      row.querySelector("[data-explorer-pick]")?.blur();
    });
  });
  explorerEvalEngine.repaint();
  void explorerEvalEngine.sync();
}

// Explorer bars are always full width: the W/D/B split is what a row is read
// for, and the game count beside it says how far to trust it. Thin samples are
// dimmed rather than shortened.
const EXPLORER_THIN_SAMPLE = 10;
function explorerThinSample(m) {
  return Math.max(0, Number(m.total) || 0) < EXPLORER_THIN_SAMPLE;
}

// A percent label only where the segment is wide enough to hold it; narrower
// segments keep the figure in their tooltip.
function explorerSegLabel(pct) {
  return pct >= 12 ? `${pct}%` : "";
}

// Explorer rows: a click adds the move to the repertoire and goes there; a move
// already in the repertoire just navigates to it.

function buildChildForUci(parentId, uci) {
  const want = normalizeUci(uci);
  return (appState.build ? appState.build.nodes : []).find(
    (n) => n.parent_id === parentId && n.depth > 0 && (n.uci === uci || normalizeUci(n.uci) === want),
  );
}

async function onExplorerRowClick(rows, uci) {
  const rowsFen = rows.dataset.fen;
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  const currentFen = node ? node.fen : boards.build && boards.build.fen;
  if (!node || !rowsFen || !sameFenPosition(rowsFen, currentFen)) return;
  const existing = buildChildForUci(node.id, uci);
  if (existing) {
    await selectBuildNode(existing.id);
    return;
  }
  await onExplorerRowAdd(rows, uci);
}

// Add from an Explorer row. Rows belong to the position they were fetched
// for. A second click (a double click, or a click while the next position's
// stats load) must not replay the old position's move from the new one: that
// was the "Illegal move" toast. The first click consumes the rows; they come
// back live only if the move didn't land (cancelled or rejected) and the board
// is still on their position.
async function onExplorerRowAdd(rows, uci) {
  const rowsFen = rows.dataset.fen;
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  const currentFen = node ? node.fen : boards.build && boards.build.fen;
  if (!rowsFen || !sameFenPosition(rowsFen, currentFen)) return;
  delete rows.dataset.fen;
  rows.classList.add("is-stale");
  try {
    await onBuildBoardMove(uci);
  } finally {
    const now = appState.buildNodeById.get(appState.buildCurrentNodeId);
    const nowFen = now ? now.fen : boards.build && boards.build.fen;
    if (!rows.dataset.fen && sameFenPosition(rowsFen, nowFen)) {
      rows.dataset.fen = rowsFen;
      rows.classList.remove("is-stale");
    }
  }
}


function renderBuilderTreeEmptyState() {
  const container = document.getElementById("builder-tree");
  const branchBar = document.getElementById("build-branchbar");
  const meta = document.getElementById("build-tree-meta");
  if (!container) return;
  if (meta) {
    meta.hidden = true;
    meta.innerHTML = "";
  }
  container.innerHTML =
    '<div class="tree-empty">No repertoire open. Pick one from the Library, or play a move to start.</div>';
  if (branchBar) branchBar.hidden = true;
  if (boards.build) boards.build.setBranchArrows([]);
  syncViewHeads();
}

function renderBuilderTree() {
  coverageView?.sync();
  if (!appState.build) {
    renderBuilderTreeEmptyState();
    return;
  }
  if (buildView) return buildView.renderBuilderTree();
  void ensureBuildView().then((view) => view.renderBuilderTree()).catch(() => {});
}

function buildRootId() {
  const nodes = appState.build ? appState.build.nodes : [];
  const root = nodes.find((n) => n.depth === 0);
  return root ? root.id : nodes[0]?.id || null;
}

function buildMainlineChild(nodeId) {
  if (!appState.build) return null;
  const kids = appState.build.nodes.filter((n) => n.parent_id === nodeId);
  if (!kids.length) return null;
  return kids.find((k) => k.is_mainline) || kids[0];
}

function buildGoRoot() {
  const id = buildRootId();
  if (id) selectBuildNode(id);
}

function buildGoBack() {
  const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
  if (node && node.parent_id) selectBuildNode(node.parent_id);
}

function buildGoForward() {
  // At a fork, → plays the picked continuation (mainline unless ↑/↓ changed it);
  // anywhere else it just walks the line.
  const ctx = buildBranchContext();
  if (ctx) {
    selectBuildNode(ctx.choiceId);
    return;
  }
  const child = buildMainlineChild(appState.buildCurrentNodeId);
  if (child) selectBuildNode(child.id);
}

function buildGoToEnd() {
  let cur = appState.buildCurrentNodeId;
  let child = buildMainlineChild(cur);
  while (child) {
    cur = child.id;
    child = buildMainlineChild(cur);
  }
  if (cur && cur !== appState.buildCurrentNodeId) selectBuildNode(cur);
}

// The next-move branches from a node (its children), mainline first.
function buildChildrenOf(nodeId) {
  if (!appState.build || !nodeId) return [];
  return appState.build.nodes
    .filter((n) => n.parent_id === nodeId)
    .sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
}

// The fork picker. ONE mental model everywhere: you stand on a position, and when
// your prep has two or more continuations from it, the bar (and the board arrows)
// show the choice of NEXT moves. ↑/↓ move the pick, →/Enter plays it, click plays
// it directly. To revisit the alternatives of a move you already played, step back
// with ← — the fork is right there. (The old design flipped between "alternatives
// at this move" and "next-move branches" depending on the node, which meant the
// same keys did different things at different times.)
function buildBranchContext() {
  if (!appState.build || !appState.buildCurrentNodeId) return null;
  const options = buildChildrenOf(appState.buildCurrentNodeId);
  if (options.length < 2) return null; // no fork: plain ← → walking
  const picked = options.find((n) => n.id === appState.buildBranchChoiceId) || options[0];
  return { options, choiceId: picked.id };
}

// ↑/↓ move the pick around the fork's options without leaving the position;
// the bar and the board arrows follow. With no fork they are inert.
function buildBranchKey(direction) {
  const ctx = buildBranchContext();
  if (!ctx) return;
  const idx = ctx.options.findIndex((n) => n.id === ctx.choiceId);
  const next = ctx.options[(idx + direction + ctx.options.length) % ctx.options.length];
  appState.buildBranchChoiceId = next.id;
  renderBuildBranchBar();
}

// The on-screen fork picker: one chip per prepared continuation, the picked one
// lit, mirrored by arrows on the board (the picked arrow drawn stronger).
function renderBuildBranchBar() {
  if (buildView) return buildView.renderBuildBranchBar();
  void ensureBuildView().then((view) => view.renderBuildBranchBar()).catch(() => {});
}

async function saveBuildAnnotations(arrows, circles) {
  if (activeViewName() !== "build" || isBuildReadOnly()) return;
  if (!appState.build || !appState.buildCurrentNodeId) return;
  const ownerId = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isOwner = () => ownerId === currentOwnerId() && generation === appState.ownerGeneration;
  const build = appState.build;
  const repertoireId = build.repertoire_id;
  const selectedId = appState.buildCurrentNodeId;
  const idMap = appState.buildIdMap;
  const resolvedId = () => idMap?.[selectedId] || selectedId;
  const slots = appState.buildAnnotationSlots ||= new Map();
  const key = JSON.stringify([ownerId, generation, repertoireId, resolvedId()]);
  let slot = slots.get(key);
  const node = appState.buildNodeById.get(resolvedId());
  if (!slot) {
    slot = { confirmed: { arrows: (node?.arrows || []).slice(), circles: (node?.circles || []).slice() }, latest: null, task: null };
    slots.set(key, slot);
  }
  slot.latest = { arrows: arrows.slice(), circles: circles.slice() };
  if (node) Object.assign(node, slot.latest);
  if (slot.task) return slot.task;
  const previousSave = appState.buildAnnotationsSaving;
  const task = (async () => {
    if (previousSave) await previousSave;
    while (slot.latest && isOwner()) {
      let snapshot;
      try {
        await hardFlushBuild();
        if (!isOwner()) return;
        snapshot = slot.latest;
        slot.latest = null;
        const current = appState.build?.repertoire_id === repertoireId;
        const nodeId = resolvedId();
        const payload = await postJson("/api/build/annotations", {
          repertoire_id: repertoireId, node_id: nodeId, ...snapshot,
          base_revision: current ? appState.build.revision : build.revision,
        });
        if (Number.isInteger(payload?.revision)) build.revision = Math.max(build.revision || 0, payload.revision);
        slot.confirmed = snapshot;
      } catch (error) {
        if (!isOwner()) return;
        setStatusError(`Annotations not saved: ${error.message}`);
        // A failed prerequisite flush has not consumed latest yet.
        if (!snapshot) slot.latest = null;
      }
      if (!isOwner()) return;
      // Only the newest visible draft can repaint this position. An earlier
      // success advances confirmation/revision without replaying an old drawing.
      if (appState.build?.repertoire_id === repertoireId) {
        const visible = slot.latest || slot.confirmed;
        const currentNode = appState.buildNodeById.get(resolvedId());
        if (currentNode) Object.assign(currentNode, visible);
        if (resolveBuildId(appState.buildCurrentNodeId) === resolvedId()) boards.build.setAnnotations(visible.arrows, visible.circles);
      }
    }
  })();
  slot.task = task;
  appState.buildAnnotationsSaving = task;
  try { await task; }
  finally {
    slots.delete(key);
    if (appState.buildAnnotationsSaving === task) appState.buildAnnotationsSaving = null;
  }
}

// ===== Local-first Build sync ================================================
// docs/local-first-sync-plan.md Phase 1. A played move mutates the local tree
// immediately and is queued; a debounced batch flush reconciles with the server,
// which owns id assignment + flag recomputation. The client never waits on the
// network to render a move (降延遲) and writes are batched (降消耗).

const BUILD_FLUSH_IDLE_MS = 2000;
const BUILD_FLUSH_MAX_BACKOFF_MS = 30000;

// R-04: the temp id is the outbox's operation identity — mergeById dedupes adds
// and tombstones settle by it. A bare per-tab counter would restart at 1 in
// EVERY tab, so two tabs of the same account mint the same "tmp-1" for different
// moves; the merge would then treat the second tab's new move as the first
// tab's already-settled op and drop it from the durable queue (silent data
// loss on close). The tab id keeps ids unique per tab while still matching the
// server's 'tmp-' prefix rule.
function mintBuildTmpId() {
  return `tmp-${OUTBOX_TAB_ID}-${++appState.buildTmpCounter}`;
}

// True when the parent already has at least one enabled child — used to decide a
// provisional move's display-only `is_mainline` (first move wins). The server
// recomputes the authoritative value on reconcile.
function someEnabledChildOf(parentId) {
  if (!appState.build) return false;
  return appState.build.nodes.some((n) => n.parent_id === parentId && n.is_enabled);
}

// Resolve a possibly-stale `tmp-` id to its real id once a flush has reconciled
// it. Used by hard-flush call sites that captured a tmp node id before sync.
// Resolve a possibly-stale `tmp-` id to its real id once a flush has reconciled
// the tree. Queued deletes are `{ id, repertoire_id }` entries (see
// queueBuildDelete) so they carry their target too; plain ids still work.
function resolveBuildId(ref) {
  const id = ref && typeof ref === "object" ? ref.id : ref;
  return (id && appState.buildIdMap[id]) || id;
}

// R-02: every queued op records WHICH repertoire it belongs to. A flush may
// only send ops for the repertoire it is flushing; anything else stays queued
// for its own tree, so restored work can never land in the wrong opening.
function buildOpTarget(entry) {
  return (entry && entry.repertoire_id) || null;
}

function buildOpMatchesRepertoire(entry, repertoireId) {
  const target = buildOpTarget(entry);
  return !target || String(target) === String(repertoireId);
}

function queueBuildDelete(nodeId) {
  appState.buildPendingDeletes.push({
    id: nodeId,
    base_revision: appState.build?.revision,
    repertoire_id: appState.build ? appState.build.repertoire_id : null,
  });
}

function hasPendingBuildOpsFor(repertoireId) {
  return (
    appState.buildPending.some((m) => buildOpMatchesRepertoire(m, repertoireId)) ||
    appState.buildPendingDeletes.some((entry) => buildOpMatchesRepertoire(entry, repertoireId))
  );
}

// Build a provisional Build node matching the serializer shape (workspace_view.py
// opening_item_to_json) so it renders and is selectable exactly like a real one.
// Flags here are display-only; the server overwrites them on reconcile.
function buildProvisionalNode(parent, uci, after) {
  const parts = String(parent.fen || "").split(" ");
  const moveSide = parts[1] === "b" ? "black" : "white";
  const moveNumber = Number(parts[5]) || parent.move_number || 1;
  const repColor = appState.build && appState.build.color === "black" ? "black" : "white";
  return {
    id: mintBuildTmpId(),
    parent_id: parent.id,
    depth: (parent.depth || 0) + 1,
    san: after.move.san,
    uci,
    fen: after.board.fen,
    fen_before: parent.fen,
    fen_after: after.board.fen,
    move_number: moveNumber,
    ply: (parent.ply || 0) + 1,
    move_side: moveSide,
    side_to_move: after.move.side_to_move,
    source: "manual",
    is_mainline: !someEnabledChildOf(parent.id),
    is_prepared: moveSide === repColor,
    is_enabled: true,
    maia_probability: null,
    engine_evaluation: null,
    tags: [],
    comment: "",
    arrows: [],
    circles: [],
    mastery: null,
  };
}

// ----- Sync indicator (Google-Docs style chip by the Build board label) -------
function setBuildSync(state) {
  appState.buildSyncState = state;
  renderBuildSync();
}

function renderSyncChip(el, state, scope = "repertoire") {
  const v = syncChipVariant(state, scope);
  el.hidden = false;
  el.className = `build-sync ${v.cls}`;
  el.textContent = v.text;
}

function renderBuildSync() {
  const el = document.getElementById("build-sync");
  if (!el) return;
  // Nothing to show without an editable repertoire (read-only shared view = no
  // local edits ever happen).
  if (!appState.build || isBuildReadOnly()) {
    el.hidden = true;
    return;
  }
  renderSyncChip(el, appState.buildSyncState);
}

let trainModule = null;
let trainView = null;

function preloadTrainView() {
  if (!trainModule) {
    trainModule = import("./views/train.js").catch((err) => {
      trainModule = null;
      throw err;
    });
  }
  return trainModule;
}

async function ensureTrainView() {
  const mod = await preloadTrainView();
  if (!trainView) {
    trainView = mod.createTrainView({
      appState,
      boards,
      escapeHtml,
      renderSyncChip,
      setTrainBanner,
      updateTrainTurnBadge,
      smartKindLabels: SMART_KIND_LABELS,
      smartKindTitles: SMART_KIND_TITLES,
      onStreakRendered: (streak) => {
        const s = appState.trainStats;
        if (s) s.lastStreak = streak;
      },
    });
  }
  return trainView;
}

// Train's counterpart chip (same look/classes): visible during a smart session
// or while abandoned-session attempts still wait to land.
function setTrainSyncState(state) {
  appState.trainSyncState = state;
  void renderTrainSync().catch(() => {});
}

async function renderTrainSync() {
  const el = document.getElementById("train-sync");
  if (!el) return;
  const sync = appState.trainSync;
  if (!appState.smart && !sync.pending.length && !sync.dirty) {
    el.hidden = true;
    return;
  }
  return (await ensureTrainView()).renderTrainSync();
}

async function renderTrainStats() {
  return (await ensureTrainView()).renderTrainStats();
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

// ----- Debounce + flush -------------------------------------------------------
function scheduleBuildFlush() {
  void persistOutbox(); // The flush awaits its durable checkpoint before sending.
  clearTimeout(appState.buildFlushTimer);
  appState.buildFlushTimer = setTimeout(() => {
    appState.buildFlushTimer = null;
    flushBuildMoves();
  }, BUILD_FLUSH_IDLE_MS);
}

// Flush the pending batches (deletes first, then adds). Resolves to true on
// success, false on failure (the batches are requeued + a backoff retry is
// armed). If a flush is already in flight the same promise is returned, so
// hard-flush callers can simply await it.
function flushBuildMoves() {
  if (appState.buildFlushing) return appState.buildFlushing;
  const owner = currentOwnerId();
  const isCurrent = captureBuildContext();
  if (!appState.build || (!appState.buildPending.length && !appState.buildPendingDeletes.length))
    return Promise.resolve(true);
  // R-03/R-04: one flusher per owner at a time — a second tab holding the lock
  // means its flush is already carrying these ops (server receipts are the
  // hard guarantee; this avoids duplicate traffic and double toasts). A failed
  // acquire must NOT strand the queue as "dirty" with no timer, so a retry is
  // always armed before returning.
  if (!acquireFlushLock(currentOwnerId(), OUTBOX_TAB_ID)) {
    appState.buildFlushTimer = setTimeout(() => {
      appState.buildFlushTimer = null;
      flushBuildMoves();
    }, BUILD_FLUSH_IDLE_MS);
    return Promise.resolve(false);
  }
  clearTimeout(appState.buildFlushTimer);
  appState.buildFlushTimer = null;

  const durableCheckpoint = persistOutbox();
  // Snapshot the in-flight batches; moves made DURING the round-trip accumulate
  // in fresh queues and must survive the reconcile (§1.4 — the load-bearing bit).
  // R-02: only THIS repertoire's ops may ride the flush — entries restored from
  // another tree stay queued for their own repertoire.
  const repertoireId = appState.build.repertoire_id;
  const batch = appState.buildPending.filter((m) => buildOpMatchesRepertoire(m, repertoireId));
  appState.buildPending = appState.buildPending.filter(
    (m) => !buildOpMatchesRepertoire(m, repertoireId),
  );
  const deleteBatch = appState.buildPendingDeletes.filter((entry) =>
    buildOpMatchesRepertoire(entry, repertoireId),
  );
  appState.buildPendingDeletes = appState.buildPendingDeletes.filter(
    (entry) => !buildOpMatchesRepertoire(entry, repertoireId),
  );
  // A delete of an in-flight add needs that add's acknowledged real ID.
  // Recover the add first; leaving the delete queued prevents tmp-only pruning
  // from silently settling a deletion whose server commit is still uncertain.
  const inFlightAdds = new Set(batch.map((op) => op.tempId));
  for (let i = deleteBatch.length - 1; i >= 0; i--) {
    if (inFlightAdds.has(resolveBuildId(deleteBatch[i]))) {
      appState.buildPendingDeletes.push(...deleteBatch.splice(i, 1));
    }
  }
  const deferredCount = [...appState.buildPending, ...appState.buildPendingDeletes]
    .filter((op) => !buildOpMatchesRepertoire(op, repertoireId)).length;
  if (deferredCount) {
    setStatus(
      `${deferredCount} edit${deferredCount === 1 ? "" : "s"} for another repertoire kept on this device — open that repertoire to save ${deferredCount === 1 ? "it" : "them"}.`,
    );
  }
  setBuildSync("syncing");

  appState.buildFlushing = (async () => {
    let acknowledged = false;
    try {
      await durableCheckpoint;
      if (!isCurrent()) return false;
      // Deletes go FIRST: replaying a just-deleted move must create a fresh
      // node, not dedupe against the dying server one. A still-tmp id means the
      // node never reached the server (its pending add was cancelled) — drop it.
      const deleteIds = [
        ...new Set(deleteBatch.map(resolveBuildId).filter((id) => !String(id).startsWith("tmp-"))),
      ];
      let payload = null;
      if (deleteIds.length) {
        const beforeRevision = queuedBuildRevision([...deleteBatch, ...batch], appState.build);
        payload = await postJson("/api/build/delete-nodes", {
          repertoire_id: repertoireId,
          base_revision: beforeRevision,
          node_ids: deleteIds,
        });
        if (owner !== currentOwnerId()) return false;
        rebaseQueuedBuildRevision(batch, repertoireId, beforeRevision, payload.revision);
        await persistOutbox({ deletes: deleteBatch.map(buildDeleteId) });
        deleteBatch.length = 0;
      }
      if (batch.length) {
        // The add response supersedes the delete payload (it's newer truth).
        payload = await postJson("/api/build/add-moves", {
          repertoire_id: repertoireId,
          base_revision: queuedBuildRevision(batch, appState.build),
          moves: batch.map((m) => ({ tempId: m.tempId, parentRef: m.parentRef, uci: m.uci })),
        });
      }
      // Both batches can drain to nothing (e.g. deletes of never-flushed tmp
      // nodes): nothing reached the server, so there's nothing to reconcile.
      if (!payload) {
        appState.buildSyncRetry = 0;
        // Those tmp-only deletes are resolved either way — tombstone them so a
        // second tab can't put them back in the durable queue.
        await persistOutbox({ deletes: deleteBatch.map(buildDeleteId) });
        if (hasPendingBuildOpsFor(repertoireId)) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          await clearOutboxWhenQuiescent();
          setBuildSync("saved");
        }
        return true;
      }
      if (owner !== currentOwnerId()) return false;
      acknowledged = true;
      const idMap = payload.id_map || {};
      Object.assign(appState.buildIdMap, idMap);
      // The server confirmed this batch: tombstone it so neither this tab nor
      // a concurrent one replays it.
      const settled = {
        build: batch.map(buildAddId),
        deletes: deleteIds,
      };
      await persistOutbox(settled);

      // Translate the current selection + branch pick through tmp -> real.
      const prevSelection = appState.buildCurrentNodeId;
      const translatedSelection = idMap[prevSelection] || prevSelection;
      const branchPick = appState.buildBranchChoiceId
        ? idMap[appState.buildBranchChoiceId] || appState.buildBranchChoiceId
        : null;

      // Re-point still-pending nodes whose parentRef was a tmp from THIS batch.
      // Only THIS repertoire's entries: a queued op for another tree must not
      // be re-inserted into this one (R-02).
      const stillPending = appState.buildPending.filter((m) =>
        buildOpMatchesRepertoire(m, repertoireId),
      );
      for (const m of stillPending) {
        if (idMap[m.parentRef]) {
          m.parentRef = idMap[m.parentRef];
          m.node.parent_id = m.parentRef;
        }
      }

      // hydrate needs a selection that exists in the authoritative payload; if the
      // user is sitting on a still-pending tmp node, pick a safe anchor now and
      // restore the tmp selection after we re-insert it below.
      const payloadHasSelection = payload.nodes.some((n) => n.id === translatedSelection);
      if (!isCurrent()) return true;
      await hydrateBuild(payload, payloadHasSelection ? translatedSelection : null);
      if (branchPick) appState.buildBranchChoiceId = branchPick;

      reapplyPendingBuildNodes(stillPending, idMap);
      // Subtrees deleted DURING the round-trip were resurrected by the hydrate
      // (the server still had them) — prune them again; their delete ops are
      // queued and flush next cycle.
      reapplyPendingBuildDeletes();

      // Restore the user's selection if it was a still-pending tmp node (now back
      // in the tree after reapply) and hydrate couldn't land on it.
      if (
        !payloadHasSelection &&
        appState.buildNodeById.has(prevSelection) &&
        prevSelection !== appState.buildCurrentNodeId
      ) {
        await selectBuildNode(prevSelection);
      }
      appState.buildSyncRetry = 0;
      persistOutbox();
      // R-02: ops queued for ANOTHER repertoire stay put; re-arming on them
      // would spin a timer that can never drain them.
      if (hasPendingBuildOpsFor(repertoireId)) {
        setBuildSync("dirty");
        scheduleBuildFlush();
      } else {
        // R-01: only drop the owner's durable copy when Train's queue (and
        // anything kept for review) is empty too.
        await clearOutboxWhenQuiescent();
        if (!isCurrent()) return false;
        setBuildSync("saved");
      }
      return true;
    } catch (error) {
      if (owner !== currentOwnerId()) return false;
      if (acknowledged) {
        // Rendering failed after the server confirmed persistence. Never replay
        // confirmed operations or misreport this as a failed network commit.
        persistOutbox();
        setStatusError(`Edits saved. Reload the repertoire to refresh it: ${error.message}`);
        if (hasPendingBuildOpsFor(repertoireId)) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          setBuildSync("saved");
        }
        return true;
      }
      // R-01/R-04: every failure class gets its own outcome. NOTHING
      // unconfirmed is ever dropped or claimed as Saved — 401/403/409/429
      // used to lose the whole batch here.
      const info = classifySyncError(error);
      const inFlightCount = batch.length + deleteBatch.length;
      if (info.kind === "validation") {
        // A genuinely invalid payload must not take legitimate edits down
        // with it: isolate by replaying the ops one at a time — whatever
        // lands is saved, whatever fails is kept, marked, and reportable.
        const { rejected, settled, idMap, payload } = await isolateRejectedBuildOps(
          batch,
          deleteBatch,
          repertoireId,
        );
        appState.buildRejected = (appState.buildRejected || []).concat(rejected);
        if (idMap && Object.keys(idMap).length) {
          // Ops that landed mid-isolation have real ids now; the local tree and
          // any queued children must be reconciled against them (R-05).
          Object.assign(appState.buildIdMap, idMap);
          const stillPending = appState.buildPending;
          for (const m of stillPending) {
            if (idMap[m.parentRef]) {
              m.parentRef = idMap[m.parentRef];
              m.node.parent_id = m.parentRef;
            }
          }
          if (payload) {
            await hydrateBuild(payload, null);
            reapplyPendingBuildNodes(stillPending, idMap);
            reapplyPendingBuildDeletes();
          }
        }
        await persistOutbox(settled);
        setStatusError(
          rejected.length
            ? `${rejected.length} edit${rejected.length === 1 ? "" : "s"} could not be saved and are kept for review. The rest saved.`
            : error.message,
        );
        if (hasPendingBuildOpsFor(repertoireId)) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else if (appState.buildRejected.length) {
          setBuildSync("rejected");
        } else {
          await clearOutboxWhenQuiescent();
          setBuildSync("saved");
        }
        return false;
      }
      // auth / csrf / conflict / rate-limit / network / server: the batch was
      // never acknowledged — requeue it ahead of newer ops (op identity is
      // stable, so a later replay is safe even if this one actually landed).
      appState.buildPending = batch.concat(appState.buildPending);
      appState.buildPendingDeletes = deleteBatch.concat(appState.buildPendingDeletes);
      persistOutbox();
      setStatus(describeSyncError(info, { count: inFlightCount }), info.kind === "conflict" ? "warning" : "info");
      if (info.pauseForAuth) {
        // R-04: 401 needs a sign-in, not a backoff timer. Stop sending until
        // loadSignedInWorkspace re-arms the flush after sign-in.
        appState.syncPausedForAuth = true;
        setBuildSync("blocked");
        return false;
      }
      if (info.kind === "conflict") {
        // D-02: base revision was stale — the draft stays queued; the user
        // reconciles (reload the tree) and the queue replays after it.
        setBuildSync("conflict");
        return false;
      }
      appState.buildSyncRetry = Math.min(appState.buildSyncRetry + 1, 6);
      setBuildSync("error");
      const delay =
        info.retryAfterMs != null
          ? info.retryAfterMs
          : Math.min(
              BUILD_FLUSH_MAX_BACKOFF_MS,
              1000 * 2 ** (appState.buildSyncRetry - 1)
            );

      appState.buildFlushTimer = setTimeout(() => {
        appState.buildFlushTimer = null;
        flushBuildMoves();
      }, delay);
      return false;
    } finally {
      if (owner === currentOwnerId()) appState.buildFlushing = null;
      releaseFlushLock(OUTBOX_TAB_ID);
    }
  })();
  return appState.buildFlushing;
}

// R-05: isolate a permanently-rejected batch. Deletes first (per id), then
// adds one by one: each success is a save, each failure becomes a kept,
// reportable rejection instead of a silent drop of the whole batch.
//
// Three things this must get right:
//  - parents land before their children (orderPendingBuildAdds), and each
//    successful op's `id_map` feeds the NEXT ops, so a legal chain survives
//    next to one invalid sibling;
//  - a retriable failure mid-isolation (network, 401, 429) is not a rejection:
//    it and every later op go back on the queue untouched;
//  - everything resolved — saved OR rejected — is reported as settled so the
//    durable copy drops it instead of replaying it.
async function isolateRejectedBuildOps(batch, deleteBatch, repertoireId) {
  const rejected = [];
  const settled = { build: [], deletes: [], train: [] };
  const idMap = {};
  let lastPayload = null;

  for (let i = 0; i < deleteBatch.length; i += 1) {
    const entry = deleteBatch[i];
    const id = resolveBuildId(entry);
    if (String(id).startsWith("tmp-")) {
      settled.deletes.push(buildDeleteId(entry)); // never reached the server
      continue;
    }
    try {
      const beforeRevision = queuedBuildRevision([...deleteBatch.slice(i), ...batch], appState.build);
      const payload = await postJson("/api/build/delete-nodes", {
        repertoire_id: repertoireId,
        base_revision: beforeRevision,
        node_ids: [id],
      });
      rebaseQueuedBuildRevision([...deleteBatch.slice(i + 1), ...batch], repertoireId, beforeRevision, payload.revision);
      settled.deletes.push(buildDeleteId(entry));
    } catch (err) {
      const info = classifySyncError(err);
      if (info.retriable) {
        // Sign-out/network blip mid-isolation: stop here and keep this delete
        // plus every later one queued for the next flush.
        appState.buildPendingDeletes = deleteBatch.slice(i).concat(appState.buildPendingDeletes);
        break;
      }
      settled.deletes.push(buildDeleteId(entry));
      rejected.push({ kind: "delete", id, message: err.message, status: err.status ?? null });
    }
  }

  const ordered = orderPendingBuildAdds(batch);
  for (let i = 0; i < ordered.length; i += 1) {
    const m = ordered[i];
    // A parent from this same isolation round now has a real id.
    const parentRef = idMap[m.parentRef] || resolveBuildId(m.parentRef);
    try {
      const beforeRevision = queuedBuildRevision(ordered.slice(i), appState.build);
      const payload = await postJson("/api/build/add-moves", {
        repertoire_id: repertoireId,
        base_revision: beforeRevision,
        moves: [{ tempId: m.tempId, parentRef, uci: m.uci }],
      });
      rebaseQueuedBuildRevision(ordered.slice(i + 1), repertoireId, beforeRevision, payload.revision);
      if (payload && payload.id_map) Object.assign(idMap, payload.id_map);
      if (payload && payload.nodes) lastPayload = payload;
      settled.build.push(buildAddId(m));
    } catch (err) {
      const info = classifySyncError(err);
      if (info.retriable) {
        appState.buildPending = ordered.slice(i).concat(appState.buildPending);
        break;
      }
      settled.build.push(buildAddId(m));
      rejected.push({
        kind: "add",
        tempId: m.tempId,
        uci: m.uci,
        message: err.message,
        status: err.status ?? null,
      });
    }
  }
  return { rejected, settled, idMap, payload: lastPayload };
}

// Re-insert still-pending provisional nodes onto the freshly hydrated tree (which
// dropped them when it rebuilt buildNodeById from the server payload). Insertion
// order preserves parent-before-child, so a tmp parent re-inserted earlier in the
// loop is already present for its child.
function reapplyPendingBuildNodes(pending, idMap) {
  if (!pending.length) return;
  for (const entry of pending) {
    const node = entry.node;
    // Idempotent: hydrateBuild and the flush reconcile both call this for the
    // same queue, and re-inserting a node would duplicate it in the tree.
    if (!node || appState.buildNodeById.has(node.id)) continue;
    const realParent = idMap[entry.parentRef] || entry.parentRef;
    entry.parentRef = realParent;
    node.parent_id = realParent;
    const parent = appState.buildNodeById.get(realParent);
    if (parent) node.depth = (parent.depth || 0) + 1;
    // Dedupe: the server may have already materialised this child (e.g. the same
    // line existed). If so, adopt the real id and drop the provisional.
    const dup = appState.build.nodes.find(
      (n) => n.parent_id === realParent && n.uci === node.uci && n.id !== node.id
    );
    if (dup) {
      appState.buildIdMap[node.id] = dup.id;
      continue;
    }
    appState.build.nodes.push(node);
    appState.buildNodeById.set(node.id, node);
  }
  renderBuilderTree();
}

// Collect a subtree (the flat list keys children by parent_id) and remove it
// from the local tree. Returns the removed ids; rendering is the caller's job.
function pruneLocalBuildSubtree(rootId) {
  const doomed = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of appState.build.nodes) {
      if (!doomed.has(n.id) && doomed.has(n.parent_id)) {
        doomed.add(n.id);
        grew = true;
      }
    }
  }
  appState.build.nodes = appState.build.nodes.filter((n) => !doomed.has(n.id));
  for (const id of doomed) appState.buildNodeById.delete(id);
  return doomed;
}

// Re-prune subtrees whose delete is still queued after a hydrate resurrected
// them (the server hasn't seen the delete yet). Mirrors reapplyPendingBuildNodes
// for the delete half of the local-first queue.
function reapplyPendingBuildDeletes() {
  // Undo-window prunes count too: the server still has those subtrees, so a
  // hydrate resurrects them just like queued-but-unflushed deletes.
  const ids = [
    ...appState.buildPendingDeletes.filter((entry) =>
      buildOpMatchesRepertoire(entry, appState.build.repertoire_id),
    ),
    ...appState.buildUndoDeletes,
  ];
  if (!appState.build || !ids.length) return;
  let pruned = false;
  for (const id of ids) {
    const resolved = resolveBuildId(id);
    const node = appState.buildNodeById.get(resolved);
    if (!node) continue;
    const parentId = node.parent_id;
    const doomed = pruneLocalBuildSubtree(resolved);
    pruned = true;
    if (doomed.has(appState.buildCurrentNodeId) && appState.buildNodeById.has(parentId)) {
      selectBuildNode(parentId);
    }
  }
  if (pruned) renderBuilderTree();
}

// Local-first delete (no confirmation by design — pruning lines is a routine
// Build edit, and the flush model makes it cheap): drop the subtree from the
// client tree immediately, cancel any pending adds inside it, and queue the
// subtree root for the debounced delete flush. A node that never reached the
// server (its add is still pending) is cancelled outright — no server op at all.
async function deleteBuildNodeLocal(nodeId) {
  const node = appState.buildNodeById.get(nodeId);
  if (!node || !appState.build) return;
  if (!node.parent_id) {
    setStatus("Can't delete the starting position");
    return;
  }
  const repId = appState.build.repertoire_id;
  const parentId = node.parent_id;
  const prevSelection = appState.buildCurrentNodeId;
  const prevBranchChoice = appState.buildBranchChoiceId;
  const nodesBefore = appState.build.nodes;
  const doomed = pruneLocalBuildSubtree(nodeId);
  const removedNodes = nodesBefore.filter((n) => doomed.has(n.id));
  // Park pending adds inside the subtree with the undo entry. If the root itself
  // was one of them the server never saw it, so no delete needs to flush for it;
  // descendants of a real root are deleted server-side by the subtree delete anyway.
  const rootWasLocalOnly = appState.buildPending.some((m) => m.tempId === nodeId);
  const parkedAdds = appState.buildPending.filter((m) => doomed.has(m.tempId));
  appState.buildPending = appState.buildPending.filter((m) => !doomed.has(m.tempId));
  if (appState.buildBranchChoiceId && doomed.has(appState.buildBranchChoiceId)) {
    appState.buildBranchChoiceId = null;
  }
  if (doomed.has(appState.buildCurrentNodeId)) {
    await selectBuildNode(parentId);
  } else {
    renderBuilderTree();
  }
  // The delete doesn't queue for the server until the undo window closes; until
  // then it lives in buildUndoDeletes so a reconcile re-hydrate re-prunes it.
  appState.buildUndoDeletes.add(nodeId);
  // Keyed by the deleted move's slot so a replay of the SAME move can commit this
  // delete first (see onBuildBoardMove). The slot is freed in both settle paths.
  const undoMoveKey = `${parentId}:${node.uci}`;
  const extra = doomed.size > 1 ? ` (+${doomed.size - 1} after it)` : "";
  // One notice only: the inline Undo card beside the tree (no extra status
  // toast), so nothing lands on top of the Explorer.
  const undoCommit = showUndoToast({
    host: document.getElementById("build-undo"),
    title: "Move deleted",
    message: `${node.san || "Move"}${extra} removed`,
    onCommit: () => {
      appState.buildUndoCommitByMove.delete(undoMoveKey);
      appState.buildUndoDeletes.delete(nodeId);
      if (!appState.build || appState.build.repertoire_id !== repId) return;
      if (!rootWasLocalOnly) queueBuildDelete(nodeId);
      if (appState.buildPending.length || appState.buildPendingDeletes.length) {
        setBuildSync("dirty");
        scheduleBuildFlush();
      }
    },
    onUndo: async () => {
      appState.buildUndoCommitByMove.delete(undoMoveKey);
      appState.buildUndoDeletes.delete(nodeId);
      if (!appState.build || appState.build.repertoire_id !== repId) return;
      for (const n of removedNodes) {
        if (!appState.buildNodeById.has(n.id)) {
          appState.build.nodes.push(n);
          appState.buildNodeById.set(n.id, n);
        }
      }
      for (const m of parkedAdds) {
        // The parent may have reconciled tmp -> real while the add was parked.
        m.parentRef = resolveBuildId(m.parentRef);
        m.node.parent_id = m.parentRef;
        appState.buildPending.push(m);
      }
      if (
        !appState.buildBranchChoiceId &&
        prevBranchChoice &&
        appState.buildNodeById.has(prevBranchChoice)
      ) {
        appState.buildBranchChoiceId = prevBranchChoice;
      }
      if (prevSelection && appState.buildNodeById.has(prevSelection)) {
        await selectBuildNode(prevSelection);
      } else {
        renderBuilderTree();
      }
      if (parkedAdds.length) {
        setBuildSync("dirty");
        scheduleBuildFlush();
      }
      setStatus(`Restored ${node.san || "move"}`);
    },
  });
  appState.buildUndoCommitByMove.set(undoMoveKey, undoCommit);
}

// Soft drain for read-only refreshes (Library counts): sends whatever is queued
// without closing undo windows, and never throws.
async function settleBuildOutbox() {
  if (!appState.build) return;
  try {
    if (appState.buildFlushing) await appState.buildFlushing;
    if (appState.buildPending.length || appState.buildPendingDeletes.length) {
      clearTimeout(appState.buildFlushTimer);
      appState.buildFlushTimer = null;
      await flushBuildMoves();
    }
  } catch (_) {
    // the outbox retries on its own; the Library just shows server truth
  }
}

// Drain every pending move before an operation that needs server truth or a real
// node id (Generate anchor, export, node actions, repertoire switch). Throws if a
// move can't be synced so the caller can abort rather than 400 on a tmp id.
async function hardFlushBuild() {
  // Open undo windows must close first: server truth has to include those
  // deletes (or the undone restore) before any operation depends on it.
  commitPendingUndos();
  if (!appState.build) return;
  const repId = appState.build.repertoire_id;
  const ownerId = currentOwnerId();
  if (appState.buildFlushing) await appState.buildFlushing.catch(() => {});
  // R-02: drain THIS repertoire's ops. Ops queued for another tree are not
  // part of this request (and must not spin the loop) — they stay on the
  // device until their own repertoire is open.
  const hasWorkForThisRep = () =>
    appState.buildPending.some((m) => buildOpMatchesRepertoire(m, repId)) ||
    appState.buildPendingDeletes.some((entry) => buildOpMatchesRepertoire(entry, repId));
  while (hasWorkForThisRep()) {
    if (ownerId !== currentOwnerId() || appState.build?.repertoire_id !== repId) {
      throw new Error("Repertoire changed before sync completed ? reopen it and try again");
    }
    const ok = await flushBuildMoves();
    if (appState.buildFlushing) await appState.buildFlushing.catch(() => {});
    if (!ok) {
      throw new Error("Couldn't sync your latest moves — check your connection and try again");
    }
  }
}

// Last-ditch flush on page unload. navigator.sendBeacon can't set the CSRF header
// the API requires, so a keepalive fetch (which can) is used instead — fire and
// forget; the next load re-hydrates from server truth regardless.
function beaconFlushBuild() {
  // Close undo windows so their deletes ride this last-ditch flush (the rep
  // delete commit is itself keepalive-safe).
  commitPendingUndos();
  void persistOutbox(); // Best effort only at unload; normal flush checkpoints first.
  if (!appState.build) return;
  const repId = appState.build.repertoire_id;
  // R-02: only this repertoire's ops — a queued op for another tree must not
  // ride this keepalive into the open tree.
  const pending = appState.buildPending.filter((m) => buildOpMatchesRepertoire(m, repId));
  const pendingDeletes = appState.buildPendingDeletes.filter((entry) =>
    buildOpMatchesRepertoire(entry, repId),
  );
  if (!pending.length && !pendingDeletes.length) return;
  const token = readCsrfCookie();
  const send = (path, payload) => {
    try {
      fetch(path, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(token ? { [CSRF_HEADER]: token } : {}) },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch (_) {
      /* best-effort */
    }
  };
  // Same order as the real flush: deletes before adds. Both fire-and-forget;
  // the next page load re-hydrates from server truth regardless.
  const deleteIds = [
    ...new Set(
      pendingDeletes.map(resolveBuildId).filter((id) => !String(id).startsWith("tmp-"))
    ),
  ];
  if (deleteIds.length) {
    send("/api/build/delete-nodes", {
      repertoire_id: repId,
      base_revision: queuedBuildRevision([...pendingDeletes, ...pending], appState.build),
      node_ids: deleteIds,
    });
  }
  if (pending.length) {
    send("/api/build/add-moves", {
      repertoire_id: repId,
      base_revision: queuedBuildRevision(pending, appState.build),
      moves: pending.map((m) => ({
        tempId: m.tempId,
        parentRef: m.parentRef,
        uci: m.uci,
      })),
    });
  }
}

function canonicalBuildUci(fen, uci) {
  const normalized = normalizeUci(uci);
  // A rook/queen can legally move along these same squares. Only translate
  // king-to-rook notation when the raw move is not legal in this position.
  return normalized !== uci && !localBoardInfo(fen).legal_moves.includes(uci) ? normalized : uci;
}

async function onBuildBoardMove(moveUci) {
  if (appState.buildLoading) return;
  // Explorer castling uses king-to-rook UCI; the board, local tree and
  // durable queue all use the standard king destination instead.
  const moveParent = appState.buildNodeById.get(appState.buildCurrentNodeId);
  moveUci = canonicalBuildUci(moveParent?.fen || boards.build.fen, moveUci);
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account to edit");
    return;
  }
  // Show the move immediately. Snapshot the pre-move position so a failed local
  // apply (or a cancelled repertoire-creation prompt) can roll the board back.
  // The first-move case (no repertoire yet) skips the optimistic render — it
  // opens a modal instead.
  const prevFen = boards.build.fen;
  const prevLegal = boards.build.legalMoves;
  const hadRep = appState.build && appState.buildCurrentNodeId;
  const optimistic = hadRep ? await optimisticBoardMove(boards.build, prevFen, moveUci) : false;
  const rollback = () => {
    if (optimistic && prevFen) {
      boards.build.setPosition({ fen: prevFen, legalMoves: prevLegal, lastMove: null });
    }
  };

  // Bootstrap: the very first move on an empty workspace still creates the
  // repertoire server-side (a modal), then we play onto its real root locally.
  if (!hadRep) {
    // A guest's move would need a repertoire to live in: show the sign-in
    // gate (with its reason) instead of a "Cancelled" for a choice never made.
    if (!requireSignIn("Sign in to save moves to a repertoire", "new-repertoire")) {
      rollback();
      return;
    }
    let created;
    try {
      created = await createRepertoirePrompt({
        title: "Start a new repertoire",
        defaultName: "New repertoire",
      });
    } catch (error) {
      rollback();
      setStatusError(error.message);
      return;
    }
    if (!created) {
      setStatus("Cancelled · playing the move would create a new repertoire");
      rollback();
      return;
    }
  }

  const parentId = appState.buildCurrentNodeId;
  const parent = appState.buildNodeById.get(parentId);
  if (!parent) {
    rollback();
    return;
  }

  // Replaying a move whose old subtree is still inside its undo window: that delete
  // hasn't reached the server yet, so the server still has the old child. Commit the
  // delete NOW so it flushes BEFORE this re-add lands in the same batch — otherwise
  // add-moves dedupes the replay into the still-living old node, and the queued
  // delete then destroys it (taking the replayed move with it). This is the
  // delete-before-add invariant, enforced across the undo-window boundary.
  const parkedDeleteCommit = appState.buildUndoCommitByMove.get(`${parentId}:${moveUci}`);
  if (parkedDeleteCommit) parkedDeleteCommit();

  // Dedupe (parity with the server): replaying an existing line just navigates to
  // the child — no provisional node, no dirty state.
  const existing = appState.build.nodes.find(
    (n) => n.parent_id === parentId && canonicalBuildUci(parent.fen, n.uci) === moveUci
  );
  if (existing) {
    await selectBuildNode(existing.id);
    return;
  }

  let after;
  try {
    after = await boardAfterMove(parent.fen, moveUci);
  } catch (_) {
    rollback();
    setStatus("Illegal move");
    return;
  }

  const node = buildProvisionalNode(parent, moveUci, after);
  appState.build.nodes.push(node);
  appState.buildNodeById.set(node.id, node);
  appState.buildPending.push({
    tempId: node.id,
    base_revision: appState.build?.revision,
    parentRef: parentId,
    uci: moveUci,
    node,
    // R-02: the target travels with the op, so a reload/restored queue can
    // never be flushed into whichever repertoire happens to be open.
    repertoire_id: appState.build ? appState.build.repertoire_id : null,
  });
  await selectBuildNode(node.id);
  setBuildSync("dirty");
  scheduleBuildFlush();
}

async function createRepertoirePrompt({ title, defaultName, openAfter = true, defaultColor = "white" } = {}) {
  if (!requireSignIn("Sign in to create a repertoire", "new-repertoire")) return null;
  const result = await showInputModal({
    title: title || "New repertoire",
    okLabel: "Create",
    fields: [
      { name: "name", label: "Name", default: defaultName || "New repertoire" },
      repertoireColorField(defaultColor),
    ],
  });
  if (!result) return null;
  const name = (result.name || "").trim() || "New repertoire";
  const color = normalizeRepertoireColor(result.color);
  try {
    const payload = await postJson("/api/repertoires/create", { name, color });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    if (openAfter) switchView("build");
    setStatus(`Created ${name}`);
    await refreshDashboardRepertoires();
    return payload;
  } catch (error) {
    setStatusError(error.message);
    return null;
  }
}

// Make an element accept dropped files. `onFile` receives the first file; the
// element gets a .drag-over class while a drag hovers for visual feedback.
function bindDropZone(element, onFile) {
  if (!element) return;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.add("drag-over");
    })
  );
  ["dragleave", "dragend"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.remove("drag-over");
    })
  );
  element.addEventListener("drop", (event) => {
    stop(event);
    element.classList.remove("drag-over");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

// Drop a PGN file onto the Analyze textarea to load its text (ready to Analyze).
async function fillPgnInputFromFile(file) {
  const sourceSeq = invalidateAnalysisSource();
  const ownerId = currentOwnerId();
  appState.analysisFileSeq = sourceSeq;
  const isCurrent = () => appState.analysisFileSeq === sourceSeq && ownerId === currentOwnerId();
  try {
    const text = await file.text();
    if (!isCurrent()) return;
    document.getElementById("pgn-input").value = text;
    const drawer = document.querySelector("#view-analyze .drawer");
    if (drawer) drawer.open = true;
    const loaded = await loadPgnIntoAnalyze(text, { goToEnd: false, sourceSeq });
    if (!isCurrent() || !loaded) return;
    orientAnalysisFromPgn(text);
    setStatus(`Loaded ${file.name}`);
  } catch (error) {
    if (isCurrent()) setStatusError(`Could not load file: ${error.message}`);
  }
}

// Rough up-front size of a Build → Generate run, for the dialog's estimate and the
// progress bar's ceiling. Your side always gets one move (the engine's best); each
// opponent position keeps the replies humans play at least `mainThreshold` of the time
// on the mainline path and `branchThreshold` inside side branches. The reply count per
// position is a heuristic over typical Maia distributions (~3 at 10%, ~1.7 at 30%).
// A 20% buffer lets the bar finish a touch early.
function estimateBuildGenerateTotal({ plyDepth, mainThreshold, branchThreshold, userToMove = true }) {
  const depth = Math.max(1, Number(plyDepth) || 1);
  const repliesAt = (share) => Math.min(6, 1 + 0.2 / Math.max(0.01, Number(share) || 0.1));
  const mainReplies = repliesAt(mainThreshold ?? GEN_DEFAULT_MAIN_PCT / 100);
  const branchReplies = repliesAt(branchThreshold ?? GEN_DEFAULT_BRANCH_PCT / 100);
  let branchNodes = 0; // nodes off the mainline path at the current ply
  let total = 0;
  for (let ply = 1; ply <= depth; ply++) {
    const userPly = userToMove ? ply % 2 === 1 : ply % 2 === 0;
    if (!userPly) branchNodes = branchNodes * branchReplies + (mainReplies - 1);
    total += 1 + branchNodes; // the mainline node plus everything branched off it
  }
  return Math.max(4, Math.ceil(total * 1.2));
}

// Generate dialog: every knob in plain view, no presets. Depth is counted in full
// moves (one of yours plus their reply); the tree always ends on your answer.
// Opponent coverage has two cut-offs: on the mainline path and inside side branches. Kept conservative: the recursion runs locally and a huge tree risks the
// server apply-plan caps. See GEN_MAX_* / GEN_PLAN_CHANGES_SOFT_CAP.
const GEN_MAX_OWN_MOVES = GEN_MAX_PLY_DEPTH / 2;
const GEN_DEFAULT_OWN_MOVES = 6;
const GEN_DEFAULT_MAIN_PCT = 10;
const GEN_DEFAULT_BRANCH_PCT = 30;

function generateDialogFields() {
  return [
    {
      name: "own_moves",
      label: `Full moves deep (1-${GEN_MAX_OWN_MOVES})`,
      hint: "A full move is one of yours plus their reply.",
      type: "number",
      default: GEN_DEFAULT_OWN_MOVES,
      min: 1,
      max: GEN_MAX_OWN_MOVES,
    },
    {
      name: "main_pct",
      label: "Cover mainline replies played at least (%)",
      hint: "Opponent moves below this share of human games are left out.",
      type: "number",
      default: GEN_DEFAULT_MAIN_PCT,
      min: 1,
      max: 50,
    },
    {
      name: "branch_pct",
      label: "Cover branch replies played at least (%)",
      hint: "Same cut-off, applied inside side branches.",
      type: "number",
      default: GEN_DEFAULT_BRANCH_PCT,
      min: 1,
      max: 50,
    },
    // Defaults to the player's own strength (Settings → Playing strength), so the
    // tree leans toward replies THEIR opponents actually play.
    {
      name: "maia_rating",
      label: "Opponent rating (600-2600)",
      type: "number",
      default: effectiveMaiaRating(),
      min: 600,
      max: 2600,
      step: 50,
    },
    // Per-position Stockfish search depth for this run; Settings holds the default.
    {
      name: "engine_depth",
      label: `Engine depth (${STOCKFISH_MIN_DEPTH}-${STOCKFISH_MAX_DEPTH})`,
      type: "number",
      default: effectiveStockfishDepth(),
      min: STOCKFISH_MIN_DEPTH,
      max: STOCKFISH_MAX_DEPTH,
    },
    { name: "estimate", label: "", type: "note" },
  ];
}

function clampGenerateInt(raw, min, max, fallback) {
  const n = Math.round(Number(String(raw ?? "").trim() || NaN));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// `userToMove`: whose turn it is at the anchor. Your first move starts the tree
// there, so N moves of yours take 2N-1 plies; otherwise the opponent's reply
// comes first and they take 2N. Either way the tree ends on your answer.
function readGenerateOptions(values, { userToMove = true } = {}) {
  const ownMoves = clampGenerateInt(values.own_moves, 1, GEN_MAX_OWN_MOVES, GEN_DEFAULT_OWN_MOVES);
  const plyDepth = Math.min(GEN_MAX_PLY_DEPTH, userToMove ? 2 * ownMoves - 1 : 2 * ownMoves);
  return {
    plyDepth,
    userToMove,
    mainThreshold: clampGenerateInt(values.main_pct, 1, 50, GEN_DEFAULT_MAIN_PCT) / 100,
    branchThreshold: clampGenerateInt(values.branch_pct, 1, 50, GEN_DEFAULT_BRANCH_PCT) / 100,
    maiaRating: clampGenerateInt(values.maia_rating, 600, 2600, effectiveMaiaRating()),
    engineDepth: clampGenerateInt(
      values.engine_depth,
      STOCKFISH_MIN_DEPTH,
      STOCKFISH_MAX_DEPTH,
      effectiveStockfishDepth(),
    ),
  };
}

// Rough range from the same model that sizes the progress bar. Moves already in the
// repertoire are reused, so the real number is often lower (said in the tooltip).
function generateEstimateRange(options) {
  const ceiling = estimateBuildGenerateTotal(options);
  const nice = (n) => (n >= 50 ? Math.round(n / 10) * 10 : n >= 20 ? Math.round(n / 5) * 5 : Math.round(n));
  const low = Math.max(1, nice(ceiling * 0.4));
  const high = Math.max(low + 1, nice(ceiling));
  return { low, high };
}

function generateEstimateText(options) {
  const { low, high } = generateEstimateRange(options);
  return `About ${low}–${high} new moves`;
}

function captureBuildContext() {
  const repertoireId = appState.build?.repertoire_id;
  const seq = buildLoadSeq;
  const owner = currentOwnerId();
  return () => repertoireId === appState.build?.repertoire_id && seq === buildLoadSeq && owner === currentOwnerId();
}

async function generateFromCurrentNode() {
  // True click origin for [engine-lifecycle] timing: recorded before any
  // toast/status/rAF so click → feedback-paint measures the real delay.
  const tGenerate = engineLifecycleMark("build-generate-click");
  // Phase 3c: generation runs in the BROWSER. Stockfish (our turn) + Maia3
  // (opponent) drive the recursion locally into a tree-mutation plan; the server
  // only re-validates + persists via /api/build/generate/apply-plan. No server
  // compute, no fallback.
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account to edit");
    return;
  }
  if (!isBrowserEngineAvailable()) {
    setStatusError(BROWSER_ENGINE_UNAVAILABLE);
    return;
  }
  const isCurrent = captureBuildContext();
  const generationBuild = appState.build;
  let nodeId = appState.buildCurrentNodeId;
  if (!appState.build || !nodeId) {
    setStatus("Open or create a repertoire first");
    return;
  }
  if (jobToast.isBusy()) {
    setStatus("Another job is already running", { severity: "warning" });
    return;
  }
  // apply-plan anchors on a REAL node id — a tmp anchor would 400. Drain any
  // pending local moves first, then re-resolve the (now-real) anchor id.
  try {
    await hardFlushBuild();
    if (!isCurrent()) return;
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  nodeId = resolveBuildId(nodeId);
  const ownColor = appState.build.color === "black" ? "black" : "white";
  const anchorFen = appState.buildNodeById.get(nodeId)?.fen || "";
  const userToMove = (anchorFen.split(" ")[1] === "b" ? "black" : "white") === ownColor;
  const values = await showInputModal({
    title: "Generate moves from this position",
    okLabel: "Generate",
    fields: generateDialogFields(),
    onInput: (current, overlay) => {
      const note = overlay.querySelector('[data-note="estimate"]');
      if (!note) return;
      note.textContent = generateEstimateText(readGenerateOptions(current, { userToMove }));
      note.title = "Fewer where your repertoire already has the moves";
    },
  });
  if (!values || !isCurrent()) return;
  const generateOptions = readGenerateOptions(values, { userToMove });
  const { plyDepth, mainThreshold, branchThreshold, maiaRating, engineDepth } = generateOptions;

  const jobId = `browser-generate-${Date.now()}`;
  const generatedRepertoireId = appState.build.repertoire_id;
  const generatedBaseRevision = appState.build.revision;
  // Cancel model has two phases. GENERATION (local, before the POST) is
  // cancellable: jobToast's Stop aborts the controller, the recursion checks the
  // signal, and an explicit re-check below bails before the POST — so Stop here
  // persists NOTHING. SAVING (the apply-plan POST) is NOT cancellable: an atomic
  // server apply can't be un-persisted by aborting the fetch, so we remove the
  // Stop button before the POST rather than imply a cancel that wouldn't hold.
  const controller = new AbortController();
  // Believable progress: estimate a ceiling, advance a little whenever the planner adds
  // nodes, and — when the engine is busy but quiet — inch forward on a timer so the bar
  // never looks stuck. It is capped just below `total` until generation truly finishes,
  // so it can't fake completion. `lastInitAt` lets the Maia cold-download own the toast.
  const progress = {
    done: 0,
    total: estimateBuildGenerateTotal(generateOptions),
    plannedMoves: 0,
  };
  let lastInitAt = 0;
  let nudgeTimer = null;
  try {
    setStatus("Loading engines and generating moves");
    jobToast.startJob({
      id: jobId,
      title: "Generating moves",
      tab: "build",
      dock: document.getElementById("build-job-dock"),
      total: progress.total,
      onCancel: () => controller.abort(),
    });

    nudgeTimer = setInterval(() => {
      if (!jobToast.isBusy()) return;
      if (Date.now() - lastInitAt < 2000) return; // let Maia cold-init progress own the toast
      progress.done = Math.min(progress.total - 3, progress.done + 1);
      jobToast.updateJob({
        current: progress.done,
        total: progress.total,
        message: progress.plannedMoves
          ? `building tree · +${progress.plannedMoves} moves`
          : "searching candidate moves",
      });
    }, 1800);

    // Yield so the toast/status above paints before the module import below
    // blocks the main thread on fetch + evaluate. The runner import and the
    // shared Maia warmup (worker spawn + ~46 MB weight fetch + ORT session)
    // start in the same tick and proceed in parallel; the pipeline awaits the
    // same shared ready promise only when it reaches the first Maia inference,
    // so one Generate never spawns a second worker/session or re-downloads.
    // The timeout keeps a hidden tab (no animation frames) from stalling the run.
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
      setTimeout(resolve, 100);
    });
    engineLifecycleMark("build-feedback-paint", tGenerate);
    const maiaReady = getSharedMaia3Provider().warmup();
    engineLifecycleMark("build-maia-init-start", tGenerate);
    const { runBrowserBuildGenerate } = await (_buildGenReady || preloadBuildGen());
    engineLifecycleMark("build-runner-import-done", tGenerate);
    if (maiaReady && typeof maiaReady.then === "function") {
      // Do NOT block the Stockfish-led opening moves on this: just note when
      // the shared init lands, so timing shows the parallel window. The first
      // Maia inference inside the runner awaits the same promise.
      maiaReady.then(
        () => engineLifecycleMark("build-maia-ready", tGenerate),
        () => engineLifecycleMark("build-maia-ready-error", tGenerate),
      );
    }
    engineLifecycleMark("build-inference-start", tGenerate);
    const plan = await runBrowserBuildGenerate({
      build: generationBuild,
      rootNodeId: nodeId,
      ownColor,
      plyDepth,
      maiaRating,
      mainThreshold,
      branchThreshold,
      // Per-position Stockfish search depth (NOT the tree's ply depth).
      depth: engineDepth,
      signal: controller.signal,
      // Reuse ONE warm Maia worker/session across Generate runs (Stage 4b) — the first run
      // downloads + caches the ~46 MB model, later runs skip both the fetch and the session
      // create. The orchestrator borrows it and never terminates it. Build
      // Generate is a Maia-by-design capability (human-like opponent branches),
      // independent of the Analyze-layer Maia analysis switch.
      maiaProvider: getSharedMaia3Provider(),
      onProgress: (added) => {
        // `added` is planned nodes, not engine work — so don't map it 1:1 onto the bar.
        // Each report nudges forward a bit, capped just short of `total`.
        progress.plannedMoves = added;
        progress.done = Math.min(
          progress.total - 2,
          Math.max(progress.done + 1, Math.ceil(added * 0.75)),
        );
        jobToast.updateJob({
          current: progress.done,
          total: progress.total,
          message: progress.plannedMoves
            ? `expanding branches · +${added} moves`
            : "expanding branches",
        });
      },
      // Real lifecycle stream from the planner. We only use it to keep the MESSAGE honest
      // about what the engine is doing right now ("searching candidates" vs "consulting
      // Maia") — the bar itself stays on the estimated-unit scale that onProgress and the
      // nudge timer drive, so a chatty stream can't fake completion. Skipped while the Maia
      // cold-init owns the toast (its download % is more useful there).
      onEvent: (ev) => {
        if (!jobToast.isBusy()) return;
        if (Date.now() - lastInitAt < 2000) return;
        if (ev && ev.type === "search") {
          const base = progress.plannedMoves ? `+${progress.plannedMoves} moves · ` : "";
          jobToast.updateJob({
            message:
              ev.engine === "maia"
                ? `${base}consulting Maia for human replies`
                : `${base}searching candidate moves`,
          });
        }
      },
      // Cold-init weight download/verify/session progress (only on the first run / a cache
      // miss). A warm run emits nothing, so the node-building message above just takes over.
      // Zero-progress maia-init phase on purpose: byte-sized current/total would ratchet
      // activeTotal to ~46M and peg the bar near 95%; the download % rides in the message
      // instead while the bar scans until tree generation resumes onProgress ticks.
      onMaiaInitProgress: ({ phase, loaded, total }) => {
        lastInitAt = Date.now();
        if (phase === "download") {
          const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: `downloading Maia model · ${pct}%`,
          });
        } else if (phase === "cache") {
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: "loading cached Maia model",
          });
        } else if (phase === "verify") {
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: "verifying Maia model",
          });
        } else if (phase === "session") {
          jobToast.updateJob({
            current: 0,
            total: 1,
            phase: "maia-init",
            message: "starting Maia engine",
          });
        }
      },
    });
    if (nudgeTimer) {
      clearInterval(nudgeTimer);
      nudgeTimer = null;
    }

    // Stop pressed during generation (or in the final stretch before we got
    // here) must mean NOTHING is persisted: bail before the POST. The recursion
    // also checks the signal, but it can resolve a tick after the last check.
    if (controller.signal.aborted) {
      const err = new Error("Generation stopped");
      err.name = "AbortError";
      throw err;
    }

    const changeCount = (plan.changes && plan.changes.length) || 0;
    if (changeCount > GEN_PLAN_CHANGES_SOFT_CAP) {
      // The server would reject this with a 400; fail with an actionable message
      // before wasting the round trip.
      throw new Error(
        `That produced ${changeCount} changes, more than the server accepts ` +
          `(${GEN_PLAN_CHANGES_SOFT_CAP}). Lower the ply depth or branch count and try again.`,
      );
    }

    // Committing to the save now. Aborting the apply-plan fetch can't un-persist
    // an atomic server apply, so the saving phase is NOT cancellable: remove the
    // Stop button (synchronously, before the awaited POST, so no late click can
    // land in the gap) rather than let the UI imply a cancel that wouldn't hold.
    jobToast.updateJob({
      current: progress.total,
      total: progress.total,
      message: "saving",
    });
    jobToast.lockJob("saving — finishing up");
    const payload = await postJson(
      "/api/build/generate/apply-plan",
      {
        repertoire_id: generatedRepertoireId,
        base_revision: generatedBaseRevision,
        root_node_id: nodeId,
        plan,
      },
      { signal: controller.signal },
    );
    if (isCurrent()) await hydrateBuild(payload, nodeId);
    const summary = payload.summary || {};
    setStatus(
      `Generated from ${appState.buildNodeById.get(nodeId)?.san || "node"} · +${summary.added_nodes || 0} new`
    );
    jobToast.completeJob({
      title: "Generation done",
      message: `+${summary.added_nodes || 0} new moves`,
      onClick: () => switchView("build"),
    });
  } catch (error) {
    if (error && (error.name === "AbortError" || error.cancelled)) {
      // Aborted before the POST: nothing persisted, existing tree still rendered.
      setStatus("Generation stopped");
      jobToast.cancelJob("Generation stopped");
    } else {
      setStatusError(error.message);
      jobToast.failJob(error.message);
    }
  } finally {
    if (nudgeTimer) clearInterval(nudgeTimer);
  }
}

function openNodeContextMenu(event, nodeId) {
  event.preventDefault();
  if (isBuildReadOnly()) return;
  const node = appState.buildNodeById.get(nodeId);
  if (!node) return;
  const menu = document.getElementById("node-context-menu");
  const sections = [
    {
      title: "Position",
      items: [
        ["generate", "Generate from here"],
      ],
    },
    {
      title: "Branch",
      items: [
        ["set_mainline", node.is_mainline ? "Mainline (active)" : "Set as mainline"],
        ["mark_prepared", node.is_prepared ? "Unmark prepared" : "Mark prepared"],
        ["disable_branch", node.is_enabled ? "Disable branch" : "Re-enable branch"],
      ],
    },
    {
      title: "Annotate",
      items: [
        ["add_comment", "Comment..."],
        ["add_tag", "Tag..."],
      ],
    },
    {
      title: "Copy / Export",
      items: [
        ["copy_fen", "Copy FEN"],
        ["copy_line_pgn", "Copy line PGN"],
        ["export_branch_pgn", "Export branch PGN"],
      ],
    },
    {
      title: "Danger",
      items: [["delete", "Delete this move"]],
    },
  ];
  const safeId = escapeHtml(nodeId);
  menu.innerHTML =
    `<div class="context-target" data-testid="context-target">${escapeHtml(nodeMenuHeading(node))}</div>` +
    sections
    .map(
      (section) =>
        `<div class="context-section">${escapeHtml(section.title)}</div>` +
        section.items
          .map(
            ([action, label]) =>
              `<button type="button" data-action="${escapeHtml(
                action
              )}" data-node-id="${safeId}">${escapeHtml(label)}</button>`
          )
          .join("")
    )
    .join("");
  menu.hidden = false;
  markNodeMenuTarget(nodeId);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () =>
      handleNodeContextAction(button.dataset.action, button.dataset.nodeId)
    );
  });
}

async function handleNodeContextAction(action, nodeId) {
  closeNodeContextMenu();
  let node = appState.buildNodeById.get(nodeId);
  if (!node) return;
  // Delete is local-first (and confirmation-free): prune the subtree from the
  // client tree immediately and let the debounced flush tell the server. No
  // hard flush — the delete queue handles tmp/real resolution itself.
  if (action === "delete") {
    await deleteBuildNodeLocal(nodeId);
    return;
  }
  // Every other action references the node by id on the server (or, for generate,
  // anchors apply-plan on it). Drain pending local moves so a tmp id is real, then
  // resolve this node's id (it may have just been minted locally) + re-read it.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  nodeId = resolveBuildId(nodeId);
  node = appState.buildNodeById.get(nodeId) || node;
  try {
    if (action === "generate") {
      // The flush above may have reconciled/removed this node. Never anchor Generate
      // on a node that no longer exists (it would open a modal that silently can't
      // apply). Select through the normal path so board + tree + current id stay in sync.
      if (!appState.buildNodeById.has(nodeId)) {
        setStatus("That position is no longer in your repertoire — try again");
        return;
      }
      await selectBuildNode(nodeId);
      await generateFromCurrentNode();
      return;
    }
    if (action === "export_branch_pgn") {
      await exportBuild("pgn", nodeId);
      return;
    }
    if (action === "copy_fen") {
      await navigator.clipboard.writeText(node.fen);
      setStatus("FEN copied");
      return;
    }
    if (action === "copy_line_pgn") {
      const payload = await postJson("/api/build/export", {
        repertoire_id: appState.build.repertoire_id,
        format: "pgn",
        node_id: nodeId,
      });
      await navigator.clipboard.writeText(payload.content);
      setStatus("Line PGN copied");
      return;
    }
    let value = null;
    if (action === "add_comment") {
      const result = await showInputModal({
        title: "Comment",
        okLabel: "Save",
        fields: [
          { name: "comment", label: "Comment", type: "textarea", default: node.comment || "" },
        ],
      });
      if (!result) return;
      value = result.comment;
    } else if (action === "add_tag") {
      const result = await showInputModal({
        title: "Add tag",
        okLabel: "Add",
        fields: [{ name: "tag", label: "Tag name", default: "" }],
      });
      if (!result) return;
      value = (result.tag || "").trim();
      if (!value) {
        setStatus("Tag is empty");
        return;
      }
    }
    const payload = await postJson("/api/build/action", {
      repertoire_id: appState.build.repertoire_id,
      node_id: nodeId,
      action,
      value,
    });
    await hydrateBuild(payload, nodeId);
    setStatus("Node updated");
  } catch (error) {
    setStatusError(error.message);
  }
}

function closeNodeContextMenu() {
  document.getElementById("node-context-menu").hidden = true;
  markNodeMenuTarget(null);
}

// Outline the tree move the context menu acts on while it is open.
function markNodeMenuTarget(nodeId) {
  document.querySelectorAll(".mtree-move.is-menu-target").forEach((el) => el.classList.remove("is-menu-target"));
  if (nodeId == null) return;
  const id = String(nodeId);
  document.querySelectorAll(".mtree-move[data-node-id]").forEach((el) => {
    if (el.dataset.nodeId === id) el.classList.add("is-menu-target");
  });
}

async function exportBuild(format, nodeId = null) {
  if (!appState.build) {
    setStatus("Open a repertoire first");
    return;
  }
  const repertoireId = appState.build.repertoire_id;
  const ownerId = currentOwnerId();
  // Export reads server-side tree state (and may scope to a node id) — sync first.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatusError(error.message);
    return;
  }
  if (ownerId !== currentOwnerId()) return;
  if (nodeId) nodeId = resolveBuildId(nodeId);
  // Full tree-with-variations PGN for top-level "Export PGN" calls
  if (format === "pgn" && !nodeId) {
    const payload = await api(
      `/api/repertoires/export-pgn?repertoire_id=${encodeURIComponent(repertoireId)}`
    );
    if (ownerId !== currentOwnerId()) return;
    downloadText(payload.filename, payload.mime, payload.content);
    setStatus(`Downloaded ${payload.filename}`);
    return;
  }
  const payload = await postJson("/api/build/export", {
    repertoire_id: repertoireId,
    format,
    node_id: nodeId,
  });
  if (ownerId !== currentOwnerId()) return;
  downloadText(payload.filename, payload.mime, payload.content);
  setStatus(`Downloaded ${payload.filename}`);
}

async function importRepertoireFromInput(inputId) {
  try {
    const packageJson = await readSelectedFile(document.getElementById(inputId));
    const payload = await postJson("/api/repertoires/import", { package_json: packageJson });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    setStatus(`Imported ${payload.name}`, { severity: "success" });
  } catch (error) {
    setStatusError(error.message);
  }
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
            `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} (${escapeHtml(r.color)})</option>`,
        )
      : [
          appState.signedIn
            ? '<option value="" disabled selected>Create a repertoire first</option>'
            : '<option value="" disabled selected>Sign in to train your repertoires</option>',
        ];
    select.innerHTML = options.join("");
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
    host.innerHTML = list
      .map((rep) => {
        const id = escapeHtml(rep.id);
        const checked = selected.has(String(rep.id)) ? " checked" : "";
        const color = rep.color === "black" ? "Black" : "White";
        return `<label class="train-repertoire-option" data-repertoire-id="${id}">
          <input type="checkbox" data-repertoire-id="${id}"${checked} />
          <span class="rep-option-name">${escapeHtml(rep.name || "Untitled repertoire")}</span>
          <span class="rep-option-color">${color}</span>
        </label>`;
      })
      .join("");
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
// setup needs no repertoire picker; line rehearsal (legacy) keeps it.
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

// Before Start: show review moves and available new moves from the health summary.
// The scheduler merges targets and adds polish, so these are not card counts. Cached briefly
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
        api(`/api/train/smart/summary?mixed=true&local_date=${encodeURIComponent(localDateString())}`),
      ]);
      trainPreviewCache.text = mod.sessionPreviewText(payload && payload.health);
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

// The player's calendar day in their own timezone (not UTC) — the server keys
// the daily training streak off this so a late-evening session counts for the
// day the player actually lived it.
function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A server timestamp (UTC ISO) as the player's local calendar day. Timestamps
// without an offset are UTC too.
function localDayOf(iso) {
  const raw = String(iso || "");
  if (!raw.includes("T")) return raw.slice(0, 10); // already a calendar day
  const stamp = /[zZ]$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? raw.slice(0, 10) : localDateString(d);
}

function setTrainBanner(state, title, sub) {
  const banner = document.getElementById("train-banner");
  if (!banner) return;
  banner.dataset.state = state;
  const titleEl = document.getElementById("train-banner-title");
  const subEl = document.getElementById("train-banner-sub");
  titleEl.textContent = title;
  titleEl.title = title || "";
  subEl.textContent = sub || "";
  subEl.title = sub || "";
  if (state === "correct" || state === "wrong") {
    banner.classList.remove("flash");
    void banner.offsetWidth;
    banner.classList.add("flash");
  }
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
  // ----- legacy line rehearsal (all_lines) below -----
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

const PLAY_COLOR_KEY = "prepforge.play_color";

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
    ? `<span class="play-trail-sans">${escapeHtml(text)}</span>`
    : `<span class="trail-empty">No moves yet</span>`;
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
  const startKey = START_FEN.split(" ").slice(0, 4).join(" ");
  const out = {};
  for (const rep of repertoires || []) {
    const matching = (rep.nodes || [])
      .filter((node) => node && key(node.fen) === target && node.is_enabled !== false)
      .map((node) => node.id);
    // A non-start Lucky FEN is deliberately outside the local trees. Falling
    // back to a repertoire root here would make an unrelated opening reply
    // appear to be in-book. Roots are only a safe fallback for the actual
    // starting position when a legacy payload omitted its FEN.
    const root = (rep.nodes || []).find((node) => node && node.id === rep.rootId);
    const rootMatches = root && (!root.fen ? target === startKey : key(root.fen) === target);
    out[rep.id] = matching.length ? matching : rootMatches && rep.rootId ? [rep.rootId] : [];
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

async function ensurePlayExplorer() {
  if (!explorerModule) {
    explorerModule = await import("./explorer.js");
    explorerClient = explorerModule.createExplorerClient({});
  }
  return explorerClient;
}

async function fetchPlayExplorer(fen) {
  try {
    const client = await ensurePlayExplorer();
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
    const { runFeelingLucky } = await import("./feeling-lucky.js");
    dbPicked = await runFeelingLucky({
      storage: typeof localStorage === "undefined" ? null : localStorage,
      exclude: [appState.lastLuckyFen, appState.play && appState.play.startFen].filter(Boolean),
      rating: effectiveMaiaRating(),
      preferDynamic: true,
      ensureExplorer: ensurePlayExplorer,
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
  let result;
  try {
    result = await api("/api/train/move", {
      method: "POST",
      body: JSON.stringify({
        session_id: prompt.session_id,
        played_uci: playedUci,
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

  stats.correct += 1;
  stats.streak += 1;
  stats.best = Math.max(stats.best, stats.streak);
  stats.history.push(true);
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
  setTrainBanner("correct", "Correct!", result.played_san ? `You played ${result.played_san}` : "");

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

function updateTrainTurnBadge(side) {
  const badge = document.getElementById("train-turn-badge");
  if (!badge) return;
  if (!side) {
    badge.hidden = true;
    badge.innerHTML = "";
    badge.title = "";
    delete badge.dataset.side;
    return;
  }
  badge.hidden = false;
  badge.dataset.side = side;
  badge.title = side === "white" ? "White to move" : "Black to move";
  // Show the side-to-move as a real piece (king of that colour), not a bare
  // letter. Pieces are inline SVG (see pieceSvg) — there is no PNG asset.
  badge.innerHTML = pieceSvg(side === "white" ? "K" : "k");
}

// ===== Smart queue trainer (Train v2) ========================================
//
// Card-based scheduler client over /api/train/smart/*. The flow per card:
// run-in animation (the approach plays itself, the opponent's last move is the
// recall cue) → prompt. New cards are taught first (arrow + idea, play it
// once); everything else is tested cold. Failure is two-stage: first miss
// auto-hints and lets the player retry (attempt 2, ungraded server-side),
// second miss reveals the answer and the card returns a few positions later.
// Only attempt 1 is graded, so the accuracy chips match the server's
// spaced-repetition writes.

const SMART_KIND_LABELS = {
  weak: "Weak spot",
  due: "Due review",
  new: "New move",
  polish: "Polish",
};

// Hover definitions for the queue-composition chips ("3 weak · 4 due · ...").
// Same meanings as the Train help drawer and services/progress.py.
const SMART_KIND_TITLES = {
  weak: "Missed more than answered",
  due: "Spaced repetition says now",
  new: "Shown once, then tested",
  polish: "Kept warm with an occasional rep",
};

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

// ----- Blitz mode: an answer clock per card (smart queue only) ---------------
//
// Entirely client-side. A timeout submits the null move "0000" as attempt 1, so
// the server grades an honest first-attempt miss — in blitz, not producing the
// move in time means it isn't known cold. Teach prompts (kind=new) and retries
// are untimed; the toggle is read once at session start.

const BLITZ_KEY = "prepforge-blitz";
const BLITZ_SECONDS = 10;

function blitzEnabled() {
  try {
    return localStorage.getItem(BLITZ_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function setBlitzEnabled(on) {
  try {
    if (on) localStorage.setItem(BLITZ_KEY, "1");
    else localStorage.removeItem(BLITZ_KEY);
  } catch (_) { /* private mode: the toggle just won't persist */ }
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
    trainSessionMemo ||= await import("./train-session-memo.js");
  } catch (_) { /* recovery is optional if the chunk cannot load */ }
  if (!isCurrent()) return;
  const mapped = trainResume.mapTrainUiSession(payload, { fresh });
  // A resumed session without a memo must not inherit unrelated counters.
  trainStatsReset();
  appState.training = null; // leave legacy mode if it was active
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
      `${SMART_KIND_LABELS[prompt.kind] || "Review"} · ${cueSan ? `answer ${cueSan}` : "play your prep"}`,
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
  void import("./controllers/train-coach.js").then((mod) => {
    if (appState.smart?.prompt !== prompt) return;
    return mod.prefetchTrainCoach(prompt, { appState, maiaPhaseCoach, setTrainBanner, trainTeachLine });
  }).catch((error) => { if (appState.smart?.prompt === prompt) console.warn("Train coach unavailable", error); });
}

// Mirror of services/training_smart.REQUEUE_GAP — keep in sync.
const SMART_REQUEUE_GAP = 3;

// After a second wrong attempt the card returns a few positions later — unless
// an identical copy is already pending, so a stubborn miss queues one retry at
// a time. Parity with SmartTrainingService._requeue_card.
function requeueSmartCard(smart) {
  const card = smart.queue[smart.cardIndex];
  if (!card) return false;
  const pendingAhead = smart.queue.slice(smart.cardIndex + 1);
  if (pendingAhead.some((c) => c.encoded === card.encoded)) return false;
  const insertAt = Math.min(smart.cardIndex + SMART_REQUEUE_GAP, smart.queue.length);
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
  if (attempt === 1) queueTrainAttempt(smart, prompt.expected_node_id, correct);
  if (correct) trackPreparationPractice({
    repertoireId: smart.queue[smart.cardIndex]?.repertoire_id || smart.repertoireId,
    nodeId: prompt.expected_node_id, fen: prompt.fen_before, completed: true,
  });
  const stats = appState.trainStats || (trainStatsReset(), appState.trainStats);

  if (!correct) {
    // Only the first answer is graded (matches the synced SR write); the
    // accuracy chips therefore never count retries.
    if (attempt === 1) {
      stats.mistakes += 1;
      // A first-try miss ends the run, same as Line rehearsal.
      stats.streak = 0;
      stats.history.push(false);
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
        timedOut ? "Time's up · try again" : "Not that one · try again",
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
              timedOut ? "Time's up · try again" : "Not that one · try again",
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

  if (attempt === 1) {
    stats.correct += 1;
    stats.streak += 1;
    stats.best = Math.max(stats.best, stats.streak);
    stats.history.push(true);
  } else {
    smart.retriesFixed += 1;
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
    attempt > 1 ? "Got it this time" : prompt.kind === "new" ? "Learned!" : "Correct!";
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

// ----- Local-first Train sync (plan §2) ---------------------------------------
// The smart session runs locally; graded first attempts + the session position
// flush in debounced batches. One request per quiet stretch instead of one per
// move — sync speed is deliberately traded for fewer round-trips.

const TRAIN_SYNC_IDLE_MS = 4000;
const TRAIN_SYNC_MAX_BACKOFF_MS = 30000;

function queueTrainAttempt(smart, nodeId, correct) {
  appState.trainSync.pending.push({
    session_id: smart.sessionId,
    session_generation: smart.generation,
    node_id: nodeId,
    correct,
    attempt_uuid: crypto.randomUUID(),
  });
  setTrainSyncState("dirty");
  scheduleTrainSync();
}

// The card_index/queue moved without a graded attempt (skip, requeue, card
// advance) — make sure the next flush carries the new position.
function markTrainPositionDirty() {
  appState.trainSync.dirty = true;
  setTrainSyncState("dirty");
  scheduleTrainSync();
}

function scheduleTrainSync() {
  const sync = appState.trainSync;
  void persistOutbox(); // Async commit status is surfaced by persistOutbox.
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => {
    sync.timer = null;
    flushTrainSync();
  }, TRAIN_SYNC_IDLE_MS);
}

// Flush pending graded attempts + the session position. Serialized like the
// Build flush: an in-flight flush is awaited by returning its promise. On
// failure the batch is requeued and a backoff retry armed — training never
// blocks on the network.
function flushTrainSync() {
  const sync = appState.trainSync;
  const owner = currentOwnerId();
  const isCurrent = () => owner === currentOwnerId() && sync === appState.trainSync;
  if (sync.flushing) return sync.flushing;
  if (!sync.pending.length && !sync.dirty) return Promise.resolve(true);
  clearTimeout(sync.timer);
  sync.timer = null;

  const durableCheckpoint = persistOutbox();
  const batch = sync.pending;
  sync.pending = [];
  sync.dirty = false;
  // Group by session: leftovers from an abandoned session flush to THEIR
  // session, not the current one. Play order is preserved within each group.
  // Grouping/partial-failure semantics live in train-sync.js (tested): retry
  // Each attempt keeps its UUID through requeue, so an uncertain response is
  // safe to retry. Only a permanently rejected group drops (and is reported);
  // auth/CSRF/conflict/rate-limit errors keep their attempts queued.
  const smart = appState.smart;
  const position = smart ? { card_index: smart.cardIndex, queue: smart.queue.map((c) => c.encoded), state_version: smart.stateVersion } : null;
  const groups = groupAttempts(batch, smart ? smart.sessionId : null, smart?.generation);
  setTrainSyncState("syncing");

  sync.flushing = (async () => {
    await durableCheckpoint;
    if (!isCurrent()) { sync.flushing = null; return false; }
    let outcome;
    let lastError = null;
    try {
      outcome = await flushGroups(groups, async (sessionId, attempts) => {
        if (!isCurrent()) throw new Error("Workspace changed");
        const generation = attempts.length ? attempts[0].session_generation : (smart?.sessionId === sessionId ? smart.generation : undefined);
        const body = { session_id: sessionId, session_generation: generation, attempts, local_date: localDateString() };
        if (smart && sessionId === smart.sessionId && generation === smart.generation) {
          Object.assign(body, position);
        }
        try {
          const result = await postJson("/api/train/smart/sync", body);
          if (isCurrent() && appState.smart === smart && body.state_version != null) {
            if (result.state_applied) smart.stateVersion = result.state_version;
            else if (result.state_applied === false) {
              setStatus("Training session changed elsewhere. Resume it to sync your position.", { severity: "error" });
            }
          }
          if (isCurrent() && result.day_streak) appState.dayStreak = result.day_streak;
        } catch (error) {
          lastError = error;
          throw error;
        }
      });
    } finally {
      sync.flushing = null;
    }
    if (!isCurrent()) return false;
    // R-02: permanently rejected attempts are reported on EVERY round — a
    // mixed failure (one rejected group + one retriable) used to hide the
    // rejection behind the retry, so attempts vanished without a word. The
    // rejected groups are kept (outbox) for review/export, never dropped.
    const rejectedCount = (outcome.rejectedGroups || []).reduce(
      (n, group) => n + (group.attempts ? group.attempts.length : 0),
      0,
    );
    // Everything the server answered for is settled: saved attempts and rejected
    // ones both LEFT the queue, so both are tombstoned. A stale tab holding
    // them would otherwise replay confirmed attempts (harmless — the receipt
    // dedupes) or re-report rejected ones forever.
    const unsettled = new Set([
      ...ungroupAttempts(outcome.failedGroups || []),
    ].map((attempt) => trainAttemptId(attempt)));
    const settledAttempts = batch
      .map((attempt) => trainAttemptId(attempt))
      .filter((id) => !unsettled.has(id));
    if (rejectedCount) {
      appState.trainRejected = (appState.trainRejected || []).concat(outcome.rejectedGroups);
    }
    if (settledAttempts.length) await persistOutbox({ train: settledAttempts });
    if (!isCurrent()) return false;
    const info = lastError ? classifySyncError(lastError) : null;
    const failedCount = outcome.failedGroups
      ? outcome.failedGroups.reduce((n, [, attempts]) => n + attempts.length, 0)
      : 0;
    if (!outcome.retriable) {
      sync.retry = 0;
      if (rejectedCount) {
        setStatus(
          `${rejectedCount} training attempt${rejectedCount === 1 ? "" : "s"} could not be saved${
            failedCount ? `; ${failedCount} kept for retry` : ""
          }`,
          { severity: "error" },
        );
      }
      if (sync.pending.length || sync.dirty) {
        setTrainSyncState("dirty");
        scheduleTrainSync();
      } else if (rejectedCount) {
        setTrainSyncState("rejected");
      } else {
        // R-01: Train finishing its queue says nothing about Build's — only a
        // fully quiescent owner copy may be dropped.
        await clearOutboxWhenQuiescent();
        if (!isCurrent()) return false;
        setTrainSyncState("saved");
      }
      return rejectedCount === 0;
    }
    // R-02 (mixed failure): even while some groups retry, the permanently
    // rejected ones get their own message — "1 kept for review, 2 will retry".
    if (rejectedCount) {
      setStatus(
        `${rejectedCount} training attempt${rejectedCount === 1 ? "" : "s"} kept for review; ` +
          `${failedCount} will retry`,
        { severity: "error" },
      );
    }
    setTrainSyncState(info && info.pauseForAuth ? "blocked" : "error");
    // Requeue failed groups ahead of newer attempts and back off. SR deltas
    // are precious but small; they also flush on hide/unload and session end.
    sync.pending = ungroupAttempts(outcome.failedGroups).concat(sync.pending);
    persistOutbox();
    // Only re-mark the position dirty if the current session's group is the
    // one that failed — other sessions carry no position payload.
    if (smart && smart === appState.smart && outcome.failedGroups.some(([sessionId]) => sessionId === smart.sessionId)) {
      sync.dirty = true;
    }
    if (info && info.pauseForAuth) {
      // R-04: 401 waits for a sign-in — a backoff timer can't fix it. The
      // flush re-arms from loadSignedInWorkspace after sign-in.
      return false;
    }
    sync.retry = Math.min(sync.retry + 1, 6);
    const delay =
      info && info.retryAfterMs != null
        ? info.retryAfterMs
        : Math.min(TRAIN_SYNC_MAX_BACKOFF_MS, 1000 * 2 ** (sync.retry - 1));
    sync.timer = setTimeout(() => {
      sync.timer = null;
      flushTrainSync();
    }, delay);
    return false;
  })();
  return sync.flushing;
}

// Last-ditch flush on page unload — keepalive fetch, fire-and-forget (same
// mechanics as beaconFlushBuild; sendBeacon can't carry the CSRF header).
function beaconFlushTrain() {
  const sync = appState.trainSync;
  void persistOutbox(); // Unload cannot guarantee completion of an IDB transaction.
  if (!sync.pending.length && !sync.dirty) return;
  const token = readCsrfCookie();
  const smart = appState.smart;
  const groups = groupAttempts(sync.pending, smart ? smart.sessionId : null, smart?.generation);
  for (const [sessionId, attempts] of groups) {
    const generation = attempts.length ? attempts[0].session_generation : (smart?.sessionId === sessionId ? smart.generation : undefined);
    const body = { session_id: sessionId, session_generation: generation, attempts, local_date: localDateString() };
    if (smart && sessionId === smart.sessionId && generation === smart.generation) {
      body.card_index = smart.cardIndex;
      body.state_version = smart.stateVersion;
      body.queue = smart.queue.map((c) => c.encoded);
    }
    try {
      fetch("/api/train/smart/sync", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", ...(token ? { [CSRF_HEADER]: token } : {}) },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch (_) {
      /* best-effort */
    }
  }
}

// ----- Settings tab — lazy view chunk -----------------------------------------
let settingsModulePromise = null;
let settingsView = null;

function preloadSettingsView() {
  if (!settingsModulePromise) {
    settingsModulePromise = import("./views/settings.js").catch((err) => {
      settingsModulePromise = null;
      throw err;
    });
  }
  return settingsModulePromise;
}

async function ensureSettingsView() {
  const mod = await preloadSettingsView();
  if (!settingsView) {
    settingsView = mod.createSettingsView({
      appState,
      setStatus,
      saveSettings,
      loadSettings,
      pref,
      setPref,
      effectiveMaiaRating,
      maiaFallbackRating: MAIA_FALLBACK_RATING,
      getSharedMaia3Provider,
      disposeSharedMaia3Provider,
      showConfirmModal,
      startFen: START_FEN,
      api,
      postJson,
      startLichessOAuth,
      onAccountsChanged: () => {
        void refreshLichessStatus();
      },
      signOut: () => accountController.signOut(),
      openAuthModal: (mode, options) => accountController.openAuthModal(mode, options),
      refreshAuthStatus: () => accountController.refreshAuthStatus(),
    });
    settingsView.bind();
  }
  return settingsView;
}

// Every in-flight loadSettings() (a tab click can start two). settingsSettled()
// waits until none remain, i.e. the Settings view is bound and fully rendered.
const settingsLoads = new Set();

function loadSettings() {
  const load = loadSettingsOnce().finally(() => settingsLoads.delete(load));
  settingsLoads.add(load);
  return load;
}

async function settingsSettled() {
  while (settingsLoads.size) await Promise.allSettled([...settingsLoads]);
}

// Open Settings through its tab (same path as a rail click) and jump to a
// section once the view is ready — no fixed delay.
async function openSettingsSection(sectionId) {
  const tab = document.querySelector('.tab[data-view="settings"]');
  if (tab) tab.click();
  else switchView("settings");
  await settingsSettled();
  const link = document.querySelector(`.settings-nav-link[href="#${sectionId}"]`);
  if (link) {
    link.click();
    return;
  }
  // A block inside a card (Chess accounts lives in Account): mark the card's
  // nav link, then bring the block itself into view.
  const target = document.getElementById(sectionId);
  const card = target?.closest(".card[id]");
  if (card) document.querySelector(`.settings-nav-link[href="#${card.id}"]`)?.click();
  target?.scrollIntoView({ block: "start" });
}

let settingsActionsPromise = null;
function loadSettingsActions() {
  settingsActionsPromise ||= import("./settings-actions.js").then(({ createSettingsActions }) => createSettingsActions({
    appState, currentOwnerId, ensureSettingsView, api, applySettingsPayload,
    applyServerEngineGating, setStatusError, positionCoach, engineWidget,
    activeViewName, explorerEvalEngine, explorerDrawerOpen, refreshExplorerPanel,
  })).catch((error) => { settingsActionsPromise = null; throw error; });
  return settingsActionsPromise;
}

async function loadSettingsOnce() {
  return (await loadSettingsActions()).loadSettingsOnce();
}

// Fold a /api/settings payload into state: the blob itself, the server-engine flag,
// and the pinned Maia rating (null = AUTO). Shared by init, loadSettings and saves.
function applySettingsPayload(payload) {
  appState.settings = payload;
  appState.serverEngineEnabled = !!payload.server_engine_enabled;
  appState.maiaRatingPinned = Number.isFinite(payload.maia_rating) ? payload.maia_rating : null;
  settingsView?.renderStrengthControls();
}

// Persist a partial settings patch ({stockfish_depth} / {maia_rating}) and re-render.
async function saveSettings(patch) {
  return (await loadSettingsActions()).saveSettings(patch);
}

// Apply one button's gated state: disable + greyed style + explanatory title,
// or restore its original title when enabled.
function setButtonGated(button, gated, message) {
  if (!button) return;
  button.disabled = gated;
  button.classList.toggle("is-coming-soon", gated);
  if (gated) {
    if (!button.dataset.enabledTitle) {
      button.dataset.enabledTitle = button.getAttribute("title") || "";
    }
    button.setAttribute("title", message);
    button.setAttribute("aria-disabled", "true");
  } else {
    button.removeAttribute("aria-disabled");
    if (button.dataset.enabledTitle) {
      button.setAttribute("title", button.dataset.enabledTitle);
    } else {
      button.removeAttribute("title");
    }
  }
}

// Gate compute actions by where the compute can actually run. BOTH whole-game
// Analyze (Phase 2) and Build → Generate (Phase 3c) now run in the BROWSER, so
// each is gated only on the browser engine being available (cross-origin
// isolated) — independent of the server engine, with no server fallback.
function applyServerEngineGating() {
  const gated = !isBrowserEngineAvailable();
  setButtonGated(
    document.getElementById("run-analysis"),
    gated,
    BROWSER_ENGINE_UNAVAILABLE,
  );
  setButtonGated(
    document.getElementById("build-generate-node"),
    gated,
    BROWSER_ENGINE_UNAVAILABLE,
  );
  paintEngineBanners();
}



// NOTE: server-side engine install (Stockfish/Maia3) and the first-run install
// prompt were removed — the public flow runs Stockfish in the browser and never
// installs or runs an engine on the server. Server install endpoints remain in
// server.py for a future admin mode (gated by PREPFORGE_SERVER_ENGINE_ENABLED).

async function runLichessCompare() {
  // Games are checked against your repertoires (owner-scoped /api/lichess/compare).
  if (!requireSignIn("Sign in to check your games against your repertoire", "games-check")) return;
  const selection = gamesSourceSelection();
  const token = appState.replayCheckToken = (appState.replayCheckToken || 0) + 1;
  const owner = appState.accountUserId;
  const sourceKey = JSON.stringify(selection);
  const isCurrent = () => appState.replayCheckToken === token && appState.signedIn
    && appState.accountUserId === owner && JSON.stringify(gamesSourceSelection()) === sourceKey;
  const usernames = resolveFetchUsernames({
    selection,
    linkedAccounts: lichessAccounts(),
    includeExternal: true,
  });
  if (!usernames.length) {
    setStatus("No Games sources selected — open Add and pick one.");
    return;
  }
  const linkedIds = gamesSourceAccountIds();
  const hasExternal = normalizeSelection(selection).external.length > 0;
  const countInput = document.getElementById("replay-count");
  const count = Math.max(1, Math.min(50, Number(countInput.value) || 10));
  const button = document.getElementById("lichess-compare-btn");
  button.disabled = true;
  setStatus("Fetching games from Lichess");
  try {
    const payload = await postJson("/api/lichess/compare", {
      count,
      // linkedIds is null only for the full-Self default (omit → all linked
      // accounts). Any explicit pick — including [] for external-only — is
      // sent as-is so the server never widens the selection back to Self.
      ...(linkedIds !== null ? { account_ids: linkedIds } : {}),
      ...(hasExternal ? { usernames } : {}),
    });
    if (!isCurrent()) return;
    payload.requested_sources = usernames.length;
    appState.replayResults = payload;
    appState.replayFilter = null;
    appState.replayOpen = new Set();
    await renderReplayResults(payload, isCurrent);
    if (!isCurrent()) return;
    const queued = Number(payload.misses_recorded) || 0;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    const sourceLabel =
      sources.length > 1
        ? `self (${sources.length} accounts)`
        : payload.username === "self"
          ? "self"
          : payload.username;
    setStatus(
      queued > 0
        ? `Fetched ${payload.count} games · ${queued} forgotten move${queued === 1 ? "" : "s"} added to training`
        : `Fetched ${countOf(payload.count, "game")} for ${sourceLabel}`
    );
  } catch (error) {
    if (isCurrent()) setStatusError(error.message);
  } finally {
    if (appState.replayCheckToken === token) button.disabled = false;
  }
}

// Games source selection — shared explicit model with Scout:
// { linkedMode: "all" | "subset" | "none", accountIds, external }.
// "all" = Self (every linked identity, the default); "subset" = exactly the
// listed linked ids; "none" = no linked accounts. External Lichess usernames
// ride alongside on both pages (Games fetches them too). Persisted per
// browser; legacy id-list storage migrates on read so reload keeps selection.
const GAMES_SOURCE_KEY = "prepforge.games_source";
const GAMES_EXTERNAL_KEY = "prepforge.games_external";
function readSourceStore(sourceKey, externalKey, selfKey) {
  const rawIds = readLegacySourceIds(sourceKey);
  let rawExternal = null;
  try {
    const raw = localStorage.getItem(externalKey);
    if (raw) rawExternal = JSON.parse(raw);
  } catch (_) {
    rawExternal = null;
  }
  let selfOff = false;
  if (selfKey) {
    try {
      selfOff = localStorage.getItem(selfKey) === "off";
    } catch (_) {
      selfOff = false;
    }
  }
  return selectionFromStorage({ ids: rawIds, external: rawExternal, selfOff });
}

function writeSourceStore(sourceKey, externalKey, selfKey, selection) {
  const stored = selectionToStorage(selection);
  writeLegacySourceIds(sourceKey, stored.ids);
  try {
    if (stored.external.length) {
      localStorage.setItem(externalKey, JSON.stringify(stored.external));
    } else {
      localStorage.removeItem(externalKey);
    }
  } catch (_) {
    /* ignore storage errors */
  }
  if (selfKey) {
    try {
      const sel = normalizeSelection(selection);
      const off = sel.linkedMode === "none" && !sel.external.length;
      localStorage.setItem(selfKey, off ? "off" : "on");
    } catch (_) {
      /* ignore storage errors */
    }
  }
}

function gamesSourceSelection() {
  return readSourceStore(GAMES_SOURCE_KEY, GAMES_EXTERNAL_KEY, null);
}

function writeGamesSelection(selection) {
  writeSourceStore(GAMES_SOURCE_KEY, GAMES_EXTERNAL_KEY, null, selection);
}

function readLegacySourceIds(key) {
  let picked = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) picked = JSON.parse(raw);
  } catch (_) {
    picked = null;
  }
  return picked;
}

function writeLegacySourceIds(key, ids) {
  try {
    // "[]" is meaningful: it persists subset + [] (every linked account
    // unpicked) and must survive a reload — only a null (Self default) clears.
    if (!ids) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(ids));
  } catch (_) {
    /* ignore storage errors */
  }
}

function gamesSourceAccountIds() {
  const sel = gamesSourceSelection();
  if (sel.linkedMode === "none") return [];
  if (sel.linkedMode === "all") return null;
  const valid = sel.accountIds.filter((id) =>
    lichessAccounts().some((a) => a.id === id)
  );
  return valid.length ? valid : [];
}

function gamesPickedUsernames() {
  return resolveFetchUsernames({
    selection: gamesSourceSelection(),
    linkedAccounts: lichessAccounts(),
    includeExternal: true,
  });
}

function openGamesComposer(anchor) {
  const composer = openSourceComposer({
    anchor,
    selection: gamesSourceSelection(),
    linkedAccounts: lichessAccounts(),
    allowExternal: true,
    title: "Games sources",
    externalPlaceholder: "Add Lichess username…",
    escapeHtml,
    onChange: (sel) => {
      writeGamesSelection(sel);
      paintGamesSource();
    },
    onClose: () => paintGamesSource(),
  });
  return composer;
}

function paintGamesSource() {
  const tray = document.getElementById("games-source-chips");
  if (!tray) return;
  // Signed out there is no "Self" (no linked accounts) and Check needs an
  // account anyway: a selected-looking "Self · all linked" chip contradicted
  // the "No Games sources selected" error. Offer the sign-in instead.
  if (!appState.signedIn) {
    tray.hidden = false;
    tray.innerHTML =
      '<button type="button" class="src-chip src-chip-signin" data-games-signin>Sign in to use your games</button>';
    return;
  }
  const selection = gamesSourceSelection();
  const { chips, selfState } = selectionChips(selection, lichessAccounts());
  const n = lichessAccounts().length;
  const label = n > 0 ? `Self · ${n}` : "Self · all linked";
  const visible = chips.length ? chips : [{ kind: "self", label }];
  tray.hidden = false;
  // Signed in with nothing linked and no usernames added: "Self · all linked"
  // named an empty set and Check stayed disabled without saying why.
  if (n === 0 && !selection.external.length && selection.linkedMode === "all") {
    tray.innerHTML =
      '<button type="button" class="src-chip src-chip-signin" data-games-link>Link Lichess to use your games</button>';
    return;
  }
  tray.innerHTML = visible
    .map((c) =>
      c.kind === "self"
        ? `<span class="src-chip is-self" data-games-chip-self>${escapeHtml(label)}</span>`
        : c.kind === "external"
          ? `<span class="src-chip" data-games-chip="${escapeHtml(c.id)}">${escapeHtml(c.label)}` +
            `<button type="button" class="src-chip-x" data-games-unpick-external="${escapeHtml(c.id)}" aria-label="Remove ${escapeHtml(c.label)} from Games sources">×</button></span>`
          : `<span class="src-chip" data-games-chip="${escapeHtml(c.id)}">${escapeHtml(c.label)}` +
            (c.primary ? ' <span class="conn-primary">Primary</span>' : "") +
            `<button type="button" class="src-chip-x" data-games-unpick="${escapeHtml(c.id)}" aria-label="Remove ${escapeHtml(c.label)} from Games sources">×</button></span>`
    )
    .join("");
  if ((selfState === "none" || (!chips.length && selection.linkedMode !== "all")) && !selection.external.length) {
    tray.innerHTML =
      '<span class="src-empty">No sources — open Add and pick one</span>';
    return;
  }
}

function bindGamesSource() {
  document.getElementById("games-source-add")?.addEventListener("click", (event) => {
    // Sources only matter for a Check, which needs an account — don't let a
    // guest collect usernames that would silently ride into their account.
    if (!requireSignIn("Sign in to check your games against your repertoire", "games-check")) return;
    openGamesComposer(event?.currentTarget || document.getElementById("games-source-add"));
  });
  document.getElementById("games-source-chips")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-games-signin]")) {
      requireSignIn("Sign in to check your games against your repertoire", "games-check");
      return;
    }
    if (event.target.closest("[data-games-link]")) {
      openSettingsSection("set-connections").catch(() => {});
      return;
    }
    const removeExt = event.target.closest("[data-games-unpick-external]");
    if (removeExt) {
      const sel = gamesSourceSelection();
      writeGamesSelection({
        linkedMode: sel.linkedMode,
        accountIds: sel.accountIds,
        external: sel.external.filter((n) => n !== removeExt.dataset.gamesUnpickExternal),
      });
      paintGamesSource();
      return;
    }
    const remove = event.target.closest("[data-games-unpick]");
    if (!remove) return;
    const sel = gamesSourceSelection();
    const current =
      sel.linkedMode === "all" ? lichessAccounts().map((a) => a.id) : sel.accountIds;
    const rest = current.filter((id) => id !== remove.dataset.gamesUnpick);
    if (!rest.length && sel.linkedMode === "all") {
      writeGamesSelection({ linkedMode: "none", accountIds: [], external: sel.external });
    } else {
      writeGamesSelection({ linkedMode: "subset", accountIds: rest, external: sel.external });
    }
    paintGamesSource();
  });
  paintGamesSource();
}

// Scout source: the SAME shared Source Composer model as Games —
// { linkedMode, accountIds, external } with the shared persistence bridge.
// "all" = Self (every linked identity); "subset" = exactly the listed linked
// ids; "none" = no linked accounts. External Lichess usernames ride alongside
// on both pages. Page difference lives only in the analysis workflow after
// picking, never in the picker.
const SCOUT_SELF_KEY = "prepforge.scout_self";
const SCOUT_SOURCE_KEY = "prepforge.scout_source";
const SCOUT_EXTERNAL_KEY = "prepforge.scout_external";

function scoutSelection() {
  return readSourceStore(SCOUT_SOURCE_KEY, SCOUT_EXTERNAL_KEY, SCOUT_SELF_KEY);
}

function writeScoutSelection(selection) {
  const before = scoutPickedUsernames();
  writeSourceStore(SCOUT_SOURCE_KEY, SCOUT_EXTERNAL_KEY, SCOUT_SELF_KEY, selection);
  // A report scouted from other accounts would sit under chips that no longer
  // describe it; drop it so the next Start reflects the picked sources.
  if (scoutView && !sameFetchSources(before, scoutPickedUsernames())) scoutView.discardReport();
}

function openScoutComposer(anchor) {
  return openSourceComposer({
    anchor,
    selection: scoutSelection(),
    linkedAccounts: lichessAccounts(),
    allowExternal: true,
    title: "Scout sources",
    externalPlaceholder: "Add Lichess username…",
    escapeHtml,
    onChange: (sel) => {
      writeScoutSelection(sel);
      paintScoutSource();
    },
    onClose: () => paintScoutSource(),
  });
}

function scoutPickedUsernames() {
  return resolveFetchUsernames({
    selection: scoutSelection(),
    linkedAccounts: lichessAccounts(),
    includeExternal: true,
  });
}

function paintScoutSource() {
  const tray = document.getElementById("scout-source-chips");
  if (!tray) return;
  const selection = scoutSelection();
  const { chips, selfState } = selectionChips(selection, lichessAccounts());
  const linked = lichessAccounts();
  const visible = chips.length
    ? chips
    : linked.length && selfState === "all"
      ? [{ kind: "self", label: `Self · ${linked.length}`, count: linked.length }]
      : [];
  tray.hidden = false;
  tray.innerHTML = visible.length
    ? visible
        .map((c) =>
          c.kind === "external"
            ? `<span class="src-chip" data-scout-chip="${escapeHtml(c.id)}">${escapeHtml(c.label)}` +
              `<button type="button" class="src-chip-x" data-scout-unpick-external="${escapeHtml(c.id)}" aria-label="Remove ${escapeHtml(c.label)} from Scout sources">×</button></span>`
            : c.kind === "self"
              ? `<span class="src-chip is-self" data-scout-chip-self>Self · ${c.count}</span>`
              : `<span class="src-chip" data-scout-chip="${escapeHtml(c.id)}">${escapeHtml(c.label)}` +
                (c.primary ? ' <span class="conn-primary">Primary</span>' : "") +
                `<button type="button" class="src-chip-x" data-scout-unpick="${escapeHtml(c.id)}" aria-label="Remove ${escapeHtml(c.label)} from Scout sources">×</button></span>`
        )
        .join("")
    : '<span class="src-empty">No sources — open Add and pick one</span>';
  // The empty state names the next step for where the user actually is.
  const hint = document.getElementById("scout-empty-hint");
  if (hint) {
    hint.textContent = !appState.signedIn
      ? "Sign in, add a Lichess username, then Start."
      : visible.length
        ? "Press Start."
        : linked.length
          ? "Add a Lichess username or pick Self, then Start."
          : "Add a Lichess username as a source, then Start.";
  }
}

function bindScoutSource() {
  document.getElementById("scout-source-add")?.addEventListener("click", (event) => {
    if (!requireSignIn("Sign in to scout an opponent", "scout-start")) return;
    openScoutComposer(event?.currentTarget || document.getElementById("scout-source-add"));
  });
  document.getElementById("scout-source-chips")?.addEventListener("click", (event) => {
    const unpickExt = event.target.closest("[data-scout-unpick-external]");
    if (unpickExt) {
      const sel = scoutSelection();
      writeScoutSelection({
        linkedMode: sel.linkedMode,
        accountIds: sel.accountIds,
        external: sel.external.filter((n) => n !== unpickExt.dataset.scoutUnpickExternal),
      });
      paintScoutSource();
      return;
    }
    const unpick = event.target.closest("[data-scout-unpick]");
    if (!unpick) return;
    const sel = scoutSelection();
    const current =
      sel.linkedMode === "all" ? lichessAccounts().map((a) => a.id) : sel.accountIds;
    const rest = current.filter((id) => id !== unpick.dataset.scoutUnpick);
    if (!rest.length && sel.linkedMode === "all") {
      writeScoutSelection({ linkedMode: "none", accountIds: [], external: sel.external });
    } else {
      writeScoutSelection({ linkedMode: "subset", accountIds: rest, external: sel.external });
    }
    paintScoutSource();
  });
  paintScoutSource();
}

let replayModule = null;
let replayView = null;

function preloadReplayView() {
  if (!replayModule) {
    replayModule = import("./views/replay.js").catch((err) => {
      replayModule = null;
      throw err;
    });
  }
  return replayModule;
}

async function ensureReplayView() {
  const mod = await preloadReplayView();
  if (!replayView) {
    replayView = mod.createReplayView({
      escapeHtml, onError: setStatusError,
      // Focus-board renderers: the production FEN decoder + active piece-SVG
      // set, shared with the Library preview (piece style follows Settings).
      boardRenderers: { parseFenBoard, pieceSvg },
      getReplayFilter: () => appState.replayFilter,
      isGameOpen: (index) => appState.replayOpen.has(index),
      onToggleFilter: (kind) => {
        appState.replayFilter = appState.replayFilter === kind ? null : kind;
        appState.replayOpen.clear();
        saveReturnState("replay", { filter: appState.replayFilter, openIndex: null });
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onToggleGame: (index) => {
        appState.replayOpen = new Set([index]);
        saveReturnState("replay", { filter: appState.replayFilter, openIndex: index });
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onTrainMiss: async (game, focus) => {
        const task = rememberHandoff(gameHandoff(game, focus, "practice-missed-move"));
        if (task.persisted === false) setStatus("Task kept in this tab only; browser storage is unavailable", { severity: "warning" });
        if (!game.expected_node_id || !game.repertoire_id) throw new Error("Prepared move unavailable; reopen the repertoire");
        await trainRepertoire(game.repertoire_id, { targetNodeIds: [game.expected_node_id], fresh: true });
      },
      onBuildReply: async (game, focus) => {
        rememberHandoff(gameHandoff(game, focus, "build-reply"));
        const owner = currentOwnerId(), generation = appState.ownerGeneration;
        const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration;
        const mod = await import("./controllers/replay-actions.js");
        if (!isCurrent()) return;
        await mod.buildReply(game, { editRepertoire,
          getNode: () => appState.buildNodeById.get(appState.buildCurrentNodeId),
          isBuildReadOnly, localBoardInfo, onBuildBoardMove, isCurrent });
      },
      onAnalyze: (game, focus) => {
        rememberHandoff(gameHandoff(game, focus, "review-in-analyze"));
        return replayToAnalyze(game);
      },
    });
  }
  return replayView;
}

async function renderReplayResults(payload, isCurrent = () => true) {
  const view = await ensureReplayView();
  if (isCurrent()) return view.renderReplayResults(payload);
}

// F-06: the Games→Train/Analyze handoff record — source game, the decision
// ply + anchor FEN (the position where the user left prep), the user's side and
// the matched repertoire. Identity covers the whole tuple, so white/black,
// transpositions and different root FENs never interleave.
function gameHandoff(game, focus, reason) {
  return {
    source: "games",
    sourceView: "replay",
    reason,
    gameId: game.lichess_id || null,
    lineUcis: [game.expected_move_uci].filter(Boolean),
    ply: Number(game.departure_ply) || null,
    anchorFen: (focus && focus.fen) || null,
    side: game.user_color === "black" ? "black" : "white",
    repertoireId: game.repertoire_id ?? null,
    targetNodeIds: [game.expected_node_id].filter(Boolean),
  };
}

// "Review in Analyze": rebuild the game's PGN from the fetched move list and
// hand it to the Analyze tab — same flow as "My last game" (press Analyze for
// the full engine review; the book banner tracks your prep as you step through).
async function replayToAnalyze(game) {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration;
  const mod = await import("./controllers/replay-actions.js");
  if (!isCurrent()) return;
  return mod.replayToAnalyze(game, { switchView, orientAnalysisForSelf,
    loadPgnIntoAnalyze, showAnalysisPly, takeHandoff, setStatus, isCurrent });
}

// ----- Shared repertoire viewer (read-only Build) -------------------------------
// A share URL (/?shared=<token>) opens the Build view as a guest-readable,
// mutation-free viewer of someone else's repertoire. "Copy to my account" forks
// it server-side; signing in reloads the page with the token still in the URL,
// so the viewer (and the Copy button) come right back.

async function maybeOpenSharedView() {
  let token = null;
  try {
    token = new URLSearchParams(window.location.search).get("shared");
  } catch (_) {
    return false;
  }
  if (!token) return false;
  try {
    setStatus("Loading shared repertoire");
    const payload = await api(`/api/shared/${encodeURIComponent(token)}`);
    appState.sharedToken = token;
    await hydrateBuild(payload, payload.selected_node_id);
    renderSharedBanner(payload);
    switchView("build");
    syncCoverageReadOnlyState();
    setStatus(`Viewing shared repertoire "${payload.name}" (read-only)`);
    return true;
  } catch (error) {
    setStatus(`Share link problem: ${error.message}`, { severity: "error" });
    return false;
  }
}

// A join URL (/?join=<code>) redeems a team invite. Mirrors the shared viewer:
// signed-out visitors are nudged to sign in (the ?join= survives the reload), then
// we preview the team and let them confirm before joining. Idempotent server-side.
async function maybeHandleJoinLink() {
  let code = null;
  try {
    code = new URLSearchParams(window.location.search).get("join");
  } catch (_) {
    return false;
  }
  if (!code) return false;
  if (!appState.signedIn) {
    openAuthModal("login", { notice: "Sign in (or create an account) to join the team" });
    return false; // ?join= stays in the URL; we resume after the sign-in reload
  }
  let preview;
  try {
    preview = await api(`/api/teams/join/${encodeURIComponent(code)}`);
  } catch (error) {
    setStatus(`Invite link problem: ${error.message}`, { severity: "error" });
    clearJoinParam();
    return false;
  }
  const members = `${preview.member_count} member${preview.member_count === 1 ? "" : "s"}`;
  const confirmed = await showConfirmModal({
    title: preview.already_member ? `Open ${preview.name}?` : `Join ${preview.name}?`,
    body: preview.already_member
      ? "You're already a member of this team."
      : `Join "${preview.name}" (${members})? You'll get read-only access to repertoires shared with the team.`,
    okLabel: preview.already_member ? "Open" : "Join",
    cancelLabel: "Cancel",
  });
  clearJoinParam();
  if (!confirmed) return false;
  let result;
  try {
    result = await postJson(`/api/teams/join/${encodeURIComponent(code)}`, {});
  } catch (error) {
    setStatus(`Couldn't join: ${error.message}`, { severity: "error" });
    return false;
  }
  const team = result.team;
  setStatus(result.joined ? `Joined ${team.name}` : `You're already in ${team.name}`);
  appState.selectedTeamId = team.id;
  switchView("teams");
  await loadTeams();
  return true;
}

function clearJoinParam() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState(null, "", url.pathname + url.search);
  } catch (_) {
    /* cosmetic */
  }
}

// The shared/read-only banner is a static host in the Opus panel (index.html).
// Both states only change its text and visibility — no element is created,
// prepended, or re-rendered here, so the shared state renders in exactly the
// same panel composition as the writable one.
function renderReadOnlyBanner(payload) {
  const banner = document.getElementById("shared-banner");
  if (!banner) return;
  const title = document.getElementById("shared-banner-title");
  if (title) title.textContent = `Read-only · ${payload.name} · shared with you`;
  banner.hidden = false;
  syncViewHeads();
}

function renderSharedBanner(payload) {
  renderReadOnlyBanner(payload);
}

async function forkReadableRepertoire() {
  const viaToken = !!appState.sharedToken;
  const viaTeam = appState.build && appState.build.writable === false;
  if (!viaToken && !viaTeam) return;
  if (!requireSignIn("Sign in (or create an account) to copy this repertoire")) return;
  try {
    const result = viaToken
      ? await postJson(
          `/api/shared/${encodeURIComponent(appState.sharedToken)}/fork`,
          {},
        )
      : await postJson("/api/repertoires/fork", {
          repertoire_id: appState.build.repertoire_id,
        });
    appState.sharedToken = null;
    removeReadOnlyBanner();
    if (viaToken) {
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch (_) {
        /* cosmetic */
      }
    }
    await editRepertoire(result.repertoire_id);
    await refreshDashboardRepertoires();
    setStatus(`Copied "${result.name}" to your account — it's yours now`);
  } catch (error) {
    setStatusError(error.message);
  }
}

// ----- Coverage workbench (Build inspector) ------------------------------------
let coverageView = null;
let coverageViewReady = null;

function ensureCoverageView() {
  if (!coverageViewReady) {
    coverageViewReady = import("./controllers/coverage.js").then(({ createCoverageController }) => {
      coverageView = createCoverageController({
        getContext: () => ({ build: appState.build, ownerId: currentOwnerId(),
          ownerGeneration: appState.ownerGeneration, rating: effectiveMaiaRating(),
          selectedNodeId: appState.buildCurrentNodeId, readOnly: isBuildReadOnly() }),
        getProvider: () => getSharedMaia3Provider(), escapeHtml,
        selectNode: selectBuildNode, getBoard: () => boards.build,
        previewReplies: previewCoverageReplies, getJob: () => jobToast,
        onError: (error) => setStatusError(error.message),
      });
      return coverageView;
    }).catch((error) => { coverageViewReady = null; throw error; });
  }
  return coverageViewReady;
}

async function runCoverageScanUI() {
  try { await (await ensureCoverageView()).scan(); }
  catch (error) { setStatusError(error.message); }
}

async function previewCoverageReplies(gaps, options) {
  const owner = currentOwnerId(), generation = appState.ownerGeneration;
  const mod = await import("./controllers/coverage-replies.js");
  if (owner !== currentOwnerId() || generation !== appState.ownerGeneration || !options.isValid()) return;
  return mod.previewCoverageReplies(gaps, options, {
    isBuildReadOnly, isBrowserEngineAvailable, unavailableMessage: BROWSER_ENGINE_UNAVAILABLE,
    jobToast, hardFlushBuild, captureBuildContext, getBuild: () => appState.build,
    effectiveMaiaRating, effectiveStockfishDepth, getGenerator: () => _buildGenReady || preloadBuildGen(),
    getProvider: getSharedMaia3Provider, showConfirmModal, postJson, classifySyncError,
    hydrateBuild, trainRepertoire,
  });
}

// ----- Opponent scouting (Replay tab) — lazy view chunk -----------------------
let scoutModulePromise = null;
let scoutView = null;

function preloadScoutView() {
  if (!scoutModulePromise) {
    scoutModulePromise = import("./views/scout.js").catch((err) => {
      scoutModulePromise = null;
      throw err;
    });
  }
  return scoutModulePromise;
}

async function ensureScoutView() {
  const mod = await preloadScoutView();
  if (!scoutView) {
    scoutView = mod.createScoutView({
      escapeHtml,
      setStatus,
      switchView,
      api,
      showInputModal,
      createRepertoirePrompt,
      editRepertoire,
      boardAfterMove,
      buildProvisionalNode,
      hardFlushBuild,
      selectBuildNode,
      resolveBuildId,
      setBuildSync,
      jobToast,
      parseFenBoard,
      pieceSvg,
      getBuildState: () => appState.build,
      getBuildNodeById: (id) => appState.buildNodeById.get(id),
      setBuildPending: (entry) => {
        appState.buildPending.push(entry);
      },
      pushBuildNode: (node) => {
        appState.build.nodes.push(node);
        appState.buildNodeById.set(node.id, node);
      },
      connectLichess: startLichessOAuth,
      loadPgnIntoAnalyze,
      rememberHandoff,
      effectiveMaiaRating,
      maiaAnalysisEnabled: () => maiaAnalysisEnabled(),
      scoutPickedUsernames: () => scoutPickedUsernames(),
      requireSignIn,
      getLichessUsername: () => appState.lichessUsername,
      getLichessAccounts: () => lichessAccounts(),
      effectiveStockfishDepth,
    });
  }
  return scoutView;
}

const SCOUT_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_SCOUT_E2E === "1";
const POLISH_E2E_BUILD_ENABLED = import.meta.env.VITE_ENABLE_POLISH_E2E === "1";

function installScoutE2eHook() {
  if (window.__prepforgeScoutE2e) return;
  const oauthOpens = [];
  const nativeOpen = window.open.bind(window);
  window.open = function scoutE2eOpen(url, target, features) {
    oauthOpens.push({
      url: String(url ?? ""),
      target: String(target ?? ""),
      features: String(features ?? ""),
      ts: Date.now(),
    });
    try {
      return nativeOpen(url, target, features);
    } catch {
      return null;
    }
  };
  window.__prepforgeScoutE2e = {
    async mountRefutationScenario(scenarioId) {
      switchView("replay");
      const view = await ensureScoutView();
      view.bindControls();
      return view.mountE2eRefutationScenario(scenarioId);
    },
    getOauthOpens() {
      return oauthOpens.map((entry) => ({ ...entry }));
    },
    resetOauthOpens() {
      oauthOpens.length = 0;
    },
  };
}

// Polish acceptance hook: deterministic tests seed linked identities and drive
// the real per-action chooser without OAuth popups. Same gating shape as the
// Scout hook — build flag + query param — so production pages never expose it.
function installPolishE2eHook() {
  if (window.__prepforgePolishE2e) return;
  window.__prepforgePolishE2e = {
    async setLichessAccounts(accounts) {
      appState.lichessAccounts = accounts;
      const primary = accounts.find((a) => a.is_primary) || accounts[0] || null;
      appState.lichessUsername = primary ? primary.username : null;
      try {
        const view = await ensureSettingsView().catch(() => null);
        view?.ensureBound?.();
        // Seed the connections list directly: the acceptance static server has
        // no /api/lichess backend, so refreshConnections() would keep the last
        // state instead of showing the seeded identities.
        await view?.renderConnections?.();
        view?.renderMaia3Status?.();
      } catch (_) {
        /* settings view may not be loaded yet */
      }
      try {
        syncReplayControls();
      } catch (_) {
        /* controller may not be initialised in a bare acceptance page */
      }
    },
    getLichessAccounts() {
      return lichessAccounts();
    },
    async fetchMyLastGame() {
      await fetchMyLichessGame();
      return document.getElementById("app-status")?.textContent || "";
    },
    async setBoardFen(boardName, fen) {
      const board = boards[boardName] || null;
      if (!board) throw new Error(`unknown board: ${boardName}`);
      const info = await boardInfo(fen);
      board.setPosition({ fen, legalMoves: info.legal_moves, lastMove: null });
      return info.legal_moves;
    },
  };
}

// Analyze E2E hook: deterministic tests seed a finished analysis payload
// (moves + eval graph) without running a browser engine. Same gating shape as
// the Scout/Polish hooks — E2E build flag + query-param opt-in — so production
// pages never expose it. Shares the existing E2E build flags so the CI e2e job's
// build (VITE_ENABLE_SCOUT_E2E=1) carries it.
const ANALYZE_E2E_BUILD_ENABLED = SCOUT_E2E_BUILD_ENABLED || POLISH_E2E_BUILD_ENABLED;

function installAnalyzeE2eHook() {
  if (window.__prepforgeAnalyzeE2e) return;
  window.__prepforgeAnalyzeE2e = {
    async seedAnalysis(payload) {
      // Boot races the seed: init()'s restoreWorkspaceLocation() switches to the
      // default view after this hook is installed. Await boot so the seeded
      // Analyze view (and its reveal) isn't switched away underneath us.
      if (appReadyPromise) await appReadyPromise;
      switchView("analyze");
      appState.analysis = payload;
      appState.analysisVarNodes = new Map();
      appState.analysisVarCounter = 0;
      appState.analysisCurrentNodeId = "root";
      appState.analysisTree = null;
      appState.analysisPly = 0;
      const view = await ensureAnalyzeView();
      view.renderAnalysis(payload);
      revealAnalysisResults();
      await showAnalysisPly(0);
      return true;
    },
    // The user's Lichess name, so a loaded PGN has a known side ("you") and the coach
    // reads the other side's moves as the opponent's.
    setSelfName(name) {
      appState.lichessUsername = name || null;
      return true;
    },
    getCoachProse: () => (document.getElementById("coach-prose") || {}).textContent || "",
    getPly: () => appState.analysisPly,
    getBoardLabel: () =>
      (document.getElementById("analysis-board-label") || {}).textContent || "",
  };
}

if (
  SCOUT_E2E_BUILD_ENABLED &&
  new URLSearchParams(location.search).get("scout_e2e") === "1"
) {
  installScoutE2eHook();
}

if (
  POLISH_E2E_BUILD_ENABLED &&
  new URLSearchParams(location.search).get("polish_e2e") === "1"
) {
  installPolishE2eHook();
}

if (
  ANALYZE_E2E_BUILD_ENABLED &&
  new URLSearchParams(location.search).get("analyze_e2e") === "1"
) {
  installAnalyzeE2eHook();
}

// Bind the view and let it paint the section's current state. The chunk is
// already in flight by the time Scout is shown, so this only resolves it.
async function ensureScoutUi() {
  const view = await ensureScoutView();
  view.bindControls();
  view.onShow?.();
  return view;
}

let scoutUiPromise = null;
function preloadScoutUi() {
  if (!scoutUiPromise) {
    scoutUiPromise = ensureScoutUi().catch((err) => {
      scoutUiPromise = null;
      throw err;
    });
  }
  return scoutUiPromise;
}

// Maia idle teardown. The browser Maia engine (onnxruntime-web session + WASM heap) is by
// far the heaviest thing the page holds — tens-to-hundreds of MB of weights + activation
// arena that ORT never voluntarily releases. Backgrounding a tab only throttles its CPU; it
// does NOT free that worker/session, so a tab left in the background keeps the whole footprint
// resident. After the tab has been hidden a while with no Maia work in flight, dispose the
// shared provider to hand that memory back. It transparently re-inits on the next use, and the
// IndexedDB weight cache means a re-init skips the ~46 MB download — only the session is rebuilt.
//
// The window is deliberately generous (10 min). A re-init still has to rebuild the ORT session
// (graph-optimizing a 23M-param transformer — seconds, the genuinely slow part), so tearing down
// after a SHORT hidden spell punished the common dev/study loop of tabbing to an editor and back:
// every return rebuilt the session and the "loading model" toast read like a fresh download. Only
// a tab parked in the background for a long stretch — where reclaiming ~1 GB clearly wins — should
// pay that rebuild cost. (Returning to the foreground cancels the timer, so an active tab never
// tears down.)
const MAIA_IDLE_TEARDOWN_MS = 10 * 60 * 1000;
let maiaIdleTimer = null;

function clearMaiaIdleTeardown() {
  if (maiaIdleTimer !== null) {
    clearTimeout(maiaIdleTimer);
    maiaIdleTimer = null;
  }
}

function scheduleMaiaIdleTeardown() {
  clearMaiaIdleTeardown();
  maiaIdleTimer = setTimeout(() => {
    maiaIdleTimer = null;
    const provider = peekSharedMaia3Provider();
    if (!provider) return; // nothing live to release
    // Still working (e.g. a Generate run left in a hidden tab)? Don't abort it — check back later.
    if (provider.busy) {
      scheduleMaiaIdleTeardown();
      return;
    }
    disposeSharedMaia3Provider();
  }, MAIA_IDLE_TEARDOWN_MS);
}

// Mobile bottom bar: the More button opens a bottom sheet carrying the
// secondary destinations (Analyze, Scout, Teams, Settings, command palette).
// Sheet entries mirror the canonical nav buttons so every view keeps its real
// activation path (URL sync, loaders, transient-overlay cleanup).
function wireMobileNav() {
  const sheet = document.getElementById("more-sheet");
  const moreBtn = document.getElementById("more-nav-btn");
  if (!sheet || !moreBtn) return;
  let sheetCleanup = null;
  const closeSheet = ({ restoreFocus = true } = {}) => {
    if (sheet.hidden) return;
    sheet.hidden = true;
    sheetCleanup?.({ restoreFocus: false });
    sheetCleanup = null;
    moreBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus) moreBtn.focus();
  };
  const openSheet = () => {
    sheet.hidden = false;
    moreBtn.setAttribute("aria-expanded", "true");
    const menu = document.getElementById("account-menu");
    sheetCleanup = activateModal(sheet, { additionalRoots: menu ? [menu] : [] });
  };
  moreBtn.addEventListener("click", () => {
    if (sheet.hidden) openSheet();
    else closeSheet();
  });
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) closeSheet();
  });
  sheet.querySelectorAll("[data-nav-mirror]").forEach((item) => {
    item.addEventListener("click", () => {
      const [view, section] = item.dataset.navMirror.split(":");
      closeSheet({ restoreFocus: false });
      const target = document.querySelector(section
        ? `.tab[data-view="${view}"][data-replay-section="${section}"]`
        : `.tab[data-view="${view}"]`);
      target?.click();
    });
  });
  sheet.querySelectorAll("[data-lib-mirror]").forEach((item) => {
    item.addEventListener("click", () => {
      closeSheet({ restoreFocus: false });
      document.getElementById(item.dataset.libMirror)?.click();
    });
  });
  // Mobile account entry (the rail — and its account row — is hidden ≤ 760px).
  // Signed in, the account menu opens over the still-open sheet with this item
  // as its trigger, so Escape returns focus here; a guest gets the auth modal.
  const accountItem = document.getElementById("sheet-account");
  if (accountItem) {
    accountItem.addEventListener("click", () => {
      if (!appState.signedIn) closeSheet({ restoreFocus: false });
      onAccountChipClick(null, { trigger: accountItem });
    });
  }
  // Picking an account-menu action finishes the sheet's job too.
  document.getElementById("account-menu")?.addEventListener("click", (event) => {
    if (event.target.closest?.('[role="menuitem"]')) closeSheet({ restoreFocus: false });
  });
  // Phones have no rail: the sheet carries the light/dark toggle (it stays
  // open so the switch is visible behind it).
  document.getElementById("sheet-theme")?.addEventListener("click", toggleTheme);
  const paletteItem = document.getElementById("sheet-palette");
  if (paletteItem) {
    paletteItem.addEventListener("click", () => {
      closeSheet({ restoreFocus: false });
      document.getElementById("open-palette")?.click();
    });
  }
  document.addEventListener("keydown", (event) => {
    // Escape closes the topmost layer only: an account menu opened from the
    // sheet closes first (the global handler), the sheet on the next Escape.
    if (event.key === "Escape" && !sheet.hidden && !isAccountMenuOpen()) closeSheet();
  });
}

function bindEvents() {
  // A mouse click leaves focus on the rail button; the next key press (e.g. →
  // to step the board) then makes it :focus-visible, which expands the rail
  // overlay. Drop pointer focus from rail controls so only real keyboard
  // navigation (Tab) opens the rail.
  document.getElementById("app-rail")?.addEventListener("click", (event) => {
    if (event.detail === 0) return; // keyboard activation keeps its focus
    const control = event.target.closest("button");
    if (control && control.id !== "account-chip") control.blur();
  });
  // The hover-expanded rail overlays the board; picking a page collapses it
  // right away instead of waiting for the pointer to leave.
  bindRailCollapseOnNavigate(document.getElementById("app-rail"));
  document.querySelectorAll(".tab[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      dismissTransientOverlays();
      activateWorkspaceTab(button.dataset, { setReplaySection, switchView });
      if (button.dataset.view === "settings") loadSettings();
      if (button.dataset.view === "teams") loadTeams().catch(() => {});
    });
  });
  wireMobileNav();

  // Teams view actions.
  const teamsNewBtn = document.getElementById("teams-new");
  if (teamsNewBtn) teamsNewBtn.addEventListener("click", createTeam);
  const teamDetailClose = document.getElementById("team-detail-close");
  if (teamDetailClose) teamDetailClose.addEventListener("click", hideTeamDetail);

  // Local-first sync (Build edits + Train SR deltas): persist pending state
  // when the tab is backgrounded (best-effort flush) and on unload (keepalive
  // fetch — sendBeacon can't carry the CSRF header the API needs). The next
  // load re-hydrates from server truth regardless, so all paths are best-effort.
  // Backgrounding also arms the Maia idle-teardown timer (see above); returning to
  // the foreground cancels it so an active session is never torn down under the user.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hardFlushBuild().catch(() => {});
      flushTrainSync().catch(() => {});
      scheduleMaiaIdleTeardown();
    } else {
      clearMaiaIdleTeardown();
    }
  });
  window.addEventListener("beforeunload", () => {
    beaconFlushBuild();
    beaconFlushTrain();
  });



  // Account chip (folds in the old standalone Sign out button as a menu action)
  document.getElementById("account-chip").addEventListener("click", () => onAccountChipClick());
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);

  // Replay tab
  document.getElementById("lichess-compare-btn").addEventListener("click", runLichessCompare);
  bindGamesSource();
  bindScoutSource();
  // Static host in the Build panel, so one binding at init covers both states.
  document.getElementById("shared-fork-btn")?.addEventListener("click", forkReadableRepertoire);
  // Start is data-only. The view and its stylesheet are already loading because
  // the Scout section is on screen; this guard covers the click that lands in the
  // few ms before bindControls() attaches the real handler, so Start is never
  // dead and never runs twice.
  document.getElementById("scout-btn")?.addEventListener("click", () => {
    if (document.getElementById("scout-btn").dataset.scoutBound) return;
    preloadScoutUi()
      .then((view) => view.runScout())
      .catch((err) => setStatusError(err.message));
  });

  document.getElementById("run-analysis").addEventListener("click", runAnalysis);
  // F-03: retry just the save from the on-device checkpoint (no re-analysis).
  document.getElementById("analysis-retry-save-btn")?.addEventListener("click", () => {
    void retryAnalyzeSave();
  });
  document.getElementById("analysis-retry-save-discard")?.addEventListener("click", discardAnalyzeCheckpoint);
  const createRepFromGame = document.getElementById("create-repertoire-from-game");
  if (createRepFromGame) {
    createRepFromGame.addEventListener("click", () => {
      onCreateRepertoireFromGameClick().catch(() => {});
    });
  }
  document.getElementById("fetch-my-game").addEventListener("click", () => fetchMyLichessGame());
  // Lazy-load the analysis history list the first time its drawer is opened.
  const historyDrawer = document.getElementById("history-drawer");
  if (historyDrawer) {
    historyDrawer.addEventListener("toggle", () => {
      if (historyDrawer.open) loadAnalysisHistory();
    });
  }
  // Coverage scan: explicit button — never runs implicitly (it's a Maia batch).
  // Scope and horizon live in these header controls, so a change made before
  // the lazy controller loads is still the one it scans with.
  const coverageRun = document.getElementById("coverage-run");
  if (coverageRun) coverageRun.addEventListener("click", runCoverageScanUI);
  const invalidateCoverage = () => { coverageView?.invalidate(); };
  document.querySelectorAll("#coverage-scope [data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-active")) return;
      document.querySelectorAll("#coverage-scope [data-scope]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      invalidateCoverage();
    });
  });
  document.getElementById("coverage-depth")?.addEventListener("change", invalidateCoverage);

  // Explorer and Coverage share one compact header row: title + segmented
  // control + info popover + scan action. Selecting another tool replaces the
  // panel in place; selecting the active tool collapses the inspector.
  const inspectorDbs = document.getElementById("inspector-dbs");
  if (inspectorDbs) {
    inspectorDbs.querySelectorAll(".explorer-db").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        // Mouse clicks drop focus so stepping moves with ← / → never draws a
        // focus ring on the toggle.
        if (event.detail !== 0) btn.blur();
        explorerDb = btn.dataset.db === "lichess" ? "lichess" : "masters";
        inspectorDbs.querySelectorAll(".explorer-db").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
          b.setAttribute("aria-pressed", String(b === btn));
        });
        refreshExplorerPanel();
      });
    });
  }
  document.getElementById("inspector-info")?.addEventListener("click", onInspectorInfo);
  initBuildDockLayout();
  const dockTabs = { explorer: "build-tool-explorer", coverage: "build-tool-coverage" };
  Object.entries(dockTabs).forEach(([name, id]) => {
    const tab = document.getElementById(id);
    if (!tab) return;
    tab.addEventListener("click", (event) => {
      // A tab on a folded dock opens the dock on that tab.
      if (buildDockFolded()) setBuildDockFolded(false);
      if (buildDockTab !== name) setBuildInspector(name);
      // A mouse click shouldn't leave a focus ring that lights up the moment
      // the user steps moves with the arrow keys.
      if (event.detail !== 0) tab.blur();
    });
    tab.addEventListener("keydown", (event) => {
      // ← / → are reserved for stepping the board everywhere in Build (a
      // clicked tab keeps focus, so a tablist arrow handler here would switch
      // Explorer → Coverage while the user is stepping moves).
      const next = event.key === "Home" ? 0 : event.key === "End" ? BUILD_DOCK_TABS.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      setBuildInspector(BUILD_DOCK_TABS[next]);
      document.getElementById(dockTabs[BUILD_DOCK_TABS[next]])?.focus();
    });
  });

  // Drag-and-drop: a PGN onto the Analyze box loads it; a PGN/JSON onto the
  // dashboard repertoires card imports it.
  bindDropZone(document.getElementById("pgn-input"), fillPgnInputFromFile);
  // Live PGN → move-list sync: every edit (debounced) re-parses the box and
  // rebuilds the move list + board. Invalid/half-typed movetext is ignored
  // (quiet) so the list never flickers mid-keystroke.
  const pgnInput = document.getElementById("pgn-input");
  if (pgnInput) {
    pgnInput.addEventListener("input", () => {
      if (analyzePgnWriting) return;
      invalidateAnalysisSource();
      syncViewHeads();
      analyzePgnInputTimer = setTimeout(() => {
        orientAnalysisFromPgn(pgnInput.value);
        void loadPgnIntoAnalyze(pgnInput.value, { goToEnd: true, quiet: true }).catch(
          () => {}
        );
      }, 300);
    });
  }
  document
    .getElementById("open-engine-widget")
    .addEventListener("click", () => setEngineOn("analyze", !engineWantedIn("analyze")));
  document
    .getElementById("explorer-engine-toggle")
    ?.addEventListener("click", () => setEngineOn("build", !engineWantedIn("build")));
  bindEvalChart();
  // While an engine line is on the board, the board-bar arrows step through it.
  const navOrPreview = (action, nav) => () => {
    if (engineWidget && engineWidget.stepPreview(action)) return;
    nav();
  };
  document.getElementById("analysis-start").addEventListener("click", navOrPreview("start", () => {
    void analysisTreeNav("start").catch(() => {});
  }));
  document.getElementById("analysis-prev").addEventListener("click", navOrPreview("prev", () => {
    void analysisTreeNav("prev").catch(() => {});
  }));
  document.getElementById("analysis-next").addEventListener("click", navOrPreview("next", () => {
    void analysisTreeNav("next").catch(() => {});
  }));
  document.getElementById("analysis-end").addEventListener("click", navOrPreview("end", () => {
    void analysisTreeNav("end").catch(() => {});
  }));
  for (const id of ["analysis-pv-exit", "build-pv-exit"]) {
    document.getElementById(id)?.addEventListener("click", () => {
      engineWidget?.exitPreview();
      if (id === "build-pv-exit") boards.build?.endPreview();
    });
  }

  document.getElementById("build-root").addEventListener("click", navOrPreview("start", buildGoRoot));
  document.getElementById("build-parent").addEventListener("click", navOrPreview("prev", buildGoBack));
  document.getElementById("build-next").addEventListener("click", navOrPreview("next", buildGoForward));
  document.getElementById("build-end").addEventListener("click", navOrPreview("end", buildGoToEnd));
  document.getElementById("build-generate-node").addEventListener("click", generateFromCurrentNode);
  document.getElementById("build-menu").addEventListener("click", openBuildMenu);
  document.getElementById("build-empty-create").addEventListener("click", () => createRepertoirePrompt({ title: "New repertoire", defaultName: "New repertoire" }));
  document.getElementById("build-empty-import").addEventListener("click", () => document.getElementById("dashboard-import-input").click());
  document.getElementById("build-empty-open").addEventListener("click", () => switchView("dashboard"));
  document
    .getElementById("import-train-json")
    .addEventListener("click", () => importRepertoireFromInput("train-import-input"));

  document.getElementById("start-train").addEventListener("click", () => startTraining());
  document.getElementById("train-summary-new").addEventListener("click", () => startTraining(undefined, { fresh: true }));
  const startPlay = document.getElementById("start-play");
  if (startPlay) {
    startPlay.addEventListener("click", async () => {
      // Mid-game the same button starts over: ask before throwing the game away.
      const live = appState.play && appState.play.active && (appState.play.history || []).length > 0;
      if (live) {
        const ok = await showConfirmModal({
          title: "Start a new game?",
          body: "The current game will be abandoned.",
          okLabel: "New game",
          cancelLabel: "Keep playing",
        });
        if (!ok) return;
      }
      startPlaySessionTracked();
    });
  }
  const luckyBtn = document.getElementById("feeling-lucky");
  if (luckyBtn) luckyBtn.addEventListener("click", () => onFeelingLucky());
  const takebackBtn = document.getElementById("play-takeback");
  if (takebackBtn) takebackBtn.addEventListener("click", () => takebackPlaySession());
  const resignBtn = document.getElementById("play-resign");
  if (resignBtn) resignBtn.addEventListener("click", () => resignPlaySession());
  const playAnalyze = document.getElementById("play-analyze");
  if (playAnalyze) playAnalyze.addEventListener("click", () => openPlayInAnalyze());
  document.querySelectorAll("#train-play-color .train-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      setPlayPickerColor(btn.dataset.color);
    });
  });
  try {
    if (localStorage.getItem(PLAY_COLOR_KEY) === "black") setPlayPickerColor("black");
  } catch (_) { /* private mode */ }
  const playBookEl = document.getElementById("train-play-book");
  if (playBookEl) {
    playBookEl.addEventListener("change", () => {
      syncTrainPickerVisibility();
    });
  }
  const playRepertoireOptions = document.getElementById("train-repertoire-options");
  if (playRepertoireOptions) {
    playRepertoireOptions.addEventListener("change", (event) => {
      const input = event.target.closest('input[type="checkbox"][data-repertoire-id]');
      if (!input) return;
      const id = String(input.dataset.repertoireId || "");
      if (!id) return;
      const selected = new Set(selectedTrainRepertoireIds());
      if (input.checked) selected.add(id);
      else selected.delete(id);
      appState.playRepertoireIds = [...selected];
      persistPlayRepertoireIds();
      renderPlayRepertoirePicker();
      syncTrainPickerVisibility();
    });
  }
  const playRepertoireSelectAll = document.getElementById("train-repertoire-select-all");
  if (playRepertoireSelectAll) {
    playRepertoireSelectAll.addEventListener("change", () => {
      const active = (appState.repertoireList || []).filter(
        (r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id)),
      );
      appState.playRepertoireIds = playRepertoireSelectAll.checked
        ? active.map((r) => String(r.id))
        : [];
      persistPlayRepertoireIds();
      renderPlayRepertoirePicker(active);
      syncTrainPickerVisibility();
    });
  }
  const trainFresh = document.getElementById("train-fresh");
  if (trainFresh) {
    trainFresh.addEventListener("click", () => startTraining(appState.trainMode, { fresh: true }));
  }
  bindCommandPalette();
  window.addEventListener("popstate", () => {
    const loc = parseWorkspaceLocation(window.location.href);
    if (loc.view === "replay" && loc.replaySection) {
      appState.replaySection = loc.replaySection;
    }
    switchView(loc.view, { fromUrl: true });
  });
  document.getElementById("train-hint").addEventListener("click", trainHint);
  const statusClose = document.getElementById("app-status-close");
  if (statusClose) {
    statusClose.addEventListener("click", () => clearStatus());
  }
  const blitzToggle = document.getElementById("train-blitz-toggle");
  if (blitzToggle) {
    const paintBlitz = (on) => {
      blitzToggle.classList.toggle("is-on", on);
      blitzToggle.setAttribute("aria-checked", String(on));
    };
    paintBlitz(blitzEnabled());
    blitzToggle.addEventListener("click", () => {
      if (blitzToggle.disabled) return;
      const next = !blitzToggle.classList.contains("is-on");
      setBlitzEnabled(next);
      paintBlitz(next);
    });
  }
  document.querySelectorAll("#train-modes .train-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (appState.trainMode === mode && btn.classList.contains("is-active")) return;
      document
        .querySelectorAll("#train-modes .train-mode")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      appState.trainMode = mode;
      appState.playStartToken = (appState.playStartToken || 0) + 1;
      appState.playStarting = null;
      appState.play = null;
      appState.trainBusy = false;
      if (mode !== "smart") appState.smart = null;
      if (mode !== "all_lines") appState.training = null;
      clearBlitzTimer();
      setBlitzBarVisible(false);
      if (mode === "play") {
        appState.smart = null;
        appState.training = null;
        setTrainBanner("idle", "Practice game", "");
        void resetTrainBoardIdle("Practice game");
      } else {
        // "Press Start" is said once, by the Start button itself (UX P2-10).
        setTrainBanner("idle", "Ready to train", "");
        void resetTrainBoardIdle("");
        const progress = document.getElementById("train-progress-panel");
        if (progress) progress.hidden = true;
        const summary = document.getElementById("train-summary");
        if (summary) summary.hidden = true;
      }
      // The answer clock only exists in the smart queue; rehearsal is untimed.
      document.getElementById("train-blitz-row").hidden = mode !== "smart";
      syncTrainPickerVisibility();
    });
  });
  syncTrainPickerVisibility();
  const trainSelect = document.getElementById("train-repertoire-select");
  if (trainSelect) {
    trainSelect.addEventListener("change", () => {
      const value = trainSelect.value;
      appState.trainingRepertoireId = value && value !== "__demo__" ? value : null;
    });
  }

  // Analyze takes a PGN file as well as a paste (Library imports from a file too).
  const pgnFileBtn = document.getElementById("pgn-file-btn");
  const pgnFileInput = document.getElementById("pgn-file-input");
  if (pgnFileBtn && pgnFileInput) {
    pgnFileBtn.addEventListener("click", () => {
      pgnFileInput.value = "";
      pgnFileInput.click();
    });
    pgnFileInput.addEventListener("change", async () => {
      const file = pgnFileInput.files && pgnFileInput.files[0];
      if (!file) return;
      await fillPgnInputFromFile(file);
    });
  }

  // Board flip + skip
  document.getElementById("analysis-flip").addEventListener("click", () => boards.analysis.flip());
  document.getElementById("build-flip").addEventListener("click", () => boards.build.flip());
  document.getElementById("train-flip").addEventListener("click", () => boards.train.flip());
  document.getElementById("train-skip").addEventListener("click", skipTrainingLine);

  // How the current focus arrived: a pointer press, or the keyboard (Tab).
  let focusFromPointer = false;
  document.addEventListener("pointerdown", () => { focusFromPointer = true; }, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Tab") focusFromPointer = false; }, true);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "k") {
      event.preventDefault();
      if (paletteIsOpen()) closePalette();
      else openPalette();
      return;
    }
    if (event.key === "Escape" && paletteIsOpen()) {
      event.preventDefault();
      closePalette();
      return;
    }
    const active = document.activeElement;
    const inEditable =
      !!active &&
      (["TEXTAREA", "INPUT", "SELECT"].includes(active.tagName) ||
        active.isContentEditable === true);
    if (inEditable) return;
    // An engine line on the board: ← → step through it, Esc goes back to the game.
    if (engineWidget && engineWidget.isPreviewing()) {
      const action = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end" }[event.key];
      if (action) {
        event.preventDefault();
        engineWidget.stepPreview(action);
        return;
      }
      if (event.key === "Escape" && !paletteIsOpen()) {
        event.preventDefault();
        engineWidget.exitPreview();
        return;
      }
    }
    // Arrow keys navigate the active tab's board. We blur clicked move buttons
    // on click, so focus returns to the document for these to fire.
    const inBuild = activeViewName() === "build";
    // A control the mouse focused (Engine, the review switch) would otherwise take
    // the keyboard focus ring on the first arrow press, though the arrows drive the board.
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && focusFromPointer && active && active !== document.body) {
      active.blur();
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (inBuild) buildGoBack();
      else void analysisTreeNav("prev").catch(() => {});
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (inBuild) buildGoForward();
      else void analysisTreeNav("next").catch(() => {});
    }
    // Up/Down (and j/k) move the fork pick — which prepared continuation → will
    // play next. The on-screen fork bar and the board arrows mirror the pick.
    // With no fork at the current position they do nothing (← → step the line).
    if (inBuild && (event.key === "ArrowDown" || event.key === "j")) {
      event.preventDefault();
      buildBranchKey(1);
    }
    if (inBuild && (event.key === "ArrowUp" || event.key === "k")) {
      event.preventDefault();
      buildBranchKey(-1);
    }
    // F flips the active tab's board (Analyze / Build / Train all have one).
    if (event.key === "f" || event.key === "F") {
      const board = activeBoardController();
      if (board) {
        event.preventDefault();
        board.flip();
      }
    }
    if (event.key === "Escape") {
      closeNodeContextMenu();
      closeRepertoireContextMenu();
      closeAccountMenu({ restoreFocus: true });
      closePalette();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#node-context-menu")) closeNodeContextMenu();
    if (!event.target.closest("#repertoire-context-menu")) closeRepertoireContextMenu(false);
    // The chip's own click toggles the menu; ignore it here so we don't immediately
    // re-close what the toggle just opened.
    if (
      !event.target.closest("#account-menu") &&
      !event.target.closest("#account-chip") &&
      !event.target.closest("#sheet-account")
    ) {
      closeAccountMenu();
    }
  });
}

async function init() {
  appState.prefs = loadPrefs();
  initAccountController();
  applyPref("theme");
  try {
    const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    systemTheme?.addEventListener?.("change", () => {
      if (pref("theme") === "system") {
        applyTheme("system");
        syncThemeToggle();
      }
    });
  } catch (_) {
    /* matchMedia is optional in embedded/test environments */
  }
  try {
    const storedStyle = localStorage.getItem(PIECE_STYLE_KEY);
    if (storedStyle && PIECE_SETS[storedStyle]) appState.pieceStyle = storedStyle;
  } catch (_) {
    // ignore storage errors
  }
  boards.analysis = new BoardController({
    boardId: "analysis-board",
    overlayId: "analysis-annotations",
    onMove: onAnalysisBoardMove,
  });
  boards.build = new BoardController({
    boardId: "build-board",
    overlayId: "build-annotations",
    onMove: onBuildBoardMove,
    onAnnotate: saveBuildAnnotations,
  });
  boards.train = new BoardController({
    boardId: "train-board",
    overlayId: "train-annotations",
    onMove: (moveUci) => submitTrainingMove(moveUci),
  });
  jobToast.bind();
  bindStatusPillAvoidance();
  engineWidget.bind();
  positionCoach.bind();
  document.getElementById("coach-maia")?.addEventListener("click", (event) => {
    const pill = event.target.closest(".hp[data-uci]");
    if (!pill) return;
    pill.blur();
    void playHumanPick(pill.dataset.uci).catch(() => {});
  });
  bindEvents();
  renderPieceStylePicker();
  renderPrefsToggles();
  // Paint the starting position on every board up front — board state is now
  // browser-computed (chess.js), so a signed-out visitor sees real pieces and can
  // explore freely instead of staring at an empty grid waiting on a 401'd /api/board.
  try {
    const startInfo = await boardInfo(START_FEN);
    boards.analysis.setPosition({ fen: START_FEN, legalMoves: startInfo.legal_moves });
    boards.build.setPosition({ fen: START_FEN, legalMoves: startInfo.legal_moves });
    boards.train.setPosition({ fen: START_FEN, legalMoves: startInfo.legal_moves });
  } catch (_) {
    /* board init is best-effort */
  }
  renderAnalysisTree();
  applyServerEngineGating();
  paintEngineBanners();

  // Learn the auth state BEFORE any owner-scoped calls. A signed-out visitor must
  // not fire /api/settings, /api/dashboard, /api/board, /api/lichess — they 401 and
  // spam the console. Gate that whole workspace load behind a real session.
  await refreshAuthProviders();
  await refreshAuthStatus();
  setHandoffOwner(currentOwnerId());
  if (appState.signedIn) {
    await loadSignedInWorkspace();
  } else {
    renderBuilderTree();
    void loadDashboard();
  }
  // Back from a sign-in (password reload or Google redirect): clean the URL,
  // put the user back on the page they were on, and pick up the action the
  // sign-in gate interrupted (after the workspace has loaded).
  const signInReturn = prepareSignInReturn();
  // The Games tray shows a sign-in chip for guests; repaint for the session.
  paintGamesSource();
  paintScoutSource();
  workspaceUrlReady = true;
  await restoreWorkspaceLocation();
  // A share URL opens the read-only viewer last, so it lands on top of whatever
  // workspace state loaded — and works for signed-out visitors too.
  await maybeOpenSharedView();
  // A join URL (/?join=<code>) redeems a team invite (requires sign-in).
  await maybeHandleJoinLink();
  // A password-reset link (/?reset_password=<token>) opens the reset form, and a
  // Stripe return (/?billing=success|cancelled) reports the outcome once.
  accountService().openResetFromUrl();
  handleBillingReturn();
  syncWorkspaceUrl();
  await resumeAfterSignIn(signInReturn);
}

// Phase 1 of the sign-in return (before the route is restored). Strips
// ?signed_in=1, restores the hash route / ?join= the Google redirect dropped,
// and takes (read-and-remove) the allowlisted pending action.
function prepareSignInReturn() {
  try {
    const cleaned = stripSignedInParam(window.location.href);
    if (cleaned) window.history.replaceState(window.history.state, "", cleaned);
  } catch (_) {
    /* cosmetic */
  }
  if (!appState.signedIn) return { pending: null, returned: false };
  const authReturn = takeAuthReturn();
  const pending = takePendingAction();
  try {
    const restored = restoredAuthHref(window.location.href, {
      route: (authReturn && authReturn.route) || (pending && pending.route) || null,
      join: authReturn ? authReturn.join : null,
    });
    if (restored) window.history.replaceState(window.history.state, "", restored);
  } catch (_) {
    /* cosmetic */
  }
  return { pending, returned: !!authReturn };
}

// Resume handlers for the allowlisted pending actions (auth-gate.js). Each
// re-opens the step the guest was stopped at; nothing here runs stored code.
// Popups and file pickers need a fresh click, so those only lead the user to
// the right control instead of firing it unprompted.
const PENDING_ACTION_HANDLERS = {
  "new-repertoire": () => createRepertoirePrompt({ title: "New repertoire" }),
  "import-pgn": () => {
    switchView("dashboard");
    setStatus("Signed in — choose Import PGN to pick your file.");
  },
  "new-team": () => {
    switchView("teams");
    return createTeam();
  },
  "analyze-game": (pending) => {
    switchView("analyze");
    const input = document.getElementById("pgn-input");
    // Old records or unavailable session storage have no source. Never run
    // the demo in place of a game the user asked us to review.
    input.value = pending.data?.pgn || "";
    if (!input.value) {
      const drawer = document.getElementById("pgn-drawer");
      if (drawer) drawer.open = true;
      setStatus("Signed in — paste your PGN to run the full-game review.");
      return;
    }
    // The sign-in round trip keeps #/analyze?ply=N; put the board back on that move
    // once the game is loaded instead of the start position.
    const wantPly =
      parseWorkspaceLocation(window.location.href).ply ||
      (pending.route ? parseWorkspaceLocation(`/${pending.route}`).ply : null);
    return runAnalysis({ mode: pending.data.mode, selectIndex: pending.data.selectIndex }).then(async (result) => {
      if (wantPly && appState.analysis && !(appState.analysisPly > 0)) await showAnalysisPly(wantPly);
      return result;
    });
  },
  // #/train was restored and restoreWorkspaceLocation already started it.
  train: () => {
    if (appState.currentView !== "train") goToSmartTraining("Starting training…");
  },
  "games-check": () => {
    setReplaySection("games", { syncUrl: false });
    switchView("replay");
    setStatus("Signed in — press Check to compare your games with your repertoire.");
  },
  "scout-start": () => {
    setReplaySection("scout", { syncUrl: false });
    switchView("replay");
    setStatus("Signed in — add the player to scout, then press Start.");
  },
  "lichess-link": () => {
    void openSettingsSection("set-connections").catch(() => {});
    setStatus("Signed in — now link your Lichess account.");
  },
  "my-last-game": () => {
    switchView("analyze");
    if (lichessAccounts().length || appState.lichessUsername) return fetchMyLichessGame();
    setStatus("Signed in — link a Lichess account (Settings → Account) to load your games.");
    return undefined;
  },
};

// Phase 2: the workspace is loaded — run the interrupted action and say
// what came along from the guest session.
async function resumeAfterSignIn({ pending, returned } = {}) {
  if (!appState.signedIn) return;
  if (returned) noteKeptGuestSources();
  if (!pending || !isPendingActionId(pending.id)) return;
  const handler = Object.prototype.hasOwnProperty.call(PENDING_ACTION_HANDLERS, pending.id)
    ? PENDING_ACTION_HANDLERS[pending.id]
    : null;
  if (!handler) return;
  try {
    await handler(pending);
  } catch (error) {
    setStatusError(error.message);
  }
}

// Lichess usernames added as Games/Scout sources live in this browser, not
// the account, so they carry over a sign-in. Say so once instead of letting
// them appear unannounced in the account's Games and Scout.
function noteKeptGuestSources() {
  const names = new Set([
    ...normalizeSelection(gamesSourceSelection()).external,
    ...normalizeSelection(scoutSelection()).external,
  ]);
  if (!names.size) return;
  const list = [...names].slice(0, 3).join(", ") + (names.size > 3 ? ` +${names.size - 3}` : "");
  // A card, not the status pill: the resumed action may own the pill.
  const toast = jobToast.notify({
    id: "kept-guest-sources",
    title: "Kept your Games/Scout sources",
    message:
      `${list} — added before you signed in — stay as Games/Scout sources. ` +
      "Remove them from the source chips if you don't need them.",
    actions: [{ label: "OK", primary: true, onClick: () => {} }],
  });
  if (toast && typeof toast._arm === "function") toast._arm(20000, () => {});
}

function handleBillingReturn() {
  let url;
  try {
    url = new URL(window.location.href);
  } catch (_) {
    return;
  }
  const outcome = url.searchParams.get("billing");
  if (!outcome) return;
  url.searchParams.delete("billing");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  if (outcome === "success") {
    // The webhook is the source of truth for the plan, not this redirect (the
    // param is user-editable, and the webhook may not have landed yet). Re-fetch
    // and only claim Pro if the server actually reports Pro.
    void refreshAuthStatus().then(() => {
      if (appState.account && appState.account.plan === "pro") {
        setStatus("Thanks — your Pro plan is active.");
      } else {
        setStatus(
          "Payment received — your Pro plan is being activated. It can take a moment to show.",
        );
      }
    });
  } else if (outcome === "cancelled") {
    setStatus("Checkout cancelled — nothing was charged.", { severity: "warning" });
  }
}

// Everything that needs an authenticated session. Called from init only when
// signed in, and after a successful sign-in.
async function loadSignedInWorkspace() {
  const owner = currentOwnerId();
  const generation = appState.ownerGeneration;
  const isCurrent = () => owner === currentOwnerId() && generation === appState.ownerGeneration;
  const settingsReady = loadSettingsActions().then((actions) => {
    if (isCurrent()) return actions.loadSettingsOnce({ render: false });
  }).catch((error) => { if (isCurrent()) setStatusError(error.message); });
  const dashboardReady = loadDashboard();
  try {
    const stored = getStoredLichessUsername();
    if (stored) setLichessUsername(stored);
  } catch (_) {
    /* ignore storage errors */
  }
  // The Play opponent book depends on a linked Lichess account.
  refreshLichessStatus()
    .then(() => syncTrainPickerVisibility())
    .catch(() => {});
  syncReplayControls();
  // Boards are already seeded with the start position in init() (browser-computed),
  // so signing in doesn't need to re-fetch them.
  renderBuilderTree();
  // R-03/R-04: this OWNER's durable outbox comes back after a reload or an
  // earlier sign-out, and any flush paused waiting for sign-in re-arms.
  appState.syncPausedForAuth = false;
  const restored = await restoreOutbox();
  if (!isCurrent()) return;
  if (appState.buildPending.length || appState.buildPendingDeletes.length) {
    setBuildSync("dirty");
    scheduleBuildFlush();
  }
  if (restored && (restored.build || restored.train)) {
    const parts = [];
    if (restored.build) parts.push(`${restored.build} Build edit${restored.build === 1 ? "" : "s"}`);
    if (restored.train) parts.push(`${restored.train} training attempt${restored.train === 1 ? "" : "s"}`);
    setStatus(`Unsynced work kept on this device: ${parts.join(" and ")} — saving…`, "info");
  }
  if (restored && restored.rejected) {
    setBuildSync("rejected");
    setStatus(
      `${restored.rejected} edit${restored.rejected === 1 ? "" : "s"} couldn't be saved earlier and ${restored.rejected === 1 ? "is" : "are"} kept for review.`,
      { severity: "warning" },
    );
  }
  await refreshAnalyzeRecovery();
  if (!isCurrent()) return;
  await Promise.allSettled([settingsReady, dashboardReady]);
}

appReadyPromise = init().then(() => {
  document.documentElement.dataset.appReady = "true";
}).catch((error) => setStatusError(error.message));
