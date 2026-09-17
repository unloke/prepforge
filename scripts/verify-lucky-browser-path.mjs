import { normalizeExplorer } from "../web-src/explorer.js";
import { Chess } from "chess.js";
import {
  luckyDbStart,
  scoreGamePositions,
  verifyReplay,
} from "../web-src/train-lucky-db.js";

// Browser-path verification part 2: feed the EXACT proxy response body from
// scripts/verify-lucky-proxy.py through normalizeExplorer -> luckyDbStart,
// with book-derived explorer-shaped continuations (live per-ply needs a real
// token). Asserts every production-flow requirement per phase.

const PROXY_BODY = {
  white: 171398,
  draws: 172107,
  black: 119218,
  moves: [
    { uci: "c7c5", san: "c5", white: 61142, draws: 57738, black: 46077 },
    { uci: "e7e5", san: "e5", white: 53772, draws: 62859, black: 40482 },
  ],
  topGames: [
    {
      uci: "e7e5",
      id: "a1b2c3d4",
      winner: "white",
      white: { name: "Carlsen, Magnus", rating: 2882 },
      black: { name: "Anand, Viswanathan", rating: 2785 },
      year: 2014,
      month: "2014-11",
    },
  ],
};

const BOOK = [
  "e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7",
  "Re1", "b5", "Bb3", "d6", "c3", "O-O", "h3", "Nb8", "d4", "Nbd7",
  "c4", "c6", "Nc3", "Bb7", "Bg5", "b4", "Nb1", "h6", "Bh4", "c5",
  "dxe5", "Nxe5", "Nxe5", "dxe5", "Qxd8", "Raxd8", "Rd1", "Rxd1+",
  "Bxd1", "Bxe4", "Bxf6", "Bxf6", "Rxe4", "Rxd2", "Rxe5", "Rd5",
  "Rxd5", "cxd5", "cxd5", "c4", "bxc4", "bxc4",
];

function bookMoves(fen) {
  try {
    const legal = new Chess(fen).moves({ verbose: true });
    const out = [];
    const seen = new Set();
    for (const san of BOOK) {
      if (out.length >= 4) break;
      let uci = null;
      try {
        const p = new Chess(fen);
        const m = p.move(san);
        if (m) uci = `${m.from}${m.to}${m.promotion || ""}`;
      } catch (_) { /* illegal here */ }
      if (!uci || seen.has(uci)) continue;
      if (!legal.some((m) => `${m.from}${m.to}${m.promotion || ""}` === uci)) continue;
      seen.add(uci);
      out.push({ uci, total: 400 - out.length * 60, share: 0.25 });
    }
    return out.length ? out : legal.slice(0, 4).map((m, i) => ({
      uci: `${m.from}${m.to}${m.promotion || ""}`,
      total: 400 - i * 60,
      share: 0.25,
    }));
  } catch (_) {
    return [];
  }
}

const SEED = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

async function browserFetchStats(db, fen, opts) {
  if (fen === SEED && opts && Number(opts.topGames) > 0) {
    return normalizeExplorer(PROXY_BODY);
  }
  return { totalGames: 2000, moves: bookMoves(fen), topGames: [] };
}

const failures = [];
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures.push(name);
};

const norm = normalizeExplorer(PROXY_BODY);
check("proxy body normalizes to uci+id topGames", norm.topGames.length === 1 && norm.topGames[0].uci === "e7e5");

for (const phase of ["opening", "middlegame", "endgame"]) {
  const picked = await luckyDbStart({ phase, storage: null, rng: () => 0.2, fetchStats: browserFetchStats });
  check(`${phase}: pick returned`, !!picked);
  if (!picked) continue;
  check(`${phase}: sans legal, len>=4`, Array.isArray(picked.sans) && picked.sans.length >= 4, `${picked.sans.length} plies`);
  const replayed = verifyReplay(picked.sans, picked.seedFen);
  check(`${phase}: replay gate passes`, !!replayed && replayed.length === picked.sans.length + 1);
  check(`${phase}: FEN on line`, !!replayed && replayed.some((p) => p.fen === picked.fen));
  const phases = new Set(scoreGamePositions(replayed).map((c) => c.phase));
  check(`${phase}: phase classification`, phases.size > 0, [...phases].join(","));
  check(`${phase}: scorer gate`, picked.score >= 5.0, `score=${picked.score.toFixed(2)}`);
  check(`${phase}: Play FEN`, typeof picked.fen === "string" && picked.fen.includes(" "), picked.fen.slice(0, 40));
}

if (failures.length) {
  console.error(`\n${failures.length} BROWSER-PATH CHECKS FAILED`);
  process.exit(1);
}
console.log("\nAll browser-path checks passed.");
