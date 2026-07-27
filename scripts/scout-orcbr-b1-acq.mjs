// ORCBR-B1 raw materialization / acquisition CLI.
// Acquisition-only. Does not run ORCBR gates or retune algorithm thresholds.
//
// Usage:
//   node scripts/scout-orcbr-b1-acq.mjs freeze
//   node scripts/scout-orcbr-b1-acq.mjs select
//   node scripts/scout-orcbr-b1-acq.mjs execute --confirm-execute
//   node scripts/scout-orcbr-b1-acq.mjs status
//   node scripts/scout-orcbr-b1-acq.mjs verify
//
// Network is disabled unless --confirm-execute is supplied.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACQ_VERDICTS,
  BURN_ON_EXECUTE,
  BURN_ON_INSPECT,
  assertNoRawIdentityLeakage,
  buildAcquisitionReport,
  buildFreezeSnapshot,
  buildManifest,
  capNdjsonBytes,
  executeAcquisition,
  loadProtocolFromPath,
  selectSubjectPanel,
  sha256Hex,
  stripPanelForReport,
  validateAcquisitionProtocol,
  verifyCustodyArtifacts,
} from "../research/scout-orcbr-b1-acq/orcbr-b1-acq.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DEFAULT_PROTOCOL = resolve(ROOT, "research/scout-orcbr-b1-acq/orcbr-b1-acq.protocol.json");
const DEFAULT_STUDY_ROOT = resolve(ROOT, "tmp/scout-orcbr-b1-acq");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function publicStudyRoot(absPath) {
  const norm = String(absPath || "").replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/");
  if (norm.startsWith(root + "/")) return norm.slice(root.length + 1);
  if (norm === root) return ".";
  const parts = norm.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "study";
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Windows best-effort
    }
  }
  renameSync(tmp, path);
}

