// Scout v13 — style classification, risk badges, memorability (pure functions).
// No DOM, no engine, no providers — inputs are precomputed metrics objects.

import { PACKAGE_STYLES } from "./scout-v13-package.js";

/** @typedef {typeof PACKAGE_STYLES[number]} PackageStyle */

export const STYLE_PRIMARY_ORDER = Object.freeze(["sharp", "forcing", "rare", "solid"]);

// --- Style thresholds (design §5) ---
export const SOLID_ENDPOINT_EVAL_MIN_CP = 15;
export const SOLID_GAP_MAX_CP = 15;
export const SOLID_EVAL_SWING_MAX_CP = 60;

export const SHARP_EVAL_SWING_MIN_CP = 80;
export const SHARP_GAP_MAX_CP = 20;

export const RARE_SHARE_PCT_THRESHOLD = 5;
export const RARE_HIGH_VOLUME_GAMES = 10000;
export const RARE_HIGH_VOLUME_SHARE_PCT_THRESHOLD = 10;
export const RARE_GAP_MAX_CP = 25;

export const FORCING_GOOD_REPLIES_MAX = 2;
export const FORCING_THREAT_DENSITY_MIN = 0.5;
export const FORCING_TOP_TWO_COVERAGE_MIN_PCT = 65;

// --- Risk badge thresholds (design §5) ---
export const HIGH_VARIANCE_EVAL_SWING_MIN_CP = 120;

export const RISK_BADGE_THIN_SAMPLE = "ThinSample";
export const RISK_BADGE_COHORT_ONLY = "CohortOnly";
export const RISK_BADGE_NARROW = "Narrow";
export const RISK_BADGE_HIGH_VARIANCE = "HighVariance";
export const RISK_BADGE_LOW_THEORY = "LowTheory";
export const RISK_BADGE_TRANSPOSITIONS = "Transposes";

// --- Memorability hard budget (design §6) ---
export const MEM_MAX_LEAVES = 6;
export const MEM_MAX_FORKS = 3;
export const MEM_MAX_REPLIES_PER_FORK = 2;
export const MEM_MAX_REPLIES_PER_FORK_WARN = 3;
export const MEM_MAX_ONLY_MOVE_NON_FORCING = 2;
export const MEM_MAX_CONCEPT_FAMILIES = 2;

// Harness-calibratable coefficients (design §9 — tuned in harness, not fixed in doc).
export const MEM_PENALTY_FORK_COEF = 2.0;
export const MEM_PENALTY_CONCEPT_COEF = 1.5;
export const MEM_PENALTY_ONLY_MOVE_COEF = 1.0;
export const MEM_PENALTY_TRANSPOSITION_COEF = 0.5;

// --- Concept families (design §6 — mirrored from scout-bias-features FEATURE_IDS) ---
export const CONCEPT_FAMILY_PAWN_STRUCTURE = "pawnStructure";
export const CONCEPT_FAMILY_DEVELOPMENT = "development";
export const CONCEPT_FAMILY_CENTER_STRATEGY = "centerStrategy";
export const CONCEPT_FAMILY_CASTLING = "castling";

/** @type {Readonly<Record<string, readonly string[]>>} */
export const CONCEPT_FAMILY_BY_FEATURE = Object.freeze({
  quietPawnPush: [CONCEPT_FAMILY_PAWN_STRUCTURE],
  centralPawnPush: [CONCEPT_FAMILY_PAWN_STRUCTURE, CONCEPT_FAMILY_CENTER_STRATEGY],
  pawnAdvancePastMidline: [CONCEPT_FAMILY_PAWN_STRUCTURE, CONCEPT_FAMILY_CENTER_STRATEGY],
  pawnPushOwnKingWing: [CONCEPT_FAMILY_PAWN_STRUCTURE, CONCEPT_FAMILY_CASTLING],
  resolvesPawnTension: [CONCEPT_FAMILY_PAWN_STRUCTURE],
  capturesPawn: [CONCEPT_FAMILY_PAWN_STRUCTURE],
  developsMinorFromHome: [CONCEPT_FAMILY_DEVELOPMENT],
  fianchetto: [CONCEPT_FAMILY_DEVELOPMENT],
  rookLift: [CONCEPT_FAMILY_DEVELOPMENT],
  minorPieceToCenter: [CONCEPT_FAMILY_DEVELOPMENT, CONCEPT_FAMILY_CENTER_STRATEGY],
  movesSamePieceAgain: [CONCEPT_FAMILY_DEVELOPMENT],
  isCastle: [CONCEPT_FAMILY_CASTLING],
  kingMoveNonCastle: [CONCEPT_FAMILY_CASTLING],
});

