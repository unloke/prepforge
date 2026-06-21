// Scout v2 — pure PGN-derived statistics (no engine, no explorer).
// Games are newest-first from Lichess export; chronological helpers reverse for trends.

import { Chess } from "chess.js";
import { SLIP_MIN_GAMES, wilsonScorePct } from "./scout.js";

const MS_PER_DAY = 86_400_000;

export const COLOR_COMPARE_MIN_GAMES = 3;
export const ACTIVITY_RECENT_BUCKETS = 3;
export const PET_LINE_DEPTH = 4;
export const BREADTH_MIN_GAMES = 3;
export const FRESHNESS_RECENT_WINDOW = 20;
export const FRESHNESS_PREVIOUS_WINDOW = 20;
export const FRESHNESS_MIN_RECENT = 2;
export const SYSTEM_TAG_MIN_GAMES = 3;
export const SYSTEM_TAG_MIN_SHARE = 0.3;
export const STRONGER_DEFAULT_THRESHOLD = 100;
export const SPEED_BUCKET_MIN_GAMES = 3;

const SPEED_BUCKETS = ["bullet", "blitz", "rapid", "classical"];

export function confidence(n) {
  if (!n || n <= 0) return { level: "none", label: "no data", n: 0 };
  if (n < 5) return { level: "low", label: "low confidence", n };
  if (n < 15) return { level: "medium", label: "moderate confidence", n };
  return { level: "high", label: "high confidence", n };
}

function filterGames(games, { color = null, speedFilter = "all" } = {}) {
  let out = games || [];
  if (color) out = out.filter((g) => g.color === color);
  if (speedFilter !== "all") out = out.filter((g) => g.speed === speedFilter);
  return out;
}

function chronological(games) {
  return [...games].sort((a, b) => {
    const da = a.datestamp || 0;
    const db = b.datestamp || 0;
    if (da !== db) return da - db;
    return String(a.gameId || "").localeCompare(String(b.gameId || ""));
  });
}

function scorePct(games) {
  if (!games.length) return 0;
  const sum = games.reduce((acc, g) => acc + g.score, 0);
  return Math.round((sum / games.length) * 100);
}

function trendDirection(points) {
  if (!points || points.length < 2) return "flat";
  const mid = Math.floor(points.length / 2);
  const older = points.slice(0, mid);
  const recent = points.slice(mid);
  if (!older.length || !recent.length) return "flat";
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const delta = recentAvg - olderAvg;
  if (delta <= -5) return "down";
  if (delta >= 5) return "up";
  return "flat";
}

function shannonEntropy(shares) {
  return -shares.reduce((h, p) => (p > 0 ? h + p * Math.log2(p) : h), 0);
}

function predictabilityLabel(normalized, topShare = 0) {
  // A dominant first move reads as predictable to a human even if a thin second
  // weapon keeps normalised entropy mid-range, so let a big top share win.
  if (topShare >= 0.7 || normalized <= 0.35) return "predictable";
  if (normalized >= 0.75) return "unpredictable";
  return "mixed";
}

function concentrationLabel(top3Share) {
  if (top3Share >= 0.7) return "concentrated";
  if (top3Share <= 0.4) return "spread";
  return "moderate";
}

function linePathKey(game, depth = PET_LINE_DEPTH) {
  const plies = Math.min(depth, game.ucis?.length || 0);
  if (!plies) return "";
  return game.ucis.slice(0, plies).join(">");
}

function opponentSans(game) {
  const start = game.color === "white" ? 0 : 1;
  const out = [];
  for (let i = start; i < (game.sans?.length || 0); i += 2) out.push(game.sans[i]);
  return out;
}

function castlingPly(sans, color) {
  const start = color === "white" ? 0 : 1;
  for (let i = start; i < sans.length; i += 2) {
    const san = sans[i];
    if (san === "O-O-O") return { side: "queenside", ply: Math.floor(i / 2) + 1 };
    if (san === "O-O") return { side: "kingside", ply: Math.floor(i / 2) + 1 };
  }
  return { side: "uncastled", ply: null };
}

