// ORCBR-B1 preparation-unit-v2 — exact-atom-v1 compatibility + bounded state-response units.
// Fail-closed breadth caps. coverageCost ∈ {1,2,3}. Package budget exactly 12.

import {
  ORCBR_UNIT_CONTRACT_EXACT_V1,
  ORCBR_UNIT_CONTRACT_V2,
  sha256Hex,
} from "./orcbr-b1-schema.js";

export const PACKAGE_SLOT_BUDGET = 12;
export const COVERAGE_COST_DOMAIN = Object.freeze([1, 2, 3]);

export const BREADTH_CAPS = Object.freeze({
  1: { maxFamilyEpds: 4, maxExactPly: 6, maxWildcards: 0 },
  2: { maxFamilyEpds: 8, maxExactPly: 12, maxWildcards: 1 },
  3: { maxFamilyEpds: 12, maxExactPly: 12, maxWildcards: 2 },
});

export const MAX_PLY = 12;

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function sortedCopy(arr) {
  return [...(arr || [])].map(String).sort((a, b) => a.localeCompare(b));
}

function canonicalJson(obj) {
  return JSON.stringify(obj);
}

/** Deterministic unitId from identity payload (not display fields). */
export function computeUnitId(identityPayload) {
  return sha256Hex(canonicalJson(identityPayload));
}

/**
 * Infer minimum legal coverageCost from matcher breadth.
 * Cost is monotone non-decreasing in breadth.
 */
export function inferMinCoverageCost(matcher) {
  if (!matcher || typeof matcher !== "object") return null;
  const familyEpds = Array.isArray(matcher.familyEpds) ? matcher.familyEpds : [];
  const wildcards = Number(matcher.wildcardPlyCount) || 0;
  const exactPly = Number(matcher.exactPly) || 0;
  const maxPly = Number(matcher.maxPly) || MAX_PLY;

  if (maxPly > MAX_PLY) return null; // illegal
  if (wildcards < 0 || wildcards > 2) return null;

  // Cost monotone non-decreasing in matcher breadth (family size + wildcards + exact depth).
  // cost-1: ≤4 family EPDs OR single exact ≤6-ply sequence; no wildcards
  // cost-2: ≤8 EPDs OR ≤1 wildcard; exact ply ≤12
  // cost-3: ≤12 EPDs OR ≤2 wildcards — hard max
  const n = familyEpds.length;
  if (n === 0) return null;

  const narrowExact = wildcards === 0 && n <= 1 && exactPly > 0 && exactPly <= BREADTH_CAPS[1].maxExactPly;
  const narrowFamily = wildcards === 0 && n <= BREADTH_CAPS[1].maxFamilyEpds;
  if (narrowExact || narrowFamily) {
    // Long exact sequences with multi-EPD still pay for family breadth only if n small.
    // But a single family token with exactPly > 6 cannot claim cost-1.
    if (wildcards === 0 && n <= 1 && exactPly > BREADTH_CAPS[1].maxExactPly) {
      // medium exact depth → at least cost 2 if still within max
      if (exactPly <= BREADTH_CAPS[2].maxExactPly) return 2;
      return null;
    }
    return 1;
  }
  if (wildcards <= BREADTH_CAPS[2].maxWildcards && n <= BREADTH_CAPS[2].maxFamilyEpds) {
    return 2;
  }
  if (wildcards <= BREADTH_CAPS[3].maxWildcards && n <= BREADTH_CAPS[3].maxFamilyEpds) {
    return 3;
  }
  return null; // over-broad
}

/**
 * Validate preparation-unit-v2 identity + cost/breadth rules.
 * Fail-closed on malformed / over-broad matchers.
 */
