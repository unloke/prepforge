// I'm Feeling Lucky, database round: pull a real Lichess-database game and
// start from one of its critical positions. Pure game-shape helpers live here
// next to the small async sampler; the score itself is train-lucky-crit.js.
// No DOM. Deps (fetchStats, PGN fetch, storage) are injected so it is
// unit-testable without a network.

import { Chess } from "chess.js";

import {
  boardSnapshot,
  CRITICAL_THRESHOLD,
  divideGame,
  extractLocalFeatures,
  phaseAt,
  pickKeyIndex,
  scorePosition,
} from "./train-lucky-crit.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const LUCKY_PHASE_KEY = "prepforge.lucky_phase";
export const LUCKY_GAME_KEY = "prepforge.lucky_game_ids";
const PHASES = ["opening", "middlegame", "endgame"];
const MAX_RECENT_GAMES = 12;
// Six broad doors into the masters DB so consecutive clicks do not keep
// drawing the same e4-e5 family. The FENs are the positions AFTER the move.
// Exported for tests so mocks can serve seed-legal topGames entries.
export const LUCKY_SEED_FENS = [
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1",
  "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  "rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2",
];

function roll(rng) {
  const value = typeof rng === "function" ? rng() : Math.random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
}

function storageGet(storage, key) {
  try {
    return storage && typeof storage.getItem === "function" ? storage.getItem(key) : null;
  } catch (_) {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    if (storage && typeof storage.setItem === "function") storage.setItem(key, value);
  } catch (_) {
    // best-effort
  }
}

export function nextLuckyPhase({ storage = null, rng = Math.random } = {}) {
  const last = storageGet(storage, LUCKY_PHASE_KEY);
  if (!PHASES.includes(last)) {
    return PHASES[Math.min(PHASES.length - 1, Math.floor(roll(rng) * PHASES.length))];
  }
  // Strict rotation opening -> middlegame -> endgame -> opening keeps the three
  // buckets balanced over time; the surprise comes from which game and which
  // critical moment is drawn inside the bucket (see pickPhaseCandidate), not
  // from the bucket order itself.
  return PHASES[(PHASES.indexOf(last) + 1) % PHASES.length];
}

export function rememberLuckyPhase(phase, storage = null) {
  if (PHASES.includes(phase)) storageSet(storage, LUCKY_PHASE_KEY, phase);
}

function recentGameIds(storage) {
  try {
    const raw = storageGet(storage, LUCKY_GAME_KEY);
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch (_) {
    return [];
  }
}

export function rememberLuckyGame(gameId, storage = null) {
  if (!gameId || !storage) return;
  const ids = [String(gameId), ...recentGameIds(storage).filter((id) => id !== String(gameId))];
  storageSet(storage, LUCKY_GAME_KEY, JSON.stringify(ids.slice(0, MAX_RECENT_GAMES)));
}

/** Replay the SAN line from the start and confirm every ply reproduces. */
export function verifyReplay(sans, startFen = START_FEN) {
  const list = Array.isArray(sans) ? sans : [];
  const walked = walkSans(list, startFen);
  if (walked.length !== list.length + 1) return null;
  for (const pos of walked.slice(1)) {
    if (!pos || !pos.san || !pos.uci || !pos.fen) return null;
  }
  return walked;
}

/** Walk SAN history into per-ply {fen, ply, san, uci}; illegal tails stop short. */
export function walkSans(sans, startFen = START_FEN) {
  const chess = new Chess(startFen);
  const positions = [{ fen: chess.fen(), ply: 0, san: null, uci: null }];
  for (const san of sans || []) {
    let move = null;
    try {
      move = chess.move(String(san || "").trim());
    } catch (_) {
      break;
    }
    if (!move) break;
    positions.push({
      fen: chess.fen(),
      ply: positions.length,
      san: move.san,
      uci: move.lan || move.from + move.to + (move.promotion || ""),
    });
  }
  return positions;
}

function placementSide(fen) {
  const parts = String(fen || "").trim().split(/\s+/);
  return `${parts[0] || ""} ${parts[1] || ""}`;
}

/**
 * Cheap local pass over a fully-replayed game: lichess division first (per
 * game, not per position — see train-lucky-crit.js), then the position scorer
 * per candidate ply. Phase comes from phaseAt(ply, division); the score itself
 * never sees the phase.
 */
export function scoreGamePositions(positions, { minPly = 6, maxPlyFromEnd = 6 } = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const end = Math.max(0, list.length - maxPlyFromEnd);
  const division = divideGame(list.map((pos) => boardSnapshot(pos && pos.fen)));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const pos = list[i];
    if (!pos || !pos.fen || pos.ply < minPly || i >= end) continue;
    if (placementSide(pos.fen) === placementSide(START_FEN)) continue;
    let features = null;
    try {
      features = extractLocalFeatures(pos.fen, pos.ply);
    } catch (_) {
      continue;
    }
    out.push({
      index: out.length,
      position: pos,
      features,
      phase: phaseAt(pos.ply, division),
      score: scorePosition(features),
    });
  }
  return out;
}

