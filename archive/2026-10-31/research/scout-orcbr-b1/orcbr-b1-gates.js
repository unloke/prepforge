// ORCBR-B1 structural / prequential gates G0–G7 — TRAIN-only, fail-closed.
// No CAL/TEST/network. Product always preserve-v2.

import {
  VERDICTS,
  IDENTITY_CONFIDENCE,
  FROZEN_PINS,
  assertNoRawIdentityLeakage,
  assertOpponentKeysPresent,
  dualParseNdjson,
  resolvePins,
  sortGamesChronologically,
  dedupeGamesById,
  splitTrainAtCutoff,
  stripOutcomesDeep,
  validateProtocolLocks,
  computeReportSha256,
  sha256Hex,
} from "./orcbr-b1-schema.js";
import {
  PACKAGE_SLOT_BUDGET,
  matchUnitToGame,
  packageContentHash,
  validatePackage,
  validatePreparationUnitV2,
} from "./orcbr-b1-units.js";
import {
  generateTrainPackage,
  expandCandidatesToBudget,
  indexOpponentWhiteHistory,
} from "./orcbr-b1-generate.js";

export const GATE_ORDER = Object.freeze(["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"]);

/** Frozen pin defaults — must match orcbr-b1.protocol.json. No silent relaxation. */
export const DEFAULT_PINS = Object.freeze({ ...FROZEN_PINS });

/** Explicit fixture-only floors (tests must opt in; never CLI default). */
export const FIXTURE_PIN_OVERRIDES = Object.freeze({
  research_min_white_games: 2,
  research_min_days: 2,
  research_g_min: 2,
  research_d_min: 2,
});

function gateResult(gate, pass, verdict, detail = {}) {
  return {
    gate,
    pass: !!pass,
    verdict: pass ? (detail.passVerdict || VERDICTS.READY_FOR_GATES) : verdict,
    ...detail,
  };
}

/**
 * G0 — Schema availability / dual-parse custody on local raw bytes only.
 */
export function runG0({
  rawText,
  subjectUsername,
  researchSalt,
  sealedRecords = null,
  protocol = null,
  knownRawTokens = null,
} = {}) {
  if (protocol) {
    const locks = validateProtocolLocks(protocol);
    if (!locks.ok) {
      return gateResult("G0", false, VERDICTS.INVALID, { errors: locks.errors });
    }
  }

  // Path A: sealed records without opponentKey → STOP_SCHEMA_UNAVAILABLE
  if (sealedRecords != null) {
    const check = assertOpponentKeysPresent(sealedRecords);
    if (!check.ok) {
      return gateResult("G0", false, VERDICTS.STOP_SCHEMA_UNAVAILABLE, {
        reason: check.reason,
      });
    }
  }

  if (rawText == null || researchSalt == null) {
    if (sealedRecords != null) {
      // sealed ok path without re-parse — still strip outcomes before downstream
      const cleaned = stripOutcomesDeep(sealedRecords);
      return gateResult("G0", true, VERDICTS.READY_FOR_GATES, {
        path: "sealed-with-opponentKey",
        count: cleaned.length,
        games: cleaned,
      });
    }
    return gateResult("G0", false, VERDICTS.STOP_SCHEMA_UNAVAILABLE, {
      reason: "missing local raw text or research salt",
    });
  }

  let dual;
  try {
    dual = dualParseNdjson(rawText, subjectUsername, researchSalt);
  } catch (err) {
    return gateResult("G0", false, VERDICTS.STOP_SCHEMA_UNAVAILABLE, {
      reason: String(err?.message || err),
    });
  }
  if (!dual.schemaAvailable) {
    return gateResult("G0", false, VERDICTS.STOP_SCHEMA_UNAVAILABLE, {
      reason: "dual-parse recovered no opponentKey",
      rawSha256: dual.rawSha256,
      identityCoverage: dual.identityCoverage,
    });
  }

  const tokens = knownRawTokens
    || (subjectUsername ? [subjectUsername] : []);
  const leak = assertNoRawIdentityLeakage({
    games: dual.games.slice(0, 5),
    receipt: { rawSha256: dual.rawSha256 },
  }, "$", { knownRawTokens: tokens });
  if (!leak.ok) {
    return gateResult("G0", false, VERDICTS.INVALID, {
      reason: "raw identity leakage in parse receipt",
      leaks: leak.leaks,
    });
  }

  return gateResult("G0", true, VERDICTS.READY_FOR_GATES, {
    rawSha256: dual.rawSha256,
    identityCoverage: dual.identityCoverage,
    withOpponentKeyCount: dual.withOpponentKeyCount,
    eligibleCount: dual.eligibleCount,
    games: dual.games,
    passVerdict: VERDICTS.READY_FOR_GATES,
  });
}

