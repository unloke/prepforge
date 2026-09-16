// ORCBR-B1 research CLI — TRAIN-only structural Phase0.
//
// Usage:
//   node scripts/scout-orcbr-b1.mjs freeze
//   node scripts/scout-orcbr-b1.mjs g0 --raw <local.ndjson> --subject <user> --salt <salt>
//   node scripts/scout-orcbr-b1.mjs gates --through g7
//   node scripts/scout-orcbr-b1.mjs package --train-only
//   node scripts/scout-orcbr-b1.mjs status
//   node scripts/scout-orcbr-b1.mjs verify
//
// Refuses CAL/TEST/network. Product always preserve-v2. Final report self-hashed last.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VERDICTS,
  validateProtocolLocks,
  computeReportSha256,
  sha256Hex,
  assertResearchSalt,
  assertNoRawIdentityLeakage,
  stripOutcomesDeep,
  pseudonymKey,
} from "../research/scout-orcbr-b1/orcbr-b1-schema.js";
import {
  buildPhase0Report,
  runG0,
  runGates,
} from "../research/scout-orcbr-b1/orcbr-b1-gates.js";
import { generateTrainPackage, expandCandidatesToBudget } from "../research/scout-orcbr-b1/orcbr-b1-generate.js";
import { packageContentHash } from "../research/scout-orcbr-b1/orcbr-b1-units.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DEFAULT_PROTOCOL = resolve(ROOT, "research/scout-orcbr-b1/orcbr-b1.protocol.json");
const DEFAULT_STUDY_ROOT = resolve(ROOT, "tmp/scout-orcbr-b1");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/** Prefer repo-relative study roots in CLI JSON (no absolute/private paths). */
function publicStudyRoot(absPath) {
  const norm = String(absPath || "").replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/");
  if (norm.startsWith(root + "/")) return norm.slice(root.length + 1);
  if (norm === root) return ".";
  // Outside repo: expose only final segment, never full private path
  const parts = norm.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "study";
}

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
      // Windows best-effort
    }
  }
  renameSync(tmp, path);
}

