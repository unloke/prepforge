// Scout v2 — natural-language readouts from scout-stats output only.
import { choose } from "./coach/phrasebank.js";
import { scoutLineText } from "./scout.js";
import { formatLastSeenLabel } from "./scout-stats.js";

const COLOR_PICK = [
  "Pick {pick}: they score worse as {weak} ({weakScore}% vs {otherScore}%).",
  "Play {pick}. Their {weak} games average {weakScore}% ({qualifier}).",
  "You want {pick}: weaker when they have {weak} ({weakScore}%).",
];

const COLOR_EVEN = [
  "No clear color edge yet ({qualifier}).",
  "Both colors look similar so far ({qualifier}).",
];

const COLOR_INSUFFICIENT = [
  "Insufficient color comparison (White n={wN}, Black n={bN}).",
  "Not enough games on both colors to recommend a side (White {wN}, Black {bN}).",
];

const PREDICTABLE = [
  "Opens predictably: 1.{san} in {pct}% of games{qualifier}.",
  "First move is usually 1.{san} ({pct}%{qualifier}).",
];

const UNPREDICTABLE = [
  "Varied first moves ({label}{qualifier}).",
  "Hard to guess the first move ({label}{qualifier}).",
];

const PET_CONCENTRATED = [
  "Pet lines: top 3 cover {pct}% of games ({label}{qualifier}).",
  "Heavy reuse of the same paths ({pct}% in top 3{qualifier}).",
];

const REPERTOIRE_BREADTH = [
  "Plays {breadth} main first moves (n≥{min}{qualifier}).",
  "{breadth} first moves with a real sample (≥{min} games{qualifier}).",
];

const REPERTOIRE_FRESH = [
  "Started playing 1.{san} recently ({n} games{qualifier}).",
  "New in recent games: 1.{san} ({n} games{qualifier}).",
];

const FRESH_LINE = [
  "Started playing {line} ({n} recent games{qualifier}).",
  "New line lately: {line} ({n} games{qualifier}).",
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

const POOL_GAP = [
  "Uses {move} more than the {rating} pool ({opp}% vs {pool}%{qualifier}).",
  "{move} is a pool favourite ({opp}% vs {pool}% at their level{qualifier}).",
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
  const system = persona?.systemSetup?.detected ? persona.systemSetup.label : null;
  if (system) return `Predictable 1.${top.san} ${system} player`;
  if (predict.label === "predictable") return `Predictable 1.${top.san} player (${pct}%)`;
  return `Mostly 1.${top.san} (${pct}%)`;
}

function buildActionableHeadline(prepTargets, stats, username) {
  const predict = stats?.predictability;
  const persona = stats?.personaTags;
  const predictable = predictableLabel(predict, persona);
  const top = prepTargets?.[0];
  if (!top || top.games < 3) {
    return `Not enough sampled prep targets on ${username} as ${stats?.oppColor || "this colour"} yet.`;
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

  const topPool = explorerReads.poolComparison?.items?.[0];
  if (explorerReads.poolComparison?.available && topPool) {
    bullets.push(
      choose({ san: topPool.moveSan }, "scout-pool-gap", POOL_GAP, {
        move: topPool.label,
        rating: "player",
        opp: topPool.opponentSharePct,
        pool: topPool.poolSharePct,
        qualifier: qualifier(explorerReads.poolComparison.confidence),
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
    lastSeenByLine = null,
  } = {},
) {
  if (!stats) return { headline: "", bullets: [] };

  const bullets = [];
  const headline = buildActionableHeadline(prepTargets, stats, username);
  bullets.push(headline);

  const activity = stats.activitySeries;
  const recentGames = activity?.recentGames ?? 0;
  const recentWeeks = activity?.recentBuckets ?? 0;
  if (recentGames > 0 && recentWeeks > 0) {
    const noun = recentGames === 1 ? "game" : "games";
    bullets.push(
      `${recentGames} ${noun} in the last ${recentWeeks} weeks${qualifier(activity.confidence)}.`,
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

  const pets = stats.petLineConcentration;
  if (pets?.games > 0 && pets.top3SharePct >= 50) {
    bullets.push(
      choose({ san: "pet" }, "scout-pet", PET_CONCENTRATED, {
        pct: pets.top3SharePct,
        label: pets.label ? `, ${pets.label}` : "",
        qualifier: qualifier(pets.confidence),
      }),
    );
  }

  const breadth = stats.repertoireBreadth;
  if (breadth?.breadth > 0) {
    bullets.push(
      choose({ san: "breadth" }, "scout-breadth", REPERTOIRE_BREADTH, {
        breadth: breadth.breadth,
        min: breadth.minGames,
        qualifier: qualifier(breadth.confidence),
      }),
    );
  }

  const fresh = stats.repertoireFreshness;
  const topFresh = fresh?.freshFamilies?.[0];
  if (topFresh) {
    bullets.push(
      choose({ san: topFresh.san, uci: topFresh.uci }, "scout-fresh", REPERTOIRE_FRESH, {
        san: topFresh.san,
        n: topFresh.recentGames,
        qualifier: qualifier(fresh.confidence),
      }),
    );
  }

  const topFreshLine = fresh?.freshLines?.[0];
  if (topFreshLine?.sans?.length) {
    bullets.push(
      choose({ san: topFreshLine.sans[0] }, "scout-fresh-line", FRESH_LINE, {
        line: scoutLineText(topFreshLine.sans),
        n: topFreshLine.games,
        qualifier: qualifier(fresh.confidence),
      }),
    );
  }

  if (prepTargets?.length && lastSeenByLine) {
    const top = prepTargets[0];
    const key = top.line || top.ucis?.join(">");
    const seen = key ? lastSeenByLine.get(key) : null;
    if (seen) {
      bullets.push(`Top prep target ${formatLastSeenLabel(seen)}.`);
    }
  }

  const persona = stats.personaTags;
  if (persona?.systemSetup?.detected && persona.systemSetup.label) {
    bullets.push(
      choose({ san: persona.systemSetup.label }, "scout-persona-system", PERSONA_SYSTEM, {
        system: persona.systemSetup.label,
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

  bullets.push(...explorerBullets(explorerReads));
  bullets.push(...engineBullets(engineAgg));

  return { headline, bullets };
}

export function buildColorRecommendationBanner(rec, escapeHtml) {
  if (!rec) return "";
  if (rec.insufficient) {
    const text = choose({ san: "insufficient" }, "scout-color-insufficient", COLOR_INSUFFICIENT, {
      wN: rec.whiteGames ?? 0,
      bN: rec.blackGames ?? 0,
    });
    return `<div class="scout-color-rec scout-color-rec-muted">${escapeHtml(text)}</div>`;
  }
  if (!rec.pick) {
    const qual = qualifier(rec.confidence);
    const text = choose({ san: "even" }, "scout-color-even", COLOR_EVEN, { qualifier: qual });
    return `<div class="scout-color-rec scout-color-rec-muted">${escapeHtml(text)}</div>`;
  }
  const qual = qualifier(rec.confidence);
  const weak =
    rec.theirWeakColor === "white" ? "White" : rec.theirWeakColor === "black" ? "Black" : "?";
  const pick = rec.pick === "white" ? "White" : "Black";
  const text = choose({ san: pick, uci: weak }, "scout-color-pick", COLOR_PICK, {
    pick,
    weak,
    weakScore: rec.weakScore,
    otherScore: rec.otherScore,
    qualifier: qual,
  });
  return `<div class="scout-color-rec">${escapeHtml(text)}</div>`;
}