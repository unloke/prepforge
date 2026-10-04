// Coach commentary: one or two short sentences on the move just played.
//
//   buildCommentary(features, { selfSide }) -> { tone, grade, prose }
//
// Rules the wording follows:
//   - Say only what the engine line or the board shows (move-facts.js). Material is
//     named only when it actually changes hands in the engine's line, and errors are
//     priced against the better move's line, so a pending recapture never reads as a
//     loss or a win.
//   - Lead with the verdict, then the one fact that explains it, then (for errors) the
//     better move. No filler and no repeated "you're two pawns up" on every move.
//   - Describe the position change before -> after only when the verdict moved.
//   - "you" for the user's own side when it is known, colour names otherwise.
import {
  lineOutcome,
  netFor,
  netValue,
  gainPhrase,
  tradePhrase,
  numberLine,
  oppositeBishopsOnly,
  fenAfterLine,
  describeMove,
  threatPhrase,
  hasCaptures,
} from "./move-facts.js";
import { motifPhrase, participle, hangingCapture } from "./motifs.js";
import { Chess } from "chess.js";
import { PIECE_VALUE, PIECE_NAME } from "./material.js";

const TYPES = ["q", "r", "b", "n", "p"];

function capturedBy(fen, uci) {
  if (!fen || !uci) return null;
  try {
    const mv = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    return mv && mv.captured ? mv.captured : null;
  } catch (_) {
    return null;
  }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Deterministic variety: the same move always reads the same way.
function pick(f, key, options) {
  return options[hash(`${key}:${f.san}:${f.uci}:${f.ply ?? ""}`) % options.length];
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// -3..3 from the mover's point of view: lost .. level .. winning.
export function bucket(winMover) {
  if (winMover >= 85) return 3;
  if (winMover >= 68) return 2;
  if (winMover >= 57) return 1;
  if (winMover > 43) return 0;
  if (winMover > 32) return -1;
  if (winMover > 15) return -2;
  return -3;
}

const LEVEL_WORD = { 1: "slightly better", 2: "clearly better", 3: "winning" };

function makeVoice(mover, selfSide) {
  const colour = (side) => (side === "white" ? "White" : "Black");
  const opp = mover === "white" ? "black" : "white";
  const name = (side) => (selfSide && side === selfSide ? "you" : colour(side));
  // "you are clearly better" / "it was level" for a mover-POV bucket.
  const standing = (b, past = false) => {
    if (b === 0) return past ? "it was level" : "it's level";
    const who = name(b > 0 ? mover : opp);
    const verb = who === "you" ? (past ? "were" : "are") : past ? "was" : "is";
    return `${who} ${verb} ${LEVEL_WORD[Math.abs(b)]}`;
  };
  // "keeping you clearly better" / "keeping it level" / "limiting the damage".
  const keeping = (b) => {
    if (b === 0) return "keeping it level";
    if (b < 0) return "limiting the damage";
    return `keeping ${name(mover)} ${LEVEL_WORD[b]}`;
  };
  return { me: name(mover), standing, keeping };
}

function mateCount(m) {
  const n = Math.abs(Number(m) || 0);
  return n <= 1 ? "mate next move" : `mate in ${n}`;
}

function negate(net) {
  const out = {};
  for (const k of Object.keys(net)) out[k] = -net[k];
  return out;
}

function minus(a, b) {
  const out = {};
  for (const t of TYPES) out[t] = (a[t] || 0) - (b[t] || 0);
  return out;
}

// The line after the first move of `outcome`, numbered and trimmed to the capture that
// settles it: the last capture by `byColor` within `cap` plies (or two plies when none).
function trimmedLine(startFen, outcome, byColor, cap = 4) {
  if (!outcome || outcome.plies < 2) return "";
  const rest = outcome.moves.slice(1, cap + 1);
  let end = -1;
  rest.forEach((mv, i) => {
    if (mv.captured && mv.color === byColor) end = i;
  });
  const n = end >= 0 ? end + 1 : Math.min(2, rest.length);
  return numberLine(startFen, rest.slice(0, n).map((mv) => mv.san));
}

// The best line including its first move: "20.c5 Rfd8 21.Bd6".
function bestLineText(f, outcome, byColor) {
  if (!outcome || !outcome.moves.length) return "";
  const moves = outcome.moves.slice(0, 5);
  let end = 0;
  moves.forEach((mv, i) => {
    if (mv.captured && mv.color === byColor) end = i;
  });
  return numberLine(f.fenBefore, moves.slice(0, end + 1).map((mv) => mv.san));
}

// Everything the wording needs, computed once.
function readFacts(f) {
  const m = f.mover === "white" ? "w" : "b";
  const opp = m === "w" ? "b" : "w";
  const played = lineOutcome(f.fenBefore, f.playedPvUci || [], { maxPlies: 8 });
  const own = /x/.test(f.san || "") ? lineOutcome(f.fenBefore, f.playedPvUci || [], { maxPlies: 6, first: true }) : null;
  const best = lineOutcome(f.fenBefore, f.bestPvUci || [], { maxPlies: 8 });
  const playedNet = played && played.quiet ? netValue(netFor(played, m)) : null;
  const bestNet = best && best.quiet ? netValue(netFor(best, m)) : null;
  // What the played move costs against the best line, per piece type (+ = the best line
  // keeps/wins it). Both lines start from the same position, so a pending recapture
  // cancels out instead of reading as a loss or a gain.
  const rel = played && best && played.quiet && best.quiet ? minus(netFor(best, m), netFor(played, m)) : null;
  const relValue = rel ? netValue(rel) : 0;
  const prevWasCapture = /x/.test(f.prevSan || "");
  const prevDest = f.prevUci ? f.prevUci.slice(2, 4) : null;
  // A take-back answers the opponent's capture on the same square and only restores what
  // it took: in Bxf3 Qxf3 Qxf3 gxf3 the first Qxf3 and gxf3 take back, the second Qxf3
  // starts a queen trade. Needs the piece the previous move captured, when known.
  const prevTook = capturedBy(f.prevFenBefore, f.prevUci);
  const nowTook = capturedBy(f.fenBefore, f.uci);
  // Classify this exchange from its captures, independent of material won earlier.
  const restores = prevTook && nowTook ? PIECE_VALUE[nowTook] <= PIECE_VALUE[prevTook] : true;
  const recapture = prevWasCapture && !!prevDest && /x/.test(f.san || "") && f.uci?.slice(2, 4) === prevDest && restores;
  const bestTakesBack = prevWasCapture && !!prevDest && f.bestUci?.slice(2, 4) === prevDest && /x/.test(f.bestSan || "");
  // What an error drops. Against the best line when that line only takes back (the
  // recapture the move skipped); otherwise what changes hands in the played line itself,
  // so material the best line would grab elsewhere never reads as dropped.
  const lost = bestTakesBack ? rel : played && played.quiet ? negate(netFor(played, m)) : null;
  return { m, opp, played, own, best, playedNet, bestNet, rel, relValue, lost, prevWasCapture, recapture, bestTakesBack };
}

// --- Good moves --------------------------------------------------------------

function capturedName(f) {
  const m = /^takes the (\w+)/.exec(describeMove(f.fenBefore, f.uci, f.san));
  return m ? m[1] : "";
}

function withThreat(f, phrase) {
  const threat = threatPhrase(f.fenBefore, f.uci, f.san);
  return threat && threat !== "gives check" ? `${phrase} and ${threat}` : phrase;
}

// The one point worth making about a sound move, as a verb phrase ("wins a pawn",
// "trades rooks", "develops the knight"), or "".
function goodPoint(f, x) {
  if (f.hasMateAfter && Number.isFinite(f.mateAfter)) return `forces ${mateCount(f.mateAfter)}`;
  const capture = /x/.test(f.san || "");
  if (capture && x.recapture) {
    const what = capturedName(f);
    return what ? `takes back the ${what}` : "recaptures";
  }
  if (capture && x.own && x.own.quiet) {
    const ownNet = netFor(x.own, x.m);
    const value = netValue(ownNet);
    if (value >= 1 && !x.prevWasCapture) return withThreat(f, `wins ${gainPhrase(ownNet)}`);
    if (value === 0 && hasCaptures(x.own)) {
      const trade = tradePhrase(x.own, x.m);
      if (trade) {
        const end = fenAfterLine(f.fenBefore, f.playedPvUci, x.own.plies);
        return end && oppositeBishopsOnly(end) ? `${trade}, leaving opposite-coloured bishops` : trade;
      }
    }
    if (value < 0) {
      const gave = gainPhrase(negate(ownNet));
      if (gave) return `gives up ${gave}`;
    }
  }
  // A quiet move that wins real material by force within a few moves.
  const strong = ["best", "great", "brilliant"].includes(f.classification.code);
  // Skipped when the mover is worse after it: a line that "wins a queen" for the side that
  // is losing is the other side's sacrifice, not a win.
  if (strong && !capture && !x.prevWasCapture && bucket(f.winAfterMover) >= 0) {
    const quick = lineOutcome(f.fenBefore, f.playedPvUci || [], { maxPlies: 6 });
    const net = quick && quick.quiet ? netFor(quick, x.m) : null;
    if (net && netValue(net) >= 2) {
      // The engine line wins material, so the tactic that does it is a fact worth naming.
      const motif = motifPhrase(f.fenBefore, f.uci, f.san);
      if (motif) return `${motif}, winning ${gainPhrase(net)}`;
      const line = trimmedLine(f.fenAfter, quick, x.m);
      return `wins ${gainPhrase(net)}${line ? ` (${line})` : ""}`;
    }
  }
  return describeMove(f.fenBefore, f.uci, f.san);
}

function bestProse(f, x) {
  const point = goodPoint(f, x);
  if (point) return `${pick(f, "best", ["Best move.", "Accurate.", "Exactly right.", "Good move."])} ${f.san} ${point}.`;
  return `${f.san} ${pick(f, "best-bare", ["is the best move here", "is spot on", "is exactly right", "is accurate", "is the right move"])}.`;
}

function goodProse(f, x) {
  const point = goodPoint(f, x);
  const alt = f.bestSan && !f.isBest ? ` ${f.bestSan} was slightly more precise.` : "";
  if (point) return `${pick(f, "good", ["Good.", "Fine move.", "Reasonable."])} ${f.san} ${point}.${alt}`;
  return `${f.san} is fine.${alt}`;
}

function greatProse(f, x) {
  const point = goodPoint(f, x);
  if (/^(wins|forces)/.test(point)) return `Great move! ${f.san} ${point}.`;
  // An only-move recapture or trade is necessary, not spectacular: say so plainly.
  if (/^(takes back|recaptures|trades|gives an? )/.test(point)) return `${f.san} ${point}; anything else loses ground.`;
  if (f.onlyMove) return `Great move! ${f.san} is the only move that holds${point ? `: it ${point}` : ""}.`;
  // Great from the Maia read: a hard or critical find, not necessarily the only move.
  const head = point
    ? `Great move! ${f.san} ${point}.`
    : `Great move! ${f.san} keeps the position together where most moves would not.`;
  const p = f.maia && Number.isFinite(f.maia.humanProb) ? Math.round(f.maia.humanProb * 100) : null;
  if (p === null || p > 35) return head;
  return `${head} ${p < 1 ? "Hardly anyone" : `Only about ${p}% of players`} at this level would play it.`;
}

function brilliantProse(f, x) {
  const point = goodPoint(f, x);
  const head = point ? `Brilliant! ${f.san} ${point}.` : `Brilliant! ${f.san} is a hidden resource.`;
  const p = f.maia && Number.isFinite(f.maia.humanProb) ? f.maia.humanProb : null;
  if (p === null) return head;
  const pct = Math.round(p * 100);
  const rarity = pct < 1 ? "Hardly anyone at this level would find it." : `Only about ${pct}% of players at this level would find it.`;
  return `${head} ${rarity}`;
}

// --- Errors ------------------------------------------------------------------

// "You were clearly better; now it's level." "" when the verdict didn't move.
function changeSentence(f, v) {
  const b0 = bucket(f.winBeforeMover);
  const b1 = bucket(f.winAfterMover);
  if (b1 >= b0) return ""; // two separate searches can disagree slightly; never narrate a gain
  if (b0 === 0) return `${cap(v.standing(b1))} now.`;
  return `${cap(v.standing(b0, true))}; now ${v.standing(b1)}.`;
}

// What should have been played and what it would have kept or won.
function betterSentence(f, x, v) {
  if (!f.bestSan || f.isBest) return "";
  if (f.hadMateBefore && Number.isFinite(f.mateBefore)) return `${f.bestSan} was the move, with ${mateCount(f.mateBefore)}.`;
  if (x.bestTakesBack) return `${f.bestSan} was the right way to take back.`;
  if (x.relValue >= 1 && x.bestNet !== null && x.bestNet >= 1) {
    const motif = motifPhrase(f.fenBefore, f.bestUci, f.bestSan);
    return `${f.bestSan} was the move, ${motif ? `${participle(motif)} and ` : ""}winning ${gainPhrase(netFor(x.best, x.m))}.`;
  }
  if (x.relValue >= 1) return `${f.bestSan} was the move, keeping the material.`;
  const b0 = bucket(f.winBeforeMover);
  if (b0 !== bucket(f.winAfterMover)) return `${f.bestSan} was the move, ${v.keeping(b0)}.`;
  return `${f.bestSan} was the move.`;
}

// "a trade of bishops" / "a bishop-for-knight trade" for an even exchange the reply starts.
function replyTrade(f, x) {
  if (!/x/.test(f.replySan || "")) return "";
  const after = lineOutcome(f.fenAfter, (f.playedPvUci || []).slice(1), { maxPlies: 6, first: true });
  if (!after || !after.quiet || netValue(netFor(after, x.m)) !== 0 || !hasCaptures(after)) return "";
  const phrase = tradePhrase(after, x.m);
  const same = /^trades (\w+)$/.exec(phrase);
  if (same) return `a trade of ${same[1]}`;
  const mixed = /^gives an? (\w+) for an? (\w+)$/.exec(phrase);
  return mixed ? `a ${mixed[1]}-for-${mixed[2]} trade` : "";
}

// The concrete consequence of an error, as a sentence. Mate first, then material against
// the better line, then the reply it allows and how the position changed.
function errorConsequence(f, x, v) {
  if (f.missedMate && f.bestSan) {
    const n = Number.isFinite(f.mateBefore) ? ` in ${Math.abs(f.mateBefore)}` : "";
    return { text: `${f.san} misses mate: ${f.bestSan} mates${n}.`, namedBest: true };
  }
  const alreadyMated = Number.isFinite(f.mateBefore) && !f.hadMateBefore;
  if (f.inMateNet && !alreadyMated) {
    const out = lineOutcome(f.fenBefore, f.playedPvUci || [], { maxPlies: 6 });
    const line = out ? numberLine(f.fenAfter, out.sans.slice(1, 4)) : "";
    return { text: `${f.san} allows ${mateCount(f.mateAfter)}${line ? `: ${line}` : ""}.` };
  }
  // Traded into opposite-coloured bishops while the better line avoids it.
  const playedEnd = x.played && x.played.quiet ? fenAfterLine(f.fenBefore, f.playedPvUci, x.played.plies) : null;
  const bestEnd = x.best && x.best.quiet ? fenAfterLine(f.fenBefore, f.bestPvUci, x.best.plies) : null;
  if (f.replySan && playedEnd && oppositeBishopsOnly(playedEnd) && !(bestEnd && oppositeBishopsOnly(bestEnd))) {
    const reply = numberLine(f.fenAfter, [f.replySan]);
    const change = changeSentence(f, v);
    return { text: `${f.san} allows ${reply} and a trade into opposite-coloured bishops, usually a draw.${change ? ` ${change}` : ""}` };
  }
  if (x.rel && x.relValue >= 1) {
    const lossText = () => {
      const lost = x.lost ? gainPhrase(x.lost) : "";
      if (!lost) return null;
      // Name the tactic the reply executes: a piece left hanging, or a fork / pin / skewer.
      const reply = f.replySan ? numberLine(f.fenAfter, [f.replySan]) : "";
      const hung = reply ? hangingCapture(f.fenAfter, f.replyUci) : null;
      if (hung && (x.lost[hung.type] || 0) >= 1) {
        const what = hung.square === f.uci?.slice(2, 4) ? `the ${PIECE_NAME[hung.type]}` : `the ${PIECE_NAME[hung.type]} on ${hung.square}`;
        return { text: `${f.san} hangs ${what} to ${reply}.` };
      }
      const motif = reply ? motifPhrase(f.fenAfter, f.replyUci, f.replySan) : "";
      if (motif) return { text: `${f.san} loses ${lost} to ${reply}, which ${motif}.` };
      const line = trimmedLine(f.fenAfter, x.played, x.opp, 6);
      return { text: `${f.san} loses ${lost}${line ? ` after ${line}` : ""}.` };
    };
    if (x.bestTakesBack) {
      const t = lossText();
      if (t) return t;
    } else if (x.bestNet !== null && x.bestNet >= 1 && f.bestSan) {
      const line = bestLineText(f, x.best, x.m);
      const gain = gainPhrase(netFor(x.best, x.m));
      const motif = motifPhrase(f.fenBefore, f.bestUci, f.bestSan);
      if (gain && motif) return { text: `${f.san} misses ${f.bestSan}, which ${motif} and wins ${gain}.`, namedBest: true };
      if (gain) return { text: `${f.san} misses ${f.bestSan}, which wins ${gain}${line && line.includes(" ") ? ` (${line})` : ""}.`, namedBest: true };
    } else if (x.playedNet !== null && x.playedNet < 0) {
      const t = lossText();
      if (t) return t;
    }
  }
  // Positional: name the reply the move allows, then how the verdict moved.
  let text;
  if (f.replySan) {
    const reply = numberLine(f.fenAfter, [f.replySan]);
    const trade = replyTrade(f, x);
    const did = trade ? "" : describeMove(f.fenAfter, f.replyUci, f.replySan);
    if (trade) text = `${f.san} allows ${reply} and ${trade}.`;
    else if (did && !/^takes the/.test(did)) text = `${f.san} allows ${reply}, which ${did}.`;
    else text = `${f.san} allows ${reply}.`;
  } else {
    text = `${f.san} isn't the right idea here.`;
  }
  const change = changeSentence(f, v);
  return { text: change ? `${text} ${change}` : text };
}

function errorProse(f, x, v) {
  const code = f.classification.code;
  const { text, namedBest } = errorConsequence(f, x, v);
  const better = namedBest ? "" : betterSentence(f, x, v);
  if (code === "inaccuracy") {
    // Gentler: a small slip only needs the fix and, if it tipped the balance, that.
    if (/ (loses|hangs|allows mate|misses)/.test(text)) return `${text}${better ? ` ${better}` : ""}`;
    const change = changeSentence(f, v);
    const fix = f.bestSan && !f.isBest ? ` ${f.bestSan} was better.` : "";
    return `${f.san} is slightly inaccurate.${fix}${change ? ` ${change}` : ""}`;
  }
  const lead = code === "blunder" ? "Blunder." : "Mistake.";
  return `${lead} ${text}${better ? ` ${better}` : ""}`;
}

// --- Entry -------------------------------------------------------------------

function buildProse(f, opts) {
  const v = makeVoice(f.mover, opts.selfSide || null);
  const code = f.classification.code;
  if (/#/.test(f.san || "")) return v.me === "you" ? "Checkmate. Well played." : "Checkmate.";
  if (code === "forced") return `${f.san} was the only legal move.`;
  const x = readFacts(f);
  if (code === "brilliant") return brilliantProse(f, x);
  if (code === "great") return greatProse(f, x);
  if (code === "best") return bestProse(f, x);
  if (code === "good") return goodProse(f, x);
  return errorProse(f, x, v);
}

// `features.opponentRead` (set by the Analyze coach on a game the user played)
// switches to the opponent's read below.
export function buildCommentary(features, opts = {}) {
  if (!features) return { tone: "info", grade: "", prose: "" };
  if (features.opponentRead) return buildOpponentCommentary(features, opts);
  return {
    tone: features.classification.tone,
    grade: features.classification.label,
    quality: features.classification.code,
    prose: buildProse(features, opts),
  };
}

// --- The opponent's move, read for the user ------------------------------------
//
// On a game the user played, the opponent's moves are not graded as if they were the
// user's: the read talks to the user about the move. A slip is a chance to punish
// (what it drops and the reply that takes it), a sound move is something to answer
// (what it does or threatens), and the read ends on the user's best answer and where
// that leaves them, said the way a coach beside the board would say it: "you", "they",
// never a colour name. Same facts as the user's own read: the engine line and the board.

const SLIP_WORD = { inaccuracy: "a small slip", mistake: "a mistake", blunder: "a blunder" };
const EDGE = { 3: "winning", 2: "clearly better", 1: "slightly better" };

// Pieces the opponent's move hits, takes, pins or skewers belong to the user:
// "attacks the pawn on e4" -> "attacks your pawn on e4", "pins the knight to the king" ->
// "pins your knight to your king". The mover's own piece ("develops the knight") keeps "the".
function yours(phrase) {
  const p = String(phrase || "");
  const whole = /^(pins|skewers) /.test(p) || /, (pinning|skewering) /.test(p);
  return whole
    ? p.replace(/\bthe (queen|rook|bishop|knight|pawn|king)\b/g, "your $1")
    : p.replace(/\bthe (queen|rook|bishop|knight|pawn) on /g, "your $1 on ").replace(/\bthe king\b/g, "your king");
}

// "takes the open g-file and gives check" -> "takes the open g-file with check".
function withCheck(phrase) {
  return String(phrase || "").replace(/^(.+) and gives check$/, "$1 with check");
}

// What the user's best reply threatens, as a participle clause (the pieces it hits are
// the opponent's, so they keep "the"): "forking the king and the rook on a8",
// "attacking the bishop on g4". "" when the reply threatens nothing concrete.
function replyPoint(f) {
  if (!f.replySan || !f.replyUci) return "";
  const motif = motifPhrase(f.fenAfter, f.replyUci, f.replySan);
  if (/^forks /.test(motif)) return participle(motif);
  const threat = threatPhrase(f.fenAfter, f.replyUci, f.replySan);
  if (!threat || threat === "gives check") return "";
  return threat.replace(/^(attack|hit|fork)s/, "$1ing").replace(/^gives check and hits/, "with check, hitting");
}

// Where the user stands, as a clause: "you're clearly better", "it's level",
// "they're slightly better", "you're losing". `u` is the user-POV bucket.
function standingClause(u) {
  if (u > 0) return `you're ${EDGE[u]}`;
  if (u === 0) return "it's level";
  if (u === -3) return "you're losing";
  return `they're ${EDGE[-u]}`;
}

// The user's answer to the move and where it leaves them. `afterSlip` = the opponent
// just erred, so the answer is a chance to take, not a problem to solve.
function answerSentence(f, afterSlip) {
  if (!f.replySan) return "";
  const reply = numberLine(f.fenAfter, [f.replySan]);
  if (Number.isFinite(f.mateAfter) && f.inMateNet) {
    const n = Math.abs(f.mateAfter);
    return n <= 1 ? `${reply} is mate.` : `${reply} forces mate in ${n}.`;
  }
  if (Number.isFinite(f.mateAfter) && f.hasMateAfter) return `${reply} holds out longest, but mate is coming.`;
  const u = bucket(100 - f.winAfterMover);
  const u0 = bucket(100 - f.winBeforeMover);
  const pt = replyPoint(f);
  const r = pt ? `${reply}, ${pt},` : reply;
  const rEnd = pt ? `${reply}, ${pt}` : reply;
  if (afterSlip) {
    if (u > 0 && u > u0) return `Punish it with ${r} and ${standingClause(u)}.`;
    if (u > 0) return `Your best reply is ${r} and you're still ${EDGE[u]}.`;
    if (u === 0 && u0 < 0) return `With ${rEnd} you're back to level.`;
    if (u === 0) return `Your best reply is ${rEnd}, and it's level.`;
    if (u > u0) return `Your best reply is ${rEnd}. You're still worse, but it's closer now.`;
    return `Your best reply is ${rEnd}, but ${standingClause(u)}.`;
  }
  if (u > 0) return `Answer with ${r} and you're ${u >= u0 ? "still " : ""}${EDGE[u]}.`;
  if (u === 0) return `Answer with ${r} and it's level.`;
  if (u === -3) return `${reply} is your most stubborn defence, but you're losing.`;
  return `Your best answer is ${rEnd}, but ${standingClause(u)}.`;
}

// The slip, in what it gives the user: mate, a hanging piece, material (with the tactic
// that wins it), a chance they missed, or just the position. `named` = the user's reply
// already appears in the text. Mirrors errorConsequence for the user's own moves.
function opponentSlip(f, x, san) {
  const reply = f.replySan ? numberLine(f.fenAfter, [f.replySan]) : "";
  const word = SLIP_WORD[f.classification.code];
  if (f.inMateNet && reply) {
    const finish = Math.abs(f.mateAfter) <= 1 ? `${reply} is mate.` : `It starts with ${reply}.`;
    return { text: `${san} walks into ${mateCount(f.mateAfter)}. ${finish}`, named: true };
  }
  if (f.missedMate && f.bestSan) return { text: `They had mate with ${f.bestSan} and missed it.`, named: false };
  const lost = x.rel && x.relValue >= 1 && x.playedNet !== null && x.playedNet < 0 && x.lost ? gainPhrase(x.lost) : "";
  // Taking back on the square the slip captured on is a trade, not a hanging piece.
  const recapture = /x/.test(f.san || "") && f.replyUci?.slice(2, 4) === f.uci?.slice(2, 4);
  const hung = reply && !recapture ? hangingCapture(f.fenAfter, f.replyUci) : null;
  if (hung && (!x.lost || (x.lost[hung.type] || 0) >= 1)) {
    return { text: `${san} leaves their ${PIECE_NAME[hung.type]} on ${hung.square} hanging. Take it with ${reply}.`, named: true };
  }
  if (lost) {
    // Name the tactic the user's reply executes when there is one: the engine line
    // confirms it wins material, so a fork / pin / skewer is a fact, not a guess.
    const motif = reply ? motifPhrase(f.fenAfter, f.replyUci, f.replySan) : "";
    if (motif) {
      // "forks the king and the rook on a8" already says what goes; only add the price when it doesn't.
      const said = motif.includes(lost.replace(/^an? /, ""));
      return { text: `${san} is ${word}. Now ${reply} ${motif}${said ? "" : ` and wins ${lost}`}.`, named: true };
    }
    const line = trimmedLine(f.fenAfter, x.played, x.opp, 6);
    if (line) return { text: `${san} gives you ${lost}. Pick it up with ${line}.`, named: true };
    return { text: `${san} gives you ${lost}.`, named: false };
  }
  // A chance they missed: their best move won material and the one played doesn't.
  if (f.bestSan && !f.isBest && x.rel && x.relValue >= 1 && x.bestNet !== null && x.bestNet >= 1) {
    const gain = gainPhrase(netFor(x.best, x.m));
    const motif = motifPhrase(f.fenBefore, f.bestUci, f.bestSan);
    if (gain) {
      const said = motif && motif.includes(gain.replace(/^an? /, ""));
      const how = motif ? `${yours(motif)}${said ? "" : ` and wins ${gain}`}` : `wins ${gain}`;
      return { text: `Lucky for you, they missed ${f.bestSan}, which ${how}.`, named: false };
    }
  }
  // Positional: nothing changes hands yet, so name the move they should have played.
  if (!f.bestSan || f.isBest) return { text: `${san} is ${word} from them.`, named: false };
  const fix = {
    inaccuracy: `${san} is a little loose. ${f.bestSan} was better for them.`,
    mistake: `${san} is a mistake. They should have played ${f.bestSan}.`,
    blunder: `${san} is a blunder. They had to play ${f.bestSan}.`,
  }[f.classification.code];
  return { text: fix, named: false };
}

// What a sound move by the opponent does, said for the user: the same point the user's
// own read would make (material won, a forced mate, a take-back, a trade, the threat),
// with the user's pieces called "your".
function opponentPoint(f, x) {
  const point = withCheck(goodPoint(f, x));
  // "takes back the bishop" / "trades rooks" name the piece that changed hands, not whose.
  return /^(takes back|recaptures|trades|gives)/.test(point) ? point : yours(point);
}

// One sentence on a sound move: what it does, with how good it was folded in.
function soundLead(f, san, point) {
  const code = f.classification.code;
  if (code === "brilliant") return point ? `That's a brilliant one from them. ${san} ${point}.` : `${san} is a brilliant find by them.`;
  if (code === "great") {
    if (f.onlyMove) return point ? `They found the only move. ${san} ${point}.` : `${san} was the only move, and they found it.`;
    return point ? `Strong move by them. ${san} ${point}.` : `${san} is a strong find by them.`;
  }
  if (code === "best") {
    return point
      ? pick(f, "opp-best", [`Good move by them. ${san} ${point}.`, `Well played by them. ${san} ${point}.`, `Nice one from them. ${san} ${point}.`])
      : pick(f, "opp-best-bare", [`${san} is accurate.`, `${san} is the best move here.`, `${san} is a good move by them.`]);
  }
  if (code === "good") return point ? `${san} ${point}.` : `${san} is a reasonable move.`;
  return point ? `${san} ${point}.` : `${san} is playable.`;
}

function opponentProse(f) {
  const code = f.classification.code;
  const san = numberLine(f.fenBefore, [f.san]);
  if (/#/.test(f.san || "")) return { tone: "danger", prose: `${san} is checkmate.` };
  if (code === "forced") return { tone: "info", prose: `${san} was forced. ${answerSentence(f, false)}`.trim() };
  const x = readFacts(f);
  if (SLIP_WORD[code]) {
    const { text, named } = opponentSlip(f, x, san);
    const answer = named ? "" : answerSentence(f, true);
    return { tone: "good", prose: answer ? `${text} ${answer}` : text };
  }
  // Their position is already lost: even their best try changes nothing, so the read is
  // the reply that keeps the win, not a grade of their defence.
  if (["best", "great", "good"].includes(code) && bucket(f.winAfterMover) <= -3) {
    const lead = code === "good" ? `${san} doesn't change much` : `${san} is their most stubborn try`;
    const reply = f.replySan ? numberLine(f.fenAfter, [f.replySan]) : "";
    const mate = Number.isFinite(f.mateAfter) && f.inMateNet ? answerSentence(f, false) : "";
    const tail = mate || (reply ? `Keep going with ${reply}.` : "");
    return { tone: "good", prose: `${lead}, but you're still winning.${tail ? ` ${tail}` : ""}` };
  }
  const point = opponentPoint(f, x);
  const threat = threatPhrase(f.fenBefore, f.uci, f.san);
  // A move that wins material, forces mate or hits a piece asks for an answer: say so in the tone.
  const forcing = /^(forces|wins)|mate/.test(point);
  const pressing = forcing || !!threat || /^takes your /.test(point);
  const tone = /^forces/.test(point) ? "danger" : pressing ? "warn" : "info";
  const lead = soundLead(f, san, point);
  const answer = answerSentence(f, false);
  return { tone, prose: answer ? `${lead} ${answer}` : lead };
}

// The opponent's move on a game the user played, read for the user.
export function buildOpponentCommentary(features, { selfSide } = {}) {
  if (!features || !selfSide) return { tone: "info", grade: "", prose: "" };
  const { tone, prose } = opponentProse(features);
  return { tone, grade: `Their ${features.classification.label.toLowerCase()}`, quality: features.classification.code, prose };
}
