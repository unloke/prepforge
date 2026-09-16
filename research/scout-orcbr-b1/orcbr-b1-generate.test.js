import { describe, expect, it } from "vitest";

import { VERDICTS, pseudonymKey } from "./orcbr-b1-schema.js";
import {
  expandCandidatesToBudget,
  generateTrainPackage,
  packageDeterminismHash,
  buildCandidateUnits,
  buildRecurringFamilies,
} from "./orcbr-b1-generate.js";

const SALT = "gen-test-salt-xx";
const OPP_A = pseudonymKey("OpponentA", SALT);
const OPP_B = pseudonymKey("OpponentB", SALT);

/** Fixture pins: opt-in relaxed floors only for synthetic structural tests. */
const FIXTURE_PINS = {
  research_min_white_games: 2,
  research_min_days: 2,
};

/** Build chronological Black-subject games vs a repeat opponent with shared openings. */
function makeBlackGames({
  opponentKey,
  n = 12,
  baseMs = 1_700_000_000_000,
  opening = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"],
  dayStrideMs = 86_400_000,
}) {
  const games = [];
  for (let i = 0; i < n; i += 1) {
    const ucis = opening.slice();
    if (i % 3 === 0 && ucis.length > 3) ucis[3] = "b8c6";
    if (i % 3 === 1 && ucis.length > 3) ucis[3] = "g8f6";
    games.push({
      gameId: `g-${opponentKey.slice(-4)}-${i}`,
      color: "black",
      opponentKey,
      identityConfidence: "id",
      createdAtMs: baseMs + i * dayStrideMs,
      dayKey: new Date(baseMs + i * dayStrideMs).toISOString().slice(0, 10),
      ucis,
      score: i % 2, // must be ignored
      result: "1-0",
    });
  }
  return games;
}

describe("recurring families + candidates", () => {
  it("finds multi-game recurring families", () => {
    const games = makeBlackGames({ opponentKey: OPP_A, n: 6 });
    const fams = buildRecurringFamilies(games, { familyPly: 4 });
    expect(fams.length).toBeGreaterThan(0);
    expect(fams[0].supportGames).toBeGreaterThanOrEqual(2);
    expect(fams[0].replyUci).toBeTruthy();
  });

  it("buildCandidateUnits only binds each unit to its opponentKey (no cross-subject pool)", () => {
    const games = [
      ...makeBlackGames({ opponentKey: OPP_A, n: 8, baseMs: 1000 }),
      ...makeBlackGames({
        opponentKey: OPP_B,
        n: 8,
        baseMs: 2000,
        opening: ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6"],
      }),
    ];
    const cands = buildCandidateUnits(games, FIXTURE_PINS);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.unit.identityPayload.opponentKey).toBe(c.opponentKey);
      expect([OPP_A, OPP_B]).toContain(c.opponentKey);
    }
  });

  it("live pins (default 30/10) refuse sparse opponents", () => {
    const games = makeBlackGames({ opponentKey: OPP_A, n: 8 });
    const cands = buildCandidateUnits(games); // frozen defaults
    expect(cands.length).toBe(0);
  });
});

describe("TRAIN package generation", () => {
  it("STOP_SCHEMA_UNAVAILABLE when sealed records lack opponentKey", () => {
    const sealed = [
      { gameId: "1", color: "black", ucis: ["e2e4", "e7e5"], createdAtMs: 1 },
      { gameId: "2", color: "black", ucis: ["e2e4", "e7e5"], createdAtMs: 2 },
    ];
    const r = generateTrainPackage(sealed);
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe(VERDICTS.STOP_SCHEMA_UNAVAILABLE);
  });

  it("identical TRAIN → identical package hash (determinism)", () => {
    const games = makeBlackGames({ opponentKey: OPP_A, n: 30 });
    const h1 = packageDeterminismHash(games, {
      requireExactFill: false,
      pins: FIXTURE_PINS,
    });
    const h2 = packageDeterminismHash(games, {
      requireExactFill: false,
      pins: FIXTURE_PINS,
    });
    expect(h1).toBeTruthy();
    expect(h1).toBe(h2);
  });

  it("can expand to budget 12 for structural fixtures", () => {
    const openings = [
      ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7"],
      ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6"],
      ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6", "c1g5", "f8e7", "e2e3", "e8g8"],
      ["c2c4", "e7e5", "b1c3", "g8f6", "g1f3", "b8c6", "g2g3", "d7d5", "c4d5", "f6d5"],
      ["e2e4", "e7e6", "d2d4", "d7d5", "b1c3", "g8f6", "c1g5", "f8e7", "e4e5", "f6d7"],
      ["g1f3", "d7d5", "d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8e7", "c1g5", "e8g8"],
    ];
    const games = [];
    openings.forEach((opening, oi) => {
      for (let i = 0; i < 4; i += 1) {
        games.push({
          gameId: `exp-${oi}-${i}`,
          color: "black",
          opponentKey: OPP_A,
          identityConfidence: "id",
          createdAtMs: 1_700_000_000_000 + (oi * 10 + i) * 86_400_000,
          dayKey: new Date(1_700_000_000_000 + (oi * 10 + i) * 86_400_000)
            .toISOString()
            .slice(0, 10),
          ucis: opening,
        });
      }
    });
    const packed = expandCandidatesToBudget(games, 12, FIXTURE_PINS);
    expect(packed.totalCost).toBeGreaterThanOrEqual(1);
    expect(packed.totalCost).toBe(12);
    expect(packed.exactFill).toBe(true);
  });

  it("ignores outcomes (score) — same package with flipped scores", () => {
    const base = makeBlackGames({ opponentKey: OPP_A, n: 20 });
    const flipped = base.map((g) => ({ ...g, score: 1 - (g.score || 0), result: "0-1", winner: "black" }));
    expect(packageDeterminismHash(base, { requireExactFill: false, pins: FIXTURE_PINS }))
      .toBe(packageDeterminismHash(flipped, { requireExactFill: false, pins: FIXTURE_PINS }));
  });

  it("no-lookahead: cutoff excludes post-t games from families", () => {
    // Early games: e4 family only. Late games: unique d4 family that must not enter pre-cut package.
    const early = makeBlackGames({
      opponentKey: OPP_A,
      n: 10,
      baseMs: 1_000_000,
      opening: ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"],
    });
    const late = makeBlackGames({
      opponentKey: OPP_A,
      n: 10,
      baseMs: 2_000_000_000_000,
      opening: ["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6"],
    });
    const all = [...early, ...late];
    const cutMs = 1_500_000_000_000;
    const pre = generateTrainPackage(all, {
      cutoffMs: cutMs,
      requireExactFill: false,
      pins: FIXTURE_PINS,
    });
    expect(pre.package).toBeTruthy();
    for (const u of pre.package.units) {
      const fam = u.identityPayload.matcher.familyEpds.join(" ");
      expect(fam).not.toMatch(/d2d4/);
    }
  });

  it("duplicate gameIds do not inflate package support", () => {
    const base = makeBlackGames({ opponentKey: OPP_A, n: 6 });
    const duped = [...base, ...base.map((g) => ({ ...g, score: 0 }))];
    const h1 = packageDeterminismHash(base, { requireExactFill: false, pins: FIXTURE_PINS });
    const h2 = packageDeterminismHash(duped, { requireExactFill: false, pins: FIXTURE_PINS });
    expect(h1).toBe(h2);
  });
});
