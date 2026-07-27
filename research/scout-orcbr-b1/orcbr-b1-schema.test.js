import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  IDENTITY_CONFIDENCE,
  FROZEN_PINS,
  VERDICTS,
  assertNoRawIdentityLeakage,
  assertOpponentKeysPresent,
  assertResearchSalt,
  chronologyTimeMs,
  dedupeGamesById,
  dualParseNdjson,
  parseGameFromJsonLegacy,
  parseGameFromJsonResearch,
  parseNdjsonGamesResearch,
  pseudonymKey,
  sortGamesChronologically,
  splitTrainAtCutoff,
  stripOutcomeFields,
  stripOutcomesDeep,
  validateProtocolLocks,
  hmacSha256Hex,
} from "./orcbr-b1-schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL = JSON.parse(
  readFileSync(join(HERE, "orcbr-b1.protocol.json"), "utf8"),
);

const SALT = "research-salt-orcbr-b1-test";
const SALT2 = "rotated-salt-different";

function ndjsonLine({
  id,
  whiteId,
  blackId,
  createdAt,
  whiteName,
  blackName,
  ai = false,
}) {
  const players = {
    white: whiteId
      ? { user: { id: whiteId, name: whiteName || whiteId } }
      : ai
        ? { user: { name: "lichess AI", aiLevel: 3 } }
        : { user: { name: whiteName || "Anon" } },
    black: blackId
      ? { user: { id: blackId, name: blackName || blackId } }
      : { user: { name: blackName || "Anon" } },
  };
  return JSON.stringify({
    id,
    createdAt,
    players,
    status: "resign",
    pgn: `[Event "Test"]\n[Site "https://lichess.org/${id}"]\n[White "${whiteId || whiteName || "W"}"]\n[Black "${blackId || blackName || "B"}"]\n[Result "1-0"]\n[UTCDate "2024.01.15"]\n\n1. e4 e5 2. Nf3 *\n`,
    ucis: ["e2e4", "e7e5", "g1f3"],
  });
}

