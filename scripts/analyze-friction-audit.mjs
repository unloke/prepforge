// Analyze friction audit harness — collects UI evidence for the free-tier audit.
// Run with API server up: uvicorn prepforge_chess.api.main:app (port 8000).
//
//   node scripts/analyze-friction-audit.mjs
//
// Writes docs/analyze-friction-audit-evidence.json
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_JSON = join(ROOT, "docs", "analyze-friction-audit-evidence.json");
const BASE = process.env.AUDIT_BASE_URL || "http://127.0.0.1:8000";
const DEMO_PGN = `[Event "PrepForge UI Demo"]
[Site "https://lichess.org/prepforge-ui"]
[Date "2026.05.25"]
[White "PrepForge"]
[Black "Demo"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

const evidence = {
  runAt: new Date().toISOString(),
  baseUrl: BASE,
  paths: [],
  console: [],
  clientlogRequests: [],
  notes: [],
};

function record(path, scenario, result) {
  evidence.paths.push({ path, scenario, ...result });
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("playwright required: npx playwright install chromium");
    process.exit(1);
  }

  let browser;
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      break;
    } catch {
      /* try next */
    }
  }
  if (!browser) {
    console.error("no Chromium browser available");
    process.exit(1);
  }

  async function newContext(viewport, coi = true) {
    const ctx = await browser.newContext({
      viewport,
      extraHTTPHeaders: coi
        ? {}
        : { "X-Audit-No-COI": "1" },
    });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      evidence.console.push({
        type: msg.type(),
        text: msg.text(),
        t: Date.now(),
      });
    });
    page.on("request", (req) => {
      if (req.url().includes("/api/clientlog")) {
        evidence.clientlogRequests.push({
          url: req.url(),
          method: req.method(),
          t: Date.now(),
        });
      }
    });
    return { ctx, page };
  }

  async function statusText(page) {
    const el = page.locator("#status, .status, [data-testid='status']").first();
    if (await el.count()) return (await el.textContent())?.trim() || "";
    return (await page.evaluate(() => {
      const s = document.querySelector(".status-bar, #app-status");
      return s ? s.textContent.trim() : "";
    })) || "";
  }

  async function getAppStatus(page) {
    return page.evaluate(() => {
      const bar = document.querySelector(".status");
      return bar ? bar.textContent.trim() : "";
    });
  }

  async function gotoAnalyze(page) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 });
    await page.click('[data-testid="nav-analyze"]');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const drawer = document.getElementById("pgn-drawer");
      if (drawer) drawer.open = true;
    });
  }

  async function coiState(page) {
    return page.evaluate(() => ({
      crossOriginIsolated: self.crossOriginIsolated,
      runDisabled: document.getElementById("run-analysis")?.disabled ?? null,
      runTitle: document.getElementById("run-analysis")?.getAttribute("title") || "",
    }));
  }

  // --- Path 1: Guest auth gate (desktop) — P0 recovery UX ---
  {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      const coi = await coiState(page);
      await page.fill('[data-testid="pgn-input"]', DEMO_PGN);
      await page.click('[data-testid="run-analysis"]');
      await page.waitForTimeout(800);
      const snap = await page.evaluate(() => ({
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        authModalOpen: !!document.querySelector(".auth-overlay"),
        resultsVisible: !document.getElementById("analysis-results")?.hidden,
        runDisabled: document.getElementById("run-analysis")?.disabled,
      }));
      record("1-happy-path", "desktop-1280-guest", {
        expected: "Guest Analyze opens sign-in modal with actionable status (not raw 401)",
        actual: { ...snap, coi },
        recovery: "Sign in via modal, then Analyze again",
        priority: snap.authModalOpen ? "P3 — auth gate OK" : "P0 — no sign-in CTA",
        pass:
          snap.authModalOpen &&
          /sign in/i.test(snap.status) &&
          !snap.resultsVisible &&
          snap.runDisabled === false,
      });
    } catch (err) {
      record("1-happy-path", "desktop-1280-guest", {
        expected: "Guest Analyze prompts sign-in",
        actual: { error: err.message, status: await getAppStatus(page) },
        priority: "P0",
        pass: false,
      });
    }
    await ctx.close();
  }

  // --- Path 1b: Guest auth gate mobile 375px ---
  {
    const { ctx, page } = await newContext({ width: 375, height: 812 });
    try {
      await gotoAnalyze(page);
      await page.fill('[data-testid="pgn-input"]', DEMO_PGN);
      await page.click('[data-testid="run-analysis"]');
      await page.waitForTimeout(800);
      const layout = await page.evaluate(() => {
        const run = document.getElementById("run-analysis");
        const pgn = document.getElementById("pgn-input");
        const rr = run?.getBoundingClientRect();
        const pr = pgn?.getBoundingClientRect();
        return {
          runWidth: rr?.width,
          runHeight: rr?.height,
          pgnWidth: pr?.width,
          viewportW: window.innerWidth,
          authModalOpen: !!document.querySelector(".auth-overlay"),
          resultsVisible: !document.getElementById("analysis-results")?.hidden,
          status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
          runDisabled: document.getElementById("run-analysis")?.disabled,
        };
      });
      record("1-happy-path", "mobile-375-guest", {
        expected: "Guest mobile Analyze opens sign-in modal; touch targets usable",
        actual: layout,
        recovery: "Sign in via modal, then Analyze again",
        priority: layout.runWidth >= 44 && layout.runHeight >= 36 ? "P3" : "P1 — touch targets",
        pass:
          layout.authModalOpen &&
          /sign in/i.test(layout.status) &&
          !layout.resultsVisible &&
          layout.runDisabled === false &&
          layout.runWidth >= 40,
      });
    } catch (err) {
      record("1-happy-path", "mobile-375", {
        expected: "Mobile analyze completes",
        actual: { error: err.message },
        priority: "P1",
        pass: false,
      });
    }
    await ctx.close();
  }

  // --- Path 1c: Keyboard ---
  {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      await page.keyboard.press("Tab");
      let focused = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        id: document.activeElement?.id,
        testid: document.activeElement?.dataset?.testid,
      }));
      await page.fill('[data-testid="pgn-input"]', DEMO_PGN);
      await page.focus('[data-testid="run-analysis"]');
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      const afterEnter = await page.evaluate(() => ({
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        runDisabled: document.getElementById("run-analysis")?.disabled,
        authModalOpen: !!document.querySelector(".auth-overlay"),
        activeId: document.activeElement?.id,
      }));
      record("1-happy-path", "keyboard-guest", {
        expected: "Enter on focused Analyze opens sign-in for guest; button stays enabled",
        actual: { initialFocus: focused, afterEnter },
        recovery: "Complete sign-in in modal, then retry Analyze",
        priority: afterEnter.authModalOpen ? "P3 — keyboard auth gate OK" : "P1 — Enter does not activate Analyze",
        pass:
          afterEnter.authModalOpen &&
          /sign in/i.test(afterEnter.status) &&
          afterEnter.runDisabled === false,
      });
    } catch (err) {
      record("1-happy-path", "keyboard", { actual: { error: err.message }, pass: false, priority: "P2" });
    }
    await ctx.close();
  }

  // --- Path 2: Import failures ---
  for (const [label, pgn, expectSubstr] of [
    ["empty-pgn", "", "Paste PGN"],
    ["invalid-pgn", "not a pgn at all {{{", "parse"],
    ["huge-pgn", "1. e4 e5\n".repeat(8000), ""],
  ]) {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      if (pgn) await page.fill('[data-testid="pgn-input"]', pgn);
      else await page.fill('[data-testid="pgn-input"]', "");
      await page.click('[data-testid="run-analysis"]');
      await page.waitForTimeout(2500);
      const snap = await page.evaluate(() => ({
        status: document.querySelector(".status")?.textContent?.trim() || "",
        resultsHidden: document.getElementById("analysis-results")?.hidden,
        runDisabled: document.getElementById("run-analysis")?.disabled,
      }));
      const authModal = await page.evaluate(() => !!document.querySelector(".auth-overlay"));
      const ok =
        label === "empty-pgn"
          ? /paste pgn/i.test(snap.status)
          : label === "invalid-pgn"
            ? authModal && /sign in/i.test(snap.status)
            : snap.status.length > 0;
      record("2-import-failure", label, {
        expected:
          label === "empty-pgn"
            ? "Status: Paste PGN before analyzing; no API call"
            : label === "invalid-pgn"
              ? "Guest: sign-in prompt before parse; button re-enabled"
              : "Graceful handling of very large input",
        actual: { ...snap, authModal },
        recovery:
          label === "empty-pgn"
            ? "Open PGN drawer and paste"
            : "Sign in, then fix PGN if needed",
        priority: ok ? "P3" : "P1 — unclear error or stuck UI",
        pass: ok && snap.runDisabled === false,
      });
    } catch (err) {
      record("2-import-failure", label, { actual: { error: err.message }, pass: false, priority: "P1" });
    }
    await ctx.close();
  }

  // --- Path 3: Engine unavailable (strip COI via route) ---
  {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    await ctx.route("**/*", async (route) => {
      const headers = { ...route.request().headers() };
      delete headers["cross-origin-opener-policy"];
      delete headers["cross-origin-embedder-policy"];
      const response = await route.fetch({ headers });
      const newHeaders = { ...response.headers() };
      delete newHeaders["cross-origin-opener-policy"];
      delete newHeaders["cross-origin-embedder-policy"];
      await route.fulfill({ response, headers: newHeaders });
    });
    try {
      await gotoAnalyze(page);
      const coi = await coiState(page);
      await page.fill('[data-testid="pgn-input"]', DEMO_PGN);
      await page.click('[data-testid="run-analysis"]');
      await page.waitForTimeout(1500);
      const snap = await page.evaluate(() => ({
        status: document.querySelector(".status")?.textContent?.trim() || "",
        runDisabled: document.getElementById("run-analysis")?.disabled,
        runGated: document.getElementById("run-analysis")?.classList.contains("is-coming-soon"),
        runTitle: document.getElementById("run-analysis")?.getAttribute("title") || "",
      }));
      record("3-engine-unavailable", "no-coi", {
        expected: "crossOriginIsolated false → gated message with recovery hint",
        actual: { ...snap, coi },
        recovery: "Use COOP/COEP-capable browser/host; Settings shows engine status",
        priority: /unavailable|cross-origin/i.test(snap.status) || snap.runGated ? "P2 — message exists" : "P0 — silent fail",
        pass: !coi.crossOriginIsolated && (snap.runGated || /unavailable/i.test(snap.status)),
      });
    } catch (err) {
      record("3-engine-unavailable", "no-coi", { actual: { error: err.message }, pass: false, priority: "P0" });
    }
    await ctx.close();
  }

  // --- Path 4: Guest auth gate (long-task path deferred until signed-in smoke) ---
  {
    const longPgn =
      "[Event \"Long\"]\n\n" +
      Array.from({ length: 40 }, (_, i) => `${i + 1}. e4 e5`).join(" ") +
      " 1-0";
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      await page.fill('[data-testid="pgn-input"]', longPgn);
      await page.click('[data-testid="run-analysis"]');
      await page.waitForTimeout(800);
      const snap = await page.evaluate(() => ({
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        authModalOpen: !!document.querySelector(".auth-overlay"),
        runDisabled: document.getElementById("run-analysis")?.disabled,
        resultsHidden: document.getElementById("analysis-results")?.hidden,
      }));
      record("4-long-task", "guest-auth-gate", {
        expected: "Guest blocked before long job; sign-in modal; button re-enabled for retry",
        actual: snap,
        recovery: "Sign in, then re-run Analyze for progress/Stop audit",
        priority: snap.authModalOpen ? "P3 — deferred to signed-in smoke" : "P1 — guest can start uncancellable job",
        pass:
          snap.authModalOpen &&
          /sign in/i.test(snap.status) &&
          snap.runDisabled === false &&
          snap.resultsHidden !== false,
      });
    } catch (err) {
      record("4-long-task", "progress-and-stop", { actual: { error: err.message }, pass: false, priority: "P1" });
    }
    await ctx.close();
  }

  // --- Path 5: Result handoff (guest — auth gate before results) ---
  {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      await page.fill('[data-testid="pgn-input"]', DEMO_PGN);
      await page.click('[data-testid="run-analysis"]');
      await page.waitForTimeout(800);
      const handoff = await page.evaluate(() => ({
        authModalOpen: !!document.querySelector(".auth-overlay"),
        booklineHidden: document.getElementById("coach-bookline")?.hidden,
        booklineText: document.getElementById("coach-bookline")?.textContent?.slice(0, 100) || "",
        trainNav: !!document.querySelector('[data-testid="nav-train"]'),
        buildNav: !!document.querySelector('[data-testid="nav-build"]'),
        resultsHidden: document.getElementById("analysis-results")?.hidden,
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
      }));
      record("5-handoff", "guest-before-results", {
        expected: "Guest sees sign-in CTA; Build/Train nav still reachable; bookline deferred",
        actual: handoff,
        recovery: "Sign in → analyze → bookline chips when repertoire exists",
        priority: handoff.authModalOpen && handoff.trainNav && handoff.buildNav ? "P2 — manual nav OK" : "P1",
        pass:
          handoff.authModalOpen &&
          /sign in/i.test(handoff.status) &&
          handoff.resultsHidden !== false &&
          handoff.trainNav &&
          handoff.buildNav,
      });
    } catch (err) {
      record("5-handoff", "unsigned-after-analysis", { actual: { error: err.message }, pass: false, priority: "P1" });
    }
    await ctx.close();
  }

  await browser.close();

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(evidence, null, 2));
  const passed = evidence.paths.filter((p) => p.pass).length;
  const total = evidence.paths.length;
  console.log(`[analyze-friction-audit] recorded ${total} scenarios (${passed} pass flags)`);
  console.log(`[analyze-friction-audit] evidence → ${OUT_JSON}`);
  console.log(`[analyze-friction-audit] clientlog beacons: ${evidence.clientlogRequests.length}`);
  console.log(`[analyze-friction-audit] console messages: ${evidence.console.length}`);
}

main().catch((err) => {
  console.error(`[analyze-friction-audit] FAIL: ${err.message}`);
  process.exit(1);
});