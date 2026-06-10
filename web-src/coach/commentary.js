// Commentary — turns a move's feature vector into something a human coach would say.
//
// The output is ONE short conversational paragraph (1–3 sentences) that points out
// the few things that matter about the move just played: what it did, the key
// consequence, and — when it went wrong — what to play instead. No grades-as-data,
// no percentages, no bullet lists. Just a coach talking.
//
//   buildCommentary(features) -> { tone, grade, prose }
//     tone   — "good" | "warn" | "danger" | "brilliant" | "info" (for subtle colour)
//     grade  — human label of the move quality (kept for aria / optional display)
//     prose  — the sentence(s) to show
//
// Every clause traces to a computed fact in `features`; we just say it like a person.
// To keep it from sounding like a stuck record, most lines draw their framing from a
// small bank of phrasings picked by a per-move seed — same position, same words; a
// different move, a different turn of phrase. The *facts* never vary, only the voice.
import { describeMove } from "../explain.js";
import { PIECE_NAME, materialPhrase } from "./material.js";

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function sideWord(mover) {
  return mover === "white" ? "White" : "Black";
}
function oppWord(mover) {
  return mover === "white" ? "Black" : "White";
}

// Qualitative read of a side's standing from its win% — humans say "winning", not "88%".
function standingWord(winPct) {
  if (winPct >= 85) return "winning";
  if (winPct >= 68) return "clearly better";
  if (winPct >= 57) return "a little better";
  if (winPct > 43) return "about level";
  if (winPct > 32) return "slightly worse";
  if (winPct > 15) return "clearly worse";
  return "lost";
}

// Stable per-move variety: the same move in the same spot always reads the same way,
// but two different moves won't open with the same words. Deterministic so tests pin.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < (s || "").length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function seedOf(f) {
  return Number.isFinite(f.ply) ? f.ply : hashStr((f.san || "") + (f.uci || ""));
}
function pick(seed, arr) {
  return arr[((seed % arr.length) + arr.length) % arr.length];
}

// Material the best line nets the mover over the move played (relative, honest).
function lineMaterialDiff(f) {
  const end = (line) => (line ? (f.mover === "white" ? line.endBalance : -line.endBalance) : null);
  const b = end(f.bestLine);
  const p = end(f.playedLine);
  if (b === null || p === null) return null;
  return b - p;
}

// Net material the mover holds after the move, in pawns (mover-POV, + = ahead).
function moverMaterialAfter(f) {
  return f.mover === "white" ? f.materialAfter : -f.materialAfter;
}

// A short clause for the recommended move's payoff: keeps material it dropped, wins
// material outright, or just holds the balance.
function betterPayoff(f) {
  const diff = lineMaterialDiff(f);
  if (diff !== null && diff >= 2) {
    const phrase = materialPhrase(diff);
    const droppedMaterial =
      f.playedLine && (f.mover === "white" ? f.playedLine.endBalance : -f.playedLine.endBalance) <= -1;
    if (phrase) return droppedMaterial ? `, saving ${phrase}` : `, winning ${phrase}`;
  }
  return "";
}

// The opponent's standing after the move (used when a move goes wrong).
function oppStanding(f) {
  return standingWord(100 - f.winAfterMover);
}

// How rarely a human finds this, translated from Maia's policy probability into
// words — the concrete "why" behind a Brilliant call, not just the label.
function maiaRarityPhrase(p) {
  if (p < 0.01) return "virtually no human player would even consider it";
  if (p < 0.03) return "maybe one player in fifty would try it";
  if (p < 0.06) return "only a handful of players would go for it";
  return "few players would risk it";
}

// "It's mate in 3." / "It's mate next move." when the move just played forces mate —
// a fact straight from the engine's own read of the resulting position.
function mateInClause(f) {
  if (!f.hasMateAfter || !Number.isFinite(f.mateAfter)) return "";
  const n = Math.abs(f.mateAfter);
  return n <= 1 ? " It's mate next move." : ` It's mate in ${n}.`;
}

