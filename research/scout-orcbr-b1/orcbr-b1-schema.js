// ORCBR-B1 research schema helpers — dual-parse, HMAC pseudonyms, chronology.
// Research-only. Never mutates production Scout defaults. Never persists raw identity.

import { createHash, createHmac } from "node:crypto";

export const ORCBR_PROTOCOL_KIND = "scout-orcbr-b1-protocol";
export const ORCBR_PROTOCOL_ID = "scout-orcbr-b1-v1";
export const ORCBR_CANDIDATE_ID = "orcbr-b1";
export const ORCBR_UNIT_CONTRACT_V2 = "preparation-unit-v2";
export const ORCBR_UNIT_CONTRACT_EXACT_V1 = "exact-atom@1";
export const ORCBR_PRODUCT_VERDICT = "preserve-v2";
export const ORCBR_REPORT_KIND = "scout-orcbr-b1-phase0-report";

export const VERDICTS = Object.freeze({
  READY_FOR_GATES: "READY_FOR_GATES",
  STOP_SCHEMA_UNAVAILABLE: "STOP_SCHEMA_UNAVAILABLE",
  STOP_IDENTITY_SPARSE: "STOP_IDENTITY_SPARSE",
  STOP_NO_LONGITUDINAL_RECURRENCE: "STOP_NO_LONGITUDINAL_RECURRENCE",
  STOP_PACKAGE_EMPTY: "STOP_PACKAGE_EMPTY",
  STOP_COST_GAMING: "STOP_COST_GAMING",
  STOP_NOT_DISTINCT_FROM_V2: "STOP_NOT_DISTINCT_FROM_V2",
  STOP_PREQUENTIAL_INFEASIBLE: "STOP_PREQUENTIAL_INFEASIBLE",
  GATES_PASSED_EVAL_NOT_RUN: "GATES_PASSED_EVAL_NOT_RUN",
  INVALID: "INVALID",
});

export const IDENTITY_CONFIDENCE = Object.freeze({
  ID: "id",
  NAME_LOWER: "name-lower",
  NONE: "none",
});

export const IDENTITY_SOURCE = Object.freeze({
  NDJSON_PLAYERS: "ndjson.players.user.id",
  PGN_HEADER: "pgn.header",
  MISSING: "missing",
});

/** SHA-256 hex of utf8 string or Buffer. */
export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return createHash("sha256").update(buf).digest("hex");
}

/** Minimum research-salt length (fail-closed against empty/weak salts). */
export const MIN_RESEARCH_SALT_LENGTH = 8;

/**
 * Validate caller-supplied research salt.
 * Salt is the HMAC key (never concatenated into the message).
 */
export function assertResearchSalt(researchSalt) {
  if (researchSalt == null || String(researchSalt).length === 0) {
    throw new Error("researchSalt is required for HMAC pseudonymization");
  }
  const s = String(researchSalt);
  if (s.length < MIN_RESEARCH_SALT_LENGTH) {
    throw new Error(
      `researchSalt must be at least ${MIN_RESEARCH_SALT_LENGTH} characters (weak salt refused)`,
    );
  }
  return s;
}

/** HMAC-SHA256 hex. researchSalt is the HMAC key; message is normalized identity. */
export function hmacSha256Hex(researchSalt, message) {
  const salt = assertResearchSalt(researchSalt);
  return createHmac("sha256", salt)
    .update(String(message), "utf8")
    .digest("hex");
}

/**
 * Pseudonymous key: "opp_" + first 16 hex chars of HMAC-SHA256(salt, normalizedId).
 * Never returns raw identity. Different salts → deterministic separation.
 */
export function pseudonymKey(normalizedId, researchSalt) {
  if (normalizedId == null || String(normalizedId).trim() === "") return null;
  const norm = String(normalizedId).trim().toLowerCase();
  const hex = hmacSha256Hex(researchSalt, norm);
  return `opp_${hex.slice(0, 16)}`;
}

export function normalizeIdentityToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.toLowerCase();
}

