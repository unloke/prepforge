// Playwright smoke: Scout streaming flow on a running PrepForge server.
// Invoked by tests/e2e/test_scout_smoke.py after uvicorn boots locally.
//
// Env:
//   E2E_BASE_URL   — default http://127.0.0.1:9876
//   E2E_SCOUT_USER — Lichess username (default DrNykterstein)
import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
// DrNykterstein (Hikaru) — stable public export; "hikaru" 404s on Lichess as of 2026-06.
const SCOUT_USER = process.env.E2E_SCOUT_USER || "DrNykterstein";
const TIMEOUT_MS = Number(process.env.E2E_SCOUT_TIMEOUT_MS || 90_000);

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

async function waitForCounterAtLeast(page, min, timeoutMs) {
  const counter = page.locator('[data-testid="scout-live-count"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = (await counter.textContent()) || "0";
    const n = Number.parseInt(text.trim(), 10);
    if (Number.isFinite(n) && n >= min) return n;
    await sleep(250);
  }
  const finalText = await counter.textContent();
  fail(`live counter did not reach ${min} (got "${finalText}")`);
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
    await page.selectOption("#scout-color", "both");
    await page.fill("#scout-username", SCOUT_USER);
    await page.click('[data-testid="scout-btn"]');

    const profile = page.locator(".scout-profile-card");
    try {
      await profile.waitFor({ timeout: TIMEOUT_MS });
    } catch {
      const errText = await page.locator(".scout-error, .scout-results").first().textContent();
      fail(`scout report did not render: ${(errText || "").trim() || "no output"}`);
    }

    const countAfterStart = await waitForCounterAtLeast(page, 1, TIMEOUT_MS);
    if (countAfterStart < 1) fail("live counter did not increment after Start");

    await page.waitForSelector(".scout-coverage-bar", { timeout: TIMEOUT_MS });

    const scoutBtn = page.locator('[data-testid="scout-btn"]');
    await scoutBtn.filter({ hasText: /^Stop$/ }).waitFor({ timeout: TIMEOUT_MS });
    await scoutBtn.click();
    await scoutBtn.filter({ hasText: /^Resume$/ }).waitFor({ timeout: 15_000 });
    const countAfterStop = Number.parseInt(
      (await page.locator('[data-testid="scout-live-count"]').textContent()) || "0",
      10,
    );
    if (!Number.isFinite(countAfterStop) || countAfterStop < 1) {
      fail(`counter invalid after Stop (${countAfterStop})`);
    }

    const colorDisabledWhilePaused = await page.locator("#scout-color").isDisabled();
    if (!colorDisabledWhilePaused) {
      fail("colour selector should be disabled while paused — use Reset to change colour");
    }

    await page.click('[data-testid="scout-btn"]');
    await page
      .locator('[data-testid="scout-btn"]')
      .filter({ hasText: /^(Stop|Resume)$/ })
      .waitFor({ timeout: TIMEOUT_MS });
    await sleep(1500);
    const countAfterResume = Number.parseInt(
      (await page.locator('[data-testid="scout-live-count"]').textContent()) || "0",
      10,
    );
    if (!Number.isFinite(countAfterResume) || countAfterResume < countAfterStop) {
      fail(`counter regressed after Resume (${countAfterResume} < ${countAfterStop})`);
    }

    const firstLine = page.locator(".scout-line").first();
    await firstLine.waitFor({ timeout: TIMEOUT_MS });
    const prepText = (await firstLine.textContent()) || "";
    if (!/When they play/i.test(prepText) || !/you play/i.test(prepText)) {
      fail(`prep row missing when-they-play framing (got: ${prepText.trim().slice(0, 120) || "(empty)"})`);
    }
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