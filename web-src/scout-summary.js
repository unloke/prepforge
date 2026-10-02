// Scout v2 — natural-language readouts from scout-stats output only.
import { choose } from "./coach/voice.js";
import { scoutLineText } from "./scout.js";

// {qualifier} is either "" or " (low confidence)" — never wrap it in more
// parentheses, or a confident read prints an empty "()".
const COLOR_PICK = [
  "If you can choose, take {pick}: {name} scores {weakScore}% with {weak} and {otherScore}% with {other}{qualifier}.",
  "Better for you: {pick}. {name} scores {weakScore}% with {weak}, {otherScore}% with {other}{qualifier}.",
];

const COLOR_EVEN = [
  "No colour preference: {name} scores about the same with White and Black{qualifier}.",
  "{name} scores similarly with either colour, so neither side is a clear edge for you{qualifier}.",
];

// With the actual numbers: a 49% vs 44% split over hundreds of games is within
// normal variation, and saying so beats "take White".
const COLOR_EVEN_NUMBERS = [
  "No clear colour edge: {name} scores {w}% with White and {b}% with Black — a gap that size is normal variation{qualifier}.",
];

const COLOR_INSUFFICIENT = [
  "Too few games to compare colours ({name}: {wN} with White, {bN} with Black).",
];

const PREDICTABLE = [
  "Opens predictably: 1.{san} in {pct}% of games{qualifier}.",
  "First move is usually 1.{san} ({pct}%{qualifier}).",
];

const UNPREDICTABLE = [
  "Varied first moves ({label}{qualifier}).",
  "Hard to guess the first move ({label}{qualifier}).",
];

const REPERTOIRE_FRESH = [
  "New lately: {line} in {n} of their last {recent} games, almost never before{qualifier}.",
];

const FRESH_LINE = [
  "New line lately: {line} in {n} of their last {recent} games, almost never before{qualifier}.",
];

const REPERTOIRE_SHIFT = [
  "Opening mix is {trend} — {label}{qualifier}.",
  "First-move repertoire {trend}: {label}{qualifier}.",
];

const PERSONA_SYSTEM = [
  "Often plays a {system} setup{qualifier}.",
  "Favours a {system} structure{qualifier}.",
];

const PERSONA_STYLE = [
  "Style: {clause}{qualifier}.",
  "Tends toward {clause}{qualifier}.",
];

const THEORY_DEVIATION = [
  "Overplays {move} vs theory ({opp}% vs {book}% in masters{qualifier}).",
  "Plays {move} more than the book ({opp}% vs {book}%{qualifier}).",
];

const RARE_WEAPON = [
  "Rare weapon: {move} scores {score}% ({opp}% of games, {book}% in masters{qualifier}).",
  "Off-book success: {move} at {score}% ({opp}% share, masters {book}%{qualifier}).",
];

const OFF_BOOK = [
  "Leaves the book often ({share}% of probed games via {move}{qualifier}).",
  "Off-book choices in {share}% of sampled games ({move}{qualifier}).",
];

const ENGINE_WORST = [
  "Engine leak: 1.{san} averages {acpl} cp loss (first inaccuracy ~ply {ply}{qualifier}).",
  "Highest ACPL in 1.{san}: {acpl} cp, inaccuracy around ply {ply}{qualifier}.",
];

// The branch ends on YOUR move: you can steer into it.
const HEADLINE_BRANCH_STEER = [
  "Steer toward {line}: {name} scores {score}% there over {n} games, against {base}% overall.",
];

// The branch ends on THEIR move: their own choice, where they do worse.
const HEADLINE_BRANCH_WEAK = [
  "Weak spot: after {line} {name} scores {score}% over {n} games, against {base}% overall.",
];

const NOTE_BRANCH_WEAK = [
  "Also below their average: {line} ({score}% over {n} games).",
];

const NOTE_BRANCH_STRONG = [
  "Their best ground: {line} ({score}% over {n} games, {base}% overall). Have your answer ready.",
];

const HEADLINE_ATTACK = [
  "{predictable} — hit them in {line} where they score {score}% over {n} games.",
  "{predictable}: punish {line} ({score}% over {n} games).",
];

const HEADLINE_WEAPON = [
  "{predictable} — have a solid answer to {line} ({share}% of games).",
  "Main weapon {line} ({share}% share) — prepare your reply.",
];

const AGGRESSION_PHRASE = {
  aggressive: "aggressive, attacking play",
  passive: "quiet, positional play",
  balanced: "a balanced approach",
};
const CASTLING_PHRASE = {
  uncastled: "an often-uncastled king",
  late: "late castling",
  kingside: "kingside castling",
  queenside: "queenside castling",
};
const TRADE_PHRASE = {
  simplifier: "early queen trades",
  complicator: "queens kept on the board",
  balanced: "even-paced queen trades",
};

