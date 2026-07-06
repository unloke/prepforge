// Scout v13 — stream-native candidate generation + browser providers (pure/injectable).

import { Chess } from "chess.js";

import { sfScoreToOurCp } from "./scout-bias-routes.js";
import { ratingBucketsFor } from "./explorer.js";
import {
  AUDIT_MIN_SUBJECT_CHOSE,
  epdFromUcis,
  fenFromUcis,
  isHisPly,
} from "./scout-route-audit.js";
import {
  assembleFunnelCandidate,
  bindSegmentGames,
  buildTrunkEdges,
  deriveMemTree,
  deriveStyleMetrics,
  entryEpdFromPath,
  entryUcisFromPath,
  reachLBFromSegments,
} from "./scout-v13-adapter.js";
import {
  EXT_SOUND_GAP_CP,
  buildExtension,
} from "./scout-v13-extension.js";
import { runSelectionFunnel } from "./scout-v13-funnel.js";

export const STREAM_MAX_CANDIDATES = 12;

export class CancelledError extends Error {
  constructor() {
    super("Scout v13 stream cancelled");
    this.name = "CancelledError";
  }
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

function trimTrailingOurMoves(ucis, subjectColor) {
  const out = [...ucis];
  while (out.length > 0 && !isHisPly(out.length - 1, subjectColor)) {
    out.pop();
  }
  return out;
}

function trieChildForUci(node, uci) {
  if (!node?.children) return null;
  for (const [key, child] of node.children) {
    if (key.startsWith(`${uci}|`)) return child;
  }
  return null;
}

function trieNodeAt(root, ucis) {
  let node = root;
  for (const uci of ucis) {
    const child = trieChildForUci(node, uci);
    if (!child) return null;
    node = child;
  }
  return node;
}

function collectTrunksDfs(node, ucis, segments, subjectColor, out) {
  let extended = false;
  for (const [key, child] of node.children || []) {
    const [uci] = key.split("|");
    const plyIndex = ucis.length;

    if (isHisPly(plyIndex, subjectColor)) {
      const k = child.gameCount || 0;
      if (k < AUDIT_MIN_SUBJECT_CHOSE) continue;
      extended = true;
      const seg = {
        plyIndex,
        n: node.gameCount || 0,
        k,
        wins: child.w || 0,
        draws: child.d || 0,
        losses: child.l || 0,
      };
      collectTrunksDfs(child, [...ucis, uci], [...segments, seg], subjectColor, out);
    } else {
      extended = true;
      collectTrunksDfs(child, [...ucis, uci], segments, subjectColor, out);
    }
  }

  if (!extended && segments.length > 0) {
    const trunkUcis = trimTrailingOurMoves(ucis, subjectColor);
    if (!trunkUcis.length || !isHisPly(trunkUcis.length - 1, subjectColor)) return;
    const trimmedSegments = segments.filter((s) => s.plyIndex < trunkUcis.length);
    const reachLB = reachLBFromSegments(trimmedSegments.map((s) => ({ k: s.k, n: s.n })));
    out.push({ trunkUcis, segments: trimmedSegments, reachLB });
  }
}

function dedupeKeepLonger(trunks) {
  const sorted = [...trunks].sort((a, b) => b.trunkUcis.length - a.trunkUcis.length);
  const kept = [];
  for (const trunk of sorted) {
    const path = trunk.trunkUcis;
    if (kept.some((k) => {
      const other = k.trunkUcis;
      if (other.length <= path.length) return false;
      for (let i = 0; i < path.length; i += 1) {
        if (other[i] !== path[i]) return false;
      }
      return true;
    })) {
      continue;
    }
    kept.push(trunk);
  }
  return kept;
}

/**
 * Walk the opponent's live trie and emit maximal personal trunks (stream mode).
 * @param {object} trie — opening trie root for the scouted colour
 * @param {"white"|"black"} subjectColor
 * @param {{ maxCandidates?: number }} [opts]
 */
export function streamTrunkCandidates(trie, subjectColor, opts = {}) {
  if (!trie?.children?.size) return [];
  /** @type {Array<{ trunkUcis: string[], segments: object[], reachLB: number }>} */
  const raw = [];
  collectTrunksDfs(trie, [], [], subjectColor, raw);
  const deduped = dedupeKeepLonger(raw);
  const maxCandidates = opts.maxCandidates ?? STREAM_MAX_CANDIDATES;
  return deduped
    .sort((a, b) => b.reachLB - a.reachLB)
    .slice(0, maxCandidates);
}

function whitePovEvalToOurCp(evaluation, ourColor) {
  const ev = evaluation || {};
  if (ev.mate_in != null && Number.isFinite(ev.mate_in)) {
    return sfScoreToOurCp({ type: "mate", value: Number(ev.mate_in) }, "white", ourColor);
  }
  return sfScoreToOurCp({ type: "cp", cp: Number(ev.score_cp) || 0 }, "white", ourColor);
}

function personalRepliesFromTrie(trie, ucis, subjectColor) {
  if (!isHisPly(ucis.length, subjectColor)) return [];
  const node = trieNodeAt(trie, ucis);
  if (!node?.children?.size) return [];

  const chess = new Chess();
  for (const uci of ucis) makeMove(chess, uci);

  return [...node.children.entries()]
    .map(([key, child]) => {
      const [uci, san] = key.split("|");
      return {
        uci,
        san: san || sanOf(chess, uci),
        games: child.gameCount || 0,
        wins: child.w || 0,
        draws: child.d || 0,
        losses: child.l || 0,
      };
    })
    .sort((a, b) => b.games - a.games);
}

/**
 * @param {object} deps
 * @param {(fen: string, count: number) => Promise<Array<{ moveUci: string, evaluation: object }>>} deps.engineCandidates
 * @param {(epd: string) => Promise<object|null>} deps.explorerFetch — normalized explorer stats or null
 * @param {object} deps.trie — live opening trie for the scouted colour
 * @param {"white"|"black"} deps.subjectColor
 * @param {string} [deps.ratingBand]
 * @param {string} [deps.speed]
 * @param {{ ourGaps?: number[], ourMultipvGaps?: number[] }} [deps.gapStore] — per-candidate mutable gap accumulators
 */
export function makeBrowserProviders(deps) {
  const ourColor = deps.subjectColor === "white" ? "black" : "white";
  const evalCache = new Map();
  const gapStore = deps.gapStore || { ourGaps: [], ourMultipvGaps: [] };

  async function evalCpAtUcis(ucis) {
    const fen = fenFromUcis(ucis);
    const key = epdFromUcis(ucis);
    if (evalCache.has(key)) return evalCache.get(key);
    const lines = await deps.engineCandidates(fen, 1);
    const cp = lines[0] ? whitePovEvalToOurCp(lines[0].evaluation, ourColor) : 0;
    evalCache.set(key, cp);
    return cp;
  }

  function isOurTurn(pathLen) {
    return deps.subjectColor === "black" ? pathLen % 2 === 0 : pathLen % 2 === 1;
  }

  return {
    sfTopMoves: async (ucis) => {
      const fen = fenFromUcis(ucis);
      const lines = await deps.engineCandidates(fen, 3);
      const chess = new Chess(fen);
      const out = lines.map((line, idx) => {
        const uci = line.moveUci;
        const evalCpOur = whitePovEvalToOurCp(line.evaluation, ourColor);
        const bestCp = lines[0]
          ? whitePovEvalToOurCp(lines[0].evaluation, ourColor)
          : evalCpOur;
        return {
          uci,
          san: uci ? sanOf(chess, uci) : uci,
          evalCpOur,
          gapToBestCp: idx === 0 ? 0 : bestCp - evalCpOur,
        };
      });

      if (isOurTurn(ucis.length)) {
        const pick = out.find((m) => m.gapToBestCp <= EXT_SOUND_GAP_CP) ?? out[0];
        if (pick) gapStore.ourGaps.push(pick.gapToBestCp);
        if (out.length >= 2) {
          gapStore.ourMultipvGaps.push(out[0].evalCpOur - out[1].evalCpOur);
        }
      }
      return out;
    },
    explorerReplies: async (ucis) => {
      const epd = epdFromUcis(ucis);
      let raw = null;
      try {
        raw = await deps.explorerFetch(epd);
      } catch (_) {
        return null;
      }
      if (!raw) return null;
      const totalGames = Number(raw.totalGames) || 0;
      return {
        totalGames,
        ratingBand: deps.ratingBand || ratingBucketsFor(1800).join(","),
        speed: deps.speed || "blitz",
        moves: (raw.moves || []).map((m) => ({
          uci: m.uci,
          san: m.san,
          games: Number(m.total) || 0,
          sharePct: totalGames > 0 ? ((Number(m.total) || 0) / totalGames) * 100 : 0,
        })),
      };
    },
    personalReplies: async (ucis) =>
      personalRepliesFromTrie(deps.trie, ucis, deps.subjectColor),
    auditLeafEval: async (ucis) => {
      const cp = await evalCpAtUcis(ucis);
      return { evalCp: cp };
    },
  };
}

function throwIfCancelled(shouldCancel) {
  if (shouldCancel?.()) throw new CancelledError();
}

/**
 * @param {object} input
 * @param {object} input.trie
 * @param {"white"|"black"} input.subjectColor
 * @param {number} [input.opponentRating]
 * @param {object[]} [input.games] — subject games for segment binding
 * @param {object} input.deps — engineCandidates, explorerFetch, extDepth, sfDepth
 * @param {(stage: string, done: number, total: number) => void} [input.onProgress]
 * @param {() => boolean} [input.shouldCancel]
 */
export async function runStreamV13(input) {
  const {
    trie,
    subjectColor,
    opponentRating = 1800,
    games = [],
    deps,
    onProgress,
    shouldCancel,
  } = input;

  const ourColor = subjectColor === "white" ? "black" : "white";
  const ratingBand = ratingBucketsFor(opponentRating).join(",");
  const speed = deps.speeds || "blitz";
  const extDepth = deps.extDepth ?? deps.sfDepth ?? 14;
  const sfDepth = deps.sfDepth ?? 18;

  const trunkSpecs = streamTrunkCandidates(trie, subjectColor, {
    maxCandidates: deps.maxCandidates,
  });

  /** @type {import("./scout-v13-funnel.js").FunnelCandidate[]} */
  const candidates = [];
  const total = trunkSpecs.length;

  for (let idx = 0; idx < trunkSpecs.length; idx += 1) {
    throwIfCancelled(shouldCancel);
    onProgress?.("candidate", idx, total);

    const { trunkUcis, segments: streamSegments } = trunkSpecs[idx];
    const pathKey = trunkUcis.join(" ");
    const gapStore = { ourGaps: [], ourMultipvGaps: [] };
    const providers = makeBrowserProviders({
      ...deps,
      trie,
      subjectColor,
      ratingBand,
      speed,
      gapStore,
    });

    const boundSegments = bindSegmentGames(
      streamSegments.map((s) => ({ ...s })),
      games,
    );
    const trunkBuilt = buildTrunkEdges(trunkUcis, boundSegments, subjectColor);

    throwIfCancelled(shouldCancel);
    const extension = await buildExtension(
      { anchorUcis: trunkUcis, subjectColor, style: null },
      providers,
    );

    const trunkOurGaps = [];
    {
      const chess = new Chess();
      for (let i = 0; i < trunkUcis.length; i += 1) {
        if (!isHisPly(i, subjectColor)) {
          const before = chess.fen();
          throwIfCancelled(shouldCancel);
          const lines = await deps.engineCandidates(before, 3);
          const uci = trunkUcis[i];
          const bestCp = lines[0]
            ? whitePovEvalToOurCp(lines[0].evaluation, ourColor)
            : 0;
          const pick = lines.find((l) => l.moveUci === uci);
          let evalCpOur;
          if (pick) {
            evalCpOur = whitePovEvalToOurCp(pick.evaluation, ourColor);
          } else {
            makeMove(chess, uci);
            evalCpOur = await providers.auditLeafEval(trunkUcis.slice(0, i + 1)).then((r) => r.evalCp);
            chess.undo();
          }
          trunkOurGaps.push(bestCp - evalCpOur);
        }
        makeMove(chess, trunkUcis[i]);
      }
    }

    const ourGaps = [...trunkOurGaps, ...gapStore.ourGaps];
    const ourMultipvGaps = gapStore.ourMultipvGaps;
    const anchorUcis = trunkUcis;

    /** @type {string[][]} */
    const hisNodePaths = [];
    if (extension.ok && extension.mainline?.length) {
      hisNodePaths.push([...anchorUcis, extension.mainline[0].uci]);
    }
    for (const branch of extension.branches || []) {
      const prefix = extension.mainline.slice(0, branch.forkPlyIndex).map((e) => e.uci);
      hisNodePaths.push([...anchorUcis, ...prefix]);
    }

    const anchorReplyEvals = [];
    const keyNodeReplySets = [];
    const keyNodeHisReplies = [];
    const keyNodeExplorer = [];
    for (let nodeIdx = 0; nodeIdx < hisNodePaths.length; nodeIdx += 1) {
      throwIfCancelled(shouldCancel);
      const nodeUcis = hisNodePaths[nodeIdx];
      const nodeFen = fenFromUcis(nodeUcis);
      const personalAtNode = await providers.personalReplies(nodeUcis);
      const explorerAtNode = await providers.explorerReplies(nodeUcis);
      const replyUcis = personalAtNode.length
        ? personalAtNode.map((r) => r.uci)
        : (explorerAtNode?.moves || []).map((m) => m.uci);

      const replyEvals = [];
      for (const uci of replyUcis.slice(0, 3)) {
        throwIfCancelled(shouldCancel);
        const afterUcis = [...nodeUcis, uci];
        const ev = await providers.auditLeafEval(afterUcis);
        replyEvals.push(ev.evalCp);
      }
      if (nodeIdx === 0) anchorReplyEvals.push(...replyEvals);

      keyNodeReplySets.push({ replyEvals });
      keyNodeHisReplies.push({ fen: nodeFen, ucis: replyUcis });
      if (explorerAtNode) keyNodeExplorer.push(explorerAtNode);
    }

    let entryMoveExplorerSharePct = 100;
    let entryNodeTotalGames = 0;
    {
      const entryPrefix = [];
      let ourSeen = 0;
      const entryUcis = entryUcisFromPath(trunkUcis, subjectColor);
      for (let i = 0; i < trunkUcis.length && ourSeen < entryUcis.length; i += 1) {
        entryPrefix.push(trunkUcis[i]);
        if (!isHisPly(i, subjectColor)) ourSeen += 1;
      }
      if (ourSeen > 0) entryPrefix.pop();
      throwIfCancelled(shouldCancel);
      const explorerEntry = await providers.explorerReplies(entryPrefix);
      entryNodeTotalGames = explorerEntry?.totalGames ?? 0;
      const entryMove = entryUcis[entryUcis.length - 1];
      const hit = explorerEntry?.moves?.find((m) => m.uci === entryMove);
      entryMoveExplorerSharePct = hit?.sharePct ?? 100;
    }

    const mainlineUcis = [
      ...trunkUcis,
      ...(extension.mainline || []).map((e) => e.uci),
    ];

    // Stream mode has no offline tilt fit. attribution = 1 (neutral multiplier), so
    // candidatePersonalScore degrades to pure personal reach instead of all-zero
    // scores that would make component-representative selection arbitrary.
    const styleMetrics = deriveStyleMetrics({
      endpointEvalCp: extension.endpointEvalCp,
      ourGaps,
      anchorReplyEvals,
      mainlineUcis,
      ourColor,
      anchorAttribution: 1,
      attributionP75: 1,
      topLeakMove: null,
      anchorUcis: trunkUcis,
      ourMultipvGaps,
      entryMoveExplorerSharePct,
      entryNodeTotalGames,
      keyNodeReplySets,
      keyNodeHisReplies,
      keyNodeExplorer,
    });

    const ourMoveInfos = [];
    {
      const chess = new Chess();
      let prevOwnMoveUci = null;
      for (let i = 0; i < mainlineUcis.length; i += 1) {
        const uci = mainlineUcis[i];
        if (i >= trunkUcis.length && !isHisPly(i, subjectColor)) {
          ourMoveInfos.push({
            uci,
            fen: chess.fen(),
            prevOwnMoveUci,
          });
        }
        makeMove(chess, uci);
        // "own" = the mover whose decision we classify — OUR previous move here.
        if (!isHisPly(i, subjectColor)) prevOwnMoveUci = uci;
      }
    }

    const memTree = deriveMemTree(extension, ourMoveInfos, {
      onlyMoveCount: styleMetrics.onlyMoveCount,
    });

    const hisTrunkGames = trunkBuilt.trunkSegments.map((s) => s.k);
    const extensionHasPersonal = [...(extension.mainline || [])].some(
      (e) => e.evidenceSource === "personal",
    );

    candidates.push(
      assembleFunnelCandidate({
        subjectColor,
        routeUcis: trunkUcis,
        trunkUcis,
        trunk: {
          edges: trunkBuilt.edges,
          personalAnchorPly: trunkBuilt.personalAnchorPly,
          reachLB: trunkBuilt.reachLB,
        },
        trunkSegments: trunkBuilt.trunkSegments,
        extension,
        styleMetrics,
        riskMetrics: {
          personalEdgeGames: hisTrunkGames,
          extensionHasPersonal,
          onlyMoveCount: styleMetrics.onlyMoveCount,
          evalSwingCp: styleMetrics.evalSwingCp,
          entryTransposes: false,
        },
        memTree,
        tendencyIds: [],
        anchorAttribution: 1,
        entryEpd: entryEpdFromPath(trunkUcis, subjectColor),
        entryUcis: entryUcisFromPath(trunkUcis, subjectColor),
      }),
    );
  }

  throwIfCancelled(shouldCancel);
  onProgress?.("funnel", 0, 1);
  // One shared audit provider — its per-EPD eval cache must survive across leaves
  // (pruning re-audits overlapping paths; a fresh provider per call re-evals everything).
  const auditProvider = makeBrowserProviders({
    ...deps,
    trie,
    subjectColor,
    ratingBand,
    speed,
  });
  const report = await runSelectionFunnel(candidates, {
    auditLeafEval: async (ucis) => {
      throwIfCancelled(shouldCancel);
      return auditProvider.auditLeafEval(ucis);
    },
  });

  return {
    report,
    meta: {
      sfDepth,
      extDepth,
      ratingBand,
      speeds: speed,
      candidateCounts: {
        streamed: trunkSpecs.length,
        assembled: candidates.length,
        survivors: report.packages.length,
      },
      generatedAt: new Date().toISOString(),
      engineLabel: "browser",
      explorerAvailable: deps.explorerAvailable !== false,
    },
  };
}