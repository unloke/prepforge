// Opponent scouting: fetch a Lichess player's recent games (public PGN export,
// CORS-open, no token), aggregate their opening tendencies per colour, and grade
// the user's own repertoires against the lines that opponent actually plays.
//
// Everything runs in the browser — the PrepForge server is never involved in the
// fetch or the number-crunching. Parsing keeps deeper moves for weakness/engine
// analysis while the display trie still caps at MAX_PLIES.
//
// Pure functions + an injected-deps fetcher, unit-testable without network/DOM.

import { Chess } from "chess.js";

import { gamePhase } from "./coach/material.js";

export const SCOUT_ERR_RATE_LIMIT =
  "Lichess rate limit — please wait a minute and try again.";
export const SCOUT_ERR_NO_GAMES =
  "No games found for this player with the selected filters.";
export const SCOUT_ERR_NETWORK = "Could not reach Lichess. Check your connection.";

/** Map fetch-layer errors to user-facing Scout messages. */
export function scoutFetchErrorMessage(error) {
  if (error instanceof TypeError) return SCOUT_ERR_NETWORK;
  const msg = error?.message || "";
  if (/rate limit/i.test(msg)) return SCOUT_ERR_RATE_LIMIT;
  return null;
}
export const MAX_PLIES = 16; // opening book depth for the display trie
export const ANALYZE_PLIES = 24; // deeper capture for weakness / engine scan
/** Minimum games for game-plan lines (ranking filters slips; no hard ply gate). */
export const GAME_PLAN_MIN_GAMES = 1;
/** Max game-plan rows shown per colour. The floor is gone, so the cap (not n≥7)
 * is what keeps the list readable and bounds the Maia enrichment cost. */
export const SCOUT_GAME_PLAN_LIMIT = 12;
/** Legacy floor kept for recommendTargets / refutation repertoire gates. */
export const WEAKNESS_MIN_GAMES = 7;
export const SLIP_MIN_GAMES = 3;

export const SCOUT_RECENCY_HALF_LIFE_DAYS = 90;
export const SCOUT_LENGTH_SATURATION_PLIES = 40;
export const SCOUT_BRANCH_SCORE_CAP = 48;
export const SCOUT_STOCKFISH_DEPTH = 8;
export const SCOUT_MAIA_LIMIT = 12;
export const SCOUT_SCORING_VERSION = 1;
export const SCOUT_THINK_TIME_CLAMP_MIN = 0.7;
export const SCOUT_THINK_TIME_CLAMP_MAX = 1.3;
export const SCOUT_THINK_TIME_Z_SCALE = 0.1;
/** Minimum per-game think medians before cohort z-scores adjust branch weights. */
export const SCOUT_THINK_MIN_SAMPLES = 5;
/** Standard MAD→σ scale for normal-consistent robust z-scores (median absolute deviation). */
export const MAD_TO_SIGMA = 1.4826;

const MS_PER_DAY = 86_400_000;
const TRIE_RECENCY_HALF_LIFE_DAYS = 45;
const CLK_ANNOTATION_RE = /\[%clk\s+(\d+:\d+:\d+(?:\.\d+)?)\]/;
const SAN_TOKEN_RE =
  /^([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O-O[+#]?|O-O[+#]?)/;

function wilsonInterval(w, d, l, tail) {
  const n = (w || 0) + (d || 0) + (l || 0);
  if (!n) return 0.5;
  const p = ((w || 0) + 0.5 * (d || 0)) / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return tail === "upper" ? (center + margin) / denom : (center - margin) / denom;
}

/** Wilson lower bound of score% (draw = 0.5). Used for ranking, not display. */
export function wilsonScorePct(w, d, l) {
  return Math.round(wilsonInterval(w, d, l, "lower") * 100);
}

/** Wilson upper bound — weakness must clear this to count as a proven attack target. */
export function wilsonScoreUpperPct(w, d, l) {
  return Math.round(wilsonInterval(w, d, l, "upper") * 100);
}

/** Convert one UCI move from a FEN; falls back to the UCI string on replay failure. */
export function uciToSan(fen, uci) {
  if (!fen || !uci) return uci || "";
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || undefined,
    });
    return move?.san || uci;
  } catch (_) {
    return uci;
  }
}

/** True when the last move in the path is the scouted opponent's move. */
export function terminalMoveIsOpponent(pathUcis, oppColor) {
  if (!pathUcis?.length || !oppColor) return false;
  const lastIdx = pathUcis.length - 1;
  const mover = lastIdx % 2 === 0 ? "white" : "black";
  return mover === oppColor;
}

/** Truncate or keep a line so it ends on the opponent's move. */
export function normalizeToOpponentTerminal(ucis, sans, oppColor) {
  if (!ucis?.length || !sans?.length || !oppColor) return null;
  if (terminalMoveIsOpponent(ucis, oppColor)) {
    return { ucis: [...ucis], sans: [...sans] };
  }
  if (ucis.length > 1) {
    const trimmedUcis = ucis.slice(0, -1);
    const trimmedSans = sans.slice(0, -1);
    if (terminalMoveIsOpponent(trimmedUcis, oppColor)) {
      return { ucis: trimmedUcis, sans: trimmedSans };
    }
  }
  return null;
}

export function triePathKey(ucis, maxPlies = MAX_PLIES) {
  return ucis.slice(0, maxPlies).join(">");
}

/** Full UCI path for opening-branch identity (no ply cap). */
export function branchPathKey(ucis) {
  return (ucis || []).join(">");
}

export function scoutLineText(sans) {
  const parts = [];
  (sans || []).forEach((san, index) => {
    if (index % 2 === 0) parts.push(`${index / 2 + 1}.`);
    parts.push(san);
  });
  return parts.join(" ");
}

// After add-moves flush, map a provisional tmp-* id to its reconciled server id.
export function nodeIdAfterFlush(nodeId, idMap) {
  return (nodeId && idMap && idMap[nodeId]) || nodeId;
}

