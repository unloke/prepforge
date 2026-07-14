import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

import {
  SHADOW_PREP_COLORS,
  SHADOW_PREP_PROTOCOL_ID,
  SHADOW_PREP_STATES,
  SHADOW_PREP_VERDICTS,
  adaptV2BaselineRows,
  aggregateAtomSupport,
  assertNoForbiddenCandidateFields,
  assertShadowPrepStateTransition,
  attachSharedYToPackages,
  buildCandidatePackagesByColor,
  buildCanonicalStudyUnit,
  buildCanonicalStudyMaterials,
  buildPilotStimulusStream,
  buildPinnedSharedEngineIdentity,
  buildSharedYReceiptForAtom,
  buildShadowPrepReport,
  canTransitionShadowPrepState,
  compareMaterialBudget,
  computeShadowPrepBuildArtifactHashes,
  comparePackageLex,
  evaluateInfluenceGates,
  evaluateStimulusInfluence,
  extractEligibleAtomsFromGames,
  extractSubjectReplyAtomFromGame,
  packageMeetsCandidateGates,
  projectAtomForRoot,
  projectBuildGame,
  recomputeMaterialChecks,
  refusesShadowPrepRebuild,
  refusesShadowPrepReplay,
  refusesShadowPrepTopUp,
  resolveShadowPrepPostBuildState,
  resolveShadowPrepPostCensusState,
  resolveShadowPrepVerdict,
  scoreToWhiteCp,
  selectCandidatePackage,
  sha256ShadowPrepProtocol,
  treatmentAtomJaccard,
  validateSharedYReceipt,
  validateShadowPrepProtocol,
  validateShadowPrepReport,
  verifyPilotStimulusPartition,
  verifyShadowPrepArtifacts,
  verifyShadowPrepBuildArtifacts,
  verifyShadowPrepPinnedSources,
  verifyShadowPrepProtocolIdentity,
} from "./scout-shadow-prep-p0.js";

const protocolPath = fileURLToPath(new URL(
  "../research/scout-shadow-prep/ericrosen-shadow-prep-p0.protocol.json",
  import.meta.url,
));
const repositoryProtocol = JSON.parse(readFileSync(protocolPath, "utf8"));