// The grounded "why" behind a Brilliant call: how rarely a human finds it, and how
// differently a human model reads the position — the actual Maia/Stockfish gap that
// decided the call, not just a label.
function brilliantWhyClause(f, me) {
  const mate = mateInClause(f);
  if (!f.maia || !Number.isFinite(f.maia.humanProb) || !Number.isFinite(f.maia.winChanceAfter)) {
    return mate;
  }
  const rarity = maiaRarityPhrase(f.maia.humanProb);
  const maiaStand = standingWord(f.maia.winChanceAfter * 100);
  return ` ${cap(rarity)} — most players would read this position as ${maiaStand} for ${me}, while Stockfish already sees the truth.${mate}`;
}

// The SAN plus the *value-add* idea of the move, without restating "piece to square"
// (the SAN already says that). describeMove() joins clauses with ", "; its first clause
// is the bare relocation/capture motif the SAN encodes, so we drop it and keep the rest
// ("with an eye on the centre", "forking the rook and queen", "getting the king safe").
function moveIdea(f) {
  const desc = describeMove(f.fenBefore, f.uci, f.san) || "";
  const segs = desc.split(", ").filter(Boolean);
  if (!segs.length) return "";
  return /^(develops|brings|pushes|takes|castles)\b/.test(segs[0])
    ? segs.slice(1).join(", ")
    : segs.join(", ");
}

// "Nf3, with an eye on the centre" / "Kf2" — SAN, plus the idea when there is one.
function gistOf(f) {
  const idea = moveIdea(f);
  return idea ? `${f.san}, ${idea}` : f.san;
}