function personaClause(persona) {
  const parts = [
    AGGRESSION_PHRASE[persona.aggression?.label] || "a balanced approach",
    CASTLING_PHRASE[persona.castling?.label] || "flexible castling",
    TRADE_PHRASE[persona.tradeSpeed?.label] || "even-paced queen trades",
  ];
  return `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
}

function qualifier(conf) {
  if (!conf || conf.level === "none") return "";
  if (conf.level === "low") return " (low confidence)";
  if (conf.level === "medium") return " (moderate confidence)";
  return "";
}

function predictableLabel(predict, persona) {
  const top = predict?.topMove;
  if (!top) return "Varied opener";
  const pct = Math.round((top.share || 0) * 100);
  const system = persona?.systemSetup?.detected
    ? persona.systemSetup.name || persona.systemSetup.label
    : null;
  if (system) return `Predictable 1.${top.san} ${system} player`;
  if (predict.label === "predictable") return `Predictable 1.${top.san} player (${pct}%)`;
  return `Mostly 1.${top.san} (${pct}%)`;
}

const pctOf = (share) => Math.round((share || 0) * 100);

// What they play on their first decision, in one phrase:
//   White: "1.d4 (49%) or 1.e4 (48%)"
//   Black: "1…c5 to 1.e4 (70%), 1…d5 to 1.d4 (82%)"
export function expectationText(choices) {
  const groups = choices?.groups || [];
  if (!groups.length) return "";
  if (choices.color !== "black") {
    const picked = [];
    let covered = 0;
    for (const reply of groups[0].replies) {
      if (picked.length && (covered >= 0.8 || reply.share < 0.1 || picked.length >= 3)) break;
      picked.push(`1. ${reply.san} (${pctOf(reply.share)}%)`);
      covered += reply.share;
    }
    return picked.join(" or ");
  }
  return groups
    .filter((grp) => grp.replies.length)
    .map((grp) => `1… ${grp.replies[0].san} to 1. ${grp.against.san} (${pctOf(grp.replies[0].share)}%)`)
    .join(", ");
}

function sideWord(stats) {
  return stats?.oppColor === "black" ? "Black" : stats?.oppColor === "white" ? "White" : "this colour";
}

// Does the headline end up built from openingBranches.weak[0]? Mirrors the
// branch choice in buildActionableHeadline: when it does not, weak[0] must
// surface in the notes or the strongest opening-branch weakness vanishes
// entirely (the notes used to skip it unconditionally).
function headlineTakesTopWeak(prepTargets, stats) {
  const top = prepTargets?.[0];
  if (top && top.games >= 5) return false;
  const branches = stats?.openingBranches;
  const games = branches?.games ?? stats?.predictability?.games ?? 0;
  return games >= 10 && !!branches?.weak?.[0];
}

// The headline answers "what do I prepare?" from opening PREFIXES that enough
// games share. It never asks whether a full game line repeats: past the opening
// two games are practically never identical, so a deep line is always n=1 and
// "load more games" could never fix that.
function buildActionableHeadline(prepTargets, stats, username) {
  const predict = stats?.predictability;
  const persona = stats?.personaTags;
  const predictable = predictableLabel(predict, persona);
  const top = prepTargets?.[0];
  const branches = stats?.openingBranches;
  const games = branches?.games ?? predict?.games ?? 0;
  const side = sideWord(stats);
  if (!top || top.games < 5) {
    if (games < 10) {
      return games
        ? `Only ${games} ${side} game${games === 1 ? "" : "s"} from ${username} so far. Treat the lines below as hints, not habits.`
        : `No ${side} games from ${username} in this filter.`;
    }
    const weak = branches?.weak?.[0];
    if (weak) {
      // White's plies are odd: a line of odd length ends on White's move.
      const endsOnWhite = weak.plies % 2 === 1;
      const yours = endsOnWhite === (stats?.oppColor === "black");
      return choose({ san: weak.sans?.[0], uci: weak.ucis?.[0] }, "scout-headline-branch", yours ? HEADLINE_BRANCH_STEER : HEADLINE_BRANCH_WEAK, {
        line: weak.label,
        name: username,
        score: weak.scorePct,
        n: weak.games,
        base: branches.baselinePct,
      });
    }
    const expect = expectationText(stats?.firstChoices);
    const lead = expect ? `Expect ${expect}. ` : "";
    return `${lead}No opening where ${username} scores clearly below their ${branches?.baselinePct ?? 0}% average. Prepare the main paths and use the ranked lines below.`;
  }
  const line = scoutLineText(top.sans);
  if (top.prepCategory === "attack" || top.belowBaseline > 0) {
    return choose({ san: top.sans?.[0], uci: top.ucis?.[0] }, "scout-headline-attack", HEADLINE_ATTACK, {
      predictable,
      line,
      score: top.scorePct,
      n: top.games,
    });
  }
  return choose({ san: top.sans?.[0], uci: top.ucis?.[0] }, "scout-headline-weapon", HEADLINE_WEAPON, {
    predictable,
    line,
    share: Math.round((top.share || 0) * 100),
  });
}

function explorerBullets(explorerReads) {
  if (!explorerReads?.available) return [];
  const bullets = [];

  const topDev = explorerReads.theoryDeviation?.items?.[0];
  if (explorerReads.theoryDeviation?.available && topDev) {
    bullets.push(
      choose({ san: topDev.moveSan, uci: topDev.moveUci }, "scout-theory-dev", THEORY_DEVIATION, {
        move: topDev.label,
        opp: topDev.opponentSharePct,
        book: topDev.mastersSharePct,
        qualifier: qualifier(explorerReads.theoryDeviation.confidence),
      }),
    );
  }

  const topRare = explorerReads.rareWeapons?.items?.[0];
  if (explorerReads.rareWeapons?.available && topRare) {
    bullets.push(
      choose({ san: topRare.moveSan }, "scout-rare-weapon", RARE_WEAPON, {
        move: topRare.label,
        score: topRare.scorePct,
        opp: topRare.opponentSharePct,
        book: topRare.mastersSharePct,
        qualifier: qualifier(explorerReads.rareWeapons.confidence),
      }),
    );
  }

  const topOff = explorerReads.offBook?.items?.[0];
  if (explorerReads.offBook?.available && topOff && explorerReads.offBook.sharePct > 0) {
    bullets.push(
      choose({ san: topOff.moveSan }, "scout-off-book", OFF_BOOK, {
        share: explorerReads.offBook.sharePct,
        move: topOff.label,
        qualifier: qualifier(explorerReads.offBook.confidence),
      }),
    );
  }

  return bullets;
}

function engineBullets(engineAgg) {
  if (!engineAgg?.sufficient) return [];
  const worst = engineAgg.families?.[0];
  if (!worst) return [];
  return [
    choose({ san: worst.san, uci: worst.uci }, "scout-engine-worst", ENGINE_WORST, {
      san: worst.san,
      acpl: worst.acpl,
      ply: worst.firstInaccuracyPly ?? "—",
      qualifier: qualifier(worst.confidence),
    }),
  ];
}

export function buildScoutSectionSummary(
  stats,
  {
    username = "opponent",
    explorerReads = null,
    engineAgg = null,
    prepTargets = null,
  } = {},
) {
  if (!stats) return { headline: "", bullets: [] };

  const bullets = [];
  // `notes` is what the page lists under the headline: the chips beside it
  // already show predictability, top-3 lines, breadth, opening mix and style,
  // so repeating them as sentences only adds more "they …" lines to read.
  const notes = [];
  const headline = buildActionableHeadline(prepTargets, stats, username);
  bullets.push(headline);

  const expect = expectationText(stats.firstChoices);
  if (expect && !headline.startsWith("Expect ")) {
    bullets.push(stats.oppColor === "black" ? `As Black they answer ${expect}.` : `Expect ${expect}.`);
  }

  const branches = stats.openingBranches;
  // Skip weak[0] only when the headline already tells its story.
  const weakStart = headlineTakesTopWeak(prepTargets, stats) ? 1 : 0;
  for (const weak of (branches?.weak || []).slice(weakStart, weakStart + 2)) {
    pushBoth(
      choose({ san: weak.sans?.[0], uci: weak.ucis?.[0] }, "scout-note-weak", NOTE_BRANCH_WEAK, {
        line: weak.label,
        score: weak.scorePct,
        n: weak.games,
      }),
    );
  }
  const strong = branches?.strong?.[0];
  if (strong) {
    pushBoth(
      choose({ san: strong.sans?.[0], uci: strong.ucis?.[0] }, "scout-note-strong", NOTE_BRANCH_STRONG, {
        line: strong.label,
        score: strong.scorePct,
        n: strong.games,
        base: branches.baselinePct,
      }),
    );
  }

  const activity = stats.activitySeries;
  const recentGames = activity?.recentGames ?? 0;
  const recentWeeks = activity?.recentBuckets ?? 0;
  if (recentGames > 0 && recentWeeks > 0) {
    const noun = recentGames === 1 ? "game" : "games";
    // Weeks counted back from their latest game, not from today.
    pushBoth(
      `${recentGames} ${sideWord(stats)} ${noun} in the last ${recentWeeks} weeks before their latest game${qualifier(activity.confidence)}.`,
    );
  }

  const shift = stats.repertoireChangeTrend;
  if (shift?.points?.length >= 2) {
    const label =
      shift.trend === "up"
        ? "getting more concentrated"
        : shift.trend === "down"
          ? "experimenting with new openings"
          : "stable first-move mix";
    bullets.push(
      choose({ san: "shift" }, "scout-rep-shift", REPERTOIRE_SHIFT, {
        trend: shift.trend === "flat" ? "holding steady" : shift.trend === "up" ? "tightening" : "shifting",
        label,
        qualifier: qualifier(shift.confidence),
      }),
    );
  }

  const predict = stats.predictability;
  if (predict?.topMove && predict.games > 0) {
    const pct = Math.round((predict.topMove.share || 0) * 100);
    const qual = qualifier(predict.confidence);
    if (predict.label === "predictable") {
      bullets.push(
        choose({ san: predict.topMove.san, uci: predict.topMove.uci }, "scout-predictable", PREDICTABLE, {
          san: predict.topMove.san,
          pct,
          qualifier: qual,
        }),
      );
    } else if (predict.label === "unpredictable") {
      bullets.push(
        choose({ san: "mix" }, "scout-unpredictable", UNPREDICTABLE, {
          label: predict.label,
          qualifier: qual,
        }),
      );
    }
  }

  const fresh = stats.repertoireFreshness;
  const topFresh = fresh?.freshFamilies?.[0];
  const recentN = Math.min(fresh?.recentWindow || 0, fresh?.games || 0);
  if (topFresh) {
    pushBoth(
      choose({ san: topFresh.san, uci: topFresh.uci }, "scout-fresh", REPERTOIRE_FRESH, {
        line: topFresh.label || `1.${topFresh.san}`,
        n: topFresh.recentGames,
        recent: recentN,
        qualifier: qualifier(fresh.confidence),
      }),
    );
  }

  const topFreshLine = fresh?.freshLines?.[0];
  if (topFreshLine?.sans?.length) {
    pushBoth(
      choose({ san: topFreshLine.sans[0] }, "scout-fresh-line", FRESH_LINE, {
        line: scoutLineText(topFreshLine.sans),
        n: topFreshLine.games,
        recent: recentN,
        qualifier: qualifier(fresh.confidence),
      }),
    );
  }

  // No "you last saw your top target line…" note: the top ranked route is a
  // whole-game path (practically always one game), so its last date is a fact
  // about one game, not a habit. The rows below still show it per line.

  const persona = stats.personaTags;
  if (persona?.systemSetup?.detected && persona.systemSetup.label) {
    bullets.push(
      choose({ san: persona.systemSetup.label }, "scout-persona-system", PERSONA_SYSTEM, {
        system: persona.systemSetup.name || persona.systemSetup.label,
        qualifier: qualifier(persona.confidence),
      }),
    );
  } else if (persona?.games >= 5) {
    bullets.push(
      choose({ san: "style" }, "scout-persona-style", PERSONA_STYLE, {
        clause: personaClause(persona),
        qualifier: qualifier(persona.confidence),
      }),
    );
  }

  for (const text of [...explorerBullets(explorerReads), ...engineBullets(engineAgg)]) pushBoth(text);

  return { headline, bullets, notes };

  function pushBoth(text) {
    bullets.push(text);
    notes.push(text);
  }
}

export function buildColorRecommendationBanner(rec, escapeHtml, { username = "" } = {}) {
  if (!rec) return "";
  const name = username || "The opponent";
  if (rec.insufficient) {
    const text = choose({ san: "insufficient" }, "scout-color-insufficient", COLOR_INSUFFICIENT, {
      name,
      wN: rec.whiteGames ?? 0,
      bN: rec.blackGames ?? 0,
    });
    return `<div class="scout-color-rec scout-color-rec-muted">${escapeHtml(text)}</div>`;
  }
  if (!rec.pick) {
    const qual = qualifier(rec.confidence);
    const text =
      rec.whiteScore != null && rec.blackScore != null
        ? choose({ san: "even-n" }, "scout-color-even-n", COLOR_EVEN_NUMBERS, {
            name,
            w: rec.whiteScore,
            b: rec.blackScore,
            qualifier: qual,
          })
        : choose({ san: "even" }, "scout-color-even", COLOR_EVEN, { name, qualifier: qual });
    return `<div class="scout-color-rec scout-color-rec-muted">${escapeHtml(text)}</div>`;
  }
  const qual = qualifier(rec.confidence);
  const weak =
    rec.theirWeakColor === "white" ? "White" : rec.theirWeakColor === "black" ? "Black" : "?";
  const pick = rec.pick === "white" ? "White" : "Black";
  const other = weak === "White" ? "Black" : "White";
  const text = choose({ san: pick, uci: weak }, "scout-color-pick", COLOR_PICK, {
    name,
    pick,
    weak,
    other,
    weakScore: rec.weakScore,
    otherScore: rec.otherScore,
    qualifier: qual,
  });
  return `<div class="scout-color-rec">${escapeHtml(text)}</div>`;
}
