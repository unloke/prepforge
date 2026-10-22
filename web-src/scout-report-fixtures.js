// Scout game records and repertoire lookups shared by the scout-report test files.
import * as scoutModule from "./scout.js";

export function scoutGameRecord(game) {
  const ucis = game.ucis || [];
  return {
    opponentRating: 1700,
    openingUcis: ucis,
    openingSans: game.sans || [],
    openingEndPly: ucis.length,
    totalPly: ucis.length,
    clockAfterPly: ucis.map(() => null),
    timeControl: null,
    nextOwnThinkSeconds: [],
    ...game,
  };
}

export const GAMES = [
  scoutGameRecord({
    color: "white",
    score: 1,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 3000,
    speed: "blitz",
  }),
  scoutGameRecord({
    color: "white",
    score: 0,
    sans: ["e4", "c5", "Nf3"],
    ucis: ["e2e4", "c7c5", "g1f3"],
    rating: 1800,
    datestamp: 2000,
    speed: "blitz",
  }),
  scoutGameRecord({
    color: "white",
    score: 1,
    sans: ["d4", "d5"],
    ucis: ["d2d4", "d7d5"],
    rating: 1800,
    datestamp: 1000,
    speed: "blitz",
  }),
];

export const PLAN_GAMES = [
  ...Array.from({ length: 8 }, (_, i) =>
    scoutGameRecord({
      color: "white",
      score: 0,
      sans: ["e4", "c5", "Nf3"],
      ucis: ["e2e4", "c7c5", "g1f3"],
      rating: 1800,
      datestamp: 4000 - i * 100,
      speed: "blitz",
      gameId: `sicilian-${i}`,
    }),
  ),
  ...Array.from({ length: 7 }, (_, i) =>
    scoutGameRecord({
      color: "white",
      score: 1,
      sans: ["d4", "d5", "c4"],
      ucis: ["d2d4", "d7d5", "c2c4"],
      rating: 1800,
      datestamp: 3000 - i * 100,
      speed: "blitz",
      gameId: `london-${i}`,
    }),
  ),
];

export const LOOKUPS = {
  white: [],
  black: [
    {
      rep: { id: "rep-black", name: "Sicilian" },
      lookup: scoutModule.repertoireChildLookup([
        { id: "root", depth: 0, parent_id: null, uci: null },
        { id: "n1", depth: 1, parent_id: "root", uci: "e2e4" },
      ]),
    },
  ],
};
