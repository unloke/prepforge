import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MEM_MAX_FORKS,
  MEM_MAX_LEAVES,
  MEM_MAX_REPLIES_PER_FORK,
} from "./scout-v13-style.js";
import {
  comparePackageLex,
  extractEligibleAtomsFromGames,
  packageMeetsCandidateGates,
  projectAtomForRoot,
  selectCandidatePackage,
} from "./scout-shadow-prep-p0.js";
import {
  EXACT_SOLVER_STATUSES,
  buildSolverDevWitnessHash,
  comparePackageSolverDev,
  compareWitnessStageC,
  exactBestForRootBounded,
  sha256SolverDevProtocol,
  solveExactCandidatePackage,
  validateEligibleAtom,
  validateSolverDevProtocol,
} from "./scout-shadow-prep-exact-solver.js";

const protocolPath = fileURLToPath(new URL(
  "../research/scout-shadow-prep/ericrosen-shadow-prep-solver-dev.protocol.json",
  import.meta.url,
));
const p0ProtocolPath = fileURLToPath(new URL(
  "../research/scout-shadow-prep/ericrosen-shadow-prep-p0.protocol.json",
  import.meta.url,
));
const solverProtocol = JSON.parse(readFileSync(protocolPath, "utf8"));
const p0Protocol = JSON.parse(readFileSync(p0ProtocolPath, "utf8"));

function solverProtocolWith(overrides = {}) {
  const { exactSolverCaps: capOverrides = {}, ...rest } = overrides;
  const merged = {
    ...solverProtocol,
    ...rest,
    exactSolverCaps: {
      ...solverProtocol.exactSolverCaps,
      ...capOverrides,
    },
  };
  if (Object.keys(capOverrides).length) delete merged.protocolSha256;
  return merged;
}

function p0ProtocolWith(overrides = {}) {
  return {
    ...p0Protocol,
    candidateSelection: { ...p0Protocol.candidateSelection, maxSearchStates: 5_000_000 },
    ...overrides,
  };
}

function game(id, color, ucis, day, extra = {}) {
  return {
    gameId: id,
    color,
    createdAtMs: 1_690_000_000_000 + day * 86_400_000,
    speed: "blitz",
    ucis,
    score: day % 2,
    maia: { ignored: true },
    ...extra,
  };
}

const WHITE_LINES = Object.freeze([
  ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "d2d3"],
  ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3"],
  ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4"],
  ["e2e4", "e7e5", "b1c3", "g8f6", "g1f3", "b8c6", "f1b5"],
]);

const BLACK_LINES = Object.freeze([
  ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "g1f3", "f8e7"],
  ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "g1f3", "c7c5"],
  ["d2d4", "d7d5", "c2c4", "e7e6", "g1f3", "f8e7", "b1c3", "g8f6"],
  ["d2d4", "d7d5", "c2c4", "c7c6", "g1f3", "g8f6", "b1c3", "e7e6"],
]);

function supportCorpus(repetitions = 3, prefix = "train") {
  const games = [];
  let day = 0;
  for (const [color, lines] of [["white", WHITE_LINES], ["black", BLACK_LINES]]) {
    for (let line = 0; line < lines.length; line += 1) {
      for (let copy = 0; copy < repetitions; copy += 1) {
        games.push(game(`${prefix}-${color}-${line}-${copy}`, color, lines[line], day++));
      }
    }
  }
  return games;
}

function packageScore(atoms) {
  const support = atoms.map((atom) => atom.support.distinctGames);
  const depths = atoms.map((atom) => atom.depthHalfMoves).sort((a, b) => a - b);
  const medianDepth = depths.length % 2
    ? depths[(depths.length - 1) / 2]
    : (depths[depths.length / 2 - 1] + depths[depths.length / 2]) / 2;
  return {
    atomCount: atoms.length,
    ordinal3PlusCount: atoms.filter((atom) => atom.subjectOrdinal >= 3).length,
    minSupport: support.length ? Math.min(...support) : 0,
    totalSupport: support.reduce((sum, value) => sum + value, 0),
    medianDepth,
    stableKey: atoms.map((atom) => atom.atomKey).sort().join(","),
  };
}

function compareExactPackage(left, right) {
  return comparePackageSolverDev(left, right);
}

