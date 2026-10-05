import { describe, expect, it } from "vitest";

import { AUDIT_MIN_SUBJECT_CHOSE } from "./scout-route-audit.js";
import { validateEvidenceEdge } from "./scout-v13-package.js";
import {
  EXT_FORK_MAX_REPLIES,
  EXT_MAX_LEAVES,
  EXT_TARGET_PLY,
  EXT_TARGET_PLY_FORCING,
  assembleHisForkCandidates,
  buildExtension,
  selectFactualCohortReplies,
  selectPersonalReply,
} from "./scout-v13-extension.js";

const EXPLORER_DEFAULT = {
  totalGames: 1000,
  ratingBand: "1800-2000",
  speed: "blitz",
};

function key(ucis) {
  return ucis.join(" ");
}

/** Deterministic providers keyed by UCI path prefix. */
function makeProviders(spec) {
  return {
    sfTopMoves: async (ucis) => spec.sf[key(ucis)] ?? spec.sf.default ?? [],
    explorerReplies: async (ucis) => spec.explorer[key(ucis)] ?? spec.explorer.default ?? null,
    personalReplies: async (ucis) => spec.personal[key(ucis)] ?? spec.personal.default ?? [],
  };
}

function soundOur(uci, evalCpOur = 25, gapToBestCp = 10) {
  return { uci, evalCpOur, gapToBestCp };
}

function cohortMove(uci, games, sharePct) {
  return { uci, games, sharePct };
}

function personalMove(uci, games) {
  return { uci, games, wins: games - 1, draws: 0, losses: 1 };
}

function allEdgesValid(edges) {
  for (const edge of edges) {
    const result = validateEvidenceEdge(edge);
    expect(result.ok, result.errors.join("; ")).toBe(true);
  }
}

describe("selectFactualCohortReplies + selectPersonalReply", () => {
  it("includes cohort replies until 70% coverage", () => {
    const explorer = {
      ...EXPLORER_DEFAULT,
      moves: [
        cohortMove("e7e5", 400, 50),
        cohortMove("c7c5", 300, 30),
        cohortMove("e7e6", 100, 10),
      ],
    };
    const picked = selectFactualCohortReplies(explorer);
    expect(picked.map((m) => m.uci)).toEqual(["e7e5", "c7c5"]);
  });

  it("includes low-share reply when games >= 50", () => {
    const explorer = {
      ...EXPLORER_DEFAULT,
      moves: [cohortMove("g8f6", 60, 5), cohortMove("d7d6", 10, 2)],
    };
    const picked = selectFactualCohortReplies(explorer);
    expect(picked).toHaveLength(1);
    expect(picked[0].uci).toBe("g8f6");
  });

  it("selectPersonalReply requires AUDIT_MIN_SUBJECT_CHOSE games", () => {
    expect(selectPersonalReply([personalMove("e7e5", AUDIT_MIN_SUBJECT_CHOSE - 1)])).toBeNull();
    expect(selectPersonalReply([personalMove("e7e5", AUDIT_MIN_SUBJECT_CHOSE)])?.uci).toBe("e7e5");
  });
});