function bothQueensOffBoard(chess) {
  const board = chess.board();
  let whiteQueen = false;
  let blackQueen = false;
  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      if (piece.type === "q" && piece.color === "w") whiteQueen = true;
      if (piece.type === "q" && piece.color === "b") blackQueen = true;
    }
  }
  return !whiteQueen && !blackQueen;
}

function queensTradedPly(game) {
  const ucis = game.ucis || [];
  if (!ucis.length) return null;
  const chess = new Chess();
  for (let i = 0; i < ucis.length; i += 1) {
    const uci = ucis[i];
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch (_) {
      break;
    }
    if (bothQueensOffBoard(chess)) return Math.floor(i / 2) + 1;
  }
  return null;
}

function aggressionScore(opponentMoves) {
  const window = opponentMoves.slice(0, 8);
  if (!window.length) return 0;
  let raw = 0;
  for (const san of window) {
    if (/\+/.test(san)) raw += 2;
    if (/x/.test(san)) raw += 1;
    if (/^[a-h][45]/.test(san)) raw += 1;
  }
  return Math.min(100, Math.round((raw / window.length) * 18));
}

function detectSystemSetup(sans, color) {
  const moves = opponentSans({ sans, color }).slice(0, 8).map((s) => s.replace(/[+#]/g, "").toLowerCase());
  const joined = moves.join("|");
  if (color === "white") {
    if (joined.includes("d4") && (joined.includes("bf4") || joined.includes("nf3")) && joined.includes("e3")) {
      return "london";
    }
    if (joined.includes("nf3") && joined.includes("g3") && joined.includes("bg2")) return "kia";
    if (joined.includes("d4") && joined.includes("e3") && joined.includes("bd3")) return "colle";
  } else {
    const qsideFianchetto = joined.includes("b6") && joined.includes("bb7");
    const ksideFianchetto = joined.includes("g6") && joined.includes("bg7");
    const closedCenter = joined.includes("d6") && joined.includes("e6");
    const avoidsOpenBreaks = !joined.includes("e5") && !joined.includes("c5") && !joined.includes("d5");
    if (qsideFianchetto && ksideFianchetto && closedCenter && avoidsOpenBreaks) return "hippo";
  }
  return null;
}

function modeLabel(counts) {
  let best = null;
  for (const [label, count] of counts) {
    if (!best || count > best.count) best = { label, count };
  }
  return best;
}

function rollingScoreSeries(games, window) {
  const ordered = chronological(games);
  const w = Math.max(1, window);
  const points = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const slice = ordered.slice(Math.max(0, i - w + 1), i + 1);
    points.push(scorePct(slice));
  }
  return points;
}

// First-move opening families for one colour, ranked worst-first.
export function scoreByFamily(games, color, { speedFilter = "all", recentWindow = 5 } = {}) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.ucis?.length);
  if (!filtered.length) {
    return {
      families: [],
      baseline: 0,
      games: 0,
      confidence: confidence(0),
    };
  }

  const byFirst = new Map();
  for (const game of filtered) {
    const key = game.ucis[0];
    if (!byFirst.has(key)) {
      byFirst.set(key, { uci: key, san: game.sans[0], games: [] });
    }
    byFirst.get(key).games.push(game);
  }

  const total = filtered.length;
  const families = [...byFirst.values()]
    .map((entry) => {
      const n = entry.games.length;
      const w = entry.games.filter((g) => g.score === 1).length;
      const d = entry.games.filter((g) => g.score === 0.5).length;
      const l = entry.games.filter((g) => g.score === 0).length;
      const recentTrend = rollingScoreSeries(entry.games, recentWindow);
      return {
        uci: entry.uci,
        san: entry.san,
        games: n,
        scorePct: scorePct(entry.games),
        wilsonScorePct: wilsonScorePct(w, d, l),
        share: n / total,
        w,
        d,
        l,
        recentTrend,
        trend: trendDirection(recentTrend),
        confidence: confidence(n),
      };
    })
    .filter((f) => f.games >= SLIP_MIN_GAMES);

  families.sort((a, b) => a.wilsonScorePct - b.wilsonScorePct || b.games - a.games);

  return {
    families,
    baseline: scorePct(filtered),
    games: total,
    confidence: confidence(total),
  };
}

