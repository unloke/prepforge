// Scout REF-DF Phase 0 — outcome-blind recurrent full-path entry census.
// Pure: no network, filesystem, DOM, engine, Maia, score, or vulnerability modules.

import {
  assertProtocolSha256,
  buildLichessStudyUrl,
  didAcquireCursorProgress,
  extractRawCreatedAtBounds,
  filterHistoricalWindow,
  gameCreatedAtMs,
  hashNdjsonRawLines,
  isHistoricalLookbackExhausted,
  mergeAcquiredGames,
  mergeNdjsonDiagnostics,
  nextAcquireUntilFromRaw,
  sha256Buffer,
  sha256Hex,
  sortGamesByCreatedAt,
  toStudyRelativePath,
  verifyProtocolSha256,
} from "./scout-v15-study.js";

export const REF_DF_PROTOCOL_KIND = "scout-ref-df-phase0-protocol";
export const REF_DF_PROTOCOL_ID = "ericrosen-ref-df-phase0";
export const REF_DF_CENSUS_REPORT_KIND = "scout-ref-df-phase0-census";
export const REF_DF_CENSUS_REPORT_VERSION = 1;
export const REF_DF_FINAL_REPORT_NAME = "ref-df-phase0-census-report.json";

export const REF_DF_SUBJECT_USERNAME = "EricRosen";
export const REF_DF_COLORS = Object.freeze(["white", "black"]);
export const REF_DF_SUBJECT_MOVE_ORDINALS = Object.freeze([2, 3, 4]);

export const REF_DF_STATES = Object.freeze({
  UNINITIALIZED: "uninitialized",
  INITIALIZED: "initialized",
  ACQUIRING: "acquiring",
  ACQUIRED: "acquired",
  INSUFFICIENT_DATA: "insufficient-data",
  CENSUS_COMPLETE: "census-complete",
  VERIFIED: "verified",
});

export const REF_DF_STATE_TRANSITIONS = Object.freeze({
  [REF_DF_STATES.UNINITIALIZED]: [REF_DF_STATES.INITIALIZED],
  [REF_DF_STATES.INITIALIZED]: [REF_DF_STATES.ACQUIRING],
  [REF_DF_STATES.ACQUIRING]: [REF_DF_STATES.ACQUIRED, REF_DF_STATES.INSUFFICIENT_DATA],
  [REF_DF_STATES.ACQUIRED]: [REF_DF_STATES.ACQUIRING, REF_DF_STATES.CENSUS_COMPLETE],
  [REF_DF_STATES.INSUFFICIENT_DATA]: [REF_DF_STATES.ACQUIRING],
  [REF_DF_STATES.CENSUS_COMPLETE]: [REF_DF_STATES.VERIFIED],
  [REF_DF_STATES.VERIFIED]: [],
});

export const REF_DF_VERDICTS = Object.freeze({
  FEASIBLE: "feasible",
  INSUFFICIENT_DATA: "insufficient-data",
  INSUFFICIENT_RECURRENT_ENTRIES: "insufficient-recurrent-entries",
});

export const REF_DF_ALLOWED_GAME_KEYS = Object.freeze([
  "gameId",
  "color",
  "createdAtMs",
  "dayKey",
  "speed",
  "perfEligible",
  "ucis",
]);

export const REF_DF_FORBIDDEN_SOURCE_KEYS = Object.freeze([
  "score",
  "status",
  "result",
  "wdl",
  "winner",
  "losers",
  "eval",
  "evals",
  "stockfish",
  "maia",
  "vulnerability",
  "weakness",
  "prepValue",
  "baselineScorePct",
  "excessErrorCp",
  "responseRate",
  "futureHit",
  "yield",
  "utility",
  "sans",
  "openingSans",
  "rating",
  "opponentRating",
  "clockAfterPly",
  "clockCsAfterPly",
]);

export const REF_DF_FORBIDDEN_REPORT_KEYS = Object.freeze([
  ...REF_DF_FORBIDDEN_SOURCE_KEYS,
  "weaknessClaim",
  "subjectOnlyTrait",
  "causalTrait",
  "expectedReply",
  "futureBehavior",
  "developmentAuthorization",
  "confirmationAuthorization",
  "productAuthorizationFromOutcomes",
]);

const PERF_ELIGIBLE_SPEEDS = new Set(["blitz", "rapid", "classical"]);

const DEFAULT_PREFIX_LENGTHS = Object.freeze({
  white: Object.freeze({ 2: 3, 3: 5, 4: 7 }),
  black: Object.freeze({ 2: 4, 3: 6, 4: 8 }),
});

function finiteMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function sha256RefDfProtocol(protocol) {
  const clone = { ...(protocol || {}) };
  delete clone.protocolSha256;
  return sha256Hex(`${JSON.stringify(clone, null, 2)}\n`);
}