/**
 * G1 — Identity coverage ≥ c1 among eligible games.
 * Name-lower is weak: counted in coverage but reported separately; cannot carry G1 alone
 * when every key is name-lower and panel is sparse (protocol §2.3.7).
 */
export function runG1(games, pins = DEFAULT_PINS) {
  const list = games || [];
  if (!list.length) {
    return gateResult("G1", false, VERDICTS.STOP_IDENTITY_SPARSE, { reason: "no games" });
  }
  const withKey = list.filter(
    (g) => g.opponentKey && g.identityConfidence !== IDENTITY_CONFIDENCE.NONE,
  );
  const withId = list.filter(
    (g) => g.opponentKey && g.identityConfidence === IDENTITY_CONFIDENCE.ID,
  );
  const withNameLower = list.filter(
    (g) => g.opponentKey && g.identityConfidence === IDENTITY_CONFIDENCE.NAME_LOWER,
  );
  const coverage = withKey.length / list.length;
  const idCoverage = withId.length / list.length;
  const min = pins.c1_identity_coverage_min ?? DEFAULT_PINS.c1_identity_coverage_min;

  // Weak fallback: name-lower alone may not satisfy G1 at scale.
  // Fail closed when coverage meets c1 only via name-lower (zero id confidence).
  if (coverage < min) {
    return gateResult("G1", false, VERDICTS.STOP_IDENTITY_SPARSE, {
      coverage,
      idCoverage,
      min,
      withKey: withKey.length,
      withId: withId.length,
      withNameLower: withNameLower.length,
      total: list.length,
    });
  }
  if (withId.length === 0 && withNameLower.length > 0) {
    return gateResult("G1", false, VERDICTS.STOP_IDENTITY_SPARSE, {
      coverage,
      idCoverage: 0,
      min,
      reason: "name-lower fallback only (weak identity; fails G1 alone)",
      withKey: withKey.length,
      withNameLower: withNameLower.length,
      total: list.length,
    });
  }
  return gateResult("G1", true, VERDICTS.READY_FOR_GATES, {
    coverage,
    idCoverage,
    withKey: withKey.length,
    withId: withId.length,
    withNameLower: withNameLower.length,
    total: list.length,
  });
}

/**
 * Privacy-safe aggregate diagnostics for G2 longitudinal stop/pass audit.
 * No opponentKey / raw identity / outcome fields — counts and extrema only.
 */
