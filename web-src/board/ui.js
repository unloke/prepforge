import { html, raw } from "../html.js";
import { appState, boards, files } from "../core/state.js";
import { pref, setPref, PREF_LABELS } from "../core/prefs.js";
import { buildArrowHeadPath, buildArrowPath, endsUnder } from "../board-arrows.js";
import { localBoardAfterMove, localBoardInfo } from "../chess-local.js";
import { activateModal } from "../core/modals.js";

// Piece artwork sets. Each value is the inner SVG markup for a 0 0 45 45
// viewBox; fill/stroke come from CSS (.piece). "berlin" is a cleaner,
// traditional Staunton silhouette (the default); "classic" is the original
// minimalist set, kept as an alternative.
export const PIECE_SETS = {
  berlin: {
    p: html`<circle cx="22.5" cy="13.5" r="4.5"></circle><path d="M19 20.2h7l1.4 8.2h-9.8z"></path><path d="M15.5 31.5h14c1.8 1.4 3 3.4 3.4 6H12.1c.4-2.6 1.6-4.6 3.4-6z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    n: html`<path d="M13 38h23v3H11z"></path><path d="M15.5 34c1.1-6.8 4.9-9.4 8.2-13.1-3 .4-6.5-.5-8.9-2.4 1-6.4 6.6-10.4 13-9 5.7 1.3 9 6.1 8.4 12.4L34 34z"></path><path d="M18.1 15.6l3.9-5.3 1.2 5.5z" class="piece-cut"></path><circle cx="28.2" cy="15.1" r="1.25" class="piece-cut"></circle><path d="M22.4 20.5c2.4 1.1 5.1 1 7.5-.2" class="piece-line"></path>`,
    b: html`<circle cx="22.5" cy="8.7" r="2.5"></circle><path d="M22.5 12c-4 3.7-7.1 8.8-7.1 14.1 0 3.8 3 6.2 7.1 6.2s7.1-2.4 7.1-6.2c0-5.3-3.1-10.4-7.1-14.1z"></path><path d="M26.7 16.2l-8.4 9.4" class="piece-line"></path><path d="M14 34h17c1.1 1 1.8 2.1 2 3.6H12c.2-1.5.9-2.6 2-3.6z"></path><path d="M10.8 38.2h23.4v2.8H10.8z"></path>`,
    r: html`<path d="M12.5 9.5h5v3.6h3.4V9.5h3.2v3.6h3.4V9.5h5v8.6H29v11.3l3.2 3.3v3H12.8v-3l3.2-3.3V18.1h-3.5z"></path><path d="M16.5 21h12M16.3 31h12.4" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    q: html`<circle cx="9.5" cy="13.2" r="2.2"></circle><circle cx="16.8" cy="9.5" r="2.2"></circle><circle cx="22.5" cy="8" r="2.4"></circle><circle cx="28.2" cy="9.5" r="2.2"></circle><circle cx="35.5" cy="13.2" r="2.2"></circle><path d="M10.2 16.2l4.3 15.5h16l4.3-15.5-6.6 8-2.8-11.2-2.9 12.2-2.9-12.2-2.8 11.2z"></path><path d="M13.5 32.2h18c.9.8 1.4 1.8 1.5 3H12c.1-1.2.6-2.2 1.5-3z"></path><path d="M10.5 38h24v3H10.5z"></path>`,
    k: html`<path d="M22.5 5.5v7M19.2 8.8h6.6" class="piece-line"></path><path d="M17.8 14.5h9.4l1.4 6.7c2.2 1.7 3.6 4.2 3.6 7.1 0 2.3-1 4.1-2.8 5.2H15.6c-1.8-1.1-2.8-2.9-2.8-5.2 0-2.9 1.4-5.4 3.6-7.1z"></path><path d="M17.3 20.8h10.4M16.2 33.8h12.6" class="piece-line"></path><path d="M10.5 38h24v3H10.5z"></path>`,
  },
  classic: {
    p: html`<circle cx="22.5" cy="13" r="6"></circle><path d="M16 22h13l3 11H13z"></path><path d="M12 36h21v4H12z"></path>`,
    n: html`<path d="M14 36h22v4H11z"></path><path d="M16 34c1-10 8-11 7-19-3 1-6 1-9-1 3-6 9-8 15-5 5 3 7 8 6 14l-2 11z"></path><circle cx="29" cy="14" r="1.4" class="piece-cut"></circle>`,
    b: html`<circle cx="22.5" cy="10" r="4.5"></circle><path d="M15 31c0-7 5-12 7.5-18C25 19 30 24 30 31z"></path><path d="M13 35h19v5H13z"></path><path d="M19 20l7-7" class="piece-line"></path>`,
    r: html`<path d="M12 9h6v4h4V9h6v4h5v8H12z"></path><path d="M15 21h15v14H15z"></path><path d="M11 35h23v5H11z"></path>`,
    q: html`<circle cx="12" cy="12" r="3.5"></circle><circle cx="22.5" cy="9" r="3.5"></circle><circle cx="33" cy="12" r="3.5"></circle><path d="M12 17l5 16h11l5-16-8 7-2.5-9-2.5 9z"></path><path d="M13 35h19v5H13z"></path>`,
    k: html`<path d="M21 7h3v7h6v3h-6v6h-3v-6h-6v-3h6z"></path><path d="M15 31c1-8 5-12 7.5-14C25 19 29 23 30 31z"></path><path d="M13 35h19v5H13z"></path>`,
  },
};

