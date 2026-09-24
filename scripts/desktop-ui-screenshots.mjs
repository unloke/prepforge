// Capture the shipped workspaces against a local API server with a fresh account.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:9876";
const out = ".impeccable/review/final";
await mkdir(out, { recursive: true });

let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try {
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    break;
  } catch { /* Try another installed Chromium. */ }
}
if (!browser) throw new Error("No Chromium browser available");

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.request.get(`${base}/api/csrf`);
  const csrf = (await context.cookies()).find((cookie) => cookie.name === "pf_csrf")?.value || "";
  const registered = await page.request.post(`${base}/api/auth/register`, {
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    data: { email: `desktop-ui-${Date.now()}@example.com`, password: "desktop-ui-review-12", display_name: "UI Review" },
  });
  if (!registered.ok()) throw new Error(`Registration failed: ${registered.status()}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#view-dashboard.is-active").waitFor();

  await page.getByTestId("account-chip").click();
  await page.locator('#account-menu [data-action="settings"]').first().click();
  await page.locator("#view-settings.is-active").waitFor();
  await page.locator('#settings-theme-seg [data-theme-value="dark"]').click();
  await page.screenshot({ path: `${out}/settings-desktop.png` });

  for (const [name, nav, view] of [
    ["analyze", "nav-analyze", "view-analyze"],
    ["build", "nav-build", "view-build"],
    ["train", "nav-train", "view-train"],
    ["games", "nav-replay", "view-replay"],
    ["scout", "nav-scout", "view-replay"],
    ["teams", "nav-teams", "view-teams"],
  ]) {
    await page.getByTestId(nav).click();
    await page.locator(`#${view}.is-active`).waitFor();
    await page.screenshot({ path: `${out}/${name}-desktop.png` });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("nav-analyze").click();
  await page.locator("#view-analyze.is-active").waitFor();
  await page.screenshot({ path: `${out}/analyze-mobile.png`, fullPage: true });
  console.log(`Captured desktop views and mobile Analyze in ${out}`);
} finally {
  await browser.close();
}
