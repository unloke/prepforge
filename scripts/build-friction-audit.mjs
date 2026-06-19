// Build friction audit harness — collects UI evidence for the free-tier Build flow.
// Prerequisites (same DB as the API server):
//   $env:DATABASE_URL="sqlite:///dev.sqlite3"
//   .\.venv\Scripts\python.exe -m alembic upgrade head
//   .\.venv\Scripts\python.exe -m uvicorn prepforge_chess.api.main:app --host 127.0.0.1 --port 8000
//
//   node scripts/build-friction-audit.mjs
//
// Writes docs/build-friction-audit-evidence.json
// Exits 1 when any required signed-in scenario fails.
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_JSON = join(ROOT, "docs", "build-friction-audit-evidence.json");
const BASE = process.env.AUDIT_BASE_URL || "http://127.0.0.1:8000";
const ANALYSIS_TIMEOUT_MS = Number(process.env.AUDIT_ANALYSIS_TIMEOUT_MS || 180_000);
const BUILD_SYNC_TIMEOUT_MS = Number(process.env.AUDIT_BUILD_SYNC_TIMEOUT_MS || 15_000);

const DEMO_PGN = `[Event "PrepForge UI Demo"]
[Site "https://lichess.org/prepforge-ui"]
[Date "2026.05.25"]
[White "PrepForge"]
[Black "Demo"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0`;

