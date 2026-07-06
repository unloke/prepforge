import { describe, expect, it, vi } from "vitest";

import { Chess } from "chess.js";

import { createOpeningTrie, insertGameIntoTrie } from "./scout.js";
import { ExplorerRateLimited } from "./explorer.js";
import { AUDIT_MIN_SUBJECT_CHOSE } from "./scout-route-audit.js";
import { validatePrepPackage } from "./scout-v13-package.js";
import {
  CancelledError,
  STREAM_MAX_CANDIDATES,
  makeBrowserProviders,
  runStreamV13,
  streamTrunkCandidates,
} from "./scout-v13-stream.js";

function mkGame(ucis, color, score = 1) {
  return {
    ucis,
    openingUcis: ucis,
    color,
    score,
    datestamp: 1_700_000_000_000,
    speed: "blitz",
  };
}

function seedTrie(games, color) {
  const trie = createOpeningTrie();
  const anchorTs = Date.now();
  for (const g of games) {
    insertGameIntoTrie(trie, g, color, { anchorTs, recency: false });
  }
  return trie;
}

function legalTopMoves(fen, count = 3) {
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true }).map((m) => {
    const promo = m.promotion ? m.promotion : "";
    return m.from + m.to + promo;
  });
  return legal.slice(0, count).map((moveUci, idx) => ({
    moveUci,
    evaluation: { score_cp: 40 - idx * 5, mate_in: null },
  }));
}

describe("streamTrunkCandidates", () => {
  const path = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4"];

  it("emits trunk ending on his-move anchor when next his edge fails (k=5 vs k=4)", () => {
    const games = [];
    for (let i = 0; i < 5; i += 1) {
      games.push(mkGame(path, "black"));
    }
    games.push(mkGame(["e2e4", "c7c5", "g1f3", "e7e6"], "black"));
    const trie = seedTrie(games, "black");
    const trunks = streamTrunkCandidates(trie, "black");
    expect(trunks.length).toBeGreaterThanOrEqual(1);
    const main = trunks.find((t) => t.trunkUcis.join(" ") === "e2e4 c7c5 g1f3 d7d6");
    expect(main).toBeTruthy();
    expect(main.segments.at(-1).k).toBe(5);
    expect(main.trunkUcis.at(-1)).toBe("d7d6");
  });

  it("prefix de-dup keeps the longer trunk", () => {
    const games = [];
    for (let i = 0; i < 8; i += 1) {
      games.push(mkGame(["e2e4", "c7c5", "g1f3"], "black"));
      games.push(mkGame(["e2e4", "c7c5", "g1f3", "d7d6"], "black"));
    }
    const trie = seedTrie(games, "black");
    const trunks = streamTrunkCandidates(trie, "black");
    const paths = trunks.map((t) => t.trunkUcis.join(" "));
    expect(paths).toContain("e2e4 c7c5 g1f3 d7d6");
    expect(paths).not.toContain("e2e4 c7c5 g1f3");
  });

  it("caps candidates by reachLB descending", () => {
    const games = [];
    const lines = [
      ["d2d4", "d7d5", "c2c4"],
      ["e2e4", "c7c5", "g1f3"],
      ["g1f3", "d7d6", "e2e4"],
    ];
    for (const ucis of lines) {
      for (let i = 0; i < 10; i += 1) games.push(mkGame(ucis, "black"));
    }
    const trie = seedTrie(games, "black");
    const trunks = streamTrunkCandidates(trie, "black", { maxCandidates: 2 });
    expect(trunks).toHaveLength(2);
    expect(trunks[0].reachLB).toBeGreaterThanOrEqual(trunks[1].reachLB);
  });

  it("returns empty when no his edge reaches AUDIT_MIN_SUBJECT_CHOSE", () => {
    const games = [mkGame(["e2e4", "c7c5"], "black")];
    const trie = seedTrie(games, "black");
    expect(streamTrunkCandidates(trie, "black")).toEqual([]);
    expect(AUDIT_MIN_SUBJECT_CHOSE).toBeGreaterThan(1);
  });

  it("default cap equals STREAM_MAX_CANDIDATES", () => {
    expect(STREAM_MAX_CANDIDATES).toBe(12);
  });
});

