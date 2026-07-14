// Scout SHADOW-PREP P0 — sealed materials feasibility gate (pure core).
// Candidate evidence is projected before use; providers, filesystem, and DOM stay in the CLI.

import { Chess } from "chess.js";

import { epdOf } from "./scout-graph.js";
import {
  MEM_MAX_FORKS,
  MEM_MAX_LEAVES,
  MEM_MAX_REPLIES_PER_FORK,
  checkMemorabilityBudget,
} from "./scout-v13-style.js";
import {
  REF_DF_COLORS,
  REF_DF_SUBJECT_USERNAME,
  isPerfEligibleSpeed,
  scanForbiddenFields,
  sha256RefDfProtocol,
  utcDayKeyFromMs,
} from "./scout-ref-df-census.js";
import { sha256Hex } from "./scout-v15-study.js";
import { buildEngineIdentity, engineIdentityKey, identitiesMatch } from "./scout-v15-engine-cache.js";

export const SHADOW_PREP_PROTOCOL_KIND = "scout-shadow-prep-p0-protocol";
export const SHADOW_PREP_PROTOCOL_ID = "ericrosen-shadow-prep-p0";
export const SHADOW_PREP_REPORT_KIND = "scout-shadow-prep-p0-report";
export const SHADOW_PREP_REPORT_VERSION = 1;
export const SHADOW_PREP_FINAL_REPORT_NAME = "shadow-prep-p0-report.json";
export const SHADOW_PREP_SUBJECT_USERNAME = REF_DF_SUBJECT_USERNAME;
export const SHADOW_PREP_COLORS = REF_DF_COLORS;
export const SHADOW_PREP_SUBJECT_MOVE_ORDINALS = Object.freeze([2, 3, 4, 5, 6]);
export const SHADOW_PREP_MAX_ATOM_PLIES = 12;
export const SHADOW_PREP_PILOT_SOURCE_ORDER = Object.freeze(["h-m1", "h-r1", "legacy"]);

export const SHADOW_PREP_STATES = Object.freeze({
  UNINITIALIZED: "uninitialized",
  INITIALIZED: "initialized",
  BUILDING: "building",
  BUILT: "built",
  CENSUS_COMPLETE: "census-complete",
  VERIFIED: "verified",
});

export const SHADOW_PREP_STATE_TRANSITIONS = Object.freeze({
  [SHADOW_PREP_STATES.UNINITIALIZED]: [SHADOW_PREP_STATES.INITIALIZED],
  [SHADOW_PREP_STATES.INITIALIZED]: [SHADOW_PREP_STATES.BUILDING],
  [SHADOW_PREP_STATES.BUILDING]: [SHADOW_PREP_STATES.BUILT],
  [SHADOW_PREP_STATES.BUILT]: [SHADOW_PREP_STATES.CENSUS_COMPLETE],
  [SHADOW_PREP_STATES.CENSUS_COMPLETE]: [SHADOW_PREP_STATES.VERIFIED],
  [SHADOW_PREP_STATES.VERIFIED]: [],
});

export const SHADOW_PREP_VERDICTS = Object.freeze({
  MATERIALS_FEASIBLE: "materials-feasible",
  INSUFFICIENT_CANDIDATE_SUPPORT: "insufficient-candidate-support",
  BASELINE_BUILD_FAILED: "baseline-build-failed",
  BUDGET_UNMATCHABLE: "budget-unmatchable",
  INSUFFICIENT_TREATMENT_DISTINCTNESS: "insufficient-treatment-distinctness",
  INSUFFICIENT_PILOT_STIMULI: "insufficient-pilot-stimuli",
});

export const SHADOW_PREP_ALLOWED_BUILD_KEYS = Object.freeze([
  "gameId", "color", "createdAtMs", "dayKey", "speed", "perfEligible", "ucis",
]);
export const SHADOW_PREP_ALLOWED_STIMULUS_KEYS = Object.freeze([
  ...SHADOW_PREP_ALLOWED_BUILD_KEYS, "sourceBlock",
]);

export const SHADOW_PREP_FORBIDDEN_CANDIDATE_KEYS = Object.freeze([
  "score", "status", "result", "wdl", "winner", "eval", "evals", "stockfish",
  "maia", "explorer", "cohort", "vulnerability", "weakness", "prepValue",
  "baselineScorePct", "excessErrorCp", "responseRate", "futureHit",
  "futureOccurrence", "stimulusHit", "yield", "utility", "rating",
  "opponentRating", "clockAfterPly", "thinkTime", "hR1Label", "hM1Label",
  "refDfRank", "productionRank", "prediction",
]);

export const SHADOW_PREP_FORBIDDEN_REPORT_KEYS = Object.freeze([
  ...SHADOW_PREP_FORBIDDEN_CANDIDATE_KEYS,
  "weaknessClaim", "subjectOnlyTrait", "causalTrait", "expectedReply",
  "futureBehavior", "developmentAuthorization", "confirmationAuthorization",
  "productAuthorizationFromOutcomes", "humanPerformanceClaim", "superiorityClaim",
  "liveEloClaim", "wildUsageClaim", "traitClaim", "predictionClaim",
]);

export const CANONICAL_STUDY_UNIT_FIELDS = Object.freeze([
  "triggerEpd", "subjectUci", "postTriggerEpd", "userResponseUci", "sanLine",
  "diagramCount", "textCharCount", "engineIdentityKey", "ySource",
]);

function finiteMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function median(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normalizeUciForChessJs(chess, uci) {
  if (!uci || uci.length < 4) return uci;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci[4] || "";
  const castleMap = {
    e1h1: "e1g1",
    e1a1: "e1c1",
    e8h8: "e8g8",
    e8a8: "e8c8",
  };
  const mapped = castleMap[`${from}${to}`];
  if (!mapped) return uci;
  const legal = chess.moves({ verbose: true });
  const directLegal = legal.some(
    (m) => m.from === from && m.to === to && (m.promotion || "") === promotion,
  );
  if (directLegal) return uci;
  const mappedFrom = mapped.slice(0, 2);
  const mappedTo = mapped.slice(2, 4);
  const mappedLegal = legal.some(
    (m) => m.from === mappedFrom && m.to === mappedTo && (m.promotion || "") === promotion,
  );
  return mappedLegal ? `${mapped}${promotion}` : uci;
}

function moveUci(chess, uci) {
  const normalized = normalizeUciForChessJs(chess, uci);
  return chess.move({
    from: normalized.slice(0, 2),
    to: normalized.slice(2, 4),
    promotion: normalized[4] || undefined,
  });
}

function safeMove(chess, uci) {
  try {
    return moveUci(chess, uci);
  } catch (_) {
    return null;
  }
}

function normalizedFenFromUcis(ucis) {
  const chess = new Chess();
  for (const uci of ucis || []) {
    if (!safeMove(chess, uci)) return null;
  }
  return chess.fen();
}

function subjectPlyIndex(color, ordinal) {
  return color === "white" ? (ordinal - 1) * 2 : ordinal * 2 - 1;
}

function rootKeyForPath(pathUcis) {
  return (pathUcis || []).slice(0, 2).join(">");
}

/** Deterministic SAN from FEN+UCI; fail closed instead of substituting raw UCI. */
export function uciToSanStrict(fen, uci) {
  if (!fen || !uci) throw new Error("missing fen or uci for SAN");
  const chess = new Chess(fen);
  const normalized = normalizeUciForChessJs(chess, uci);
  const move = chess.move({
    from: normalized.slice(0, 2),
    to: normalized.slice(2, 4),
    promotion: normalized[4] || undefined,
  });
  if (!move?.san) throw new Error(`cannot produce SAN for ${uci}`);
  return move.san;
}

/** Convert Stockfish score (side-to-move POV) to centipawns from White's perspective. */
export function scoreToWhiteCp(score, sideToMove) {
  if (!score) return null;
  if (score.type === "cp") {
    const cp = Number(score.cp);
    if (!Number.isFinite(cp)) return null;
    return sideToMove === "white" ? cp : -cp;
  }
  if (score.type === "mate") {
    const mate = Number(score.value);
    if (!Number.isFinite(mate) || mate === 0) return null;
    const whiteMate = sideToMove === "white" ? mate : -mate;
    const magnitude = Math.abs(mate);
    const sign = whiteMate > 0 ? 1 : -1;
    return sign * (10_000 - magnitude);
  }
  return null;
}

function materialChecksEqual(left, right) {
  return SHADOW_PREP_COLORS.every((color) => {
    const a = left?.[color];
    const b = right?.[color];
    return a?.ok === b?.ok && JSON.stringify(a?.errors || []) === JSON.stringify(b?.errors || []);
  });
}

export function computeShadowPrepBuildArtifactHashes({
  candidatePackages,
  baselinePackages,
  sharedYReceipts,
  materialChecks,
  materials = {},
}) {
  const materialHashes = Object.fromEntries(
    SHADOW_PREP_COLORS.flatMap((color) => [
      [`candidate-${color}`, sha256Hex(materials?.candidate?.[color] ?? [])],
      [`baseline-${color}`, sha256Hex(materials?.baseline?.[color] ?? [])],
    ]),
  );
  return {
    candidatePackages: sha256Hex(candidatePackages),
    baselinePackages: sha256Hex(baselinePackages),
    sharedYReceipts: sha256Hex(sharedYReceipts),
    materialChecks: sha256Hex(materialChecks),
    materials: materialHashes,
  };
}

/** Pure verifier for frozen build artifacts against a build manifest. */
export function verifyShadowPrepBuildArtifacts(manifest, {
  candidatePackages = null,
  baselinePackages = null,
  sharedYReceipts = null,
  materialChecks = null,
  materials = null,
} = {}) {
  const issues = [];
  if (!manifest) {
    issues.push({ kind: "missing-build-manifest" });
    return { ok: false, issues };
  }
  const expected = manifest.artifactHashes || {
    candidatePackages: manifest.packageHashes?.candidate ?? null,
    baselinePackages: manifest.packageHashes?.baseline ?? null,
    sharedYReceipts: manifest.ySha256 ?? null,
    materialChecks: manifest.materialChecksSha256 ?? null,
    materials: manifest.materialFileHashes ?? null,
  };
  const actual = computeShadowPrepBuildArtifactHashes({
    candidatePackages,
    baselinePackages,
    sharedYReceipts,
    materialChecks,
    materials: materials || {},
  });
  const compareHash = (name, exp, got) => {
    if (!exp) {
      issues.push({ kind: "missing-manifest-hash", artifact: name });
      return;
    }
    if (got == null) {
      issues.push({ kind: "missing-artifact", artifact: name });
      return;
    }
    if (String(exp).toLowerCase() !== String(got).toLowerCase()) {
      issues.push({ kind: "artifact-hash-mismatch", artifact: name, expected: exp, actual: got });
    }
  };
  compareHash("candidatePackages", expected.candidatePackages, actual.candidatePackages);
  compareHash("baselinePackages", expected.baselinePackages, actual.baselinePackages);
  compareHash("sharedYReceipts", expected.sharedYReceipts, actual.sharedYReceipts);
  compareHash("materialChecks", expected.materialChecks, actual.materialChecks);
  for (const key of SHADOW_PREP_COLORS.flatMap((color) => [`candidate-${color}`, `baseline-${color}`])) {
    compareHash(`materials.${key}`, expected.materials?.[key], actual.materials?.[key]);
  }
  if (manifest.materialChecks && materialChecks && !materialChecksEqual(manifest.materialChecks, materialChecks)) {
    issues.push({ kind: "material-checks-content-mismatch" });
  }
  return { ok: issues.length === 0, issues, expected, actual };
}

/** Filter atom receipts to one root and recompute conservative support geometry. */
export function projectAtomForRoot(atom, rootKey, protocol = null) {
  if (!atom?.triggerEpd || !atom?.subjectUci || !rootKey) return null;
  const rootReceipts = (atom.receipts || []).filter((receipt) => receipt?.rootKey === rootKey);
  if (!rootReceipts.length) return null;

  const displayPathMap = new Map();
  const subjectOrdinals = [];
  const depths = [];
  for (const receipt of rootReceipts) {
    if (Number.isFinite(receipt.subjectOrdinal)) subjectOrdinals.push(receipt.subjectOrdinal);
    if (Number.isFinite(receipt.depthHalfMoves)) depths.push(receipt.depthHalfMoves);
    const pathKey = (receipt.pathUcis || []).join(">");
    if (pathKey) displayPathMap.set(pathKey, [...receipt.pathUcis]);
  }

  const games = new Set(rootReceipts.map((receipt) => receipt.gameId));
  const dates = new Set(rootReceipts.map((receipt) => receipt.dayKey).filter(Boolean));
  const blocks = new Set(rootReceipts.map((receipt) => receipt.sourceBlock).filter(Boolean));
  const support = {
    distinctGames: games.size,
    distinctDates: dates.size,
    residualLooSupport: Math.max(0, games.size - 1),
    distinctSourceBlocks: blocks.size,
    gameIds: [...games].sort(),
    dayKeys: [...dates].sort(),
    sourceBlocks: [...blocks].sort(),
  };
  if (!isAtomEligible(support, protocol)) return null;

  return {
    ...atom,
    selectedRootKey: rootKey,
    subjectOrdinal: subjectOrdinals.length ? Math.min(...subjectOrdinals) : atom.subjectOrdinal,
    depthHalfMoves: depths.length ? Math.min(...depths) : atom.depthHalfMoves,
    rootKeys: [rootKey],
    receipts: [...rootReceipts].sort((a, b) => String(a.gameId).localeCompare(String(b.gameId))),
    displayPaths: [...displayPathMap.values()].sort((a, b) => a.join(">").localeCompare(b.join(">"))),
    support,
  };
}

export function sha256ShadowPrepProtocol(protocol) {
  const canonical = { ...(protocol || {}) };
  delete canonical.protocolSha256;
  return sha256Hex(`${JSON.stringify(canonical, null, 2)}\n`);
}

export function atomIdentityKey(triggerEpd, subjectUci) {
  return `${triggerEpd}|${subjectUci}`;
}

export function formatAtomKey(atom) {
  return atomIdentityKey(atom?.triggerEpd, atom?.subjectUci);
}

export function projectBuildGame(game) {
  const createdAtMs = finiteMs(game?.createdAtMs ?? game?.datestamp);
  const color = game?.color === "white" || game?.color === "black" ? game.color : null;
  const speed = typeof game?.speed === "string" ? game.speed.toLowerCase() : null;
  return {
    gameId: game?.gameId != null ? String(game.gameId) : game?.id != null ? String(game.id) : null,
    color,
    createdAtMs,
    dayKey: utcDayKeyFromMs(createdAtMs),
    speed,
    perfEligible: isPerfEligibleSpeed(speed),
    ucis: Array.isArray(game?.ucis) ? game.ucis.map(String).filter(Boolean) : [],
  };
}

export function projectStimulusGame(game, { sourceBlock = null } = {}) {
  return { ...projectBuildGame(game), sourceBlock: sourceBlock == null ? null : String(sourceBlock) };
}

export function assertNoForbiddenCandidateFields(value, {
  forbiddenKeys = SHADOW_PREP_FORBIDDEN_CANDIDATE_KEYS,
  label = "candidate artifact",
} = {}) {
  const hits = scanForbiddenFields(value, { forbiddenKeys });
  if (hits.length) throw new Error(`${label} contains forbidden fields: ${hits.join(", ")}`);
}

export function extractSubjectReplyAtomFromGame(game, {
  ordinal,
  maxPlies = SHADOW_PREP_MAX_ATOM_PLIES,
  sourceBlock = "build",
  protocol = null,
} = {}) {
  const projected = projectBuildGame(game);
  const ordinals = protocol?.subjectMoveOrdinals || SHADOW_PREP_SUBJECT_MOVE_ORDINALS;
  if (!projected.color || !projected.gameId || !projected.perfEligible || !ordinals.includes(ordinal)) return null;
  const plyIndex = subjectPlyIndex(projected.color, ordinal);
  if (plyIndex < 0 || plyIndex >= projected.ucis.length || plyIndex >= maxPlies) return null;

  const triggerPath = projected.ucis.slice(0, plyIndex);
  const subjectUci = projected.ucis[plyIndex];
  const triggerFen = normalizedFenFromUcis(triggerPath);
  if (!triggerFen) return null;
  const chess = new Chess(triggerFen);
  if (!safeMove(chess, subjectUci)) return null;
  const pathUcis = [...triggerPath, subjectUci];
  const triggerEpd = epdOf(triggerFen);
  const postTriggerFen = chess.fen();
  const postTriggerUserToMoveEpd = epdOf(postTriggerFen);
  const rootKey = rootKeyForPath(pathUcis);

  return {
    atomKey: atomIdentityKey(triggerEpd, subjectUci),
    triggerEpd,
    triggerFen,
    subjectUci,
    postTriggerUserToMoveEpd,
    postTriggerFen,
    subjectOrdinal: ordinal,
    depthHalfMoves: plyIndex + 1,
    color: projected.color,
    pathUcis,
    rootKey,
    receipts: [{
      gameId: projected.gameId,
      dayKey: projected.dayKey,
      createdAtMs: projected.createdAtMs,
      sourceBlock,
      pathUcis,
      rootKey,
      subjectOrdinal: ordinal,
      depthHalfMoves: plyIndex + 1,
    }],
  };
}

export function aggregateAtomSupport(atoms) {
  const buckets = new Map();
  for (const atom of atoms || []) {
    if (!atom?.triggerEpd || !atom?.subjectUci) continue;
    const key = formatAtomKey(atom);
    const bucket = buckets.get(key) || {
      atomKey: key,
      triggerEpd: atom.triggerEpd,
      triggerFen: atom.triggerFen,
      subjectUci: atom.subjectUci,
      postTriggerUserToMoveEpd: atom.postTriggerUserToMoveEpd,
      postTriggerFen: atom.postTriggerFen,
      color: atom.color,
      subjectOrdinals: [],
      depths: [],
      receiptsByGame: new Map(),
      displayPathMap: new Map(),
      rootKeys: new Set(),
    };
    bucket.subjectOrdinals.push(atom.subjectOrdinal);
    bucket.depths.push(atom.depthHalfMoves);
    for (const receipt of atom.receipts || []) {
      if (!receipt?.gameId) continue;
      const existing = bucket.receiptsByGame.get(String(receipt.gameId));
      if (existing && JSON.stringify(existing.pathUcis) !== JSON.stringify(receipt.pathUcis)) {
        throw new Error(`conflicting atom receipt for game ${receipt.gameId}`);
      }
      bucket.receiptsByGame.set(String(receipt.gameId), { ...receipt });
      const pathKey = (receipt.pathUcis || []).join(">");
      if (pathKey) bucket.displayPathMap.set(pathKey, [...receipt.pathUcis]);
      if (receipt.rootKey) bucket.rootKeys.add(receipt.rootKey);
    }
    buckets.set(key, bucket);
  }

  return [...buckets.values()].map((bucket) => {
    const receipts = [...bucket.receiptsByGame.values()].sort((a, b) => String(a.gameId).localeCompare(String(b.gameId)));
    const games = new Set(receipts.map((r) => r.gameId));
    const dates = new Set(receipts.map((r) => r.dayKey).filter(Boolean));
    const blocks = new Set(receipts.map((r) => r.sourceBlock).filter(Boolean));
    return {
      atomKey: bucket.atomKey,
      triggerEpd: bucket.triggerEpd,
      triggerFen: bucket.triggerFen,
      subjectUci: bucket.subjectUci,
      postTriggerUserToMoveEpd: bucket.postTriggerUserToMoveEpd,
      postTriggerFen: bucket.postTriggerFen,
      color: bucket.color,
      subjectOrdinal: Math.min(...bucket.subjectOrdinals),
      depthHalfMoves: Math.min(...bucket.depths),
      rootKeys: [...bucket.rootKeys].sort(),
      displayPaths: [...bucket.displayPathMap.values()].sort((a, b) => a.join(">").localeCompare(b.join(">"))),
      receipts,
      support: {
        distinctGames: games.size,
        distinctDates: dates.size,
        residualLooSupport: Math.max(0, games.size - 1),
        distinctSourceBlocks: blocks.size,
        gameIds: [...games].sort(),
        dayKeys: [...dates].sort(),
        sourceBlocks: [...blocks].sort(),
      },
    };
  }).sort((a, b) => a.atomKey.localeCompare(b.atomKey));
}

export function isAtomEligible(support, protocol = null) {
  return support?.distinctGames >= Number(protocol?.candidateSupport?.minDistinctGames ?? 3)
    && support?.distinctDates >= Number(protocol?.candidateSupport?.minDistinctDates ?? 2)
    && support?.residualLooSupport >= Number(protocol?.candidateSupport?.minResidualLooSupport ?? 2);
}

export function extractEligibleAtomsFromGames(games, {
  color,
  protocol = null,
  sourceBlock = "build",
} = {}) {
  const projected = (games || []).map(projectBuildGame);
  assertNoForbiddenCandidateFields(projected, { label: "projected build games" });
  const ordinals = protocol?.subjectMoveOrdinals || SHADOW_PREP_SUBJECT_MOVE_ORDINALS;
  const maxPlies = Number(protocol?.candidateSupport?.maxAtomHalfMoves ?? SHADOW_PREP_MAX_ATOM_PLIES);
  const raw = [];
  for (const game of projected) {
    if (game.color !== color || !game.perfEligible) continue;
    for (const ordinal of ordinals) {
      const atom = extractSubjectReplyAtomFromGame(game, { ordinal, maxPlies, sourceBlock, protocol });
      if (atom) raw.push(atom);
    }
  }
  return aggregateAtomSupport(raw).filter((atom) => isAtomEligible(atom.support, protocol));
}

export function computePackageTreeMetrics(atoms) {
  const repliesByTrigger = new Map();
  for (const atom of atoms || []) {
    const replies = repliesByTrigger.get(atom.triggerEpd) || new Set();
    replies.add(atom.subjectUci);
    repliesByTrigger.set(atom.triggerEpd, replies);
  }
  const sizes = [...repliesByTrigger.values()].map((set) => set.size);
  return {
    leafCount: atoms?.length || 0,
    forkCount: sizes.filter((size) => size > 1).length,
    maxRepliesPerFork: sizes.length ? Math.max(...sizes) : 0,
    onlyMoveCount: 0,
    conceptFamilies: [],
    style: null,
  };
}

function packageScore(atoms) {
  const support = atoms.map((atom) => atom.support.distinctGames);
  return {
    atomCount: atoms.length,
    ordinal3PlusCount: atoms.filter((atom) => atom.subjectOrdinal >= 3).length,
    minSupport: support.length ? Math.min(...support) : 0,
    totalSupport: support.reduce((sum, value) => sum + value, 0),
    medianDepth: median(atoms.map((atom) => atom.depthHalfMoves)),
    stableKey: atoms.map((atom) => atom.atomKey).sort().join(","),
  };
}

/** Positive means left is the preferred package. */
export function comparePackageLex(left, right) {
  const a = left?.score || packageScore(left?.atoms || []);
  const b = right?.score || packageScore(right?.atoms || []);
  for (const key of ["atomCount", "ordinal3PlusCount", "minSupport", "totalSupport", "medianDepth"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return String(b.stableKey).localeCompare(String(a.stableKey));
}

export function packageMeetsCandidateGates(atoms, protocol = null) {
  const target = Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? MEM_MAX_LEAVES);
  const minDeep = Number(protocol?.treatmentBudget?.minOrdinal3PlusAtoms ?? 3);
  if ((atoms || []).length !== target) return { ok: false, reason: "atom-count" };
  if (atoms.filter((atom) => atom.subjectOrdinal >= 3).length < minDeep) return { ok: false, reason: "ordinal-floor" };
  const rootKeys = new Set(atoms.map((atom) => atom.selectedRootKey));
  if (rootKeys.size !== 1 || rootKeys.has(undefined)) return { ok: false, reason: "root-coherence" };
  const tree = computePackageTreeMetrics(atoms);
  const budget = checkMemorabilityBudget(tree);
  if (!budget.ok) return { ok: false, reason: "tree-budget", tree, budget };
  return { ok: true, tree, budget };
}

function exactBestForRoot(componentAtoms, rootKey, protocol) {
  const target = Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? MEM_MAX_LEAVES);
  const maxForks = Number(protocol?.treatmentBudget?.maxForks ?? MEM_MAX_FORKS);
  const maxReplies = Number(protocol?.treatmentBudget?.maxRepliesPerFork ?? MEM_MAX_REPLIES_PER_FORK);
  const maxStates = Number(protocol?.candidateSelection?.maxSearchStates ?? 250_000);
  const atoms = (componentAtoms || [])
    .map((atom) => projectAtomForRoot(atom, rootKey, protocol))
    .filter(Boolean)
    .sort((a, b) => a.atomKey.localeCompare(b.atomKey));
  const byTrigger = new Map();
  for (const atom of atoms) {
    const rows = byTrigger.get(atom.triggerEpd) || [];
    rows.push(atom);
    byTrigger.set(atom.triggerEpd, rows);
  }

  function optionsFor(rows) {
    const options = [[]];
    for (const atom of rows) options.push([atom]);
    if (maxReplies >= 2) {
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) options.push([rows[i], rows[j]]);
      }
    }
    return options;
  }

  function stateKey(atomsInState, forks) {
    const keys = atomsInState.map((atom) => atom.atomKey).sort().join(",");
    return `${keys}|${forks}`;
  }

  let transitions = 0;
  let frontier = [{ atoms: [], forks: 0 }];
  for (const trigger of [...byTrigger.keys()].sort()) {
    const options = optionsFor(byTrigger.get(trigger));
    const next = new Map();
    for (const state of frontier) {
      for (const option of options) {
        transitions += 1;
        if (transitions > maxStates) {
          throw new Error(`candidate exact search exceeded maxSearchStates=${maxStates}`);
        }
        const count = state.atoms.length + option.length;
        const forks = state.forks + (option.length > 1 ? 1 : 0);
        if (count > target || forks > maxForks) continue;
        const candidate = { atoms: [...state.atoms, ...option], forks };
        const signature = stateKey(candidate.atoms, forks);
        if (!next.has(signature)) next.set(signature, candidate);
      }
    }
    frontier = [...next.values()];
  }

  let best = null;
  for (const state of frontier) {
    if (state.atoms.length !== target) continue;
    const candidate = {
      atoms: state.atoms,
      score: packageScore(state.atoms),
      rootKey,
      evidenceType: "candidate-personal",
    };
    const gate = packageMeetsCandidateGates(candidate.atoms, protocol);
    if (gate.ok && (!best || comparePackageLex(candidate, best) > 0)) {
      best = { ...candidate, tree: gate.tree, budget: gate.budget };
    }
  }
  return { best, visited: transitions };
}

