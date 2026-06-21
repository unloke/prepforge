// Scout Phase 3 — refutation synthesis: repertoire line → explorer reply → engine ACPL.
// Pure aggregation only; per-layer gates mark gaps without inferring refutations.

import {
  MASTERS_MIN_TOTAL_GAMES,
  POOL_COMPARE_MIN_GAMES,
  mastersShareForMove,
  poolShareForMove,
} from "./scout-explorer.js";
import {
  ENGINE_AGG_MIN_ANALYZED_GAMES,
  ENGINE_AGG_MIN_COVERAGE_PCT,
  SCOUT_ENGINE_MIN_RECURRENCE,
} from "./scout-engine.js";
import {
  fenAfterLine,
  terminalMoveIsOpponent,
  triePathKey,
  uciToSan,
  WEAKNESS_MIN_GAMES,
} from "./scout.js";

const ENGINE_REFUTATION_BLOCK_CODES = new Set([
  "no-scan",
  "stale",
  "insufficient-coverage",
  "insufficient-path-games",
  "speed-mismatch",
]);

export { terminalMoveIsOpponent };

export const REFUTATION_MIN_REPERTOIRE_GAMES = WEAKNESS_MIN_GAMES;
export const REFUTATION_MIN_EXPLORER_GAMES = POOL_COMPARE_MIN_GAMES;
export const REFUTATION_MIN_ENGINE_PATH_GAMES = SCOUT_ENGINE_MIN_RECURRENCE;

export function refutationIdentity({ color, speed, pathUcis, fen }) {
  const pathKey = triePathKey(pathUcis || []);
  return `${color}|${speed}|${pathKey}|${fen || ""}`;
}

export function collectRefutationCandidates(weaknessTargets, { color, speed = "all" } = {}) {
  const seen = new Set();
  const candidates = [];
  for (const target of weaknessTargets || []) {
    const pathUcis = target.ucis || [];
    if (!pathUcis.length || !terminalMoveIsOpponent(pathUcis, color)) continue;
    const fen = fenAfterLine(pathUcis);
    const identity = refutationIdentity({ color, speed, pathUcis, fen });
    if (seen.has(identity)) continue;
    seen.add(identity);
    candidates.push({
      identity,
      color,
      speed,
      pathUcis,
      pathSans: target.sans || [],
      pathKey: triePathKey(pathUcis),
      fen,
      games: target.games ?? 0,
      scorePct: target.scorePct ?? 0,
      share: target.share ?? 0,
      belowBaseline: target.belowBaseline ?? 0,
      opportunity: target.opportunity ?? 0,
    });
  }
  return candidates;
}

export function scanRecordsForPath(scanRecords, pathUcis) {
  if (!scanRecords?.length || !pathUcis?.length) return [];
  const lastUci = pathUcis[pathUcis.length - 1];
  const parentKey = pathUcis.length > 1 ? triePathKey(pathUcis.slice(0, -1)) : "";

  return scanRecords.filter((record) => {
    if (record.firstUci !== pathUcis[0]) return false;
    if (pathUcis.length === 1) return (record.analyzedOpponentPlies ?? 0) > 0;
    return (record.moves || []).some(
      (m) => m.playedUci === lastUci && m.pathKey === parentKey,
    );
  });
}

export function pathEngineMoves(scanRecords, pathUcis) {
  const records = scanRecordsForPath(scanRecords, pathUcis);
  const parentKey = pathUcis.length > 1 ? triePathKey(pathUcis.slice(0, -1)) : "";
  const moves = [];
  for (const record of records) {
    for (const move of record.moves || []) {
      const onPath =
        pathUcis.length === 1
          ? move.ply === 0 && move.playedUci === pathUcis[0]
          : move.pathKey === parentKey && move.playedUci === pathUcis[pathUcis.length - 1];
      if (onPath) moves.push({ ...move, gameId: record.gameId });
    }
  }
  return moves;
}

function speedFiltersMatch(activeSpeed, scanSpeed) {
  if (!activeSpeed || activeSpeed === "all") return true;
  if (!scanSpeed || scanSpeed === "all") return true;
  return activeSpeed === scanSpeed;
}

