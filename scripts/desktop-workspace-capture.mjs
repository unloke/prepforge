import { chromium } from "playwright";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

const base = process.env.CAPTURE_BASE_URL || "http://127.0.0.1:4173/static/";
const out = resolve(process.env.CAPTURE_OUT || "artifacts/desktop-workspace");
mkdirSync(out, { recursive: true });
// Default to the Playwright-bundled Chromium (no host browser dependency). Opt in
// to a host channel only when needed: CAPTURE_BROWSER=msedge|chrome|chromium.
// No extra screenshot binaries — screenshots go through this script's Playwright.
const channel = (process.env.CAPTURE_BROWSER || "").trim().toLowerCase();
const browser = channel
  ? await chromium.launch({ channel, headless: true })
  : await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const report = {};
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  for (const [name, nav, board] of [
    ["analyze", "nav-analyze", "#analysis-board"],
    ["build", "nav-build", "#build-board"],
    ["train", "nav-train", "#train-board"],
    ["games", "nav-replay", null],
    ["scout", "nav-scout", null],
    ["teams", "nav-teams", null],
  ]) {
    await page.getByTestId(nav).click();
    await page.waitForTimeout(350);
    const close = page.locator("#app-status:not([hidden]) .status-close");
    if (await close.count()) await close.click();
    await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
    report[name] = await page.evaluate((selector) => {
      const rect = selector ? document.querySelector(selector)?.getBoundingClientRect() : null;
      return {
        board: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        documentHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight,
      };
    }, board);
  }
  await page.getByTestId("nav-analyze").click();
  report.statusShift = await page.evaluate(() => {
    const board = document.querySelector("#analysis-board");
    const status = document.querySelector("#app-status");
    status.hidden = true;
    const before = board.getBoundingClientRect().top;
    status.querySelector(".status-message").textContent = "Saved successfully";
    status.hidden = false;
    const after = board.getBoundingClientRect().top;
    status.hidden = true;
    return Math.round(after - before);
  });
  if (report.statusShift !== 0) throw new Error("Status notification shifted the board");
  await page.getByTestId("nav-replay").click();
  const asset = basename(readdirSync(resolve("src/prepforge_chess/web/static/assets")).find((name) => /^replay-.*\.js$/.test(name)));
  report.gamesSelection = await page.evaluate(async (moduleUrl) => {
    const { createReplayView } = await import(moduleUrl);
    const games = [
      { white: "Avery", black: "Morgan", result: "1-0", departure_reason: "game_stayed_in_preparation", in_repertoire: true, repertoire_name: "Italian", matched_plies: 8, user_color: "white", move_san_history: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"] },
      { white: "Casey", black: "Avery", result: "0-1", departure_reason: "opponent_unprepared_branch", repertoire_name: "Caro-Kann", matched_plies: 5, departure_ply: 6, user_color: "black", move_san_history: ["e4", "c6", "d4", "d5", "Nc3", "dxe4"] },
      { white: "Avery", black: "Riley", result: "½-½", departure_reason: "user_left_preparation", repertoire_name: "London", matched_plies: 4, departure_ply: 5, expected_move_san: "Bf4", user_color: "white", move_san_history: ["d4", "d5", "Nf3", "Nf6", "c4"] },
    ];
    let selected = -1;
    let filter = null;
    let view;
    const render = () => view.renderReplayResults({ games, misses_recorded: 1 });
    view = createReplayView({
      escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
      getReplayFilter: () => filter,
      isGameOpen: (index) => selected === index,
      onToggleFilter: (kind) => { filter = filter === kind ? null : kind; render(); },
      onToggleGame: (index) => { selected = selected === index ? -1 : index; render(); },
      onTrainMiss: () => {}, onBuildReply: () => {}, onAnalyze: () => {},
    });
    render();
    document.querySelectorAll(".replay-row-head")[0].click();
    document.querySelectorAll(".replay-row-head")[1].click();
    return { selectedCount: document.querySelectorAll(".replay-row.is-open").length, selectedPlayer: document.querySelector(".replay-inspector h3")?.textContent };
  }, `/static/assets/${asset}`);
  if (report.gamesSelection.selectedCount !== 1 || !report.gamesSelection.selectedPlayer?.includes("Casey")) {
    throw new Error("Games inspector did not switch to a single selected row");
  }
  await page.screenshot({ path: resolve(out, "games-selected.png"), fullPage: true });
  writeFileSync(resolve(out, "metrics.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
