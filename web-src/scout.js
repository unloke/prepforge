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

export const SCOUT_MAX_GAMES = 500;

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
export const WEAKNESS_MIN_GAMES = 7;

export function triePathKey(ucis, maxPlies = MAX_PLIES) {
  return ucis.slice(0, maxPlies).join(">");
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
const CACHE_KEY = "prepforge.scout.cache.v2";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // opponents play new games constantly
const CACHE_CAP = 8;

// ---------------------------------------------------------------------------
// PGN parsing (multi-game export -> per-game opening records)
// ---------------------------------------------------------------------------

function headerValue(block, name) {
  const match = block.match(new RegExp(`\\[${name}\\s+"([^"]*)"\\]`));
  return match ? match[1] : null;
}

function parseSpeedBucket(timeControl) {
  if (!timeControl) return "unknown";
  const match = String(timeControl).match(/^(\d+)\+(\d+)$/);
  if (!match) return "unknown";
  const n = Number(match[1]);
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

// Movetext -> SAN tokens, openings only. Strips comments, variations, NAGs,
// move numbers, results, and lichess's clock/eval annotations.
export function movetextSans(movetext, maxPlies = MAX_PLIES) {
  const cleaned = movetext
    .replace(/\{[^}]*\}/g, " ") // comments / %clk
    .replace(/\([^)]*\)/g, " ") // variations (one level is enough for exports)
    .replace(/\$\d+/g, " ");
  const sans = [];
  for (const token of cleaned.split(/\s+/)) {
    if (!token || /^\d+\.+$/.test(token)) continue;
    if (token === "1-0" || token === "0-1" || token === "1/2-1/2" || token === "*") break;
    const san = token.replace(/^\d+\.+/, ""); // "1.e4" glued form
    if (san) sans.push(san);
    if (sans.length >= maxPlies) break;
  }
  return sans;
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
  const ratingRaw = headerValue(block, ratingHeader);
  const rating = ratingRaw ? Number(ratingRaw) || 0 : 0;

  const dateRaw = headerValue(block, "UTCDate");
  const datestamp = dateRaw ? Date.parse(dateRaw.replace(/\./g, "-")) || 0 : 0;

  const timeControl = headerValue(block, "TimeControl");
  const speed = parseSpeedBucket(timeControl);
  const gameId = parseGameId(block);

  const moveStart = block.search(/\n\s*\n/);
  const movetext = moveStart >= 0 ? block.slice(moveStart) : block;
  const sans = movetextSans(movetext, ANALYZE_PLIES);
  if (!sans.length) return null;

  // Replay for UCIs (needed to walk repertoire trees, which key moves by uci).
  const chess = new Chess();
  const ucis = [];
  const replayedSans = [];
  for (const san of sans) {
    let move;
    try {
      move = chess.move(san);
    } catch (_) {
      break;
    }
    if (!move) break;
    ucis.push(move.from + move.to + (move.promotion || ""));
    replayedSans.push(move.san);
  }
  if (!ucis.length) return null;
  return { color, score, sans: replayedSans, ucis, rating, datestamp, speed, gameId };
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
  if (!game.datestamp || game.datestamp <= 0) return 0.5;
  const stamps = games.map((g) => g.datestamp).filter((d) => d > 0);
  if (!stamps.length) return 1;
  const oldestTs = Math.min(...stamps);
  const newestTs = Math.max(...stamps);
  const range = newestTs - oldestTs;
  if (range === 0) return 1;
  return 0.5 + 0.5 * ((game.datestamp - oldestTs) / range);
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
function isNestedLine(a, b) {
  const x = a.line || triePathKey(a.ucis || []);
  const y = b.line || triePathKey(b.ucis || []);
  return x === y || x.startsWith(`${y}>`) || y.startsWith(`${x}>`);
}

// Rank lines by frequency × how far below the opponent's own baseline they score, then
// collapse nested duplicates: among ancestor/descendant lines of one opening we keep only
// the single best-opportunity representative, so "Prepare these first" reads as distinct
// weaknesses rather than the same line repeated at every depth.
export function recommendTargets(breakdown, baselineScorePct, { limit = 8, minGames = WEAKNESS_MIN_GAMES } = {}) {
  const ranked = breakdown
    .filter((g) => g.games >= minGames)
    .map((g) => {
      const belowBaseline = baselineScorePct - g.scorePct;
      return {
        ...g,
        belowBaseline,
        opportunity: g.share * Math.max(0, belowBaseline),
        smallSample: false,
      };
    })
    .filter((g) => g.belowBaseline > 0)
    .sort((a, b) => b.opportunity - a.opportunity);

  const chosen = [];
  for (const g of ranked) {
    if (chosen.some((c) => isNestedLine(c, g))) continue;
    chosen.push(g);
    if (chosen.length >= limit) break;
  }
  return chosen;
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
export function moveDistribution(root) {
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
        node: child,
      };
    })
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Repertoire coverage (how deep does MY prep follow each of their lines?)
// ---------------------------------------------------------------------------

// Build a parent->children uci lookup from a /api/build/load payload's flat nodes.
export function repertoireChildLookup(nodes) {
  const childUci = new Map(); // parentId -> Map<uci, nodeId>
  let rootId = null;
  for (const node of nodes || []) {
    if (node.depth === 0) {
      rootId = node.id;
      continue;
    }
    if (!childUci.has(node.parent_id)) childUci.set(node.parent_id, new Map());
    childUci.get(node.parent_id).set(node.uci, node.id);
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
    nodeId = next;
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
    max: String(Math.max(10, Math.min(SCOUT_MAX_GAMES, Number(max) || 100))),
    moves: "true",
    clocks: "false",
    evals: "false",
    opening: "false",
    perfType: "bullet,blitz,rapid,classical",
  });
  return `https://lichess.org/api/games/user/${safe}?${params}`;
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
  async function fetchGames(username, { max = 100, signal } = {}) {
    const key = `${username.toLowerCase()}:${max}`;
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

  return { fetchGames };
}