function isAnonymousOrAi(userObj, name) {
  if (!userObj && !name) return true;
  if (userObj && userObj.aiLevel != null) return true;
  const id = userObj?.id || userObj?.name || name;
  if (!id) return true;
  const lower = String(id).toLowerCase().trim();
  if (
    lower === "anonymous"
    || lower === "anon"
    || lower === "lichess ai"
    || lower === "lichessai"
    || lower.startsWith("ai ")
    || lower.startsWith("lichess ai")
    || /^w$|^b$/.test(lower) // placeholder side labels, not identities
  ) {
    return true;
  }
  return false;
}

/**
 * Extract side identity from Lichess NDJSON players block.
 * Prefer user.id over display name. Does not emit raw ids in return when
 * researchSalt is provided — only confidence + source + optional key.
 */
export function extractSideIdentity(playersSide, researchSalt) {
  if (!playersSide || typeof playersSide !== "object") {
    return {
      opponentKey: null,
      identityConfidence: IDENTITY_CONFIDENCE.NONE,
      identitySource: IDENTITY_SOURCE.MISSING,
    };
  }
  const user = playersSide.user;
  if (isAnonymousOrAi(user, playersSide.name || playersSide.userName)) {
    return {
      opponentKey: null,
      identityConfidence: IDENTITY_CONFIDENCE.NONE,
      identitySource: IDENTITY_SOURCE.MISSING,
    };
  }
  if (user && typeof user.id === "string" && user.id.trim()) {
    const key = researchSalt != null
      ? pseudonymKey(user.id, researchSalt)
      : null;
    return {
      opponentKey: key,
      identityConfidence: IDENTITY_CONFIDENCE.ID,
      identitySource: IDENTITY_SOURCE.NDJSON_PLAYERS,
      // _raw only for internal dual-parse tests; strip before persist
      _rawNormalized: normalizeIdentityToken(user.id),
    };
  }
  const name = user?.name || playersSide.name || playersSide.userName;
  if (typeof name === "string" && name.trim()) {
    const key = researchSalt != null
      ? pseudonymKey(name, researchSalt)
      : null;
    return {
      opponentKey: key,
      identityConfidence: IDENTITY_CONFIDENCE.NAME_LOWER,
      identitySource: IDENTITY_SOURCE.NDJSON_PLAYERS,
      _rawNormalized: normalizeIdentityToken(name),
    };
  }
  return {
    opponentKey: null,
    identityConfidence: IDENTITY_CONFIDENCE.NONE,
    identitySource: IDENTITY_SOURCE.MISSING,
  };
}

function pgnHeaderValue(pgn, key) {
  const re = new RegExp(`\\[${key}\\s+"([^"]*)"\\]`, "i");
  const m = String(pgn || "").match(re);
  return m ? m[1] : null;
}

function parseGameIdFromPgn(pgn) {
  const site = pgnHeaderValue(pgn, "Site") || "";
  const m = site.match(/\/(\w+)(?:\/white|\/black)?$/i) || site.match(/lichess\.org\/(\w+)/i);
  if (m) return m[1];
  const link = pgnHeaderValue(pgn, "Link") || "";
  const m2 = link.match(/\/(\w+)$/);
  return m2 ? m2[1] : null;
}

function datestampFromPgn(pgn) {
  const dateRaw = pgnHeaderValue(pgn, "UTCDate") || pgnHeaderValue(pgn, "Date");
  if (!dateRaw) return 0;
  return Date.parse(String(dateRaw).replace(/\./g, "-")) || 0;
}

function dayKeyFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayKeyFromDatestamp(datestamp) {
  if (typeof datestamp === "string" && /^\d{4}\.\d{2}\.\d{2}$/.test(datestamp)) {
    return datestamp.replace(/\./g, "-");
  }
  if (Number.isFinite(datestamp) && datestamp > 0) return dayKeyFromMs(datestamp);
  return null;
}

