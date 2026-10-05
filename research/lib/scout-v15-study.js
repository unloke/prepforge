// Scout v15 study — append-only acquisition corpus helpers.
// Pure: no network, filesystem, DOM, engine, or outcome metrics.

import { createHash } from "node:crypto";
import { relative } from "node:path";

export const STUDY_PROTOCOL_ID = "ericrosen-v15";
export const STUDY_SUBJECT_USERNAME = "EricRosen";
export const STUDY_LEGACY_BURNED_COUNT = 203;
export const STUDY_DEFAULT_MIN_PER_COLOR = 40;

export const HISTORICAL_PROTOCOL_ID = "ericrosen-v15-historical-r1";
export const HISTORICAL_DEFAULT_MIN_PER_COLOR = 220;
export const HISTORICAL_INSUFFICIENT_DATA_VERDICT = "historical-insufficient-data";
export const HISTORICAL_PARTITION_KIND = "scout-v15-historical-r1-partition";

export const MAIA_HISTORICAL_PROTOCOL_ID = "ericrosen-v15-historical-m1";
export const MAIA_HISTORICAL_HYPOTHESIS_ID = "H-M1";
export const MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR = 220;
export const MAIA_HISTORICAL_PARTITION_KIND = "scout-v15-historical-m1-partition";
export const MAIA_HISTORICAL_HR1_FROZEN_COUNT = 446;
export const MAIA_HISTORICAL_TOTAL_EXCLUDED_COUNT = 649;

export const STUDY_STATES = Object.freeze({
  UNINITIALIZED: "uninitialized",
  INITIALIZED: "initialized",
  ACQUIRING: "acquiring",
  ACQUIRED: "acquired",
  AWAITING_DATA: "awaiting-data",
  FROZEN_C1: "frozen-c1",
  VERIFIED: "verified",
});

/** Legal study state transitions (append-only; frozen partitions refuse top-up). */
export const STUDY_STATE_TRANSITIONS = Object.freeze({
  [STUDY_STATES.UNINITIALIZED]: [STUDY_STATES.INITIALIZED],
  [STUDY_STATES.INITIALIZED]: [STUDY_STATES.ACQUIRING],
  [STUDY_STATES.ACQUIRING]: [STUDY_STATES.ACQUIRED, STUDY_STATES.AWAITING_DATA],
  [STUDY_STATES.ACQUIRED]: [STUDY_STATES.ACQUIRING, STUDY_STATES.FROZEN_C1],
  [STUDY_STATES.AWAITING_DATA]: [STUDY_STATES.ACQUIRING],
  [STUDY_STATES.FROZEN_C1]: [STUDY_STATES.VERIFIED],
  [STUDY_STATES.VERIFIED]: [],
});

export const HISTORICAL_STATES = Object.freeze({
  UNINITIALIZED: "uninitialized",
  INITIALIZED: "initialized",
  ACQUIRING: "acquiring",
  ACQUIRED: "acquired",
  INSUFFICIENT_DATA: HISTORICAL_INSUFFICIENT_DATA_VERDICT,
  FROZEN_HR1: "frozen-h-r1",
  VERIFIED: "verified",
});

/** Legal H-R1 state transitions (append-only; frozen partitions refuse top-up). */
export const HISTORICAL_STATE_TRANSITIONS = Object.freeze({
  [HISTORICAL_STATES.UNINITIALIZED]: [HISTORICAL_STATES.INITIALIZED],
  [HISTORICAL_STATES.INITIALIZED]: [HISTORICAL_STATES.ACQUIRING],
  [HISTORICAL_STATES.ACQUIRING]: [
    HISTORICAL_STATES.ACQUIRED,
    HISTORICAL_STATES.INSUFFICIENT_DATA,
  ],
  [HISTORICAL_STATES.ACQUIRED]: [HISTORICAL_STATES.ACQUIRING, HISTORICAL_STATES.FROZEN_HR1],
  [HISTORICAL_STATES.INSUFFICIENT_DATA]: [HISTORICAL_STATES.ACQUIRING],
  [HISTORICAL_STATES.FROZEN_HR1]: [HISTORICAL_STATES.VERIFIED],
  [HISTORICAL_STATES.VERIFIED]: [],
});

export const MAIA_HISTORICAL_STATES = Object.freeze({
  UNINITIALIZED: "uninitialized",
  INITIALIZED: "initialized",
  ACQUIRING: "acquiring",
  ACQUIRED: "acquired",
  INSUFFICIENT_DATA: HISTORICAL_INSUFFICIENT_DATA_VERDICT,
  FROZEN_HM1: "frozen-h-m1",
  VERIFIED: "verified",
});

/** Legal H-M1 state transitions (append-only; frozen partitions refuse top-up). */
export const MAIA_HISTORICAL_STATE_TRANSITIONS = Object.freeze({
  [MAIA_HISTORICAL_STATES.UNINITIALIZED]: [MAIA_HISTORICAL_STATES.INITIALIZED],
  [MAIA_HISTORICAL_STATES.INITIALIZED]: [MAIA_HISTORICAL_STATES.ACQUIRING],
  [MAIA_HISTORICAL_STATES.ACQUIRING]: [
    MAIA_HISTORICAL_STATES.ACQUIRED,
    MAIA_HISTORICAL_STATES.INSUFFICIENT_DATA,
  ],
  [MAIA_HISTORICAL_STATES.ACQUIRED]: [MAIA_HISTORICAL_STATES.ACQUIRING, MAIA_HISTORICAL_STATES.FROZEN_HM1],
  [MAIA_HISTORICAL_STATES.INSUFFICIENT_DATA]: [MAIA_HISTORICAL_STATES.ACQUIRING],
  [MAIA_HISTORICAL_STATES.FROZEN_HM1]: [MAIA_HISTORICAL_STATES.VERIFIED],
  [MAIA_HISTORICAL_STATES.VERIFIED]: [],
});

const CANONICAL_GAME_KEYS = [
  "gameId",
  "color",
  "score",
  "status",
  "sans",
  "ucis",
  "rating",
  "opponentRating",
  "datestamp",
  "createdAtMs",
  "speed",
  "timeControl",
  "clockAfterPly",
  "clockCsAfterPly",
  "clockInitialSeconds",
  "clockIncrementSeconds",
  "totalPly",
  "openingUcis",
  "openingSans",
  "openingEndPly",
];

