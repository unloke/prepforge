// Scout v13 — real-data harness: routes + games + SF + Lichess explorer → packages JSON.
//
// Usage:
//   node scripts/scout-v13-run.mjs \
//     --routes tmp/routes-unbrainless87-black-v2.json \
//     --games tmp/unbrainless87.json \
//     --sf tmp/tools/stockfish/stockfish-windows-x86-64-avx2.exe \
//     --sf-depth 18 [--ext-depth 14] [--ratings 2000] [--speeds blitz] \
//     --out tmp/v13-packages-unbrainless87-black.json

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Chess } from "chess.js";

import { sfScoreToOurCp } from "../web-src/scout-bias-routes.js";
import { epdOf } from "../web-src/scout-graph.js";
import {
  assembleFunnelCandidate,
  attributionP75,
  bindSegmentGames,
  buildTrunkEdges,
  countPathSegments,
  cutTrunkAtPersonalAnchor,
  deriveMemTree,
  deriveStyleMetrics,
  entryEpdFromPath,
  entryUcisFromPath,
  makePersonalRepliesProvider,
} from "../web-src/scout-v13-adapter.js";
import {
  EXT_SOUND_GAP_CP,
  buildExtension,
} from "../web-src/scout-v13-extension.js";
import { runSelectionFunnel } from "../web-src/scout-v13-funnel.js";
import {
  epdFromUcis,
  fenFromUcis,
  isHisPly,
  loadGames,
} from "../web-src/scout-route-audit.js";
import { StockfishPool } from "../web-src/scout-stockfish-uci.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EXPLORER_CACHE_DIR = join(ROOT, "tmp", "explorer-cache");