// Rolling score sparkline for recent form (chronological left → right).
export function formTrend(games, window = 10, { color = null, speedFilter = "all" } = {}) {
  const filtered = filterGames(games, { color, speedFilter });
  const points = rollingScoreSeries(filtered, window);
  return {
    points,
    window: Math.max(1, window),
    games: filtered.length,
    confidence: confidence(filtered.length),
    trend: trendDirection(points),
  };
}

export function ratingTrajectory(games, { color = null, speedFilter = "all" } = {}) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.rating > 0);
  const ordered = chronological(filtered);
  const points = ordered.map((g) => ({ datestamp: g.datestamp, rating: g.rating }));
  const ratings = points.map((p) => p.rating);
  const min = ratings.length ? Math.min(...ratings) : null;
  const max = ratings.length ? Math.max(...ratings) : null;
  let trend = "flat";
  if (ratings.length >= 2) {
    const delta = ratings[ratings.length - 1] - ratings[0];
    if (delta <= -20) trend = "down";
    else if (delta >= 20) trend = "up";
  }
  return {
    points,
    games: points.length,
    min,
    max,
    trend,
    confidence: confidence(points.length),
  };
}

export function activitySeries(
  games,
  { color = null, speedFilter = "all", bucketDays = 7, recentBuckets = ACTIVITY_RECENT_BUCKETS } = {},
) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.datestamp > 0);
  const bucketMs = Math.max(1, bucketDays) * MS_PER_DAY;
  const counts = new Map();
  for (const game of filtered) {
    const key = Math.floor(game.datestamp / bucketMs);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const buckets = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, count]) => ({
      datestamp: key * bucketMs,
      count,
    }));

  const windowSize = Math.max(1, recentBuckets);
  let recentWindow = [];
  if (filtered.length) {
    const newest = Math.max(...filtered.map((g) => g.datestamp));
    const endKey = Math.floor(newest / bucketMs);
    for (let i = windowSize - 1; i >= 0; i -= 1) {
      const key = endKey - i;
      recentWindow.push({
        datestamp: key * bucketMs,
        count: counts.get(key) || 0,
      });
    }
  }
  const recentGames = recentWindow.reduce((n, b) => n + b.count, 0);
  const sparkBuckets = recentWindow.length ? recentWindow : buckets;
  const max = sparkBuckets.length ? Math.max(...sparkBuckets.map((b) => b.count), 1) : 0;

  return {
    buckets,
    recentWindow,
    recentGames,
    recentBuckets: windowSize,
    bucketDays: Math.max(1, bucketDays),
    games: filtered.length,
    max,
    confidence: confidence(filtered.length),
  };
}

function insufficientColorComparison(wN, bN) {
  return {
    insufficient: true,
    pick: null,
    whiteGames: wN,
    blackGames: bN,
    confidence: confidence(Math.min(wN || 0, bN || 0)),
  };
}

export function colorRecommendation(games) {
  const white = filterGames(games, { color: "white" });
  const black = filterGames(games, { color: "black" });
  const wN = white.length;
  const bN = black.length;
  if (!wN && !bN) return null;

  if (wN < COLOR_COMPARE_MIN_GAMES || bN < COLOR_COMPARE_MIN_GAMES) {
    return insufficientColorComparison(wN, bN);
  }

  const wScore = scorePct(white);
  const bScore = scorePct(black);

  if (wScore < bScore - 3) {
    return {
      pick: "black",
      theirWeakColor: "white",
      weakScore: wScore,
      otherScore: bScore,
      confidence: confidence(Math.min(wN, bN)),
    };
  }
  if (bScore < wScore - 3) {
    return {
      pick: "white",
      theirWeakColor: "black",
      weakScore: bScore,
      otherScore: wScore,
      confidence: confidence(Math.min(wN, bN)),
    };
  }
  return {
    pick: null,
    theirWeakColor: null,
    weakScore: Math.min(wScore, bScore),
    otherScore: Math.max(wScore, bScore),
    confidence: confidence(Math.min(wN, bN)),
  };
}

