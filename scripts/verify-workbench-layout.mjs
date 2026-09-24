import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.env.UI_CAPTURE_DIR || "artifacts/ui-layout-review";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});

function fixture(view, state) {
  if (view === "games") {
    const count = state === "dense" ? 40 : state === "normal" ? 8 : 0;
    const rows = Array.from({ length: count }, (_, i) => `
      <div class="replay-row rk-${i % 3 === 0 ? "user-error" : i % 3 === 1 ? "left-prep" : "no-prep"}${i === 0 ? " is-open" : ""}">
        <button class="replay-row-head" type="button"><span class="replay-badge">${i % 3 === 0 ? "You left prep" : i % 3 === 1 ? "Opponent novelty" : "Not covered"}</span><span class="players">Player ${i + 1} vs Opponent ${i + 1}</span><span class="replay-result">1–0</span><span class="replay-preview">e4 e5 Nf3 Nc6 Bb5 a6</span><span class="replay-departure">Ply ${7 + i}</span></button>
      </div>`).join("");
    const focus = '<section class="replay-focus"><div class="replay-focus-eyebrow">Selected game</div><h4>Player 1 vs Opponent 1</h4><div class="replay-row-body"><div class="replay-line">1. e4 e5 2. Nf3</div><div class="replay-detail">You diverged on ply 7.</div><div class="replay-actions"><button class="btn primary">Train it now</button></div></div></section>';
    return { target: "#replay-results", html: count ? `<div class="replay-triage"><div class="replay-ledger"><div class="replay-ledger-head"><h4>Games to review</h4><span>${count} shown</span></div><div class="replay-ledger-columns"><span>Preparation</span><span>Game</span><span>Result</span><span>Opening</span><span>Departure</span></div><div class="replay-game-list">${rows}</div></div>${focus}</div>` : '<div class="empty-state">No games found. Check your games to review preparation.</div>' };
  }
  if (view === "teams") {
    const count = state === "dense" ? 18 : state === "normal" ? 4 : 0;
    return { target: "#teams-list", html: count ? Array.from({ length: count }, (_, i) => `<div class="list-item team-row${i === 0 ? " is-selected" : ""}" role="button" tabindex="0"><span><span class="name">${["Opening lab", "Students", "Weekend practice"][i % 3]} ${i + 1}</span><span class="sub">${i + 2} members</span></span><span class="team-role-badge">${i % 2 ? "Member" : "Owner"}</span></div>`).join("") : '<div class="empty-state">No teams yet. Create one to start sharing.</div>' };
  }
  const count = state === "dense" ? 12 : state === "normal" ? 4 : 0;
  return { target: "#scout-v3-results", html: count ? `<div class="scout-v13-cards">${Array.from({ length: count }, (_, i) => `<section class="scout-v13-card card"><h3>${i % 2 ? "Against Black" : "Against White"}: ${["Sicilian Defense", "Queen's Gambit", "Ruy Lopez"][i % 3]}</h3><p>Prepare 1. e4 c5 2. Nf3 d6. ${16 + i} games support this route.</p><button class="btn ghost">Evidence</button></section>`).join("")}</div>` : '<div class="empty-state">Choose a source, then start scouting.</div>' };
}

