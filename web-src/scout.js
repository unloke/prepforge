// Opponent scouting: fetch a Lichess player's recent games (public PGN export,
// CORS-open, no token), aggregate their opening tendencies per colour, and grade
// the user's own repertoires against the lines that opponent actually plays.
//
// Everything runs in the browser — the PrepForge server is never involved in the
// fetch or the number-crunching. Parsing keeps deeper moves for weakness/engine
// analysis. Display helpers cap their presentation; production reachability uses
// every observed opening move in the live trie.
//
// Pure functions + an injected-deps fetcher, unit-testable without network/DOM.

import { Chess } from "chess.js";
import { preparationValue, routeKey, selectPreparationRoutes, opponentOnlyReach } from "./scout-preparation-value.js";
import { replayGuardedRoutes } from "./scout-path-guard.js";
import { decisionShifted } from "./scout-decisions.js";

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
export const MAX_PLIES = 16; // default depth for compact display
export const ANALYZE_PLIES = 24; // deeper capture for weakness / engine scan
/** Minimum raw full-prefix support for historical weakness. */
export const GAME_PLAN_MIN_GAMES = 3;
/** Max game-plan rows per colour; fewer supported targets are allowed. */
export const SCOUT_GAME_PLAN_LIMIT = 12;
/** Floor for recommendTargets / refutation repertoire gates. */
export const WEAKNESS_MIN_GAMES = 7;
export const SLIP_MIN_GAMES = 3;

export const SCOUT_RECENCY_HALF_LIFE_DAYS = 90;
export const SCOUT_LENGTH_SATURATION_PLIES = 40;
export const SCOUT_BRANCH_SCORE_CAP = 48;
/** Hard browser resource limit: at most 300 leaf positions per colour. */
export const SCOUT_BRANCH_HARD_CEILING = 300;
/** Any observed opponent choice below this conditional share makes a route poor prep. */
export const SCOUT_MIN_ROUTE_REACH = 0.1;
/** Fewer parent games leave an opponent decision unmeasured, rather than certain. */
import { opponentMoveProbability } from "./scout-probability.js";
export const SCOUT_STOCKFISH_DEPTH = 8;
export const SCOUT_MAIA_LIMIT = 12;
export const SCOUT_SCORING_VERSION = 10;
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

