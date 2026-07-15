// Scout robust-Y P1 Phase-0 lifecycle — zero-engine inventory gate.
//
// Usage:
//   node scripts/scout-robust-y-p1.mjs freeze
//   node scripts/scout-robust-y-p1.mjs phase0
//   node scripts/scout-robust-y-p1.mjs verify
//   node scripts/scout-robust-y-p1.mjs status
//
// Study root defaults to tmp/scout-robust-y/robust-y-p1/.
// Final report is written last. Product authorization always false / preserve-v2.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RY_FINAL_REPORT_NAME,
  RY_MANIFEST_KIND,
  RY_PHASE0_STARTED_NAME,
  RY_PROTOCOL_ID,
  RY_STATES,
  RY_SUMMARY_NAME,
  assertFreezeCohortRoot,
  assertRyStateTransition,
  buildRobustYManifest,
  buildRobustYSummary,
  checkRobustYArtifactPresence,
  computeManifestSha256,
  computeRobustYReportSha256,
  computeScientificPayloadSha256,
  manifestBytesForHash,
  describePhase0StuckState,
  discoverCohortPairs,
  listPhase0BurnMarkers,
  orderedPlayerIds,
  refuseIfPhase0Burned,
  runPhase0Inventory,
  shouldRunFullScientificRecompute,
  validateRobustYProtocol,
  verifyRobustYStudy,
} from "../research/scout-robust-y/robust-y-phase0.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DEFAULT_PROTOCOL = resolve(ROOT, "research/scout-robust-y/robust-y-p1.protocol.json");
const DEFAULT_STUDY_ROOT = resolve(ROOT, "tmp/scout-robust-y/robust-y-p1");
const DEFAULT_COHORT_ROOT = resolve(ROOT, "tmp/cohort-unbrainless87");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort replace on Windows
    }
  }
  renameSync(tmp, path);
}