try {
  for (const width of [1440, 1920, 390]) {
    for (const view of ["games", "scout", "teams"]) {
      for (const state of ["empty", "normal", "dense"]) {
        const page = await browser.newPage({ viewport: { width, height: width === 1920 ? 1080 : 900 }, deviceScaleFactor: 1 });
        await page.goto("http://127.0.0.1:5173/static/", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(400);
        await page.locator(view === "teams" ? '[data-testid="nav-teams"]' : view === "scout" ? '[data-testid="nav-scout"]' : '[data-testid="nav-replay"]').click();
        await page.evaluate(({ view, state }) => {
          document.querySelectorAll(".view").forEach((el) => el.classList.remove("is-active"));
          const active = document.querySelector(view === "teams" ? "#view-teams" : "#view-replay");
          active.classList.add("is-active");
          document.querySelectorAll("[data-replay-panel]").forEach((el) => { el.hidden = el.dataset.replayPanel !== view; });
          const data = (window.__fixture = { view, state });
          return data;
        }, { view, state });
        const { target, html } = fixture(view, state);
        await page.locator(target).evaluate((el, html) => { el.innerHTML = html; el.hidden = false; }, html);
        if (view === "teams" && state !== "empty") {
          await page.locator("#team-detail-card").evaluate((el) => { el.hidden = false; });
          await page.locator("#team-detail-name").evaluate((el) => { el.textContent = "Opening lab"; });
          await page.locator("#team-members").evaluate((el, state) => { el.innerHTML = Array.from({ length: state === "dense" ? 14 : 3 }, (_, i) => `<div class="list-item"><span class="name">Member ${i + 1}</span><span class="sub">${i ? "Editor" : "Owner"}</span></div>`).join(""); }, state);
          await page.locator("#team-shared-repertoires").evaluate((el, state) => { el.innerHTML = Array.from({ length: state === "dense" ? 12 : 2 }, (_, i) => `<div class="list-item"><span class="name">${i % 2 ? "Sicilian" : "Queen's Gambit"} repertoire ${i + 1}</span><button class="ib">Copy</button></div>`).join(""); }, state);
          if (state === "normal") {
            await page.locator('[data-team-pane="repertoires"]').click();
            if (!(await page.locator('[data-team-panel="repertoires"]').isVisible())) throw new Error("Teams repertoire tab did not open");
            await page.locator('[data-team-pane="members"]').click();
            if (!(await page.locator('[data-team-panel="members"]').isVisible())) throw new Error("Teams members tab did not reopen");
          }
        }
        if (view === "scout" && state !== "empty") await page.locator("#scout-v3-results").evaluate((el) => { el.hidden = false; });
        if (view === "scout" && state !== "empty") {
          const placeholder = await page.locator("#scout-results").evaluate((el) => getComputedStyle(el, "::before").display);
          if (placeholder !== "none") throw new Error(`Scout shows empty prompt beside populated report: ${placeholder}`);
        }
        if (view === "teams" && state === "dense") {
          const positions = await page.evaluate(() => ({ detail: document.querySelector("#team-detail-card").getBoundingClientRect().top, directory: document.querySelector(".teams-directory").getBoundingClientRect().top }));
          if (width > 680 && Math.abs(positions.detail - positions.directory) > 12) throw new Error(`Selected team detail is misaligned with directory: ${JSON.stringify(positions)}`);
        }
        await page.screenshot({ path: `${out}/${view}-${state}-${width}.png`, fullPage: true });
        if (!(await page.locator(target).isVisible())) throw new Error(`${view}/${state}/${width} target is hidden`);
        const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        if (dimensions.scrollWidth > dimensions.innerWidth + 1) throw new Error(`${view}/${state}/${width} horizontal overflow: ${JSON.stringify(dimensions)}`);
        console.log(`${view} ${state} ${width}: no horizontal overflow`);
        await page.close();
      }
    }
  }
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5173/static/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.locator('[data-testid="nav-replay"]').click();
  const result = await page.evaluate(async () => {
    const { createReplayView } = await import("/static/views/replay.js");
    let openIndex = -1;
    const payload = { games: [{ white: "Alice", black: "Bob", result: "1-0", in_repertoire: true, departure_reason: "user_left_preparation", departure_ply: 3, move_san_history: ["e4", "e5", "Nf3"], expected_move_san: "Nc3" }] };
    const view = createReplayView({ escapeHtml: (s) => String(s), getReplayFilter: () => null, isGameOpen: (i) => i === openIndex, onToggleFilter: () => {}, onToggleGame: (i) => { openIndex = i; view.renderReplayResults(payload); }, onTrainMiss: () => {}, onBuildReply: () => {}, onAnalyze: () => {} });
    view.renderReplayResults(payload);
    document.querySelector(".replay-row-head").click();
    return { body: !!document.querySelector(".replay-focus .replay-row-body"), label: document.querySelector(".replay-focus .replay-detail")?.textContent };
  });
  if (!result.body || !result.label.includes("You diverged")) throw new Error(`Games interaction failed: ${JSON.stringify(result)}`);
  console.log("games click: selected game opens in the focus panel");
  await page.close();
} finally {
  await browser.close();
}
