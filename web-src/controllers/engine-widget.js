import { html } from "../html.js";
import { hooks } from "../core/hooks.js";
import { localGameOver, pvSan } from "../chess-local.js";
import { clampPly, decodeLine, encodeLine, moveLineHtml } from "../move-text.js";
import { formatEngineEval } from "../engine-eval.js";
import { paintUnlocks } from "../engine-unlock.js";
import { subscribeDownloads } from "../engine/engine-downloads.js";
import { createPassFeed } from "./engine-pass-feed.js";

let effectiveStockfishDepth, createSharedEvaluationProvider, activeViewName, appState,
  boards, START_FEN, setEngineBestArrow, setStatusError, setEngineOn,
  explorerEvalEngine, getAnalyzeSession, analysisStore;

export function createEngineWidget(deps) {
  ({
    effectiveStockfishDepth, createSharedEvaluationProvider, activeViewName, appState,
    boards, START_FEN, setEngineBestArrow, setStatusError, setEngineOn,
    explorerEvalEngine, getAnalyzeSession, analysisStore,
  } = deps);
  const widget = new EngineWidget();
  widget.bind();
  return widget;
}

class EngineWidget {
  constructor() {
    this.el = null;
    this.pvsEl = null;
    this.evalBarWhite = null;
    this.evalBarText = null;
    this.evalHead = null;
    this.linesReadout = null;
    this.linesUpBtn = null;
    this.linesDownBtn = null;
    this.depthReadout = null;
    this.closeBtn = null;
    this.open = false;
    this.unwatch = null;
    this.lastFen = null;
    this.lastSnapshot = null;
    // Lines shown, and the width of the search behind them: always the same number.
    this.multipv = 1;
    this.maxMultipv = 5;
    this.minMultipv = 1;
    // Engine compute seam: browser Stockfish (WASM Worker) only. No server
    // fallback — if the browser engine is unavailable the widget shows an error.
    // Built lazily (on first open) at the Settings depth, and rebuilt if that
    // depth changes — so the slider in Settings actually steers the widget.
    this.engine = null;
    this.engineDepth = null;
    this.unlockEl = null;
    // While a full-game pass holds the workers, this reads the pass's own results
    // for the board instead of searching (see engine-pass-feed.js).
    this.passFeed = null;
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
    this._watch();
  }