function studyPaths(studyRoot) {
  return {
    root: studyRoot,
    state: join(studyRoot, "state.json"),
    events: join(studyRoot, "events.ndjson"),
    manifest: join(studyRoot, "manifest.json"),
    protocolSnapshot: join(studyRoot, "protocol.snapshot.json"),
    phase0Dir: join(studyRoot, "phase0"),
    phase0Started: join(studyRoot, RY_PHASE0_STARTED_NAME),
    report: join(studyRoot, "phase0", RY_FINAL_REPORT_NAME),
    summary: join(studyRoot, "phase0", RY_SUMMARY_NAME),
    perUnitDir: join(studyRoot, "phase0", "per-unit"),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readState(paths) {
  if (!existsSync(paths.state)) {
    return { state: RY_STATES.UNINITIALIZED, seq: 0 };
  }
  return readJson(paths.state);
}

function appendEvent(paths, event) {
  const state = readState(paths);
  const seq = (state.seq || 0) + 1;
  const line = JSON.stringify({
    seq,
    at: new Date().toISOString(),
    ...event,
  });
  appendFileSync(paths.events, `${line}\n`, "utf8");
  return seq;
}

function writeState(paths, next) {
  writeAtomic(paths.state, `${JSON.stringify(next, null, 2)}\n`);
}

function readEvents(paths) {
  if (!existsSync(paths.events)) return [];
  return readFileSync(paths.events, "utf8")
    .split(/\r?\n/)
    .filter((ln) => ln.trim())
    .map((ln) => JSON.parse(ln));
}

function parseArgs(argv) {
  const args = {
    command: null,
    studyRoot: DEFAULT_STUDY_ROOT,
    protocolPath: DEFAULT_PROTOCOL,
    cohortRoot: DEFAULT_COHORT_ROOT,
    explicitProtocol: false,
  };
  const rest = argv.slice(2);
  args.command = rest[0] || null;
  for (let i = 1; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--study-root") args.studyRoot = resolve(rest[++i]);
    else if (arg === "--protocol") {
      args.protocolPath = resolve(rest[++i]);
      args.explicitProtocol = true;
    }
    else if (arg === "--cohort-root") args.cohortRoot = resolve(rest[++i]);
    else if (arg === "--authorized-bypass") {
      throw new Error("--authorized-bypass is not supported; single-phase0 lock has no bypass");
    }
  }
  return args;
}

function loadProtocol(protocolPath) {
  const bytes = readFileSync(protocolPath);
  const protocol = JSON.parse(bytes.toString("utf8"));
  const protocolSha256 = createHash("sha256").update(bytes).digest("hex");
  return { protocol, protocolSha256, protocolPath, bytes };
}

function loadFrozenProtocolSnapshot(paths) {
  if (!existsSync(paths.protocolSnapshot)) {
    throw new Error("missing protocol.snapshot.json; run freeze first");
  }
  const bytes = readFileSync(paths.protocolSnapshot);
  const protocol = JSON.parse(bytes.toString("utf8"));
  const protocolSha256 = createHash("sha256").update(bytes).digest("hex");
  return { protocol, protocolSha256, bytes };
}

function rel(path) {
  return relative(ROOT, path).split("\\").join("/");
}

function scanCohortPlayers(cohortRoot) {
  const names = readdirSync(cohortRoot);
  return discoverCohortPairs(names.map((name) => ({ name })));
}

function loadFrozenManifest(paths) {
  if (!existsSync(paths.manifest)) throw new Error("missing manifest.json; run freeze first");
  const manifest = readJson(paths.manifest);
  if (manifest.immutable !== true) throw new Error("manifest is not immutable");
  return manifest;
}

function verifyManifestAgainstDisk(manifest, protocol) {
  const issues = [];
  const expectedPlayerCount = protocol?.inputs?.expectedPlayerCount ?? 17;
  const players = manifest.players || [];
  if (players.length !== expectedPlayerCount) {
    issues.push(`player count ${players.length} !== expected ${expectedPlayerCount}`);
  }
  for (const row of players) {
    const gamesPath = resolve(ROOT, row.gamesPath);
    const dumpPath = resolve(ROOT, row.dumpPath);
    if (!existsSync(gamesPath)) issues.push(`missing games file ${row.gamesPath}`);
    if (!existsSync(dumpPath)) issues.push(`missing dump file ${row.dumpPath}`);
    if (existsSync(gamesPath) && sha256File(gamesPath) !== row.gamesSha256) {
      issues.push(`games hash drift for ${row.playerId}`);
    }
    if (existsSync(dumpPath) && sha256File(dumpPath) !== row.dumpSha256) {
      issues.push(`dump hash drift for ${row.playerId}`);
    }
    if (existsSync(gamesPath)) {
      try {
        const games = JSON.parse(readFileSync(gamesPath, "utf8"));
        const liveCount = Array.isArray(games) ? games.length : null;
        if (liveCount != null && Number(row.gameCount) !== liveCount) {
          issues.push(`gameCount drift for ${row.playerId}: manifest ${row.gameCount} vs live ${liveCount}`);
        }
      } catch (err) {
        issues.push(`games parse failed for ${row.playerId}: ${err.message}`);
      }
    }
  }
  if (issues.length) throw new Error(`manifest integrity failure: ${issues.join("; ")}`);
}

function loadPlayerGames(manifest) {
  const payloads = [];
  for (const row of manifest.players || []) {
    const gamesPath = resolve(ROOT, row.gamesPath);
    const games = JSON.parse(readFileSync(gamesPath, "utf8"));
    if (!Array.isArray(games)) throw new Error(`games must be array for ${row.playerId}`);
    payloads.push({ playerId: row.playerId, games });
  }
  return payloads;
}

function runPhase0Preflight(paths, state, manifest) {
  const { protocol, protocolSha256 } = loadFrozenProtocolSnapshot(paths);
  if (state.protocolSha256 && state.protocolSha256 !== protocolSha256) {
    throw new Error("protocol sha256 drift vs frozen state");
  }
  if (manifest.protocolSha256 !== protocolSha256) {
    throw new Error("protocol sha256 drift vs manifest");
  }
  verifyManifestAgainstDisk(manifest, protocol);
  const playerGames = loadPlayerGames(manifest);
  return { protocol, protocolSha256, manifest, playerGames };
}

async function cmdFreeze(args) {
  const paths = studyPaths(args.studyRoot);
  const { protocol, protocolSha256, protocolPath, bytes } = loadProtocol(args.protocolPath);
  const validation = validateRobustYProtocol(protocol);
  if (!validation.ok) {
    throw new Error(`invalid protocol: ${validation.errors.join("; ")}`);
  }

  const cohortCheck = assertFreezeCohortRoot({
    protocol,
    cohortRootAbs: args.cohortRoot,
    rootDir: ROOT,
  });
  if (!cohortCheck.ok) {
    throw new Error(`freeze refused: ${cohortCheck.errors.join("; ")}`);
  }

  const state = readState(paths);
  if (state.state !== RY_STATES.UNINITIALIZED) {
    throw new Error(`freeze refused: state is ${state.state}`);
  }

  const pairs = scanCohortPlayers(args.cohortRoot);
  const expectedPlayerCount = protocol?.inputs?.expectedPlayerCount ?? 17;
  if (pairs.length !== expectedPlayerCount) {
    throw new Error(
      `freeze refused: cohort player count ${pairs.length} !== expected ${expectedPlayerCount}`,
    );
  }

  const players = [];
  for (const pair of pairs) {
    const gamesPath = join(args.cohortRoot, `${pair.playerId}.json`);
    const dumpPath = join(args.cohortRoot, `${pair.playerId}-bias.ndjson`);
    const games = JSON.parse(readFileSync(gamesPath, "utf8"));
    players.push({
      playerId: pair.playerId,
      gamesPath: rel(gamesPath),
      gamesSha256: sha256File(gamesPath),
      dumpPath: rel(dumpPath),
      dumpSha256: sha256File(dumpPath),
      gameCount: Array.isArray(games) ? games.length : 0,
    });
  }

  const manifest = buildRobustYManifest({
    protocolId: RY_PROTOCOL_ID,
    protocolSha256,
    players: players.sort((a, b) => a.playerId.localeCompare(b.playerId)),
    protocol,
    cohortRoot: cohortCheck.cohortRoot,
    enforcePlayerCount: true,
  });

  const manifestBytes = manifestBytesForHash(manifest);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

  writeAtomic(paths.protocolSnapshot, bytes);
  writeAtomic(paths.manifest, manifestBytes);

  const seq = appendEvent(paths, {
    type: "freeze",
    protocolSha256,
    manifestSha256,
    protocolPath: rel(protocolPath),
    playerCount: manifest.playerCount,
    playersSha256: manifest.playersSha256,
  });

  assertRyStateTransition(state.state, RY_STATES.FROZEN);
  writeState(paths, {
    state: RY_STATES.FROZEN,
    seq,
    protocolSha256,
    manifestSha256,
    protocolPath: rel(protocolPath),
    cohortRoot: cohortCheck.cohortRoot,
    frozenAt: new Date().toISOString(),
    playerIds: orderedPlayerIds(players.map((p) => p.playerId)),
    playersSha256: manifest.playersSha256,
  });

  console.log(JSON.stringify({
    command: "freeze",
    studyRoot: args.studyRoot,
    playerCount: manifest.playerCount,
    playersSha256: manifest.playersSha256,
    protocolSha256,
    manifestSha256,
    state: RY_STATES.FROZEN,
  }, null, 2));
}

async function cmdPhase0(args) {
  const paths = studyPaths(args.studyRoot);
  const state = readState(paths);
  const events = readEvents(paths);
  if (state.state !== RY_STATES.FROZEN) {
    throw new Error(`phase0 refused: state is ${state.state}, expected frozen`);
  }
  refuseIfPhase0Burned(args.studyRoot, { exists: existsSync, state, events });

  const manifest = loadFrozenManifest(paths);
  const preflight = runPhase0Preflight(paths, state, manifest);
  const { protocol, protocolSha256, playerGames } = preflight;

  const rawManifestBytes = readFileSync(paths.manifest);
  const rawManifestSha256 = createHash("sha256").update(rawManifestBytes).digest("hex");
  const eventsBeforeStart = readEvents(paths);
  const freezeEvent = eventsBeforeStart.find((e) => e.type === "freeze");
  if (state.manifestSha256 && rawManifestSha256 !== state.manifestSha256) {
    throw new Error("manifest sha256 drift vs frozen state before phase0 burn marker");
  }
  if (freezeEvent?.manifestSha256 && rawManifestSha256 !== freezeEvent.manifestSha256) {
    throw new Error("manifest sha256 drift vs freeze event before phase0 burn marker");
  }
  if (rawManifestSha256 !== computeManifestSha256(manifest)) {
    throw new Error("on-disk manifest bytes do not match pretty-print manifestSha256 convention");
  }

  writeAtomic(paths.phase0Started, `${JSON.stringify({
    startedAt: new Date().toISOString(),
    protocolSha256,
    manifestSha256: rawManifestSha256,
    stateSeq: state.seq || 0,
  }, null, 2)}\n`);

  const report = runPhase0Inventory({
    protocol,
    protocolSha256,
    manifest,
    manifestSha256: rawManifestSha256,
    playerGames,
  });

  mkdirSync(paths.perUnitDir, { recursive: true });
  for (const unit of report.units || []) {
    const out = join(paths.perUnitDir, `${unit.playerId}-${unit.subjectColor}-${unit.cutoff}.json`);
    writeAtomic(out, `${JSON.stringify(unit, null, 2)}\n`);
  }

  writeAtomic(paths.summary, buildRobustYSummary(report));

  const seq = appendEvent(paths, {
    type: "phase0",
    verdict: report.verdict,
    reportSha256: report.reportSha256,
    manifestSha256: rawManifestSha256,
    scientificPayloadSha256: computeScientificPayloadSha256(report),
    productAuthorization: false,
  });

  assertRyStateTransition(state.state, RY_STATES.PHASE0_COMPLETE);
  writeState(paths, {
    ...state,
    state: RY_STATES.PHASE0_COMPLETE,
    seq,
    phase0At: new Date().toISOString(),
    verdict: report.verdict,
    reportSha256: report.reportSha256,
    manifestSha256: rawManifestSha256,
    scientificPayloadSha256: computeScientificPayloadSha256(report),
  });

  writeAtomic(paths.report, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    command: "phase0",
    verdict: report.verdict,
    productAuthorization: false,
    productVerdict: report.productVerdict,
    usableUnits: report.panel?.usableUnitCount,
    repeatSupportedUnits: report.panel?.repeatSupportedUnitCount,
    unitCount: report.panel?.unitCount,
  }, null, 2));
}