export function sha256Hex(value) {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Stable JSON object for hashing and manifest pinning. */
export function canonicalizeGameRecord(game) {
  const out = {};
  for (const key of CANONICAL_GAME_KEYS) {
    if (game?.[key] !== undefined) out[key] = game[key];
  }
  return out;
}

export function gameContentHash(game) {
  return sha256Hex(canonicalizeGameRecord(game));
}

export function gameCreatedAtMs(game) {
  const raw = game?.createdAtMs ?? game?.datestamp;
  return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
}

export function sortGamesByCreatedAt(games) {
  return [...(games || [])].sort((a, b) => {
    const aMs = gameCreatedAtMs(a) ?? 0;
    const bMs = gameCreatedAtMs(b) ?? 0;
    if (aMs !== bMs) return aMs - bMs;
    return String(a.gameId || "").localeCompare(String(b.gameId || ""));
  });
}

export function sortGamesByCreatedAtDesc(games) {
  return [...(games || [])].sort((a, b) => {
    const aMs = gameCreatedAtMs(a) ?? 0;
    const bMs = gameCreatedAtMs(b) ?? 0;
    if (aMs !== bMs) return bMs - aMs;
    return String(a.gameId || "").localeCompare(String(b.gameId || ""));
  });
}

export function validateStudyProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== "scout-v15-preregistration-protocol") errors.push("invalid kind");
  if (protocol?.protocolId !== STUDY_PROTOCOL_ID) errors.push("invalid protocolId");
  if (protocol?.subject?.lichessUsername !== STUDY_SUBJECT_USERNAME) errors.push("invalid subject");
  const boundaryMs = Number(protocol?.c1Transfer?.boundary?.ms);
  if (!Number.isFinite(boundaryMs)) errors.push("missing c1 boundary ms");
  const burned = protocol?.frozenArtifacts?.legacyGames?.burnedGameIds;
  if (!Array.isArray(burned) || burned.length !== STUDY_LEGACY_BURNED_COUNT) {
    errors.push(`expected ${STUDY_LEGACY_BURNED_COUNT} burned game ids`);
  }
  const minPerColor = Number(protocol?.c1Transfer?.minimumFreshGamesPerColor);
  if (minPerColor !== STUDY_DEFAULT_MIN_PER_COLOR) {
    errors.push(`expected minimumFreshGamesPerColor ${STUDY_DEFAULT_MIN_PER_COLOR}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    boundaryMs: Number.isFinite(boundaryMs) ? boundaryMs : null,
    burnedGameIds: Array.isArray(burned) ? [...burned] : [],
    minPerColor: Number.isFinite(minPerColor) ? minPerColor : STUDY_DEFAULT_MIN_PER_COLOR,
  };
}

export function unionExcludedGameIds(burnedGameIds = [], hR1FrozenGameIds = []) {
  return [...new Set([
    ...(burnedGameIds || []),
    ...(hR1FrozenGameIds || []),
  ])];
}

export function validateMaiaHistoricalProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== "scout-v15-historical-replication-protocol") errors.push("invalid kind");
  if (protocol?.protocolId !== MAIA_HISTORICAL_PROTOCOL_ID) errors.push("invalid protocolId");
  if (protocol?.hypothesisId !== MAIA_HISTORICAL_HYPOTHESIS_ID) errors.push("invalid hypothesisId");
  if (protocol?.studyId !== MAIA_HISTORICAL_PROTOCOL_ID) errors.push("invalid studyId");
  if (protocol?.subject?.lichessUsername !== STUDY_SUBJECT_USERNAME) errors.push("invalid subject");
  const upperExclusiveMs = Number(protocol?.historicalAcquisition?.upperBoundary?.ms);
  if (!Number.isFinite(upperExclusiveMs)) errors.push("missing upperExclusiveMs");
  const lookbackFloorMs = Number(protocol?.historicalAcquisition?.maxLookback?.minCreatedAtMs);
  if (!Number.isFinite(lookbackFloorMs)) errors.push("missing lookbackFloorMs");
  const c1LowerExclusiveMs = Number(protocol?.historicalAcquisition?.c1LowerExclusive?.ms);
  if (!Number.isFinite(c1LowerExclusiveMs)) errors.push("missing c1LowerExclusiveMs");
  const burned = protocol?.frozenArtifacts?.legacyGames?.burnedGameIds;
  if (!Array.isArray(burned) || burned.length !== STUDY_LEGACY_BURNED_COUNT) {
    errors.push(`expected ${STUDY_LEGACY_BURNED_COUNT} burned game ids`);
  }
  const hR1Frozen = protocol?.frozenArtifacts?.hR1FrozenGames?.frozenGameIds;
  if (!Array.isArray(hR1Frozen) || hR1Frozen.length !== MAIA_HISTORICAL_HR1_FROZEN_COUNT) {
    errors.push(`expected ${MAIA_HISTORICAL_HR1_FROZEN_COUNT} H-R1 frozen game ids`);
  }
  const minPerColor = Number(protocol?.historicalAcquisition?.freezePolicy?.minGamesPerColor);
  if (minPerColor !== MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR) {
    errors.push(`expected minGamesPerColor ${MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR}`);
  }
  if (upperExclusiveMs != null && c1LowerExclusiveMs != null && upperExclusiveMs >= c1LowerExclusiveMs) {
    errors.push("upperExclusiveMs must be strictly before c1LowerExclusiveMs");
  }
  const excludedGameIds = unionExcludedGameIds(burned, hR1Frozen);
  if (excludedGameIds.length !== MAIA_HISTORICAL_TOTAL_EXCLUDED_COUNT) {
    errors.push(`expected ${MAIA_HISTORICAL_TOTAL_EXCLUDED_COUNT} total excluded game ids`);
  }
  return {
    ok: errors.length === 0,
    errors,
    upperExclusiveMs: Number.isFinite(upperExclusiveMs) ? upperExclusiveMs : null,
    lookbackFloorMs: Number.isFinite(lookbackFloorMs) ? lookbackFloorMs : null,
    c1LowerExclusiveMs: Number.isFinite(c1LowerExclusiveMs) ? c1LowerExclusiveMs : null,
    burnedGameIds: Array.isArray(burned) ? [...burned] : [],
    hR1FrozenGameIds: Array.isArray(hR1Frozen) ? [...hR1Frozen] : [],
    excludedGameIds,
    minPerColor: Number.isFinite(minPerColor) ? minPerColor : MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR,
    parentProtocolSha256: protocol?.parentProtocol?.sha256 ?? null,
    hR1ParentManifestSha256: protocol?.frozenArtifacts?.hR1FrozenGames?.sha256 ?? null,
  };
}

export function validateHistoricalProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== "scout-v15-historical-replication-protocol") errors.push("invalid kind");
  if (protocol?.protocolId !== HISTORICAL_PROTOCOL_ID) errors.push("invalid protocolId");
  if (protocol?.subject?.lichessUsername !== STUDY_SUBJECT_USERNAME) errors.push("invalid subject");
  const upperExclusiveMs = Number(protocol?.historicalAcquisition?.upperBoundary?.ms);
  if (!Number.isFinite(upperExclusiveMs)) errors.push("missing upperExclusiveMs");
  const lookbackFloorMs = Number(protocol?.historicalAcquisition?.maxLookback?.minCreatedAtMs);
  if (!Number.isFinite(lookbackFloorMs)) errors.push("missing lookbackFloorMs");
  const c1LowerExclusiveMs = Number(protocol?.historicalAcquisition?.c1LowerExclusive?.ms);
  if (!Number.isFinite(c1LowerExclusiveMs)) errors.push("missing c1LowerExclusiveMs");
  const burned = protocol?.frozenArtifacts?.legacyGames?.burnedGameIds;
  if (!Array.isArray(burned) || burned.length !== STUDY_LEGACY_BURNED_COUNT) {
    errors.push(`expected ${STUDY_LEGACY_BURNED_COUNT} burned game ids`);
  }
  const minPerColor = Number(protocol?.historicalAcquisition?.freezePolicy?.minGamesPerColor);
  if (minPerColor !== HISTORICAL_DEFAULT_MIN_PER_COLOR) {
    errors.push(`expected minGamesPerColor ${HISTORICAL_DEFAULT_MIN_PER_COLOR}`);
  }
  if (upperExclusiveMs != null && c1LowerExclusiveMs != null && upperExclusiveMs >= c1LowerExclusiveMs) {
    errors.push("upperExclusiveMs must be strictly before c1LowerExclusiveMs");
  }
  return {
    ok: errors.length === 0,
    errors,
    upperExclusiveMs: Number.isFinite(upperExclusiveMs) ? upperExclusiveMs : null,
    lookbackFloorMs: Number.isFinite(lookbackFloorMs) ? lookbackFloorMs : null,
    c1LowerExclusiveMs: Number.isFinite(c1LowerExclusiveMs) ? c1LowerExclusiveMs : null,
    burnedGameIds: Array.isArray(burned) ? [...burned] : [],
    minPerColor: Number.isFinite(minPerColor) ? minPerColor : HISTORICAL_DEFAULT_MIN_PER_COLOR,
    parentProtocolSha256: protocol?.parentProtocol?.sha256 ?? null,
  };
}

export function canTransitionStudyState(from, to) {
  const allowed = STUDY_STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertStudyStateTransition(from, to) {
  if (!canTransitionStudyState(from, to)) {
    throw new Error(`illegal study state transition: ${from} -> ${to}`);
  }
}

export function canTransitionHistoricalState(from, to) {
  const allowed = HISTORICAL_STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertHistoricalStateTransition(from, to) {
  if (!canTransitionHistoricalState(from, to)) {
    throw new Error(`illegal historical state transition: ${from} -> ${to}`);
  }
}

export function refusesTopUp(state) {
  return state === STUDY_STATES.FROZEN_C1 || state === STUDY_STATES.VERIFIED;
}

export function refusesHistoricalTopUp(state) {
  return state === HISTORICAL_STATES.FROZEN_HR1 || state === HISTORICAL_STATES.VERIFIED;
}

export function canTransitionMaiaHistoricalState(from, to) {
  const allowed = MAIA_HISTORICAL_STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertMaiaHistoricalStateTransition(from, to) {
  if (!canTransitionMaiaHistoricalState(from, to)) {
    throw new Error(`illegal H-M1 state transition: ${from} -> ${to}`);
  }
}

export function refusesMaiaHistoricalTopUp(state) {
  return state === MAIA_HISTORICAL_STATES.FROZEN_HM1 || state === MAIA_HISTORICAL_STATES.VERIFIED;
}

export function classifyIncomingGame(record, { burnedIds, acquiredById } = {}) {
  const gameId = String(record?.gameId || "");
  if (!gameId) return { action: "accept" };
  if (burnedIds?.has?.(gameId)) return { action: "skip", reason: "burned" };
  const existing = acquiredById?.get?.(gameId);
  if (!existing) return { action: "accept" };
  const incomingHash = gameContentHash(record);
  const existingHash = gameContentHash(existing);
  if (incomingHash === existingHash) return { action: "skip", reason: "duplicate" };
  return {
    action: "conflict",
    reason: "content-mismatch",
    gameId,
    existingHash,
    incomingHash,
  };
}

export function mergeAcquiredGames(existingGames, incomingGames, { burnedIds } = {}) {
  const byId = new Map();
  for (const game of existingGames || []) {
    if (game?.gameId) byId.set(String(game.gameId), game);
  }
  const accepted = [];
  const skipped = [];
  const conflicts = [];
  for (const record of incomingGames || []) {
    const verdict = classifyIncomingGame(record, { burnedIds, acquiredById: byId });
    if (verdict.action === "accept") {
      accepted.push(record);
      if (record?.gameId) byId.set(String(record.gameId), record);
      continue;
    }
    if (verdict.action === "skip") {
      skipped.push({ gameId: record?.gameId || null, reason: verdict.reason });
      continue;
    }
    conflicts.push(verdict);
  }
  if (conflicts.length) {
    const first = conflicts[0];
    throw new Error(`game-id content conflict for ${first.gameId}`);
  }
  return {
    games: sortGamesByCreatedAt([...(existingGames || []), ...accepted]),
    accepted,
    skipped,
  };
}

export function countGamesByColor(games) {
  let white = 0;
  let black = 0;
  for (const game of games || []) {
    if (game?.color === "white") white += 1;
    else if (game?.color === "black") black += 1;
  }
  return { white, black, total: (games || []).length };
}

export function filterStrictlyAfterBoundary(games, boundaryMs) {
  const ms = Number(boundaryMs);
  return (games || []).filter((game) => {
    const createdAtMs = gameCreatedAtMs(game);
    return createdAtMs != null && createdAtMs > ms;
  });
}

/** Eligible H-R1 games: lookbackFloorMs <= createdAtMs < upperExclusiveMs. */
export function filterHistoricalWindow(games, {
  lookbackFloorMs,
  upperExclusiveMs,
} = {}) {
  const floor = Number(lookbackFloorMs);
  const upper = Number(upperExclusiveMs);
  return (games || []).filter((game) => {
    const createdAtMs = gameCreatedAtMs(game);
    return createdAtMs != null && createdAtMs >= floor && createdAtMs < upper;
  });
}

export function excludeBurnedGames(games, burnedIds) {
  const burned = burnedIds instanceof Set ? burnedIds : new Set(burnedIds || []);
  return (games || []).filter((game) => !burned.has(String(game?.gameId || "")));
}

/**
 * Earliest createdAt ms where BOTH colors reach `minPerColor`, including timestamp ties.
 * Partition = all strictly-after-boundary games with createdAtMs <= boundaryCreatedAtMs.
 */
export function computeC1FreezeBoundary(games, {
  boundaryMs,
  minPerColor = STUDY_DEFAULT_MIN_PER_COLOR,
} = {}) {
  const eligible = sortGamesByCreatedAt(filterStrictlyAfterBoundary(games, boundaryMs));
  let white = 0;
  let black = 0;
  let boundaryCreatedAtMs = null;

  for (const game of eligible) {
    if (game.color === "white") white += 1;
    else if (game.color === "black") black += 1;
    if (white >= minPerColor && black >= minPerColor) {
      boundaryCreatedAtMs = gameCreatedAtMs(game);
      break;
    }
  }

  if (boundaryCreatedAtMs == null) {
    return {
      ready: false,
      boundaryCreatedAtMs: null,
      partitionGames: [],
      counts: { white, black, total: eligible.length },
    };
  }

  const partitionGames = eligible.filter((game) => gameCreatedAtMs(game) <= boundaryCreatedAtMs);
  const counts = countGamesByColor(partitionGames);
  return {
    ready: true,
    boundaryCreatedAtMs,
    partitionGames,
    counts,
  };
}

/**
 * Backward-contiguous H-R1 freeze: walk newest-to-oldest within the preregistered window,
 * find the oldest boundary where both colors reach `minPerColor`, then include every
 * eligible game from that boundary through upperExclusive (timestamp ties included).
 */
export function computeHistoricalFreezeBoundary(games, {
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  minPerColor = HISTORICAL_DEFAULT_MIN_PER_COLOR,
} = {}) {
  const eligible = sortGamesByCreatedAtDesc(
    excludeBurnedGames(
      filterHistoricalWindow(games, { lookbackFloorMs, upperExclusiveMs }),
      burnedGameIds,
    ),
  );
  let white = 0;
  let black = 0;
  let boundaryCreatedAtMs = null;

  for (const game of eligible) {
    if (game.color === "white") white += 1;
    else if (game.color === "black") black += 1;
    if (white >= minPerColor && black >= minPerColor) {
      boundaryCreatedAtMs = gameCreatedAtMs(game);
      break;
    }
  }

  if (boundaryCreatedAtMs == null) {
    return {
      ready: false,
      boundaryCreatedAtMs: null,
      partitionGames: [],
      counts: { white, black, total: eligible.length },
      eligibleCount: eligible.length,
    };
  }

  const partitionGames = sortGamesByCreatedAt(
    eligible.filter((game) => gameCreatedAtMs(game) >= boundaryCreatedAtMs),
  );
  const counts = countGamesByColor(partitionGames);
  return {
    ready: true,
    boundaryCreatedAtMs,
    partitionGames,
    counts,
    eligibleCount: eligible.length,
  };
}

export function isHistoricalFreezeReady(games, options = {}) {
  return computeHistoricalFreezeBoundary(games, options).ready;
}

/**
 * Backward-contiguous H-M1 freeze: same walk as H-R1 but excludes burned IDs
 * and H-R1 frozen IDs pinned in the preregistered protocol.
 */
export function computeMaiaHistoricalFreezeBoundary(games, {
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  hR1FrozenGameIds = [],
  minPerColor = MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR,
} = {}) {
  return computeHistoricalFreezeBoundary(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds: unionExcludedGameIds(burnedGameIds, hR1FrozenGameIds),
    minPerColor,
  });
}

export function isMaiaHistoricalFreezeReady(games, options = {}) {
  return computeMaiaHistoricalFreezeBoundary(games, options).ready;
}

export function auditPartitionOverlaps({
  burnedGameIds = [],
  acquiredGameIds = [],
  c1GameIds = [],
} = {}) {
  const issues = [];
  const burned = new Set(burnedGameIds);
  const acquired = new Set(acquiredGameIds);
  const c1 = new Set(c1GameIds);

  for (const gameId of c1) {
    if (burned.has(gameId)) issues.push({ kind: "c1-burned-overlap", gameId });
    if (!acquired.has(gameId)) issues.push({ kind: "c1-not-acquired", gameId });
  }

  const seen = new Set();
  for (const gameId of acquiredGameIds) {
    if (seen.has(gameId)) issues.push({ kind: "acquired-duplicate-id", gameId });
    seen.add(gameId);
  }

  return { ok: issues.length === 0, issues };
}

export function auditHistoricalPartitionOverlaps({
  burnedGameIds = [],
  acquiredGameIds = [],
  historicalGameIds = [],
} = {}) {
  const issues = [];
  const burned = new Set(burnedGameIds);
  const acquired = new Set(acquiredGameIds);
  const historical = new Set(historicalGameIds);

  for (const gameId of historical) {
    if (burned.has(gameId)) issues.push({ kind: "historical-burned-overlap", gameId });
    if (!acquired.has(gameId)) issues.push({ kind: "historical-not-acquired", gameId });
  }

  const seen = new Set();
  for (const gameId of acquiredGameIds) {
    if (seen.has(gameId)) issues.push({ kind: "acquired-duplicate-id", gameId });
    seen.add(gameId);
  }

  return { ok: issues.length === 0, issues };
}

export function auditMaiaHistoricalPartitionOverlaps({
  burnedGameIds = [],
  hR1FrozenGameIds = [],
  acquiredGameIds = [],
  maiaHistoricalGameIds = [],
} = {}) {
  const issues = [];
  const burned = new Set(burnedGameIds);
  const hR1Frozen = new Set(hR1FrozenGameIds);
  const acquired = new Set(acquiredGameIds);
  const maiaHistorical = new Set(maiaHistoricalGameIds);

  for (const gameId of maiaHistorical) {
    if (burned.has(gameId)) issues.push({ kind: "maia-historical-burned-overlap", gameId });
    if (hR1Frozen.has(gameId)) issues.push({ kind: "maia-historical-hr1-frozen-overlap", gameId });
    if (!acquired.has(gameId)) issues.push({ kind: "maia-historical-not-acquired", gameId });
  }

  const seen = new Set();
  for (const gameId of acquiredGameIds) {
    if (seen.has(gameId)) issues.push({ kind: "acquired-duplicate-id", gameId });
    seen.add(gameId);
  }

  return { ok: issues.length === 0, issues };
}

export function buildCorpusManifest({
  protocolId = STUDY_PROTOCOL_ID,
  games = [],
  boundaryMs = null,
  createdAt = null,
} = {}) {
  const sorted = sortGamesByCreatedAt(games);
  const gameIds = sorted.map((game) => game.gameId).filter(Boolean);
  return {
    kind: "scout-v15-study-corpus",
    version: 1,
    protocolId,
    createdAt: createdAt || new Date().toISOString(),
    boundaryMs,
    gameCount: sorted.length,
    counts: countGamesByColor(sorted),
    gameIds,
    gamesSha256: sha256Hex(sorted.map((game) => canonicalizeGameRecord(game))),
  };
}

export function buildC1PartitionManifest({
  protocolId = STUDY_PROTOCOL_ID,
  protocolSha256 = null,
  boundaryMs,
  freezeBoundaryCreatedAtMs,
  games = [],
  createdAt = null,
} = {}) {
  const sorted = sortGamesByCreatedAt(games);
  const gameIds = sorted.map((game) => game.gameId).filter(Boolean);
  return {
    kind: "scout-v15-c1-partition",
    version: 1,
    protocolId,
    protocolSha256,
    immutable: true,
    createdAt: createdAt || new Date().toISOString(),
    legacyBoundaryMs: boundaryMs,
    freezeBoundaryCreatedAtMs,
    gameCount: sorted.length,
    counts: countGamesByColor(sorted),
    gameIds,
    gamesSha256: sha256Hex(sorted.map((game) => canonicalizeGameRecord(game))),
  };
}

export function buildHistoricalCorpusManifest({
  protocolId = HISTORICAL_PROTOCOL_ID,
  games = [],
  lookbackFloorMs = null,
  upperExclusiveMs = null,
  createdAt = null,
} = {}) {
  const sorted = sortGamesByCreatedAt(games);
  const gameIds = sorted.map((game) => game.gameId).filter(Boolean);
  return {
    kind: "scout-v15-historical-study-corpus",
    version: 1,
    protocolId,
    createdAt: createdAt || new Date().toISOString(),
    lookbackFloorMs,
    upperExclusiveMs,
    gameCount: sorted.length,
    counts: countGamesByColor(sorted),
    gameIds,
    gamesSha256: sha256Hex(sorted.map((game) => canonicalizeGameRecord(game))),
  };
}

export function buildHistoricalPartitionManifest({
  protocolId = HISTORICAL_PROTOCOL_ID,
  protocolSha256 = null,
  lookbackFloorMs,
  upperExclusiveMs,
  freezeBoundaryCreatedAtMs,
  games = [],
  createdAt = null,
} = {}) {
  const sorted = sortGamesByCreatedAt(games);
  const gameIds = sorted.map((game) => game.gameId).filter(Boolean);
  return {
    kind: HISTORICAL_PARTITION_KIND,
    version: 1,
    protocolId,
    protocolSha256,
    immutable: true,
    createdAt: createdAt || new Date().toISOString(),
    lookbackFloorMs,
    upperExclusiveMs,
    freezeBoundaryCreatedAtMs,
    gameCount: sorted.length,
    counts: countGamesByColor(sorted),
    gameIds,
    gamesSha256: sha256Hex(sorted.map((game) => canonicalizeGameRecord(game))),
  };
}

export function buildMaiaHistoricalCorpusManifest({
  protocolId = MAIA_HISTORICAL_PROTOCOL_ID,
  games = [],
  lookbackFloorMs = null,
  upperExclusiveMs = null,
  createdAt = null,
} = {}) {
  const sorted = sortGamesByCreatedAt(games);
  const gameIds = sorted.map((game) => game.gameId).filter(Boolean);
  return {
    kind: "scout-v15-historical-m1-study-corpus",
    version: 1,
    protocolId,
    createdAt: createdAt || new Date().toISOString(),
    lookbackFloorMs,
    upperExclusiveMs,
    gameCount: sorted.length,
    counts: countGamesByColor(sorted),
    gameIds,
    gamesSha256: sha256Hex(sorted.map((game) => canonicalizeGameRecord(game))),
  };
}

export function buildMaiaHistoricalPartitionManifest({
  protocolId = MAIA_HISTORICAL_PROTOCOL_ID,
  protocolSha256 = null,
  lookbackFloorMs,
  upperExclusiveMs,
  freezeBoundaryCreatedAtMs,
  games = [],
  createdAt = null,
} = {}) {
  const sorted = sortGamesByCreatedAt(games);
  const gameIds = sorted.map((game) => game.gameId).filter(Boolean);
  return {
    kind: MAIA_HISTORICAL_PARTITION_KIND,
    version: 1,
    protocolId,
    protocolSha256,
    immutable: true,
    createdAt: createdAt || new Date().toISOString(),
    lookbackFloorMs,
    upperExclusiveMs,
    freezeBoundaryCreatedAtMs,
    gameCount: sorted.length,
    counts: countGamesByColor(sorted),
    gameIds,
    gamesSha256: sha256Hex(sorted.map((game) => canonicalizeGameRecord(game))),
  };
}

export function resolveStudyLifecycleState(games, {
  boundaryMs,
  minPerColor = STUDY_DEFAULT_MIN_PER_COLOR,
  frozen = false,
  verified = false,
} = {}) {
  if (verified) return STUDY_STATES.VERIFIED;
  if (frozen) return STUDY_STATES.FROZEN_C1;
  const c1 = computeC1FreezeBoundary(games, { boundaryMs, minPerColor });
  if (c1.ready) return STUDY_STATES.ACQUIRED;
  const fresh = filterStrictlyAfterBoundary(games, boundaryMs);
  if (!fresh.length) return STUDY_STATES.INITIALIZED;
  return STUDY_STATES.AWAITING_DATA;
}

/**
 * Lifecycle after a completed acquire pass. Empty post-boundary corpus means
 * awaiting-data (exhausted search), not initialized (never started).
 */
export function resolvePostAcquireLifecycleState(games, {
  boundaryMs,
  minPerColor = STUDY_DEFAULT_MIN_PER_COLOR,
} = {}) {
  const lifecycle = resolveStudyLifecycleState(games, { boundaryMs, minPerColor });
  if (lifecycle === STUDY_STATES.INITIALIZED) {
    return STUDY_STATES.AWAITING_DATA;
  }
  return lifecycle;
}

export function resolveHistoricalLifecycleState(games, {
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  minPerColor = HISTORICAL_DEFAULT_MIN_PER_COLOR,
  frozen = false,
  verified = false,
} = {}) {
  if (verified) return HISTORICAL_STATES.VERIFIED;
  if (frozen) return HISTORICAL_STATES.FROZEN_HR1;
  const freeze = computeHistoricalFreezeBoundary(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    minPerColor,
  });
  if (freeze.ready) return HISTORICAL_STATES.ACQUIRED;
  const windowed = filterHistoricalWindow(games, { lookbackFloorMs, upperExclusiveMs });
  if (!windowed.length) return HISTORICAL_STATES.INITIALIZED;
  return HISTORICAL_STATES.INSUFFICIENT_DATA;
}

export function resolvePostAcquireHistoricalLifecycleState(games, options = {}) {
  const lifecycle = resolveHistoricalLifecycleState(games, options);
  if (lifecycle === HISTORICAL_STATES.INITIALIZED) {
    return HISTORICAL_STATES.INSUFFICIENT_DATA;
  }
  return lifecycle;
}

export function resolveMaiaHistoricalLifecycleState(games, {
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  hR1FrozenGameIds = [],
  minPerColor = MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR,
  frozen = false,
  verified = false,
} = {}) {
  if (verified) return MAIA_HISTORICAL_STATES.VERIFIED;
  if (frozen) return MAIA_HISTORICAL_STATES.FROZEN_HM1;
  const freeze = computeMaiaHistoricalFreezeBoundary(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    hR1FrozenGameIds,
    minPerColor,
  });
  if (freeze.ready) return MAIA_HISTORICAL_STATES.ACQUIRED;
  const windowed = filterHistoricalWindow(games, { lookbackFloorMs, upperExclusiveMs });
  if (!windowed.length) return MAIA_HISTORICAL_STATES.INITIALIZED;
  return MAIA_HISTORICAL_STATES.INSUFFICIENT_DATA;
}

export function resolvePostAcquireMaiaHistoricalLifecycleState(games, options = {}) {
  const lifecycle = resolveMaiaHistoricalLifecycleState(games, options);
  if (lifecycle === MAIA_HISTORICAL_STATES.INITIALIZED) {
    return MAIA_HISTORICAL_STATES.INSUFFICIENT_DATA;
  }
  return lifecycle;
}

/** Finalize a stranded acquiring state when checkpoint already completed. */
export function recoverStrandedAcquireState({
  state,
  games = [],
  checkpoint = null,
  boundaryMs,
  minPerColor = STUDY_DEFAULT_MIN_PER_COLOR,
} = {}) {
  if (state !== STUDY_STATES.ACQUIRING || !checkpoint?.completed) {
    return { state, recovered: false, lifecycle: null };
  }
  const lifecycle = resolvePostAcquireLifecycleState(games, { boundaryMs, minPerColor });
  if (!canTransitionStudyState(state, lifecycle)) {
    return { state, recovered: false, lifecycle };
  }
  return { state: lifecycle, recovered: true, lifecycle };
}

export function recoverStrandedHistoricalAcquireState({
  state,
  games = [],
  checkpoint = null,
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  minPerColor = HISTORICAL_DEFAULT_MIN_PER_COLOR,
} = {}) {
  if (state !== HISTORICAL_STATES.ACQUIRING || !checkpoint?.completed) {
    return { state, recovered: false, lifecycle: null };
  }
  const lifecycle = resolvePostAcquireHistoricalLifecycleState(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    minPerColor,
  });
  if (!canTransitionHistoricalState(state, lifecycle)) {
    return { state, recovered: false, lifecycle };
  }
  return { state: lifecycle, recovered: true, lifecycle };
}

export function recoverStrandedMaiaHistoricalAcquireState({
  state,
  games = [],
  checkpoint = null,
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  hR1FrozenGameIds = [],
  minPerColor = MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR,
} = {}) {
  if (state !== MAIA_HISTORICAL_STATES.ACQUIRING || !checkpoint?.completed) {
    return { state, recovered: false, lifecycle: null };
  }
  const lifecycle = resolvePostAcquireMaiaHistoricalLifecycleState(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    hR1FrozenGameIds,
    minPerColor,
  });
  if (!canTransitionMaiaHistoricalState(state, lifecycle)) {
    return { state, recovered: false, lifecycle };
  }
  return { state: lifecycle, recovered: true, lifecycle };
}

/** H-R1 acquisition status without outcomes or engine metrics. */
export function buildHistoricalStudyStatus({
  state,
  protocolId = HISTORICAL_PROTOCOL_ID,
  games = [],
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  minPerColor = HISTORICAL_DEFAULT_MIN_PER_COLOR,
  checkpoint = null,
  frozenAt = null,
  verifiedAt = null,
  corpusSha256 = null,
  historicalManifestSha256 = null,
} = {}) {
  const acquiredCounts = countGamesByColor(games);
  const freeze = computeHistoricalFreezeBoundary(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    minPerColor,
  });
  return {
    protocolId,
    state,
    acquired: acquiredCounts,
    historical: {
      ready: freeze.ready,
      insufficientData: !freeze.ready,
      boundaryCreatedAtMs: freeze.boundaryCreatedAtMs,
      counts: freeze.counts,
      eligibleCount: freeze.eligibleCount,
      minimumPerColor: minPerColor,
      lookbackFloorMs,
      upperExclusiveMs,
    },
    checkpoint,
    frozenAt,
    verifiedAt,
    corpusSha256,
    historicalManifestSha256,
  };
}

/** H-M1 acquisition status without outcomes or engine metrics. */
export function buildMaiaHistoricalStudyStatus({
  state,
  protocolId = MAIA_HISTORICAL_PROTOCOL_ID,
  games = [],
  lookbackFloorMs,
  upperExclusiveMs,
  burnedGameIds = [],
  hR1FrozenGameIds = [],
  minPerColor = MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR,
  checkpoint = null,
  frozenAt = null,
  verifiedAt = null,
  corpusSha256 = null,
  maiaHistoricalManifestSha256 = null,
} = {}) {
  const acquiredCounts = countGamesByColor(games);
  const freeze = computeMaiaHistoricalFreezeBoundary(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    hR1FrozenGameIds,
    minPerColor,
  });
  return {
    protocolId,
    state,
    acquired: acquiredCounts,
    maiaHistorical: {
      ready: freeze.ready,
      insufficientData: !freeze.ready,
      boundaryCreatedAtMs: freeze.boundaryCreatedAtMs,
      counts: freeze.counts,
      eligibleCount: freeze.eligibleCount,
      minimumPerColor: minPerColor,
      lookbackFloorMs,
      upperExclusiveMs,
      excludedGameCount: unionExcludedGameIds(burnedGameIds, hR1FrozenGameIds).length,
    },
    checkpoint,
    frozenAt,
    verifiedAt,
    corpusSha256,
    maiaHistoricalManifestSha256,
  };
}

/** Acquisition status without outcomes or engine metrics. */
export function buildStudyStatus({
  state,
  protocolId = STUDY_PROTOCOL_ID,
  games = [],
  boundaryMs,
  minPerColor = STUDY_DEFAULT_MIN_PER_COLOR,
  checkpoint = null,
  frozenAt = null,
  verifiedAt = null,
  corpusSha256 = null,
  c1ManifestSha256 = null,
} = {}) {
  const acquiredCounts = countGamesByColor(games);
  const c1 = computeC1FreezeBoundary(games, { boundaryMs, minPerColor });
  return {
    protocolId,
    state,
    acquired: acquiredCounts,
    c1: {
      ready: c1.ready,
      awaitingData: !c1.ready,
      boundaryCreatedAtMs: c1.boundaryCreatedAtMs,
      counts: c1.counts,
      minimumPerColor: minPerColor,
    },
    checkpoint,
    frozenAt,
    verifiedAt,
    corpusSha256,
    c1ManifestSha256,
  };
}

export function verifyStudyArtifacts({
  state,
  games = [],
  corpusManifest = null,
  c1Manifest = null,
  c1Games = [],
  burnedGameIds = [],
  boundaryMs,
  protocolId = STUDY_PROTOCOL_ID,
  protocolSha256 = null,
  snapshotProtocolSha256 = null,
  checkpoint = null,
  events = [],
  minPerColor = STUDY_DEFAULT_MIN_PER_COLOR,
} = {}) {
  const issues = [];
  const lifecycle = resolveStudyLifecycleState(games, {
    boundaryMs,
    frozen: state === STUDY_STATES.FROZEN_C1 || state === STUDY_STATES.VERIFIED,
    verified: state === STUDY_STATES.VERIFIED,
  });
  const preFreezeStates = new Set([
    STUDY_STATES.INITIALIZED,
    STUDY_STATES.ACQUIRING,
    STUDY_STATES.ACQUIRED,
    STUDY_STATES.AWAITING_DATA,
  ]);
  const lifecycleCompatible = lifecycle === state
    || (preFreezeStates.has(state) && preFreezeStates.has(lifecycle));
  if (!lifecycleCompatible && (state === STUDY_STATES.FROZEN_C1 || state === STUDY_STATES.VERIFIED)) {
    issues.push({ kind: "state-mismatch", expected: lifecycle, actual: state });
  }

  if (protocolSha256 != null || snapshotProtocolSha256 != null) {
    const protocolCheck = verifyProtocolSha256({
      expectedSha256: snapshotProtocolSha256 ?? protocolSha256,
      actualSha256: protocolSha256 ?? snapshotProtocolSha256,
    });
    if (!protocolCheck.ok) issues.push({ kind: protocolCheck.kind, ...protocolCheck });
  }

  if (corpusManifest) {
    const expectedSha = sha256Hex(games.map((game) => canonicalizeGameRecord(game)));
    if (corpusManifest.gamesSha256 !== expectedSha) {
      issues.push({ kind: "corpus-hash-mismatch", expected: expectedSha, actual: corpusManifest.gamesSha256 });
    }
    const idCheck = verifyManifestGameIds(corpusManifest, games);
    if (!idCheck.ok) issues.push(idCheck);
  }

  if (c1Manifest) {
    const expectedSha = sha256Hex(c1Games.map((game) => canonicalizeGameRecord(game)));
    if (c1Manifest.gamesSha256 !== expectedSha) {
      issues.push({ kind: "c1-hash-mismatch", expected: expectedSha, actual: c1Manifest.gamesSha256 });
    }
    if (c1Manifest.protocolId && c1Manifest.protocolId !== protocolId) {
      issues.push({
        kind: "c1-manifest-protocol-id-mismatch",
        expected: protocolId,
        actual: c1Manifest.protocolId,
      });
    }
    const expectedProtocolSha = snapshotProtocolSha256 ?? protocolSha256;
    if (expectedProtocolSha != null) {
      if (!c1Manifest.protocolSha256) {
        issues.push({ kind: "c1-manifest-missing-protocol-sha" });
      } else {
        const manifestProtocolCheck = verifyProtocolSha256({
          expectedSha256: expectedProtocolSha,
          actualSha256: c1Manifest.protocolSha256,
        });
        if (!manifestProtocolCheck.ok) {
          issues.push({
            ...manifestProtocolCheck,
            kind: "c1-manifest-protocol-sha-mismatch",
          });
        }
      }
    }
    const idCheck = verifyManifestGameIds(c1Manifest, c1Games);
    if (!idCheck.ok) issues.push(idCheck);
    const overlap = auditPartitionOverlaps({
      burnedGameIds,
      acquiredGameIds: games.map((game) => game.gameId).filter(Boolean),
      c1GameIds: c1Games.map((game) => game.gameId).filter(Boolean),
    });
    if (!overlap.ok) issues.push(...overlap.issues);

    const freeze = computeC1FreezeBoundary(games, { boundaryMs, minPerColor });
    if (freeze.ready) {
      if (c1Manifest.freezeBoundaryCreatedAtMs !== freeze.boundaryCreatedAtMs) {
        issues.push({
          kind: "c1-freeze-boundary-mismatch",
          expected: freeze.boundaryCreatedAtMs,
          actual: c1Manifest.freezeBoundaryCreatedAtMs,
        });
      }
      const expectedC1Ids = freeze.partitionGames.map((game) => game.gameId).filter(Boolean);
      const actualC1Ids = c1Manifest.gameIds || [];
      if (expectedC1Ids.length !== actualC1Ids.length
        || expectedC1Ids.some((id, index) => id !== actualC1Ids[index])) {
        issues.push({
          kind: "c1-partition-ids-mismatch",
          expectedCount: expectedC1Ids.length,
          actualCount: actualC1Ids.length,
        });
      }
    }
  }

  if (state === STUDY_STATES.FROZEN_C1 || state === STUDY_STATES.VERIFIED) {
    const c1 = computeC1FreezeBoundary(games, { boundaryMs, minPerColor });
    if (!c1.ready) issues.push({ kind: "frozen-without-minimum", counts: c1.counts });
  }

  if (checkpoint) {
    const checkpointCheck = verifyCheckpointConsistency({ checkpoint, games, events });
    if (!checkpointCheck.ok) issues.push(...checkpointCheck.issues);
  }

  return { ok: issues.length === 0, issues };
}

export function verifyHistoricalArtifacts({
  state,
  games = [],
  corpusManifest = null,
  historicalManifest = null,
  historicalGames = [],
  burnedGameIds = [],
  lookbackFloorMs,
  upperExclusiveMs,
  protocolId = HISTORICAL_PROTOCOL_ID,
  protocolSha256 = null,
  snapshotProtocolSha256 = null,
  checkpoint = null,
  events = [],
  minPerColor = HISTORICAL_DEFAULT_MIN_PER_COLOR,
} = {}) {
  const issues = [];
  const lifecycle = resolveHistoricalLifecycleState(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    frozen: state === HISTORICAL_STATES.FROZEN_HR1 || state === HISTORICAL_STATES.VERIFIED,
    verified: state === HISTORICAL_STATES.VERIFIED,
  });
  const preFreezeStates = new Set([
    HISTORICAL_STATES.INITIALIZED,
    HISTORICAL_STATES.ACQUIRING,
    HISTORICAL_STATES.ACQUIRED,
    HISTORICAL_STATES.INSUFFICIENT_DATA,
  ]);
  const lifecycleCompatible = lifecycle === state
    || (preFreezeStates.has(state) && preFreezeStates.has(lifecycle));
  if (!lifecycleCompatible
    && (state === HISTORICAL_STATES.FROZEN_HR1 || state === HISTORICAL_STATES.VERIFIED)) {
    issues.push({ kind: "state-mismatch", expected: lifecycle, actual: state });
  }

  if (protocolSha256 != null || snapshotProtocolSha256 != null) {
    const protocolCheck = verifyProtocolSha256({
      expectedSha256: snapshotProtocolSha256 ?? protocolSha256,
      actualSha256: protocolSha256 ?? snapshotProtocolSha256,
    });
    if (!protocolCheck.ok) issues.push({ kind: protocolCheck.kind, ...protocolCheck });
  }

  if (corpusManifest) {
    const expectedSha = sha256Hex(games.map((game) => canonicalizeGameRecord(game)));
    if (corpusManifest.gamesSha256 !== expectedSha) {
      issues.push({
        kind: "corpus-hash-mismatch",
        expected: expectedSha,
        actual: corpusManifest.gamesSha256,
      });
    }
    const idCheck = verifyManifestGameIds(corpusManifest, games);
    if (!idCheck.ok) issues.push(idCheck);
  }

  if (historicalManifest) {
    const expectedSha = sha256Hex(
      sortGamesByCreatedAt(historicalGames).map((game) => canonicalizeGameRecord(game)),
    );
    if (historicalManifest.gamesSha256 !== expectedSha) {
      issues.push({
        kind: "historical-hash-mismatch",
        expected: expectedSha,
        actual: historicalManifest.gamesSha256,
      });
    }
    if (historicalManifest.protocolId && historicalManifest.protocolId !== protocolId) {
      issues.push({
        kind: "historical-manifest-protocol-id-mismatch",
        expected: protocolId,
        actual: historicalManifest.protocolId,
      });
    }
    const expectedProtocolSha = snapshotProtocolSha256 ?? protocolSha256;
    if (expectedProtocolSha != null) {
      if (!historicalManifest.protocolSha256) {
        issues.push({ kind: "historical-manifest-missing-protocol-sha" });
      } else {
        const manifestProtocolCheck = verifyProtocolSha256({
          expectedSha256: expectedProtocolSha,
          actualSha256: historicalManifest.protocolSha256,
        });
        if (!manifestProtocolCheck.ok) {
          issues.push({
            ...manifestProtocolCheck,
            kind: "historical-manifest-protocol-sha-mismatch",
          });
        }
      }
    }
    const idCheck = verifyManifestGameIds(historicalManifest, historicalGames);
    if (!idCheck.ok) issues.push(idCheck);
    const overlap = auditHistoricalPartitionOverlaps({
      burnedGameIds,
      acquiredGameIds: games.map((game) => game.gameId).filter(Boolean),
      historicalGameIds: historicalGames.map((game) => game.gameId).filter(Boolean),
    });
    if (!overlap.ok) issues.push(...overlap.issues);

    const freeze = computeHistoricalFreezeBoundary(games, {
      lookbackFloorMs,
      upperExclusiveMs,
      burnedGameIds,
      minPerColor,
    });
    if (freeze.ready) {
      if (historicalManifest.freezeBoundaryCreatedAtMs !== freeze.boundaryCreatedAtMs) {
        issues.push({
          kind: "historical-freeze-boundary-mismatch",
          expected: freeze.boundaryCreatedAtMs,
          actual: historicalManifest.freezeBoundaryCreatedAtMs,
        });
      }
      const expectedIds = freeze.partitionGames.map((game) => game.gameId).filter(Boolean);
      const actualIds = historicalManifest.gameIds || [];
      if (expectedIds.length !== actualIds.length
        || expectedIds.some((id, index) => id !== actualIds[index])) {
        issues.push({
          kind: "historical-partition-ids-mismatch",
          expectedCount: expectedIds.length,
          actualCount: actualIds.length,
        });
      }
    }
  }

  if (state === HISTORICAL_STATES.FROZEN_HR1 || state === HISTORICAL_STATES.VERIFIED) {
    const freeze = computeHistoricalFreezeBoundary(games, {
      lookbackFloorMs,
      upperExclusiveMs,
      burnedGameIds,
      minPerColor,
    });
    if (!freeze.ready) {
      issues.push({ kind: "frozen-without-minimum", counts: freeze.counts });
    }
  }

  if (checkpoint) {
    const checkpointCheck = verifyCheckpointConsistency({ checkpoint, games, events });
    if (!checkpointCheck.ok) issues.push(...checkpointCheck.issues);
  }

  return { ok: issues.length === 0, issues };
}

export function verifyMaiaHistoricalArtifacts({
  state,
  games = [],
  corpusManifest = null,
  maiaHistoricalManifest = null,
  maiaHistoricalGames = [],
  burnedGameIds = [],
  hR1FrozenGameIds = [],
  lookbackFloorMs,
  upperExclusiveMs,
  protocolId = MAIA_HISTORICAL_PROTOCOL_ID,
  protocolSha256 = null,
  snapshotProtocolSha256 = null,
  checkpoint = null,
  events = [],
  minPerColor = MAIA_HISTORICAL_DEFAULT_MIN_PER_COLOR,
} = {}) {
  const issues = [];
  const lifecycle = resolveMaiaHistoricalLifecycleState(games, {
    lookbackFloorMs,
    upperExclusiveMs,
    burnedGameIds,
    hR1FrozenGameIds,
    frozen: state === MAIA_HISTORICAL_STATES.FROZEN_HM1 || state === MAIA_HISTORICAL_STATES.VERIFIED,
    verified: state === MAIA_HISTORICAL_STATES.VERIFIED,
  });
  const preFreezeStates = new Set([
    MAIA_HISTORICAL_STATES.INITIALIZED,
    MAIA_HISTORICAL_STATES.ACQUIRING,
    MAIA_HISTORICAL_STATES.ACQUIRED,
    MAIA_HISTORICAL_STATES.INSUFFICIENT_DATA,
  ]);
  const lifecycleCompatible = lifecycle === state
    || (preFreezeStates.has(state) && preFreezeStates.has(lifecycle));
  if (!lifecycleCompatible
    && (state === MAIA_HISTORICAL_STATES.FROZEN_HM1 || state === MAIA_HISTORICAL_STATES.VERIFIED)) {
    issues.push({ kind: "state-mismatch", expected: lifecycle, actual: state });
  }

  if (protocolSha256 != null || snapshotProtocolSha256 != null) {
    const protocolCheck = verifyProtocolSha256({
      expectedSha256: snapshotProtocolSha256 ?? protocolSha256,
      actualSha256: protocolSha256 ?? snapshotProtocolSha256,
    });
    if (!protocolCheck.ok) issues.push({ kind: protocolCheck.kind, ...protocolCheck });
  }

  if (corpusManifest) {
    const expectedSha = sha256Hex(games.map((game) => canonicalizeGameRecord(game)));
    if (corpusManifest.gamesSha256 !== expectedSha) {
      issues.push({
        kind: "corpus-hash-mismatch",
        expected: expectedSha,
        actual: corpusManifest.gamesSha256,
      });
    }
    const idCheck = verifyManifestGameIds(corpusManifest, games);
    if (!idCheck.ok) issues.push(idCheck);
  }

  if (maiaHistoricalManifest) {
    const expectedSha = sha256Hex(
      sortGamesByCreatedAt(maiaHistoricalGames).map((game) => canonicalizeGameRecord(game)),
    );
    if (maiaHistoricalManifest.gamesSha256 !== expectedSha) {
      issues.push({
        kind: "maia-historical-hash-mismatch",
        expected: expectedSha,
        actual: maiaHistoricalManifest.gamesSha256,
      });
    }
    if (maiaHistoricalManifest.protocolId && maiaHistoricalManifest.protocolId !== protocolId) {
      issues.push({
        kind: "maia-historical-manifest-protocol-id-mismatch",
        expected: protocolId,
        actual: maiaHistoricalManifest.protocolId,
      });
    }
    if (maiaHistoricalManifest.kind !== MAIA_HISTORICAL_PARTITION_KIND) {
      issues.push({
        kind: "maia-historical-manifest-kind-mismatch",
        expected: MAIA_HISTORICAL_PARTITION_KIND,
        actual: maiaHistoricalManifest.kind,
      });
    }
    const expectedProtocolSha = snapshotProtocolSha256 ?? protocolSha256;
    if (expectedProtocolSha != null) {
      if (!maiaHistoricalManifest.protocolSha256) {
        issues.push({ kind: "maia-historical-manifest-missing-protocol-sha" });
      } else {
        const manifestProtocolCheck = verifyProtocolSha256({
          expectedSha256: expectedProtocolSha,
          actualSha256: maiaHistoricalManifest.protocolSha256,
        });
        if (!manifestProtocolCheck.ok) {
          issues.push({
            ...manifestProtocolCheck,
            kind: "maia-historical-manifest-protocol-sha-mismatch",
          });
        }
      }
    }
    const idCheck = verifyManifestGameIds(maiaHistoricalManifest, maiaHistoricalGames);
    if (!idCheck.ok) issues.push(idCheck);
    const overlap = auditMaiaHistoricalPartitionOverlaps({
      burnedGameIds,
      hR1FrozenGameIds,
      acquiredGameIds: games.map((game) => game.gameId).filter(Boolean),
      maiaHistoricalGameIds: maiaHistoricalGames.map((game) => game.gameId).filter(Boolean),
    });
    if (!overlap.ok) issues.push(...overlap.issues);

    const freeze = computeMaiaHistoricalFreezeBoundary(games, {
      lookbackFloorMs,
      upperExclusiveMs,
      burnedGameIds,
      hR1FrozenGameIds,
      minPerColor,
    });
    if (freeze.ready) {
      if (maiaHistoricalManifest.freezeBoundaryCreatedAtMs !== freeze.boundaryCreatedAtMs) {
        issues.push({
          kind: "maia-historical-freeze-boundary-mismatch",
          expected: freeze.boundaryCreatedAtMs,
          actual: maiaHistoricalManifest.freezeBoundaryCreatedAtMs,
        });
      }
      const expectedIds = freeze.partitionGames.map((game) => game.gameId).filter(Boolean);
      const actualIds = maiaHistoricalManifest.gameIds || [];
      if (expectedIds.length !== actualIds.length
        || expectedIds.some((id, index) => id !== actualIds[index])) {
        issues.push({
          kind: "maia-historical-partition-ids-mismatch",
          expectedCount: expectedIds.length,
          actualCount: actualIds.length,
        });
      }
    }
  }

  if (state === MAIA_HISTORICAL_STATES.FROZEN_HM1 || state === MAIA_HISTORICAL_STATES.VERIFIED) {
    const freeze = computeMaiaHistoricalFreezeBoundary(games, {
      lookbackFloorMs,
      upperExclusiveMs,
      burnedGameIds,
      hR1FrozenGameIds,
      minPerColor,
    });
    if (!freeze.ready) {
      issues.push({ kind: "frozen-without-minimum", counts: freeze.counts });
    }
  }

  if (checkpoint) {
    const checkpointCheck = verifyCheckpointConsistency({ checkpoint, games, events });
    if (!checkpointCheck.ok) issues.push(...checkpointCheck.issues);
  }

  return { ok: issues.length === 0, issues };
}

export function isHistoricalLookbackExhausted(nextUntil, lookbackFloorMs) {
  if (nextUntil == null) return true;
  const floor = Number(lookbackFloorMs);
  return Number.isFinite(floor) && nextUntil < floor;
}

export function buildLichessStudyUrl(username, {
  since,
  until,
  max = 100,
} = {}) {
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    moves: "true",
    clocks: "true",
    evals: "false",
    opening: "false",
    pgnInJson: "true",
    perfType: "blitz,rapid,classical",
  });
  const maxN = Number(max);
  if (Number.isFinite(maxN) && maxN > 0) params.set("max", String(Math.max(10, Math.round(maxN))));
  if (since != null) params.set("since", String(since));
  if (until != null) params.set("until", String(until));
  return `https://lichess.org/api/games/user/${safe}?${params}`;
}

export function oldestCreatedAtMs(records) {
  let oldest = null;
  for (const record of records || []) {
    const ms = gameCreatedAtMs(record);
    if (ms == null) continue;
    if (oldest == null || ms < oldest) oldest = ms;
  }
  return oldest;
}

export function countNonemptyRawLines(rawText) {
  return String(rawText || "").split(/\r?\n/).filter((line) => line.trim()).length;
}

/** Pagination cursor from parsed research records (legacy; prefer raw bounds for acquire). */
export function nextAcquireUntilCursor(records) {
  const oldest = oldestCreatedAtMs(records);
  return oldest == null ? null : oldest - 1;
}

/**
 * Pagination `until` from oldest valid raw `createdAt` on the page.
 * Empty pages return null. Nonempty pages without any valid raw timestamp are fatal.
 */
export function nextAcquireUntilFromRaw(rawText) {
  const lineCount = countNonemptyRawLines(rawText);
  if (lineCount === 0) return null;
  const { oldestRawCreatedAt } = extractRawCreatedAtBounds(rawText);
  if (oldestRawCreatedAt == null) {
    throw new Error("fatal: nonempty page has no valid raw createdAt");
  }
  return oldestRawCreatedAt - 1;
}

/**
 * Plan acquire when a prior checkpoint may already be completed.
 * Normal acquire stays idempotent; `--refresh` resumes from the newest page while
 * preserving prior pages/corpus and allocating new page numbers.
 */
export function planAcquireSession({
  checkpoint = null,
  refresh = false,
} = {}) {
  const base = {
    pageNumber: 0,
    until: null,
    acquiredGameIds: [],
    completed: false,
    ...(checkpoint || {}),
  };
  if (!base.completed) {
    return { action: "continue", checkpoint: base, idempotent: false };
  }
  if (!refresh) {
    return {
      action: "idempotent",
      checkpoint: base,
      idempotent: true,
      needsStrandedRecovery: true,
    };
  }
  return {
    action: "refresh",
    checkpoint: {
      ...base,
      completed: false,
      until: null,
    },
    idempotent: false,
  };
}

export function isRetriableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Non-retriable 4xx (e.g. 404) must fail immediately — never retry. */
export function isFatalHttpStatus(status) {
  const code = Number(status);
  return Number.isFinite(code) && code >= 400 && code < 500 && !isRetriableHttpStatus(code);
}

export function classifyHttpStatusForRetry(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return "unknown";
  if (code >= 200 && code < 300) return "success";
  if (isFatalHttpStatus(code)) return "fatal";
  if (isRetriableHttpStatus(code)) return "retriable";
  if (code >= 400 && code < 500) return "fatal";
  return "unknown";
}

/**
 * Pure fetch retry planner — network errors and 408/429/5xx retry; other 4xx fatal.
 */
export function planFetchRetryAction({
  status = null,
  attempt = 1,
  maxRetries = 5,
  isNetworkError = false,
} = {}) {
  if (status != null && status >= 200 && status < 300) {
    return { action: "success", reason: null };
  }
  if (status != null && isFatalHttpStatus(status)) {
    return { action: "fatal", reason: `http-${status}` };
  }
  if (isNetworkError || (status != null && isRetriableHttpStatus(status))) {
    if (attempt >= maxRetries) {
      return { action: "fatal", reason: isNetworkError ? "network-exhausted" : `http-${status}-exhausted` };
    }
    return {
      action: "retry",
      reason: isNetworkError ? "network" : `http-${status}`,
    };
  }
  if (status != null) return { action: "fatal", reason: `http-${status}` };
  if (isNetworkError) {
    if (attempt >= maxRetries) return { action: "fatal", reason: "network-exhausted" };
    return { action: "retry", reason: "network" };
  }
  return { action: "fatal", reason: "unknown" };
}

export function parseRetryAfterMs(headerValue, fallbackMs = 60_000, now = Date.now()) {
  if (headerValue == null || headerValue === "") return fallbackMs;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(String(headerValue));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return fallbackMs;
}

/** Windows-safe study-relative path using forward slashes. */
export function toStudyRelativePath(studyRoot, absolutePath) {
  const rel = relative(String(studyRoot || ""), String(absolutePath || ""));
  return rel.split("\\").join("/");
}

export function verifyProtocolSha256({ expectedSha256, actualSha256 } = {}) {
  if (!expectedSha256) {
    return { ok: false, kind: "missing-expected-protocol-sha" };
  }
  if (!actualSha256) {
    return { ok: false, kind: "missing-actual-protocol-sha" };
  }
  if (expectedSha256 !== actualSha256) {
    return {
      ok: false,
      kind: "protocol-sha-mismatch",
      expected: expectedSha256,
      actual: actualSha256,
    };
  }
  return { ok: true };
}

export function assertProtocolSha256(ctx) {
  const result = verifyProtocolSha256(ctx);
  if (!result.ok) {
    throw new Error(`protocol snapshot mismatch: ${result.kind}`);
  }
}

export function mergeNdjsonDiagnostics(base, incoming) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = (Number(out[key]) || 0) + value;
    }
  }
  return out;
}

