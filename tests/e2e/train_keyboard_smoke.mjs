// Playwright smoke: play one Smart Train move entirely from the keyboard, then
// exercise the board's roving-focus navigation.
// Invoked by tests/e2e/test_train_keyboard_smoke.py after uvicorn boots locally.
//
// The Train board keeps a roving tabindex (one tabbable square, arrows move
// focus — the ARIA grid pattern) and supports Enter/Space pick-and-move
// (squares are <button>s). This walks the real flow — API-created repertoire,
// Smart queue start, keyboard selection + move — and asserts:
//   1. the board exposes exactly ONE tab stop (never 64),
//   2. arrow keys move focus (including across the flipped board),
//   3. the from-square button exposes aria-pressed="true" while selected,
//   4. the move lands (graded banner flips to the correct state),
//   5. aria-pressed resets on every square after the move.
//
// Env:
//   E2E_BASE_URL — default http://127.0.0.1:9876

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.E2E_TRAIN_TIMEOUT_MS || 45_000);

function fail(msg) {
  console.error(`[train-keyboard-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function registerSession(page) {
  const email = `train-kb-e2e-${Date.now()}@example.com`;
  const password = "train-kb-e2e-pass-12";
  await page.request.get(`${BASE}/api/csrf`);
  const csrfCookie = (await page.context().cookies()).find((c) => c.name === "pf_csrf");
  const csrf = csrfCookie?.value || "";
  const reg = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: { email, password, display_name: "Train Keyboard E2E" },
  });
  if (!reg.ok()) fail(`register failed: ${reg.status()} ${await reg.text()}`);
  const session = (await page.context().cookies()).find((c) => c.name === "pf_session");
  if (!session) fail("pf_session cookie missing after register");
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

// One prepared white line: 1. e4 — the smart queue has exactly one trainable
// move, so the first prompt must be the e2e4 teach card.
async function seedRepertoire(page, csrf) {
  const created = await apiPost(page, csrf, "/api/repertoires/create", {
    name: "Keyboard E2E",
    color: "white",
  });
  const repertoireId = created.repertoire_id;
  await apiPost(page, csrf, "/api/build/add-moves", {
    repertoire_id: repertoireId,
    moves: [
      { tempId: "tmp-kb-e4", parentRef: created.selected_node_id, uci: "e2e4" },
    ],
  });
  return repertoireId;
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

  try {
    const page = await browser.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const { csrf } = await registerSession(page);
    await seedRepertoire(page, csrf);
    await page.reload({ waitUntil: "domcontentloaded" });

    // Let the signed-in workspace load finish before navigating: mid-boot the
    // later restoreWorkspaceLocation() re-enters the restored view and (for
    // Train) auto-starts a session, which hides the setup panel mid-click.
    // The dashboard repertoire list renders at the end of that load.
    await page
      .locator("#dashboard-repertoires > *")
      .first()
      .waitFor({ timeout: 30_000 });

    // Train: the fresh account has exactly one repertoire, so the picker
    // defaults to it.
    await page.click('[data-testid="nav-train"]');
    await page.locator("#view-train.is-active").waitFor({ timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const select = document.getElementById("train-repertoire-select");
        return select && select.options.length > 0 && select.value !== "";
      },
      null,
      { timeout: 15_000 },
    ).catch(() => fail("train repertoire select never populated"));

    await page.click('[data-testid="start-train"]');
    // Smart prompt lands on the teach banner for the single prepared move.
    const banner = page.locator('[data-testid="train-feedback"]');
    await page
      .locator('[data-testid="train-feedback"][data-state="teach"]')
      .waitFor({ timeout: TIMEOUT_MS });
    const teachTitle = (await banner.locator("#train-banner-title").textContent()) || "";
    if (!/e4/i.test(teachTitle)) {
      fail(`teach banner does not name e4 (got: ${teachTitle.trim() || "(empty)"})`);
    }

    const board = page.locator('[data-testid="train-board"]');
    const e2 = board.locator('button.square[data-square="e2"]');
    const e4 = board.locator('button.square[data-square="e4"]');
    if ((await e2.getAttribute("aria-label")) !== "white pawn e2") {
      fail(`e2 aria-label should name the piece ("white pawn e2"), got: ${await e2.getAttribute("aria-label")}`);
    }

    // Keyboard pick: focus e2, press Enter. The button exposes aria-pressed
    // while selected so screen readers announce the pick.
    await e2.focus();
    await e2.press("Enter");
    if ((await e2.getAttribute("aria-pressed")) !== "true") {
      fail(`e2 aria-pressed should be "true" after keyboard select, got: ${await e2.getAttribute("aria-pressed")}`);
    }

    // Keyboard move: focus e4, press Enter. The prompt is graded locally and
    // the banner flips to the correct state with the learned move.
    await e4.focus();
    await e4.press("Enter");
    await page
      .locator('[data-testid="train-feedback"][data-state="correct"]')
      .waitFor({ timeout: TIMEOUT_MS });

    // Selection state cleared on every square after the move.
    await page.waitForFunction(() => {
      const pressed = document.querySelectorAll('#train-board button.square[aria-pressed="true"]');
      return pressed.length === 0;
    }, { timeout: 10_000 }).catch(() => fail("some square keeps aria-pressed=true after the move"));

    const statsCorrect = ((await page.locator('#train-stat-correct').textContent()) || "").trim();
    if (statsCorrect !== "1") {
      fail(`correct counter should be 1 after the keyboard move (got: ${statsCorrect || "(empty)"})`);
    }

    // --- Roving focus: the board is ONE tab stop, never 64. ---
    const roving = await page.evaluate(() => {
      const board = document.getElementById("train-board");
      const tabbables = board.querySelectorAll('button.square[tabindex="0"]');
      return { count: tabbables.length, square: tabbables[0]?.dataset?.square || null };
    });
    if (roving.count !== 1 || roving.square !== "e2") {
      fail(
        `board must keep exactly 1 tabbable square (the roving e2), got ${roving.count}` +
          ` (square: ${String(roving.square)})`,
      );
    }
    // Real-Tab regression guard: with the old 64-stop grid, Tab from e2 landed
    // on e3; with a roving tabindex it must leave the board entirely.
    await board.locator('button.square[data-square="e2"]').focus();
    await page.keyboard.press("Tab");
    const afterTab = await page.evaluate(() => document.activeElement?.dataset?.square || null);
    if (afterTab !== null) {
      fail(`Tab from the roving square must leave the board, but it landed on square ${afterTab}`);
    }

    // --- Arrows move focus inside the board (white orientation). ---
    const focusOf = () =>
      page.evaluate(() => document.activeElement?.dataset?.square || null);
    await board.locator('button.square[data-square="e2"]').focus();
    await page.keyboard.press("ArrowRight"); // e2 -> f2
    if ((await focusOf()) !== "f2") fail(`ArrowRight from e2 should focus f2, got ${await focusOf()}`);
    await page.keyboard.press("ArrowUp"); // f2 -> f3
    if ((await focusOf()) !== "f3") fail(`ArrowUp from f2 should focus f3, got ${await focusOf()}`);
    await page.keyboard.press("ArrowLeft"); // f3 -> e3
    if ((await focusOf()) !== "e3") fail(`ArrowLeft from f3 should focus e3, got ${await focusOf()}`);
    await page.keyboard.press("ArrowDown"); // e3 -> e2
    if ((await focusOf()) !== "e2") fail(`ArrowDown from e3 should focus e2, got ${await focusOf()}`);
    // Edge: no wrap-around, focus holds.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    if ((await focusOf()) !== "e1") fail(`ArrowDown should hold at the edge e1, got ${await focusOf()}`);

    // --- Roving cursor survives a board flip; arrows follow the screen. ---
    // Keyboard flip (F flips the active tab's board): focus stays in the board
    // on the same square.
    await page.keyboard.press("f");
    if ((await focusOf()) !== "e1") fail(`F-flip should keep focus on e1, got ${await focusOf()}`);
    await page.keyboard.press("ArrowLeft"); // visually left from e1 is f1 on a flipped board
    if ((await focusOf()) !== "f1") fail(`ArrowLeft from e1 on a flipped board should focus f1, got ${await focusOf()}`);
    // Flipped board draws rank 1 at the TOP, so visually DOWN from f1 is f2.
    await page.keyboard.press("ArrowDown");
    if ((await focusOf()) !== "f2") fail(`ArrowDown from f1 on a flipped board should focus f2, got ${await focusOf()}`);
    // Visually UP from f2 is back to f1 (the top row on a flipped board).
    await page.keyboard.press("ArrowUp");
    if ((await focusOf()) !== "f1") fail(`ArrowUp from f2 on a flipped board should focus f1, got ${await focusOf()}`);
    // Edge: f1 is the top row when flipped, so UP holds.
    await page.keyboard.press("ArrowUp");
    if ((await focusOf()) !== "f1") fail(`ArrowUp from f1 on a flipped board should hold (top row), got ${await focusOf()}`);
    // Button flip: focus moves to the toolbar button (browser default), but the
    // roving cursor must survive the rebuild on the last-visited square.
    await page.click("#train-flip"); // back to white
    const whiteRoving = await page.evaluate(() => {
      const sq = document.querySelector('#train-board button.square[tabindex="0"]');
      return sq?.dataset?.square || null;
    });
    if (whiteRoving !== "f1") {
      fail(`after button flip the roving cursor should stay f1, got ${String(whiteRoving)}`);
    }

    console.log("[train-keyboard-smoke] passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.message || String(err)));