/** Signed-in E2E paths — audit fails (exit 1) if any of these do not pass. */
const REQUIRED_IDS = new Set([
  "1-signed-in/empty-state",
  "1-signed-in/mobile-375",
  "1-signed-in/keyboard",
  "2-signed-in/create-repertoire",
  "3-signed-in/first-move-branch",
  "4-signed-in/reload-persist",
  "5-signed-in/handoff-entry",
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
      if (!health.ok()) {
        throw new Error(`server not reachable: ${health.status()}`);
      }
      const csrf = await page.request.get(`${BASE}/api/csrf`);
      if (!csrf.ok()) {
        throw new Error(`csrf bootstrap failed: ${csrf.status()}`);
      }
      evidence.notes.push(
        "Audit registers ~10 fresh users per run. Start API with rate limiting disabled: " +
          'PREPFORGE_DISABLE_RATE_LIMIT=1 or limiter.enabled=False before uvicorn.',
      );
    } finally {
      await ctx.close();
    }
  }

  await preflightServer();

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

  async function createSignedInContext(viewport) {
    const { ctx, page } = await newContext(viewport);
    const stamp = Date.now();
    const email = `build-audit-${stamp}@example.com`;
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
      data: { email, password, display_name: "Build Audit" },
    });
    if (!reg.ok()) {
      const body = await reg.text();
      if (reg.status() === 429) {
        throw new Error(
          "register rate limited (429) — restart API with limiter.enabled=False for audit runs",
        );
      }
      if (reg.status() === 500 && /no such table/i.test(body)) {
        throw new Error("database not migrated — run alembic upgrade head");
      }
      throw new Error(`register failed: ${reg.status()} ${body.slice(0, 200)}`);
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

  async function gotoBuild(page) {
    await page.click('[data-testid="nav-build"]');
    await page.locator("#view-build.is-active").waitFor({ state: "attached", timeout: 10000 });
    await page.waitForTimeout(400);
  }

  async function gotoDashboard(page) {
    await page.click('[data-testid="nav-dashboard"]');
    await page.locator("#view-dashboard.is-active").waitFor({ state: "attached", timeout: 10000 });
    await page.waitForTimeout(400);
  }

  async function gotoAnalyze(page) {
    await page.click('[data-testid="nav-analyze"]');
    await page.locator("#view-analyze.is-active").waitFor({ state: "attached", timeout: 10000 });
    await page.waitForTimeout(400);
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

  async function waitForAnalysisResults(page, timeout = ANALYSIS_TIMEOUT_MS) {
    await page.locator("#analysis-results").waitFor({ state: "visible", timeout });
    await page.locator("#analysis-moves > *").first().waitFor({ state: "attached", timeout });
    await page
      .locator("#analysis-summary .class-bars, #analysis-summary .cbar-row")
      .first()
      .waitFor({ state: "attached", timeout });
  }

  async function snapshotBuildEmpty(page) {
    return page.evaluate(() => ({
      viewBuildActive: document.getElementById("view-build")?.classList.contains("is-active"),
      repName: document.getElementById("build-rep-name")?.textContent?.trim() || "",
      boardLabel: document.getElementById("build-board-label")?.textContent?.trim() || "",
      treeText: (document.getElementById("builder-tree")?.textContent || "").trim().slice(0, 240),
      treeHasEmptyState: !!document.querySelector("#builder-tree .empty-state"),
      buildMenuVisible: !document.getElementById("build-menu")?.hidden,
      dashboardNewRep: !!document.querySelector('[data-testid="dashboard-new-rep"]'),
      dashboardEmptyText: (document.getElementById("dashboard-repertoires")?.textContent || "")
        .trim()
        .slice(0, 120),
      status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
    }));
  }

  async function snapshotBuild(page) {
    return page.evaluate(() => ({
      viewBuildActive: document.getElementById("view-build")?.classList.contains("is-active"),
      repName: document.getElementById("build-rep-name")?.textContent?.trim() || "",
      boardLabel: document.getElementById("build-board-label")?.textContent?.trim() || "",
      treeChildCount: document.getElementById("builder-tree")?.querySelectorAll(".tree-node, .move-row, .tree-row").length || 0,
      treeText: (document.getElementById("builder-tree")?.textContent || "").trim().slice(0, 240),
      branchBarVisible: !document.getElementById("build-branchbar")?.hidden,
      branchChipCount: document.querySelectorAll("#build-branchbar .branch-chip").length,
      branchChipSans: [...document.querySelectorAll("#build-branchbar .branch-san")].map((el) =>
        el.textContent.trim(),
      ),
      syncText: document.getElementById("build-sync")?.textContent?.trim() || "",
      syncClass: document.getElementById("build-sync")?.className || "",
      syncHidden: document.getElementById("build-sync")?.hidden,
      boardSquareCount: document.querySelectorAll("#build-board .square").length,
      status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
    }));
  }

  async function fillCreateModal(page, { name, color }) {
    await page.locator(".modal-overlay").waitFor({ state: "visible", timeout: 10000 });
    await page.fill('.modal-overlay input[name="name"]', name);
    if (color) {
      await page.fill('.modal-overlay input[name="color"]', color);
    }
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

  async function createRepertoireFromBuildMenu(page, { name, color = "white" }) {
    await gotoBuild(page);
    await page.click('[data-testid="build-menu"]');
    await page.locator('#repertoire-context-menu button[data-action="build-new-rep"]').click();
    await fillCreateModal(page, { name, color });
    await page.locator("#build-rep-name", { hasText: name }).waitFor({ timeout: 30000 });
  }

  async function playBuildMove(page, from, to) {
    await page.locator(`#build-board [data-square="${from}"]`).click();
    await page.locator(`#build-board [data-square="${to}"]`).click();
    await page.waitForTimeout(300);
  }

  async function waitForBuildSaved(page, timeout = BUILD_SYNC_TIMEOUT_MS) {
    const sync = page.locator("#build-sync.is-saved");
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hidden = await page.evaluate(() => document.getElementById("build-sync")?.hidden);
      const text = await page.evaluate(() => document.getElementById("build-sync")?.textContent?.trim() || "");
      const cls = await page.evaluate(() => document.getElementById("build-sync")?.className || "");
      if (!hidden && cls.includes("is-saved")) return { text, cls };
      if (!hidden && /saved/i.test(text)) return { text, cls };
      await page.waitForTimeout(250);
    }
    try {
      await sync.waitFor({ state: "visible", timeout: 2000 });
      return page.evaluate(() => ({
        text: document.getElementById("build-sync")?.textContent?.trim() || "",
        cls: document.getElementById("build-sync")?.className || "",
      }));
    } catch {
      throw new Error("Timed out waiting for build sync saved");
    }
  }

  async function openRepertoireFromDashboard(page, name) {
    await gotoDashboard(page);
    await page.locator(`#dashboard-repertoires .list-item .name`, { hasText: name }).first().click();
    await page.locator("#view-build.is-active").waitFor({ state: "attached", timeout: 30000 });
    await page.locator("#build-rep-name", { hasText: name }).waitFor({ timeout: 30000 });
  }

  async function addMainlineAndBranch(page) {
    await playBuildMove(page, "e2", "e4");
    await page.locator("#builder-tree", { hasText: "e4" }).waitFor({ timeout: 10000 });
    await page.click("#build-root");
    await page.waitForTimeout(300);
    await playBuildMove(page, "d2", "d4");
    await page.locator("#builder-tree", { hasText: "d4" }).waitFor({ timeout: 10000 });
    // Fork bar shows next-move options at the PARENT position — step back to root.
    await page.click("#build-root");
    await page.waitForTimeout(300);
    await page.locator("#build-branchbar:not([hidden])").waitFor({ state: "attached", timeout: 10000 });
    const beforeSwitch = await snapshotBuild(page);
    const altChip = page.locator("#build-branchbar .branch-chip").nth(1);
    await altChip.click();
    await page.waitForTimeout(400);
    const afterSwitch = await snapshotBuild(page);
    return { beforeSwitch, afterSwitch };
  }

  // --- Path 1-signed-in: Empty state (REQUIRED) ---
  {
    let ctx;
    let page;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await gotoBuild(page);
      const snap = await snapshotBuildEmpty(page);
      await gotoDashboard(page);
      const dashSnap = await page.evaluate(() => ({
        newRepVisible: !!document.querySelector('[data-testid="dashboard-new-rep"]'),
        repertoiresText: (document.getElementById("dashboard-repertoires")?.textContent || "").trim().slice(0, 160),
      }));
      record("1-signed-in", "empty-state", {
        expected:
          "Fresh user on Build: clear empty state; primary create paths visible (tree hint, ⋯ menu, Dashboard New)",
        actual: { build: snap, dashboard: dashSnap },
        recovery: "Use Dashboard → New, Build ⋯ → New repertoire, or play first move on board",
        priority:
          snap.treeHasEmptyState && /no repertoire/i.test(snap.repName)
            ? "P3 — empty state OK"
            : "P1 — empty state unclear",
        pass:
          snap.viewBuildActive &&
          snap.treeHasEmptyState &&
          /no repertoire/i.test(snap.repName) &&
          /play a move|dashboard|⋯|menu/i.test(snap.treeText) &&
          dashSnap.newRepVisible &&
          /no repertoires/i.test(dashSnap.repertoiresText),
      });
    } catch (err) {
      record("1-signed-in", "empty-state", {
        expected: "Fresh user Build empty state",
        actual: { error: err.message },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 2-signed-in: Create repertoire name/color → board/tree (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Build ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await createRepertoireFromDashboard(page, { name: repName, color: "white" });
      const snap = await snapshotBuild(page);
      const boardState = await page.evaluate(() => ({
        squareCount: document.querySelectorAll("#build-board .square").length,
        hasPieces: document.querySelectorAll("#build-board .square[data-piece]").length > 0,
        orientation: document.querySelector("#build-board")?.classList.contains("is-flipping")
          ? "animating"
          : "white-default",
      }));
      record("2-signed-in", "create-repertoire", {
        expected: "Dashboard New → name/color modal → Build opens with rep name, board, and tree scaffold",
        actual: { repName, snap, boardState },
        recovery: "Retry Dashboard → New or Build ⋯ → New repertoire",
        priority: snap.repName.includes(repName) ? "P3 — create OK" : "P1 — create broken",
        pass:
          snap.viewBuildActive &&
          snap.repName.includes(repName) &&
          boardState.squareCount === 64 &&
          boardState.hasPieces &&
          /play a move|breadcrumb/i.test(snap.treeText),
      });
    } catch (err) {
      record("2-signed-in", "create-repertoire", {
        expected: "Create repertoire with name/color",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 3-signed-in: First prepared move + branch switch (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Moves ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await createRepertoireFromDashboard(page, { name: repName, color: "white" });
      const { beforeSwitch, afterSwitch } = await addMainlineAndBranch(page);
      record("3-signed-in", "first-move-branch", {
        expected: "Play e4, add d4 branch at root, switch via branch bar between mainline and alt",
        actual: { repName, beforeSwitch, afterSwitch },
        recovery: "Use ← to revisit fork; click branch chips or ↑↓ then →",
        priority:
          beforeSwitch.branchChipCount >= 2 && /d4/i.test(afterSwitch.boardLabel)
            ? "P3 — move + branch OK"
            : "P1 — branch switching broken",
        pass:
          /e4/i.test(beforeSwitch.treeText) &&
          beforeSwitch.branchBarVisible &&
          beforeSwitch.branchChipCount >= 2 &&
          /d4/i.test(afterSwitch.boardLabel),
      });
    } catch (err) {
      record("3-signed-in", "first-move-branch", {
        expected: "First prepared move and branch switch",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 4-signed-in: Reload persists repertoire + moves (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Reload ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await createRepertoireFromDashboard(page, { name: repName, color: "white" });
      await playBuildMove(page, "e2", "e4");
      await page.locator("#builder-tree", { hasText: "e4" }).waitFor({ timeout: 10000 });
      const syncBefore = await waitForBuildSaved(page);
      await page.reload({ waitUntil: "networkidle", timeout: 60000 });
      await openRepertoireFromDashboard(page, repName);
      const afterReload = await snapshotBuild(page);
      record("4-signed-in", "reload-persist", {
        expected: "After save + reload, Dashboard opens repertoire with e4 still in tree",
        actual: { repName, syncBefore, afterReload },
        recovery: "Open repertoire from Dashboard; check sync chip if moves missing",
        priority: /e4/i.test(afterReload.treeText) ? "P3 — persist OK" : "P1 — reload data loss",
        pass:
          afterReload.viewBuildActive &&
          afterReload.repName.includes(repName) &&
          /e4/i.test(afterReload.treeText),
      });
    } catch (err) {
      record("4-signed-in", "reload-persist", {
        expected: "Reload preserves repertoire and moves",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 1-signed-in: Mobile 375px core flow (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Mobile ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 375, height: 812 }));
      await gotoBuild(page);
      const empty = await snapshotBuildEmpty(page);
      await createRepertoireFromBuildMenu(page, { name: repName, color: "white" });
      await playBuildMove(page, "e2", "e4");
      await page.locator("#builder-tree", { hasText: "e4" }).waitFor({ timeout: 10000 });
      const layout = await page.evaluate(() => {
        const board = document.getElementById("build-board");
        const br = board?.getBoundingClientRect();
        const menu = document.getElementById("build-menu");
        const mr = menu?.getBoundingClientRect();
        return {
          viewportW: window.innerWidth,
          boardWidth: br?.width,
          menuHeight: mr?.height,
          menuWidth: mr?.width,
        };
      });
      const afterMove = await snapshotBuild(page);
      record("1-signed-in", "mobile-375", {
        expected: "375px: empty state → create via ⋯ menu → play e4; record touch targets",
        actual: { empty, repName, layout, afterMove },
        recovery: "Use Build ⋯ → New repertoire on narrow viewports",
        priority:
          layout.menuWidth >= 44 && layout.menuHeight >= 44
            ? "P3 — mobile core OK"
            : `P1 — Build ⋯ menu ${layout.menuWidth}×${layout.menuHeight}px (<44×44px touch target)`,
        pass:
          empty.treeHasEmptyState &&
          afterMove.repName.includes(repName) &&
          /e4/i.test(afterMove.treeText) &&
          layout.viewportW <= 400 &&
          layout.menuWidth >= 44 &&
          layout.menuHeight >= 44,
      });
    } catch (err) {
      record("1-signed-in", "mobile-375", {
        expected: "Mobile 375px Build core flow",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 1-signed-in: Keyboard core flow (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Keys ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await gotoBuild(page);
      await page.focus('[data-testid="build-menu"]');
      await page.keyboard.press("Enter");
      await page.locator('#repertoire-context-menu button[data-action="build-new-rep"]').click();
      await page.locator(".modal-overlay").waitFor({ state: "visible", timeout: 10000 });
      await page.fill('.modal-overlay input[name="name"]', repName);
      await page.keyboard.press("Enter");
      await page.locator("#build-rep-name", { hasText: repName }).waitFor({ timeout: 30000 });

      // Board squares use pointerdown — document keyboard path for moves separately.
      await playBuildMove(page, "e2", "e4");
      await page.click("#build-root");
      await playBuildMove(page, "d2", "d4");
      await page.click("#build-root");
      await page.waitForTimeout(300);
      await page.locator("#build-branchbar:not([hidden])").waitFor({ state: "attached", timeout: 10000 });
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(400);
      const afterKeys = await snapshotBuild(page);

      record("1-signed-in", "keyboard", {
        expected:
          "Keyboard: ⋯ menu → modal Enter creates rep; ArrowUp/ArrowRight switches branch at fork",
        actual: { repName, afterKeys },
        recovery: "Modal supports Enter; branch bar mirrors ↑↓ pick and → play",
        priority:
          afterKeys.repName.includes(repName) && /d4/i.test(afterKeys.boardLabel)
            ? "P3 — keyboard partial OK (board moves need pointer)"
            : "P1 — keyboard path broken",
        pass:
          afterKeys.repName.includes(repName) &&
          /e4|d4/i.test(afterKeys.treeText) &&
          /d4/i.test(afterKeys.boardLabel),
      });
    } catch (err) {
      record("1-signed-in", "keyboard", {
        expected: "Keyboard Build core flow",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Path 5-signed-in: Analyze handoff → Build entry (REQUIRED) ---
  {
    let ctx;
    let page;
    const repName = `Audit Handoff ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await gotoAnalyze(page);
      await fillPgn(page, DEMO_PGN);
      await page.click('[data-testid="run-analysis"]');
      await waitForAnalysisResults(page);
      const beforeHandoff = await page.evaluate(() => ({
        handoffVisible: !document.getElementById("analysis-handoff")?.hidden,
        repertoireCta: !!document.querySelector('[data-testid="create-repertoire-from-game"]'),
      }));
      if (!beforeHandoff.handoffVisible || !beforeHandoff.repertoireCta) {
        throw new Error("create-repertoire-from-game CTA not visible for fresh user");
      }

      await page.click('[data-testid="create-repertoire-from-game"]');
      await page.locator(".modal-overlay").waitFor({ state: "visible", timeout: 10000 });
      await page.fill('.modal-overlay input[name="name"]', repName);
      await page.click('.modal-overlay [data-action="ok"]');
      await page.locator("#view-build.is-active").waitFor({ state: "attached", timeout: 60000 });
      await page.locator("#build-rep-name", { hasText: repName }).waitFor({ timeout: 30000 });

      const afterHandoff = await snapshotBuild(page);
      const treeHasMoves = /e4|Nf3|Bb5/i.test(afterHandoff.treeText);

      record("5-signed-in", "handoff-entry", {
        expected: "Analyze CTA → modal → Build with imported game tree (handoff entry path)",
        actual: { beforeHandoff, afterHandoff, repName, treeHasMoves },
        recovery: "Retry Create on analysis results panel",
        priority: treeHasMoves ? "P3 — handoff entry OK" : "P1 — handoff tree empty",
        pass:
          beforeHandoff.handoffVisible &&
          beforeHandoff.repertoireCta &&
          afterHandoff.viewBuildActive &&
          afterHandoff.repName.includes(repName) &&
          treeHasMoves,
      });
    } catch (err) {
      record("5-signed-in", "handoff-entry", {
        expected: "Analyze → Build handoff entry",
        actual: { error: err.message, repName },
        priority: "P0 — blocks audit baseline",
        pass: false,
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Recovery: Engine unavailable — Generate gated (NOT required) ---
  {
    const { ctx, page } = await newContext({ width: 1280, height: 800 });
    await ctx.route("**/*", async (route) => {
      const response = await route.fetch();
      const newHeaders = { ...response.headers() };
      delete newHeaders["cross-origin-opener-policy"];
      delete newHeaders["cross-origin-embedder-policy"];
      await route.fulfill({ response, headers: newHeaders });
    });
    try {
      await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 60000 });
      await gotoBuild(page);
      const snap = await page.evaluate(() => {
        const btn = document.getElementById("build-generate-node");
        return {
          crossOriginIsolated: self.crossOriginIsolated,
          genDisabled: btn?.disabled ?? null,
          genAriaDisabled: btn?.getAttribute("aria-disabled") || "",
          genGated: btn?.classList.contains("is-coming-soon"),
          genTitle: btn?.getAttribute("title") || "",
          status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        };
      });
      record("3-recovery", "engine-gate", {
        expected: "No COI → Generate disabled with recovery title (inspect only)",
        actual: snap,
        recovery: "Use COOP/COEP-capable browser; Settings engine panel",
        priority: snap.genGated && snap.genDisabled ? "P2 — gating OK" : "P1 — unclear engine gate",
        pass:
          !snap.crossOriginIsolated &&
          snap.genDisabled === true &&
          snap.genAriaDisabled === "true" &&
          /unavailable|cross-origin/i.test(snap.genTitle),
      });
    } catch (err) {
      record("3-recovery", "engine-gate", {
        actual: { error: err.message },
        pass: false,
        priority: "P1",
      });
    }
    await ctx.close();
  }

  // --- Recovery: Sync failure — dirty/error state (NOT required) ---
  {
    let ctx;
    let page;
    const repName = `Audit Sync ${Date.now()}`;
    let failAdds = true;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await page.route("**/api/build/add-moves", async (route) => {
        if (failAdds) {
          await route.fulfill({ status: 503, body: "audit simulated outage" });
          return;
        }
        await route.continue();
      });
      await createRepertoireFromDashboard(page, { name: repName, color: "white" });
      await playBuildMove(page, "e2", "e4");
      const deadline = Date.now() + BUILD_SYNC_TIMEOUT_MS + 5000;
      let errorSnap = null;
      while (Date.now() < deadline) {
        errorSnap = await page.evaluate(() => ({
          syncText: document.getElementById("build-sync")?.textContent?.trim() || "",
          syncClass: document.getElementById("build-sync")?.className || "",
          syncHidden: document.getElementById("build-sync")?.hidden,
          status: document.querySelector('[data-testid="app-status"]')?.textContent?.trim() || "",
        }));
        if (
          errorSnap.syncClass.includes("is-error") ||
          errorSnap.syncClass.includes("is-syncing") ||
          /offline|retry/i.test(errorSnap.syncText)
        ) {
          break;
        }
        await page.waitForTimeout(400);
      }
      failAdds = false;
      await page.unroute("**/api/build/add-moves");
      const recovered = await waitForBuildSaved(page, BUILD_SYNC_TIMEOUT_MS * 3);
      record("4-recovery", "sync-failure", {
        expected: "add-moves 503 → dirty/error chip; recovers to saved after route restored",
        actual: { repName, errorSnap, recovered },
        recovery: "Wait for backoff retry or reload after connection returns",
        priority: errorSnap?.syncClass?.includes("is-error") ? "P2 — error state OK" : "P1 — no error surfacing",
        pass:
          errorSnap &&
          (errorSnap.syncClass.includes("is-error") ||
            errorSnap.syncClass.includes("is-dirty") ||
            /offline|unsaved|retry/i.test(errorSnap.syncText)) &&
          recovered.cls.includes("is-saved"),
      });
    } catch (err) {
      record("4-recovery", "sync-failure", {
        actual: { error: err.message, repName },
        pass: false,
        priority: "P1",
      });
    }
    if (ctx) await ctx.close();
  }

  // --- Recovery: Dashboard refresh after create (NOT required) ---
  {
    let ctx;
    let page;
    const repName = `Audit Dash ${Date.now()}`;
    try {
      ({ ctx, page } = await createSignedInContext({ width: 1280, height: 800 }));
      await createRepertoireFromDashboard(page, { name: repName, color: "black" });
      await gotoDashboard(page);
      await page.waitForTimeout(800);
      const dash = await page.evaluate((expectedName) => {
        const names = [...document.querySelectorAll("#dashboard-repertoires .name")].map((el) =>
          el.textContent.trim(),
        );
        const colors = [...document.querySelectorAll("#dashboard-repertoires .color-dot")].map((el) =>
          el.classList.contains("black") ? "black" : "white",
        );
        return {
          names,
          colors,
          hasRep: names.some((n) => n.includes(expectedName)),
          metricsRepertoires: document.querySelector("#dashboard-metrics .metric-value")?.textContent?.trim(),
        };
      }, repName);
      record("5-recovery", "dashboard-refresh", {
        expected: "After create, Dashboard lists new repertoire with correct name/color",
        actual: { repName, dash },
        recovery: "Refresh dashboard or switch tabs if list stale",
        priority: dash.hasRep ? "P3 — dashboard refresh OK" : "P1 — repertoire missing on dashboard",
        pass: dash.hasRep && dash.names.join(" ").includes(repName),
      });
    } catch (err) {
      record("5-recovery", "dashboard-refresh", {
        actual: { error: err.message, repName },
        pass: false,
        priority: "P1",
      });
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

  console.log(`[build-friction-audit] recorded ${total} scenarios (${passed} pass flags)`);
  console.log(
    `[build-friction-audit] required signed-in: ${required.length - requiredFailed.length}/${required.length} passed`,
  );
  console.log(`[build-friction-audit] evidence → ${OUT_JSON}`);
  console.log(`[build-friction-audit] clientlog beacons: ${evidence.clientlogRequests.length}`);
  console.log(`[build-friction-audit] console messages: ${evidence.console.length}`);

  if (requiredFailed.length) {
    console.error("[build-friction-audit] FAIL: required signed-in scenarios:");
    for (const row of requiredFailed) {
      console.error(`  - ${row.id}: ${row.actual?.error || row.priority || "failed"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[build-friction-audit] FAIL: ${err.message}`);
  process.exit(1);
});