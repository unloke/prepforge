import "./styles.css";
import {
  createEngineProvider,
  isBrowserEngineAvailable,
} from "./engine/stockfish-provider.js";
import { analyzeGamePositions } from "./engine/game-analyzer.js";
import {
  getSharedMaia3Provider,
  disposeSharedMaia3Provider,
  peekSharedMaia3Provider,
} from "./engine/maia3-provider.js";
import { createCsrfTokenSource, isSafeMethod, readCsrfCookie, CSRF_HEADER } from "./csrf.js";
import { localBoardInfo, localBoardAfterMove } from "./chess-local.js";
import { flushGroups, groupAttempts, ungroupAttempts } from "./train-sync.js";
import { describeMove } from "./explain.js";
let _coachReady = null;
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
const DEMO_PGN = `[Event "PrepForge UI Demo"]
[Site "https://lichess.org/prepforge-ui"]
[Date "2026.05.25"]
[White "PrepForge"]
[Black "Demo"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;
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
  coordinates: true,
  lastMovePulse: true,
  flipAnim: true,
  moveAnim: true,
  sounds: true,
  bestArrow: true,
  brilliantDetection: false,
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
  if (name === "coordinates") {
    Object.values(boards).forEach((b) => b && b.applyCoordinates && b.applyCoordinates());
  }
  if (name === "bestArrow" && !pref("bestArrow")) {
    Object.values(boards).forEach((b) => b && b.setEngineArrow && b.setEngineArrow(null));
  }
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
  analysis: null,
  // Raw PGN from the most recent in-session Analyze run (not history recall).
  analysisSourcePgn: null,
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
  training: null,
  // Which trainer the Start button launches: "smart" (card queue, default) or
  // "all_lines" (legacy whole-line rehearsal, kept for pre-game prep).
  trainMode: "smart",
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
  // Whether this browser's session is bound to a real account (vs a fresh guest). The
  // app is pure Lichess-OAuth, so signed-in ⇒ a username exists. Guests see a single
  // "Connect Lichess" action; signed-in users get the user-name button → Sign out.
  signedIn: false,
  replayResults: null,
  replayFilter: null, // summary-chip filter: an outcome kind, or null = all
  replayOpen: new Set(), // indexes of expanded game rows
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

const LICHESS_KEY = "prepforge.lichess_username";

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
    const resp = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`);
    if (!resp.ok) return;
    const perfs = (await resp.json()).perfs || {};
    let best = null;
    for (const key of ["bullet", "blitz", "rapid", "classical"]) {
      const p = perfs[key];
      if (p && Number.isFinite(p.rating) && !p.prov) {
        if (!best || (p.games || 0) > best.games) best = { rating: p.rating, games: p.games || 0 };
      }
    }
    if (!best) return;
    appState.maiaAutoRating = Math.max(600, Math.min(2600, Math.round(best.rating)));
    try {
      localStorage.setItem(
        MAIA_AUTO_CACHE_KEY,
        JSON.stringify({ username, rating: appState.maiaAutoRating, at: Date.now() }),
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
const GEN_MAX_PLY_DEPTH = 12;
const GEN_MAX_BRANCHES = 3;
const GEN_PLAN_CHANGES_SOFT_CAP = 2000;

const boards = {};

// Delays (ms) for auto-collapsing/auto-dismissing a card. The countdown only
// runs while the user is *not* actively pointing at the card (see _holdDismiss).
const TOAST_MINIMIZE_DELAY = 7500;
const TOAST_DONE_DELAY = 12000;
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
    // The named phase the bar is currently tracking (e.g. "evaluating" → "brilliancies" →
    // "traps" → "classifying"). A job that runs several phases with DIFFERENT scales resets the
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
    this.el = this._build(title || "Working...", message, actions);
    stack.container.appendChild(this.el);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
    if (this.variant === "job") {
      this._arm(TOAST_MINIMIZE_DELAY, () => {
        if (this.state === "running") this.toggleMinimize(true);
      });
    }
  }

  _build(title, message, actions) {
    const el = document.createElement("div");
    el.className = `job-toast state-${this.state} variant-${this.variant}`;
    el.dataset.state = this.state;
    const stopBtn = this.onCancel
      ? '<button class="job-toast-stop" type="button" title="Stop job">Stop</button>'
      : "";
    let bodyInner;
    if (this.variant === "info") {
      bodyInner =
        `<div class="job-toast-message">${escapeHtml(message || "")}</div>` +
        '<div class="job-toast-actions"></div>';
    } else {
      // Track and Stop share one row so they never crowd each other, and the
      // track stays visible when the card is minimized.
      bodyInner =
        '<div class="job-toast-message">Queued</div>' +
        '<div class="job-toast-progress">' +
        '<div class="job-toast-track"><div class="job-toast-fill"></div></div>' +
        stopBtn +
        "</div>";
    }
    el.innerHTML =
      '<div class="job-toast-head">' +
      '<span class="job-toast-icon" aria-hidden="true"></span>' +
      `<span class="job-toast-title">${escapeHtml(title)}</span>` +
      '<button class="job-toast-collapse" type="button" title="Minimize" aria-label="Minimize">_</button>' +
      "</div>" +
      `<div class="job-toast-body">${bodyInner}</div>`;
    this.titleEl = el.querySelector(".job-toast-title");
    this.messageEl = el.querySelector(".job-toast-message");
    this.fillEl = el.querySelector(".job-toast-fill");
    this.collapseBtn = el.querySelector(".job-toast-collapse");
    this.stopBtn = el.querySelector(".job-toast-stop");
    this.collapseBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMinimize(true);
    });
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
    this._arm(TOAST_DONE_DELAY, () => this.dismiss());
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
    const next = typeof force === "boolean" ? force : !this.minimized;
    this.minimized = next;
    this.el.classList.toggle("is-minimized", next);
    // Re-arm the running-job minimize timer when the user expands it again.
    if (!next && this.state === "running") {
      this._arm(TOAST_MINIMIZE_DELAY, () => {
        if (this.state === "running") this.toggleMinimize(true);
      });
    }
  }

  dismiss() {
    if (this.removed) return;
    this.removed = true;
    this._clearProgressFlush();
    this._clearDismiss();
    this._clearIdle();
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

function showUndoToast({ title, message, onUndo, onCommit }) {
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
    this.multipv = 1;
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
    this.engine = createEngineProvider({ maxDepth: depth });
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
    this._bindDrag();
    this._bindResize();
  }

  isOpen() {
    return this.open;
  }

  /** FEN of whichever board the active tab is showing. */
  currentFen() {
    if (activeViewName() === "build") {
      const node = appState.buildNodeById.get(appState.buildCurrentNodeId);
      if (node && node.fen) return node.fen;
    }
    return appState.analysisBoardFen || START_FEN;
  }

  async openForCurrent() {
    // The engine widget runs its own lightweight Stockfish session and is
    // intentionally *not* gated on heavy Analyze/Build jobs — the user can keep
    // probing positions while a long job runs in the background.
    this.open = true;
    this.el.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.el.classList.add("is-visible"));
    });
    await this._restartForCurrentBoard();
    this._startPolling();
  }

  async close() {
    if (!this.open) return;
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
      const snapshot = await engine.update({ fen, multipv: this.multipv });
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
      const snapshot = await engine.open({ fen, multipv: this.multipv });
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
      const snapshot = await engine.update({ fen, multipv: clamped });
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
    setStatus(message);
    if (this.pvsEl) {
      this.pvsEl.innerHTML = `<div class="empty-state">${escapeHtml(
        message || "Engine error"
      )}</div>`;
    }
  }

  _clearAnalysisView() {
    setEngineBestArrow(null);
    if (this.pvsEl) {
      this.pvsEl.innerHTML = '<div class="empty-state">Calculating...</div>';
    }
    if (this.depthReadout) this.depthReadout.textContent = "0 / ?";
    if (this.evalBarText) this.evalBarText.textContent = "...";
    if (this.evalHead) this.evalHead.textContent = "...";
  }

  _renderLinesReadout() {
    if (!this.linesReadout) return;
    this.linesReadout.textContent = `${this.multipv}`;
    if (this.linesDownBtn) this.linesDownBtn.disabled = this.multipv <= this.minMultipv;
    if (this.linesUpBtn) this.linesUpBtn.disabled = this.multipv >= this.maxMultipv;
  }

  _bindControls() {
    this.closeBtn.addEventListener("click", () => this.close());
    this.linesUpBtn.addEventListener("click", () => this._setMultipv(this.multipv + 1));
    this.linesDownBtn.addEventListener("click", () => this._setMultipv(this.multipv - 1));
  }

  _startPolling() {
    // Never poll a closed panel. openForCurrent()/onDepthSettingChanged() call this right after
    // awaiting _restartForCurrentBoard(), so the user may have closed the widget mid-await — guard
    // here to cover every call site at once (a stray 450ms interval on a hidden panel otherwise).
    if (!this.open) return;
    this._stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const snapshot = await this.engine.snapshot();
        if (!this.open) return; // closed between the _stopPolling() in close() and this tick
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
    const depthText = `${snapshot.current_depth || 0} / ${snapshot.max_depth || "?"}`;
    if (this.depthReadout) this.depthReadout.textContent = depthText;
    const pvs = Array.isArray(snapshot.pvs) ? snapshot.pvs : [];
    // Render only as many PV slots as the user asked for; engines occasionally
    // emit transient extra ranks while changing multipv.
    const sideToMove = snapshot.side_to_move || "white";
    const fullmoveNumber = this._fullmoveFromFen(snapshot.fen) || 1;
    if (pvs.length) {
      this.pvsEl.innerHTML = pvs
        .slice(0, this.multipv)
        .map((pv, index) =>
          this._renderPv(pv, index === 0, sideToMove, fullmoveNumber)
        )
        .join("");
      this._renderEvalBar(pvs[0]);
      const best = (pvs[0].pv_uci || [])[0] || null;
      setEngineBestArrow(best);
    } else {
      setEngineBestArrow(null);
      this.pvsEl.innerHTML = '<div class="empty-state">Calculating...</div>';
    }
    // Keep the coach's one-line rationale in sync with this (deeper) search.
    if (typeof positionCoach !== "undefined") positionCoach.onWidgetSnapshot(snapshot);
    // Once the engine reaches max depth it stops; no point polling further
    // until the position changes (open/update restart polling).
    if (snapshot.running === false) this._stopPolling();
  }

  _renderPv(pv, isTop, sideToMove, fullmoveNumber) {
    const evalText = this._formatEval(pv.score_cp, pv.mate_in);
    const moves = this._formatPvLine(
      pv.pv_san || [],
      sideToMove,
      fullmoveNumber
    );
    const cls = isTop ? "engine-pv is-top" : "engine-pv";
    return (
      `<div class="${cls}">` +
      `<span class="engine-pv-eval">${escapeHtml(evalText)}</span>` +
      `<span class="engine-pv-line">${moves || "..."}</span>` +
      `</div>`
    );
  }

  _formatPvLine(moves, sideToMove, fullmoveNumber) {
    if (!moves || !moves.length) return "";
    const out = [];
    let move = fullmoveNumber;
    let whiteToMove = sideToMove === "white";
    for (let i = 0; i < moves.length; i += 1) {
      if (whiteToMove) {
        out.push(`<span class="pv-move-num">${move}.</span>${escapeHtml(moves[i])}`);
      } else {
        if (i === 0) {
          out.push(`<span class="pv-move-num">${move}...</span>${escapeHtml(moves[i])}`);
        } else {
          out.push(escapeHtml(moves[i]));
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
    if (this.evalBarText) this.evalBarText.textContent = evalStr;
    if (this.evalHead) this.evalHead.textContent = evalStr;
  }

  _bindDrag() {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      this.el.style.left = `${Math.max(0, startLeft + dx)}px`;
      this.el.style.top = `${Math.max(0, startTop + dy)}px`;
      this.el.style.right = "auto";
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    this.head.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      event.preventDefault();
      this.head.setPointerCapture(event.pointerId);
      dragging = true;
      const rect = this.el.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  _bindResize() {
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let resizing = false;
    const onMove = (event) => {
      if (!resizing) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      this.el.style.width = `${Math.max(260, startW + dx)}px`;
      this.el.style.height = `${Math.max(220, startH + dy)}px`;
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    this.resizeHandle.addEventListener("pointerdown", (event) => {
      resizing = true;
      const rect = this.el.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startW = rect.width;
      startH = rect.height;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      event.preventDefault();
    });
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
    depth: ev.depth || depth || 0,
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

class PositionCoach {
  constructor() {
    this.engine = null;
    this.engineDepth = null;
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

  // Build the coach's own Stockfish at the current Settings depth, rebuilding (and
  // dropping the now-stale eval cache) if that depth changed since we last built.
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
    this.engine = createEngineProvider({ maxDepth: depth });
    this.engineDepth = depth;
    this.evalCache.clear();
  }

  bind() {
    const toggle = document.getElementById("explain-engine-toggle");
    if (!toggle) return;
    this.enabled = toggle.checked;
    toggle.addEventListener("change", () => {
      this.enabled = toggle.checked;
      if (this.enabled) this.update(this.fen, this.ctx);
      else renderInstantCoach(); // engine off → fall back to the plain read
    });
  }

  // Kept as a no-op: the coach runs its own searches and draws no competing arrow,
  // so it no longer needs to mirror the Engine window's snapshots.
  onWidgetSnapshot() {}

  // Called on every Analyze position change. The instant plain-language read is
  // already on screen (renderInstantCoach); this replaces it with the engine's
  // verdict on the move that was JUST PLAYED — never a next-move instruction.
  update(fen, ctx) {
    this.fen = fen;
    this.ctx = ctx || {};
    setEngineBestArrow(null); // review mode: the board shows your move, not a hint
    if (!fen) return;
    if (!this.enabled) return; // engine off → leave the instant read
    if (activeViewName() !== "analyze") return;
    const hasMove = !!(this.ctx.prevFen && this.ctx.lastUci);
    if (!hasMove) return; // nothing played in → leave the instant read
    if (!isBrowserEngineAvailable()) return; // no engine → leave the instant read
    window.clearTimeout(this.timer);
    setCoachProse("Let me look at that…", "info");
    const target = fen;
    this.timer = window.setTimeout(() => this._run(target), 280);
  }

  async _run(fen) {
    if (fen !== this.fen) return;
    const ctx = this.ctx;
    const prevFen = ctx.prevFen;
    const token = ++this.token;
    try {
      const c = await (_coachReady || preloadCoach());
      this._ensureEngine();
      // The position BEFORE the move (best line + best alternative) and AFTER it.
      const before = await this._eval(prevFen, token);
      if (token !== this.token || fen !== this.fen) return;
      if (!before || !before.lines.length) return;

      const mover = fen.split(" ")[1] === "b" ? "white" : "black";

      // A move that ends the game (checkmate/stalemate) leaves no position for the
      // engine to search — _eval(fen) comes back empty and we'd silently produce no
      // commentary at all for the final move. Synthesize the "after" read instead.
      let top;
      const status = localBoardInfo(fen).status;
      if (status.is_checkmate) {
        top = { cp: null, mate: mover === "white" ? 1 : -1, pvUci: [], pvSan: [] };
      } else if (status.is_stalemate) {
        top = { cp: 0, mate: null, pvUci: [], pvSan: [] };
      } else {
        const after = await this._eval(fen, token);
        if (token !== this.token || fen !== this.fen) return;
        if (!after) return;
        top = after.lines[0] || {};
      }
      const features = c.buildMoveFeatures({
        ply: ctx.ply ?? null,
        moveNumber: Number(prevFen.split(" ")[5]) || null,
        mover,
        uci: ctx.lastUci,
        san: ctx.lastSan,
        fenBefore: prevFen,
        fenAfter: fen,
        beforeEval: { lines: before.lines },
        afterEval: { cp: top.cp ?? null, mate: top.mate ?? null, pvUci: top.pvUci || [], pvSan: top.pvSan || [] },
      });
      renderCoachProse(c.buildCommentary(features));
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
      const saved = savedMainlineMove(ctx.ply, prevFen, ctx.lastUci, fen);
      if (saved) {
        if (saved.classification === "brilliant") {
          this._showSavedBrilliant(c, features, prevFen, ctx.lastUci, fen, token);
        }
        // A saved non-brilliant verdict is authoritative → leave the base read as is.
      } else if (features.brilliantCandidate && pref("brilliantDetection")) {
        this._checkBrilliant(features, prevFen, ctx.lastUci, fen, token);
      }
    } catch (err) {
      console.warn("Coach: failed to build move commentary", err);
      /* leave the instant read on screen */
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
      // Brilliant has three layers, cheapest-first (see brilliant-assess.js). The two cheap
      // ones gate the costly trap_gap (a Maia policy read + a Stockfish eval of the natural
      // move), so we never pay for it on a move a free check already ruled out:
      //   • Unintuitive — a human rarely finds it.
      if (!(a.humanProbability <= c.BRILLIANT_MAX_HUMAN_PROB)) return;
      //   • Reveal — Stockfish's truth sits far above Maia's first-glance read. (Free: both
      //     numbers are already in hand.) This is the gate that used to be checked only after
      //     trap_gap had already run, inside isBrilliantByMaia.
      if (features.winAfterMover - a.winChanceAfter * 100 < c.BRILLIANT_MIN_WIN_GAP) return;
      const trapGap = await this._trapGap(features, prevFen, uci, fen, token, rating);
      if (token !== this.token || fen !== this.fen) return;
      const brilliant = c.isBrilliantByMaia(features, {
        maiaHumanProb: a.humanProbability,
        maiaWinAfter: a.winChanceAfter,
        trapGap,
      });
      if (brilliant) {
        c.markBrilliant(features, { humanProb: a.humanProbability, winChanceAfter: a.winChanceAfter });
        renderCoachProse(c.buildCommentary(features));
      }
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
    renderCoachProse(c.buildCommentary(features));
    // Then enrich — non-blocking — with how rarely a human finds it. This is a cosmetic detail
    // on top of an already-shown Brilliant; a re-render only if the user is still on this move
    // when Maia answers. Maia unavailable → the star simply stays without the rarity grounding.
    try {
      const provider = getSharedMaia3Provider();
      const a = await provider.moveAssessment({ fen: prevFen, moveUci: uci, rating: effectiveMaiaRating() });
      if (!a || token !== this.token || fen !== this.fen) return;
      c.markBrilliant(features, { humanProb: a.humanProbability, winChanceAfter: a.winChanceAfter });
      renderCoachProse(c.buildCommentary(features));
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
  // one a hard choice. Best-effort and async — if Maia is unavailable the engine read
  // simply stands with no texture note. One Maia forward per move, reusing the shared
  // worker (the model is loaded once and cached), so it rides the existing budget.
  async _checkIntuition(features, prevFen, fen, token) {
    try {
      const c = await (_coachReady || preloadCoach());
      const provider = getSharedMaia3Provider();
      // Personalized: the texture read runs at the player's own strength (Settings →
      // Playing strength), so "one obvious move" means obvious to THEM.
      const read = await provider.positionRead({ fen: prevFen, rating: effectiveMaiaRating() });
      if (token !== this.token || fen !== this.fen || !read) return;
      c.attachIntuition(features, read);
      renderCoachProse(c.buildCommentary(features));
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
    await this.engine.open({ fen, multipv: 2 });
    const deadline = Date.now() + 1200;
    let snap = this.engine.snapshot();
    while (Date.now() < deadline) {
      await sleep(150);
      if (token !== this.token) return null;
      snap = this.engine.snapshot();
      const ready = snap && snap.pvs && snap.pvs.length && snap.pvs[0].pv_uci.length;
      if (ready && (snap.running === false || snap.current_depth >= 14)) break;
    }
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
    this.evalCache.set(key, result);
    if (this.evalCache.size > 50) this.evalCache.delete(this.evalCache.keys().next().value);
    return result;
  }
}

const positionCoach = new PositionCoach();

const COACH_TONES = ["good", "warn", "danger", "info", "brilliant"];

// The Coach speaks in one short paragraph. Set its text + tone (subtle colour).
function setCoachProse(text, tone = "info") {
  const el = document.getElementById("coach-prose");
  if (!el) return;
  el.textContent = text || "";
  for (const t of COACH_TONES) el.classList.toggle(`is-${t}`, t === tone);
}

// Render the engine's read of the move just played, in the coach's own voice.
function renderCoachProse(c) {
  if (!c) return;
  setCoachProse(c.prose, c.tone);
}

// Drive the coach from one position-change call: show an instant plain-language read
// immediately, then let the engine replace it with a graded verdict.
function refreshAnalysisExplain(ctx) {
  appState.explainContext = ctx || {};
  renderInstantCoach();
  positionCoach.update(ctx ? ctx.fen : null, ctx || {});
  updateBookline().catch(() => { /* book read is best-effort */ });
}

// Instant, engine-free sentence: what the last move did, or whose move it is. This is
// the placeholder the engine commentary upgrades a beat later.
function renderInstantCoach() {
  const ctx = appState.explainContext || {};
  const fen = ctx.fen || appState.analysisBoardFen || START_FEN;
  const turn = fen.split(" ")[1] === "b" ? "black" : "white";
  if (ctx.prevFen && ctx.lastSan) {
    const mover = turn === "white" ? "Black" : "White"; // the side that just moved
    const did = describeMove(ctx.prevFen, ctx.lastUci, ctx.lastSan);
    setCoachProse(did ? `${mover} ${did}.` : `${mover} plays ${ctx.lastSan}.`, "info");
  } else {
    const side = turn === "white" ? "White" : "Black";
    setCoachProse(`${side} to move. Make a move and I'll tell you what I think.`, "info");
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
  loaded: false,
  loading: null,
  reps: [], // { id, name, color, rootId, children: Map("parentId|uci" -> node), kids: Map(parentId -> [node]) }
};

// Build edits make this copy stale; drop it so the next Analyze look refetches.
function invalidateBook() {
  bookState.loaded = false;
  bookState.loading = null;
  bookState.reps = [];
}

async function ensureBookLoaded() {
  if (bookState.loaded) return;
  if (bookState.loading) return bookState.loading;
  bookState.loading = (async () => {
    let reps = [];
    try {
      const payload = await api("/api/repertoires");
      const active = (payload.repertoires || []).filter(
        (r) => r.is_active !== false && !appState.pendingRepDeletes.has(String(r.id))
      );
      reps = (
        await Promise.all(
          active.map(async (meta) => {
            const data = await api(
              `/api/build/load?repertoire_id=${encodeURIComponent(meta.id)}`
            );
            const children = new Map();
            const kids = new Map();
            let rootId = null;
            for (const node of data.nodes || []) {
              if (!node.parent_id) {
                rootId = node.id;
                continue;
              }
              if (node.is_enabled === false || !node.uci) continue;
              children.set(`${node.parent_id}|${node.uci}`, node);
              if (!kids.has(node.parent_id)) kids.set(node.parent_id, []);
              kids.get(node.parent_id).push(node);
            }
            return rootId
              ? { id: data.repertoire_id, name: data.name, color: data.color, rootId, children, kids }
              : null;
          })
        )
      ).filter(Boolean);
    } catch (_) {
      /* guest / fetch failure → no book; the banner simply stays hidden */
    }
    bookState.reps = reps;
    bookState.loaded = true;
    bookState.loading = null;
  })();
  return bookState.loading;
}

// Deepest full-prefix match of `ucis` across the loaded repertoires.
// Returns { rep, node, matched } for the best rep, or null when none loaded.
function bookMatch(ucis) {
  let best = null;
  for (const rep of bookState.reps) {
    let cur = rep.rootId;
    let node = null;
    let matched = 0;
    for (const uci of ucis) {
      const child = rep.children.get(`${cur}|${uci}`);
      if (!child) break;
      node = child;
      cur = child.id;
      matched += 1;
    }
    if (!best || matched > best.matched) best = { rep, node, nodeId: cur, matched };
  }
  return best;
}

// The uci path from the analysis-tree root down to `node` (mainline or variation).
function analysisNodePath(node) {
  const path = [];
  for (let cur = node; cur && cur.parent; cur = cur.parent) path.push(cur.uci);
  return path.reverse();
}

function hideBookline() {
  const el = document.getElementById("coach-bookline");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
}

// Called on every Analyze position change (via refreshAnalysisExplain). Async and
// best-effort: the first call kicks off the lazy load and re-renders when it lands.
//
// The departure note is part of the coach's CONVERSATION, not a status widget:
// while the line is in book, nothing is shown (the screen only carries what's
// useful right now); at the exact ply a move steps out of the book, the coach
// adds one sentence from the bookline phrase bank, with the single useful
// action (train the forgotten move / add the novelty in Build) as an inline
// chip at the end of the sentence, like a spoken link.
async function updateBookline() {
  const el = document.getElementById("coach-bookline");
  if (!el) return;
  if (!appState.signedIn) return hideBookline();
  const { buildBookline } = await (_coachReady || preloadCoach());
  const nodeId = appState.analysisCurrentNodeId || "root";
  await ensureBookLoaded();
  // Re-read after the await — the user may have navigated while the trees loaded.
  if ((appState.analysisCurrentNodeId || "root") !== nodeId) return;
  if (!bookState.reps.length) return hideBookline();
  const tree = appState.analysisTree;
  const node = tree && tree.byId.get(nodeId);
  if (!node || !node.parent) return hideBookline(); // root: nothing played yet
  const path = analysisNodePath(node);
  const cur = bookMatch(path);
  // Still in book: the coach has nothing to flag, so it says nothing.
  if (cur && cur.matched === path.length) return hideBookline();
  // Out of book. Only speak at the departure ply: the PARENT was fully in book.
  // When the parent position sits in SEVERAL books, prefer the repertoire where
  // the mover is the player — forgetting your own prep outranks a novelty note.
  const prefix = path.slice(0, -1);
  const fullPrev = bookState.reps
    .map((rep) => {
      let walk = rep.rootId;
      for (const uci of prefix) {
        const child = rep.children.get(`${walk}|${uci}`);
        if (!child) return null;
        walk = child.id;
      }
      return { rep, nodeId: walk };
    })
    .filter(Boolean);
  if (!fullPrev.length) return hideBookline();
  const prev = fullPrev.find((m) => node.side === m.rep.color) || fullPrev[0];
  const rep = prev.rep;
  const moverIsUser = node.side === rep.color;

  if (moverIsUser) {
    // The player left their own prep: say what the script wanted, offer to drill it.
    const prescribed = (rep.kids.get(prev.nodeId) || [])
      .sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline))[0];
    if (!prescribed) return hideBookline(); // book actually ends here — no miss
    const text = buildBookline({
      kind: "user",
      san: node.san,
      uci: node.uci,
      ply: path.length,
      repName: rep.name,
      expectedSan: prescribed.san,
    });
    el.innerHTML =
      `${escapeHtml(text)} ` +
      `<button class="coach-bookaction" type="button" data-act="train">Train it<span class="cba-arrow" aria-hidden="true">›</span></button>`;
    el.hidden = false;
    el.querySelector('[data-act="train"]').addEventListener("click", async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        await postJson("/api/train/record-miss", {
          repertoire_id: rep.id,
          node_id: prescribed.id,
        });
        btn.textContent = "Queued ✓";
        setStatus(`${prescribed.san} will lead your next smart session`);
      } catch (error) {
        btn.disabled = false;
        setStatus(error.message);
      }
    });
  } else {
    // Opponent novelty: nothing to recall — offer to extend the book instead.
    const text = buildBookline({
      kind: "opponent",
      san: node.san,
      uci: node.uci,
      ply: path.length,
      repName: rep.name,
    });
    el.innerHTML =
      `${escapeHtml(text)} ` +
      `<button class="coach-bookaction" type="button" data-act="build">Add it in Build<span class="cba-arrow" aria-hidden="true">›</span></button>`;
    el.hidden = false;
    el.querySelector('[data-act="build"]').addEventListener("click", () =>
      editRepertoire(rep.id, prev.nodeId)
    );
  }
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
    this.branchArrows = [];
    this.branchPick = null;
    this.moveBadge = null;
    this._hadPosition = false;
    this.annotationStart = null;
    this.highlights = new Set();
    this.arrows = [];
    this.squares = new Map();
    this._badgeEl = null;       // tracks the one square holding a .square-badge
    this._lastMoveSqs = null;   // tracks the [from, to] squares of the current last-move
    this.orientation = "white";
    this._buildGrid();
    this._bindBoardEvents();
  }

  setOrientation(orientation) {
    const next = orientation === "black" ? "black" : "white";
    if (this.orientation === next) return;
    this.orientation = next;
    this._buildGrid();
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
      this.branchPick
    );
  }

  setEngineArrow(uci) {
    const next = uci || null;
    if (this.engineArrow === next) return;
    this.engineArrow = next;
    this._renderArrows();
  }

  // Faint arrows for the fork's next-move options at the current position, so a
  // branch point is visible on the board itself (the fork picker's on-board echo).
  // ``pickUci`` is the currently picked option, drawn stronger than its siblings.
  setBranchArrows(list, pickUci = null) {
    const next = Array.isArray(list) ? list.filter((u) => typeof u === "string" && u.length >= 4) : [];
    const pick = typeof pickUci === "string" && pickUci.length >= 4 ? pickUci : null;
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
  }

  applyCoordinates() {
    this.board.classList.toggle("show-coords", pref("coordinates"));
  }

  _bindBoardEvents() {
    this.board.addEventListener("contextmenu", (event) => event.preventDefault());

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
        const move = legalMoveFor(this.selected, squareName, this.legalMoves);
        if (move) {
          this._setSelected(null);
          this.play(move);
          return;
        }
      }
      if (this.hasLegalFrom(squareName)) {
        this._setSelected(squareName);
        this._beginDrag(squareName, event);
      } else {
        this._setSelected(null);
      }
    });

    this.board.addEventListener("pointerup", (event) => {
      if (event.button === 2) this._finishAnnotation(event);
    });

    // Keyboard parity for the click-to-move model: squares are <button>s, so they
    // already take focus and Tab order. Enter/Space on a square selects a movable
    // piece, then selects a legal target to play — the pointer path minus the drag
    // (which keyboards can't do). Without this, keyboard users could focus squares
    // but never move (flagged P2 in the Build and Train friction audits).
    this.board.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      const square = event.target.closest(".square");
      if (!square) return;
      const squareName = square.dataset.square;
      // Swallow the default button activation so Space doesn't also scroll and
      // Enter doesn't fire a redundant synthetic click.
      event.preventDefault();
      if (this.selected && this.selected !== squareName) {
        const move = legalMoveFor(this.selected, squareName, this.legalMoves);
        if (move) {
          this._setSelected(null);
          this.play(move);
          return;
        }
      }
      if (this.hasLegalFrom(squareName)) {
        this._setSelected(squareName);
      } else {
        this._setSelected(null);
      }
    });
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
    this._cancelDrag();
    if (!from) return;
    const target = this._squareAt(event);
    // Same-square release is treated as a click: the piece stays selected so a
    // follow-up click on a target square plays the move.
    if (!target || target === from) return;
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
    this._cancelDrag();
    const fenChanged = this.fen !== fen;
    const prevFen = this.fen;

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
    this.selected = null;
    this.lastMove = lastMove;
    this.moveBadge = null;
    this.dragFrom = null;
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
    // Clear previous badge from exactly the one tracked square (not a 64-square scan).
    if (this._badgeEl) {
      const existing = this._badgeEl.querySelector(".square-badge");
      if (existing) existing.remove();
      this._badgeEl = null;
    }
    if (!this.moveBadge) return;
    const square = this.squares.get(this.moveBadge.square);
    if (!square) return;
    this._badgeEl = square;
    const cls = this.moveBadge.classification.replace(/[^a-z0-9_-]/g, "");
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

function setStatus(message) {
  document.getElementById("app-status").textContent = message;
}

const getCsrfToken = createCsrfTokenSource();

async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  // Merge caller headers over the JSON default, then attach the CSRF token on
  // unsafe methods (bootstrapping /api/csrf if the cookie isn't set yet). The
  // FastAPI backend 403s any unsafe request that doesn't echo the cookie.
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!isSafeMethod(method)) {
    const token = await getCsrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
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
  // Legacy server returned {error}; FastAPI returns {detail}. Accept both so the
  // SPA surfaces real messages during and after the cutover.
  if (!response.ok) {
    const err = new Error(payload.error || payload.detail || `Request failed (${response.status})`);
    err.status = response.status; // lets callers (e.g. Build sync) tell 4xx from 5xx/network
    throw err;
  }
  return payload;
}

function postJson(path, body, options = {}) {
  // `options` (e.g. an AbortSignal) is forwarded to fetch via api(); it spreads
  // last so a caller can pass `signal` for a cancellable request.
  return api(path, {
    method: "POST",
    body: JSON.stringify(body || {}),
    ...options,
  });
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

function switchView(name) {
  appState.currentView = name;
  // Navigating is user activity; if the Lichess watch is running, switching to
  // Analyze (where a fresh game matters most) tightens the poll cadence briefly.
  noteLichessActivity();
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  if (name === "analyze") {
    preloadCoach().catch(() => {});
    preloadAnalyzeView().catch(() => {});
  }
  if (name === "build") {
    preloadCoach().catch(() => {});
    preloadBuildGen().catch(() => {});
    preloadBuildView().catch(() => {});
  }
  if (name === "train") {
    preloadTrainView().catch(() => {});
    loadTrainRepertoireOptions();
  }
  if (name === "replay") {
    preloadReplayView().catch(() => {});
    bindScoutControlsLazy();
  }
  if (name === "settings") {
    preloadSettingsView().catch(() => {});
  }
  // Warm the Analyze book (active repertoire trees) so the first explored move
  // can be matched without waiting on the lazy load.
  if (name === "analyze" && appState.signedIn) {
    ensureBookLoaded()
      .then(() => updateBookline())
      .catch(() => { /* best-effort */ });
  }
  // Entering dashboard loads the view chunk; signed-in users also refresh counters.
  if (name === "dashboard") {
    ensureDashboardView().catch(() => {});
    if (appState.signedIn) {
      loadDashboard().catch(() => { /* counters refresh is best-effort */ });
    }
  }
  // Entering Teams (re)loads the caller's teams + shared list.
  if (name === "teams") {
    preloadTeamsView().catch(() => {});
    if (appState.signedIn) loadTeams().catch(() => { /* best-effort */ });
  }
  // The engine widget is shared across tabs: it stays open while navigating and
  // re-syncs to whichever board the new tab shows (Analyze or Build).
  if (engineWidget && engineWidget.isOpen && engineWidget.isOpen()) {
    if (name === "analyze" || name === "build") engineWidget.onBoardChanged();
  }
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
  const sample = ["K", "Q", "N", "p"];
  host.innerHTML = Object.keys(PIECE_SETS)
    .map((style) => {
      const active = style === appState.pieceStyle ? " is-active" : "";
      const set = PIECE_SETS[style];
      const previews = sample
        .map((pc) => {
          const colorClass = pc === pc.toUpperCase() ? "piece-white" : "piece-black";
          return `<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${set[pc.toLowerCase()]}</g></svg>`;
        })
        .join("");
      return (
        `<button type="button" class="piece-style-option${active}" data-style="${escapeHtml(style)}">` +
        `<span class="piece-style-preview">${previews}</span>` +
        `<span class="piece-style-name">${escapeHtml(PIECE_STYLE_LABELS[style] || style)}</span>` +
        `</button>`
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
      return (
        `<button type="button" class="pref-toggle${on}" data-pref="${escapeHtml(key)}" role="switch" aria-checked="${pref(key)}">` +
        `<span class="pref-label">${escapeHtml(PREF_LABELS[key] || key)}</span>` +
        `<span class="pref-switch"><span class="pref-knob"></span></span>` +
        `</button>`
      );
    })
    .join("");
  host.querySelectorAll(".pref-toggle").forEach((btn) => {
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

// Build a single closed polygon for an arrow from `from` to `to`.
// Doing shaft + head as one path (instead of a <line> + <marker>) means the
// arrowhead and shaft are guaranteed to be in perfect alignment regardless of
// stroke width, marker scale, or board orientation. The tip lands exactly on
// the to-square center and the tail starts near the edge of the from-square.
function buildArrowPath(from, to) {
  const tailOffset = 4.0;
  const headLength = 5.0;
  const halfBase = 1.05;
  const halfNeck = 0.85;
  const halfHead = 2.25;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;

  const sx = from.x + ux * tailOffset;
  const sy = from.y + uy * tailOffset;
  const nx = to.x - ux * headLength;
  const ny = to.y - uy * headLength;

  const p1x = sx + px * halfBase, p1y = sy + py * halfBase;
  const p2x = nx + px * halfNeck, p2y = ny + py * halfNeck;
  const p3x = nx + px * halfHead, p3y = ny + py * halfHead;
  const p5x = nx - px * halfHead, p5y = ny - py * halfHead;
  const p6x = nx - px * halfNeck, p6y = ny - py * halfNeck;
  const p7x = sx - px * halfBase, p7y = sy - py * halfBase;

  return [
    `M${p1x.toFixed(3)},${p1y.toFixed(3)}`,
    `L${p2x.toFixed(3)},${p2y.toFixed(3)}`,
    `L${p3x.toFixed(3)},${p3y.toFixed(3)}`,
    `L${to.x.toFixed(3)},${to.y.toFixed(3)}`,
    `L${p5x.toFixed(3)},${p5y.toFixed(3)}`,
    `L${p6x.toFixed(3)},${p6y.toFixed(3)}`,
    `L${p7x.toFixed(3)},${p7y.toFixed(3)}`,
    "Z",
  ].join(" ");
}

function renderAnnotations(
  overlay,
  arrows,
  orientation = "white",
  engineArrow = null,
  branchArrows = [],
  branchPick = null
) {
  overlay.setAttribute("viewBox", "0 0 100 100");
  overlay.innerHTML = "";
  // Colours and stroke come from CSS tokens (.annot-arrow rules) so board
  // arrows stay in step with the rest of the theme.
  const drawArrow = (arrow, kind) => {
    const from = squareCenter(arrow.slice(0, 2), orientation);
    const to = squareCenter(arrow.slice(2, 4), orientation);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", buildArrowPath(from, to));
    path.setAttribute("class", `annot-arrow annot-${kind}`);
    overlay.appendChild(path);
  };
  // Branch hints sit under the user/engine arrows so an explicit annotation always
  // wins; the picked fork option is drawn stronger than its siblings.
  (branchArrows || []).forEach(
    (arrow) =>
      arrow &&
      arrow.length >= 4 &&
      drawArrow(arrow, arrow === branchPick ? "branch is-pick" : "branch")
  );
  arrows.forEach((arrow) => drawArrow(arrow, "user"));
  if (engineArrow && engineArrow.length >= 4) drawArrow(engineArrow, "engine");
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
  setStatus(statusMessage);
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
      localDateString,
      goToSmartTraining,
      editRepertoire,
      openRepertoireContextMenu,
      createRepertoirePrompt,
      hydrateBuild,
      showInputModal,
      promptImportRepertoireFromPgn,
    });
    dashboardView.bind();
  }
  return dashboardView;
}

async function loadDashboard() {
  try {
    const view = await ensureDashboardView();
    await view.loadDashboard();
  } catch (error) {
    setStatus(error.message);
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
      { name: "color", label: "Your color (white / black)", default: "white" },
    ],
  });
  if (!meta) return null;
  const name = (meta.name || "").trim() || "Imported";
  const color = (meta.color || "white").trim().toLowerCase() === "black" ? "black" : "white";
  try {
    const payload = await importRepertoireFromPgnText(pgnText, { name, color });
    if (switchToBuild) switchView("build");
    setStatus(
      switchToBuild
        ? `Repertoire “${payload.name}” created — edit it in Build`
        : `Imported ${payload.name}`,
    );
    return payload;
  } catch (error) {
    setStatus(error.message);
    throw error;
  }
}

function setLichessUsername(username) {
  const cleaned = (username || "").trim();
  appState.lichessUsername = cleaned || null;
  if (cleaned) {
    try {
      localStorage.setItem(LICHESS_KEY, cleaned);
    } catch (_) { /* ignore */ }
  } else {
    try {
      localStorage.removeItem(LICHESS_KEY);
    } catch (_) { /* ignore */ }
  }
  renderAccountChip();
  syncReplayControls();
  // The player's own strength feeds Maia's AUTO rating; resolve it (cached) whenever
  // the linked account changes. Fire-and-forget — AUTO falls back until it lands.
  refreshAutoMaiaRating();
}

// The single user-name button in the topbar. The app is pure Lichess-OAuth, so there's
// no meaningful difference between "sign out of PrepForge" and "disconnect Lichess" — both
// live behind this one button as a single Sign out action. A guest instead sees a plain
// "Connect Lichess" action that goes straight to OAuth.
function renderAccountChip() {
  const chip = document.getElementById("account-chip");
  const label = document.getElementById("account-label");
  if (!chip || !label) return;
  const name = appState.accountUsername || appState.lichessUsername;
  if (appState.signedIn) {
    chip.classList.add("is-connected");
    label.textContent = name || "Account";
    chip.setAttribute("aria-haspopup", "menu");
    chip.title = `Signed in as ${name || "your account"}`;
  } else {
    chip.classList.remove("is-connected");
    label.textContent = "Sign in";
    // A guest chip is a single action, not a menu — drop the popup affordance.
    chip.removeAttribute("aria-haspopup");
    chip.setAttribute("aria-expanded", "false");
    chip.title = "Sign in to PrepForge";
  }
}

// Which sign-in methods the server offers (Google when configured; email/password
// always). Fetched once; drives which buttons the auth modal shows.
async function refreshAuthProviders() {
  try {
    appState.authProviders = await api("/api/auth/providers");
  } catch (_) {
    appState.authProviders = { google: false, password: true };
  }
}

// The sign-in / create-account modal. Google (when configured) is the primary path;
// email/password is the always-available fallback.
function openAuthModal(mode = "login") {
  const existing = document.querySelector(".modal-overlay.auth-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay auth-overlay";
  const providers = appState.authProviders || { google: false, password: true };
  const render = (currentMode) => {
    const isRegister = currentMode === "register";
    const title = isRegister ? "Create account" : "Sign in";
    const googleBlock = providers.google
      ? `<button class="btn primary auth-google" data-action="google" type="button">Continue with Google</button>
         <div class="auth-divider"><span>or use email</span></div>`
      : "";
    overlay.innerHTML = `
      <div class="modal auth-modal" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="modal-title">${title}</div>
        <div class="modal-body">
          ${googleBlock}
          <label class="modal-field"><span>Email</span>
            <input type="email" data-auth="email" autocomplete="email" /></label>
          <label class="modal-field"><span>Password</span>
            <input type="password" data-auth="password"
              autocomplete="${isRegister ? "new-password" : "current-password"}" /></label>
          <p class="auth-error" data-auth="error" role="alert" hidden></p>
        </div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="toggle" type="button">${
            isRegister ? "Have an account? Sign in" : "New here? Create account"
          }</button>
          <button class="btn primary" data-action="submit" type="button">${
            isRegister ? "Create account" : "Sign in"
          }</button>
        </div>
      </div>`;
    overlay.dataset.mode = currentMode;
    const emailInput = overlay.querySelector('[data-auth="email"]');
    if (emailInput) emailInput.focus();
  };
  render(mode);
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const showError = (msg) => {
    const el = overlay.querySelector('[data-auth="error"]');
    if (el) {
      el.textContent = msg;
      el.hidden = !msg;
    }
  };
  const submit = async () => {
    const currentMode = overlay.dataset.mode;
    const email = overlay.querySelector('[data-auth="email"]').value.trim();
    const password = overlay.querySelector('[data-auth="password"]').value;
    if (!email || !password) {
      showError("Enter your email and password.");
      return;
    }
    if (currentMode === "register" && password.length < 8) {
      showError("Password must be at least 8 characters.");
      return;
    }
    showError("");
    const submitBtn = overlay.querySelector('[data-action="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const endpoint = currentMode === "register" ? "/api/auth/register" : "/api/auth/login";
      await postJson(endpoint, { email, password });
      close();
      // A fresh session changes every owner-scoped view — reload for a clean slate.
      window.location.reload();
    } catch (error) {
      showError(error.message || "Sign-in failed.");
      if (submitBtn) submitBtn.disabled = false;
    }
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (event.target === overlay) {
      close();
    } else if (action === "google") {
      window.location.assign("/api/auth/google/login");
    } else if (action === "toggle") {
      render(overlay.dataset.mode === "register" ? "login" : "register");
    } else if (action === "submit") {
      submit();
    }
  });
}

// Guest → the chip is a single Connect action (straight to OAuth). Signed in → the
// chip toggles the account menu.
function onAccountChipClick() {
  if (!appState.signedIn) {
    openAuthModal("login");
    return;
  }
  toggleAccountMenu();
}

function openAccountMenu() {
  const chip = document.getElementById("account-chip");
  const menu = document.getElementById("account-menu");
  if (!chip || !menu) return;
  const name = appState.accountUsername || appState.lichessUsername || "your account";
  // Signed in: offer the Lichess link as a secondary connection. Show the linked
  // username when present, otherwise a "Connect Lichess" action.
  const lichessItem = appState.lichessUsername
    ? `<div class="context-section">Lichess: ${escapeHtml(appState.lichessUsername)}</div>`
    : `<button type="button" role="menuitem" data-action="connect-lichess">Connect Lichess</button>`;
  const items = [
    `<div class="context-section">Signed in as ${escapeHtml(name)}</div>`,
    lichessItem,
    `<button type="button" role="menuitem" data-action="signout">Sign out</button>`,
  ];
  menu.innerHTML = items.join("");
  menu.hidden = false;
  chip.setAttribute("aria-expanded", "true");
  // Drop the menu under the chip, right-aligned to it and clamped to the viewport.
  const cr = chip.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(cr.right - rect.width, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(cr.bottom + 6, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => handleAccountMenuAction(button.dataset.action));
  });
}

