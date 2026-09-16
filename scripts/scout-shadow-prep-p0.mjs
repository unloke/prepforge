// Scout SHADOW-PREP P0 — sealed materials feasibility gate lifecycle.
//
// Usage:
//   node scripts/scout-shadow-prep-p0.mjs init
//   node scripts/scout-shadow-prep-p0.mjs build [--sf <stockfish.exe>]
//   node scripts/scout-shadow-prep-p0.mjs census
//   node scripts/scout-shadow-prep-p0.mjs status
//   node scripts/scout-shadow-prep-p0.mjs verify
//
// Study root defaults to tmp/scout-shadow-prep-study/ericrosen-shadow-prep-p0.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { wdlCurrent } from "../web-src/engine/maia3-inference.js";
import { tokensFromFen } from "../web-src/engine/maia3-tokenizer.js";
import {
  configureOrtWasm,
  createMaiaSession,
  maiaFeeds,
} from "../web-src/scout-maia-harness.js";
import {
  SCOUT_GAME_PLAN_LIMIT,
  SCOUT_MAIA_LIMIT,
  buildOpeningTrie,
  fenAfterLine,
  rankedOpeningBranches,
  rankGamePlan,
  terminalMoveIsOpponent,
  trimRankedBranches,
} from "../web-src/scout.js";
import {
  collectPrefilterFens,
  prefilterMaiaLines,
  rankPrefilterCandidates,
} from "../web-src/scout-prefilter.js";
import {
  clampMaiaRating,
  maiaScorePctFromWdl,
  medianOpponentRating,
  wdlToOpponentPerspective,
} from "../web-src/scout-maia.js";
import {
  sha256RefDfProtocol,
  validateRefDfProtocol,
} from "../web-src/scout-ref-df-census.js";
import {
  SHADOW_PREP_COLORS,
  SHADOW_PREP_FINAL_REPORT_NAME,
  SHADOW_PREP_PROTOCOL_ID,
  SHADOW_PREP_STATES,
  adaptV2BaselineRows,
  assertShadowPrepStateTransition,
  attachSharedYToPackages,
  buildCandidatePackagesByColor,
  buildCanonicalStudyMaterials,
  buildPilotStimulusStream,
  buildPinnedSharedEngineIdentity,
  buildSharedYReceiptForAtom,
  buildShadowPrepReport,
  computeShadowPrepBuildArtifactHashes,
  compareMaterialBudget,
  evaluateInfluenceGates,
  evaluateStimulusInfluence,
  extractEligibleAtomsFromGames,
  refusesShadowPrepRebuild,
  refusesShadowPrepReplay,
  refusesShadowPrepTopUp,
  recomputeMaterialChecks,
  resolveShadowPrepPostBuildState,
  resolveShadowPrepPostCensusState,
  selectCandidatePackage,
  sha256ShadowPrepProtocol,
  validateShadowPrepProtocol,
  validateShadowPrepReport,
  verifyShadowPrepArtifacts,
  verifyShadowPrepBuildArtifacts,
  verifyShadowPrepPinnedSources,
  verifyShadowPrepProtocolIdentity,
} from "../web-src/scout-shadow-prep-p0.js";
import { engineIdentityKey } from "../web-src/scout-v15-engine-cache.js";
import { lineLastSeen } from "../web-src/scout-stats.js";
import {
  parseBestMove,
  parseFinalDepthScore,
  parseMultipvAtDepth,
  StockfishPool,
} from "../web-src/scout-stockfish-uci.js";
import {
  assertProtocolSha256,
  sha256Buffer,
  sha256Hex,
  sortGamesByCreatedAt,
} from "../web-src/scout-v15-study.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROTOCOL = resolve(
  REPO_ROOT,
  "research/scout-shadow-prep/ericrosen-shadow-prep-p0.protocol.json",
);
const DEFAULT_STUDY_ROOT = resolve(
  REPO_ROOT,
  "tmp/scout-shadow-prep-study/ericrosen-shadow-prep-p0",
);
const MAIA_DIR = join(REPO_ROOT, "web-src", "public", "maia3");
const FROZEN_AT = "1970-01-01T00:00:00.000Z";
export function studyPaths(studyRoot) {
  return {
    root: studyRoot,
    state: resolve(studyRoot, "state.json"),
    events: resolve(studyRoot, "events.ndjson"),
    protocolSnapshot: resolve(studyRoot, "protocol.snapshot.json"),
    sourceManifest: resolve(studyRoot, "source.manifest.json"),
    buildDir: resolve(studyRoot, "build"),
    buildManifest: resolve(studyRoot, "build/manifest.json"),
    buildIdentity: resolve(studyRoot, "build/d0-corpus-identity.json"),
    candidatePackages: resolve(studyRoot, "build/candidate/packages.json"),
    baselinePackages: resolve(studyRoot, "build/baseline/packages.json"),
    materialsDir: resolve(studyRoot, "build/materials"),
    materialChecks: resolve(studyRoot, "build/materials/checks.json"),
    yDir: resolve(studyRoot, "build/y"),
    yReceipts: resolve(studyRoot, "build/y/shared-receipts.json"),
    yManifest: resolve(studyRoot, "build/y/manifest.json"),
    cacheDir: resolve(studyRoot, "build/cache"),
    stockfishEvalCache: resolve(studyRoot, "build/cache/stockfish-eval-cache.json"),
    maiaEvidence: resolve(studyRoot, "build/cache/maia-evidence.json"),
    engineEvidence: resolve(studyRoot, "build/cache/engine-evidence.json"),
    modelEvidence: resolve(studyRoot, "build/cache/model-evidence.json"),
    censusDir: resolve(studyRoot, "census"),
    censusReport: resolve(studyRoot, `census/${SHADOW_PREP_FINAL_REPORT_NAME}`),
    stimulusDir: resolve(studyRoot, "census/stimulus"),
    stimulusStream: resolve(studyRoot, "census/stimulus/stream.json"),
    stimulusManifest: resolve(studyRoot, "census/stimulus/manifest.json"),
  };
}