export function mergeEngineIntoTargets(targets, enginePatterns) {
  if (!enginePatterns?.size) return targets;
  return targets.map((target) => {
    const pathKey = triePathKey(target.ucis);
    let pattern = enginePatterns.get(pathKey);
    if (!pattern) {
      for (const [key, value] of enginePatterns) {
        if (pathKey.startsWith(key) || key.startsWith(pathKey)) {
          pattern = value;
          break;
        }
      }
    }
    if (!pattern) return target;
    return { ...target, enginePattern: pattern, hasEngineMistake: true };
  });
}
const CACHE_KEY = "prepforge.scout.cache.v3";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // opponents play new games constantly
const CACHE_CAP = 8;

// ---------------------------------------------------------------------------
// PGN parsing (multi-game export -> per-game opening records)
// ---------------------------------------------------------------------------

function headerValue(block, name) {
  const match = block.match(new RegExp(`\\[${name}\\s+"([^"]*)"\\]`));
  return match ? match[1] : null;
}

/** Parse TimeControl header: "180+2" or bare base seconds. */
export function parseTimeControlHeader(raw) {
  if (raw == null || raw === "") return null;
  const inc = String(raw).match(/^(\d+)\+(\d+)$/);
  if (inc) {
    return { baseSeconds: Number(inc[1]), incrementSeconds: Number(inc[2]) };
  }
  const base = String(raw).match(/^(\d+)$/);
  if (base) return { baseSeconds: Number(base[1]), incrementSeconds: 0 };
  return null;
}