function closeAccountMenu() {
  const menu = document.getElementById("account-menu");
  if (menu) menu.hidden = true;
  const chip = document.getElementById("account-chip");
  if (chip) chip.setAttribute("aria-expanded", "false");
}

function toggleAccountMenu() {
  const menu = document.getElementById("account-menu");
  if (menu && !menu.hidden) closeAccountMenu();
  else openAccountMenu();
}

async function handleAccountMenuAction(action) {
  closeAccountMenu();
  if (action === "signout") {
    await signOut();
  } else if (action === "connect-lichess") {
    startLichessOAuth();
  }
}

// Ask the server whether this browser's session is a real account or a guest, and
// capture the account's stable username for the user-name button.
async function refreshAuthStatus() {
  try {
    const status = await api("/api/auth/status");
    appState.signedIn = !!status.signed_in;
    appState.accountUsername = status.username || null;
    appState.accountUserId = status.user_id || null;
  } catch (_) {
    appState.signedIn = false;
    appState.accountUsername = null;
    appState.accountUserId = null;
  }
  renderAccountChip();
}

// Sign out of PrepForge on this browser: rotate the session to a fresh guest so the
// account's repertoires/games are no longer visible here. The new guest session also
// has no Lichess token, so this is the single "log out" action for the app.
async function signOut() {
  const confirmed = await showConfirmModal({
    title: "Sign out?",
    body:
      "Signs you out on this browser. Your saved repertoires and games stay on your " +
      "account and return when you sign back in with Lichess.",
    okLabel: "Sign out",
    cancelLabel: "Stay signed in",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await postJson("/api/auth/signout", {});
  } catch (_) {
    // The session was NOT rotated server-side; reloading would drop the user right
    // back into the same account while flashing "Signed out". Stay put and report.
    setStatus("Sign out failed — you are still signed in. Try again.");
    return;
  }
  try {
    localStorage.removeItem(LICHESS_KEY);
  } catch (_) {
    /* ignore */
  }
  setStatus("Signed out");
  // Reload so every view reflects the fresh guest session cleanly.
  window.location.reload();
}

function syncReplayControls() {
  const chip = document.getElementById("replay-account");
  if (chip) {
    chip.textContent = appState.lichessUsername || "not connected";
    chip.classList.toggle("is-connected", !!appState.lichessUsername);
  }
  const btn = document.getElementById("lichess-compare-btn");
  if (btn) btn.disabled = !appState.lichessUsername;
}

// Drop the Lichess OAuth token. This is NOT a sign-out: the browser stays bound to
// Pull the server's stored connection state (the source of truth with OAuth).
async function refreshLichessStatus() {
  try {
    const status = await api("/api/lichess/status");
    setLichessUsername(status.connected ? status.username : "");
    if (status.connected) startLichessGameWatch();
  } catch (_) {
    renderAccountChip();
  }
}

// Open Lichess sign-in in a popup; the callback page postMessages back, and we
// also poll status as a fallback if the message is blocked.
function startLichessOAuth() {
  const w = 520;
  const h = 660;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const popup = window.open(
    "/oauth/login",
    "lichess-oauth",
    `width=${w},height=${h},left=${left},top=${top}`
  );
  setStatus("Opening Lichess sign-in...");
  const onMessage = (event) => {
    if (!event.data || event.data.type !== "lichess-oauth") return;
    window.removeEventListener("message", onMessage);
    if (event.data.ok) {
      refreshLichessStatus();
      // Login rebinds the session to the account profile → now signed in.
      refreshAuthStatus();
      setStatus(`Lichess: ${event.data.detail}`);
    } else {
      setStatus(`Lichess sign-in failed: ${event.data.detail}`);
    }
  };
  window.addEventListener("message", onMessage);
  let tries = 0;
  const poll = window.setInterval(async () => {
    tries += 1;
    try {
      const status = await api("/api/lichess/status");
      if (status.connected) {
        window.clearInterval(poll);
        window.removeEventListener("message", onMessage);
        setLichessUsername(status.username);
        refreshAuthStatus();
        startLichessGameWatch();
        setStatus(`Lichess: ${status.username}`);
        return;
      }
    } catch (_) {
      /* ignore */
    }
    if (tries > 120 || (popup && popup.closed)) window.clearInterval(poll);
  }, 1500);
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

// "My game" button: pull the latest Lichess game straight into the PGN box.
async function fetchMyLichessGame() {
  if (!appState.lichessUsername) {
    setStatus("Connect a Lichess account first");
    startLichessOAuth();
    return;
  }
  setStatus("Fetching your latest game...");
  let latest;
  try {
    latest = await api("/api/lichess/latest");
  } catch (error) {
    setStatus(error.message);
    return;
  }
  if (!latest.has_game) {
    setStatus("No recent games found");
    return;
  }
  document.getElementById("pgn-input").value = latest.pgn || "";
  const drawer = document.querySelector("#view-analyze .drawer");
  if (drawer) drawer.open = true;
  if (latest.lichess_id) markLichessSeen(latest.lichess_id);
  setStatus(`Loaded ${latest.white || "?"} vs ${latest.black || "?"} - press Analyze`);
}

// Analyze "History": list previously analyzed games; click to recall a saved
// report without re-running the engine.
async function loadAnalysisHistory() {
  const host = document.getElementById("analysis-history");
  if (!host) return;
  host.innerHTML = '<div class="muted hint">Loading...</div>';
  let payload;
  try {
    payload = await api("/api/analyses");
  } catch (error) {
    host.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!payload.analyses || !payload.analyses.length) {
    host.innerHTML = '<div class="muted hint">No saved analyses yet.</div>';
    return;
  }
  host.innerHTML = payload.analyses
    .map((a) => {
      const when = (a.analyzed_at || "").slice(0, 10);
      return (
        `<button class="history-item" data-game-id="${escapeHtml(a.game_id)}">` +
        `<span class="hi-players">${escapeHtml(a.white || "?")} vs ${escapeHtml(a.black || "?")}</span>` +
        `<span class="hi-meta">${escapeHtml(a.result || "")} · ${escapeHtml(when)}</span>` +
        `</button>`
      );
    })
    .join("");
  host.querySelectorAll(".history-item").forEach((btn) => {
    btn.addEventListener("click", () => recallAnalysis(btn.dataset.gameId));
  });
}

async function recallAnalysis(gameId) {
  setStatus("Loading saved analysis...");
  appState.analysisSourcePgn = null;
  hideAnalysisHandoff();
  try {
    const payload = await api(`/api/analyses/${encodeURIComponent(gameId)}`);
    appState.analysis = payload;
    resetAnalysisVariations();
    showAnalysisPly(0);
    await renderAnalysis(payload);
    revealAnalysisResults();
    setStatus(`Recalled analysis: ${payload.moves.length} plies`);
  } catch (error) {
    setStatus(error.message);
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

async function openTeamDetail(teamId) {
  appState.selectedTeamId = teamId;
  renderTeamsList(); // reflect the selected row
  const card = document.getElementById("team-detail-card");
  const membersEl = document.getElementById("team-members");
  const foot = document.getElementById("team-detail-foot");
  if (!card || !membersEl) return;
  card.hidden = false;
  membersEl.innerHTML = '<div class="empty-state">Loading…</div>';
  if (foot) foot.innerHTML = "";
  let detail;
  try {
    detail = await api(`/api/teams/${encodeURIComponent(teamId)}`);
  } catch (error) {
    membersEl.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const myRole = detail.role;
  const canManage = myRole === "owner" || myRole === "admin";
  document.getElementById("team-detail-name").textContent = detail.name;
  const roleBadge = document.getElementById("team-detail-role");
  if (roleBadge) roleBadge.textContent = teamRoleLabel(myRole);
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
  membersEl.innerHTML = members
    .map((m) => {
      const name = escapeHtml(m.display_name || m.email);
      const sub = m.display_name ? ` <span class="sub">· ${escapeHtml(m.email)}</span>` : "";
      const isMe = m.user_id === appState.accountUserId;
      const isOwner = m.role === "owner";
      const uid = escapeHtml(m.user_id);
      const uname = escapeHtml(m.display_name || m.email);
      // Owner row is fixed. Managers get an inline role control on every other row
      // (incl. their own, so an admin can step down) plus remove; a plain member only
      // sees a read-only badge and a Leave button on their own row. The server
      // enforces all of this too.
      let tail;
      if (isOwner) {
        tail = `<span class="team-role-badge sm">${escapeHtml(teamRoleLabel("owner"))}</span>`;
      } else if (canManage) {
        const opts = ["member", "admin"]
          .map(
            (r) =>
              `<option value="${r}"${m.role === r ? " selected" : ""}>${escapeHtml(teamRoleLabel(r))}</option>`
          )
          .join("");
        const removeBtn = `<button type="button" class="ib team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="${isMe ? "1" : "0"}" title="${isMe ? "Leave team" : "Remove member"}">${isMe ? "Leave" : "×"}</button>`;
        tail = `<select class="team-role-select" data-user-id="${uid}" aria-label="Role for ${uname}">${opts}</select>${removeBtn}`;
      } else {
        const leaveBtn = isMe
          ? `<button type="button" class="ib team-remove" data-user-id="${uid}" data-user-name="${uname}" data-self="1" title="Leave team">Leave</button>`
          : "";
        tail = `<span class="team-role-badge sm">${escapeHtml(teamRoleLabel(m.role))}</span>${leaveBtn}`;
      }
      return `
        <div class="list-item team-member-row">
          <span><span class="name">${name}${isMe ? ' <span class="sub">(you)</span>' : ""}</span>${sub}</span>
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
    setStatus(error.message);
  }
}

async function createTeam() {
  if (!appState.signedIn) {
    openAuthModal("login");
    return;
  }
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
    setStatus(`Created team "${name}"`);
    await loadTeams();
  } catch (error) {
    setStatus(error.message);
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
    setStatus(error.message);
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
    setStatus(error.message);
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
    setStatus(error.message);
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
    setStatus(error.message);
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
    if (isSelf) hideTeamDetail();
    await loadTeams();
  } catch (error) {
    setStatus(error.message);
  }
}

// The team's shareable join link. The raw code is returned ONLY at mint time (it's
// hashed at rest), so opening this rotates the link and shows the fresh one; any
// previously shared link stops working.
async function teamInvite(teamId) {
  let payload;
  try {
    payload = await postJson(`/api/teams/${encodeURIComponent(teamId)}/invite`, {});
  } catch (error) {
    setStatus(error.message);
    return;
  }
  const url = `${window.location.origin}${payload.url}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus("Invite link copied");
  } catch (_) {
    /* clipboard blocked — the modal still shows the link to copy by hand */
  }
  const choice = await showInviteModal({ url });
  if (choice === "revoke") {
    try {
      await api(`/api/teams/${encodeURIComponent(teamId)}/invite`, { method: "DELETE" });
      setStatus("Invite link revoked");
    } catch (error) {
      setStatus(error.message);
    }
  }
  await openTeamDetail(teamId);
}

function showInviteModal({ url }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">Team invite link</div>
        <div class="modal-body">
          <p class="modal-note muted">Anyone signed in who opens this link joins the team as a member. For security it's shown only once and replaces any previous link — copy it now. Revoke to disable joining by link.</p>
          <label class="modal-field">
            <span>Invite link</span>
            <input type="text" value="${escapeHtml(url)}" data-invite-url readonly />
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn danger" data-action="revoke" type="button">Revoke</button>
          <button class="btn ghost" data-action="copy" type="button">Copy</button>
          <button class="btn primary" data-action="done" type="button">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector("[data-invite-url]");
    if (input) {
      input.focus();
      if (input.select) input.select();
    }
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
        close(null);
      }
    };
    document.addEventListener("keydown", onKey);
    overlay.querySelector('[data-action="copy"]').addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        setStatus("Invite link copied");
      } catch (_) {
        if (input) {
          input.focus();
          if (input.select) input.select();
        }
      }
    });
    overlay.querySelector('[data-action="revoke"]').addEventListener("click", () => close("revoke"));
    overlay.querySelector('[data-action="done"]').addEventListener("click", () => close("done"));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
  });
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
    setStatus(error.message);
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
    setStatus(error.message);
  }
}

