// Maia3 tokenizer — JS port of the Python encoding the model was trained on.
//
// Faithful to the maia3 package (pinned in maia3.manifest.json):
//   - maia3/dataset.py  : tokenize_board, get_legal_moves_mask, get_historical_tokens
//   - maia3/uci.py      : Maia3UCIEngine._reset_history / _tokens_from_history /
//                         _history_after_move / _move_from_index, get_all_possible_moves
//   - maia3/utils.py    : mirror_square, mirror_move, get_all_possible_moves
//
// Scope matches Phase 3b's bare-FEN contract (docs/browser-engine-migration.md):
// the server's Maia3Adapter runs with use_uci_history=False and the manifest's
// include_time_info=False, so the (64, token_dim) input is simply the CURRENT board's
// 12-dim one-hot repeated `history` times plus a single zero "ponder" column. We do
// NOT yet thread real ancestor history (the provider accepts `historyFens` but ignores
// it for now), which keeps this a pure function of the FEN.
//
// Parity is pinned by maia3-tokenizer.test.js against the committed
// maia3-smoke-fixture.json, whose `tokens` / `legal_indices` come straight from the
// Python adapter — so any drift in square indexing, the mirror frame, or the move
// vocabulary fails a test rather than silently corrupting inference.
import { Chess } from "chess.js";

// Token-dim layout from the manifest (history=8, token_dim=97, time info off).
// These are hardwired but NOT taken on faith: assertManifestContract() (below)
// checks them against the runtime manifest before any tokenization runs.
export const HISTORY = 8;
export const PIECE_PLANES = 12; // 6 piece types × 2 colors, one-hot per square
export const TOKEN_DIM = PIECE_PLANES * HISTORY + 1; // + 1 ponder col = 97
export const NUM_SQUARES = 64;

// chess.js piece letters → maia's PIECE_MAP order (pawn..king = 1..6).
const PIECE_PLANE = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
const FILES = "abcdefgh";

// Square index in maia/python-chess order: a1=0 .. h8=63 (rank*8 + file).
function squareName(file, rank) {
  return FILES[file] + (rank + 1);
}

// utils.mirror_square: vertical flip (file kept, rank -> 9-rank), as a string op.
function mirrorSquare(sq) {
  return sq[0] + (9 - Number(sq[1]));
}

// utils.mirror_move: mirror both endpoints, keep the promotion piece.
export function mirrorMove(uci) {
  const promo = uci.length > 4 ? uci.slice(4) : "";
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + promo;
}

// ---- Move vocabulary (utils.get_all_possible_moves) ------------------------
// 64×64 plain from→to strings (from-square outer, rank-major then file-major to
// match chess.square(file, rank)), then 256 white-frame promotions (rank 7→8). The
// ORDER fixes the policy index space, so it must mirror the Python loops exactly.
function buildMoveVocab() {
  const moves = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const from = squareName(file, rank);
      for (let targetRank = 0; targetRank < 8; targetRank++) {
        for (let targetFile = 0; targetFile < 8; targetFile++) {
          moves.push(from + squareName(targetFile, targetRank));
        }
      }
    }
  }
  // Promotions are always white-frame (board is mirrored for black to move).
  for (const fileFrom of FILES) {
    for (const fileTo of FILES) {
      for (const piece of ["q", "r", "b", "n"]) {
        moves.push(`${fileFrom}7${fileTo}8${piece}`);
      }
    }
  }
  return moves;
}

export const MOVE_VOCAB = buildMoveVocab();
export const INDEX_TO_MOVE = MOVE_VOCAB;
export const MOVE_TO_INDEX = new Map(MOVE_VOCAB.map((m, i) => [m, i]));

// Guard the tokenizer's hardwired contract (HISTORY / TOKEN_DIM / time-info off,
// and the 4352-move policy dimension) against the RUNTIME manifest. The constants
// above encode the exact model the tokenizer was written for; if a CDN artifact or
// an edited manifest bumps the contract, an unchecked tokenizer would silently emit
// wrong-shape tokens or a mis-sized policy mask. Call this at provider init (the
// smoke harness does, before any inference) so a drift fails loudly instead. Throws
// on the first mismatch set it finds.
export function assertManifestContract(manifest) {
  const io = (manifest && manifest.io) || {};
  const problems = [];
  if (manifest?.history !== HISTORY)
    problems.push(`history ${manifest?.history} != tokenizer ${HISTORY}`);
  if (manifest?.token_dim !== TOKEN_DIM)
    problems.push(`token_dim ${manifest?.token_dim} != tokenizer ${TOKEN_DIM}`);
  if (manifest?.include_time_info !== false)
    problems.push(`include_time_info ${manifest?.include_time_info} != false (time info unsupported)`);
  if (io.logits_move_dim !== MOVE_VOCAB.length)
    problems.push(`logits_move_dim ${io.logits_move_dim} != move vocab ${MOVE_VOCAB.length}`);
  if (problems.length)
    throw new Error(
      "Maia3 manifest contract mismatch — refusing to tokenize/run:\n  " +
        problems.join("\n  ") +
        "\nThe tokenizer's hardwired layout no longer matches the shipped model; " +
        "regenerate the tokenizer + smoke fixture for the new contract.",
    );
}