describe("buildExtension", () => {
  it("happy path: anchor ply 6 extends mainline to ply 14 with valid sources", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const ourMoves = ["f3d4", "c1e3", "f1e2", "e1g1"];
    const hisMoves = ["g8f6", "e7e5", "f8e7", "e8g8"];

    const providers = {
      sfTopMoves: async (ucis) => {
        const len = ucis.length;
        if (len % 2 === 0) {
          const uci = ourMoves[(len - anchor.length) / 2] ?? ourMoves[ourMoves.length - 1];
          return [soundOur(uci, 30 - len, 5)];
        }
        const hisUci = hisMoves[(len - anchor.length - 1) / 2] ?? hisMoves[hisMoves.length - 1];
        return [
          { uci: hisUci, evalCpOur: 20, gapToBestCp: 0 },
          { uci: "tactic1", evalCpOur: -40, gapToBestCp: 60 },
        ];
      },
      explorerReplies: async (ucis) => {
        if (ucis.length % 2 === 0) return null;
        const hisUci = hisMoves[(ucis.length - anchor.length - 1) / 2] ?? hisMoves[hisMoves.length - 1];
        return {
          ...EXPLORER_DEFAULT,
          moves: [cohortMove(hisUci, 200, 55)],
        };
      },
      personalReplies: async () => [],
    };

    const result = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "solid" },
      providers,
    );

    expect(result.ok).toBe(true);
    expect(anchor.length + result.mainline.length).toBeGreaterThanOrEqual(EXT_TARGET_PLY);
    expect(result.mainline.length).toBe(8);

    for (let i = 0; i < result.mainline.length; i += 1) {
      const edge = result.mainline[i];
      const isOurPly = i % 2 === 0;
      if (isOurPly) {
        expect(edge.evidenceSource).toBe("engine");
        expect(edge.receipts.gapToBestCp).toBeDefined();
      } else {
        expect(edge.evidenceSource).toBe("cohort");
      }
    }

    allEdgesValid(result.mainline);
    for (const branch of result.branches) {
      allEdgesValid(branch.edges);
    }
  });

  it("prefers personal reply over cohort when games >= AUDIT_MIN_SUBJECT_CHOSE", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const nodeKey = key(anchor);

    const providers = makeProviders({
      sf: {
        default: [soundOur("f3d4"), { uci: "e7e5", evalCpOur: 15, gapToBestCp: 0 }],
      },
      explorer: {
        [nodeKey]: {
          ...EXPLORER_DEFAULT,
          moves: [cohortMove("g8f6", 500, 60)],
        },
      },
      personal: {
        [nodeKey]: [personalMove("e7e5", AUDIT_MIN_SUBJECT_CHOSE)],
      },
    });

    const { candidates } = await assembleHisForkCandidates(anchor, providers);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("personal");
    expect(candidates[0].uci).toBe("e7e5");

    const lowPersonal = makeProviders({
      sf: { default: [soundOur("f3d4")] },
      explorer: {
        [nodeKey]: {
          ...EXPLORER_DEFAULT,
          moves: [cohortMove("g8f6", 500, 60)],
        },
      },
      personal: {
        [nodeKey]: [personalMove("e7e5", AUDIT_MIN_SUBJECT_CHOSE - 1)],
      },
    });
    const { candidates: cohortPick } = await assembleHisForkCandidates(anchor, lowPersonal);
    expect(cohortPick[0].kind).toBe("cohort");
    expect(cohortPick[0].uci).toBe("g8f6");
  });

  it("stops the line when cohort replies fail coverage and games rules", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const nodeKey = key(anchor);

    const providers = makeProviders({
      sf: {
        default: [soundOur("f3d4"), soundOur("c1e3"), soundOur("f1e2"), soundOur("e1g1")],
        [key([...anchor, "f3d4"])]: [soundOur("c1e3")],
      },
      explorer: {
        [nodeKey]: {
          ...EXPLORER_DEFAULT,
          moves: [cohortMove("a7a6", 10, 8), cohortMove("b7b6", 8, 6)],
        },
      },
      personal: { default: [] },
    });

    const result = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "solid" },
      providers,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tooShort");
    expect(result.mainline).toHaveLength(1);
    expect(result.mainline[0].evidenceSource).toBe("engine");
  });

  it("forces tactical engine reply into fork over second cohort reply", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const nodeKey = key(anchor);

    const providers = makeProviders({
      sf: {
        [nodeKey]: [
          { uci: "g8f6", evalCpOur: 20, gapToBestCp: 0 },
          { uci: "b8c6", evalCpOur: 18, gapToBestCp: 2 },
          { uci: "trapmove", evalCpOur: -50, gapToBestCp: 70 },
        ],
        default: [soundOur("f3d4")],
      },
      explorer: {
        [nodeKey]: {
          ...EXPLORER_DEFAULT,
          moves: [
            cohortMove("g8f6", 400, 45),
            cohortMove("b8c6", 350, 40),
          ],
        },
      },
      personal: { default: [] },
    });

    const { candidates } = await assembleHisForkCandidates(anchor, providers);
    expect(candidates).toHaveLength(EXT_FORK_MAX_REPLIES);
    expect(candidates[0].kind).toBe("cohort");
    expect(candidates[0].uci).toBe("g8f6");
    expect(candidates[1].kind).toBe("engine");
    expect(candidates[1].uci).toBe("trapmove");
  });

  it("returns soundnessFail when all our moves exceed gap threshold; sharp uses 20cp", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const gap25 = [{ uci: "f3d4", evalCpOur: 10, gapToBestCp: 25 }];
    const gap35 = [{ uci: "f3d4", evalCpOur: 10, gapToBestCp: 35 }];

    const solidPass = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "solid" },
      makeProviders({
        sf: {
          [key(anchor)]: gap25,
          default: [soundOur("c1e3")],
        },
        explorer: {
          [key([...anchor, "f3d4"])]: {
            ...EXPLORER_DEFAULT,
            moves: [cohortMove("g8f6", 200, 50)],
          },
        },
        personal: { default: [] },
      }),
    );
    expect(solidPass.ok).toBe(true);
    expect(solidPass.mainline[0].uci).toBe("f3d4");

    const sharpFail = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "sharp" },
      makeProviders({
        sf: { default: gap25 },
        explorer: { default: null },
        personal: { default: [] },
      }),
    );
    expect(sharpFail.ok).toBe(false);
    expect(sharpFail.reason).toBe("soundnessFail");

    const solidFail = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "solid" },
      makeProviders({
        sf: { default: gap35 },
        explorer: { default: null },
        personal: { default: [] },
      }),
    );
    expect(solidFail.ok).toBe(false);
    expect(solidFail.reason).toBe("soundnessFail");
  });

  it("returns endpointEval when final eval is below -20cp", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const ourMoves = ["f3d4", "c1e3", "f1e2", "e1g1"];
    const hisMoves = ["g8f6", "e7e5", "f8e7", "e8g8"];

    const providers = {
      sfTopMoves: async (ucis) => {
        const len = ucis.length;
        if (len % 2 === 0) {
          const idx = (len - anchor.length) / 2;
          const uci = ourMoves[idx] ?? ourMoves[ourMoves.length - 1];
          const evalCp = idx === ourMoves.length - 1 ? -30 : 25;
          return [{ uci, evalCpOur: evalCp, gapToBestCp: 5 }];
        }
        const hisUci = hisMoves[(len - anchor.length - 1) / 2] ?? hisMoves[hisMoves.length - 1];
        return [{ uci: hisUci, evalCpOur: 20, gapToBestCp: 0 }];
      },
      explorerReplies: async (ucis) => {
        if (ucis.length % 2 === 0) return null;
        const hisUci = hisMoves[(ucis.length - anchor.length - 1) / 2] ?? hisMoves[hisMoves.length - 1];
        return { ...EXPLORER_DEFAULT, moves: [cohortMove(hisUci, 200, 55)] };
      },
      personalReplies: async () => [],
    };

    const result = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "solid" },
      providers,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("endpointEval");
    expect(result.endpointEvalCp).toBe(-30);
  });

  it("respects EXT_MAX_LEAVES when every fork offers two replies", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const ourSeq = ["f3d4", "c1e3", "f1e2", "e1g1", "d4e5", "d1d4", "a1d1", "h2h3"];
    const hisPrimary = ["g8f6", "e7e5", "f8e7", "e8g8", "f6e4", "e5d4", "e7d6", "g8h8"];
    const hisAlt = ["b8c6", "b7b6", "c8b7", "d8c7", "c6e5", "f7f6", "c7d6", "h8g8"];

    const providers = {
      sfTopMoves: async (ucis) => {
        const extIdx = Math.max(0, Math.floor((ucis.length - anchor.length) / 2));
        if (ucis.length % 2 === 0) {
          return [soundOur(ourSeq[extIdx] ?? ourSeq[ourSeq.length - 1], 20, 5)];
        }
        const primary = hisPrimary[Math.floor((ucis.length - anchor.length - 1) / 2)] ?? "g8f6";
        const alt = hisAlt[Math.floor((ucis.length - anchor.length - 1) / 2)] ?? "b8c6";
        return [
          { uci: primary, evalCpOur: 15, gapToBestCp: 0 },
          { uci: alt, evalCpOur: 14, gapToBestCp: 1 },
        ];
      },
      explorerReplies: async (ucis) => {
        if (ucis.length % 2 === 0) return null;
        const idx = Math.floor((ucis.length - anchor.length - 1) / 2);
        const primary = hisPrimary[idx] ?? "g8f6";
        const alt = hisAlt[idx] ?? "b8c6";
        return {
          ...EXPLORER_DEFAULT,
          moves: [
            cohortMove(primary, 300, 45),
            cohortMove(alt, 250, 35),
          ],
        };
      },
      personalReplies: async () => [],
    };

    const result = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "solid" },
      providers,
    );

    expect(result.ok).toBe(true);
    expect(result.leafCount).toBeLessThanOrEqual(EXT_MAX_LEAVES);
    expect(result.branches.length).toBeLessThanOrEqual(EXT_MAX_LEAVES - 1);
  });

  it("returns tooShort when anchor is already at targetPly - 1", async () => {
    const anchor = Array.from({ length: EXT_TARGET_PLY - 1 }, (_, i) => `m${i}`);
    const result = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "solid" },
      makeProviders({ sf: { default: [] }, explorer: { default: null }, personal: { default: [] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tooShort");
  });

  it("forcing style extends to EXT_TARGET_PLY_FORCING", async () => {
    const anchor = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"];
    const ourMoves = Array.from({ length: 6 }, (_, i) => `our${i}`);
    const hisMoves = Array.from({ length: 6 }, (_, i) => `his${i}`);

    const providers = {
      sfTopMoves: async (ucis) => {
        const len = ucis.length;
        if (len % 2 === 0) {
          const uci = ourMoves[(len - anchor.length) / 2] ?? "ourX";
          return [soundOur(uci, 25, 5)];
        }
        const hisUci = hisMoves[(len - anchor.length - 1) / 2] ?? "hisX";
        return [{ uci: hisUci, evalCpOur: 20, gapToBestCp: 0 }];
      },
      explorerReplies: async (ucis) => {
        if (ucis.length % 2 === 0) return null;
        const hisUci = hisMoves[(ucis.length - anchor.length - 1) / 2] ?? "hisX";
        return { ...EXPLORER_DEFAULT, moves: [cohortMove(hisUci, 200, 55)] };
      },
      personalReplies: async () => [],
    };

    const result = await buildExtension(
      { anchorUcis: anchor, subjectColor: "black", style: "forcing" },
      providers,
    );

    expect(result.ok).toBe(true);
    expect(anchor.length + result.mainline.length).toBeGreaterThanOrEqual(EXT_TARGET_PLY_FORCING);
    expect(result.mainline.length).toBe(EXT_TARGET_PLY_FORCING - anchor.length);
  });
});