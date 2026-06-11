// Commentary — turns a move's feature vector into something a human coach would say.
//
// The output is ONE short conversational paragraph (1–3 sentences) that points out
// the few things that matter about the move just played: what it was trying to do,
// the concrete consequence (named, with the line and the material at stake), and —
// when it went wrong — the better move and what it would have kept. No grades-as-data,
// no percentages, no bullet lists. Just a coach talking.
//
//   buildCommentary(features) -> { tone, grade, prose }
//     tone   — "good" | "warn" | "danger" | "brilliant" | "info" (for subtle colour)
//     grade  — human label of the move quality (kept for aria / optional display)
//     prose  — the sentence(s) to show
//
// Every clause traces to a computed fact in `features`. The actual WORDING comes from
// phrasebank.js: each "slot" (lead-in, hang description, punishing reply, recommended
// fix, ...) is a small bank of interchangeable templates, and `choose()` picks one per
// slot from a per-move-per-slot deterministic seed. Slots vary independently, so a
// handful of small banks compose into thousands of distinct sentences — same facts,
// different voice — while each bank stays short enough to tweak in isolation.
import { describeMove } from "../explain.js";
import { PIECE_NAME, materialPhrase } from "./material.js";
import { describeThreat, describeAnyThreat } from "./tactics.js";
import {
  choose,
  tailComma,
  tailDash,
  tailParen,
  MATE_DELIVERED,
  FORCED_MOVE,
  FORCED_CHECK,
  BRILLIANT_LEAD,
  LOOKS_HANGS,
  LOOKS_PLAIN,
  RARITY_TIER1,
  RARITY_TIER2,
  RARITY_TIER3,
  RARITY_TIER4,
  BRILLIANT_WHY,
  BLUNDER_LEAD,
  MISTAKE_LEAD,
  IN_MATE_NET,
  MISSED_MATE,
  HANG_DESC,
  HANG_PUNISH_WITH_REPLY,
  HANG_PUNISH_NO_REPLY,
  MISSED_WIN,
  OPENER_WITH_IDEA,
  LOSE_MATERIAL_VERB,
  LOSE_MATERIAL_TEMPLATE,
  PUNISH_WITH_REPLY_COUNT,
  PUNISH_NO_REPLY_COUNT,
  PHASE_HINT_OPENING,
  PHASE_HINT_MIDDLEGAME,
  PHASE_HINT_ENDGAME,
  STANDING_TAIL,
  INITIATIVE_WITH_PUNISH,
  INITIATIVE_NO_PUNISH,
  BETTER_MOVE,
  INACC_HEAD_WITH_IDEA,
  INACC_HEAD_PLAIN,
  INACC_CLEANER,
  INACC_FLIP,
  GREAT_DECISIVE,
  GREAT_ONLY_MOVE,
  LEAD_BEST,
  LEAD_GOOD,
  POINT_MATERIAL,
  POINT_TRADE,
  POINT_TRADE_AHEAD,
  POINT_TARGET,
  POINT_ENDGAME,
  STAND_TAIL,
  GOOD_SOLID,
  GOOD_THREAT_FORK,
  GOOD_THREAT_PIN,
  GOOD_THREAT_PIN_ABS,
  GOOD_THREAT_SKEWER,
  ERROR_OPP_THREAT_FORK,
  ERROR_OPP_THREAT_PIN,
  ERROR_OPP_THREAT_PIN_ABS,
  ERROR_OPP_THREAT_SKEWER,
  INTUITION_SLIP,
  INTUITION_HARD,
  INTUITION_OWN_PATH,
  INTUITION_AVOIDED,
  INTUITION_RICH_HANDLED,
  INTUITION_NATURAL,
} from "./phrasebank.js";

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

// ---------------------------------------------------------------------------
// Material read of the lines (mover-POV, in pawns).
// ---------------------------------------------------------------------------

// Net material the mover holds after the move, in pawns (mover-POV, + = ahead). Uses the
// exchange-resolved count so a move that captures into an even trade reads as level, not
// "a pawn up" (the recapture is already priced in). Falls back to the raw count if the
// settled figure is ever absent.
function moverMaterialAfter(f) {
  const after = Number.isFinite(f.materialAfterSettled) ? f.materialAfterSettled : f.materialAfter;
  return f.mover === "white" ? after : -after;
}

// Net material the mover held BEFORE the move, mover-POV, in pawns.
function moverMaterialBefore(f) {
  return f.mover === "white" ? f.materialBefore : -f.materialBefore;
}

