// Browser render of Scout's real section builder against a dense public-game corpus.
// Run while Vite serves /static/; pass the parsed game JSON from scout-fetch-games.mjs.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";

const source = process.argv[2];
if (!source) throw new Error("Pass parsed Scout games JSON");
const games = JSON.parse(readFileSync(source, "utf8")).slice(-1000);
const out = process.env.UI_CAPTURE_DIR || "artifacts/ui-layout-review";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
try {
  for (const width of [1440, 1920, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1920 ? 1080 : 900 } });
    await page.goto("http://127.0.0.1:5173/static/", { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="nav-scout"]').click();
    const result = await page.evaluate(async (data) => {
      const scout = await import("/static/scout.js");
      const report = await import("/static/scout-report.js");
      const sections = ["white", "black"].map((color) => report.buildScoutSectionReport(
        scout, { games: data, profile: { colorStats: {}, recentlyChanged: { white: false, black: false } }, username: "EricRosen" }, color, [],
        { escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
          trie: scout.buildOpeningTrie(data, color, { maxPlies: Infinity }) },
      ));
      const el = document.querySelector("#scout-results");
      el.innerHTML = sections.map((section) => section.html).join("");
      document.querySelector("#scout-v3-results").hidden = true;
      return { sections: sections.length, counts: sections.map((section) => section.sectionData?.trie?.gameCount || 0), htmlLength: el.innerHTML.length };
    }, games);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1 || result.htmlLength < 1000) throw new Error(`${width}: ${JSON.stringify({ result, overflow })}`);
    await page.screenshot({ path: `${out}/scout-real-dense-${width}.png`, fullPage: true });
    console.log(`${width}: rendered ${games.length} real games, ${result.htmlLength} HTML chars, horizontal overflow ${overflow}`);
    await page.close();
  }
} finally {
  await browser.close();
}
