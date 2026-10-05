import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Chess } from "chess.js";

const base = process.env.COVERAGE_SMOKE_URL || "http://127.0.0.1:5188/static/";
const output = new URL("../artifacts/coverage-workbench/", import.meta.url);
await mkdir(output, { recursive: true });
const game = new Chess();
const nodes = [{ id: "root", parent_id: null, depth: 0, fen: game.fen(), is_enabled: true }];
let parent = "root";
for (const [i, san] of ["e4", "e5", "Nf3"].entries()) {
  const move = game.move(san), id = `n${i}`;
  nodes.push({ id, parent_id: parent, depth: i + 1, fen: game.fen(), uci: move.from + move.to,
    san, move_number: Math.floor(i / 2) + 1, move_side: i % 2 ? "black" : "white",
    is_enabled: true, is_mainline: true, is_prepared: i % 2 === 0, source: "manual", arrows: [], circles: [] });
  parent = id;
}
let revision = 1;
let reads = 0;
let applied = 0;
let savedNodes = nodes;
const generationSource = `export async function runBrowserBuildGenerate({rootNodeId}) {
  return { rootNodeId, changes: [{ action:'planned_add', tempId:'tmp-preview-reply',
    parentRef:rootNodeId, moveUci:'b1c3', source:'generated_stockfish', intendedMainline:true }] };
}`;
const providerSource = await readFile(new URL("../web-src/engine/maia3-provider.js", import.meta.url), "utf8");
const fakeProvider = `export function getSharedMaia3Provider() {
  return { predictions: async ({fen}) => {
    globalThis.__coverageReads = (globalThis.__coverageReads || 0) + 1;
    if (globalThis.__coverageReadBlocked) await new Promise(r => { globalThis.__coverageRelease = r; });
    const black = fen.split(' ')[1] === 'b';
    if (!black) return [];
    return fen.includes('5N2') ? [{move_uci:'b8c6',probability:1}] : [{move_uci:'e7e5',probability:.7},{move_uci:'e7e6',probability:.25}];
  }};
}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const evidence = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/maia3-provider.js*", (r) => r.fulfill({ contentType: "text/javascript",
    body: providerSource.replace(/export function getSharedMaia3Provider\(options = \{\}\) \{[\s\S]*?\n\}/, fakeProvider) }));
  await page.route("**/build-generate-runner.js*", (r) => r.fulfill({ contentType: "text/javascript", body: generationSource }));
  await page.route("**/api/**", async (r) => {
    const u = new URL(r.request().url());
    let data = {};
    if (u.pathname === "/api/auth/me") data = { id: "coverage-owner", display_name: "Coverage review", email: "review@example.test" };
    if (u.pathname === "/api/csrf") data = { csrf_token: "fixture" };
    if (u.pathname === "/api/repertoires") data = { repertoires: ["a", "b"].map((id) => ({
      id, name: `Review ${id}`, color: "white", root_fen: nodes[0].fen, tags: [], is_active: true })), shared: [] };
    if (u.pathname === "/api/build/load") { const id = u.searchParams.get("repertoire_id"); data = {
      repertoire_id: id, name: `Review ${id}`, color: "white", revision, writable: true,
      selected_node_id: "n0", nodes: savedNodes }; }
    if (u.pathname === "/api/build/generate/apply-plan") {
      const request = r.request().postDataJSON();
      assert.ok(request.operation_id);
      assert.equal(request.base_revision, revision);
      applied++;
      const idMap = {};
      savedNodes = savedNodes.map((n) => ({ ...n }));
      for (const change of request.plan.changes) {
        const parentId = idMap[change.parentRef] || change.parentRef;
        const parentNode = savedNodes.find((n) => n.id === parentId);
        const chess = new Chess(parentNode.fen);
        const m = chess.move({ from: change.moveUci.slice(0,2), to: change.moveUci.slice(2,4) });
        const id = `saved-${savedNodes.length}`;
        idMap[change.tempId] = id;
        savedNodes.push({ id, parent_id: parentId, depth: parentNode.depth + 1, fen: chess.fen(),
          uci: change.moveUci, san: m.san, is_enabled: true, is_prepared: chess.turn() === "b",
          is_mainline: change.intendedMainline, source: change.source, arrows: [], circles: [] });
      }
      revision++;
      data = { repertoire_id: request.repertoire_id, name: `Review ${request.repertoire_id}`, color: "white",
        revision, writable: true, selected_node_id: "n0", nodes: savedNodes,
        id_map: idMap, summary: { added_nodes: request.plan.changes.length } };
    }
    if (u.pathname.startsWith("/api/shared/")) data = { repertoire_id: "shared", name: "Shared review",
      color: "white", revision: 1, writable: false, selected_node_id: "n0", nodes };
    if (u.pathname === "/api/dashboard") data = { repertoires: 2, streak: {}, recap: {}, recommendations: [] };
    if (u.pathname === "/api/teams") data = { teams: [] };
    if (u.pathname === "/api/lichess") data = { linked: false, accounts: [] };
    await r.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(base);
  await page.locator('html[data-app-ready="true"]').waitFor();
  await page.locator('.lib-row[data-repertoire-id="a"]').click();
  await page.locator("#build-rep-name").filter({ hasText: "Review a" }).waitFor();
  await page.locator("#build-tool-coverage").click();
  await page.locator("#coverage-depth").selectOption("4");
  // Scan's explicit opt-in must leave Analyze's global preference unchanged.
  await page.locator("#coverage-run").click();
  await page.locator(".coverage-gap").first().waitFor();
  const summary = await page.locator(".coverage-summary").innerText();
  assert.match(summary, /0.0% prepared/);
  assert.match(summary, /95.0% missing/);
  assert.match(summary, /5.0% unchecked/);
  assert.equal(await page.locator(".coverage-gap").count(), 2);
  assert.equal(await page.locator(".coverage-gap-check:checked").count(), 0);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("prepforge.prefs") || "{}").maiaAnalysis === true), false);
  await page.locator(".coverage-gap-body").first().focus();
  await page.keyboard.press("Enter");
  await page.locator("#build-board.is-previewing").waitFor();
  await page.locator("#build-pv-exit").click();
  assert.equal(await page.locator("#build-board.is-previewing").count(), 0);
  evidence.push({ case: "real scan, missing reply, unknown mass and keyboard preview", summary, pass: true });
  await page.screenshot({ path: fileURLToPath(new URL("coverage-desktop.png", output)) });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    heights: [...document.querySelectorAll(".coverage-gap")].map((e) => e.getBoundingClientRect().height),
  }));
  assert.equal(mobile.overflow, 0);
  assert.ok(mobile.heights.every((h) => h >= 44));
  await page.screenshot({ path: fileURLToPath(new URL("coverage-mobile.png", output)) });
  evidence.push({ case: "mobile", ...mobile, pass: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const gap = page.locator(".coverage-gap").filter({ hasText: "e6" });
  await gap.locator(".coverage-gap-check").check();
  await page.locator("#coverage-complete").click();
  await page.getByRole("button", { name: "Add replies", exact: true }).waitFor();
  assert.equal(applied, 0);
  assert.equal(savedNodes.length, nodes.length);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  assert.equal(applied, 0);
  await page.locator("#coverage-complete").click();
  await page.getByRole("button", { name: "Add replies", exact: true }).click();
  await page.getByRole("button", { name: "Stay in Build", exact: true }).click();
  assert.equal(applied, 1);
  assert.equal(savedNodes.length, nodes.length + 2);
  assert.equal(savedNodes.at(-1).uci, "b1c3");
  await page.locator(".coverage-stale").waitFor();
  evidence.push({ case: "preview without writes, cancel, one atomic opponent/reply save", applied, pass: true });
  await page.locator('[data-testid="nav-dashboard"]').click();
  await page.locator('.lib-row[data-repertoire-id="b"]').click();
  await page.locator("#build-rep-name").filter({ hasText: "Review b" }).waitFor();
  await page.locator(".coverage-stale").waitFor();
  assert.equal(await page.locator(".coverage-gap").count(), 0);
  evidence.push({ case: "switch repertoire discards old usable results", pass: true });
  await page.evaluate(() => { globalThis.__coverageReadBlocked = true; });
  await page.locator("#coverage-run").click();
  await page.waitForFunction(() => !!globalThis.__coverageRelease);
  const cancel = page.locator('#coverage-job-dock [data-job-action="cancel"], #coverage-job-dock button').first();
  // Prefer the controller's actual job cancellation affordance, not an injected signal.
  const buttons = await page.locator("#coverage-job-dock button").allTextContents();
  const stop = page.locator("#coverage-job-dock button").filter({ hasText: /stop|cancel/i }).first();
  if (await stop.count()) await stop.click();
  else { console.log("job buttons", buttons); await cancel.click(); }
  await page.locator("#coverage-run").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("coverage-run").disabled);
  await page.evaluate(() => { globalThis.__coverageReadBlocked = false; globalThis.__coverageRelease(); });
  reads = await page.evaluate(() => globalThis.__coverageReads);
  evidence.push({ case: "cancel unresolved shared prediction", reads, pass: true });
  await page.goto(`${base}?shared=fixture`);
  await page.locator("#build-rep-name").filter({ hasText: "Shared review" }).waitFor();
  await page.locator("#build-tool-coverage").click();
  await page.locator("#coverage-run").click();
  await page.locator(".coverage-gap").first().waitFor();
  assert.equal(await page.locator(".coverage-gap-check:enabled").count(), 0);
  evidence.push({ case: "read-only scan works without enabling editing", pass: true });
  assert.deepEqual(errors, []);
  await writeFile(new URL("browser-verification.json", output), JSON.stringify({ base, deterministicModel: true, errors, evidence }, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); }