export function pickPhaseCandidate(candidates, phase, { rng = Math.random, exclude = [] } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;
  const banned = new Set(
    (exclude || []).map((fen) => placementSide(fen)).filter((id) => id && id !== " "),
  );
  const fresh = (c) => !banned.has(placementSide(c.position.fen));
  const inPhase = list.filter((c) => c.phase === phase);
  const freshInPhase = inPhase.filter(fresh);
  const critical = (pool) => pool.filter((c) => c.score >= CRITICAL_THRESHOLD);
  // 1. fresh critical moments inside the target phase (the common case).
  // 2. fresh critical moments anywhere (keeps the critical gate, borrows a
  //    neighbour bucket instead of serving a quiet move).
  // 3. fresh best-effort inside the phase (short games with no critical hit).
  // 4. anything fresh; only when every candidate is banned do we recycle.
  const criticalInPhase = critical(freshInPhase);
  const criticalFresh = critical(list.filter(fresh));
  const ranked = (pool) => pool.slice().sort((a, b) => b.score - a.score).slice(0, 6);
  let shortlist = ranked(criticalInPhase);
  if (!shortlist.length) shortlist = ranked(criticalFresh);
  if (!shortlist.length) shortlist = ranked(freshInPhase);
  if (!shortlist.length) shortlist = ranked(list.filter(fresh));
  if (!shortlist.length) shortlist = ranked(list);
  if (!shortlist.length) return null;
  const idx = pickKeyIndex(
    shortlist.map((c, i) => ({ index: i, score: c.score })),
    { rng },
  );
  return shortlist[idx] || shortlist[0];
}

/**
 * Walk the masters explorer into a database-backed continuation LINE.
 *
 * The upstream `topGames[]` entry is one single next-move `uci` plus a game
 * reference (ExplorerGameWithUciMove in lila-openingexplorer's
 * src/api/response.rs) — never a full-game movetext — and masters ids are
 * fixed-width base62 OTB keys (src/model/game_id.rs), not lichess.org game
 * ids, so no single-game PGN export can resolve them. The upstream server
 * does expose one full-game route (`GET /masters/pgn/{id}` in main.rs, backed
 * by `MastersGame::write_pgn`), but it is an administrative endpoint hidden
 * behind the deploy reverse proxy — only /masters, /lichess, /player are
 * whitelisted — so the public API cannot rebuild one single tracked game.
 *
 * The sampler therefore builds what the public contract actually supports: a
 * position-by-position masters line. The topGames entry supplies the first
 * ply; every later ply is the explorer's own most-played continuation from
 * the position masters genuinely reached. Every ply is individually legal and
 * database-backed, but the assembled line may stitch plies from different
 * OTB games — call it a "master database-derived line", never "the game".
 * verifyReplay below still holds as a hard gate: an illegal or truncated
 * walk is dropped like any bad game.
 */
export function uciFen(fen, uci) {
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: String(uci || "").slice(0, 2),
      to: String(uci || "").slice(2, 4),
      promotion: String(uci || "").length > 4 ? String(uci).slice(4) : undefined,
    });
    if (!move) return null;
    return { san: move.san, fen: chess.fen(), over: chess.isGameOver() };
  } catch (_) {
    return null;
  }
}

