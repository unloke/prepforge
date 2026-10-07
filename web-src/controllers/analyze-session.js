// Analyze: whole-game analysis runs, the move list and variations, the position coach
// and its Maia read, saving and the handoff to a new repertoire. Lazy-loaded by app.js
// with the Analyze view. The startup recovery check for unsaved runs stays in app.js.

import {
  clearCheckpoint, evalMapFrom, loadCheckpoint, markCheckpointSaved, saveCheckpoint,
} from "../analyze-checkpoint.js";
import { isReviewedMove } from "../analyze-orient.js";
import { parsePgn } from "../analyze-pgn.js";
import { _coachReady, analysisRecallSeq, analyzeView } from "../app.js";
import { isAuthError } from "../auth-gate.js";
import { localBoardAfterMove, localGameOver } from "../chess-local.js";
import { buildGameSummary, hasClassifiedMoves } from "../coach/game-summary.js";
import { getSharedMaia3Provider } from "../engine/maia3-provider.js";
import { isBrowserEngineAvailable } from "../engine/stockfish-provider.js";
import { describeMove } from "../explain.js";
import { classBadgeSymbol } from "../move-grades.js";
import { normalizeRepertoireColor, repertoireColorField } from "../repertoire-color.js";

let accountService, activeViewName, analysisSelfSide, analysisStore, api, appState,
  boardAfterMove, boardInfo, boards, BROWSER_ENGINE_UNAVAILABLE, currentOwnerId,
  defaultRepertoireNameFromPgn, effectiveMaiaRating, effectiveStockfishDepth,
  engineLifecycleMark, engineWidget, ensureAnalyzeView, escapeHtml, hideAnalysisRetrySave,
  importRepertoireFromPgnText, invalidateAnalysisSource, jobToast, loadPhaseCoach,
  maiaAnalysisEnabled, postJson, pref, preloadCoach, refreshAnalysisHistoryIfOpen,
  refreshAnalyzeRecovery, renderAnalysisTree, renderAnalysisTreeEmptyState, requireSignIn,
  sanLineFromUci, savedPvSan, setEngineBestArrow, setStatus, setStatusError,
  showAnalysisRetrySave, showConfirmModal, showInputModal, START_FEN, switchView,
  syncAnalysisEvalCard, syncPgnFromTree, syncViewHeads, syncWorkspaceUrl, updateBookline;

export function createAnalyzeSession(deps) {
  ({
    accountService, activeViewName, analysisSelfSide, analysisStore, api, appState,
    boardAfterMove, boardInfo, boards, BROWSER_ENGINE_UNAVAILABLE, currentOwnerId,
    defaultRepertoireNameFromPgn, effectiveMaiaRating, effectiveStockfishDepth,
    engineLifecycleMark, engineWidget, ensureAnalyzeView, escapeHtml, hideAnalysisRetrySave,
    importRepertoireFromPgnText, invalidateAnalysisSource, jobToast, loadPhaseCoach,
    maiaAnalysisEnabled, postJson, pref, preloadCoach, refreshAnalysisHistoryIfOpen,
    refreshAnalyzeRecovery, renderAnalysisTree, renderAnalysisTreeEmptyState, requireSignIn,
    sanLineFromUci, savedPvSan, setEngineBestArrow, setStatus, setStatusError,
    showAnalysisRetrySave, showConfirmModal, showInputModal, START_FEN, switchView,
    syncAnalysisEvalCard, syncPgnFromTree, syncViewHeads, syncWorkspaceUrl, updateBookline,
  } = deps);
  positionCoach = new PositionCoach();
  positionCoach.bind();
  return {
    analysisTreeNav, discardAnalyzeCheckpoint, hideAnalysisHandoff, loadPgnIntoAnalyze,
    onAnalysisBoardMove, onCreateRepertoireFromGameClick, playHumanPick, positionCoach,
    resetAnalysisVariations, retryAnalyzeSave, revealAnalysisResults, runAnalysis,
    selectAnalysisNode, showAnalysisPly,
  };
}

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

function savedPositionEvalRead(fen, depth) {
  const positionEvals = appState.analysis && appState.analysis.position_evals;
  const ev = positionEvals && positionEvals[fen];
  if (!ev) return null;
  const pvUci = Array.isArray(ev.pv) ? ev.pv.slice() : [];
  const firstUci = ev.best_move_uci || pvUci[0] || null;
  if (!firstUci && ev.score_cp == null && ev.mate_in == null) return null;
  let pvSan = savedPvSan.get(ev);
  if (!pvSan) {
    pvSan = sanLineFromUci(fen, pvUci);
    savedPvSan.set(ev, pvSan);
  }
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
        pvSan: pvSan.slice(),
      },
    ],
  };
}

// Steps closer together than this count as one held key or a fast run of clicks;
// the coach then reads only once they have paused this long.
const COACH_RAPID_STEP_MS = 120;
const COACH_RAPID_SETTLE_MS = 160;

// Shallowest interrupted/borrowed search the coach reuses as a position read.
const COACH_MIN_REUSE_DEPTH = 10;

class PositionCoach {
  constructor() {
    this.lastUpdateAt = -Infinity;
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
    // Holding → steps faster than the coach can read: each move keeps the instant
    // line, and the full read waits until the stepping pauses.
    const now = performance.now();
    const rapid = now - this.lastUpdateAt < COACH_RAPID_STEP_MS;
    this.lastUpdateAt = now;
    const cached = (position) => this.evalCache.get(`${this.engineDepth}|${position}`) ||
      savedPositionEvalRead(position, this.engineDepth);
    if (!rapid && cached(this.ctx.prevFen) && (localGameOver(fen) || cached(fen))) {
      void this._run(fen);
      return true; // cached verdict lands before the next browser paint
    }
    this.timer = window.setTimeout(() => this._run(fen), rapid ? COACH_RAPID_SETTLE_MS : 280);
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

// Created by createAnalyzeSession, once the app state it reads is bound.
let positionCoach = null;

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
    const tiered = await import("../engine/tiered-analysis.js");
    const { evals, screenDepth } = await timed("stockfish", () =>
      tiered.analyzeTiered({
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

async function renderAnalysis(payload, { sourceSeq = analysisRecallSeq } = {}) {
  const view = await ensureAnalyzeView();
  if (sourceSeq !== analysisRecallSeq || appState.analysis !== payload) return;
  const rendered = view.renderAnalysis(payload);
  syncViewHeads();
  return rendered;
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
  // Boundary navigation must not redraw the board or rerun the coach, which
  // clears the engine arrow even though the widget's FEN has not changed.
  if (node.id === appState.analysisCurrentNodeId) return;
  await selectAnalysisNode(node.id);
}

function resetAnalysisVariations() {
  appState.analysisVarNodes = new Map();
  appState.analysisVarCounter = 0;
  appState.analysisCurrentNodeId = "root";
  appState.analysisTree = null;
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
