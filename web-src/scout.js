// Opponent scouting: fetch a Lichess player's recent games (public PGN export,
// CORS-open, no token), aggregate their opening tendencies per colour, and grade
// the user's own repertoires against the lines that opponent actually plays.
//
// Everything runs in the browser — the PrepForge server is never involved in the
// fetch or the number-crunching. Only the openings matter here, so parsing stops
// at MAX_PLIES; sixty games cost a few milliseconds.
//
// Pure functions + an injected-deps fetcher, unit-testable without network/DOM.

import { Chess } from "chess.js";

export const SCOUT_MAX_GAMES = 100;
export const MAX_PLIES = 12; // opening book depth we care about
const CACHE_KEY = "prepforge.scout.cache.v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // opponents play new games constantly
const CACHE_CAP = 8;

// ---------------------------------------------------------------------------
// PGN parsing (multi-game export -> per-game opening records)
// ---------------------------------------------------------------------------

function headerValue(block, name) {
  const match = block.match(new RegExp(`\\[${name}\\s+"([^"]*)"\\]`));
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

  const moveStart = block.search(/\n\s*\n/);
  const movetext = moveStart >= 0 ? block.slice(moveStart) : block;
  const sans = movetextSans(movetext);
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
  return { color, score, sans: replayedSans, ucis };
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
  return { count: 0, score: 0, children: new Map() };
}

// Aggregate the games one colour at a time. Each path through the trie is a line
// the opponent has actually played, with how often and how well they scored.
export function buildOpeningTrie(games, color, maxPlies = MAX_PLIES) {
  const root = trieNode();
  for (const game of games) {
    if (game.color !== color) continue;
    root.count += 1;
    root.score += game.score;
    let node = root;
    for (let i = 0; i < Math.min(game.ucis.length, maxPlies); i += 1) {
      const key = `${game.ucis[i]}|${game.sans[i]}`;
      if (!node.children.has(key)) node.children.set(key, trieNode());
      node = node.children.get(key);
      node.count += 1;
      node.score += game.score;
    }
  }
  return root;
}

// The opponent's most-travelled paths: walk the trie greedily from the most
// common child down, splitting off one line per top-level branch (and per second
// branch under the most common reply) so the list reads like a repertoire sketch.
export function topLines(root, { limit = 6, minCount = 2 } = {}) {
  const lines = [];

  const walk = (node, sans, ucis) => {
    let best = null;
    for (const [key, child] of node.children) {
      if (!best || child.count > best.child.count) best = { key, child };
    }
    if (!best || best.child.count < minCount) {
      return { sans, ucis, count: node.count, score: node.score };
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
    lines.push({
      sans: tip.sans,
      ucis: tip.ucis,
      count: child.count,
      share: root.count > 0 ? child.count / root.count : 0,
      scorePct: child.count > 0 ? Math.round((child.score / child.count) * 100) : 0,
    });
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
        share: child.count / total,
        scorePct: child.count > 0 ? Math.round((child.score / child.count) * 100) : 0,
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
// Fetching (with a small per-username cache)
// ---------------------------------------------------------------------------

export function scoutUrl(username, max) {
  const safe = encodeURIComponent(String(username || "").trim());
  const params = new URLSearchParams({
    max: String(Math.max(10, Math.min(SCOUT_MAX_GAMES, Number(max) || 60))),
    moves: "true",
    clocks: "false",
    evals: "false",
    opening: "false",
    perfType: "blitz,rapid,classical",
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
  async function fetchGames(username, { max = 60, signal } = {}) {
    const key = `${username.toLowerCase()}:${max}`;
    const cache = readCache();
    const hit = cache.entries[key];
    if (hit && clock() - hit.at < CACHE_TTL_MS) return hit.games;

    const resp = await doFetch(scoutUrl(username, max), {
      headers: { Accept: "application/x-chess-pgn" },
      signal,
    });
    if (resp.status === 404) throw new Error(`No Lichess user named "${username}"`);
    if (resp.status === 429) throw new Error("Lichess rate limit - wait a minute and retry");
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