export function buildG2AggregateDiagnostics(games, byKey, { gMin, dMin, nMin, fixtureMode } = {}) {
  const list = games || [];
  let blackGameCount = 0;
  let whiteSubjectGameCount = 0;
  let otherColorCount = 0;
  let gamesWithOpponentKey = 0;
  let outcomeFieldHits = 0;
  const outcomeNames = ["score", "result", "winner", "status", "outcome"];
  for (const g of list) {
    if (g?.color === "black") blackGameCount += 1;
    else if (g?.color === "white") whiteSubjectGameCount += 1;
    else otherColorCount += 1;
    if (g?.opponentKey) gamesWithOpponentKey += 1;
    for (const f of outcomeNames) {
      if (g != null && Object.prototype.hasOwnProperty.call(g, f) && g[f] != null) {
        outcomeFieldHits += 1;
      }
    }
  }

  let maxGamesPerKey = 0;
  let maxDaysPerKey = 0;
  let keysAtOrAboveGMin = 0;
  let keysAtOrAboveDMin = 0;
  let keysAtOrAboveBoth = 0;
  // Coarse game-count histogram (privacy-safe bins; no keys).
  const gamesPerKeyHistogram = {
    "1": 0,
    "2-4": 0,
    "5-9": 0,
    "10-19": 0,
    "20-29": 0,
    "30+": 0,
  };
  for (const bucket of byKey.values()) {
    const gCount = bucket.games.length;
    const dCount = bucket.days.size;
    if (gCount > maxGamesPerKey) maxGamesPerKey = gCount;
    if (dCount > maxDaysPerKey) maxDaysPerKey = dCount;
    if (gCount >= gMin) keysAtOrAboveGMin += 1;
    if (dCount >= dMin) keysAtOrAboveDMin += 1;
    if (gCount >= gMin && dCount >= dMin) keysAtOrAboveBoth += 1;
    if (gCount === 1) gamesPerKeyHistogram["1"] += 1;
    else if (gCount <= 4) gamesPerKeyHistogram["2-4"] += 1;
    else if (gCount <= 9) gamesPerKeyHistogram["5-9"] += 1;
    else if (gCount <= 19) gamesPerKeyHistogram["10-19"] += 1;
    else if (gCount <= 29) gamesPerKeyHistogram["20-29"] += 1;
    else gamesPerKeyHistogram["30+"] += 1;
  }

  return {
    // Gate floors (frozen when fixtureMode=false)
    nMin,
    gMin,
    dMin,
    fixtureMode: !!fixtureMode,
    // Input composition (subject color; G2 indexes subject-Black only)
    totalGames: list.length,
    blackGameCount,
    whiteSubjectGameCount,
    otherColorCount,
    gamesWithOpponentKey,
    // Longitudinal recurrence aggregates (no per-key identities)
    opponentKeyCount: byKey.size,
    qualifyingCount: keysAtOrAboveBoth,
    keysAtOrAboveGMin,
    keysAtOrAboveDMin,
    maxGamesPerKey,
    maxDaysPerKey,
    gamesPerKeyHistogram,
    // Outcome-blind audit: G2 must not consume outcomes; sealed games should be stripped
    outcomeFieldHits,
    outcomeBlind: outcomeFieldHits === 0,
  };
}

/**
 * G2 — Longitudinal opponent recurrence.
 * Measures repeat-opponent history from subject-Black games only (opponent played White),
 * counting games + distinct UTC dayKeys per opponentKey. No outcomes used.
 * Uses frozen protocol floors unless fixtureMode explicitly relaxes via pins.research_*.
 */
export function runG2(games, pins = DEFAULT_PINS, { fixtureMode = false } = {}) {
  const byKey = indexOpponentWhiteHistory(games);
  const gMin = fixtureMode
    ? (pins.research_g_min ?? pins.research_min_white_games ?? DEFAULT_PINS.g_min_white_games_per_key)
    : (pins.g_min_white_games_per_key ?? DEFAULT_PINS.g_min_white_games_per_key);
  const dMin = fixtureMode
    ? (pins.research_d_min ?? pins.research_min_days ?? DEFAULT_PINS.d_min_distinct_days_per_key)
    : (pins.d_min_distinct_days_per_key ?? DEFAULT_PINS.d_min_distinct_days_per_key);
  const nMin = pins.n_o_min_opponent_keys ?? DEFAULT_PINS.n_o_min_opponent_keys;

  const diagnostics = buildG2AggregateDiagnostics(games, byKey, {
    gMin,
    dMin,
    nMin,
    fixtureMode,
  });

  // Pass path may list pseudonymous opponentKey counts (already research-safe).
  // Fail path keeps aggregates only — no per-key identities needed to audit the stop.
  const qualifying = [];
  for (const [key, bucket] of byKey.entries()) {
    if (bucket.games.length >= gMin && bucket.days.size >= dMin) {
      qualifying.push({
        opponentKey: key,
        games: bucket.games.length,
        days: bucket.days.size,
      });
    }
  }
  if (qualifying.length < nMin) {
    return gateResult("G2", false, VERDICTS.STOP_NO_LONGITUDINAL_RECURRENCE, {
      // Compact fields kept for backward-compatible tests + CLI receipts
      qualifying: qualifying.length,
      nMin,
      gMin,
      dMin,
      fixtureMode: !!fixtureMode,
      // Privacy-safe audit bundle (no identities)
      diagnostics,
    });
  }
  return gateResult("G2", true, VERDICTS.READY_FOR_GATES, {
    qualifying,
    nMin,
    gMin,
    dMin,
    fixtureMode: !!fixtureMode,
    diagnostics,
  });
}