export async function buildMasterLine({
  startFen = START_FEN,
  firstUci = null,
  fetchStats = null,
  rating,
  rng = Math.random,
  maxPly = 64,
  say = null,
} = {}) {
  const sans = [];
  const chess = new Chess(startFen);
  let over = chess.isGameOver();
  const step = (uci) => {
    try {
      const applied = chess.move({
        from: String(uci).slice(0, 2),
        to: String(uci).slice(2, 4),
        promotion: String(uci).length > 4 ? String(uci).slice(4) : undefined,
      });
      if (!applied) return false;
      sans.push(applied.san);
      over = chess.isGameOver();
      return true;
    } catch (_) {
      return false;
    }
  };
  if (firstUci) {
    if (!step(firstUci)) return null;
  }
  while (!over && sans.length < maxPly) {
    const fen = chess.fen();
    let stats = null;
    try {
      if (typeof say === "function") say("Following the master line…");
      stats = await fetchStats("masters", fen, { rating });
    } catch (_) {
      break;
    }
    const continuations = (stats && stats.moves) || [];
    if (!continuations.length) break;
    // Weighted by real master popularity with a little jitter: the masters'
    // most-played reply usually continues, but the dice occasionally take a
    // side road so consecutive clicks do not trace the same game.
    const total = continuations.reduce((sum, m) => sum + (Number(m.total) || 0), 0);
    let pick = null;
    if (total > 0 && typeof rng === "function") {
      let draw = roll(rng) * total;
      for (const move of continuations) {
        draw -= Number(move.total) || 0;
        if (draw < 0) {
          pick = move;
          break;
        }
      }
      if (!pick) pick = continuations[0];
    } else {
      pick = continuations[0];
    }
    if (!pick || !pick.uci || !step(pick.uci)) break;
  }
  if (!sans.length) return null;
  return { sans, over, startFen };
}

/** Back-compat alias: single-position UCI → SAN without game-over info. */
export function uciToSan(fen, uci) {
  const moved = uciFen(fen, uci);
  return moved ? moved.san : null;
}

/**
 * Database round for Feeling Lucky.
 *
 * 1. Pick a seed door (rng) and ask the masters explorer for its topGames.
 * 2. Walk each top-game entry's single `uci` forward through the explorer
 *    into a master database-derived continuation line (see buildMasterLine).
 *    Masters ids are OTB keys, not lichess.org game ids, so no PGN export is
 *    involved — and per the design note above the result is a legal,
 *    position-by-position masters line, not one tracked OTB game.
 * 3. Verify the SAN line fully replays from the seed position; drop any line
 *    whose tail is illegal or truncated (no partial games reach the picker).
 * 4. Divide the replayed game with lichess Divider, score every ply locally,
 *    keep the target phase's critical shortlist (critical gate enforced).
 * 5. Enrich the shortlist (<=6 explorer reads, best-effort), re-score, pick.
 * 6. Optional: one shallow Stockfish MultiPV-2 + one Maia read on the winner to
 *    confirm the swing / human-error bonus. Skipped on any failure.
 */
export async function luckyDbStart({
  phase = null,
  storage = null,
  rng = Math.random,
  exclude = [],
  rating = 1500,
  fetchStats = null,
  engine = null,
  maia = null,
  onStatus = null,
  verifyGame = verifyReplay,
  maxWalkPly = 96,
} = {}) {
  const say = (msg) => {
    if (typeof onStatus === "function") {
      try {
        onStatus(msg);
      } catch (_) {
        // ignore
      }
    }
  };
  const targetPhase = phase || nextLuckyPhase({ storage, rng });
  if (typeof fetchStats !== "function") throw new Error("Lichess explorer is unavailable");
  const bannedGames = new Set(recentGameIds(storage));
  const seeds = LUCKY_SEED_FENS.slice();
  const seedIndex = Math.min(seeds.length - 1, Math.floor(roll(rng) * seeds.length));
  const seedOrder = [seeds[seedIndex], ...seeds.filter((_, i) => i !== seedIndex)];
  let lastError = null;
  for (const seedFen of seedOrder) {
    let seed = null;
    try {
      seed = await fetchStats("masters", seedFen, { rating, topGames: 4 });
    } catch (error) {
      lastError = error;
      if (error && (error.status === 400 || error.status === 401 || error.status === 403)) break;
      continue;
    }
    const picked = await luckyDbStartFromSeed({
      seed,
      seedFen,
      targetPhase,
      rng,
      exclude,
      bannedGames,
      storage,
      rating,
      fetchStats,
      engine,
      maia,
      verifyGame,
      maxWalkPly,
      say,
    });
    if (picked) {
      rememberLuckyPhase(picked.phase, storage);
      rememberLuckyGame(picked.gameId, storage);
      return picked;
    }
  }
  if (lastError) throw lastError;
  throw new Error("No sharp database game found — try again");
}

