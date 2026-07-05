// Scout v12 — Step 5 route audit: harsher verification pass on derived prep routes.
//
// Usage:
//   node scripts/scout-route-audit.mjs \
//     --routes tmp/routes-unbrainless87-black-v2.json \
//     --games tmp/unbrainless87.json \
//     --fit tmp/unbrainless87-fit.json \
//     --cohort tmp/cohort-z-unbrainless87.json \
//     --sf tmp/tools/stockfish/stockfish-windows-x86-64-avx2.exe \
//     --sf-depth 18 \
//     --maia-rating 2250 \
//     --out tmp/routes-audit-unbrainless87-black.json

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
import { sfScoreToOurCp, tiltedProbs } from "../web-src/scout-bias-routes.js";
import {
  buildCandidates,
  configureOrtWasm,
  createMaiaSession,
  legalUciSet,
  maiaDistFor,
} from "../web-src/scout-maia-harness.js";
import { StockfishPool } from "../web-src/scout-stockfish-uci.js";
import {
  CLAIM_LEVEL,
  FRAGILITY_GAP_MAX_CP,
  FRAGILITY_PLIES,
  PRODUCT_COPY_RULES,
  annotateAuditReport,
  assessFragility,
  assessRobustness,
  buildCohortLabelMap,
  buildOurLineSoundReport,
  countActualReach,
  countEntryDiversity,
  countSubjectSamples,
  countSurvivors,
  deriveRiskLevel,
  deriveVerdict,
  epdFromUcis,
  isHisPly,
  loadGames,
  multipvGapCp,
  prevHisMoveUciOnPath,
  wrapModelAttribution,
} from "../web-src/scout-route-audit.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MAIA_DIR = join(ROOT, "web-src", "public", "maia3");
const MANIFEST = JSON.parse(readFileSync(join(MAIA_DIR, "maia3.manifest.json"), "utf8"));

configureOrtWasm(
  pathToFileURL(join(ROOT, "node_modules", "onnxruntime-web", "dist")).href + "/",
);

function parseArgs(argv) {
  const out = {
    sfDepth: 18,
    fragilityDepth: 14,
    maiaRating: 2250,
    topK: 12,
    fp16: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--routes") out.routes = argv[++i];
    else if (a === "--games") out.games = argv[++i];
    else if (a === "--fit") out.fit = argv[++i];
    else if (a === "--cohort") out.cohort = argv[++i];
    else if (a === "--sf") out.sf = argv[++i];
    else if (a === "--sf-depth") out.sfDepth = Number(argv[++i]) || 18;
    else if (a === "--maia-rating") out.maiaRating = Number(argv[++i]) || 2250;
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--fp16") out.fp16 = true;
    else if (a === "--annotate") out.annotate = argv[++i];
  }
  return out;
}

