// Moves inside text: a line of moves (an engine PV, a Scout line, a Train path)
// or free prose (a repertoire note, a coach sentence) turned into move tokens a
// reader can preview and play. Pure (chess.js and html.js only), so parsing and
// stepping test without a DOM; line-preview.js owns the board and the popover.
//
// A token names its line as `data-mt="<fen>|<uci> <uci> …"` (the line's start
// position and its moves) and its place in it as `data-p` (0 = the line's first
// move). Nothing is registered anywhere: the markup carries what a hover needs,
// and the line is only walked when someone actually looks at it.
import { Chess } from "chess.js";
import { html } from "./html.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Plies played before `fen`'s position: 0 at the start, 1 after 1.e4. */
export function plyOfFen(fen) {
  const parts = String(fen || "").split(" ");
  const full = Number(parts[5]) || 1;
  return (full - 1) * 2 + (parts[1] === "b" ? 1 : 0);
}

/** "5." before White's fifth move, "5..." before Black's. */
function moveNumber(ply) {
  return `${Math.floor(ply / 2) + 1}${ply % 2 ? "..." : "."}`;
}

function chessAt(fen) {
  try {
    return new Chess(fen || START_FEN);
  } catch (_) {
    return null;
  }
}

function playOne(chess, move) {
  try {
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
      return chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] || undefined });
    }
    return chess.move(move.replace(/0/g, "O"));
  } catch (_) {
    return null;
  }
}

/**
 * Walk `moves` (UCI or SAN) from `baseFen`: `{ baseFen, plies: [{ uci, san, fenBefore,
 * fen, ply, label }] }`, stopping at the first illegal move. `label` is the numbered SAN
 * ("5.O-O", "5...Qxe5"). Null for an unusable FEN or when the first move is illegal.
 */
export function walkLine(baseFen, moves) {
  const chess = chessAt(baseFen);
  if (!chess) return null;
  const plies = [];
  for (const move of Array.isArray(moves) ? moves : []) {
    if (typeof move !== "string" || !move) break;
    const fenBefore = chess.fen();
    const ply = plyOfFen(fenBefore);
    const mv = playOne(chess, move);
    if (!mv) break;
    plies.push({ uci: mv.lan, san: mv.san, fenBefore, fen: chess.fen(), ply, label: `${moveNumber(ply)}${mv.san}` });
  }
  return plies.length ? { baseFen: baseFen || START_FEN, plies } : null;
}

/** A path written out ("1.e4 c5 2.Nf3") walked from the start; null unless every move plays. */
export function walkPathText(text) {
  const sans = String(text || "").split(/\s+/).map((t) => t.replace(/^\d+\.+/, "")).filter(Boolean);
  const line = walkLine(START_FEN, sans);
  return line && line.plies.length === sans.length ? line : null;
}

/** Clamp a preview ply (0 = the line's start position, n = its end). */
export function clampPly(line, ply) {
  const n = line?.plies?.length || 0;
  return Math.max(0, Math.min(n, Math.round(Number(ply) || 0)));
}

/** The board position at ply `ply` of a line: `{ fen, lastMove }`. */
export function previewPosition(line, ply) {
  const at = clampPly(line, ply);
  if (!line || at === 0) return { fen: line?.baseFen || null, lastMove: null };
  const step = line.plies[at - 1];
  return { fen: step.fen, lastMove: step.uci };
}

/** A token's line as markup data, and back. */
export function encodeLine(baseFen, ucis) {
  return `${baseFen || START_FEN}|${ucis.join(" ")}`;
}
export function decodeLine(value) {
  const [baseFen, moves = ""] = String(value || "").split("|");
  return walkLine(baseFen, moves.split(" ").filter(Boolean));
}

