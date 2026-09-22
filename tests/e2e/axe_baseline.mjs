// axe accessibility baseline (node script, run under pytest like scout_smoke).
// Boots the same way test_scout_smoke.py does (uvicorn on throwaway sqlite,
// register via browser) and runs @axe-core/playwright over representative
// screens: Dashboard / Analyze / Build / Train / Games+Scout / Settings /
// command palette / one modal dialog. Prints JSON to stdout; exits nonzero
// on any serious/critical first-party violation.
import { setTimeout as sleep } from "node:timers/promises";

const BASE = (process.env.E2E_BASE_URL || "http://127.0.0.1:9876").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.E2E_AXE_TIMEOUT_MS || 60_000);

function fail(msg) {
  console.error(`[axe-baseline] FAIL: ${msg}`);
  process.exit(1);
}

async function registerSession(page) {
  const email = `axe-e2e-${Date.now()}@example.com`;
  const password = "axe-e2e-pass-12";
  await page.request.get(`${BASE}/api/csrf`);
  const csrfCookie = (await page.context().cookies()).find((c) => c.name === "pf_csrf");
  const csrf = csrfCookie?.value || "";
  const reg = await page.request.post(`${BASE}/api/auth/register`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: { email, password, display_name: "Axe E2E" },
  });
  if (!reg.ok()) fail(`register failed: ${reg.status()} ${await reg.text()}`);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    fail("playwright not installed — run npm ci && npx playwright install chromium");
  }
  let AxeBuilder;
  try {
    ({ AxeBuilder } = await import("@axe-core/playwright"));
  } catch {
    fail("@axe-core/playwright not installed — run npm install --no-save @axe-core/playwright");
  }

  let browser;
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      break;
    } catch { /* try next */ }
  }
  if (!browser) fail("no Chromium browser available");

  const results = {};
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await registerSession(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#dashboard-repertoires > *").first().waitFor({ timeout: TIMEOUT_MS }).catch(() => {});

    const scan = async (name, run) => {
      await run();
      await sleep(400);
      const r = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const serious = (r.violations || []).filter((v) => v.impact === "serious" || v.impact === "critical");
      results[name] = {
        violations: serious.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 3).map((n) => n.target),
        })),
        incomplete: (r.incomplete || []).length,
      };
    };

    await scan("dashboard", async () => {
      await page.click('[data-testid="nav-dashboard"]');
      await page.locator("#view-dashboard.is-active").waitFor({ timeout: 10_000 });
    });
    await scan("analyze", async () => {
      await page.click('[data-testid="nav-analyze"]');
      await page.locator("#view-analyze.is-active").waitFor({ timeout: 10_000 });
    });
    await scan("build", async () => {
      await page.click('[data-testid="nav-build"]');
      await page.locator("#view-build.is-active").waitFor({ timeout: 10_000 });
    });
    await scan("train", async () => {
      await page.click('[data-testid="nav-train"]');
      await page.locator("#view-train.is-active").waitFor({ timeout: 10_000 });
    });
    await scan("games", async () => {
      await page.click('[data-testid="nav-replay"]');
      await page.locator("#view-replay.is-active").waitFor({ timeout: 10_000 });
      await page.locator('.replay-card-games:not([hidden])').waitFor({ timeout: 10_000 });
    });
    await scan("scout", async () => {
      await page.click('[data-testid="nav-scout"]');
      await page.locator("#view-replay.is-active").waitFor({ timeout: 10_000 });
      await page.locator('.replay-card-scout:not([hidden])').waitFor({ timeout: 10_000 });
    });
    await scan("settings", async () => {
      await page.click('[data-testid="account-chip"]');
      await page.locator('#account-menu [data-action="settings"]').first().click().catch(() => {});
      await page.locator("#view-settings.is-active").waitFor({ timeout: 10_000 });
    });
    await scan("command-palette", async () => {
      await page.click('[data-testid="open-palette"]');
      await page.locator("#command-palette:not([hidden])").waitFor({ timeout: 10_000 });
    });
    await page.keyboard.press("Escape").catch(() => {});
    await scan("modal-dialog", async () => {
      await page.click('[data-testid="nav-dashboard"]');
      await page.click('[data-testid="dashboard-new-rep"]');
      await page.locator(".modal-overlay .modal").first().waitFor({ timeout: 10_000 });
    });

    console.log(JSON.stringify(results, null, 2));
    const bad = Object.entries(results).filter(([, r]) => r.violations.length > 0);
    if (bad.length) {
      fail(`${bad.length} screen(s) with serious/critical violations: ${bad.map(([k]) => k).join(", ")}`);
    }
    console.log("[axe-baseline] passed — no serious/critical violations.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.message || String(err)));
