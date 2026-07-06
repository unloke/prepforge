// Scout v13 — real-data adapter (pure assembly, no I/O, no engines).
// Wires subject games + provider outputs into FunnelCandidate shapes.

import { Chess } from "chess.js";

import { ENTRY_PLY_LIMIT, jeffreysLower } from "./scout-bias-routes.js";
import {
  FEATURE_IDS,
  buildDecisionContext,
  featureVector,
} from "./scout-bias-features.js";
import {
  AUDIT_MIN_SUBJECT_CHOSE,
  epdFromUcis,
  isHisPly,
  ourMovesFromPath,
} from "./scout-route-audit.js";
import { personalReachFromSegments } from "./scout-v13-package.js";
import { conceptFamiliesForEdges } from "./scout-v13-style.js";

/** @typedef {import("./scout-v13-package.js").EvidenceEdge} EvidenceEdge */
/** @typedef {import("./scout-v13-extension.js").PersonalReply} PersonalReply */
/** @typedef {import("./scout-v13-extension.js").BuildExtensionResult} BuildExtensionResult */
/** @typedef {import("./scout-v13-style.js").StyleMetrics} StyleMetrics */
/** @typedef {import("./scout-v13-style.js").PkgRiskMetrics} PkgRiskMetrics */
/** @typedef {import("./scout-v13-funnel.js").FunnelCandidate} FunnelCandidate */

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ONLY_MOVE_GAP_CP = 100;
const GOOD_REPLY_CP_WINDOW = 50;

function gameUcis(game) {
  return game.openingUcis?.length ? game.openingUcis : game.ucis || [];
}

function makeMove(chess, uci) {
  return chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4] || undefined,
  });
}

function sanOf(chess, uci) {
  const m = makeMove(chess, uci);
  chess.undo();
  return m?.san ?? uci;
}

function prefixMatches(gameMoves, ucis, len) {
  if (gameMoves.length < len) return false;
  for (let i = 0; i < len; i += 1) {
    if (gameMoves[i] !== ucis[i]) return false;
  }
  return true;
}

function tallyOutcomes(games, ucis, len, subjectColor) {
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const game of games) {
    if (game.color !== subjectColor) continue;
    const moves = gameUcis(game);
    if (!prefixMatches(moves, ucis, len)) continue;
    const score = Number(game.score);
    if (score === 1) wins += 1;
    else if (score === 0.5) draws += 1;
    else losses += 1;
  }
  return { wins, draws, losses, games: wins + draws + losses };
}

/**
 * @param {Array<{ color: string, ucis?: string[], openingUcis?: string[], score?: number }>} games
 * @param {string[]} ucis
 * @param {"white"|"black"} subjectColor
 * @returns {Array<{ plyIndex: number, n: number, k: number, wins: number, draws: number, losses: number }>}
 */
export function countPathSegments(games, ucis, subjectColor) {
  const colorGames = (games || []).filter((g) => g.color === subjectColor);
  /** @type {Array<{ plyIndex: number, n: number, k: number, wins: number, draws: number, losses: number }>} */
  const out = [];

  for (let i = 0; i < ucis.length; i += 1) {
    if (!isHisPly(i, subjectColor)) continue;
    let n = 0;
    let k = 0;
    for (const game of colorGames) {
      const moves = gameUcis(game);
      if (prefixMatches(moves, ucis, i)) n += 1;
      if (prefixMatches(moves, ucis, i + 1)) k += 1;
    }
    const wdl = tallyOutcomes(colorGames, ucis, i + 1, subjectColor);
    out.push({
      plyIndex: i,
      n,
      k,
      wins: wdl.wins,
      draws: wdl.draws,
      losses: wdl.losses,
    });
  }
  return out;
}

/**
 * @param {{ ucis?: string[], subjectColor?: "white"|"black" } | string[]} route
 * @param {ReturnType<typeof countPathSegments>} segments
 * @returns {{ trunkUcis: string[], personalAnchorPly: number }}
 */
export function cutTrunkAtPersonalAnchor(route, segments) {
  const ucis = Array.isArray(route) ? route : route?.ucis || [];
  const subjectColor = Array.isArray(route) ? null : route?.subjectColor;
  if (!subjectColor) {
    throw new Error("cutTrunkAtPersonalAnchor requires route.subjectColor");
  }

  const segByPly = new Map(segments.map((s) => [s.plyIndex, s]));
  /** @type {string[]} */
  const trunkUcis = [];
  let includedAnyHis = false;

  for (let i = 0; i < ucis.length; i += 1) {
    if (!isHisPly(i, subjectColor)) {
      trunkUcis.push(ucis[i]);
      continue;
    }
    const seg = segByPly.get(i);
    const k = seg?.k ?? 0;
    if (k < AUDIT_MIN_SUBJECT_CHOSE) {
      if (!includedAnyHis) {
        return { trunkUcis: [], personalAnchorPly: 0 };
      }
      break;
    }
    trunkUcis.push(ucis[i]);
    includedAnyHis = true;
  }

  while (trunkUcis.length > 0) {
    const lastPly = trunkUcis.length - 1;
    if (isHisPly(lastPly, subjectColor)) break;
    trunkUcis.pop();
  }

  if (!includedAnyHis) {
    return { trunkUcis: [], personalAnchorPly: 0 };
  }

  return { trunkUcis, personalAnchorPly: trunkUcis.length };
}

