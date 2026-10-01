// Scout explorer reads from the public masters database.
// Pure aggregation + a batched fetch helper; all HTTP goes through explorer.js cache.

import { confidence } from "./scout-stats.js";

// Leaving the book: masters DB shows this move in <5% of games at the position.
export const OFF_BOOK_MAX_MASTERS_SHARE = 0.05;
// Low popularity: still in the book tree but under 10%.
export const LOW_POPULARITY_MAX_MASTERS_SHARE = 0.1;
export const THEORY_DEVIATION_MIN_GAP = 0.12;
export const THEORY_DEVIATION_MIN_GAMES = 3;
export const RARE_WEAPON_MIN_GAMES = 3;
export const RARE_WEAPON_MIN_OPP_SHARE = 0.12;
export const RARE_WEAPON_MAX_MASTERS_SHARE = 0.06;
export const RARE_WEAPON_MIN_SCORE_PCT = 55;
export const MASTERS_MIN_TOTAL_GAMES = 100;
export const EXPLORER_PROBE_MAX_FIRST_MOVES = 4;
export const EXPLORER_PROBE_MAX_REPLIES = 2;

function nodeScorePct(node) {
  return node.count > 0 ? Math.round((node.score / node.count) * 100) : 0;
}

export function mastersShareForMove(stats, uci) {
  const move = stats?.moves?.find((m) => m.uci === uci);
  return move ? move.share : 0;
}

export function classifyBookStatus(mastersShare) {
  if (mastersShare < OFF_BOOK_MAX_MASTERS_SHARE) return "off-book";
  if (mastersShare < LOW_POPULARITY_MAX_MASTERS_SHARE) return "low-popularity";
  return "mainline";
}

export function isAuthExplorerError(error) {
  const msg = String(error?.message || "");
  return /link your Lichess account/i.test(msg);
}

// Probe only the positions where the SCOUTED player chooses: with White their
// first move and (under their main first move) their second move; with Black
// their reply to each of the first moves they usually face. Shares are plain game
// counts, the same numbers the first-move bars show — the trie's `count` is
// recency-weighted, and using it here printed "1.e4 87%" beside a "48%" bar.
export function collectExplorerProbePositions(
  root,
  fenAfterLine,
  {
    oppColor = "white",
    maxFirstMoves = EXPLORER_PROBE_MAX_FIRST_MOVES,
    maxReplies = EXPLORER_PROBE_MAX_REPLIES,
  } = {},
) {
  if (!root?.children?.size) return [];
  const positions = [];
  const childrenOf = (node) =>
    [...node.children.entries()]
      .map(([key, child]) => {
        const [uci, san] = key.split("|");
        return { uci, san, child, games: child.gameCount || 0, scorePct: nodeScorePct(child) };
      })
      .sort((a, b) => b.games - a.games);
  const probeAt = (node, parentUcis, parentSans, limit) => {
    const total = node.gameCount || 0;
    if (!total || !node.children?.size) return [];
    const fen = fenAfterLine(parentUcis);
    const moves = childrenOf(node).slice(0, limit);
    for (const move of moves) {
      positions.push({
        fen,
        parentUcis,
        parentSans,
        moveUci: move.uci,
        moveSan: move.san,
        opponentShare: move.games / total,
        opponentGames: move.games,
        opponentScorePct: move.scorePct,
        ply: parentUcis.length + 1,
      });
    }
    return moves;
  };

  if (oppColor === "black") {
    // Their replies to the (up to two) first moves they face most.
    const faced = childrenOf(root).slice(0, 2);
    for (const first of faced) {
      probeAt(first.child, [first.uci], [first.san], maxFirstMoves);
    }
    return positions;
  }

  const firstMoves = probeAt(root, [], [], maxFirstMoves);
  const topFirst = firstMoves[0];
  if (topFirst?.child?.children?.size) {
    // Their second move, after the reply they meet most under their main first move.
    const reply = childrenOf(topFirst.child)[0];
    if (reply?.child?.children?.size) {
      probeAt(reply.child, [topFirst.uci, reply.uci], [topFirst.san, reply.san], maxReplies);
    }
  }
  return positions;
}