/**
 * @typedef {object} StyleMetrics
 * @property {number} endpointEvalCp — SF eval at extension endpoint (centipawns, our perspective).
 * @property {number[]} ourGaps — per our-move gapToBestCp across the whole package.
 * @property {number} evalSwingCp — max eval spread across his main replies.
 * @property {boolean} hasSacrifice — true when the package includes a sacrifice line.
 * @property {number} anchorAttribution — tilt attribution at the personal anchor.
 * @property {number} attributionP75 — P75 attribution across the current selection run.
 * @property {boolean} leakMoveIsCaptureOrCheck — leak move at anchor is capture or check class.
 * @property {number} onlyMoveCount — count of only-move moments in the package.
 * @property {number} entryMoveExplorerSharePct — explorer share% for our entry move in cohort.
 * @property {number} entryNodeTotalGames — explorer total games at the entry node.
 * @property {number} goodRepliesWithin50Cp — min over key nodes of good replies within 50cp.
 * @property {number} checkCaptureThreatDensity — check/capture threat density 0..1 at key nodes.
 * @property {number} topTwoRepliesCoveragePct — explorer top-two reply coverage at key nodes.
 */

/**
 * @typedef {object} PkgRiskMetrics
 * @property {number[]} personalEdgeGames — games on each personal edge in the package.
 * @property {boolean} extensionHasPersonal — true when extension includes any personal edge.
 * @property {number} onlyMoveCount
 * @property {number} evalSwingCp
 * @property {PackageStyle|null} primaryStyle
 * @property {boolean} entryTransposes — entry can transpose to an equivalent EPD path.
 */

/**
 * @typedef {object} MemorabilityTree
 * @property {number} leafCount
 * @property {number} forkCount
 * @property {number} maxRepliesPerFork
 * @property {number} onlyMoveCount
 * @property {string[]} conceptFamilies — unique concept family ids present in the tree.
 * @property {PackageStyle|null} style
 */

function everyGapAtMost(gaps, maxCp) {
  if (!Array.isArray(gaps) || gaps.length === 0) return true;
  return gaps.every((gap) => Number.isFinite(gap) && gap <= maxCp);
}

function rareShareThreshold(entryNodeTotalGames) {
  return entryNodeTotalGames >= RARE_HIGH_VOLUME_GAMES
    ? RARE_HIGH_VOLUME_SHARE_PCT_THRESHOLD
    : RARE_SHARE_PCT_THRESHOLD;
}

function qualifiesSolid(metrics) {
  return (
    metrics.endpointEvalCp >= SOLID_ENDPOINT_EVAL_MIN_CP &&
    everyGapAtMost(metrics.ourGaps, SOLID_GAP_MAX_CP) &&
    metrics.evalSwingCp <= SOLID_EVAL_SWING_MAX_CP &&
    !metrics.hasSacrifice
  );
}

function qualifiesSharp(metrics) {
  return (
    metrics.anchorAttribution >= metrics.attributionP75 &&
    metrics.leakMoveIsCaptureOrCheck &&
    (metrics.evalSwingCp >= SHARP_EVAL_SWING_MIN_CP || metrics.onlyMoveCount >= 1) &&
    everyGapAtMost(metrics.ourGaps, SHARP_GAP_MAX_CP)
  );
}

function qualifiesRare(metrics) {
  const shareMax = rareShareThreshold(metrics.entryNodeTotalGames);
  return (
    metrics.entryMoveExplorerSharePct <= shareMax &&
    everyGapAtMost(metrics.ourGaps, RARE_GAP_MAX_CP)
  );
}

function qualifiesForcing(metrics) {
  return (
    metrics.goodRepliesWithin50Cp <= FORCING_GOOD_REPLIES_MAX &&
    metrics.checkCaptureThreatDensity >= FORCING_THREAT_DENSITY_MIN &&
    metrics.topTwoRepliesCoveragePct >= FORCING_TOP_TWO_COVERAGE_MIN_PCT
  );
}

/**
 * Classify package styles from precomputed metrics (design §5).
 * @param {StyleMetrics} metrics
 * @returns {{ styles: PackageStyle[], primary: PackageStyle|null }}
 */
export function classifyStyles(metrics) {
  const styles = [];
  if (qualifiesSolid(metrics)) styles.push("solid");
  if (qualifiesSharp(metrics)) styles.push("sharp");
  if (qualifiesRare(metrics)) styles.push("rare");
  if (qualifiesForcing(metrics)) styles.push("forcing");

  const primary = STYLE_PRIMARY_ORDER.find((style) => styles.includes(style)) ?? null;
  return { styles, primary };
}

/**
 * Derive non-tier risk badges from package metrics (design §5).
 * @param {PkgRiskMetrics} pkgMetrics
 * @returns {string[]}
 */
