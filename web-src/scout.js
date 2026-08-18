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
/** Scout prefilter feeds ALL exploitability-ranked branches to Stockfish (leaf-only),
 * bounded by the engine time budget rather than a count. This ceiling only guards the
 * cheap trie-walk + FEN-enumeration step against pathological corpora (every game a
 * unique deep line) — it is not the old 48 candidate cut. */
export const SCOUT_BRANCH_HARD_CEILING = 300;
/** Always feed at least this many branches to the engine so the Maia backup pool (64)
 *  never starves on a thin opponent. Mirrors SCOUT_PREFILTER_POOL_SIZE (kept local to
 *  avoid a circular import from scout-prefilter.js). */
export const SCOUT_BRANCH_MIN_KEEP = 64;
export const SCOUT_STOCKFISH_DEPTH = 8;
export const SCOUT_MAIA_LIMIT = 12;
export const SCOUT_SCORING_VERSION = 3;
/** Minimum games before empirical opponent performance gates prefilter candidates. */
export const SCOUT_PREFILTER_EMPIRICAL_MIN_GAMES = 3;
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

export function wilsonInterval(w, d, l, tail, z = 1.96) {
  const n = (w || 0) + (d || 0) + (l || 0);
  if (!n) return 0.5;
  const p = ((w || 0) + 0.5 * (d || 0)) / n;
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
        // Pattern may annotate a prefix of this target, not a descendant or sibling.
        if (pathKey === key || pathKey.startsWith(`${key}>`)) {
          pattern = value;
          break;
        }
      }
    }
    if (!pattern) return target;
    return { ...target, enginePattern: pattern, hasEngineMistake: true };
  });
}
// v4: fetchGames now excludes bullet at the source (excludeBullet:true). The v3
// cache may hold older results that still contain bullet games, so the key is
// bumped to force a clean re-fetch rather than re-serving contaminated data.
const CACHE_KEY = "prepforge.scout.cache.v4";
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

