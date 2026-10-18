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
  playUci,
} from "./move-facts.js";
import { motifPhrase, participle } from "./motifs.js";
import { Chess } from "chess.js";
import { why } from "./why/index.js";
import { PIECE_VALUE } from "./material.js";
import { soundReason, reasonPhrase } from "./reasons.js";

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

// Everything the wording needs, computed once.
function readFacts(f) {
  const m = f.mover === "white" ? "w" : "b";
  const own = /x/.test(f.san || "") ? lineOutcome(f.fenBefore, f.playedPvUci || [], { maxPlies: 6, first: true }) : null;
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
  return { m, own, prevWasCapture, recapture };
}

// The engine line to mate, numbered: "20...Nd4+ 21.Kd2 Qc2+ 22.Ke1 Qc1#". `fen` is where
// `ucis` starts; "" unless the line really ends in mate within eight moves.
function mateLine(fen, ucis, mate) {
  const n = Math.abs(Number(mate) || 0);
  if (!n || 2 * n - 1 > 8 || !ucis || ucis.length < 2 * n - 1) return "";
  const b = new Chess(fen);
  const sans = [];
  for (const u of ucis.slice(0, 2 * n - 1)) {
    const mv = playUci(b, u);
    if (!mv) return "";
    sans.push(mv.san);
  }
  return sans.length === 2 * n - 1 && sans[sans.length - 1].endsWith("#") ? numberLine(fen, sans) : "";
}

// The mover is already being mated, whatever they play.
function lostAnyway(f) {
  return f.inMateNet && Number.isFinite(f.mateBefore) && !f.hadMateBefore;
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
// "trades rooks", "develops the knight", "defends the pawn on b7"), or "". `words` names
// whose pieces a proven reason talks about (see reasonPhrase).
export function goodPoint(f, x, words) {
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
  return describeMove(f.fenBefore, f.uci, f.san) || reasonPhrase(soundReason(f), words);
}

function bestProse(f, x) {
  const point = goodPoint(f, x);
  // An only move without the Maia read that would make it Great: say it was necessary.
  if (f.onlyMove) {
    if (/^(takes back|recaptures|trades|gives an? )/.test(point)) return `${f.san} ${point}; anything else loses ground.`;
    return `${f.san} is the only move that holds${point ? `: it ${point}` : ""}.`;
  }
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

// One reason, picked by the frozen selector from the facts of both engine lines (why/).
function errorProse(f) {
  return why({
    fen: f.fenBefore, grade: f.classification.code, played: f.playedPvUci, best: f.bestPvUci,
    before: { cp: f.evalBeforeCp, mate: f.mateBefore }, after: { cp: f.evalAfterCp, mate: f.mateAfter },
  });
}

// --- Entry -------------------------------------------------------------------

function buildProse(f, opts) {
  const v = makeVoice(f.mover, opts.selfSide || null);
  const code = f.classification.code;
  if (/#/.test(f.san || "")) return v.me === "you" ? "Checkmate. Well played." : "Checkmate.";
  if (code === "forced") return `${f.san} was the only legal move.`;
  if (lostAnyway(f)) return `Nothing helps here: ${mateCount(f.mateAfter)} is coming whatever ${v.me === "you" ? "you play" : `${v.me} plays`}.`;
  const x = readFacts(f);
  if (f.inMateNet && !["inaccuracy", "mistake", "blunder"].includes(code)) {
    const line = mateLine(f.fenAfter, (f.playedPvUci || []).slice(1), f.mateAfter);
    const alt = f.bestSan && !f.isBest ? ` ${f.bestSan} held out longer.` : "";
    return `${f.san} allows ${mateCount(f.mateAfter)}${line ? `: ${line}` : ""}.${alt}`;
  }
  if (code === "brilliant") return brilliantProse(f, x);
  if (code === "great") return greatProse(f, x);
  if (code === "best") return bestProse(f, x);
  if (code === "good") return goodProse(f, x);
  return errorProse(f);
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

const SLIPS = new Set(["inaccuracy", "mistake", "blunder"]);
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
    if (u === 0 && u0 < 0) return `With ${r} you're back to level.`;
    if (u === 0) return `Your best reply is ${rEnd}, and it's level.`;
    if (u > u0) return `Your best reply is ${rEnd}. You're still worse, but it's closer now.`;
    return `Your best reply is ${rEnd}, but ${standingClause(u)}.`;
  }
  if (u > 0) return `Answer with ${r} and you're ${u >= u0 ? "still " : ""}${EDGE[u]}.`;
  if (u === 0) return `Answer with ${r} and it's level.`;
  if (u === -3) return `${reply} is your most stubborn defence, but you're losing.`;
  return `Your best answer is ${rEnd}, but ${standingClause(u)}.`;
}

// The opponent's slip: a mate they walked into or missed, else the same reason the user's
// own error would get (why/). `named` = the user's reply already appears in the text.
function opponentSlip(f) {
  const reply = f.replySan ? numberLine(f.fenAfter, [f.replySan]) : "";
  if (f.inMateNet && reply) {
    const finish = Math.abs(f.mateAfter) <= 1 ? `${reply} is mate.` : `It starts with ${reply}.`;
    return { text: `${numberLine(f.fenBefore, [f.san])} walks into ${mateCount(f.mateAfter)}. ${finish}`, named: true };
  }
  if (f.missedMate && f.bestSan) return { text: `They had mate with ${f.bestSan} and missed it.`, named: false };
  const text = errorProse(f);
  return { text, named: !!reply && text.includes(reply) };
}

// What a sound move by the opponent does, said for the user: the same point the user's
// own read would make (material won, a forced mate, a take-back, a trade, the threat),
// with the user's pieces called "your".
function opponentPoint(f, x) {
  const point = withCheck(goodPoint(f, x, { mine: "their", theirs: "your" }));
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
  if (SLIPS.has(code)) {
    const { text, named } = opponentSlip(f);
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
  const point = opponentPoint(f, readFacts(f));
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
