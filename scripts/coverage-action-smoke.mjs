import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { Chess } from "chess.js";

const base = process.env.COVERAGE_SMOKE_URL || "http://127.0.0.1:5188/static/";
const game = new Chess();
const nodes = [{ id: "root", parent_id: null, depth: 0, fen: game.fen(), is_enabled: true }];
for (const [i, san] of ["e4", "e5", "Nf3"].entries()) {
  const move = game.move(san);
  nodes.push({ id: `n${i}`, parent_id: i ? `n${i - 1}` : "root", depth: i + 1,
    fen: game.fen(), uci: move.from + move.to, san, move_number: Math.floor(i / 2) + 1,
    move_side: i % 2 ? "black" : "white", is_enabled: true, is_mainline: true,
    is_prepared: i % 2 === 0, source: "manual", arrows: [], circles: [] });
}
const replies = new Chess(nodes[1].fen).moves({ verbose: true }).map((m, _, all) => ({
  move_uci: m.from + m.to, probability: 1 / all.length,
}));
const provider = await readFile(new URL("../web-src/engine/maia3-provider.js", import.meta.url), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.route("**/maia3-provider.js*", (route) => route.fulfill({ contentType: "text/javascript",
    body: provider.replace(/export function getSharedMaia3Provider\(options = \{\}\) \{[\s\S]*?\n\}/,
      `export function getSharedMaia3Provider() { return { predictions: async ({fen}) =>
        fen === ${JSON.stringify(nodes[1].fen)} ? ${JSON.stringify(replies)} : [] }; }`),
  }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let data = {};
    if (path === "/api/auth/me") data = { id: "coverage-owner", display_name: "Coverage review" };
    if (path === "/api/csrf") data = { csrf_token: "fixture" };
    if (path === "/api/repertoires") data = { repertoires: [{ id: "a", name: "Coverage review",
      color: "white", root_fen: nodes[0].fen, tags: [], is_active: true }], shared: [] };
    if (path === "/api/build/load") data = { repertoire_id: "a", name: "Coverage review",
      color: "white", revision: 1, writable: true, selected_node_id: "n0", nodes };
    if (path === "/api/teams") data = { teams: [] };
    if (path === "/api/lichess") data = { accounts: [] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(base);
  await page.locator('html[data-app-ready="true"]').waitFor();
  await page.locator('.lib-row[data-repertoire-id="a"]').dblclick();
  await page.locator("#build-rep-name").filter({ hasText: "Coverage review" }).waitFor();
  await page.locator('#build-panes [data-pane="coverage"]').click();
  await page.locator("#coverage-run").click();
  const checks = page.locator(".coverage-gap-check");
  await checks.nth(10).waitFor();
  await checks.nth(10).check();
  const action = page.locator("#coverage-complete");
  assert.equal(await action.textContent(), "Preview 1 reply");
  const reachable = () => action.evaluate((button) => {
    const r = button.getBoundingClientRect();
    const panel = document.querySelector("#build-sidebar > .panel-body").getBoundingClientRect();
    return r.top >= panel.top && r.bottom <= Math.min(panel.bottom, innerHeight)
      && r.left >= 0 && r.right <= innerWidth
      && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  assert.ok(await reachable(), "selected count + preview action must remain reachable after checking a lower gap");
  await checks.last().scrollIntoViewIfNeeded();
  assert.ok(await reachable(), "preview action must stay reachable at the end of the gap list");
  await checks.nth(10).uncheck();
  assert.equal(await action.textContent(), "Preview replies");
  assert.ok(await action.isDisabled());
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await action.evaluate((el) => getComputedStyle(el.parentElement).position), "static");
  console.log("[coverage-action] ok — lower-gap selection and end-of-list scrolling keep the phone action reachable; deselection and desktop unchanged");
} finally {
  await browser.close();
}