// An optional move number ("12.", "12...", "12…", "…"), the SAN, check and
// annotation marks. Bounded by non-word characters so "be5t" or "Ra1b" never match.
const TOKEN =
  /(?<![\w.…])(?:(\d{1,3})?\s?(\.\.\.|…|\.)\s?)?(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][1-8](?:=?[QRBN])?)([+#]?[!?]{0,2})(?![\w])/g;
// The words that make a bare square a place, not a move: "the pawn on e5",
// "guards d5", "the d4 pawn". A coach sentence never puts a move after them.
const SQUARE_WORD = /\b(?:on|to|of|at|from|onto|into|towards?|the|an?|guard(?:s|ed|ing)?|defend(?:s|ed|ing)?|attack(?:s|ed|ing)?|hit(?:s|ting)?|control(?:s|led|ling)?|eye(?:s|d|ing)?|cover(?:s|ed|ing)?|weaken(?:s|ed|ing)?|squares?|against)\s+$/i;
// What may sit between two moves of one line or between a move and its alternative.
const JOINER = /^(?:[\s,;:()[\]–—-]|\bor\b|\bthen\b|\band\b|\bafter\b)*$/i;

/**
 * Free text → `[string | { text, line: { baseFen, ucis }, index, label }]`.
 * `ctx.fen` is the position the text is about (a note's node, the coach's move);
 * `ctx.at(ply)` (optional) gives the position at an earlier ply on the same path, so
 * "4.Nc3" in a note on move 9 still resolves. A numbered move plays from that ply; an
 * unnumbered one continues the previous move, or is its alternative ("4.Nc3 or 4.f3",
 * "Rd4 … g3 was better"). A bare pawn push ("e5") links only with a number or right
 * after another move, so "the pawn on e5" stays text; a capture ("exd5") always links.
 * `ctx.pawns` lifts that for text that is only ever about moves ("New move: e4");
 * `ctx.pawns: "prose"` (the coach's sentences, which name the move played and its
 * alternative without a number: "c6 is fine. d6 was more precise.") lifts it except
 * after a word that makes the square a place ("on e5", "guards d5").
 * Anything illegal stays text.
 */
export function parseMoveText(text, ctx = {}) {
  const source = String(text ?? "");
  const out = [];
  let last = null; // { chain, index, fenBefore, fen, end }
  let from = 0;
  const push = (s) => {
    if (!s) return;
    if (typeof out[out.length - 1] === "string") out[out.length - 1] += s;
    else out.push(s);
  };
  for (const m of source.matchAll(TOKEN)) {
    const [whole, num, dots, sanRaw] = m;
    const numbered = !!num;
    // "Nf3. Nc6" — a lone full stop is the sentence's, not a move number.
    const lead = !numbered && dots === "." ? whole.indexOf(sanRaw) : 0;
    const start = m.index + lead;
    const black = dots === "..." || dots === "…";
    const adjacent = !!last && JOINER.test(source.slice(last.end, start));
    const pawn = /^[a-h][1-8]/.test(sanRaw)
      && (!ctx.pawns || (ctx.pawns === "prose" && SQUARE_WORD.test(source.slice(Math.max(0, start - 16), start))));
    const bases = [];
    if (numbered) {
      const target = (Number(num) - 1) * 2 + (black ? 1 : 0);
      if (last && plyOfFen(last.fen) === target) bases.push({ fen: last.fen, chain: last.chain, cut: last.index + 1 });
      if (last && plyOfFen(last.fenBefore) === target) bases.push({ fen: last.fenBefore, chain: last.chain, cut: last.index });
      if (!last && ctx.fen && plyOfFen(ctx.fen) === target) bases.push({ fen: ctx.fen });
      const at = ctx.at?.(target);
      if (at) bases.push({ fen: at });
    } else if (last) {
      // A coach sentence's unnumbered move after a full stop or a verb is the move
      // it is about, or its alternative ("Nxe5 was the move"), not a reply to the
      // line the sentence before it walked.
      if (ctx.pawns === "prose" && !adjacent && !pawn && ctx.fen) bases.push({ fen: ctx.fen });
      if (adjacent || !pawn) {
        bases.push({ fen: last.fen, chain: last.chain, cut: last.index + 1 });
        bases.push({ fen: last.fenBefore, chain: last.chain, cut: last.index });
      }
      if (!pawn && ctx.fen) bases.push({ fen: ctx.fen });
    } else if (!pawn && ctx.fen) {
      bases.push({ fen: ctx.fen });
    }
    let hit = null;
    for (const base of bases) {
      if (black && base.fen.split(" ")[1] !== "b") continue;
      const chess = chessAt(base.fen);
      const mv = chess && playOne(chess, sanRaw);
      if (mv) {
        hit = { base, mv, fen: chess.fen() };
        break;
      }
    }
    if (!hit) continue;
    const { base, mv } = hit;
    const chain = base.chain && base.cut === base.chain.ucis.length
      ? base.chain
      : base.chain
        ? { baseFen: base.chain.baseFen, ucis: base.chain.ucis.slice(0, base.cut) }
        : { baseFen: base.fen, ucis: [] };
    chain.ucis.push(mv.lan);
    const index = chain.ucis.length - 1;
    push(source.slice(from, start));
    const tokenText = source.slice(start, m.index + whole.length);
    out.push({ text: tokenText, line: chain, index, label: `${moveNumber(plyOfFen(base.fen))}${mv.san}` });
    last = { chain, index, fenBefore: base.fen, fen: hit.fen, end: m.index + whole.length };
    from = last.end;
  }
  push(source.slice(from));
  return out;
}

/**
 * One token: `text` showing move `index` of `ucis` played from `baseFen`. A `.move-ref`
 * is a control of its own; `focusable: false` (a `.move-inline` by default) sits
 * inside a control that already is one (a clickable row) and leaves the click to it.
 * The accessible name is the numbered move, which the visible text may shorten.
 */
export function moveTokenHtml(baseFen, ucis, index, text, { focusable = true, cls = focusable ? "move-ref" : "move-inline", label = text, current = false } = {}) {
  const data = encodeLine(baseFen, ucis);
  const c = `${cls}${current ? " is-current" : ""}`;
  return focusable
    ? html`<span class="${c}" role="button" tabindex="0" data-mt="${data}" data-p="${index}" aria-label="${label}">${text}</span>`
    : html`<span class="${c}" data-mt="${data}" data-p="${index}">${text}</span>`;
}

/** Free text with its moves as tokens (see parseMoveText). Plain text when none resolve. */
export function moveTextHtml(text, ctx = {}, opts = {}) {
  return html`${parseMoveText(text, ctx).map((seg) =>
    typeof seg === "string" ? seg : moveTokenHtml(seg.line.baseFen, seg.line.ucis, seg.index, seg.text, { ...opts, label: seg.label }))}`;
}

/**
 * A known line (engine PV, Scout line, Train path) as numbered tokens from `baseFen`.
 * `sans` are shown; `ucis` name the moves (a move without one stays plain text).
 * Nothing is played here: the source already knows the moves, so a long line costs
 * no chess work until a token is looked at. `current` marks one ply; `cls` names the
 * tokens and `${cls}-num` their move numbers.
 */
export function moveLineHtml(baseFen, sans, ucis, { current = -1, focusable = true, cls = focusable ? "move-ref" : "move-inline" } = {}) {
  const n = sans?.length || 0;
  const known = (ucis || []).slice(0, n);
  const start = plyOfFen(baseFen);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const ply = start + i;
    if (i) out.push(" ");
    if (ply % 2 === 0 || i === 0) out.push(html`<span class="${cls}-num">${moveNumber(ply)}</span>`);
    out.push(i < known.length
      ? moveTokenHtml(baseFen, known, i, sans[i], { cls, focusable, current: i === current, label: `${moveNumber(ply)}${sans[i]}` })
      : sans[i]);
  }
  return html`${out}`;
}