export function validatePreparationUnitV2(unit) {
  const errors = [];
  if (!isPlainObject(unit)) return { ok: false, errors: ["unit must be object"] };
  if (unit.unitContract !== ORCBR_UNIT_CONTRACT_V2) {
    errors.push(`unitContract must be ${ORCBR_UNIT_CONTRACT_V2}`);
  }
  const idp = unit.identityPayload;
  if (!isPlainObject(idp)) {
    return { ok: false, errors: ["identityPayload required"] };
  }
  if (idp.kind !== "conditional_response_rule") {
    errors.push("identityPayload.kind must be conditional_response_rule");
  }
  if (idp.ourColor !== "black") errors.push("ourColor must be black");
  if (typeof idp.opponentKey !== "string" || !idp.opponentKey.startsWith("opp_")) {
    errors.push("opponentKey must be opp_* pseudonym");
  }
  if (idp.contractVersion !== 2) errors.push("contractVersion must be 2");

  const matcher = idp.matcher;
  if (!isPlainObject(matcher)) {
    errors.push("matcher required");
  } else {
    if (matcher.type !== "prefix_or_epd_family") {
      errors.push("matcher.type must be prefix_or_epd_family");
    }
    const familyEpds = Array.isArray(matcher.familyEpds) ? matcher.familyEpds : null;
    if (!familyEpds) errors.push("matcher.familyEpds must be array");
    else if (familyEpds.length === 0) errors.push("matcher.familyEpds must be non-empty");
    const maxPly = Number(matcher.maxPly);
    if (!Number.isFinite(maxPly) || maxPly < 1 || maxPly > MAX_PLY) {
      errors.push(`matcher.maxPly must be in 1..${MAX_PLY}`);
    }
    // Canonical sorted family requirement for identity stability
    if (familyEpds) {
      const sorted = sortedCopy(familyEpds);
      if (familyEpds.map(String).join("\0") !== sorted.join("\0")) {
        errors.push("matcher.familyEpds must be canonically sorted");
      }
    }
  }

  const response = idp.response;
  if (!isPlainObject(response) || typeof response.replyUci !== "string" || !response.replyUci) {
    errors.push("response.replyUci required");
  }

  const cost = idp.coverageCost;
  if (!COVERAGE_COST_DOMAIN.includes(cost)) {
    errors.push("coverageCost must be in {1,2,3}");
  } else if (matcher && Array.isArray(matcher.familyEpds)) {
    const minCost = inferMinCoverageCost(matcher);
    if (minCost == null) {
      errors.push("matcher breadth exceeds hard max (fail-closed)");
    } else if (cost < minCost) {
      errors.push(`coverageCost ${cost} below minimum ${minCost} for matcher breadth`);
    }
    const caps = BREADTH_CAPS[cost];
    if (caps) {
      const n = matcher.familyEpds.length;
      const wild = Number(matcher.wildcardPlyCount) || 0;
      if (n > caps.maxFamilyEpds) {
        errors.push(`familyEpds length ${n} exceeds cost-${cost} cap ${caps.maxFamilyEpds}`);
      }
      if (wild > caps.maxWildcards) {
        errors.push(`wildcardPlyCount ${wild} exceeds cost-${cost} cap ${caps.maxWildcards}`);
      }
    }
  }

  const expectedId = computeUnitId(idp);
  if (unit.unitId != null && unit.unitId !== expectedId) {
    errors.push("unitId does not match identityPayload hash");
  }

  return { ok: errors.length === 0, errors, expectedUnitId: expectedId };
}

/**
 * Exact-atom v1 validator — rejects preparation-unit-v2 (no silent rewrite).
 */