/**
 * @param {string[]} trunkUcis
 * @param {ReturnType<typeof countPathSegments>} segments
 * @param {"white"|"black"} subjectColor
 * @returns {{ edges: EvidenceEdge[], personalAnchorPly: number, reachLB: number, trunkSegments: Array<{ k: number, n: number }> }}
 */
export function buildTrunkEdges(trunkUcis, segments, subjectColor) {
  const segByPly = new Map(segments.map((s) => [s.plyIndex, s]));
  /** @type {EvidenceEdge[]} */
  const edges = [];
  /** @type {Array<{ k: number, n: number }>} */
  const trunkSegments = [];

  const chess = new Chess();
  for (let i = 0; i < trunkUcis.length; i += 1) {
    const uci = trunkUcis[i];
    const san = sanOf(chess, uci);
    makeMove(chess, uci);

    if (isHisPly(i, subjectColor)) {
      const seg = segByPly.get(i);
      const k = seg?.k ?? 0;
      const n = seg?.n ?? 0;
      trunkSegments.push({ k, n });
      edges.push({
        uci,
        san,
        evidenceSource: "personal",
        receipts: {
          games: k,
          wins: seg?.wins ?? 0,
          draws: seg?.draws ?? 0,
          losses: seg?.losses ?? 0,
        },
      });
    } else {
      const pool = segments.gamesPool ?? [];
      const wdl = tallyOutcomes(pool, trunkUcis, i + 1, subjectColor);
      const parentN = (() => {
        let count = 0;
        for (const game of pool) {
          if (game.color !== subjectColor) continue;
          if (prefixMatches(gameUcis(game), trunkUcis, i)) count += 1;
        }
        return count;
      })();
      edges.push({
        uci,
        san,
        evidenceSource: "personal",
        receipts: {
          games: parentN,
          wins: wdl.wins,
          draws: wdl.draws,
          losses: wdl.losses,
        },
      });
    }
  }

  const reachLB = personalReachFromSegments(trunkSegments);
  return {
    edges,
    personalAnchorPly: trunkUcis.length,
    reachLB,
    trunkSegments,
  };
}

/**
 * Bind games pool on segments for our-move W/D/L in buildTrunkEdges (not serialized).
 * @param {ReturnType<typeof countPathSegments>} segments
 * @param {object[]} games
 */
export function bindSegmentGames(segments, games) {
  segments.gamesPool = games;
  return segments;
}

/**
 * @param {object[]} games
 * @param {"white"|"black"} subjectColor
 * @returns {(ucis: string[]) => Promise<PersonalReply[]>}
 */
export function makePersonalRepliesProvider(games, subjectColor) {
  const colorGames = (games || []).filter((g) => g.color === subjectColor);

  return async (ucis) => {
    const prefixLen = ucis.length;
    if (!isHisPly(prefixLen, subjectColor)) return [];

    const agg = new Map();
    for (const game of colorGames) {
      const moves = gameUcis(game);
      if (moves.length <= prefixLen) continue;
      if (!prefixMatches(moves, ucis, prefixLen)) continue;

      const replyUci = moves[prefixLen];
      if (!agg.has(replyUci)) {
        agg.set(replyUci, { uci: replyUci, games: 0, wins: 0, draws: 0, losses: 0 });
      }
      const entry = agg.get(replyUci);
      entry.games += 1;
      const score = Number(game.score);
      if (score === 1) entry.wins += 1;
      else if (score === 0.5) entry.draws += 1;
      else entry.losses += 1;
    }

    const chess = new Chess();
    for (const uci of ucis) makeMove(chess, uci);

    return [...agg.values()]
      .sort((a, b) => b.games - a.games)
      .map((r) => ({
        ...r,
        san: sanOf(chess, r.uci),
      }));
  };
}

function materialOurCp(chess, ourColor) {
  const board = chess.board();
  let total = 0;
  const us = ourColor === "white" ? "w" : "b";
  for (const row of board) {
    for (const piece of row) {
      if (!piece) continue;
      const val = PIECE_VALUE[piece.type] ?? 0;
      total += piece.color === us ? val : -val;
    }
  }
  return total;
}

