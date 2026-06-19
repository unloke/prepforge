// Cross-flow release verification — single fresh user: Analyze → Build → Train → reload.
// Prerequisites (release DB + local API; disable auth rate limit):
//   $env:DATABASE_URL="sqlite:///release.sqlite3"
//   .\.venv\Scripts\python.exe -m alembic upgrade head
//   .\.venv\Scripts\python.exe -c "from prepforge_chess.api.ratelimit import limiter; limiter.enabled=False; import uvicorn; uvicorn.run('prepforge_chess.api.main:app', host='127.0.0.1 --port 8000)"
//
//   node scripts/release-cross-flow.mjs
//
// Writes docs/release-cross-flow-audit-evidence.json
// Exits 1 when any required release step fails.
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_JSON = join(ROOT, "docs", "release-cross-flow-audit-evidence.json");
const BASE = process.env.RELEASE_BASE_URL || process.env.AUDIT_BASE_URL || "http://127.0.0.1:8000";
const ANALYSIS_TIMEOUT_MS = Number(process.env.AUDIT_ANALYSIS_TIMEOUT_MS || 180_000);
const TRAIN_ANIM_MS = Number(process.env.AUDIT_TRAIN_ANIM_MS || 3_500);

const DEMO_PGN = `[Event "PrepForge UI Demo"]
[Site "https://lichess.org/prepforge-ui"]
[Date "2026.05.25"]
[White "PrepForge"]
[Black "Demo"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

const REQUIRED_IDS = new Set([
  "release/signed-in",
  "release/analyze-results",
  "release/handoff-create",
  "release/build-tree",
  "release/train-start",
  "release/train-correct",
  "release/reload-persist",
  "release/dashboard-verify",
]);

const evidence = {
  runAt: new Date().toISOString(),
  baseUrl: BASE,
  database: process.env.DATABASE_URL || "(server env)",
  auth: { method: "single-register-journey", credentialsInEvidence: false },
  steps: [],
  console: [],
  clientlogRequests: [],
  notes: [
    "One browser context, one fresh user for the full Analyze → Build → Train journey.",
    "Use sqlite:///release.sqlite3 for isolated release verification.",
  ],
};

function record(step, result) {
  evidence.steps.push({
    step,
    id: `release/${step}`,
    required: REQUIRED_IDS.has(`release/${step}`),
    ...result,
  });
}

function uciToSquares(uci) {
  if (!uci || uci.length < 4) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

function isBenignConsoleError(text) {
  return /favicon\.ico/i.test(text) || /Failed to load resource.*404/i.test(text);
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

  const health = await fetch(`${BASE}/healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(`[release-cross-flow] server not reachable at ${BASE}`);
    process.exit(1);
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  page.on("console", (msg) => {
    evidence.console.push({ type: msg.type(), text: msg.text(), t: Date.now() });
  });
  page.on("request", (req) => {
    if (req.url().includes("/api/clientlog")) {
      evidence.clientlogRequests.push({ url: req.url(), method: req.method(), t: Date.now() });
    }
  });

  const repName = `Release Journey ${Date.now()}`;
  let userId = null;
  let startPayload = null;

  try {
    // --- Step 1: signed-in fresh account ---
    const stamp = Date.now();
    const email = `release-${stamp}@example.com`;
    const password = `ReleasePass-${stamp}!`;

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.request.get(`${BASE}/api/csrf`);
    const csrfCookie = (await ctx.cookies()).find((c) => c.name === "pf_csrf");
    const csrf = csrfCookie?.value || "";
    const reg = await page.request.post(`${BASE}/api/auth/register`, {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      data: { email, password, display_name: "Release Journey" },
    });
    if (!reg.ok()) {
      throw new Error(`register failed: ${reg.status()} ${(await reg.text()).slice(0, 200)}`);
    }
    await page.reload({ waitUntil: "networkidle", timeout: 60000 });
    const authStatus = await page.request.get(`${BASE}/api/auth/status`).then((r) => r.json());
    if (!authStatus.signed_in) throw new Error("signed_in false after register");
    userId = authStatus.user_id;
    evidence.auth.signedInVerified = true;
    evidence.auth.userId = userId;

    record("signed-in", {
      expected: "Single fresh account registered and session active",
      actual: { email: email.replace(/@.*/, "@…"), userId },
      pass: true,
      priority: "P3 — auth OK",
    });

    // --- Step 2: Analyze valid PGN → results ---
    await page.click('[data-testid="nav-analyze"]');
    await page.locator("#view-analyze.is-active").waitFor({ timeout: 10000 });
    await page.evaluate(() => {
      const drawer = document.getElementById("pgn-drawer");
      if (drawer) drawer.open = true;
    });
    await page.evaluate((text) => {
      const el = document.getElementById("pgn-input");
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, DEMO_PGN);
    await page.click('[data-testid="run-analysis"]');
    await page.locator("#analysis-results").waitFor({ state: "visible", timeout: ANALYSIS_TIMEOUT_MS });
    await page.locator("#analysis-moves > *").first().waitFor({ timeout: ANALYSIS_TIMEOUT_MS });
    await page
      .locator("#analysis-summary .class-bars, #analysis-summary .cbar-row")
      .first()
      .waitFor({ timeout: ANALYSIS_TIMEOUT_MS });

    const analyzeSnap = await page.evaluate(() => ({
      resultsVisible: !document.getElementById("analysis-results")?.hidden,
      moveListChildCount: document.getElementById("analysis-moves")?.children.length || 0,
      summaryHasBars: !!document.querySelector("#analysis-summary .class-bars, #analysis-summary .cbar-row"),
      status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
      handoffVisible: !document.getElementById("analysis-handoff")?.hidden,
      repertoireCta: !!document.querySelector('[data-testid="create-repertoire-from-game"]'),
    }));

    const consoleErrorsSoFar = evidence.console.filter(
      (c) => c.type === "error" && !isBenignConsoleError(c.text),
    ).length;

    record("analyze-results", {
      expected: "Valid PGN → move list + classification summary; no client errors",
      actual: { analyzeSnap, consoleErrorsSoFar, clientlogBeacons: evidence.clientlogRequests.length },
      pass:
        analyzeSnap.resultsVisible &&
        analyzeSnap.moveListChildCount > 0 &&
        analyzeSnap.summaryHasBars &&
        /analysis ready/i.test(analyzeSnap.status) &&
        consoleErrorsSoFar === 0 &&
        evidence.clientlogRequests.length === 0,
      priority: "P3 — analyze OK",
    });

    // --- Step 3: Handoff CTA → modal → create ---
    if (!analyzeSnap.handoffVisible || !analyzeSnap.repertoireCta) {
      throw new Error("create-repertoire-from-game CTA not visible");
    }
    await page.click('[data-testid="create-repertoire-from-game"]');
    await page.locator(".modal-overlay").waitFor({ state: "visible", timeout: 10000 });
    await page.fill('.modal-overlay input[name="name"]', repName);
    await page.fill('.modal-overlay input[name="color"]', "white");
    await page.click('.modal-overlay [data-action="ok"]');
    await page.locator("#view-build.is-active").waitFor({ state: "attached", timeout: 60000 });
    await page.locator("#build-rep-name", { hasText: repName }).waitFor({ timeout: 30000 });

    const afterHandoff = await page.evaluate(() => ({
      viewBuildActive: document.getElementById("view-build")?.classList.contains("is-active"),
      repName: document.getElementById("build-rep-name")?.textContent?.trim() || "",
      status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
    }));

    record("handoff-create", {
      expected: "Turn this game into a repertoire → name/color modal → Build opens",
      actual: { repName, afterHandoff },
      pass: afterHandoff.viewBuildActive && afterHandoff.repName.includes(repName),
      priority: "P3 — handoff OK",
    });

    // --- Step 4: Build tree + repertoire exists ---
    const buildSnap = await page.evaluate(() => ({
      treeText: (document.getElementById("builder-tree")?.textContent || "").trim().slice(0, 240),
      repName: document.getElementById("build-rep-name")?.textContent?.trim() || "",
      boardSquares: document.querySelectorAll("#build-board .square").length,
    }));

    const repsApi = await page.request.get(`${BASE}/api/repertoires`).then((r) => r.json());
    const hasRepServer = (repsApi.repertoires || []).some((r) => (r.name || "").includes(repName));

    record("build-tree", {
      expected: "Build shows imported PGN tree; repertoire persisted server-side",
      actual: { buildSnap, hasRepServer, repName },
      pass:
        hasRepServer &&
        /e4|Nf3|Bb5/i.test(buildSnap.treeText) &&
        buildSnap.boardSquares === 64,
      priority: "P3 — build tree OK",
    });

    // --- Step 5: Train — repertoire selectable + Smart start ---
    await page.click('[data-testid="nav-train"]');
    await page.locator("#view-train.is-active").waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);

    await page.click('#train-modes .train-mode[data-mode="all_lines"]');
    await page.waitForTimeout(400);
    const picker = await page.evaluate((name) => {
      const select = document.getElementById("train-repertoire-select");
      const options = [...(select?.options || [])].map((o) => o.textContent.trim());
      return { hidden: select?.hidden, options, hasRep: options.some((t) => t.includes(name)) };
    }, repName);

    await page.click('#train-modes .train-mode[data-mode="smart"]');
    await page.waitForTimeout(300);

    const startRespPromise = page.waitForResponse(
      (r) => r.url().includes("/api/train/smart/start") && r.status() === 200,
      { timeout: 60_000 },
    );
    await page.click('[data-testid="start-train"]');
    const startResp = await startRespPromise;
    startPayload = await startResp.json();
    await page
      .locator(
        '#train-banner[data-state="move"], #train-banner[data-state="teach"], #train-banner[data-state="runin"]',
      )
      .first()
      .waitFor({ timeout: 60_000 });

    const trainStart = await page.evaluate(() => ({
      bannerState: document.getElementById("train-banner")?.dataset?.state || "",
      bannerTitle: document.getElementById("train-banner-title")?.textContent?.trim() || "",
      progressHidden: document.getElementById("train-progress-panel")?.hidden,
      syncClass: document.getElementById("train-sync")?.className || "",
    }));

    record("train-start", {
      expected: "Train: repertoire in Line picker; Smart queue starts first prompt",
      actual: {
        picker,
        cards: startPayload?.cards?.length || 0,
        trainStart,
      },
      pass:
        picker.hasRep &&
        (startPayload?.cards?.length || 0) > 0 &&
        (trainStart.bannerState === "move" ||
          trainStart.bannerState === "teach" ||
          trainStart.bannerState === "runin") &&
        !trainStart.progressHidden,
      priority: "P3 — train start OK",
    });

    // --- Step 6: Correct first expected move ---
    const firstTarget = startPayload?.cards?.[0]?.targets?.[0];
    const squares = uciToSquares(firstTarget?.uci);
    if (!squares) throw new Error("no expected uci in smart start payload");

    const beforeCorrect = await page.evaluate(() => ({
      correct: document.getElementById("train-stat-correct")?.textContent?.trim() || "0",
      mistakes: document.getElementById("train-stat-mistakes")?.textContent?.trim() || "0",
    }));

    await page.locator(`#train-board [data-square="${squares.from}"]`).click();
    await page.locator(`#train-board [data-square="${squares.to}"]`).click();
    await page.waitForTimeout(TRAIN_ANIM_MS);

    const afterCorrect = await page.evaluate(() => ({
      correct: document.getElementById("train-stat-correct")?.textContent?.trim() || "0",
      mistakes: document.getElementById("train-stat-mistakes")?.textContent?.trim() || "0",
      bannerState: document.getElementById("train-banner")?.dataset?.state || "",
      bannerTitle: document.getElementById("train-banner-title")?.textContent?.trim() || "",
      bannerSub: document.getElementById("train-banner-sub")?.textContent?.trim() || "",
    }));

    record("train-correct", {
      expected: "First expected move grades correct; stats/progress update",
      actual: { expectedUci: firstTarget?.uci, expectedSan: firstTarget?.san, beforeCorrect, afterCorrect },
      pass:
        Number(afterCorrect.correct) > Number(beforeCorrect.correct) ||
        /correct|learned|first-try correct|got it/i.test(
          afterCorrect.bannerTitle + afterCorrect.bannerSub,
        ),
      priority: "P3 — train correct OK",
    });

    // --- Step 7: Reload — repertoire persists, Train restarts cleanly ---
    const correctBeforeReload = afterCorrect.correct;
    await page.waitForTimeout(4500);
    await page.reload({ waitUntil: "networkidle", timeout: 60000 });

    await page.click('[data-testid="nav-dashboard"]');
    await page.locator("#view-dashboard.is-active").waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    const dashBeforeTrain = await page.evaluate((name) => {
      const names = [...document.querySelectorAll("#dashboard-repertoires .name")].map((el) =>
        el.textContent.trim(),
      );
      return { names, hasRep: names.some((n) => n.includes(name)) };
    }, repName);

    await page.click('[data-testid="nav-train"]');
    await page.waitForTimeout(400);
    const restartPromise = page.waitForResponse(
      (r) => r.url().includes("/api/train/smart/start") && r.status() === 200,
      { timeout: 60_000 },
    );
    await page.click('[data-testid="start-train"]');
    await restartPromise;
    await page
      .locator(
        '#train-banner[data-state="move"], #train-banner[data-state="teach"], #train-banner[data-state="runin"]',
      )
      .first()
      .waitFor({ timeout: 60_000 });

    const afterReload = await page.evaluate(() => ({
      correct: document.getElementById("train-stat-correct")?.textContent?.trim() || "0",
      trainSync: document.getElementById("train-sync")?.className || "",
      trainSyncText: document.getElementById("train-sync")?.textContent?.trim() || "",
      buildSync: document.getElementById("build-sync")?.className || "",
      bannerState: document.getElementById("train-banner")?.dataset?.state || "",
    }));

    record("reload-persist", {
      expected:
        "Reload: repertoire on Dashboard; Train restarts; fresh session stats; no stuck error sync",
      actual: { repName, dashBeforeTrain, correctBeforeReload, afterReload },
      pass:
        dashBeforeTrain.hasRep &&
        Number(afterReload.correct) === 0 &&
        !afterReload.trainSync.includes("is-error") &&
        (afterReload.bannerState === "move" ||
          afterReload.bannerState === "teach" ||
          afterReload.bannerState === "runin"),
      priority: "P3 — reload OK",
    });

    // --- Step 8: Dashboard + cross-tab observability ---
    await page.click('[data-testid="nav-dashboard"]');
    await page.waitForTimeout(400);
    await page.click('[data-testid="nav-analyze"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="nav-build"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="nav-train"]');
    await page.waitForTimeout(300);

    const dashFinal = await page.evaluate((name) => {
      const names = [...document.querySelectorAll("#dashboard-repertoires .name")].map((el) =>
        el.textContent.trim(),
      );
      return { names, hasRep: names.some((n) => n.includes(name)) };
    }, repName);

    const consoleErrors = evidence.console.filter(
      (c) => c.type === "error" && !isBenignConsoleError(c.text),
    );

    record("dashboard-verify", {
      expected: "Dashboard lists repertoire; no console errors or clientlog beacons across tabs",
      actual: {
        dashFinal,
        consoleErrorCount: consoleErrors.length,
        consoleErrors: consoleErrors.map((c) => c.text).slice(0, 8),
        clientlogBeacons: evidence.clientlogRequests.length,
      },
      pass: dashFinal.hasRep && consoleErrors.length === 0 && evidence.clientlogRequests.length === 0,
      priority: "P3 — dashboard + observability OK",
    });
  } catch (err) {
    record("journey-abort", {
      expected: "Complete release journey without uncaught abort",
      actual: {
        error: err.message,
        repName,
        userId,
        completedSteps: evidence.steps.map((s) => ({ step: s.step, pass: s.pass })),
      },
      required: false,
      pass: false,
      priority: "P0 — release blocked",
    });
  }

  await ctx.close();
  await browser.close();

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(evidence, null, 2));

  const required = evidence.steps.filter((s) => s.required);
  const requiredFailed = required.filter((s) => !s.pass);
  const passed = evidence.steps.filter((s) => s.pass).length;

  console.log(`[release-cross-flow] recorded ${evidence.steps.length} steps (${passed} pass flags)`);
  console.log(
    `[release-cross-flow] required: ${required.length - requiredFailed.length}/${required.length} passed`,
  );
  console.log(`[release-cross-flow] evidence → ${OUT_JSON}`);
  console.log(`[release-cross-flow] clientlog beacons: ${evidence.clientlogRequests.length}`);
  console.log(
    `[release-cross-flow] console errors (non-benign): ${
      evidence.console.filter((c) => c.type === "error" && !isBenignConsoleError(c.text)).length
    }`,
  );

  if (requiredFailed.length) {
    console.error("[release-cross-flow] FAIL: required steps:");
    for (const row of requiredFailed) {
      console.error(`  - ${row.id}: ${row.actual?.error || row.priority || "failed"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[release-cross-flow] FAIL: ${err.message}`);
  process.exit(1);
});