export function utcDayKeyFromMs(createdAtMs) {
  const ms = finiteMs(createdAtMs);
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function prefixLengthForOrdinal(color, ordinal, protocol = null) {
  const lengths = protocol?.prefixLengthsHalfMoves?.[color] || DEFAULT_PREFIX_LENGTHS[color];
  return Number(lengths?.[String(ordinal)] ?? lengths?.[ordinal] ?? NaN);
}

export function minPrefixHalfMovesForColor(color, protocol = null) {
  const ordinals = protocol?.subjectMoveOrdinals || REF_DF_SUBJECT_MOVE_ORDINALS;
  const lengths = ordinals
    .map((ordinal) => prefixLengthForOrdinal(color, ordinal, protocol))
    .filter((len) => Number.isFinite(len) && len > 0);
  return lengths.length ? Math.min(...lengths) : null;
}

export function resolveRefDfStartUntil(protocol) {
  const pinned = Number(protocol?.acquisition?.pagination?.startUntilMs);
  if (Number.isFinite(pinned)) return pinned;
  const upper = Number(protocol?.d0Window?.upperExclusiveMs);
  if (Number.isFinite(upper)) return upper - 1;
  return null;
}

export function censusGameCanonicalKey(game) {
  return JSON.stringify({
    gameId: game.gameId,
    color: game.color,
    createdAtMs: game.createdAtMs,
    dayKey: game.dayKey,
    speed: game.speed,
    perfEligible: game.perfEligible,
    ucis: game.ucis,
  });
}

export function extractExactPrefix(ucis, color, ordinal, protocol = null) {
  const len = prefixLengthForOrdinal(color, ordinal, protocol);
  if (!Number.isFinite(len) || len <= 0) return null;
  if (!Array.isArray(ucis) || ucis.length < len) return null;
  return ucis.slice(0, len);
}

export function formatPrefixKey(color, ordinal, prefix) {
  return `${color}:${ordinal}:${(prefix || []).join(">")}`;
}

export function isStrictPrefix(shorter, longer) {
  if (!Array.isArray(shorter) || !Array.isArray(longer)) return false;
  if (shorter.length >= longer.length) return false;
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

export function isPerfEligibleSpeed(speed) {
  return PERF_ELIGIBLE_SPEEDS.has(String(speed || "").toLowerCase());
}

/** Immediately project a parsed game to the allowlisted census schema. */
export function projectCensusGame(game) {
  const createdAtMs = finiteMs(game?.createdAtMs ?? game?.datestamp);
  const color = game?.color === "black" ? "black" : game?.color === "white" ? "white" : null;
  const speed = typeof game?.speed === "string" ? game.speed.toLowerCase() : null;
  const ucis = Array.isArray(game?.ucis)
    ? game.ucis.map((uci) => String(uci || "")).filter(Boolean)
    : [];
  return {
    gameId: game?.gameId ? String(game.gameId) : null,
    color,
    createdAtMs,
    dayKey: utcDayKeyFromMs(createdAtMs),
    speed,
    perfEligible: isPerfEligibleSpeed(speed),
    ucis,
  };
}

export function scanForbiddenFields(value, {
  forbiddenKeys = REF_DF_FORBIDDEN_SOURCE_KEYS,
  path = "",
  hits = [],
} = {}) {
  if (value == null || typeof value !== "object") return hits;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      scanForbiddenFields(entry, {
        forbiddenKeys,
        path: path ? `${path}[${index}]` : `[${index}]`,
        hits,
      });
    });
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (forbiddenKeys.includes(key)) hits.push(childPath);
    scanForbiddenFields(child, { forbiddenKeys, path: childPath, hits });
  }
  return hits;
}

export function assertNoForbiddenFields(value, {
  forbiddenKeys = REF_DF_FORBIDDEN_SOURCE_KEYS,
  label = "value",
} = {}) {
  const hits = scanForbiddenFields(value, { forbiddenKeys });
  if (hits.length) {
    throw new Error(`${label} contains forbidden fields: ${hits.join(", ")}`);
  }
}

export function resolveBurnedUnionIds(protocol) {
  const artifacts = protocol?.frozenArtifacts || {};
  const legacy = artifacts.legacyGames?.burnedGameIds || [];
  const hr1 = artifacts.hR1FrozenGames?.frozenGameIds || [];
  const hm1 = artifacts.hM1FrozenGames?.frozenGameIds || [];
  return [...new Set([...legacy, ...hr1, ...hm1])];
}

export function verifyBurnedUnion(protocol) {
  const errors = [];
  const legacy = protocol?.frozenArtifacts?.legacyGames?.burnedGameIds || [];
  const hr1 = protocol?.frozenArtifacts?.hR1FrozenGames?.frozenGameIds || [];
  const hm1 = protocol?.frozenArtifacts?.hM1FrozenGames?.frozenGameIds || [];
  const allIds = [...legacy, ...hr1, ...hm1];
  const union = resolveBurnedUnionIds(protocol);
  const expectedCount = Number(protocol?.frozenArtifacts?.burnedUnion?.gameCount);
  if (legacy.length !== 203) errors.push(`expected 203 legacy burned ids got ${legacy.length}`);
  if (hr1.length !== 446) errors.push(`expected 446 H-R1 frozen ids got ${hr1.length}`);
  if (hm1.length !== 449) errors.push(`expected 449 H-M1 frozen ids got ${hm1.length}`);
  if (Number.isFinite(expectedCount) && union.length !== expectedCount) {
    errors.push(`burned union count mismatch expected ${expectedCount} got ${union.length}`);
  }
  if (allIds.length !== union.length) errors.push("burned source lists overlap or contain duplicate ids");
  return { ok: errors.length === 0, errors, burnedUnionIds: union };
}

