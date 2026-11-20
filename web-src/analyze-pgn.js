import { Chess } from "chess.js";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function isFenLegal(fen) {
  if (!fen || typeof fen !== "string") return false;
  const parts = fen.split(" ");
  if (parts.length !== 6) return false;
  const [placement, side, castling, enPassant, halfmove, fullmove] = parts;
  if (!/^[pnbrqkPNBRQK1-8/]+$/.test(placement)) return false;
  if (!/^[wb]$/.test(side)) return false;
  if (!/^[KQkq-]*$/.test(castling)) return false;
  if (!/^([a-h][36]|-)?$/.test(enPassant)) return false;
  if (!/^\d+$/.test(halfmove) || !/^\d+$/.test(fullmove)) return false;
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

function uciOf(move) {
  return move.lan || move.from + move.to + (move.promotion || "");
}

function sideOf(color) {
  return color === "w" ? "white" : "black";
}

export function extractHeaders(pgnText) {
  const headers = {};
  const headerRe = /^\s*(?:\[(\w+)\s+"([^"]*)"\][ \t]*(?:\r?\n|$)|(\{[^}]*\}|;[^\r\n]*))/;
  let movetext = pgnText;
  let comments = "";
  let match;
  while ((match = headerRe.exec(movetext)) !== null) {
    if (match[1]) headers[match[1]] = match[2];
    else comments += match[3] + "\n";
    movetext = movetext.slice(match[0].length);
  }
  return { headers, movetext: comments + movetext };
}

function stripComments(text) {
  let result = "";
  let depth = 0;
  let inLineComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (c === ";" && depth === 0) {
      result += " ";
      inLineComment = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) result += " ";
      depth++;
      continue;
    }
    if (c === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) result += c;
  }
  return result;
}

function tokenize(movetext) {
  return (movetext.match(/\{[^}]*\}|;[^\r\n]*|\$\d+|[!?]+|[()]|[^\s(){};$!?]+/g) || [])
    .map(t => /^[{;$!?]/.test(t) ? t : t.replace(/^\d+\.{1,3}/, "").replace(/(?:\*|1-0|0-1|1\/2-1\/2)$/, ""))
    .filter(t => t && !/^(\.\.\.|1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}

function makeMoveNode(move, parent) {
  const fenBefore = move.before;
  return {
    san: move.san,
    uci: uciOf(move),
    fenBefore,
    fenAfter: move.after,
    moveNumber: Number(fenBefore.split(" ")[5]),
    side: sideOf(move.color),
    children: [],
    _parent: parent,
  };
}

function cleanTree(node) {
  delete node._parent;
  for (const child of node.children || []) {
    cleanTree(child);
  }
}

function parseMovetext(movetext, initialFen = START_FEN) {
  const root = { san: null, children: [], _parent: null };
  const tokens = tokenize(movetext);

  if (tokens.length === 0) {
    cleanTree(root);
    return { ok: true, root };
  }

  const stack = [{
    parentNode: root,
    lastNode: null,
    chess: new Chess(initialFen),
  }];

  for (const token of tokens) {
    const frame = stack[stack.length - 1];

    if (/^[{;$!?]/.test(token)) {
      const target = frame.lastNode || (stack.length === 1 ? root : frame);
      (target.annotations ||= []).push(token.startsWith(";") ? token + "\n" : token);
    } else if (token === "(") {
      if (!frame.lastNode) {
        return { ok: false, error: "Variation without preceding move" };
      }
      stack.push({
        parentNode: frame.lastNode._parent,
        lastNode: null,
        chess: new Chess(frame.lastNode.fenBefore),
      });
    } else if (token === ")") {
      if (stack.length <= 1) {
        return { ok: false, error: "Unmatched closing parenthesis" };
      }
      stack.pop();
    } else {
      try {
        const move = frame.chess.move(token);
        const node = makeMoveNode(move, frame.lastNode || frame.parentNode);
        if (!frame.lastNode && frame.annotations) node.startingAnnotations = frame.annotations;
        if (frame.lastNode) {
          frame.lastNode.children.push(node);
        } else {
          frame.parentNode.children.push(node);
        }
        frame.lastNode = node;
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }
  }

  if (stack.length > 1) {
    return { ok: false, error: "Unmatched opening parenthesis" };
  }

  cleanTree(root);
  return { ok: true, root };
}

export function parsePgn(pgnText) {
  const text = pgnText ?? "";
  let hasMovetext = false;
  for (const line of stripComments(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*\[\w+\s+"/.test(line)) {
      if (hasMovetext) return { ok: false, error: "Multiple games found. Use Review → Analyze batch." };
    } else hasMovetext = true;
  }
  const { headers, movetext } = extractHeaders(text);
  let initialFen = START_FEN;
  if (Object.hasOwn(headers, "FEN")) {
    if (isFenLegal(headers.FEN)) {
      initialFen = headers.FEN;
    } else {
      return { ok: false, error: "Invalid FEN header." };
    }
  }
  const result = parseMovetext(movetext, initialFen);
  if (!result.ok) {
    return result;
  }
  return { ok: true, root: result.root, headers };
}

function token(node, forceNumber) {
  if (node.side === "white") {
    return `${node.moveNumber}. ${node.san}`;
  }
  return forceNumber ? `${node.moveNumber}... ${node.san}` : node.san;
}

function emit(node, siblings, forceNumber) {
  let s = [...(node.startingAnnotations || []), token(node, forceNumber), ...(node.annotations || [])].join(" ");
  for (const v of siblings) {
    s += " (" + emit(v, [], true) + ")";
  }
  const kids = node.children || [];
  if (kids.length) {
    const main = kids[0];
    const vars = kids.slice(1);
    s += " " + emit(main, vars, siblings.length > 0);
  }
  return s;
}

function copyAnnotations(node, source) {
  for (const key of ["annotations", "startingAnnotations"]) {
    if (source[key]) node[key] = source[key];
  }
  for (const child of node.children || []) {
    const original = source.children?.find(n => n.uci === child.uci);
    if (original) copyAnnotations(child, original);
  }
}

export function treeToMovetext(root, sourcePgn) {
  if (sourcePgn) {
    const source = parsePgn(sourcePgn);
    if (source.ok) copyAnnotations(root, source.root);
  }
  const top = root.children || [];
  if (top.length === 0) return "";
  return [...(root.annotations || []), emit(top[0], top.slice(1), true)].join(" ");
}

// A PGN's header block as a plain object ("[White \"X\"]" -> White: "X"). The
// Analyze head and the self-orientation read it; a game with no headers is {}.
export function pgnHeaderTags(pgnText) {
  const tags = {};
  const re = /^\s*\[(\w+)\s+"([^"]*)"\]\s*$/gm;
  let match;
  while ((match = re.exec(pgnText)) !== null) tags[match[1]] = match[2];
  return tags;
}
