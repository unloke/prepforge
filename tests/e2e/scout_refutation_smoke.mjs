// Playwright smoke: deterministic Scout prep-row refutation fixtures (real report HTML).
// Invoked by tests/e2e/test_scout_smoke.py after uvicorn boots locally.
//
// Requires an E2E build (VITE_ENABLE_SCOUT_E2E=1) and ?scout_e2e=1 query opt-in.
import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
const APP_URL = `${BASE}/?scout_e2e=1`;
const TIMEOUT_MS = Number(process.env.E2E_SCOUT_TIMEOUT_MS || 120_000);

const SCENARIOS = [
  {
    id: "confirmedHit",
    async assert(page) {
      const prepLine = page.locator(".scout-line").first();
      await prepLine.waitFor({ timeout: TIMEOUT_MS });
      const prepText = await prepLine.textContent();
      if (!prepText || !/When they play/i.test(prepText) || !/(you play|needs prep)/i.test(prepText)) {
        fail(`prep column missing framing (got: ${prepText?.trim().slice(0, 160) || "(empty)"})`);
      }
      const card = page.locator('[data-testid="scout-refutation-card"]').first();
      await card.waitFor({ timeout: TIMEOUT_MS });
      const cardText = await card.textContent();
      if (!cardText || !/You answer/i.test(cardText)) {
        fail(`inline refutation card missing punishment copy (${cardText || "(empty)"})`);
      }
      if (!cardText.includes("+")) {
        fail(`refutation card eval swing should be positive for the player (${cardText})`);
      }
    },
  },
  {
    id: "deepScanGap",
    async assert(page) {
      const deepScanGap = page.locator('[data-testid="scout-refutation-gap-deep-scan"]').first();
      await deepScanGap.waitFor({ timeout: TIMEOUT_MS });
      await deepScanGap.click();
      const jobTitle = page.locator(".job-toast-title");
      try {
        await jobTitle.filter({ hasText: /Scout Deep Scan/i }).waitFor({ timeout: 10_000 });
      } catch {
        fail("Deep scan gap CTA did not start the scout deep scan job");
      }
    },
  },
  {
    id: "oauthGap",
    async assert(page) {
      const card = page.locator('[data-testid="scout-refutation-card"]').first();
      await card.waitFor({ timeout: TIMEOUT_MS });
      const cardText = await card.textContent();
      if (!cardText || !/You answer/i.test(cardText)) {
        fail(`engine refutation card missing in OAuth-gap fixture (${cardText || "(empty)"})`);
      }
    },
  },
];

function fail(msg) {
  console.error(`[scout-refutation-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function registerSession(page) {
  const email = `scout-refute-e2e-${Date.now()}@example.com`;
  const password = "scout-refute-e2e-pass-12";
  await page.request.get(`${BASE}/api/csrf`);
  const csrfCookie = (await page.context().cookies()).find((c) => c.name === "pf_csrf");
  const csrf = csrfCookie?.value || "";
  const reg = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: { email, password, display_name: "Scout Refutation E2E" },
  });
  if (!reg.ok()) fail(`register failed: ${reg.status()} ${await reg.text()}`);
}

async function mountScenario(page, scenarioId) {
  const mounted = await page.evaluate(async (id) => {
    const hook = window.__prepforgeScoutE2e;
    if (!hook?.mountRefutationScenario) {
      return { ok: false, error: "window.__prepforgeScoutE2e.mountRefutationScenario missing" };
    }
    try {
      const result = await hook.mountRefutationScenario(id);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }, scenarioId);
  if (!mounted?.ok) {
    fail(`fixture mount failed for ${scenarioId}: ${mounted?.error || "unknown error"}`);
  }
  await page.locator(`[data-e2e-refutation="${scenarioId}"]`).waitFor({ timeout: TIMEOUT_MS });
}

async function waitForE2eHook(page) {
  await page.waitForFunction(
    () => typeof window.__prepforgeScoutE2e?.mountRefutationScenario === "function",
    undefined,
    { timeout: TIMEOUT_MS },
  );
}

async function activateScout(page) {
  await page
    .locator("#dashboard-repertoires > *")
    .first()
    .waitFor({ state: "attached", timeout: TIMEOUT_MS });
  await page.click('[data-testid="nav-scout"]');
  await page.locator("#view-replay.is-active").waitFor({ timeout: 10_000 });
  await page.locator('.replay-card-scout:not([hidden])').waitFor({ timeout: 10_000 });
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
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await waitForE2eHook(page);
    await registerSession(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForE2eHook(page);
    await activateScout(page);

    for (const [index, scenario] of SCENARIOS.entries()) {
      // Deep-scan is intentionally asynchronous. Reload between scenarios so
      // its job/toast cannot mutate the next fixture's report in a slower CI runner.
      if (index > 0) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitForE2eHook(page);
        await activateScout(page);
      }
      await mountScenario(page, scenario.id);
      await scenario.assert(page);
      console.log(`[scout-refutation-smoke] ${scenario.id} passed.`);
      await sleep(300);
    }

    console.log("[scout-refutation-smoke] passed.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.message || String(err)));