export const PIECE_STYLE_KEY = "prepforge.piece_style";
const PIECE_STYLE_LABELS = { berlin: "Staunton Pro", classic: "Classic" };

export function activePieceSet() {
  return PIECE_SETS[appState.pieceStyle] || PIECE_SETS.berlin;
}

export function parseFenBoard(fen) {
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

export function pieceLabel(piece) {
  const name = PIECE_LABEL_NAMES[piece.toLowerCase()] || "piece";
  return `${piece === piece.toUpperCase() ? "white" : "black"} ${name}`;
}

export function pieceSvg(piece) {
  const colorClass = piece === piece.toUpperCase() ? "piece-white" : "piece-black";
  // eslint-disable-next-line local/trusted-raw -- SVG paths come from the authored piece sets above.
  return html`<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${raw(activePieceSet()[piece.toLowerCase()])}</g></svg>`;
}

export function setPieceStyle(style) {
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

export function renderPieceStylePicker() {
  const host = document.getElementById("piece-style-picker");
  if (!host) return;
  // A tiny sample of each set on board squares, so the choice is visible
  // before (and after) picking — the label alone didn't say what you'd get.
  const sample = ["K", "Q", "N", "p"];
  host.innerHTML = html`${Object.keys(PIECE_SETS)
    .map((style) => {
      const active = style === appState.pieceStyle;
      const set = PIECE_SETS[style];
      const previews = sample
        .map((pc) => {
          const colorClass = pc === pc.toUpperCase() ? "piece-white" : "piece-black";
          // eslint-disable-next-line local/trusted-raw -- Preview paths come from the same authored SVG piece sets.
          return html`<svg class="piece ${colorClass}" viewBox="0 0 45 45" aria-hidden="true"><g>${raw(set[pc.toLowerCase()])}</g></svg>`;
        });
      return (
        html`<button type="button" class="seg-btn piece-style-option${active ? " is-active" : ""}" data-style="${style}" aria-pressed="${active}"><span class="piece-style-preview" aria-hidden="true">${previews}</span><span class="piece-style-name">${PIECE_STYLE_LABELS[style] || style}</span></button>`
      );
    })}`;
  host.querySelectorAll(".piece-style-option").forEach((btn) => {
    btn.addEventListener("click", () => setPieceStyle(btn.dataset.style));
  });
}

export function renderPrefsToggles() {
  const host = document.getElementById("board-prefs");
  if (!host) return;
  host.innerHTML = html`${Object.keys(PREF_LABELS)
    .map((key) => {
      const on = pref(key) ? " is-on" : "";
      const label = PREF_LABELS[key] || key;
      return (
        html`<div class="pf-row"><span class="pf-row-text"><span class="pf-row-label">${label}</span></span><button type="button" class="pf-switch${on}" data-pref="${key}" role="switch" aria-checked="${pref(key)}" aria-label="${label}"><span class="pf-knob"></span></button></div>`
      );
    })}`;
  host.querySelectorAll(".pf-switch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.pref;
      setPref(key, !pref(key));
      btn.classList.toggle("is-on", pref(key));
      btn.setAttribute("aria-checked", String(pref(key)));
    });
  });
}