function evaluateRepertoireLayer(candidate, { baselineScorePct } = {}) {
  const blockedBy = [];
  const evidence = [];
  const reasons = [];

  if ((candidate.games ?? 0) < REFUTATION_MIN_REPERTOIRE_GAMES) {
    blockedBy.push({
      layer: "repertoire",
      code: "insufficient-sample",
      message: `Need ≥${REFUTATION_MIN_REPERTOIRE_GAMES} games (have ${candidate.games ?? 0})`,
    });
  }

  if ((candidate.belowBaseline ?? 0) <= 0) {
    blockedBy.push({
      layer: "repertoire",
      code: "above-baseline",
      message: `Score ${candidate.scorePct ?? 0}% is not below baseline ${baselineScorePct ?? 0}%`,
    });
  }

  if (!blockedBy.length) {
    evidence.push({
      layer: "repertoire",
      games: candidate.games,
      scorePct: candidate.scorePct,
      sharePct: Math.round((candidate.share ?? 0) * 100),
      belowBaseline: candidate.belowBaseline,
      opportunity: candidate.opportunity,
    });
    reasons.push(
      `Opponent scores ${candidate.scorePct}% over ${candidate.games} games (${candidate.belowBaseline} pts below baseline)`,
    );
  }

  return { blockedBy, evidence, reasons };
}

function evaluateExplorerLayer(
  candidate,
  { explorerReads = null, mastersByFen = null, poolByFen = null } = {},
) {
  const blockedBy = [];
  const evidence = [];
  const reasons = [];

  if (!explorerReads?.available) {
    const reason = explorerReads?.reason || "unavailable";
    blockedBy.push({
      layer: "explorer",
      code: reason,
      message:
        reason === "auth"
          ? "Lichess account required for explorer reads"
          : `Explorer reads unavailable (${reason})`,
    });
    return { blockedBy, evidence, reasons };
  }

  if (explorerReads.poolAuthFailed) {
    blockedBy.push({
      layer: "explorer",
      code: "pool-auth",
      message: "Pool comparison unavailable (auth required)",
    });
  }

  const pathUcis = candidate.pathUcis || [];
  const lastUci = pathUcis[pathUcis.length - 1];
  const parentUcis = pathUcis.slice(0, -1);
  const probeFen = parentUcis.length ? fenAfterLine(parentUcis) : fenAfterLine([]);

  const mastersStats = mastersByFen?.get?.(probeFen);
  if (!mastersStats || mastersStats.totalGames < MASTERS_MIN_TOTAL_GAMES) {
    blockedBy.push({
      layer: "explorer",
      code: "low-masters-sample",
      message: `Masters sample below ${MASTERS_MIN_TOTAL_GAMES} games at position`,
    });
    return { blockedBy, evidence, reasons };
  }

  if ((candidate.games ?? 0) < REFUTATION_MIN_EXPLORER_GAMES) {
    blockedBy.push({
      layer: "explorer",
      code: "insufficient-sample",
      message: `Need ≥${REFUTATION_MIN_EXPLORER_GAMES} opponent games on this line`,
    });
  }

  const mastersShare = mastersShareForMove(mastersStats, lastUci);
  const poolStats = poolByFen?.get?.(probeFen);
  const poolShare = poolStats ? poolShareForMove(poolStats, lastUci) : null;
  const opponentSharePct = Math.round((candidate.share ?? 0) * 100);

  evidence.push({
    layer: "explorer",
    fen: probeFen,
    moveUci: lastUci,
    moveSan: candidate.pathSans?.[candidate.pathSans.length - 1] || null,
    opponentSharePct,
    mastersSharePct: Math.round(mastersShare * 100),
    poolSharePct: poolShare != null ? Math.round(poolShare * 100) : null,
    games: candidate.games,
    poolAvailable: poolShare != null && !explorerReads.poolAuthFailed,
  });

  if (!blockedBy.length) {
    reasons.push(
      `Opponent plays this line in ${opponentSharePct}% of games vs ${Math.round(mastersShare * 100)}% in masters`,
    );
  }

  return { blockedBy, evidence, reasons };
}