export function selectCandidatePackage(eligibleAtoms, protocol = null) {
  const byRoot = new Map();
  for (const atom of eligibleAtoms || []) {
    for (const rootKey of atom.rootKeys || []) {
      if (!rootKey) continue;
      const rows = byRoot.get(rootKey) || [];
      rows.push(atom);
      byRoot.set(rootKey, rows);
    }
  }
  let best = null;
  const search = [];
  for (const rootKey of [...byRoot.keys()].sort()) {
    const component = byRoot.get(rootKey);
    if (component.length < Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? MEM_MAX_LEAVES)) continue;
    const result = exactBestForRoot(component, rootKey, protocol);
    search.push({ rootKey, eligibleAtoms: component.length, visited: result.visited });
    if (result.best && (!best || comparePackageLex(result.best, best) > 0)) best = result.best;
  }
  return best ? { ...best, searchDiagnostics: search } : null;
}

export function buildCandidatePackagesByColor(games, { protocol = null } = {}) {
  const projected = (games || []).map(projectBuildGame);
  assertNoForbiddenCandidateFields(projected, { label: "projected build games" });
  return Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [
    color,
    selectCandidatePackage(extractEligibleAtomsFromGames(projected, { color, protocol }), protocol),
  ]));
}

function atomFromV2Row(row, color) {
  let fullPath = Array.isArray(row?.ucis) ? [...row.ucis] : null;
  if (!fullPath?.length && Array.isArray(row?.prefixUcis) && row?.subjectUci) fullPath = [...row.prefixUcis, row.subjectUci];
  if (!fullPath?.length) return null;
  const subjectUci = row.subjectUci || fullPath.at(-1);
  if (fullPath.at(-1) !== subjectUci) fullPath.push(subjectUci);
  const triggerPath = fullPath.slice(0, -1);
  const triggerFen = normalizedFenFromUcis(triggerPath);
  if (!triggerFen) return null;
  const chess = new Chess(triggerFen);
  if (!safeMove(chess, subjectUci)) return null;
  return {
    atomKey: atomIdentityKey(epdOf(triggerFen), subjectUci),
    triggerEpd: epdOf(triggerFen),
    triggerFen,
    subjectUci,
    postTriggerUserToMoveEpd: epdOf(chess.fen()),
    postTriggerFen: chess.fen(),
    subjectOrdinal: Number(row.subjectOrdinal) || null,
    depthHalfMoves: fullPath.length,
    color,
    productionRank: Number(row.productionRank),
    evidenceType: "baseline-model",
    pathUcis: fullPath,
    rootKey: rootKeyForPath(fullPath),
    userResponseUci: row.userResponseUci || null,
  };
}