function studyPaths(studyRoot) {
  return {
    root: studyRoot,
    state: join(studyRoot, "state.json"),
    events: join(studyRoot, "events.ndjson"),
    protocolSnapshot: join(studyRoot, "protocol.snapshot.json"),
    custodyDir: join(studyRoot, "custody"),
    parseReceipt: join(studyRoot, "custody", "parse-receipt.json"),
    rawSha: join(studyRoot, "custody", "raw.sha256"),
    gatesDir: join(studyRoot, "gates"),
    trainDir: join(studyRoot, "train"),
    packagePath: join(studyRoot, "train", "package.json"),
    report: join(studyRoot, "report.json"),
    gamesCache: join(studyRoot, "train", "games.research.json"),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeAtomic(path, `${JSON.stringify(obj, null, 2)}\n`);
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

function refuseForbiddenFlags(argv) {
  const bannedExact = new Set([
    "--cal",
    "--test",
    "--network",
    "--fetch",
    "--online",
    "--cal-path",
    "--test-path",
    "--product",
    "--authorize",
    "--ship",
  ]);
  for (const a of argv) {
    const flag = String(a).split("=")[0];
    if (bannedExact.has(flag)) {
      die(`refused: ${flag} is prohibited under ORCBR-B1 (cal/test/network/product disabled)`);
    }
    // Refuse --cal=..., --test=..., etc.
    if (/^--(cal|test|network|fetch|online)(=|$)/i.test(a)) {
      die(`refused: ${a} is prohibited under ORCBR-B1`);
    }
  }
}

/** Refuse path segments that look like CAL/TEST holdouts or production web-src. */
function refuseForbiddenPath(label, path) {
  if (!path) return;
  const norm = String(path).replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(cal|test)(\/|$)/i.test(norm) && !/node_modules|vitest|\.test\.|\/tests\//i.test(norm)) {
    // Allow repo tests/ directory and *.test.js; block /cal/ and sealed TEST panels.
    if (/\/(cal)(\/|$)/i.test(norm) || /\/(holdout-test|sealed-test|panel-test)(\/|$)/i.test(norm)) {
      die(`refused: ${label} path looks like CAL/TEST holdout: ${path}`);
    }
  }
  if (/\/web-src(\/|$)/i.test(norm) || /\/src\/prepforge_chess\/web\/static(\/|$)/i.test(norm)) {
    die(`refused: ${label} must not target production web-src/static paths`);
  }
}

function parseArgs(argv) {
  refuseForbiddenFlags(argv);
  const args = {
    command: null,
    studyRoot: DEFAULT_STUDY_ROOT,
    protocolPath: DEFAULT_PROTOCOL,
    rawPath: null,
    cappedPath: null,
    subject: null,
    salt: null,
    through: "G7",
    trainOnly: false,
    fixtureMode: false,
  };
  const rest = argv.slice(2);
  args.command = rest[0] || null;
  for (let i = 1; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--study-root") args.studyRoot = resolve(rest[++i]);
    else if (a === "--protocol") args.protocolPath = resolve(rest[++i]);
    else if (a === "--raw") args.rawPath = resolve(rest[++i]);
    else if (a === "--capped") args.cappedPath = resolve(rest[++i]);
    else if (a === "--subject") args.subject = rest[++i];
    else if (a === "--salt") args.salt = rest[++i];
    else if (a === "--through") args.through = String(rest[++i] || "G7").toUpperCase();
    else if (a === "--train-only") args.trainOnly = true;
    else if (a === "--fixture-mode") {
      // Explicit opt-in for synthetic structural fixtures only — never production default.
      args.fixtureMode = true;
    } else if (a === "--help" || a === "-h") args.command = "help";
    else if (a.startsWith("-")) {
      die(`refused: unknown/ambiguous flag ${a}`);
    }
  }
  refuseForbiddenPath("raw", args.rawPath);
  refuseForbiddenPath("capped", args.cappedPath);
  refuseForbiddenPath("study-root", args.studyRoot);
  return args;
}

function loadProtocol(path) {
  const protocol = readJson(path);
  const v = validateProtocolLocks(protocol);
  if (!v.ok) die(`protocol INVALID: ${v.errors.join("; ")}`);
  return protocol;
}

function cmdFreeze(args) {
  const paths = studyPaths(args.studyRoot);
  const protocol = loadProtocol(args.protocolPath);
  const bytes = readFileSync(args.protocolPath);
  const protocolSha256 = createHash("sha256").update(bytes).digest("hex");

  if (existsSync(paths.protocolSnapshot)) {
    const existingSha = sha256File(paths.protocolSnapshot);
    const snap = readJson(paths.protocolSnapshot);
    if (snap.protocolSha256 && snap.protocolSha256 !== protocolSha256) {
      die("freeze refused: existing protocol.snapshot.json differs (new protocolId required)");
    }
    // allow idempotent freeze if same bytes
    if (existingSha === sha256Hex(readFileSync(paths.protocolSnapshot))) {
      console.log(JSON.stringify({
        ok: true,
        state: "frozen",
        protocolSha256,
        studyRoot: publicStudyRoot(paths.root),
        note: "already frozen (identical)",
      }, null, 2));
      return;
    }
  }

  mkdirSync(paths.root, { recursive: true });
  const snapshot = {
    ...protocol,
    protocolSha256,
    frozenAt: new Date().toISOString(),
    productAuthorization: false,
    productVerdict: "preserve-v2",
  };
  writeJson(paths.protocolSnapshot, snapshot);
  writeState(paths, {
    state: "frozen",
    seq: 1,
    protocolSha256,
    productAuthorization: false,
    productVerdict: "preserve-v2",
    verdict: VERDICTS.READY_FOR_GATES,
  });
  appendEvent(paths, {
    type: "freeze",
    protocolSha256,
    productAuthorization: false,
  });
  console.log(JSON.stringify({
    ok: true,
    state: "frozen",
    protocolSha256,
    studyRoot: publicStudyRoot(paths.root),
  }, null, 2));
}

function cmdG0(args) {
  const paths = studyPaths(args.studyRoot);
  if (!existsSync(paths.protocolSnapshot)) {
    die("run freeze first");
  }
  const protocol = readJson(paths.protocolSnapshot);
  if (!args.rawPath) die("g0 requires --raw <local.ndjson>");
  if (!args.subject) die("g0 requires --subject <username>");
  if (!args.salt) die("g0 requires --salt <research-salt>");
  try {
    assertResearchSalt(args.salt);
  } catch (err) {
    die(String(err.message || err));
  }
  if (!existsSync(args.rawPath)) die(`raw file not found (local only)`);

  const rawText = readFileSync(args.rawPath, "utf8");
  const rawSha256 = sha256Hex(Buffer.from(rawText, "utf8"));
  const knownRaw = [args.subject];
  const g0 = runG0({
    rawText,
    subjectUsername: args.subject,
    researchSalt: args.salt,
    protocol,
    knownRawTokens: knownRaw,
  });

  mkdirSync(paths.custodyDir, { recursive: true });
  writeAtomic(paths.rawSha, `${rawSha256}\n`);

  const receipt = {
    gate: "G0",
    pass: g0.pass,
    verdict: g0.verdict,
    rawSha256,
    identityCoverage: g0.identityCoverage ?? null,
    withOpponentKeyCount: g0.withOpponentKeyCount ?? 0,
    eligibleCount: g0.eligibleCount ?? 0,
    productAuthorization: false,
    productVerdict: "preserve-v2",
    protocolSha256: protocol.protocolSha256,
    reason: g0.reason || null,
    priorGateSha256: null,
  };
  receipt.receiptSha256 = sha256Hex(`${JSON.stringify({ ...receipt, receiptSha256: undefined }, null, 2)}\n`);
  writeJson(paths.parseReceipt, receipt);

  if (g0.pass && g0.games) {
    mkdirSync(paths.trainDir, { recursive: true });
    // Privacy: persist only pseudonymous subjectKey — never raw username/salt.
    const subjectKey = pseudonymKey(args.subject, args.salt);
    const cache = {
      subjectKey,
      games: stripOutcomesDeep(g0.games),
      count: g0.games.length,
      outcomeBlind: true,
    };
    const leak = assertNoRawIdentityLeakage(cache, "$", { knownRawTokens: knownRaw });
    if (!leak.ok) die(`refused: raw identity leakage in games cache: ${leak.leaks.join(",")}`);
    writeJson(paths.gamesCache, cache);
  }

  writeState(paths, {
    ...readState(paths),
    state: g0.pass ? "g0-complete" : "g0-stopped",
    verdict: g0.verdict,
    rawSha256,
    productAuthorization: false,
    productVerdict: "preserve-v2",
  });
  appendEvent(paths, { type: "g0", verdict: g0.verdict, rawSha256 });

  // Self-hashed report (even on stop)
  const report = buildPhase0Report({
    protocol,
    gateRun: {
      verdict: g0.verdict,
      results: [g0],
      package: null,
    },
    rawSha256,
    knownRawTokens: knownRaw,
  });
  writeJson(paths.report, report);

  console.log(JSON.stringify({
    ok: g0.pass,
    verdict: g0.verdict,
    rawSha256,
    receiptSha256: receipt.receiptSha256,
    reportSha256: report.reportSha256,
    studyRoot: publicStudyRoot(paths.root),
  }, null, 2));

  if (!g0.pass) process.exitCode = 2;
}

function cmdGates(args) {
  const paths = studyPaths(args.studyRoot);
  if (!existsSync(paths.protocolSnapshot)) die("run freeze first");
  const protocol = readJson(paths.protocolSnapshot);

  let games = null;
  if (existsSync(paths.gamesCache)) {
    games = readJson(paths.gamesCache).games;
  }
  if (!games?.length) {
    die("no research games cache; run g0 --raw ... first");
  }

  const state = readState(paths);
  // Default: live frozen pins (g_min=30, d_min=10). --fixture-mode is explicit opt-in only.
  const run = runGates({
    sealedRecords: stripOutcomesDeep(games),
    games: stripOutcomesDeep(games),
    protocol,
    fixtureMode: args.fixtureMode === true,
  }, { through: args.through });

  mkdirSync(paths.gatesDir, { recursive: true });
  for (const r of run.results) {
    // Persist gate receipt without embedding full package units twice when large.
    // G2 diagnostics are privacy-safe aggregates only (no opponentKey / raw ids).
    writeJson(join(paths.gatesDir, `${r.gate.toLowerCase()}.json`), {
      gate: r.gate,
      pass: r.pass,
      verdict: r.verdict,
      receiptSha256: r.receiptSha256,
      priorGateSha256: r.priorGateSha256,
      reason: r.reason || null,
      // numeric diagnostics only (no raw identity)
      coverage: r.coverage,
      mean: r.mean,
      jaccard: r.jaccard,
      totalCost: r.package?.totalCost ?? r.totalCost,
      gMin: r.gMin,
      dMin: r.dMin,
      nMin: r.nMin,
      qualifying: typeof r.qualifying === "number" ? r.qualifying : undefined,
      fixtureMode: r.fixtureMode,
      diagnostics: r.diagnostics || undefined,
    });
  }

  if (run.package) {
    mkdirSync(paths.trainDir, { recursive: true });
    writeJson(paths.packagePath, run.package);
  }

  const report = buildPhase0Report({
    protocol,
    gateRun: run,
    rawSha256: state.rawSha256 || null,
  });
  writeJson(paths.report, report);

  writeState(paths, {
    ...state,
    state: run.ok ? "gates-complete" : "gates-stopped",
    verdict: run.verdict,
    productAuthorization: false,
    productVerdict: "preserve-v2",
  });
  appendEvent(paths, { type: "gates", through: args.through, verdict: run.verdict });

  console.log(JSON.stringify({
    ok: run.ok,
    verdict: run.verdict,
    gates: run.results.map((r) => ({ gate: r.gate, pass: r.pass, verdict: r.verdict })),
    reportSha256: report.reportSha256,
    packageSha256: run.package?.packageSha256 || null,
  }, null, 2));

  if (!run.ok) process.exitCode = 2;
}

function cmdPackage(args) {
  const paths = studyPaths(args.studyRoot);
  if (!args.trainOnly) {
    die("package requires --train-only (CAL/TEST refused)");
  }
  if (!existsSync(paths.gamesCache)) die("run g0 first");
  const protocol = readJson(paths.protocolSnapshot);
  const games = readJson(paths.gamesCache).games;

  const cleaned = stripOutcomesDeep(games);
  // package command uses frozen pins unless --fixture-mode
  const pins = args.fixtureMode
    ? { research_min_white_games: 2, research_min_days: 2 }
    : {};
  let gen = generateTrainPackage(cleaned, { requireExactFill: true, pins });
  if (!gen.ok) {
    const expanded = expandCandidatesToBudget(cleaned, 12, pins);
    if (expanded.exactFill) {
      gen = {
        ok: true,
        package: {
          unitContract: "preparation-unit-v2",
          budget: 12,
          totalCost: expanded.totalCost,
          exactFill: true,
          units: expanded.units,
          meta: expanded.meta,
          packageSha256: packageContentHash(expanded.units),
          productAuthorization: false,
          productVerdict: "preserve-v2",
          trainOnly: true,
          outcomeBlind: true,
        },
      };
    }
  }

  if (!gen.ok) {
    const report = buildPhase0Report({
      protocol,
      gateRun: {
        verdict: gen.verdict || VERDICTS.STOP_PACKAGE_EMPTY,
        results: [{
          gate: "G3",
          pass: false,
          verdict: gen.verdict || VERDICTS.STOP_PACKAGE_EMPTY,
        }],
        package: gen.package || null,
      },
    });
    writeJson(paths.report, report);
    console.log(JSON.stringify({
      ok: false,
      verdict: gen.verdict,
      reason: gen.reason,
      reportSha256: report.reportSha256,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  mkdirSync(paths.trainDir, { recursive: true });
  writeJson(paths.packagePath, gen.package);
  const report = buildPhase0Report({
    protocol,
    gateRun: {
      verdict: VERDICTS.READY_FOR_GATES,
      results: [{ gate: "G3", pass: true, verdict: VERDICTS.READY_FOR_GATES }],
      package: gen.package,
    },
  });
  writeJson(paths.report, report);
  console.log(JSON.stringify({
    ok: true,
    totalCost: gen.package.totalCost,
    exactFill: gen.package.exactFill,
    packageSha256: gen.package.packageSha256,
    reportSha256: report.reportSha256,
    unitCount: gen.package.units.length,
  }, null, 2));
}

function cmdStatus(args) {
  const paths = studyPaths(args.studyRoot);
  const state = readState(paths);
  const report = existsSync(paths.report) ? readJson(paths.report) : null;
  console.log(JSON.stringify({
    state: state.state,
    verdict: state.verdict || report?.verdict || null,
    productAuthorization: false,
    productVerdict: "preserve-v2",
    reportSha256: report?.reportSha256 || null,
    studyRoot: publicStudyRoot(paths.root),
  }, null, 2));
}

function cmdVerify(args) {
  const paths = studyPaths(args.studyRoot);
  const errors = [];
  if (!existsSync(paths.protocolSnapshot)) errors.push("missing protocol.snapshot.json");
  if (!existsSync(paths.report)) errors.push("missing report.json");

  if (existsSync(paths.protocolSnapshot)) {
    const protocol = readJson(paths.protocolSnapshot);
    const locks = validateProtocolLocks(protocol);
    if (!locks.ok) errors.push(...locks.errors);
    if (protocol.productAuthorization !== false) {
      errors.push("productAuthorization must be false");
    }
  }

  if (existsSync(paths.report)) {
    const report = readJson(paths.report);
    const expected = computeReportSha256(report);
    if (report.reportSha256 !== expected) {
      errors.push("reportSha256 mismatch (tamper or non-canonical rewrite)");
    }
    if (report.productAuthorization !== false) {
      errors.push("report productAuthorization must be false");
    }
    if (report.productVerdict !== "preserve-v2") {
      errors.push("report productVerdict must be preserve-v2");
    }
    const leak = assertNoRawIdentityLeakage(report);
    if (!leak.ok) errors.push(`raw identity leakage: ${leak.leaks.join(",")}`);
  }

  if (existsSync(paths.parseReceipt)) {
    const receipt = readJson(paths.parseReceipt);
    const body = { ...receipt };
    delete body.receiptSha256;
    const expectedReceipt = sha256Hex(`${JSON.stringify(body, null, 2)}\n`);
    if (receipt.receiptSha256 !== expectedReceipt) {
      errors.push("parse-receipt receiptSha256 mismatch (tamper)");
    }
  }

  const ok = errors.length === 0;
  console.log(JSON.stringify({
    ok,
    verdict: ok ? "VERIFIED" : VERDICTS.INVALID,
    errors,
    productAuthorization: false,
    productVerdict: "preserve-v2",
  }, null, 2));
  if (!ok) process.exitCode = 2;
}

function cmdHelp() {
  console.log(`ORCBR-B1 research CLI (TRAIN-only, no network/CAL/TEST)

Commands:
  freeze
  g0 --raw <local.ndjson> --subject <user> --salt <research-salt>
  gates [--through G7] [--fixture-mode]
  package --train-only [--fixture-mode]
  status
  verify

Options:
  --study-root <path>   default tmp/scout-orcbr-b1
  --protocol <path>     default research/scout-orcbr-b1/orcbr-b1.protocol.json
  --fixture-mode        opt-in relaxed longitudinal floors for synthetic fixtures only
                        (default uses frozen g_min=30, d_min=10)

Refuses: --cal, --test, --network, --fetch, --online, --product, unknown flags.
`);
}

function main() {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "freeze":
      return cmdFreeze(args);
    case "g0":
      return cmdG0(args);
    case "gates":
      return cmdGates(args);
    case "package":
      return cmdPackage(args);
    case "status":
      return cmdStatus(args);
    case "verify":
      return cmdVerify(args);
    case "help":
    case null:
      return cmdHelp();
    default:
      die(`unknown command: ${args.command}`);
  }
}

main();