/** Wilson lower bound of score% (draw = 0.5). Used for display, not ranking. */
export function wilsonScorePct(w, d, l, z = 1.96) {
  const n = (w || 0) + (d || 0) + (l || 0);
  if (!n) return 50;
  const p = ((w || 0) + 0.5 * (d || 0)) / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.round(((center - margin) / denom) * 100);
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
  } catch {
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

export function mergeEngineIntoTargets(targets, enginePatterns) {
  if (!enginePatterns?.size) return targets;
  return targets.map((target) => {
    // Scan patterns are keyed by the full path (scans reach 24 plies).
    const pathKey = branchPathKey(target.ucis);
    let pattern = enginePatterns.get(pathKey);
    if (!pattern) {
      // Pattern may annotate a prefix of this target, not a descendant or sibling;
      // the deepest such prefix is the most specific.
      let best = -1;
      for (const [key, value] of enginePatterns) {
        if (key.length > best && pathKey.startsWith(`${key}>`)) {
          pattern = value;
          best = key.length;
        }
      }
    }
    if (!pattern) return target;
    return { ...target, enginePattern: pattern, hasEngineMistake: true };
  });
}

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

// Lichess exports carry [GameId]. [Site] is lichess.org/game/<id> now, so its
// first path segment was "game" for every game and dedup kept only one.
function parseGameId(block) {
  const id = headerValue(block, "GameId");
  if (id) return id;
  const match = (headerValue(block, "Site") || "").match(/lichess\.org\/(?:game\/)?([a-zA-Z0-9]+)/);
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
  return medianOf(values.filter((v) => v != null).map((v) => Math.abs(v - med))) ?? 0;
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

// The one recency decay every Scout weight uses: a game's weight halves every
// `halfLifeDays` before `anchorTs` (games after it count in full); an undated game gets
// the caller's fixed `undated` weight. Callers differ only in those two parameters:
//   display trie 45 days / 0.3, route selection 90 days / 1, branch score 90 days / 0.3.
function recencyDecay(game, anchorTs, halfLifeDays, undated) {
  if (!(game.datestamp > 0)) return undated;
  return 2 ** (-Math.max(0, (anchorTs - game.datestamp) / MS_PER_DAY) / halfLifeDays);
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
    } catch {
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
  // resignation, and time forfeits carry their own termination.
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

// ---------------------------------------------------------------------------
// Opening aggregation (trie of the opponent's moves)
// ---------------------------------------------------------------------------

function trieNode() {
  return { count: 0, score: 0, gameCount: 0, w: 0, d: 0, l: 0, selectionWdl: { w: 0, d: 0, l: 0, weight: 0, weightSquared: 0 }, children: new Map() };
}

function incrementSelection(node, score, weight) {
  const x = node.selectionWdl;
  x[score === 1 ? "w" : score === 0.5 ? "d" : "l"] += weight;
  x.weight += weight;
  x.weightSquared += weight * weight;
}

function incrementResult(node, score) {
  node[score === 1 ? "w" : score === 0.5 ? "d" : "l"] += 1;
}

function wdlScorePct(w, d, n) {
  return n > 0 ? Math.round(((w + 0.5 * d) / n) * 100) : 0;
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
  return recency ? recencyDecay(game, anchorTs, TRIE_RECENCY_HALF_LIFE_DAYS, 0.3) : 1;
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
  const selectionWeight = recencyDecay(game, anchor, SCOUT_RECENCY_HALF_LIFE_DAYS, 1);
  incrementSelection(root, game.score, selectionWeight);
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
    incrementSelection(node, game.score, selectionWeight);
  }
  return root;
}

function nodeScorePct(node) {
  return node.count > 0 ? Math.round((node.score / node.count) * 100) : 0;
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
  const initial = game?.timeControl?.baseSeconds;
  if (!(initial > 0)) return null;
  const clocks = game.clockAfterPly || [];
  const parity = game.color === "white" ? 0 : 1; // clocks[p] is after ply p: even = White
  for (let p = clocks.length - 1; p >= 0; p -= 1) {
    if (p % 2 === parity && Number.isFinite(clocks[p])) return clocks[p] / initial;
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

/**
 * The games the report actually analyses: inside the speed filter, minus the
 * early-resign collapses. Pass a `color` to narrow to one side; omit it for both.
 * Every count on screen (colour tab, section W/D/L, profile total, speed chips,
 * coverage) reads this one set, so they add up.
 */
export function analyzedGames(games, color = null, { speedFilter = "all" } = {}) {
  return (games || []).filter(
    (g) =>
      (!color || g.color === color) &&
      (speedFilter === "all" || g.speed === speedFilter) &&
      !isEarlyResignCollapse(g),
  );
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
  const eligible = filtered.filter(g => g.color === color && (!excludeCollapse || !isEarlyResignCollapse(g)));
  const anchorTs = trieAnchorTs(eligible);
  Object.defineProperties(root, { selectionAnchorTs: { value: anchorTs }, selectionMaxPlies: { value: maxPlies } });
  for (const game of filtered) {
    insertGameIntoTrie(root, game, color, { maxPlies, anchorTs, recency, excludeCollapse });
  }
  return root;
}

// A line earns the weak-spot badge when Maia rates their play from its end
// clearly below their usual result. A line a couple of points under baseline is
// neither a weakness to punish nor a weapon to fear, so it stays neutral.
export const SCOUT_ATTACK_MIN_MARGIN = 6;

export function enrichPrepTarget(g, baselineScorePct, { maiaScorePct = null } = {}) {
  const maia = maiaScorePct ?? g.maiaScorePct ?? null;
  const below = maia == null ? 0 : baselineScorePct - maia;
  const isAttack = below >= SCOUT_ATTACK_MIN_MARGIN;
  const isWeapon = !isAttack && maia != null && below <= -SCOUT_ATTACK_MIN_MARGIN;
  return {
    ...g,
    maiaScorePct: maia,
    belowBaseline: isAttack ? below : 0,
    opportunity: g.share * (isAttack ? below * 0.25 : 0),
    prepCategory: isAttack ? "attack" : isWeapon ? "weapon" : "neutral",
  };
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

    const R = recencyDecay(game, newestTs, SCOUT_RECENCY_HALF_LIFE_DAYS, 0.3);
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
    incrementResult(row, game.score);
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
      scorePct: wdlScorePct(row.w, row.d, n),
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

/** Opponent W/D/L + score% for one colour over the games the report analyses. */
export function opponentColorStats(games, color, { speedFilter = "all" } = {}) {
  return colorResultStats(analyzedGames(games, color, { speedFilter }), color);
}

/** Opponent's overall score% in games for one colour (used as the prep baseline). */
export function opponentColorBaseline(games, color, { speedFilter = "all" } = {}) {
  const stats = opponentColorStats(games, color, { speedFilter });
  return stats.games > 0 ? stats.scorePct : 50;
}

/** Same eligible cohort and recency weights as the route posterior. */
export function selectionBaselineFromTrie(trie) {
  const x = trie.selectionWdl;
  const weight = x?.weight || 0;
  const smoothing = 0.001; // Avoid zero prior components without creating weakness in an unbeaten cohort.
  return { score: weight > 0 ? (x.w + 0.5 * x.d) / weight : 0.5,
    prior: { w: ((x?.w || 0) + smoothing) / (weight + 3 * smoothing),
      d: ((x?.d || 0) + smoothing) / (weight + 3 * smoothing), l: ((x?.l || 0) + smoothing) / (weight + 3 * smoothing) } };
}

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
      parentGames,
      parentWeight: node.selectionWdl?.weight,
      selectionWdl: child.selectionWdl,
      gameCount: gc,
      w: child.w || 0,
      d: child.d || 0,
      l: child.l || 0,
      scorePct: wdlScorePct(child.w || 0, child.d || 0, gc),
      moveShare: parentGames > 0 ? gc / parentGames : 0,
    });
    node = child;
  }
  return out;
}

/** The weakest sample-aware opponent choice determines route plausibility. */
export function opponentRoutePlausibility(trie, ucis, opponentColor, prefixStats = null) {
  const empty = { complete: false, weakestEstimatedProbability: 0, decisionCount: 0,
    deepestDecisionPly: null, weakestDecision: null };
  if (!trie || !ucis?.length || !["white", "black"].includes(opponentColor)) return empty;
  const stats = prefixStats ?? triePrefixStats(trie, ucis);
  if (stats.length !== ucis.length) return empty;
  const evidence = { complete: true, weakestEstimatedProbability: null, decisionCount: 0,
    deepestDecisionPly: null, weakestDecision: null };
  for (const node of stats) {
    const mover = node.ply % 2 === 0 ? "white" : "black";
    if (mover !== opponentColor) continue;
    const estimate = opponentMoveProbability(node.gameCount, node.parentGames, "jeffreys");
    evidence.decisionCount += 1;
    evidence.deepestDecisionPly = node.ply + 1;
    if (evidence.weakestEstimatedProbability == null ||
      estimate < evidence.weakestEstimatedProbability) {
      evidence.weakestEstimatedProbability = estimate;
      evidence.weakestDecision = { ply: node.ply + 1, parentGames: node.parentGames,
        moveGames: node.gameCount, rawProbability: node.moveShare, estimate };
    }
  }
  return evidence;
}

/** Compatibility score: null means the route contains no opponent decision. */
export function opponentRouteReach(trie, ucis, opponentColor) {
  return opponentRoutePlausibility(trie, ucis, opponentColor).weakestEstimatedProbability;
}

/** Allocate bounded engine reads by personal preparation value, without family quotas. */
export function trimRankedBranches(
  branches,
  { ceiling = SCOUT_BRANCH_HARD_CEILING } = {},
) {
  return (branches || [])
    .map(route => ({ route, evidence: preparationValue(route, route.baselineScorePct ?? 50) }))
    .sort((a, b) => b.evidence.value - a.evidence.value || b.evidence.softValue - a.evidence.softValue ||
      (b.route.continuationShare ?? 0) - (a.route.continuationShare ?? 0) || routeKey(a.route).localeCompare(routeKey(b.route)))
    .slice(0, ceiling)
    .map(entry => entry.route);
}

/** Attach anchor evidence to an observed route (mutates `b`): the deepest
 * prefix ending on an opponent move with enough games to judge them. */
export function annotateRouteEvidence(b, trie, color, { total = trie.gameCount, baselineScorePct = 50,
  selectionBaseline = selectionBaselineFromTrie(trie) } = {}) {
  const effective = x => x?.weightSquared > 0 ? x.weight ** 2 / x.weightSquared : 0;
  b.evidenceGames = total;
  b.baselineScorePct = baselineScorePct;
  b.selectionBaseline = selectionBaseline;
  b.oppColor = color;
  const stats = triePrefixStats(trie, b.ucis);
  b.routePlausibility = opponentRoutePlausibility(trie, b.ucis, color, stats);
  b.routeReach = b.routePlausibility.weakestEstimatedProbability;
  // The anchor ends on an opponent move, like every row: our own move choice
  // is not evidence about them. No supported anchor leaves the row unranked.
  let k = -1;
  for (let i = stats.length - 1; i >= 0; i--) {
    if ((i % 2 === 0 ? "white" : "black") !== color) continue;
    if (stats[i].gameCount >= GAME_PLAN_MIN_GAMES && effective(stats[i].selectionWdl) >= 2) { k = i; break; }
  }
  const anchor = k >= 0 ? stats[k] : null;
  const leaf = stats.length === b.ucis.length ? stats.at(-1) : null;
  b.anchorUcis = b.ucis.slice(0, k + 1);
  b.anchorSans = b.sans.slice(0, k + 1);
  b.evidencePlies = k + 1;
  b.exactGames = leaf?.gameCount ?? b.games;
  b.continuationShare = anchor?.selectionWdl?.weight > 0
    ? (leaf?.selectionWdl?.weight ?? 0) / anchor.selectionWdl.weight : 0;
  // Games behind each move of the line: the most common continuation through a
  // branch follows the more-played move at the first point of difference.
  b.pathGames = stats.map(node => node.gameCount);
  b.preparationDecisions = stats.slice(0, k + 1).filter(node => (node.ply % 2 === 0 ? "white" : "black") === color)
    .map(node => ({ ply: node.ply + 1, moveGames: node.gameCount, parentGames: node.parentGames, moveWeight: node.selectionWdl?.weight, parentWeight: node.parentWeight }));
  b.routeSupportGames = anchor?.gameCount ?? 0;
  b.routeScorePct = anchor?.scorePct ?? b.scorePct;
  b.routeWdl = anchor ? { w: anchor.w, d: anchor.d, l: anchor.l } : null;
  b.selectionWdl = anchor?.selectionWdl;
  b.conditionalReach = anchor ? opponentOnlyReach(b) : 0;
  return b;
}

/** Observed full opening routes, each scored by its anchor: the deepest prefix
 * with enough games. No invented moves and no truncated rows. */
// Batch selection tries, memoised per games array. Scout's games array only ever grows
// (push), so (length, last game) identifies its content; the report and the prefilter
// rank the same games several times per render, and the streaming display tries (session
// anchor) can never stand in for the newest-game anchor the selection weights need.
const batchSelectionTries = new WeakMap();
function batchSelectionTrie(games, color, speedFilter) {
  let byScope = batchSelectionTries.get(games);
  if (!byScope) batchSelectionTries.set(games, (byScope = new Map()));
  const scope = `${color}|${speedFilter}`;
  const hit = byScope.get(scope);
  if (hit && hit.length === games.length && hit.last === games[games.length - 1]) return hit.trie;
  const trie = buildOpeningTrie(games, color, { speedFilter, maxPlies: Infinity });
  byScope.set(scope, { length: games.length, last: games[games.length - 1], trie });
  return trie;
}

export function rankedOpeningBranches(
  games,
  color,
  { speedFilter = "all", limit = SCOUT_BRANCH_SCORE_CAP, now = Date.now(), trie = null, baselineScorePct = 50, plausibleOnly = true } = {},
) {
  const eligibleGames = games.filter(g => g.color === color && (speedFilter === "all" || g.speed === speedFilter) && !isEarlyResignCollapse(g));
  // Streaming display tries use a session anchor. Fixed-strength priors require the newest eligible game.
  if (!trie || trie.selectionAnchorTs !== trieAnchorTs(eligibleGames) || trie.selectionMaxPlies !== Infinity)
    trie = batchSelectionTrie(games, color, speedFilter);
  const selectionBaseline = selectionBaselineFromTrie(trie);
  const { branches } = aggregateOpeningBranches(games, color, { speedFilter, now });
  const total = trie.gameCount ?? branches.reduce((n,b) => n + b.games, 0);
  for (const b of branches) annotateRouteEvidence(b, trie, color, { total, baselineScorePct, selectionBaseline });
  const plausible = !plausibleOnly ? branches : branches.filter((branch) => branch.routePlausibility.complete &&
    (branch.routeReach == null || branch.routeReach >= SCOUT_MIN_ROUTE_REACH));
  const ranked = trimRankedBranches(plausible, { ceiling: limit > 0 ? limit : plausible.length });
  return { branches: ranked };
}


/** The selector's input: supported, opponent-terminal, reachable lines with terminal FENs. */
export function gamePlanCandidates(lines, baselineScorePct, { minGames = GAME_PLAN_MIN_GAMES, oppColor = null } = {}) {
  return lines
    .filter((g) => (g.routeSupportGames ?? g.games) >= minGames)
    .map((g) => {
      if (!oppColor) return enrichPrepTarget(g, baselineScorePct);
      const normalized = normalizeToOpponentTerminal(g.ucis, g.sans, oppColor);
      if (!normalized) return null;
      const enriched = enrichPrepTarget(
        {
          ...g,
          ucis: normalized.ucis,
          sans: normalized.sans,
          terminalFen: normalized.ucis.length === g.ucis.length ? g.terminalFen : null,
          line: branchPathKey(normalized.ucis),
          maiaWdl: g.maiaWdl,
          prefilterScore: g.prefilterScore,
        },
        baselineScorePct,
        { maiaScorePct: g.maiaScorePct ?? null },
      );
      return enriched;
    })
    .filter((line) => line && (line.routeReach == null || line.routeReach >= SCOUT_MIN_ROUTE_REACH))
    .map((line) => ({ ...line, terminalFen: line.terminalFen ?? fenAfterLine(line.ucis) }));
}

/** Position after each ply of a line (index 0 = start). */
export function fensAlongLine(ucis) {
  const chess = new Chess();
  const fens = [chess.fen()];
  for (const uci of ucis || []) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      break;
    }
    fens.push(chess.fen());
  }
  return fens;
}