describe("protocol locks", () => {
  it("accepts frozen protocol snapshot pins", () => {
    const v = validateProtocolLocks(PROTOCOL);
    expect(v.ok).toBe(true);
  });

  it("rejects productAuthorization true", () => {
    const v = validateProtocolLocks({ ...PROTOCOL, productAuthorization: true });
    expect(v.ok).toBe(false);
  });

  it("rejects retuned frozen pins", () => {
    const v = validateProtocolLocks({
      ...PROTOCOL,
      pins: { ...PROTOCOL.pins, g_min_white_games_per_key: 1 },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/g_min_white_games_per_key/);
  });

  it("frozen pin constants match protocol JSON", () => {
    for (const [k, expected] of Object.entries(FROZEN_PINS)) {
      expect(PROTOCOL.pins[k]).toBe(expected);
    }
  });
});

describe("HMAC pseudonym identity", () => {
  it("emits opp_ + 16 hex from HMAC-SHA256(salt, id)", () => {
    const key = pseudonymKey("AlicePlayer", SALT);
    expect(key).toMatch(/^opp_[0-9a-f]{16}$/);
    const expected = `opp_${hmacSha256Hex(SALT, "aliceplayer").slice(0, 16)}`;
    expect(key).toBe(expected);
  });

  it("salt rotation invalidates keys (deterministic separation)", () => {
    expect(pseudonymKey("AlicePlayer", SALT)).not.toBe(pseudonymKey("AlicePlayer", SALT2));
  });

  it("refuses empty and weak research salts", () => {
    expect(() => assertResearchSalt("")).toThrow(/required/);
    expect(() => assertResearchSalt("short")).toThrow(/at least/);
    expect(() => pseudonymKey("x", "tiny")).toThrow(/at least/);
  });

  it("anonymous / AI → null key + confidence none", () => {
    const obj = {
      id: "gAi",
      createdAt: 1000,
      players: {
        white: { user: { name: "lichess AI", aiLevel: 3 } },
        black: { user: { id: "subject1" } },
      },
      status: "resign",
      pgn: `[Event "Test"]\n[Site "https://lichess.org/gAi"]\n[White "lichess AI"]\n[Black "subject1"]\n[Result "1-0"]\n[UTCDate "2024.01.15"]\n\n1. e4 e5 *\n`,
      ucis: ["e2e4", "e7e5"],
    };
    const g = parseGameFromJsonResearch(obj, "subject1", {
      research: true,
      researchSalt: SALT,
    });
    expect(g.opponentKey).toBeNull();
    expect(g.identityConfidence).toBe(IDENTITY_CONFIDENCE.NONE);
  });

  it("never includes raw opponent ids in research record", () => {
    const line = ndjsonLine({
      id: "g1",
      whiteId: "OppUser",
      blackId: "subject1",
      createdAt: 1000,
    });
    const g = parseGameFromJsonResearch(JSON.parse(line), "subject1", {
      research: true,
      researchSalt: SALT,
    });
    expect(g.opponentKey).toMatch(/^opp_/);
    expect(JSON.stringify(g)).not.toMatch(/OppUser/i);
    expect(g.opponentId).toBeUndefined();
    expect(g.players).toBeUndefined();
  });

  it("name-lower fallback is marked weak confidence", () => {
    const obj = {
      id: "gName",
      createdAt: 1000,
      players: {
        white: { name: "DisplayOnlyOpp" },
        black: { user: { id: "subject1" } },
      },
      pgn: `[Event "T"]\n[Site "https://lichess.org/gName"]\n[White "DisplayOnlyOpp"]\n[Black "subject1"]\n[Result "1-0"]\n\n1. e4 e5 *\n`,
      ucis: ["e2e4", "e7e5"],
    };
    const g = parseGameFromJsonResearch(obj, "subject1", {
      research: true,
      researchSalt: SALT,
    });
    expect(g.opponentKey).toMatch(/^opp_/);
    expect(g.identityConfidence).toBe(IDENTITY_CONFIDENCE.NAME_LOWER);
  });
});

describe("legacy compatibility", () => {
  it("returns legacy shape when research not requested", () => {
    const line = ndjsonLine({
      id: "g1",
      whiteId: "OppUser",
      blackId: "subject1",
      createdAt: 1000,
    });
    const legacy = parseGameFromJsonLegacy(JSON.parse(line), "subject1");
    const viaFlag = parseGameFromJsonResearch(JSON.parse(line), "subject1", {
      research: false,
    });
    expect(viaFlag).toEqual(legacy);
    expect(viaFlag.opponentKey).toBeUndefined();
    expect(viaFlag.subjectKey).toBeUndefined();
  });
});

describe("dual-parse + sealed schema", () => {
  it("dual-parse recovers keys from local NDJSON and strips outcomes", () => {
    const text = [
      ndjsonLine({ id: "g1", whiteId: "OppA", blackId: "subject1", createdAt: 1000 }),
      ndjsonLine({ id: "g2", whiteId: "OppB", blackId: "subject1", createdAt: 2000 }),
    ].join("\n");
    const dual = dualParseNdjson(text, "subject1", SALT);
    expect(dual.schemaAvailable).toBe(true);
    expect(dual.withOpponentKeyCount).toBe(2);
    expect(dual.identityCoverage).toBe(1);
    for (const g of dual.games) {
      expect(g.score).toBeUndefined();
      expect(g.status).toBeUndefined();
      expect(g.result).toBeUndefined();
    }
  });

  it("sealed records without opponentKey → STOP_SCHEMA_UNAVAILABLE", () => {
    const sealed = [
      { gameId: "a", color: "black", ucis: ["e2e4"], createdAtMs: 1 },
      { gameId: "b", color: "black", ucis: ["d2d4"], createdAtMs: 2 },
    ];
    const r = assertOpponentKeysPresent(sealed);
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe(VERDICTS.STOP_SCHEMA_UNAVAILABLE);
  });
});

describe("chronology + outcome-blind + dedupe", () => {
  it("sorts by createdAtMs then gameId", () => {
    const games = [
      { gameId: "b", createdAtMs: 200 },
      { gameId: "a", createdAtMs: 100 },
      { gameId: "c", createdAtMs: 100 },
    ];
    const s = sortGamesChronologically(games);
    expect(s.map((g) => g.gameId)).toEqual(["a", "c", "b"]);
  });

  it("parses string datestamps for chronology", () => {
    expect(chronologyTimeMs({ datestamp: "2024.01.15" })).toBeGreaterThan(0);
    const games = [
      { gameId: "b", datestamp: "2024.02.01" },
      { gameId: "a", datestamp: "2024.01.01" },
    ];
    expect(sortGamesChronologically(games).map((g) => g.gameId)).toEqual(["a", "b"]);
  });

  it("no-lookahead: train is strictly before cutoff", () => {
    const games = [
      { gameId: "1", createdAtMs: 10 },
      { gameId: "2", createdAtMs: 20 },
      { gameId: "3", createdAtMs: 30 },
    ];
    const { train, future } = splitTrainAtCutoff(games, { cutoffIndex: 2 });
    expect(train.map((g) => g.gameId)).toEqual(["1", "2"]);
    expect(future.map((g) => g.gameId)).toEqual(["3"]);
    const byMs = splitTrainAtCutoff(games, { cutoffMs: 20 });
    expect(byMs.train.map((g) => g.gameId)).toEqual(["1"]);
    expect(byMs.future.map((g) => g.gameId)).toEqual(["2", "3"]);
  });

  it("dedupes duplicate gameIds keeping earliest", () => {
    const games = [
      { gameId: "dup", createdAtMs: 10, ucis: ["e2e4"] },
      { gameId: "dup", createdAtMs: 20, ucis: ["d2d4"] },
      { gameId: "x", createdAtMs: 15, ucis: ["c2c4"] },
    ];
    const d = dedupeGamesById(games);
    expect(d).toHaveLength(2);
    expect(d.find((g) => g.gameId === "dup").ucis).toEqual(["e2e4"]);
  });

  it("stripOutcomeFields removes score/result/winner/status/outcome", () => {
    const g = stripOutcomeFields({
      gameId: "x",
      score: 1,
      result: "1-0",
      winner: "white",
      status: "resign",
      outcome: "loss",
      opponentKey: "opp_abc",
    });
    expect(g.score).toBeUndefined();
    expect(g.result).toBeUndefined();
    expect(g.winner).toBeUndefined();
    expect(g.status).toBeUndefined();
    expect(g.outcome).toBeUndefined();
    expect(g.opponentKey).toBe("opp_abc");
  });

  it("stripOutcomesDeep removes nested outcomes before persistence", () => {
    const cleaned = stripOutcomesDeep({
      games: [{ score: 1, result: "1-0", opponentKey: "opp_x" }],
    });
    expect(cleaned.games[0].score).toBeUndefined();
    expect(cleaned.games[0].result).toBeUndefined();
  });
});

describe("raw leakage guard", () => {
  it("flags banned raw identity keys including subject", () => {
    const leak = assertNoRawIdentityLeakage({
      report: { opponentName: "secret" },
    });
    expect(leak.ok).toBe(false);
    const subj = assertNoRawIdentityLeakage({ subject: "rawUser" });
    expect(subj.ok).toBe(false);
  });

  it("allows pseudonymous opponentKey", () => {
    const leak = assertNoRawIdentityLeakage({
      unit: { opponentKey: "opp_deadbeefdeadbeef" },
    });
    expect(leak.ok).toBe(true);
  });

  it("flags known raw tokens in string values", () => {
    const leak = assertNoRawIdentityLeakage(
      { note: "played vs OppUser secretly" },
      "$",
      { knownRawTokens: ["OppUser"] },
    );
    expect(leak.ok).toBe(false);
  });
});

describe("parseNdjson multi", () => {
  it("parses multiple research games", () => {
    const text = [
      ndjsonLine({ id: "g1", whiteId: "OppA", blackId: "sub", createdAt: 1 }),
      ndjsonLine({ id: "g2", whiteId: "OppA", blackId: "sub", createdAt: 2 }),
      "not-json",
    ].join("\n");
    const games = parseNdjsonGamesResearch(text, "sub", {
      research: true,
      researchSalt: SALT,
    });
    expect(games).toHaveLength(2);
    expect(games[0].opponentKey).toBe(games[1].opponentKey);
  });
});