function bruteForceOptions(rows, maxReplies) {
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

function bruteForceBestForRoot(componentAtoms, rootKey, protocol) {
  const target = Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? MEM_MAX_LEAVES);
  const maxForks = Number(protocol?.treatmentBudget?.maxForks ?? MEM_MAX_FORKS);
  const maxReplies = Number(protocol?.treatmentBudget?.maxRepliesPerFork ?? MEM_MAX_REPLIES_PER_FORK);
  const atoms = componentAtoms
    .map((atom) => projectAtomForRoot(atom, rootKey, protocol))
    .filter(Boolean)
    .sort((a, b) => a.atomKey.localeCompare(b.atomKey));
  const byTrigger = new Map();
  for (const atom of atoms) {
    const rows = byTrigger.get(atom.triggerEpd) || [];
    rows.push(atom);
    byTrigger.set(atom.triggerEpd, rows);
  }
  const triggers = [...byTrigger.keys()].sort();
  let frontier = [{ atoms: [], forks: 0 }];
  for (const trigger of triggers) {
    const options = bruteForceOptions(byTrigger.get(trigger), maxReplies);
    const next = [];
    for (const state of frontier) {
      for (const option of options) {
        const count = state.atoms.length + option.length;
        const forks = state.forks + (option.length > 1 ? 1 : 0);
        if (count > target || forks > maxForks) continue;
        next.push({ atoms: [...state.atoms, ...option], forks });
      }
    }
    frontier = next;
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
    if (gate.ok && (!best || compareExactPackage(candidate, best) > 0)) {
      best = { ...candidate, tree: gate.tree, budget: gate.budget };
    }
  }
  return best;
}

function mkAtom({
  key,
  triggerEpd,
  rootKey,
  games,
  ordinal = 3,
  depth = 5,
  subjectUci = key,
}) {
  const receipts = games.map((row) => ({
    gameId: row.id,
    dayKey: row.day,
    rootKey,
    pathUcis: ["e2e4", "e7e5"],
    subjectOrdinal: ordinal,
    depthHalfMoves: depth,
  }));
  return {
    atomKey: key,
    triggerEpd,
    triggerFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    subjectUci,
    postTriggerUserToMoveEpd: `post-${key}`,
    postTriggerFen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    color: "white",
    subjectOrdinal: ordinal,
    depthHalfMoves: depth,
    rootKeys: [rootKey],
    displayPaths: [["e2e4", "e7e5"]],
    receipts,
    support: {
      distinctGames: games.length,
      distinctDates: new Set(games.map((row) => row.day)).size,
      residualLooSupport: games.length - 1,
      gameIds: games.map((row) => row.id),
      dayKeys: [...new Set(games.map((row) => row.day))],
    },
  };
}

function generatedFixture(seed) {
  const root = "e2e4>e7e5";
  const baseGames = [
    { id: `g1-${seed}`, day: "2023-08-01" },
    { id: `g2-${seed}`, day: "2023-08-02" },
    { id: `g3-${seed}`, day: "2023-08-03" },
  ];
  return Array.from({ length: 7 + (seed % 2) }, (_, i) => mkAtom({
    key: `gen-${seed}-${i}`,
    triggerEpd: `gen-${seed}-t-${i}`,
    rootKey: root,
    games: baseGames,
    depth: 4 + ((i + seed) % 5),
    ordinal: 3,
  }));
}