/**
 * @param {string[]} mainlineUcis
 * @param {"white"|"black"} ourColor
 * @returns {boolean}
 */
export function detectSacrifice(mainlineUcis, ourColor) {
  const chess = new Chess();
  let runningMax = materialOurCp(chess, ourColor);
  let dropPly = null;
  let peakBeforeDrop = runningMax;

  for (let ply = 0; ply < mainlineUcis.length; ply += 1) {
    makeMove(chess, mainlineUcis[ply]);
    const mat = materialOurCp(chess, ourColor);
    if (mat > runningMax) runningMax = mat;
    if (runningMax - mat >= 1) {
      dropPly = ply;
      peakBeforeDrop = runningMax;
      break;
    }
  }

  if (dropPly === null) return false;

  const chess2 = new Chess();
  for (let i = 0; i <= dropPly; i += 1) makeMove(chess2, mainlineUcis[i]);

  for (let j = 1; j <= 2 && dropPly + j < mainlineUcis.length; j += 1) {
    makeMove(chess2, mainlineUcis[dropPly + j]);
    if (materialOurCp(chess2, ourColor) >= peakBeforeDrop) return false;
  }

  return true;
}

function isCaptureOrCheckAt(fen, uci) {
  const chess = new Chess(fen);
  let m = null;
  try {
    m = makeMove(chess, uci);
  } catch {
    return false; // chess.js throws on illegal moves — treat as "not capture/check"
  }
  if (!m) return false;
  return Boolean(m.captured) || chess.inCheck();
}

/**
 * @param {object} input
 * @param {number|null} input.endpointEvalCp
 * @param {number[]} input.ourGaps
 * @param {number[]} input.anchorReplyEvals
 * @param {string[]} input.mainlineUcis
 * @param {"white"|"black"} input.ourColor
 * @param {number} input.anchorAttribution
 * @param {number} input.attributionP75
 * @param {{ uci?: string }|null} [input.topLeakMove]
 * @param {string[]} [input.anchorUcis]
 * @param {number[]} input.ourMultipvGaps
 * @param {number} input.entryMoveExplorerSharePct
 * @param {number} input.entryNodeTotalGames
 * @param {Array<{ replyEvals: number[] }>} input.keyNodeReplySets
 * @param {Array<{ ucis: string[], fen: string }>} input.keyNodeHisReplies
 * @param {Array<{ moves: Array<{ games: number }>, totalGames: number }>} input.keyNodeExplorer
 * @returns {StyleMetrics}
 */
export function deriveStyleMetrics(input) {
  const replyEvals = input.anchorReplyEvals || [];
  const evalSwingCp =
    replyEvals.length >= 2
      ? Math.max(...replyEvals) - Math.min(...replyEvals)
      : replyEvals.length === 1
        ? 0
        : 0;

  let leakMoveIsCaptureOrCheck = false;
  if (input.topLeakMove?.uci && input.anchorUcis?.length) {
    const chess = new Chess();
    for (const u of input.anchorUcis) makeMove(chess, u);
    leakMoveIsCaptureOrCheck = isCaptureOrCheckAt(chess.fen(), input.topLeakMove.uci);
  }

  const onlyMoveCount = (input.ourMultipvGaps || []).filter(
    (g) => Number.isFinite(g) && g >= ONLY_MOVE_GAP_CP,
  ).length;

  const goodRepliesWithin50Cp = (input.keyNodeReplySets || []).length
    ? Math.min(
        ...input.keyNodeReplySets.map((node) => {
          const evals = node.replyEvals || [];
          if (!evals.length) return 0;
          const best = Math.max(...evals);
          return evals.filter((e) => best - e <= GOOD_REPLY_CP_WINDOW).length;
        }),
      )
    : 0;

  const checkCaptureThreatDensity = (() => {
    const nodes = input.keyNodeHisReplies || [];
    if (!nodes.length) return 0;
    let total = 0;
    let hits = 0;
    for (const node of nodes) {
      const chess = new Chess(node.fen);
      for (const uci of node.ucis) {
        total += 1;
        let m = null;
        try {
          m = makeMove(chess, uci);
        } catch {
          continue; // illegal reply uci — count in total, never a hit
        }
        if (m && (m.captured || chess.inCheck())) hits += 1;
        chess.undo();
      }
    }
    return total > 0 ? hits / total : 0;
  })();

  const topTwoRepliesCoveragePct = (() => {
    const nodes = input.keyNodeExplorer || [];
    if (!nodes.length) return 0;
    return Math.min(
      ...nodes.map((ex) => {
        const total = ex.totalGames || 0;
        if (total <= 0) return 0;
        const g1 = ex.moves?.[0]?.games ?? 0;
        const g2 = ex.moves?.[1]?.games ?? 0;
        return ((g1 + g2) / total) * 100;
      }),
    );
  })();

  return {
    endpointEvalCp: input.endpointEvalCp ?? 0,
    ourGaps: input.ourGaps || [],
    evalSwingCp,
    hasSacrifice: detectSacrifice(input.mainlineUcis || [], input.ourColor),
    anchorAttribution: input.anchorAttribution ?? 0,
    attributionP75: input.attributionP75 ?? 0,
    leakMoveIsCaptureOrCheck,
    onlyMoveCount,
    entryMoveExplorerSharePct: input.entryMoveExplorerSharePct ?? 0,
    entryNodeTotalGames: input.entryNodeTotalGames ?? 0,
    goodRepliesWithin50Cp,
    checkCaptureThreatDensity,
    topTwoRepliesCoveragePct,
  };
}