export function deriveRiskBadges(pkgMetrics) {
  const badges = [];

  if (
    Array.isArray(pkgMetrics.personalEdgeGames) &&
    pkgMetrics.personalEdgeGames.some(
      (games) => Number.isFinite(games) && games >= 5 && games < 10,
    )
  ) {
    badges.push(RISK_BADGE_THIN_SAMPLE);
  }
  if (!pkgMetrics.extensionHasPersonal) {
    badges.push(RISK_BADGE_COHORT_ONLY);
  }
  if (pkgMetrics.onlyMoveCount >= 1) {
    badges.push(RISK_BADGE_NARROW);
  }
  if (pkgMetrics.evalSwingCp >= HIGH_VARIANCE_EVAL_SWING_MIN_CP) {
    badges.push(RISK_BADGE_HIGH_VARIANCE);
  }
  if (pkgMetrics.primaryStyle === "rare") {
    badges.push(RISK_BADGE_LOW_THEORY);
  }
  if (pkgMetrics.entryTransposes) {
    badges.push(RISK_BADGE_TRANSPOSITIONS);
  }

  return badges;
}

/**
 * Check memorability hard budget (design §6). Exceeding limits yields violations;
 * three replies per fork is allowed with a warning only.
 * @param {MemorabilityTree} tree
 * @param {object} [_opts] — reserved for harness overrides.
 * @returns {{ ok: boolean, violations: string[], warnings: string[] }}
 */
export function checkMemorabilityBudget(tree, _opts = {}) {
  const violations = [];
  const warnings = [];

  if (tree.leafCount > MEM_MAX_LEAVES) {
    violations.push(`leafCount ${tree.leafCount} exceeds ${MEM_MAX_LEAVES}`);
  }
  if (tree.forkCount > MEM_MAX_FORKS) {
    violations.push(`forkCount ${tree.forkCount} exceeds ${MEM_MAX_FORKS}`);
  }
  if (tree.maxRepliesPerFork > MEM_MAX_REPLIES_PER_FORK_WARN) {
    violations.push(
      `maxRepliesPerFork ${tree.maxRepliesPerFork} exceeds ${MEM_MAX_REPLIES_PER_FORK_WARN}`,
    );
  } else if (tree.maxRepliesPerFork > MEM_MAX_REPLIES_PER_FORK) {
    warnings.push(
      `maxRepliesPerFork ${tree.maxRepliesPerFork} exceeds ${MEM_MAX_REPLIES_PER_FORK} (rare allowance up to ${MEM_MAX_REPLIES_PER_FORK_WARN})`,
    );
  }
  if (
    tree.style !== "forcing" &&
    tree.onlyMoveCount > MEM_MAX_ONLY_MOVE_NON_FORCING
  ) {
    violations.push(
      `onlyMoveCount ${tree.onlyMoveCount} exceeds ${MEM_MAX_ONLY_MOVE_NON_FORCING} for non-forcing style`,
    );
  }
  if (tree.conceptFamilies.length > MEM_MAX_CONCEPT_FAMILIES) {
    violations.push(
      `conceptFamilies ${tree.conceptFamilies.length} exceeds ${MEM_MAX_CONCEPT_FAMILIES}`,
    );
  }

  return { ok: violations.length === 0, violations, warnings };
}

/**
 * Soft memorability penalty for bucket tie-break (design §6).
 * @param {{ forkCount: number, uniqueConceptCount: number, onlyMoveCount: number, transpositionDivergence: number }} input
 * @returns {number}
 */
export function memPenalty(input) {
  const forkTerm =
    MEM_PENALTY_FORK_COEF * Math.log2(1 + input.forkCount);
  const conceptTerm = MEM_PENALTY_CONCEPT_COEF * input.uniqueConceptCount;
  const onlyMoveTerm = MEM_PENALTY_ONLY_MOVE_COEF * input.onlyMoveCount;
  const transpositionTerm =
    MEM_PENALTY_TRANSPOSITION_COEF * input.transpositionDivergence;
  return forkTerm + conceptTerm + onlyMoveTerm + transpositionTerm;
}

/**
 * Union concept families for a list of edges' feature-id lists (design §6).
 * Unknown feature ids are ignored.
 * @param {string[][]} edgeFeatureIds
 * @returns {string[]}
 */
export function conceptFamiliesForEdges(edgeFeatureIds) {
  const families = new Set();
  for (const featureIds of edgeFeatureIds) {
    if (!Array.isArray(featureIds)) continue;
    for (const featureId of featureIds) {
      const mapped = CONCEPT_FAMILY_BY_FEATURE[featureId];
      if (!mapped) continue;
      for (const family of mapped) {
        families.add(family);
      }
    }
  }
  return [...families].sort();
}