describe("solver development protocol", () => {
  it("validates canonical hash, development freeze, and transparent cap provenance", () => {
    const validation = validateSolverDevProtocol(solverProtocol);
    expect(validation.ok).toBe(true);
    expect(sha256SolverDevProtocol(solverProtocol)).toBe(solverProtocol.protocolSha256);
    expect(solverProtocol.preregisteredAt).toBeUndefined();
    expect(solverProtocol.developmentFrozenAt).toBeTruthy();
    expect(solverProtocol.exactSolverCaps.selectedDuringBurnedD0Implementation).toBe(true);
    expect(solverProtocol.exactSolverCaps.notAScientificFeasibilityGate).toBe(true);
    expect(solverProtocol.exactSolverCaps.maxTransitionsPerRootScope).toContain("Stage-A");
    expect(solverProtocol.objectiveEquivalenceToSealedP0).toBe(false);
    expect(solverProtocol.objectiveDirectionProvenance.solverDevMedianDepthDirection).toBe("minimize");
    expect(solverProtocol.sealedP0ProtocolReference.fileSha256).toBe(
      "1d9d38623b0e28b925c267772c762d6eae0a8be2197d1dcf7dfec7725dc83756",
    );
    expect(solverProtocol.scientificAuthorization).toBe(false);
    expect(solverProtocol.productAuthorization).toBe(false);
    expect(solverProtocol.freshHoldoutRequired).toBe(true);
  });

  it("rejects altered protocol semantics fail-closed", () => {
    expect(validateSolverDevProtocol({ ...solverProtocol, kind: "wrong" }).ok).toBe(false);
    expect(validateSolverDevProtocol({
      ...solverProtocol,
      treatmentBudget: { ...solverProtocol.treatmentBudget, atomsPerColorPerArm: 5 },
    }).ok).toBe(false);
    expect(validateSolverDevProtocol({
      ...solverProtocol,
      exactSolverCaps: { ...solverProtocol.exactSolverCaps, maxStatesPerStage: 0 },
    }).ok).toBe(false);
    expect(validateSolverDevProtocol({
      ...solverProtocol,
      candidateSelection: {
        ...solverProtocol.candidateSelection,
        statuses: ["OPTIMAL", "INFEASIBLE"],
      },
    }).ok).toBe(false);
    expect(validateSolverDevProtocol({
      ...solverProtocol,
      scientificAuthorization: true,
    }).ok).toBe(false);
    expect(validateSolverDevProtocol({
      ...solverProtocol,
      objectiveEquivalenceToSealedP0: true,
    }).ok).toBe(false);
    expect(validateSolverDevProtocol({
      ...solverProtocol,
      objectiveDirectionProvenance: {
        ...solverProtocol.objectiveDirectionProvenance,
        solverDevMedianDepthDirection: "maximize",
      },
    }).ok).toBe(false);
    expect(validateSolverDevProtocol({
      ...solverProtocol,
      exactSolverCaps: {
        ...solverProtocol.exactSolverCaps,
        maxTransitionsPerRootScope: "",
      },
    }).ok).toBe(false);
  });
});

describe("comparePackageSolverDev vs sealed comparePackageLex", () => {
  it("chooses lower medianDepth on median-only ties while sealed chooses higher", () => {
    const lowMedian = {
      score: {
        atomCount: 6,
        ordinal3PlusCount: 3,
        minSupport: 3,
        totalSupport: 18,
        medianDepth: 5,
        stableKey: "a,b,c,d,e,f",
      },
    };
    const highMedian = {
      score: {
        atomCount: 6,
        ordinal3PlusCount: 3,
        minSupport: 3,
        totalSupport: 18,
        medianDepth: 7,
        stableKey: "a,b,c,d,e,f",
      },
    };
    expect(comparePackageSolverDev(lowMedian, highMedian)).toBeGreaterThan(0);
    expect(comparePackageSolverDev(highMedian, lowMedian)).toBeLessThan(0);
    expect(comparePackageLex(lowMedian, highMedian)).toBeLessThan(0);
    expect(comparePackageLex(highMedian, lowMedian)).toBeGreaterThan(0);
  });
});

describe("compareWitnessStageC median and stable-key ties", () => {
  it("prefers smaller medianDepth when higher layers tie", () => {
    const low = { totalSupport: 18, medianDepth: 5, stableKey: "m|z" };
    const high = { totalSupport: 18, medianDepth: 6, stableKey: "m|a" };
    expect(compareWitnessStageC(low, high)).toBeGreaterThan(0);
    expect(compareWitnessStageC(high, low)).toBeLessThan(0);
    const oldComparator = (left, right) => {
      if (left.totalSupport !== right.totalSupport) return left.totalSupport - right.totalSupport;
      if (left.medianDepth !== right.medianDepth) return left.medianDepth - right.medianDepth;
      return String(right.stableKey).localeCompare(String(left.stableKey));
    };
    expect(oldComparator(low, high)).toBeLessThan(0);
  });

  it("prefers smaller stableKey when totalSupport and medianDepth tie", () => {
    const a = { totalSupport: 18, medianDepth: 5.5, stableKey: "a-key,b-key,c-key" };
    const z = { totalSupport: 18, medianDepth: 5.5, stableKey: "z-key,b-key,c-key" };
    expect(compareWitnessStageC(a, z)).toBeGreaterThan(0);
    expect(compareWitnessStageC(z, a)).toBeLessThan(0);
  });
});

