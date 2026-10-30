// Real API + production UI: delete/Undo paints immediately, floating controls
// preserve layout, and Smart answers advance while their save is still pending.
// Run against an isolated local database: E2E_BASE_URL=http://127.0.0.1:9876.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:9876";
const OUT = "out/train-repertoire-flow";
await mkdir(OUT, { recursive: true });
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; }
  catch { /* use the next installed browser */ }
}
assert(browser, "Chromium is required");
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(BASE);
  await page.request.get(`${BASE}/api/csrf`);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "pf_csrf").value;
  const post = async (path, data) => {
    const response = await page.request.post(`${BASE}${path}`, {
      data, headers: { "X-CSRF-Token": csrf },
    });
    assert(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await post("/api/auth/register", {
    email: `train-flow-${Date.now()}@example.com`, password: "train-flow-local-test-123",
    display_name: "Opening practice",
  });
  const created = await post("/api/repertoires/create", { name: "Open games · White", color: "white" });
  const repertoireId = created.repertoire_id;
  const moves = [
    ["e4", created.selected_node_id, "e2e4"], ["e5", "tmp-e4", "e7e5"],
    ["nf3", "tmp-e5", "g1f3"], ["nc6", "tmp-nf3", "b8c6"],
    ["bb5", "tmp-nc6", "f1b5"], ["a6", "tmp-bb5", "a7a6"],
    ["d6", "tmp-nf3", "d7d6"], ["d4b", "tmp-d6", "d2d4"],
    ["d4", created.selected_node_id, "d2d4"], ["d5", "tmp-d4", "d7d5"],
    ["c4", "tmp-d5", "c2c4"],
  ].map(([id, parentRef, uci]) => ({ tempId: `tmp-${id}`, parentRef, uci }));
  const seeded = await post("/api/build/add-moves", { repertoire_id: repertoireId, moves });
  const ids = seeded.id_map;
  await page.reload();
  await page.locator('html[data-app-ready="true"]').waitFor();
  await page.locator(`.lib-row[data-repertoire-id="${repertoireId}"]`).click();
  await page.locator("#builder-tree .mtree-move").first().waitFor();
  const token = id => page.locator(`#builder-tree .mtree-move[data-node-id="${ids[`tmp-${id}`]}"]`);

  // Selected-node deletion was the broken path: selection moved the DOM mark
  // without rebuilding the now-pruned tree. The server intentionally still has
  // the move during this undo window.
  await token("bb5").click();
  const before = await page.locator("#builder-tree").boundingBox();
  await token("bb5").click({ button: "right" });
  const deleting = Date.now();
  await page.locator('#node-context-menu [data-action="delete"]').click();
  await page.locator("#build-undo:not([hidden])").waitFor();
  assert.equal(await token("bb5").count(), 0, "deleted move must disappear before Undo expires");
  const deletedMs = Date.now() - deleting;
  assert(deletedMs < 2000, `immediate delete took ${deletedMs}ms`);
  const after = await page.locator("#builder-tree").boundingBox();
  assert.equal(after.y, before.y, "Undo must not push the tree down");
  assert.equal(await page.locator("#build-undo").evaluate(el => getComputedStyle(el).position), "fixed");
  const stillStored = await (await page.request.get(`${BASE}/api/build/load?repertoire_id=${repertoireId}`)).json();
  assert(stillStored.nodes.some(node => node.id === ids["tmp-bb5"]));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/undo-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${OUT}/undo-phone.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#build-undo button").click();
  await token("bb5").waitFor();
  assert.equal(await token("a6").count(), 1, "Undo restores the whole subtree");

  const measures = [];
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.locator("#build-root").click();
    await page.locator("#build-branchbar:not([hidden])").waitFor();
    const treeTop = (await page.locator("#builder-tree").boundingBox()).y;
    const fork = await page.locator("#build-branchbar").evaluate(el => {
      const css = getComputedStyle(el), box = el.getBoundingClientRect();
      return { position: css.position, border: parseFloat(css.borderTopWidth), x: box.x, right: box.right };
    });
    assert.equal(fork.position, "absolute");
    assert(fork.border >= 1 && fork.x >= 0 && fork.right <= width, "fork needs a visible border inside the viewport");
    await page.keyboard.press("ArrowDown");
    assert.equal((await page.locator("#builder-tree").boundingBox()).y, treeTop);
    const arrow = await page.locator("#build-annotations .annot-branch.is-pick").evaluate(el => {
      const css = getComputedStyle(el);
      return { dash: css.strokeDasharray, opacity: css.fillOpacity, fill: css.fill, stroke: css.stroke };
    });
    assert.equal(arrow.dash, "none");
    assert.equal(arrow.opacity, "1");
    assert.notEqual(arrow.fill, arrow.stroke);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page overflows horizontally");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/repertoire-${width}.png`, fullPage: true });
    if (width === 1440) {
      await page.locator("#theme-toggle").click();
      await page.locator('html[data-theme="dark"]').waitFor();
      await page.screenshot({ path: `${OUT}/repertoire-dark.png` });
      await page.locator("#theme-toggle").click();
    }
    await page.locator("#build-branchbar .fork-close").click();
    assert(await page.locator("#build-branchbar").isHidden());
    await page.keyboard.press("ArrowDown");
    assert(await page.locator("#build-branchbar").isVisible(), "keyboard branch selection reopens the chooser");
    if (width <= 760) {
      await page.locator('#build-panes [data-pane="explorer"]').click();
      assert(await page.locator("#build-branchbar").isHidden());
      await page.locator('#build-panes [data-pane="moves"]').click();
      assert(await page.locator("#build-branchbar").isVisible());
    }
    measures.push({ width, fork, arrow });
  }

  // Run the real local queue under delayed save responses. A correct move
  // should never wait for /smart/sync, /smart/move or /smart/skip.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-testid="nav-dashboard"]').click();
  let releaseSave;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  let syncRequests = 0, perMoveRequests = 0;
  await page.route("**/api/train/smart/sync", async route => {
    syncRequests++;
    await saveGate;
    if (!page.isClosed()) await route.continue();
  });
  page.on("request", request => {
    if (/\/api\/train\/(smart\/)?(move|skip)$/.test(new URL(request.url()).pathname)) perMoveRequests++;
  });
  const start = page.waitForResponse(response => response.url().endsWith("/api/train/smart/start"));
  await page.locator('[data-testid="dashboard-train-now"]').click();
  const payload = await (await start).json();
  let answerMs = null;
  for (const [cardIndex, card] of payload.cards.entries()) {
    for (const [targetIndex, target] of card.targets.entries()) {
      await page.waitForFunction(() => ["move", "teach"].includes(document.getElementById("train-banner")?.dataset.state));
      if (cardIndex === 0 && targetIndex === 0) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/train-desktop.png` });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: `${OUT}/train-phone.png`, fullPage: true });
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      const answered = Date.now();
      for (const square of [target.uci.slice(0, 2), target.uci.slice(2, 4)]) {
        await page.locator(`#train-board .square[data-square="${square}"]`).click();
      }
      await page.waitForFunction(() => ["correct", "runin", "done"].includes(document.getElementById("train-banner")?.dataset.state)
        || !document.getElementById("train-summary")?.hidden);
      await page.waitForFunction(() => ["move", "teach"].includes(document.getElementById("train-banner")?.dataset.state)
        || !document.getElementById("train-summary")?.hidden);
      if (cardIndex === 0 && targetIndex === 0) answerMs = Date.now() - answered;
    }
  }
  await page.locator("#train-summary:not([hidden])").waitFor();
  assert.equal(perMoveRequests, 0);
  assert(answerMs < 1500, `first answer took ${answerMs}ms`);
  releaseSave();
  await page.unrouteAll({ behavior: "wait" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ deletedMs, answerMs, syncRequests, perMoveRequests, measures, screenshots: OUT }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${OUT}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
}