async function luckyDbStartFromSeed({
  seed = null,
  seedFen = START_FEN,
  targetPhase,
  rng,
  exclude,
  bannedGames = new Set(),
  storage = null,
  rating,
  fetchStats,
  engine,
  maia,
  verifyGame = verifyReplay,
  maxWalkPly = 96,
  say,
}) {
  say("Asking the Lichess database for master positions…");
  const entries = (seed && seed.topGames) || [];
  if (!entries.length) return null;
  const freshFirst = entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const aSeen = bannedGames.has(String(a.entry.id)) ? 1 : 0;
      const bSeen = bannedGames.has(String(b.entry.id)) ? 1 : 0;
      if (aSeen !== bSeen) return aSeen - bSeen;
      return roll(rng) - 0.5;
    });
  for (const { entry } of freshFirst) {
    if (!entry || !entry.uci) continue;
    say("Following a master line…");
    let walk = null;
    try {
      walk = await buildMasterLine({
        startFen: seedFen,
        firstUci: entry.uci,
        fetchStats,
        rating,
        rng,
        maxPly: maxWalkPly,
        say,
      });
    } catch (_) {
      continue;
    }
    const sans = (walk && walk.sans) || [];
    if (sans.length < 4) continue;
    const verify = typeof verifyGame === "function" ? verifyGame : verifyReplay;
    const positions = verify(sans, (walk && walk.startFen) || seedFen);
    if (!positions) continue;
    const short = sans.length < 24;
    const scored = scoreGamePositions(positions, short ? { minPly: 2, maxPlyFromEnd: 1 } : {});
    if (!scored.length) continue;
    const candidate = pickPhaseCandidate(scored, targetPhase, { rng, exclude });
    if (!candidate) continue;
    const enriched = await enrichCandidate(candidate, scored, { fetchStats, rating, say });
    const confirmed = await confirmCandidate(enriched, { engine, maia, rating });
    confirmed.gameId = entry.id != null ? String(entry.id) : null;
    confirmed.sans = sans;
    confirmed.seedFen = (walk && walk.startFen) || seedFen;
    void storage;
    return confirmed;
  }
  return null;
}

async function enrichCandidate(candidate, scored, { fetchStats, rating, say }) {
  const peers = scored
    .filter((c) => c.phase === candidate.phase)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const shortlist = peers.length ? peers : [candidate];
  say("Checking which moments masters actually debated…");
  for (const row of shortlist) {
    try {
      const stats = await fetchStats("masters", row.position.fen, { rating });
      row.evidence = {
        explorer: { totalGames: stats.totalGames, moves: stats.moves },
        explorerTop: stats.moves && stats.moves[0] ? stats.moves[0].uci : null,
      };
      row.score = scorePosition(row.features, row.evidence);
    } catch (_) {
      // explorer 400/429/offline → the cheap local score stands
    }
  }
  shortlist.sort((a, b) => b.score - a.score);
  return shortlist[0] || candidate;
}

async function confirmCandidate(candidate, { engine, maia, rating }) {
  const out = toLuckyPick(candidate);
  try {
    if (engine && typeof engine.open === "function") {
      await engine.open({ fen: candidate.position.fen, multipv: 2 });
      const deadline = Date.now() + 2500;
      let snap = engine.snapshot ? engine.snapshot() : null;
      while (
        Date.now() < deadline &&
        snap &&
        (snap.running !== false || !(snap.pvs && snap.pvs.length))
      ) {
        await sleep(150);
        snap = engine.snapshot();
      }
      const swing = swingFromSnapshot(snap);
      if (swing) {
        out.evidence = { ...(out.evidence || {}), ...swing };
        out.score = scorePosition(candidate.features, {
          ...(candidate.evidence || {}),
          ...swing,
        });
        out.sharp = out.score >= 7.0;
      }
      try {
        if (typeof engine.close === "function") await engine.close();
      } catch (_) {
        // ignore
      }
    }
  } catch (_) {
    // engine unavailable → local + explorer evidence stands
  }
  try {
    if (maia && typeof maia.predictions === "function") {
      const predictions = await maia.predictions({
        fen: candidate.position.fen,
        rating,
      });
      const top = predictions && predictions[0] ? predictions[0].move_uci : null;
      if (top) {
        out.evidence = { ...(out.evidence || {}), maiaTop: top };
        out.score = scorePosition(candidate.features, {
          ...(candidate.evidence || {}),
          ...(out.evidence || {}),
        });
        out.sharp = out.score >= 7.0;
      }
    }
  } catch (_) {
    // Maia unavailable → mismatch bonus simply does not apply
  }
  return out;
}