function runAnnotate(args) {
  if (!args.annotate || !args.games || !args.out) {
    console.error(
      "usage: node scripts/scout-route-audit.mjs --annotate <existing-audit.json> --games <games.json> --out <annotated-audit.json>",
    );
    process.exit(2);
  }

  const auditJson = JSON.parse(readFileSync(args.annotate, "utf8"));
  const allGames = loadGames(JSON.parse(readFileSync(args.games, "utf8")));
  const annotated = annotateAuditReport(auditJson, allGames);

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(annotated, null, 2) + "\n");

  const tiers = { advantage: 0, safe: 0, info: 0, fail: 0 };
  for (const t of annotated.tendencies || []) {
    for (const r of t.routes || []) {
      if (r.tier) tiers[r.tier] += 1;
      else tiers.fail += 1;
    }
  }
  console.log("Annotate summary:");
  console.log(`  advantage: ${tiers.advantage}`);
  console.log(`  safe:      ${tiers.safe}`);
  console.log(`  info:      ${tiers.info}`);
  console.log(`  fail:      ${tiers.fail}`);
  console.log(`\n✓ wrote ${args.out}`);
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.annotate) {
    runAnnotate(args);
    return;
  }
  if (!args.routes || !args.games || !args.fit || !args.cohort || !args.sf || !args.out) {
    console.error(
      "usage: node scripts/scout-route-audit.mjs --routes <routes-v2.json> --games <games.json> --fit <fit.json> --cohort <cohort-z.json> --sf <stockfish.exe> [--sf-depth 18] [--maia-rating 2250] --out <audit.json>",
    );
    process.exit(2);
  }

  const routesReport = JSON.parse(readFileSync(args.routes, "utf8"));
  const subjectColor = routesReport.meta?.subjectColor;
  const ourColor = routesReport.meta?.ourColor ?? (subjectColor === "white" ? "black" : "white");
  const maxPlies = routesReport.meta?.maxPlies ?? 30;

  const allGames = loadGames(JSON.parse(readFileSync(args.games, "utf8")));
  const colorGames = allGames.filter((g) => g.color === subjectColor);
  console.log(`Loaded ${allGames.length} games (${colorGames.length} as ${subjectColor})`);

  const fitReport = JSON.parse(readFileSync(args.fit, "utf8"));
  const featureIds = fitReport.header?.featureIds || FEATURE_IDS;
  const beta = featureIds.map((id) => fitReport.fit?.beta?.[id] ?? 0);
  const cohortLabels = buildCohortLabelMap(JSON.parse(readFileSync(args.cohort, "utf8")));

  const tendencyMasks = new Map();
  for (const t of routesReport.tendencies || []) {
    const idx = featureIds.indexOf(t.featureId);
    const mask = featureIds.map(() => false);
    if (idx >= 0) mask[idx] = true;
    tendencyMasks.set(t.featureId, mask);
  }

  console.log("→ loading Maia …");
  const maiaSession = await createMaiaSession(MAIA_DIR, MANIFEST, { fp16: args.fp16 });
  const sf = new StockfishPool(args.sf);
  const policyCache = new Map();
  const evalCache = new Map();

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

  async function policyAt(fen) {
    const key = `${epdOf(fen)}|${args.maiaRating}`;
    let dist = policyCache.get(key);
    if (!dist) {
      try {
        dist = await maiaDistFor(maiaSession, fen, args.maiaRating);
      } catch {
        dist = [];
      }
      policyCache.set(key, dist);
    }
    return dist;
  }

  async function candsAt(fen, { prevOwnMoveUci = null } = {}) {
    const chess = new Chess(fen);
    const legal = legalUciSet(chess);
    const dist = await policyAt(fen);
    const raw = buildCandidates(dist, legal, args.topK);
    const ctx = buildDecisionContext(fen, { prevOwnMoveUci });
    return raw.map(({ uci, p }) => ({
      uci,
      p,
      san: sanOf(chess, uci),
      f: [...featureVector(ctx, uci)],
    }));
  }

  async function tiltedTopReplies(fen, featureId, n = 3, { prevOwnMoveUci = null } = {}) {
    const mask = tendencyMasks.get(featureId) || featureIds.map(() => false);
    const cands = await candsAt(fen, { prevOwnMoveUci });
    const piTilt = tiltedProbs(cands, beta, mask);
    const ranked = cands
      .map((c, i) => ({ ...c, piTilt: piTilt[i] }))
      .sort((a, b) => b.piTilt - a.piTilt)
      .slice(0, n);
    return ranked;
  }

  const subjectSamplesCache = new Map();
  function samplesFor(featureId) {
    if (!subjectSamplesCache.has(featureId)) {
      subjectSamplesCache.set(
        featureId,
        countSubjectSamples(allGames, featureId, subjectColor, { maxPlies: 60 }),
      );
    }
    return subjectSamplesCache.get(featureId);
  }

  let routeIdx = 0;
  const routeTotal = (routesReport.tendencies || []).reduce(
    (n, t) => n + (t.routes?.length || 0),
    0,
  );
  const t0 = Date.now();

  const tendencyOutputs = [];

  for (const tendency of routesReport.tendencies || []) {
    const cohortLabel = cohortLabels.get(tendency.featureId) ?? "cohort-common";
    const subjectSamples = samplesFor(tendency.featureId);
    const auditedRoutes = [];

    for (const route of tendency.routes || []) {
      routeIdx += 1;
      const targetEpd = epdFromUcis(route.ucis);
      const reach = countActualReach(allGames, targetEpd, subjectColor, { maxPlies });
      const actualReach = { ...reach, reachLB: route.reachLB };

      const endFen = fenFromUcis(route.ucis);
      const routePrevHis = prevHisMoveUciOnPath(route.ucis, subjectColor);
      const nodeEvalCp18 = await evalOurCp(endFen, args.sfDepth);

      const chessPath = new Chess();
      const ourPathMoves = [];
      for (let i = 0; i < route.ucis.length; i += 1) {
        const uci = route.ucis[i];
        if (!isHisPly(i, subjectColor)) {
          const beforeFen = chessPath.fen();
          const bestCp = await evalOurCp(beforeFen, args.sfDepth);
          const evalCp = await evalOurCpAfter(beforeFen, uci, args.sfDepth);
          ourPathMoves.push({
            uci,
            san: sanOf(chessPath, uci),
            evalCp,
            bestCp,
          });
        }
        makeMove(chessPath, uci);
      }

      const { ourLineSound, ourMoveLosses } = buildOurLineSoundReport(ourPathMoves);
      const sfVerify = { nodeEvalCp18, ourLineSound, ourMoveLosses };

      const topReplies = await tiltedTopReplies(endFen, tendency.featureId, 3, {
        prevOwnMoveUci: routePrevHis,
      });
      const robustnessReplies = [];
      for (const reply of topReplies) {
        const afterHis = new Chess(endFen);
        makeMove(afterHis, reply.uci);
        const ourBest = await sf.bestMove(afterHis.fen(), args.sfDepth);
        if (ourBest) makeMove(afterHis, ourBest);
        const evalAfterCp = await evalOurCp(afterHis.fen(), args.sfDepth);
        robustnessReplies.push({
          san: reply.san,
          piTilt: reply.piTilt,
          evalAfterCp,
        });
      }
      const robustness = assessRobustness(robustnessReplies);

      const fragilityGaps = [];
      let walkFen = endFen;
      for (let ply = 1; ply <= FRAGILITY_PLIES; ply += 1) {
        const isHis = ply % 2 === 1;
        if (isHis) {
          const replies = await tiltedTopReplies(walkFen, tendency.featureId, 1);
          const uci = replies[0]?.uci;
          if (!uci) break;
          const ch = new Chess(walkFen);
          makeMove(ch, uci);
          walkFen = ch.fen();
        } else {
          const lines = await sf.topMoves(walkFen, args.fragilityDepth, 2);
          const sideToMove = walkFen.split(" ")[1] === "b" ? "black" : "white";
          if (lines.length >= 2) {
            const gap = multipvGapCp(lines[0].score, lines[1].score, sideToMove, ourColor);
            fragilityGaps.push({
              ply,
              bestCp: gap.bestCp,
              secondCp: gap.secondCp,
              gapCp: gap.gapCp,
            });
          }
          const uci = lines[0]?.pv?.[0] || (await sf.bestMove(walkFen, args.fragilityDepth));
          if (!uci) break;
          const ch = new Chess(walkFen);
          makeMove(ch, uci);
          walkFen = ch.fen();
        }
      }
      const fragility = assessFragility(fragilityGaps, { gapMax: FRAGILITY_GAP_MAX_CP });

      const riskLevel = deriveRiskLevel({
        ourLineSound,
        robustnessPass: robustness.pass,
        actualReachPassed: actualReach.passed,
        narrowPath: fragility.narrowPath,
        nodeEvalCp18,
        subjectSamplesChose: subjectSamples.chose,
      });

      const { verdict, reasons } = deriveVerdict({
        riskLevel,
        ourLineSound,
        robustnessPass: robustness.pass,
        actualReachPassed: actualReach.passed,
        narrowPath: fragility.narrowPath,
        nodeEvalCp18,
        subjectSamplesChose: subjectSamples.chose,
      });

      auditedRoutes.push({
        sanLine: route.sanLine,
        ucis: route.ucis,
        entryPly: route.entryPly,
        nodeGames: route.nodeGames,
        actualReach,
        subjectSamples,
        cohortLabel,
        modelAttribution: wrapModelAttribution(route.attribution, route.topLeakMove),
        sfVerify,
        robustness,
        fragility,
        entryDiversity: 0,
        riskLevel,
        claimLevel: CLAIM_LEVEL,
        verdict,
        reasons,
      });

      if (routeIdx % 3 === 0 || routeIdx === routeTotal) {
        const rate = routeIdx / ((Date.now() - t0) / 1000);
        process.stdout.write(`\r  routes ${routeIdx}/${routeTotal}  (${rate.toFixed(2)}/s)   `);
      }
    }

    const survivors = countSurvivors(auditedRoutes);
    const survivingRoutes = auditedRoutes.filter((r) => r.verdict === "pass");
    const diversity = countEntryDiversity(survivingRoutes, subjectColor);
    for (const r of auditedRoutes) r.entryDiversity = diversity;

    tendencyOutputs.push({
      featureId: tendency.featureId,
      cohortLabel,
      stable: tendency.stable,
      routes: auditedRoutes,
      survivors,
    });
  }
  process.stdout.write("\n");

  const report = {
    meta: {
      routesFile: args.routes,
      gamesFile: args.games,
      fitFile: args.fit,
      cohortFile: args.cohort,
      subjectColor,
      ourColor,
      games: colorGames.length,
      maiaRating: args.maiaRating,
      sfDepth: args.sfDepth,
      fragilityDepth: args.fragilityDepth,
      maxPlies,
      routeCount: routeTotal,
      sfEvalCache: evalCache.size,
      maiaPolicyCache: policyCache.size,
      auditedAt: new Date().toISOString(),
    },
    productCopyRules: PRODUCT_COPY_RULES,
    tendencies: tendencyOutputs,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
  sf.quit();

  console.log("\nAudit summary:");
  console.log("feature                          routes  survivors");
  for (const t of tendencyOutputs) {
    console.log(
      `${t.featureId.padEnd(32)} ${String(t.routes.length).padStart(6)}  ${String(t.survivors).padStart(9)}`,
    );
  }
  console.log(`\n✓ wrote ${args.out}`);
}

function fenFromUcis(ucis) {
  const chess = new Chess();
  for (const uci of ucis) makeMove(chess, uci);
  return chess.fen();
}

main().catch((err) => {
  console.error(`\n✗ ${err.stack || err.message}`);
  process.exit(1);
});