// First-move entropy: low = guessable, high = varied.
export function predictability(games, color, { speedFilter = "all" } = {}) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.ucis?.length);
  if (!filtered.length) {
    return {
      entropy: 0,
      normalized: 0,
      label: "mixed",
      topMove: null,
      moves: [],
      games: 0,
      confidence: confidence(0),
    };
  }

  const counts = new Map();
  for (const game of filtered) {
    const key = game.ucis[0];
    if (!counts.has(key)) counts.set(key, { uci: key, san: game.sans[0], games: 0 });
    counts.get(key).games += 1;
  }
  const total = filtered.length;
  const moves = [...counts.values()]
    .map((entry) => ({
      uci: entry.uci,
      san: entry.san,
      games: entry.games,
      share: entry.games / total,
    }))
    .sort((a, b) => b.games - a.games);

  // Mouse-slip / one-off first moves (e.g. a single 1.d3 meant for 1.d4) would
  // otherwise inflate the entropy and mislabel a predictable player as "mixed".
  const significant = moves.filter((m) => m.games >= SLIP_MIN_GAMES);
  const entropyMoves = significant.length > 1 ? significant : moves;
  const sigTotal = entropyMoves.reduce((s, m) => s + m.games, 0) || 1;
  const shares = entropyMoves.map((m) => m.games / sigTotal);
  const entropy = shannonEntropy(shares);
  const maxEntropy = entropyMoves.length > 1 ? Math.log2(entropyMoves.length) : 1;
  const normalized = entropyMoves.length > 1 ? entropy / maxEntropy : 0;
  const topShare = moves[0]?.share || 0;

  return {
    entropy: Math.round(entropy * 100) / 100,
    normalized: Math.round(normalized * 100) / 100,
    label: entropyMoves.length > 1 ? predictabilityLabel(normalized, topShare) : "predictable",
    topMove: moves[0] || null,
    moves,
    games: total,
    confidence: confidence(total),
  };
}

// Share of games falling into the three most-played opening paths.
export function petLineConcentration(games, color, { speedFilter = "all", depth = PET_LINE_DEPTH } = {}) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.ucis?.length);
  if (!filtered.length) {
    return {
      top3Share: 0,
      top3SharePct: 0,
      label: "moderate",
      lines: [],
      games: 0,
      confidence: confidence(0),
    };
  }

  const counts = new Map();
  for (const game of filtered) {
    const key = linePathKey(game, depth);
    if (!key) continue;
    if (!counts.has(key)) {
      counts.set(key, { pathKey: key, sans: game.sans.slice(0, depth), ucis: game.ucis.slice(0, depth), games: 0 });
    }
    counts.get(key).games += 1;
  }

  const total = filtered.length;
  const lines = [...counts.values()]
    .map((entry) => ({
      ...entry,
      share: entry.games / total,
    }))
    .sort((a, b) => b.games - a.games);

  const top3Share = lines.slice(0, 3).reduce((sum, line) => sum + line.share, 0);
  return {
    top3Share,
    top3SharePct: Math.round(top3Share * 100),
    label: concentrationLabel(top3Share),
    lines: lines.slice(0, 6),
    games: total,
    confidence: confidence(total),
  };
}

// Distinct first moves with at least minGames samples.
export function repertoireBreadth(games, color, { speedFilter = "all", minGames = BREADTH_MIN_GAMES } = {}) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.ucis?.length);
  if (!filtered.length) {
    return {
      breadth: 0,
      moves: [],
      minGames,
      games: 0,
      confidence: confidence(0),
    };
  }

  const counts = new Map();
  for (const game of filtered) {
    const key = game.ucis[0];
    if (!counts.has(key)) counts.set(key, { uci: key, san: game.sans[0], games: 0 });
    counts.get(key).games += 1;
  }

  const total = filtered.length;
  const moves = [...counts.values()]
    .map((entry) => ({
      uci: entry.uci,
      san: entry.san,
      games: entry.games,
      share: entry.games / total,
    }))
    .filter((entry) => entry.games >= minGames)
    .sort((a, b) => b.games - a.games);

  return {
    breadth: moves.length,
    moves,
    minGames,
    games: total,
    confidence: confidence(total),
  };
}

