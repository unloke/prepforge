// Scout SHADOW-PREP exact solver development harness — burned D0 only.
//
// Usage:
//   node scripts/scout-shadow-prep-exact-solver-dev.mjs verify
//   node scripts/scout-shadow-prep-exact-solver-dev.mjs benchmark [--protocol <path>] [--report-root <dir>]

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHADOW_PREP_COLORS,
  assertNoForbiddenCandidateFields,
  extractEligibleAtomsFromGames,
  projectBuildGame,
  sha256ShadowPrepProtocol,
} from "../web-src/scout-shadow-prep-p0.js";
import {
  EXACT_SOLVER_STATUSES,
  SHADOW_PREP_SOLVER_DEV_REPORT_KIND,
  SHADOW_PREP_SOLVER_DEV_REPORT_VERSION,
  buildSolverDevWitnessHash,
  sha256SolverDevProtocol,
  solveExactCandidatePackage,
  validateSolverDevProtocol,
} from "../web-src/scout-shadow-prep-exact-solver.js";
import { sha256Buffer, sha256Hex } from "../web-src/scout-v15-study.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROTOCOL = resolve(
  REPO_ROOT,
  "research/scout-shadow-prep/ericrosen-shadow-prep-solver-dev.protocol.json",
);
const DEFAULT_REPORT_ROOT = resolve(REPO_ROOT, "tmp/scout-shadow-prep-solver-dev");
const FROZEN_AT = "1970-01-01T00:00:00.000Z";