/** Lichess estimated duration: base + 40 * increment. */
export function parseSpeedBucket(timeControl) {
  const parsed = parseTimeControlHeader(timeControl);
  if (!parsed) return "unknown";
  const n = parsed.baseSeconds + 40 * (parsed.incrementSeconds || 0);
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

/** UTCDate (YYYY.MM.DD) plus optional UTCTime (HH:MM:SS) → ms. Date-only is midnight UTC. */
export function parseScoutDatestamp(dateRaw, timeRaw) {
  if (!dateRaw) return 0;
  const datePart = String(dateRaw).replace(/\./g, "-");
  const timeOk = timeRaw && /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(timeRaw).trim());
  const timePart = timeOk ? String(timeRaw).trim() : "00:00:00";
  const iso = timePart.length === 5 ? `${datePart}T${timePart}:00Z` : `${datePart}T${timePart}Z`;
  return Date.parse(iso) || Date.parse(datePart) || 0;
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

function getGameOpeningMoves(game) {
  const ucis = game.openingUcis?.length ? game.openingUcis : game.ucis || [];
  const sans = game.openingSans?.length ? game.openingSans : game.sans || [];
  return { ucis, sans };
}

function extractOpponentTerminalOpening(game) {
  const oppColor = game.color;
  const { ucis, sans } = getGameOpeningMoves(game);
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
  const timeRaw = headerValue(block, "UTCTime");
  const datestamp = parseScoutDatestamp(dateRaw, timeRaw);

  const variant = (headerValue(block, "Variant") || "Standard").trim().toLowerCase();
  if (variant && variant !== "standard" && variant !== "chess") return null;
  if (headerValue(block, "SetUp") === "1" || headerValue(block, "FEN")) return null;

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
  let openingClosed = false;

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
    if (!openingClosed && phase === "opening") {
      openingUcis.push(uci);
      openingSans.push(move.san);
      openingEndPly = openingUcis.length;
    } else if (!openingClosed) {
      openingClosed = true;
      openingEndPly = openingUcis.length;
    }
  }
  if (!ucis.length) return null;

  const nextOwnThinkSeconds = computeNextOwnThinkSeconds(
    clockAfterPly,
    timeControl?.incrementSeconds ?? 0,
    color,
  );

  // Coarse end-state, for the collapse down-weight rule. Lichess PGN marks resign and
  // checkmate alike as [Termination "Normal"]; the trailing "#" separates mate from a
  // resignation, and time forfeits carry their own termination. The ND-JSON path later
  // overrides this with Lichess's authoritative `status` (see parseGameFromJson).
  const termination = (headerValue(block, "Termination") || "").toLowerCase();
  const lastSan = replayedSans[replayedSans.length - 1] || "";
  let status = null;
  if (termination.includes("time")) status = "outoftime";
  else if (result === "1/2-1/2") status = "draw";
  else if (lastSan.endsWith("#")) status = "mate";
  else if (termination === "normal") status = "resign";

  return {
    color,
    score,
    status,
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

/**
 * One ND-JSON game object (with `pgnInJson=true&clocks=true`) -> a scout record.
 * The embedded `pgn` reuses the full PGN reader so every derived field is identical to
 * the PGN path; we only *attach* the raw centisecond `clocks` array + the precise
 * initial/increment, which the PGN `[%clk]` annotation rounds to whole seconds.
 */
export function parseGameFromJson(obj, username) {
  if (!obj || typeof obj !== "object") return null;
  const pgnText = typeof obj.pgn === "string" ? obj.pgn : null;
  if (!pgnText) return null;
  const game = parseGameBlock(pgnText, username);
  if (!game) return null;
  if (Array.isArray(obj.clocks) && obj.clocks.length) {
    game.clockCsAfterPly = obj.clocks
      .slice(0, game.ucis.length)
      .map((c) => (Number.isFinite(c) ? c : null));
  }
  if (obj.clock && typeof obj.clock === "object") {
    if (Number.isFinite(obj.clock.initial)) game.clockInitialSeconds = obj.clock.initial;
    if (Number.isFinite(obj.clock.increment)) game.clockIncrementSeconds = obj.clock.increment;
  }
  // Authoritative end-state ("resign" / "mate" / "outoftime" / "draw" / …), which the
  // PGN reader can only approximate — the collapse rule needs a reliable "resign".
  if (typeof obj.status === "string") game.status = obj.status;
  if (Number.isFinite(obj.createdAt)) game.datestamp = obj.createdAt;
  return game;
}

/** Parse a Lichess ND-JSON games export (one JSON object per line). */
export function parseNdjsonGames(text, username) {
  const games = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue; // tolerate blank/partial lines
    }
    const game = parseGameFromJson(obj, username);
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

// The newest game timestamp in a set — the anchor the display trie's recency decay is
// measured from. Computed ONCE per build (was recomputed per game inside gameWeight,
// making buildOpeningTrie O(N²); the streaming view called it every batch).
export function trieAnchorTs(games) {
  let newest = 0;
  for (const g of games) {
    if (g.datestamp && g.datestamp > newest) newest = g.datestamp;
  }
  return newest > 0 ? newest : Date.now();
}

// Recency decay for one game, measured from a FIXED anchor timestamp. Because shifting
// the anchor multiplies every game's weight by the same constant, all *displayed* trie
// quantities — score/count ratios, per-node share, gameCount — are invariant to the
// anchor chosen. That invariance is what lets the streaming view insert each game once
// into a persistent trie (createOpeningTrie + insertGameIntoTrie) with an anchor fixed at
// session start, instead of rebuilding from every game on each batch, and still match a
// one-shot buildOpeningTrie on everything the report shows.
function trieRecencyWeight(game, anchorTs, recency) {
  if (!recency) return 1;
  if (!game.datestamp || game.datestamp <= 0) return 0.3;
  const ageDays = Math.max(0, (anchorTs - game.datestamp) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / TRIE_RECENCY_HALF_LIFE_DAYS);
}

/** A fresh, empty opening trie root — seed for incremental insertion. */
export function createOpeningTrie() {
  return trieNode();
}

// Fold one game into a persistent per-color trie. The caller supplies a fixed `anchorTs`
// (see trieRecencyWeight). Wrong-colour games and early-resign collapses are skipped, so
// this is safe to call blindly on every streamed game. Returns the root for chaining.
export function insertGameIntoTrie(
  root,
  game,
  color,
  { maxPlies = MAX_PLIES, anchorTs = null, recency = true, excludeCollapse = true } = {},
) {
  if (!game || game.color !== color) return root;
  if (excludeCollapse && isEarlyResignCollapse(game)) return root;
  const anchor = anchorTs ?? (game.datestamp && game.datestamp > 0 ? game.datestamp : Date.now());
  const w = trieRecencyWeight(game, anchor, recency);
  root.count += w;
  root.score += game.score * w;
  root.gameCount += 1;
  incrementResult(root, game.score);
  const { ucis, sans } = getGameOpeningMoves(game);
  let node = root;
  for (let i = 0; i < Math.min(ucis.length, maxPlies); i += 1) {
    const key = `${ucis[i]}|${sans[i]}`;
    if (!node.children.has(key)) node.children.set(key, trieNode());
    node = node.children.get(key);
    node.count += w;
    node.score += game.score * w;
    node.gameCount += 1;
    incrementResult(node, game.score);
  }
  return root;
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

/**
 * Transparent down-weight for non-representative games. A game the scouted opponent LOST
 * by early resignation while still holding a healthy share of their clock is a one-off
 * collapse — a mouse-slip, or a snap blunder they instantly gave up on — not a signal of
 * their real opening prep. Counting it lets a single disaster inflate a line's empirical
 * "struggle" and make it look artificially exploitable, so scout drops such games from the
 * opening trie and branch aggregation.
 *
 * The gate is deliberately narrow (resign + short game + healthy clock) to bias hard toward
 * precision: it removes clear collapses and essentially never a genuine prep game. Getting
 * mated in the opening is intentionally NOT caught — that can be a repeatable trap the
 * opponent keeps walking into, i.e. a real, exploitable weakness worth keeping.
 */
export const SCOUT_COLLAPSE_MAX_PLY = 24; // resigned by ~move 12 → still in / near the opening
export const SCOUT_COLLAPSE_MIN_CLOCK_FRAC = 0.5; // ≥ half the clock left → not a time scramble

// The scouted player's remaining-clock fraction (0..1) at their last recorded move, or
// null when it can't be determined (the collapse rule then abstains rather than guesses).
function opponentEndClockFraction(game) {
  const initial = Number.isFinite(game?.clockInitialSeconds)
    ? game.clockInitialSeconds
    : Number.isFinite(game?.timeControl?.baseSeconds)
      ? game.timeControl.baseSeconds
      : null;
  if (!initial || initial <= 0) return null;
  const parity = game?.color === "white" ? 0 : 1; // clocks[p] is after ply p: even = White
  const cs = game?.clockCsAfterPly;
  const secs = game?.clockAfterPly;
  const len = Math.max(cs?.length || 0, secs?.length || 0);
  for (let p = len - 1; p >= 0; p -= 1) {
    if (p % 2 !== parity) continue;
    const fromCs = cs && Number.isFinite(cs[p]) ? cs[p] / 100 : null;
    const fromSecs = secs && Number.isFinite(secs[p]) ? secs[p] : null;
    const remaining = fromCs != null ? fromCs : fromSecs;
    if (remaining != null) return remaining / initial;
  }
  return null;
}

/**
 * True when `game` matches the early-resign collapse fingerprint (see SCOUT_COLLAPSE_*).
 * Pure and cheap — no engine, only the result / status / length / clock already on the
 * record — so it can gate the no-engine trie and branch aggregation.
 */
export function isEarlyResignCollapse(
  game,
  { maxPly = SCOUT_COLLAPSE_MAX_PLY, minClockFrac = SCOUT_COLLAPSE_MIN_CLOCK_FRAC } = {},
) {
  if (!game || game.score !== 0) return false; // the opponent must have lost
  if (String(game.status || "").toLowerCase() !== "resign") return false; // resignation only
  const totalPly = game.totalPly ?? game.ucis?.length ?? 0;
  if (!totalPly || totalPly > maxPly) return false; // short game (opening / early middlegame)
  const frac = opponentEndClockFraction(game);
  if (frac == null) return false; // can't confirm a healthy clock → keep the game
  return frac >= minClockFrac;
}

// Aggregate the games one colour at a time. Each path through the trie is a line
// the opponent has actually played, with how often and how well they scored.
export function buildOpeningTrie(
  games,
  color,
  { maxPlies = MAX_PLIES, speedFilter = "all", recency = true, excludeCollapse = true } = {},
) {
  const root = createOpeningTrie();
  const filtered =
    speedFilter !== "all" ? games.filter((g) => g.speed === speedFilter) : games;
  // Anchor recency to the newest game ONCE (not per game — that was the O(N²)). Feeding
  // the same anchor to every insert reproduces the old gameWeight output exactly.
  const anchorTs = trieAnchorTs(filtered);
  for (const game of filtered) {
    insertGameIntoTrie(root, game, color, { maxPlies, anchorTs, recency, excludeCollapse });
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
  const x = a.line || branchPathKey(a.ucis || []);
  const y = b.line || branchPathKey(b.ucis || []);
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
  { speedFilter = "all", now = Date.now(), excludeCollapse = true } = {},
) {
  const filtered = (
    speedFilter !== "all" ? games.filter((g) => g.speed === speedFilter) : games
  ).filter((g) => g.color === color && !(excludeCollapse && isEarlyResignCollapse(g)));

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
  const ancestorFreq = new Map();
  const ancestorSeenGameIds = new Map();
  let droppedCount = 0;

  for (const game of filtered) {
    const terminal = extractOpponentTerminalOpening(game);
    if (!terminal) {
      droppedCount += 1;
      continue;
    }
    const fenBefore = fenBeforeLastMove(terminal.ucis);
    if (fenBefore) {
      if (!ancestorFreq.has(fenBefore)) {
        ancestorFreq.set(fenBefore, { count: 0, frequency: 0, w: 0, d: 0, l: 0, games: 0, scorePct: 0 });
        ancestorSeenGameIds.set(fenBefore, new Set());
      }
      const seenAncestors = ancestorSeenGameIds.get(fenBefore);
      const skipAncestor =
        game.gameId && seenAncestors.has(game.gameId);
      if (!skipAncestor) {
        if (game.gameId) seenAncestors.add(game.gameId);
        const ancestor = ancestorFreq.get(fenBefore);
        ancestor.count += 1;
        if (game.score === 1) ancestor.w += 1;
        else if (game.score === 0.5) ancestor.d += 1;
        else ancestor.l += 1;
      }
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
  const ancestorTotalGames = filtered.length || 1;
  for (const info of ancestorFreq.values()) {
    info.frequency = info.count / ancestorTotalGames;
    const n = (info.w || 0) + (info.d || 0) + (info.l || 0);
    info.games = n;
    info.scorePct = n > 0 ? Math.round(((info.w + 0.5 * info.d) / n) * 100) : 0;
  }
  return { branches, droppedCount, ancestorFreq };
}

/** Opponent W/D/L + score% for one colour, optionally restricted to a speed filter. */
export function opponentColorStats(games, color, { speedFilter = "all" } = {}) {
  const filtered =
    speedFilter !== "all" ? (games || []).filter((g) => g.speed === speedFilter) : games || [];
  return colorResultStats(filtered, color);
}

/** Opponent's overall score% in games for one colour (used as the prep baseline). */
export function opponentColorBaseline(games, color, { speedFilter = "all" } = {}) {
  const stats = opponentColorStats(games, color, { speedFilter });
  return stats.games > 0 ? stats.scorePct : 50;
}

/**
 * Downweight prep value when the opponent performs at/above baseline.
 * Returns 1 when empirical data is missing (do not penalize rare samples).
 */
export function opponentStruggleFactor(opponentScorePct, baselineScorePct = 50) {
  if (opponentScorePct == null) return 1;
  const baseline = Math.max(baselineScorePct, 1);
  const ratio = Math.min(1, opponentScorePct / baseline);
  return 1 - ratio;
}

/** Frequent branch where opponent empirically performs at/above baseline — not a prep target. */
export function isOpponentComfortZone(
  entry,
  baselineScorePct = 50,
  { minGames = SCOUT_PREFILTER_EMPIRICAL_MIN_GAMES } = {},
) {
  const oppGames = entry?.ancestorGames ?? entry?.games ?? 0;
  if (oppGames < minGames) return false;
  const oppScore = entry?.ancestorScorePct ?? entry?.scorePct;
  if (oppScore == null) return false;
  return oppScore >= baselineScorePct;
}

/** Prep value: frequent × Stockfish edge × opponent struggle (empirical performance). */
export function openingReproducibilityScore(entry, baselineScorePct = 50) {
  const ancestorFrequency = entry?.ancestorFrequency ?? 0.001;
  const stockfishAdvantage = Math.max(0, entry?.prefilterScore ?? 0);
  const empiricalScore = entry?.ancestorScorePct ?? entry?.scorePct ?? null;
  const struggle = opponentStruggleFactor(empiricalScore, baselineScorePct);
  return ancestorFrequency * stockfishAdvantage * struggle;
}

/** Minimum off-modal struggle floor so rare blunders Stockfish can punish stay in the pool. */
export const SCOUT_STRUGGLE_PRIOR_FLOOR = 0.08;
/** Prior of a modal, non-reproducible one-off (struggle 0, offModal 1, prefixGames 0):
 *  SCOUT_STRUGGLE_PRIOR_FLOOR * (log1p(0) + 0.1). Branches at/below this carry NO
 *  exploitability signal at all — they are transposition noise, safe to drop pre-engine. */
export const SCOUT_PRIOR_NOISE_FLOOR = SCOUT_STRUGGLE_PRIOR_FLOOR * 0.1;
/** Off-modal exponent in the exploitability prior (sub-linear so rarity helps but doesn't dominate). */
export const SCOUT_OFFMODAL_PRIOR_EXP = 0.7;

/**
 * Walk the opening trie along a UCI path. The trie keys children by `${uci}|${san}`,
 * so we match on the uci prefix. Returns per-ply nodes with their w/d/l, scorePct, and
 * `moveShare` (how often, among games that reached the parent, the opponent chose this move).
 * Stops at the first uci not present in the trie or at the trie's ply cap.
 */
export function triePrefixStats(trie, ucis) {
  const out = [];
  let node = trie;
  for (let i = 0; i < (ucis || []).length; i += 1) {
    if (!node?.children?.size) break;
    const parentGames = node.gameCount || 0;
    let child = null;
    for (const [key, c] of node.children) {
      const sep = key.indexOf("|");
      const uci = sep >= 0 ? key.slice(0, sep) : key;
      if (uci === ucis[i]) {
        child = c;
        break;
      }
    }
    if (!child) break;
    const gc = child.gameCount || 0;
    out.push({
      ply: i,
      uci: ucis[i],
      gameCount: gc,
      w: child.w || 0,
      d: child.d || 0,
      l: child.l || 0,
      scorePct: gc > 0 ? Math.round(((child.w + 0.5 * child.d) / gc) * 100) : 0,
      moveShare: parentGames > 0 ? gc / parentGames : 0,
    });
    node = child;
  }
  return out;
}

/**
 * Empirical "struggle" + rarity for one opening branch, resolved at the deepest prefix
 * with enough games to trust (n ≥ minGames). Solves the granularity-vs-sample-size
 * tension: a rare deep leaf borrows its struggle signal from the line family it belongs
 * to, instead of asserting anything from an n=1 leaf.
 *   struggle  — 0..1, how far the family's Wilson-upper score sits below the opponent's
 *               own baseline (0 = at/above baseline, no measured weakness).
 *   offModal  — 1/moveShare of the terminal move (how rarely they pick it here); rare,
 *               off-book replies are likelier to be unprepared.
 *   prefixGames — family sample size backing the struggle signal.
 */
export function branchStruggle(trie, ucis, baselineScorePct = 50, { minGames = SLIP_MIN_GAMES } = {}) {
  const empty = { struggle: 0, offModal: 1, prefixGames: 0, prefixPly: -1, scorePct: null };
  if (!trie || !ucis?.length) return empty;
  const stats = triePrefixStats(trie, ucis);
  if (!stats.length) return empty;
  let chosen = null;
  for (let i = stats.length - 1; i >= 0; i -= 1) {
    if (stats[i].gameCount >= minGames) {
      chosen = stats[i];
      break;
    }
  }
  const terminal = stats[stats.length - 1];
  const offModal = terminal.moveShare > 0 ? Math.min(50, 1 / Math.max(terminal.moveShare, 0.02)) : 1;
  if (!chosen) {
    return { struggle: 0, offModal, prefixGames: 0, prefixPly: -1, scorePct: null };
  }
  const wilsonUpper = wilsonScoreUpperPct(chosen.w, chosen.d, chosen.l);
  const struggle = Math.max(0, baselineScorePct - wilsonUpper) / 100;
  return {
    struggle,
    offModal,
    prefixGames: chosen.gameCount,
    prefixPly: chosen.ply,
    scorePct: chosen.scorePct,
  };
}

/**
 * Cheap (no-engine) prior for which branches deserve a Stockfish read. Centred on
 * exploitability — empirical struggle and off-modal rarity — NOT raw frequency, so
 * rare lines the opponent can't handle reach the engine pool. Family-level
 * reproducibility (log of prefix games) keeps truly one-off noise from crowding out
 * recurring weaknesses. Falls back to branchScore when no trie is available.
 */
export function branchExploitabilityPrior(branch, { trie, baselineScorePct = 50 } = {}) {
  if (!trie) return branch?.branchScore ?? 0;
  const struggle = branch?.exploitabilityStruggle;
  const offModal = branch?.offModal;
  const prefixGames = branch?.prefixGames;
  const stats = (struggle == null || offModal == null || prefixGames == null)
    ? branchStruggle(trie, branch?.ucis, baselineScorePct)
    : null;
  const s = struggle ?? stats?.struggle ?? 0;
  const o = offModal ?? stats?.offModal ?? 1;
  const n = prefixGames ?? stats?.prefixGames ?? 0;
  const reproducibility = Math.log1p(n) + 0.1;
  return (s + SCOUT_STRUGGLE_PRIOR_FLOOR) * Math.pow(Math.max(o, 1), SCOUT_OFFMODAL_PRIOR_EXP) * reproducibility;
}

/**
 * Logical replacement for the old slice(0, 300) cut. Given branches already sorted by
 * exploitabilityPrior (descending), keep every branch whose prior shows a real signal
 * (> noiseFloor), but always keep at least `minKeep` (so the Maia pool stays full) and
 * never more than `ceiling` (a pathological-corpus safety net, NOT the primary cut).
 * Pure: returns a prefix slice of the input, order preserved.
 */
export function trimRankedBranches(
  sortedBranches,
  { minKeep = SCOUT_BRANCH_MIN_KEEP, ceiling = SCOUT_BRANCH_HARD_CEILING, noiseFloor = SCOUT_PRIOR_NOISE_FLOOR } = {},
) {
  if (!sortedBranches?.length) return [];
  let keep = 0;
  while (keep < sortedBranches.length && (sortedBranches[keep].exploitabilityPrior ?? 0) > noiseFloor) {
    keep += 1;
  }
  keep = Math.min(ceiling, Math.max(minKeep, keep));
  return sortedBranches.slice(0, keep);
}

/**
 * Rank exact per-game opening branches; top N feed Stockfish/Maia. With a `trie` +
 * `baselineScorePct`, branches are ranked by the exploitability prior (struggle × rarity
 * × family reproducibility) and annotated with struggle/offModal/prefixGames for the
 * downstream prefilter gate. Without a trie, falls back to branchScore ordering.
 */
export function rankedOpeningBranches(
  games,
  color,
  { speedFilter = "all", limit = SCOUT_BRANCH_SCORE_CAP, now = Date.now(), trie = null, baselineScorePct = 50 } = {},
) {
  const { branches, ancestorFreq } = aggregateOpeningBranches(games, color, { speedFilter, now });
  if (trie) {
    for (const b of branches) {
      const { struggle, offModal, prefixGames } = branchStruggle(trie, b.ucis, baselineScorePct);
      b.exploitabilityStruggle = struggle;
      b.offModal = offModal;
      b.prefixGames = prefixGames;
      b.exploitabilityPrior = branchExploitabilityPrior(b, { trie, baselineScorePct });
    }
    branches.sort(
      (a, b) =>
        (b.exploitabilityPrior || 0) - (a.exploitabilityPrior || 0) ||
        b.branchScore - a.branchScore ||
        (b.lastDatestamp || 0) - (a.lastDatestamp || 0) ||
        b.games - a.games ||
        a.line.localeCompare(b.line),
    );
  } else {
    branches.sort(
      (a, b) =>
        b.branchScore - a.branchScore ||
        (b.lastDatestamp || 0) - (a.lastDatestamp || 0) ||
        b.games - a.games ||
        a.line.localeCompare(b.line),
    );
  }
  const ranked = limit > 0 ? branches.slice(0, limit) : branches;
  return { branches: ranked, ancestorFreq };
}

/** @deprecated Trie bridge removed — use rankedOpeningBranches(games, color). */
export function rankedOpeningLines(
  gamesOrTrie,
  { color, speedFilter = "all", oppColor = null, limit = SCOUT_BRANCH_SCORE_CAP } = {},
) {
  if (Array.isArray(gamesOrTrie)) {
    const c = color ?? oppColor;
    if (!c) return [];
    return rankedOpeningBranches(gamesOrTrie, c, { speedFilter, limit }).branches;
  }
  return [];
}

// Unified ranked game plan: exploitability first, collapse nested prefixes, no row cap.
function ancestorFrequencyForLine(line, ancestorFreq) {
  if (!ancestorFreq?.size || !line?.ucis?.length) return line?.ancestorFrequency ?? 0.001;
  const fenBefore = fenBeforeLastMove(line.ucis);
  const info = fenBefore ? ancestorFreq.get(fenBefore) : null;
  return info?.frequency ?? line?.ancestorFrequency ?? 0.001;
}

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
    ancestorFreq = null,
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
          line: branchPathKey(normalized.ucis),
          maiaWdl: g.maiaWdl,
          prefilterScore: g.prefilterScore,
        },
        baselineScorePct,
        { maiaScorePct: g.maiaScorePct ?? null },
      );
      enriched.ancestorFrequency = ancestorFrequencyForLine(
        { ...enriched, ucis: normalized.ucis },
        ancestorFreq,
      );
      if (!enriched.lastSeen && games && lineLastSeen) {
        enriched.lastSeen = lineLastSeen(games, enriched.ucis, { color: oppColor, speedFilter });
      }
      return enriched;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aHasMaia = a.maiaScorePct != null;
      const bHasMaia = b.maiaScorePct != null;
      if (aHasMaia && bHasMaia && a.maiaScorePct !== b.maiaScorePct) {
        return a.maiaScorePct - b.maiaScorePct;
      }
      if (aHasMaia !== bHasMaia) return aHasMaia ? -1 : 1;
      const reproducibilityA = openingReproducibilityScore(a, baselineScorePct);
      const reproducibilityB = openingReproducibilityScore(b, baselineScorePct);
      if (reproducibilityA !== reproducibilityB) {
        return reproducibilityB - reproducibilityA;
      }
      const aStamp = a.lastSeen?.lastDatestamp ?? 0;
      const bStamp = b.lastSeen?.lastDatestamp ?? 0;
      const aKey = a.line || triePathKey(a.ucis || []);
      const bKey = b.line || triePathKey(b.ucis || []);
      return (
        bStamp - aStamp ||
        (b.branchScore || 0) - (a.branchScore || 0) ||
        b.share - a.share ||
        b.games - a.games ||
        aKey.localeCompare(bKey)
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

/** Production Module B selector alias — keep rankGamePlan as the implementation. */
export function selectProductionRoutes(lines, baselineScorePct, options = {}) {
  return rankGamePlan(lines, baselineScorePct, {
    ...options,
    limit: options.limit ?? SCOUT_GAME_PLAN_LIMIT,
  });
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

export function fenBeforeLastMove(ucis) {
  if (!ucis?.length) return null;
  const chess = new Chess();
  for (let i = 0; i < ucis.length - 1; i += 1) {
    const uci = ucis[i];
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch (_) {
      return null;
    }
  }
  return chess.fen();
}

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

export function scoutUrl(username, max, { pgnInJson = false, excludeBullet = false } = {}) {
  const safe = encodeURIComponent(String(username || "").trim());
  // Bullet think-times are too compressed to tell a real preparation gap from a
  // mouse-slip, so bullet is dropped at the source. The production scout
  // (streamGames / scoutStreamUrl) also excludes bullet now.
  const perfType = excludeBullet ? "blitz,rapid,classical" : "bullet,blitz,rapid,classical";
  const params = new URLSearchParams({
    moves: "true",
    clocks: "true",
    evals: "false",
    opening: "false",
    perfType,
    variant: "standard",
  });
  // pgnInJson lets the ND-JSON export carry both the PGN (parsed by the existing
  // PGN reader) AND the raw centisecond `clocks` array the PGN `[%clk]` rounds away.
  if (pgnInJson) params.set("pgnInJson", "true");
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
    // Bullet is dropped at the source: its think-times are too compressed to
    // separate a real preparation gap from a mouse-slip, and bullet openings are
    // noisy prep signal. The production scout streams blitz/rapid/classical only.
    perfType: "blitz,rapid,classical",
    variant: "standard",
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

    // ND-JSON (not PGN) so we keep the raw centisecond `clocks` array that `[%clk]`
    // rounds to whole seconds — the time-discrimination features need sub-second think.
    const resp = await doFetch(scoutUrl(username, max, { pgnInJson: true, excludeBullet: true }), {
      headers: { Accept: "application/x-ndjson" },
      signal,
    });
    if (resp.status === 404) throw new Error(`No Lichess user named "${username}"`);
    if (resp.status === 429) throw new Error(SCOUT_ERR_RATE_LIMIT);
    if (!resp.ok) throw new Error(`Lichess responded ${resp.status}`);
    const games = parseNdjsonGames(await resp.text(), username);

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