describe("makeBrowserProviders", () => {
  const trie = seedTrie(
    Array.from({ length: 6 }, () => mkGame(["e2e4", "c7c5"], "black")),
    "black",
  );

  it("flips white-POV score_cp to our perspective for black-subject", async () => {
    const providers = makeBrowserProviders({
      subjectColor: "black",
      trie,
      engineCandidates: async (fen) => [
        { moveUci: legalTopMoves(fen, 1)[0].moveUci, evaluation: { score_cp: 30, mate_in: null } },
      ],
      explorerFetch: async () => null,
    });
    const sf = await providers.sfTopMoves(["e2e4", "c7c5"]);
    expect(sf[0].evalCpOur).toBe(30);
  });

  it("flips white-POV score_cp for white-subject (we are black)", async () => {
    const whiteTrie = seedTrie(
      Array.from({ length: 6 }, () => mkGame(["e2e4", "e7e5"], "white")),
      "white",
    );
    const providers = makeBrowserProviders({
      subjectColor: "white",
      trie: whiteTrie,
      engineCandidates: async (fen) => [
        { moveUci: legalTopMoves(fen, 1)[0].moveUci, evaluation: { score_cp: 20, mate_in: null } },
      ],
      explorerFetch: async () => null,
    });
    const sf = await providers.sfTopMoves(["e2e4", "e7e5"]);
    expect(sf[0].evalCpOur).toBe(-20);
  });

  it("maps mate_in through our-perspective conversion", async () => {
    const providers = makeBrowserProviders({
      subjectColor: "black",
      trie,
      engineCandidates: async () => [
        { moveUci: "g8f6", evaluation: { score_cp: null, mate_in: 3 } },
      ],
      explorerFetch: async () => null,
    });
    const ev = await providers.auditLeafEval(["e2e4", "c7c5"]);
    expect(ev.evalCp).toBeGreaterThan(500);
  });

  it("maps explorer stats to extension shape and returns null on rate-limit", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        totalGames: 1200,
        moves: [{ uci: "g8f6", san: "Nf6", total: 400, share: 0.33 }],
      })
      .mockRejectedValueOnce(new ExplorerRateLimited(1000));
    const providers = makeBrowserProviders({
      subjectColor: "black",
      trie,
      ratingBand: "1800,2000",
      speed: "blitz",
      engineCandidates: async (fen) => legalTopMoves(fen, 3),
      explorerFetch: fetch,
    });
    const ok = await providers.explorerReplies(["e2e4", "c7c5"]);
    expect(ok.totalGames).toBe(1200);
    expect(ok.moves[0].sharePct).toBeCloseTo(33.33, 0);
    expect(ok.ratingBand).toBe("1800,2000");
    expect(await providers.explorerReplies(["e2e4"])).toBeNull();
  });

  it("personalReplies reads trie children at his-ply", async () => {
    const games = [];
    for (let i = 0; i < 6; i += 1) games.push(mkGame(["e2e4", "c7c5"], "black"));
    for (let i = 0; i < 5; i += 1) games.push(mkGame(["e2e4", "e7e5"], "black"));
    const localTrie = seedTrie(games, "black");
    const providers = makeBrowserProviders({
      subjectColor: "black",
      trie: localTrie,
      engineCandidates: async (fen) => legalTopMoves(fen, 3),
      explorerFetch: async () => null,
    });
    const replies = await providers.personalReplies(["e2e4"]);
    expect(replies.map((r) => r.uci).sort()).toEqual(["c7c5", "e7e5"]);
    expect(replies[0].games).toBeGreaterThanOrEqual(AUDIT_MIN_SUBJECT_CHOSE);
  });
});

describe("runStreamV13", () => {
  it("e2e with generous fakes yields ≥1 package passing validatePrepPackage", async () => {
    const trunkPath = ["e2e4", "c7c5", "g1f3", "d7d6"];
    const games = Array.from({ length: 8 }, () => mkGame(trunkPath, "black"));
    const trie = seedTrie(games, "black");

    const DEV_MOVE_PREF = ["b1c3", "f1e2", "e1g1", "g1f3", "c1e3"];
    const minorOnlyEngine = async (fen, count = 3) => {
      const chess = new Chess(fen);
      const legal = chess.moves({ verbose: true });
      const uciOf = (mv) => mv.from + mv.to + (mv.promotion || "");
      const m =
        DEV_MOVE_PREF.map((want) => legal.find((mv) => uciOf(mv) === want)).find(Boolean) ||
        legal.find((mv) => mv.piece === "n") ||
        legal[0];
      const uci = uciOf(m);
      return Array.from({ length: count }, (_, idx) => ({
        moveUci: uci,
        evaluation: { score_cp: 30 - idx, mate_in: null },
      }));
    };

    const explorerFetch = async (epd) => {
      try {
        const chess = new Chess(`${epd} 0 1`);
        const legal = chess.moves({ verbose: true });
        const m =
          legal.find((mv) => mv.from + mv.to === "g8f6") ||
          legal.find((mv) => mv.piece === "n") ||
          legal[0];
        if (!m) return null;
        const uci = m.from + m.to + (m.promotion || "");
        return {
          totalGames: 4000,
          moves: [{ uci, san: m.san, total: 2000, share: 0.5 }],
        };
      } catch {
        return null;
      }
    };

    const result = await runStreamV13({
      trie: seedTrie(games, "black"),
      subjectColor: "black",
      opponentRating: 1900,
      games,
      deps: {
        sfDepth: 14,
        extDepth: 12,
        speeds: "blitz",
        engineCandidates: minorOnlyEngine,
        explorerFetch,
      },
    });

    expect(result.report.packages.length).toBeGreaterThanOrEqual(1);
    const pkg = result.report.packages[0];
    const assembled = {
      entryRegion: { epd: pkg.entryEpd, ourEntryUcis: pkg.entryUcis || [] },
      trunk: pkg.trunk,
      extension: {
        mainline: pkg.extension.mainline || [],
        branches: (pkg.extension.branches || []).map((b) => b.edges || b),
      },
      style: pkg.primaryStyle,
      tendencyIds: pkg.tendencyIds || [],
      tier: null,
      riskTags: pkg.riskTags || [],
      receipts: {},
      notes: [],
    };
    expect(validatePrepPackage(assembled).ok).toBe(true);
    expect(result.meta.engineLabel).toBe("browser");
  });

  it("throws CancelledError when shouldCancel returns true", async () => {
    const games = Array.from({ length: 8 }, () =>
      mkGame(["e2e4", "c7c5", "g1f3", "d7d6"], "black"),
    );
    const trie = seedTrie(games, "black");
    let calls = 0;
    await expect(
      runStreamV13({
        trie,
        subjectColor: "black",
        games,
        deps: {
          engineCandidates: async (fen) => {
            calls += 1;
            return legalTopMoves(fen, calls > 1 ? 1 : 3);
          },
          explorerFetch: async () => null,
        },
        shouldCancel: () => calls > 2,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
  });
});