function parseArgs(argv) {
  const args = {
    command: null,
    studyRoot: DEFAULT_STUDY_ROOT,
    protocolPath: DEFAULT_PROTOCOL,
    sfPath: null,
  };
  const rest = argv.slice(2);
  if (!rest.length) return args;
  args.command = rest[0];
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--root" || arg === "--study-root") args.studyRoot = resolve(rest[++i]);
    else if (arg === "--protocol") args.protocolPath = resolve(rest[++i]);
    else if (arg === "--sf") args.sfPath = resolve(rest[++i]);
  }
  return args;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendEvent(studyRoot, event) {
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    ...event,
  })}\n`;
  appendFileSync(resolve(studyRoot, "events.ndjson"), line, "utf8");
}

function loadEvents(studyRoot) {
  const path = resolve(studyRoot, "events.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function resolveRepoPath(relativePath) {
  return resolve(REPO_ROOT, relativePath);
}

function loadProtocol(protocolPath) {
  const protocol = readJson(protocolPath);
  const validation = validateShadowPrepProtocol(protocol);
  if (!validation.ok) {
    throw new Error(`invalid SHADOW-PREP protocol: ${validation.errors.join("; ")}`);
  }
  return { protocol, validation };
}

function protocolSha256FromProtocol(protocol) {
  return sha256ShadowPrepProtocol(protocol);
}

function assertShadowPrepProtocolSnapshot(paths, protocolPath) {
  if (!existsSync(paths.protocolSnapshot)) {
    throw new Error("missing protocol.snapshot.json — run init first");
  }
  const snapshot = readJson(paths.protocolSnapshot);
  const { protocol } = loadProtocol(protocolPath);
  const identity = verifyShadowPrepProtocolIdentity(protocol, {
    snapshotProtocolSha256: snapshot.protocolSha256,
  });
  if (!identity.ok) {
    throw new Error(`protocol snapshot mismatch: ${identity.issues.map((issue) => issue.kind).join(", ")}`);
  }
  assertProtocolSha256({
    expectedSha256: snapshot.protocolSha256,
    actualSha256: identity.canonicalSha256,
  });
  return { snapshot, protocol, currentSha: identity.canonicalSha256 };
}

function loadState(paths) {
  return readJson(paths.state);
}

function saveState(paths, state) {
  writeJson(paths.state, state);
}

function readPinnedFile(relativePath) {
  const absolutePath = resolveRepoPath(relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`missing pinned file: ${relativePath}`);
  }
  const buffer = readFileSync(absolutePath);
  return {
    absolutePath,
    relativePath,
    buffer,
    sha256: sha256Buffer(buffer),
    text: buffer.toString("utf8"),
  };
}

function loadNdjsonGames(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadJsonArray(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`expected JSON array at ${path}`);
  return data;
}

function idsFromGamesArray(games) {
  return games.map((row) => String(row?.gameId ?? row?.id ?? "")).filter(Boolean);
}

function idsFromManifest(data) {
  if (Array.isArray(data?.gameIds)) return data.gameIds.map(String);
  if (Array.isArray(data)) return idsFromGamesArray(data);
  return [];
}

function buildD0CorpusIdentity(games) {
  const sorted = sortGamesByCreatedAt(games);
  const gameIds = sorted.map((game) => String(game.gameId)).sort((a, b) => a.localeCompare(b));
  const lines = sorted.map((game) => JSON.stringify(game));
  return {
    kind: "scout-shadow-prep-p0-d0-corpus-identity",
    version: 1,
    gameCount: sorted.length,
    gameIdsSha256: sha256Hex(`${gameIds.join("\n")}\n`),
    contentSha256: sha256Hex(`${lines.join("\n")}\n`),
    gameIds,
  };
}

function verifyWindowOrder(protocol) {
  const artifacts = protocol?.frozenArtifacts || {};
  const hm1 = artifacts.hM1Games;
  const hr1 = artifacts.hR1Games;
  const errors = [];
  if (Number(hm1?.lowerInclusiveMs) >= Number(hm1?.upperExclusiveMs)) {
    errors.push("h-m1 window order invalid");
  }
  if (Number(hr1?.lowerInclusiveMs) >= Number(hr1?.upperExclusiveMs)) {
    errors.push("h-r1 window order invalid");
  }
  if (Number(hm1?.upperExclusiveMs) !== Number(hr1?.lowerInclusiveMs)) {
    errors.push("h-m1/h-r1 window boundary mismatch");
  }
  if (Number(hm1?.lowerInclusiveMs) !== Number(protocol?.buildPartition?.d0Window?.upperExclusiveMs)) {
    errors.push("d0/h-m1 window boundary mismatch");
  }
  return { ok: errors.length === 0, errors };
}

function buildPinnedSourceDescriptors(protocol) {
  const pins = protocol?.buildPartition || {};
  const frozen = protocol?.frozenArtifacts || {};
  const baseline = protocol?.baselineEvidence || {};
  const entries = {
    refDfProtocol: pins.refDfProtocol,
    d0CorpusGames: pins.refDfCorpusGames,
    d0CorpusManifest: pins.refDfCorpusManifest,
    d0CensusReport: pins.refDfCensusReport,
    hM1Games: frozen.hM1Games,
    hM1Manifest: frozen.hM1Manifest,
    hR1Games: frozen.hR1Games,
    hR1Manifest: frozen.hR1Manifest,
    legacyGames: frozen.legacyGames,
    maiaManifest: baseline.maiaManifest,
    stockfishBinary: protocol?.sharedYEngine,
  };
  const descriptors = {};
  for (const [name, pin] of Object.entries(entries)) {
    if (!pin?.relativePath) continue;
    const file = readPinnedFile(pin.relativePath);
    descriptors[name] = {
      name,
      relativePath: pin.relativePath,
      sha256: file.sha256,
      bytes: file.buffer.length,
      absolutePath: file.absolutePath,
      buffer: file.buffer,
      text: file.text,
    };
  }
  return descriptors;
}

function verifyInitPinnedSources(protocol, descriptors) {
  const issues = [];
  const sources = {};

  const assign = (name, value) => {
    sources[name] = value;
  };

  assign("refDfProtocol", { content: descriptors.refDfProtocol?.text, sha256: descriptors.refDfProtocol?.sha256 });
  assign("d0CorpusGames", { content: descriptors.d0CorpusGames?.text, sha256: descriptors.d0CorpusGames?.sha256 });
  assign("d0CorpusManifest", { content: descriptors.d0CorpusManifest?.text, sha256: descriptors.d0CorpusManifest?.sha256 });
  assign("d0CensusReport", { content: descriptors.d0CensusReport?.text, sha256: descriptors.d0CensusReport?.sha256 });
  assign("legacyGames", { data: JSON.parse(descriptors.legacyGames.text), sha256: descriptors.legacyGames.sha256 });
  assign("hM1Games", { data: JSON.parse(descriptors.hM1Games.text), sha256: descriptors.hM1Games.sha256 });
  assign("hM1Manifest", { data: JSON.parse(descriptors.hM1Manifest.text), sha256: descriptors.hM1Manifest.sha256 });
  assign("hR1Games", { data: JSON.parse(descriptors.hR1Games.text), sha256: descriptors.hR1Games.sha256 });
  assign("hR1Manifest", { data: JSON.parse(descriptors.hR1Manifest.text), sha256: descriptors.hR1Manifest.sha256 });
  assign("maiaManifest", { content: descriptors.maiaManifest.text, sha256: descriptors.maiaManifest.sha256 });

  const pure = verifyShadowPrepPinnedSources(protocol, { sources });
  if (!pure.ok) issues.push(...pure.issues);

  const pinChecks = [
    ["d0CorpusGames", protocol.buildPartition?.refDfCorpusGames],
    ["d0CorpusManifest", protocol.buildPartition?.refDfCorpusManifest],
    ["d0CensusReport", protocol.buildPartition?.refDfCensusReport],
    ["hM1Games", protocol.frozenArtifacts?.hM1Games],
    ["hM1Manifest", protocol.frozenArtifacts?.hM1Manifest],
    ["hR1Games", protocol.frozenArtifacts?.hR1Games],
    ["hR1Manifest", protocol.frozenArtifacts?.hR1Manifest],
    ["legacyGames", protocol.frozenArtifacts?.legacyGames],
    ["maiaManifest", protocol.baselineEvidence?.maiaManifest],
    ["stockfishBinary", protocol.sharedYEngine],
  ];
  for (const [name, pin] of pinChecks) {
    const row = descriptors[name];
    if (!row) {
      issues.push({ kind: "missing-pinned-file", source: name });
      continue;
    }
    if (pin?.sha256 && row.sha256 !== String(pin.sha256).toLowerCase()) {
      issues.push({ kind: "pinned-sha-mismatch", source: name, expected: pin.sha256, actual: row.sha256 });
    }
  }

  const refDfProtocol = JSON.parse(descriptors.refDfProtocol.text);
  const refDfValidation = validateRefDfProtocol(refDfProtocol);
  if (!refDfValidation.ok) {
    issues.push({ kind: "invalid-ref-df-protocol", errors: refDfValidation.errors });
  }
  const refDfSha = sha256RefDfProtocol(refDfProtocol);
  if (refDfSha !== protocol.buildPartition?.refDfProtocol?.protocolSha256) {
    issues.push({ kind: "ref-df-protocol-sha-mismatch", expected: protocol.buildPartition?.refDfProtocol?.protocolSha256, actual: refDfSha });
  }

  const d0Games = loadNdjsonGames(descriptors.d0CorpusGames.absolutePath);
  if (d0Games.length !== Number(protocol.buildPartition?.refDfCorpusGames?.gameCount)) {
    issues.push({
      kind: "d0-corpus-count-mismatch",
      expected: protocol.buildPartition?.refDfCorpusGames?.gameCount,
      actual: d0Games.length,
    });
  }
  const d0Manifest = JSON.parse(descriptors.d0CorpusManifest.text);
  if (Number(d0Manifest?.gameCount) !== Number(protocol.buildPartition?.refDfCorpusManifest?.gameCount)) {
    issues.push({ kind: "d0-manifest-count-mismatch" });
  }
  const censusReport = JSON.parse(descriptors.d0CensusReport.text);
  if (censusReport?.verdict !== protocol.buildPartition?.refDfCensusReport?.requiredVerdict) {
    issues.push({
      kind: "d0-census-verdict-mismatch",
      expected: protocol.buildPartition?.refDfCensusReport?.requiredVerdict,
      actual: censusReport?.verdict,
    });
  }

  const legacyIds = idsFromGamesArray(JSON.parse(descriptors.legacyGames.text));
  const hm1GamesIds = idsFromGamesArray(JSON.parse(descriptors.hM1Games.text));
  const hr1GamesIds = idsFromGamesArray(JSON.parse(descriptors.hR1Games.text));
  const hm1Ids = idsFromManifest(JSON.parse(descriptors.hM1Manifest.text));
  const hr1Ids = idsFromManifest(JSON.parse(descriptors.hR1Manifest.text));
  if (legacyIds.length !== Number(protocol.frozenArtifacts?.legacyGames?.gameCount)) {
    issues.push({ kind: "legacy-count-mismatch", actual: legacyIds.length });
  }
  if (hm1Ids.length !== Number(protocol.frozenArtifacts?.hM1Manifest?.gameCount)) {
    issues.push({ kind: "h-m1-manifest-count-mismatch", actual: hm1Ids.length });
  }
  if (hr1Ids.length !== Number(protocol.frozenArtifacts?.hR1Manifest?.gameCount)) {
    issues.push({ kind: "h-r1-manifest-count-mismatch", actual: hr1Ids.length });
  }
  const sameIds = (left, right) => {
    const a = [...left].sort();
    const b = [...right].sort();
    return a.length === b.length && a.every((id, index) => id === b[index]);
  };
  if (!sameIds(hm1GamesIds, hm1Ids)) issues.push({ kind: "h-m1-games-manifest-id-mismatch" });
  if (!sameIds(hr1GamesIds, hr1Ids)) issues.push({ kind: "h-r1-games-manifest-id-mismatch" });

  const union = new Set([...legacyIds, ...hm1Ids, ...hr1Ids]);
  if (legacyIds.length + hm1Ids.length + hr1Ids.length !== union.size) {
    issues.push({ kind: "stimulus-id-overlap" });
  }
  if (union.size !== Number(protocol.frozenArtifacts?.burnedUnion?.gameCount)) {
    issues.push({ kind: "burned-union-count-mismatch", expected: 1098, actual: union.size });
  }
  const d0Ids = idsFromGamesArray(d0Games);
  const d0BurnedOverlap = d0Ids.filter((id) => union.has(id));
  if (d0BurnedOverlap.length) {
    issues.push({ kind: "d0-burned-overlap", count: d0BurnedOverlap.length, sample: d0BurnedOverlap.slice(0, 3) });
  }

  const windowOrder = verifyWindowOrder(protocol);
  if (!windowOrder.ok) {
    for (const error of windowOrder.errors) issues.push({ kind: "window-order", error });
  }

  const maiaManifest = JSON.parse(descriptors.maiaManifest.text);
  const maiaModelRel = maiaManifest?.artifacts?.fp32?.file || maiaManifest?.artifacts?.fp16?.file;
  if (!maiaModelRel) issues.push({ kind: "missing-maia-model-path" });
  else {
    const maiaModelPath = join(MAIA_DIR, maiaModelRel);
    if (!existsSync(maiaModelPath)) issues.push({ kind: "missing-maia-model-file", path: maiaModelPath });
    else {
      const modelSha = sha256Buffer(readFileSync(maiaModelPath));
      const artifact = maiaManifest?.artifacts?.fp32 || maiaManifest?.artifacts?.fp16;
      sources.maiaModelSha256 = modelSha;
      if (artifact?.sha256 && modelSha !== String(artifact.sha256).toLowerCase()) {
        issues.push({ kind: "maia-model-sha-mismatch", expected: artifact.sha256, actual: modelSha });
      }
    }
  }

  return { ok: issues.length === 0, issues, sources, d0Games, maiaManifest };
}

function buildSourceManifest(protocol, descriptors, verification) {
  return {
    kind: "scout-shadow-prep-p0-source-manifest",
    version: 1,
    protocolId: protocol.protocolId,
    protocolSha256: protocolSha256FromProtocol(protocol),
    verifiedAt: new Date().toISOString(),
    buildUsedStimulus: false,
    entries: Object.fromEntries(
      Object.entries(descriptors).map(([name, row]) => [name, {
        relativePath: row.relativePath,
        sha256: row.sha256,
        bytes: row.bytes,
      }]),
    ),
    burnedUnionCount: verification.sources ? Number(protocol.frozenArtifacts?.burnedUnion?.gameCount) : null,
    verification: { ok: verification.ok, issueCount: verification.issues.length },
  };
}

export function commandInit(args) {
  const paths = studyPaths(args.studyRoot);
  const { protocol } = loadProtocol(args.protocolPath);
  if (existsSync(paths.state)) {
    throw new Error(`SHADOW-PREP study already initialized at ${args.studyRoot}`);
  }

  ensureDir(paths.buildDir);
  ensureDir(paths.censusDir);
  ensureDir(paths.stimulusDir);

  const protocolSha256 = protocolSha256FromProtocol(protocol);
  const descriptors = buildPinnedSourceDescriptors(protocol);
  const verification = verifyInitPinnedSources(protocol, descriptors);
  if (!verification.ok) {
    throw new Error(`pinned source verification failed: ${verification.issues.map((issue) => issue.kind).join(", ")}`);
  }

  const snapshot = {
    kind: "scout-shadow-prep-p0-protocol-snapshot",
    version: 1,
    protocolId: protocol.protocolId,
    protocolPath: args.protocolPath,
    protocolSha256,
    subject: protocol.subject.lichessUsername,
    frozenAt: new Date().toISOString(),
    protocol: { ...protocol, protocolSha256 },
  };
  writeJson(paths.protocolSnapshot, snapshot);

  const sourceManifest = buildSourceManifest(protocol, descriptors, verification);
  writeJson(paths.sourceManifest, sourceManifest);

  const state = {
    kind: "scout-shadow-prep-p0-study-state",
    version: 1,
    protocolId: protocol.protocolId,
    protocolPath: args.protocolPath,
    protocolSha256,
    subject: protocol.subject.lichessUsername,
    state: SHADOW_PREP_STATES.INITIALIZED,
    createdAt: new Date().toISOString(),
    builtAt: null,
    censusAt: null,
    verifiedAt: null,
    buildUsedStimulus: false,
  };
  saveState(paths, state);
  appendEvent(args.studyRoot, { type: "init", state: state.state, protocolSha256 });
  return { ok: true, command: "init", studyRoot: args.studyRoot, state, sourceManifest };
}

function subjectMoveOrdinalFromPath(ucis, color) {
  let ordinal = 0;
  for (let i = 0; i < (ucis || []).length; i += 1) {
    const mover = i % 2 === 0 ? "white" : "black";
    if (mover === color) ordinal += 1;
  }
  return ordinal;
}

function baselineScorePctForGames(games) {
  const scores = (games || []).map((game) => Number(game?.score)).filter(Number.isFinite);
  if (!scores.length) return 50;
  return (scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100;
}

function evalToWhitePov(score, sideToMove) {
  if (!score) return { score_cp: 0, mate_in: 0 };
  if (score.type === "mate") {
    const mate = Number(score.value) || 0;
    return { score_cp: 0, mate_in: sideToMove === "white" ? mate : -mate };
  }
  const cp = Number(score.cp) || 0;
  return { score_cp: sideToMove === "white" ? cp : -cp, mate_in: 0 };
}

function buildEvalMapEntry(fen, depth, { score, sideToMove, buf }) {
  const white = evalToWhitePov(score, sideToMove);
  const top = parseMultipvAtDepth(buf, depth, 1)[0];
  return {
    score_cp: white.score_cp,
    mate_in: white.mate_in,
    best_move_uci: parseBestMove(buf),
    pv: top?.pv || [],
  };
}

async function evaluateLeafFens(sf, fens, depth, threads, hashMb) {
  const pool = sf || null;
  const evalMap = new Map();
  const receipts = [];
  for (const fen of [...new Set(fens || [])].sort()) {
    const { score, sideToMove, buf } = await pool.evalPosition(fen, depth);
    const entry = buildEvalMapEntry(fen, depth, { score, sideToMove, buf });
    evalMap.set(fen, entry);
    receipts.push({ fen, sha256: sha256Hex(entry) });
  }
  return { evalMap, receipts, threads, hashMb };
}

async function readMaiaWdl(session, fen, rating) {
  const tokens = tokensFromFen(fen);
  const out = await session.run(maiaFeeds(tokens, rating));
  return wdlCurrent(out.logits_value.data);
}

function safeSelectCandidatePackage(games, color, protocol) {
  const eligible = extractEligibleAtomsFromGames(games, { color, protocol });
  try {
    const selected = selectCandidatePackage(eligible, protocol);
    return { package: selected, diagnostic: selected ? null : { kind: "no-package", color, eligibleAtoms: eligible.length } };
  } catch (error) {
    return {
      package: null,
      diagnostic: {
        kind: "search-overflow",
        color,
        message: error?.message || String(error),
        eligibleAtoms: eligible.length,
      },
    };
  }
}

async function buildBaselinePackageForColor({
  games,
  color,
  protocol,
  sf,
  maiaSession,
  maiaManifest,
  sfDepth,
  sfThreads,
  sfHashMb,
}) {
  const colorGames = games.filter((game) => game.color === color);
  const baselineScorePct = baselineScorePctForGames(colorGames);
  const trie = buildOpeningTrie(colorGames, color, { speedFilter: "all" });
  const { branches, ancestorFreq } = rankedOpeningBranches(colorGames, color, {
    speedFilter: "all",
    trie,
    baselineScorePct,
    limit: 0,
    now: Number(protocol?.buildPartition?.d0Window?.upperExclusiveMs),
  });
  const lines = trimRankedBranches(branches);
  const leafFens = collectPrefilterFens(lines, { fenAfterLine, oppColor: color });
  const { evalMap, receipts: sfReceipts } = await evaluateLeafFens(sf, leafFens, sfDepth, sfThreads, sfHashMb);
  const ranked = rankPrefilterCandidates(lines, evalMap, {
    fenAfterLine,
    oppColor: color,
    ancestorFreq,
    baselineScorePct,
  });
  const maiaLines = prefilterMaiaLines(ranked, SCOUT_MAIA_LIMIT);
  const maiaRating = clampMaiaRating(medianOpponentRating(colorGames, color));
  const maiaEvidenceRows = [];
  const enriched = [];
  for (const line of maiaLines) {
    const fen = fenAfterLine(line.ucis);
    const sideWdl = await readMaiaWdl(maiaSession, fen, maiaRating);
    const leafIsUserTurn = terminalMoveIsOpponent(line.ucis, color);
    const maiaWdl = wdlToOpponentPerspective(sideWdl, leafIsUserTurn);
    const maiaScorePct = maiaScorePctFromWdl(maiaWdl);
    maiaEvidenceRows.push({ fen, rating: maiaRating, maiaWdl, maiaScorePct, leafIsUserTurn });
    enriched.push({
      ...line,
      maiaWdl,
      maiaScorePct,
      prefilterScore: ranked.find((entry) => entry.line === line)?.prefilterScore ?? line.prefilterScore,
    });
  }
  const rankedPlan = rankGamePlan(enriched, baselineScorePct, {
    oppColor: color,
    games: colorGames,
    speedFilter: "all",
    lineLastSeen,
    ancestorFreq,
    limit: SCOUT_GAME_PLAN_LIMIT,
  });
  const v2Rows = rankedPlan.map((row, index) => ({
    productionRank: index + 1,
    ucis: row.ucis,
    subjectOrdinal: subjectMoveOrdinalFromPath(row.ucis, color),
    subjectUci: row.ucis?.at(-1) || null,
  }));
  const adapted = adaptV2BaselineRows(v2Rows, { color, protocol });
  return {
    package: adapted.atoms.length
      ? {
        atoms: adapted.atoms,
        evidenceType: adapted.evidenceType,
        trimmedFrom: adapted.trimmedFrom,
        issues: adapted.issues,
        baselineScorePct,
        productionRows: v2Rows.length,
      }
      : null,
    diagnostics: {
      branchCount: branches.length,
      trimmedBranchCount: lines.length,
      prefilterRanked: ranked.length,
      maiaLines: maiaLines.length,
      rankedPlan: rankedPlan.length,
      adaptedAtoms: adapted.atoms.length,
      adaptedIssues: adapted.issues,
    },
    modelEvidence: {
      manifestPath: protocol.baselineEvidence?.maiaManifest?.relativePath,
      manifestSha256: protocol.baselineEvidence?.maiaManifest?.sha256,
      modelArtifact: maiaManifest?.artifacts?.fp32?.file || null,
      medianOpponentRating: maiaRating,
      rows: maiaEvidenceRows.sort((a, b) => a.fen.localeCompare(b.fen)),
    },
    engineEvidence: {
      depth: sfDepth,
      leafFens: leafFens.sort(),
      receipts: sfReceipts,
      prefilterFunnel: ranked.length,
    },
  };
}

function collectPostTriggerEpds(packagesByArm) {
  const epds = new Set();
  for (const arm of ["candidate", "baseline"]) {
    for (const color of SHADOW_PREP_COLORS) {
      for (const atom of packagesByArm?.[arm]?.[color]?.atoms || []) {
        if (atom?.postTriggerUserToMoveEpd) epds.add(atom.postTriggerUserToMoveEpd);
      }
    }
  }
  return [...epds].sort();
}

export async function buildSharedYReceipts(atomsByEpd, sf, protocol, engineIdentity) {
  const receipts = [];
  const byEpd = new Map();
  for (const epd of [...atomsByEpd.keys()].sort()) {
    const atom = atomsByEpd.get(epd);
    const receipt = await buildSharedYReceiptForAtom(atom, sf, protocol, engineIdentity);
    receipts.push(receipt);
    byEpd.set(epd, receipt);
  }
  return { receipts: receipts.sort((a, b) => a.postTriggerEpd.localeCompare(b.postTriggerEpd)), byEpd };
}

function stripSharedYReceiptsForStorage(packagesByColor) {
  return Object.fromEntries(SHADOW_PREP_COLORS.map((color) => {
    const pkg = packagesByColor?.[color];
    if (!pkg) return [color, null];
    return [color, {
      ...pkg,
      atoms: (pkg.atoms || []).map((atom) => {
        const { sharedYReceipt, ...rest } = atom;
        return rest;
      }),
    }];
  }));
}

export function packagesWithSharedY(packages, yReceiptsByColor, { protocol } = {}) {
  const attached = {};
  const issues = [];
  for (const arm of ["candidate", "baseline"]) {
    const armPackages = Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [color, packages?.[arm]?.[color] || null]),
    );
    const result = attachSharedYToPackages(armPackages, yReceiptsByColor, { protocol });
    attached[arm] = result.packages;
    issues.push(...(result.issues || []).map((issue) => ({ ...issue, arm })));
    for (const color of SHADOW_PREP_COLORS) {
      const count = result.packages?.[color]?.atoms?.length || 0;
      const target = Number(protocol?.treatmentBudget?.atomsPerColorPerArm ?? 6);
      if (count !== target) {
        issues.push({ arm, color, kind: "atom-count-after-y", count, target });
      }
    }
  }
  return { packages: attached, issues, ok: issues.length === 0 };
}

function buildMaterialsManifest(attachedPackages, protocol) {
  const materials = { candidate: {}, baseline: {} };
  const checks = {};
  for (const color of SHADOW_PREP_COLORS) {
    const candUnits = buildCanonicalStudyMaterials(attachedPackages.candidate[color] || { atoms: [] });
    const baseUnits = buildCanonicalStudyMaterials(attachedPackages.baseline[color] || { atoms: [] });
    materials.candidate[color] = candUnits;
    materials.baseline[color] = baseUnits;
    checks[color] = compareMaterialBudget(candUnits, baseUnits, protocol);
  }
  return { materials, checks };
}

function resolveStockfishPath(args, protocol) {
  const configured = args.sfPath || resolveRepoPath(protocol.sharedYEngine?.relativePath || "");
  if (!existsSync(configured)) {
    throw new Error(`missing Stockfish binary at ${configured}`);
  }
  const expected = String(protocol.sharedYEngine?.stockfishSha256 || "").toLowerCase();
  const actual = sha256Buffer(readFileSync(configured));
  if (expected && actual !== expected) {
    throw new Error(`stockfish sha mismatch: expected ${expected}, got ${actual}`);
  }
  return configured;
}

async function releaseMaiaSession(session) {
  if (!session) return;
  if (typeof session.release === "function") await session.release();
  else if (typeof session.dispose === "function") session.dispose();
}

export async function commandBuild(args) {
  const paths = studyPaths(args.studyRoot);
  const state = loadState(paths);
  if (!state) throw new Error("SHADOW-PREP study not initialized — run init first");
  const { protocol } = assertShadowPrepProtocolSnapshot(paths, args.protocolPath);
  if (refusesShadowPrepRebuild(state.state)) {
    throw new Error(`refusing rebuild while SHADOW-PREP study is ${state.state}`);
  }

  const sourceManifest = readJson(paths.sourceManifest);
  if (!sourceManifest?.verification?.ok) {
    throw new Error("source manifest not verified — run init first");
  }

  if (state.state === SHADOW_PREP_STATES.INITIALIZED) {
    assertShadowPrepStateTransition(state.state, SHADOW_PREP_STATES.BUILDING);
    state.state = SHADOW_PREP_STATES.BUILDING;
    saveState(paths, state);
    appendEvent(args.studyRoot, { type: "build-start", state: state.state });
  } else if (state.state !== SHADOW_PREP_STATES.BUILDING) {
    throw new Error(`build requires initialized/building state, got ${state.state}`);
  } else {
    appendEvent(args.studyRoot, { type: "build-resume", state: state.state });
  }

  const d0Path = resolveRepoPath(protocol.buildPartition.refDfCorpusGames.relativePath);
  const d0Raw = readPinnedFile(protocol.buildPartition.refDfCorpusGames.relativePath);
  if (d0Raw.sha256 !== String(protocol.buildPartition.refDfCorpusGames.sha256).toLowerCase()) {
    throw new Error("D0 corpus sha mismatch at build time");
  }
  const games = loadNdjsonGames(d0Path);
  const d0Identity = buildD0CorpusIdentity(games);

  const candidateDiagnostics = {};
  let candidatePackages = {};
  try {
    candidatePackages = buildCandidatePackagesByColor(games, { protocol });
    for (const color of SHADOW_PREP_COLORS) {
      if (!candidatePackages[color]) {
        candidateDiagnostics[color] = {
          kind: "no-package",
          color,
        };
      }
    }
  } catch (error) {
    candidatePackages = {};
    for (const color of SHADOW_PREP_COLORS) {
      const result = safeSelectCandidatePackage(games, color, protocol);
      candidatePackages[color] = result.package;
      if (result.diagnostic) candidateDiagnostics[color] = result.diagnostic;
    }
    candidateDiagnostics.global = {
      kind: "candidate-build-overflow",
      message: error?.message || String(error),
    };
  }

  const sfPath = resolveStockfishPath(args, protocol);
  const sfThreads = Number(protocol.sharedYEngine?.threads ?? 4);
  const sfHashMb = Number(protocol.sharedYEngine?.hashMb ?? 256);
  const engineIdentity = buildPinnedSharedEngineIdentity(protocol);
  const maiaManifest = JSON.parse(readFileSync(join(MAIA_DIR, "maia3.manifest.json"), "utf8"));
  if (sha256Buffer(readFileSync(join(MAIA_DIR, "maia3.manifest.json"))) !== String(protocol.baselineEvidence.maiaManifest.sha256).toLowerCase()) {
    throw new Error("maia manifest sha mismatch at build time");
  }

  configureOrtWasm(new URL("./", import.meta.resolve("onnxruntime-web")).href);

  let sf = null;
  let maiaSession = null;
  const baselinePackages = {};
  const baselineDiagnostics = {};
  const modelEvidence = { colors: {} };
  const engineEvidence = { colors: {} };

  try {
    sf = new StockfishPool(sfPath, { threads: sfThreads, hash: sfHashMb });
    maiaSession = await createMaiaSession(MAIA_DIR, maiaManifest, { fp16: false });

    for (const color of SHADOW_PREP_COLORS) {
      const built = await buildBaselinePackageForColor({
        games,
        color,
        protocol,
        sf,
        maiaSession,
        maiaManifest,
        sfDepth: Number(protocol.sharedYEngine?.depth ?? 8),
        sfThreads,
        sfHashMb,
      });
      baselinePackages[color] = built.package;
      baselineDiagnostics[color] = built.diagnostics;
      modelEvidence.colors[color] = built.modelEvidence;
      engineEvidence.colors[color] = built.engineEvidence;
    }

    const atomsByEpd = new Map();
    for (const arm of [
      { name: "candidate", packages: candidatePackages },
      { name: "baseline", packages: baselinePackages },
    ]) {
      for (const color of SHADOW_PREP_COLORS) {
        for (const atom of arm.packages?.[color]?.atoms || []) {
          const epd = atom.postTriggerUserToMoveEpd;
          const prior = atomsByEpd.get(epd);
          if (!prior) atomsByEpd.set(epd, atom);
          else if (prior.postTriggerFen !== atom.postTriggerFen) {
            throw new Error(`conflicting post-trigger fen for ${epd}`);
          }
        }
      }
    }

    const { receipts: sharedReceipts } = await buildSharedYReceipts(atomsByEpd, sf, protocol, engineIdentity);
    const yReceiptsByColor = Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [color, sharedReceipts]),
    );

    const attached = packagesWithSharedY(
      { candidate: candidatePackages, baseline: baselinePackages },
      yReceiptsByColor,
      { protocol },
    );

    const { materials, checks } = buildMaterialsManifest(attached.packages, protocol);

    ensureDir(paths.materialsDir);
    ensureDir(paths.yDir);
    ensureDir(paths.cacheDir);

    const packagePayload = {
      candidate: stripSharedYReceiptsForStorage(attached.packages.candidate),
      baseline: stripSharedYReceiptsForStorage(attached.packages.baseline),
    };

    writeJson(paths.candidatePackages, packagePayload.candidate);
    writeJson(paths.baselinePackages, packagePayload.baseline);
    for (const color of SHADOW_PREP_COLORS) {
      writeJson(resolve(paths.materialsDir, `candidate-${color}.json`), materials.candidate[color]);
      writeJson(resolve(paths.materialsDir, `baseline-${color}.json`), materials.baseline[color]);
    }
    writeJson(paths.materialChecks, checks);
    writeJson(paths.yReceipts, sharedReceipts);
    writeJson(paths.buildIdentity, d0Identity);
    writeJson(paths.maiaEvidence, modelEvidence);
    writeJson(paths.engineEvidence, engineEvidence);
    writeJson(paths.modelEvidence, {
      kind: "scout-shadow-prep-p0-model-evidence",
      version: 1,
      maiaManifestSha256: protocol.baselineEvidence.maiaManifest.sha256,
      colors: modelEvidence.colors,
    });
    writeJson(paths.stockfishEvalCache, engineEvidence);

    const artifactHashes = computeShadowPrepBuildArtifactHashes({
      candidatePackages: packagePayload.candidate,
      baselinePackages: packagePayload.baseline,
      sharedYReceipts: sharedReceipts,
      materialChecks: checks,
      materials,
    });
    const buildManifest = {
      kind: "scout-shadow-prep-p0-build-manifest",
      version: 1,
      protocolSha256: state.protocolSha256,
      buildUsedStimulus: false,
      d0CorpusIdentity: d0Identity,
      candidateDiagnostics,
      baselineDiagnostics,
      sharedY: {
        uniqueEpds: collectPostTriggerEpds({ candidate: candidatePackages, baseline: baselinePackages }),
        receiptCount: sharedReceipts.length,
        engineIdentityKey: engineIdentityKey(engineIdentity),
      },
      artifactHashes,
      packageHashes: {
        candidate: artifactHashes.candidatePackages,
        baseline: artifactHashes.baselinePackages,
      },
      materialChecks: checks,
      materialChecksSha256: artifactHashes.materialChecks,
      materialFileHashes: artifactHashes.materials,
      ySha256: artifactHashes.sharedYReceipts,
      attachmentOk: attached.ok,
      attachmentIssues: attached.issues,
      frozenAt: FROZEN_AT,
    };
    writeJson(paths.buildManifest, buildManifest);
    writeJson(paths.yManifest, {
      kind: "scout-shadow-prep-p0-y-manifest",
      version: 1,
      receiptCount: sharedReceipts.length,
      sha256: buildManifest.ySha256,
      engineIdentityKey: buildManifest.sharedY.engineIdentityKey,
    });

    const postBuild = resolveShadowPrepPostBuildState({ currentState: state.state });
    if (postBuild.state !== state.state) {
      assertShadowPrepStateTransition(state.state, postBuild.state);
      state.state = postBuild.state;
      state.builtAt = new Date().toISOString();
      state.buildUsedStimulus = false;
      state.d0CorpusIdentitySha256 = d0Identity.contentSha256;
      saveState(paths, state);
    }
    if (postBuild.eventType) {
      appendEvent(args.studyRoot, {
        type: postBuild.eventType,
        state: state.state,
        attachmentOk: attached.ok,
        buildManifestSha256: sha256Hex(buildManifest),
      });
    }

    return {
      ok: true,
      scientificBuildComplete: true,
      attachmentOk: attached.ok,
      command: "build",
      state: state.state,
      buildManifest,
      attachmentIssues: attached.issues,
      candidateDiagnostics,
      baselineDiagnostics,
    };
  } finally {
    if (sf) sf.quit();
    await releaseMaiaSession(maiaSession);
  }
}

function loadBuildArtifacts(paths) {
  const protocol = readJson(paths.protocolSnapshot)?.protocol;
  const candidatePackages = readJson(paths.candidatePackages);
  const baselinePackages = readJson(paths.baselinePackages);
  const sharedYReceipts = readJson(paths.yReceipts, []);
  const materialChecks = readJson(paths.materialChecks, {});
  const materials = {
    candidate: Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [
        color,
        readJson(resolve(paths.materialsDir, `candidate-${color}.json`), []),
      ]),
    ),
    baseline: Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [
        color,
        readJson(resolve(paths.materialsDir, `baseline-${color}.json`), []),
      ]),
    ),
  };
  return {
    protocol,
    candidatePackages,
    baselinePackages,
    sharedYReceipts,
    materialChecks,
    materials,
  };
}

function assertVerifiedBuildArtifacts(paths, buildManifest) {
  const artifacts = loadBuildArtifacts(paths);
  const missing = [];
  if (!artifacts.candidatePackages) missing.push("candidatePackages");
  if (!artifacts.baselinePackages) missing.push("baselinePackages");
  if (!artifacts.sharedYReceipts?.length) missing.push("sharedYReceipts");
  if (!artifacts.materialChecks || !Object.keys(artifacts.materialChecks).length) {
    missing.push("materialChecks");
  }
  for (const color of SHADOW_PREP_COLORS) {
    if (!artifacts.materials.candidate[color]) missing.push(`materials.candidate-${color}`);
    if (!artifacts.materials.baseline[color]) missing.push(`materials.baseline-${color}`);
  }
  if (missing.length) {
    throw new Error(`build artifact integrity failure: missing ${missing.join(", ")}`);
  }
  const verification = verifyShadowPrepBuildArtifacts(buildManifest, artifacts);
  if (!verification.ok) {
    const summary = verification.issues
      .map((issue) => issue.kind + (issue.artifact ? `:${issue.artifact}` : ""))
      .join("; ");
    throw new Error(`build artifact integrity failure: ${summary}`);
  }
  return artifacts;
}

export function sharedYAttachmentIntegrityIssues(issues = []) {
  return issues.filter((issue) => issue.kind !== "atom-count-after-y");
}

function loadFrozenPackages(paths, { protocol = null } = {}) {
  const artifacts = loadBuildArtifacts(paths);
  const snapshotProtocol = protocol || artifacts.protocol;
  const yReceiptsByColor = Object.fromEntries(
    SHADOW_PREP_COLORS.map((color) => [color, artifacts.sharedYReceipts]),
  );
  const attached = packagesWithSharedY(
    { candidate: artifacts.candidatePackages, baseline: artifacts.baselinePackages },
    yReceiptsByColor,
    { protocol: snapshotProtocol },
  );
  const attachmentIntegrityIssues = sharedYAttachmentIntegrityIssues(attached.issues || []);
  return {
    candidate: artifacts.candidatePackages,
    baseline: artifacts.baselinePackages,
    attached: attached.packages,
    yReceipts: artifacts.sharedYReceipts,
    materialChecks: artifacts.materialChecks,
    materials: artifacts.materials,
    engineIdentity: buildPinnedSharedEngineIdentity(snapshotProtocol),
    attachmentOk: attached.ok,
    attachmentIssues: attached.issues || [],
    attachmentIntegrityOk: attachmentIntegrityIssues.length === 0,
    attachmentIntegrityIssues,
  };
}

function loadStimulusBlocks(protocol) {
  const frozen = protocol.frozenArtifacts || {};
  const order = protocol.pilotStimulusPartition?.chronology || ["h-m1", "h-r1", "legacy"];
  const specs = [
    ["h-m1", frozen.hM1Games],
    ["h-r1", frozen.hR1Games],
    ["legacy", frozen.legacyGames],
  ];
  const blocks = [];
  for (const [sourceBlock, pin] of specs) {
    const file = readPinnedFile(pin.relativePath);
    if (file.sha256 !== String(pin.sha256).toLowerCase()) {
      throw new Error(`${sourceBlock} stimulus sha mismatch`);
    }
    const games = sourceBlock === "legacy"
      ? JSON.parse(file.text)
      : loadJsonArray(file.absolutePath);
    blocks.push({ sourceBlock, games, sha256: file.sha256, gameCount: games.length });
  }
  blocks.sort((a, b) => order.indexOf(a.sourceBlock) - order.indexOf(b.sourceBlock));
  return blocks;
}

export function commandCensus(args) {
  const paths = studyPaths(args.studyRoot);
  const state = loadState(paths);
  if (!state) throw new Error("SHADOW-PREP study not initialized — run init first");
  const { protocol } = assertShadowPrepProtocolSnapshot(paths, args.protocolPath);
  if (refusesShadowPrepReplay(state.state)) {
    throw new Error(`refusing census replay while SHADOW-PREP study is ${state.state}`);
  }
  if (existsSync(paths.censusReport)) {
    throw new Error(`census report already exists at ${paths.censusReport}; replay forbidden`);
  }
  if (state.state !== SHADOW_PREP_STATES.BUILT) {
    throw new Error(`census requires built state, got ${state.state}`);
  }

  const buildManifest = readJson(paths.buildManifest);
  if (!buildManifest || buildManifest.buildUsedStimulus) {
    throw new Error("build manifest missing or indicates stimulus contamination");
  }

  const verifiedArtifacts = assertVerifiedBuildArtifacts(paths, buildManifest);
  const frozen = loadFrozenPackages(paths, { protocol });
  if (!frozen.attachmentIntegrityOk) {
    throw new Error(
      `build artifact integrity failure: shared Y attachment invalid (${frozen.attachmentIntegrityIssues.length} issue(s))`,
    );
  }
  const blocks = loadStimulusBlocks(protocol);
  const stimulus = buildPilotStimulusStream(
    { candidate: frozen.attached.candidate, baseline: frozen.attached.baseline },
    blocks,
    { protocol },
  );
  const influence = evaluateInfluenceGates(frozen.attached.candidate, protocol);
  const stimulusInfluence = evaluateStimulusInfluence(stimulus, protocol);
  const materialChecks = recomputeMaterialChecks(
    { candidate: frozen.attached.candidate, baseline: frozen.attached.baseline },
    protocol,
  );
  const storedMaterialChecks = verifiedArtifacts.materialChecks;
  const manifestMaterialChecks = buildManifest.materialChecks || null;
  const drift = Object.fromEntries(
    SHADOW_PREP_COLORS
      .map((color) => {
        const stored = storedMaterialChecks?.[color];
        const recomputed = materialChecks?.[color];
        const manifest = manifestMaterialChecks?.[color];
        const storedMatches = stored?.ok === recomputed?.ok
          && JSON.stringify(stored?.errors || []) === JSON.stringify(recomputed?.errors || []);
        const manifestMatches = !manifest || (
          manifest?.ok === recomputed?.ok
          && JSON.stringify(manifest?.errors || []) === JSON.stringify(recomputed?.errors || [])
        );
        return storedMatches && manifestMatches
          ? null
          : [color, { stored, manifest, recomputed }];
      })
      .filter(Boolean),
  );
  if (Object.keys(drift).length) {
    throw new Error(`build artifact integrity failure: material checks drift (${Object.keys(drift).join(", ")})`);
  }

  const report = buildShadowPrepReport({
    protocol: { ...protocol, protocolSha256: state.protocolSha256 },
    candidatePackages: frozen.attached.candidate,
    baselinePackages: frozen.attached.baseline,
    materialChecks,
    stimulus,
    influence,
    stimulusInfluence,
    frozenAt: FROZEN_AT,
  });

  writeJson(paths.stimulusStream, stimulus);
  writeJson(paths.stimulusManifest, {
    kind: "scout-shadow-prep-p0-stimulus-manifest",
    version: 1,
    sourceOrder: blocks.map((block) => block.sourceBlock),
    sourceSha256: Object.fromEntries(blocks.map((block) => [block.sourceBlock, block.sha256])),
    eventCount: stimulus.events.length,
    streamSha256: sha256Hex(stimulus),
  });
  writeJson(paths.censusReport, report);

  const postCensus = resolveShadowPrepPostCensusState({ currentState: state.state });
  if (postCensus.state !== state.state) {
    assertShadowPrepStateTransition(state.state, postCensus.state);
    state.state = postCensus.state;
    state.censusAt = new Date().toISOString();
    state.censusVerdict = report.verdict;
    saveState(paths, state);
  }
  if (postCensus.eventType) {
    appendEvent(args.studyRoot, {
      type: "census",
      verdict: report.verdict,
      reportSha256: sha256Hex(report),
      stimulusSha256: sha256Hex(stimulus),
    });
  }

  return {
    ok: true,
    command: "census",
    verdict: report.verdict,
    reportPath: paths.censusReport,
    report,
  };
}

function hashFileJson(path) {
  if (!existsSync(path)) return null;
  return sha256Hex(readJson(path));
}

export function commandVerify(args) {
  const paths = studyPaths(args.studyRoot);
  const state = loadState(paths);
  if (!state) throw new Error("SHADOW-PREP study not initialized — run init first");
  const { snapshot, protocol, currentSha } = assertShadowPrepProtocolSnapshot(paths, args.protocolPath);
  const events = loadEvents(args.studyRoot);
  const censusReport = readJson(paths.censusReport);
  const buildManifest = readJson(paths.buildManifest);
  const sourceManifest = readJson(paths.sourceManifest);
  const issues = [];

  const artifactVerify = verifyShadowPrepArtifacts({
    state: state.state,
    protocol: { ...protocol, protocolSha256: currentSha },
    snapshotProtocolSha256: snapshot.protocolSha256,
    censusReport,
    events,
    buildUsedStimulus: Boolean(buildManifest?.buildUsedStimulus || state.buildUsedStimulus),
  });
  if (!artifactVerify.ok) issues.push(...artifactVerify.issues);

  const descriptors = buildPinnedSourceDescriptors(protocol);
  const sourceCheck = verifyInitPinnedSources(protocol, descriptors);
  if (!sourceCheck.ok) issues.push(...sourceCheck.issues.map((issue) => ({ ...issue, phase: "source" })));

  if (sourceManifest) {
    for (const [name, entry] of Object.entries(sourceManifest.entries || {})) {
      const row = descriptors[name];
      if (!row || row.sha256 !== entry.sha256) {
        issues.push({ kind: "source-manifest-drift", source: name });
      }
    }
  }

  if (buildManifest) {
    const artifacts = loadBuildArtifacts(paths);
    const buildArtifactVerify = verifyShadowPrepBuildArtifacts(buildManifest, artifacts);
    if (!buildArtifactVerify.ok) issues.push(...buildArtifactVerify.issues.map((issue) => ({ ...issue, phase: "build" })));
    const d0Identity = readJson(paths.buildIdentity);
    if (buildManifest.buildUsedStimulus) issues.push({ kind: "build-stimulus-contamination" });
    if (d0Identity?.contentSha256 !== buildManifest.d0CorpusIdentity?.contentSha256) {
      issues.push({ kind: "d0-identity-mismatch" });
    }
    if (state.d0CorpusIdentitySha256 && state.d0CorpusIdentitySha256 !== d0Identity?.contentSha256) {
      issues.push({ kind: "state-d0-identity-mismatch" });
    }
  }

  if (censusReport) {
    const reportValidation = validateShadowPrepReport(censusReport, { protocol: { ...protocol, protocolSha256: currentSha } });
    if (!reportValidation.ok) issues.push({ kind: "invalid-census-report", errors: reportValidation.errors });
    const stimulus = readJson(paths.stimulusStream);
    const stimulusManifest = readJson(paths.stimulusManifest);
    if (!stimulus) issues.push({ kind: "missing-stimulus-stream" });
    if (stimulusManifest && stimulus && stimulusManifest.streamSha256 !== sha256Hex(stimulus)) {
      issues.push({ kind: "stimulus-stream-hash-mismatch" });
    }
  }

  const verify = { ok: issues.length === 0, issues };

  if (verify.ok && state.state === SHADOW_PREP_STATES.CENSUS_COMPLETE) {
    assertShadowPrepStateTransition(state.state, SHADOW_PREP_STATES.VERIFIED);
    state.state = SHADOW_PREP_STATES.VERIFIED;
    state.verifiedAt = new Date().toISOString();
    saveState(paths, state);
    appendEvent(args.studyRoot, { type: "verify", ok: true });
  } else {
    appendEvent(args.studyRoot, { type: "verify", ok: verify.ok, issues: verify.issues });
  }

  return {
    ok: verify.ok,
    command: "verify",
    state: state.state,
    issues: verify.issues,
    hashes: {
      protocolSha256: currentSha,
      sourceManifest: hashFileJson(paths.sourceManifest),
      buildManifest: hashFileJson(paths.buildManifest),
      censusReport: hashFileJson(paths.censusReport),
      stimulusStream: hashFileJson(paths.stimulusStream),
    },
  };
}

export function commandStatus(args) {
  const paths = studyPaths(args.studyRoot);
  const state = loadState(paths);
  if (!state) throw new Error("SHADOW-PREP study not initialized — run init first");
  assertShadowPrepProtocolSnapshot(paths, args.protocolPath);

  const sourceManifest = readJson(paths.sourceManifest);
  const buildManifest = readJson(paths.buildManifest);
  const materialChecks = readJson(paths.materialChecks);
  const candidate = readJson(paths.candidatePackages);
  const baseline = readJson(paths.baselinePackages);
  const censusReport = readJson(paths.censusReport);
  const stimulus = readJson(paths.stimulusStream);

  const packageCounts = {
    candidate: Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [color, candidate?.[color]?.atoms?.length ?? null]),
    ),
    baseline: Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [color, baseline?.[color]?.atoms?.length ?? null]),
    ),
  };

  const status = {
    state: state.state,
    protocolId: state.protocolId,
    protocolSha256: state.protocolSha256,
    sourceVerified: Boolean(sourceManifest?.verification?.ok),
    buildUsedStimulus: Boolean(buildManifest?.buildUsedStimulus ?? state.buildUsedStimulus ?? false),
    packageCounts,
    materialChecks: materialChecks || null,
    stimulus: stimulus
      ? {
        eventCount: stimulus.events?.length ?? 0,
        diagnostics: stimulus.diagnostics || null,
      }
      : null,
    censusVerdict: censusReport?.verdict ?? state.censusVerdict ?? null,
    verifiedAt: state.verifiedAt ?? null,
  };

  return { ok: true, command: "status", status };
}

function printUsage() {
  console.error(`usage:
  node scripts/scout-shadow-prep-p0.mjs init [--root <dir>] [--protocol <path>]
  node scripts/scout-shadow-prep-p0.mjs build [--root <dir>] [--protocol <path>] [--sf <stockfish.exe>]
  node scripts/scout-shadow-prep-p0.mjs census [--root <dir>] [--protocol <path>]
  node scripts/scout-shadow-prep-p0.mjs status [--root <dir>] [--protocol <path>]
  node scripts/scout-shadow-prep-p0.mjs verify [--root <dir>] [--protocol <path>]`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.command) {
    printUsage();
    process.exit(2);
  }
  let result;
  if (args.command === "init") result = commandInit(args);
  else if (args.command === "build") result = await commandBuild(args);
  else if (args.command === "census") result = commandCensus(args);
  else if (args.command === "status") result = commandStatus(args);
  else if (args.command === "verify") result = commandVerify(args);
  else {
    printUsage();
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false) process.exit(1);
}

const isMain = process.argv[1]
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}