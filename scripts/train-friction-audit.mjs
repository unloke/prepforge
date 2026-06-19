// Train friction audit harness — collects UI evidence for the free-tier Train flow.
// Prerequisites (same DB as the API server; disable auth rate limit for ~10 registrations/run):
//   $env:DATABASE_URL="sqlite:///dev.sqlite3"
//   .\.venv\Scripts\python.exe -m alembic upgrade head
//   .\.venv\Scripts\python.exe -c "from prepforge_chess.api.ratelimit import limiter; limiter.enabled=False; import uvicorn; uvicorn.run('prepforge_chess.api.main:app', host='127.0.0.1', port=8000)"
//
//   node scripts/train-friction-audit.mjs
//
// Writes docs/train-friction-audit-evidence.json
// Exits 1 when any required signed-in scenario fails.
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_JSON = join(ROOT, "docs", "train-friction-audit-evidence.json");
const BASE = process.env.AUDIT_BASE_URL || "http://127.0.0.1:8000";
const BUILD_SYNC_TIMEOUT_MS = Number(process.env.AUDIT_BUILD_SYNC_TIMEOUT_MS || 15_000);
const TRAIN_SYNC_TIMEOUT_MS = Number(process.env.AUDIT_TRAIN_SYNC_TIMEOUT_MS || 12_000);
const TRAIN_ANIM_MS = Number(process.env.AUDIT_TRAIN_ANIM_MS || 3_500);