export function validateRefDfProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== REF_DF_PROTOCOL_KIND) errors.push("invalid kind");
  if (protocol?.protocolId !== REF_DF_PROTOCOL_ID) errors.push("invalid protocolId");
  if (protocol?.phase !== "D0") errors.push("expected phase D0");
  if (protocol?.role !== "non-product-feasibility") errors.push("invalid role");
  if (protocol?.productAuthorization !== false) errors.push("productAuthorization must be false");
  if (protocol?.cannotAuthorizeCards !== true) errors.push("cannotAuthorizeCards must be true");
  if (protocol?.productVerdict !== "preserve-v2") errors.push("expected productVerdict preserve-v2");
  if (protocol?.subject?.lichessUsername !== REF_DF_SUBJECT_USERNAME) errors.push("invalid subject");

  const lower = Number(protocol?.d0Window?.lowerInclusiveMs);
  const upper = Number(protocol?.d0Window?.upperExclusiveMs);
  if (!Number.isFinite(lower)) errors.push("missing d0 lowerInclusiveMs");
  if (!Number.isFinite(upper)) errors.push("missing d0 upperExclusiveMs");
  if (Number.isFinite(lower) && Number.isFinite(upper) && lower >= upper) {
    errors.push("d0 lower must be strictly before upper");
  }

  const ordinals = protocol?.subjectMoveOrdinals;
  if (!Array.isArray(ordinals) || ordinals.join(",") !== "2,3,4") {
    errors.push("expected subjectMoveOrdinals [2,3,4]");
  }

  const minGames = Number(protocol?.censusGates?.minEligibleGamesPerColor);
  const minAntichain = Number(protocol?.censusGates?.minAntichainEntriesPerColor);
  if (!Number.isFinite(minGames) || minGames < 1) errors.push("invalid minEligibleGamesPerColor");
  if (!Number.isFinite(minAntichain) || minAntichain < 1) errors.push("invalid minAntichainEntriesPerColor");

  const unionCheck = verifyBurnedUnion(protocol);
  if (!unionCheck.ok) errors.push(...unionCheck.errors);

  if (protocol?.protocolSha256) {
    const actual = sha256RefDfProtocol(protocol);
    if (actual !== protocol.protocolSha256) errors.push("protocolSha256 mismatch");
  }

  if (!protocol?.claimBoundary?.establishes) errors.push("missing claimBoundary.establishes");
  if (!Array.isArray(protocol?.forbiddenClaims) || !protocol.forbiddenClaims.length) {
    errors.push("missing forbiddenClaims");
  }

  return {
    ok: errors.length === 0,
    errors,
    lowerInclusiveMs: Number.isFinite(lower) ? lower : null,
    upperExclusiveMs: Number.isFinite(upper) ? upper : null,
    burnedUnionIds: unionCheck.burnedUnionIds,
    minEligibleGamesPerColor: Number.isFinite(minGames) ? minGames : 120,
    minAntichainEntriesPerColor: Number.isFinite(minAntichain) ? minAntichain : 3,
    protocolSha256: protocol?.protocolSha256 ?? null,
  };
}

export function filterD0Window(games, {
  lowerInclusiveMs,
  upperExclusiveMs,
} = {}) {
  return filterHistoricalWindow(games, {
    lookbackFloorMs: lowerInclusiveMs,
    upperExclusiveMs,
  });
}