export function adaptV2BaselineRows(rows, { color, protocol = null } = {}) {
  const target = Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? MEM_MAX_LEAVES);
  const sorted = [...(rows || [])].filter((row) => Number.isFinite(Number(row?.productionRank)))
    .sort((a, b) => Number(a.productionRank) - Number(b.productionRank));
  const atoms = [];
  const seenAtoms = new Set();
  const yByPostEpd = new Map();
  const issues = [];
  for (const row of sorted) {
    if (atoms.length >= target) break;
    const atom = atomFromV2Row(row, color);
    if (!atom || seenAtoms.has(atom.atomKey)) continue;
    const priorY = yByPostEpd.get(atom.postTriggerUserToMoveEpd);
    if (priorY && atom.userResponseUci && priorY !== atom.userResponseUci) {
      issues.push({ kind: "conflicting-v2-y", productionRank: atom.productionRank });
      continue;
    }
    if (atom.userResponseUci) yByPostEpd.set(atom.postTriggerUserToMoveEpd, atom.userResponseUci);
    seenAtoms.add(atom.atomKey);
    atoms.push(atom);
  }
  return { atoms, evidenceType: "baseline-model", trimmedFrom: sorted.length, issues };
}

export function buildPinnedSharedEngineIdentity(protocol) {
  const y = protocol?.sharedYEngine || {};
  return buildEngineIdentity({
    stockfishSha256: y.stockfishSha256,
    uciIdName: y.uciIdName ?? null,
    uciIdAuthor: y.uciIdAuthor ?? null,
    depth: y.depth,
    multipv: y.multipv,
    threads: y.threads ?? 1,
    hashMb: y.hashMb ?? 16,
    maxPlies: y.maxPlies ?? SHADOW_PREP_MAX_ATOM_PLIES,
  });
}

export function validateSharedYReceipt(receipt, { postTriggerEpd, engineIdentity, protocol = null } = {}) {
  const errors = [];
  if (!receipt) return { ok: false, errors: ["missing receipt"] };
  if (!receipt.postTriggerFen) errors.push("missing postTriggerFen");
  if (receipt.postTriggerEpd !== postTriggerEpd) errors.push("post-trigger epd mismatch");
  if (!receipt.userResponseUci) errors.push("missing userResponseUci");
  if (!receipt.engineIdentity || !identitiesMatch(engineIdentity, receipt.engineIdentity)) errors.push("engine identity mismatch");
  if (receipt.safetyMeasured !== true) errors.push("safety not measured");
  if (receipt.safe !== true) errors.push("safety check failed");
  if (!Number.isFinite(receipt.evalSwingCp) || receipt.evalSwingCp < 0) {
    errors.push("missing measured evalSwingCp");
  }
  if (!Number.isFinite(receipt.bestScoreCp)) errors.push("missing bestScoreCp");
  if (!Number.isFinite(receipt.selectedScoreCp)) errors.push("missing selectedScoreCp");
  if (!Number.isFinite(receipt.multipvReturned) || receipt.multipvReturned < 1) {
    errors.push("missing multipvReturned");
  }
  const expectedDepth = Number(protocol?.sharedYEngine?.depth ?? 8);
  const expectedMultipv = Number(protocol?.sharedYEngine?.multipv ?? 5);
  if (Number(receipt.searchedDepth) !== expectedDepth) errors.push("searched depth mismatch");
  if (Number(receipt.searchedMultipv) !== expectedMultipv) errors.push("searched multipv mismatch");
  if (Number(receipt.selectedMultipv) !== 1) errors.push("selected multipv must be 1");
  if (receipt.postTriggerFen) {
    try {
      if (epdOf(receipt.postTriggerFen) !== receipt.postTriggerEpd) errors.push("post-trigger fen/epd mismatch");
      const chess = new Chess(receipt.postTriggerFen);
      if (!safeMove(chess, receipt.userResponseUci)) errors.push("illegal user response");
    } catch (_) {
      errors.push("invalid post-trigger fen");
    }
  }
  const maxSwing = Number(protocol?.sharedYEngine?.maxEvalSwingCp ?? 120);
  if (Number.isFinite(receipt.evalSwingCp) && receipt.evalSwingCp > maxSwing) errors.push("eval swing exceeds safety tolerance");
  if (receipt.selectedScore?.type === "mate" && !Number.isFinite(Number(receipt.selectedScore?.value))) {
    errors.push("invalid mate score");
  }
  return { ok: errors.length === 0, errors };
}