function protocol(overrides = {}) {
  return {
    ...repositoryProtocol,
    candidateSelection: { ...repositoryProtocol.candidateSelection, maxSearchStates: 500000 },
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

function legalYReceipt(atom, p = protocol()) {
  const chess = new Chess(atom.postTriggerFen);
  const move = chess.moves({ verbose: true })[0];
  const uci = `${move.from}${move.to}${move.promotion || ""}`;
  const engineIdentity = buildPinnedSharedEngineIdentity(p);
  const sideToMove = atom.postTriggerFen.split(" ")[1] === "b" ? "black" : "white";
  const selectedScoreCp = scoreToWhiteCp({ type: "cp", cp: 20 }, sideToMove);
  return {
    postTriggerEpd: atom.postTriggerUserToMoveEpd,
    postTriggerFen: atom.postTriggerFen,
    userResponseUci: uci,
    safe: true,
    safetyMeasured: true,
    source: "stockfish",
    evalSwingCp: 0,
    bestScoreCp: selectedScoreCp,
    selectedScoreCp,
    multipvReturned: p.sharedYEngine.multipv,
    multipvEvidence: [{
      multipv: 1,
      score: { type: "cp", cp: 20 },
      scoreCp: selectedScoreCp,
      pvFirstMove: uci,
    }],
    searchedDepth: p.sharedYEngine.depth,
    searchedMultipv: p.sharedYEngine.multipv,
    selectedMultipv: 1,
    selectedPv: [uci],
    selectedScore: { type: "cp", cp: 20 },
    engineIdentity,
    engineIdentityKey: engineIdentity.stockfishSha256,
  };
}

function attachAll(packages, p = protocol()) {
  const receipts = {};
  for (const color of SHADOW_PREP_COLORS) {
    receipts[color] = (packages[color]?.atoms || []).map((atom) => legalYReceipt(atom, p));
  }
  return attachSharedYToPackages(packages, receipts, { protocol: p });
}

function distinctBaseline(candidate) {
  return Object.fromEntries(SHADOW_PREP_COLORS.map((color) => [color, {
    atoms: candidate[color].atoms.map((atom, index) => ({ ...atom, atomKey: `baseline-${color}-${index}` })),
  }]));
}

function pilotBlocks() {
  return ["h-m1", "h-r1", "legacy"].map((sourceBlock, blockIndex) => ({
    sourceBlock,
    blockId: `${sourceBlock}-block`,
    games: supportCorpus(4, sourceBlock).map((row, index) => ({
      ...row,
      gameId: `${sourceBlock}-${index}`,
      createdAtMs: 1_750_000_000_000 + blockIndex * 100_000_000 + index * 86_400_000,
    })),
  }));
}

describe("SHADOW-PREP projection and atom geometry", () => {
  it("drops forbidden raw fields before candidate evidence", () => {
    const projected = projectBuildGame(game("p", "white", WHITE_LINES[0], 1, {
      score: 0,
      wdl: [0, 0, 1],
      explorer: { share: 1 },
      futureHit: true,
    }));
    expect(Object.keys(projected).sort()).toEqual([
      "color", "createdAtMs", "dayKey", "gameId", "perfEligible", "speed", "ucis",
    ]);
    expect(() => assertNoForbiddenCandidateFields(projected)).not.toThrow();
    expect(() => assertNoForbiddenCandidateFields({ ...projected, weakness: 1 })).toThrow();
  });

  it("extracts a legal EPD+subject-UCI atom and rejects illegal source games", () => {
    const atom = extractSubjectReplyAtomFromGame(game("a", "white", WHITE_LINES[0], 1), { ordinal: 3 });
    expect(atom.subjectUci).toBe("f1c4");
    expect(atom.subjectOrdinal).toBe(3);
    expect(atom.pathUcis).toEqual(WHITE_LINES[0].slice(0, 5));
    expect(atom.rootKey).toBe("e2e4>e7e5");
    expect(new Chess(atom.postTriggerFen).turn()).toBe("b");
    expect(extractSubjectReplyAtomFromGame(game("bad", "white", ["c2e4"], 1), { ordinal: 2 })).toBeNull();
  });

  it("handles Black subject plies without starting a game with Black", () => {
    const atom = extractSubjectReplyAtomFromGame(game("b", "black", BLACK_LINES[0], 1), { ordinal: 3 });
    expect(atom.subjectUci).toBe("g8f6");
    expect(atom.depthHalfMoves).toBe(6);
    expect(new Chess(atom.postTriggerFen).turn()).toBe("w");
  });

  it("merges transpositions only for identical EPD+subject-UCI", () => {
    const a = extractSubjectReplyAtomFromGame(game("t1", "white", WHITE_LINES[0], 1), { ordinal: 2 });
    const b = { ...a, receipts: [{ ...a.receipts[0], gameId: "t2", dayKey: "2023-08-02", pathUcis: ["g1f3", "g8f6", "e2e4"], rootKey: "g1f3>g8f6" }] };
    const merged = aggregateAtomSupport([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].support.distinctGames).toBe(2);
    expect(merged[0].displayPaths).toHaveLength(2);
    const other = extractSubjectReplyAtomFromGame(game("t3", "white", ["e2e4", "e7e5", "b1c3"], 3), { ordinal: 2 });
    expect(other.atomKey).not.toBe(a.atomKey);
  });

  it("retains subjectOrdinal and depthHalfMoves on receipts", () => {
    const atom = extractSubjectReplyAtomFromGame(game("r", "white", WHITE_LINES[0], 1), { ordinal: 3 });
    expect(atom.receipts[0].subjectOrdinal).toBe(3);
    expect(atom.receipts[0].depthHalfMoves).toBe(5);
  });
});

describe("candidate support and exact rooted selection", () => {
  it("fails n=2 and passes n=3 with residual support 2 and two dates", () => {
    const two = [0, 1].map((i) => game(`n2-${i}`, "white", WHITE_LINES[0], i));
    expect(extractEligibleAtomsFromGames(two, { color: "white", protocol: protocol() })).toEqual([]);
    const three = [0, 1, 2].map((i) => game(`n3-${i}`, "white", WHITE_LINES[0], i));
    const eligible = extractEligibleAtomsFromGames(three, { color: "white", protocol: protocol() });
    expect(eligible.some((atom) => atom.support.distinctGames === 3 && atom.support.residualLooSupport === 2)).toBe(true);
    const sameDay = three.map((row) => ({ ...row, createdAtMs: 1_690_000_000_000 }));
    expect(extractEligibleAtomsFromGames(sameDay, { color: "white", protocol: protocol() })).toEqual([]);
  });

  it("is invariant to ignored outcomes and input order", () => {
    const p = protocol();
    const base = supportCorpus();
    const first = buildCandidatePackagesByColor(base, { protocol: p });
    const polluted = [...base].reverse().map((row, index) => ({
      ...row,
      score: index % 2,
      wdl: [index, 0, 0],
      maia: { p: index / 100 },
      eval: index * 10,
      futureHit: index % 3 === 0,
    }));
    const second = buildCandidatePackagesByColor(polluted, { protocol: p });
    expect(second.white.score.stableKey).toBe(first.white.score.stableKey);
    expect(second.black.score.stableKey).toBe(first.black.score.stableKey);
  });

  it("selects six coherent atoms and honors tree/depth gates", () => {
    const p = protocol();
    const packages = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    for (const color of SHADOW_PREP_COLORS) {
      expect(packages[color]).not.toBeNull();
      expect(packages[color].atoms).toHaveLength(6);
      expect(new Set(packages[color].atoms.map((atom) => atom.selectedRootKey)).size).toBe(1);
      expect(packageMeetsCandidateGates(packages[color].atoms, p).ok).toBe(true);
      expect(packages[color].searchDiagnostics.every((row) => row.eligibleAtoms >= 6)).toBe(true);
    }
  });

  it("compares lexicographic packages in the intended direction", () => {
    const better = { score: { atomCount: 6, ordinal3PlusCount: 4, minSupport: 3, totalSupport: 20, medianDepth: 7, stableKey: "a" } };
    const worse = { score: { atomCount: 6, ordinal3PlusCount: 3, minSupport: 99, totalSupport: 99, medianDepth: 12, stableKey: "z" } };
    expect(comparePackageLex(better, worse)).toBeGreaterThan(0);
    expect(comparePackageLex(worse, better)).toBeLessThan(0);
  });

  it("rejects off-root 2+1 support that cannot qualify under either root", () => {
    const p = protocol();
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
      support: { distinctGames: 3, distinctDates: 3, residualLooSupport: 2, gameIds: ["g1", "g2", "g3"], dayKeys: ["2023-08-01", "2023-08-02", "2023-08-03"] },
    };
    expect(projectAtomForRoot(atom, rootA, p)).toBeNull();
    expect(projectAtomForRoot(atom, rootB, p)).toBeNull();
    expect(selectCandidatePackage([atom], p)).toBeNull();
  });

  it("retains exact-search completions that lossy dominance merging would drop", () => {
    const p = protocol({ candidateSelection: { ...protocol().candidateSelection, maxSearchStates: 500000 } });
    const root = "e2e4>e7e5";
    const mk = (key, triggerEpd, games) => {
      const receipts = games.map((row) => ({
        gameId: row.id,
        dayKey: row.day,
        rootKey: root,
        pathUcis: ["e2e4", "e7e5"],
        subjectOrdinal: 3,
        depthHalfMoves: 5,
      }));
      return {
        atomKey: key,
        triggerEpd,
        triggerFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        subjectUci: key,
        postTriggerUserToMoveEpd: `post-${key}`,
        postTriggerFen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        color: "white",
        subjectOrdinal: 3,
        depthHalfMoves: 5,
        rootKeys: [root],
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
    };
    const baseGames = [
      { id: "g1", day: "2023-08-01" },
      { id: "g2", day: "2023-08-02" },
      { id: "g3", day: "2023-08-03" },
    ];
    const heavyGames = [
      ...baseGames,
      ...Array.from({ length: 47 }, (_, i) => ({
        id: `gx-${i}`,
        day: `2023-09-${String((i % 20) + 1).padStart(2, "0")}`,
      })),
    ];
    const atoms = [
      mk("branch-a", "trigger-1", baseGames),
      mk("branch-b", "trigger-1", baseGames),
      mk("pick-a", "trigger-2", baseGames),
      mk("pick-b", "trigger-2", baseGames),
      mk("anchor-low", "trigger-3", baseGames),
      mk("anchor-high", "trigger-3", heavyGames),
    ];
    const selected = selectCandidatePackage(atoms, p);
    expect(selected?.atoms?.some((atom) => atom.atomKey === "anchor-high")).toBe(true);
  });

  it("considers atoms beyond the old top-28 truncation", () => {
    const p = protocol({ candidateSelection: { ...protocol().candidateSelection, maxSearchStates: 500000 } });
    const base = extractEligibleAtomsFromGames(supportCorpus(3), { color: "white", protocol: p });
    const rootKey = "e2e4>e7e5";
    const rooted = base.filter((atom) => atom.rootKeys.includes(rootKey));
    expect(rooted.length).toBeGreaterThan(0);
    const donor = rooted[0];
    const fillers = rooted.slice(1, 9);
    const superstarReceipts = [
      ...donor.receipts,
      ...Array.from({ length: 47 }, (_, j) => ({
        ...donor.receipts[0],
        gameId: `superstar-${j}`,
        dayKey: `2024-03-${String((j % 20) + 1).padStart(2, "0")}`,
      })),
    ];
    const superstar = {
      ...donor,
      atomKey: `${donor.atomKey}|synthetic-34`,
      triggerEpd: `${donor.triggerEpd}|syn-34`,
      subjectUci: `${donor.subjectUci}|u34`,
      receipts: superstarReceipts,
      support: {
        ...donor.support,
        distinctGames: new Set(superstarReceipts.map((row) => row.gameId)).size,
        distinctDates: new Set(superstarReceipts.map((row) => row.dayKey)).size,
        residualLooSupport: new Set(superstarReceipts.map((row) => row.gameId)).size - 1,
        gameIds: [...new Set(superstarReceipts.map((row) => row.gameId))],
        dayKeys: [...new Set(superstarReceipts.map((row) => row.dayKey))],
      },
    };
    const pool = [...fillers, ...rooted.slice(9, 29), superstar];
    const selected = selectCandidatePackage(pool, p);
    expect(selected.atoms.some((atom) => atom.atomKey.endsWith("synthetic-34"))).toBe(true);
  });
});

describe("production-v2 adaptation and shared Y", () => {
  it("adapts full production paths, preserves rank, trims, and deduplicates", () => {
    const rows = supportCorpus().filter((row) => row.color === "white").slice(0, 8).map((row, index) => ({
      productionRank: index + 1,
      ucis: row.ucis.slice(0, index % 2 ? 5 : 3),
      subjectOrdinal: index % 2 ? 3 : 2,
    }));
    rows.push({ ...rows[0], productionRank: 99 });
    const adapted = adaptV2BaselineRows(rows, { color: "white", protocol: protocol() });
    expect(adapted.atoms.length).toBeLessThanOrEqual(6);
    expect(adapted.atoms.map((atom) => atom.productionRank)).toEqual([...adapted.atoms.map((atom) => atom.productionRank)].sort((a, b) => a - b));
    expect(new Set(adapted.atoms.map((atom) => atom.atomKey)).size).toBe(adapted.atoms.length);
    expect(adapted.atoms.every((atom) => atom.evidenceType === "baseline-model")).toBe(true);
  });

  it("rejects receipts missing measured safety evidence", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const atom = candidate.white.atoms[0];
    const engineIdentity = buildPinnedSharedEngineIdentity(p);
    const incomplete = legalYReceipt(atom, p);
    delete incomplete.safetyMeasured;
    expect(validateSharedYReceipt(incomplete, {
      postTriggerEpd: atom.postTriggerUserToMoveEpd,
      engineIdentity,
      protocol: p,
    }).ok).toBe(false);
  });

  it("rejects receipts with missing, negative, or non-finite evalSwingCp", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const atom = candidate.white.atoms[0];
    const engineIdentity = buildPinnedSharedEngineIdentity(p);
    const base = legalYReceipt(atom, p);
    for (const evalSwingCp of [null, -1, Number.NaN]) {
      expect(validateSharedYReceipt({ ...base, evalSwingCp }, {
        postTriggerEpd: atom.postTriggerUserToMoveEpd,
        engineIdentity,
        protocol: p,
      }).ok).toBe(false);
    }
    expect(validateSharedYReceipt({ ...base, evalSwingCp: 0 }, {
      postTriggerEpd: atom.postTriggerUserToMoveEpd,
      engineIdentity,
      protocol: p,
    }).ok).toBe(true);
  });

  it("converts mate scores to white perspective for all side/sign combinations", () => {
    expect(scoreToWhiteCp({ type: "mate", value: 2 }, "white")).toBe(9998);
    expect(scoreToWhiteCp({ type: "mate", value: 2 }, "black")).toBe(-9998);
    expect(scoreToWhiteCp({ type: "mate", value: -2 }, "white")).toBe(-9998);
    expect(scoreToWhiteCp({ type: "mate", value: -2 }, "black")).toBe(9998);
  });

  it("returns null for missing, unknown, or non-finite cp scores", () => {
    expect(scoreToWhiteCp(null, "white")).toBeNull();
    expect(scoreToWhiteCp(undefined, "black")).toBeNull();
    expect(scoreToWhiteCp({ type: "cp" }, "white")).toBeNull();
    expect(scoreToWhiteCp({ type: "cp", cp: Number.NaN }, "white")).toBeNull();
    expect(scoreToWhiteCp({ type: "unknown", cp: 10 }, "white")).toBeNull();
    expect(scoreToWhiteCp({ type: "cp", cp: 0 }, "white")).toBe(0);
    expect(scoreToWhiteCp({ type: "cp", cp: -15 }, "black")).toBe(15);
  });

  it("requires an actual multipv=1 line and rejects fallback rows", async () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const atom = candidate.white.atoms[0];
    const engineIdentity = buildPinnedSharedEngineIdentity(p);
    const chess = new Chess(atom.postTriggerFen);
    const move = chess.moves({ verbose: true })[0];
    const uci = `${move.from}${move.to}${move.promotion || ""}`;
    const fakeSf = {
      topMoves: async () => [{ multipv: 2, score: { type: "cp", cp: 35 }, pv: [uci] }],
    };
    await expect(buildSharedYReceiptForAtom(atom, fakeSf, p, engineIdentity))
      .rejects.toThrow(/multipv=1/);
  });

  it("builds measured shared-Y receipts from fake Stockfish topMoves(depth=8,multipv=5)", async () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const atom = candidate.white.atoms[0];
    const engineIdentity = buildPinnedSharedEngineIdentity(p);
    const calls = [];
    const fakeSf = {
      topMoves: async (fen, depth, multipv) => {
        calls.push({ fen, depth, multipv });
        const chess = new Chess(fen);
        const move = chess.moves({ verbose: true })[0];
        const uci = `${move.from}${move.to}${move.promotion || ""}`;
        return [{ multipv: 1, score: { type: "cp", cp: 35 }, pv: [uci, "e7e5"] }];
      },
    };
    const receipt = await buildSharedYReceiptForAtom(atom, fakeSf, p, engineIdentity);
    const sideToMove = atom.postTriggerFen.split(" ")[1] === "b" ? "black" : "white";
    const expectedScoreCp = scoreToWhiteCp({ type: "cp", cp: 35 }, sideToMove);
    expect(calls).toEqual([{ fen: atom.postTriggerFen, depth: 8, multipv: 5 }]);
    expect(receipt.evalSwingCp).toBe(0);
    expect(receipt.bestScoreCp).toBe(receipt.selectedScoreCp);
    expect(receipt.multipvReturned).toBe(1);
    expect(receipt.multipvEvidence).toEqual([{
      multipv: 1,
      score: { type: "cp", cp: 35 },
      scoreCp: expectedScoreCp,
      pvFirstMove: receipt.userResponseUci,
    }]);
    expect(receipt.searchedDepth).toBe(8);
    expect(receipt.searchedMultipv).toBe(5);
    expect(receipt.selectedMultipv).toBe(1);
    expect(receipt.safetyMeasured).toBe(true);
    expect(validateSharedYReceipt(receipt, {
      postTriggerEpd: atom.postTriggerUserToMoveEpd,
      engineIdentity,
      protocol: p,
    }).ok).toBe(true);
  });

  it("keeps PV1-selected receipts safe despite a wide PV1-vs-PV5 spread", async () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const atom = candidate.white.atoms[0];
    const engineIdentity = buildPinnedSharedEngineIdentity(p);
    const chess = new Chess(atom.postTriggerFen);
    const moves = chess.moves({ verbose: true });
    const pv1Uci = `${moves[0].from}${moves[0].to}${moves[0].promotion || ""}`;
    const pv5Uci = `${moves[1].from}${moves[1].to}${moves[1].promotion || ""}`;
    const fakeSf = {
      topMoves: async () => ([
        { multipv: 1, score: { type: "cp", cp: 220 }, pv: [pv1Uci] },
        { multipv: 5, score: { type: "cp", cp: -900 }, pv: [pv5Uci] },
      ]),
    };
    const receipt = await buildSharedYReceiptForAtom(atom, fakeSf, p, engineIdentity);
    const sideToMove = atom.postTriggerFen.split(" ")[1] === "b" ? "black" : "white";
    const pv1ScoreCp = scoreToWhiteCp({ type: "cp", cp: 220 }, sideToMove);
    const pv5ScoreCp = scoreToWhiteCp({ type: "cp", cp: -900 }, sideToMove);
    expect(receipt.userResponseUci).toBe(pv1Uci);
    expect(receipt.selectedScoreCp).toBe(pv1ScoreCp);
    expect(receipt.bestScoreCp).toBe(pv1ScoreCp);
    expect(receipt.evalSwingCp).toBe(0);
    expect(receipt.safe).toBe(true);
    expect(receipt.multipvReturned).toBe(2);
    expect(receipt.multipvEvidence).toEqual([
      { multipv: 1, score: { type: "cp", cp: 220 }, scoreCp: pv1ScoreCp, pvFirstMove: pv1Uci },
      { multipv: 5, score: { type: "cp", cp: -900 }, scoreCp: pv5ScoreCp, pvFirstMove: pv5Uci },
    ]);
    expect(validateSharedYReceipt(receipt, {
      postTriggerEpd: atom.postTriggerUserToMoveEpd,
      engineIdentity,
      protocol: p,
    }).ok).toBe(true);
  });

  it("fails closed when PV1 cp score is missing or non-finite", async () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const atom = candidate.white.atoms[0];
    const engineIdentity = buildPinnedSharedEngineIdentity(p);
    const chess = new Chess(atom.postTriggerFen);
    const move = chess.moves({ verbose: true })[0];
    const uci = `${move.from}${move.to}${move.promotion || ""}`;
    const fakeSf = {
      topMoves: async () => [{ multipv: 1, score: { type: "cp" }, pv: [uci] }],
    };
    await expect(buildSharedYReceiptForAtom(atom, fakeSf, p, engineIdentity))
      .rejects.toThrow(/cannot score PV1/);
    expect(scoreToWhiteCp({ type: "cp" }, "white")).toBeNull();
  });

  it("requires legal, FEN-bound, engine-matched Y and catches duplicate conflicts", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const atom = candidate.white.atoms[0];
    const one = { white: { ...candidate.white, atoms: [atom] }, black: { atoms: [] } };
    const good = legalYReceipt(atom, p);
    expect(attachSharedYToPackages(one, { white: [good], black: [] }, { protocol: p }).ok).toBe(true);
    expect(attachSharedYToPackages(one, { white: [{ ...good, postTriggerFen: null }], black: [] }, { protocol: p }).ok).toBe(false);
    expect(attachSharedYToPackages(one, { white: [{ ...good, safe: false }], black: [] }, { protocol: p }).ok).toBe(false);
    expect(attachSharedYToPackages(one, { white: [{ ...good, engineIdentity: { ...good.engineIdentity, depth: 99 } }], black: [] }, { protocol: p }).ok).toBe(false);
    const conflict = { ...good, userResponseUci: new Chess(atom.postTriggerFen).moves({ verbose: true })[1].from + new Chess(atom.postTriggerFen).moves({ verbose: true })[1].to };
    expect(attachSharedYToPackages(one, { white: [good, conflict], black: [] }, { protocol: p }).ok).toBe(false);
  });
});