export function filterCensusEligibleGames(games, {
  lowerInclusiveMs,
  upperExclusiveMs,
  burnedUnionIds = [],
  protocol = null,
} = {}) {
  const burned = new Set((burnedUnionIds || []).map((id) => String(id)));
  const projected = [];
  let burnedCollisions = 0;
  const shortGameExclusions = { white: 0, black: 0, total: 0 };
  for (const raw of games || []) {
    const game = projectCensusGame(raw);
    if (!game.gameId || !game.color || game.createdAtMs == null) continue;
    if (burned.has(game.gameId)) {
      burnedCollisions += 1;
      continue;
    }
    if (game.createdAtMs < lowerInclusiveMs || game.createdAtMs >= upperExclusiveMs) continue;
    if (!game.perfEligible) continue;
    if (!game.ucis.length) continue;
    const minPrefix = minPrefixHalfMovesForColor(game.color, protocol);
    if (Number.isFinite(minPrefix) && game.ucis.length < minPrefix) {
      shortGameExclusions[game.color] += 1;
      shortGameExclusions.total += 1;
      continue;
    }
    projected.push(game);
  }

  const byId = new Map();
  const duplicateIds = [];
  const conflictingDuplicates = [];
  for (const game of projected) {
    const existing = byId.get(game.gameId);
    if (!existing) {
      byId.set(game.gameId, game);
      continue;
    }
    duplicateIds.push(game.gameId);
    if (censusGameCanonicalKey(existing) !== censusGameCanonicalKey(game)) {
      conflictingDuplicates.push({
        gameId: game.gameId,
        first: existing,
        second: game,
      });
    }
  }

  const dedupedGames = [...byId.values()].sort((a, b) => {
    const aMs = a.createdAtMs ?? 0;
    const bMs = b.createdAtMs ?? 0;
    if (aMs !== bMs) return aMs - bMs;
    return String(a.gameId).localeCompare(String(b.gameId));
  });

  return {
    games: dedupedGames,
    burnedCollisions,
    duplicateDiagnostics: {
      duplicateIds: [...new Set(duplicateIds)].sort(),
      duplicateRecordCount: duplicateIds.length,
      conflictingDuplicates,
    },
    shortGameExclusions,
  };
}

export function buildPrefixSupport(games, protocol = null) {
  const ordinals = protocol?.subjectMoveOrdinals || REF_DF_SUBJECT_MOVE_ORDINALS;
  const buckets = new Map();

  for (const game of games || []) {
    for (const ordinal of ordinals) {
      const prefix = extractExactPrefix(game.ucis, game.color, ordinal, protocol);
      if (!prefix) continue;
      const key = formatPrefixKey(game.color, ordinal, prefix);
      const bucket = buckets.get(key) || {
        key,
        color: game.color,
        ordinal,
        prefix: [...prefix],
        prefixLength: prefix.length,
        gameIds: new Set(),
        dayKeys: new Set(),
      };
      bucket.gameIds.add(game.gameId);
      if (game.dayKey) bucket.dayKeys.add(game.dayKey);
      buckets.set(key, bucket);
    }
  }

  return [...buckets.values()].map((bucket) => ({
    key: bucket.key,
    color: bucket.color,
    ordinal: bucket.ordinal,
    prefix: bucket.prefix,
    prefixLength: bucket.prefixLength,
    distinctGames: bucket.gameIds.size,
    distinctDates: bucket.dayKeys.size,
    residualLooSupport: Math.max(0, bucket.gameIds.size - 1),
    gameIds: [...bucket.gameIds].sort(),
    dayKeys: [...bucket.dayKeys].sort(),
  }));
}

export function isPrefixEligible(support, protocol = null) {
  const minGames = Number(protocol?.eligibility?.minDistinctGames ?? 3);
  const minDates = Number(protocol?.eligibility?.minDistinctDates ?? 2);
  const minLoo = Number(protocol?.eligibility?.minResidualLooSupport ?? 2);
  return support.distinctGames >= minGames
    && support.distinctDates >= minDates
    && support.residualLooSupport >= minLoo;
}

export function compareAntichainEntries(a, b) {
  if (b.prefixLength !== a.prefixLength) return b.prefixLength - a.prefixLength;
  const keyCmp = String(a.key).localeCompare(String(b.key));
  if (keyCmp !== 0) return keyCmp;
  if (b.distinctGames !== a.distinctGames) return b.distinctGames - a.distinctGames;
  return Number(a.ordinal) - Number(b.ordinal);
}

/** Deterministic deepest-eligible exact-prefix antichain for one color. */
export function buildDeepestEligibleAntichain(supports, {
  color,
  protocol = null,
} = {}) {
  const eligible = (supports || [])
    .filter((entry) => entry.color === color && isPrefixEligible(entry, protocol))
    .sort(compareAntichainEntries);

  const antichain = [];
  for (const entry of eligible) {
    const hasDeeperEligibleDescendant = eligible.some((other) => (
      other !== entry
      && other.prefixLength > entry.prefixLength
      && isStrictPrefix(entry.prefix, other.prefix)
    ));
    if (hasDeeperEligibleDescendant) continue;
    antichain.push({
      key: entry.key,
      color: entry.color,
      ordinal: entry.ordinal,
      prefix: [...entry.prefix],
      prefixLength: entry.prefixLength,
      distinctGames: entry.distinctGames,
      distinctDates: entry.distinctDates,
      residualLooSupport: entry.residualLooSupport,
    });
  }

  antichain.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return antichain;
}

