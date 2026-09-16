// Scout SHADOW-PREP exact solver — burned-D0 algorithm development only (pure core).
// Reuses sealed P0 projection/gates/objective; no filesystem, network, DOM, or engine access.

import {
  MEM_MAX_FORKS,
  MEM_MAX_LEAVES,
  MEM_MAX_REPLIES_PER_FORK,
} from "./scout-v13-style.js";
import { sha256Hex } from "./scout-v15-study.js";
import {
  packageMeetsCandidateGates,
  projectAtomForRoot,
} from "./scout-shadow-prep-p0.js";

export const SHADOW_PREP_SOLVER_DEV_PROTOCOL_KIND = "scout-shadow-prep-solver-dev-protocol";
export const SHADOW_PREP_SOLVER_DEV_PROTOCOL_ID = "ericrosen-shadow-prep-solver-dev";
export const SHADOW_PREP_SOLVER_DEV_REPORT_KIND = "scout-shadow-prep-solver-dev-report";
export const SHADOW_PREP_SOLVER_DEV_REPORT_VERSION = 1;

export const EXACT_SOLVER_STATUSES = Object.freeze({
  OPTIMAL: "OPTIMAL",
  INFEASIBLE: "INFEASIBLE",
  RESOURCE_EXHAUSTED: "RESOURCE_EXHAUSTED",
  INVALID_INPUT: "INVALID_INPUT",
});

const LOCKED_LEX_OBJECTIVE = Object.freeze([
  "atomCount",
  "ordinal3PlusCount",
  "minSupport",
  "totalSupport",
  "medianDepth",
  "stableKey",
]);

const POSITIVE_CAP_FIELDS = Object.freeze([
  "maxTransitionsPerRoot",
  "maxStatesPerStage",
  "maxSupportPasses",
  "maxRoots",
]);