export function swingFromSnapshot(snap) {
  const pvs = (snap && snap.pvs) || [];
  const lines = pvs.filter((pv) => pv && pv.pv_uci && pv.pv_uci.length);
  if (lines.length < 1) return null;
  const cpOf = (pv) => {
    if (pv.mate_in != null) return pv.mate_in >= 0 ? 1000 : -1000;
    return Number(pv.score_cp);
  };
  const best = lines[0];
  const bestCp = cpOf(best);
  if (!Number.isFinite(bestCp)) return null;
  const evidence = { engineBest: best.pv_uci[0] };
  if (lines.length >= 2) {
    const secondCp = cpOf(lines[1]);
    if (Number.isFinite(secondCp)) {
      evidence.swingPawns = Math.abs(bestCp - secondCp) / 100;
    }
  }
  return evidence;
}

function toLuckyPick(candidate) {
  const pos = candidate.position;
  return {
    fen: pos.fen,
    ply: pos.ply,
    phase: candidate.phase,
    score: candidate.score,
    reason: "db-critical",
    gameId: candidate.gameId || null,
    evidence: candidate.evidence || null,
    sharp: candidate.score >= 7.0,
  };
}

/** Convert one UCI movetext line (from-start) to SAN. Kept for tests. */
export function sansFromTopGameMoves(pgn, explorerMoves) {
  const raw = String(explorerMoves || "").trim();
  if (raw) {
    const sans = [];
    const chess = new Chess(START_FEN);
    let ok = true;
    for (const token of raw.split(/\s+/)) {
      const clean = token.trim();
      if (!clean) continue;
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(clean)) {
        let move = null;
        try {
          move = chess.move(clean.toLowerCase());
        } catch (_) {
          move = null;
        }
        if (!move) {
          ok = false;
          break;
        }
        sans.push(move.san);
      } else if (/^[KQRBNPa-hO0-]/i.test(clean)) {
        let move = null;
        try {
          move = chess.move(clean.replace(/[!?+#]+$/, ""));
        } catch (_) {
          move = null;
        }
        if (!move) {
          ok = false;
          break;
        }
        sans.push(move.san);
      } else {
        ok = false;
        break;
      }
    }
    if (ok && sans.length) return sans;
  }
  return sansFromPgn(pgn);
}

export function sansFromPgn(pgn) {
  const text = String(pgn || "");
  const body = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("["))
    .join(" ");
  const cleaned = body
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\$\d+/g, " ")
    .replace(/\d+\.{1,3}/g, " ")
    .replace(/\b(1-0|0-1|1\/2-1\/2)\b/g, " ")
    .replace(/\*/g, " ")
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .replace(/\s+/g, " ")
    .trim();
  const chess = new Chess(START_FEN);
  const sans = [];
  let depth = 0;
  for (const token of cleaned.split(" ").filter(Boolean)) {
    if (token === "(") {
      depth += 1;
      continue;
    }
    if (token === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    const clean = token.replace(/[!?+#]+$/, "");
    if (!clean) continue;
    // Pawn pushes ("e4") start with a file letter, not a piece letter, so the
    // SAN gate must also accept [a-h]. Castling / piece moves keep working.
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(clean) && !/^[KQRBNPa-hO0-]/i.test(clean)) {
      continue;
    }
    let move = null;
    try {
      move = chess.move(/^[a-h][1-8][a-h][1-8]/i.test(clean) ? clean.toLowerCase() : clean);
    } catch (_) {
      move = null;
    }
    if (!move) break;
    sans.push(move.san);
  }
  return sans;
}

/**
 * Legacy site-game export (lichess.org game ids only). Masters top-game ids
 * are OTB keys, not site ids, so the sampler no longer calls this — it walks
 * the explorer instead (see buildMasterLine). Kept exported for tests.
 */
export async function defaultFetchGamePgn(gameId) {
  const id = encodeURIComponent(String(gameId || ""));
  const resp = await fetch(`https://lichess.org/game/export/${id}`, {
    headers: { Accept: "application/x-chess-pgn" },
  });
  if (!resp.ok) {
    const error = new Error(`Lichess game export responded ${resp.status}`);
    error.status = resp.status;
    throw error;
  }
  return resp.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