// A capturing move whose settled material is unchanged from before — a clean, even
// trade. Leans on the exchange-resolved count so a recapture reads as a swap, not a
// phantom material gain. Returns false for a capture that actually wins or loses wood.
function isEvenTrade(f) {
  if (!/x/.test(f.san || "")) return false;
  return moverMaterialAfter(f) === moverMaterialBefore(f);
}

// Material the best line nets the mover over the move played (relative, honest). Compared
// at the SETTLED end of each line so two PVs that happen to stop at different points in a
// capture sequence don't read a phantom piece of difference between them.
function lineMaterialDiff(f) {
  const end = (line) => {
    if (!line) return null;
    const bal = Number.isFinite(line.settledEndBalance) ? line.settledEndBalance : line.endBalance;
    return f.mover === "white" ? bal : -bal;
  };
  const b = end(f.bestLine);
  const p = end(f.playedLine);
  if (b === null || p === null) return null;
  return b - p;
}

// Pawns the mover actually drops over the line they played (best play by both sides from
// the engine's PV), measured on the exchange-resolved swing so a clean recapture doesn't
// register as a loss. 0 when the line is materially level — the "positional" case where
// the cost is initiative, not wood. This is the "loses two pawns" number.
function playedLineLoss(f) {
  if (!f.playedLine) return 0;
  const swing = Number.isFinite(f.playedLine.settledSwing)
    ? f.playedLine.settledSwing
    : f.playedLine.swing;
  const swingMover = f.mover === "white" ? swing : -swing;
  // swing/settledSwing are differences of materialBalance() sums, which add up whole
  // PIECE_VALUE points — always an integer. Math.round is just a defensive guard
  // against future fractional piece values, not a real rounding step today.
  return swingMover < 0 ? Math.round(-swingMover) : 0;
}

// ---------------------------------------------------------------------------
// Move-idea narration — what a move *does*, reusing the motif detector. We split
// describeMove()'s comma-joined clauses and keep the "idea" tail (the consequence),
// dropping the bare relocation/capture clause the SAN already encodes.
// ---------------------------------------------------------------------------

function moveClauses(fen, uci, san) {
  const d = describeMove(fen, uci, san) || "";
  return d
    .split(", ")
    .map((s) => s.trim())
    .filter(Boolean);
}

const RELOCATION_RE = /^(develops|brings|pushes|takes|castles|fianchettoes|promotes)\b/;

// Drop the leading bare relocation/capture (the SAN already says "piece to square"),
// keep what the move accomplishes: "forking the rook and queen", "with check",
// "claiming the centre", "and now eyes the bishop on c4".
function ideaTail(clauses) {
  if (!clauses.length) return "";
  return RELOCATION_RE.test(clauses[0]) ? clauses.slice(1).join(", ") : clauses.join(", ");
}

// The value-add idea of the move just played (no "piece to square" — the SAN has it).
function moveIdea(f) {
  return ideaTail(moveClauses(f.fenBefore, f.uci, f.san));
}

// "Nf3, with an eye on the centre" / "Kf2" — SAN, plus the idea when there is one.
function gistOf(f) {
  const idea = moveIdea(f);
  return idea ? `${f.san}, ${idea}` : f.san;
}

// ---------------------------------------------------------------------------
// The refutation — the opponent's reply, named with its own idea.
// ---------------------------------------------------------------------------

// "after Nxc4, forking the queen and rook," — reply SAN plus the threat it sets up,
// folded into a sentence (lowercase-start, trailing comma). "" when there's no reply.
function replyWithTail(f) {
  if (!f.replySan) return "";
  const tail = ideaTail(moveClauses(f.fenAfter, f.replyUci, f.replySan));
  return tail ? `after ${f.replySan}, ${tail},` : `after ${f.replySan},`;
}

// The opponent's standing after the move (used when a move goes wrong).
function oppStanding(f) {
  return standingWord(100 - f.winAfterMover);
}

// ---------------------------------------------------------------------------
// The better move — what to play instead, and what it would have kept.
// ---------------------------------------------------------------------------