function median(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function packageScore(atoms) {
  const support = (atoms || []).map((atom) => atom.support.distinctGames);
  return {
    atomCount: atoms.length,
    ordinal3PlusCount: atoms.filter((atom) => atom.subjectOrdinal >= 3).length,
    minSupport: support.length ? Math.min(...support) : 0,
    totalSupport: support.reduce((sum, value) => sum + value, 0),
    medianDepth: median(atoms.map((atom) => atom.depthHalfMoves)),
    stableKey: atoms.map((atom) => atom.atomKey).sort().join(","),
  };
}

/** Stage-C tie-break after fixed deep count and minSupport: maximize totalSupport, minimize medianDepth, smallest stableKey. */
export function compareWitnessStageC(left, right) {
  if (left.totalSupport !== right.totalSupport) return left.totalSupport - right.totalSupport;
  if (left.medianDepth !== right.medianDepth) return right.medianDepth - left.medianDepth;
  return String(right.stableKey).localeCompare(String(left.stableKey));
}

/** Full solver-dev package comparator: positive => left preferred. */
export function comparePackageSolverDev(left, right) {
  const a = left?.score || packageScore(left?.atoms || []);
  const b = right?.score || packageScore(right?.atoms || []);
  for (const key of ["atomCount", "ordinal3PlusCount", "minSupport", "totalSupport"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return compareWitnessStageC(
    { totalSupport: a.totalSupport, medianDepth: a.medianDepth, stableKey: a.stableKey },
    { totalSupport: b.totalSupport, medianDepth: b.medianDepth, stableKey: b.stableKey },
  );
}

function countProjectedEligibleForRoot(componentAtoms, rootKey, protocol) {
  let count = 0;
  for (const atom of componentAtoms) {
    if (projectAtomForRoot(atom, rootKey, protocol)) count += 1;
  }
  return count;
}

export function sha256SolverDevProtocol(protocol) {
  const canonical = { ...(protocol || {}) };
  delete canonical.protocolSha256;
  return sha256Hex(`${JSON.stringify(canonical, null, 2)}\n`);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function validateEligibleAtom(atom, index = 0) {
  const errors = [];
  if (atom == null || typeof atom !== "object") {
    errors.push(`atom[${index}] must be an object`);
    return { ok: false, errors };
  }
  if (typeof atom.atomKey !== "string" || !atom.atomKey) {
    errors.push(`atom[${index}] atomKey must be a non-empty string`);
  }
  if (!Array.isArray(atom.rootKeys) || !atom.rootKeys.length || atom.rootKeys.some((key) => !key)) {
    errors.push(`atom[${index}] rootKeys must be a non-empty string array`);
  }
  if (!atom.triggerEpd || !atom.subjectUci) {
    errors.push(`atom[${index}] missing triggerEpd or subjectUci`);
  }
  if (!Number.isFinite(atom.subjectOrdinal)) {
    errors.push(`atom[${index}] subjectOrdinal must be finite`);
  }
  if (!Number.isFinite(atom.depthHalfMoves)) {
    errors.push(`atom[${index}] depthHalfMoves must be finite`);
  }
  const support = atom.support;
  if (!support || typeof support !== "object") {
    errors.push(`atom[${index}] support must be an object`);
  } else {
    if (!Number.isFinite(support.distinctGames)) errors.push(`atom[${index}] support.distinctGames must be finite`);
    if (!Number.isFinite(support.distinctDates)) errors.push(`atom[${index}] support.distinctDates must be finite`);
    if (!Number.isFinite(support.residualLooSupport)) {
      errors.push(`atom[${index}] support.residualLooSupport must be finite`);
    }
  }
  if (!Array.isArray(atom.receipts)) {
    errors.push(`atom[${index}] receipts must be an array`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateEligibleAtoms(eligibleAtoms) {
  if (!Array.isArray(eligibleAtoms)) {
    return { ok: false, errors: ["eligibleAtoms must be an array"] };
  }
  const errors = [];
  for (let i = 0; i < eligibleAtoms.length; i += 1) {
    const check = validateEligibleAtom(eligibleAtoms[i], i);
    if (!check.ok) errors.push(...check.errors);
  }
  return { ok: errors.length === 0, errors };
}

export function validateSolverDevProtocol(protocol) {
  const errors = [];
  if (protocol?.kind !== SHADOW_PREP_SOLVER_DEV_PROTOCOL_KIND) errors.push("invalid kind");
  if (protocol?.protocolId !== SHADOW_PREP_SOLVER_DEV_PROTOCOL_ID) errors.push("invalid protocolId");
  if (protocol?.purpose !== "burned-D0-algorithm-development-only") errors.push("invalid purpose");
  if (protocol?.scientificAuthorization !== false) errors.push("scientificAuthorization must be false");
  if (protocol?.productAuthorization !== false) errors.push("productAuthorization must be false");
  if (protocol?.freshHoldoutRequired !== true) errors.push("freshHoldoutRequired must be true");
  if (protocol?.preregisteredAt != null) errors.push("preregisteredAt is forbidden on solver-dev protocol");
  if (!protocol?.developmentFrozenAt) errors.push("missing developmentFrozenAt");
  if (protocol?.exactSolverCaps?.notAScientificFeasibilityGate !== true) {
    errors.push("exactSolverCaps must declare notAScientificFeasibilityGate");
  }
  if (protocol?.exactSolverCaps?.selectedDuringBurnedD0Implementation !== true) {
    errors.push("exactSolverCaps must declare selectedDuringBurnedD0Implementation");
  }
  if (protocol?.futureP0Policy?.mustFreezeSolverVersionAndCapsBeforeHoldoutAccess !== true) {
    errors.push("future P0 must freeze solver version and caps before holdout access");
  }
  if (protocol?.d0Corpus?.sha256 !== "a709270826232fef346098ebfe15f0bd265b5737372de27daedbb60ca70a9a42") {
    errors.push("d0 corpus sha mismatch");
  }
  if (Number(protocol?.d0Corpus?.gameCount) !== 2260) errors.push("d0 corpus count mismatch");
  if (protocol?.sealedP0ProtocolReference?.fileSha256 !== "1d9d38623b0e28b925c267772c762d6eae0a8be2197d1dcf7dfec7725dc83756") {
    errors.push("sealed P0 raw file sha mismatch");
  }
  if (protocol?.sealedP0ProtocolReference?.protocolSha256 !== "4c77c6c5e60dda061be1ebf9e014fe232d362934318c4343a75c0d1e458e0df1") {
    errors.push("sealed P0 protocol sha mismatch");
  }
  if (Number(protocol?.candidateSupport?.minDistinctGames) !== 3) errors.push("candidate support games mismatch");
  if (Number(protocol?.candidateSupport?.minDistinctDates) !== 2) errors.push("candidate support dates mismatch");
  if (Number(protocol?.candidateSupport?.minResidualLooSupport) !== 2) errors.push("candidate support loo mismatch");
  if (Number(protocol?.candidateSupport?.maxAtomHalfMoves) !== 12) errors.push("candidate support plies mismatch");
  if (Number(protocol?.treatmentBudget?.atomsPerColorPerArm) !== 6) errors.push("target atom count mismatch");
  if (Number(protocol?.treatmentBudget?.maxForks) !== 3) errors.push("max forks mismatch");
  if (Number(protocol?.treatmentBudget?.maxRepliesPerFork) !== 2) errors.push("max replies mismatch");
  if (Number(protocol?.treatmentBudget?.minOrdinal3PlusAtoms) !== 3) errors.push("min deep atoms mismatch");
  const lex = protocol?.candidateSelection?.lexicographicObjective || [];
  if (lex.length !== LOCKED_LEX_OBJECTIVE.length
    || LOCKED_LEX_OBJECTIVE.some((key, index) => lex[index] !== key)) {
    errors.push("invalid lexicographic objective");
  }
  if (protocol?.candidateSelection?.medianDepthDirection !== "minimize") {
    errors.push("medianDepthDirection must be minimize");
  }
  if (protocol?.objectiveEquivalenceToSealedP0 !== false) {
    errors.push("objectiveEquivalenceToSealedP0 must be false");
  }
  const prov = protocol?.objectiveDirectionProvenance;
  if (prov?.sealedP0ComparePackageLex !== "maximizes medianDepth on median-only ties") {
    errors.push("objectiveDirectionProvenance.sealedP0ComparePackageLex mismatch");
  }
  if (prov?.sealedP0ProtocolListedNamesWithoutDirections !== true) {
    errors.push("objectiveDirectionProvenance.sealedP0ProtocolListedNamesWithoutDirections must be true");
  }
  if (prov?.sealedRealD0CandidateSearchNeverCompleted !== true) {
    errors.push("objectiveDirectionProvenance.sealedRealD0CandidateSearchNeverCompleted must be true");
  }
  if (prov?.solverDevMedianDepthDirection !== "minimize") {
    errors.push("objectiveDirectionProvenance.solverDevMedianDepthDirection must be minimize");
  }
  if (prov?.divergenceScope !== "median-only ties only; higher objective layers match maximize direction") {
    errors.push("objectiveDirectionProvenance.divergenceScope mismatch");
  }
  if (prov?.futureP0MustPreregisterObjectiveDirection !== true) {
    errors.push("objectiveDirectionProvenance.futureP0MustPreregisterObjectiveDirection must be true");
  }
  if (!protocol?.exactSolverCaps?.maxTransitionsPerRootScope) {
    errors.push("exactSolverCaps.maxTransitionsPerRootScope is required");
  }
  const statuses = protocol?.candidateSelection?.statuses || [];
  if (statuses.length !== 4 || !Object.values(EXACT_SOLVER_STATUSES).every((status) => statuses.includes(status))) {
    errors.push("invalid solver statuses");
  }
  for (const field of POSITIVE_CAP_FIELDS) {
    if (!isPositiveInteger(Number(protocol?.exactSolverCaps?.[field]))) {
      errors.push(`exactSolverCaps.${field} must be a positive integer`);
    }
  }
  if (protocol?.protocolSha256 && sha256SolverDevProtocol(protocol) !== protocol.protocolSha256) {
    errors.push("protocolSha256 mismatch");
  }
  return { ok: errors.length === 0, errors, protocolSha256: protocol?.protocolSha256 ?? null };
}

function resolveCaps(protocol) {
  return {
    maxTransitionsPerRoot: Number(protocol.exactSolverCaps.maxTransitionsPerRoot),
    maxStatesPerStage: Number(protocol.exactSolverCaps.maxStatesPerStage),
    maxSupportPasses: Number(protocol.exactSolverCaps.maxSupportPasses),
    maxRoots: Number(protocol.exactSolverCaps.maxRoots),
  };
}

function optionsFor(rows, maxReplies) {
  const sorted = [...rows].sort((a, b) => a.atomKey.localeCompare(b.atomKey));
  const options = [[]];
  for (const atom of sorted) options.push([atom]);
  if (maxReplies >= 2) {
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) options.push([sorted[i], sorted[j]]);
    }
  }
  return options;
}

function buildTriggerGroups(atoms, maxReplies) {
  const byTrigger = new Map();
  for (const atom of atoms) {
    const rows = byTrigger.get(atom.triggerEpd) || [];
    rows.push(atom);
    byTrigger.set(atom.triggerEpd, rows);
  }
  return [...byTrigger.keys()].sort().map((trigger) => ({
    trigger,
    options: optionsFor(byTrigger.get(trigger), maxReplies),
  }));
}

function makeCapResult(stage, kind, diagnostics) {
  return {
    status: EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED,
    best: null,
    diagnostics: {
      ...diagnostics,
      capHit: { stage, kind },
    },
  };
}

function stageAFeasibleDeepCounts(groups, target, maxForks, caps, diagnostics) {
  const stageStartTransitions = diagnostics.transitions;
  let frontier = new Set(["0|0|0"]);
  let peakStates = 1;
  for (const group of groups) {
    const next = new Set();
    for (const key of frontier) {
      const [count, forks, deepCount] = key.split("|").map(Number);
      for (const option of group.options) {
        diagnostics.transitions += 1;
        if (diagnostics.transitions > caps.maxTransitionsPerRoot) {
          return makeCapResult("A", "maxTransitionsPerRoot", diagnostics);
        }
        const newCount = count + option.length;
        const newForks = forks + (option.length > 1 ? 1 : 0);
        const newDeep = deepCount + option.filter((atom) => atom.subjectOrdinal >= 3).length;
        if (newCount > target || newForks > maxForks) continue;
        next.add(`${newCount}|${newForks}|${newDeep}`);
      }
    }
    if (next.size > caps.maxStatesPerStage) {
      return makeCapResult("A", "maxStatesPerStage", diagnostics);
    }
    peakStates = Math.max(peakStates, next.size);
    frontier = next;
  }
  diagnostics.peakStates = Math.max(diagnostics.peakStates, peakStates);
  diagnostics.transitionsByStage.A = diagnostics.transitions - stageStartTransitions;
  const deepCounts = new Set();
  for (const key of frontier) {
    const [count, , deepCount] = key.split("|").map(Number);
    if (count === target) deepCounts.add(deepCount);
  }
  return { deepCounts, diagnostics };
}

function stageBFeasibleAtThreshold(groups, target, maxForks, deepTarget, threshold, caps, diagnostics) {
  const stageStartTransitions = diagnostics.transitions;
  let frontier = new Set(["0|0|0|inf"]);
  let peakStates = 1;
  for (const group of groups) {
    const next = new Set();
    for (const key of frontier) {
      const parts = key.split("|");
      const count = Number(parts[0]);
      const forks = Number(parts[1]);
      const deepCount = Number(parts[2]);
      const minSupport = parts[3] === "inf" ? Number.POSITIVE_INFINITY : Number(parts[3]);
      for (const option of group.options) {
        diagnostics.transitions += 1;
        if (diagnostics.transitions > caps.maxTransitionsPerRoot) {
          return { feasible: false, cap: makeCapResult("B", "maxTransitionsPerRoot", diagnostics) };
        }
        const newCount = count + option.length;
        const newForks = forks + (option.length > 1 ? 1 : 0);
        const newDeep = deepCount + option.filter((atom) => atom.subjectOrdinal >= 3).length;
        if (newCount > target || newForks > maxForks || newDeep > deepTarget) continue;
        const optionSupports = option.map((atom) => atom.support.distinctGames);
        const newMin = option.length
          ? Math.min(minSupport, ...optionSupports)
          : minSupport;
        next.add(`${newCount}|${newForks}|${newDeep}|${newMin}`);
      }
    }
    if (next.size > caps.maxStatesPerStage) {
      return { feasible: false, cap: makeCapResult("B", "maxStatesPerStage", diagnostics) };
    }
    peakStates = Math.max(peakStates, next.size);
    frontier = next;
  }
  diagnostics.peakStates = Math.max(diagnostics.peakStates, peakStates);
  diagnostics.transitionsByStage.B = (diagnostics.transitionsByStage.B || 0)
    + (diagnostics.transitions - stageStartTransitions);
  let feasible = false;
  for (const key of frontier) {
    const [count, , deepCount, minSupportRaw] = key.split("|");
    const minSupport = minSupportRaw === "inf" ? Number.POSITIVE_INFINITY : Number(minSupportRaw);
    if (Number(count) === target && Number(deepCount) === deepTarget && minSupport >= threshold) {
      feasible = true;
      break;
    }
  }
  return { feasible, diagnostics };
}

function stageCOptimizeWitness(groups, target, maxForks, deepTarget, minSupportTarget, caps, diagnostics) {
  const stageStartTransitions = diagnostics.transitions;
  let frontier = [{
    atoms: [],
    forks: 0,
    deepCount: 0,
    totalSupport: 0,
    minSupport: Number.POSITIVE_INFINITY,
    medianDepth: 0,
    stableKey: "",
  }];
  let peakStates = 1;
  for (const group of groups) {
    const next = new Map();
    for (const state of frontier) {
      for (const option of group.options) {
        diagnostics.transitions += 1;
        if (diagnostics.transitions > caps.maxTransitionsPerRoot) {
          return makeCapResult("C", "maxTransitionsPerRoot", diagnostics);
        }
        const atoms = [...state.atoms, ...option];
        const count = atoms.length;
        const forks = state.forks + (option.length > 1 ? 1 : 0);
        const deepCount = atoms.filter((atom) => atom.subjectOrdinal >= 3).length;
        if (count > target || forks > maxForks || deepCount > deepTarget) continue;
        const supports = atoms.map((atom) => atom.support.distinctGames);
        const minSupport = supports.length ? Math.min(...supports) : Number.POSITIVE_INFINITY;
        if (Number.isFinite(minSupportTarget) && minSupport < minSupportTarget) continue;
        const totalSupport = supports.reduce((sum, value) => sum + value, 0);
        const depths = atoms.map((atom) => atom.depthHalfMoves).sort((a, b) => a - b);
        const stableKey = atoms.map((atom) => atom.atomKey).sort().join(",");
        const witness = {
          atoms,
          forks,
          deepCount,
          totalSupport,
          minSupport,
          medianDepth: median(atoms.map((atom) => atom.depthHalfMoves)),
          stableKey,
          depthKey: depths.join(","),
        };
        const pruneKey = `${count}|${forks}|${deepCount}|${witness.depthKey}`;
        const prior = next.get(pruneKey);
        if (!prior || compareWitnessStageC(prior, witness) < 0) next.set(pruneKey, witness);
      }
    }
    if (next.size > caps.maxStatesPerStage) {
      return makeCapResult("C", "maxStatesPerStage", diagnostics);
    }
    peakStates = Math.max(peakStates, next.size);
    frontier = [...next.values()];
  }
  diagnostics.peakStates = Math.max(diagnostics.peakStates, peakStates);
  diagnostics.transitionsByStage.C = diagnostics.transitions - stageStartTransitions;
  let bestWitness = null;
  for (const witness of frontier) {
    if (witness.atoms.length !== target) continue;
    if (witness.deepCount !== deepTarget) continue;
    if (witness.minSupport < minSupportTarget) continue;
    if (!bestWitness || compareWitnessStageC(bestWitness, witness) < 0) bestWitness = witness;
  }
  return { bestWitness, diagnostics };
}

export function exactBestForRootBounded(componentAtoms, rootKey, protocol = null) {
  const validation = validateSolverDevProtocol(protocol);
  if (!validation.ok) {
    return {
      status: EXACT_SOLVER_STATUSES.INVALID_INPUT,
      best: null,
      diagnostics: { errors: validation.errors },
    };
  }

  if (!rootKey || typeof rootKey !== "string" || !Array.isArray(componentAtoms)) {
    return {
      status: EXACT_SOLVER_STATUSES.INVALID_INPUT,
      best: null,
      diagnostics: { errors: ["invalid root or atoms"] },
    };
  }

  const atomValidation = validateEligibleAtoms(componentAtoms);
  if (!atomValidation.ok) {
    return {
      status: EXACT_SOLVER_STATUSES.INVALID_INPUT,
      best: null,
      diagnostics: { errors: atomValidation.errors },
    };
  }

  const target = Number(protocol.treatmentBudget.atomsPerColorPerArm);
  const maxForks = Number(protocol.treatmentBudget.maxForks);
  const maxReplies = Number(protocol.treatmentBudget.maxRepliesPerFork);
  const minDeep = Number(protocol.treatmentBudget.minOrdinal3PlusAtoms);
  const caps = resolveCaps(protocol);

  const atoms = componentAtoms
    .map((atom) => projectAtomForRoot(atom, rootKey, protocol))
    .filter(Boolean)
    .sort((a, b) => a.atomKey.localeCompare(b.atomKey));

  const diagnostics = {
    rootKey,
    eligibleAtoms: atoms.length,
    triggerGroups: 0,
    transitions: 0,
    transitionsByStage: {},
    peakStates: 0,
    supportPasses: 0,
    capHit: null,
  };

  const groups = buildTriggerGroups(atoms, maxReplies);
  diagnostics.triggerGroups = groups.length;

  const stageA = stageAFeasibleDeepCounts(groups, target, maxForks, caps, diagnostics);
  if (stageA.status) return stageA;
  const { deepCounts } = stageA;
  let maxDeep = -1;
  for (const deepCount of deepCounts) if (deepCount > maxDeep) maxDeep = deepCount;
  if (maxDeep < minDeep) {
    return {
      status: EXACT_SOLVER_STATUSES.INFEASIBLE,
      best: null,
      diagnostics: { ...diagnostics, maxOrdinal3PlusCount: maxDeep, reason: "ordinal-floor" },
    };
  }

  const supportThresholds = [...new Set(atoms.map((atom) => atom.support.distinctGames))].sort((a, b) => b - a);
  let maxMinSupport = null;
  for (const threshold of supportThresholds) {
    diagnostics.supportPasses += 1;
    if (diagnostics.supportPasses > caps.maxSupportPasses) {
      return makeCapResult("B", "maxSupportPasses", diagnostics);
    }
    const stageB = stageBFeasibleAtThreshold(
      groups, target, maxForks, maxDeep, threshold, caps, diagnostics,
    );
    if (stageB.cap) return stageB.cap;
    if (stageB.feasible) {
      maxMinSupport = threshold;
      break;
    }
  }
  if (maxMinSupport == null) {
    return {
      status: EXACT_SOLVER_STATUSES.INFEASIBLE,
      best: null,
      diagnostics: { ...diagnostics, maxOrdinal3PlusCount: maxDeep, reason: "min-support" },
    };
  }

  const stageC = stageCOptimizeWitness(
    groups, target, maxForks, maxDeep, maxMinSupport, caps, diagnostics,
  );
  if (stageC.status) return stageC;
  const { bestWitness } = stageC;
  if (!bestWitness) {
    return {
      status: EXACT_SOLVER_STATUSES.INFEASIBLE,
      best: null,
      diagnostics: { ...diagnostics, maxOrdinal3PlusCount: maxDeep, maxMinSupport, reason: "witness" },
    };
  }

  const candidate = {
    atoms: bestWitness.atoms,
    score: packageScore(bestWitness.atoms),
    rootKey,
    evidenceType: "candidate-personal",
  };
  const gate = packageMeetsCandidateGates(candidate.atoms, protocol);
  if (!gate.ok) {
    return {
      status: EXACT_SOLVER_STATUSES.INFEASIBLE,
      best: null,
      diagnostics: {
        ...diagnostics,
        maxOrdinal3PlusCount: maxDeep,
        maxMinSupport,
        reason: gate.reason,
      },
    };
  }

  return {
    status: EXACT_SOLVER_STATUSES.OPTIMAL,
    best: { ...candidate, tree: gate.tree, budget: gate.budget },
    diagnostics: {
      ...diagnostics,
      maxOrdinal3PlusCount: maxDeep,
      maxMinSupport,
      objective: candidate.score,
      witnessStableKey: candidate.score.stableKey,
    },
  };
}

function isCompletedProofStatus(status) {
  return status === EXACT_SOLVER_STATUSES.OPTIMAL
    || status === EXACT_SOLVER_STATUSES.INFEASIBLE;
}

function buildSolverDiagnostics(perRoot, rootKeys) {
  const rootsRelevant = perRoot.filter((row) => row.relevant).length;
  const rootsCompleted = perRoot.filter((row) => row.relevant && isCompletedProofStatus(row.status)).length;
  return {
    rootsConsidered: rootKeys.length,
    rootsRelevant,
    rootsCompleted,
    perRoot,
  };
}

export function solveExactCandidatePackage(eligibleAtoms, protocol = null) {
  const validation = validateSolverDevProtocol(protocol);
  if (!validation.ok) {
    return {
      status: EXACT_SOLVER_STATUSES.INVALID_INPUT,
      package: null,
      diagnostics: { errors: validation.errors },
    };
  }

  const atomValidation = validateEligibleAtoms(eligibleAtoms);
  if (!atomValidation.ok) {
    return {
      status: EXACT_SOLVER_STATUSES.INVALID_INPUT,
      package: null,
      diagnostics: { errors: atomValidation.errors },
    };
  }

  const target = Number(protocol.treatmentBudget.atomsPerColorPerArm);
  const caps = resolveCaps(protocol);
  const byRoot = new Map();
  for (const atom of eligibleAtoms) {
    for (const rootKey of atom.rootKeys || []) {
      if (!rootKey) continue;
      const rows = byRoot.get(rootKey) || [];
      rows.push(atom);
      byRoot.set(rootKey, rows);
    }
  }

  const rootKeys = [...byRoot.keys()].sort();
  const relevanceByRoot = new Map(rootKeys.map((rootKey) => {
    const component = byRoot.get(rootKey);
    const projectedEligible = countProjectedEligibleForRoot(component, rootKey, protocol);
    return [rootKey, {
      projectedEligible,
      relevant: projectedEligible >= target,
    }];
  }));
  const rootsRelevantCount = [...relevanceByRoot.values()].filter((row) => row.relevant).length;
  if (rootsRelevantCount > caps.maxRoots) {
    return {
      status: EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED,
      package: null,
      diagnostics: {
        rootsConsidered: rootKeys.length,
        rootsRelevant: rootsRelevantCount,
        rootsCompleted: 0,
        capHit: { stage: "roots", kind: "maxRoots" },
      },
    };
  }

  const perRoot = [];
  let best = null;
  let bestSoFarNonAuthoritative = null;
  let anyRelevant = false;
  let anyExhausted = false;
  let anyInvalid = false;
  let allInfeasible = true;

  for (const rootKey of rootKeys) {
    const component = byRoot.get(rootKey);
    const { projectedEligible, relevant } = relevanceByRoot.get(rootKey);
    if (!relevant) {
      perRoot.push({
        rootKey,
        relevant: false,
        eligibleAtoms: projectedEligible,
        status: null,
      });
      continue;
    }
    anyRelevant = true;
    const result = exactBestForRootBounded(component, rootKey, protocol);
    perRoot.push({
      rootKey,
      relevant: true,
      eligibleAtoms: projectedEligible,
      status: result.status,
      diagnostics: result.diagnostics,
      objective: result.best?.score ?? null,
      witnessStableKey: result.best?.score?.stableKey ?? null,
    });
    if (result.status === EXACT_SOLVER_STATUSES.INVALID_INPUT) anyInvalid = true;
    if (result.status === EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED) anyExhausted = true;
    if (result.status === EXACT_SOLVER_STATUSES.OPTIMAL) {
      allInfeasible = false;
      if (!best || comparePackageSolverDev(result.best, best) > 0) best = result.best;
    }
    if (result.best && (!bestSoFarNonAuthoritative || comparePackageSolverDev(result.best, bestSoFarNonAuthoritative) > 0)) {
      bestSoFarNonAuthoritative = result.best;
    }
    if (result.status !== EXACT_SOLVER_STATUSES.INFEASIBLE) allInfeasible = false;
  }

  const diagnostics = buildSolverDiagnostics(perRoot, rootKeys);
  if (bestSoFarNonAuthoritative) {
    diagnostics.bestSoFarNonAuthoritative = {
      authoritative: false,
      rootKey: bestSoFarNonAuthoritative.rootKey,
      stableKey: bestSoFarNonAuthoritative.score?.stableKey ?? null,
      objective: bestSoFarNonAuthoritative.score ?? null,
    };
  }

  if (anyInvalid) {
    return { status: EXACT_SOLVER_STATUSES.INVALID_INPUT, package: null, diagnostics };
  }
  if (anyExhausted) {
    return { status: EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED, package: null, diagnostics };
  }
  if (!anyRelevant || allInfeasible || !best) {
    return { status: EXACT_SOLVER_STATUSES.INFEASIBLE, package: null, diagnostics };
  }

  const completedRelevant = perRoot.filter((row) => row.relevant);
  const allCompleted = completedRelevant.every((row) => isCompletedProofStatus(row.status));
  if (!allCompleted) {
    return { status: EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED, package: null, diagnostics };
  }

  return {
    status: EXACT_SOLVER_STATUSES.OPTIMAL,
    package: { ...best, searchDiagnostics: perRoot },
    diagnostics,
  };
}

export function buildSolverDevWitnessHash(pkg) {
  if (!pkg?.atoms?.length) return null;
  return sha256Hex({
    rootKey: pkg.rootKey,
    stableKey: packageScore(pkg.atoms).stableKey,
    score: pkg.score ?? packageScore(pkg.atoms),
  });
}