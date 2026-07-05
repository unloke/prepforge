// Scout v12 — route-derivation harness: trie nodes → Maia tilt → SF leak → routes.
//
// Usage:
//   node scripts/scout-bias-routes.mjs \
//     --games tmp/unbrainless87.json \
//     --fit tmp/unbrainless87-fit.json \
//     --color white \
//     --rating 2250 \
//     --sf tmp/tools/stockfish/stockfish-windows-x86-64-avx2.exe \
//     --sf-depth 14 \
//     --max-plies 30 \
//     --min-node-games 5 \
//     --out tmp/routes-unbrainless87-white.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Chess } from "chess.js";

import { epdOf } from "../web-src/scout-graph.js";
import {
  FEATURE_IDS,
  buildDecisionContext,
  featureVector,
} from "../web-src/scout-bias-features.js";
import {
  attributionForFeature,
  clampDeltaCp,
  isRouteSound,
  pathReachLB,
  pickStableTendencies,
  rankScore,
  rawProbs,
  selectDistinctRoutes,
  sfScoreToOurCp,
  stableFeatureMask,
  tendencyVerdict,
  tiltedProbs,
  topLeakMove,
} from "../web-src/scout-bias-routes.js";
import { createOpeningTrie, insertGameIntoTrie, trieAnchorTs } from "../web-src/scout.js";
import {
  buildCandidates,
  configureOrtWasm,
  createMaiaSession,
  legalUciSet,
  maiaDistFor,
} from "../web-src/scout-maia-harness.js";
import { StockfishPool } from "../web-src/scout-stockfish-uci.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MAIA_DIR = join(ROOT, "web-src", "public", "maia3");
const MANIFEST = JSON.parse(readFileSync(join(MAIA_DIR, "maia3.manifest.json"), "utf8"));

configureOrtWasm(
  pathToFileURL(join(ROOT, "node_modules", "onnxruntime-web", "dist")).href + "/",
);

// --- args -----------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    rating: 2250,
    sfDepth: 14,
    maxPlies: 30,
    minNodeGames: 5,
    topK: 12,
    fp16: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--games") out.games = argv[++i];
    else if (a === "--fit") out.fit = argv[++i];
    else if (a === "--color") out.color = argv[++i];
    else if (a === "--rating") out.rating = Number(argv[++i]) || 2250;
    else if (a === "--sf") out.sf = argv[++i];
    else if (a === "--sf-depth") out.sfDepth = Number(argv[++i]) || 14;
    else if (a === "--max-plies") out.maxPlies = Number(argv[++i]) || 30;
    else if (a === "--min-node-games") out.minNodeGames = Number(argv[++i]) || 5;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--fp16") out.fp16 = true;
  }
  return out;
}

// --- game load (same convention as scout-bias-dump.mjs) -------------------------------------

function loadGames(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? raw : [...(raw.white || []), ...(raw.black || [])];
}

// --- trie walk ------------------------------------------------------------------------------

function isHisPly(ply, subjectColor) {
  const mover = ply % 2 === 0 ? "white" : "black";
  return mover === subjectColor;
}

function collectTrieNodes(root, subjectColor, maxPlies, minNodeGames) {
  const nodes = [];

  function walk(node, pathUcis, pathSans, reachSegments, ply) {
    if (isHisPly(ply, subjectColor) && ply <= maxPlies && node.gameCount >= minNodeGames) {
      nodes.push({
        trieNode: node,
        pathUcis: [...pathUcis],
        pathSans: [...pathSans],
        reachSegments: [...reachSegments],
        ply,
      });
    }
    for (const [key, child] of node.children) {
      const sep = key.indexOf("|");
      const uci = key.slice(0, sep);
      const san = key.slice(sep + 1);
      const childPly = ply + 1;
      const seg = {
        isHisMove: isHisPly(ply, subjectColor),
        childGames: child.gameCount,
        parentGames: node.gameCount,
      };
      walk(child, [...pathUcis, uci], [...pathSans, san], [...reachSegments, seg], childPly);
    }
  }

  walk(root, [], [], [], 0);
  return nodes;
}

function ourMovesOnPath(pathUcis, subjectColor) {
  const out = [];
  for (let i = 0; i < pathUcis.length; i += 1) {
    if (!isHisPly(i, subjectColor)) out.push(pathUcis[i]);
  }
  return out;
}

function entryPly(pathUcis, subjectColor) {
  for (let i = 0; i < pathUcis.length; i += 1) {
    if (!isHisPly(i, subjectColor)) return i + 1;
  }
  return 0;
}

