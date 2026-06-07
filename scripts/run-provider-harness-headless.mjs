// Headless runner that turns the two-origin provider harness from a "human-driven
// browser load" into an automated, repeatable GATE (docs/browser-engine-migration.md
// Phase 3b→3c). It closes the one thing curl/Node can't: a REAL browser Web Worker
// fetching the .onnx cross-origin through the injected window.__MAIA3_ASSET_BASE and
// passing the harness's `cross-origin-weight-fetch` check.
//
// It uses the system Chrome/Edge over the DevTools Protocol with NO npm dependency
// (Node 24 ships global fetch + WebSocket). Steps:
//   1. spawn scripts/two-origin-smoke.mjs (APP :8787 with COOP/COEP + injected asset
//      base → WEIGHT :8788 "CDN" with ACAO/CORP),
//   2. launch headless Chrome and open
//      /maia3-provider-harness.html?requireCrossOrigin=1,
//   3. wait for window.__HARNESS_RESULT, then assert report.ok AND that every backend's
//      `cross-origin-weight-fetch` check is ok with crossOrigin === true.
//
// Exit 0 = gate passed; non-zero = failed (prints the offending checks). One command:
//   npm run gate:cross-origin       (or: node scripts/run-provider-harness-headless.mjs)
// The diagnostic pages are opt-in (vite harnessInputs); if the built static/ doesn't
// have them, this script first runs a build with MAIA3_HARNESS=1 set in the child env.
// On exit it ALWAYS restores the default deploy build so the committed static/ can't be
// staged with diagnostics (opt out with KEEP_HARNESS_BUILD=1 for iterative debugging).
// Override the browser with CHROME_PATH=... if auto-detection misses it.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS_HTML = join("src", "prepforge_chess", "web", "static", "maia3-provider-harness.html");

// Stage 4c: request threaded WASM (override with THREADS=N; THREADS=1 forces single-thread).
// The two-origin harness app origin is crossOriginIsolated, so threading must engage — the
// harness's `wasm-threads` check fails the gate if a >1 request comes back single-threaded.
const THREADS = /^\d+$/.test(process.env.THREADS || "") ? process.env.THREADS : "4";
const APP_URL = `http://localhost:8787/maia3-provider-harness.html?requireCrossOrigin=1&threads=${THREADS}`;
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);
const READY_TIMEOUT_MS = 15000; // for the two-origin servers to start listening
const RESULT_TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS || 240000); // WASM inference is slow

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("No Chrome/Edge found; set CHROME_PATH to the browser executable.");
}