async function cmdVerify(args) {
  const paths = studyPaths(args.studyRoot);
  const state = readState(paths);
  const { protocol, protocolSha256 } = loadFrozenProtocolSnapshot(paths);
  const hasProtocolSnapshot = existsSync(paths.protocolSnapshot);
  const hasManifest = existsSync(paths.manifest);
  const hasReport = existsSync(paths.report);
  const hasSummary = existsSync(paths.summary);
  const snapshotSha = hasProtocolSnapshot ? sha256File(paths.protocolSnapshot) : null;
  const rawManifestSha256 = hasManifest
    ? createHash("sha256").update(readFileSync(paths.manifest)).digest("hex")
    : null;
  const manifest = hasManifest ? readJson(paths.manifest) : null;
  const report = hasReport ? readJson(paths.report) : null;
  const events = readEvents(paths);
  const hasPhase0Started = existsSync(paths.phase0Started);
  const phase0StartedRecord = hasPhase0Started ? readJson(paths.phase0Started) : null;

  const unitArtifacts = [];
  if (existsSync(paths.perUnitDir)) {
    for (const name of readdirSync(paths.perUnitDir)) {
      if (!name.endsWith(".json")) continue;
      unitArtifacts.push(readJson(join(paths.perUnitDir, name)));
    }
  }

  const presence = checkRobustYArtifactPresence({
    state: state.state,
    hasProtocolSnapshot,
    hasManifest,
    hasReport,
    hasSummary,
    hasPhase0Started,
    unitArtifacts,
    expectedUnitCount: report?.units?.length ?? null,
  });

  if (!presence.ok) {
    console.log(JSON.stringify({
      command: "verify",
      ok: false,
      state: state.state,
      issues: presence.issues,
    }, null, 2));
    process.exit(1);
  }

  if (manifest) verifyManifestAgainstDisk(manifest, protocol);

  const stuck = describePhase0StuckState(args.studyRoot, { exists: existsSync, state, events });
  if (stuck.stuck) {
    console.log(JSON.stringify({
      command: "verify",
      ok: false,
      state: state.state,
      stuck: true,
      stuckReason: stuck.reason,
      message: stuck.message,
    }, null, 2));
    process.exit(1);
  }

  let fullRecomputeOk = true;
  let fullRecomputeIssues = [];
  let recomputedReport = null;
  if (report && manifest && shouldRunFullScientificRecompute(state.state)) {
    try {
      const playerGames = loadPlayerGames(manifest);
      recomputedReport = runPhase0Inventory({
        protocol,
        protocolSha256,
        manifest,
        manifestSha256: state.manifestSha256 || rawManifestSha256,
        playerGames,
      });
      const expectedScientific = computeScientificPayloadSha256(report);
      const actualScientific = computeScientificPayloadSha256(recomputedReport);
      if (expectedScientific !== actualScientific) {
        fullRecomputeOk = false;
        fullRecomputeIssues.push({
          kind: "scientific-payload-sha-mismatch",
          expected: expectedScientific,
          actual: actualScientific,
        });
      }
    } catch (err) {
      fullRecomputeOk = false;
      fullRecomputeIssues.push({
        kind: "full-recompute-failed",
        message: err?.message || String(err),
      });
    }
  }

  const verification = verifyRobustYStudy({
    state: state.state,
    protocol,
    protocolSha256,
    snapshotProtocolSha256: snapshotSha,
    manifest,
    rawManifestSha256,
    phase0StartedRecord,
    report,
    events,
    unitArtifacts,
    stateRecord: state,
    artifactPresence: presence.issues,
    recomputedReport,
  });

  const ok = verification.ok && fullRecomputeOk;
  const issues = [...verification.issues, ...fullRecomputeIssues];

  let nextState = state;
  if (ok && state.state === RY_STATES.PHASE0_COMPLETE) {
    const seq = appendEvent(paths, { type: "verify", ok: true });
    assertRyStateTransition(state.state, RY_STATES.VERIFIED);
    nextState = {
      ...state,
      state: RY_STATES.VERIFIED,
      seq,
      verifiedAt: new Date().toISOString(),
    };
    writeState(paths, nextState);
  }

  console.log(JSON.stringify({
    command: "verify",
    ok,
    state: nextState.state,
    recomputedVerdict: verification.recomputedVerdict,
    scientificPayloadVerified: fullRecomputeOk,
    issues,
    productAuthorization: false,
    productVerdict: "preserve-v2",
  }, null, 2));

  if (!ok) process.exit(1);
}