function fenFromPath(pathUcis) {
  const chess = new Chess();
  for (const uci of pathUcis) {
    chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || undefined,
    });
  }
  return chess.fen();
}

function sanLineFromPath(pathUcis) {
  const chess = new Chess();
  const sans = [];
  for (const uci of pathUcis) {
    const m = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || undefined,
    });
    if (!m) break;
    sans.push(m.san);
  }
  return sans.join(" ");
}

// --- main pipeline --------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  if (!args.games || !args.fit || !args.color || !args.sf || !args.out) {
    console.error(
      "usage: node scripts/scout-bias-routes.mjs --games <json> --fit <fit.json> --color white|black --sf <stockfish.exe> [--rating N] [--sf-depth N] [--max-plies N] [--min-node-games N] --out <out.json>",
    );
    process.exit(2);
  }

  const subjectColor = args.color;
  const ourColor = subjectColor === "white" ? "black" : "white";

  const allGames = loadGames(args.games);
  const colorGames = allGames.filter((g) => g.color === subjectColor);
  console.log(`Loaded ${allGames.length} games (${colorGames.length} as ${subjectColor})`);

  const fitReport = JSON.parse(readFileSync(args.fit, "utf8"));
  const featureIds = fitReport.header?.featureIds || FEATURE_IDS;
  const beta = featureIds.map((id) => fitReport.fit?.beta?.[id] ?? 0);
  const tendencies = pickStableTendencies(fitReport, featureIds);
  const usedFallback = tendencies.some((t) => t.source === "featuresByAbsZ_fallback");
  if (usedFallback) {
    console.warn("  note: reliability.features absent — using featuresByAbsZ |z|≥2 fallback");
  }
  console.log(`  ${tendencies.length} stable tendencies`);

  const activeMask = stableFeatureMask(featureIds, tendencies);

  const anchorTs = trieAnchorTs(colorGames);
  const trie = createOpeningTrie();
  for (const g of colorGames) {
    insertGameIntoTrie(trie, g, subjectColor, { maxPlies: args.maxPlies, anchorTs, recency: true });
  }

  const trieNodes = collectTrieNodes(trie, subjectColor, args.maxPlies, args.minNodeGames);
  console.log(`  ${trieNodes.length} trie nodes (his move, games≥${args.minNodeGames}, ply≤${args.maxPlies})`);

  const artifact = args.fp16 ? MANIFEST.artifacts.fp16 : MANIFEST.artifacts.fp32;
  console.log(`→ loading Maia ${artifact.file} ...`);
  const maiaSession = await createMaiaSession(MAIA_DIR, MANIFEST, { fp16: args.fp16 });

  const sf = new StockfishPool(args.sf);
  const policyCache = new Map();
  const evalCache = new Map();

  async function evalOurCp(fen) {
    const epd = epdOf(fen);
    const cached = evalCache.get(epd);
    if (cached != null) return cached;
    const { score, sideToMove } = await sf.evalPosition(fen, args.sfDepth);
    const cp = sfScoreToOurCp(score, sideToMove, ourColor);
    evalCache.set(epd, cp);
    return cp;
  }

  async function evalOurCpAfter(fen, uci) {
    const chess = new Chess(fen);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    return evalOurCp(chess.fen());
  }

  const enrichedNodes = [];
  let inferCount = 0;
  const t0 = Date.now();

  for (let ni = 0; ni < trieNodes.length; ni += 1) {
    const tn = trieNodes[ni];
    const fen = fenFromPath(tn.pathUcis);
    const epd = epdOf(fen);
    const cacheKey = `${epd}|${args.rating}`;

    let dist = policyCache.get(cacheKey);
    if (!dist) {
      try {
        dist = await maiaDistFor(maiaSession, fen, args.rating);
      } catch {
        dist = [];
      }
      policyCache.set(cacheKey, dist);
      inferCount += 1;
    }

    const chess = new Chess(fen);
    const legal = legalUciSet(chess);
    let prevOwnMoveUci = null;
    for (let p = tn.pathUcis.length - 1; p >= 0; p -= 1) {
      if (isHisPly(p, subjectColor)) {
        prevOwnMoveUci = tn.pathUcis[p];
        break;
      }
    }
    const ctx = buildDecisionContext(fen, { prevOwnMoveUci });
    const candsRaw = buildCandidates(dist, legal, args.topK);
    const cands = candsRaw.map(({ uci, p }) => {
      const m = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
      chess.undo();
      return {
        uci,
        p,
        f: [...featureVector(ctx, uci)],
        san: m?.san ?? uci,
      };
    });

    const piRaw = rawProbs(cands);
    const piTilt = tiltedProbs(cands, beta, activeMask);

    const nodeEvalCp = await evalOurCp(fen);
    const cpAfter = [];
    // Deltas measure HIS error from OUR perspective: his best candidate MINIMIZES
    // our cp, and Δ(m) = how much move m gives away relative to that best choice.
    let hisBestCp = Infinity;
    for (const c of cands) {
      const cp = await evalOurCpAfter(fen, c.uci);
      cpAfter.push(cp);
      if (cp < hisBestCp) hisBestCp = cp;
    }
    const deltas = cpAfter.map((cp) => clampDeltaCp(cp - hisBestCp));

    const ourPathChecks = [];
    const chessPath = new Chess();
    for (let i = 0; i < tn.pathUcis.length; i += 1) {
      const uci = tn.pathUcis[i];
      if (!isHisPly(i, subjectColor)) {
        // Best = engine score of the pre-move position with US to move (its PV is
        // our best play); played = score after our actual route move. Two cached
        // evals instead of one per legal move.
        const beforeFen = chessPath.fen();
        const localBest = await evalOurCp(beforeFen);
        const playedCp = await evalOurCpAfter(beforeFen, uci);
        ourPathChecks.push({ evalCp: playedCp, bestCp: localBest });
      }
      chessPath.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4] || undefined,
      });
    }

    const sound = isRouteSound(nodeEvalCp, ourPathChecks);
    const reachLB = pathReachLB(tn.reachSegments);

    const attributions = {};
    for (const t of tendencies) {
      attributions[t.featureId] = attributionForFeature(
        cands,
        beta,
        t.featureIdx,
        deltas,
        activeMask,
      );
    }

    enrichedNodes.push({
      ...tn,
      fen,
      epd,
      cands,
      piRaw,
      piTilt,
      deltas,
      nodeEvalCp,
      sound,
      reachLB,
      attributions,
      nodeGames: tn.trieNode.gameCount,
      ourMoves: ourMovesOnPath(tn.pathUcis, subjectColor),
      entryPly: entryPly(tn.pathUcis, subjectColor),
    });

    if ((ni + 1) % 10 === 0 || ni + 1 === trieNodes.length) {
      const rate = (ni + 1) / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  nodes ${ni + 1}/${trieNodes.length}  maia ${inferCount}  (${rate.toFixed(1)}/s)   `);
    }
  }
  process.stdout.write("\n");

  const tendencyOutputs = tendencies.map((t) => {
    const ranked = enrichedNodes
      .map((n) => ({
        ...n,
        attribution: n.attributions[t.featureId] ?? 0,
        rankScore: rankScore(n.reachLB, n.attributions[t.featureId]),
        featureId: t.featureId,
      }))
      .filter((n) => n.sound && n.attribution > 0)
      .sort((a, b) => b.rankScore - a.rankScore);

    const picked = selectDistinctRoutes(ranked, { maxRoutes: 3 });
    const routes = picked.map((n) => ({
      sanLine: sanLineFromPath(n.pathUcis),
      ucis: n.pathUcis,
      entryPly: n.entryPly,
      reachLB: n.reachLB,
      nodeGames: n.nodeGames,
      nodeEvalCp: n.nodeEvalCp,
      attribution: n.attribution,
      topLeakMove: topLeakMove(n.cands, n.piTilt, n.piRaw, n.deltas),
    }));

    return {
      featureId: t.featureId,
      beta: t.beta,
      zFull: t.zFull,
      stable: t.stable,
      routes,
      verdict: tendencyVerdict(routes),
    };
  });

  const report = {
    meta: {
      games: colorGames.length,
      subjectColor,
      ourColor,
      rating: args.rating,
      sfDepth: args.sfDepth,
      maxPlies: args.maxPlies,
      minNodeGames: args.minNodeGames,
      trieNodes: trieNodes.length,
      maiaInferences: inferCount,
      sfEvalCache: evalCache.size,
      stableTendencies: tendencies.length,
      stableSource: usedFallback ? "featuresByAbsZ_fallback" : "reliability",
    },
    tendencies: tendencyOutputs,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
  sf.quit();

  console.log("\nRoute summary:");
  console.log("feature                          routes  verdict        top reach×attr");
  for (const t of tendencyOutputs) {
    const top = t.routes[0];
    const topScore = top ? (top.reachLB * top.attribution).toFixed(4) : "—";
    console.log(
      `${t.featureId.padEnd(32)} ${String(t.routes.length).padStart(6)}  ${t.verdict.padEnd(14)} ${topScore}`,
    );
  }
  console.log(`\n✓ wrote ${args.out}`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}`);
  process.exit(1);
});