describe("materials, pilot stimuli, and verdicts", () => {
  it("builds deterministic SAN canonical units and fails closed without SAN", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const attached = attachAll(candidate, p);
    const unit = buildCanonicalStudyMaterials(attached.packages.white)[0];
    expect(unit.sanLine).not.toBe(unit.subjectUci);
    expect(unit.sanLine).toContain(" ");
    expect(() => buildCanonicalStudyUnit({ ...attached.packages.white.atoms[0], triggerFen: null })).toThrow();
  });

  it("enforces canonical matched materials with attached shared Y", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const attachedCandidate = attachAll(candidate, p);
    expect(attachedCandidate.ok).toBe(true);
    const baseline = distinctBaseline(candidate);
    const attachedBaseline = attachAll(baseline, p);
    expect(attachedBaseline.ok).toBe(true);
    const candUnits = buildCanonicalStudyMaterials(attachedCandidate.packages.white);
    const baseUnits = buildCanonicalStudyMaterials(attachedBaseline.packages.white);
    expect(compareMaterialBudget(candUnits, baseUnits, p).ok).toBe(true);
    const extra = baseUnits.map((row, index) => index ? row : { ...row, extra: true });
    expect(compareMaterialBudget(candUnits, extra, p).ok).toBe(false);
    expect(() => buildCanonicalStudyMaterials(candidate.white)).toThrow();
  });

  it("builds the shared stream in H-M1→H-R1→legacy order with per-color diagnostics", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const stream = buildPilotStimulusStream({ candidate, baseline: candidate }, pilotBlocks(), { protocol: p });
    expect(stream.events.length).toBeGreaterThan(0);
    expect(stream.events[0].sourceBlock).toBe("h-m1");
    expect(stream.diagnostics.byColor.white.totalEvents).toBeGreaterThan(0);
    expect(stream.diagnostics.byColor.black.totalEvents).toBeGreaterThan(0);
    expect(stream.diagnostics.bySourceBlock["h-r1"]).toBeGreaterThan(0);
  });

  it("evaluates candidate and stimulus influence separately", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    expect(evaluateInfluenceGates(candidate, p).ok).toBe(true);
    const stream = buildPilotStimulusStream({ candidate, baseline: candidate }, pilotBlocks(), { protocol: p });
    const check = evaluateStimulusInfluence(stream, p);
    expect(check.ok).toBe(true);
    const thin = { events: [], diagnostics: { byColor: {}, withoutOrdinal2: {}, leaveOneSourceBlockOut: {} } };
    expect(evaluateStimulusInfluence(thin, p).ok).toBe(false);
  });

  it("fails leave-one-date influence when one date owns all but one game", () => {
    const p = protocol();
    const atom = {
      atomKey: "dom",
      support: { gameIds: ["g1", "g2", "g3"], dayKeys: ["d-heavy", "d-light"] },
      receipts: [
        { gameId: "g1", dayKey: "d-heavy" },
        { gameId: "g2", dayKey: "d-heavy" },
        { gameId: "g3", dayKey: "d-light" },
      ],
    };
    const check = evaluateInfluenceGates({ white: { atoms: [atom] }, black: { atoms: [] } }, p);
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.kind === "leave-one-date")).toBe(true);
  });

  it("rejects verdict when candidate influence is omitted and would fail", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const baseline = distinctBaseline(candidate);
    const stream = buildPilotStimulusStream({ candidate, baseline }, pilotBlocks(), { protocol: p });
    const badAtom = {
      ...candidate.white.atoms[0],
      receipts: candidate.white.atoms[0].receipts.slice(0, 1),
      support: {
        ...candidate.white.atoms[0].support,
        distinctGames: 1,
        distinctDates: 1,
        residualLooSupport: 0,
        gameIds: [candidate.white.atoms[0].receipts[0].gameId],
        dayKeys: [candidate.white.atoms[0].receipts[0].dayKey],
      },
    };
    const weakened = {
      ...candidate,
      white: { ...candidate.white, atoms: [badAtom, ...candidate.white.atoms.slice(1)] },
    };
    expect(resolveShadowPrepVerdict({
      candidatePackages: weakened,
      baselinePackages: baseline,
      materialChecks: { white: { ok: true }, black: { ok: true } },
      stimulus: stream,
      stimulusInfluence: evaluateStimulusInfluence(stream, p),
      protocol: p,
    })).toBe(SHADOW_PREP_VERDICTS.INSUFFICIENT_CANDIDATE_SUPPORT);
  });

  it("refuses tampered stored material checks during build-artifact verification", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const attached = attachAll(candidate, p);
    const baselineAttached = attachAll(distinctBaseline(candidate), p);
    const recomputed = recomputeMaterialChecks({
      candidate: attached.packages,
      baseline: baselineAttached.packages,
    }, p);
    const materials = {
      candidate: Object.fromEntries(
        SHADOW_PREP_COLORS.map((color) => [color, buildCanonicalStudyMaterials(attached.packages[color])]),
      ),
      baseline: Object.fromEntries(
        SHADOW_PREP_COLORS.map((color) => [color, buildCanonicalStudyMaterials(baselineAttached.packages[color])]),
      ),
    };
    const artifactHashes = computeShadowPrepBuildArtifactHashes({
      candidatePackages: attached.packages,
      baselinePackages: baselineAttached.packages,
      sharedYReceipts: attached.packages.white.atoms.map((atom) => atom.sharedYReceipt),
      materialChecks: recomputed,
      materials,
    });
    const manifest = {
      artifactHashes,
      materialChecks: recomputed,
    };
    const verifyOk = verifyShadowPrepBuildArtifacts(manifest, {
      candidatePackages: attached.packages,
      baselinePackages: baselineAttached.packages,
      sharedYReceipts: attached.packages.white.atoms.map((atom) => atom.sharedYReceipt),
      materialChecks: recomputed,
      materials,
    });
    expect(verifyOk.ok).toBe(true);
    const tamperedChecks = { white: { ok: false, errors: ["tampered"] }, black: recomputed.black };
    expect(verifyShadowPrepBuildArtifacts(manifest, {
      candidatePackages: attached.packages,
      baselinePackages: baselineAttached.packages,
      sharedYReceipts: attached.packages.white.atoms.map((atom) => atom.sharedYReceipt),
      materialChecks: tamperedChecks,
      materials,
    }).ok).toBe(false);
    expect(resolveShadowPrepVerdict({
      candidatePackages: attached.packages,
      baselinePackages: baselineAttached.packages,
      materialChecks: recomputed,
      stimulus: buildPilotStimulusStream({ candidate: attached.packages, baseline: baselineAttached.packages }, pilotBlocks(), { protocol: p }),
      stimulusInfluence: evaluateStimulusInfluence(
        buildPilotStimulusStream({ candidate: attached.packages, baseline: baselineAttached.packages }, pilotBlocks(), { protocol: p }),
        p,
      ),
      protocol: p,
    })).toBe(SHADOW_PREP_VERDICTS.MATERIALS_FEASIBLE);
  });

  it("resolves the locked verdict order and gates per color", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const baseline = distinctBaseline(candidate);
    const stream = buildPilotStimulusStream({ candidate, baseline }, pilotBlocks(), { protocol: p });
    const materials = { white: { ok: true }, black: { ok: true } };
    const influence = evaluateInfluenceGates(candidate, p);
    const stimulusInfluence = evaluateStimulusInfluence(stream, p);
    expect(resolveShadowPrepVerdict({ candidatePackages: candidate, baselinePackages: baseline, materialChecks: materials, stimulus: stream, influence, stimulusInfluence, protocol: p }))
      .toBe(SHADOW_PREP_VERDICTS.MATERIALS_FEASIBLE);
    expect(resolveShadowPrepVerdict({ candidatePackages: candidate, baselinePackages: candidate, materialChecks: materials, stimulus: stream, influence, stimulusInfluence, protocol: p }))
      .toBe(SHADOW_PREP_VERDICTS.INSUFFICIENT_TREATMENT_DISTINCTNESS);
    expect(resolveShadowPrepVerdict({ candidatePackages: { white: null, black: null }, baselinePackages: baseline, materialChecks: materials, stimulus: stream, protocol: p }))
      .toBe(SHADOW_PREP_VERDICTS.INSUFFICIENT_CANDIDATE_SUPPORT);
    expect(treatmentAtomJaccard(candidate.white.atoms, candidate.white.atoms)).toBe(1);
  });
});