// ---- Board tokenization (dataset.tokenize_board) ---------------------------
// One-hot (64, 12). For black to move the Python code mirrors the WHOLE board
// (vertical flip + color swap); we apply that per-piece: square s -> s^56 and color
// flipped, so we never need a board.mirror() the way python-chess has one.
function tokenizeBoard(chess) {
  const blackToMove = chess.turn() === "b";
  const planes = new Float32Array(NUM_SQUARES * PIECE_PLANES);
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    const piece = chess.get(squareName(sq % 8, Math.floor(sq / 8)));
    if (!piece) continue;
    let square = sq;
    let black = piece.color === "b";
    if (blackToMove) {
      square = sq ^ 56; // vertical flip (rank -> 7-rank)
      black = !black; // color swap
    }
    const plane = PIECE_PLANE[piece.type] + (black ? 6 : 0); // 1..12
    planes[square * PIECE_PLANES + (plane - 1)] = 1;
  }
  return planes;
}

// get_historical_tokens with a single (current) position: the 12-plane one-hot is
// repeated `HISTORY` times, then one zero ponder column (include_time_info=False).
function tokensFromBoard(chess) {
  const board = tokenizeBoard(chess);
  const out = new Float32Array(NUM_SQUARES * TOKEN_DIM);
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    for (let h = 0; h < HISTORY; h++) {
      out.set(
        board.subarray(sq * PIECE_PLANES, (sq + 1) * PIECE_PLANES),
        sq * TOKEN_DIM + h * PIECE_PLANES,
      );
    }
    // out[sq * TOKEN_DIM + (TOKEN_DIM - 1)] stays 0 (clk_ponder / 100).
  }
  return out;
}

// Flattened (1, 64, TOKEN_DIM) tokens for the current position — feeds `tokens`.
export function tokensFromFen(fen) {
  return tokensFromBoard(new Chess(fen));
}

// Flattened tokens for the position AFTER a legal move (uci) — feeds the value head
// in moveAssessment (Maia3Adapter / score_moves candidate path). Returns null if the
// move is illegal in `fen`.
export function tokensAfterMove(fen, uci) {
  const chess = new Chess(fen);
  if (!applyUci(chess, uci)) return null;
  return tokensFromBoard(chess);
}

function applyUci(chess, uci) {
  try {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4) : undefined,
    });
    return !!move;
  } catch {
    return null; // chess.js throws on an illegal move
  }
}

// ---- Legal mask + index↔move (dataset.get_legal_moves_mask, _move_from_index) ----
// Sorted legal policy indices for `fen`, in the model's side-to-move frame (moves
// mirrored when black is to move). Sorted so it can be compared to the fixture.
export function legalMoveIndices(fen) {
  const chess = new Chess(fen);
  const blackToMove = chess.turn() === "b";
  const indices = [];
  for (const mv of chess.moves({ verbose: true })) {
    let uci = mv.from + mv.to + (mv.promotion || "");
    if (blackToMove) uci = mirrorMove(uci);
    const idx = MOVE_TO_INDEX.get(uci);
    // The vocabulary is built to cover every legal move (utils.get_all_possible_moves),
    // so a miss means the vocab/mirror frame drifted — NOT a move we may quietly skip.
    // Dropping it would leave the provider to re-softmax over the survivors and emit
    // plausible-but-wrong probabilities. Fail loudly instead.
    if (idx === undefined)
      throw new Error(
        `legalMoveIndices: legal move ${uci} (frame=${blackToMove ? "black-mirrored" : "white"}) ` +
          `is absent from the ${MOVE_VOCAB.length}-move vocabulary — vocab/mirror drift in ${fen}`,
      );
    indices.push(idx);
  }
  return indices.sort((a, b) => a - b);
}

// Map a policy index back to a real UCI move for `fen`, undoing the mirror frame.
// Returns null when the index is out of vocab or not legal in this position.
export function moveFromIndex(index, fen) {
  const uci = INDEX_TO_MOVE[index];
  if (uci === undefined) return null;
  const chess = new Chess(fen);
  const real = chess.turn() === "b" ? mirrorMove(uci) : uci;
  // Validate legality by attempting the move on a copy (chess.js has no quiet check).
  const probe = new Chess(fen);
  return applyUci(probe, real) ? real : null;
}