// One final budgeted set selection, shared by live and fallback reports. With a recorded
// path-guard run (`pathGuard`) the guarded selection is replayed instead.
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
    pathGuard = null,
  } = {},
) {
  const eligible = gamePlanCandidates(lines, baselineScorePct, { minGames, oppColor });
  let selected;
  if (pathGuard && oppColor) {
    const replay = replayGuardedRoutes(eligible, { baseline: baselineScorePct, limit },
      { ...pathGuard, fensFor: fensAlongLine, oppColor });
    selected = replay.picked;
    pathGuard.onReplay?.(replay);
  } else {
    selected = selectPreparationRoutes(eligible, { baseline: baselineScorePct, limit });
  }
  // The badge reads the selection's own evidence: Maia's leaf score against the SAME
  // baseline the selection measured it by (recency-weighted), with the honest gap.
  // A route the selector valued by a sliver stays neutral: a weak spot needs at least
  // SCOUT_ATTACK_MIN_MARGIN points, as enrichPrepTarget has always required.
  for (const route of selected) Object.assign(route, weakSpotLabel(route));
  if (oppColor && games && lineLastSeen) {
    for (const route of selected) if (!route.lastSeen) {
      route.lastSeen = lineLastSeen(games, route.ucis, { color: oppColor, speedFilter });
    }
  }
  return selected;
}