/**
 * @param {BuildExtensionResult} extensionResult
 * @param {Array<{ uci: string, fen: string, prevOwnMoveUci?: string|null }>} ourMoveInfos
 * @param {object} [opts]
 * @param {number} [opts.onlyMoveCount]
 * @param {typeof featureVector} [opts.featureVectorFn]
 * @param {typeof buildDecisionContext} [opts.buildDecisionContextFn]
 */
export function deriveMemTree(extensionResult, ourMoveInfos, opts = {}) {
  const fv = opts.featureVectorFn || featureVector;
  const bdc = opts.buildDecisionContextFn || buildDecisionContext;

  const branches = extensionResult.branches || [];
  const forkCounts = new Map();
  for (const branch of branches) {
    const f = branch.forkPlyIndex;
    forkCounts.set(f, (forkCounts.get(f) || 0) + 1);
  }

  const forkCount = forkCounts.size;
  const maxRepliesPerFork =
    forkCount > 0 ? Math.max(...forkCounts.values()) : 0;

  const edgeFeatureIds = [];
  for (const info of ourMoveInfos || []) {
    const ctx = bdc(info.fen, { prevOwnMoveUci: info.prevOwnMoveUci ?? null });
    const vec = fv(ctx, info.uci);
    const ids = FEATURE_IDS.filter((_, idx) => vec[idx] > 0);
    edgeFeatureIds.push(ids);
  }

  return {
    leafCount: extensionResult.leafCount ?? 0,
    forkCount,
    maxRepliesPerFork,
    onlyMoveCount: opts.onlyMoveCount ?? 0,
    conceptFamilies: conceptFamiliesForEdges(edgeFeatureIds),
  };
}

/**
 * @param {object} parts
 * @returns {FunnelCandidate}
 */
export function assembleFunnelCandidate(parts) {
  const {
    subjectColor,
    routeUcis,
    trunkUcis,
    trunk,
    trunkSegments,
    extension,
    styleMetrics,
    riskMetrics,
    memTree,
    tendencyIds,
    anchorAttribution,
    entryEpd,
    entryUcis,
  } = parts;

  const id = `${subjectColor}:${(routeUcis || trunkUcis || []).join(" ")}`;

  return {
    id,
    subjectColor,
    trunkUcis,
    trunkEndEpd: epdFromUcis(trunkUcis),
    entryEpd,
    entryUcis,
    extensionMainlineUcis: (extension?.mainline || []).map((e) => e.uci),
    trunkSegments,
    anchorAttribution,
    tendencyIds: [...new Set(tendencyIds || [])],
    trunk,
    extension,
    styleMetrics,
    riskMetrics,
    memTree,
  };
}

/** Entry our-move UCIs within the first ENTRY_PLY_LIMIT plies. */
export function entryUcisFromPath(pathUcis, subjectColor) {
  const ourMoves = ourMovesFromPath(pathUcis, subjectColor);
  const limit = Math.ceil(ENTRY_PLY_LIMIT / 2);
  return ourMoves.slice(0, limit);
}

/** EPD after the route prefix that completes our entry choices. */
export function entryEpdFromPath(pathUcis, subjectColor) {
  const targetOur = entryUcisFromPath(pathUcis, subjectColor);
  if (!targetOur.length) return epdFromUcis([]);
  let ourCount = 0;
  const played = [];
  for (let i = 0; i < pathUcis.length && ourCount < targetOur.length; i += 1) {
    played.push(pathUcis[i]);
    if (!isHisPly(i, subjectColor)) ourCount += 1;
  }
  return epdFromUcis(played);
}

/** P75 of finite attribution values across candidates. */
export function attributionP75(values) {
  const finite = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!finite.length) return 0;
  const idx = Math.floor(0.75 * (finite.length - 1));
  return finite[idx];
}

/** Jeffreys reach product for hand-checks in tests. */
export function reachLBFromSegments(segments) {
  return personalReachFromSegments(segments);
}

/** Exposed for tests — same formula as scout-bias-routes. */
export { jeffreysLower };