describe("protocol, report, source, and lifecycle boundaries", () => {
  it("validates the repository protocol and canonical semantic mutation detection", () => {
    expect(validateShadowPrepProtocol(repositoryProtocol).ok).toBe(true);
    expect(verifyPilotStimulusPartition(repositoryProtocol).ok).toBe(true);
    const hash = sha256ShadowPrepProtocol(repositoryProtocol);
    expect(verifyShadowPrepProtocolIdentity(repositoryProtocol, { snapshotProtocolSha256: hash }).ok).toBe(true);
    const mutated = { ...repositoryProtocol, p0Gates: { ...repositoryProtocol.p0Gates, minPilotTrialEvents: 1 } };
    expect(verifyShadowPrepProtocolIdentity(mutated, { snapshotProtocolSha256: hash }).ok).toBe(false);
  });

  it("rejects D0 corpus overlap with burned H-M1/H-R1/legacy union", () => {
    const p = protocol();
    const source = (sha256, ids = []) => ({ sha256, data: ids.map((id) => ({ gameId: id })) });
    const hm = ["hm-0", "hm-1"];
    const hr = ["hr-0"];
    const legacy = ["le-0"];
    const d0 = ["d0-0", "hm-0"];
    const sources = {
      refDfProtocol: { content: JSON.stringify(JSON.parse(readFileSync(fileURLToPath(new URL("../research/scout-ref-df/ericrosen-ref-df-phase0.protocol.json", import.meta.url)), "utf8"))) },
      d0CorpusGames: source(p.buildPartition.refDfCorpusGames.sha256, d0),
      d0CorpusManifest: source(p.buildPartition.refDfCorpusManifest.sha256),
      d0CensusReport: source(p.buildPartition.refDfCensusReport.sha256),
      hM1Games: source(p.frozenArtifacts.hM1Games.sha256, hm),
      hM1Manifest: { sha256: p.frozenArtifacts.hM1Manifest.sha256, data: { gameIds: hm } },
      hR1Games: source(p.frozenArtifacts.hR1Games.sha256, hr),
      hR1Manifest: { sha256: p.frozenArtifacts.hR1Manifest.sha256, data: { gameIds: hr } },
      legacyGames: source(p.frozenArtifacts.legacyGames.sha256, legacy),
      maiaManifest: source(p.baselineEvidence.maiaManifest.sha256),
    };
    const check = verifyShadowPrepPinnedSources(p, { sources });
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.kind === "d0-burned-overlap")).toBe(true);
    expect(check.d0BurnedOverlap).toEqual(["hm-0"]);
  });

  it("verifies pinned descriptors, exact ID union, and overlap failure", () => {
    const p = protocol();
    const source = (sha256, ids = []) => ({ sha256, data: ids.map((id) => ({ gameId: id })) });
    const hm = Array.from({ length: 449 }, (_, i) => `hm-${i}`);
    const hr = Array.from({ length: 446 }, (_, i) => `hr-${i}`);
    const legacy = Array.from({ length: 203 }, (_, i) => `le-${i}`);
    const sources = {
      refDfProtocol: { content: JSON.stringify(JSON.parse(readFileSync(fileURLToPath(new URL("../research/scout-ref-df/ericrosen-ref-df-phase0.protocol.json", import.meta.url)), "utf8"))) },
      d0CorpusGames: source(p.buildPartition.refDfCorpusGames.sha256),
      d0CorpusManifest: source(p.buildPartition.refDfCorpusManifest.sha256),
      d0CensusReport: source(p.buildPartition.refDfCensusReport.sha256),
      hM1Games: source(p.frozenArtifacts.hM1Games.sha256, hm),
      hM1Manifest: { sha256: p.frozenArtifacts.hM1Manifest.sha256, data: { gameIds: hm } },
      hR1Games: source(p.frozenArtifacts.hR1Games.sha256, hr),
      hR1Manifest: { sha256: p.frozenArtifacts.hR1Manifest.sha256, data: { gameIds: hr } },
      legacyGames: source(p.frozenArtifacts.legacyGames.sha256, legacy),
      maiaManifest: source(p.baselineEvidence.maiaManifest.sha256),
    };
    expect(verifyShadowPrepPinnedSources(p, { sources }).ok).toBe(true);
    sources.hR1Manifest.data.gameIds[0] = hm[0];
    expect(verifyShadowPrepPinnedSources(p, { sources }).ok).toBe(false);
  });

  it("keeps report claims and authorization fail-closed", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const baseline = distinctBaseline(candidate);
    const stream = buildPilotStimulusStream({ candidate, baseline }, pilotBlocks(), { protocol: p });
    const influence = evaluateInfluenceGates(candidate, p);
    const stimulusInfluence = evaluateStimulusInfluence(stream, p);
    const report = buildShadowPrepReport({
      protocol: p,
      candidatePackages: candidate,
      baselinePackages: baseline,
      materialChecks: { white: { ok: true }, black: { ok: true } },
      stimulus: stream,
      influence,
      stimulusInfluence,
      frozenAt: "1970-01-01T00:00:00.000Z",
    });
    expect(validateShadowPrepReport(report, { protocol: p }).ok).toBe(true);
    expect(report.productVerdict).toBe("preserve-v2");
    expect(report.influenceDiagnostics).toEqual(influence);
    expect(report.stimulusInfluenceDiagnostics).toEqual(stimulusInfluence);
    expect(validateShadowPrepReport({ ...report, superiorityClaim: "wins", productAuthorization: true }, { protocol: p }).ok).toBe(false);
  });

  it("stores computed influence diagnostics when omitted from buildShadowPrepReport", () => {
    const p = protocol();
    const candidate = buildCandidatePackagesByColor(supportCorpus(), { protocol: p });
    const baseline = distinctBaseline(candidate);
    const stream = buildPilotStimulusStream({ candidate, baseline }, pilotBlocks(), { protocol: p });
    const report = buildShadowPrepReport({
      protocol: p,
      candidatePackages: candidate,
      baselinePackages: baseline,
      materialChecks: { white: { ok: true }, black: { ok: true } },
      stimulus: stream,
      frozenAt: "1970-01-01T00:00:00.000Z",
    });
    expect(report.influenceDiagnostics).toEqual(evaluateInfluenceGates(candidate, p));
    expect(report.stimulusInfluenceDiagnostics).toEqual(evaluateStimulusInfluence(stream, p));
    expect(report.influenceDiagnostics).not.toBeNull();
    expect(report.stimulusInfluenceDiagnostics).not.toBeNull();
  });

  it("refuses rebuild, replay, top-up, contamination, and duplicate census", () => {
    expect(refusesShadowPrepRebuild(SHADOW_PREP_STATES.BUILT)).toBe(true);
    expect(refusesShadowPrepReplay(SHADOW_PREP_STATES.CENSUS_COMPLETE)).toBe(true);
    expect(refusesShadowPrepTopUp(SHADOW_PREP_STATES.VERIFIED)).toBe(true);
    expect(canTransitionShadowPrepState(SHADOW_PREP_STATES.BUILDING, SHADOW_PREP_STATES.BUILT)).toBe(true);
    assertShadowPrepStateTransition(SHADOW_PREP_STATES.BUILT, SHADOW_PREP_STATES.CENSUS_COMPLETE);
    expect(resolveShadowPrepPostBuildState({ currentState: SHADOW_PREP_STATES.BUILDING }).state).toBe(SHADOW_PREP_STATES.BUILT);
    expect(resolveShadowPrepPostCensusState({ currentState: SHADOW_PREP_STATES.BUILT }).state).toBe(SHADOW_PREP_STATES.CENSUS_COMPLETE);
    const check = verifyShadowPrepArtifacts({
      state: SHADOW_PREP_STATES.CENSUS_COMPLETE,
      protocol: protocol(),
      snapshotProtocolSha256: sha256ShadowPrepProtocol(protocol()),
      censusReport: null,
      events: [{ type: "census" }, { type: "census" }],
      buildUsedStimulus: true,
    });
    expect(check.ok).toBe(false);
    expect(check.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining([
      "missing-census-report", "census-replay-forbidden", "build-stimulus-contamination",
    ]));
  });

  it("enumerates only the six locked verdicts and two colors", () => {
    expect(Object.values(SHADOW_PREP_VERDICTS)).toHaveLength(6);
    expect(SHADOW_PREP_COLORS).toEqual(["white", "black"]);
    expect(repositoryProtocol.protocolId).toBe(SHADOW_PREP_PROTOCOL_ID);
  });
});