describe("exact solver oracle under solver-dev objective", () => {
  it("matches brute-force oracle on synthetic rooted fixtures", () => {
    const root = "e2e4>e7e5";
    const baseGames = [
      { id: "g1", day: "2023-08-01" },
      { id: "g2", day: "2023-08-02" },
      { id: "g3", day: "2023-08-03" },
    ];
    const atoms = [
      mkAtom({ key: "a", triggerEpd: "t1", rootKey: root, games: baseGames }),
      mkAtom({ key: "b", triggerEpd: "t1", rootKey: root, games: baseGames }),
      mkAtom({ key: "c", triggerEpd: "t2", rootKey: root, games: baseGames }),
      mkAtom({ key: "d", triggerEpd: "t2", rootKey: root, games: baseGames }),
      mkAtom({ key: "e", triggerEpd: "t3", rootKey: root, games: baseGames }),
      mkAtom({ key: "f", triggerEpd: "t3", rootKey: root, games: baseGames, depth: 7 }),
      mkAtom({ key: "g", triggerEpd: "t4", rootKey: root, games: baseGames, ordinal: 2, depth: 3 }),
      mkAtom({ key: "h", triggerEpd: "t4", rootKey: root, games: baseGames, ordinal: 4, depth: 9 }),
    ];
    const oracle = bruteForceBestForRoot(atoms, root, solverProtocol);
    const solved = exactBestForRootBounded(atoms, root, solverProtocol);
    expect(solved.status).toBe(EXACT_SOLVER_STATUSES.OPTIMAL);
    expect(solved.best.score).toEqual(oracle.score);
    expect(solved.best.score.stableKey).toBe(oracle.score.stableKey);
  });

  it("matches exact oracle on several generated small fixtures", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const atoms = generatedFixture(seed);
      const root = "e2e4>e7e5";
      const oracle = bruteForceBestForRoot(atoms, root, solverProtocol);
      const solved = exactBestForRootBounded(atoms, root, solverProtocol);
      if (!oracle) {
        expect(solved.status).toBe(EXACT_SOLVER_STATUSES.INFEASIBLE);
      } else {
        expect(solved.status).toBe(EXACT_SOLVER_STATUSES.OPTIMAL);
        expect(solved.best.score.stableKey).toBe(oracle.score.stableKey);
      }
    }
  });

  it("finds an OPTIMAL gated package on tractable support corpus", () => {
    const p0 = p0ProtocolWith();
    const eligible = extractEligibleAtomsFromGames(supportCorpus(3), { color: "white", protocol: p0 });
    const exact = solveExactCandidatePackage(eligible, solverProtocol);
    expect(exact.status).toBe(EXACT_SOLVER_STATUSES.OPTIMAL);
    expect(exact.package.atoms).toHaveLength(6);
    expect(packageMeetsCandidateGates(exact.package.atoms, solverProtocol).ok).toBe(true);
    const legacy = selectCandidatePackage(eligible, p0);
    expect(legacy).not.toBeNull();
    expect(legacy.atoms).toHaveLength(6);
    const higherLayersMatch = ["atomCount", "ordinal3PlusCount", "minSupport", "totalSupport"].every(
      (key) => exact.package.score[key] === legacy.score[key],
    );
    if (higherLayersMatch && exact.package.score.medianDepth !== legacy.score.medianDepth) {
      expect(exact.package.score.medianDepth).toBeLessThan(legacy.score.medianDepth);
    }
  });
});