function parseArgs(argv) {
  const out = {
    sfDepth: 18,
    extDepth: 14,
    ratings: "2000",
    speeds: "blitz",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--routes") out.routes = argv[++i];
    else if (a === "--games") out.games = argv[++i];
    else if (a === "--sf") out.sf = argv[++i];
    else if (a === "--sf-depth") out.sfDepth = Number(argv[++i]) || 18;
    else if (a === "--ext-depth") out.extDepth = Number(argv[++i]) || 14;
    else if (a === "--ratings") out.ratings = argv[++i];
    else if (a === "--speeds") out.speeds = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--out") out.out = argv[++i];
  }
  return out;
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

function isOurTurn(pathLen, subjectColor) {
  return subjectColor === "black" ? pathLen % 2 === 0 : pathLen % 2 === 1;
}

function dedupeRoutesByPath(tendencies) {
  /** @type {Map<string, { route: object, tendencyIds: string[] }>} */
  const byPath = new Map();
  for (const tendency of tendencies || []) {
    for (const route of tendency.routes || []) {
      const key = (route.ucis || []).join(" ");
      if (!key) continue;
      if (!byPath.has(key)) {
        byPath.set(key, { route, tendencyIds: [tendency.featureId] });
      } else {
        const entry = byPath.get(key);
        if (!entry.tendencyIds.includes(tendency.featureId)) {
          entry.tendencyIds.push(tendency.featureId);
        }
      }
    }
  }
  return [...byPath.values()];
}

function explorerCacheKey(epd, speeds, ratings) {
  return createHash("sha1").update(`${epd}|${speeds}|${ratings}`).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.routes || !args.games || !args.sf || !args.out) {
    console.error(
      "usage: node scripts/scout-v13-run.mjs --routes <routes-v2.json> --games <games.json> --sf <stockfish.exe> [--sf-depth 18] [--ext-depth 14] [--ratings 2000] [--speeds blitz] --out <packages.json>",
    );
    process.exit(2);
  }

  const routesReport = JSON.parse(readFileSync(args.routes, "utf8"));
  const subjectColor = routesReport.meta?.subjectColor;
  const ourColor = routesReport.meta?.ourColor ?? (subjectColor === "white" ? "black" : "white");

  const allGames = loadGames(JSON.parse(readFileSync(args.games, "utf8")));
  const colorGames = allGames.filter((g) => g.color === subjectColor);
  console.log(`Loaded ${allGames.length} games (${colorGames.length} as ${subjectColor})`);

  const deduped = dedupeRoutesByPath(routesReport.tendencies);
  const routeTotal = (routesReport.tendencies || []).reduce(
    (n, t) => n + (t.routes?.length || 0),
    0,
  );
  console.log(`Routes: ${routeTotal} raw → ${deduped.length} deduped paths`);

  mkdirSync(EXPLORER_CACHE_DIR, { recursive: true });

  // explorer.lichess.ovh dropped anonymous access in early 2026 — a Lichess API
  // token (any scope) is required or every cohort lookup 401s into honest cuts.
  const explorerToken = args.token || process.env.LICHESS_TOKEN || null;
  if (!explorerToken) {
    console.warn(
      "⚠ no Lichess token (--token / LICHESS_TOKEN): explorer lookups will fail → extensions cut early → expect 0 packages",
    );
  }

  const sf = new StockfishPool(args.sf);
  const evalCache = new Map();
  const explorerStats = { hits: 0, misses: 0, fetches: 0, failures: 0, lastFailStatus: null };
  let lastExplorerFetchMs = 0;

  async function evalOurCp(fen, depth = args.sfDepth) {
    const epd = epdOf(fen);
    const key = `${epd}|d${depth}`;
    const cached = evalCache.get(key);
    if (cached != null) return cached;
    const { score, sideToMove } = await sf.evalPosition(fen, depth);
    const cp = sfScoreToOurCp(score, sideToMove, ourColor);
    evalCache.set(key, cp);
    return cp;
  }

  async function evalOurCpAfter(fen, uci, depth = args.sfDepth) {
    const chess = new Chess(fen);
    makeMove(chess, uci);
    return evalOurCp(chess.fen(), depth);
  }

  async function fetchExplorer(epd) {
    const cacheName = explorerCacheKey(epd, args.speeds, args.ratings);
    const cachePath = join(EXPLORER_CACHE_DIR, `${cacheName}.json`);
    if (existsSync(cachePath)) {
      explorerStats.hits += 1;
      return JSON.parse(readFileSync(cachePath, "utf8"));
    }

    explorerStats.misses += 1;
    const now = Date.now();
    const waitMs = Math.max(0, 1000 - (now - lastExplorerFetchMs));
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const url =
      `https://explorer.lichess.ovh/lichess?variant=standard&speeds=${encodeURIComponent(args.speeds)}` +
      `&ratings=${encodeURIComponent(args.ratings)}&fen=${encodeURIComponent(epd)}&moves=12&topGames=0&recentGames=0`;

    let body = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      explorerStats.fetches += 1;
      lastExplorerFetchMs = Date.now();
      const res = await fetch(url, {
        headers: explorerToken ? { Authorization: `Bearer ${explorerToken}` } : {},
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 60000));
        continue;
      }
      if (!res.ok) {
        explorerStats.failures += 1;
        explorerStats.lastFailStatus = res.status;
        return null;
      }
      body = await res.json();
      break;
    }

    if (!body?.moves) return null;

    const totalGames = (body.white ?? 0) + (body.draws ?? 0) + (body.black ?? 0);
    const mapped = {
      totalGames,
      ratingBand: args.ratings,
      speed: args.speeds,
      moves: (body.moves || []).map((m) => ({
        uci: m.uci,
        games: m.white + m.draws + m.black,
        sharePct: totalGames > 0 ? ((m.white + m.draws + m.black) / totalGames) * 100 : 0,
      })),
    };

    writeFileSync(cachePath, JSON.stringify(mapped, null, 2) + "\n");
    return mapped;
  }

  const ourGapsByPath = new Map();
  const ourMultipvGapsByPath = new Map();

  function baseProviders(pathKey) {
    return {
      sfTopMoves: async (ucis) => {
        const fen = fenFromUcis(ucis);
        const lines = await sf.topMoves(fen, args.extDepth, 3);
        const sideToMove = fen.split(" ")[1] === "b" ? "black" : "white";
        const chess = new Chess(fen);
        const out = lines.map((line, idx) => {
          const uci = line.pv?.[0];
          const evalCpOur = sfScoreToOurCp(line.score, sideToMove, ourColor);
          const bestCp = sfScoreToOurCp(lines[0].score, sideToMove, ourColor);
          return {
            uci,
            san: uci ? sanOf(chess, uci) : uci,
            evalCpOur,
            gapToBestCp: idx === 0 ? 0 : bestCp - evalCpOur,
          };
        });

        if (isOurTurn(ucis.length, subjectColor)) {
          const gaps = ourGapsByPath.get(pathKey) || [];
          const multipv = ourMultipvGapsByPath.get(pathKey) || [];
          const pick = out.find((m) => m.gapToBestCp <= EXT_SOUND_GAP_CP) ?? out[0];
          if (pick) gaps.push(pick.gapToBestCp);
          if (out.length >= 2) {
            multipv.push(out[0].evalCpOur - out[1].evalCpOur);
          }
          ourGapsByPath.set(pathKey, gaps);
          ourMultipvGapsByPath.set(pathKey, multipv);
        }

        return out;
      },
      explorerReplies: async (ucis) => {
        const epd = epdFromUcis(ucis);
        return fetchExplorer(epd);
      },
      personalReplies: makePersonalRepliesProvider(allGames, subjectColor),
    };
  }

  /** @type {Array<{ reasons: string[] }>} */
  const preFunnelDropped = [];
  /** @type {import("../web-src/scout-v13-funnel.js").FunnelCandidate[]} */
  const candidates = [];
  const attributions = [];

  let routeIdx = 0;
  const t0 = Date.now();

  for (const { route, tendencyIds } of deduped) {
    routeIdx += 1;
    const pathKey = route.ucis.join(" ");
    const routeWithColor = { ...route, subjectColor };

    const segments = bindSegmentGames(
      countPathSegments(allGames, route.ucis, subjectColor),
      allGames,
    );
    const { trunkUcis, personalAnchorPly } = cutTrunkAtPersonalAnchor(routeWithColor, segments);

    if (!trunkUcis.length || personalAnchorPly === 0) {
      preFunnelDropped.push({
        id: `${subjectColor}:${pathKey}`,
        reasons: ["personalAnchor:emptyTrunk"],
      });
      continue;
    }

    const trunkBuilt = buildTrunkEdges(trunkUcis, segments, subjectColor);
    const providers = baseProviders(pathKey);

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
          const lines = await sf.topMoves(before, args.extDepth, 3);
          const sideToMove = before.split(" ")[1] === "b" ? "black" : "white";
          const uci = trunkUcis[i];
          const bestCp = sfScoreToOurCp(lines[0].score, sideToMove, ourColor);
          const pick = lines.find((l) => l.pv?.[0] === uci);
          // If the played move is outside multipv-3, eval it directly — never assume gap 0.
          const evalCpOur = pick
            ? sfScoreToOurCp(pick.score, sideToMove, ourColor)
            : await evalOurCpAfter(before, uci, args.extDepth);
          trunkOurGaps.push(bestCp - evalCpOur);
        }
        makeMove(chess, trunkUcis[i]);
      }
    }

    const ourGaps = [...trunkOurGaps, ...(ourGapsByPath.get(pathKey) || [])];
    const ourMultipvGaps = ourMultipvGapsByPath.get(pathKey) || [];

    const anchorUcis = trunkUcis;

    // The trunk ends after HIS move, so the anchor position is OUR turn. His-reply
    // key nodes (design §5: eval swing / threat density / coverage measured over HIS
    // main replies) start after our first extension move, plus every fork node.
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
      const nodeUcis = hisNodePaths[nodeIdx];
      const nodeFen = fenFromUcis(nodeUcis);
      const personalAtNode = await providers.personalReplies(nodeUcis);
      const explorerAtNode = await providers.explorerReplies(nodeUcis);
      const replyUcis = personalAtNode.length
        ? personalAtNode.map((r) => r.uci)
        : (explorerAtNode?.moves || []).map((m) => m.uci);

      const replyEvals = [];
      for (const uci of replyUcis.slice(0, 3)) {
        replyEvals.push(await evalOurCpAfter(nodeFen, uci, args.extDepth));
      }
      if (nodeIdx === 0) anchorReplyEvals.push(...replyEvals);

      keyNodeReplySets.push({ replyEvals });
      keyNodeHisReplies.push({ fen: nodeFen, ucis: replyUcis });
      if (explorerAtNode) keyNodeExplorer.push(explorerAtNode);
    }

    const entryUcis = entryUcisFromPath(route.ucis, subjectColor);
    const entryEpd = entryEpdFromPath(route.ucis, subjectColor);
    let entryMoveExplorerSharePct = 100;
    let entryNodeTotalGames = 0;
    {
      const entryPrefix = [];
      let ourSeen = 0;
      for (let i = 0; i < route.ucis.length && ourSeen < entryUcis.length; i += 1) {
        entryPrefix.push(route.ucis[i]);
        if (!isHisPly(i, subjectColor)) ourSeen += 1;
      }
      if (ourSeen > 0) entryPrefix.pop();
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

    const anchorAttribution = Number(route.attribution) || 0;
    attributions.push(anchorAttribution);

    const styleMetrics = deriveStyleMetrics({
      endpointEvalCp: extension.endpointEvalCp,
      ourGaps,
      anchorReplyEvals,
      mainlineUcis,
      ourColor,
      anchorAttribution,
      attributionP75: 0,
      topLeakMove: route.topLeakMove ?? null,
      // topLeakMove was computed at the route END node (scout-bias-routes), so the
      // capture/check test must replay the full route path, not the cut trunk.
      anchorUcis: route.ucis,
      ourMultipvGaps,
      entryMoveExplorerSharePct,
      entryNodeTotalGames,
      keyNodeReplySets,
      keyNodeHisReplies,
      keyNodeExplorer,
    });

    // Concept-family budget (§6) measures the NEW memorization load: the extension
    // plan only. Trunk moves are the entry decision he already plays into — counting
    // them makes every real line blow the ≤2-family budget on routine opening moves.
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

    const riskMetrics = {
      personalEdgeGames: hisTrunkGames,
      extensionHasPersonal,
      onlyMoveCount: styleMetrics.onlyMoveCount,
      evalSwingCp: styleMetrics.evalSwingCp,
      // TODO(v1): detect entry transpositions to equivalent EPD paths.
      entryTransposes: false,
    };

    candidates.push(
      assembleFunnelCandidate({
        subjectColor,
        routeUcis: route.ucis,
        trunkUcis,
        trunk: {
          edges: trunkBuilt.edges,
          personalAnchorPly: trunkBuilt.personalAnchorPly,
          reachLB: trunkBuilt.reachLB,
        },
        trunkSegments: trunkBuilt.trunkSegments,
        extension,
        styleMetrics,
        riskMetrics,
        memTree,
        tendencyIds,
        anchorAttribution,
        entryEpd,
        entryUcis,
      }),
    );

    if (routeIdx % 3 === 0 || routeIdx === deduped.length) {
      const rate = routeIdx / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  routes ${routeIdx}/${deduped.length}  (${rate.toFixed(2)}/s)   `);
    }
  }
  process.stdout.write("\n");

  const p75 = attributionP75(attributions);
  for (const cand of candidates) {
    cand.styleMetrics.attributionP75 = p75;
  }

  const report = await runSelectionFunnel(candidates, {
    auditLeafEval: async (ucis) => {
      const fen = fenFromUcis(ucis);
      return { evalCp: await evalOurCp(fen, args.sfDepth) };
    },
  });

  const eliminated = [
    ...preFunnelDropped,
    ...report.eliminated,
  ];

  const output = {
    meta: {
      routesFile: args.routes,
      gamesFile: args.games,
      subjectColor,
      ourColor,
      sfDepth: args.sfDepth,
      extDepth: args.extDepth,
      ratings: args.ratings,
      speeds: args.speeds,
      candidateCounts: {
        routes: routeTotal,
        deduped: deduped.length,
        assembled: candidates.length,
        survivors: report.packages.length,
      },
      explorerCache: explorerStats,
      sfEvalCache: evalCache.size,
      attributionP75: p75,
      runAt: new Date().toISOString(),
    },
    report: {
      ...report,
      eliminated,
    },
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2) + "\n");
  sf.quit();

  console.log("\nFunnel summary:");
  for (const pkg of report.packages) {
    console.log(
      `  ${pkg.id}  style=${pkg.primaryStyle ?? "—"}  risk=${pkg.riskTags.join(",") || "—"}  leaves=${pkg.extension?.leafCount ?? "?"}`,
    );
  }
  console.log(`  packages: ${report.packages.length}`);
  console.log(`  bucket vacancies: ${report.bucketVacancies.length}`);
  const reasonHist = new Map();
  for (const e of eliminated) {
    for (const r of e.reasons) {
      reasonHist.set(r, (reasonHist.get(r) || 0) + 1);
    }
  }
  console.log("  eliminated reasons:");
  for (const [reason, count] of [...reasonHist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count}`);
  }
  console.log(`\n✓ wrote ${args.out}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}`);
  process.exit(1);
});