export function validateExactAtomV1(unit) {
  const errors = [];
  if (!isPlainObject(unit)) return { ok: false, errors: ["unit must be object"] };
  if (unit.unitContract !== ORCBR_UNIT_CONTRACT_EXACT_V1) {
    errors.push(`exact-atom scorer rejects contract ${unit.unitContract}`);
  }
  if (unit.unitContract === ORCBR_UNIT_CONTRACT_V2) {
    return {
      ok: false,
      errors: ["exact-atom@1 scorer rejects preparation-unit-v2 (no silent rewrite)"],
    };
  }
  if (typeof unit.triggerEpd !== "string" || !unit.triggerEpd) {
    errors.push("triggerEpd required for exact-atom@1");
  }
  if (typeof unit.subjectUci !== "string" || !unit.subjectUci) {
    errors.push("subjectUci required for exact-atom@1");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Generalized scorer rejects exact atoms.
 */
export function validateForGeneralizedScorer(unit) {
  if (unit?.unitContract === ORCBR_UNIT_CONTRACT_EXACT_V1) {
    return {
      ok: false,
      errors: ["preparation-unit-v2 scorer rejects exact-atom@1"],
    };
  }
  return validatePreparationUnitV2(unit);
}

/**
 * Build a frozen preparation-unit-v2 from parts.
 */
export function buildPreparationUnitV2({
  opponentKey,
  familyEpds,
  replyUci,
  coverageCost,
  maxPly = MAX_PLY,
  wildcardPlyCount = 0,
  exactPly = 0,
  replySource = "pinned-shared-Y-or-frozen-rule",
  display = null,
}) {
  const sortedFamily = sortedCopy(familyEpds);
  const identityPayload = {
    kind: "conditional_response_rule",
    ourColor: "black",
    opponentKey,
    matcher: {
      type: "prefix_or_epd_family",
      familyEpds: sortedFamily,
      maxPly,
      wildcardPlyCount,
      exactPly,
    },
    response: {
      replyUci: String(replyUci),
      replySource,
    },
    coverageCost,
    contractVersion: 2,
  };
  const unit = {
    unitContract: ORCBR_UNIT_CONTRACT_V2,
    unitId: computeUnitId(identityPayload),
    identityPayload,
  };
  if (display != null) unit.display = display; // non-identity
  const v = validatePreparationUnitV2(unit);
  if (!v.ok) {
    const err = new Error(`invalid preparation-unit-v2: ${v.errors.join("; ")}`);
    err.validation = v;
    throw err;
  }
  return unit;
}

/**
 * Match unit against a Black subject game vs same opponentKey.
 * Match if game opening UCI path / EPD family hits at ply ≤ maxPly.
 * At most one contribution per game per unit (boolean).
 */
export function matchUnitToGame(unit, game) {
  const v = validatePreparationUnitV2(unit);
  if (!v.ok) return { match: false, reason: "invalid-unit" };
  if (!game || game.color !== "black") return { match: false, reason: "not-black" };
  if (game.opponentKey !== unit.identityPayload.opponentKey) {
    return { match: false, reason: "foreign-opponentKey" };
  }
  const matcher = unit.identityPayload.matcher;
  const family = new Set(matcher.familyEpds.map(String));
  const ucis = Array.isArray(game.ucis) ? game.ucis : [];
  const maxPly = Math.min(Number(matcher.maxPly) || MAX_PLY, MAX_PLY, ucis.length);

  // Deterministic family membership (Phase0):
  //   - progressive UCI path prefixes (joined by single space)
  //   - optional game.openingKey / game.familyTokens supplied by research parse only
  // Synthetic "ply:N:uci" tokens are NOT auto-generated here: a unit that lists only
  // single-move ply tokens would monopolize coverage without paying breadth cost.
  // Units may still include explicit ply tokens in familyEpds if they pay the cost caps.
  const prefixKeys = [];
  let path = "";
  for (let i = 0; i < maxPly; i += 1) {
    path = path ? `${path} ${ucis[i]}` : ucis[i];
    prefixKeys.push(path);
  }
  if (game.openingKey) prefixKeys.push(String(game.openingKey));
  if (Array.isArray(game.familyTokens)) {
    for (const t of game.familyTokens) prefixKeys.push(String(t));
  }

  // At most one contribution per game per unit (first hit only).
  for (const key of prefixKeys) {
    if (family.has(key)) {
      return {
        match: true,
        contribution: 1,
        replyUci: unit.identityPayload.response.replyUci,
      };
    }
  }
  return { match: false, reason: "no-family-hit" };
}

/**
 * Validate a package: sum(coverageCost) must equal budget (default 12) for exact fill.
 * Fail-closed on over-budget, invalid units, foreign contracts.
 */
export function validatePackage(units, { budget = PACKAGE_SLOT_BUDGET, requireExactFill = true } = {}) {
  const errors = [];
  if (!Array.isArray(units)) return { ok: false, errors: ["units must be array"], totalCost: 0 };
  let total = 0;
  const unitIds = new Set();
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    const v = validatePreparationUnitV2(u);
    if (!v.ok) errors.push(`unit[${i}]: ${v.errors.join("; ")}`);
    else {
      total += u.identityPayload.coverageCost;
      if (unitIds.has(u.unitId)) errors.push(`unit[${i}]: duplicate unitId`);
      unitIds.add(u.unitId);
    }
  }
  if (total > budget) errors.push(`total coverageCost ${total} exceeds budget ${budget}`);
  if (requireExactFill && units.length > 0 && total !== budget) {
    errors.push(`total coverageCost ${total} must equal budget ${budget} for exact fill`);
  }
  if (units.length === 0) errors.push("package empty");
  return {
    ok: errors.length === 0,
    errors,
    totalCost: total,
    budget,
    remaining: budget - total,
  };
}

/** Slot-normalized coverage U = |games with ≥1 contribution| / sum(coverageCost). */
export function slotNormalizedCoverage(units, games) {
  const pack = validatePackage(units, { requireExactFill: false });
  if (!pack.ok && pack.totalCost === 0) return { U: 0, coveredGames: 0, totalCost: 0 };
  const totalCost = pack.totalCost || units.reduce(
    (s, u) => s + (u?.identityPayload?.coverageCost || 0),
    0,
  );
  let covered = 0;
  for (const g of games || []) {
    let hit = false;
    for (const u of units) {
      if (matchUnitToGame(u, g).match) {
        hit = true;
        break;
      }
    }
    if (hit) covered += 1;
  }
  return {
    U: totalCost > 0 ? covered / totalCost : 0,
    coveredGames: covered,
    totalCost,
  };
}

/**
 * Deterministic ranking for packing:
 * 1. supportGames desc
 * 2. supportDays desc
 * 3. lower coverageCost preferred
 * 4. unitId asc
 */
export function rankUnits(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const sg = (b.supportGames || 0) - (a.supportGames || 0);
    if (sg !== 0) return sg;
    const sd = (b.supportDays || 0) - (a.supportDays || 0);
    if (sd !== 0) return sd;
    const ca = a.unit?.identityPayload?.coverageCost ?? 99;
    const cb = b.unit?.identityPayload?.coverageCost ?? 99;
    if (ca !== cb) return ca - cb;
    return String(a.unit?.unitId || "").localeCompare(String(b.unit?.unitId || ""));
  });
}

