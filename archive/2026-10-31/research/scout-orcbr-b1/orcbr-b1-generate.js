// ORCBR-B1 TRAIN-only package builder — Black subject, strict chronology,
// repeat-opponent conditional state-response rules. No outcomes/engines/peer pooling.

import {
  VERDICTS,
  FROZEN_PINS,
  assertOpponentKeysPresent,
  dedupeGamesById,
  sortGamesChronologically,
  splitTrainAtCutoff,
  stripOutcomeFields,
  stripOutcomesDeep,
  sha256Hex,
} from "./orcbr-b1-schema.js";
import {
  PACKAGE_SLOT_BUDGET,
  buildPreparationUnitV2,
  packUnitsToBudget,
  packageContentHash,
  validatePackage,
} from "./orcbr-b1-units.js";

/** Live/default floors = frozen protocol pins. Fixture tests may override via pins. */
const DEFAULT_PINS = Object.freeze({
  g_min_white_games_per_key: FROZEN_PINS.g_min_white_games_per_key,
  d_min_distinct_days_per_key: FROZEN_PINS.d_min_distinct_days_per_key,
  n_o_min_opponent_keys: FROZEN_PINS.n_o_min_opponent_keys,
  max_ply: FROZEN_PINS.max_ply,
});

/**
 * Opening family key from White-as-opponent game: first maxPly UCIs joined.
 * Used as familyEpd token for prefix_or_epd_family matcher (research Phase0).
 */
export function openingFamilyKey(game, maxPly = 12) {
  const ucis = Array.isArray(game?.ucis) ? game.ucis : [];
  const n = Math.min(ucis.length, maxPly);
  if (n < 2) return null;
  // Prefer even ply so Black has moved at least once for a reply target, but
  // family is defined on White's opening path prefix (all plies up to n).
  return ucis.slice(0, n).join(" ");
}