describe("multi-root global selection under solver-dev comparator", () => {
  const baseGames = [
    { id: "g1", day: "2023-08-01" },
    { id: "g2", day: "2023-08-02" },
    { id: "g3", day: "2023-08-03" },
  ];

  function sixAtomRoot(rootKey, depthBias) {
    return Array.from({ length: 6 }, (_, i) => mkAtom({
      key: `${rootKey}-${i}`,
      triggerEpd: `${rootKey}-t-${i}`,
      rootKey,
      games: baseGames,
      depth: depthBias + (i % 2),
    }));
  }

  it("selects globally smaller medianDepth when higher objective layers tie across roots", () => {
    const rootLow = "e2e4>e7e5";
    const rootHigh = "d2d4>d7d5";
    const eligible = [...sixAtomRoot(rootLow, 4), ...sixAtomRoot(rootHigh, 8)];
    const solved = solveExactCandidatePackage(eligible, solverProtocol);
    expect(solved.status).toBe(EXACT_SOLVER_STATUSES.OPTIMAL);
    expect(solved.package.rootKey).toBe(rootLow);
    expect(solved.package.score.medianDepth).toBeLessThan(
      packageScore(sixAtomRoot(rootHigh, 8)).medianDepth,
    );
    const lowOnly = solveExactCandidatePackage(sixAtomRoot(rootLow, 4), solverProtocol);
    const highOnly = solveExactCandidatePackage(sixAtomRoot(rootHigh, 8), solverProtocol);
    expect(comparePackageSolverDev(solved.package, lowOnly.package)).toBe(0);
    expect(comparePackageSolverDev(solved.package, highOnly.package)).toBeGreaterThan(0);
  });

  it("final OPTIMAL package is >= every completed root OPTIMAL package under solver-dev comparator", () => {
    const rootLow = "e2e4>e7e5";
    const rootHigh = "d2d4>d7d5";
    const eligible = [...sixAtomRoot(rootLow, 4), ...sixAtomRoot(rootHigh, 8)];
    const solved = solveExactCandidatePackage(eligible, solverProtocol);
    expect(solved.status).toBe(EXACT_SOLVER_STATUSES.OPTIMAL);
    const completedOptimalRoots = solved.diagnostics.perRoot.filter(
      (row) => row.relevant && row.status === EXACT_SOLVER_STATUSES.OPTIMAL,
    );
    expect(completedOptimalRoots.length).toBe(2);
    for (const row of completedOptimalRoots) {
      const rootPackage = {
        rootKey: row.rootKey,
        score: row.objective,
        atoms: [],
      };
      expect(comparePackageSolverDev(solved.package, rootPackage)).toBeGreaterThanOrEqual(0);
      if (row.rootKey !== solved.package.rootKey) {
        expect(comparePackageSolverDev(solved.package, rootPackage)).toBeGreaterThan(0);
      }
    }
  });

  it("still maximizes higher objective layers across roots", () => {
    const rootA = "e2e4>e7e5";
    const rootB = "d2d4>d7d5";
    const weak = sixAtomRoot(rootA, 5);
    const strong = sixAtomRoot(rootB, 5).map((atom, i) => ({
      ...atom,
      support: {
        ...atom.support,
        distinctGames: 5,
        distinctDates: 3,
        residualLooSupport: 4,
      },
      receipts: Array.from({ length: 5 }, (_, j) => ({
        gameId: `strong-${i}-${j}`,
        dayKey: `2023-08-0${j + 1}`,
        rootKey: rootB,
        pathUcis: ["d2d4"],
        subjectOrdinal: 3,
        depthHalfMoves: atom.depthHalfMoves,
      })),
    }));
    const solved = solveExactCandidatePackage([...weak, ...strong], solverProtocol);
    expect(solved.status).toBe(EXACT_SOLVER_STATUSES.OPTIMAL);
    expect(solved.package.rootKey).toBe(rootB);
    expect(solved.package.score.minSupport).toBeGreaterThan(
      packageScore(weak).minSupport,
    );
  });
});

describe("exact solver invariance and gates", () => {
  it("is invariant to root, input, and group option permutations", () => {
    const root = "e2e4>e7e5";
    const baseGames = [
      { id: "g1", day: "2023-08-01" },
      { id: "g2", day: "2023-08-02" },
      { id: "g3", day: "2023-08-03" },
    ];
    const atoms = [
      mkAtom({ key: "z", triggerEpd: "t4", rootKey: root, games: baseGames }),
      mkAtom({ key: "a", triggerEpd: "t1", rootKey: root, games: baseGames }),
      mkAtom({ key: "b", triggerEpd: "t1", rootKey: root, games: baseGames }),
      mkAtom({ key: "c", triggerEpd: "t2", rootKey: root, games: baseGames }),
      mkAtom({ key: "d", triggerEpd: "t2", rootKey: root, games: baseGames }),
      mkAtom({ key: "e", triggerEpd: "t3", rootKey: root, games: baseGames }),
      mkAtom({ key: "f", triggerEpd: "t3", rootKey: root, games: baseGames }),
    ];
    const first = exactBestForRootBounded(atoms, root, solverProtocol);
    const shuffled = [...atoms].reverse();
    const second = exactBestForRootBounded(shuffled, root, solverProtocol);
    expect(second.best.score.stableKey).toBe(first.best.score.stableKey);
  });

  it("rejects root-conditional 2+1 support split atoms", () => {
    const rootA = "e2e4>e7e5";
    const rootB = "d2d4>d7d5";
    const atom = {
      atomKey: "epd|e2e4",
      triggerEpd: "epd",
      triggerFen: "fen",
      subjectUci: "e2e4",
      postTriggerUserToMoveEpd: "post",
      postTriggerFen: "postfen",
      color: "white",
      subjectOrdinal: 3,
      depthHalfMoves: 5,
      rootKeys: [rootA, rootB],
      displayPaths: [],
      receipts: [
        { gameId: "g1", dayKey: "2023-08-01", rootKey: rootA, pathUcis: ["e2e4"], subjectOrdinal: 3, depthHalfMoves: 5 },
        { gameId: "g2", dayKey: "2023-08-02", rootKey: rootA, pathUcis: ["e2e4"], subjectOrdinal: 3, depthHalfMoves: 5 },
        { gameId: "g3", dayKey: "2023-08-03", rootKey: rootB, pathUcis: ["d2d4"], subjectOrdinal: 3, depthHalfMoves: 5 },
      ],
      support: {
        distinctGames: 3,
        distinctDates: 3,
        residualLooSupport: 2,
        gameIds: ["g1", "g2", "g3"],
        dayKeys: ["2023-08-01", "2023-08-02", "2023-08-03"],
      },
    };
    expect(projectAtomForRoot(atom, rootA, solverProtocol)).toBeNull();
    expect(solveExactCandidatePackage([atom], solverProtocol).status).toBe(EXACT_SOLVER_STATUSES.INFEASIBLE);
  });

  it("returns deterministic repeat output and witness hash", () => {
    const eligible = extractEligibleAtomsFromGames(supportCorpus(3), {
      color: "white",
      protocol: p0ProtocolWith(),
    });
    const first = solveExactCandidatePackage(eligible, solverProtocol);
    const second = solveExactCandidatePackage([...eligible].reverse(), solverProtocol);
    expect(second.package.score.stableKey).toBe(first.package.score.stableKey);
    expect(buildSolverDevWitnessHash(second.package)).toBe(buildSolverDevWitnessHash(first.package));
  });
});