function evaluateEngineLayer(
  candidate,
  { engineAgg = null, engineScan = null, speedFilter = "all" } = {},
) {
  const blockedBy = [];
  const evidence = [];
  const reasons = [];

  if (!engineScan?.scanRecords?.length) {
    blockedBy.push({
      layer: "engine",
      code: "no-scan",
      message: "No deep scan for this colour",
    });
    return { blockedBy, evidence, reasons, pathMoves: [] };
  }

  if (!speedFiltersMatch(speedFilter, engineScan.speedFilter)) {
    blockedBy.push({
      layer: "engine",
      code: "speed-mismatch",
      message: `Scan speed ${engineScan.speedFilter} does not match active filter ${speedFilter}`,
    });
  }

  if (engineAgg?.stale) {
    blockedBy.push({
      layer: "engine",
      code: "stale",
      message: "Deep scan is stale — scoped game set changed",
    });
  } else if (!engineAgg?.sufficient) {
    blockedBy.push({
      layer: "engine",
      code: "insufficient-coverage",
      message: `Engine coverage below gate (need ≥${ENGINE_AGG_MIN_ANALYZED_GAMES} games and ≥${ENGINE_AGG_MIN_COVERAGE_PCT}% coverage)`,
    });
  }

  const pathRecords = scanRecordsForPath(engineScan.scanRecords, candidate.pathUcis);
  const analyzedOnPath = pathRecords.filter((r) => (r.analyzedOpponentPlies ?? 0) > 0);
  const pathMoves = pathEngineMoves(engineScan.scanRecords, candidate.pathUcis);

  if (analyzedOnPath.length < REFUTATION_MIN_ENGINE_PATH_GAMES) {
    blockedBy.push({
      layer: "engine",
      code: "insufficient-path-games",
      message: `Need ≥${REFUTATION_MIN_ENGINE_PATH_GAMES} analyzed games on this path (have ${analyzedOnPath.length})`,
    });
  }

  const totalCpLoss = pathMoves.reduce((sum, m) => sum + (m.cpLoss || 0), 0);
  const acpl =
    pathMoves.length > 0 ? Math.round(totalCpLoss / pathMoves.length) : 0;
  const inaccuracyPlies = pathMoves
    .filter((m) => m.isInaccuracy)
    .map((m) => m.ply)
    .filter((ply) => ply != null);
  const firstInaccuracyPly = inaccuracyPlies.length
    ? Math.min(...inaccuracyPlies)
    : null;

  evidence.push({
    layer: "engine",
    analyzedGames: analyzedOnPath.length,
    pathMoves: pathMoves.length,
    acpl,
    firstInaccuracyPly,
    gameIds: analyzedOnPath.map((r) => r.gameId).filter(Boolean),
    scopeLimited: engineAgg?.scopeLimited ?? false,
    maxGames: engineAgg?.maxGames ?? engineScan.maxGames,
  });

  if (!blockedBy.length) {
    reasons.push(
      `Engine ACPL ${acpl} cp over ${analyzedOnPath.length} games on this path`,
    );
  }

  return { blockedBy, evidence, reasons, pathMoves };
}

export function inferRefutation(pathMoves) {
  const ranked = [...(pathMoves || [])].sort(
    (a, b) => (b.cpLoss || 0) - (a.cpLoss || 0) || (a.ply ?? 0) - (b.ply ?? 0),
  );
  const top = ranked.find((m) => (m.cpLoss || 0) > 0);
  if (!top?.ourReplyUci) {
    return {
      refutation: null,
      blockedBy: [
        {
          layer: "engine",
          code: "reply-unavailable",
          message: "Engine did not produce a best reply after the opponent move",
        },
      ],
    };
  }
  const parentUcis =
    top.pathKey && top.pathKey.length ? top.pathKey.split(">") : [];
  const afterOpponent = [...parentUcis, top.playedUci].filter(Boolean);
  const replyFen = fenAfterLine(afterOpponent);
  return {
    refutation: {
      suggestedUci: top.ourReplyUci,
      suggestedSan: uciToSan(replyFen, top.ourReplyUci),
      source: "engine",
      cpLoss: top.cpLoss,
      ply: top.ply,
      gameId: top.gameId,
      playedUci: top.playedUci,
      playedSan: top.playedSan,
      opponentBestAlternativeUci: top.opponentBestAlternativeUci ?? top.bestUci ?? null,
      ourReplyPv: top.ourReplyPv ?? null,
    },
    blockedBy: [],
  };
}

export function computeRefutationScore(candidate, { explorerEvidence = null, engineEvidence = null } = {}) {
  let score = candidate.opportunity ?? 0;
  if (explorerEvidence?.mastersSharePct != null) {
    const gap = Math.max(0, (candidate.share ?? 0) * 100 - explorerEvidence.mastersSharePct);
    score += gap / 100;
  }
  if (engineEvidence?.acpl) score += engineEvidence.acpl / 200;
  return Math.round(score * 1e6) / 1e6;
}