/** Build one measured shared-Y receipt from protocol-pinned Stockfish MultiPV search. */
export async function buildSharedYReceiptForAtom(atom, sf, protocol, engineIdentity) {
  const depth = Number(protocol?.sharedYEngine?.depth ?? 8);
  const multipv = Number(protocol?.sharedYEngine?.multipv ?? 5);
  const maxSwing = Number(protocol?.sharedYEngine?.maxEvalSwingCp ?? 120);
  const fen = atom?.postTriggerFen;
  const epd = atom?.postTriggerUserToMoveEpd;
  if (!fen || !epd) throw new Error("atom missing post-trigger geometry");

  const lines = await sf.topMoves(fen, depth, multipv);
  if (!lines.length) throw new Error(`stockfish returned no multipv lines for ${epd}`);
  const pv1 = lines.find((row) => row.multipv === 1);
  if (!pv1) throw new Error(`missing multipv=1 line for ${epd}`);
  if (!pv1.pv?.length) throw new Error(`empty PV1 for ${epd}`);
  if (pv1.score?.type === "mate" && !Number.isFinite(Number(pv1.score.value))) {
    throw new Error(`invalid mate score for ${epd}`);
  }

  const selectedUci = pv1.pv[0];
  const chess = new Chess(fen);
  if (!safeMove(chess, selectedUci)) throw new Error(`illegal PV1 move ${selectedUci} at ${epd}`);
  if (epdOf(fen) !== epd) throw new Error(`post-trigger fen/epd mismatch for ${epd}`);

  const sideToMove = fen.split(" ")[1] === "b" ? "black" : "white";
  const bestScoreCp = scoreToWhiteCp(pv1.score, sideToMove);
  if (!Number.isFinite(bestScoreCp)) throw new Error(`cannot score PV1 for ${epd}`);
  const selectedScoreCp = bestScoreCp;
  const evalSwingCp = Math.abs(selectedScoreCp - bestScoreCp);
  if (!Number.isFinite(evalSwingCp) || evalSwingCp < 0) {
    throw new Error(`invalid eval swing for ${epd}`);
  }
  const multipvEvidence = [...lines]
    .sort((a, b) => Number(a.multipv) - Number(b.multipv))
    .map((row) => ({
      multipv: row.multipv,
      score: row.score,
      scoreCp: scoreToWhiteCp(row.score, sideToMove),
      pvFirstMove: row.pv?.[0] ?? null,
    }));

  const receipt = {
    postTriggerEpd: epd,
    postTriggerFen: fen,
    userResponseUci: selectedUci,
    safe: evalSwingCp <= maxSwing,
    safetyMeasured: true,
    source: "stockfish",
    evalSwingCp,
    bestScoreCp,
    selectedScoreCp,
    multipvReturned: lines.length,
    multipvEvidence,
    searchedDepth: depth,
    searchedMultipv: multipv,
    selectedMultipv: 1,
    selectedPv: [...pv1.pv],
    selectedScore: pv1.score,
    engineIdentity,
    engineIdentityKey: engineIdentityKey(engineIdentity),
  };
  return receipt;
}

export function attachSharedYToPackages(packagesByColor, yReceiptsByColor, { protocol = null } = {}) {
  const engineIdentity = buildPinnedSharedEngineIdentity(protocol);
  const issues = [];
  const attached = {};
  const globalY = new Map();
  for (const color of SHADOW_PREP_COLORS) {
    const receipts = yReceiptsByColor?.[color] || [];
    const byEpd = new Map();
    for (const receipt of receipts) {
      const prior = byEpd.get(receipt.postTriggerEpd);
      if (prior && prior.userResponseUci !== receipt.userResponseUci) {
        issues.push({ color, kind: "conflicting-y-receipts", postTriggerEpd: receipt.postTriggerEpd });
        continue;
      }
      byEpd.set(receipt.postTriggerEpd, receipt);
    }
    const atoms = [];
    for (const atom of packagesByColor?.[color]?.atoms || []) {
      const receipt = byEpd.get(atom.postTriggerUserToMoveEpd);
      const check = validateSharedYReceipt(receipt, { postTriggerEpd: atom.postTriggerUserToMoveEpd, engineIdentity, protocol });
      if (!check.ok) {
        issues.push({ color, atomKey: atom.atomKey, errors: check.errors });
        continue;
      }
      const prior = globalY.get(atom.postTriggerUserToMoveEpd);
      if (prior && prior !== receipt.userResponseUci) {
        issues.push({ color, atomKey: atom.atomKey, errors: ["conflicting shared Y at identical EPD"] });
        continue;
      }
      globalY.set(atom.postTriggerUserToMoveEpd, receipt.userResponseUci);
      atoms.push({
        ...atom,
        userResponseUci: receipt.userResponseUci,
        sharedYReceipt: { ...receipt, engineIdentityKey: engineIdentityKey(engineIdentity) },
      });
    }
    attached[color] = { ...packagesByColor?.[color], atoms, engineIdentity };
  }
  return { packages: attached, issues, ok: issues.length === 0, engineIdentity };
}

export function buildCanonicalStudyUnit(atom, { extraText = "" } = {}) {
  if (!atom?.userResponseUci || !atom?.sharedYReceipt?.engineIdentityKey) {
    throw new Error("canonical study unit requires attached shared Y evidence");
  }
  if (!atom?.triggerFen) throw new Error("canonical study unit requires trigger FEN for SAN");
  const subjectSan = uciToSanStrict(atom.triggerFen, atom.subjectUci);
  const responseSan = uciToSanStrict(atom.postTriggerFen, atom.userResponseUci);
  const sanLine = `${subjectSan} ${responseSan}`.trim();
  const unit = {
    triggerEpd: atom.triggerEpd,
    subjectUci: atom.subjectUci,
    postTriggerEpd: atom.postTriggerUserToMoveEpd,
    userResponseUci: atom.userResponseUci,
    sanLine,
    diagramCount: 1,
    textCharCount: sanLine.length + String(extraText || "").length,
    engineIdentityKey: atom.sharedYReceipt.engineIdentityKey,
    ySource: atom.sharedYReceipt.source || "stockfish",
  };
  return unit;
}

export function buildCanonicalStudyMaterials(pkg, { textByAtomKey = {} } = {}) {
  return (pkg?.atoms || []).map((atom) => buildCanonicalStudyUnit(atom, {
    extraText: textByAtomKey[atom.atomKey],
  }));
}

/** Recompute canonical materials and budget checks from frozen packages with attached shared Y. */
export function recomputeMaterialChecks(attachedPackages, protocol = null) {
  const checks = {};
  for (const color of SHADOW_PREP_COLORS) {
    const candUnits = buildCanonicalStudyMaterials(attachedPackages?.candidate?.[color] || { atoms: [] });
    const baseUnits = buildCanonicalStudyMaterials(attachedPackages?.baseline?.[color] || { atoms: [] });
    checks[color] = compareMaterialBudget(candUnits, baseUnits, protocol);
  }
  return checks;
}

