// Commentary database — turns a move's feature vector into a human verdict.
//
// Design rule: every sentence must trace back to a computed fact in `features`.
// No vibes, no filler. The output is small and structured so the UI can render it:
//
//   { verdict, headline, primary, notes[] }
//     verdict  — the grade pill ({ label, glyph, tone }) from classification
//     headline — what the move DID, in plain chess language
//     primary  — the one teaching sentence (the highlighted box), toned by verdict
//     notes    — supporting bullets (accuracy, what was better, hanging pieces, read)
//
// To extend the "database", add a clause to pickPrimary() or a builder to notes().
import { describeMove } from "../explain.js";
import {
  PIECE_NAME,
  materialPhrase,
  pieceListPhrase,
} from "./material.js";

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function sideWord(mover) {
  return mover === "white" ? "White" : "Black";
}
function oppWord(mover) {
  return mover === "white" ? "Black" : "White";
}
function pct(n) {
  return `${Math.round(n)}%`;
}

// Material from the mover's point of view at the end of a walked line (+ = mover up).
function moverEnd(line, mover) {
  if (!line) return null;
  return mover === "white" ? line.endBalance : -line.endBalance;
}

// Headline: what the move did. describeMove already narrates motifs (develops,
// castles, grabs the centre, takes, forks, check); we just attribute it to the side.
function buildHeadline(f) {
  if (/#/.test(f.san)) return `${sideWord(f.mover)} plays ${f.san} — checkmate.`;
  const phrase = describeMove(f.fenBefore, f.uci, f.san);
  if (phrase) return `${sideWord(f.mover)} ${phrase}.`;
  return `${sideWord(f.mover)} plays ${f.san}.`;
}

// The single most important thing to say about the move, chosen by priority.
function pickPrimary(f) {
  const c = f.classification.code;
  const opp = oppWord(f.mover);

  // Checkmate delivered.
  if (/#/.test(f.san)) return { text: "Checkmate — game over.", tone: "good" };

  // Walked into a forced mate.
  if (f.inMateNet) {
    const better = f.bestSan ? ` ${f.bestSan} held on.` : "";
    return { text: `This walks into a forced mate.${better}`, tone: "danger" };
  }

  // Missed a forced mate that was on the board.
  if (f.missedMate && f.bestSan) {
    const n = f.mateBefore !== null ? Math.abs(f.mateBefore) : null;
    const mate = n ? `mate in ${n}` : "a forced mate";
    return { text: `Missed it — ${f.bestSan} forced ${mate}.`, tone: f.classification.tone };
  }

  // Blunder / mistake: name the cost in win% and the move that was right.
  if (c === "blunder" || c === "mistake") {
    const hang =
      f.hangingOwnTop && f.hangingOwnTop.worth >= 3
        ? ` It leaves the ${PIECE_NAME[f.hangingOwnTop.type]} on ${f.hangingOwnTop.square} hanging.`
        : "";
    const better = f.bestSan && !f.isBest ? ` ${f.bestSan} was the move.` : "";
    const lead =
      f.winAfterMover < 50
        ? `${opp} is now better (${pct(100 - f.winAfterMover)}).`
        : `This throws away the edge.`;
    return { text: `${lead}${hang}${better}`, tone: f.classification.tone };
  }

  // Missed free material.
  if (f.missedWin && f.bestSan) {
    const wins = bestLineWinsPhrase(f);
    const win = wins ? ` wins ${wins}` : " was much stronger";
    return { text: `${f.bestSan}${win}.`, tone: "warn" };
  }

  // Inaccuracy: gentle nudge.
  if (c === "inaccuracy") {
    const better = f.bestSan && !f.isBest ? ` ${f.bestSan} kept more.` : "";
    return { text: `A little loose.${better}`, tone: "warn" };
  }

  // Brilliant sacrifice.
  if (c === "brilliant") {
    const give = f.hangingOwnTop ? `the ${PIECE_NAME[f.hangingOwnTop.type]}` : "material";
    return {
      text: `Brilliant — you give up ${give} but stay on top (${pct(f.winAfterMover)}).`,
      tone: "brilliant",
    };
  }

  // Great (only move).
  if (c === "great") {
    return { text: `The only move that holds — and you found it.`, tone: "good" };
  }

  // Best / good.
  if (c === "best" || c === "good") {
    const grab = f.looseAfter[0] && f.looseAfter[0].worth >= 3
      ? ` Now the ${PIECE_NAME[f.looseAfter[0].type]} on ${f.looseAfter[0].square} is under fire.`
      : "";
    const tag = f.isBest ? "The engine's top choice." : "A solid move.";
    return { text: `${tag}${grab}`, tone: "good" };
  }

  return { text: "", tone: "info" };
}

// How much more material the best line keeps for the mover than the move played —
// the honest cost of the choice (relative, so a pre-existing edge isn't double-counted).
function lineMaterialDiff(f) {
  const b = moverEnd(f.bestLine, f.mover);
  const p = moverEnd(f.playedLine, f.mover);
  if (b === null || p === null) return null;
  return b - p;
}

// For the missed-win primary: the material the best move nets over what was played.
function bestLineWinsPhrase(f) {
  const diff = lineMaterialDiff(f);
  if (diff === null || diff < 2) return "";
  return materialPhrase(diff);
}

// Tail for a "Better: X" note, framed honestly: "wins" when the strong move comes
// out materially ahead of yours, "keeps" when your move dropped material it rescues.
function betterTail(f) {
  const diff = lineMaterialDiff(f);
  if (diff === null || diff < 2) return "";
  const phrase = materialPhrase(diff);
  if (!phrase) return "";
  const dropped = moverEnd(f.playedLine, f.mover) <= -1;
  return dropped ? ` — saves ${phrase}` : ` — wins ${phrase}`;
}

function buildNotes(f) {
  const notes = [];

  // What was better, with the start of the line, when the move wasn't best.
  if (!f.isBest && f.bestSan && f.classification.code !== "great") {
    const seq = f.bestLine && f.bestLine.sanSeq.length
      ? ` (${f.bestLine.sanSeq.slice(0, 3).join(" ")}…)`
      : "";
    notes.push(`Better: ${f.bestSan}${seq}${betterTail(f)}.`);
  }

  // Self-inflicted hanging piece that the primary line didn't already call out.
  if (
    f.hangingOwnTop &&
    f.hangingOwnTop.worth >= 3 &&
    f.classification.code !== "blunder" &&
    f.classification.code !== "mistake" &&
    f.classification.code !== "brilliant"
  ) {
    notes.push(
      `Careful: your ${PIECE_NAME[f.hangingOwnTop.type]} on ${f.hangingOwnTop.square} is loose.`
    );
  }

  // The position read after the move: material + phase + whose move.
  notes.push(positionRead(f));

  // Single-move accuracy, the Game-Review number.
  notes.push(`Accuracy ${Math.round(f.accuracy)}% · ${sideWord(f.mover)} played.`);

  return notes;
}

function positionRead(f) {
  const bal = f.materialAfter;
  const phaseWord =
    f.phase === "opening" ? "Opening" : f.phase === "endgame" ? "Endgame" : "Middlegame";
  let mat;
  const phrase = materialPhrase(bal);
  if (!phrase) mat = "material level";
  else mat = `${bal > 0 ? "White" : "Black"} up ${phrase}`;
  const toMove = oppWord(f.mover); // after the move it's the other side to play
  return `${phaseWord}, ${mat} — ${toMove} to move.`;
}

export function buildCommentary(features) {
  if (!features) return { verdict: null, headline: "", primary: null, notes: [] };
  return {
    verdict: features.classification,
    headline: buildHeadline(features),
    primary: pickPrimary(features),
    notes: buildNotes(features),
  };
}
