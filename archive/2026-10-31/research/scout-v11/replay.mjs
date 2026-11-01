// v10 vs v11 path-guard head-to-head on frozen sessions. Native16 labels are evaluator-only.
// node replay.mjs <dataDir> <auditDir> <outDir> <shard> <shardCount>
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import * as scout from "../../web-src/scout.js";
import { rankPrefilterCandidates, collectPrefilterFens } from "../../web-src/scout-prefilter.js";
import { routeKey, canonicalPosition } from "../../web-src/scout-preparation-value.js";
import { selectPreparationRoutesV11, createPathGuard, ownDecisionPlies, unsafeRead, AUDIT_NODE_BUDGET, V10_QUEUE_READS, NODES_PER_GATE_READ, SCREEN_DEPTH, GATE_DEPTH, SCREEN_MARGIN_CP } from "./path-guard.mjs";
import { createEngine, parseNodes } from "./engine.mjs";
import { diagnosePath } from "./path-diagnostics.mjs";

const [dataDir, auditDir, outDir, shardArg = "0", countArg = "1"] = process.argv.slice(2);
const shard = Number(shardArg), shardCount = Number(countArg);
mkdirSync(resolve(outDir, "sessions"), { recursive: true });
const read = p => JSON.parse(readFileSync(p, "utf8"));
const ndjson = async function* (p) {
  for await (const line of createInterface({ input: createReadStream(p), crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line);
};

const protocol = read(resolve(dataDir, "PROTOCOL.json"));
const teacher = new Map(), teacherCanon = new Map();
for await (const r of ndjson(resolve(dataDir, "teacher-receipts.ndjson"))) {
  const v = { whiteCp: r.whiteCp, whiteMate: r.whiteMate, terminalWinner: r.terminalWinner ?? null };
  teacher.set(r.fen, v);
  const c = canonicalPosition(r.fen);
  if (!teacherCanon.has(c)) teacherCanon.set(c, v);
}
const leaf = new Map();
const leafPath = resolve(auditDir, "production-leaf-receipts.ndjson");
if (existsSync(leafPath)) for await (const r of ndjson(leafPath)) leaf.set(r.canonical ?? canonicalPosition(r.fen), r);

const engine = await createEngine(resolve("node_modules/stockfish/bin/stockfish-19-lite-single.js"));
const fensCache = new Map();
function fensFor(ucis) {
  const key = ucis.join(">");
  if (!fensCache.has(key)) fensCache.set(key, Array.from({ length: ucis.length + 1 }, (_, i) => scout.fenAfterLine(ucis.slice(0, i))));
  return fensCache.get(key);
}
let teacherMisses = 0, teacherCanonHits = 0;
const teacherGet = fen => {
  if (teacher.has(fen)) return teacher.get(fen);
  const v = teacherCanon.get(canonicalPosition(fen));
  if (v) teacherCanonHits++; else teacherMisses++;
  return v ?? null;
};

/** Native16 audit of a shown line (evaluator only). */
function native(route, oppColor) {
  const fens = fensFor(route.ucis), receipts = fens.map(teacherGet);
  const d = diagnosePath(receipts, oppColor, (route.anchorUcis ?? route.ucis).length, route.ucis.length);
  if (d.status !== "complete") return { status: "unknown", missing: d.missingPlies.length };
  const own = ownDecisionPlies(route.ucis.length, oppColor).some(p => unsafeRead({ whiteCp: receipts[p].whiteCp, whiteMate: receipts[p].whiteMate, winner: receipts[p].terminalWinner }, oppColor));
  return { status: "complete", mask: d.endpointMasksEarlierDisadvantage, ownUnsafe: own, gatePass: d.gatePass, worstCp: d.worstCp,
    fullFail: !d.gatePass || d.adverseMatePlies.length > 0 || (Number.isFinite(d.worstCp) && d.worstCp < -75),
    over100: Object.values(d.byPhase).reduce((n, p) => n + p.over100, 0) };
}

function armMetrics(picked, oppColor, v10Keys) {
  const rows = picked.map(r => ({ key: routeKey(r), anchor: (r.anchorUcis ?? r.ucis).join(">"), weak: r.preparationEvidence.value > 0,
    value: r.preparationEvidence.value, softValue: r.preparationEvidence.softValue, shrunk: r.preparationEvidence.shrunkScore,
    reach: r.preparationEvidence.conditionalReach, support: r.preparationEvidence.support, plies: r.ucis.length,
    pathStatus: r.pathStatus ?? null, native: native(r, oppColor) }));
  const n = rows.map(r => r.native), weak = rows.filter(r => r.weak), mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return { rows: rows.length, weak: weak.length, masks: n.filter(x => x.mask).length, fullFails: n.filter(x => x.fullFail).length,
    ownUnsafe: n.filter(x => x.ownUnsafe).length, unknown: n.filter(x => x.status !== "complete").length,
    worstCp: Math.min(...n.filter(x => Number.isFinite(x.worstCp)).map(x => x.worstCp)),
    over100: n.reduce((s, x) => s + (x.over100 ?? 0), 0),
    flags: { safe: rows.filter(r => r.pathStatus === "safe").length, risk: rows.filter(r => r.pathStatus === "risk").length,
      unverified: rows.filter(r => r.pathStatus === "unverified").length },
    flaggedMasks: rows.filter(r => r.native.mask && r.pathStatus === "risk").length,
    sumValue: rows.reduce((s, r) => s + r.value, 0), sumSoftValue: rows.reduce((s, r) => s + r.softValue, 0),
    weakMeanShrunk: mean(weak.map(r => r.shrunk)), meanReach: mean(rows.map(r => r.reach)), minReach: Math.min(...rows.map(r => r.reach)),
    minSupport: Math.min(...rows.map(r => r.support)), meanPlies: mean(rows.map(r => r.plies)),
    changedRows: rows.filter(r => !v10Keys.has(r.key)).length, rowsDetail: rows };
}

const sessions = [];
const players = protocol.players.filter(p => p.split !== "locked-test").filter((_, i) => i % shardCount === shard);
try {
  for (const p of players) {
    const corpus = read(resolve(dataDir, `prepared/${p.id}.corpus.json`));
    const games = corpus.games.filter(g => g.datestamp < corpus.cutoff && g.finishedAt < corpus.cutoff);
    for (const color of ["white", "black"]) {
      const t0 = Date.now();
      const baseline = scout.opponentColorBaseline(games, color), trie = scout.buildOpeningTrie(games, color, { maxPlies: Infinity });
      const bundle = scout.rankedOpeningBranches(games, color, { trie, limit: 300, baselineScorePct: baseline, now: trie.selectionAnchorTs });
      const fens = collectPrefilterFens(bundle.branches, { fenAfterLine: scout.fenAfterLine, oppColor: color });
      assert(fens.length <= 300);
      const evals = new Map(), leafNodes = new Map();
      let freshLeafReads = 0, missingLeafNodes = 0;
      for (const fen of fens) {
        const key = canonicalPosition(fen), r = leaf.get(key);
        let e, nodes = r?.uci ? parseNodes(r.uci) : null;
        if (r) e = { score_cp: r.score_cp, mate_in: r.mate_in, best_move_uci: r.best_move_uci, complete: true };
        if (!r || nodes === null) {
          const x = await engine.fresh(fen); freshLeafReads++;
          if (r) missingLeafNodes++;
          nodes = x.nodes;
          e ??= { score_cp: x.whiteCp ?? 0, mate_in: x.whiteMate ?? 0, best_move_uci: null, complete: true };
        }
        evals.set(fen, e); leafNodes.set(key, nodes);
      }
      const v10LeafNodes = [...leafNodes.values()].reduce((a, b) => a + b, 0);
      const options = { fenAfterLine: scout.fenAfterLine, oppColor: color, ancestorFreq: bundle.ancestorFreq, baselineScorePct: baseline };
      const lines = rankPrefilterCandidates(bundle.branches, evals, options).map(e => e.line);
      const v10 = scout.selectProductionRoutes(lines, baseline, { oppColor: color });
      const v10Keys = new Set(v10.map(routeKey));
      // Same eligibility mapping as rankGamePlan.
      const eligible = lines.filter(g => (g.routeSupportGames ?? g.games) >= scout.GAME_PLAN_MIN_GAMES).map(g => {
        const normalized = scout.normalizeToOpponentTerminal(g.ucis, g.sans, color);
        if (!normalized) return null;
        return scout.enrichPrepTarget({ ...g, ucis: normalized.ucis, sans: normalized.sans,
          terminalFen: normalized.ucis.length === g.ucis.length ? g.terminalFen : null, line: scout.branchPathKey(normalized.ucis),
          maiaWdl: g.maiaWdl, prefilterScore: g.prefilterScore }, baseline, { maiaScorePct: g.maiaScorePct ?? null });
      }).filter(l => l && (l.routeReach == null || l.routeReach >= scout.SCOUT_MIN_ROUTE_REACH))
        .map(l => ({ ...l, terminalFen: l.terminalFen ?? scout.fenAfterLine(l.ucis) }));
      const control = await selectPreparationRoutesV11(eligible, { baseline, limit: 12 });
      assert.deepEqual(control.picked.map(routeKey), v10.map(routeKey), `v11 control != v10 for ${p.id} ${color}`);
      const auditFile = resolve(auditDir, `${p.id}.${color}.json`);
      const auditSelected = existsSync(auditFile) ? read(auditFile).selected : null;
      const arms = {};
      for (const [arm, budgetNodes] of [["v11", AUDIT_NODE_BUDGET], ["v11-uncapped", Infinity]]) {
        const guard = createPathGuard({ engine, fensFor, oppColor: color, budgetNodes, leafMeanNodes: v10LeafNodes / Math.max(1, leafNodes.size) });
        const r = await selectPreparationRoutesV11(eligible, { baseline, limit: 12, guard });
        arms[arm] = { ...armMetrics(r.picked, color, v10Keys), auditNodes: guard.spentNodes, auditReads: guard.reads,
          budgetNodes: Number.isFinite(budgetNodes) ? budgetNodes : null, nodeRatio: v10LeafNodes ? guard.spentNodes / v10LeafNodes : null, capacityRatio: guard.spentNodes / (V10_QUEUE_READS * NODES_PER_GATE_READ),
          budgetExhausted: guard.exhausted, screens: guard.screens, confirms: guard.confirms, anchorRejections: r.anchorRejections, log: r.log };
      }
      // Detector recall: every v10 row read in full at depth8 (diagnostic, not a runtime cost).
      const recall = [];
      for (const route of v10) {
        const fs = fensFor(route.ucis), plies = ownDecisionPlies(route.ucis.length, color);
        await engine.newLine();
        let unsafe = false, nodes = 0, screenUnsafe = false, screenNodes = 0;
        for (const ply of plies) { const x = await engine.read(fs[ply], GATE_DEPTH); nodes += x.nodes; if (unsafeRead(x, color)) unsafe = true; }
        // The guard's screen policy over the same row, from a fresh hash.
        await engine.newLine();
        for (const ply of plies) {
          const x = await engine.read(fs[ply], SCREEN_DEPTH); screenNodes += x.nodes;
          if (!unsafeRead(x, color, SCREEN_MARGIN_CP)) continue;
          const y = await engine.read(fs[ply], GATE_DEPTH); screenNodes += y.nodes;
          if (unsafeRead(y, color)) screenUnsafe = true;
        }
        recall.push({ key: routeKey(route), depth8Unsafe: unsafe, nodes, screenUnsafe, screenNodes, native: native(route, color) });
      }
      const record = { id: `${p.id}-${color}`, player: p.id, split: p.split, color, baseline,
        v10ReplayMatchesAudit: auditSelected ? JSON.stringify(auditSelected) === JSON.stringify(v10.map(routeKey)) : null,
        v10LeafNodes, v10LeafReads: leafNodes.size, freshLeafReads, missingLeafNodes,
        arms: { v10: armMetrics(v10, color, v10Keys), ...arms }, recall, seconds: (Date.now() - t0) / 1000 };
      writeFileSync(resolve(outDir, "sessions", `${record.id}.json`), JSON.stringify(record, null, 1));
      const a = record.arms;
      console.log(JSON.stringify({ id: record.id, masks: [a.v10.masks, a.v11.masks, a["v11-uncapped"].masks],
        weak: [a.v10.weak, a.v11.weak], rows: [a.v10.rows, a.v11.rows], ratio: a.v11.nodeRatio?.toFixed(3),
        uncappedRatio: a["v11-uncapped"].nodeRatio?.toFixed(3), seconds: record.seconds }));
      sessions.push(record.id);
    }
  }
  writeFileSync(resolve(outDir, `SHARD-${shard}.json`), JSON.stringify({ status: "complete", shard, sessions, teacherMisses, teacherCanonHits, engineSearches: engine.searches }, null, 1));
} finally { engine.quit(); }
