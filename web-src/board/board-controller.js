import { html } from "../html.js";
import { typedSquare } from "../board-navigation.js";
import {
  boardTransition, moveMotion, playMoveMotion, positionKey,
} from "./move-motion.js";

let pref, renderAnnotations, files, isPromotionMove, resolveBoardMove, legalMoveFor,
  pieceSvg, parseFenBoard, playSound, moveCue, pieceLabel, legalTargetsFrom;

export function createBoardController(deps) {
  ({
    pref, renderAnnotations, files, isPromotionMove, resolveBoardMove, legalMoveFor,
    pieceSvg, parseFenBoard, playSound, moveCue, pieceLabel, legalTargetsFrom,
  } = deps);
  return BoardController;
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
    this.ghost = null;          // the piece following the pointer during a drag
    this._peekReal = null;      // the real position while a peek shows another (peek)
    this._draggedMove = null;   // the move a drag released, so it lands without a slide
    this._soundedKey = null;    // the move whose sound was already played
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

  setEngineArrow(uci) {
    const next = uci || null;
    if (this.engineArrow === next) return;
    this.engineArrow = next;
    this._renderArrows();
  }

  // The move the side that just moved should have played instead (Analyze, on a graded
  // error), drawn in its own colour so it never reads as the engine's next move.
  setBetterArrow(uci) {
    const next = typeof uci === "string" && uci.length >= 4 ? uci : null;
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
    const same =
      pick === this.branchPick &&
      next.length === this.branchArrows.length &&
      next.every((u, i) => u === this.branchArrows[i]);
    if (same) return;
    this.branchArrows = next;
    this.branchPick = pick;
    this._renderArrows();
  }

  // --- Peek ----------------------------------------------------------------
  // The position a move beside the board names (a coach sentence's move, a move
  // of an engine line), shown on the board itself while the reader points at it:
  // its pieces and last move on a tinted board, the marks of the real position
  // hidden. The real position is kept and comes back on peek(null); the game,
  // the tree and the engine never see a peek. A real position ends it.
  peek(pos) {
    if (pos?.fen) {
      this._peekReal ||= { fen: this.fen, lastMove: this.lastMove };
      this.fen = pos.fen;
      this.lastMove = pos.lastMove || null;
    } else if (this._peekReal) {
      ({ fen: this.fen, lastMove: this.lastMove } = this._peekReal);
      this._peekReal = null;
    } else {
      return;
    }
    const on = Boolean(this._peekReal);
    this.board.classList.toggle("is-peeking", on);
    this.overlay?.classList.toggle("is-peeking", on);
    this._renderPieces();
    this._updateClasses();
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
          square.insertAdjacentHTML("beforeend", html`<span class="coord coord-file" data-coord="${files[fileIndex]}"></span>`);
        }
        if (fileIndex === leftFile) {
          square.insertAdjacentHTML("beforeend", html`<span class="coord coord-rank" data-coord="${rank}"></span>`);
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
      this._draggedMove = `${from}${target}`;
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
      this._draggedMove = move;
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

  // `back` says this render steps back through existing history rather than
  // landing a new move: it stays quiet (the undone move's cue already played)
  // and keeps no pulse. Which way the pieces travel, and which of them move, is
  // read from the two positions (`boardTransition`), so every board — a
  // repertoire step, a takeback, an analysis branch — gets the same motion
  // without its caller having to say which direction the user went.
  setPosition({ fen, legalMoves = [], lastMove = null, cue, back = false }) {
    this.peek(null);
    const fenChanged = this.fen !== fen;
    // The position itself, without the clocks: a confirmed render that differs
    // only in halfmove/fullmove is the same position arriving twice, not a move.
    const positionChanged = positionKey(this.fen) !== positionKey(fen);
    const prevFen = this.fen;
    // A same-position refresh (an autosave, a re-render) must not yank a piece
    // out of the user's hand: keep the drag and selection while they stay legal.
    const keepInteraction = !fenChanged && (this.dragFrom || this.selected) &&
      legalMoves.some((move) => move.startsWith(this.dragFrom || this.selected));
    if (!keepInteraction) this._cancelDrag();

    // What this change moved, and the travel it needs, read NOW — before any DOM
    // write (no forced reflow) and off the positions rather than off `lastMove`.
    // A position change is read as a transition; anything wider than one move
    // comes back null and is drawn as a cut rather than a slide from a square no
    // piece ever stood on.
    const transition = fenChanged && this._hadPosition ? boardTransition(prevFen, fen) : null;
    const motion = transition ? moveMotion(transition, (square) => this.squares.get(square)) : null;

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
    // The arrows and circles belong to the position they were drawn on. A
    // position change drops them; a same-position refresh (an autosave, a
    // re-render) keeps them. Nothing is notified: they were saved already.
    if (positionChanged) {
      this.arrows = [];
      this.highlights = new Set();
    }
    if (fenChanged) {
      this._renderPieces();
      // A drag left the piece under the pointer on its target: the slide would
      // replay the drop backwards. The mark covers one position change only.
      const dragged = Boolean(this._draggedMove && lastMove && lastMove.startsWith(this._draggedMove));
      this._draggedMove = null;
      if (motion) playMoveMotion(motion, (sq) => this.squares.get(sq), pref("moveAnim") && !dragged);
      // A step back is quiet: the undone move's cue played when it was made.
      if (this._hadPosition && lastMove && !back) this._feedbackForMove(prevFen, fen, lastMove, cue);
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

  // Chirp a sound for the move and pulse its destination, off the final rendered
  // position (the slide is played by `playMoveMotion`, which also disposes of any
  // held victim when the animation is off).
  // `cue` is the caller's own sound for this move (a drill's right/wrong, or false
  // to stay quiet); without it the change itself picks the cue. One move is one
  // sound: a caller may render the same move twice (an optimistic landing, then
  // the confirmed position), and the second render of it stays quiet.
  _feedbackForMove(prevFen, fen, lastMove, cue) {
    // The sound belongs to the move, not to a position change: the optimistic
    // render and the confirmed one are the same move, and it sounds once. Two
    // different moves never share a `lastMove`, so a real move still sounds.
    const heard = lastMove === this._soundedKey;
    this._soundedKey = lastMove;
    if (cue === undefined) cue = moveCue(prevFen, fen, lastMove);
    if (cue && !heard) playSound(cue);
    if (pref("lastMovePulse")) this._pulseSquare(lastMove.slice(2, 4));
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

  // The FEN is the DOM's only authority: every square is reconciled against the
  // position, never against what an earlier render happened to leave behind.
  //
  // A capture mounts a detached copy of the victim (.piece-caught) into the
  // square the mover lands on, so that square briefly holds TWO .piece elements.
  // Keying the no-op check on `data-piece` alone, and removing at most one
  // element, meant the next render took away one of the two and left the other:
  // once the FEN empties that square, `data-piece` already reads "" and matches
  // the FEN, so no later render revisited it and a captured piece stayed on the
  // board for good. A held ←/→ is exactly the overlap — the next position
  // arrives while the previous capture's clone is still fading.
  _renderPieces() {
    const pieces = parseFenBoard(this.fen);
    this.squares.forEach((square, squareName) => {
      const piece = pieces[squareName];
      const desired = piece || "";
      const nodes = square.querySelectorAll(".piece");
      const own = nodes.length - square.querySelectorAll(".piece-caught").length;
      // Settled means: the cached letter is this square's letter, and it draws
      // exactly one own piece when the FEN has one and none when it has none.
      if (square.dataset.piece === desired && nodes.length === own && own === (piece ? 1 : 0)) return;
      square.dataset.piece = desired;
      // Keep the accessible name in lockstep with the rendered piece so
      // keyboard users hear what is on the square, not just its coordinates.
      square.setAttribute("aria-label", piece ? `${pieceLabel(piece)} ${squareName}` : squareName);
      // Swap every piece element (clones and leftovers included) so coordinate
      // labels survive; a superseded capture clone goes with the position it was
      // drawn for.
      nodes.forEach((node) => node.remove());
      if (piece) square.insertAdjacentHTML("beforeend", pieceSvg(piece));
    });
  }

  // Force every piece to re-render with the current style (dataset cache busts
  // the no-op check in _renderPieces).
  redrawPieces() {
    this.squares.forEach((square) => {
      square.dataset.piece = "";
      square.querySelectorAll(".piece").forEach((node) => node.remove());
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
    const label = this.moveBadge.label;
    square.insertAdjacentHTML(
      "beforeend",
      html`<span class="square-badge class-${cls}">${label}</span>`
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