// Wait until an HTTP endpoint is reachable. `acceptListening` (weight origin) treats ANY
// response as ready — we only care the port is listening. Otherwise (app manifest) require
// a 2xx: a 404 there means the build is wrong, which must fail fast, not be waited on.
async function waitForHttp(url, timeoutMs, acceptListening = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (acceptListening || r.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// Minimal CDP client over a single browser websocket with flattened sessions.
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        console.error(`  [page exception] ${d?.exception?.description || d?.text}`);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        console.error(`  [page console.error] ${msg.params.args?.map((a) => a.value ?? a.description).join(" ")}`);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

let twoOrigin = null;
let chrome = null;
let userDataDir = null;
// The gate always builds (or runs against) a HARNESS-shaped static/. Restore the deploy
// shape on exit unconditionally so the committed static/ can't be staged with diagnostic
// pages / the worker chunk — opt out with KEEP_HARNESS_BUILD=1 for iterative debugging.
const restoreDeployBuild = process.env.KEEP_HARNESS_BUILD !== "1";

// Run a child process to completion, inheriting stdio; reject on non-zero exit.
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function main() {
  // 0. The diagnostic pages are opt-in (vite harnessInputs). If this build doesn't have
  //    them, produce one with the flag set in the CHILD env — cross-platform, so we don't
  //    rely on shell-specific inline-env syntax (`VAR=1 cmd` fails in Windows cmd).
  if (!existsSync(HARNESS_HTML)) {
    console.log("→ harness page missing; building with MAIA3_HARNESS=1 ...");
    await run("npm", ["run", "build"], { ...process.env, MAIA3_HARNESS: "1" });
  }

  // 1. Two-origin servers.
  console.log("→ starting two-origin harness (APP :8787 / WEIGHT :8788) ...");
  twoOrigin = spawn(process.execPath, [join("scripts", "two-origin-smoke.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  twoOrigin.stdout.on("data", (b) => process.stdout.write(`  [two-origin] ${b}`));
  await waitForHttp("http://localhost:8787/static/maia3/maia3.manifest.json", READY_TIMEOUT_MS); // must be 2xx
  await waitForHttp("http://localhost:8788/", READY_TIMEOUT_MS, true); // weight origin: just listening

  // 2. Headless browser.
  const browser = findBrowser();
  userDataDir = mkdtempSync(join(tmpdir(), "maia3-harness-"));
  console.log(`→ launching ${browser} (headless) ...`);
  chrome = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });

  await waitForHttp(`http://localhost:${DEBUG_PORT}/json/version`, READY_TIMEOUT_MS);
  const version = await (await fetch(`http://localhost:${DEBUG_PORT}/json/version`)).json();
  console.log(`  ${version.Browser}`);

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new CDP(ws);

  // 3. Open the harness and wait for the report.
  console.log(`→ opening ${APP_URL}`);
  const { targetId } = await cdp.send("Target.createTarget", { url: APP_URL });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);

  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  let report = null;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const probe = await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "JSON.stringify({ done: !!window.__HARNESS_RESULT, status: (document.getElementById('status')||{}).textContent || '', result: window.__HARNESS_RESULT || null })",
        returnByValue: true,
      },
      sessionId,
    );
    const snap = JSON.parse(probe.result.value);
    if (snap.status && snap.status !== lastStatus) {
      lastStatus = snap.status;
      console.log(`  status: ${snap.status}`);
    }
    if (snap.done) {
      report = snap.result;
      break;
    }
    await sleep(1000);
  }

  if (!report) throw new Error(`harness did not finish within ${RESULT_TIMEOUT_MS}ms`);
  if (report.fatal) throw new Error(`harness FATAL:\n${report.fatal}`);

  // 4. Assert the gate.
  console.log("\n=== report summary ===");
  console.log(`report.ok=${report.ok}  requireCrossOrigin=${report.requireCrossOrigin}  assetBaseInjected=${report.assetBaseInjected}  crossOriginIsolated=${report.crossOriginIsolated}`);

  const failures = [];
  if (!report.ok) failures.push("report.ok is false");
  for (const b of report.backends || []) {
    const seam = (b.checks || []).find((c) => c.name === "cross-origin-weight-fetch");
    if (!seam) {
      failures.push(`[${b.backend}] no cross-origin-weight-fetch check`);
      continue;
    }
    const detail = seam.detail || {};
    console.log(
      `[${b.backend}] cross-origin-weight-fetch ok=${seam.ok} crossOrigin=${detail.crossOrigin} ` +
        `fetchOrigin=${detail.fetchOrigin} appOrigin=${detail.appOrigin}`,
    );
    if (!seam.ok) failures.push(`[${b.backend}] cross-origin-weight-fetch failed: ${JSON.stringify(seam.issues)}`);
    if (detail.crossOrigin !== true) failures.push(`[${b.backend}] crossOrigin !== true (${detail.fetchOrigin})`);
    // Stage 4c: report the applied thread count + a coarse latency note (one headless box).
    const threadsCheck = (b.checks || []).find((c) => c.name === "wasm-threads");
    const td = (threadsCheck && threadsCheck.detail) || {};
    const t = b.timings || {};
    const predMs = Array.isArray(t.predMs) && t.predMs.length ? (t.predMs.reduce((a, x) => a + x, 0) / t.predMs.length).toFixed(1) : "n/a";
    console.log(
      `[${b.backend}] threads requested=${td.requested} applied=${b.numThreads} ` +
        `(coi=${td.crossOriginIsolated}) · initMs=${t.initMs ?? "n/a"} warmPredMs(avg)=${predMs} batchMs=${t.batchMs ?? "n/a"}`,
    );
    // surface any other failing checks too (incl. wasm-threads if threading didn't engage)
    for (const c of b.checks || []) if (!c.ok) failures.push(`[${b.backend}] ${c.name}: ${JSON.stringify(c.issues)}`);
  }

  if (failures.length) {
    console.error("\n✗ GATE FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ GATE PASSED: real browser worker fetched the .onnx cross-origin and all checks are OK.");
  }
}

function cleanup() {
  try { chrome?.kill(); } catch {}
  try { twoOrigin?.kill(); } catch {}
  try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

main()
  .catch((err) => {
    console.error(`\n✗ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(200);
    cleanup();
    // give child processes a moment to die before the event loop drains
    await sleep(200);
    // Always restore the deploy-shaped static/ (the gate ran against a HARNESS build either
    // way) so the committed static/ never carries diagnostic pages / the worker chunk into
    // production. Opt out with KEEP_HARNESS_BUILD=1 (handled where restoreDeployBuild is set).
    if (restoreDeployBuild) {
      try {
        console.log("→ restoring default deploy build (no diagnostics) ...");
        await run("npm", ["run", "build"], { ...process.env, MAIA3_HARNESS: "" });
      } catch (err) {
        console.error(
          `\n⚠ FAILED to restore the deploy build (${err.message}). static/ still holds a ` +
            `HARNESS build — run \`npm run build\` before staging src/prepforge_chess/web/static/.`,
        );
      }
    }
    process.exit(process.exitCode || 0);
  });