// First-move families that show up in the recent window but not the previous one.
export function repertoireFreshness(
  games,
  color,
  {
    speedFilter = "all",
    recentWindow = FRESHNESS_RECENT_WINDOW,
    previousWindow = FRESHNESS_PREVIOUS_WINDOW,
    minRecent = FRESHNESS_MIN_RECENT,
  } = {},
) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.ucis?.length);
  const recent = filtered.slice(0, recentWindow);
  const previous = filtered.slice(recentWindow, recentWindow + previousWindow);

  if (!recent.length) {
    return {
      recentWindow,
      previousWindow,
      freshFamilies: [],
      games: filtered.length,
      confidence: confidence(0),
    };
  }

  const countFamilies = (slice) => {
    const counts = new Map();
    for (const game of slice) {
      const key = game.ucis[0];
      if (!counts.has(key)) counts.set(key, { uci: key, san: game.sans[0], games: 0 });
      counts.get(key).games += 1;
    }
    return counts;
  };

  const recentCounts = countFamilies(recent);
  const previousCounts = countFamilies(previous);
  const freshFamilies = [];

  for (const [uci, entry] of recentCounts) {
    const previousGames = previousCounts.get(uci)?.games || 0;
    if (entry.games >= minRecent && previousGames === 0) {
      freshFamilies.push({
        uci,
        san: entry.san,
        recentGames: entry.games,
        previousGames,
        recentShare: entry.games / recent.length,
      });
    }
  }

  freshFamilies.sort((a, b) => b.recentGames - a.recentGames || b.recentShare - a.recentShare);

  const recentLineCounts = new Map();
  const previousLineCounts = new Map();
  for (const game of recent) {
    const key = linePathKey(game, PET_LINE_DEPTH);
    if (!key) continue;
    if (!recentLineCounts.has(key)) {
      recentLineCounts.set(key, {
        pathKey: key,
        sans: game.sans.slice(0, PET_LINE_DEPTH),
        ucis: game.ucis.slice(0, PET_LINE_DEPTH),
        games: 0,
        newestDatestamp: 0,
      });
    }
    const row = recentLineCounts.get(key);
    row.games += 1;
    if (game.datestamp > row.newestDatestamp) row.newestDatestamp = game.datestamp;
  }
  for (const game of previous) {
    const key = linePathKey(game, PET_LINE_DEPTH);
    if (!key) continue;
    previousLineCounts.set(key, (previousLineCounts.get(key) || 0) + 1);
  }

  const freshLines = [];
  for (const [key, entry] of recentLineCounts) {
    const previousGames = previousLineCounts.get(key) || 0;
    if (entry.games >= minRecent && previousGames === 0) {
      freshLines.push({
        ...entry,
        previousGames,
        recentShare: entry.games / recent.length,
      });
    }
  }
  freshLines.sort((a, b) => b.games - a.games || b.newestDatestamp - a.newestDatestamp);

  return {
    recentWindow,
    previousWindow,
    freshFamilies,
    freshLines: freshLines.slice(0, 6),
    games: filtered.length,
    confidence: confidence(recent.length),
  };
}

export function lineLastSeen(games, pathUcis, { color = null, speedFilter = "all" } = {}) {
  const filtered = filterGames(games, { color, speedFilter });
  let newest = 0;
  let count = 0;
  for (const game of filtered) {
    if (!game.ucis?.length || game.ucis.length < pathUcis.length) continue;
    if (!pathUcis.every((uci, i) => game.ucis[i] === uci)) continue;
    count += 1;
    if (game.datestamp > newest) newest = game.datestamp;
  }
  if (!count) return { games: 0, lastDatestamp: null, daysAgo: null };
  const daysAgo =
    newest > 0 ? Math.max(0, Math.round((Date.now() - newest) / MS_PER_DAY)) : null;
  return { games: count, lastDatestamp: newest || null, daysAgo };
}