describe("lexicographic layer counterexamples", () => {
  const root = "e2e4>e7e5";
  const baseGames = [
    { id: "g1", day: "2023-08-01" },
    { id: "g2", day: "2023-08-02" },
    { id: "g3", day: "2023-08-03" },
  ];

  it("prefers smaller medianDepth when deep count, minSupport, and totalSupport tie", () => {
    const atoms = [
      mkAtom({ key: "low-root", triggerEpd: "t0", rootKey: root, games: baseGames, depth: 4 }),
      mkAtom({ key: "high-root", triggerEpd: "t0", rootKey: root, games: baseGames, depth: 9 }),
      mkAtom({ key: "mid-1", triggerEpd: "t1", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "mid-2", triggerEpd: "t2", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "mid-3", triggerEpd: "t3", rootKey: root, games: baseGames, depth: 6 }),
      mkAtom({ key: "mid-4", triggerEpd: "t4", rootKey: root, games: baseGames, depth: 6 }),
      mkAtom({ key: "mid-5", triggerEpd: "t5", rootKey: root, games: baseGames, depth: 6 }),
      mkAtom({ key: "mid-6", triggerEpd: "t6", rootKey: root, games: baseGames, depth: 6 }),
    ];
    const solved = exactBestForRootBounded(atoms, root, solverProtocol);
    const oracle = bruteForceBestForRoot(atoms, root, solverProtocol);
    const lowPath = bruteForceBestForRoot(
      atoms.filter((atom) => atom.atomKey !== "high-root"),
      root,
      solverProtocol,
    );
    const highOnly = [...atoms.filter((atom) => atom.atomKey !== "low-root"), mkAtom({
      key: "high-root",
      triggerEpd: "t0",
      rootKey: root,
      games: baseGames,
      depth: 9,
    })];
    const highPath = bruteForceBestForRoot(highOnly, root, solverProtocol);
    expect(solved.best.score.medianDepth).toBe(oracle.score.medianDepth);
    expect(solved.best.score.medianDepth).toBeLessThan(highPath.score.medianDepth);
    expect(solved.best.score.medianDepth).toBe(lowPath.score.medianDepth);
  });

  it("prefers smaller stableKey when medianDepth also ties", () => {
    const atoms = [
      mkAtom({ key: "z-pick", triggerEpd: "t0", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "a-pick", triggerEpd: "t0", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "mid-1", triggerEpd: "t1", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "mid-2", triggerEpd: "t2", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "mid-3", triggerEpd: "t3", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "mid-4", triggerEpd: "t4", rootKey: root, games: baseGames, depth: 5 }),
      mkAtom({ key: "mid-5", triggerEpd: "t5", rootKey: root, games: baseGames, depth: 5 }),
    ];
    const solved = exactBestForRootBounded(atoms, root, solverProtocol);
    const oracle = bruteForceBestForRoot(atoms, root, solverProtocol);
    expect(solved.best.score.stableKey).toBe(oracle.score.stableKey);
    expect(solved.best.atoms.some((atom) => atom.atomKey === "a-pick")).toBe(true);
    expect(solved.best.atoms.some((atom) => atom.atomKey === "z-pick")).toBe(false);
  });
});