function parseArgs(argv) {
  const args = {
    command: null,
    protocolPath: DEFAULT_PROTOCOL,
    reportRoot: DEFAULT_REPORT_ROOT,
  };
  const rest = argv.slice(2);
  if (!rest.length) return args;
  args.command = rest[0];
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--protocol") args.protocolPath = resolve(rest[++i]);
    else if (arg === "--report-root") args.reportRoot = resolve(rest[++i]);
  }
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadNdjsonGames(path) {
  const text = readFileSync(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function resolveRepoPath(relativePath) {
  return resolve(REPO_ROOT, relativePath);
}

function loadProtocol(protocolPath) {
  const protocol = readJson(protocolPath);
  const validation = validateSolverDevProtocol(protocol);
  if (!validation.ok) {
    throw new Error(`invalid solver-dev protocol: ${validation.errors.join("; ")}`);
  }
  return { protocol, validation };
}

function verifySealedP0Reference(protocol) {
  const ref = protocol?.sealedP0ProtocolReference;
  const p0Path = resolveRepoPath(ref.relativePath);
  if (!existsSync(p0Path)) {
    throw new Error(`missing sealed P0 protocol: ${ref.relativePath}`);
  }
  const buffer = readFileSync(p0Path);
  const fileSha256 = sha256Buffer(buffer);
  if (fileSha256 !== String(ref.fileSha256).toLowerCase()) {
    throw new Error(`sealed P0 raw file sha mismatch: expected ${ref.fileSha256}, got ${fileSha256}`);
  }
  const p0 = JSON.parse(buffer.toString("utf8"));
  const canonicalSha = sha256ShadowPrepProtocol(p0);
  if (canonicalSha !== ref.protocolSha256) {
    throw new Error(`sealed P0 canonical protocol sha mismatch: expected ${ref.protocolSha256}, got ${canonicalSha}`);
  }
  return { ok: true, protocolId: p0.protocolId, fileSha256, protocolSha256: canonicalSha };
}

function verifyD0Corpus(protocol) {
  const pin = protocol?.d0Corpus;
  const corpusPath = resolveRepoPath(pin.relativePath);
  if (!existsSync(corpusPath)) {
    throw new Error(`missing D0 corpus: ${pin.relativePath}`);
  }
  const buffer = readFileSync(corpusPath);
  const sha256 = sha256Buffer(buffer);
  if (sha256 !== String(pin.sha256).toLowerCase()) {
    throw new Error(`D0 corpus sha mismatch: expected ${pin.sha256}, got ${sha256}`);
  }
  const games = loadNdjsonGames(corpusPath);
  if (games.length !== Number(pin.gameCount)) {
    throw new Error(`D0 corpus count mismatch: expected ${pin.gameCount}, got ${games.length}`);
  }
  return { games, sha256, gameCount: games.length };
}

function buildCanonicalReport({
  protocol,
  inputHashes,
  perColor,
}) {
  return {
    kind: SHADOW_PREP_SOLVER_DEV_REPORT_KIND,
    version: SHADOW_PREP_SOLVER_DEV_REPORT_VERSION,
    purpose: "burned-D0-algorithm-development-only",
    scientificAuthorization: false,
    productAuthorization: false,
    freshHoldoutRequired: true,
    developmentCapProvenance: {
      selectedDuringBurnedD0Implementation: protocol.exactSolverCaps.selectedDuringBurnedD0Implementation,
      notAScientificFeasibilityGate: protocol.exactSolverCaps.notAScientificFeasibilityGate,
      notAConfirmatoryThreshold: protocol.exactSolverCaps.notAConfirmatoryThreshold,
      exploratoryHistory: protocol.exactSolverCaps.exploratoryHistory,
      maxTransitionsPerRootScope: protocol.exactSolverCaps.maxTransitionsPerRootScope,
      finalCaps: {
        maxTransitionsPerRoot: protocol.exactSolverCaps.maxTransitionsPerRoot,
        maxStatesPerStage: protocol.exactSolverCaps.maxStatesPerStage,
        maxSupportPasses: protocol.exactSolverCaps.maxSupportPasses,
        maxRoots: protocol.exactSolverCaps.maxRoots,
      },
    },
    objectiveEquivalenceToSealedP0: protocol.objectiveEquivalenceToSealedP0,
    objectiveDirectionProvenance: protocol.objectiveDirectionProvenance,
    benchmarkConclusionLimit: protocol.claimBoundary.benchmarkConclusionLimit,
    futureWork: {
      freshHoldoutRequired: true,
      mustFreezeSolverVersionAndCapsBeforeHoldoutAccess: protocol.futureP0Policy.mustFreezeSolverVersionAndCapsBeforeHoldoutAccess,
      thisRunAuthorizesNothing: protocol.futureP0Policy.thisDevelopmentRunAuthorizesNothing,
      permittedNextStep: protocol.futureP0Policy.permittedNextStep,
    },
    protocolId: protocol.protocolId,
    protocolSha256: protocol.protocolSha256,
    inputHashes,
    perColor: Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => {
        const row = perColor[color];
        return [color, {
          status: row.status,
          eligibleAtomCount: row.eligibleAtomCount,
          objective: row.objective,
          witnessHash: row.witnessHash,
          resourceCounts: row.resourceCounts,
        }];
      }),
    ),
    createdAt: FROZEN_AT,
    immutableAfterWrite: true,
  };
}

function summarizeResourceCounts(diagnostics) {
  return {
    rootsConsidered: diagnostics?.rootsConsidered ?? 0,
    rootsRelevant: diagnostics?.rootsRelevant ?? 0,
    rootsCompleted: diagnostics?.rootsCompleted ?? 0,
    transitions: diagnostics?.perRoot?.reduce(
      (sum, row) => sum + (row.diagnostics?.transitions ?? 0),
      0,
    ) ?? 0,
    peakStates: diagnostics?.perRoot?.reduce(
      (max, row) => Math.max(max, row.diagnostics?.peakStates ?? 0),
      0,
    ) ?? 0,
    supportPasses: diagnostics?.perRoot?.reduce(
      (sum, row) => sum + (row.diagnostics?.supportPasses ?? 0),
      0,
    ) ?? 0,
    capHits: diagnostics?.perRoot
      ?.filter((row) => row.diagnostics?.capHit)
      .map((row) => ({ rootKey: row.rootKey, capHit: row.diagnostics.capHit })) ?? [],
    bestSoFarNonAuthoritative: diagnostics?.bestSoFarNonAuthoritative ?? null,
  };
}