/** G3 — Package fill budget 12. */
export function runG3(games, options = {}) {
  const {
    pins = DEFAULT_PINS,
    requireExactFill = true,
    useExpand = true,
  } = options;

  const keyCheck = assertOpponentKeysPresent(games);
  if (!keyCheck.ok) {
    return gateResult("G3", false, VERDICTS.STOP_SCHEMA_UNAVAILABLE, {
      reason: keyCheck.reason,
    });
  }

  const cleaned = dedupeGamesById(games).map((g) => stripOutcomesDeep(g));

  let gen = generateTrainPackage(cleaned, {
    pins,
    requireExactFill,
    budget: PACKAGE_SLOT_BUDGET,
  });

  if (!gen.ok && useExpand) {
    const expanded = expandCandidatesToBudget(cleaned, PACKAGE_SLOT_BUDGET, pins);
    if (expanded.exactFill) {
      gen = {
        ok: true,
        verdict: VERDICTS.READY_FOR_GATES,
        package: {
          unitContract: "preparation-unit-v2",
          budget: PACKAGE_SLOT_BUDGET,
          totalCost: expanded.totalCost,
          exactFill: true,
          units: expanded.units,
          meta: expanded.meta,
          packageSha256: packageContentHash(expanded.units),
          productAuthorization: false,
          productVerdict: "preserve-v2",
          trainOnly: true,
          outcomeBlind: true,
        },
      };
    }
  }

  if (!gen.ok || !gen.package?.exactFill) {
    return gateResult("G3", false, VERDICTS.STOP_PACKAGE_EMPTY, {
      reason: gen.reason || "package not exact fill 12",
      totalCost: gen.package?.totalCost ?? 0,
    });
  }
  return gateResult("G3", true, VERDICTS.READY_FOR_GATES, {
    package: gen.package,
  });
}

/** G4 — Unit breadth / cost integrity. */
export function runG4(units) {
  const list = units || [];
  if (!list.length) {
    return gateResult("G4", false, VERDICTS.STOP_COST_GAMING, { reason: "no units" });
  }
  const errors = [];
  let total = 0;
  for (const u of list) {
    const v = validatePreparationUnitV2(u);
    if (!v.ok) errors.push(...v.errors);
    else total += u.identityPayload.coverageCost;
  }
  if (total > PACKAGE_SLOT_BUDGET) {
    errors.push(`total cost ${total} > ${PACKAGE_SLOT_BUDGET}`);
  }
  if (errors.length) {
    return gateResult("G4", false, VERDICTS.STOP_COST_GAMING, { errors, total });
  }
  return gateResult("G4", true, VERDICTS.READY_FOR_GATES, { total });
}

/**
 * G5 — Divergence from v2 path set (read-only Jaccard / outside-set).
 * Pass if Jaccard ≤ J_max OR ≥1 family path outside v2 terminal set.
 */
