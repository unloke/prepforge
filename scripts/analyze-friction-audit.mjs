// Analyze friction audit harness — collects UI evidence for the free-tier audit.
// Prerequisites (same DB as the API server):
//   $env:DATABASE_URL="sqlite:///dev.sqlite3"
//   .\.venv\Scripts\python.exe -m alembic upgrade head
//   .\.venv\Scripts\python.exe -m uvicorn prepforge_chess.api.main:app --host 127.0.0.1 --port 8000
//
//   node scripts/analyze-friction-audit.mjs
//
// Writes docs/analyze-friction-audit-evidence.json
// Exits 1 when any required signed-in scenario fails.
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_JSON = join(ROOT, "docs", "analyze-friction-audit-evidence.json");
const BASE = process.env.AUDIT_BASE_URL || "http://127.0.0.1:8000";
const ANALYSIS_TIMEOUT_MS = Number(process.env.AUDIT_ANALYSIS_TIMEOUT_MS || 180_000);

const DEMO_PGN = `[Event "PrepForge UI Demo"]
[Site "https://lichess.org/prepforge-ui"]
[Date "2026.05.25"]
[White "PrepForge"]
[Black "Demo"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

/** Signed-in E2E paths — audit fails (exit 1) if any of these do not pass. */
const REQUIRED_IDS = new Set([
  "1-signed-in/desktop-happy",
  "1-signed-in/mobile-375",
  "4-signed-in/long-task-stop-retry",
  "5-signed-in/handoff-no-repertoire",
]);

const evidence = {
  runAt: new Date().toISOString(),
  baseUrl: BASE,
  auth: { method: "register-via-api", credentialsInEvidence: false },
  paths: [],
  console: [],
  clientlogRequests: [],
  notes: [],
};

function record(path, scenario, result) {
  const id = `${path}/${scenario}`;
  evidence.paths.push({
    path,
    scenario,
    id,
    required: REQUIRED_IDS.has(id),
    ...result,
  });
}

function buildLongPgn(pairs = 24) {
  const moves = [];
  for (let i = 0; i < pairs; i += 1) {
    const n = i + 1;
    moves.push(i % 2 === 0 ? `${n}. Nf3 Nc6` : `${n}. Ng1 Nb8`);
  }
  return `[Event "Audit long"]\n[Result "*"]\n\n${moves.join(" ")} *`;
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

  async function preflightDatabase() {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.request.get(`${BASE}/api/csrf`);
      const csrfCookie = (await ctx.cookies()).find((c) => c.name === "pf_csrf");
      const csrf = csrfCookie?.value || "";
      const reg = await page.request.post(`${BASE}/api/auth/register`, {
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        data: {
          email: `audit-preflight-${Date.now()}@example.com`,
          password: "AuditPreflight12!",
          display_name: "Audit Preflight",
        },
      });
      if (!reg.ok()) {
        const body = await reg.text();
        if (reg.status() === 500 && /no such table/i.test(body)) {
          console.error("[analyze-friction-audit] Database not migrated (missing users table).");
          console.error('  $env:DATABASE_URL="sqlite:///dev.sqlite3"');
          console.error("  .\\.venv\\Scripts\\python.exe -m alembic upgrade head");
          process.exit(1);
        }
        throw new Error(`preflight register failed: ${reg.status()} ${body.slice(0, 200)}`);
      }
    } finally {
      await ctx.close();
    }
  }

  await preflightDatabase();

  function wirePage(page) {
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
  }

  async function newContext(viewport, coi = true) {
    const ctx = await browser.newContext({
      viewport,
      extraHTTPHeaders: coi ? {} : { "X-Audit-No-COI": "1" },
    });
    const page = await ctx.newPage();
    wirePage(page);
    return { ctx, page };
  }

  /** Register a throwaway user in the same browser context (cookies stay on origin). */
  async function createSignedInContext(viewport) {
    const { ctx, page } = await newContext(viewport);
    const stamp = Date.now();
    const email = `analyze-audit-${stamp}@example.com`;
    const password = `AuditPass-${stamp}!`;

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const csrfResp = await page.request.get(`${BASE}/api/csrf`);
    if (!csrfResp.ok()) {
      throw new Error(`csrf bootstrap failed: ${csrfResp.status()}`);
    }
    const csrfCookie = (await ctx.cookies()).find((c) => c.name === "pf_csrf");
    const csrf = csrfCookie?.value || "";
    const reg = await page.request.post(`${BASE}/api/auth/register`, {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      data: { email, password, display_name: "Analyze Audit" },
    });
    if (!reg.ok()) {
      throw new Error(`register failed: ${reg.status()} ${await reg.text()}`);
    }

    await page.reload({ waitUntil: "networkidle", timeout: 60000 });
    const statusResp = await page.request.get(`${BASE}/api/auth/status`);
    const status = await statusResp.json();
    if (!status.signed_in) {
      throw new Error("signed_in false after register reload");
    }

    evidence.auth.signedInVerified = true;
    evidence.auth.lastUserId = status.user_id || null;
    return { ctx, page, userId: status.user_id || null };
  }

  async function getAppStatus(page) {
    return page.evaluate(() => {
      const bar = document.querySelector('[data-testid="app-status"], .status');
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

  async function fillPgn(page, pgn) {
    await page.evaluate((text) => {
      const el = document.getElementById("pgn-input");
      if (!el) return;
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, pgn);
  }

  async function coiState(page) {
    return page.evaluate(() => ({
      crossOriginIsolated: self.crossOriginIsolated,
      runDisabled: document.getElementById("run-analysis")?.disabled ?? null,
      runTitle: document.getElementById("run-analysis")?.getAttribute("title") || "",
      runAriaDisabled: document.getElementById("run-analysis")?.getAttribute("aria-disabled") || "",
      runGated: document.getElementById("run-analysis")?.classList.contains("is-coming-soon"),
    }));
  }

  async function snapshotResults(page) {
    return page.evaluate(() => ({
      resultsVisible: !document.getElementById("analysis-results")?.hidden,
      resultsHasVisibleClass: document.getElementById("analysis-results")?.classList.contains("is-visible"),
      moveListChildCount: document.getElementById("analysis-moves")?.children.length || 0,
      summaryHasBars: !!document.querySelector("#analysis-summary .class-bars"),
      summaryText: (document.getElementById("analysis-summary")?.textContent || "").trim().slice(0, 120),
      status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
      booklineHidden: document.getElementById("coach-bookline")?.hidden,
      booklineText: (document.getElementById("coach-bookline")?.textContent || "").trim().slice(0, 120),
      coachProse: (document.getElementById("coach-prose")?.textContent || "").trim().slice(0, 120),
      handoffVisible: !document.getElementById("analysis-handoff")?.hidden,
      repertoireCta: !!document.querySelector('[data-testid="create-repertoire-from-game"]'),
      buildNav: !!document.querySelector('[data-testid="nav-build"]'),
      trainNav: !!document.querySelector('[data-testid="nav-train"]'),
    }));
  }

  // Locator-based waits — page.waitForFunction uses eval and fails under the SPA CSP.
  async function waitForAnalysisResults(page, timeout = ANALYSIS_TIMEOUT_MS) {
    await page.locator("#analysis-results").waitFor({ state: "visible", timeout });
    await page.locator("#analysis-moves > *").first().waitFor({ state: "attached", timeout });
    await page
      .locator("#analysis-summary .class-bars, #analysis-summary .cbar-row")
      .first()
      .waitFor({ state: "attached", timeout });
  }

  async function waitForJobStopButton(page, timeout = 120_000) {
    await page.locator(".job-toast-stop").waitFor({ state: "visible", timeout });
  }

  async function waitForRunRetryable(page, statusPattern, timeout = 90_000) {
    const btn = page.locator('[data-testid="run-analysis"]');
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const disabled = await btn.isDisabled();
      const status = await getAppStatus(page);
      if (!disabled && statusPattern.test(status)) return { status, runDisabled: disabled };
      await page.waitForTimeout(300);
    }
    throw new Error(`Timed out waiting for retryable run (wanted status ${statusPattern})`);
  }

  async function clickAnalyze(page) {
    await page.click('[data-testid="run-analysis"]');
  }

  // --- Path 1: Guest auth gate (desktop) ---
  {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      const coi = await coiState(page);
      await fillPgn(page, DEMO_PGN);
      await clickAnalyze(page);
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

  // --- Path 1b: Guest auth gate mobile 375px (touch target evidence) ---
  {
    const { ctx, page } = await newContext({ width: 375, height: 812 });
    try {
      await gotoAnalyze(page);
      await fillPgn(page, DEMO_PGN);
      await clickAnalyze(page);
      await page.waitForTimeout(800);
      const layout = await page.evaluate(() => {
        const run = document.getElementById("run-analysis");
        const rr = run?.getBoundingClientRect();
        return {
          runWidth: rr?.width,
          runHeight: rr?.height,
          viewportW: window.innerWidth,
          authModalOpen: !!document.querySelector(".auth-overlay"),
          resultsVisible: !document.getElementById("analysis-results")?.hidden,
          status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
          runDisabled: document.getElementById("run-analysis")?.disabled,
        };
      });
      record("1-happy-path", "mobile-375-guest", {
        expected: "Guest mobile Analyze opens sign-in modal; record touch target size",
        actual: layout,
        recovery: "Sign in via modal, then Analyze again",
        priority:
          layout.runHeight >= 44 ? "P3" : `P1 — Analyze button height ${layout.runHeight}px (<44px touch target)`,
        pass:
          layout.authModalOpen &&
          /sign in/i.test(layout.status) &&
          !layout.resultsVisible &&
          layout.runDisabled === false,
      });
    } catch (err) {
      record("1-happy-path", "mobile-375-guest", {
        expected: "Guest mobile auth gate",
        actual: { error: err.message },
        priority: "P1",
        pass: false,
      });
    }
    await ctx.close();
  }

  // --- Path 1c: Keyboard guest ---
  {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        testid: document.activeElement?.dataset?.testid,
      }));
      await fillPgn(page, DEMO_PGN);
      await page.focus('[data-testid="run-analysis"]');
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      const afterEnter = await page.evaluate(() => ({
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        runDisabled: document.getElementById("run-analysis")?.disabled,
        authModalOpen: !!document.querySelector(".auth-overlay"),
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
      record("1-happy-path", "keyboard-guest", { actual: { error: err.message }, pass: false, priority: "P2" });
    }
    await ctx.close();
  }

  // --- Path 1-signed-in: Desktop valid PGN → results (REQUIRED) ---
  {
    let ctx;
    let page;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await gotoAnalyze(page);
      const coi = await coiState(page);
      if (!coi.crossOriginIsolated) {
        throw new Error("crossOriginIsolated false — browser engine unavailable");
      }
      await fillPgn(page, DEMO_PGN);
      await clickAnalyze(page);
      await waitForAnalysisResults(page);
      const snap = await snapshotResults(page);
      record("1-signed-in", "desktop-happy", {
        expected: "Signed-in Analyze → move list + classification summary visible",
        actual: { ...snap, coi },
        recovery: "N/A on success",
        priority: "P3 — signed-in happy path",
        pass:
          snap.resultsVisible &&
          snap.moveListChildCount > 0 &&
          snap.summaryHasBars &&
          /analysis ready/i.test(snap.status),
      });
    } catch (err) {
      record("1-signed-in", "desktop-happy", {
        expected: "Signed-in desktop Analyze completes with results",
        actual: { error: err.message, status: page ? await getAppStatus(page) : "" },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 1-signed-in: Mobile 375px valid PGN → results (REQUIRED) ---
  {
    let ctx;
    let page;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 375, height: 812 }));
      await gotoAnalyze(page);
      await fillPgn(page, DEMO_PGN);
      await clickAnalyze(page);
      await waitForAnalysisResults(page);
      const layout = await page.evaluate(() => {
        const run = document.getElementById("run-analysis");
        const rr = run?.getBoundingClientRect();
        const snap = {
          runWidth: rr?.width,
          runHeight: rr?.height,
          viewportW: window.innerWidth,
          resultsVisible: !document.getElementById("analysis-results")?.hidden,
          moveListChildCount: document.getElementById("analysis-moves")?.children.length || 0,
          summaryHasBars: !!document.querySelector("#analysis-summary .class-bars"),
          status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        };
        return snap;
      });
      record("1-signed-in", "mobile-375", {
        expected: "Signed-in mobile Analyze completes; record button dimensions",
        actual: layout,
        recovery: "N/A on success",
        priority:
          layout.runHeight >= 44
            ? "P3 — signed-in mobile OK"
            : `P1 — Analyze button height ${layout.runHeight}px (<44px touch target)`,
        pass:
          layout.resultsVisible &&
          layout.moveListChildCount > 0 &&
          layout.summaryHasBars &&
          /analysis ready/i.test(layout.status),
      });
    } catch (err) {
      record("1-signed-in", "mobile-375", {
        expected: "Signed-in mobile Analyze completes with results",
        actual: { error: err.message },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 2: Import failures (guest) ---
  for (const [label, pgn] of [
    ["empty-pgn", ""],
    ["invalid-pgn", "not a pgn at all {{{"],
    ["huge-pgn", "1. e4 e5\n".repeat(8000)],
  ]) {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      await fillPgn(page, pgn);
      await clickAnalyze(page);
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
            : snap.status.length > 0 || snap.runDisabled === false;
      record("2-import-failure", label, {
        expected:
          label === "empty-pgn"
            ? "Status: Paste PGN before analyzing; no API call"
            : label === "invalid-pgn"
              ? "Guest: sign-in prompt before parse; button re-enabled"
              : "Graceful handling of very large input (no stuck UI)",
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

  // --- Path 3: Engine unavailable — inspect gated button only (no click) ---
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
      const snap = await page.evaluate(() => {
        const btn = document.getElementById("run-analysis");
        return {
          status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
          runDisabled: btn?.disabled ?? null,
          runAriaDisabled: btn?.getAttribute("aria-disabled") || "",
          runGated: btn?.classList.contains("is-coming-soon"),
          runTitle: btn?.getAttribute("title") || "",
        };
      });
      record("3-engine-unavailable", "no-coi", {
        expected: "crossOriginIsolated false → button disabled/aria-disabled with recovery title (no click)",
        actual: { ...snap, coi },
        recovery: "Use COOP/COEP-capable browser/host; Settings shows engine status",
        priority: snap.runGated && snap.runDisabled ? "P2 — gating OK" : "P1 — unclear engine gate",
        pass:
          !coi.crossOriginIsolated &&
          snap.runDisabled === true &&
          snap.runAriaDisabled === "true" &&
          /unavailable|cross-origin/i.test(snap.runTitle),
      });
    } catch (err) {
      record("3-engine-unavailable", "no-coi", { actual: { error: err.message }, pass: false, priority: "P1" });
    }
    await ctx.close();
  }

  // --- Path 4-signed-in: Long task progress, Stop, retry (REQUIRED) ---
  {
    let ctx;
    let page;
    const longPgn = buildLongPgn(24);
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await gotoAnalyze(page);
      await fillPgn(page, longPgn);
      await clickAnalyze(page);

      await waitForJobStopButton(page);
      const during = await page.evaluate(() => ({
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        toast: (document.querySelector(".job-toast")?.textContent || "").slice(0, 160),
        stopVisible: !!document.querySelector(".job-toast-stop"),
        runDisabled: document.getElementById("run-analysis")?.disabled,
      }));

      await page.locator(".job-toast-stop").first().click();
      const afterStop = await waitForRunRetryable(page, /stopped/i);
      afterStop.resultsHidden = await page.evaluate(
        () => document.getElementById("analysis-results")?.hidden,
      );

      await fillPgn(page, DEMO_PGN);
      await clickAnalyze(page);
      await waitForAnalysisResults(page);
      const afterRetry = await snapshotResults(page);

      record("4-signed-in", "long-task-stop-retry", {
        expected: "Progress visible; Stop cancels; button re-enabled; short PGN retry succeeds",
        actual: { during, afterStop, afterRetry },
        recovery: "Stop then Analyze again",
        priority: "P3 — long-task controls OK",
        pass:
          during.stopVisible &&
          /stopped/i.test(afterStop.status) &&
          afterStop.runDisabled === false &&
          afterRetry.resultsVisible &&
          afterRetry.moveListChildCount > 0,
      });
    } catch (err) {
      record("4-signed-in", "long-task-stop-retry", {
        expected: "Signed-in long task Stop + retry",
        actual: { error: err.message },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 5-signed-in: Handoff CTA + create repertoire (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Handoff ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await gotoAnalyze(page);
      await fillPgn(page, DEMO_PGN);
      await clickAnalyze(page);
      await waitForAnalysisResults(page);
      const beforeClick = await snapshotResults(page);
      if (!beforeClick.handoffVisible || !beforeClick.repertoireCta) {
        throw new Error("create-repertoire CTA not visible after fresh-user analysis");
      }

      await page.click('[data-testid="create-repertoire-from-game"]');
      await page.locator(".modal-overlay").waitFor({ state: "visible", timeout: 10000 });
      await page.fill('.modal-overlay input[name="name"]', repName);
      await page.click('.modal-overlay [data-action="ok"]');
      await page.locator("#view-build.is-active").waitFor({ state: "attached", timeout: 60000 });
      await page.locator("#build-rep-name", { hasText: repName }).waitFor({ timeout: 30000 });

      const afterCreate = await page.evaluate((expectedName) => ({
        viewBuildActive: document.getElementById("view-build")?.classList.contains("is-active"),
        buildRepName: document.getElementById("build-rep-name")?.textContent?.trim() || "",
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        handoffHidden: document.getElementById("analysis-handoff")?.hidden,
      }), repName);

      record("5-signed-in", "handoff-no-repertoire", {
        expected:
          "Fresh user: CTA visible after analysis; click creates repertoire via import-pgn and opens Build",
        actual: { beforeClick, afterCreate, repName },
        recovery: "Retry Create on analysis results panel",
        priority: afterCreate.viewBuildActive ? "P3 — handoff OK" : "P1 — handoff broken",
        pass:
          beforeClick.handoffVisible &&
          beforeClick.repertoireCta &&
          afterCreate.viewBuildActive &&
          afterCreate.buildRepName.includes(repName) &&
          /created|imported|editing/i.test(afterCreate.status),
      });
    } catch (err) {
      record("5-signed-in", "handoff-no-repertoire", {
        expected: "Signed-in handoff CTA and repertoire creation",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 4 guest gate (informational) ---
  {
    const longPgn = buildLongPgn(8);
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    try {
      await gotoAnalyze(page);
      await fillPgn(page, longPgn);
      await clickAnalyze(page);
      await page.waitForTimeout(800);
      const snap = await page.evaluate(() => ({
        status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        authModalOpen: !!document.querySelector(".auth-overlay"),
        runDisabled: document.getElementById("run-analysis")?.disabled,
      }));
      record("4-long-task", "guest-auth-gate", {
        expected: "Guest blocked before long job; sign-in modal",
        actual: snap,
        recovery: "Sign in for progress/Stop audit",
        priority: snap.authModalOpen ? "P3 — guest gate OK" : "P1",
        pass: snap.authModalOpen && /sign in/i.test(snap.status) && snap.runDisabled === false,
      });
    } catch (err) {
      record("4-long-task", "guest-auth-gate", { actual: { error: err.message }, pass: false, priority: "P1" });
    }
    await ctx.close();
  }

  await browser.close();

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(evidence, null, 2));

  const passed = evidence.paths.filter((p) => p.pass).length;
  const total = evidence.paths.length;
  const required = evidence.paths.filter((p) => p.required);
  const requiredFailed = required.filter((p) => !p.pass);

  console.log(`[analyze-friction-audit] recorded ${total} scenarios (${passed} pass flags)`);
  console.log(`[analyze-friction-audit] required signed-in: ${required.length - requiredFailed.length}/${required.length} passed`);
  console.log(`[analyze-friction-audit] evidence → ${OUT_JSON}`);
  console.log(`[analyze-friction-audit] clientlog beacons: ${evidence.clientlogRequests.length}`);
  console.log(`[analyze-friction-audit] console messages: ${evidence.console.length}`);

  if (requiredFailed.length) {
    console.error("[analyze-friction-audit] FAIL: required signed-in scenarios:");
    for (const row of requiredFailed) {
      console.error(`  - ${row.id}: ${row.actual?.error || row.priority || "failed"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[analyze-friction-audit] FAIL: ${err.message}`);
  process.exit(1);
});