/** Convert [%clk H:MM:SS] to whole seconds. */
export function parseClkToSeconds(clk) {
  const m = String(clk || "").match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Math.floor(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
}

function parseSpeedBucket(timeControl) {
  const parsed = parseTimeControlHeader(timeControl);
  if (!parsed) return "unknown";
  const n = parsed.baseSeconds;
  if (n < 180) return "bullet";
  if (n < 480) return "blitz";
  if (n < 1500) return "rapid";
  return "classical";
}

function parseGameId(block) {
  const site = headerValue(block, "Site") || "";
  const match = site.match(/lichess\.org\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Read one `{ ... }` comment from mainline movetext starting at `{`.
 * Returns parsed `[%clk H:MM:SS]` when present; unmatched braces consume to EOF.
 */
function readMainlineComment(movetext, startIdx) {
  let i = startIdx;
  if (movetext[i] !== "{") return { clockSeconds: null, endIdx: i };
  i += 1;
  let depth = 1;
  let content = "";
  while (i < movetext.length && depth > 0) {
    if (movetext[i] === "{") depth += 1;
    else if (movetext[i] === "}") depth -= 1;
    else if (depth === 1) content += movetext[i];
    i += 1;
  }
  const clk = content.match(CLK_ANNOTATION_RE);
  return {
    clockSeconds: clk ? parseClkToSeconds(clk[1]) : null,
    endIdx: i,
  };
}

/** Skip a parenthesized variation starting at `(`; returns index after closing `)`. */
function skipMainlineVariation(movetext, startIdx) {
  let i = startIdx;
  let depth = 0;
  while (i < movetext.length) {
    if (movetext[i] === "(") depth += 1;
    else if (movetext[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    i += 1;
  }
  return i;
}

/** Mainline-only movetext parser; preserves { [%clk H:MM:SS] } per move. */
export function parseMainlineMoves(movetext) {
  const moves = [];
  let i = 0;
  const text = String(movetext || "");

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;

    if (text[i] === "(") {
      i = skipMainlineVariation(text, i);
      continue;
    }
    if (text[i] === "{") {
      i = readMainlineComment(text, i).endIdx;
      continue;
    }
    if (text[i] === "$") {
      while (i < text.length && /\S/.test(text[i])) i += 1;
      continue;
    }

    const tail = text.slice(i);
    if (/^(1-0|0-1|1\/2-1\/2|\*)\b/.test(tail)) break;

    const moveNum = tail.match(/^(\d+)\.(?:\.\.)?/);
    if (moveNum) {
      i += moveNum[0].length;
      while (i < text.length && /\s/.test(text[i])) i += 1;
    }

    const sanMatch = text.slice(i).match(SAN_TOKEN_RE);
    if (!sanMatch) {
      const junk = tail.match(/^(\S+)/);
      if (!junk) break;
      i += junk[0].length;
      continue;
    }

    const san = sanMatch[1];
    i += sanMatch[0].length;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    let clockSeconds = null;
    if (text[i] === "{") {
      const comment = readMainlineComment(text, i);
      clockSeconds = comment.clockSeconds;
      i = comment.endIdx;
    }

    moves.push({ san, clockSeconds });
  }
  return moves;
}

// Movetext -> SAN tokens from the mainline parser (clocks stripped from output).
export function movetextSans(movetext, maxPlies = MAX_PLIES) {
  const sans = [];
  for (const { san } of parseMainlineMoves(movetext)) {
    sans.push(san);
    if (sans.length >= maxPlies) break;
  }
  return sans;
}

/**
 * Opponent think gaps from Lichess `[%clk H:MM:SS]` annotations (seconds).
 * `clockAfterPly[p]` is remaining time after ply `p` (0-based); gap at ply `p` is
 * max(0, clock[p] + increment − clock[p+2]) for each opponent ply.
 */
export function computeNextOwnThinkSeconds(clockAfterPly, incrementSeconds, color) {
  const out = [];
  const inc = Number(incrementSeconds) || 0;
  const clocks = clockAfterPly || [];
  const start = color === "white" ? 0 : 1;
  for (let p = start; p < clocks.length - 2; p += 2) {
    const before = clocks[p];
    const after = clocks[p + 2];
    if (before == null || after == null) {
      out.push(null);
      continue;
    }
    out.push(Math.max(0, before + inc - after));
  }
  return out;
}

function medianOf(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function madOf(values, med) {
  const devs = values
    .filter((v) => v != null && Number.isFinite(v))
    .map((v) => Math.abs(v - med))
    .sort((a, b) => a - b);
  if (!devs.length) return 0;
  const mid = Math.floor(devs.length / 2);
  return devs.length % 2 ? devs[mid] : (devs[mid - 1] + devs[mid]) / 2;
}

function openingClockAfterPly(game) {
  const clocks = game.clockAfterPly || [];
  if (game.openingEndPly > 0) return clocks.slice(0, game.openingEndPly);
  if (game.openingUcis?.length) return clocks.slice(0, game.openingUcis.length);
  return clocks;
}

/** Median opponent "next own think" seconds during the recorded opening segment. */
export function gameNextOwnThinkMedian(game, oppColor) {
  const thinks = computeNextOwnThinkSeconds(
    openingClockAfterPly(game),
    game.timeControl?.incrementSeconds ?? 0,
    oppColor,
  ).filter((t) => t != null && Number.isFinite(t));
  return medianOf(thinks);
}

function recencyWeight(game, newestTs, halfLifeDays = SCOUT_RECENCY_HALF_LIFE_DAYS) {
  if (!game.datestamp || game.datestamp <= 0) return 0.3;
  const ageDays = Math.max(0, (newestTs - game.datestamp) / MS_PER_DAY);
  return Math.pow(2, -ageDays / halfLifeDays);
}

function lengthWeight(totalPly, saturation = SCOUT_LENGTH_SATURATION_PLIES) {
  const n = Number(totalPly) || 0;
  return 0.75 + 0.25 * (1 - Math.exp(-n / saturation));
}

function thinkTimeMultiplier(z) {
  return Math.max(
    SCOUT_THINK_TIME_CLAMP_MIN,
    Math.min(SCOUT_THINK_TIME_CLAMP_MAX, 1 + SCOUT_THINK_TIME_Z_SCALE * z),
  );
}

function extractOpponentTerminalOpening(game) {
  const oppColor = game.color;
  const ucis = game.openingUcis?.length ? game.openingUcis : game.ucis || [];
  const sans = game.openingSans?.length
    ? game.openingSans
    : (game.sans || []).slice(0, ucis.length);
  if (!ucis.length || sans.length !== ucis.length) return null;
  return normalizeToOpponentTerminal(ucis, sans, oppColor);
}

export function hashGameIdsForScope(games) {
  const ids = (games || []).map((g) => g.gameId || "").filter(Boolean).sort();
  let h = 0;
  const str = ids.join(",");
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

export function computeScoutBranchScopeKey({ username, activeSpeed, games } = {}) {
  return `${String(username || "").toLowerCase()}|${activeSpeed || "all"}|${hashGameIdsForScope(games)}|${SCOUT_SCORING_VERSION}`;
}

// One exported game -> a scout record from the SCOUTED player's point of view.
// Returns null when the player isn't in the game or the moves don't replay.
export function parseGameBlock(block, username) {
  const white = (headerValue(block, "White") || "").toLowerCase();
  const black = (headerValue(block, "Black") || "").toLowerCase();
  const needle = username.toLowerCase();
  let color = null;
  if (white === needle) color = "white";
  else if (black === needle) color = "black";
  if (!color) return null;

  const result = headerValue(block, "Result") || "*";
  let score; // from the scouted player's POV: 1 win, 0.5 draw, 0 loss
  if (result === "1/2-1/2") score = 0.5;
  else if (result === "1-0") score = color === "white" ? 1 : 0;
  else if (result === "0-1") score = color === "black" ? 1 : 0;
  else return null; // unfinished

  const ratingHeader = color === "white" ? "WhiteElo" : "BlackElo";
  const opponentRatingHeader = color === "white" ? "BlackElo" : "WhiteElo";
  const ratingRaw = headerValue(block, ratingHeader);
  const opponentRatingRaw = headerValue(block, opponentRatingHeader);
  const rating = ratingRaw ? Number(ratingRaw) || 0 : 0;
  const opponentRating = opponentRatingRaw ? Number(opponentRatingRaw) || 0 : 0;

  const dateRaw = headerValue(block, "UTCDate");
  const datestamp = dateRaw ? Date.parse(dateRaw.replace(/\./g, "-")) || 0 : 0;

  const timeControlRaw = headerValue(block, "TimeControl");
  const timeControl = parseTimeControlHeader(timeControlRaw);
  const speed = parseSpeedBucket(timeControlRaw);
  const gameId = parseGameId(block);

  const moveStart = block.search(/\n\s*\n/);
  const movetext = moveStart >= 0 ? block.slice(moveStart) : block;
  const mainline = parseMainlineMoves(movetext);
  if (!mainline.length) return null;

  const chess = new Chess();
  const ucis = [];
  const replayedSans = [];
  const clockAfterPly = [];
  const openingUcis = [];
  const openingSans = [];
  let openingEndPly = 0;

  for (const { san, clockSeconds } of mainline) {
    let move;
    try {
      move = chess.move(san);
    } catch (_) {
      break;
    }
    if (!move) break;
    const uci = move.from + move.to + (move.promotion || "");
    ucis.push(uci);
    replayedSans.push(move.san);
    clockAfterPly.push(clockSeconds ?? null);

    const phase = gamePhase(chess.fen());
    if (phase === "opening") {
      openingUcis.push(uci);
      openingSans.push(move.san);
      openingEndPly = openingUcis.length;
    } else if (!openingEndPly) {
      openingEndPly = ucis.length - 1;
    }
  }
  if (!ucis.length) return null;

  const nextOwnThinkSeconds = computeNextOwnThinkSeconds(
    clockAfterPly,
    timeControl?.incrementSeconds ?? 0,
    color,
  );

  return {
    color,
    score,
    sans: replayedSans,
    ucis,
    rating,
    opponentRating,
    datestamp,
    speed,
    gameId,
    timeControl,
    clockAfterPly,
    totalPly: ucis.length,
    openingUcis,
    openingSans,
    openingEndPly,
    nextOwnThinkSeconds,
  };
}

export function parseMultiPgn(text, username) {
  const games = [];
  // Lichess exports separate games by a blank line before the next [Event tag.
  for (const block of String(text || "").split(/\n\s*\n(?=\[Event )/)) {
    const game = parseGameBlock(block, username);
    if (game) games.push(game);
  }
  return games;
}

// ---------------------------------------------------------------------------
// Opening aggregation (trie of the opponent's moves)
// ---------------------------------------------------------------------------

function trieNode() {
  return { count: 0, score: 0, gameCount: 0, w: 0, d: 0, l: 0, children: new Map() };
}

function incrementResult(node, score) {
  if (score === 1) node.w += 1;
  else if (score === 0.5) node.d += 1;
  else node.l += 1;
}

function gameWeight(games, game, recency) {
  if (!recency) return 1;
  if (!game.datestamp || game.datestamp <= 0) return 0.3;
  const stamps = games.map((g) => g.datestamp).filter((d) => d > 0);
  const newestTs = stamps.length ? Math.max(...stamps) : Date.now();
  const ageDays = Math.max(0, (newestTs - game.datestamp) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / TRIE_RECENCY_HALF_LIFE_DAYS);
}

function nodeScorePct(node) {
  return node.count > 0 ? Math.round((node.score / node.count) * 100) : 0;
}

function nodeToLineGroup(root, node, sans, ucis, pathKey) {
  return {
    line: pathKey,
    sans: [...sans],
    ucis: [...ucis],
    games: node.gameCount,
    w: node.w,
    d: node.d,
    l: node.l,
    scorePct: nodeScorePct(node),
    share: root.count > 0 ? node.count / root.count : 0,
    // Raw (un-decayed) proportion for DISPLAY — recency-weighted `share`/`count`
    // collapse to ~0 for old lines, which renders as a misleading "0% · n=0".
    rawShare: root.gameCount > 0 ? node.gameCount / root.gameCount : 0,
    count: node.count,
  };
}

// Aggregate the games one colour at a time. Each path through the trie is a line
// the opponent has actually played, with how often and how well they scored.
export function buildOpeningTrie(
  games,
  color,
  { maxPlies = MAX_PLIES, speedFilter = "all", recency = true } = {},
) {
  const root = trieNode();
  const filtered =
    speedFilter !== "all" ? games.filter((g) => g.speed === speedFilter) : games;
  for (const game of filtered) {
    if (game.color !== color) continue;
    const w = gameWeight(filtered, game, recency);
    root.count += w;
    root.score += game.score * w;
    root.gameCount += 1;
    incrementResult(root, game.score);
    let node = root;
    for (let i = 0; i < Math.min(game.ucis.length, maxPlies); i += 1) {
      const key = `${game.ucis[i]}|${game.sans[i]}`;
      if (!node.children.has(key)) node.children.set(key, trieNode());
      node = node.children.get(key);
      node.count += w;
      node.score += game.score * w;
      node.gameCount += 1;
      incrementResult(node, game.score);
    }
  }
  return root;
}

// Walk the trie to first-move families plus distinct lines at 2–4 plies.
export function openingBreakdown(root, { minGames = 1 } = {}) {
  const groups = [];
  const seen = new Set();

  const add = (node, sans, ucis, pathKey) => {
    if (node.gameCount < minGames) return;
    if (seen.has(pathKey)) return;
    seen.add(pathKey);
    groups.push(nodeToLineGroup(root, node, sans, ucis, pathKey));
  };

  for (const [key, child] of root.children) {
    const [uci, san] = key.split("|");
    add(child, [san], [uci], key);
  }

  const walk = (node, depth, sans, ucis, pathKeys) => {
    if (depth >= 2 && depth <= 4) {
      add(node, sans, ucis, pathKeys.join(">"));
    }
    if (depth >= 4) return;
    for (const [key, child] of node.children) {
      const [uci, san] = key.split("|");
      walk(child, depth + 1, [...sans, san], [...ucis, uci], [...pathKeys, key]);
    }
  };
  walk(root, 0, [], [], []);

  return groups;
}

// Two lines are nested when one's move path is a prefix of the other's (e.g. "1.e4 c5"
// and "1.e4 c5 2.Nf3" are the same Sicilian seen at different depths). We compare on the
// ">"-joined uci path so a partial-uci coincidence can't false-match.
export function isNestedLine(a, b) {
  const x = a.line || triePathKey(a.ucis || []);
  const y = b.line || triePathKey(b.ucis || []);
  return x === y || x.startsWith(`${y}>`) || y.startsWith(`${x}>`);
}

// A line only earns the "Attack" badge when they sit MEANINGFULLY below their own
// baseline — either Wilson-confidently (upper bound still under baseline) or by a clear
// raw margin on a real sample. A line a couple of points under baseline is neither a
// weakness to punish nor a weapon to fear, so it stays neutral (no badge, not a target).
export const SCOUT_ATTACK_MIN_MARGIN = 6;

export function enrichPrepTarget(g, baselineScorePct, { maiaScorePct = null } = {}) {
  const useMaia = maiaScorePct != null;
  const scoreForBadge = useMaia ? maiaScorePct : g.scorePct;
  const wilsonLower = wilsonScorePct(g.w ?? 0, g.d ?? 0, g.l ?? 0);
  const wilsonUpper = wilsonScoreUpperPct(g.w ?? 0, g.d ?? 0, g.l ?? 0);
  const below = baselineScorePct - scoreForBadge;
  const wilsonMargin = useMaia ? 0 : Math.max(0, baselineScorePct - wilsonUpper);
  const isAttack = below > 0 && (wilsonMargin > 0 || below >= SCOUT_ATTACK_MIN_MARGIN);
  const isWeapon = !isAttack && scoreForBadge >= baselineScorePct;
  const opportunity =
    g.share *
    (wilsonMargin > 0 ? wilsonMargin : below >= SCOUT_ATTACK_MIN_MARGIN ? below * 0.25 : 0);
  return {
    ...g,
    maiaScorePct: useMaia ? maiaScorePct : g.maiaScorePct,
    wilsonScorePct: wilsonLower,
    wilsonScoreUpperPct: wilsonUpper,
    belowBaseline: isAttack ? below : 0,
    opportunity,
    prepCategory: isAttack ? "attack" : isWeapon ? "weapon" : "neutral",
  };
}

// Rank by recency-weighted share × Wilson-below-baseline; collapse nested lines; split
// attack targets (below baseline) from main-weapon lines (high share, at/above baseline).
export function recommendTargets(
  breakdown,
  baselineScorePct,
  {
    limit = 8,
    minGames = WEAKNESS_MIN_GAMES,
    oppColor = null,
    weaponShareMin = 0.12,
    attackLimit = 5,
    weaponLimit = 3,
  } = {},
) {
  const eligible = breakdown
    .filter((g) => g.games >= minGames)
    .map((g) => {
      if (!oppColor) return enrichPrepTarget(g, baselineScorePct);
      const normalized = normalizeToOpponentTerminal(g.ucis, g.sans, oppColor);
      if (!normalized) return null;
      // Refresh `line` to the normalised path: two deeper lines can truncate to the same
      // opponent-terminal move (e.g. "1.d4 Nf6" and "1.d4 g6" → "1.d4"), and the nested
      // dedup below keys off `line`, so a stale original path would leak duplicate rows.
      return enrichPrepTarget(
        { ...g, ucis: normalized.ucis, sans: normalized.sans, line: triePathKey(normalized.ucis) },
        baselineScorePct,
      );
    })
    .filter(Boolean);

  const attacks = eligible
    .filter((g) => g.prepCategory === "attack")
    .sort((a, b) => b.opportunity - a.opportunity);
  const weapons = eligible
    .filter((g) => g.prepCategory === "weapon" && g.share >= weaponShareMin)
    .sort((a, b) => b.share - a.share || b.games - a.games);

  const chosen = [];
  const pickFrom = (list, cap) => {
    let n = 0;
    for (const g of list) {
      if (chosen.some((c) => isNestedLine(c, g))) continue;
      chosen.push(g);
      n += 1;
      if (n >= cap || chosen.length >= limit) break;
    }
  };
  pickFrom(attacks, attackLimit);
  if (chosen.length < limit) pickFrom(weapons, weaponLimit);
  return chosen;
}

const openingPhaseCache = new Map();

/** Clear cached opening-phase lookups (tests or long sessions). */
export function clearOpeningPhaseCache() {
  openingPhaseCache.clear();
}

function openingPhaseAt(ucis, cache = openingPhaseCache) {
  const key = triePathKey(ucis);
  const hit = cache.get(key);
  if (hit != null) return hit;
  const phase = gamePhase(fenAfterLine(ucis));
  cache.set(key, phase);
  return phase;
}

function nextMoverAt(ucis) {
  return ucis.length % 2 === 0 ? "white" : "black";
}

// Aggregate one real opening branch per game (no trie bridge / prefix collapse).
export function aggregateOpeningBranches(
  games,
  color,
  { speedFilter = "all", now = Date.now() } = {},
) {
  const filtered = (
    speedFilter !== "all" ? games.filter((g) => g.speed === speedFilter) : games
  ).filter((g) => g.color === color);

  const stamps = filtered.map((g) => g.datestamp).filter((d) => d > 0);
  const newestTs = stamps.length ? Math.max(...stamps) : now;

  const thinkSamples = [];
  const gameThinkMedian = new Map();
  for (const game of filtered) {
    const med = gameNextOwnThinkMedian(game, game.color);
    gameThinkMedian.set(game, med);
    if (med != null) thinkSamples.push(med);
  }
  const cohortMedian = medianOf(thinkSamples);
  const cohortMad = cohortMedian != null ? madOf(thinkSamples, cohortMedian) : 0;
  const thinkReady = thinkSamples.length >= SCOUT_THINK_MIN_SAMPLES && cohortMad > 0;

  const byKey = new Map();
  let droppedCount = 0;

  for (const game of filtered) {
    const terminal = extractOpponentTerminalOpening(game);
    if (!terminal) {
      droppedCount += 1;
      continue;
    }
    const key = terminal.ucis.join(">");
    if (!byKey.has(key)) {
      byKey.set(key, {
        sans: [...terminal.sans],
        ucis: [...terminal.ucis],
        games: 0,
        w: 0,
        d: 0,
        l: 0,
        branchScore: 0,
        lastDatestamp: 0,
        seenGameIds: new Set(),
      });
    }
    const row = byKey.get(key);
    if (game.gameId) {
      if (row.seenGameIds.has(game.gameId)) continue;
      row.seenGameIds.add(game.gameId);
    }

    const R = recencyWeight(game, newestTs);
    const L = lengthWeight(game.totalPly ?? game.ucis?.length ?? 0);
    let T = 1;
    if (thinkReady) {
      const gameThink = gameThinkMedian.get(game);
      if (gameThink != null) {
        const z = (cohortMedian - gameThink) / (MAD_TO_SIGMA * cohortMad);
        T = thinkTimeMultiplier(z);
      }
    }
    row.branchScore += R * L * T;
    row.games += 1;
    if (game.score === 1) row.w += 1;
    else if (game.score === 0.5) row.d += 1;
    else row.l += 1;
    if (game.datestamp > row.lastDatestamp) row.lastDatestamp = game.datestamp;
  }

  const branches = [...byKey.values()].map((row) => {
    const n = row.games;
    const pathKey = branchPathKey(row.ucis);
    return {
      line: pathKey,
      sans: row.sans,
      ucis: row.ucis,
      games: n,
      w: row.w,
      d: row.d,
      l: row.l,
      scorePct: n > 0 ? Math.round(((row.w + 0.5 * row.d) / n) * 100) : 0,
      share: 0,
      rawShare: 0,
      count: row.branchScore,
      branchScore: row.branchScore,
      lastDatestamp: row.lastDatestamp,
    };
  });

  const totalScore = branches.reduce((s, b) => s + b.branchScore, 0) || 1;
  const totalGames = branches.reduce((s, b) => s + b.games, 0) || 1;
  for (const b of branches) {
    b.share = b.branchScore / totalScore;
    b.rawShare = b.games / totalGames;
  }
  return { branches, droppedCount };
}

/** Rank exact per-game opening branches by branchScore; top N feed Stockfish/Maia. */
export function rankedOpeningBranches(
  games,
  color,
  { speedFilter = "all", limit = SCOUT_BRANCH_SCORE_CAP, now = Date.now() } = {},
) {
  const { branches } = aggregateOpeningBranches(games, color, { speedFilter, now });
  branches.sort(
    (a, b) =>
      b.branchScore - a.branchScore ||
      (b.lastDatestamp || 0) - (a.lastDatestamp || 0) ||
      b.games - a.games ||
      a.line.localeCompare(b.line),
  );
  return limit > 0 ? branches.slice(0, limit) : branches;
}

/** @deprecated Trie bridge removed — use rankedOpeningBranches(games, color). */
export function rankedOpeningLines(
  gamesOrTrie,
  { color, speedFilter = "all", oppColor = null, limit = SCOUT_BRANCH_SCORE_CAP } = {},
) {
  if (Array.isArray(gamesOrTrie)) {
    const c = color ?? oppColor;
    if (!c) return [];
    return rankedOpeningBranches(gamesOrTrie, c, { speedFilter, limit });
  }
  return [];
}

// Unified ranked game plan: exploitability first, collapse nested prefixes, no row cap.
export function rankGamePlan(
  lines,
  baselineScorePct,
  {
    minGames = GAME_PLAN_MIN_GAMES,
    oppColor = null,
    limit = SCOUT_GAME_PLAN_LIMIT,
    games = null,
    speedFilter = "all",
    lineLastSeen = null,
  } = {},
) {
  const eligible = lines
    .filter((g) => g.games >= minGames)
    .map((g) => {
      if (!oppColor) return enrichPrepTarget(g, baselineScorePct);
      const normalized = normalizeToOpponentTerminal(g.ucis, g.sans, oppColor);
      if (!normalized) return null;
      const enriched = enrichPrepTarget(
        {
          ...g,
          ucis: normalized.ucis,
          sans: normalized.sans,
          line: triePathKey(normalized.ucis),
          maiaWdl: g.maiaWdl,
        },
        baselineScorePct,
        { maiaScorePct: g.maiaScorePct ?? null },
      );
      if (!enriched.lastSeen && games && lineLastSeen) {
        enriched.lastSeen = lineLastSeen(games, enriched.ucis, { color: oppColor, speedFilter });
      }
      return enriched;
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Lines with a Maia read rank by opponent score (lowest = most exploitable for user).
      // Lines without Maia fall after all assessed lines, sorted by recency then share.
      const aHasMaia = a.maiaScorePct != null;
      const bHasMaia = b.maiaScorePct != null;
      if (aHasMaia && bHasMaia) {
        if (a.maiaScorePct !== b.maiaScorePct) return a.maiaScorePct - b.maiaScorePct;
        const aStamp = a.lastSeen?.lastDatestamp ?? 0;
        const bStamp = b.lastSeen?.lastDatestamp ?? 0;
        return bStamp - aStamp || b.share - a.share;
      }
      if (aHasMaia !== bHasMaia) return aHasMaia ? -1 : 1;
      // Both unenriched: recent first, then share.
      const aStamp = a.lastSeen?.lastDatestamp ?? 0;
      const bStamp = b.lastSeen?.lastDatestamp ?? 0;
      return (
        bStamp - aStamp ||
        (b.branchScore || 0) - (a.branchScore || 0) ||
        b.share - a.share ||
        b.games - a.games
      );
    });

  const chosen = [];
  for (const g of eligible) {
    const gPath = g.line || triePathKey(g.ucis || []);
    const nestedIdx = chosen.findIndex((c) => isNestedLine(c, g));
    if (nestedIdx >= 0) {
      const cPath = chosen[nestedIdx].line || triePathKey(chosen[nestedIdx].ucis || []);
      if (gPath.startsWith(`${cPath}>`)) chosen[nestedIdx] = g;
      continue;
    }
    chosen.push(g);
  }
  return limit > 0 ? chosen.slice(0, limit) : chosen;
}

/** Prefer an enabled mainline child; otherwise pick deterministically by UCI. */
function pickRepertoireReplyChild(children) {
  if (!children?.size) return null;
  const entries = [...children.entries()].map(([uci, meta]) => ({
    uci,
    id: meta.id,
    is_mainline: !!meta.is_mainline,
    is_enabled: meta.is_enabled !== false,
  }));
  const enabled = entries.filter((e) => e.is_enabled);
  if (!enabled.length) return null;
  const mainlines = enabled.filter((e) => e.is_mainline);
  if (mainlines.length) {
    mainlines.sort((a, b) => a.uci.localeCompare(b.uci));
    return mainlines[0];
  }
  enabled.sort((a, b) => a.uci.localeCompare(b.uci));
  return enabled[0];
}

/** Next move in the player's repertoire after the opponent line (mainline-aware). */
export function suggestReplyFromRepertoire(lookup, lineUcis) {
  const { covered, deepestNodeId } = lineCoverage(lookup, lineUcis);
  if (covered < lineUcis.length || !deepestNodeId) return null;
  const children = lookup.childUci.get(deepestNodeId);
  const picked = pickRepertoireReplyChild(children);
  return picked?.uci ? { uci: picked.uci, source: "repertoire" } : null;
}

/** Attach a recommended player reply from repertoire coverage or engine refutation. */
export function attachPrepReplies(targets, { lookups = [], refutations = [], oppColor } = {}) {
  const refByKey = new Map();
  for (const item of refutations || []) {
    const key = triePathKey(item.candidate?.pathUcis || []);
    if (key && item.refutation) refByKey.set(key, item.refutation);
  }
  return (targets || []).map((target) => {
    const pathKey = triePathKey(target.ucis || []);
    let suggestedReply = null;
    for (const { lookup } of lookups || []) {
      const fromRep = suggestReplyFromRepertoire(lookup, target.ucis);
      if (fromRep) {
        suggestedReply = fromRep;
        break;
      }
    }
    if (!suggestedReply) {
      const ref = refByKey.get(pathKey);
      if (ref?.suggestedUci) {
        const replyFen = fenAfterLine([...(target.ucis || [])]);
        suggestedReply = {
          uci: ref.suggestedUci,
          san: ref.suggestedSan || uciToSan(replyFen, ref.suggestedUci),
          source: "engine",
          cpLoss: ref.cpLoss,
          ourReplyPv: ref.ourReplyPv,
          playedSan: ref.playedSan,
          playedUci: ref.playedUci,
        };
      }
    }
    if (suggestedReply?.uci && !suggestedReply.san) {
      const replyFen = fenAfterLine([...(target.ucis || [])]);
      suggestedReply = {
        ...suggestedReply,
        san: uciToSan(replyFen, suggestedReply.uci),
      };
    }
    const refutation = refByKey.get(pathKey) || null;
    return {
      ...target,
      suggestedReply,
      needsPrep: !suggestedReply,
      refutation,
      oppColor,
    };
  });
}

// The opponent's most-travelled paths: walk the trie greedily from the most
// common child down, splitting off one line per top-level branch (and per second
// branch under the most common reply) so the list reads like a repertoire sketch.
export function topLines(root, { limit = 12, minCount = 1.5 } = {}) {
  const lines = [];

  const walk = (node, sans, ucis) => {
    let best = null;
    for (const [key, child] of node.children) {
      if (!best || child.count > best.child.count) best = { key, child };
    }
    if (!best || best.child.count < minCount) {
      return { sans, ucis, count: node.count, score: node.score, w: node.w, d: node.d, l: node.l };
    }
    const [uci, san] = best.key.split("|");
    return walk(best.child, [...sans, san], [...ucis, uci]);
  };

  // One line per first-move branch, most common first.
  const firstMoves = [...root.children.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, child] of firstMoves) {
    if (lines.length >= limit || child.count < minCount) break;
    const [uci, san] = key.split("|");
    const tip = walk(child, [san], [uci]);
    const line = {
      sans: tip.sans,
      ucis: tip.ucis,
      count: child.count,
      gameCount: child.gameCount,
      w: child.w,
      d: child.d,
      l: child.l,
      share: root.count > 0 ? child.count / root.count : 0,
      scorePct: nodeScorePct(child),
    };
    lines.push(line);
  }

  // Sub-lines for the top 2 first-move branches.
  for (let i = 0; i < Math.min(2, firstMoves.length); i += 1) {
    const [, child] = firstMoves[i];
    const subLines = topLines(child, { limit: 3, minCount: 1 });
    if (subLines.length && lines[i]) lines[i].subLines = subLines;
  }

  return lines;
}

// First-move distribution (or the reply distribution under a given first move).
export function moveDistribution(root, { slipMinGames = SLIP_MIN_GAMES } = {}) {
  const total = root.count || 1;
  return [...root.children.entries()]
    .map(([key, child]) => {
      const [uci, san] = key.split("|");
      return {
        uci,
        san,
        count: child.count,
        gameCount: child.gameCount,
        w: child.w,
        d: child.d,
        l: child.l,
        share: child.count / total,
        scorePct: nodeScorePct(child),
        wilsonScorePct: wilsonScorePct(child.w, child.d, child.l),
        node: child,
      };
    })
    .filter((m) => m.gameCount >= slipMinGames)
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Repertoire coverage (how deep does MY prep follow each of their lines?)
// ---------------------------------------------------------------------------

// Build a parent->children uci lookup from a /api/build/load payload's flat nodes.
export function repertoireChildLookup(nodes) {
  const childUci = new Map(); // parentId -> Map<uci, { id, is_mainline, is_enabled }>
  let rootId = null;
  for (const node of nodes || []) {
    if (node.depth === 0) {
      rootId = node.id;
      continue;
    }
    if (node.is_enabled === false) continue;
    if (!childUci.has(node.parent_id)) childUci.set(node.parent_id, new Map());
    childUci.get(node.parent_id).set(node.uci, {
      id: node.id,
      is_mainline: !!node.is_mainline,
      is_enabled: node.is_enabled !== false,
    });
  }
  return { rootId, childUci };
}

// Walk one opponent line through my tree: how many plies are covered, and the id
// of the deepest matching node (the place Build should open to extend the prep).
export function lineCoverage(lookup, lineUcis) {
  let nodeId = lookup.rootId;
  let covered = 0;
  for (const uci of lineUcis) {
    const children = lookup.childUci.get(nodeId);
    const next = children ? children.get(uci) : null;
    if (!next) break;
    nodeId = next.id;
    covered += 1;
  }
  return { covered, deepestNodeId: nodeId };
}

// A line counts as "prepared" when my tree follows it to the opponent's full
// (scout-depth) length, or at least PREPARED_PLIES deep into the opening.
export const PREPARED_PLIES = 8;

export function gradeLines(lookup, lines) {
  return lines.map((line) => {
    const { covered, deepestNodeId } = lineCoverage(lookup, line.ucis);
    const prepared = covered >= Math.min(line.ucis.length, PREPARED_PLIES);
    return { ...line, covered, deepestNodeId, prepared };
  });
}

// ---------------------------------------------------------------------------
// FEN + opponent profile
// ---------------------------------------------------------------------------

export function fenAfterLine(ucis) {
  const chess = new Chess();
  for (const uci of ucis) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch (_) {
      break;
    }
  }
  return chess.fen();
}

function mostCommonFirstMove(games, color) {
  const counts = new Map();
  for (const g of games) {
    if (g.color !== color || !g.ucis.length) continue;
    const key = g.ucis[0];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  for (const [uci, count] of counts) {
    if (!best || count > best.count) best = { uci, count };
  }
  return best ? best.uci : null;
}

export const RECENT_CHANGE_MIN_GAMES = 3;

function colorGamesWithMoves(games, color) {
  return games.filter((g) => g.color === color && g.ucis.length);
}

function detectRecentChange(last20, prev20) {
  const changed = (color) => {
    const last = colorGamesWithMoves(last20, color);
    const prev = colorGamesWithMoves(prev20, color);
    if (last.length < RECENT_CHANGE_MIN_GAMES || prev.length < RECENT_CHANGE_MIN_GAMES) {
      return false;
    }
    return mostCommonFirstMove(last20, color) !== mostCommonFirstMove(prev20, color);
  };
  return { white: changed("white"), black: changed("black") };
}

function colorResultStats(games, color) {
  const filtered = games.filter((g) => g.color === color);
  let w = 0;
  let d = 0;
  let l = 0;
  let scoreSum = 0;
  for (const g of filtered) {
    if (g.score === 1) w += 1;
    else if (g.score === 0.5) d += 1;
    else l += 1;
    scoreSum += g.score;
  }
  const n = filtered.length;
  return {
    games: n,
    w,
    d,
    l,
    scorePct: n > 0 ? Math.round((scoreSum / n) * 100) : 0,
  };
}

export function opponentProfile(games) {
  const ratingsSeen = games.map((g) => g.rating).filter((r) => r > 0);
  const speedCounts = { bullet: 0, blitz: 0, rapid: 0, classical: 0, unknown: 0 };
  games.forEach((g) => {
    speedCounts[g.speed] = (speedCounts[g.speed] || 0) + 1;
  });
  const last20 = games.slice(0, 20);
  const prev20 = games.slice(20, 40);
  return {
    total: games.length,
    ratingMin: ratingsSeen.length ? Math.min(...ratingsSeen) : null,
    ratingMax: ratingsSeen.length ? Math.max(...ratingsSeen) : null,
    ratingLast: games[0]?.rating || null,
    speedCounts,
    recentlyChanged: detectRecentChange(last20, prev20),
    colorStats: {
      white: colorResultStats(games, "white"),
      black: colorResultStats(games, "black"),
    },
  };
}

// ---------------------------------------------------------------------------
// Fetching (with a small per-username cache)
// ---------------------------------------------------------------------------

export function scoutUrl(username, max) {
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    moves: "true",
    clocks: "true",
    evals: "false",
    opening: "false",
    perfType: "bullet,blitz,rapid,classical",
  });
  const maxN = Number(max);
  if (max != null && Number.isFinite(maxN) && maxN > 0) {
    params.set("max", String(Math.max(10, Math.round(maxN))));
  }
  return `https://lichess.org/api/games/user/${safe}?${params}`;
}

/** Streaming export URL — adds colour filter and since/until for resume pagination. */
export function scoutStreamUrl(username, { color = "both", since, until, max } = {}) {
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    moves: "true",
    clocks: "true",
    evals: "false",
    opening: "false",
    perfType: "bullet,blitz,rapid,classical",
  });
  const maxN = Number(max);
  if (max != null && Number.isFinite(maxN) && maxN > 0) {
    params.set("max", String(Math.max(10, Math.round(maxN))));
  }
  if (color && color !== "both") params.set("color", color);
  if (since != null) params.set("since", String(since));
  if (until != null) params.set("until", String(until));
  return `https://lichess.org/api/games/user/${safe}?${params}`;
}

// Lichess exports separate games by a blank line before the next [Event tag.
export const PGN_BLOCK_BOUNDARY = /\n\s*\n(?=\[Event )/;

async function streamPgn(resp, username, onGame, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accepted = 0;
  let lastDatestamp = null;

  const emitBlock = (block) => {
    const trimmed = String(block || "").trim();
    if (!trimmed) return;
    const game = parseGameBlock(trimmed, username);
    if (!game) return;
    if (onGame(game) === false) return;
    accepted += 1;
    if (game.datestamp > 0 && (lastDatestamp == null || game.datestamp < lastDatestamp)) {
      lastDatestamp = game.datestamp;
    }
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) break;
        throw error;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(PGN_BLOCK_BOUNDARY);
      buffer = parts.pop() || "";
      for (const part of parts) emitBlock(part);
    }
  } finally {
    try {
      reader.cancel?.();
    } catch (_) {
      /* reader may already be closed */
    }
    if (!signal?.aborted) emitBlock(buffer);
  }
  return { accepted, emitted: accepted, lastDatestamp };
}

export function createScoutClient({ fetchImpl, storage, now } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const clock = now || (() => Date.now());
  const store =
    storage ||
    (typeof localStorage === "undefined"
      ? { getItem: () => null, setItem: () => {} }
      : localStorage);

  function readCache() {
    try {
      const parsed = JSON.parse(store.getItem(CACHE_KEY) || "null");
      return parsed && parsed.entries ? parsed : { entries: {} };
    } catch (_) {
      return { entries: {} };
    }
  }

  // fetchGames(username, {max}) -> parsed game records (cached for a few hours).
  async function fetchGames(username, { max, signal } = {}) {
    const key = `${username.toLowerCase()}:${max ?? "all"}`;
    const cache = readCache();
    const hit = cache.entries[key];
    if (hit && clock() - hit.at < CACHE_TTL_MS) return hit.games;

    const resp = await doFetch(scoutUrl(username, max), {
      headers: { Accept: "application/x-chess-pgn" },
      signal,
    });
    if (resp.status === 404) throw new Error(`No Lichess user named "${username}"`);
    if (resp.status === 429) throw new Error(SCOUT_ERR_RATE_LIMIT);
    if (!resp.ok) throw new Error(`Lichess responded ${resp.status}`);
    const games = parseMultiPgn(await resp.text(), username);

    const fresh = readCache();
    fresh.entries[key] = { at: clock(), games };
    const keys = Object.keys(fresh.entries);
    if (keys.length > CACHE_CAP) {
      keys
        .sort((a, b) => fresh.entries[a].at - fresh.entries[b].at)
        .slice(0, keys.length - CACHE_CAP)
        .forEach((k) => delete fresh.entries[k]);
    }
    try {
      store.setItem(CACHE_KEY, JSON.stringify(fresh));
    } catch (_) {
      /* best-effort cache */
    }
    return games;
  }

  // streamGames(username, {color, since, until, onGame, signal}) -> {accepted, lastDatestamp}
  async function streamGames(username, { color, since, until, max, onGame, signal } = {}) {
    const resp = await doFetch(scoutStreamUrl(username, { color, since, until, max }), {
      headers: { Accept: "application/x-chess-pgn" },
      signal,
    });
    if (resp.status === 404) throw new Error(`No Lichess user named "${username}"`);
    if (resp.status === 429) throw new Error(SCOUT_ERR_RATE_LIMIT);
    if (!resp.ok) throw new Error(`Lichess responded ${resp.status}`);
    return streamPgn(resp, username, onGame, signal);
  }

  return { fetchGames, streamGames };
}