// A short clause for the recommended move's material payoff: keeps material it dropped,
// wins material outright, or "" when the gain isn't about wood.
function betterPayoff(f) {
  const diff = lineMaterialDiff(f);
  if (diff !== null && diff >= 2) {
    const phrase = materialPhrase(diff);
    const playedEnd =
      f.playedLine && Number.isFinite(f.playedLine.settledEndBalance)
        ? f.playedLine.settledEndBalance
        : f.playedLine && f.playedLine.endBalance;
    const droppedMaterial =
      f.playedLine && (f.mover === "white" ? playedEnd : -playedEnd) <= -1;
    if (phrase) return droppedMaterial ? `, saving ${phrase}` : `, winning ${phrase}`;
  }
  return "";
}

// What the best move *keeps* in positional terms — the standing the engine's top line
// holds for the mover (winBeforeMover is that line's win%). Used when the gain isn't a
// clean material count: "keeping White clearly better", "holding the balance".
function meritStanding(f) {
  const w = f.winBeforeMover;
  const me = sideWord(f.mover);
  if (w >= 57) return `keeping ${me} ${standingWord(w)}`;
  if (w > 43) return "holding the balance";
  if (w > 32) return `keeping ${me} in the game`;
  return "limiting the damage";
}

// The trailing clause on a "X was the move" recommendation: material payoff if there is
// one, otherwise what the move keeps.
function betterMerit(f) {
  return betterPayoff(f) || `, ${meritStanding(f)}`;
}

// ---------------------------------------------------------------------------
// Brilliant — grounded in the Maia/Stockfish disagreement, not just a label.
// ---------------------------------------------------------------------------

// "It's mate in 3." / "It's mate next move." when the move just played forces mate.
function mateInClause(f) {
  if (!f.hasMateAfter || !Number.isFinite(f.mateAfter)) return "";
  const n = Math.abs(f.mateAfter);
  return n <= 1 ? " It's mate next move." : ` It's mate in ${n}.`;
}

// The grounded "why" behind a Brilliant call: how rarely a human finds it, and how
// differently a human model reads the position — the actual Maia/Stockfish gap.
function brilliantWhyClause(f, me) {
  const mate = mateInClause(f);
  if (!f.maia || !Number.isFinite(f.maia.humanProb) || !Number.isFinite(f.maia.winChanceAfter)) {
    return mate;
  }
  const p = f.maia.humanProb;
  const rarityBank = p < 0.01 ? RARITY_TIER1 : p < 0.03 ? RARITY_TIER2 : p < 0.06 ? RARITY_TIER3 : RARITY_TIER4;
  const rarity = choose(f, "rarity", rarityBank, {});
  const maiaStand = standingWord(f.maia.winChanceAfter * 100);
  const why = choose(f, "brilliantWhy", BRILLIANT_WHY, { rarityCap: cap(rarity), maiaStand, me });
  return ` ${why}${mate}`;
}

// ---------------------------------------------------------------------------
// Tactics — the concrete motif a move creates, or the one it hands the opponent.
// ---------------------------------------------------------------------------

function moverLetter(f) {
  return f.mover === "white" ? "w" : "b";
}
function oppLetter(f) {
  return f.mover === "white" ? "b" : "w";
}

// A leading-space sentence naming the tactic the move just played creates (fork / pin /
// skewer), for a strong move's "why". "" when the move makes no concrete threat.
function threatPoint(f, me, opp) {
  const motif = describeThreat(f.fenAfter, f.uci, moverLetter(f));
  if (!motif) return "";
  if (motif.kind === "fork") return choose(f, "goodForkThreat", GOOD_THREAT_FORK, { targets: motif.targets, me, opp });
  if (motif.kind === "skewer")
    return choose(f, "goodSkewerThreat", GOOD_THREAT_SKEWER, { front: motif.front, back: motif.back, me, opp });
  if (motif.kind === "pin") {
    const bank = motif.absolute ? GOOD_THREAT_PIN_ABS : GOOD_THREAT_PIN;
    return choose(f, "goodPinThreat", bank, { front: motif.front, back: motif.back, me, opp });
  }
  return "";
}

// A leading-space sentence naming the tactic a weak move hands the opponent. "" when
// there's nothing concrete to point at.
function oppThreatClause(f, opp) {
  const motif = describeAnyThreat(f.fenAfter, oppLetter(f));
  if (!motif) return "";
  if (motif.kind === "fork") return choose(f, "oppForkThreat", ERROR_OPP_THREAT_FORK, { targets: motif.targets, opp });
  if (motif.kind === "skewer")
    return choose(f, "oppSkewerThreat", ERROR_OPP_THREAT_SKEWER, { front: motif.front, back: motif.back, opp });
  if (motif.kind === "pin") {
    const bank = motif.absolute ? ERROR_OPP_THREAT_PIN_ABS : ERROR_OPP_THREAT_PIN;
    return choose(f, "oppPinThreat", bank, { front: motif.front, back: motif.back, opp });
  }
  return "";
}