/** Weak-spot / main-line badge from a selected route's preparationEvidence. */
export function weakSpotLabel(route) {
  const { value, maiaScore, baseline } = route.preparationEvidence;
  const basePct = Math.round(baseline * 100);
  const gap = maiaScore == null ? null : basePct - Math.round(maiaScore * 100);
  const attack = value > 0 && gap >= SCOUT_ATTACK_MIN_MARGIN;
  const prepCategory = attack ? "attack" : gap != null && gap <= -SCOUT_ATTACK_MIN_MARGIN ? "weapon" : "neutral";
  return { prepCategory, belowBaseline: attack ? gap : 0, weakSpotBaselinePct: basePct };
}

/** Production Module B selector alias — keep rankGamePlan as the implementation. */
/** Prefer an enabled mainline child; otherwise pick deterministically by UCI. */
function pickRepertoireReplyUci(children) {
  const enabled = [...(children || [])]
    .filter(([, meta]) => meta.is_enabled !== false)
    .sort(([a], [b]) => a.localeCompare(b));
  return (enabled.find(([, meta]) => meta.is_mainline) || enabled[0])?.[0] || null;
}

/** Next move in the player's repertoire after the opponent line (mainline-aware). */
export function suggestReplyFromRepertoire(lookup, lineUcis) {
  const { covered, deepestNodeId } = lineCoverage(lookup, lineUcis);
  if (covered < lineUcis.length || !deepestNodeId) return null;
  const uci = pickRepertoireReplyUci(lookup.childUci.get(deepestNodeId));
  return uci ? { uci, source: "repertoire" } : null;
}