function commandVerify({ protocolPath }) {
  const { protocol, validation } = loadProtocol(protocolPath);
  const p0 = verifySealedP0Reference(protocol);
  const d0 = verifyD0Corpus(protocol);
  const canonicalSha = sha256SolverDevProtocol(protocol);
  if (canonicalSha !== protocol.protocolSha256) {
    throw new Error("embedded solver-dev protocolSha256 mismatch");
  }
  console.log(JSON.stringify({
    ok: true,
    protocolId: protocol.protocolId,
    protocolSha256: protocol.protocolSha256,
    validation,
    sealedP0: p0,
    d0Corpus: { sha256: d0.sha256, gameCount: d0.gameCount },
  }, null, 2));
  return 0;
}

function commandBenchmark({ protocolPath, reportRoot }) {
  const started = Date.now();
  const { protocol } = loadProtocol(protocolPath);
  verifySealedP0Reference(protocol);
  const { games, sha256: d0Sha256, gameCount } = verifyD0Corpus(protocol);

  const projected = games.map(projectBuildGame);
  assertNoForbiddenCandidateFields(projected, { label: "projected D0 build games" });

  const perColor = {};
  let exitCode = 0;
  for (const color of SHADOW_PREP_COLORS) {
    const eligible = extractEligibleAtomsFromGames(projected, { color, protocol });
    const solved = solveExactCandidatePackage(eligible, protocol);
    perColor[color] = {
      status: solved.status,
      eligibleAtomCount: eligible.length,
      objective: solved.package?.score ?? null,
      witnessHash: buildSolverDevWitnessHash(solved.package),
      resourceCounts: summarizeResourceCounts(solved.diagnostics),
      diagnostics: solved.diagnostics,
    };
    if (solved.status === EXACT_SOLVER_STATUSES.INVALID_INPUT
      || solved.status === EXACT_SOLVER_STATUSES.RESOURCE_EXHAUSTED) {
      exitCode = 1;
    }
  }

  const runtimeMs = Date.now() - started;
  const inputHashes = {
    d0CorpusSha256: d0Sha256,
    d0CorpusGameCount: gameCount,
    sealedP0FileSha256: protocol.sealedP0ProtocolReference.fileSha256,
    sealedP0ProtocolSha256: protocol.sealedP0ProtocolReference.protocolSha256,
  };

  const canonicalReport = buildCanonicalReport({
    protocol,
    inputHashes,
    perColor,
  });
  const reportSha256 = sha256Hex(canonicalReport);

  mkdirSync(reportRoot, { recursive: true });
  writeJson(resolve(reportRoot, "solver-dev-report.json"), canonicalReport);
  writeJson(resolve(reportRoot, "solver-dev-report.meta.json"), {
    reportSha256,
    runtimeMs,
    perColorDiagnostics: Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [color, perColor[color].diagnostics]),
    ),
  });

  const banner = [
    "SOLVER-DEV NON-AUTHORIZATION / NON-EQUIVALENCE BANNER",
    "scientificAuthorization=false productAuthorization=false",
    "objectiveEquivalenceToSealedP0=false (median-only ties: solver-dev minimizes medianDepth; sealed comparePackageLex maximizes)",
    "claimBoundary: exact optimization under solver-dev objective and final development caps only",
  ].join(" | ");
  console.error(banner);
  console.log(JSON.stringify({
    ok: exitCode === 0,
    reportRoot,
    reportSha256,
    runtimeMs,
    nonAuthorizationBanner: banner,
    objectiveEquivalenceToSealedP0: protocol.objectiveEquivalenceToSealedP0,
    perColor: Object.fromEntries(
      SHADOW_PREP_COLORS.map((color) => [color, {
        status: perColor[color].status,
        eligibleAtomCount: perColor[color].eligibleAtomCount,
        witnessHash: perColor[color].witnessHash,
        objective: perColor[color].objective,
      }]),
    ),
  }, null, 2));

  return exitCode;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.command || args.command === "help" || args.command === "--help") {
    console.log("Usage: node scripts/scout-shadow-prep-exact-solver-dev.mjs <verify|benchmark>");
    return 0;
  }
  if (args.command === "verify") return commandVerify(args);
  if (args.command === "benchmark") return commandBenchmark(args);
  throw new Error(`unknown command: ${args.command}`);
}

try {
  const code = main();
  process.exit(code ?? 0);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}