export function formatLastSeenLabel(lastSeen) {
  if (!lastSeen?.lastDatestamp) return "no recent games";
  const days = lastSeen.daysAgo;
  if (days === 0) return "last played today";
  if (days === 1) return "last played yesterday";
  if (days != null && days < 14) return `last played ${days} days ago`;
  const date = new Date(lastSeen.lastDatestamp);
  const month = date.toLocaleString("en", { month: "long" });
  return `not since ${month}`;
}

// How concentrated vs experimental their first-move mix is over chronological chunks.
export function repertoireChangeTrend(
  games,
  color,
  { speedFilter = "all", buckets = 6 } = {},
) {
  const filtered = filterGames(games, { color, speedFilter }).filter(
    (g) => g.ucis?.length && g.datestamp > 0,
  );
  if (filtered.length < buckets) {
    return { points: [], trend: "flat", games: filtered.length, confidence: confidence(0) };
  }
  const ordered = chronological(filtered);
  const chunkSize = Math.max(1, Math.floor(ordered.length / buckets));
  const points = [];
  for (let i = 0; i < buckets; i += 1) {
    const slice = ordered.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!slice.length) continue;
    const counts = new Map();
    for (const game of slice) {
      const key = game.ucis[0];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const shares = [...counts.values()].map((c) => c / slice.length);
    const entropy = shannonEntropy(shares);
    const maxEntropy = shares.length > 1 ? Math.log2(shares.length) : 1;
    const concentration = shares.length > 1 ? 1 - entropy / maxEntropy : 1;
    points.push(Math.round(concentration * 100));
  }
  return {
    points,
    trend: trendDirection(points),
    games: filtered.length,
    confidence: confidence(filtered.length),
  };
}

function aggressionLabel(score) {
  if (score >= 60) return "aggressive";
  if (score <= 25) return "passive";
  return "balanced";
}

function tradeSpeedLabel(ply) {
  if (ply == null) return "complicator";
  if (ply <= 8) return "simplifier";
  if (ply >= 14) return "complicator";
  return "balanced";
}

function castlingLabel(side, ply) {
  if (side === "uncastled") return "uncastled";
  if (ply != null && ply >= 12) return "late";
  return side;
}

export function personaTags(games, color, { speedFilter = "all" } = {}) {
  const filtered = filterGames(games, { color, speedFilter }).filter((g) => g.sans?.length);
  if (!filtered.length) {
    return {
      aggression: { score: 0, label: "balanced" },
      tradeSpeed: { label: "balanced", queenOffPly: null },
      castling: { label: "uncastled", side: "uncastled", ply: null },
      systemSetup: { label: null, detected: false },
      games: 0,
      confidence: confidence(0),
    };
  }

  let aggressionTotal = 0;
  const castlingCounts = new Map();
  const tradeCounts = new Map();
  const systemCounts = new Map();
  let castlingPlySum = 0;
  let castlingPlyCount = 0;
  let queenPlySum = 0;
  let queenPlyCount = 0;

  for (const game of filtered) {
    const oppMoves = opponentSans(game);
    const agg = aggressionScore(oppMoves);
    aggressionTotal += agg;

    const castle = castlingPly(game.sans, game.color);
    const castleLabel = castlingLabel(castle.side, castle.ply);
    castlingCounts.set(castleLabel, (castlingCounts.get(castleLabel) || 0) + 1);
    if (castle.ply != null) {
      castlingPlySum += castle.ply;
      castlingPlyCount += 1;
    }

    const queenPly = queensTradedPly(game);
    const tradeLabel = tradeSpeedLabel(queenPly);
    tradeCounts.set(tradeLabel, (tradeCounts.get(tradeLabel) || 0) + 1);
    if (queenPly != null) {
      queenPlySum += queenPly;
      queenPlyCount += 1;
    }

    const system = detectSystemSetup(game.sans, game.color);
    if (system) systemCounts.set(system, (systemCounts.get(system) || 0) + 1);
  }

  const aggressionScoreAvg = Math.round(aggressionTotal / filtered.length);
  const topCastle = modeLabel(castlingCounts);
  const topTrade = modeLabel(tradeCounts);
  const topSystem = modeLabel(systemCounts);
  const systemDetected =
    topSystem &&
    topSystem.count >= SYSTEM_TAG_MIN_GAMES &&
    topSystem.count / filtered.length >= SYSTEM_TAG_MIN_SHARE;

  return {
    aggression: {
      score: aggressionScoreAvg,
      label: aggressionLabel(aggressionScoreAvg),
    },
    tradeSpeed: {
      label: topTrade?.label || "balanced",
      queenOffPly: queenPlyCount ? Math.round(queenPlySum / queenPlyCount) : null,
    },
    castling: {
      label: topCastle?.label || "uncastled",
      side: topCastle?.label === "late" || topCastle?.label === "uncastled"
        ? topCastle.label
        : topCastle?.label || "uncastled",
      ply: castlingPlyCount ? Math.round(castlingPlySum / castlingPlyCount) : null,
    },
    systemSetup: {
      label: systemDetected ? topSystem.label : null,
      detected: Boolean(systemDetected),
    },
    games: filtered.length,
    confidence: confidence(filtered.length),
  };
}

