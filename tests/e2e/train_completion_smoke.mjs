// Playwright smoke: finish a Smart Train session while the Repertoire (Build) tree
// is open, which is the state that used to crash on completion.
// Invoked by tests/e2e/test_train_completion_smoke.py after uvicorn boots locally.
//
// The regression: finishing a session refreshed the open repertoire's tree by
// calling hydrateBuild(appState.build.repertoire_id). hydrateBuild takes the
// /api/build/load PAYLOAD, so appState.build became a string and payload.nodes.map
// threw; the next paint (syncViewHeads) read build.nodes.filter and reported
// "Cannot read properties of undefined (reading 'filter')" — the error the user saw
// the instant training finished. It only fired when a tree was open, so the walk
// below must open the Repertoire page first.
//
// Asserts:
//   1. finishing the last card shows the result card,
//   2. no pageerror or unhandled rejection is raised by the finish,
//   3. the Repertoire header still names the repertoire afterwards (a string where
//      the tree belongs would have blanked/crashed it),
//   4. the builder still renders the tree, and the trained moves now read as
//      learned — proving the re-read landed instead of being skipped.
//
// Env:
//   E2E_BASE_URL — default http://127.0.0.1:9876

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.E2E_TRAIN_TIMEOUT_MS || 60_000);

function fail(msg) {
  console.error(`[train-completion-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function registerSession(page) {
  const email = `train-complete-e2e-${Date.now()}@example.com`;
  await page.request.get(`${BASE}/api/csrf`);
  const csrf = (await page.context().cookies()).find((c) => c.name === "pf_csrf")?.value || "";
  const res = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: { email, password: "train-complete-e2e-pass-12", display_name: "Train Completion E2E" },
  });
  if (!res.ok()) fail(`register failed: ${res.status()} ${await res.text()}`);
  return { csrf };
}

async function apiPost(page, csrf, path, body) {
  const res = await page.request.post(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: body,
  });
  if (!res.ok()) fail(`POST ${path} failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

// Two prepared white lines (1.e4 c6, 1.d4 c5): four own moves, so the queue has
// more than one card and the finish is a real end-of-queue, not a single card.
async function seedRepertoire(page, csrf) {
  const created = await apiPost(page, csrf, "/api/repertoires/create", { name: "Completion E2E", color: "white" });
  const repertoireId = created.repertoire_id;
  const add = async (tempId, parentRef, uci) => {
    const res = await apiPost(page, csrf, "/api/build/add-moves", {
      repertoire_id: repertoireId,
      moves: [{ tempId, parentRef, uci }],
    });
    return res.id_map[tempId];
  };
  const root = created.selected_node_id;
  const e4 = await add("tmp-cm-e4", root, "e2e4");
  await add("tmp-cm-c6", e4, "c7c6");
  const d4 = await add("tmp-cm-d4", root, "d2d4");
  await add("tmp-cm-c5", d4, "c7c5");
  return repertoireId;
}

// Click the two squares of a UCI move on the Train board.
async function playMove(page, uci) {
  for (const square of [uci.slice(0, 2), uci.slice(2, 4)]) {
    await page.evaluate((name) => {
      document.querySelector(`#train-board .square[data-square="${name}"]`)?.click();
    }, square);
    await page.waitForTimeout(150);
  }
  // The card animates the move, the reply, then advances.
  await page.waitForTimeout(2400);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("playwright not installed — run npm ci && npx playwright install chromium");
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
  if (!browser) fail("no Chromium browser available");

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack || ""}`));
  // A floating async refresh reports through the rejection handler, not pageerror.
  await page.addInitScript(() => {
    window.__completionRejections = [];
    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason;
      window.__completionRejections.push(`${(reason && reason.message) || reason}\n${(reason && reason.stack) || ""}`);
    });
  });

  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const { csrf } = await registerSession(page);
    const repertoireId = await seedRepertoire(page, csrf);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('html[data-app-ready="true"]').waitFor({ timeout: 30_000 });
    await page.locator("#dashboard-repertoires > *").first().waitFor({ timeout: 30_000 });

    // 1) Open the repertoire so appState.build is a live tree — the precondition
    //    that made the old refresh corrupt it.
    await page.click(`.lib-row[data-repertoire-id="${repertoireId}"]`);
    await page.locator("#builder-tree .mtree-move").first().waitFor({ timeout: TIMEOUT_MS });
    const headerBefore = ((await page.locator("#build-rep-name").textContent()) || "").trim();
    if (!/Completion E2E/.test(headerBefore)) fail(`Repertoire header should name the repertoire, got "${headerBefore}"`);

    // 2) Leave the builder but keep it loaded, then run the queue from Library.
    await page.click('[data-testid="nav-dashboard"]');
    await page.waitForTimeout(1000);

    const startResponse = page
      .waitForResponse((res) => res.url().includes("/api/train/smart/start"), { timeout: TIMEOUT_MS })
      .catch(() => null);
    await page.click('[data-testid="dashboard-train-now"]');
    const started = await startResponse;
    if (!started) fail("Smart queue never started");
    const payload = await started.json();
    const cards = payload.cards || [];
    if (!cards.length) fail("start payload carried no cards");

    // 3) Answer every card with its prepared move.
    for (const card of cards) {
      for (const target of card.targets || []) {
        await playMove(page, target.uci);
        if (errors.length || (await page.evaluate(() => window.__completionRejections.length))) {
          fail(`finishing ${target.uci} raised:\n${errors.join("\n")}\n${await page.evaluate(() => window.__completionRejections.join("\n"))}`);
        }
      }
    }

    // The finish flushes the graded attempts, reads the summary, then refreshes
    // the Library listing and the open tree. Give that tail time to land.
    await page.locator("#train-summary:not([hidden])").waitFor({ timeout: TIMEOUT_MS })
      .catch(() => fail("the result card never appeared after the last card"));
    await page.waitForTimeout(6000);

    const rejections = await page.evaluate(() => window.__completionRejections || []);
    if (errors.length) fail(`completion raised a page error:\n${errors.join("\n\n")}`);
    if (rejections.length) fail(`completion raised an unhandled rejection:\n${rejections.join("\n\n")}`);

    // 4) The poisoned state was appState.build itself: the header reads it.
    const headerAfter = ((await page.locator("#build-rep-name").textContent()) || "").trim();
    if (!/Completion E2E/.test(headerAfter)) {
      fail(`Repertoire header lost its repertoire after finishing (got "${headerAfter}")`);
    }

    // 5) The re-read must have landed: the trained moves now read "Learning"
    //    instead of "Not trained yet".
    await page.click('[data-testid="nav-build"]');
    await page.locator("#builder-tree .mtree-move").first().waitFor({ timeout: TIMEOUT_MS });
    const mastery = await page.evaluate(() =>
      [...document.querySelectorAll("#builder-tree .mtree-move")]
        .map((el) => [...el.classList].filter((name) => name.startsWith("m-")).join(""))
        .filter(Boolean),
    );
    const trained = await page.evaluate(() =>
      [...document.querySelectorAll("#builder-tree .mtree-move")].filter((el) =>
        /Learning|Mastered/.test(el.getAttribute("title") || ""),
      ).length,
    );
    if (trained < 2) {
      fail(`the trained moves should read as learned after the finish, got ${JSON.stringify(mastery)}`);
    }

    console.log("[train-completion-smoke] passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.stack || err.message || String(err)));