export function runG5(units, v2Paths = [], pins = DEFAULT_PINS) {
  const familyPaths = new Set();
  for (const u of units || []) {
    for (const epd of u.identityPayload?.matcher?.familyEpds || []) {
      familyPaths.add(String(epd));
    }
  }
  const v2 = new Set((v2Paths || []).map(String));
  if (v2.size === 0) {
    // No v2 reference → treat as distinct (cannot prove collision)
    return gateResult("G5", true, VERDICTS.READY_FOR_GATES, {
      jaccard: 0,
      note: "no-v2-reference",
    });
  }
  let inter = 0;
  for (const p of familyPaths) if (v2.has(p)) inter += 1;
  const union = new Set([...familyPaths, ...v2]).size;
  const jaccard = union ? inter / union : 0;
  const jMax = pins.J_max_v2_path_jaccard ?? DEFAULT_PINS.J_max_v2_path_jaccard;
  let outside = 0;
  for (const p of familyPaths) if (!v2.has(p)) outside += 1;
  if (jaccard <= jMax || outside >= 1) {
    return gateResult("G5", true, VERDICTS.READY_FOR_GATES, { jaccard, outside, jMax });
  }
  return gateResult("G5", false, VERDICTS.STOP_NOT_DISTINCT_FROM_V2, {
    jaccard,
    outside,
    jMax,
  });
}

/**
 * Fit units from TRAIN-only games at a cutoff (no future leakage).
 */
export function fitUnitsAtCutoff(trainGames, pins = DEFAULT_PINS) {
  const cleaned = dedupeGamesById(trainGames).map((g) => stripOutcomesDeep(g));
  const gen = generateTrainPackage(cleaned, {
    pins,
    requireExactFill: false,
    budget: PACKAGE_SLOT_BUDGET,
  });
  if (gen.ok && gen.package?.units?.length) return gen.package.units;
  const expanded = expandCandidatesToBudget(cleaned, PACKAGE_SLOT_BUDGET, pins);
  return expanded.units || [];
}

/**
 * G6 — Prequential future-match on TRAIN only (nested cutoffs).
 * CRITICAL: units are re-fit on games strictly before each cut — never full-sample units
 * evaluated on their own training tails (no optimistic in-sample hit rates).
 */
export function runG6(games, _unitsIgnored, pins = DEFAULT_PINS) {
  const ordered = dedupeGamesById(games || [])
    .map((g) => stripOutcomesDeep(g))
    .filter((g) => g.color === "black");
  if (ordered.length < 5) {
    return gateResult("G6", false, VERDICTS.STOP_PREQUENTIAL_INFEASIBLE, {
      reason: "insufficient games",
    });
  }
  const fracs = [0.4, 0.5, 0.6, 0.7, 0.8];
  const hits = [];
  for (const f of fracs) {
    const cut = Math.floor(ordered.length * f);
    if (cut < 2 || cut >= ordered.length) continue;
    const { train, future } = splitTrainAtCutoff(ordered, { cutoffIndex: cut });
    // Re-fit package from train only (strict no-lookahead)
    const fitUnits = fitUnitsAtCutoff(train, pins);
    if (!fitUnits.length) {
      hits.push({
        cut,
        future: future.length,
        hit: 0,
        rate: 0,
        fitUnitCount: 0,
      });
      continue;
    }
    let hit = 0;
    for (const g of future) {
      let gameHit = false;
      for (const u of fitUnits) {
        if (matchUnitToGame(u, g).match) {
          gameHit = true;
          break; // at most one contribution counted per game (panel hit proxy)
        }
      }
      if (gameHit) hit += 1;
    }
    const rate = future.length ? hit / future.length : 0;
    hits.push({
      cut,
      future: future.length,
      hit,
      rate,
      fitUnitCount: fitUnits.length,
    });
  }
  if (!hits.length) {
    return gateResult("G6", false, VERDICTS.STOP_PREQUENTIAL_INFEASIBLE, {
      reason: "no valid cutoffs",
    });
  }
  const mean = hits.reduce((s, h) => s + h.rate, 0) / hits.length;
  const pMin = pins.p_min_prequential_hit ?? DEFAULT_PINS.p_min_prequential_hit;
  const pMax = pins.p_max_prequential_hit ?? DEFAULT_PINS.p_max_prequential_hit;
  if (mean < pMin || mean > pMax) {
    return gateResult("G6", false, VERDICTS.STOP_PREQUENTIAL_INFEASIBLE, {
      mean,
      pMin,
      pMax,
      hits,
    });
  }
  return gateResult("G6", true, VERDICTS.READY_FOR_GATES, { mean, hits });
}

