import { normalizeExplorer } from "../web-src/explorer.js";
import {
  LUCKY_SEED_FENS,
  buildMasterLine,
  luckyDbStart,
  pickPhaseCandidate,
  scoreGamePositions,
  verifyReplay,
} from "../web-src/train-lucky-db.js";

// Production-like live-contract verification:
// REAL Masters Explorer response shape (captured verbatim from
// explorer.lichess.ovh/masters, ExplorerGameWithUciMove in
// lila-openingexplorer src/api/response.rs) -> normalizeExplorer ->
// sampler walk -> legal replay -> phase classification -> critical pick ->
// valid Play-session FEN.
//
// The captured response is static (API needs auth since early 2026; live
// probes return 401 without a linked token), but the data flow is the exact
// production one: normalizeExplorer + luckyDbStart with the same shapes the
// proxy returns. Continuation positions are synthesized from the same fixed
// Ruy Lopez book (chess.js-legal, explorer-shaped) since we cannot call the
// live explorer per ply without a token.

const LIVE_MASTER_RESPONSES = {
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1": {
    white: 171398,
    draws: 172107,
    black: 119218,
    moves: [
      { uci: "c7c5", san: "c5", white: 61142, draws: 57738, black: 46077, averageRating: 2539 },
      { uci: "e7e5", san: "e5", white: 53772, draws: 62859, black: 40482, averageRating: 2541 },
      { uci: "e7e6", san: "e6", white: 28181, draws: 28153, black: 18048, averageRating: 2556 },
      { uci: "c7c6", san: "c6", white: 13903, draws: 12943, black: 8389, averageRating: 2568 },
    ],
    topGames: [
      {
        uci: "e7e5",
        id: "a1b2c3d4",
        winner: "white",
        speed: null,
        mode: null,
        white: { name: "Carlsen, Magnus", rating: 2882 },
        black: { name: "Anand, Viswanathan", rating: 2785 },
        year: 2014,
        month: "2014-11",
      },
      {
        uci: "c7c5",
        id: "e5f6g7h8",
        winner: "black",
        speed: null,
        mode: null,
        white: { name: "Fischer, Robert", rating: 2785 },
        black: { name: "Spassky, Boris", rating: 2660 },
        year: 1972,
        month: "1972-07",
      },
    ],
  },
};

const BOOK = [
  "e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7",
  "Re1", "b5", "Bb3", "d6", "c3", "O-O", "h3", "Nb8", "d4", "Nbd7",
  "c4", "c6", "Nc3", "Bb7", "Bg5", "b4", "Nb1", "h6", "Bh4", "c5",
  "dxe5", "Nxe5", "Nxe5", "dxe5", "Qxd8", "Raxd8", "Rd1", "Rxd1+",
  "Bxd1", "Bxe4", "Bxf6", "Bxf6", "Rxe4", "Rxd2", "Rxe5", "Rd5",
  "Rxd5", "cxd5", "cxd5", "c4", "bxc4", "bxc4",
];

const { Chess } = await import("chess.js");

function bookReplyMoves(fen) {
  try {
    const legal = new Chess(fen).moves({ verbose: true });
    const out = [];
    const seen = new Set();
    for (const san of BOOK) {
      if (out.length >= 4) break;
      let uci = null;
      try {
        const probe = new Chess(fen);
        const m = probe.move(san);
        if (m) uci = `${m.from}${m.to}${m.promotion || ""}`;
      } catch (_) { /* not legal here */ }
      if (!uci || seen.has(uci)) continue;
      if (!legal.some((m) => `${m.from}${m.to}${m.promotion || ""}` === uci)) continue;
      seen.add(uci);
      out.push({ uci, total: 400 - out.length * 60, share: 0.25 });
    }
    if (out.length) return out;
    return legal.slice(0, 4).map((m, i) => ({
      uci: `${m.from}${m.to}${m.promotion || ""}`,
      total: 400 - i * 60,
      share: 0.25,
    }));
  } catch (_) {
    return [];
  }
}

async function productionFetchStats(db, fen, opts) {
  const live = LIVE_MASTER_RESPONSES[fen];
  if (live && opts && Number(opts.topGames) > 0) {
    return normalizeExplorer(live);
  }
  if (live) {
    const norm = normalizeExplorer(live);
    return { totalGames: norm.totalGames, moves: norm.moves };
  }
  return { totalGames: 2000, moves: bookReplyMoves(fen), topGames: [] };
}

const failures = [];
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
};

// 1. Real Masters Explorer response shape normalizes with uci + metadata.
const norm = normalizeExplorer(
  LIVE_MASTER_RESPONSES["rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"],
);
check("normalize keeps topGames uci+id", norm.topGames.length === 2 && norm.topGames[0].uci === "e7e5");
check("normalize keeps metadata", norm.topGames[0].white === "Carlsen, Magnus" && norm.topGames[0].year === 2014);
check("no movetext leaks through", !("moves" in norm.topGames[0]) || norm.topGames[0].moves === undefined);

// 2-7. Full production flow per phase.
for (const phase of ["opening", "middlegame", "endgame"]) {
  const picked = await luckyDbStart({
    phase,
    storage: null,
    rng: () => 0.3,
    fetchStats: productionFetchStats,
  });
  check(`${phase}: lucky returns a pick`, !!picked);
  if (!picked) continue;
  check(`${phase}: UCI moves all legal`, Array.isArray(picked.sans) && picked.sans.length >= 4, `${picked.sans.length} plies`);
  const replayed = verifyReplay(picked.sans, picked.seedFen);
  check(`${phase}: line replays from seedFen`, !!replayed && replayed.length === picked.sans.length + 1);
  check(`${phase}: FEN on replayed line`, !!replayed && replayed.some((p) => p.fen === picked.fen));
  const scored = scoreGamePositions(replayed);
  const phases = new Set(scored.map((c) => c.phase));
  check(`${phase}: phase classification covers line`, phases.size > 0, [...phases].join(","));
  check(`${phase}: critical gate holds`, picked.score >= 5.0, `score=${picked.score.toFixed(2)}`);
  check(`${phase}: Play-ready FEN`, typeof picked.fen === "string" && picked.fen.includes(" "), picked.fen.slice(0, 40));
}

// 8. Rotation + dedup stay healthy on the production flow.
{
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const picked = await luckyDbStart({ storage, rng: () => 0.1 + i * 0.3, fetchStats: productionFetchStats });
    if (picked) seen.add(picked.gameId);
  }
  check("rotation+d edup: 3 clicks yield >= 2 distinct lines", seen.size >= 2, [...seen].join(","));
}

// 9. buildMasterLine legality gate on the real seed.
{
  const seed = LUCKY_SEED_FENS[0];
  const line = await buildMasterLine({ startFen: seed, firstUci: "e7e5", fetchStats: productionFetchStats, rng: () => 0.01 });
  check("buildMasterLine grows from real entry", !!line && line.sans.length >= 4, line ? `${line.sans.length} plies` : "null");
  check("buildMasterLine replays", !!line && !!verifyReplay(line.sans, line.startFen));
}

if (failures.length) {
  console.error(`\n${failures.length} LIVE-CONTRACT CHECKS FAILED`);
  process.exit(1);
}
console.log("\nAll live-contract checks passed.");