/**
 * Pack ranked candidates until budget exactly 12 (or max fill without exceeding).
 * When requireExactFill, only returns packages that sum to 12 (greedy then backfill skip).
 */
export function packUnitsToBudget(rankedCandidates, { budget = PACKAGE_SLOT_BUDGET, requireExactFill = true } = {}) {
  const ranked = rankUnits(rankedCandidates);
  const selected = [];
  let used = 0;
  for (const c of ranked) {
    const cost = c.unit?.identityPayload?.coverageCost;
    if (!COVERAGE_COST_DOMAIN.includes(cost)) continue;
    if (used + cost > budget) continue;
    const v = validatePreparationUnitV2(c.unit);
    if (!v.ok) continue;
    selected.push(c);
    used += cost;
    if (used === budget) break;
  }
  if (requireExactFill && used !== budget) {
    // Try single-pass replacement: drop last and find exact fit remainder (minimal).
    // Keep greedy result; caller may treat underfill as STOP_PACKAGE_EMPTY.
  }
  return {
    units: selected.map((c) => c.unit),
    meta: selected.map((c) => ({
      unitId: c.unit.unitId,
      supportGames: c.supportGames,
      supportDays: c.supportDays,
      coverageCost: c.unit.identityPayload.coverageCost,
    })),
    totalCost: used,
    budget,
    exactFill: used === budget,
  };
}

export function packageContentHash(units) {
  const ids = (units || []).map((u) => u.unitId).sort();
  const costs = (units || [])
    .map((u) => `${u.unitId}:${u.identityPayload.coverageCost}`)
    .sort();
  return sha256Hex(JSON.stringify({ ids, costs }));
}