export function extractRawCreatedAtBounds(rawText) {
  let oldestRawCreatedAt = null;
  let newestRawCreatedAt = null;
  for (const line of String(rawText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const raw = Number(obj.createdAt);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      if (oldestRawCreatedAt == null || raw < oldestRawCreatedAt) oldestRawCreatedAt = raw;
      if (newestRawCreatedAt == null || raw > newestRawCreatedAt) newestRawCreatedAt = raw;
    } catch (_) {
      // ignore malformed lines — page diagnostics capture those separately
    }
  }
  return { oldestRawCreatedAt, newestRawCreatedAt };
}

export function hashNdjsonRawLines(rawText) {
  const lineHashes = [];
  const objectHashes = [];
  for (const line of String(rawText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineHashes.push(sha256Hex(trimmed));
    try {
      objectHashes.push(sha256Hex(JSON.parse(trimmed)));
    } catch (_) {
      objectHashes.push(null);
    }
  }
  return { lineHashes, objectHashes };
}

/**
 * No-progress means the acquire cursor (`until`) did not move — not zero new game ids.
 */
export function didAcquireCursorProgress({
  previousUntil = null,
  nextUntil = null,
  emptyPage = false,
} = {}) {
  if (emptyPage) return true;
  if (nextUntil == null) return true;
  if (previousUntil == null) return true;
  return nextUntil !== previousUntil;
}

export function buildMaiaHistoricalAcquisitionManifest({
  protocolSha256 = null,
  aggregateDiagnostics = null,
  pages = [],
  checkpoint = null,
  createdAt = null,
} = {}) {
  return {
    kind: "scout-v15-historical-m1-study-acquisition",
    version: 1,
    protocolSha256,
    createdAt: createdAt || new Date().toISOString(),
    aggregateDiagnostics,
    pageCount: pages.length,
    pages,
    checkpoint: checkpoint
      ? {
        pageNumber: checkpoint.pageNumber ?? null,
        until: checkpoint.until ?? null,
        completed: Boolean(checkpoint.completed),
        acquiredGameIds: [...(checkpoint.acquiredGameIds || [])],
        freezeReady: Boolean(checkpoint.freezeReady),
      }
      : null,
  };
}

export function buildHistoricalAcquisitionManifest({
  protocolSha256 = null,
  aggregateDiagnostics = null,
  pages = [],
  checkpoint = null,
  createdAt = null,
} = {}) {
  return {
    kind: "scout-v15-historical-study-acquisition",
    version: 1,
    protocolSha256,
    createdAt: createdAt || new Date().toISOString(),
    aggregateDiagnostics,
    pageCount: pages.length,
    pages,
    checkpoint: checkpoint
      ? {
        pageNumber: checkpoint.pageNumber ?? null,
        until: checkpoint.until ?? null,
        completed: Boolean(checkpoint.completed),
        acquiredGameIds: [...(checkpoint.acquiredGameIds || [])],
        freezeReady: Boolean(checkpoint.freezeReady),
      }
      : null,
  };
}

export function buildAcquisitionManifest({
  protocolSha256 = null,
  aggregateDiagnostics = null,
  pages = [],
  checkpoint = null,
  createdAt = null,
} = {}) {
  return {
    kind: "scout-v15-study-acquisition",
    version: 1,
    protocolSha256,
    createdAt: createdAt || new Date().toISOString(),
    aggregateDiagnostics,
    pageCount: pages.length,
    pages,
    checkpoint: checkpoint
      ? {
        pageNumber: checkpoint.pageNumber ?? null,
        until: checkpoint.until ?? null,
        completed: Boolean(checkpoint.completed),
        acquiredGameIds: [...(checkpoint.acquiredGameIds || [])],
      }
      : null,
  };
}

export function verifyManifestGameIds(manifest, games) {
  const expected = sortGamesByCreatedAt(games).map((game) => game.gameId).filter(Boolean);
  const actual = manifest?.gameIds || [];
  if (expected.length !== actual.length) {
    return {
      ok: false,
      kind: "manifest-id-count-mismatch",
      expectedCount: expected.length,
      actualCount: actual.length,
    };
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) {
      return {
        ok: false,
        kind: "manifest-id-order-mismatch",
        index,
        expected: expected[index],
        actual: actual[index],
      };
    }
  }
  if (manifest?.gameCount != null && manifest.gameCount !== expected.length) {
    return {
      ok: false,
      kind: "manifest-game-count-mismatch",
      expected: expected.length,
      actual: manifest.gameCount,
    };
  }
  return { ok: true };
}