/** Signed-in E2E paths — audit fails (exit 1) if any of these do not pass. */
const REQUIRED_IDS = new Set([
  "1-signed-in/empty-state",
  "1-signed-in/mobile-375",
  "1-signed-in/keyboard",
  "2-signed-in/ready-to-start",
  "3-signed-in/correct-move",
  "4-signed-in/wrong-retry",
  "5-signed-in/reload-persist",
  "6-signed-in/handoff-entry",
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

  async function preflightServer() {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const health = await page.request.get(`${BASE}/healthz`);
      if (!health.ok()) throw new Error(`server not reachable: ${health.status()}`);
      const csrf = await page.request.get(`${BASE}/api/csrf`);
      if (!csrf.ok()) throw new Error(`csrf bootstrap failed: ${csrf.status()}`);
      evidence.notes.push(
        "Audit registers ~10 fresh users per run. Start API with limiter.enabled=False before uvicorn (local audit server only).",
      );
    } finally {
      await ctx.close();
    }
  }

  await preflightServer();

  function wirePage(page) {
    page.on("console", (msg) => {
      evidence.console.push({ type: msg.type(), text: msg.text(), t: Date.now() });
    });
    page.on("request", (req) => {
      if (req.url().includes("/api/clientlog")) {
        evidence.clientlogRequests.push({ url: req.url(), method: req.method(), t: Date.now() });
      }
    });
  }

  async function newContext(viewport) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    wirePage(page);
    return { ctx, page };
  }

  async function createSignedInContext(viewport) {
    const { ctx, page } = await newContext(viewport);
    const stamp = Date.now();
    const email = `train-audit-${stamp}@example.com`;
    const password = `AuditPass-${stamp}!`;

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.request.get(`${BASE}/api/csrf`);
    const csrfCookie = (await ctx.cookies()).find((c) => c.name === "pf_csrf");
    const csrf = csrfCookie?.value || "";
    const reg = await page.request.post(`${BASE}/api/auth/register`, {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      data: { email, password, display_name: "Train Audit" },
    });
    if (!reg.ok()) {
      const body = await reg.text();
      if (reg.status() === 429) {
        throw new Error("register rate limited — restart API with limiter.enabled=False");
      }
      throw new Error(`register failed: ${reg.status()} ${body.slice(0, 200)}`);
    }

    await page.reload({ waitUntil: "networkidle", timeout: 60000 });
    const status = await page.request.get(`${BASE}/api/auth/status`).then((r) => r.json());
    if (!status.signed_in) throw new Error("signed_in false after register reload");

    evidence.auth.signedInVerified = true;
    evidence.auth.lastUserId = status.user_id || null;
    return { ctx, page, userId: status.user_id || null };
  }

  async function getAppStatus(page) {
    return page.evaluate(() => document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "");
  }

  async function gotoDashboard(page) {
    await page.click('[data-testid="nav-dashboard"]');
    await page.locator("#view-dashboard.is-active").waitFor({ state: "attached", timeout: 10000 });
    await page.waitForTimeout(300);
  }

  async function gotoBuild(page) {
    await page.click('[data-testid="nav-build"]');
    await page.locator("#view-build.is-active").waitFor({ state: "attached", timeout: 10000 });
    await page.waitForTimeout(300);
  }

  async function gotoTrain(page) {
    await page.click('[data-testid="nav-train"]');
    await page.locator("#view-train.is-active").waitFor({ state: "attached", timeout: 10000 });
    await page.waitForTimeout(400);
  }

  async function fillCreateModal(page, { name, color }) {
    await page.locator(".modal-overlay").waitFor({ state: "visible", timeout: 10000 });
    await page.fill('.modal-overlay input[name="name"]', name);
    if (color) await page.fill('.modal-overlay input[name="color"]', color);
    await page.click('.modal-overlay [data-action="ok"]');
    await page.locator(".modal-overlay").waitFor({ state: "hidden", timeout: 10000 });
  }

  async function createRepertoireFromDashboard(page, { name, color = "white" }) {
    await gotoDashboard(page);
    await page.click('[data-testid="dashboard-new-rep"]');
    await fillCreateModal(page, { name, color });
    await page.locator("#view-build.is-active").waitFor({ state: "attached", timeout: 30000 });
    await page.locator("#build-rep-name", { hasText: name }).waitFor({ timeout: 30000 });
  }

  async function playBuildMove(page, from, to) {
    await page.locator(`#build-board [data-square="${from}"]`).click();
    await page.locator(`#build-board [data-square="${to}"]`).click();
    await page.waitForTimeout(300);
  }

  async function waitForBuildSaved(page, timeout = BUILD_SYNC_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const snap = await page.evaluate(() => ({
        hidden: document.getElementById("build-sync")?.hidden,
        cls: document.getElementById("build-sync")?.className || "",
        text: document.getElementById("build-sync")?.textContent?.trim() || "",
      }));
      if (!snap.hidden && snap.cls.includes("is-saved")) return snap;
      await page.waitForTimeout(250);
    }
    throw new Error("Timed out waiting for build sync saved");
  }

  async function setupTrainableRepertoire(page, repName) {
    await createRepertoireFromDashboard(page, { name: repName, color: "white" });
    await playBuildMove(page, "e2", "e4");
    await page.locator("#builder-tree", { hasText: "e4" }).waitFor({ timeout: 10000 });
    await waitForBuildSaved(page);
  }

  async function snapshotTrainEmpty(page) {
    return page.evaluate(() => ({
      viewTrainActive: document.getElementById("view-train")?.classList.contains("is-active"),
      bannerTitle: document.getElementById("train-banner-title")?.textContent?.trim() || "",
      prompt: document.getElementById("train-prompt")?.textContent?.trim() || "",
      bannerState: document.getElementById("train-banner")?.dataset?.state || "",
      bannerSub: document.getElementById("train-banner-sub")?.textContent?.trim() || "",
      boardLabel: document.getElementById("train-board-label")?.textContent?.trim() || "",
      helpVisible: !!document.querySelector('[data-testid="train-help"]'),
      startVisible: !!document.querySelector('[data-testid="start-train"]'),
      navBuild: !!document.querySelector('[data-testid="nav-build"]'),
      pickerHidden: document.getElementById("train-repertoire-select")?.hidden,
      smartModeActive: !!document.querySelector('#train-modes .train-mode[data-mode="smart"].is-active'),
      status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
    }));
  }

  async function getTrainStats(page) {
    return page.evaluate(() => ({
      correct: document.getElementById("train-stat-correct")?.textContent?.trim() || "0",
      mistakes: document.getElementById("train-stat-mistakes")?.textContent?.trim() || "0",
      streak: document.getElementById("train-stat-streak")?.textContent?.trim() || "0",
      accuracy: document.getElementById("train-accuracy")?.textContent?.trim() || "",
      bannerTitle: document.getElementById("train-banner-title")?.textContent?.trim() || "",
      prompt: document.getElementById("train-prompt")?.textContent?.trim() || "",
      bannerState: document.getElementById("train-banner")?.dataset?.state || "",
      bannerSub: document.getElementById("train-banner-sub")?.textContent?.trim() || "",
      lineLabel: document.getElementById("train-line-label")?.textContent?.trim() || "",
      progressHidden: document.getElementById("train-progress-panel")?.hidden,
      syncText: document.getElementById("train-sync")?.textContent?.trim() || "",
      syncClass: document.getElementById("train-sync")?.className || "",
    }));
  }

  async function playTrainMove(page, from, to) {
    await page.locator(`#train-board [data-square="${from}"]`).click();
    await page.locator(`#train-board [data-square="${to}"]`).click();
    await page.waitForTimeout(200);
  }

  async function waitForTrainActive(page, timeout = 60_000) {
    await page
      .locator(
        '#train-banner[data-state="move"], #train-banner[data-state="teach"], #train-banner[data-state="runin"]',
      )
      .first()
      .waitFor({ state: "attached", timeout });
  }

  async function clickStartTrain(page) {
    await page.click('[data-testid="start-train"]');
  }

  async function startSmartSession(page) {
    const respPromise = page.waitForResponse(
      (r) => r.url().includes("/api/train/smart/start") && r.status() === 200,
      { timeout: 60_000 },
    );
    await clickStartTrain(page);
    const resp = await respPromise;
    const payload = await resp.json();
    await waitForTrainActive(page);
    return payload;
  }

  async function waitForTrainSyncSaved(page, timeout = TRAIN_SYNC_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const snap = await page.evaluate(() => ({
        hidden: document.getElementById("train-sync")?.hidden,
        cls: document.getElementById("train-sync")?.className || "",
        text: document.getElementById("train-sync")?.textContent?.trim() || "",
      }));
      if (!snap.hidden && snap.cls.includes("is-saved")) return snap;
      await page.waitForTimeout(300);
    }
    throw new Error("Timed out waiting for train sync saved");
  }

  async function measureTrainTargets(page) {
    return page.evaluate(() => {
      const rect = (id) => {
        const el = document.getElementById(id);
        const r = el?.getBoundingClientRect();
        return { width: r?.width, height: r?.height };
      };
      const targetOk = (box) => (box?.width ?? 0) >= 44 && (box?.height ?? 0) >= 44;
      return {
        viewportW: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        noHorizontalScroll: document.documentElement.scrollWidth <= window.innerWidth,
        startTrain: rect("start-train"),
        hint: rect("train-hint"),
        skip: rect("train-skip"),
        flip: rect("train-flip"),
        smartModeEl: (() => {
          const el = document.querySelector('#train-modes .train-mode[data-mode="smart"]');
          const r = el?.getBoundingClientRect();
          return { width: r?.width, height: r?.height };
        })(),
        targetsOk: {
          startTrain: targetOk(rect("start-train")),
          hint: targetOk(rect("train-hint")),
          skip: targetOk(rect("train-skip")),
          flip: targetOk(rect("train-flip")),
        },
      };
    });
  }

  // --- Path 1-signed-in: Empty state (REQUIRED) ---
  {
    let ctx;
    let page;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await gotoTrain(page);
      const beforeStart = await snapshotTrainEmpty(page);
      await clickStartTrain(page);
      await page.waitForTimeout(1200);
      const afterStart = await getTrainStats(page);
      const status = await getAppStatus(page);
      record("1-signed-in", "empty-state", {
        expected:
          "Fresh user on Train: clear prerequisites + Build path; Start without repertoire explains next step",
        actual: { beforeStart, afterStart, status },
        recovery: "Build a repertoire with prepared moves, then return to Train",
        priority:
          /nothing to train|build/i.test(afterStart.bannerTitle + afterStart.bannerSub + status)
            ? "P3 — empty state OK"
            : "P1 — unclear Train prerequisites",
        pass:
          beforeStart.viewTrainActive &&
          /press start/i.test(beforeStart.bannerTitle + beforeStart.boardLabel) &&
          beforeStart.startVisible &&
          beforeStart.navBuild &&
          (/nothing to train|add prepared moves/i.test(
            afterStart.bannerTitle + afterStart.bannerSub,
          ) ||
            /build|train/i.test(status)),
      });
    } catch (err) {
      record("1-signed-in", "empty-state", {
        expected: "Train empty state for fresh user",
        actual: { error: err.message },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 2-signed-in: Ready to start after Build (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Train ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);

      // Line rehearsal exposes repertoire picker.
      await page.click('#train-modes .train-mode[data-mode="all_lines"]');
      await page.waitForTimeout(400);
      const picker = await page.evaluate((name) => {
        const select = document.getElementById("train-repertoire-select");
        const options = [...(select?.options || [])].map((o) => ({
          value: o.value,
          text: o.textContent.trim(),
        }));
        return {
          hidden: select?.hidden,
          options,
          selectedText: select?.selectedOptions?.[0]?.textContent?.trim() || "",
          hasRep: options.some((o) => o.text.includes(name)),
        };
      }, repName);

      await page.click('#train-modes .train-mode[data-mode="smart"]');
      await page.waitForTimeout(300);
      const startPayload = await startSmartSession(page);
      const active = await getTrainStats(page);

      record("2-signed-in", "ready-to-start", {
        expected:
          "After Build prepared move: Line rehearsal picker lists repertoire; Smart queue starts first prompt",
        actual: { repName, picker, startPayload: { cards: startPayload.cards?.length, session_id: !!startPayload.session_id }, active },
        recovery: "Flush Build sync, then Start training",
        priority: active.bannerState === "move" || active.bannerState === "teach" ? "P3 — ready OK" : "P1 — cannot start",
        pass:
          !picker.hidden &&
          picker.hasRep &&
          (startPayload.cards?.length || 0) > 0 &&
          (active.bannerState === "move" || active.bannerState === "teach" || active.bannerState === "runin") &&
          !active.progressHidden,
      });
    } catch (err) {
      record("2-signed-in", "ready-to-start", {
        expected: "Train ready after Build",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 3-signed-in: Correct move advances stats (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Correct ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      await startSmartSession(page);
      const before = await getTrainStats(page);
      const lineBefore = before.lineLabel;
      await playTrainMove(page, "e2", "e4");
      await page.waitForTimeout(TRAIN_ANIM_MS);
      const after = await getTrainStats(page);

      record("3-signed-in", "correct-move", {
        expected: "Correct e4: stats/progress update; banner shows success or next prompt",
        actual: { repName, before, after },
        recovery: "Retry the prepared move shown in teach banner or hints",
        priority:
          Number(after.correct) > Number(before.correct) || after.bannerState === "correct"
            ? "P3 — correct flow OK"
            : "P1 — correct move not reflected",
        pass:
          (Number(after.correct) > Number(before.correct) ||
            after.bannerState === "correct" ||
            /correct|learned|got it|first-try correct/i.test(after.bannerTitle + after.bannerSub)) &&
          (after.lineLabel !== lineBefore || after.bannerState === "move" || after.bannerState === "done"),
      });
    } catch (err) {
      record("3-signed-in", "correct-move", {
        expected: "Correct move flow",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 4-signed-in: Wrong move → retry → advance (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Wrong ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      await startSmartSession(page);
      const before = await getTrainStats(page);
      await playTrainMove(page, "d2", "d4");
      await page.waitForTimeout(1200);
      const wrong = await getTrainStats(page);
      await playTrainMove(page, "e2", "e4");
      await page.waitForTimeout(TRAIN_ANIM_MS);
      const after = await getTrainStats(page);

      record("4-signed-in", "wrong-retry", {
        expected: "Wrong move: clear retry prompt; correct on retry advances without double mistake count",
        actual: { repName, before, wrong, after },
        recovery: "Read banner hint; play expected prepared move on retry",
        priority:
          wrong.bannerState === "wrong" && Number(after.correct) >= Number(before.correct)
            ? "P3 — wrong/retry OK"
            : "P1 — wrong move UX broken",
        pass:
          wrong.bannerState === "wrong" &&
          /try again|not that|time's up/i.test(wrong.bannerTitle + wrong.bannerSub) &&
          (Number(after.correct) > Number(before.correct) ||
            /fixed on retry|correct|learned|got it|opponent/i.test(
              after.bannerTitle + after.bannerSub,
            )),
      });
    } catch (err) {
      record("4-signed-in", "wrong-retry", {
        expected: "Wrong move retry flow",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 5-signed-in: Reload / re-entry (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Reload ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      await startSmartSession(page);
      await playTrainMove(page, "e2", "e4");
      await page.waitForTimeout(TRAIN_ANIM_MS);
      const beforeReload = await getTrainStats(page);
      try {
        await waitForTrainSyncSaved(page);
      } catch {
        /* sync chip may stay hidden until dirty — still record */
      }
      await page.reload({ waitUntil: "networkidle", timeout: 60000 });
      await gotoTrain(page);
      await startSmartSession(page);
      const afterReload = await getTrainStats(page);

      record("5-signed-in", "reload-persist", {
        expected:
          "After graded move + reload: can restart training cleanly; session UI resets without errors (sync prevents double-count server-side)",
        actual: { repName, beforeReload, afterReload },
        recovery: "Start training again; prior attempts should have flushed via sync/beacon",
        priority:
          afterReload.bannerState === "move" || afterReload.bannerState === "teach"
            ? "P3 — reload re-entry OK"
            : "P1 — reload blocks training",
        pass:
          Number(beforeReload.correct) >= 1 &&
          (afterReload.bannerState === "move" ||
            afterReload.bannerState === "teach" ||
            afterReload.bannerState === "runin") &&
          Number(afterReload.correct) === 0,
      });
    } catch (err) {
      record("5-signed-in", "reload-persist", {
        expected: "Reload persistence",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 1-signed-in: Mobile 375px (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Mobile ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 375, height: 812 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      const empty = await snapshotTrainEmpty(page);
      const layout = await measureTrainTargets(page);
      await startSmartSession(page);
      await playTrainMove(page, "d2", "d4");
      await page.waitForTimeout(1200);
      const wrong = await getTrainStats(page);
      await playTrainMove(page, "e2", "e4");
      await page.waitForTimeout(TRAIN_ANIM_MS);
      const done = await getTrainStats(page);

      const t = layout.targetsOk || {};
      const start = layout.startTrain || {};
      record("1-signed-in", "mobile-375", {
        expected:
          "375px: start, wrong retry, correct finish; Start + flip/hint/skip ≥44×44px; no horizontal scroll",
        actual: { empty, repName, layout, wrong, done },
        recovery: "Use Start training sidebar on narrow viewports",
        priority:
          t.startTrain && t.flip && t.hint && t.skip && layout.noHorizontalScroll
            ? "P3 — mobile Train OK"
            : `P1 — touch targets or scroll (start ${start.width}×${start.height})`,
        pass:
          empty.startVisible &&
          (wrong.bannerState === "wrong" ||
            /try again|not that/i.test(wrong.bannerTitle + wrong.bannerSub)) &&
          (/fixed on retry|correct|learned|got it/i.test(done.bannerTitle + done.bannerSub) ||
            Number(done.correct) >= 1) &&
          layout.viewportW <= 400 &&
          t.startTrain &&
          t.flip &&
          t.hint &&
          t.skip &&
          layout.noHorizontalScroll,
      });
    } catch (err) {
      record("1-signed-in", "mobile-375", {
        expected: "Mobile Train flow",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 1-signed-in: Keyboard (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Keys ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      await page.focus('[data-testid="start-train"]');
      await page.keyboard.press("Enter");
      await waitForTrainActive(page);
      const afterStart = await getTrainStats(page);
      const boardNeedsPointer = await page.evaluate(() => {
        const sq = document.querySelector("#train-board .square");
        if (!sq) return { tested: false };
        sq.focus();
        const before = document.getElementById("train-banner")?.dataset?.state;
        sq.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        sq.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        const after = document.getElementById("train-banner")?.dataset?.state;
        return { tested: true, before, after, tag: document.activeElement?.tagName };
      });

      record("1-signed-in", "keyboard", {
        expected:
          "Enter on Start begins session; board squares need pointer (document as P2 if keyboard play fails)",
        actual: { repName, afterStart, boardNeedsPointer },
        recovery: "Tab to Start/controls; use pointer for board moves",
        priority: boardNeedsPointer.tested && boardNeedsPointer.before === boardNeedsPointer.after
          ? "P2 — board needs pointer (controls OK)"
          : "P3 — keyboard controls OK",
        pass:
          (afterStart.bannerState === "move" ||
            afterStart.bannerState === "teach" ||
            afterStart.bannerState === "runin") &&
          boardNeedsPointer.tested,
      });
    } catch (err) {
      record("1-signed-in", "keyboard", {
        expected: "Keyboard Train flow",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 6-signed-in: Build → Train handoff (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Handoff ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      await page.click('#train-modes .train-mode[data-mode="all_lines"]');
      await page.waitForTimeout(400);
      const picker = await page.evaluate((name) => {
        const select = document.getElementById("train-repertoire-select");
        return {
          options: [...(select?.options || [])].map((o) => o.textContent.trim()),
          hasRep: [...(select?.options || [])].some((o) => o.textContent.includes(name)),
        };
      }, repName);
      await page.click('#train-modes .train-mode[data-mode="smart"]');
      await page.waitForTimeout(300);
      await startSmartSession(page);
      const active = await getTrainStats(page);

      record("6-signed-in", "handoff-entry", {
        expected: "Build → Train: freshly created repertoire appears in picker and Smart queue starts",
        actual: { repName, picker, active },
        recovery: "Open Train after Build sync; use Line rehearsal picker if needed",
        priority: picker.hasRep && (active.bannerState === "move" || active.bannerState === "teach")
          ? "P3 — handoff OK"
          : "P1 — repertoire missing in Train",
        pass:
          picker.hasRep &&
          (active.bannerState === "move" || active.bannerState === "teach" || active.bannerState === "runin"),
      });
    } catch (err) {
      record("6-signed-in", "handoff-entry", {
        expected: "Build → Train handoff",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Recovery: No trainable moves (NOT required) ---
  {
    let ctx;
    let page;
    const repName = `Audit Empty ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await createRepertoireFromDashboard(page, { name: repName, color: "white" });
      await gotoTrain(page);
      await clickStartTrain(page);
      await page.waitForTimeout(1500);
      const snap = await getTrainStats(page);
      record("4-recovery", "no-trainable-moves", {
        expected: "Repertoire without prepared moves → Nothing to train yet + Build hint",
        actual: { repName, snap },
        recovery: "Add prepared moves in Build",
        priority: /nothing to train|add prepared/i.test(snap.bannerSub + snap.prompt) ? "P3 — gate OK" : "P1",
        pass:
          /nothing to train/i.test(snap.bannerTitle + snap.bannerSub) && /build/i.test(snap.bannerSub),
      });
    } catch (err) {
      record("4-recovery", "no-trainable-moves", { actual: { error: err.message }, pass: false, priority: "P1" });
    }
    if (ctx) await ctx.close();
  }

  // --- Recovery: Sync failure (NOT required) ---
  {
    let ctx;
    let page;
    const repName = `Audit Sync ${Date.now()}`;
    let failSync = true;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await page.route("**/api/train/smart/sync", async (route) => {
        if (failSync) {
          await route.fulfill({ status: 503, body: "audit simulated outage" });
          return;
        }
        await route.continue();
      });
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      await startSmartSession(page);
      await playTrainMove(page, "e2", "e4");
      await page.waitForTimeout(TRAIN_ANIM_MS);
      const deadline = Date.now() + TRAIN_SYNC_TIMEOUT_MS + 5000;
      let errorSnap = null;
      while (Date.now() < deadline) {
        errorSnap = await page.evaluate(() => ({
          syncText: document.getElementById("train-sync")?.textContent?.trim() || "",
          syncClass: document.getElementById("train-sync")?.className || "",
          syncHidden: document.getElementById("train-sync")?.hidden,
        }));
        if (errorSnap.syncClass.includes("is-error") || /offline|retry/i.test(errorSnap.syncText)) break;
        await page.waitForTimeout(400);
      }
      failSync = false;
      await page.unroute("**/api/train/smart/sync");
      let recovered = null;
      try {
        recovered = await waitForTrainSyncSaved(page, TRAIN_SYNC_TIMEOUT_MS * 2);
      } catch (err) {
        recovered = { error: err.message };
      }
      record("5-recovery", "sync-failure", {
        expected: "smart/sync 503 → error/dirty chip; recovers after route restored",
        actual: { repName, errorSnap, recovered },
        recovery: "Wait for backoff retry; session continues locally",
        priority: errorSnap?.syncClass?.includes("is-error") ? "P2 — error surfaced" : "P1 — no error chip",
        pass:
          errorSnap &&
          (errorSnap.syncClass.includes("is-error") ||
            errorSnap.syncClass.includes("is-dirty") ||
            /offline|unsaved|retry/i.test(errorSnap.syncText)),
      });
    } catch (err) {
      record("5-recovery", "sync-failure", { actual: { error: err.message, repName }, pass: false, priority: "P1" });
    }
    if (ctx) await ctx.close();
  }

  // --- Recovery: Reload before sync flush (NOT required) ---
  {
    let ctx;
    let page;
    const repName = `Audit Interrupt ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await setupTrainableRepertoire(page, repName);
      await gotoTrain(page);
      await startSmartSession(page);
      await playTrainMove(page, "e2", "e4");
      await page.waitForTimeout(800);
      const before = await getTrainStats(page);
      await page.reload({ waitUntil: "networkidle", timeout: 60000 });
      await gotoTrain(page);
      await clickStartTrain(page);
      await page.waitForTimeout(2000);
      const after = await getTrainStats(page);
      record("6-recovery", "reload-interrupt", {
        expected: "Reload mid-session (pre-sync): UI restarts; document whether in-memory session restores",
        actual: { repName, before, after },
        recovery: "Start again; beacon/keepalive may have flushed attempts",
        priority: "P2 — informational",
        pass: true,
      });
    } catch (err) {
      record("6-recovery", "reload-interrupt", { actual: { error: err.message }, pass: false, priority: "P1" });
    }
    if (ctx) await ctx.close();
  }

  await browser.close();

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(evidence, null, 2));

  const passed = evidence.paths.filter((p) => p.pass).length;
  const total = evidence.paths.length;
  const required = evidence.paths.filter((p) => p.required);
  const requiredFailed = required.filter((p) => !p.pass);

  console.log(`[train-friction-audit] recorded ${total} scenarios (${passed} pass flags)`);
  console.log(
    `[train-friction-audit] required signed-in: ${required.length - requiredFailed.length}/${required.length} passed`,
  );
  console.log(`[train-friction-audit] evidence → ${OUT_JSON}`);
  console.log(`[train-friction-audit] clientlog beacons: ${evidence.clientlogRequests.length}`);
  console.log(`[train-friction-audit] console messages: ${evidence.console.length}`);

  if (requiredFailed.length) {
    console.error("[train-friction-audit] FAIL: required signed-in scenarios:");
    for (const row of requiredFailed) {
      console.error(`  - ${row.id}: ${row.actual?.error || row.priority || "failed"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[train-friction-audit] FAIL: ${err.message}`);
  process.exit(1);
});