export function evaluateRefutationCandidate(candidate, context = {}) {
  const repertoire = evaluateRepertoireLayer(candidate, context);
  const explorer = evaluateExplorerLayer(candidate, context);
  const engine = evaluateEngineLayer(candidate, context);

  const evidence = [...repertoire.evidence, ...explorer.evidence, ...engine.evidence];
  const reasons = [...repertoire.reasons, ...explorer.reasons, ...engine.reasons];

  const explorerEvidence = explorer.evidence.find((e) => e.layer === "explorer") || null;
  const engineEvidence = engine.evidence.find((e) => e.layer === "engine") || null;
  const score = computeRefutationScore(candidate, { explorerEvidence, engineEvidence });

  const engineBlocks = engine.blockedBy.filter((b) => ENGINE_REFUTATION_BLOCK_CODES.has(b.code));
  let refutation = null;
  const blockedBy = [];

  if (!engineBlocks.length) {
    const inferred = inferRefutation(engine.pathMoves);
    if (inferred.refutation) {
      refutation = inferred.refutation;
    } else {
      blockedBy.push(...inferred.blockedBy);
    }
  } else {
    blockedBy.push(...engineBlocks);
  }

  if (!refutation) {
    blockedBy.push(...explorer.blockedBy, ...repertoire.blockedBy);
  }

  return {
    identity: candidate.identity,
    candidate: {
      color: candidate.color,
      speed: candidate.speed,
      pathUcis: candidate.pathUcis,
      pathSans: candidate.pathSans,
      pathKey: candidate.pathKey,
      fen: candidate.fen,
      games: candidate.games,
      scorePct: candidate.scorePct,
      share: candidate.share,
    },
    score,
    reasons,
    evidence,
    blockedBy,
    refutation,
    layers: {
      repertoire: repertoire.blockedBy.length ? "blocked" : "pass",
      explorer: explorer.blockedBy.length ? "supplemental" : "pass",
      engine: refutation ? "pass" : engine.blockedBy.length ? "blocked" : "pass",
    },
  };
}

export function refutationGapAction(blocked) {
  switch (blocked?.code) {
    case "no-scan":
    case "insufficient-coverage":
    case "stale":
    case "reply-unavailable":
    case "insufficient-path-games":
    case "speed-mismatch":
      return {
        id: "deep-scan",
        label: "Run Deep scan",
        ariaLabel: "Run deep engine scan to generate refutations",
        testId: "scout-refutation-gap-deep-scan",
      };
    case "auth":
      return {
        id: "connect-lichess",
        label: "Connect Lichess account",
        ariaLabel: "Connect your Lichess account for opening explorer data",
        testId: "scout-refutation-gap-connect-lichess",
      };
    case "pool-auth":
      return {
        id: "connect-lichess",
        label: "Connect Lichess for pool comparison",
        ariaLabel: "Connect your Lichess account for pool comparison",
        testId: "scout-refutation-gap-connect-lichess",
      };
    default:
      return null;
  }
}

export function collectActionableRefutationGapActions(refutations) {
  const actions = [];
  const seen = new Set();
  for (const item of refutations || []) {
    if (item.refutation) continue;
    for (const blocked of item.blockedBy || []) {
      const action = refutationGapAction(blocked);
      if (action && !seen.has(action.id)) {
        seen.add(action.id);
        actions.push(action);
      }
    }
  }
  return actions;
}

export function collectActionableRefutationGaps(refutations) {
  return collectActionableRefutationGapActions(refutations).map((action) => action.label);
}

export function sortRefutations(refutations) {
  return [...(refutations || [])].sort(
    (a, b) => b.score - a.score || a.identity.localeCompare(b.identity),
  );
}

export function buildRefutations({
  weaknessTargets,
  color,
  speedFilter = "all",
  baselineScorePct = 50,
  explorerReads = null,
  mastersByFen = null,
  poolByFen = null,
  engineAgg = null,
  engineScan = null,
} = {}) {
  const candidates = collectRefutationCandidates(weaknessTargets, {
    color,
    speed: speedFilter,
  });
  const evaluated = candidates.map((candidate) =>
    evaluateRefutationCandidate(candidate, {
      baselineScorePct,
      explorerReads,
      mastersByFen,
      poolByFen,
      engineAgg,
      engineScan,
      speedFilter,
    }),
  );
  return sortRefutations(evaluated);
}