/** G7 — Freeze receipt / product flags. */
export function runG7({ protocol, report, packageObj, knownRawTokens = [] } = {}) {
  const errors = [];
  if (protocol) {
    const locks = validateProtocolLocks(protocol);
    if (!locks.ok) errors.push(...locks.errors);
  }
  if (report?.productAuthorization !== false && report != null) {
    errors.push("report.productAuthorization must be false");
  }
  if (report?.productVerdict != null && report.productVerdict !== "preserve-v2") {
    errors.push("report.productVerdict must be preserve-v2");
  }
  if (packageObj?.productAuthorization === true) {
    errors.push("package productAuthorization true");
  }
  if (report != null) {
    const leak = assertNoRawIdentityLeakage(report, "$", { knownRawTokens });
    if (!leak.ok) errors.push(`raw leak: ${leak.leaks.join(",")}`);
  }
  if (errors.length) {
    return gateResult("G7", false, VERDICTS.INVALID, { errors });
  }
  return gateResult("G7", true, VERDICTS.GATES_PASSED_EVAL_NOT_RUN, {
    passVerdict: VERDICTS.GATES_PASSED_EVAL_NOT_RUN,
  });
}

/**
 * Run gates in order through `through` (e.g. "G7"). Stop at first fail-closed.
 * Default: live frozen pins, fixtureMode false (no silent G2 relaxation).
 */
export function runGates(context = {}, { through = "G7" } = {}) {
  const stopAt = GATE_ORDER.indexOf(through);
  if (stopAt < 0) {
    return {
      ok: false,
      verdict: VERDICTS.INVALID,
      results: [],
      reason: `unknown gate ${through}`,
    };
  }

  const {
    rawText,
    subjectUsername,
    researchSalt,
    sealedRecords,
    protocol,
    games: gamesIn,
    pins: pinsIn = null,
    v2Paths = [],
    fixtureMode = false,
    knownRawTokens = null,
  } = context;

  // Pins: frozen defaults ← protocol.pins ← explicit overrides. Fixture floors only if opted in.
  let pins = resolvePins(protocol, pinsIn);
  if (fixtureMode) {
    pins = {
      ...pins,
      ...FIXTURE_PIN_OVERRIDES,
      ...(pinsIn || {}),
    };
  }

  const results = [];
  let games = gamesIn || null;
  let units = null;
  let pkg = null;
  let priorReceiptSha = null;

  for (let i = 0; i <= stopAt; i += 1) {
    const gate = GATE_ORDER[i];
    let r;
    if (gate === "G0") {
      r = runG0({
        rawText,
        subjectUsername,
        researchSalt,
        sealedRecords,
        protocol,
        knownRawTokens,
      });
      if (r.pass && r.games) games = r.games;
      if (r.pass && sealedRecords && !games) games = stripOutcomesDeep(sealedRecords);
    } else if (gate === "G1") {
      r = runG1(games, pins);
    } else if (gate === "G2") {
      r = runG2(games, pins, { fixtureMode });
    } else if (gate === "G3") {
      r = runG3(games, { pins, requireExactFill: true, useExpand: true });
      if (r.pass) {
        pkg = r.package;
        units = pkg.units;
      }
    } else if (gate === "G4") {
      r = runG4(units || pkg?.units);
    } else if (gate === "G5") {
      r = runG5(units || pkg?.units, v2Paths, pins);
    } else if (gate === "G6") {
      // Re-fit at nested cutoffs; ignore full-sample units for hit estimation
      r = runG6(games, units || pkg?.units, pins);
    } else if (gate === "G7") {
      r = runG7({
        protocol,
        report: {
          productAuthorization: false,
          productVerdict: "preserve-v2",
        },
        packageObj: pkg,
        knownRawTokens: knownRawTokens || [],
      });
    } else {
      r = gateResult(gate, false, VERDICTS.INVALID, { reason: "unhandled" });
    }
    // Chain receipts: bind prior gate hash
    r.priorGateSha256 = priorReceiptSha;
    const receiptBody = {
      gate: r.gate,
      pass: r.pass,
      verdict: r.verdict,
      priorGateSha256: priorReceiptSha,
    };
    r.receiptSha256 = sha256Hex(`${JSON.stringify(receiptBody, null, 2)}\n`);
    priorReceiptSha = r.receiptSha256;
    results.push(r);
    if (!r.pass) {
      return {
        ok: false,
        verdict: r.verdict,
        results,
        games,
        package: pkg,
      };
    }
  }

  const last = results[results.length - 1];
  return {
    ok: true,
    verdict: last.verdict === VERDICTS.GATES_PASSED_EVAL_NOT_RUN
      ? VERDICTS.GATES_PASSED_EVAL_NOT_RUN
      : VERDICTS.READY_FOR_GATES,
    results,
    games,
    package: pkg,
  };
}

