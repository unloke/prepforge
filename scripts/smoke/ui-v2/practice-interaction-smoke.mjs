// Runs against Vite so deterministic positions can use the actual source modules,
// without shipping test-only hooks in the application. Start Vite on 5191 first.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.PRACTICE_SMOKE_URL || "http://127.0.0.1:5191/static/";
const output = new URL("../../../designs/practice-repair/after/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, isMobile: width === 390 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = path === "/api/auth/me" ? { id: "practice-test", display_name: "Practice tester" }
        : path === "/api/repertoires" ? { repertoires: [{ id: "italian", name: "Italian", color: "white", is_active: true, health: { trainable: 3 } }], shared: [] }
        : path === "/api/train/smart/summary" ? { next_session: { cards: 3, upcoming: [] }, outlook: { now: 3 } }
        : path === "/api/lichess/accounts" ? { accounts: [] } : {};
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(base);
    await page.waitForSelector("#analysis-board .piece", { state: "attached" });
    await page.evaluate(() => document.querySelector('[data-testid="nav-train"]').click());
    await page.waitForFunction(() => document.getElementById("view-train").dataset.trainScreen === "home");
    await page.evaluate(async () => {
      const { appState, boards } = await import("/static/core/state.js");
      const { localBoardInfo, localBoardAfterMove } = await import("/static/chess-local.js");
      const session = await import("/static/controllers/train-session.js");
      const { saveRun } = await import("/static/train-history.js");
      const rootFen = boards.train.fen;
      const branches = ["e2e4", "d2d4", "g1f3"].map((uci, i) => {
        const after = localBoardAfterMove(rootFen, uci);
        return { id: `branch-${i}`, parent_id: "root", uci, san: after.move.san, fen: after.board.fen };
      });
      appState.build = { repertoire_id: "italian", name: "Italian", color: "white", root_fen: rootFen,
        selected_node_id: "root", nodes: [{ id: "root", parent_id: null, fen: rootFen }, ...branches] };
      appState.analysis = { initial_fen: rootFen, moves: [branches[0]], summary: { analyzed_plies: 1 } };
      saveRun(appState.accountUserId, { id: "practice-seed", mode: "smart", blitz: false,
        repertoires: ["Italian"], cards: 3, correct: 2, mistakes: 1, skipped: 0,
        finishedAt: "2026-11-02T12:00:00Z" });
      const { getSharedMaia3Provider } = await import("/static/engine/maia3-provider.js");
      window.practiceReplies = [];
      getSharedMaia3Provider().predictions = (request) => new Promise((resolve) => window.practiceReplies.push({ request, resolve }));
      window.practiceTest = { appState, boards, localBoardInfo, session };
      appState.trainMode = "play";
    });
    await page.locator('[data-pane="play"]').click();
    assert.equal(await page.locator('#train-home [data-row="smart"]').isVisible(), false);
    assert.equal(await page.locator("#start-play").isVisible(), true);
    await page.locator('[data-pane="drill"]').click();
    assert.equal(await page.locator("#start-play").isVisible(), false);
    await page.locator('[data-pane="play"]').click();

    await page.evaluate(() => {
      window.practiceScreens = [];
      new MutationObserver(() => window.practiceScreens.push(document.getElementById("view-train").dataset.trainScreen))
        .observe(document.getElementById("view-train"), { attributes: true, attributeFilter: ["data-train-screen"] });
    });
    await page.locator("#start-play").click();
    await page.waitForFunction(() => window.practiceTest.appState.play?.active);
    assert.deepEqual(await page.evaluate(() => [...new Set(window.practiceScreens)]), ["session"]);

    async function mount(fen, color = "white") {
      await page.evaluate(async ({ fen, color }) => {
        const { appState, boards, localBoardInfo, session } = window.practiceTest;
        // Repertoire replies keep the test local and deterministic.
        appState.playBook = "maia";
        const { setPlayPickerColor } = await import("/static/controllers/train-home.js");
        setPlayPickerColor(color);
        await session.startPlaySessionTracked({ fen });
        const info = localBoardInfo(fen);
        appState.play.userColor = color;
        boards.train.setOrientation(color);
        boards.train.setPosition({ fen, legalMoves: info.legal_moves, cue: false });
      }, { fen, color });
      await page.waitForFunction(() => !document.documentElement.classList.contains("train-vt"));
    }
    async function move(from, to, drag = false) {
      const square = (name) => page.locator(`#train-board [data-square="${name}"]`);
      if (drag) {
        const a = await square(from).boundingBox(), b = await square(to).boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
        await page.mouse.up();
      } else {
        await square(from)[width === 390 ? "tap" : "click"]();
        await square(to)[width === 390 ? "tap" : "click"]();
      }
    }
    const white = "8/P6k/8/8/8/8/6K1/8 w - - 0 1";
    await mount(white);
    await move("a7", "a8");
    await page.waitForSelector(".promotion-option", { state: "visible", timeout: 3000 });
    assert.equal(await page.locator(".promotion-option").count(), 4);
    await page.screenshot({ path: fileURLToPath(new URL(`promotion-${width}.png`, output)) });
    await page.getByRole("button", { name: "Promote to Knight", exact: true }).click();
    await page.waitForFunction(() => window.practiceTest.appState.play.history.some((ply) => ply.uci === "a7a8n"));
    assert.equal(await page.locator('#train-board [data-square="a8"]').getAttribute("data-piece"), "N");
    const black = "8/7k/8/8/8/8/p5K1/8 b - - 0 1";
    await mount(black, "black");
    await move("a2", "a1", true);
    await page.waitForSelector(".promotion-option", { state: "visible" });
    assert.equal(await page.locator(".promotion-option .piece-black").count(), 4);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('#train-board [data-square="a2"]').getAttribute("data-piece"), "p");
    await move("a2", "a1", true);
    await page.getByRole("button", { name: "Promote to Rook", exact: true }).click();
    await page.waitForFunction(() => window.practiceTest.appState.play.history.some((ply) => ply.uci === "a2a1r"));

    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    async function beginThinking() {
      await mount(start);
      await page.evaluate(() => { window.practiceReplies = []; });
      await move("e2", "e4");
      await page.waitForFunction(() => window.practiceReplies.length === 1);
    }
    async function reply(uci) {
      await page.evaluate((uci) => window.practiceReplies.shift().resolve([{ move_uci: uci, probability: 1 }]), uci);
    }
    await beginThinking();
    await move("g1", "f3", true);
    await page.waitForFunction(() => window.practiceTest.appState.play.premove === "g1f3");
    assert.equal(await page.locator("#train-board .premove").count(), 2);
    await page.screenshot({ path: fileURLToPath(new URL(`premove-${width}.png`, output)) });
    await reply("e7e5");
    await page.waitForFunction(() => window.practiceTest.appState.play.history.length === 3);
    assert.deepEqual(await page.evaluate(() => window.practiceTest.appState.play.history.map((ply) => ply.uci)), ["e2e4", "e7e5", "g1f3"]);

    await beginThinking();
    await move("g1", "f3");
    await page.evaluate(() => window.practiceTest.boards.train.setAnnotations(["e2e4"], ["d4"]));
    await page.locator('#train-board [data-square="a4"]').click();
    assert.equal(await page.evaluate(() => window.practiceTest.appState.play.premove), null);
    assert.equal(await page.locator("#train-board .highlighted, #train-board .premove, #train-annotations .annot-user").count(), 0);
    await reply("c7c5");
    await page.waitForFunction(() => window.practiceTest.appState.play.history.length === 2);
    assert.equal(await page.locator('#train-board [data-square="g1"]').getAttribute("data-piece"), "N");

    await beginThinking();
    await move("e4", "d5"); // legal only if the opponent puts a piece there
    await page.waitForFunction(() => window.practiceTest.appState.play.premove === "e4d5");
    await reply("a7a6");
    await page.waitForFunction(() => window.practiceTest.appState.play.history.length === 2);
    assert.equal(await page.evaluate(() => window.practiceTest.appState.play.premove), null);
    assert.equal(await page.locator('#train-board [data-square="e4"]').getAttribute("data-piece"), "P");

    await beginThinking();
    const knight = await page.locator('#train-board [data-square="g1"]').boundingBox();
    await page.mouse.move(knight.x + knight.width / 2, knight.y + knight.height / 2);
    await page.mouse.down();
    await reply("e7e5");
    await page.waitForFunction(() => window.practiceTest.appState.play.history.length === 2);
    assert.equal(await page.locator(".drag-ghost").count(), 1);
    const target = await page.locator('#train-board [data-square="f3"]').boundingBox();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.up();
    await page.waitForFunction(() => window.practiceTest.appState.play.history.length === 3);

    await page.evaluate(async (fen) => {
      const { session } = window.practiceTest;
      const { setPlayPickerColor } = await import("/static/controllers/train-home.js");
      setPlayPickerColor("black");
      window.practiceReplies = [];
      void session.startPlaySessionTracked({ fen });
    }, start);
    await page.waitForFunction(() => window.practiceReplies.length === 1);
    await move("g8", "f6", true);
    await page.waitForFunction(() => window.practiceTest.appState.play.premove === "g8f6");
    await reply("e2e4");
    await page.waitForFunction(() => window.practiceTest.appState.play.history.length === 2);
    assert.deepEqual(await page.evaluate(() => window.practiceTest.appState.play.history.map((ply) => ply.uci)), ["e2e4", "g8f6"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`[practice-interactions] ${width}: tabs, promotion, premove, cancellation, legality and held drag passed`);
  }
} finally { await browser.close(); }