export function verifyCheckpointConsistency({
  checkpoint = null,
  games = [],
  events = [],
} = {}) {
  const issues = [];
  const corpusIds = new Set((games || []).map((game) => game.gameId).filter(Boolean));
  for (const gameId of checkpoint?.acquiredGameIds || []) {
    if (!corpusIds.has(gameId)) {
      issues.push({ kind: "checkpoint-id-not-in-corpus", gameId });
    }
  }
  const acquireEvents = (events || []).filter((event) => event?.type === "acquire-page");
  if (checkpoint?.lastPageId) {
    const hasPage = acquireEvents.some((event) => event.pageId === checkpoint.lastPageId);
    if (!hasPage) issues.push({ kind: "checkpoint-page-missing-event", pageId: checkpoint.lastPageId });
  }
  if (checkpoint?.completed && checkpoint?.until != null && !issues.length) {
    // completed runs end with until=null; if until is still set, flag inconsistency
  }
  if (checkpoint?.completed && checkpoint?.pageNumber != null) {
    const maxPage = acquireEvents.reduce((max, event) => {
      const match = String(event.pageId || "").match(/page-(\d+)/);
      const num = match ? Number(match[1]) : 0;
      return Math.max(max, num);
    }, 0);
    if (maxPage > 0 && maxPage !== checkpoint.pageNumber) {
      issues.push({
        kind: "checkpoint-page-number-mismatch",
        expected: checkpoint.pageNumber,
        actual: maxPage,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}