function subjectColorFromNdjson(obj, subjectUsername) {
  if (!subjectUsername) return null;
  const needle = String(subjectUsername).toLowerCase();
  const w = obj?.players?.white?.user?.id
    || obj?.players?.white?.user?.name
    || obj?.players?.white?.name
    || pgnHeaderValue(obj?.pgn, "White");
  const b = obj?.players?.black?.user?.id
    || obj?.players?.black?.user?.name
    || obj?.players?.black?.name
    || pgnHeaderValue(obj?.pgn, "Black");
  if (w && String(w).toLowerCase() === needle) return "white";
  if (b && String(b).toLowerCase() === needle) return "black";
  return null;
}

/**
 * Legacy production-shaped parse of one NDJSON game object.
 * Identity-free: no opponentKey / subjectKey / raw names of counterparty.
 * Mirrors scout.js field surface enough for chronology + gameId.
 */
export function parseGameFromJsonLegacy(obj, subjectUsername) {
  if (!obj || typeof obj !== "object") return null;
  const color = subjectColorFromNdjson(obj, subjectUsername);
  if (!color) return null;
  const pgn = typeof obj.pgn === "string" ? obj.pgn : "";
  const gameId = (typeof obj.id === "string" && obj.id) || parseGameIdFromPgn(pgn) || null;
  const createdAtMs = Number.isFinite(obj.createdAt) ? obj.createdAt : null;
  const datestamp = createdAtMs != null
    ? createdAtMs
    : (pgn ? datestampFromPgn(pgn) : 0);
  // Outcome-blind research path still may compute score for legacy shape; callers
  // strip outcomes before package/gate use via stripOutcomeFields.
  const result = pgnHeaderValue(pgn, "Result") || obj.status || "*";
  let score = null;
  if (result === "1/2-1/2" || result === "draw") score = 0.5;
  else if (result === "1-0") score = color === "white" ? 1 : 0;
  else if (result === "0-1") score = color === "black" ? 1 : 0;

  return {
    gameId,
    color,
    datestamp,
    createdAtMs: createdAtMs ?? (datestamp || null),
    ucis: Array.isArray(obj.ucis) ? obj.ucis.slice() : [],
    sans: Array.isArray(obj.sans) ? obj.sans.slice() : [],
    score,
    status: typeof obj.status === "string" ? obj.status : null,
  };
}

/**
 * Research parse: additive opponent identity fields when researchSalt is supplied.
 * When research option is not requested (no salt / research:false), returns legacy shape only.
 *
 * Options:
 *   { research: true, researchSalt, subjectUsername, includeRawForTest?: false }
 */
export function parseGameFromJsonResearch(obj, subjectUsername, options = {}) {
  const research = options.research === true;
  const salt = options.researchSalt;
  const legacy = parseGameFromJsonLegacy(obj, subjectUsername);
  if (!legacy) return null;

  if (!research) {
    // Preserve legacy parser output when research not explicitly requested.
    return legacy;
  }
  if (salt == null || String(salt).length === 0) {
    throw new Error("researchSalt is required when research:true");
  }

  const subjectSide = legacy.color;
  const opponentSide = subjectSide === "white" ? "black" : "white";
  const players = obj.players || {};
  const subjectIdent = extractSideIdentity(players[subjectSide], salt);
  const opponentIdent = extractSideIdentity(players[opponentSide], salt);

  // PGN header fallback if NDJSON players missing
  let opponentKey = opponentIdent.opponentKey;
  let identityConfidence = opponentIdent.identityConfidence;
  let identitySource = opponentIdent.identitySource;
  if (!opponentKey && obj.pgn) {
    const headerName = pgnHeaderValue(obj.pgn, opponentSide === "white" ? "White" : "Black");
    if (headerName && !isAnonymousOrAi(null, headerName)) {
      opponentKey = pseudonymKey(headerName, salt);
      identityConfidence = IDENTITY_CONFIDENCE.NAME_LOWER;
      identitySource = IDENTITY_SOURCE.PGN_HEADER;
    }
  }

  let subjectKey = subjectIdent.opponentKey;
  if (!subjectKey && subjectUsername) {
    subjectKey = pseudonymKey(subjectUsername, salt);
  }

  const createdAtMs = legacy.createdAtMs;
  const dayKey = dayKeyFromMs(createdAtMs)
    || dayKeyFromDatestamp(legacy.datestamp)
    || null;

  const researchRecord = {
    ...legacy,
    subjectKey,
    opponentKey,
    identitySource,
    identityConfidence,
    dayKey,
  };

  // Never persist raw identity unless explicit test opt-in.
  if (options.includeRawForTest !== true) {
    delete researchRecord._rawNormalized;
  }

  return stripRawIdentityFields(researchRecord);
}