describe("invalid input handling", () => {
  it("returns INVALID_INPUT for null atoms and malformed atom geometry", () => {
    expect(solveExactCandidatePackage(null, solverProtocol).status).toBe(EXACT_SOLVER_STATUSES.INVALID_INPUT);
    const bad = mkAtom({
      key: "bad",
      triggerEpd: "t",
      rootKey: "e2e4>e7e5",
      games: [{ id: "g1", day: "2023-08-01" }],
    });
    bad.rootKeys = [];
    expect(solveExactCandidatePackage([bad], solverProtocol).status).toBe(EXACT_SOLVER_STATUSES.INVALID_INPUT);
    bad.rootKeys = ["e2e4>e7e5"];
    bad.support = null;
    expect(validateEligibleAtom(bad).ok).toBe(false);
    expect(solveExactCandidatePackage([bad], solverProtocol).status).toBe(EXACT_SOLVER_STATUSES.INVALID_INPUT);
    bad.support = { distinctGames: 3, distinctDates: 2, residualLooSupport: 2 };
    bad.subjectOrdinal = Number.NaN;
    expect(solveExactCandidatePackage([bad], solverProtocol).status).toBe(EXACT_SOLVER_STATUSES.INVALID_INPUT);
  });

  it("returns INVALID_INPUT for missing, empty, or non-string atomKey without throwing", () => {
    const base = mkAtom({
      key: "good",
      triggerEpd: "t",
      rootKey: "e2e4>e7e5",
      games: [{ id: "g1", day: "2023-08-01" }],
    });
    const missing = { ...base };
    delete missing.atomKey;
    expect(() => solveExactCandidatePackage([missing], solverProtocol).status)
      .not.toThrow();
    expect(solveExactCandidatePackage([missing], solverProtocol).status)
      .toBe(EXACT_SOLVER_STATUSES.INVALID_INPUT);

    const empty = { ...base, atomKey: "" };
    expect(() => solveExactCandidatePackage([empty], solverProtocol).status)
      .not.toThrow();
    expect(solveExactCandidatePackage([empty], solverProtocol).status)
      .toBe(EXACT_SOLVER_STATUSES.INVALID_INPUT);

    const nonString = { ...base, atomKey: 42 };
    expect(() => solveExactCandidatePackage([nonString], solverProtocol).status)
      .not.toThrow();
    expect(solveExactCandidatePackage([nonString], solverProtocol).status)
      .toBe(EXACT_SOLVER_STATUSES.INVALID_INPUT);
  });
});