export function compareMaterialBudget(candidateUnits, baselineUnits, protocol = null) {
  const errors = [];
  const target = Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? MEM_MAX_LEAVES);
  const tolerance = Number(protocol?.materialBudget?.textSanCharTolerance ?? 24);
  for (const [label, units] of [["candidate", candidateUnits], ["baseline", baselineUnits]]) {
    if ((units || []).length !== target) errors.push(`${label} atom count mismatch`);
    for (const unit of units || []) {
      const keys = Object.keys(unit).sort();
      const expected = [...CANONICAL_STUDY_UNIT_FIELDS].sort();
      if (JSON.stringify(keys) !== JSON.stringify(expected)) errors.push(`${label} noncanonical fields`);
      if (!unit.userResponseUci || unit.diagramCount !== 1 || !unit.engineIdentityKey) errors.push(`${label} incomplete study unit`);
    }
  }
  const candDiagrams = (candidateUnits || []).reduce((sum, row) => sum + row.diagramCount, 0);
  const baseDiagrams = (baselineUnits || []).reduce((sum, row) => sum + row.diagramCount, 0);
  if (candDiagrams !== baseDiagrams) errors.push("diagram count mismatch");
  const candText = (candidateUnits || []).reduce((sum, row) => sum + row.textCharCount, 0);
  const baseText = (baselineUnits || []).reduce((sum, row) => sum + row.textCharCount, 0);
  if (Math.abs(candText - baseText) > tolerance) errors.push("text/san budget mismatch");
  const engineKeys = new Set([...(candidateUnits || []), ...(baselineUnits || [])].map((row) => row.engineIdentityKey));
  const sources = new Set([...(candidateUnits || []), ...(baselineUnits || [])].map((row) => row.ySource));
  if (engineKeys.size !== 1) errors.push("engine identity mismatch across arms");
  if (sources.size !== 1) errors.push("Y source shape mismatch across arms");
  return { ok: errors.length === 0, errors, candidateText: candText, baselineText: baseText };
}