/** Remove any accidental raw identity fields before persistence/report. */
export function stripRawIdentityFields(record) {
  if (!record || typeof record !== "object") return record;
  const out = { ...record };
  const banned = [
    "opponentId",
    "opponentName",
    "subjectId",
    "subjectName",
    "white",
    "black",
    "players",
    "userId",
    "username",
    "_rawNormalized",
    "rawOpponent",
    "rawSubject",
  ];
  for (const k of banned) delete out[k];
  return out;
}

/** Outcome-bearing field names that must never influence package/gates/prequential. */
export const OUTCOME_FIELD_NAMES = Object.freeze([
  "score",
  "result",
  "winner",
  "status",
  "outcome",
  "winnerColor",
  "termination",
  "winnerId",
  "points",
]);

/** Strip outcome/result fields for outcome-blind package construction / custody. */
export function stripOutcomeFields(record) {
  if (!record || typeof record !== "object") return record;
  const out = { ...record };
  for (const k of OUTCOME_FIELD_NAMES) delete out[k];
  return out;
}

/**
 * Deep-strip outcomes from records before persistence (custody / research cache).
 * Returns a new object tree; arrays of records are mapped.
 */
export function stripOutcomesDeep(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(stripOutcomesDeep);
  if (typeof value !== "object") return value;
  const out = stripOutcomeFields(value);
  for (const [k, v] of Object.entries(out)) {
    if (v && typeof v === "object") out[k] = stripOutcomesDeep(v);
  }
  return out;
}

/**
 * Parse NDJSON text. When options.research !== true, legacy shape only.
 */
export function parseNdjsonGamesResearch(text, subjectUsername, options = {}) {
  const games = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const game = parseGameFromJsonResearch(obj, subjectUsername, options);
    if (game) games.push(game);
  }
  return games;
}

/**
 * Dual-parse local NDJSON bytes: legacy + research (if salt).
 * Returns coverage stats; never includes raw identity in receipt.
 */
export function dualParseNdjson(text, subjectUsername, researchSalt) {
  const rawBytes = Buffer.from(String(text || ""), "utf8");
  const rawSha256 = sha256Hex(rawBytes);
  const legacy = parseNdjsonGamesResearch(text, subjectUsername, { research: false });
  const research = researchSalt != null
    ? parseNdjsonGamesResearch(text, subjectUsername, {
      research: true,
      researchSalt,
    })
    : [];

  const eligible = research.filter((g) => g.color === "black" || g.color === "white");
  const withKey = eligible.filter(
    (g) => g.opponentKey && g.identityConfidence !== IDENTITY_CONFIDENCE.NONE,
  );
  const identityCoverage = eligible.length ? withKey.length / eligible.length : 0;

  // Fail-closed if sealed research path requested but zero keys recovered.
  const schemaAvailable = researchSalt == null
    ? false
    : withKey.length > 0;

  return {
    rawSha256,
    legacyCount: legacy.length,
    researchCount: research.length,
    eligibleCount: eligible.length,
    withOpponentKeyCount: withKey.length,
    identityCoverage,
    schemaAvailable,
    games: research.map((g) => stripOutcomeFields(stripRawIdentityFields(g))),
  };
}

