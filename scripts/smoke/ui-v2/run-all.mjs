// UI v2 viewport smoke suite — single runner.
//
// Runs the per-view Playwright viewport smokes plus the cross-view states
// and dialogs smokes (each serves the built
// static/ tree with real-shape /api/* fixtures at 1440x900 / 1180x900 /
// 390x844) sequentially and reports one summary. The smokes were promoted
// from throwaway tmp/ scripts after they caught regressions during the
// ui-v2 page-internals round; they intentionally reuse the existing
// fixture + Playwright setup — no new test framework.
//
// Usage: npm run smoke:ui-v2   (or: node scripts/smoke/ui-v2/run-all.mjs)
// Requires `npm run build` first — the smokes serve the built
// src/prepforge_chess/web/static tree.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL(".", import.meta.url));
// A smoke stuck waiting on the page fails instead of holding the CI job open.
// SIGTERM alone is not enough: Playwright's handler only closes the browser,
// and the smoke's fixture server keeps the process alive, so SIGKILL follows.
const SMOKE_TIMEOUT_MS = Number(process.env.UI_V2_SMOKE_TIMEOUT_MS || 4 * 60_000);
const KILL_GRACE_MS = 10_000;

// The view order follows the app's page order. "build" is the Repertoire
// workspace (the Build view).
const SUITE = [
  ["Library", "library-viewport-smoke.mjs"],
  ["Repertoire", "build-viewport-smoke.mjs"],
  ["Engine PV", "engine-pv-containment-smoke.mjs"],
  ["Train", "train-viewport-smoke.mjs"],
  ["Games", "games-viewport-smoke.mjs"],
  ["Scout", "scout-viewport-smoke.mjs"],
  ["Analyze", "analyze-viewport-smoke.mjs"],
  // Off-mainline Analyze: a selected variation node (not its mainline cousin of
  // the same move number) drives the board, caption, Coach and engine — through a
  // fast reversal and a reload. Production build only, no E2E hooks.
  ["Analyze variations", "analyze-variations-smoke.mjs"],
  ["Board rewind", "board-rewind-smoke.mjs"],
  // Last game / "you just finished a game": both entry paths orient the board,
  // the nudge goes when the same game is loaded, and returning to the tab
  // probes once per burst.
  ["Last game", "last-game-smoke.mjs"],
  ["Teams", "teams-viewport-smoke.mjs"],
  ["Settings", "settings-viewport-smoke.mjs"],
  // Nothing enters twice: re-renders, refreshes, returning to a view and the
  // view's own cross-fade never replay or stack an entrance; the Settings jump
  // lands under the sticky strip.
  ["Motion", "motion-smoke.mjs"],
  // Cross-view states: signed out, Library load errors, resize chunk hygiene,
  // mobile account-menu focus, Link Lichess → Connections.
  ["States", "states-smoke.mjs"],
  // Every dialog and menu is native: one modal, Tab kept inside, Escape closes
  // and hands focus back, phone dialogs on the bottom edge.
  ["Dialogs", "dialogs-smoke.mjs"],
];

// Each smoke serves its own port, so a few run side by side; output is held
// per smoke and printed in suite order so the log stays readable.
const CONCURRENCY = 3;

function runOne([label, file]) {
  return new Promise((resolve) => {
    const started = Date.now();
    let log = "";
    const child = spawn(process.execPath, [join(DIR, file)], { env: process.env });
    child.stdout.on("data", (chunk) => { log += chunk; });
    child.stderr.on("data", (chunk) => { log += chunk; });
    let killer;
    const timer = setTimeout(() => {
      log += `[ui-v2-smoke] ${label} timed out after ${SMOKE_TIMEOUT_MS / 60_000} min\n`;
      // Print what it got through now: a stuck smoke is the one whose log matters.
      process.stdout.write(`\n[ui-v2-smoke] ${label} (${file}) — timed out, log so far:\n${log}`);
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, SMOKE_TIMEOUT_MS);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      const ms = Date.now() - started;
      console.log(`[ui-v2-smoke] ${ok ? "ok  " : "FAIL"}  ${label} (${(ms / 1000).toFixed(1)}s)`);
      resolve({ label, file, ok, ms, log });
    };
    child.on("exit", (code) => done(code === 0));
    child.on("error", () => done(false));
  });
}

const results = new Array(SUITE.length);
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < SUITE.length) {
    const i = next++;
    results[i] = await runOne(SUITE[i]);
  }
}));
for (const r of results) {
  process.stdout.write(`\n[ui-v2-smoke] ${r.label} (${r.file})\n${r.log}`);
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