function buildProse(f) {
  const seed = seedOf(f);
  const me = sideWord(f.mover);
  const opp = oppWord(f.mover);
  const code = f.classification.code;

  // Checkmate delivered — the SAN already carries the '#'.
  if (/#/.test(f.san)) {
    return pick(seed, [
      `Checkmate — ${f.san} ends it. Game over.`,
      `That's mate. ${f.san}, and there's nothing to be done about it.`,
      `Checkmate! ${f.san} brings the curtain down.`,
    ]);
  }

  // Brilliant — the engine loves it, humans wouldn't find it (Maia disagreement).
  if (code === "brilliant") {
    const looks = f.hangingOwnTop
      ? `it looks like it just hangs the ${PIECE_NAME[f.hangingOwnTop.type]}, but`
      : `it looks wrong at a glance, but`;
    const stand = standingWord(f.winAfterMover);
    const base = pick(seed, [
      `Brilliant! Almost no one would find ${f.san} — ${looks} it's the best move on the board and keeps ${me} ${stand}.`,
      `Brilliant — ${f.san} is the kind of move you don't expect a person to find. ${cap(looks)} it's simply best, and ${me} stays ${stand}.`,
      `Brilliant! ${cap(looks)} ${f.san} is exactly right, holding ${me} ${stand}.`,
    ]);
    return `${base}${brilliantWhyClause(f, me)}`;
  }

  // Blunder / mistake — say what broke and (when there's a clean fix) what to play.
  if (code === "blunder" || code === "mistake") {
    const lead =
      code === "blunder"
        ? pick(seed, [`Ouch — that's a blunder.`, `That's a blunder, I'm afraid.`, `Careful — that's a blunder.`])
        : pick(seed, [`Not quite — that's a slip.`, `Hmm, that's a mistake.`, `That's a bit of a slip.`]);

    let why;
    if (f.inMateNet && f.replySan) {
      why = `${f.san} walks into a forced mate — after ${f.replySan}, ${opp} finishes by force.`;
    } else if (f.missedMate && f.bestSan) {
      why = `${me} walks straight past a forced mate — ${f.bestSan} ended it on the spot.`;
    } else if (f.hangingOwnTop && f.hangingOwnTop.worth >= 3) {
      const reply = f.replySan ? `after ${f.replySan} ` : "";
      why = `${f.san} just drops the ${PIECE_NAME[f.hangingOwnTop.type]} on ${f.hangingOwnTop.square} — ${reply}${opp} is ${oppStanding(f)}.`;
    } else if (f.missedWin && f.looseBefore[0] && f.bestSan) {
      const t = f.looseBefore[0];
      why = `${f.san} misses it — there was a free ${PIECE_NAME[t.type]} on ${t.square} going begging, and ${f.bestSan} grabs it instead.`;
    } else {
      const phaseHint =
        f.phase === "opening"
          ? "gives away precious development time"
          : f.phase === "endgame"
          ? "gives up a tempo the endgame can't spare"
          : "hands over the initiative";
      why = `${f.san} ${phaseHint} — ${opp} is now ${oppStanding(f)}.`;
    }

    // Only name a "better move" when we haven't already named one inside `why`.
    const namedBetterAlready = f.missedMate || f.missedWin;
    const better =
      !namedBetterAlready && f.bestSan && !f.isBest ? ` ${f.bestSan} was the move${betterPayoff(f)}.` : "";
    return `${lead} ${why}${better}`;
  }

  // Inaccuracy — gentle; mention the cleaner move, and flag it if it actually flipped
  // who's better (a "small" slip that changes the verdict is worth knowing about).
  if (code === "inaccuracy") {
    const cleaner = f.bestSan && !f.isBest ? ` ${f.bestSan} would have kept things tidier.` : "";
    const flip =
      f.winAfterMover < 50 ? ` ${opp} edges ahead now — ${me} is ${standingWord(f.winAfterMover)}.` : "";
    return (
      pick(seed, [
        `A touch loose — ${me} lets a little of the edge slip.${cleaner}`,
        `Slightly inaccurate — no real harm done, just not the sharpest try.${cleaner}`,
        `A small inaccuracy — the position's still fine, only a hair less precise.${cleaner}`,
      ]) + flip
    );
  }

  // Great — far and away the best move. Two flavours: a decisive winning blow, or the
  // single move that holds a difficult position together. Pick the words to fit which.
  if (code === "great") {
    const up = moverMaterialAfter(f);
    const mate = mateInClause(f);
    if (/x/.test(f.san) && up >= 3 && materialPhrase(up)) {
      return (
        pick(seed, [
          `${f.san} — the strongest move on the board, and ${me} comes out up ${materialPhrase(up)}. Clean.`,
          `Great — ${f.san} snaps off ${materialPhrase(up)} and nothing else came close. Nicely done.`,
          `Best of the bunch — ${f.san} wins ${materialPhrase(up)}, and only this move does it so cleanly.`,
        ]) + mate
      );
    }
    const stand = !mate && f.winAfterMover >= 57 ? ` ${me} is now ${standingWord(f.winAfterMover)}.` : "";
    return (
      pick(seed, [
        `Great find — ${f.san} was the only move that holds everything together. Well spotted.`,
        `Great move. ${f.san} is the one move that keeps ${me} afloat — nicely found.`,
        `The only move, and you found it — ${f.san} is the lifeline here. That's how games get saved.`,
      ]) + (mate || stand)
    );
  }

  // Best / good — keep it warm and short, with one positive, factual point. A forced
  // mate trumps everything else; otherwise pick whichever fact is most telling.
  const lead =
    code === "best"
      ? pick(seed, [`Good move —`, `Nice —`, `Solid —`])
      : pick(seed, [`Looks fine —`, `Reasonable —`, `That works —`]);

  const gist = gistOf(f);
  const up = moverMaterialAfter(f);
  const target = f.looseAfter[0];
  const mate = mateInClause(f);
  let point = "";
  if (mate) {
    point = mate;
  } else if (/x/.test(f.san) && up >= 1 && materialPhrase(up)) {
    point = ` ${me} is up ${materialPhrase(up)} now.`;
  } else if (target && target.worth >= 3) {
    point = ` Now the ${PIECE_NAME[target.type]} on ${target.square} is feeling the heat.`;
  } else if (f.phase === "endgame" && up >= 1 && materialPhrase(up)) {
    point = ` The extra ${materialPhrase(up)} should tell in the endgame.`;
  }
  const stand = !point && f.winAfterMover >= 68 ? ` ${me} is ${standingWord(f.winAfterMover)}.` : "";
  return `${lead} ${gist}.${point}${stand}`;
}

export function buildCommentary(features) {
  if (!features) return { tone: "info", grade: "", prose: "" };
  return {
    tone: features.classification.tone,
    grade: features.classification.label,
    prose: buildProse(features),
  };
}