/** Resolve chronology timestamp: prefer createdAtMs, then datestamp (ms or YYYY.MM.DD). */
export function chronologyTimeMs(game) {
  if (Number.isFinite(game?.createdAtMs) && game.createdAtMs > 0) {
    return game.createdAtMs;
  }
  const ds = game?.datestamp;
  if (Number.isFinite(ds) && ds > 0) return ds;
  if (typeof ds === "string" && ds.trim()) {
    const normalized = ds.trim().replace(/\./g, "-");
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * Sort by (createdAtMs || datestamp, String(gameId)) ascending.
 * Stable secondary key prevents nondeterministic ties.
 */
export function sortGamesChronologically(games) {
  return [...(games || [])].sort((a, b) => {
    const ta = chronologyTimeMs(a);
    const tb = chronologyTimeMs(b);
    if (ta !== tb) return ta - tb;
    return String(a?.gameId ?? "").localeCompare(String(b?.gameId ?? ""));
  });
}

/**
 * Deduplicate by gameId after chronological sort.
 * Keeps the earliest occurrence; drops later duplicates (fail-closed inflation guard).
 */
export function dedupeGamesById(games) {
  const ordered = sortGamesChronologically(games);
  const seen = new Set();
  const out = [];
  for (const g of ordered) {
    const id = g?.gameId != null && String(g.gameId) !== ""
      ? String(g.gameId)
      : null;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(g);
  }
  return out;
}

/** TRAIN = games strictly before cutoffMs (or before cutoffIndex in ordered list). */
export function splitTrainAtCutoff(orderedGames, { cutoffMs, cutoffIndex } = {}) {
  const ordered = dedupeGamesById(orderedGames);
  if (cutoffIndex != null) {
    const idx = Math.max(0, Math.min(Number(cutoffIndex), ordered.length));
    return {
      train: ordered.slice(0, idx),
      future: ordered.slice(idx),
      ordered,
    };
  }
  if (cutoffMs != null) {
    const train = ordered.filter((g) => chronologyTimeMs(g) < cutoffMs);
    const future = ordered.filter((g) => chronologyTimeMs(g) >= cutoffMs);
    return { train, future, ordered };
  }
  return { train: ordered, future: [], ordered };
}

/** Sealed records lacking opponentKey → schema unavailable. */
export function assertOpponentKeysPresent(records) {
  const list = records || [];
  if (!list.length) {
    return {
      ok: false,
      verdict: VERDICTS.STOP_SCHEMA_UNAVAILABLE,
      reason: "no sealed records",
    };
  }
  const missing = list.filter((r) => !r?.opponentKey);
  if (missing.length === list.length) {
    return {
      ok: false,
      verdict: VERDICTS.STOP_SCHEMA_UNAVAILABLE,
      reason: "local sealed records lack opponentKey",
    };
  }
  return { ok: true, withKey: list.length - missing.length, missing: missing.length };
}

/**
 * Detect raw-identity leakage in reports/receipts/errors.
 * options.knownRawTokens: extra raw id/name strings that must not appear as values.
 */
export function assertNoRawIdentityLeakage(obj, path = "$", options = {}) {
  const leaks = [];
  const bannedKey = /^(opponentId|opponentName|subjectId|subjectName|userId|username|subject|_rawNormalized|rawOpponent|rawSubject)$/i;
  const knownRaw = (options.knownRawTokens || [])
    .filter((t) => t != null && String(t).trim().length >= 2)
    .map((t) => String(t).toLowerCase());

  const walk = (v, p) => {
    if (v == null) return;
    if (typeof v === "string") {
      const lower = v.toLowerCase();
      // Pseudonyms and hashes are allowed; flag known raw tokens as values.
      if (!lower.startsWith("opp_") && knownRaw.some((t) => lower === t || lower.includes(t))) {
        leaks.push(`${p}=raw-token`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (bannedKey.test(k)) leaks.push(`${p}.${k}`);
        if (k === "players" || k === "white" || k === "black") {
          // nested player objects are raw identity carriers
          if (val && typeof val === "object") leaks.push(`${p}.${k}`);
        }
        walk(val, `${p}.${k}`);
      }
    }
  };
  walk(obj, path);
  return { ok: leaks.length === 0, leaks };
}

export function computeReportSha256(report) {
  const canonical = { ...(report || {}) };
  delete canonical.reportSha256;
  return sha256Hex(`${JSON.stringify(canonical, null, 2)}\n`);
}

/** Frozen numeric pins required by protocol (must match orcbr-b1.protocol.json). */
export const FROZEN_PINS = Object.freeze({
  c1_identity_coverage_min: 0.85,
  n_o_min_opponent_keys: 1,
  g_min_white_games_per_key: 30,
  d_min_distinct_days_per_key: 10,
  J_max_v2_path_jaccard: 0.50,
  p_min_prequential_hit: 0.10,
  p_max_prequential_hit: 0.90,
  PACKAGE_SLOT_BUDGET: 12,
  max_family_epds_cost_1: 4,
  max_family_epds_cost_2: 8,
  max_family_epds_cost_3: 12,
  max_ply: 12,
  exact_ply_cost_1: 6,
});

export function validateProtocolLocks(protocol) {
  const errors = [];
  if (protocol?.kind !== ORCBR_PROTOCOL_KIND) errors.push(`kind must be ${ORCBR_PROTOCOL_KIND}`);
  if (protocol?.protocolId !== ORCBR_PROTOCOL_ID) errors.push(`protocolId must be ${ORCBR_PROTOCOL_ID}`);
  if (protocol?.candidateId !== ORCBR_CANDIDATE_ID) errors.push(`candidateId must be ${ORCBR_CANDIDATE_ID}`);
  if (protocol?.researchOnly !== true) errors.push("researchOnly must be true");
  if (protocol?.trainOnly !== true) errors.push("trainOnly must be true");
  if (protocol?.outcomeBlind !== true) errors.push("outcomeBlind must be true");
  if (protocol?.productAuthorization !== false) errors.push("productAuthorization must be false");
  if (protocol?.productVerdict !== ORCBR_PRODUCT_VERDICT) {
    errors.push(`productVerdict must be ${ORCBR_PRODUCT_VERDICT}`);
  }
  if (protocol?.moduleAStatus !== "CLOSED_NOT_REOPENED") {
    errors.push("moduleAStatus must be CLOSED_NOT_REOPENED");
  }
  if (protocol?.unitContract !== ORCBR_UNIT_CONTRACT_V2) {
    errors.push(`unitContract must be ${ORCBR_UNIT_CONTRACT_V2}`);
  }
  if (protocol?.packageSlotBudget !== 12) errors.push("packageSlotBudget must be 12");
  if (protocol?.calAllowed !== false) errors.push("calAllowed must be false");
  if (protocol?.testAllowed !== false) errors.push("testAllowed must be false");
  if (protocol?.networkEnabled !== false) errors.push("networkEnabled must be false");
  if (protocol?.ourColor !== "black") errors.push("ourColor must be black");
  if (protocol?.humanAuthorization !== false && protocol?.humanAuthorization != null) {
    errors.push("humanAuthorization must be false");
  }
  // Pin integrity: if pins present, must match frozen thresholds (no silent retune).
  if (protocol?.pins && typeof protocol.pins === "object") {
    for (const [k, expected] of Object.entries(FROZEN_PINS)) {
      if (protocol.pins[k] != null && protocol.pins[k] !== expected) {
        errors.push(`pins.${k} must be ${expected} (frozen), got ${protocol.pins[k]}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Merge protocol pins over frozen defaults (never invent relaxed floors). */
export function resolvePins(protocolOrPins = null, overrides = null) {
  const base = { ...FROZEN_PINS };
  if (protocolOrPins?.pins && typeof protocolOrPins.pins === "object") {
    Object.assign(base, protocolOrPins.pins);
  } else if (protocolOrPins && typeof protocolOrPins === "object" && !protocolOrPins.protocolId) {
    Object.assign(base, protocolOrPins);
  }
  if (overrides && typeof overrides === "object") Object.assign(base, overrides);
  return base;
}
