// Playwright smoke: Scout flow on a running PrepForge server.
// Invoked by tests/e2e/test_scout_smoke.py after uvicorn boots locally.
//
// Env:
//   E2E_BASE_URL   — default http://127.0.0.1:9876
//   E2E_SCOUT_USER — Lichess username (default hikaru)
import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
// DrNykterstein (Hikaru) — stable public export; "hikaru" 404s on Lichess as of 2026-06.
const SCOUT_USER = process.env.E2E_SCOUT_USER || "DrNykterstein";
const TIMEOUT_MS = Number(process.env.E2E_SCOUT_TIMEOUT_MS || 60_000);

function fail(msg) {
  console.error(`[scout-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function registerSession(page) {
  const email = `scout-e2e-${Date.now()}@example.com`;
  const password = "scout-e2e-pass-12";
  await page.request.get(`${BASE}/api/csrf`);
  const csrfCookie = (await page.context().cookies()).find((c) => c.name === "pf_csrf");
  const csrf = csrfCookie?.value || "";
  const reg = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: { email, password, display_name: "Scout E2E" },
  });
  if (!reg.ok()) fail(`register failed: ${reg.status()} ${await reg.text()}`);
  const session = (await page.context().cookies()).find((c) => c.name === "pf_session");
  if (!session) fail("pf_session cookie missing after register");
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
    await registerSession(page);
    await page.reload({ waitUntil: "domcontentloaded" });

    await page.click('[data-testid="nav-replay"]');
    await page.selectOption("#scout-count", "50");
    await page.fill("#scout-username", SCOUT_USER);
    await page.click('[data-testid="scout-btn"]');

    const profile = page.locator(".scout-profile-card");
    try {
      await profile.waitFor({ timeout: TIMEOUT_MS });
    } catch {
      const errText = await page.locator(".scout-error, .scout-results").first().textContent();
      fail(`scout report did not render: ${(errText || "").trim() || "no output"}`);
    }
    await page.waitForSelector(".scout-coverage-bar", { timeout: TIMEOUT_MS });
    const firstLine = page.locator(".scout-line").first();
    await firstLine.waitFor({ timeout: TIMEOUT_MS });
    await firstLine.click();
    const detail = page.locator(".scout-line-detail").first();
    await detail.waitFor({ timeout: 10_000 });
    await detail.locator(".scout-action-analyze").click();

    await page.waitForSelector("#view-analyze.is-active", { timeout: 10_000 });
    const pgn = await page.inputValue("#pgn-input");
    if (!pgn || !pgn.includes(SCOUT_USER)) {
      fail(`Analyze tab PGN missing scout line (got: ${pgn?.slice(0, 80) || "(empty)"})`);
    }

    console.log("[scout-smoke] passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.message || String(err)));