// "1.e4", "1…c5", "2.Nf3", "2…d6" — the move with its number, so a chip reads
// on its own ("Theory: 1…c5 62% vs 35% book").
function lineLabel(parentUcis, moveSan) {
  const ply = (parentUcis?.length || 0) + 1;
  const moveNo = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${moveNo}.${moveSan}` : `${moveNo}…${moveSan}`;
}

function analyzeProbe(position, mastersStats) {
  if (!mastersStats || mastersStats.totalGames < MASTERS_MIN_TOTAL_GAMES) {
    return { skipped: true, reason: "low-masters-sample" };
  }

  const mastersShare = mastersShareForMove(mastersStats, position.moveUci);
  const bookStatus = classifyBookStatus(mastersShare);
  const label = lineLabel(position.parentUcis, position.moveSan);

  const deviation =
    position.opponentGames >= THEORY_DEVIATION_MIN_GAMES &&
    position.opponentShare - mastersShare >= THEORY_DEVIATION_MIN_GAP
      ? {
          label,
          moveSan: position.moveSan,
          moveUci: position.moveUci,
          ply: position.ply,
          opponentSharePct: Math.round(position.opponentShare * 100),
          mastersSharePct: Math.round(mastersShare * 100),
          gapPct: Math.round((position.opponentShare - mastersShare) * 100),
          games: position.opponentGames,
          bookStatus,
        }
      : null;

  const rareWeapon =
    position.opponentGames >= RARE_WEAPON_MIN_GAMES &&
    position.opponentShare >= RARE_WEAPON_MIN_OPP_SHARE &&
    mastersShare <= RARE_WEAPON_MAX_MASTERS_SHARE &&
    position.opponentScorePct >= RARE_WEAPON_MIN_SCORE_PCT
      ? {
          label,
          moveSan: position.moveSan,
          ply: position.ply,
          opponentSharePct: Math.round(position.opponentShare * 100),
          mastersSharePct: Math.round(mastersShare * 100),
          scorePct: position.opponentScorePct,
          games: position.opponentGames,
          opportunity: position.opponentShare * position.opponentScorePct,
        }
      : null;

  const offBook =
    bookStatus === "off-book" && position.opponentGames >= THEORY_DEVIATION_MIN_GAMES
      ? {
          label,
          moveSan: position.moveSan,
          games: position.opponentGames,
          mastersSharePct: Math.round(mastersShare * 100),
        }
      : null;

  const lowPopularity =
    bookStatus === "low-popularity" && position.opponentGames >= THEORY_DEVIATION_MIN_GAMES
      ? {
          label,
          moveSan: position.moveSan,
          games: position.opponentGames,
          mastersSharePct: Math.round(mastersShare * 100),
          opponentSharePct: Math.round(position.opponentShare * 100),
        }
      : null;

  return {
    skipped: false,
    deviation,
    rareWeapon,
    offBook,
    lowPopularity,
    mastersShare,
    bookStatus,
    games: position.opponentGames,
  };
}

function topBy(items, key, limit = 3) {
  return [...items].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, limit);
}

export function buildExplorerReads(positions, { mastersByFen = new Map() } = {}) {
  const deviations = [];
  const rareWeapons = [];
  const offBookMoves = [];
  const lowPopMoves = [];
  let mastersProbes = 0;
  let excludedLowSample = 0;
  let offBookGames = 0;
  let probedGames = 0;

  for (const position of positions) {
    const mastersStats = mastersByFen.get(position.fen);
    const result = analyzeProbe(position, mastersStats);
    if (result.skipped) {
      excludedLowSample += 1;
      continue;
    }
    mastersProbes += 1;
    probedGames += position.opponentGames;
    if (result.deviation) deviations.push(result.deviation);
    if (result.rareWeapon) rareWeapons.push(result.rareWeapon);
    if (result.offBook) {
      offBookMoves.push(result.offBook);
      offBookGames += position.opponentGames;
    }
    if (result.lowPopularity) lowPopMoves.push(result.lowPopularity);
  }

  const theoryDeviation = {
    available: deviations.length > 0,
    items: topBy(deviations, "gapPct"),
    confidence: confidence(deviations.reduce((n, d) => n + d.games, 0)),
    excludedLowSample,
    mastersProbes,
  };

  const rareWeaponRead = {
    available: rareWeapons.length > 0,
    items: topBy(rareWeapons, "opportunity"),
    confidence: confidence(rareWeapons.reduce((n, d) => n + d.games, 0)),
  };

  const offBook = {
    available: offBookMoves.length > 0,
    items: topBy(offBookMoves, "games"),
    sharePct: probedGames > 0 ? Math.round((offBookGames / probedGames) * 100) : 0,
    games: offBookGames,
    confidence: confidence(offBookGames),
  };

  const lowPopularity = {
    available: lowPopMoves.length > 0,
    items: topBy(lowPopMoves, "opponentSharePct"),
    confidence: confidence(lowPopMoves.reduce((n, d) => n + d.games, 0)),
  };

  return {
    theoryDeviation,
    rareWeapons: rareWeaponRead,
    offBook,
    lowPopularity,
    probes: positions.length,
    mastersFens: mastersByFen.size,
  };
}

export async function fetchExplorerReads({
  fetchStats,
  positions,
  shouldCancel = () => false,
}) {
  if (!positions?.length || typeof fetchStats !== "function") {
    return {
      available: false,
      reason: "no-positions",
      mastersByFen: new Map(),
    };
  }

  const mastersByFen = new Map();
  const uniqueFens = [...new Set(positions.map((p) => p.fen))];

  for (const fen of uniqueFens) {
    if (shouldCancel()) {
      return {
        available: false,
        reason: "cancelled",
        mastersByFen: new Map(),
      };
    }
    try {
      mastersByFen.set(fen, await fetchStats("masters", fen, {}));
    } catch (error) {
      if (isAuthExplorerError(error)) {
        return {
          available: false,
          reason: "auth",
          mastersByFen: new Map(),
        };
      }
    }
  }

  if (!mastersByFen.size) {
    return {
      available: false,
      reason: "masters-unavailable",
      mastersByFen: new Map(),
    };
  }

  const reads = buildExplorerReads(positions, { mastersByFen });
  return {
    available: true,
    mastersByFen,
    ...reads,
  };
}
