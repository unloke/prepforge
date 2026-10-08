// UI v2 viewport smoke suite — single runner.
//
// Runs the eight per-view Playwright viewport smokes plus the cross-view
// states smoke (each serves the built
// static/ tree with real-shape /api/* fixtures at 1440x900 / 1180x900 /
// 390x844) sequentially and reports one summary. The smokes were promoted
// from throwaway tmp/ scripts after they caught regressions during the
// ui-v2 page-internals round; they intentionally reuse the existing
// fixture + Playwright setup — no new test framework.
//
// Usage: npm run smoke:ui-v2   (or: node scripts/smoke/ui-v2/run-all.mjs)
// Requires `npm run build` first — the smokes serve the committed/built
// src/prepforge_chess/web/static tree.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL(".", import.meta.url));
// A smoke stuck waiting on the page fails instead of holding the CI job open.
const SMOKE_TIMEOUT_MS = 5 * 60_000;

// The view order follows the app's page order. "build" is the Repertoire
// workspace (the Build view).
const SUITE = [
  ["Library", "library-viewport-smoke.mjs"],
  ["Repertoire", "build-viewport-smoke.mjs"],
  ["Train", "train-viewport-smoke.mjs"],
  ["Games", "games-viewport-smoke.mjs"],
  ["Scout", "scout-viewport-smoke.mjs"],
  ["Analyze", "analyze-viewport-smoke.mjs"],
  ["Teams", "teams-viewport-smoke.mjs"],
  ["Settings", "settings-viewport-smoke.mjs"],
  // Cross-view states: signed out, Library load errors, resize chunk hygiene,
  // mobile account-menu focus, Link Lichess → Connections.
  ["States", "states-smoke.mjs"],
];

function runOne([label, file]) {
  return new Promise((resolve) => {
    const started = Date.now();
    process.stdout.write(`\n[ui-v2-smoke] ${label} (${file}) …\n`);
    const child = spawn(process.execPath, [join(DIR, file)], {
      stdio: "inherit",
      env: process.env,
    });
    const timer = setTimeout(() => {
      process.stdout.write(`[ui-v2-smoke] ${label} timed out after ${SMOKE_TIMEOUT_MS / 60_000} min
`);
      child.kill();
    }, SMOKE_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ label, file, ok: code === 0, ms: Date.now() - started });
    });
    child.on("error", () => resolve({ label, file, ok: false, ms: Date.now() - started }));
  });
}

const results = [];
for (const entry of SUITE) {
  results.push(await runOne(entry));
}

const failed = results.filter((r) => !r.ok);
console.log("\n[ui-v2-smoke] summary");
for (const r of results) {
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"}  ${r.label.padEnd(11)} ${r.file}  (${(r.ms / 1000).toFixed(1)}s)`,
  );
}
console.log(`[ui-v2-smoke] ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