  bind() {
    this.el = document.getElementById("engine-window");
    if (!this.el) return;
    this.pvsEl = document.getElementById("engine-window-pvs");
    this.unlockEl = document.getElementById("engine-window-unlock");
    // The row comes, changes and goes with the download, not only with a paint here:
    // each change re-fits the Build dock to the card (_paintPvs).
    subscribeDownloads(() => { if (this.open) this._paintUnlock(); });
    this.evalBarWhite = document.getElementById("engine-eval-bar-white");
    this.evalBarText = document.getElementById("engine-eval-bar-text");
    this.evalHead = document.getElementById("engine-head-eval");
    this.linesReadout = document.getElementById("engine-lines-readout");
    this.linesUpBtn = document.getElementById("engine-lines-up");
    this.linesDownBtn = document.getElementById("engine-lines-down");
    this.depthReadout = document.getElementById("engine-window-depth-readout");
    this.closeBtn = document.getElementById("engine-window-close");
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

  // The full net's unlock row sits above the lines, named for the view it is in;
  // the lite search runs and paints underneath it the whole time, and the usable
  // profile moves the search onto the full net once its bytes land.
  _paintUnlock() {
    if (!this.unlockEl) return;
    this.unlockEl.dataset.unlockPlace = activeViewName() === "build" ? "engine-build" : "engine-analyze";
    paintUnlocks(this.el);
    this._paintPvs();
  }

  async openForCurrent() {
    // The engine widget runs its own lightweight Stockfish session and is
    // intentionally *not* gated on heavy Analyze/Build jobs — the user can keep
    // probing positions while a long job runs in the background. A full-game pass
    // is the exception: it holds every worker, so the card reads its results
    // instead of queueing behind it (see _passFeed).
    this.open = true;
    this.el.hidden = false;
    this.el.classList.add("is-visible");
    this._paintPvs(this._pendingRows(0)); // rows in the frame the card appears, not after
    this._paintUnlock();
    void this._passFeed().attach();
    await this._restartForCurrentBoard();
    this._watch();
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    this._unwatch();
    this.passFeed?.detach();
    if (this.unlockEl) {
      delete this.unlockEl.dataset.unlockPlace;
      this.unlockEl.hidden = true;
      this.unlockEl.innerHTML = this.unlockEl.unlockMarkup = "";
    }
    setEngineBestArrow(null);
    this.el.classList.remove("is-visible");
    // The floating window fades out; docked in a panel there is no fade, so
    // waiting left the last line standing under a header that had gone.
    if (this.el.closest?.(".engine-slot")) this.el.hidden = true;
    else setTimeout(() => {
      if (!this.el.classList.contains("is-visible")) this.el.hidden = true;
    }, 240);
    try {
      if (this.engine) await this.engine.close();
    } catch (_) {
      // best-effort
    }
  }

  _passFeed() { return (this.passFeed ||= createPassFeed({ host: this, store: analysisStore })); }

  /** Re-analyze whenever the active board changes. No-op if widget closed. */
  async onBoardChanged() {
    if (!this.open) return;
    const fen = this.currentFen();
    if (fen === this.lastFen) return;
    this._ensureEngine();
    const engine = this.engine;
    this.lastFen = fen;
    this._clearAnalysisView();
    // A running pass owns every worker: read what it has for this position.
    if (await this._passFeed().read()) return;
    try {
      const snapshot = await engine.update({ fen, multipv: this.multipv });
      // Bail if the world moved while update() was in flight: the panel closed, a NEWER board
      // change set a different lastFen, or a depth change swapped the provider out. Otherwise we'd
      // paint this (now stale) FEN's eval onto the current board, or poll the wrong provider.
      // provider.serialize() orders engine commands, not these UI continuations.
      if (!this.open || engine !== this.engine || fen !== this.lastFen) return;
      this._renderSnapshot(snapshot);
      this._watch();
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
    // A card that opens mid-pass reads the pass's result for this position.
    if (await this._passFeed().read()) return;
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
      const snapshot = await engine.update({ fen, multipv: this.multipv });
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
      this._watch();
    } catch (error) {
      if (!this.open || engine !== this.engine || this.multipv !== clamped) return;
      this._showError(error.message);
    }
  }

  // The lines are the card's only variable height, and the Build inspector is sized to its
  // drawers (fitBuildDock), which ran only on a Build/Coverage paint: a line arriving in
  // between left the dock shorter than the drawer holding it — an internal scrollbar until
  // the next unrelated repaint. Every row paint asks for the fit, keyed on the shape.
  _paintPvs(markup) {
    if (!this.pvsEl) return;
    if (markup !== undefined) this.pvsEl.innerHTML = markup;
    const key = `${this.pvsEl.children.length}/${this.unlockEl?.hidden === false && this.unlockEl.firstElementChild?.dataset.mode}`;
    if (key === this.pvsEl.dataset.rows || this.el?.hidden || activeViewName() !== "build") return;
    this.pvsEl.dataset.rows = key;
    hooks.build?.session?.fitBuildDock();
  }

  _showError(message) {
    setEngineBestArrow(null);
    setStatusError(message);
    this._paintPvs(html`<div class="empty-state">${message || "Engine error"}</div>`);
  }

  _clearAnalysisView() {
    setEngineBestArrow(null);
    if (this.lastFen && this._renderGameOver(this.lastFen)) return;
    this._paintPvs(this._pendingRows(0));
    if (this.depthReadout) this.depthReadout.textContent = "0 / ?";
    this._paintDepth(0, null);
    if (this.evalBarText) this.evalBarText.textContent = "...";
    if (this.evalHead) {
      // Analyze keeps the last live number while the next position warms up.
      if (activeViewName() !== "analyze") {
        this.evalHead.textContent = "...";
        delete this.evalHead.dataset.side;
      }
      this.evalHead.dataset.pending = "true";
    }
  }

  // Placeholder rows so the panel keeps the same height while a search warms up:
  // one row per requested line, identical in size to a real line.
  _pendingRows(from) {
    const markup = [];
    for (let i = from; i < this.multipv; i += 1) {
      markup.push(html`<div class="engine-pv is-pending" aria-hidden="true"><span class="engine-pv-eval">…</span><span class="engine-pv-line">${i === 0 ? "Calculating…" : ""}</span></div>`);
    }
    return html`${markup}`;
  }

  // Checkmate / stalemate / draw on the board: there is no line to search, so
  // say the result instead of "Calculating…" forever. Returns true if shown.
  _renderGameOver(fen) {
    const over = localGameOver(fen);
    if (!over) return false;
    setEngineBestArrow(null);
    const text =
      over.kind === "checkmate"
        ? `Checkmate: ${over.winner === "white" ? "White" : "Black"} wins`
        : over.kind === "stalemate"
          ? "Stalemate, draw"
          : "Draw";
    this._paintPvs(html`<div class="engine-pv is-top is-final"><span class="engine-pv-eval">${over.result}</span><span class="engine-pv-line">${text}</span></div>`);
    if (this.depthReadout) this.depthReadout.textContent = "0 / 0";
    this._paintDepth(0, 0);
    if (this.evalBarWhite) {
      const share = over.winner === "white" ? 1 : over.winner === "black" ? 0 : 0.5;
      this.evalBarWhite.style.transform = `scaleY(${share})`;
    }
    if (this.evalBarText) this.evalBarText.textContent = over.result;
    if (this.evalHead) {
      this.evalHead.textContent = over.result;
      this.evalHead.dataset.side = over.winner || "even";
      delete this.evalHead.dataset.pending;
    }
    return true;
  }

  // Depth reads as its own number: "14/20" says how far the search has come
  // and how far it can go; the tooltip names it.
  _paintDepth(current, target) {
    const el = this.depthReadout;
    if (!el) return;
    // Number(null) is 0, so "no depth at all" must be checked before converting.
    const hasCur = current !== null && current !== undefined && Number.isFinite(Number(current));
    const cur = Number(current);
    const max = Number(target);
    // Only a real positive ceiling counts as a target.
    const hasMax = Number.isFinite(max) && max > 0;
    el.dataset.d = hasCur ? (hasMax ? `${cur}/${max}` : String(cur)) : "";
    el.title = hasCur ? `Search depth ${cur}${hasMax ? ` of ${max}` : ""}` : "";
    el.hidden = !hasCur;
  }

  _renderLinesReadout() {
    if (!this.linesReadout) return;
    this.linesReadout.textContent = `${this.multipv}`;
    this.linesReadout.title = "Lines shown";
    if (this.linesDownBtn) this.linesDownBtn.disabled = this.multipv <= this.minMultipv;
    if (this.linesUpBtn) this.linesUpBtn.disabled = this.multipv >= this.maxMultipv;
  }

  _bindControls() {
    this.closeBtn.addEventListener("click", () => setEngineOn(activeViewName(), false));
    this.linesUpBtn.addEventListener("click", () => this._setMultipv(this.multipv + 1));
    this.linesDownBtn.addEventListener("click", () => this._setMultipv(this.multipv - 1));
    // A line is for the move list: clicking one of its moves plays the line up to
    // that move into the analysis tree, as a variation from the position on the
    // board, and a branch that is already there is selected instead of added
    // twice. Clicking the row itself plays its first move; Enter/Space do the same
    // from the keyboard. Nothing here walks a line on the board on its own.
    this.pvsEl.addEventListener("click", (event) => {
      const row = event.target.closest(".engine-pv[data-line]");
      if (!row) return;
      const move = event.target.closest(".pv-move[data-p]");
      this._playLine(row, move ? Number(move.dataset.p) + 1 : 1);
    });
    // The rows are real controls, so Enter/Space must work too.
    this.pvsEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest(".engine-pv[data-line]");
      if (!row) return;
      event.preventDefault(); // Space would otherwise scroll the dock
      this._playLine(row, 1);
    });
  }

  // The lines the card shows, played into the analysis tree up to `ply` (1 = the
  // first move). The moves come from the row's own encoded line, so a repaint
  // between the click and this handler cannot swap the line under it; a row with
  // no moves yet has nothing to play.
  _playLine(row, ply) {
    if (activeViewName() !== "analyze") return;
    const line = decodeLine(row.dataset.mt);
    // The rows belong to the position the search was asked for: once the board
    // has moved on they are on their way out, and their moves no longer start
    // from the position on screen.
    if (!line || line.baseFen !== appState.analysisBoardFen) return;
    const session = getAnalyzeSession();
    if (!session) return;
    const at = clampPly(line, ply);
    return at ? this._playMoves(session, line.plies.slice(0, at)) : undefined;
  }

  async _playMoves(session, plies) {
    for (const step of plies) {
      await session.onAnalysisBoardMove(step.uci, step.fenBefore);
      // A move that did not land (illegal from here, or a newer board took over)
      // makes the rest of the line meaningless from this position.
      if (appState.analysisBoardFen !== step.fen) return;
    }
  }

  // Paint every update the search produces, as it produces it: the panel used to sample
  // the search on a 450 ms timer, so a fresh position sat on "Calculating…" for up to half
  // a second after the engine's first line already existed, and intermediate depths were
  // skipped. Paints are coalesced to one per animation frame — the engine emits several
  // depths inside one frame at low depths, and repainting for each makes the row flicker.
  // The subscription stays on the provider instance it was made for.
  _watch() {
    this._unwatch();
    if (!this.open) return;
    const engine = this.engine;
    const fen = this.lastFen;
    let frame = 0;
    let latest = null;
    const paint = () => {
      frame = 0;
      const snapshot = latest;
      latest = null;
      if (!snapshot || !this.open || engine !== this.engine || fen !== this.lastFen) return;
      this._renderSnapshot(snapshot);
    };
    engine.watch((snapshot) => {
      latest = snapshot;
      frame ||= requestAnimationFrame(paint);
    });
    this.unwatch = () => {
      engine.watch(null);
      if (frame) cancelAnimationFrame(frame);
    };
  }

  _unwatch() {
    const off = this.unwatch;
    this.unwatch = null;
    if (off) off();
  }

  _renderSnapshot(snapshot) {
    if (snapshot?.fen && snapshot.fen !== this.lastFen) return;
    if (!snapshot || !snapshot.session_id) {
      setEngineBestArrow(null);
      if (this.depthReadout) this.depthReadout.textContent = "0 / 0";
      this._paintDepth(0, 0);
      return;
    }
    this.lastSnapshot = snapshot;
    if (snapshot.error) {
      this._showError(snapshot.error);
      return;
    }
    const pvs = Array.isArray(snapshot.pvs) ? snapshot.pvs : [];
    if (!pvs.length && this._renderGameOver(snapshot.fen || this.lastFen)) {
      this._unwatch();
      return;
    }
    const depthText = `${snapshot.current_depth || 0} / ${snapshot.max_depth || "?"}`;
    if (this.depthReadout) this.depthReadout.textContent = depthText;
    this._paintDepth(snapshot.current_depth, snapshot.max_depth);
    // Render only as many PV slots as the user asked for; engines occasionally
    // emit transient extra ranks while changing multipv. Missing ranks keep a
    // placeholder row so the block never changes height mid-search.
    const shown = pvs.slice(0, this.multipv);
    const rows = shown.map((pv, index) => this._renderPv(pv, index, snapshot.fen || this.lastFen));
    this._paintPvs(html`${rows}${this._pendingRows(shown.length)}`);
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
    getAnalyzeSession()?.positionCoach.onWidgetSnapshot(snapshot);
    // Once the engine reaches max depth it stops; nothing more will arrive until the
    // position changes (open/update subscribe again).
    if (snapshot.running === false) this._unwatch();
  }

  // One line per row, cut off at the panel edge; rows stay one line. In Analyze a
  // row (and each move in it) plays into the move list, so it is a control; in
  // Build the card is a readout next to the Explorer, which already adds moves,
  // and a row that did nothing when clicked would be a dead button.
  _renderPv(pv, index, fen) {
    const evalText = formatEngineEval(pv.score_cp, pv.mate_in);
    // SAN for the rows this frame actually paints, converted once per PV version (see pvSan).
    const sans = pvSan(fen, pv);
    const moves = sans.length
      ? moveLineHtml(fen, sans, pv.pv_uci || [], { cls: "pv-move", focusable: false })
      : "";
    const cls = index === 0 ? "engine-pv is-top" : "engine-pv";
    // The row carries its line as the moves do (data-mt), so a click on the row's
    // own space plays the same line the row shows, not one the search has since
    // replaced.
    const playable = activeViewName() === "analyze"
      ? html` role="button" tabindex="0"`
      : "";
    return (
      html`<div class="${cls}" data-line="${index}" data-mt="${encodeLine(fen, pv.pv_uci || [])}"${playable}><span class="engine-pv-eval">${evalText}</span><span class="engine-pv-line">${moves || "..."}</span></div>`
    );
  }

  _renderEvalBar(topPv) {
    // A scoreless MultiPV placeholder is still warming up.
    if (activeViewName() === "analyze" && topPv.score_cp == null && topPv.mate_in == null) return;
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
    const evalStr = formatEngineEval(topPv.score_cp, topPv.mate_in);
    if (this.evalBarWhite) {
      this.evalBarWhite.style.transform = `scaleY(${wc.toFixed(4)})`;
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
      delete this.evalHead.dataset.pending;
    }
  }

}