function writeJson(path, obj) {
  writeAtomic(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function studyPaths(studyRoot) {
  return {
    root: studyRoot,
    state: join(studyRoot, "state.json"),
    events: join(studyRoot, "events.ndjson"),
    protocolSnapshot: join(studyRoot, "protocol.snapshot.json"),
    subjectPanel: join(studyRoot, "subject-panel.json"),
    custodyDir: join(studyRoot, "custody"),
    subjectsDir: join(studyRoot, "custody", "subjects"),
    manifest: join(studyRoot, "manifest.json"),
    report: join(studyRoot, "report.json"),
  };
}

function readState(paths) {
  if (!existsSync(paths.state)) {
    return { state: "uninitialized", seq: 0, verdict: null };
  }
  return readJson(paths.state);
}

function writeState(paths, next) {
  writeJson(paths.state, next);
}

function appendEvent(paths, event) {
  const state = readState(paths);
  const seq = (state.seq || 0) + 1;
  mkdirSync(paths.root, { recursive: true });
  appendFileSync(
    paths.events,
    `${JSON.stringify({ seq, at: new Date().toISOString(), ...event })}\n`,
    "utf8",
  );
  return seq;
}

function parseArgs(argv) {
  const args = {
    command: null,
    studyRoot: DEFAULT_STUDY_ROOT,
    protocolPath: DEFAULT_PROTOCOL,
    confirmExecute: false,
  };
  const rest = argv.slice(2);
  args.command = rest[0] || null;
  for (let i = 1; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--study-root") args.studyRoot = resolve(rest[++i]);
    else if (a === "--protocol") args.protocolPath = resolve(rest[++i]);
    else if (a === "--confirm-execute") args.confirmExecute = true;
    else if (a === "--help" || a === "-h") args.command = "help";
    else if (a.startsWith("-")) die(`refused: unknown flag ${a}`);
  }
  // Refuse algorithm/CAL/TEST/product contamination flags
  for (const a of argv) {
    if (/^--(cal|test|gates|package|network|fetch|online|product|authorize)(=|$)/i.test(a)
      && a !== "--confirm-execute") {
      die(`refused: ${a} is prohibited on acquisition CLI`);
    }
  }
  return args;
}

function cmdFreeze(args) {
  const paths = studyPaths(args.studyRoot);
  if (!existsSync(args.protocolPath)) die(`protocol not found: ${args.protocolPath}`);
  const { protocol, protocolSha256 } = loadProtocolFromPath(args.protocolPath);
  const locks = validateAcquisitionProtocol(protocol);
  if (!locks.ok) die(`protocol INVALID: ${locks.errors.join("; ")}`);

  if (existsSync(paths.protocolSnapshot)) {
    const snap = readJson(paths.protocolSnapshot);
    if (snap.protocolSha256 && snap.protocolSha256 !== protocolSha256) {
      die("freeze refused: existing snapshot differs (new protocolId required)");
    }
    console.log(JSON.stringify({
      ok: true,
      state: "frozen",
      verdict: ACQ_VERDICTS.ACQ_PROTOCOL_FROZEN,
      protocolSha256,
      studyRoot: publicStudyRoot(paths.root),
      note: "already frozen (identical protocol bytes)",
      acquisitionUntilMs: snap.acquisitionUntilMs,
    }, null, 2));
    return;
  }

  const built = buildFreezeSnapshot(protocol, { protocolSha256 });
  if (!built.ok) die(`freeze INVALID: ${(built.errors || []).join("; ")}`);

  mkdirSync(paths.root, { recursive: true });
  writeJson(paths.protocolSnapshot, built.snapshot);
  writeState(paths, {
    state: "frozen",
    seq: 1,
    protocolSha256,
    acquisitionUntilMs: built.snapshot.acquisitionUntilMs,
    productAuthorization: false,
    productVerdict: "preserve-v2",
    verdict: ACQ_VERDICTS.ACQ_PROTOCOL_FROZEN,
  });
  appendEvent(paths, {
    type: "freeze",
    protocolSha256,
    acquisitionUntilMs: built.snapshot.acquisitionUntilMs,
  });

  // Minimal freeze report (no network)
  const report = buildAcquisitionReport({
    protocol,
    snapshot: built.snapshot,
    panelPublic: null,
    executeResult: null,
    manifest: null,
  });
  writeJson(paths.report, report);

  console.log(JSON.stringify({
    ok: true,
    state: "frozen",
    verdict: ACQ_VERDICTS.ACQ_PROTOCOL_FROZEN,
    protocolSha256,
    acquisitionUntilMs: built.snapshot.acquisitionUntilMs,
    saltSha256: built.snapshot.saltSha256,
    studyRoot: publicStudyRoot(paths.root),
    reportSha256: report.reportSha256,
    freezeBeforeFetch: true,
  }, null, 2));
}

function cmdSelect(args) {
  const paths = studyPaths(args.studyRoot);
  if (!existsSync(paths.protocolSnapshot)) {
    die("run freeze first", 2);
  }
  const snapshot = readJson(paths.protocolSnapshot);
  const panel = selectSubjectPanel(snapshot, { repoRoot: ROOT });
  const publicPanel = stripPanelForReport(panel);

  // Local panel file may retain raw ids for execute URL construction only.
  writeJson(paths.subjectPanel, {
    ...panel,
    subjects: (panel.subjects || []).map((s) => ({
      subjectKey: s.subjectKey,
      rawId: s._rawId,
    })),
  });

  // Public-facing copy without raw ids for status
  writeJson(join(paths.root, "subject-panel.public.json"), publicPanel);

  writeState(paths, {
    ...readState(paths),
    state: panel.ok ? "panel-selected" : "panel-unavailable",
    verdict: panel.verdict,
    productAuthorization: false,
    productVerdict: "preserve-v2",
  });
  appendEvent(paths, {
    type: "select",
    verdict: panel.verdict,
    selectedCount: publicPanel.selectedCount,
  });

  const report = buildAcquisitionReport({
    protocol: snapshot,
    snapshot,
    panelPublic: publicPanel,
    executeResult: null,
    manifest: null,
  });
  writeJson(paths.report, report);

  console.log(JSON.stringify({
    ok: panel.ok,
    verdict: panel.verdict,
    reason: panel.reason || null,
    selectedCount: publicPanel.selectedCount,
    subjectKeys: publicPanel.subjectKeys,
    studyRoot: publicStudyRoot(paths.root),
    reportSha256: report.reportSha256,
  }, null, 2));

  if (!panel.ok) process.exitCode = 2;
}

async function cmdExecute(args) {
  const paths = studyPaths(args.studyRoot);
  if (!existsSync(paths.protocolSnapshot)) {
    die("run freeze first", 2);
  }
  if (!existsSync(paths.subjectPanel)) {
    die("run select first", 2);
  }

  const snapshot = readJson(paths.protocolSnapshot);
  const stored = readJson(paths.subjectPanel);
  const panel = {
    ok: stored.ok,
    verdict: stored.verdict,
    reason: stored.reason,
    subjects: (stored.subjects || []).map((s) => ({
      subjectKey: s.subjectKey,
      _rawId: s.rawId || s._rawId,
    })),
    selectedCount: stored.selectedCount,
    qualifiedCount: stored.qualifiedCount,
    sourceHits: stored.sourceHits,
    selectionRule: stored.selectionRule,
  };
  const publicPanel = stripPanelForReport(panel);
  const knownRaw = panel.subjects.map((s) => s._rawId).filter(Boolean);

  if (!args.confirmExecute) {
    const report = buildAcquisitionReport({
      protocol: snapshot,
      snapshot,
      panelPublic: publicPanel,
      executeResult: {
        ok: false,
        verdict: ACQ_VERDICTS.ACQ_NETWORK_DISABLED,
        subjects: [],
      },
      manifest: null,
    });
    writeJson(paths.report, report);
    writeState(paths, {
      ...readState(paths),
      state: "network-disabled",
      verdict: ACQ_VERDICTS.ACQ_NETWORK_DISABLED,
    });
    appendEvent(paths, { type: "execute", verdict: ACQ_VERDICTS.ACQ_NETWORK_DISABLED });
    console.log(JSON.stringify({
      ok: false,
      verdict: ACQ_VERDICTS.ACQ_NETWORK_DISABLED,
      reason: "network disabled by default; pass explicit --confirm-execute",
      studyRoot: publicStudyRoot(paths.root),
      reportSha256: report.reportSha256,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  if (!panel.ok || !panel.subjects.length) {
    console.log(JSON.stringify({
      ok: false,
      verdict: panel.verdict || ACQ_VERDICTS.STOP_ACQUISITION_PANEL_UNAVAILABLE,
      reason: panel.reason || "panel unavailable",
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const result = await executeAcquisition({
    protocol: snapshot,
    snapshot,
    panel,
    confirmExecute: true,
    fetchFn: globalThis.fetch.bind(globalThis),
  });

  mkdirSync(paths.subjectsDir, { recursive: true });
  const receipts = [];

  for (const r of result.subjects || []) {
    const dir = join(paths.subjectsDir, r.subjectKey);
    mkdirSync(dir, { recursive: true });
    if (r.ok) {
      writeAtomic(join(dir, "raw.ndjson"), r.rawText);
      writeAtomic(join(dir, "raw.sha256"), `${r.rawSha256}\n`);
      writeAtomic(join(dir, "capped.ndjson"), r.cappedText);
      writeAtomic(join(dir, "capped.sha256"), `${r.cappedSha256}\n`);
      // Double-check cap determinism on disk
      const recap = capNdjsonBytes(r.rawText, snapshot.fetch.maxGamesPerSubject);
      if (sha256Hex(recap.cappedText) !== r.cappedSha256) {
        die("capped hash mismatch after write (determinism failure)");
      }
    }
    if (r.httpReceipt) {
      const leak = assertNoRawIdentityLeakage(r.httpReceipt, "$.httpReceipt", {
        knownRawTokens: knownRaw,
      });
      if (!leak.ok) die(`refused: raw identity in http receipt: ${leak.leaks.join(",")}`);
      writeJson(join(dir, "http-receipt.json"), r.httpReceipt);
    } else {
      // Failure receipt without body
      const failReceipt = {
        kind: "orcbr-b1-acq-http-receipt",
        subjectKey: r.subjectKey,
        httpStatus: r.httpStatus ?? null,
        urlSha256: r.urlSha256 || null,
        ok: false,
        verdict: r.verdict,
        reason: r.reason || null,
        productAuthorization: false,
        productVerdict: "preserve-v2",
        burnDeclaration: BURN_ON_EXECUTE,
      };
      failReceipt.receiptSha256 = sha256Hex(
        `${JSON.stringify({ ...failReceipt, receiptSha256: undefined }, null, 2)}\n`,
      );
      writeJson(join(dir, "http-receipt.json"), failReceipt);
    }
    receipts.push(r);
  }

  const manifest = buildManifest({
    protocol: snapshot,
    snapshot,
    panelPublic: publicPanel,
    subjectReceipts: receipts,
  });
  const leakM = assertNoRawIdentityLeakage(manifest, "$.manifest", {
    knownRawTokens: knownRaw,
  });
  if (!leakM.ok) die(`refused: raw identity in manifest: ${leakM.leaks.join(",")}`);
  writeJson(paths.manifest, manifest);

  const report = buildAcquisitionReport({
    protocol: snapshot,
    snapshot,
    panelPublic: publicPanel,
    executeResult: result,
    manifest,
  });
  const leakR = assertNoRawIdentityLeakage(report, "$.report", {
    knownRawTokens: knownRaw,
  });
  if (!leakR.ok) die(`refused: raw identity in report: ${leakR.leaks.join(",")}`);
  writeJson(paths.report, report);

  writeState(paths, {
    ...readState(paths),
    state: result.ok ? "execute-ok" : "execute-stopped",
    verdict: result.verdict,
    burnDeclaration: result.burnDeclaration || BURN_ON_EXECUTE,
    productAuthorization: false,
    productVerdict: "preserve-v2",
    manifestSha256: manifest.manifestSha256,
    reportSha256: report.reportSha256,
  });
  appendEvent(paths, {
    type: "execute",
    verdict: result.verdict,
    ok: result.ok,
    burnDeclaration: result.burnDeclaration || BURN_ON_EXECUTE,
  });

  console.log(JSON.stringify({
    ok: result.ok,
    verdict: result.verdict,
    reason: result.reason || null,
    burnDeclaration: result.burnDeclaration || BURN_ON_EXECUTE,
    burnNote: BURN_ON_INSPECT,
    subjectKeys: publicPanel.subjectKeys,
    manifestSha256: manifest.manifestSha256,
    reportSha256: report.reportSha256,
    studyRoot: publicStudyRoot(paths.root),
    productAuthorization: false,
    productVerdict: "preserve-v2",
    orcbrGatesRun: false,
  }, null, 2));

  if (!result.ok) process.exitCode = 2;
}

function cmdStatus(args) {
  const paths = studyPaths(args.studyRoot);
  const state = readState(paths);
  const out = {
    studyRoot: publicStudyRoot(paths.root),
    state: state.state,
    verdict: state.verdict,
    productAuthorization: false,
    productVerdict: "preserve-v2",
    moduleAStatus: "CLOSED_NOT_REOPENED",
    protocolSha256: state.protocolSha256 || null,
    acquisitionUntilMs: state.acquisitionUntilMs || null,
    burnDeclaration: state.burnDeclaration || null,
    manifestSha256: state.manifestSha256 || null,
    reportSha256: state.reportSha256 || null,
    frozen: existsSync(paths.protocolSnapshot),
    panelSelected: existsSync(paths.subjectPanel),
  };
  if (existsSync(paths.report)) {
    const report = readJson(paths.report);
    out.reportVerdict = report.verdict;
    out.reportSha256 = report.reportSha256;
  }
  console.log(JSON.stringify(out, null, 2));
}

function cmdVerify(args) {
  const paths = studyPaths(args.studyRoot);
  if (!existsSync(paths.protocolSnapshot)) die("nothing to verify; run freeze first");

  const snapshot = readJson(paths.protocolSnapshot);
  const manifest = existsSync(paths.manifest) ? readJson(paths.manifest) : null;
  const report = existsSync(paths.report) ? readJson(paths.report) : null;

  const subjectFiles = [];
  if (existsSync(paths.subjectsDir)) {
    for (const name of readdirSync(paths.subjectsDir)) {
      const dir = join(paths.subjectsDir, name);
      const rawPath = join(dir, "raw.ndjson");
      const cappedPath = join(dir, "capped.ndjson");
      const rawShaPath = join(dir, "raw.sha256");
      const cappedShaPath = join(dir, "capped.sha256");
      subjectFiles.push({
        subjectKey: name,
        rawBytes: existsSync(rawPath) ? readFileSync(rawPath) : null,
        cappedBytes: existsSync(cappedPath) ? readFileSync(cappedPath) : null,
        rawSha256: existsSync(rawShaPath)
          ? readFileSync(rawShaPath, "utf8").trim()
          : null,
        cappedSha256: existsSync(cappedShaPath)
          ? readFileSync(cappedShaPath, "utf8").trim()
          : null,
      });
    }
  }

  const v = verifyCustodyArtifacts({
    snapshot,
    manifest,
    report,
    subjectFiles,
  });

  // Also verify protocol file still matches snapshot hash when default path used
  if (existsSync(args.protocolPath)) {
    const bytes = readFileSync(args.protocolPath);
    const live = createHash("sha256").update(bytes).digest("hex");
    if (snapshot.protocolSha256 && live !== snapshot.protocolSha256) {
      v.ok = false;
      v.verdict = ACQ_VERDICTS.TAMPER_DETECTED;
      v.issues = [...(v.issues || []), "protocol file bytes drifted from freeze snapshot"];
    }
  }

  console.log(JSON.stringify({
    ok: v.ok,
    verdict: v.verdict,
    issues: v.issues,
    studyRoot: publicStudyRoot(paths.root),
    productAuthorization: false,
    productVerdict: "preserve-v2",
  }, null, 2));

  if (!v.ok) process.exitCode = 2;
}

function cmdHelp() {
  console.log(`ORCBR-B1 raw acquisition CLI (scout-orcbr-b1-raw-acq-v1)

Commands:
  freeze                 Freeze protocol + acquisitionUntilMs (no network)
  select                 Offline subject panel selection (no network)
  execute                Fetch raw only with --confirm-execute
  status                 Print study state
  verify                 Rehash custody; detect tamper

Flags:
  --confirm-execute      Required for network access
  --study-root <path>    Default: tmp/scout-orcbr-b1-acq
  --protocol <path>      Default: research/scout-orcbr-b1-acq/orcbr-b1-acq.protocol.json

Prohibited: --cal --test --gates --package --product (acquisition-only).
Does not run ORCBR algorithm gates or retune thresholds.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "freeze":
      cmdFreeze(args);
      break;
    case "select":
      cmdSelect(args);
      break;
    case "execute":
      await cmdExecute(args);
      break;
    case "status":
      cmdStatus(args);
      break;
    case "verify":
      cmdVerify(args);
      break;
    case "help":
    case null:
      cmdHelp();
      if (args.command == null) process.exitCode = 2;
      break;
    default:
      die(`unknown command: ${args.command}`);
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