export function legalTargetsFrom(square, moves) {
  return moves.filter((move) => move.startsWith(square)).map((move) => move.slice(2, 4));
}

export function legalMoveFor(from, to, moves) {
  return moves.find((move) => move.startsWith(`${from}${to}`));
}

const PROMOTION_PIECES = ["q", "r", "b", "n"];
const PROMOTION_LABELS = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };

export function promotionOptions(from, to, moves) {
  return PROMOTION_PIECES.map((piece) => `${from}${to}${piece}`).filter((uci) =>
    moves.includes(uci)
  );
}

// True when `from→to` is a pawn promotion: more than one 5-char UCI shares the
// from/to prefix, or a single 5-char UCI does. Callers gate the picker on this
// so normal moves keep the instant click/drag path with zero UI.
export function isPromotionMove(from, to, moves) {
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
    overlay.innerHTML = html`
      <div class="promotion-picker" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
        ${options
          .map(
            (uci) => html`
          <button type="button" class="promotion-option" data-uci="${uci}"
            aria-label="Promote to ${PROMOTION_LABELS[uci[4]] || uci[4]}">
            ${pieceSvg(side === "white" ? uci[4].toUpperCase() : uci[4])}
            <span class="promotion-name">${PROMOTION_LABELS[uci[4]] || uci[4]}</span>
          </button>`
          )}
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
export function resolveBoardMove({ from, to, moves, board, play }) {
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

export function renderAnnotations(
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
  const drawn = [];
  const drawArrow = (parent, arrow, kind, opts) => {
    const from = squareCenter(arrow.slice(0, 2), orientation);
    const to = squareCenter(arrow.slice(2, 4), orientation);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", buildArrowPath(from, to, opts));
    path.setAttribute("class", `annot-arrow annot-${kind}`);
    parent.appendChild(path);
    drawn.push({ from, to, kind, opts, idle: parent !== overlay });
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
  // Two moves along one line from the same square (Bd3 and Bc4): the longer arrow's shaft
  // covers the shorter one, so the shorter one's head is drawn again on top — one shaft,
  // a head at each stop.
  drawn.forEach((a, i) => {
    if (!drawn.slice(i + 1).some((b) => endsUnder(a, b))) return;
    const head = document.createElementNS(NS, "path");
    head.setAttribute("d", buildArrowHeadPath(a.from, a.to, a.opts));
    head.setAttribute("class", `annot-arrow annot-${a.kind} annot-stop${a.idle ? " is-idle" : ""}`);
    overlay.appendChild(head);
  });
}

export function squareCenter(square, orientation = "white") {
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
export async function boardAfterMove(fen, moveUci) {
  return localBoardAfterMove(fen, moveUci);
}

export async function boardInfo(fen) {
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
// `cue` goes to the board's own feedback: a graded answer passes false because
// its right/wrong cue covers the move.
export async function optimisticBoardMove(board, fenBefore, moveUci, cue) {
  if (!board || !fenBefore || !moveUci) return false;
  try {
    const after = await boardAfterMove(fenBefore, moveUci);
    board.setPosition({ fen: after.board.fen, legalMoves: [], lastMove: moveUci, cue });
    return true;
  } catch (_) {
    return false;
  }
}