/** Attach a recommended player reply from repertoire coverage or engine refutation. */
export function attachPrepReplies(targets, { lookups = [], refutations = [], oppColor } = {}) {
  const refByKey = new Map();
  for (const item of refutations || []) {
    const key = branchPathKey(item.candidate?.pathUcis || []);
    if (key && item.refutation) refByKey.set(key, item.refutation);
  }
  return (targets || []).map((target) => {
    const pathKey = branchPathKey(target.ucis || []);
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
      // "No answer in your prep" only means something when there is a prep to look in;
      // with no repertoire for this side every row would say it.
      needsPrep: !suggestedReply && (lookups || []).length > 0,
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
        // Their score in these games, from the same W/D/L the row's count and Wilson
        // bound use. The recency-weighted value is recent form, kept apart: shown as
        // "score" next to a real game count it read 1% for a 5-5 record.
        scorePct: wdlScorePct(child.w, child.d, child.gameCount),
        recentScorePct: nodeScorePct(child),
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

// Scout re-aggregates every branch on each streaming render, and the prefilter,
// selector and report replay every ranked route on each pass; most games share
// their opening lines, so replaying each through chess.js every time was a
// quarter of the render cost. Both replays are pure in `ucis`: memoize them in a
// bounded LRU. ~850 bytes per entry (the joined-UCI key dominates), so 4000 is a
// few MB, and eviction drops one oldest entry at a time rather than clearing.
const UCI_REPLAY_CACHE_MAX = 4000;

function lruUciMemo(replay) {
  const cache = new Map();
  return (ucis) => {
    const key = ucis.join(" ");
    if (cache.has(key)) {
      // Map iteration order is insertion order: re-insert to mark as recent.
      const fen = cache.get(key);
      cache.delete(key);
      cache.set(key, fen);
      return fen;
    }
    const fen = replay(ucis);
    if (cache.size >= UCI_REPLAY_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, fen);
    return fen;
  };
}

// Replays `ucis`; an illegal move yields null when `strict`, otherwise the
// position reached before it.
function replayUcis(ucis, strict) {
  const chess = new Chess();
  for (const uci of ucis) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      if (strict) return null;
      break;
    }
  }
  return chess.fen();
}

const fenBeforeLastMemo = lruUciMemo((ucis) => replayUcis(ucis.slice(0, -1), true));
const fenAfterLineMemo = lruUciMemo((ucis) => replayUcis(ucis, false));

export function fenBeforeLastMove(ucis) {
  return ucis?.length ? fenBeforeLastMemo(ucis) : null;
}

export function fenAfterLine(ucis) {
  return fenAfterLineMemo(ucis || []);
}

export const RECENT_CHANGE_MIN_GAMES = 3;
// The recent favourite must have gained this much share for the badge: with a
// near 50/50 split between two openings, the "most common" one flips between
// windows by chance, which used to light the badge up for no reason.
export const RECENT_CHANGE_MIN_SHIFT = 0.3;
export const RECENT_CHANGE_WINDOW = 20;

// Their newest 20 games of each colour against the 20 before (windows per colour, so a
// mostly-White history still gives Black a real sample). With Black the favourite reply
// is compared against the same first move, so a change in what their opponents open
// with is not read as a change in their repertoire.
function detectRecentChange(analyzed) {
  const changed = (color) => {
    const own = analyzed.filter((g) => g.color === color);
    return decisionShifted(own.slice(0, RECENT_CHANGE_WINDOW), own.slice(RECENT_CHANGE_WINDOW, 2 * RECENT_CHANGE_WINDOW),
      color, { minGames: RECENT_CHANGE_MIN_GAMES, minShift: RECENT_CHANGE_MIN_SHIFT });
  };
  return { white: changed("white"), black: changed("black") };
}

function colorResultStats(games, color) {
  const filtered = games.filter((g) => g.color === color);
  const wdl = { w: 0, d: 0, l: 0 };
  let scoreSum = 0;
  for (const g of filtered) {
    incrementResult(wdl, g.score);
    scoreSum += g.score;
  }
  const n = filtered.length;
  return { games: n, ...wdl, scorePct: n > 0 ? Math.round((scoreSum / n) * 100) : 0 };
}

export function opponentProfile(games) {
  // Only the games the report analyses: collapses are dropped everywhere they are
  // counted, so the profile total equals the two colour sections' counts. The speed
  // filter is deliberately not applied here — the speed chips have to keep counting
  // the other speeds so the user can switch to them.
  const analyzed = analyzedGames(games);
  const ratingsSeen = analyzed.map((g) => g.rating).filter((r) => r > 0);
  const speedCounts = { bullet: 0, blitz: 0, rapid: 0, classical: 0, unknown: 0 };
  analyzed.forEach((g) => {
    speedCounts[g.speed] = (speedCounts[g.speed] || 0) + 1;
  });
  return {
    total: analyzed.length,
    // Games fetched but not analysed (early resignations), so the report label can
    // account for every game the toolbar counter counted.
    skipped: (games || []).length - analyzed.length,
    ratingMin: ratingsSeen.length ? Math.min(...ratingsSeen) : null,
    ratingMax: ratingsSeen.length ? Math.max(...ratingsSeen) : null,
    ratingLast: analyzed[0]?.rating || null,
    speedCounts,
    recentlyChanged: detectRecentChange(analyzed),
    colorStats: {
      white: colorResultStats(analyzed, "white"),
      black: colorResultStats(analyzed, "black"),
    },
  };
}

// ---------------------------------------------------------------------------
// Fetching (with a small per-username cache)
// ---------------------------------------------------------------------------

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
  let received = 0; // every game block Lichess sent, kept or not (batch-full check)
  let lastDatestamp = null;

  const emitBlock = (block) => {
    const trimmed = String(block || "").trim();
    if (!trimmed) return;
    received += 1;
    // Pagination follows the export, even when parsing or deduplication drops a game.
    const stamp = parseScoutDatestamp(headerValue(trimmed, "UTCDate"), headerValue(trimmed, "UTCTime"));
    if (stamp > 0 && (lastDatestamp == null || stamp < lastDatestamp)) lastDatestamp = stamp;
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
    } catch {
      /* reader may already be closed */
    }
    if (!signal?.aborted) emitBlock(buffer);
  }
  return { accepted, emitted: accepted, received, lastDatestamp };
}

