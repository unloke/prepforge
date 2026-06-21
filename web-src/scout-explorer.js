// Scout Phase 3 — explorer-backed opening reads (theory deviation, pool comparison, rare weapons).
// Pure aggregation + a batched fetch helper; all HTTP goes through explorer.js cache.

import { confidence } from "./scout-stats.js";

// Leaving the book: masters DB shows this move in <5% of games at the position.
export const OFF_BOOK_MAX_MASTERS_SHARE = 0.05;
// Low popularity: still in the book tree but under 10%.
export const LOW_POPULARITY_MAX_MASTERS_SHARE = 0.1;
export const THEORY_DEVIATION_MIN_GAP = 0.12;
export const THEORY_DEVIATION_MIN_GAMES = 3;
export const POOL_GAP_MIN = 0.15;
export const POOL_COMPARE_MIN_GAMES = 3;
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

export function poolShareForMove(stats, uci) {
  return mastersShareForMove(stats, uci);
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

export function collectExplorerProbePositions(
  root,
  fenAfterLine,
  {
    maxFirstMoves = EXPLORER_PROBE_MAX_FIRST_MOVES,
    maxReplies = EXPLORER_PROBE_MAX_REPLIES,
  } = {},
) {
  if (!root?.children?.size) return [];
  const startFen = fenAfterLine([]);
  const total = root.count || 1;
  const positions = [];

  const firstMoves = [...root.children.entries()]
    .map(([key, child]) => {
      const [uci, san] = key.split("|");
      return {
        uci,
        san,
        child,
        share: child.count / total,
        games: child.gameCount,
        scorePct: nodeScorePct(child),
      };
    })
    .sort((a, b) => b.games - a.games)
    .slice(0, maxFirstMoves);

  for (const move of firstMoves) {
    positions.push({
      fen: startFen,
      parentUcis: [],
      moveUci: move.uci,
      moveSan: move.san,
      opponentShare: move.share,
      opponentGames: move.games,
      opponentScorePct: move.scorePct,
      ply: 1,
    });
  }

  const topFirst = firstMoves[0];
  if (topFirst?.child?.children?.size) {
    const parentUcis = [topFirst.uci];
    const fen = fenAfterLine(parentUcis);
    const replyTotal = topFirst.child.count || 1;
    const replies = [...topFirst.child.children.entries()]
      .map(([key, child]) => {
        const [uci, san] = key.split("|");
        return {
          uci,
          san,
          share: child.count / replyTotal,
          games: child.gameCount,
          scorePct: nodeScorePct(child),
        };
      })
      .sort((a, b) => b.games - a.games)
      .slice(0, maxReplies);

    for (const reply of replies) {
      positions.push({
        fen,
        parentUcis,
        moveUci: reply.uci,
        moveSan: reply.san,
        opponentShare: reply.share,
        opponentGames: reply.games,
        opponentScorePct: reply.scorePct,
        ply: 2,
      });
    }
  }

  return positions;
}

function lineLabel(parentUcis, moveSan) {
  if (!parentUcis?.length) return `1.${moveSan}`;
  return `…${moveSan}`;
}

function analyzeProbe(position, mastersStats, poolStats) {
  if (!mastersStats || mastersStats.totalGames < MASTERS_MIN_TOTAL_GAMES) {
    return { skipped: true, reason: "low-masters-sample" };
  }

  const mastersShare = mastersShareForMove(mastersStats, position.moveUci);
  const poolShare = poolStats ? poolShareForMove(poolStats, position.moveUci) : null;
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

  const poolGap =
    poolStats &&
    poolShare != null &&
    position.opponentGames >= POOL_COMPARE_MIN_GAMES &&
    position.opponentShare - poolShare >= POOL_GAP_MIN
      ? {
          label,
          moveSan: position.moveSan,
          ply: position.ply,
          opponentSharePct: Math.round(position.opponentShare * 100),
          poolSharePct: Math.round(poolShare * 100),
          gapPct: Math.round((position.opponentShare - poolShare) * 100),
          games: position.opponentGames,
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
    poolGap,
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

export function buildExplorerReads(positions, { mastersByFen = new Map(), poolByFen = new Map() } = {}) {
  const deviations = [];
  const poolGaps = [];
  const rareWeapons = [];
  const offBookMoves = [];
  const lowPopMoves = [];
  let mastersProbes = 0;
  let excludedLowSample = 0;
  let offBookGames = 0;
  let probedGames = 0;

  for (const position of positions) {
    const mastersStats = mastersByFen.get(position.fen);
    const poolStats = poolByFen.get(position.fen);
    const result = analyzeProbe(position, mastersStats, poolStats);
    if (result.skipped) {
      excludedLowSample += 1;
      continue;
    }
    mastersProbes += 1;
    probedGames += position.opponentGames;
    if (result.deviation) deviations.push(result.deviation);
    if (result.poolGap) poolGaps.push(result.poolGap);
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

  const poolComparison = {
    available: poolGaps.length > 0,
    items: topBy(poolGaps, "gapPct"),
    confidence: confidence(poolGaps.reduce((n, d) => n + d.games, 0)),
    poolFens: poolByFen.size,
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
    poolComparison,
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
  opponentRating,
  shouldCancel = () => false,
}) {
  if (!positions?.length || typeof fetchStats !== "function") {
    return {
      available: false,
      reason: "no-positions",
      mastersByFen: new Map(),
      poolByFen: new Map(),
    };
  }

  const mastersByFen = new Map();
  const poolByFen = new Map();
  const uniqueFens = [...new Set(positions.map((p) => p.fen))];

  for (const fen of uniqueFens) {
    if (shouldCancel()) {
      return {
        available: false,
        reason: "cancelled",
        mastersByFen: new Map(),
        poolByFen: new Map(),
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
          poolByFen: new Map(),
        };
      }
    }
  }

  if (!mastersByFen.size) {
    return {
      available: false,
      reason: "masters-unavailable",
      mastersByFen: new Map(),
      poolByFen: new Map(),
    };
  }

  let poolAuthFailed = false;
  for (const fen of uniqueFens) {
    if (shouldCancel()) {
      return {
        available: false,
        reason: "cancelled",
        mastersByFen,
        poolByFen: new Map(),
      };
    }
    try {
      poolByFen.set(fen, await fetchStats("lichess", fen, { rating: opponentRating }));
    } catch (error) {
      if (isAuthExplorerError(error)) {
        poolAuthFailed = true;
        break;
      }
    }
  }

  const reads = buildExplorerReads(positions, { mastersByFen, poolByFen });
  return {
    available: true,
    poolAuthFailed,
    mastersByFen,
    poolByFen,
    ...reads,
  };
}