function bucketScore(games) {
  return {
    games: games.length,
    scorePct: scorePct(games),
    confidence: confidence(games.length),
  };
}

export function scoreVsStronger(
  games,
  { color = null, speedFilter = "all", threshold = STRONGER_DEFAULT_THRESHOLD } = {},
) {
  const filtered = filterGames(games, { color, speedFilter });
  const stronger = [];
  const equalOrLower = [];
  let excluded = 0;

  for (const game of filtered) {
    if (!game.rating || !game.opponentRating) {
      excluded += 1;
      continue;
    }
    const gap = game.opponentRating - game.rating;
    if (gap >= threshold) stronger.push(game);
    else if (gap <= 0) equalOrLower.push(game);
    else excluded += 1;
  }

  const ratedGames = stronger.length + equalOrLower.length;
  return {
    threshold,
    stronger: bucketScore(stronger),
    equalOrLower: bucketScore(equalOrLower),
    excluded,
    games: filtered.length,
    confidence: confidence(ratedGames),
  };
}

export function scoreBySpeed(games, { color = null, speedFilter = "all", minGames = SPEED_BUCKET_MIN_GAMES } = {}) {
  const filtered = filterGames(games, { color, speedFilter });
  const buckets = {};
  for (const speed of SPEED_BUCKETS) {
    const slice = filtered.filter((g) => g.speed === speed);
    buckets[speed] = {
      speed,
      ...bucketScore(slice),
    };
  }

  const eligible = SPEED_BUCKETS.map((speed) => buckets[speed]).filter((b) => b.games >= minGames);
  const weakest =
    eligible.length > 0
      ? eligible.reduce((a, b) => (a.scorePct <= b.scorePct ? a : b))
      : null;

  return {
    buckets,
    weakest: weakest
      ? { speed: weakest.speed, games: weakest.games, scorePct: weakest.scorePct }
      : null,
    minGames,
    games: filtered.length,
  };
}

export function buildScoutStats(games, { color, speedFilter = "all" } = {}) {
  return {
    oppColor: color,
    scoreByFamily: scoreByFamily(games, color, { speedFilter }),
    activitySeries: activitySeries(games, { color, speedFilter }),
    predictability: predictability(games, color, { speedFilter }),
    petLineConcentration: petLineConcentration(games, color, { speedFilter }),
    repertoireBreadth: repertoireBreadth(games, color, { speedFilter }),
    repertoireFreshness: repertoireFreshness(games, color, { speedFilter }),
    repertoireChangeTrend: repertoireChangeTrend(games, color, { speedFilter }),
    personaTags: personaTags(games, color, { speedFilter }),
  };
}