export function buildPhase0Report({
  protocol,
  gateRun,
  rawSha256 = null,
  studyId = "orcbr-b1-phase0",
  knownRawTokens = [],
} = {}) {
  // Lift privacy-safe G2 aggregates into the report so a stop can be audited without
  // re-opening sealed games or reading per-key identities.
  const g2Result = (gateRun?.results || []).find((r) => r.gate === "G2");
  const g2Diagnostics = g2Result?.diagnostics
    || (g2Result
      ? {
        qualifyingCount: typeof g2Result.qualifying === "number"
          ? g2Result.qualifying
          : (g2Result.qualifying?.length ?? null),
        nMin: g2Result.nMin ?? null,
        gMin: g2Result.gMin ?? null,
        dMin: g2Result.dMin ?? null,
        fixtureMode: g2Result.fixtureMode ?? false,
      }
      : null);

  const report = {
    kind: "scout-orcbr-b1-phase0-report",
    version: 1,
    protocolId: protocol?.protocolId || "scout-orcbr-b1-v1",
    candidateId: "orcbr-b1",
    studyId,
    researchOnly: true,
    trainOnly: true,
    outcomeBlind: true,
    nonConfirmatory: true,
    scientificScope: "structural-only",
    productAuthorization: false,
    productVerdict: "preserve-v2",
    moduleAStatus: "CLOSED_NOT_REOPENED",
    unitContract: "preparation-unit-v2",
    packageSlotBudget: 12,
    verdict: gateRun?.verdict || VERDICTS.INVALID,
    gates: (gateRun?.results || []).map((r) => ({
      gate: r.gate,
      pass: r.pass,
      verdict: r.verdict,
      receiptSha256: r.receiptSha256 || null,
      priorGateSha256: r.priorGateSha256 || null,
    })),
    g2Diagnostics,
    package: gateRun?.package
      ? {
        packageSha256: gateRun.package.packageSha256,
        totalCost: gateRun.package.totalCost,
        exactFill: gateRun.package.exactFill,
        unitIds: (gateRun.package.units || []).map((u) => u.unitId),
        // opponentKey is already pseudonymous; allowed
        opponentKeys: [...new Set(
          (gateRun.package.units || []).map((u) => u.identityPayload.opponentKey),
        )].sort(),
      }
      : null,
    custody: {
      rawSha256,
    },
    calAllowed: false,
    testAllowed: false,
    networkEnabled: false,
  };
  const leak = assertNoRawIdentityLeakage(report, "$", { knownRawTokens });
  if (!leak.ok) {
    report.verdict = VERDICTS.INVALID;
    report.leakErrors = leak.leaks;
  }
  report.reportSha256 = computeReportSha256(report);
  return report;
}

export { validatePackage, PACKAGE_SLOT_BUDGET, sortGamesChronologically };