export function createScoutClient({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  // The games export 404s both for a missing account and for an existing one
  // whose games Lichess will not export; only the profile lookup tells them
  // apart. Telling a user that a real account "does not exist" sent them
  // hunting for a typo that was not there.
  async function notFoundError(username, signal) {
    try {
      const safe = encodeURIComponent(String(username || "").trim());
      const probe = await doFetch(`https://lichess.org/api/user/${safe}`, { signal });
      if (probe && probe.ok) {
        return new Error(`Lichess won't export ${username}'s games, so Scout can't read them.`);
      }
      if (probe?.status === 404) return new Error(`No Lichess user named "${username}"`);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return new Error(`Lichess did not export ${username}'s games, and Scout couldn't verify the account. Try again in a moment.`);
  }

  // streamGames(username, {color, since, until, onGame, signal}) -> {accepted, lastDatestamp}
  async function streamGames(username, { color, since, until, max, onGame, signal } = {}) {
    const resp = await doFetch(scoutStreamUrl(username, { color, since, until, max }), {
      headers: { Accept: "application/x-chess-pgn" },
      signal,
    });
    if (resp.status === 404) throw await notFoundError(username, signal);
    if (resp.status === 429) throw new Error(SCOUT_ERR_RATE_LIMIT);
    if (!resp.ok) throw new Error(`Lichess responded ${resp.status}`);
    return streamPgn(resp, username, onGame, signal);
  }

  return { streamGames };
}