export function buildSupportHistogram(supports) {
  const histogram = {};
  for (const entry of supports || []) {
    const label = String(entry.distinctGames);
    histogram[label] = (histogram[label] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(histogram).sort((a, b) => Number(a[0]) - Number(b[0])),
  );
}

export function buildColorOrdinalDiagnostics(supports, protocol = null) {
  const ordinals = protocol?.subjectMoveOrdinals || REF_DF_SUBJECT_MOVE_ORDINALS;
  const diagnostics = {};
  for (const color of REF_DF_COLORS) {
    diagnostics[color] = {};
    for (const ordinal of ordinals) {
      const ordinalSupports = (supports || []).filter((entry) => (
        entry.color === color && entry.ordinal === ordinal
      ));
      diagnostics[color][ordinal] = {
        prefixCount: ordinalSupports.length,
        eligiblePrefixCount: ordinalSupports.filter((entry) => isPrefixEligible(entry, protocol)).length,
        supportHistogram: buildSupportHistogram(ordinalSupports),
      };
    }
  }
  return diagnostics;
}

export function countGamesByColor(games) {
  let white = 0;
  let black = 0;
  for (const game of games || []) {
    if (game.color === "white") white += 1;
    else if (game.color === "black") black += 1;
  }
  return { white, black, total: white + black };
}

export function resolveRefDfVerdict({
  acquisitionComplete = true,
  gamesByColor = {},
  antichainByColor = {},
  protocol = null,
} = {}) {
  const minGames = Number(protocol?.censusGates?.minEligibleGamesPerColor ?? 120);
  const minAntichain = Number(protocol?.censusGates?.minAntichainEntriesPerColor ?? 3);

  if (!acquisitionComplete
    || gamesByColor.white < minGames
    || gamesByColor.black < minGames) {
    return REF_DF_VERDICTS.INSUFFICIENT_DATA;
  }

  if ((antichainByColor.white?.length ?? 0) < minAntichain
    || (antichainByColor.black?.length ?? 0) < minAntichain) {
    return REF_DF_VERDICTS.INSUFFICIENT_RECURRENT_ENTRIES;
  }

  return REF_DF_VERDICTS.FEASIBLE;
}

export function runRefDfCensus(rawGames, {
  protocol,
  acquisitionComplete = true,
} = {}) {
  const validation = validateRefDfProtocol(protocol);
  if (!validation.ok) {
    const err = new Error(`invalid REF-DF protocol: ${validation.errors.join("; ")}`);
    err.validation = validation;
    throw err;
  }

  assertNoForbiddenFields(protocol, { label: "protocol" });

  const {
    games,
    burnedCollisions,
    duplicateDiagnostics,
    shortGameExclusions,
  } = filterCensusEligibleGames(rawGames, {
    lowerInclusiveMs: validation.lowerInclusiveMs,
    upperExclusiveMs: validation.upperExclusiveMs,
    burnedUnionIds: validation.burnedUnionIds,
    protocol,
  });

  if (duplicateDiagnostics.conflictingDuplicates.length) {
    const ids = duplicateDiagnostics.conflictingDuplicates.map((entry) => entry.gameId).join(", ");
    throw new Error(`conflicting duplicate census game ids: ${ids}`);
  }

  for (const game of games) {
    assertNoForbiddenFields(game, { label: "census game" });
  }

  const supports = buildPrefixSupport(games, protocol);
  const antichainByColor = {
    white: buildDeepestEligibleAntichain(supports, { color: "white", protocol }),
    black: buildDeepestEligibleAntichain(supports, { color: "black", protocol }),
  };
  const gamesByColor = countGamesByColor(games);
  const verdict = resolveRefDfVerdict({
    acquisitionComplete,
    gamesByColor,
    antichainByColor,
    protocol,
  });

  const report = {
    kind: REF_DF_CENSUS_REPORT_KIND,
    version: REF_DF_CENSUS_REPORT_VERSION,
    protocolId: protocol.protocolId,
    protocolSha256: protocol.protocolSha256,
    phase: protocol.phase,
    productAuthorization: false,
    cannotAuthorizeCards: true,
    productVerdict: "preserve-v2",
    establishesOnly: protocol.claimBoundary.establishes,
    claimBoundary: protocol.claimBoundary,
    forbiddenClaims: protocol.forbiddenClaims,
    verdict,
    acquisitionComplete,
    acquisitionDiagnostics: {
      eligibleGames: gamesByColor,
      burnedCollisions,
      duplicateDiagnostics,
      shortGameExclusions,
      supportHistogram: buildSupportHistogram(supports),
      eligiblePrefixCount: supports.filter((entry) => isPrefixEligible(entry, protocol)).length,
      byColorOrdinal: buildColorOrdinalDiagnostics(supports, protocol),
      antichainCounts: {
        white: antichainByColor.white.length,
        black: antichainByColor.black.length,
      },
    },
    antichainByColor,
    createdAt: new Date().toISOString(),
    singleCensusOnly: true,
    immutableAfterReport: true,
  };

  const reportValidation = validateRefDfCensusReport(report, { protocol });
  if (!reportValidation.ok) {
    throw new Error(`invalid REF-DF census report: ${reportValidation.errors.join("; ")}`);
  }
  return report;
}

export function validateRefDfCensusReport(report, { protocol = null } = {}) {
  const errors = [];
  if (report?.kind !== REF_DF_CENSUS_REPORT_KIND) errors.push("invalid report kind");
  if (report?.version !== REF_DF_CENSUS_REPORT_VERSION) errors.push("invalid report version");
  if (report?.productAuthorization !== false) errors.push("report productAuthorization must be false");
  if (report?.cannotAuthorizeCards !== true) errors.push("report cannotAuthorizeCards must be true");
  if (report?.productVerdict !== "preserve-v2") errors.push("report productVerdict must be preserve-v2");
  if (protocol?.protocolSha256 && report?.protocolSha256 !== protocol.protocolSha256) {
    errors.push("report protocolSha256 mismatch");
  }
  if (!report?.claimBoundary?.establishes) errors.push("missing report claimBoundary");
  if (!Object.values(REF_DF_VERDICTS).includes(report?.verdict)) errors.push("invalid verdict");

  const forbiddenHits = scanForbiddenFields(report, {
    forbiddenKeys: REF_DF_FORBIDDEN_REPORT_KEYS,
  });
  if (forbiddenHits.length) {
    errors.push(`forbidden report fields: ${forbiddenHits.join(", ")}`);
  }

  for (const color of REF_DF_COLORS) {
    const entries = report?.antichainByColor?.[color] || [];
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (isStrictPrefix(entries[i].prefix, entries[j].prefix)
          || isStrictPrefix(entries[j].prefix, entries[i].prefix)) {
          errors.push(`antichain ancestor/descendant pair for ${color}: ${entries[i].key} vs ${entries[j].key}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function canTransitionRefDfState(from, to) {
  const allowed = REF_DF_STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertRefDfStateTransition(from, to) {
  if (!canTransitionRefDfState(from, to)) {
    throw new Error(`illegal REF-DF state transition: ${from} -> ${to}`);
  }
}

export function refusesRefDfTopUp(state) {
  return state === REF_DF_STATES.CENSUS_COMPLETE || state === REF_DF_STATES.VERIFIED;
}

export function refusesRefDfReplay(state) {
  return state === REF_DF_STATES.CENSUS_COMPLETE || state === REF_DF_STATES.VERIFIED;
}

export function hashRefDfCorpusGames(games) {
  const sorted = sortGamesByCreatedAt(games);
  return sha256Hex(sorted.map((game) => JSON.stringify(game)));
}

export function buildRefDfCorpusManifest({
  protocolId = REF_DF_PROTOCOL_ID,
  protocolSha256 = null,
  games = [],
  lowerInclusiveMs = null,
  upperExclusiveMs = null,
} = {}) {
  const sorted = sortGamesByCreatedAt(games);
  return {
    kind: "scout-ref-df-phase0-corpus",
    version: 1,
    protocolId,
    protocolSha256,
    lowerInclusiveMs,
    upperExclusiveMs,
    gameCount: sorted.length,
    counts: countGamesByColor(sorted),
    gameIds: sorted.map((game) => game.gameId).filter(Boolean),
    gamesSha256: hashRefDfCorpusGames(sorted),
    createdAt: new Date().toISOString(),
  };
}

export function buildRefDfAcquisitionManifest({
  protocolSha256 = null,
  aggregateDiagnostics = null,
  pages = [],
  checkpoint = null,
} = {}) {
  return {
    kind: "scout-ref-df-phase0-acquisition",
    version: 1,
    protocolSha256,
    createdAt: new Date().toISOString(),
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

export function buildRefDfStudyStatus({
  state,
  protocolId = REF_DF_PROTOCOL_ID,
  games = [],
  lowerInclusiveMs,
  upperExclusiveMs,
  burnedUnionIds = [],
  protocol = null,
  checkpoint = null,
  censusReportSha256 = null,
} = {}) {
  const filtered = filterCensusEligibleGames(games, {
    lowerInclusiveMs,
    upperExclusiveMs,
    burnedUnionIds,
    protocol,
  });
  const counts = countGamesByColor(filtered.games);
  return {
    kind: "scout-ref-df-phase0-status",
    version: 1,
    protocolId,
    state,
    acquisitionComplete: Boolean(checkpoint?.completed),
    allowlistedCounts: counts,
    burnedCollisions: filtered.burnedCollisions,
    checkpointPageNumber: checkpoint?.pageNumber ?? 0,
    censusReportSha256,
  };
}

export function verifyRefDfProtocolIdentity(protocol, {
  snapshotProtocolSha256 = null,
} = {}) {
  const issues = [];
  const canonicalSha256 = sha256RefDfProtocol(protocol);
  if (protocol?.protocolSha256 && protocol.protocolSha256 !== canonicalSha256) {
    issues.push({
      kind: "embedded-protocol-sha-mismatch",
      expected: canonicalSha256,
      actual: protocol.protocolSha256,
    });
  }
  if (snapshotProtocolSha256 && canonicalSha256 !== snapshotProtocolSha256) {
    issues.push({
      kind: "protocol-sha-mismatch",
      expected: snapshotProtocolSha256,
      actual: canonicalSha256,
    });
  }
  return { ok: issues.length === 0, issues, canonicalSha256 };
}

export function extractPinnedGameIdsFromSource({ kind, content }) {
  if (content == null) return [];
  if (kind === "legacy") {
    const raw = typeof content === "string" ? JSON.parse(content) : content;
    const games = Array.isArray(raw) ? raw : [...(raw.white || []), ...(raw.black || [])];
    return games.map((game) => String(game?.gameId || game?.id || "")).filter(Boolean);
  }
  if (kind === "frozen-manifest") {
    const manifest = typeof content === "string" ? JSON.parse(content) : content;
    return (manifest?.gameIds || []).map((id) => String(id)).filter(Boolean);
  }
  return [];
}

export function comparePinnedIdLists(expected = [], actual = []) {
  if (expected.length !== actual.length) {
    return {
      ok: false,
      kind: "pinned-id-count-mismatch",
      expectedCount: expected.length,
      actualCount: actual.length,
    };
  }
  const expectedSorted = expected.map(String).sort();
  const actualSorted = actual.map(String).sort();
  for (let i = 0; i < expectedSorted.length; i += 1) {
    if (expectedSorted[i] !== actualSorted[i]) {
      return {
        ok: false,
        kind: "pinned-id-list-mismatch",
        index: i,
        expected: expectedSorted[i],
        actual: actualSorted[i],
      };
    }
  }
  return { ok: true };
}

export function verifyPinnedFrozenArtifacts(protocol, {
  sources = {},
} = {}) {
  const issues = [];
  const artifacts = protocol?.frozenArtifacts || {};
  const checks = [
    {
      key: "legacyGames",
      kind: "legacy",
      spec: artifacts.legacyGames,
      idField: "burnedGameIds",
    },
    {
      key: "hR1FrozenGames",
      kind: "frozen-manifest",
      spec: artifacts.hR1FrozenGames,
      idField: "frozenGameIds",
    },
    {
      key: "hM1FrozenGames",
      kind: "frozen-manifest",
      spec: artifacts.hM1FrozenGames,
      idField: "frozenGameIds",
    },
  ];

  for (const check of checks) {
    const spec = check.spec || {};
    const source = sources[check.key] || {};
    const relativePath = spec.relativePath || check.key;
    if (!source.exists) {
      issues.push({ kind: "pinned-source-missing", source: check.key, relativePath });
      continue;
    }
    if (spec.sha256 && source.sha256 && spec.sha256 !== source.sha256) {
      issues.push({
        kind: "pinned-source-sha-mismatch",
        source: check.key,
        relativePath,
        expected: spec.sha256,
        actual: source.sha256,
      });
    }
    const expectedIds = spec[check.idField] || [];
    const actualIds = extractPinnedGameIdsFromSource({
      kind: check.kind,
      content: source.content,
    });
    if (Number.isFinite(Number(spec.gameCount)) && actualIds.length !== Number(spec.gameCount)) {
      issues.push({
        kind: "pinned-source-count-mismatch",
        source: check.key,
        relativePath,
        expected: Number(spec.gameCount),
        actual: actualIds.length,
      });
    }
    const listCheck = comparePinnedIdLists(expectedIds, actualIds);
    if (!listCheck.ok) {
      issues.push({ kind: listCheck.kind, source: check.key, relativePath, ...listCheck });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function verifyRefDfAcquisitionPages(acquisitionManifest, {
  resolveRawPath = null,
  resolveReceiptPath = null,
  readFile = null,
  fileExists = null,
} = {}) {
  const issues = [];
  const pages = acquisitionManifest?.pages || [];
  if (!pages.length) {
    issues.push({ kind: "missing-acquisition-pages" });
    return { ok: false, issues };
  }

  for (const page of pages) {
    const pageId = page.pageId;
    const rawPath = resolveRawPath ? resolveRawPath(page) : page.rawPath;
    if (!rawPath) {
      issues.push({ kind: "missing-raw-path", pageId });
      continue;
    }
    if (fileExists && !fileExists(rawPath)) {
      issues.push({ kind: "missing-raw-page", pageId, rawPath });
      continue;
    }
    if (readFile && page.rawSha256) {
      const rawContent = readFile(rawPath);
      if (rawContent == null) {
        issues.push({ kind: "missing-raw-page", pageId, rawPath });
        continue;
      }
      const actualSha = sha256Buffer(Buffer.from(rawContent, "utf8"));
      if (actualSha !== page.rawSha256) {
        issues.push({
          kind: "raw-page-sha-mismatch",
          pageId,
          rawPath,
          expected: page.rawSha256,
          actual: actualSha,
        });
      }
    }

    const receiptPath = resolveReceiptPath ? resolveReceiptPath(page) : null;
    if (receiptPath && fileExists && readFile) {
      if (!fileExists(receiptPath)) {
        issues.push({ kind: "missing-request-receipt", pageId, receiptPath });
      } else {
        const receipt = JSON.parse(readFile(receiptPath));
        if (receipt.rawPath && page.rawPath && receipt.rawPath !== page.rawPath) {
          issues.push({
            kind: "receipt-raw-path-mismatch",
            pageId,
            expected: page.rawPath,
            actual: receipt.rawPath,
          });
        }
        if (receipt.rawSha256 && page.rawSha256 && receipt.rawSha256 !== page.rawSha256) {
          issues.push({
            kind: "receipt-raw-sha-mismatch",
            pageId,
            expected: page.rawSha256,
            actual: receipt.rawSha256,
          });
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function resolveRefDfPostAcquireState({
  currentState,
  checkpoint = null,
  paused = false,
} = {}) {
  if (paused || !checkpoint?.completed) {
    return {
      state: REF_DF_STATES.ACQUIRING,
      eventType: "acquire-paused",
      acquisitionComplete: false,
    };
  }
  if (currentState === REF_DF_STATES.INITIALIZED || currentState === REF_DF_STATES.ACQUIRING) {
    return {
      state: REF_DF_STATES.ACQUIRED,
      eventType: "acquire-complete",
      acquisitionComplete: true,
    };
  }
  return {
    state: currentState,
    eventType: null,
    acquisitionComplete: Boolean(checkpoint?.completed),
  };
}

export function verifyRefDfArtifacts({
  state,
  protocol,
  protocolSha256,
  snapshotProtocolSha256,
  games = [],
  corpusManifest = null,
  acquisitionManifest = null,
  censusReport = null,
  checkpoint = null,
  events = [],
  pinnedSources = null,
  acquisitionPageVerification = null,
} = {}) {
  const issues = [];
  const validation = validateRefDfProtocol(protocol);
  if (!validation.ok) {
    issues.push({ kind: "invalid-protocol", errors: validation.errors });
  }

  const identity = verifyRefDfProtocolIdentity(protocol, { snapshotProtocolSha256 });
  if (!identity.ok) issues.push(...identity.issues);
  const canonicalSha256 = identity.canonicalSha256;
  if (protocolSha256 && protocolSha256 !== canonicalSha256) {
    issues.push({
      kind: "raw-file-protocol-sha-mismatch",
      expected: canonicalSha256,
      actual: protocolSha256,
    });
  }

  if (pinnedSources) {
    const pinned = verifyPinnedFrozenArtifacts(protocol, { sources: pinnedSources });
    if (!pinned.ok) issues.push(...pinned.issues);
  }

  if (acquisitionPageVerification) {
    const pages = verifyRefDfAcquisitionPages(acquisitionManifest, acquisitionPageVerification);
    if (!pages.ok) issues.push(...pages.issues);
  }

  if (corpusManifest) {
    const sorted = sortGamesByCreatedAt(games);
    const counts = countGamesByColor(sorted);
    if (corpusManifest.gameCount !== sorted.length) {
      issues.push({ kind: "corpus-count-mismatch", expected: sorted.length, actual: corpusManifest.gameCount });
    }
    if (corpusManifest.counts?.white !== counts.white || corpusManifest.counts?.black !== counts.black) {
      issues.push({ kind: "corpus-color-count-mismatch", expected: counts, actual: corpusManifest.counts });
    }
    const expectedSha = hashRefDfCorpusGames(sorted);
    if (corpusManifest.gamesSha256 !== expectedSha) {
      issues.push({ kind: "corpus-hash-mismatch", expected: expectedSha, actual: corpusManifest.gamesSha256 });
    }
  }

  if (censusReport) {
    const reportValidation = validateRefDfCensusReport(censusReport, { protocol });
    if (!reportValidation.ok) {
      issues.push({ kind: "invalid-census-report", errors: reportValidation.errors });
    }
    if (censusReport.protocolSha256 !== canonicalSha256) {
      issues.push({ kind: "census-protocol-sha-mismatch" });
    }
  }

  if (state === REF_DF_STATES.CENSUS_COMPLETE || state === REF_DF_STATES.VERIFIED) {
    if (!censusReport) issues.push({ kind: "missing-census-report" });
    if (checkpoint && !checkpoint.completed) issues.push({ kind: "census-before-acquisition-complete" });
  }

  const replayAttempts = (events || []).filter((event) => event.type === "census").length;
  if (replayAttempts > 1) issues.push({ kind: "census-replay-forbidden", attempts: replayAttempts });

  if (acquisitionManifest?.protocolSha256
    && canonicalSha256
    && acquisitionManifest.protocolSha256 !== canonicalSha256) {
    issues.push({ kind: "acquisition-protocol-sha-mismatch" });
  }

  return { ok: issues.length === 0, issues, validation };
}

export {
  assertProtocolSha256,
  buildLichessStudyUrl,
  didAcquireCursorProgress,
  extractRawCreatedAtBounds,
  hashNdjsonRawLines,
  isHistoricalLookbackExhausted,
  mergeAcquiredGames,
  mergeNdjsonDiagnostics,
  nextAcquireUntilFromRaw,
  sha256Buffer,
  sha256Hex,
  toStudyRelativePath,
  verifyProtocolSha256,
};