// ---------------------------------------------------------------------------
// Intuition — the position's texture (from Maia) crossed with the move's quality. A
// trailing sentence that explains WHY a move went the way it did: a slip in an obvious
// spot, a hard choice in a rich one, an inventive path, a trap dodged. "" when there's no
// Maia read (it arrives async) or the texture adds nothing to this particular move.
// ---------------------------------------------------------------------------
// A position that is sharp FOR ITS PHASE (top quartile/decile of the WDL sharpness band) —
// the honest "easy to mess up" read that policy entropy got wrong (many calm options also
// spread the policy). "lively" or "sharp" both count as worth flagging.
function isSharp(intu) {
  const s = intu && intu.sharpness;
  return !!s && (s.band === "sharp" || s.band === "lively");
}

function intuitionNote(f) {
  const intu = f.intuition;
  if (!intu) return "";
  const code = f.classification.code;
  const isError = code === "blunder" || code === "mistake" || code === "inaccuracy";
  const isGood = code === "best" || code === "good" || code === "great";

  if (isError) {
    // Obvious position, the natural move was best, you played something else: a slip.
    if (intu.texture === "obvious" && intu.obviousIsBest && !intu.playedWasObvious && intu.obviousSan) {
      return choose(f, "intuSlip", INTUITION_SLIP, { obviousSan: intu.obviousSan });
    }
    // Sharp-for-its-phase position: a sympathetic "this was genuinely hard".
    if (isSharp(intu)) return choose(f, "intuHard", INTUITION_HARD, {});
    return "";
  }

  if (isGood) {
    // The human-obvious move wasn't best, and you played the engine's best instead.
    if (
      (code === "best" || code === "great") &&
      intu.texture === "obvious" &&
      !intu.obviousIsBest &&
      !intu.playedWasObvious &&
      intu.obviousSan
    ) {
      return choose(f, "intuAvoided", INTUITION_AVOIDED, { obviousSan: intu.obviousSan, san: f.san });
    }
    // Obvious position, but you found a strong move humans rarely pick: your own path.
    if (intu.texture === "obvious" && intu.surprise && !intu.playedWasObvious && intu.obviousSan) {
      return choose(f, "intuOwnPath", INTUITION_OWN_PATH, { obviousSan: intu.obviousSan, san: f.san });
    }
    // A sharp position navigated well.
    if (isSharp(intu)) return choose(f, "intuRichGood", INTUITION_RICH_HANDLED, { san: f.san });
    // An obvious position, played the obvious move: natural and correct (kept mild).
    if (intu.texture === "obvious" && intu.playedWasObvious) {
      return choose(f, "intuNatural", INTUITION_NATURAL, {});
    }
    return "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// The prose.
// ---------------------------------------------------------------------------

function buildProse(f) {
  const me = sideWord(f.mover);
  const opp = oppWord(f.mover);
  const code = f.classification.code;

  // Checkmate delivered — the SAN already carries the '#'.
  if (/#/.test(f.san)) {
    return choose(f, "mateDelivered", MATE_DELIVERED, { san: f.san });
  }

  // Forced — only one legal move existed. State that plainly; there was nothing to find
  // and nothing to fault, so no praise and no grade-shaming.
  if (code === "forced") {
    const bank = f.wasInCheck ? FORCED_CHECK : FORCED_MOVE;
    return choose(f, "forced", bank, { san: f.san });
  }

  // Brilliant — the engine loves it, humans wouldn't find it (Maia disagreement).
  if (code === "brilliant") {
    const stand = standingWord(f.winAfterMover);
    const looks = f.hangingOwnTop
      ? choose(f, "looksHangs", LOOKS_HANGS, { piece: PIECE_NAME[f.hangingOwnTop.type] })
      : choose(f, "looksPlain", LOOKS_PLAIN, {});
    const lead = choose(f, "brilliantLead", BRILLIANT_LEAD, { san: f.san, looks, looksCap: cap(looks), me, stand });
    return `${lead}${brilliantWhyClause(f, me)}`;
  }

  // Blunder / mistake — say what broke and (when there's a clean fix) what to play.
  if (code === "blunder" || code === "mistake") {
    const lead = choose(f, "lead", code === "blunder" ? BLUNDER_LEAD : MISTAKE_LEAD, {});

    let why;
    let namedBetterAlready = false;
    let quiet = false; // a quiet error — the place a "now the opponent threatens X" fits

    if (f.inMateNet && f.replySan) {
      // Walking into a forced mate — the heaviest consequence there is.
      const tail = ideaTail(moveClauses(f.fenAfter, f.replyUci, f.replySan));
      const extra = tail ? `${tail}, and ` : "";
      why = choose(f, "inMateNet", IN_MATE_NET, { san: f.san, reply: f.replySan, extra, opp });
    } else if (f.missedMate && f.bestSan) {
      // A forced mate was on the board and the move stepped past it.
      why = choose(f, "missedMate", MISSED_MATE, { me, bestSan: f.bestSan });
      namedBetterAlready = true;
    } else if (f.hangingOwnTop && f.hangingOwnTop.worth >= 3) {
      // Hangs a piece outright — name it, the punishment, and the resulting standing.
      const piece = PIECE_NAME[f.hangingOwnTop.type];
      const sq = f.hangingOwnTop.square;
      const desc = choose(f, "hangDesc", HANG_DESC, { san: f.san, piece, sq });
      const standing = oppStanding(f);
      const punish = f.replySan
        ? choose(f, "hangPunish", HANG_PUNISH_WITH_REPLY, { reply: f.replySan, opp, standing })
        : choose(f, "hangPunishNo", HANG_PUNISH_NO_REPLY, { opp, standing });
      why = `${desc}. ${punish}`;
    } else if (f.missedWin && f.looseBefore[0] && f.bestSan) {
      // Left a free piece on the board and didn't take it.
      const t = f.looseBefore[0];
      why = choose(f, "missedWin", MISSED_WIN, {
        san: f.san,
        piece: PIECE_NAME[t.type],
        sq: t.square,
        bestSan: f.bestSan,
      });
      namedBetterAlready = true;
    } else {
      // Quiet error: no single piece hangs, but the line still costs something. Lead
      // with what the move was trying to do, then the concrete cost — material if the
      // forcing line wins it, otherwise the initiative.
      quiet = true;
      const idea = moveIdea(f);
      const opener = idea ? choose(f, "opener", OPENER_WITH_IDEA, { san: f.san, idea }) : f.san;
      const loss = playedLineLoss(f);
      if (loss >= 1 && materialPhrase(loss)) {
        const phrase = materialPhrase(loss);
        const replyTail = ideaTail(moveClauses(f.fenAfter, f.replyUci, f.replySan));
        const punish = f.replySan
          ? choose(f, "punishCount", PUNISH_WITH_REPLY_COUNT, {
              reply: f.replySan,
              opp,
              phrase,
              tailComma: tailComma(replyTail),
              tailDash: tailDash(replyTail),
              tailParen: tailParen(replyTail),
            })
          : choose(f, "punishCountNo", PUNISH_NO_REPLY_COUNT, { opp, phrase });
        const verb = choose(f, "loseVerb", LOSE_MATERIAL_VERB, {});
        why = choose(f, "loseTemplate", LOSE_MATERIAL_TEMPLATE, { opener, verb, punish });
      } else {
        const phaseBank =
          f.phase === "opening" ? PHASE_HINT_OPENING : f.phase === "endgame" ? PHASE_HINT_ENDGAME : PHASE_HINT_MIDDLEGAME;
        const phaseHint = choose(f, "phaseHint", phaseBank, {});
        const standing = oppStanding(f);
        const standingTail = choose(f, "standingTail", STANDING_TAIL, { opp, standing });
        if (f.replySan) {
          const punish = replyWithTail(f);
          why = choose(f, "initiativeWith", INITIATIVE_WITH_PUNISH, {
            opener,
            phaseHint,
            punish,
            punishCap: cap(punish),
            standingTail,
            opp,
            standing,
          });
        } else {
          why = choose(f, "initiativeNo", INITIATIVE_NO_PUNISH, {
            opener,
            phaseHint,
            standingTail,
            standingTailCap: cap(standingTail),
            opp,
            standing,
          });
        }
      }
    }

    // On a quiet error, spell out the concrete tactic it hands the opponent, if any —
    // the "this lets Black fork the rook and king" the read was missing.
    const consequence = quiet ? oppThreatClause(f, opp) : "";

    // Only name a "better move" when we haven't already named one inside `why`.
    const better =
      !namedBetterAlready && f.bestSan && !f.isBest
        ? ` ${choose(f, "betterMove", BETTER_MOVE, { bestSan: f.bestSan, merit: betterMerit(f) })}`
        : "";
    return `${lead} ${why}${consequence}${better}${intuitionNote(f)}`;
  }

  // Inaccuracy — gentle; mention the cleaner move, and flag it if it actually flipped
  // who's better (a "small" slip that changes the verdict is worth knowing about).
  if (code === "inaccuracy") {
    const idea = moveIdea(f);
    const head = idea
      ? choose(f, "inaccHead", INACC_HEAD_WITH_IDEA, { san: f.san, idea })
      : choose(f, "inaccHeadPlain", INACC_HEAD_PLAIN, { me });
    const cleaner =
      f.bestSan && !f.isBest
        ? choose(f, "inaccCleaner", INACC_CLEANER, { bestSan: f.bestSan, payoff: betterPayoff(f) })
        : "";
    const flip =
      f.winAfterMover < 50
        ? choose(f, "inaccFlip", INACC_FLIP, { opp, me, standing: standingWord(f.winAfterMover) })
        : "";
    return `${head}${cleaner}${flip}${intuitionNote(f)}`;
  }

  // Great — far and away the best move. Two flavours: a decisive winning blow, or the
  // single move that holds a difficult position together. Pick the words to fit which.
  if (code === "great") {
    const up = moverMaterialAfter(f);
    const mate = mateInClause(f);
    if (/x/.test(f.san) && up >= 3 && materialPhrase(up)) {
      return choose(f, "greatDecisive", GREAT_DECISIVE, { san: f.san, phrase: materialPhrase(up), me }) + mate + intuitionNote(f);
    }
    const threat = mate ? "" : threatPoint(f, me, opp);
    const stand =
      !mate && !threat && f.winAfterMover >= 57
        ? choose(f, "greatStand", STAND_TAIL, { me, standing: standingWord(f.winAfterMover) })
        : "";
    return choose(f, "greatOnly", GREAT_ONLY_MOVE, { san: f.san, me }) + (mate || threat || stand) + intuitionNote(f);
  }

  // Best / good — keep it warm and short, with one positive, factual point. A forced
  // mate trumps everything; then a concrete tactic the move sets up (fork/pin/skewer);
  // then material, a pressured target, the endgame edge, the standing, and failing all
  // that a plain word on why it's sound — so even a quiet good move gets a "because".
  const lead = code === "best" ? choose(f, "leadBest", LEAD_BEST, {}) : choose(f, "leadGood", LEAD_GOOD, {});

  const gist = gistOf(f);
  const up = moverMaterialAfter(f);
  const target = f.looseAfter[0];
  const mate = mateInClause(f);
  let point = "";
  if (mate) {
    point = mate;
  } else if (threatPoint(f, me, opp)) {
    point = threatPoint(f, me, opp);
  } else if (/x/.test(f.san) && up >= 1 && materialPhrase(up)) {
    point = choose(f, "pointMaterial", POINT_MATERIAL, { me, phrase: materialPhrase(up) });
  } else if (isEvenTrade(f)) {
    point =
      up >= 2
        ? choose(f, "pointTradeAhead", POINT_TRADE_AHEAD, { me })
        : choose(f, "pointTrade", POINT_TRADE, { me });
  } else if (target && target.worth >= 3) {
    point = choose(f, "pointTarget", POINT_TARGET, { piece: PIECE_NAME[target.type], sq: target.square });
  } else if (f.phase === "endgame" && up >= 1 && materialPhrase(up)) {
    point = choose(f, "pointEndgame", POINT_ENDGAME, { phrase: materialPhrase(up) });
  } else if (f.winAfterMover >= 68) {
    point = choose(f, "standTailGood", STAND_TAIL, { me, standing: standingWord(f.winAfterMover) });
  } else if (isSharp(f.intuition)) {
    // A position that's sharp for its phase (WDL sharpness band): don't reach for the bland
    // "keeps it simple and sound" line — that's the "calls a knife-fight stable" misread.
    // Let the intuition note below ("a sharp, many-sided position...") carry the point.
    point = "";
  } else {
    point = choose(f, "goodSolid", GOOD_SOLID, {});
  }
  return `${lead} ${gist}.${point}${intuitionNote(f)}`;
}

export function buildCommentary(features) {
  if (!features) return { tone: "info", grade: "", prose: "" };
  return {
    tone: features.classification.tone,
    grade: features.classification.label,
    prose: buildProse(features),
  };
}