export function dayKeyOf(game) {
  if (game?.dayKey) return game.dayKey;
  const ms = Number.isFinite(game?.createdAtMs) ? game.createdAtMs : Number(game?.datestamp) || 0;
  if (!ms) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Index opponent White games (subject Black games vs opponentKey, using
 * opponent's White moves as state — i.e. games where subject is Black).
 * Conditioning evidence: only TRAIN games prior to cutoff.
 */
export function indexOpponentWhiteHistory(trainGames) {
  const byKey = new Map();
  for (const g of sortGamesChronologically(trainGames)) {
    if (g.color !== "black") continue; // subject Black only
    if (!g.opponentKey) continue;
    const clean = stripOutcomeFields(g);
    let bucket = byKey.get(clean.opponentKey);
    if (!bucket) {
      bucket = { opponentKey: clean.opponentKey, games: [], days: new Set() };
      byKey.set(clean.opponentKey, bucket);
    }
    bucket.games.push(clean);
    const dk = dayKeyOf(clean);
    if (dk) bucket.days.add(dk);
  }
  return byKey;
}

/**
 * Recurring opening families for one opponent from TRAIN only.
 * Family support = distinct games sharing the same openingFamilyKey prefix (depth 4 plies default).
 */
export function buildRecurringFamilies(opponentGames, { familyPly = 4, maxPly = 12 } = {}) {
  const counts = new Map(); // familyKey -> { games: Set, days: Set, replyVotes: Map }
  for (const g of opponentGames) {
    const ucis = Array.isArray(g.ucis) ? g.ucis : [];
    if (ucis.length < familyPly + 1) continue; // need White path + Black reply
    const fam = ucis.slice(0, familyPly).join(" ");
    // Black reply is ply familyPly (0-based index familyPly) when familyPly is even?
    // Ply indices: 0 W, 1 B, 2 W, 3 B for familyPly=4 means after 4 plies next is White.
    // For conditional Black response: family ends on White move so Black replies next.
    // Use odd familyPly so last ply is White (0-based even index last).
    // Simpler: family = first `familyPly` plies if familyPly is odd (ends on White? ply1=W index0).
    // index 0 White, 1 Black, 2 White → family of length 1,3,5 ends on White; Black replies at index length.
    let end = familyPly;
    if (end % 2 === 0) end = Math.max(1, end - 1); // force end on White move (odd length)
    if (ucis.length < end + 1) continue;
    const familyKey = ucis.slice(0, end).join(" ");
    const replyUci = ucis[end]; // Black's reply in that historical game
    let rec = counts.get(familyKey);
    if (!rec) {
      rec = {
        familyKey,
        gameIds: new Set(),
        days: new Set(),
        replyVotes: new Map(),
      };
      counts.set(familyKey, rec);
    }
    rec.gameIds.add(String(g.gameId));
    const dk = dayKeyOf(g);
    if (dk) rec.days.add(dk);
    rec.replyVotes.set(replyUci, (rec.replyVotes.get(replyUci) || 0) + 1);
  }

  const families = [];
  for (const rec of counts.values()) {
    if (rec.gameIds.size < 2) continue; // multi-game recurrence
    // pinned reply = most frequent historical Black reply; tie → lexical
    let bestReply = null;
    let bestN = -1;
    for (const [uci, n] of [...rec.replyVotes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (n > bestN) {
        bestN = n;
        bestReply = uci;
      }
    }
    if (!bestReply) continue;
    families.push({
      familyKey: rec.familyKey,
      supportGames: rec.gameIds.size,
      supportDays: rec.days.size,
      replyUci: bestReply,
      maxPly,
    });
  }
  // deterministic order
  families.sort((a, b) => {
    if (b.supportGames !== a.supportGames) return b.supportGames - a.supportGames;
    if (b.supportDays !== a.supportDays) return b.supportDays - a.supportDays;
    return a.familyKey.localeCompare(b.familyKey);
  });
  return families;
}

function coverageCostForFamily(family) {
  // Narrow single-prefix families → cost 1; Phase0 research units are prefix keys.
  // Breadth measured by number of family EPDs we attach (always 1 here) → cost 1.
  return 1;
}

/**
 * Build candidate preparation-unit-v2 list from TRAIN games (Black subject).
 */
export function buildCandidateUnits(trainGames, pins = {}) {
  const p = { ...DEFAULT_PINS, ...pins };
  const byKey = indexOpponentWhiteHistory(trainGames);
  const candidates = [];
  // Fixture overrides may set research_min_*; otherwise frozen longitudinal floors.
  const gMin = p.research_min_white_games ?? p.g_min_white_games_per_key;
  const dMin = p.research_min_days ?? p.d_min_distinct_days_per_key;

  for (const [opponentKey, bucket] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const whiteGames = bucket.games;
    const days = bucket.days.size;
    if (whiteGames.length < gMin) continue;
    if (days < dMin) continue;

    const families = buildRecurringFamilies(whiteGames, {
      familyPly: 4,
      maxPly: p.max_ply,
    });
    for (const fam of families) {
      const cost = coverageCostForFamily(fam);
      try {
        const unit = buildPreparationUnitV2({
          opponentKey,
          familyEpds: [fam.familyKey],
          replyUci: fam.replyUci,
          coverageCost: cost,
          maxPly: fam.maxPly,
          wildcardPlyCount: 0,
          exactPly: fam.familyKey.split(" ").length,
        });
        candidates.push({
          unit,
          supportGames: fam.supportGames,
          supportDays: fam.supportDays,
          opponentKey,
        });
      } catch {
        // fail-closed skip invalid
      }
    }
  }
  return candidates;
}

/**
 * TRAIN-only package construction for one subject.
 * If records lack opponentKey entirely → STOP_SCHEMA_UNAVAILABLE.
 */
export function generateTrainPackage(games, options = {}) {
  const {
    cutoffIndex = null,
    cutoffMs = null,
    pins = {},
    requireExactFill = true,
    budget = PACKAGE_SLOT_BUDGET,
  } = options;

  // Chronology + dedupe before any conditioning; outcome fields stripped before use.
  const ordered = dedupeGamesById(games || []).map((g) => stripOutcomesDeep(g));
  const keyCheck = assertOpponentKeysPresent(ordered);
  if (!keyCheck.ok) {
    return {
      ok: false,
      verdict: VERDICTS.STOP_SCHEMA_UNAVAILABLE,
      reason: keyCheck.reason,
      package: null,
    };
  }

  const { train } = splitTrainAtCutoff(ordered, { cutoffIndex, cutoffMs });
  // Outcome-blind: never use score/result/winner/status for package construction
  const trainClean = train.map(stripOutcomeFields);

  const blackTrain = trainClean.filter((g) => g.color === "black");
  if (!blackTrain.length) {
    return {
      ok: false,
      verdict: VERDICTS.STOP_PACKAGE_EMPTY,
      reason: "no Black TRAIN games",
      package: null,
    };
  }

  const candidates = buildCandidateUnits(blackTrain, pins);
  if (!candidates.length) {
    return {
      ok: false,
      verdict: VERDICTS.STOP_PACKAGE_EMPTY,
      reason: "no recurring opponent families in TRAIN",
      package: null,
      trainGameCount: blackTrain.length,
    };
  }

  // Pad with additional cost-1 units from remaining candidates to fill budget 12.
  // If fewer than 12 candidates, try to emit cost-adjusted units (still fail if underfill required).
  let packed = packUnitsToBudget(candidates, { budget, requireExactFill: false });

  // If underfilled and we have room, duplicate-free: nothing more to pack.
  // For structural Phase0 tests with small fixtures, allow generating filler-narrow units
  // from top families by splitting is NOT allowed (no invented families).
  // Instead: if underfill, return STOP_PACKAGE_EMPTY when requireExactFill.

  if (requireExactFill && packed.totalCost !== budget) {
    // Attempt to fill by admitting cost-1 candidates only until 12 — already done.
    // If still short, try reducing is impossible; mark empty.
    if (packed.totalCost === 0) {
      return {
        ok: false,
        verdict: VERDICTS.STOP_PACKAGE_EMPTY,
        reason: "pack produced zero cost",
        package: null,
      };
    }
    // Honest underfill path for research diagnostics when exact fill impossible:
    // protocol prefers exact 12; G3 fails closed on underfill when requireExactFill.
    return {
      ok: false,
      verdict: VERDICTS.STOP_PACKAGE_EMPTY,
      reason: `package underfill totalCost=${packed.totalCost} budget=${budget}`,
      package: {
        unitContract: "preparation-unit-v2",
        budget,
        totalCost: packed.totalCost,
        exactFill: false,
        units: packed.units,
        meta: packed.meta,
        packageSha256: packageContentHash(packed.units),
        trainGameCount: blackTrain.length,
        candidateCount: candidates.length,
      },
      trainGameCount: blackTrain.length,
      candidateCount: candidates.length,
    };
  }

  const packVal = validatePackage(packed.units, { budget, requireExactFill });
  if (!packVal.ok && requireExactFill) {
    return {
      ok: false,
      verdict: packed.totalCost > budget
        ? VERDICTS.STOP_COST_GAMING
        : VERDICTS.STOP_PACKAGE_EMPTY,
      reason: packVal.errors.join("; "),
      package: null,
    };
  }

  const pkg = {
    unitContract: "preparation-unit-v2",
    budget,
    totalCost: packed.totalCost,
    exactFill: packed.exactFill,
    units: packed.units,
    meta: packed.meta,
    packageSha256: packageContentHash(packed.units),
    trainGameCount: blackTrain.length,
    candidateCount: candidates.length,
    productAuthorization: false,
    productVerdict: "preserve-v2",
    trainOnly: true,
    outcomeBlind: true,
  };

  return {
    ok: true,
    verdict: VERDICTS.READY_FOR_GATES,
    package: pkg,
    trainGameCount: blackTrain.length,
    candidateCount: candidates.length,
  };
}

/**
 * Deterministic package from identical TRAIN → identical hash.
 */
export function packageDeterminismHash(games, options = {}) {
  const result = generateTrainPackage(games, { ...options, requireExactFill: false });
  if (!result.package) return null;
  return result.package.packageSha256;
}

/**
 * Build synthetic fill to budget for fixtures that need exact-12 packages.
 * Only uses real candidate families; never invents opponent keys.
 * When candidates < 12, clones are forbidden — instead assign remaining budget
 * by raising coverageCost on broadest units is also forbidden (monotone).
 * So exact-12 fixtures must supply ≥12 distinct recurring families.
 *
 * Helper for tests: expand a small set by treating successive prefix depths as families.
 */
export function expandCandidatesToBudget(trainGames, budget = PACKAGE_SLOT_BUDGET, pins = {}) {
  const p = { ...DEFAULT_PINS, ...pins };
  const gMin = p.research_min_white_games ?? p.g_min_white_games_per_key;
  const dMin = p.research_min_days ?? p.d_min_distinct_days_per_key;
  const ordered = dedupeGamesById(trainGames).map(stripOutcomeFields);
  const byKey = indexOpponentWhiteHistory(ordered);
  const candidates = [];
  for (const [opponentKey, bucket] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // No global pooling: skip opponents below longitudinal floors
    if (bucket.games.length < gMin || bucket.days.size < dMin) continue;
    for (const g of bucket.games) {
      const ucis = g.ucis || [];
      for (let depth = 1; depth <= Math.min(11, ucis.length - 1); depth += 2) {
        const familyKey = ucis.slice(0, depth).join(" ");
        const replyUci = ucis[depth];
        if (!replyUci) continue;
        // need at least 2 games supporting this family for recurrence
        const support = bucket.games.filter((x) => {
          const u = x.ucis || [];
          return u.length > depth && u.slice(0, depth).join(" ") === familyKey;
        });
        if (support.length < 2) continue;
        const days = new Set(support.map(dayKeyOf).filter(Boolean));
        try {
          const unit = buildPreparationUnitV2({
            opponentKey,
            familyEpds: [familyKey],
            replyUci,
            coverageCost: 1,
            maxPly: 12,
            exactPly: depth,
          });
          candidates.push({
            unit,
            supportGames: support.length,
            supportDays: days.size,
            opponentKey,
          });
        } catch {
          // skip
        }
        if (candidates.length >= budget * 3) break;
      }
    }
  }
  // dedupe by unitId
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c.unit.unitId)) continue;
    seen.add(c.unit.unitId);
    unique.push(c);
  }
  return packUnitsToBudget(unique, { budget, requireExactFill: false });
}

export function scientificPayloadSha256(pkg) {
  if (!pkg) return null;
  const payload = {
    unitContract: pkg.unitContract,
    budget: pkg.budget,
    totalCost: pkg.totalCost,
    units: (pkg.units || []).map((u) => ({
      unitId: u.unitId,
      opponentKey: u.identityPayload.opponentKey,
      coverageCost: u.identityPayload.coverageCost,
      familyEpds: u.identityPayload.matcher.familyEpds,
      replyUci: u.identityPayload.response.replyUci,
    })),
  };
  return sha256Hex(JSON.stringify(payload));
}
