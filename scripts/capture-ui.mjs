import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = process.env.UI_BASE_URL || "http://127.0.0.1:5174/static/";
const out = "artifacts/ui-screenshots";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "msedge" }).catch(() => chromium.launch({ headless: true }));

for (const [device, width, height] of [["desktop", 1440, 900], ["tablet", 820, 1024], ["mobile", 390, 844]]) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.request.get("http://127.0.0.1:8765/api/csrf");
  const csrf = (await context.cookies()).find((cookie) => cookie.name === "pf_csrf")?.value;
  const signup = await page.request.post("http://127.0.0.1:8765/api/auth/register", {
    headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    data: { email: `ui-${device}-${Date.now()}@example.com`, password: "ui-e2e-password-12", display_name: "UI Review" },
  });
  if (!signup.ok()) throw new Error(`UI session setup failed: ${signup.status()}`);
  await page.evaluate(() => localStorage.setItem("prepforge.prefs", JSON.stringify({ theme: "dark" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  for (const [name, selector] of [
    ["dashboard", '[data-testid="nav-dashboard"]'],
    ["analyze", '[data-testid="nav-analyze"]'],
    ["build", '[data-testid="nav-build"]'],
    ["train", '[data-testid="nav-train"]'],
    ["games", '[data-testid="nav-replay"]'],
    ["scout", '[data-testid="nav-scout"]'],
    ["teams", '[data-testid="nav-teams"]'],
    ["settings", '[data-testid="nav-settings"]'],
  ]) {
    await page.locator(selector).click();
    await page.waitForTimeout(120);
    const active = await page.locator(".view.is-active").count();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
    console.log(JSON.stringify({ device, name, active, overflow }));
    await page.screenshot({ path: `${out}/${device}-${name}.png`, fullPage: true });
  }
  if (device === "desktop") {
    const create = async (name, color) => {
      const response = await page.request.post("http://127.0.0.1:8765/api/repertoires/create", {
        headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
        data: { name, color },
      });
      if (!response.ok()) throw new Error(`Repertoire seed failed: ${response.status()}`);
    };
    await create("White · Italian structures", "white");
    await page.locator('[data-testid="nav-dashboard"]').click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-repertoire-id]').first().waitFor();
    await page.screenshot({ path: `${out}/desktop-dashboard-normal.png`, fullPage: true });
    await page.evaluate(() => {
      const host = document.querySelector("#dashboard-repertoires");
      host.innerHTML = Array.from({ length: 14 }, (_, i) =>
        `<div class="list-item"><span><span class="color-dot ${i % 2 ? "black" : "white"}"></span><span class="name">${i % 2 ? "Black" : "White"} · Opening plan ${i + 1}</span></span><span class="rep-health">${i * 7}% mastered · ${i % 4} due</span></div>`
      ).join("");
    });
    await page.screenshot({ path: `${out}/desktop-dashboard-dense-synthetic.png`, fullPage: true });
  }
  await context.close();
}
await browser.close();