async function cmdStatus(args) {
  const paths = studyPaths(args.studyRoot);
  const state = readState(paths);
  const events = readEvents(paths);
  const stuck = describePhase0StuckState(args.studyRoot, { exists: existsSync, state, events });
  console.log(JSON.stringify({
    command: "status",
    studyRoot: args.studyRoot,
    state: state.state,
    seq: state.seq || 0,
    protocolSha256: state.protocolSha256 || null,
    verdict: state.verdict || null,
    reportSha256: state.reportSha256 || null,
    hasManifest: existsSync(paths.manifest),
    hasReport: existsSync(paths.report),
    hasPhase0Started: existsSync(paths.phase0Started),
    burnMarkers: listPhase0BurnMarkers(args.studyRoot, { exists: existsSync, state, events }),
    stuck: stuck.stuck,
    stuckReason: stuck.reason,
    productAuthorization: false,
    productVerdict: "preserve-v2",
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.command) {
    console.error("Usage: node scripts/scout-robust-y-p1.mjs <freeze|phase0|verify|status>");
    process.exit(2);
  }
  if (args.command === "freeze") await cmdFreeze(args);
  else if (args.command === "phase0") await cmdPhase0(args);
  else if (args.command === "verify") await cmdVerify(args);
  else if (args.command === "status") await cmdStatus(args);
  else {
    console.error(`unknown command: ${args.command}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});