describe("exact solver statuses", () => {
  it("returns INFEASIBLE when exactly-six packages cannot meet deep floor", () => {
    const root = "e2e4>e7e5";
    const baseGames = [
      { id: "g1", day: "2023-08-01" },
      { id: "g2", day: "2023-08-02" },
      { id: "g3", day: "2023-08-03" },
    ];
    const atoms = Array.from({ length: 8 }, (_, i) => mkAtom({
      key: `shallow-${i}`,
      triggerEpd: `t-${i}`,
      rootKey: root,
      games: baseGames,
      ordinal: 2,
      depth: 3,
    }));
    const solved = exactBestForRootBounded(atoms, root, solverProtocol);
    expect(solved.status).toBe(EXACT_SOLVER_STATUSES.INFEASIBLE);
    expect(solved.best).toBeNull();
  });

  it("returns RESOURCE_EXHAUSTED without authoritative package and retains non-authoritative witness", () => {
    const rootA = "e2e4>e7e5";
    const rootB = "d2d4>d7d5";
    const baseGames = [
      { id: "g1", day: "2023-08-01" },
      { id: "g2", day: "2023-08-02" },
      { id: "g3", day: "2023-08-03" },
    ];
    const easy = Array.from({ length: 6 }, (_, i) => mkAtom({
      key: `easy-${i}`,
      triggerEpd: `easy-${i}`,
      rootKey: rootA,
      games: baseGames,
    }));
    const hard = Array.from({ length: 16 }, (_, i) => mkAtom({
      key: `hard-${i}`,
      triggerEpd: `hard-${i}`,
      rootKey: rootB,
      games: baseGames,
    }));
    const tight = solverProtocolWith({ exactSolverCaps: { maxTransitionsPerRoot: 200 } });
    const result = solveExactCandidatePackage([...easy, ...hard], tight);
    expect(result.status).toBe(EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED);
    expect(result.package).toBeNull();
    expect(result.diagnostics.bestSoFarNonAuthoritative?.authoritative).toBe(false);
    expect(result.diagnostics.bestSoFarNonAuthoritative?.stableKey).toBeTruthy();
  });

  it("hits maxStatesPerStage cap", () => {
    const root = "e2e4>e7e5";
    const baseGames = [
      { id: "g1", day: "2023-08-01" },
      { id: "g2", day: "2023-08-02" },
      { id: "g3", day: "2023-08-03" },
    ];
    const atoms = Array.from({ length: 12 }, (_, i) => mkAtom({
      key: `state-${i}`,
      triggerEpd: `state-t-${i}`,
      rootKey: root,
      games: baseGames,
    }));
    const tight = solverProtocolWith({ exactSolverCaps: { maxStatesPerStage: 3, maxTransitionsPerRoot: 1_000_000 } });
    const result = exactBestForRootBounded(atoms, root, tight);
    expect(result.status).toBe(EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED);
    expect(result.diagnostics.capHit?.kind).toBe("maxStatesPerStage");
  });

  it("hits maxSupportPasses cap", () => {
    const root = "e2e4>e7e5";
    const atoms = [];
    for (let i = 0; i < 10; i += 1) {
      const games = Array.from({ length: 3 + i }, (_, j) => ({
        id: `g-${i}-${j}`,
        day: `2023-08-${String(j + 1).padStart(2, "0")}`,
      }));
      atoms.push(mkAtom({
        key: `support-${i}`,
        triggerEpd: `support-t-${i}`,
        rootKey: root,
        games,
      }));
    }
    const tight = solverProtocolWith({ exactSolverCaps: { maxSupportPasses: 2, maxTransitionsPerRoot: 1_000_000, maxStatesPerStage: 1_000_000 } });
    const result = exactBestForRootBounded(atoms, root, tight);
    expect(result.status).toBe(EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED);
    expect(result.diagnostics.capHit?.kind).toBe("maxSupportPasses");
  });

  it("hits maxRoots cap against relevant roots only, ignoring tiny irrelevant roots", () => {
    const baseGames = [
      { id: "g1", day: "2023-08-01" },
      { id: "g2", day: "2023-08-02" },
      { id: "g3", day: "2023-08-03" },
    ];
    const relevant = Array.from({ length: 4 }, (_, rootIndex) => (
      Array.from({ length: 6 }, (_, i) => mkAtom({
        key: `rel-${rootIndex}-${i}`,
        triggerEpd: `rel-${rootIndex}-t-${i}`,
        rootKey: `relevant-root-${rootIndex}`,
        games: baseGames,
      }))
    )).flat();
    const irrelevant = Array.from({ length: 20 }, (_, i) => mkAtom({
      key: `tiny-${i}`,
      triggerEpd: `tiny-t-${i}`,
      rootKey: `tiny-root-${i}`,
      games: baseGames.slice(0, 1),
    }));
    const tight = solverProtocolWith({ exactSolverCaps: { maxRoots: 3 } });
    const result = solveExactCandidatePackage([...relevant, ...irrelevant], tight);
    expect(result.status).toBe(EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED);
    expect(result.package).toBeNull();
    expect(result.diagnostics.capHit?.kind).toBe("maxRoots");
    expect(result.diagnostics.rootsRelevant).toBe(4);
    expect(result.diagnostics.rootsConsidered).toBe(24);
  });

  it("counts rootsCompleted only for OPTIMAL or INFEASIBLE proofs", () => {
    const eligible = extractEligibleAtomsFromGames(supportCorpus(3), {
      color: "white",
      protocol: p0ProtocolWith(),
    });
    const result = solveExactCandidatePackage(eligible, solverProtocol);
    expect(result.status).toBe(EXACT_SOLVER_STATUSES.OPTIMAL);
    expect(result.diagnostics.rootsRelevant).toBeGreaterThan(0);
    expect(result.diagnostics.rootsCompleted).toBe(result.diagnostics.rootsRelevant);
    expect(result.diagnostics.perRoot.filter((row) => row.relevant).every((row) => (
      row.status === EXACT_SOLVER_STATUSES.OPTIMAL || row.status === EXACT_SOLVER_STATUSES.INFEASIBLE
    ))).toBe(true);
  });
});