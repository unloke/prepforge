// Full release gate runner — quality checks + friction audits + cross-flow journey.
// Uses an isolated release SQLite DB (default: release.sqlite3 in repo root).
//
//   node scripts/run-release-gates.mjs
//
// Exits 1 on first failing gate. Starts a local API server if /healthz is down.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RELEASE_DB = process.env.RELEASE_DATABASE_URL || "sqlite:///release.sqlite3";
const PORT = process.env.RELEASE_PORT || "8001";
const BASE = process.env.RELEASE_BASE_URL || `http://127.0.0.1:${PORT}`;
const PY = join(ROOT, ".venv", "Scripts", "python.exe");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NODE = process.execPath;

const gates = [];

function log(msg) {
  console.log(`[release-gates] ${msg}`);
}

function runGate(name, cmd, args, extraEnv = {}, { useShell = false } = {}) {
  log(`▶ ${name}`);
  const env = {
    ...process.env,
    DATABASE_URL: RELEASE_DB,
    AUDIT_BASE_URL: BASE,
    RELEASE_BASE_URL: BASE,
    ...extraEnv,
  };
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env,
    stdio: "inherit",
    shell: useShell,
  });
  const ok = r.status === 0;
  gates.push({ name, ok, exitCode: r.status ?? 1 });
  if (!ok) {
    log(`✗ ${name} failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
  log(`✓ ${name}`);
}

async function healthOk() {
  try {
    const r = await fetch(`${BASE}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthOk()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let serverProc = null;

async function ensureServer() {
  if (await healthOk()) {
    log(`API already up at ${BASE} (expect DATABASE_URL=${RELEASE_DB} on that process)`);
    return;
  }
  if (!existsSync(PY)) {
    console.error(`[release-gates] missing ${PY} — create venv first`);
    process.exit(1);
  }
  log(`starting API on ${BASE} (db=${RELEASE_DB})`);
  serverProc = spawn(
    PY,
    [
      "-c",
      "from prepforge_chess.api.ratelimit import limiter; limiter.enabled=False; import uvicorn; uvicorn.run('prepforge_chess.api.main:app', host='127.0.0.1', port=" +
        PORT +
        ")",
    ],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: RELEASE_DB },
      stdio: "ignore",
      shell: false,
    },
  );
  if (!(await waitForHealth())) {
    console.error("[release-gates] API failed to start");
    process.exit(1);
  }
  log(`API ready at ${BASE}`);
}

function shutdownServer() {
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill();
    } catch {
      /* best-effort */
    }
  }
}

async function main() {
  log(`release DB: ${RELEASE_DB}`);

  runGate("alembic upgrade head", PY, ["-m", "alembic", "upgrade", "head"]);

  await ensureServer();

  try {
    runGate("npm test", NPM, ["test", "--", "--run"], {}, { useShell: true });
    runGate("npm run build", NPM, ["run", "build"], {}, { useShell: true });
    runGate("bundle size", NODE, [join(ROOT, "scripts", "check-bundle-size.mjs")]);
    runGate("lazy-chunk smoke", NPM, ["run", "smoke:lazy-chunks"], {}, { useShell: true });
    runGate("analyze friction audit", NODE, [join(ROOT, "scripts", "analyze-friction-audit.mjs")]);
    runGate("build friction audit", NODE, [join(ROOT, "scripts", "build-friction-audit.mjs")]);
    runGate("train friction audit", NODE, [join(ROOT, "scripts", "train-friction-audit.mjs")]);
    runGate("cross-flow release", NODE, [join(ROOT, "scripts", "release-cross-flow.mjs")]);
  } finally {
    shutdownServer();
  }

  log("all release gates passed");
  for (const g of gates) {
    log(`  ✓ ${g.name}`);
  }
}

process.on("exit", shutdownServer);
process.on("SIGINT", () => {
  shutdownServer();
  process.exit(130);
});

main().catch((err) => {
  console.error(`[release-gates] FAIL: ${err.message}`);
  shutdownServer();
  process.exit(1);
});