export function treatmentAtomJaccard(candidateAtoms, baselineAtoms) {
  const a = new Set((candidateAtoms || []).map((atom) => atom.atomKey));
  const b = new Set((baselineAtoms || []).map((atom) => atom.atomKey));
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const key of a) if (b.has(key)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

function frozenAtomIndex(frozenPackages) {
  const index = new Map();
  for (const arm of ["candidate", "baseline"]) {
    for (const color of SHADOW_PREP_COLORS) {
      for (const atom of frozenPackages?.[arm]?.[color]?.atoms || []) index.set(atom.atomKey, atom);
    }
  }
  return index;
}

export function buildPilotStimulusStream(frozenPackages, burnedBlocks = [], { protocol = null } = {}) {
  const atomIndex = frozenAtomIndex(frozenPackages);
  const order = protocol?.pilotStimulusPartition?.chronology || SHADOW_PREP_PILOT_SOURCE_ORDER;
  const events = [];
  const seen = new Set();
  const blocks = [...burnedBlocks].sort((a, b) => order.indexOf(a.sourceBlock) - order.indexOf(b.sourceBlock));
  for (const block of blocks) {
    for (const rawGame of block.games || []) {
      const game = projectStimulusGame(rawGame, { sourceBlock: block.sourceBlock });
      if (!game.color || !game.perfEligible) continue;
      for (const ordinal of protocol?.subjectMoveOrdinals || SHADOW_PREP_SUBJECT_MOVE_ORDINALS) {
        const atom = extractSubjectReplyAtomFromGame(game, {
          ordinal,
          maxPlies: Number(protocol?.candidateSupport?.maxAtomHalfMoves ?? SHADOW_PREP_MAX_ATOM_PLIES),
          sourceBlock: block.sourceBlock,
          protocol,
        });
        if (!atom || !atomIndex.has(atom.atomKey)) continue;
        const key = `${game.gameId}|${atom.atomKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({
          atomKey: atom.atomKey,
          color: game.color,
          subjectOrdinal: atom.subjectOrdinal,
          depthHalfMoves: atom.depthHalfMoves,
          gameId: game.gameId,
          dayKey: game.dayKey,
          sourceBlock: block.sourceBlock,
        });
      }
    }
  }
  events.sort((a, b) => order.indexOf(a.sourceBlock) - order.indexOf(b.sourceBlock)
    || String(a.gameId).localeCompare(String(b.gameId)) || a.atomKey.localeCompare(b.atomKey));
  return { events, diagnostics: summarizeStimulus(events, order) };
}

function stimulusSummaryFor(events) {
  return {
    totalEvents: events.length,
    ordinal3PlusEvents: events.filter((event) => event.subjectOrdinal >= 3).length,
    distinctTriggerAtoms: new Set(events.map((event) => event.atomKey)).size,
  };
}

export function summarizeStimulus(events, sourceOrder = SHADOW_PREP_PILOT_SOURCE_ORDER) {
  const byColor = Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [color, stimulusSummaryFor(events.filter((event) => event.color === color))]));
  const bySourceBlock = Object.fromEntries(sourceOrder.map((source) => [source, events.filter((event) => event.sourceBlock === source).length]));
  const leaveOneSourceBlockOut = {};
  for (const source of sourceOrder) {
    const remaining = events.filter((event) => event.sourceBlock !== source);
    leaveOneSourceBlockOut[source] = {
      byColor: Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [color, stimulusSummaryFor(remaining.filter((event) => event.color === color))])),
    };
  }
  return {
    ...stimulusSummaryFor(events),
    byColor,
    bySourceBlock,
    leaveOneSourceBlockOut,
    withoutOrdinal2: Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [
      color,
      stimulusSummaryFor(events.filter((event) => event.color === color && event.subjectOrdinal >= 3)),
    ])),
  };
}

export function evaluateInfluenceGates(packageByColor, protocol = null) {
  const minResidual = Number(protocol?.candidateSupport?.minResidualLooSupport ?? 2);
  const issues = [];
  for (const color of SHADOW_PREP_COLORS) {
    for (const atom of packageByColor?.[color]?.atoms || []) {
      for (const gameId of atom.support.gameIds || []) {
        const remaining = new Set(atom.receipts.filter((receipt) => receipt.gameId !== gameId).map((receipt) => receipt.gameId));
        if (remaining.size < minResidual) issues.push({ color, atomKey: atom.atomKey, kind: "leave-one-game", gameId });
      }
      for (const dayKey of atom.support.dayKeys || []) {
        const remainingGames = new Set(
          atom.receipts
            .filter((receipt) => receipt.dayKey !== dayKey)
            .map((receipt) => receipt.gameId),
        );
        if (remainingGames.size < minResidual) {
          issues.push({
            color,
            atomKey: atom.atomKey,
            kind: "leave-one-date",
            dayKey,
            remainingGames: remainingGames.size,
          });
        }
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function stimulusMeetsColorGates(summary, protocol) {
  return summary.totalEvents >= Number(protocol?.p0Gates?.minPilotTrialEvents ?? 24)
    && summary.ordinal3PlusEvents >= Number(protocol?.p0Gates?.minPilotOrdinal3PlusEvents ?? 8)
    && summary.distinctTriggerAtoms >= Number(protocol?.p0Gates?.minDistinctTriggerAtoms ?? 4);
}

export function evaluateStimulusInfluence(stimulus, protocol = null) {
  const issues = [];
  const diagnostics = stimulus?.diagnostics || {};
  for (const color of SHADOW_PREP_COLORS) {
    if (!stimulusMeetsColorGates(diagnostics.byColor?.[color] || {}, protocol)) issues.push({ color, kind: "color-stimulus-thin" });
    const deep = diagnostics.withoutOrdinal2?.[color] || {};
    if ((deep.ordinal3PlusEvents || 0) < Number(protocol?.p0Gates?.minPilotOrdinal3PlusEvents ?? 8)) {
      issues.push({ color, kind: "shallow-dominance" });
    }
    for (const source of protocol?.pilotStimulusPartition?.chronology || SHADOW_PREP_PILOT_SOURCE_ORDER) {
      const remaining = diagnostics.leaveOneSourceBlockOut?.[source]?.byColor?.[color] || {};
      if (!stimulusMeetsColorGates(remaining, protocol)) issues.push({ color, sourceBlock: source, kind: "leave-one-source-block" });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function resolveShadowPrepVerdict({
  candidatePackages = {}, baselinePackages = {}, materialChecks = {}, stimulus = null,
  influence = null, stimulusInfluence = null, protocol = null,
} = {}) {
  const target = Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? MEM_MAX_LEAVES);
  for (const color of SHADOW_PREP_COLORS) {
    if (candidatePackages[color]?.atoms?.length !== target || !packageMeetsCandidateGates(candidatePackages[color].atoms, protocol).ok) {
      return SHADOW_PREP_VERDICTS.INSUFFICIENT_CANDIDATE_SUPPORT;
    }
  }
  const candidateInfluence = (influence && typeof influence.ok === "boolean")
    ? influence
    : evaluateInfluenceGates(candidatePackages, protocol);
  if (!candidateInfluence?.ok) return SHADOW_PREP_VERDICTS.INSUFFICIENT_CANDIDATE_SUPPORT;
  for (const color of SHADOW_PREP_COLORS) {
    if (baselinePackages[color]?.atoms?.length !== target) return SHADOW_PREP_VERDICTS.BASELINE_BUILD_FAILED;
    if (!materialChecks[color]?.ok) return SHADOW_PREP_VERDICTS.BUDGET_UNMATCHABLE;
    if (treatmentAtomJaccard(candidatePackages[color].atoms, baselinePackages[color].atoms)
      >= Number(protocol?.p0Gates?.maxTreatmentAtomJaccard ?? 0.8)) {
      return SHADOW_PREP_VERDICTS.INSUFFICIENT_TREATMENT_DISTINCTNESS;
    }
  }
  const stimInfluence = stimulusInfluence || evaluateStimulusInfluence(stimulus, protocol);
  if (!stimInfluence.ok) return SHADOW_PREP_VERDICTS.INSUFFICIENT_PILOT_STIMULI;
  return SHADOW_PREP_VERDICTS.MATERIALS_FEASIBLE;
}

export function buildShadowPrepReport({
  protocol, candidatePackages = {}, baselinePackages = {}, materialChecks = {}, stimulus = null,
  influence = null, stimulusInfluence = null, frozenAt = "1970-01-01T00:00:00.000Z",
} = {}) {
  const influenceDiagnostics = (influence && typeof influence.ok === "boolean")
    ? influence
    : evaluateInfluenceGates(candidatePackages, protocol);
  const stimulusInfluenceDiagnostics = (stimulusInfluence && typeof stimulusInfluence.ok === "boolean")
    ? stimulusInfluence
    : evaluateStimulusInfluence(stimulus, protocol);
  const verdict = resolveShadowPrepVerdict({
    candidatePackages,
    baselinePackages,
    materialChecks,
    stimulus,
    influence: influenceDiagnostics,
    stimulusInfluence: stimulusInfluenceDiagnostics,
    protocol,
  });
  const report = {
    kind: SHADOW_PREP_REPORT_KIND,
    version: SHADOW_PREP_REPORT_VERSION,
    protocolId: protocol?.protocolId || SHADOW_PREP_PROTOCOL_ID,
    protocolSha256: protocol?.protocolSha256 ?? null,
    phase: "P0",
    productAuthorization: false,
    cannotAuthorizeCards: true,
    cannotAuthorizeHumanStudy: true,
    productVerdict: "preserve-v2",
    nextWorkRequiresNewPreregistration: true,
    establishesOnly: protocol?.claimBoundary?.establishes,
    claimBoundary: protocol?.claimBoundary,
    forbiddenClaims: protocol?.forbiddenClaims,
    verdict,
    evidenceBoundary: {
      candidatePersonal: "score-free D0 EPD+subject-UCI receipts only",
      baselineModel: "production-v2 baseline/model evidence only",
      pilotStimulus: "burned H-M1/H-R1/legacy feasibility stimuli only",
    },
    overlapsByColor: Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [
      color, treatmentAtomJaccard(candidatePackages[color]?.atoms, baselinePackages[color]?.atoms),
    ])),
    candidatePackageCounts: Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [color, candidatePackages[color]?.atoms?.length || 0])),
    baselinePackageCounts: Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [color, baselinePackages[color]?.atoms?.length || 0])),
    materialChecks,
    stimulusDiagnostics: stimulus?.diagnostics || null,
    influenceDiagnostics,
    stimulusInfluenceDiagnostics,
    createdAt: frozenAt,
    singleCensusOnly: true,
    immutableAfterReport: true,
  };
  const validation = validateShadowPrepReport(report, { protocol });
  if (!validation.ok) throw new Error(`invalid SHADOW-PREP report: ${validation.errors.join("; ")}`);
  return report;
}

export function verifyPilotStimulusPartition(protocol) {
  const errors = [];
  const chronology = protocol?.pilotStimulusPartition?.chronology || [];
  if (chronology.join(",") !== SHADOW_PREP_PILOT_SOURCE_ORDER.join(",")) errors.push("pilot chronology must be h-m1,h-r1,legacy");
  const artifacts = protocol?.frozenArtifacts || {};
  const expected = {
    legacyGames: ["tmp/foe.json", "f8e35f04c138094ad2d661b7c14813fd74a34aec42011ae8e3a71080f9fa943a", 203],
    hM1Games: ["tmp/scout-v15-study/ericrosen-v15-historical-m1/frozen/h-m1/games.json", "9e5977bf22f8c9b67010000f3f06b0aae795e339c6f0db572415d2466b398ce2", 449],
    hM1Manifest: ["tmp/scout-v15-study/ericrosen-v15-historical-m1/frozen/h-m1/manifest.json", "9719893468e7fb2415d84f3b4b36dcdd721c6116c30801810c6665a043884b5a", 449],
    hR1Games: ["tmp/scout-v15-study/ericrosen-v15-historical-r1/frozen/h-r1/games.json", "f351c59518a585916624be04b965cccc9d706152912a768dfd623c46c69486a4", 446],
    hR1Manifest: ["tmp/scout-v15-study/ericrosen-v15-historical-r1/frozen/h-r1/manifest.json", "93c4ddf8c7df22350fb739d89a42873049a3711d007be8da12295bf449254979", 446],
  };
  for (const [key, [path, sha, count]] of Object.entries(expected)) {
    const row = artifacts[key] || {};
    if (row.relativePath !== path) errors.push(`${key} path mismatch`);
    if (row.sha256 !== sha) errors.push(`${key} sha mismatch`);
    if (Number(row.gameCount) !== count) errors.push(`${key} count mismatch`);
  }
  if (Number(artifacts.burnedUnion?.gameCount) !== 1098) errors.push("burned union count mismatch");
  return { ok: errors.length === 0, errors };
}

export function validateShadowPrepProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== SHADOW_PREP_PROTOCOL_KIND) errors.push("invalid kind");
  if (protocol?.protocolId !== SHADOW_PREP_PROTOCOL_ID) errors.push("invalid protocolId");
  if (protocol?.phase !== "P0" || protocol?.role !== "non-product-materials-gate") errors.push("invalid phase/role");
  if (protocol?.productAuthorization !== false) errors.push("productAuthorization must be false");
  if (protocol?.cannotAuthorizeCards !== true) errors.push("cannotAuthorizeCards must be true");
  if (protocol?.cannotAuthorizeHumanStudy !== true) errors.push("cannotAuthorizeHumanStudy must be true");
  if (protocol?.productVerdict !== "preserve-v2") errors.push("productVerdict must preserve v2");
  if (protocol?.nextWorkRequiresNewPreregistration !== true) errors.push("next work must require preregistration");
  if (protocol?.subject?.lichessUsername !== SHADOW_PREP_SUBJECT_USERNAME) errors.push("invalid subject");
  if ((protocol?.subjectMoveOrdinals || []).join(",") !== SHADOW_PREP_SUBJECT_MOVE_ORDINALS.join(",")) errors.push("invalid ordinals");
  errors.push(...verifyPilotStimulusPartition(protocol).errors);
  if (protocol?.sharedYEngine?.depth !== 8 || protocol?.sharedYEngine?.multipv !== 5 || !protocol?.sharedYEngine?.stockfishSha256) errors.push("invalid shared engine pin");
  if (protocol?.protocolSha256 && sha256ShadowPrepProtocol(protocol) !== protocol.protocolSha256) errors.push("protocolSha256 mismatch");
  const verdictKeys = Object.keys(protocol?.verdicts || {});
  if (verdictKeys.length !== Object.values(SHADOW_PREP_VERDICTS).length
    || verdictKeys.some((key) => !Object.values(SHADOW_PREP_VERDICTS).includes(key))) errors.push("invalid verdict map");
  return { ok: errors.length === 0, errors, protocolSha256: protocol?.protocolSha256 ?? null };
}

export function validateShadowPrepReport(report, { protocol = null } = {}) {
  const errors = [];
  if (report?.kind !== SHADOW_PREP_REPORT_KIND || report?.version !== SHADOW_PREP_REPORT_VERSION) errors.push("invalid report identity");
  if (report?.productAuthorization !== false || report?.cannotAuthorizeCards !== true
    || report?.cannotAuthorizeHumanStudy !== true || report?.productVerdict !== "preserve-v2") errors.push("invalid authorization flags");
  if (report?.nextWorkRequiresNewPreregistration !== true) errors.push("next work not locked");
  if (protocol?.protocolSha256 && report?.protocolSha256 !== protocol.protocolSha256) errors.push("report protocol hash mismatch");
  if (!Object.values(SHADOW_PREP_VERDICTS).includes(report?.verdict)) errors.push("invalid verdict");
  const hits = scanForbiddenFields(report, { forbiddenKeys: SHADOW_PREP_FORBIDDEN_REPORT_KEYS });
  if (hits.length) errors.push(`forbidden report fields: ${hits.join(", ")}`);
  return { ok: errors.length === 0, errors };
}

export function verifyShadowPrepProtocolIdentity(protocol, { snapshotProtocolSha256 = null } = {}) {
  const canonicalSha256 = sha256ShadowPrepProtocol(protocol);
  const issues = [];
  if (protocol?.protocolSha256 && protocol.protocolSha256 !== canonicalSha256) issues.push({ kind: "embedded-protocol-sha-mismatch" });
  if (snapshotProtocolSha256 && canonicalSha256 !== snapshotProtocolSha256) issues.push({ kind: "protocol-sha-mismatch" });
  return { ok: issues.length === 0, issues, canonicalSha256 };
}

function descriptorSha(descriptor) {
  if (descriptor?.sha256) return String(descriptor.sha256).toLowerCase();
  if (typeof descriptor?.content === "string") return sha256Hex(descriptor.content);
  return null;
}

function idsFromSource(source) {
  const data = source?.data ?? source?.content;
  if (Array.isArray(data)) return data.map((row) => String(row?.gameId ?? row?.id ?? "")).filter(Boolean);
  if (data && Array.isArray(data.gameIds)) return data.gameIds.map(String);
  return [];
}

/** Pure verifier; the CLI owns file reads and passes descriptors/content here. */
export function verifyShadowPrepPinnedSources(protocol, { sources = {} } = {}) {
  const issues = [];
  const pins = [
    ["d0CorpusGames", protocol?.buildPartition?.refDfCorpusGames],
    ["d0CorpusManifest", protocol?.buildPartition?.refDfCorpusManifest],
    ["d0CensusReport", protocol?.buildPartition?.refDfCensusReport],
    ["legacyGames", protocol?.frozenArtifacts?.legacyGames],
    ["hM1Games", protocol?.frozenArtifacts?.hM1Games],
    ["hM1Manifest", protocol?.frozenArtifacts?.hM1Manifest],
    ["hR1Games", protocol?.frozenArtifacts?.hR1Games],
    ["hR1Manifest", protocol?.frozenArtifacts?.hR1Manifest],
    ["maiaManifest", protocol?.baselineEvidence?.maiaManifest],
  ];
  for (const [name, pin] of pins) {
    const source = sources[name];
    if (!source) {
      issues.push({ kind: "missing-source", source: name });
      continue;
    }
    if (pin?.sha256 && descriptorSha(source) !== String(pin.sha256).toLowerCase()) issues.push({ kind: "source-sha-mismatch", source: name });
    const ids = idsFromSource(source);
    if (pin?.gameCount != null && ids.length && ids.length !== Number(pin.gameCount)) issues.push({ kind: "source-count-mismatch", source: name });
  }
  const refDf = sources.refDfProtocol;
  if (!refDf) issues.push({ kind: "missing-source", source: "refDfProtocol" });
  else {
    const parsed = typeof refDf.content === "string" ? JSON.parse(refDf.content) : refDf.data ?? refDf.content;
    if (sha256RefDfProtocol(parsed) !== protocol?.buildPartition?.refDfProtocol?.protocolSha256) issues.push({ kind: "ref-df-protocol-sha-mismatch" });
  }
  const legacyIds = idsFromSource(sources.legacyGames);
  const hm1Ids = idsFromSource(sources.hM1Manifest);
  const hr1Ids = idsFromSource(sources.hR1Manifest);
  const d0Ids = idsFromSource(sources.d0CorpusGames);
  const union = new Set([...legacyIds, ...hm1Ids, ...hr1Ids]);
  if (legacyIds.length + hm1Ids.length + hr1Ids.length !== union.size) issues.push({ kind: "stimulus-id-overlap" });
  if (union.size && union.size !== Number(protocol?.frozenArtifacts?.burnedUnion?.gameCount)) issues.push({ kind: "burned-union-count-mismatch" });
  const d0BurnedOverlap = d0Ids.filter((id) => union.has(id));
  if (d0BurnedOverlap.length) {
    issues.push({ kind: "d0-burned-overlap", count: d0BurnedOverlap.length, sample: d0BurnedOverlap.slice(0, 3) });
  }
  return { ok: issues.length === 0, issues, burnedUnionIds: [...union].sort(), d0BurnedOverlap };
}

export function canTransitionShadowPrepState(from, to) {
  return SHADOW_PREP_STATE_TRANSITIONS[from]?.includes(to) === true;
}
export function assertShadowPrepStateTransition(from, to) {
  if (!canTransitionShadowPrepState(from, to)) throw new Error(`illegal SHADOW-PREP transition: ${from} -> ${to}`);
}
export function refusesShadowPrepTopUp(state) {
  return state === SHADOW_PREP_STATES.CENSUS_COMPLETE || state === SHADOW_PREP_STATES.VERIFIED;
}
export function refusesShadowPrepReplay(state) {
  return state === SHADOW_PREP_STATES.CENSUS_COMPLETE || state === SHADOW_PREP_STATES.VERIFIED;
}
export function refusesShadowPrepRebuild(state) {
  return [SHADOW_PREP_STATES.BUILT, SHADOW_PREP_STATES.CENSUS_COMPLETE, SHADOW_PREP_STATES.VERIFIED].includes(state);
}
export function resolveShadowPrepPostBuildState({ currentState } = {}) {
  return currentState === SHADOW_PREP_STATES.BUILDING
    ? { state: SHADOW_PREP_STATES.BUILT, eventType: "build-complete" }
    : { state: currentState, eventType: null };
}
export function resolveShadowPrepPostCensusState({ currentState } = {}) {
  return currentState === SHADOW_PREP_STATES.BUILT
    ? { state: SHADOW_PREP_STATES.CENSUS_COMPLETE, eventType: "census-complete" }
    : { state: currentState, eventType: null };
}

export function verifyShadowPrepArtifacts({
  state, protocol, snapshotProtocolSha256 = null, censusReport = null, events = [],
  buildUsedStimulus = false,
} = {}) {
  const issues = [];
  const validation = validateShadowPrepProtocol(protocol);
  if (!validation.ok) issues.push({ kind: "invalid-protocol", errors: validation.errors });
  const identity = verifyShadowPrepProtocolIdentity(protocol, { snapshotProtocolSha256 });
  if (!identity.ok) issues.push(...identity.issues);
  if (buildUsedStimulus) issues.push({ kind: "build-stimulus-contamination" });
  if (events.filter((event) => event.type === "census").length > 1) issues.push({ kind: "census-replay-forbidden" });
  if ([SHADOW_PREP_STATES.CENSUS_COMPLETE, SHADOW_PREP_STATES.VERIFIED].includes(state)) {
    if (!censusReport) issues.push({ kind: "missing-census-report" });
    else {
      const report = validateShadowPrepReport(censusReport, { protocol });
      if (!report.ok) issues.push({ kind: "invalid-census-report", errors: report.errors });
    }
  }
  return { ok: issues.length === 0, issues, validation, canonicalSha256: identity.canonicalSha256 };
}