// Copy a team-shared repertoire the caller doesn't own into their own account.
async function copySharedRepertoire(repertoireId) {
  try {
    const result = await postJson("/api/repertoires/fork", { repertoire_id: repertoireId });
    setStatus(`Copied "${result.name}" to your repertoires`);
    await refreshDashboardRepertoires();
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadSharedRepertoires() {
  const container = document.getElementById("teams-shared");
  if (!container) return;
  try {
    const payload = await api("/api/repertoires");
    const shared = payload.shared || [];
    if (!shared.length) {
      container.innerHTML = '<div class="empty-state">Nothing shared with you yet.</div>';
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
          <div class="list-item shared-rep-row" role="button" tabindex="0" data-repertoire-id="${id}">
            <span>
              <span class="color-dot ${color}"></span>
              <span class="name">${name}</span>
              <span class="sub"> · ${via}</span>
            </span>
            <span class="team-member-tail">
              <span class="team-role-badge sm">read-only</span>
              <button type="button" class="ib team-copy" data-rep-id="${id}" title="Copy to my account">Copy</button>
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
    setStatus(error.message);
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

function showInputModal({ title, fields, okLabel = "OK" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const inputsHtml = fields
      .map((field) => {
        const safeName = escapeHtml(field.name);
        const safeLabel = escapeHtml(field.label || field.name);
        const safeValue = escapeHtml(field.default == null ? "" : String(field.default));
        if (field.type === "note") {
          // Read-only informational line (no input, never collected).
          return `<p class="modal-note muted">${safeLabel}</p>`;
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
        return `
          <label class="modal-field">
            <span>${safeLabel}</span>
            <input name="${safeName}" type="${inputType}" value="${safeValue}"${numericAttrs} data-field />
          </label>
        `;
      })
      .join("");
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-body">${inputsHtml}</div>
        <div class="modal-footer">
          <button class="btn ghost" data-action="cancel" type="button">Cancel</button>
          <button class="btn primary" data-action="ok" type="button">${escapeHtml(okLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
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
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    overlay.querySelector('[data-action="ok"]').addEventListener("click", () => close(collect()));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
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

async function editRepertoire(repertoireId, nodeId = null) {
  // Switching repertoires replaces the local Build tree — flush pending moves of
  // the current one first so they aren't dropped. An optional `nodeId` opens the
  // builder at that position (Analyze's "Open in Build" deep link).
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  appState.sharedToken = null;
  setStatus("Loading repertoire");
  try {
    const payload = await api(
      `/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`
    );
    const target = nodeId && payload.nodes.some((n) => n.id === nodeId) ? nodeId : null;
    await hydrateBuild(payload, target || payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    switchView("build");
    updateBuildReadOnlyUi(payload);
  } catch (error) {
    setStatus(error.message);
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
  if (banner) banner.remove();
  syncCoverageReadOnlyState();
}

function syncCoverageReadOnlyState() {
  const button = document.getElementById("coverage-run");
  const gapsEl = document.getElementById("coverage-gaps");
  const scoreEl = document.getElementById("coverage-score");
  const drawer = document.getElementById("coverage-drawer");
  const readOnly = isBuildReadOnly();
  if (button) {
    button.disabled = readOnly;
    button.title = readOnly ? "Read-only — copy to your account first" : "";
  }
  if (readOnly) {
    if (coverageController) {
      coverageController.abort();
      coverageController = null;
      jobToast.cancelJob("Scan stopped");
    }
    if (drawer) drawer.open = false;
    if (gapsEl) gapsEl.innerHTML = "";
    if (scoreEl) scoreEl.hidden = true;
    coverageGaps = [];
  }
}

function coverageScanStillValid(scanRepId) {
  return !isBuildReadOnly() && appState.build && appState.build.repertoire_id === scanRepId;
}

async function trainRepertoire(repertoireId) {
  // Training reads the server's repertoire tree — make sure any pending Build edits
  // are persisted before we leave the builder.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  appState.trainingRepertoireId = repertoireId;
  switchView("train");
  await startTraining();
}

function openRepertoireContextMenu(event, repertoireId, isActive) {
  event.preventDefault();
  const menu = document.getElementById("repertoire-context-menu");
  const safeId = escapeHtml(repertoireId);
  const items = [
    ["train", "Start training"],
    ["edit", "Edit in builder"],
    ["rename", "Rename..."],
    ["share-link", "Share link..."],
    ["share-team", "Share with team..."],
    ["toggle-active", isActive ? "Disable" : "Enable"],
    ["delete", "Delete..."],
  ];
  menu.innerHTML = items
    .map(
      ([action, label]) =>
        `<button type="button" data-action="${escapeHtml(action)}" data-repertoire-id="${safeId}">${escapeHtml(label)}</button>`
    )
    .join("");
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () =>
      handleRepertoireContextAction(button.dataset.action, button.dataset.repertoireId, isActive)
    );
  });
}

function closeRepertoireContextMenu() {
  const menu = document.getElementById("repertoire-context-menu");
  if (menu) menu.hidden = true;
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
        fields: [
          {
            name: "url",
            label: "Anyone with this link can view (not edit) the repertoire",
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
                setStatus("Delete failed — repertoire restored");
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
    setStatus(error.message);
  }
}

function prefillDemoPgn() {
  document.getElementById("pgn-input").value = DEMO_PGN;
}

async function loadDemoAndAnalyze() {
  prefillDemoPgn();
  const drawer = document.querySelector("#view-analyze .drawer");
  if (drawer) drawer.open = true;
  await runAnalysis();
}

async function runAnalysis() {
  // Phase 2: whole-game analysis runs in the browser. The server only parses
  // the PGN (/api/analyze/prepare) and classifies + saves the browser-computed
  // evals (/api/analyze/classify-save) — it never runs an engine.
  if (!isBrowserEngineAvailable()) {
    setStatus(BROWSER_ENGINE_UNAVAILABLE);
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
  if (!appState.signedIn) {
    setStatus("Sign in (or create an account) to analyze and save games");
    openAuthModal("login");
    return;
  }
  setStatus("Analyzing PGN");
  hideAnalysisResults();
  const runButton = document.getElementById("run-analysis");
  runButton.disabled = true;

  let cancelled = false;
  const jobId = `browser-analysis-${Date.now()}`;
  try {
    const prep = await postJson("/api/analyze/prepare", { pgn });
    const positions = prep.positions || [];
    if (!positions.length) throw new Error("No positions to analyze");

    jobToast.startJob({
      id: jobId,
      title: "Analyzing game",
      tab: "analyze",
      total: positions.length,
      onCancel: () => {
        cancelled = true;
      },
    });

    const evals = await analyzeGamePositions({
      positions,
      depth: prep.depth,
      multipv: 1,
      onProgress: (done, total) => {
        jobToast.updateJob({
          current: done,
          total,
          phase: "evaluating",
          message: `evaluating ${done}/${total} positions`,
        });
      },
      shouldCancel: () => cancelled,
    });

    // Phase 3d: browser Brilliant detection. Compute Maia assessments for the played
    // moves (best-effort) so the server can flag brilliancies with no server compute.
    // Maia's ~46 MB model downloads once (then cached); progress shows in the toast.
    // Any failure (no weights / inference error) is swallowed → analysis without
    // brilliancies, mirroring the server's no-Maia path.
    let maiaAssessments = [];
    if (
      prep.brilliant &&
      prep.brilliant.enabled &&
      pref("brilliantDetection") &&
      Array.isArray(prep.moves) &&
      prep.moves.length
    ) {
      try {
        const provider = getSharedMaia3Provider();
        provider.setInitProgressHandler(({ phase, loaded, total }) => {
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
              message: "loading Maia model from cache",
            });
          } else if (phase === "verify" || phase === "session") {
            // Cached weights still need an ORT session rebuild (the slow part). Say so, rather
            // than leaving the stale "downloading" message up — that's what made a cached
            // re-init (after an idle teardown) look like a fresh 46 MB download.
            jobToast.updateJob({
              current: 0,
              total: 1,
              phase: "maia-init",
              message: "preparing Maia engine…",
            });
          }
        });
        try {
          const { computeBrilliantAssessments } = await (_coachReady || preloadCoach());
          maiaAssessments = await computeBrilliantAssessments({
            moves: prep.moves,
            evals,
            depth: prep.depth,
            rating: effectiveMaiaRating(),
            provider,
            analyzeFn: analyzeGamePositions,
            shouldCancel: () => cancelled,
            onProgress: (done, total) =>
              jobToast.updateJob({ current: done, total, phase: "brilliancies", message: `checking brilliancies ${done}/${total}` }),
            // The trap_gap second pass (Stockfish over the candidates' natural-move lines) gets
            // its own phase so the bar reflects it instead of sitting frozen at the end of the
            // brilliancies count while the batch runs.
            onTrapProgress: (done, total) =>
              jobToast.updateJob({ current: done, total, phase: "traps", message: `checking traps ${done}/${total}` }),
          });
        } finally {
          provider.setInitProgressHandler(null);
        }
      } catch (brilliantErr) {
        if (brilliantErr && brilliantErr.cancelled) throw brilliantErr;
        // Non-fatal: proceed with no brilliancies (e.g. Maia weights unavailable).
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

    // Past this point we're persisting (classify-save). Like Build Generate's apply phase,
    // the save is not cancellable, so remove the Stop affordance rather than imply a cancel
    // that wouldn't hold.
    jobToast.lockJob();
    jobToast.updateJob({
      current: positions.length,
      total: positions.length,
      phase: "classifying",
      message: "classifying",
    });

    const payload = await postJson("/api/analyze/classify-save", {
      game_id: prep.game_id,
      engine: prep.engine || "stockfish (browser)",
      depth: prep.depth,
      positions: positions.map((fen) => {
        const ev = evals.get(fen) || {};
        return {
          fen,
          score_cp: ev.score_cp ?? null,
          mate_in: ev.mate_in ?? null,
          best_move_uci: ev.best_move_uci ?? null,
          pv: ev.pv || [],
        };
      }),
      maia_assessments: maiaAssessments,
    });

    appState.analysis = payload;
    resetAnalysisVariations();
    showAnalysisPly(0);
    await renderAnalysis(payload);
    setStatus(`Analysis ready: ${payload.moves.length} plies`);
    jobToast.completeJob({
      title: "Analysis ready",
      message: `${payload.moves.length} plies classified`,
      onClick: () => switchView("analyze"),
    });
    appState.analysisSourcePgn = pgn;
    revealAnalysisResults();
    await updateAnalysisHandoff();
  } catch (error) {
    if (error && error.cancelled) {
      appState.analysisSourcePgn = null;
      hideAnalysisHandoff();
      setStatus("Analysis stopped");
      jobToast.cancelJob(error.message || "Analysis stopped");
    } else if (error && error.status === 401) {
      setStatus("Sign in (or create an account) to analyze and save games");
      openAuthModal("login");
      jobToast.failJob("Sign in required");
    } else {
      setStatus(error.message);
      jobToast.failJob(error.message);
    }
  } finally {
    runButton.disabled = false;
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
      { name: "color", label: "Your color (white / black)", default: "white" },
    ],
  });
  if (!meta) return;
  const name = (meta.name || "").trim() || "Imported game";
  const color = (meta.color || "white").trim().toLowerCase() === "black" ? "black" : "white";
  if (btn) btn.disabled = true;
  try {
    const payload = await importRepertoireFromPgnText(pgn, { name, color });
    switchView("build");
    setStatus(`Repertoire “${payload.name}” created — edit it in Build`);
    appState.analysisSourcePgn = null;
    hideAnalysisHandoff();
  } catch (error) {
    setStatus(error.message || "Could not create repertoire — try again");
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
}

function revealAnalysisResults() {
  const panel = document.getElementById("analysis-results");
  if (!panel) return;
  panel.hidden = false;
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

async function renderAnalysis(payload) {
  return (await ensureAnalyzeView()).renderAnalysis(payload);
}

// Inline badge symbols so move badges render correctly before analyze.js loads.
const ANALYSIS_CLASS_GROUP_OF = {
  brilliant: "brilliant",
  best: "good",
  excellent: "good",
  good: "good",
  book: "good",
  inaccuracy: "inaccuracy",
  mistake: "mistake",
  blunder: "blunder",
  missed_win: "missed",
  missed_tactic: "missed",
};
function classBadgeSymbol(classification) {
  if (analyzeView) return analyzeView.classBadgeSymbol(classification);
  const group = ANALYSIS_CLASS_GROUP_OF[String(classification || "").toLowerCase()];
  return (
    {
      brilliant: "!!",
      good: "+",
      inaccuracy: "?!",
      mistake: "?",
      blunder: "!",
      missed: "x",
    }[group] || "."
  );
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
    '<div class="empty-state">Play moves on the board to branch into study lines, ' +
    "or load a PGN and click Analyze for a full review.</div>";
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
  const moves = appState.analysis ? appState.analysis.moves : [];
  const boundedPly = Math.max(0, Math.min(ply, moves.length));
  appState.analysisPly = boundedPly;
  appState.analysisCurrentNodeId = boundedPly === 0 ? "root" : `m${boundedPly}`;
  const move = boundedPly > 0 ? moves[boundedPly - 1] : null;
  const fen = move ? move.fen_after : moves[0]?.fen_before || START_FEN;
  const info = await boardInfo(fen);
  appState.analysisBoardFen = fen;
  boards.analysis.setPosition({
    fen,
    legalMoves: info.legal_moves,
    lastMove: move ? move.uci : null,
  });
  boards.analysis.setMoveBadge(
    move ? move.uci.slice(2, 4) : null,
    move ? move.classification : null,
    move ? classBadgeSymbol(move.classification) : ""
  );
  document.getElementById("analysis-board-label").textContent = move
    ? `${move.move_number}${move.side === "black" ? "..." : "."} ${move.san}`
    : "Initial position";
  highlightCurrentMove();
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

// Highlight the active move + sync the eval-chart cursor. The list itself is
// re-rendered from appState.analysisCurrentNodeId so highlighting and variation
// structure can never drift apart.
function highlightCurrentMove() {
  renderAnalysisTree();
  updateEvalChartCursor();
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
  document.getElementById("analysis-board-label").textContent = `${node.moveNumber}${
    node.side === "black" ? "..." : "."
  } ${node.san} · variation`;
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
    document.getElementById("analysis-board-label").textContent = `${moveNumber}${
      side === "black" ? "..." : "."
    } ${payload.move.san} · variation`;
    highlightCurrentMove();
    refreshAnalysisExplain({
      fen: payload.board.fen,
      lastUci: moveUci,
      lastSan: payload.move.san,
      prevFen: fen,
    });
    if (engineWidget) engineWidget.onBoardChanged();
  } catch (error) {
    setStatus(error.message);
  }
}

function bindEvalChart() {
  const chart = document.getElementById("eval-chart");
  chart.addEventListener("click", (event) => {
    const points = appState.evalChartPoints || [];
    if (!points.length) return;
    const rect = chart.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (points.length - 1));
    showAnalysisPly(points[idx].ply);
  });
  window.addEventListener("resize", rescaleEvalMarkers);
}

async function hydrateBuild(payload, selectedNodeId = null) {
  // Opening/switching to a DIFFERENT repertoire drops any local-first sync state
  // from the previous one (callers hard-flush before switching, so nothing is
  // lost). A reconcile re-hydrate keeps the same id, so its pending queue + id map
  // survive — that's the load-bearing distinction for the in-flight-move case.
  const prevRepId = appState.build && appState.build.repertoire_id;
  if (payload.repertoire_id !== prevRepId) {
    clearTimeout(appState.buildFlushTimer);
    appState.buildFlushTimer = null;
    appState.buildPending = [];
    appState.buildPendingDeletes = [];
    // Stale undo windows from the old repertoire become no-ops (their commit
    // guards on repertoire id), but their ids must not prune the new tree.
    appState.buildUndoDeletes = new Set();
    appState.buildUndoCommitByMove = new Map();
    appState.buildIdMap = {};
    appState.buildSyncState = "saved";
    appState.buildSyncRetry = 0;
  }
  appState.build = payload;
  appState.buildNodeById = new Map(payload.nodes.map((node) => [node.id, node]));
  // Any (re)hydrate means the repertoire may have changed — drop Analyze's book copy.
  invalidateBook();
  if (boards.build) boards.build.setOrientation(payload.color === "black" ? "black" : "white");
  renderBuildRepHeader();
  const nextNodeId = selectedNodeId || payload.selected_node_id || payload.nodes[0]?.id;
  await selectBuildNode(nextNodeId);
  renderBuildSync();
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
    });
  }
  return buildView;
}

// The sidebar's repertoire identity line: which repertoire is open and for which
// colour. The ⋯ button next to it carries the repertoire-scoped actions.
function renderBuildRepHeader() {
  const nameEl = document.getElementById("build-rep-name");
  if (!nameEl) return;
  if (!appState.build) {
    nameEl.textContent = "No repertoire open";
    return;
  }
  if (buildView) return buildView.renderBuildRepHeader();
  void ensureBuildView().then((view) => view.renderBuildRepHeader()).catch(() => {});
}

// The ⋯ menu in the Build sidebar header: every repertoire-scoped action in one
// place (the board bar keeps only position navigation, the tools row only
// position-scoped work). Reuses the shared context-menu element.
function openBuildMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  const menu = document.getElementById("repertoire-context-menu");
  if (!menu) return;
  const hasRep = !!appState.build && !isBuildReadOnly();
  const items = [
    ...(hasRep
      ? [
          ["build-rename", "Rename..."],
          ["build-export-pgn", "Export PGN"],
        ]
      : []),
    ["build-new-rep", "New repertoire..."],
  ];
  menu.innerHTML = items
    .map(
      ([action, label]) =>
        `<button type="button" data-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`
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
    setStatus(error.message);
  }
}

async function skipTrainingLine() {
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
    setStatus(error.message);
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
      ? `${appState.build.name} - ${appState.build.color}`
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
  const drawer = document.getElementById("explorer-drawer");
  return !!(drawer && drawer.open);
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
    return;
  }
  renderExplorerScope();
  const seq = ++explorerSeq;
  try {
    if (!explorerModule) {
      rows.innerHTML = '<div class="muted hint">Loading explorer…</div>';
      explorerModule = await import("./explorer.js");
      explorerClient = explorerModule.createExplorerClient({});
      renderExplorerScope(); // now that ratingBucketsFor is available, show the pool
    }
    const stats = await explorerClient.fetchStats(explorerDb, fen, {
      rating: effectiveMaiaRating(),
    });
    if (seq !== explorerSeq || !explorerDrawerOpen()) return; // superseded
    renderExplorerRows(stats);
  } catch (error) {
    if (seq !== explorerSeq) return;
    if (explorerModule && error instanceof explorerModule.ExplorerRateLimited) {
      const secs = Math.max(1, Math.ceil(error.retryInMs / 1000));
      rows.innerHTML = `<div class="muted hint">Lichess asks for a short pause - try again in ~${secs}s.</div>`;
    } else {
      rows.innerHTML = `<div class="muted hint">Explorer unavailable: ${escapeHtml(error.message)}</div>`;
    }
  }
}

// Small readout under the DB tabs: make it obvious that Masters ignores rating while
// Players is pooled near the player's strength (shared with the Maia model strength).
function renderExplorerScope() {
  const el = document.getElementById("explorer-scope");
  if (!el) return;
  if (explorerDb !== "lichess") {
    el.textContent = "Master games — strong-player games, not filtered by rating.";
    return;
  }
  const rating = effectiveMaiaRating();
  const buckets =
    explorerModule && typeof explorerModule.ratingBucketsFor === "function"
      ? explorerModule.ratingBucketsFor(rating)
      : null;
  el.textContent =
    buckets && buckets.length
      ? `Players near ~${rating} (rating pool ${buckets.join(", ")}).`
      : `Players near ~${rating}.`;
}

function renderExplorerRows(stats) {
  const rows = document.getElementById("explorer-rows");
  if (!rows) return;
  const openingEl = document.getElementById("explorer-opening");
  if (openingEl) openingEl.textContent = stats.opening || "";
  if (!stats.moves.length) {
    rows.innerHTML = '<div class="muted hint">No games reached this position - true novelty territory.</div>';
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
  rows.innerHTML = stats.moves
    .map(
      (m) => `
    <button type="button" class="explorer-row" data-uci="${escapeHtml(m.uci)}" title="Add ${escapeHtml(m.san)} to the repertoire">
      <span class="explorer-san">${escapeHtml(m.san)}${inRep.has(m.uci) ? '<span class="explorer-inrep" title="In your repertoire">&#9679;</span>' : ""}</span>
      <span class="explorer-games">${explorerModule.formatGames(m.total)}</span>
      <span class="explorer-bar" aria-label="White ${m.whitePct}% / draw ${m.drawPct}% / Black ${m.blackPct}%">
        <span class="explorer-bar-w" style="width:${m.whitePct}%"></span><span class="explorer-bar-d" style="width:${m.drawPct}%"></span><span class="explorer-bar-b" style="width:${m.blackPct}%"></span>
      </span>
    </button>`,
    )
    .join("");
  rows.querySelectorAll(".explorer-row").forEach((btn) => {
    btn.addEventListener("click", () => onBuildBoardMove(btn.dataset.uci));
  });
}

function renderBuilderTreeEmptyState() {
  const container = document.getElementById("builder-tree");
  const branchBar = document.getElementById("build-branchbar");
  if (!container) return;
  container.innerHTML =
    '<div class="empty-state">No repertoire open. Play a move on the board to start one, ' +
    'use the <b>⋯</b> menu above, or open one from the Dashboard.</div>';
  if (branchBar) branchBar.hidden = true;
  if (boards.build) boards.build.setBranchArrows([]);
}

function renderBuilderTree() {
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
  if (activeViewName() !== "build") return;
  if (isBuildReadOnly()) return;
  if (!appState.build || !appState.buildCurrentNodeId) return;
  // The annotation POST keys off a real node id — drain any pending local moves so
  // a freshly-played (tmp) node has been reconciled first.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  const nodeId = resolveBuildId(appState.buildCurrentNodeId);
  const node = appState.buildNodeById.get(nodeId);
  if (node) {
    node.arrows = arrows.slice();
    node.circles = circles.slice();
  }
  try {
    await postJson("/api/build/annotations", {
      repertoire_id: appState.build.repertoire_id,
      node_id: nodeId,
      arrows,
      circles,
    });
  } catch (error) {
    setStatus(error.message);
  }
}

// ===== Local-first Build sync ================================================
// docs/local-first-sync-plan.md Phase 1. A played move mutates the local tree
// immediately and is queued; a debounced batch flush reconciles with the server,
// which owns id assignment + flag recomputation. The client never waits on the
// network to render a move (降延遲) and writes are batched (降消耗).

const BUILD_FLUSH_IDLE_MS = 2000;
const BUILD_FLUSH_MAX_BACKOFF_MS = 30000;

function mintBuildTmpId() {
  return `tmp-${++appState.buildTmpCounter}`;
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
function resolveBuildId(id) {
  return (id && appState.buildIdMap[id]) || id;
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

const SYNC_CHIP_VARIANTS = {
  saved: { cls: "is-saved", text: "✓ Saved" },
  dirty: { cls: "is-dirty", text: "• Unsaved changes" },
  syncing: { cls: "is-syncing", text: "↻ Saving…" },
  error: { cls: "is-error", text: "⚠ Offline — will retry" },
};

function renderSyncChip(el, state) {
  const v = SYNC_CHIP_VARIANTS[state] || SYNC_CHIP_VARIANTS.saved;
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
  return (await ensureTrainView()).renderTraining(prompt);
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
  if (!appState.build || (!appState.buildPending.length && !appState.buildPendingDeletes.length))
    return Promise.resolve(true);
  clearTimeout(appState.buildFlushTimer);
  appState.buildFlushTimer = null;

  // Snapshot the in-flight batches; moves made DURING the round-trip accumulate
  // in fresh queues and must survive the reconcile (§1.4 — the load-bearing bit).
  const batch = appState.buildPending;
  appState.buildPending = [];
  const deleteBatch = appState.buildPendingDeletes;
  appState.buildPendingDeletes = [];
  const repertoireId = appState.build.repertoire_id;
  setBuildSync("syncing");

  appState.buildFlushing = (async () => {
    try {
      // Deletes go FIRST: replaying a just-deleted move must create a fresh
      // node, not dedupe against the dying server one. A still-tmp id means the
      // node never reached the server (its pending add was cancelled) — drop it.
      const deleteIds = [
        ...new Set(deleteBatch.map(resolveBuildId).filter((id) => !String(id).startsWith("tmp-"))),
      ];
      let payload = null;
      if (deleteIds.length) {
        payload = await postJson("/api/build/delete-nodes", {
          repertoire_id: repertoireId,
          node_ids: deleteIds,
        });
      }
      if (batch.length) {
        // The add response supersedes the delete payload (it's newer truth).
        payload = await postJson("/api/build/add-moves", {
          repertoire_id: repertoireId,
          moves: batch.map((m) => ({ tempId: m.tempId, parentRef: m.parentRef, uci: m.uci })),
        });
      }
      // Both batches can drain to nothing (e.g. deletes of never-flushed tmp
      // nodes): nothing reached the server, so there's nothing to reconcile.
      if (!payload) {
        appState.buildSyncRetry = 0;
        if (appState.buildPending.length || appState.buildPendingDeletes.length) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          setBuildSync("saved");
        }
        return true;
      }
      const idMap = payload.id_map || {};
      Object.assign(appState.buildIdMap, idMap);

      // Translate the current selection + branch pick through tmp -> real.
      const prevSelection = appState.buildCurrentNodeId;
      const translatedSelection = idMap[prevSelection] || prevSelection;
      const branchPick = appState.buildBranchChoiceId
        ? idMap[appState.buildBranchChoiceId] || appState.buildBranchChoiceId
        : null;

      // Re-point still-pending nodes whose parentRef was a tmp from THIS batch.
      const stillPending = appState.buildPending;
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
      if (appState.buildPending.length || appState.buildPendingDeletes.length) {
        setBuildSync("dirty");
        scheduleBuildFlush();
      } else {
        setBuildSync("saved");
      }
      return true;
    } catch (error) {
      const status = error && error.status;
      if (status && status >= 400 && status < 500) {
        // Validation 4xx shouldn't happen for legal moves, but defend: drop the bad
        // batches and re-hydrate from server truth so the local tree can't drift.
        setStatus(error.message);
        try {
          const fresh = await api(
            `/api/build/load?repertoire_id=${encodeURIComponent(repertoireId)}`
          );
          await hydrateBuild(fresh, fresh.selected_node_id);
          reapplyPendingBuildDeletes();
        } catch (_) {
          /* best-effort resync */
        }
        if (appState.buildPending.length || appState.buildPendingDeletes.length) {
          setBuildSync("dirty");
          scheduleBuildFlush();
        } else {
          setBuildSync("saved");
        }
        return false;
      }
      // Network / 5xx: requeue the in-flight batches ahead of any newer ops and
      // back off exponentially. The next played move also re-arms a flush.
      // Adds whose node was deleted locally while the batch was in flight stay
      // dropped — recreating them server-side would resurrect a deleted branch.
      appState.buildPending = batch
        .filter((m) => appState.buildNodeById.has(m.tempId))
        .concat(appState.buildPending);
      appState.buildPendingDeletes = deleteBatch.concat(appState.buildPendingDeletes);
      appState.buildSyncRetry = Math.min(appState.buildSyncRetry + 1, 6);
      setBuildSync("error");
      const delay = Math.min(
        BUILD_FLUSH_MAX_BACKOFF_MS,
        1000 * 2 ** (appState.buildSyncRetry - 1)
      );
      appState.buildFlushTimer = setTimeout(() => {
        appState.buildFlushTimer = null;
        flushBuildMoves();
      }, delay);
      return false;
    } finally {
      appState.buildFlushing = null;
    }
  })();
  return appState.buildFlushing;
}

// Re-insert still-pending provisional nodes onto the freshly hydrated tree (which
// dropped them when it rebuilt buildNodeById from the server payload). Insertion
// order preserves parent-before-child, so a tmp parent re-inserted earlier in the
// loop is already present for its child.
function reapplyPendingBuildNodes(pending, idMap) {
  if (!pending.length) return;
  for (const entry of pending) {
    const node = entry.node;
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
  const ids = [...appState.buildPendingDeletes, ...appState.buildUndoDeletes];
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
  const undoCommit = showUndoToast({
    title: "Move deleted",
    message: `${node.san || "Move"}${extra} removed`,
    onCommit: () => {
      appState.buildUndoCommitByMove.delete(undoMoveKey);
      appState.buildUndoDeletes.delete(nodeId);
      if (!appState.build || appState.build.repertoire_id !== repId) return;
      if (!rootWasLocalOnly) appState.buildPendingDeletes.push(nodeId);
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
  setStatus(`Deleted ${node.san || "move"}`);
}

// Drain every pending move before an operation that needs server truth or a real
// node id (Generate anchor, export, node actions, repertoire switch). Throws if a
// move can't be synced so the caller can abort rather than 400 on a tmp id.
async function hardFlushBuild() {
  // Open undo windows must close first: server truth has to include those
  // deletes (or the undone restore) before any operation depends on it.
  commitPendingUndos();
  if (!appState.build) return;
  if (appState.buildFlushing) await appState.buildFlushing.catch(() => {});
  while (appState.buildPending.length || appState.buildPendingDeletes.length) {
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
  if (!appState.build) return;
  if (!appState.buildPending.length && !appState.buildPendingDeletes.length) return;
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
      appState.buildPendingDeletes
        .map(resolveBuildId)
        .filter((id) => !String(id).startsWith("tmp-"))
    ),
  ];
  if (deleteIds.length) {
    send("/api/build/delete-nodes", {
      repertoire_id: appState.build.repertoire_id,
      node_ids: deleteIds,
    });
  }
  if (appState.buildPending.length) {
    send("/api/build/add-moves", {
      repertoire_id: appState.build.repertoire_id,
      moves: appState.buildPending.map((m) => ({
        tempId: m.tempId,
        parentRef: m.parentRef,
        uci: m.uci,
      })),
    });
  }
}

async function onBuildBoardMove(moveUci) {
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
    let created;
    try {
      created = await createRepertoirePrompt({
        title: "Start a new repertoire",
        defaultName: "New repertoire",
      });
    } catch (error) {
      rollback();
      setStatus(error.message);
      return;
    }
    if (!created) {
      setStatus("Cancelled - playing the move would create a new repertoire");
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
    (n) => n.parent_id === parentId && n.uci === moveUci
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
  appState.buildPending.push({ tempId: node.id, parentRef: parentId, uci: moveUci, node });
  await selectBuildNode(node.id);
  setBuildSync("dirty");
  scheduleBuildFlush();
}

async function createRepertoirePrompt({ title, defaultName, openAfter = true, defaultColor = "white" } = {}) {
  const result = await showInputModal({
    title: title || "New repertoire",
    okLabel: "Create",
    fields: [
      { name: "name", label: "Name", default: defaultName || "New repertoire" },
      { name: "color", label: "Your color (white / black)", default: defaultColor },
    ],
  });
  if (!result) return null;
  const name = (result.name || "").trim() || "New repertoire";
  const color = ((result.color || "white").trim().toLowerCase() === "black") ? "black" : "white";
  try {
    const payload = await postJson("/api/repertoires/create", { name, color });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    if (openAfter) switchView("build");
    setStatus(`Created ${name}`);
    await refreshDashboardRepertoires();
    return payload;
  } catch (error) {
    setStatus(error.message);
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
  try {
    const text = await file.text();
    document.getElementById("pgn-input").value = text;
    const drawer = document.querySelector("#view-analyze .drawer");
    if (drawer) drawer.open = true;
    setStatus(`Loaded ${file.name} - press Analyze`);
  } catch (_) {
    setStatus("Could not read file");
  }
}

// Rough up-front size of a Build → Generate run, used only to give the progress bar a
// believable ceiling. The tree is EXPONENTIAL: user turn branches b times, opponent turn
// merges Stockfish mainline + Maia predictions above threshold (~2.5 moves on average).
// Simple mode only recurses the opponent's mainline but still creates ~2 Maia leaf nodes
// per opponent position. A 20% over-estimate buffer ensures the bar finishes a touch early.
function estimateBuildGenerateTotal({ plyDepth, ownSideCandidateCount, detailMode }) {
  const depth = Math.max(1, Number(plyDepth) || 1);
  const b = Math.max(1, Number(ownSideCandidateCount) || 1);
  const mode = String(detailMode || "balanced").toLowerCase();

  // Opponent branches that get recursed per position: Stockfish mainline + Maia above
  // threshold (10% on mainline path, 30% off it) → real-world average ~2.5.
  // Simple mode only recurses the mainline so effective recursion factor = 1.
  const oppRecurse = mode === "simple" ? 1.0 : 2.5;

  // Accumulate nodes at each ply by alternating user-turn (×b) and opponent-turn (×oppRecurse).
  // Assumes user moves first from the anchor (common case; opponent-first anchors run ~25%
  // smaller — the slight over-estimate is acceptable).
  let nodesAtPly = 1; // anchor
  let total = 0;
  let oppNodes = 0; // opponent positions, for simple-mode leaf accounting
  for (let ply = 1; ply <= depth; ply++) {
    nodesAtPly *= ply % 2 === 1 ? b : oppRecurse;
    total += nodesAtPly;
    if (ply % 2 === 0) oppNodes += nodesAtPly;
  }

  // Simple mode: Maia branches are CREATED (≈2 extra per opp position) but not recursed.
  if (mode === "simple") total += oppNodes * 2;

  // 20% over-estimate so the bar finishes a touch early rather than pegging at the ceiling.
  total *= 1.2;
  return Math.max(12, Math.ceil(total));
}

async function generateFromCurrentNode() {
  // Phase 3c: generation runs in the BROWSER. Stockfish (our turn) + Maia3
  // (opponent) drive the recursion locally into a tree-mutation plan; the server
  // only re-validates + persists via /api/build/generate/apply-plan. No server
  // compute, no fallback.
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account to edit");
    return;
  }
  if (!isBrowserEngineAvailable()) {
    setStatus(BROWSER_ENGINE_UNAVAILABLE);
    return;
  }
  let nodeId = appState.buildCurrentNodeId;
  if (!appState.build || !nodeId) {
    setStatus("Open or create a repertoire first");
    return;
  }
  if (jobToast.isBusy()) {
    setStatus("Another job is already running");
    return;
  }
  // apply-plan anchors on a REAL node id — a tmp anchor would 400. Drain any
  // pending local moves first, then re-resolve the (now-real) anchor id.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  nodeId = resolveBuildId(nodeId);
  const repColor = appState.build.color === "black" ? "black" : "white";
  const values = await showInputModal({
    title: "Generate moves from this position",
    okLabel: "Generate",
    fields: [
      {
        name: "own_color",
        label: "Your side (whose best moves to build)",
        type: "select",
        default: repColor,
        options: [
          { value: "white", label: "White" + (repColor === "white" ? " - your repertoire" : " - explore opponent") },
          { value: "black", label: "Black" + (repColor === "black" ? " - your repertoire" : " - explore opponent") },
        ],
      },
      // Kept conservative on purpose: the recursion runs locally (deep × branches
      // is slow on the user's machine) and a huge tree risks exceeding the server
      // apply-plan caps. See GEN_MAX_* / GEN_PLAN_CHANGES_SOFT_CAP.
      { name: "ply_depth", label: `Ply depth (1-${GEN_MAX_PLY_DEPTH})`, type: "number", default: 6, min: 1, max: GEN_MAX_PLY_DEPTH },
      {
        name: "own_side_candidate_count",
        label: `Your-move branches per node (1-${GEN_MAX_BRANCHES})`,
        type: "number",
        default: 1,
        min: 1,
        max: GEN_MAX_BRANCHES,
      },
      {
        name: "detail_mode",
        label: "Detail mode",
        type: "select",
        default: "balanced",
        options: [
          { value: "simple", label: "simple - mainline + first-level branches" },
          { value: "balanced", label: "balanced - recurse, 10% / 30% thresholds" },
          { value: "deep", label: "deep - same as balanced, intended for shallower depth" },
        ],
      },
      // Defaults to the player's own strength (Settings → Playing strength), so the
      // generated tree leans toward replies THEIR opponents actually play.
      { name: "maia_rating", label: "Maia rating (600-2600)", type: "number", default: effectiveMaiaRating(), min: 600, max: 2600 },
      // Ply depth (above) = how far the tree grows; Stockfish depth (here) = how deep
      // each our-turn search runs. The latter comes from Settings to avoid a second
      // depth knob that could fight it; shown read-only so the distinction is clear.
      { name: "stockfish_depth_note", label: `Stockfish search depth: ${effectiveStockfishDepth()} (from Settings)`, type: "note" },
    ],
  });
  if (!values) return;
  const ownColor = values.own_color === "black" ? "black" : "white";
  const plyDepth = Math.max(1, Math.min(GEN_MAX_PLY_DEPTH, Number(values.ply_depth) || 6));
  const ownSideCandidateCount = Math.max(
    1,
    Math.min(GEN_MAX_BRANCHES, Number(values.own_side_candidate_count) || 1),
  );
  const detailMode = ["simple", "balanced", "deep"].includes(values.detail_mode)
    ? values.detail_mode
    : "balanced";
  const maiaRating = Math.max(600, Math.min(2600, Number(values.maia_rating) || effectiveMaiaRating()));

  const jobId = `browser-generate-${Date.now()}`;
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
    total: estimateBuildGenerateTotal({ plyDepth, ownSideCandidateCount, detailMode }),
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

    const { runBrowserBuildGenerate } = await (_buildGenReady || preloadBuildGen());
    const plan = await runBrowserBuildGenerate({
      build: appState.build,
      rootNodeId: nodeId,
      ownColor,
      plyDepth,
      detailMode,
      maiaRating,
      ownSideCandidateCount,
      // Per-position Stockfish search depth from Settings (NOT the tree's ply depth).
      depth: effectiveStockfishDepth(),
      signal: controller.signal,
      // Reuse ONE warm Maia worker/session across Generate runs (Stage 4b) — the first run
      // downloads + caches the ~46 MB model, later runs skip both the fetch and the session
      // create. The orchestrator borrows it and never terminates it.
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
        repertoire_id: appState.build.repertoire_id,
        root_node_id: nodeId,
        plan,
      },
      { signal: controller.signal },
    );
    await hydrateBuild(payload, nodeId);
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
      setStatus(error.message);
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
  menu.innerHTML = sections
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
    setStatus(error.message);
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
    setStatus(error.message);
  }
}

function closeNodeContextMenu() {
  document.getElementById("node-context-menu").hidden = true;
}

async function exportBuild(format, nodeId = null) {
  if (!appState.build) {
    setStatus("Open a repertoire first");
    return;
  }
  // Export reads server-side tree state (and may scope to a node id) — sync first.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  if (nodeId) nodeId = resolveBuildId(nodeId);
  // Full tree-with-variations PGN for top-level "Export PGN" calls
  if (format === "pgn" && !nodeId) {
    const payload = await api(
      `/api/repertoires/export-pgn?repertoire_id=${encodeURIComponent(appState.build.repertoire_id)}`
    );
    downloadText(payload.filename, payload.mime, payload.content);
    setStatus(`Downloaded ${payload.filename}`);
    return;
  }
  const payload = await postJson("/api/build/export", {
    repertoire_id: appState.build.repertoire_id,
    format,
    node_id: nodeId,
  });
  downloadText(payload.filename, payload.mime, payload.content);
  setStatus(`Downloaded ${payload.filename}`);
}

async function importRepertoireFromInput(inputId) {
  try {
    const packageJson = await readSelectedFile(document.getElementById(inputId));
    const payload = await postJson("/api/repertoires/import", { package_json: packageJson });
    await hydrateBuild(payload, payload.selected_node_id);
    appState.trainingRepertoireId = payload.repertoire_id;
    setStatus(`Imported ${payload.name}`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadTrainRepertoireOptions() {
  const select = document.getElementById("train-repertoire-select");
  if (!select) return;
  let active = [];
  try {
    const payload = await api("/api/repertoires");
    active = (payload.repertoires || []).filter((r) => r.is_active !== false);
  } catch (error) {
    setStatus(error.message);
  }
  const previous =
    appState.trainingRepertoireId ||
    (active.length ? active[0].id : "__demo__");
  const options = [
    '<option value="__demo__">Demo repertoire</option>',
    ...active.map(
      (r) =>
        `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} (${escapeHtml(r.color)})</option>`
    ),
  ];
  select.innerHTML = options.join("");
  // Restore previous selection when still valid.
  const valid = new Set(["__demo__", ...active.map((r) => r.id)]);
  select.value = valid.has(previous) ? previous : (active.length ? active[0].id : "__demo__");
  if (select.value !== "__demo__") {
    appState.trainingRepertoireId = select.value;
  } else {
    appState.trainingRepertoireId = null;
  }
}

// The smart queue trains ALL active repertoires in one mixed session, so its
// setup needs no repertoire picker; line rehearsal (legacy) keeps it.
function syncTrainPickerVisibility() {
  const smart = (appState.trainMode || "smart") === "smart";
  const select = document.getElementById("train-repertoire-select");
  const label = document.querySelector(".train-picker-label");
  if (select) select.hidden = smart;
  if (label) label.hidden = smart;
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
function localDateString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function setTrainBanner(state, title, sub) {
  const banner = document.getElementById("train-banner");
  if (!banner) return;
  banner.dataset.state = state;
  document.getElementById("train-banner-title").textContent = title;
  document.getElementById("train-banner-sub").textContent = sub || "";
  if (state === "correct" || state === "wrong") {
    banner.classList.remove("flash");
    void banner.offsetWidth;
    banner.classList.add("flash");
  }
}

async function startTraining(mode) {
  mode = mode || appState.trainMode || "smart";
  appState.trainMode = mode;
  if (mode === "smart") {
    await startSmartTraining();
    return;
  }
  // ----- legacy line rehearsal (all_lines) below -----
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
    setStatus("Create a repertoire in Build first, then train it.");
    setTrainBanner("done", "No repertoire to train", "Build a repertoire, then start the trainer.");
    return;
  }
  // Same freshness rule as the smart queue: unsynced Build edits must land
  // before the server walks the tree into lines.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  const body = { seed: 13, mode, repertoire_id: repertoireId };
  try {
    const payload = await postJson("/api/train/start", body);
    appState.training = payload;
    trainStatsReset();
    if (boards.train && payload.color) {
      boards.train.setOrientation(payload.color === "black" ? "black" : "white");
    }
    document.getElementById("train-progress-panel").hidden = false;
    await renderTrainStats();
    if (payload.prompt) {
      await renderTraining(payload);
    } else {
      boards.train.setEngineArrow(null);
      setTrainBanner("done", "No trainable lines here", "Add prepared moves in Build, then train.");
      document.getElementById("train-board-label").textContent = "Nothing to train yet";
    }
    setStatus(`Trainer ready: ${payload.lines.length} lines`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function submitTrainingMove(playedUci) {
  if (appState.smart) {
    return submitSmartMove(playedUci);
  }
  if (appState.trainReview && appState.trainReview.active) {
    return submitReviewMove(playedUci);
  }
  const prompt = currentTrainingPrompt();
  if (!prompt || !playedUci || appState.trainBusy) return;
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
    setStatus(error.message);
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
      : `Prepared move: ${expectedSan}. Resetting the position.`;
    setTrainBanner(
      "wrong",
      playedSan ? `Not ${playedSan}` : "Not the prepared move",
      sub
    );
    playSound("capture");
    if (appState.training) appState.training.prompt = result.prompt;
    await sleep(1450);
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
  setTrainBanner("correct", "Correct!", result.played_san ? `You played ${result.played_san}` : "Nice - that's the prep");

  // 2) After a beat, let the opponent reply as its own animated step.
  if (result.reply_uci && result.fen_after_reply) {
    await sleep(520);
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
  setTrainBanner("review", "Recovery round", `Fix ${review.queue.length} missed move${review.queue.length === 1 ? "" : "s"} to win your run back`);
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
  setTrainBanner("review", `Recovery - ${review.index + 1} / ${review.queue.length}`, `${side === "white" ? "White" : "Black"} to move - the one you missed`);
  document.getElementById("train-board-label").textContent = "Recovery round - get it right to win your run back";
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
    stats.history.push(true);
    await renderTrainStats();
    setTrainBanner("correct", "Recovered!", "Mistake fixed - nice save");
    playSound("move");
    await sleep(640);
    appState.trainBusy = false;
    review.index += 1;
    showReviewItem();
  } else {
    stats.history.push(false);
    await renderTrainStats();
    setTrainBanner("wrong", "Still not it", "Try again - you've got this");
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
    setTrainBanner("done", "Run recovered!", `Fixed ${review.recovered} - back to ${review.savedStreak} in a row - best ${stats.best}`);
  } else {
    setTrainBanner("done", "All cleaned up!", `Fixed ${review.recovered} missed move${review.recovered === 1 ? "" : "s"}`);
  }
  document.getElementById("train-board-label").textContent = "Press Start to train again";
  celebrate();
}

function finishTrainingSession() {
  const stats = appState.trainStats;
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  setTrainBanner("done", "Session complete!", `${stats.correct} correct - ${stats.mistakes} mistakes - best run ${stats.best}`);
  document.getElementById("train-board-label").textContent = "Press Start to train again";
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
    setStatus(error.message);
  }
}

function currentTrainingPrompt() {
  return appState.training ? appState.training.prompt : null;
}

function updateTrainTurnBadge(side) {
  const badge = document.getElementById("train-turn-badge");
  if (!badge) return;
  badge.hidden = false;
  badge.dataset.side = side;
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
  weak: "Missed more often than answered — always scheduled first",
  due: "Spaced repetition says review these now",
  new: "Never trained — taught with an arrow first, then tested",
  polish: "Known material kept warm with an occasional rep",
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

async function startSmartTraining() {
  setStatus("Building your queue");
  // Train must see the latest tree: drain unsynced Build edits (adds + deletes)
  // before the server builds the queue, else a just-added line wouldn't be in
  // it and a just-deleted one would.
  try {
    await hardFlushBuild();
  } catch (error) {
    setStatus(error.message);
    return;
  }
  // Land any leftover graded attempts (an abandoned previous session) before
  // the new queue is scheduled from SR state. Strict: starting anyway would
  // schedule the queue off stale SR state, so block until the sync lands.
  const trainSynced = await flushTrainSync().catch(() => false);
  if (!trainSynced) {
    setStatus("Couldn't sync your last session — check your connection and try again.");
    return;
  }
  let payload;
  try {
    // mixed: one queue over ALL active repertoires (the picker only matters
    // for line rehearsal). fresh: always rebuild the queue from the current
    // tree + SR state — a resumed stale queue is exactly the desync this avoids.
    payload = await postJson("/api/train/smart/start", {
      mixed: true,
      fresh: true,
    });
  } catch (error) {
    setStatus(error.message);
    setTrainBanner("done", "Nothing to train yet", "Add prepared moves in Build, then train.");
    return;
  }
  appState.trainingRepertoireId = payload.repertoire_id;
  trainStatsReset();
  appState.training = null; // leave legacy mode if it was active
  // A restart can interrupt an in-flight run-in; its early-return leaves the
  // busy flag set, so clear it before the new session takes the board.
  appState.trainBusy = false;
  clearBlitzTimer();
  // The whole session runs locally off this card bundle (grading, advancement,
  // requeue, skip); only graded attempts + the position sync back, batched.
  const queue = (payload.cards || []).filter((c) => c.targets && c.targets.length);
  if (!queue.length) {
    setStatus("Nothing to train yet");
    setTrainBanner("done", "Nothing to train yet", "Add prepared moves in Build, then train.");
    return;
  }
  appState.smart = {
    sessionId: payload.session_id,
    repertoireId: payload.repertoire_id,
    repertoireName: payload.repertoire_name,
    color: payload.color,
    mixed: !!payload.mixed,
    queue,
    cardIndex: 0,
    targetIndex: 0,
    totalCards: queue.length,
    counts: { ...payload.counts },
    healthBefore: payload.health || null,
    prompt: null,
    attempt: 1,
    cardsDone: 0,
    retriesFixed: 0,
    // Snapshot the toggle so flipping it mid-session can't change the rules.
    blitz: blitzEnabled(),
    timeouts: 0,
  };
  setBlitzBarVisible(appState.smart.blitz);
  if (boards.train && payload.color) {
    boards.train.setOrientation(payload.color === "black" ? "black" : "white");
  }
  document.getElementById("train-progress-panel").hidden = false;
  setSmartPanelsHidden();
  await renderSmartQueueStrip();
  await renderTrainStats();
  setTrainSyncState("saved");
  document.getElementById("train-board-label").textContent =
    `${payload.repertoire_name} - you play ${payload.color}`;
  setStatus(`Queue ready: ${queue.length} cards`);
  await presentSmartPrompt(smartLocalPrompt(appState.smart));
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
async function presentSmartPrompt(prompt) {
  const smart = appState.smart;
  if (!smart || !prompt) return;
  smart.prompt = prompt;
  smart.attempt = 1;
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
      `${cardMeta.repertoire_name || smart.repertoireName} - you play ${cardMeta.color}`;
  }
  let cueUci = board.lastMove || null;
  if (board.fen !== prompt.fen_before) {
    appState.trainBusy = true;
    const runIn = prompt.run_in || [];
    if (runIn.length) {
      let fen = prompt.start_fen;
      board.setPosition({ fen, legalMoves: [], lastMove: null });
      setTrainBanner("runin", "Finding the position…", runIn.map((m) => m.san).join(" "));
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
    setTrainBanner(
      "move",
      `${side === "white" ? "White" : "Black"} to move`,
      `${SMART_KIND_LABELS[prompt.kind] || "Review"} - play your prepared move`
    );
    if (smart.blitz) startBlitzTimer(smart, prompt);
    else clearBlitzTimer();
  }
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
  const stats = appState.trainStats || (trainStatsReset(), appState.trainStats);

  if (!correct) {
    // Only the first answer is graded (matches the synced SR write); the
    // accuracy chips therefore never count retries.
    if (attempt === 1) {
      stats.mistakes += 1;
      stats.history.push(false);
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
      // First miss: auto-hint and a free retry, streak intact, no reveal.
      // The blitz retry is deliberately untimed — the clock tests recall,
      // the retry rebuilds it.
      setTrainBanner(
        "wrong",
        timedOut ? "Time's up - try again" : "Not that one - try again",
        prompt.hint.strategy || prompt.hint.piece || "Think about the idea behind the line."
      );
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
      // The answer is on screen anyway, so say WHY it's the move — a reveal that
      // teaches sticks better than a bare "it's Nf3".
      const why = teachWhy(prompt, "");
      setTrainBanner(
        "reveal",
        `It's ${prompt.expected_san}`,
        `${why ? `${why} ` : ""}${requeued ? "Play it to continue - this card comes back in a few cards." : "Play it to continue."}`
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

async function finishSmartSession() {
  const smart = appState.smart;
  if (!smart) return;
  const stats = appState.trainStats || {};
  smart.prompt = null;
  clearBlitzTimer();
  setBlitzBarVisible(false);
  boards.train.setEngineArrow(null);
  document.getElementById("train-progress-fill").style.width = "100%";
  const dots = document.getElementById("train-card-dots");
  if (dots) dots.innerHTML = "";
  const fixed = smart.retriesFixed ? ` - ${smart.retriesFixed} fixed on retry` : "";
  const blitzed = smart.blitz && smart.timeouts ? ` (${smart.timeouts} timed out)` : "";
  setTrainBanner(
    "done",
    smart.blitz ? "Blitz session complete!" : "Session complete!",
    `${stats.correct || 0} first-try correct - ${stats.mistakes || 0} missed${blitzed}${fixed}`
  );
  document.getElementById("train-board-label").textContent = "Press Start for a fresh queue";
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
  await renderSmartSummary(smart, stats, after);
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
    node_id: nodeId,
    correct,
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
  if (sync.flushing) return sync.flushing;
  if (!sync.pending.length && !sync.dirty) return Promise.resolve(true);
  clearTimeout(sync.timer);
  sync.timer = null;

  const batch = sync.pending;
  sync.pending = [];
  sync.dirty = false;
  // Group by session: leftovers from an abandoned session flush to THEIR
  // session, not the current one. Play order is preserved within each group.
  // Grouping/partial-failure semantics live in train-sync.js (tested): retry
  // unit is the session group — record_attempt is NOT idempotent server-side,
  // so a group that POSTed successfully must never be requeued when a later
  // group fails; 4xx drops only its own group.
  const smart = appState.smart;
  const groups = groupAttempts(batch, smart ? smart.sessionId : null);
  setTrainSyncState("syncing");

  sync.flushing = (async () => {
    let outcome;
    try {
      outcome = await flushGroups(groups, async (sessionId, attempts) => {
        const body = { session_id: sessionId, attempts, local_date: localDateString() };
        if (smart && sessionId === smart.sessionId) {
          body.card_index = smart.cardIndex;
          body.queue = smart.queue.map((c) => c.encoded);
        }
        const result = await postJson("/api/train/smart/sync", body);
        if (result.day_streak) appState.dayStreak = result.day_streak;
      });
    } finally {
      sync.flushing = null;
    }
    if (!outcome.retriable) {
      sync.retry = 0;
      if (sync.pending.length || sync.dirty) {
        setTrainSyncState("dirty");
        scheduleTrainSync();
      } else {
        setTrainSyncState("saved");
      }
      return true;
    }
    setTrainSyncState("error");
    // Requeue failed groups ahead of newer attempts and back off. SR deltas
    // are precious but small; they also flush on hide/unload and session end.
    sync.pending = ungroupAttempts(outcome.failedGroups).concat(sync.pending);
    // Only re-mark the position dirty if the current session's group is the
    // one that failed — other sessions carry no position payload.
    if (smart && outcome.failedGroups.some(([sessionId]) => sessionId === smart.sessionId)) {
      sync.dirty = true;
    }
    sync.retry = Math.min(sync.retry + 1, 6);
    const delay = Math.min(TRAIN_SYNC_MAX_BACKOFF_MS, 1000 * 2 ** (sync.retry - 1));
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
  if (!sync.pending.length && !sync.dirty) return;
  const token = readCsrfCookie();
  const smart = appState.smart;
  const groups = groupAttempts(sync.pending, smart ? smart.sessionId : null);
  for (const [sessionId, attempts] of groups) {
    const body = { session_id: sessionId, attempts, local_date: localDateString() };
    if (smart && sessionId === smart.sessionId) {
      body.card_index = smart.cardIndex;
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
    });
    settingsView.bind();
  }
  return settingsView;
}

async function loadSettings() {
  try {
    const view = await ensureSettingsView();
    const payload = await api("/api/settings");
    applySettingsPayload(payload);
    applyServerEngineGating();
    view.renderSettings(payload);
  } catch (error) {
    setStatus(error.message);
  }
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
  try {
    const payload = await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
    applySettingsPayload(payload);
    // A depth change must reach the live Stockfish consumers. The Position coach
    // rebuilds lazily (its _ensureEngine sees the new depth on the next run), but an
    // open Engine widget needs an explicit nudge to rebuild + re-analyze right now.
    if (patch && Object.prototype.hasOwnProperty.call(patch, "stockfish_depth")) {
      engineWidget.onDepthSettingChanged().catch(() => { /* best-effort */ });
    }
    // A Maia-rating change moves the Explorer Players pool (and its scope readout), which
    // both read effectiveMaiaRating() at fetch time — re-render if the drawer is open.
    if (patch && Object.prototype.hasOwnProperty.call(patch, "maia_rating") && explorerDrawerOpen()) {
      refreshExplorerPanel();
    }
  } catch (error) {
    setStatus(error.message);
  }
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
}



// NOTE: server-side engine install (Stockfish/Maia3) and the first-run install
// prompt were removed — the public flow runs Stockfish in the browser and never
// installs or runs an engine on the server. Server install endpoints remain in
// server.py for a future admin mode (gated by PREPFORGE_SERVER_ENGINE_ENABLED).

async function runLichessCompare() {
  if (!appState.lichessUsername) {
    setStatus("Connect a Lichess account first");
    startLichessOAuth();
    return;
  }
  const countInput = document.getElementById("replay-count");
  const count = Math.max(1, Math.min(50, Number(countInput.value) || 10));
  const button = document.getElementById("lichess-compare-btn");
  button.disabled = true;
  setStatus("Fetching games from Lichess");
  try {
    const payload = await postJson("/api/lichess/compare", {
      username: appState.lichessUsername,
      count,
    });
    appState.replayResults = payload;
    appState.replayFilter = null;
    appState.replayOpen = new Set();
    await renderReplayResults(payload);
    const queued = Number(payload.misses_recorded) || 0;
    setStatus(
      queued > 0
        ? `Fetched ${payload.count} games · ${queued} forgotten move${queued === 1 ? "" : "s"} added to training`
        : `Fetched ${payload.count} games for ${payload.username}`
    );
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
  }
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
      escapeHtml,
      getReplayFilter: () => appState.replayFilter,
      isGameOpen: (index) => appState.replayOpen.has(index),
      onToggleFilter: (kind) => {
        appState.replayFilter = appState.replayFilter === kind ? null : kind;
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onToggleGame: (index) => {
        if (appState.replayOpen.has(index)) appState.replayOpen.delete(index);
        else appState.replayOpen.add(index);
        void renderReplayResults(appState.replayResults).catch(() => {});
      },
      onTrainMiss: () =>
        goToSmartTraining("Your missed move is due now — press Start"),
      onBuildReply: (game) =>
        editRepertoire(game.repertoire_id, game.last_matched_node_id || null),
      onAnalyze: (game) => replayToAnalyze(game),
    });
  }
  return replayView;
}

async function renderReplayResults(payload) {
  return (await ensureReplayView()).renderReplayResults(payload);
}

// "Review in Analyze": rebuild the game's PGN from the fetched move list and
// hand it to the Analyze tab — same flow as "My last game" (press Analyze for
// the full engine review; the book banner tracks your prep as you step through).
function replayToAnalyze(game) {
  const history = game.move_san_history || [];
  if (!history.length) return;
  const safe = (s) => String(s || "?").replace(/"/g, "'");
  const headers = [
    `[Event "Lichess game"]`,
    `[Site "https://lichess.org/${safe(game.lichess_id || "")}"]`,
    `[White "${safe(game.white)}"]`,
    `[Black "${safe(game.black)}"]`,
    `[Result "${safe(game.result || "*")}"]`,
  ].join("\n");
  const movetext = history
    .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san))
    .join(" ");
  const input = document.getElementById("pgn-input");
  if (input) input.value = `${headers}\n\n${movetext} ${game.result || "*"}`;
  const drawer = document.getElementById("pgn-drawer");
  if (drawer) drawer.open = true;
  switchView("analyze");
  setStatus(
    `Loaded ${game.white || "?"} vs ${game.black || "?"} — press Analyze game`
  );
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
    setStatus(`Share link problem: ${error.message}`);
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
    setStatus("Sign in (or create an account) to join the team");
    openAuthModal("login");
    return false; // ?join= stays in the URL; we resume after the sign-in reload
  }
  let preview;
  try {
    preview = await api(`/api/teams/join/${encodeURIComponent(code)}`);
  } catch (error) {
    setStatus(`Invite link problem: ${error.message}`);
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
    setStatus(`Couldn't join: ${error.message}`);
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

function readOnlyBannerText(payload) {
  return `<b>${escapeHtml(payload.name)}</b> &middot; shared with you (read-only)`;
}

function renderReadOnlyBanner(payload) {
  const sidebar = document.querySelector("#view-build .sidebar");
  if (!sidebar) return;
  let banner = document.getElementById("shared-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "shared-banner";
    banner.className = "shared-banner";
    sidebar.prepend(banner);
  }
  banner.innerHTML = `
    <div class="shared-banner-text">
      ${readOnlyBannerText(payload)}
    </div>
    <button class="btn primary" id="shared-fork-btn" data-testid="shared-fork-btn">Copy to my account</button>
  `;
  document.getElementById("shared-fork-btn").addEventListener("click", forkReadableRepertoire);
}

function renderSharedBanner(payload) {
  renderReadOnlyBanner(payload);
}

async function forkReadableRepertoire() {
  const viaToken = !!appState.sharedToken;
  const viaTeam = appState.build && appState.build.writable === false;
  if (!viaToken && !viaTeam) return;
  if (!appState.signedIn) {
    setStatus("Sign in (or create an account) to copy this repertoire");
    openAuthModal("login");
    return;
  }
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
    setStatus(error.message);
  }
}

// ----- Coverage scan (Build sidebar) -------------------------------------------
// Maia3 walks my repertoire and measures how much of real human play (at the
// player's strength) my prepared replies answer — reach-weighted, so a hole on
// their main line outweighs one in a rare sideline. All compute runs on the
// user's device via the shared Maia worker; the module is lazily imported.

let coverageModule = null;
let coverageController = null;
let coverageGaps = []; // last scan's gaps, mapped by checkbox data-index for batch complete

async function runCoverageScanUI() {
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account first");
    return;
  }
  if (!appState.build || !appState.build.nodes || appState.build.nodes.length < 2) {
    setStatus("Open a repertoire with some moves first");
    return;
  }
  // No Stockfish gate here: the scan is Maia-only. Gating it on cross-origin
  // isolation (a Stockfish requirement) wrongly blocked a Maia-only feature; if the
  // Maia worker itself can't start, the provider surfaces that error below instead.
  const button = document.getElementById("coverage-run");
  if (button) button.disabled = true;
  const scanRepId = appState.build.repertoire_id;
  const rating = effectiveMaiaRating();
  coverageController = new AbortController();
  const jobId = `coverage-${Date.now()}`;
  jobToast.startJob({
    id: jobId,
    title: "Scanning coverage",
    tab: "build",
    total: 0,
    onCancel: () => coverageController.abort(),
  });
  try {
    if (!coverageModule) coverageModule = await import("./coverage.js");
    const result = await coverageModule.runCoverageScan({
      nodes: appState.build.nodes,
      myColor: appState.build.color,
      rating,
      provider: getSharedMaia3Provider(),
      signal: coverageController.signal,
      onProgress: ({ scanned }) =>
        jobToast.updateJob({ current: scanned, total: 0, message: `Maia read · ${scanned} positions` }),
    });
    if (!coverageScanStillValid(scanRepId)) {
      jobToast.cancelJob("Scan discarded");
      return;
    }
    renderCoverageResult(result, rating);
    jobToast.completeJob({
      message: `${Math.round(result.coverage * 100)}% of human play covered`,
    });
  } catch (error) {
    if (error && error.name === "AbortError") jobToast.cancelJob("Scan stopped");
    else jobToast.failJob(error.message);
  } finally {
    if (button && !isBuildReadOnly()) button.disabled = false;
    coverageController = null;
  }
}

function renderCoverageResult(result, rating) {
  const score = document.getElementById("coverage-score");
  if (score) {
    score.hidden = false;
    score.textContent = `${Math.round(result.coverage * 100)}% covered at ~${rating}${result.truncated ? " (partial scan)" : ""}`;
  }
  const gapsEl = document.getElementById("coverage-gaps");
  if (!gapsEl) return;
  if (!result.gaps.length) {
    coverageGaps = [];
    gapsEl.innerHTML = '<div class="muted hint">No notable holes found - the likely human moves all have an answer.</div>';
    return;
  }
  // Keep the gaps so the batch-complete handler can map checkboxes back to {nodeId, moveUci}.
  coverageGaps = result.gaps.slice();
  // Gmail-style multi-select: every gap starts checked, the user unchecks any line they
  // don't want, then "Complete" auto-builds a real reply (≥2 of my own moves deep) for the rest.
  const rows = coverageGaps
    .map(
      (gap, i) => `
    <div class="coverage-gap" data-index="${i}" data-node="${escapeHtml(gap.nodeId)}">
      <input type="checkbox" class="coverage-gap-check" data-index="${i}" checked
             aria-label="Complete ${escapeHtml(gap.moveSan)}" />
      <span class="coverage-gap-body" role="button" tabindex="0" title="Jump to this position">
        <span class="coverage-gap-move">${escapeHtml(gap.moveSan)}</span>
        <span class="coverage-gap-meta">${Math.round(gap.prob * 100)}% play it here · hits ${(gap.impact * 100).toFixed(1)}% of games</span>
      </span>
    </div>`,
    )
    .join("");
  gapsEl.innerHTML = `
    <div class="coverage-complete-bar">
      <label class="coverage-selall"><input type="checkbox" id="coverage-selectall" checked /> Select all</label>
      <button class="btn primary" id="coverage-complete" data-testid="coverage-complete">Complete ${coverageGaps.length} lines</button>
    </div>
    ${rows}`;

  const checks = () => Array.from(gapsEl.querySelectorAll(".coverage-gap-check"));
  const selectAll = gapsEl.querySelector("#coverage-selectall");
  const completeBtn = gapsEl.querySelector("#coverage-complete");
  const syncCompleteBtn = () => {
    const n = checks().filter((c) => c.checked).length;
    completeBtn.textContent = n ? `Complete ${n} line${n === 1 ? "" : "s"}` : "Complete";
    completeBtn.disabled = n === 0;
    const all = checks();
    selectAll.checked = n > 0 && n === all.length;
    selectAll.indeterminate = n > 0 && n < all.length;
  };
  selectAll.addEventListener("change", () => {
    checks().forEach((c) => (c.checked = selectAll.checked));
    syncCompleteBtn();
  });
  checks().forEach((c) => c.addEventListener("change", syncCompleteBtn));
  completeBtn.addEventListener("click", () => {
    const chosen = checks()
      .filter((c) => c.checked)
      .map((c) => coverageGaps[Number(c.dataset.index)])
      .filter(Boolean);
    completeSelectedGaps(chosen);
  });
  // Clicking the move text (not the checkbox) jumps to the position to prep manually.
  gapsEl.querySelectorAll(".coverage-gap-body").forEach((body) => {
    const node = body.closest(".coverage-gap").dataset.node;
    body.addEventListener("click", () => selectBuildNode(node));
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectBuildNode(node);
      }
    });
  });
  syncCompleteBtn();
}

// Auto-complete the chosen coverage gaps: for each, add the unanswered human move and
// generate a real reply (Stockfish ours / Maia theirs) deep enough to clear the "shallow
// line" bar (≥2 of my own moves). Sequential so the local-first add + apply-plan for each
// line settles before the next; one job toast tracks the batch and Stop aborts cleanly.
async function completeSelectedGaps(gaps) {
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account to edit");
    return;
  }
  if (!isBrowserEngineAvailable()) {
    setStatus(BROWSER_ENGINE_UNAVAILABLE);
    return;
  }
  if (!gaps || !gaps.length) return;
  if (jobToast.isBusy()) {
    setStatus("Another job is already running");
    return;
  }
  const controller = new AbortController();
  jobToast.startJob({
    id: `coverage-complete-${Date.now()}`,
    title: "Completing lines",
    tab: "build",
    total: gaps.length,
    onCancel: () => controller.abort(),
  });
  let done = 0;
  let added = 0;
  let failed = 0;
  try {
    for (const gap of gaps) {
      if (controller.signal.aborted) break;
      jobToast.updateJob({ current: done, total: gaps.length, message: `${gap.moveSan} · ${done + 1}/${gaps.length}` });
      try {
        added += await completeOneGap(gap, controller.signal);
      } catch (error) {
        if (error && error.name === "AbortError") break;
        failed += 1; // a single line failing must not abort the whole batch
      }
      done += 1;
    }
    jobToast.completeJob({
      title: "Lines completed",
      message: `+${added} moves across ${done - failed} line${done - failed === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`,
      onClick: () => switchView("build"),
    });
    setStatus(`Coverage: completed ${done - failed}/${gaps.length} lines (+${added} moves)`);
  } catch (error) {
    jobToast.failJob(error.message);
  }
}

async function completeOneGap(gap, signal) {
  // Add the opponent's unanswered human move, landing on the resulting (my-turn) node.
  await selectBuildNode(gap.nodeId);
  const before = appState.buildCurrentNodeId;
  await onBuildBoardMove(gap.moveUci);
  // onBuildBoardMove bails (without moving) on an illegal/blocked move — guard so we never
  // generate from the gap node itself (which would build the opponent's tree, not a reply).
  if (appState.buildCurrentNodeId === before) {
    throw new Error(`could not play ${gap.moveSan}`);
  }
  // apply-plan anchors on a REAL node id, so drain pending local adds and re-resolve.
  await hardFlushBuild();
  const nodeId = resolveBuildId(appState.buildCurrentNodeId);
  const { runBrowserBuildGenerate } = await (_buildGenReady || preloadBuildGen());
  const plan = await runBrowserBuildGenerate({
    build: appState.build,
    rootNodeId: nodeId,
    ownColor: appState.build.color,
    plyDepth: 3, // my move → their reply → my move ⇒ 2 own moves on the line ("deep enough")
    detailMode: "simple", // keep the per-line tree small for a batch run on the user's device
    ownSideCandidateCount: 1,
    maiaRating: effectiveMaiaRating(),
    // Per-position Stockfish search depth from Settings (NOT the tree's ply depth).
    depth: effectiveStockfishDepth(),
    maiaProvider: getSharedMaia3Provider(),
    signal,
  });
  if (signal && signal.aborted) {
    const err = new Error("Completion stopped");
    err.name = "AbortError";
    throw err;
  }
  // Committing to the save now. Generation above is cancellable, but aborting the
  // apply-plan fetch can't un-persist an atomic server apply — so the save does NOT
  // take the abort signal. A Stop click during the POST still ends the batch (the
  // outer loop re-checks signal.aborted before the next line), but THIS line finishes
  // and hydrateBuild runs, so the client never drifts from server truth.
  const payload = await postJson(
    "/api/build/generate/apply-plan",
    { repertoire_id: appState.build.repertoire_id, root_node_id: nodeId, plan },
  );
  await hydrateBuild(payload, nodeId);
  return (payload.summary && payload.summary.added_nodes) || 0;
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
    });
  }
  return scoutView;
}

// Scout chunk loads on first Scout click/Enter — not at app boot. A tiny static
// handler here avoids importing views/scout.js until the user actually scouts.
function bindScoutControlsLazy() {
  const scoutBtn = document.getElementById("scout-btn");
  const scoutName = document.getElementById("scout-username");
  if (!scoutBtn || scoutBtn.dataset.scoutLazyBound) return;
  scoutBtn.dataset.scoutLazyBound = "1";

  const activate = async () => {
    const view = await ensureScoutView();
    view.bindControls();
    return view;
  };

  const onFirstInteract = async () => {
    scoutBtn.removeEventListener("click", onFirstInteract);
    if (scoutName) scoutName.removeEventListener("keydown", onFirstKey);
    const view = await activate();
    await view.runScout();
  };
  const onFirstKey = async (event) => {
    if (event.key !== "Enter") return;
    scoutBtn.removeEventListener("click", onFirstInteract);
    scoutName.removeEventListener("keydown", onFirstKey);
    const view = await activate();
    await view.runScout();
  };

  scoutBtn.addEventListener("click", onFirstInteract);
  if (scoutName) scoutName.addEventListener("keydown", onFirstKey);
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

function bindEvents() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      switchView(button.dataset.view);
      if (button.dataset.view === "settings") loadSettings();
      if (button.dataset.view === "teams") loadTeams().catch(() => {});
    });
  });

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
  document.getElementById("account-chip").addEventListener("click", onAccountChipClick);

  // Replay tab
  document.getElementById("lichess-compare-btn").addEventListener("click", runLichessCompare);
  bindScoutControlsLazy();

  document.getElementById("run-analysis").addEventListener("click", runAnalysis);
  const createRepFromGame = document.getElementById("create-repertoire-from-game");
  if (createRepFromGame) {
    createRepFromGame.addEventListener("click", () => {
      onCreateRepertoireFromGameClick().catch(() => {});
    });
  }
  document.getElementById("fetch-my-game").addEventListener("click", fetchMyLichessGame);
  // Lazy-load the analysis history list the first time its drawer is opened.
  const historyDrawer = document.getElementById("history-drawer");
  if (historyDrawer) {
    historyDrawer.addEventListener("toggle", () => {
      if (historyDrawer.open) loadAnalysisHistory();
    });
  }
  // Coverage scan: explicit button — never runs implicitly (it's a Maia batch).
  const coverageRun = document.getElementById("coverage-run");
  if (coverageRun) coverageRun.addEventListener("click", runCoverageScanUI);

  // Opening explorer: fetch on open, switch databases in place. Closing cancels
  // any pending debounce via the drawer-open guard.
  const explorerDrawer = document.getElementById("explorer-drawer");
  if (explorerDrawer) {
    explorerDrawer.addEventListener("toggle", () => {
      if (explorerDrawer.open) refreshExplorerPanel();
    });
    explorerDrawer.querySelectorAll(".explorer-db").forEach((btn) => {
      btn.addEventListener("click", () => {
        explorerDb = btn.dataset.db === "lichess" ? "lichess" : "masters";
        explorerDrawer.querySelectorAll(".explorer-db").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
        refreshExplorerPanel();
      });
    });
  }

  // Drag-and-drop: a PGN onto the Analyze box loads it; a PGN/JSON onto the
  // dashboard repertoires card imports it.
  bindDropZone(document.getElementById("pgn-input"), fillPgnInputFromFile);
  document
    .getElementById("open-engine-widget")
    .addEventListener("click", () => engineWidget.openForCurrent());
  document
    .getElementById("open-engine-widget-build")
    .addEventListener("click", () => engineWidget.openForCurrent());
  bindEvalChart();
  document.getElementById("analysis-start").addEventListener("click", () => {
    void analysisTreeNav("start").catch(() => {});
  });
  document.getElementById("analysis-prev").addEventListener("click", () => {
    void analysisTreeNav("prev").catch(() => {});
  });
  document.getElementById("analysis-next").addEventListener("click", () => {
    void analysisTreeNav("next").catch(() => {});
  });
  document.getElementById("analysis-end").addEventListener("click", () => {
    void analysisTreeNav("end").catch(() => {});
  });

  document.getElementById("build-root").addEventListener("click", buildGoRoot);
  document.getElementById("build-parent").addEventListener("click", buildGoBack);
  document.getElementById("build-next").addEventListener("click", buildGoForward);
  document.getElementById("build-end").addEventListener("click", buildGoToEnd);
  document.getElementById("build-generate-node").addEventListener("click", generateFromCurrentNode);
  document.getElementById("build-menu").addEventListener("click", openBuildMenu);
  document
    .getElementById("import-train-json")
    .addEventListener("click", () => importRepertoireFromInput("train-import-input"));

  document.getElementById("start-train").addEventListener("click", () => startTraining());
  document.getElementById("train-hint").addEventListener("click", trainHint);
  const blitzRow = document.getElementById("train-blitz-row");
  const blitzToggle = document.getElementById("train-blitz-toggle");
  if (blitzToggle) {
    blitzToggle.checked = blitzEnabled();
    blitzToggle.addEventListener("change", () => setBlitzEnabled(blitzToggle.checked));
  }
  document.querySelectorAll("#train-modes .train-mode").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#train-modes .train-mode")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      appState.trainMode = btn.dataset.mode;
      // The answer clock only exists in the smart queue; rehearsal is untimed.
      if (blitzRow) blitzRow.hidden = btn.dataset.mode !== "smart";
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

  // Board flip + skip
  document.getElementById("analysis-flip").addEventListener("click", () => boards.analysis.flip());
  document.getElementById("build-flip").addEventListener("click", () => boards.build.flip());
  document.getElementById("train-flip").addEventListener("click", () => boards.train.flip());
  document.getElementById("train-skip").addEventListener("click", skipTrainingLine);

  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if (active && ["TEXTAREA", "INPUT", "SELECT"].includes(active.tagName)) return;
    // Arrow keys navigate the active tab's board. We blur clicked move buttons
    // on click, so focus returns to the document for these to fire.
    const inBuild = activeViewName() === "build";
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
      closeAccountMenu();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#node-context-menu")) closeNodeContextMenu();
    if (!event.target.closest("#repertoire-context-menu")) closeRepertoireContextMenu();
    // The chip's own click toggles the menu; ignore it here so we don't immediately
    // re-close what the toggle just opened.
    if (!event.target.closest("#account-menu") && !event.target.closest("#account-chip")) {
      closeAccountMenu();
    }
  });
}

async function init() {
  appState.prefs = loadPrefs();
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
  engineWidget.bind();
  positionCoach.bind();
  bindEvents();
  renderPieceStylePicker();
  renderPrefsToggles();
  prefillDemoPgn();
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

  // Learn the auth state BEFORE any owner-scoped calls. A signed-out visitor must
  // not fire /api/settings, /api/dashboard, /api/board, /api/lichess — they 401 and
  // spam the console. Gate that whole workspace load behind a real session.
  await refreshAuthProviders();
  await refreshAuthStatus();
  if (appState.signedIn) {
    await loadSignedInWorkspace();
  } else {
    setStatus("Sign in to build and train your repertoires.");
    renderBuilderTree();
  }
  // A share URL opens the read-only viewer last, so it lands on top of whatever
  // workspace state loaded — and works for signed-out visitors too.
  await maybeOpenSharedView();
  // A join URL (/?join=<code>) redeems a team invite (requires sign-in).
  await maybeHandleJoinLink();
}

// Everything that needs an authenticated session. Called from init only when
// signed in, and after a successful sign-in.
async function loadSignedInWorkspace() {
  try {
    applySettingsPayload(await api("/api/settings"));
  } catch (_) {
    appState.serverEngineEnabled = false;
  }
  applyServerEngineGating();
  try {
    const stored = localStorage.getItem(LICHESS_KEY);
    if (stored) setLichessUsername(stored);
  } catch (_) {
    /* ignore storage errors */
  }
  refreshLichessStatus();
  syncReplayControls();
  // Boards are already seeded with the start position in init() (browser-computed),
  // so signing in doesn't need to re-fetch them.
  renderBuilderTree();
  await loadDashboard();
}

init().catch((error) => setStatus(error.message));
