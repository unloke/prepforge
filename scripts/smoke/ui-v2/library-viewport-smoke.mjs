// Library viewport smoke (ui-v2 page internals, 2026-09-27 integration round).
// Serves the built static/ tree, intercepts /api/* with real-shape
// fixtures, and at 1440x900 / 1180x900 / 390x844 checks:
//   - no horizontal overflow, no console/page errors
//   - Library table + preview render from the fixture data
//   - click-to-preview shows the clicked repertoire; preview actions work
//   - keyboard: rows are reachable, Enter on the selected row opens the rep
// Tracked UI-v2 smoke: run the whole eight-view suite with
// `npm run smoke:ui-v2` (scripts/smoke/ui-v2/run-all.mjs).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const STATIC_DIR = join(ROOT, "src", "prepforge_chess", "web", "static");
const PORT = Number(process.env.LIB_SMOKE_PORT || 8793);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const FIXTURE_REPS = {
  repertoires: [
    {
      id: "rep-1",
      name: "Caro-Kann: Advance",
      color: "black",
      root_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      notes: "", tags: [], is_active: true, team_id: null, visibility: "private",
      health: { trainable: 40, mastered: 20, weak: 6, due: 9, learning: 3, untrained: 2, mastery_pct: 50, shallow_lines: 1 },
    },
    {
      id: "rep-2",
      name: "London System",
      color: "white",
      root_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      notes: "", tags: [], is_active: true, team_id: null, visibility: "private",
      health: { trainable: 30, mastered: 28, weak: 0, due: 0, learning: 2, untrained: 0, mastery_pct: 93, shallow_lines: 0 },
    },
    {
      id: "rep-3",
      name: "QGD vs 1.d4",
      color: "black",
      root_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      notes: "", tags: [], is_active: false, team_id: null, visibility: "private",
      health: null,
    },
  ],
  shared: [],
};

const api = (path, url) => {
  if (path.startsWith("/api/auth/me")) return { id: "u1", display_name: "Smoke Tester", email: "s@x.test" };
  if (path.startsWith("/api/auth/providers")) return { google: false };
  if (path.startsWith("/api/csrf")) return { csrf_token: "x" };
  if (path === "/api/build/load") {
    const rep = FIXTURE_REPS.repertoires.find((r) => r.id === url.searchParams.get("repertoire_id"));
    return {
      repertoire_id: rep.id, name: rep.name, color: rep.color, root_fen: rep.root_fen,
      writable: true, selected_node_id: "root",
      nodes: [{ id: "root", parent_id: null, depth: 0, fen: rep.root_fen, san: null, uci: null, arrows: [], circles: [] }],
    };
  }
  if (path.startsWith("/api/dashboard")) {
    return {
      games: 12, repertoires: 3, training_sessions: 7, open_mistakes: 6,
      due_reviews: 9, due_soon: 4,
      streak: { current: 5, best: 13, trained_today: false },
      recap: { moves_reviewed_7d: 61, mastered_now: 24, mastered_delta: 2, weak_now: 6, weak_delta: -1 },
      recommendations: [
        { id: "due-review", title: "9 reviews due", detail: "Clear the spaced-repetition queue", cta: { label: "Train now", view: "train" } },
      ],
    };
  }
  // The share dialog's access read (one grant, link off); before the listing's prefix match.
  if (path.startsWith("/api/repertoires/access")) return { grants: [{ user_id: "u9", name: "Sam", lichess_username: "samqueen", role: "view" }], link: { share_enabled: false, share_role: "view" } };
  if (path.startsWith("/api/repertoires")) return FIXTURE_REPS;
  if (path.startsWith("/api/teams")) return { teams: [] };
  if (path.startsWith("/api/lichess")) return { accounts: [] };
  if (path.startsWith("/api/settings")) return {};
  return {};
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204); res.end(); return;
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(api(url.pathname, url)));
    return;
  }
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path.startsWith("/static/")) path = path.slice("/static".length);
  try {
    const file = await readFile(join(STATIC_DIR, path));
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise((r) => server.listen(PORT, r));

const { chromium } = await import("playwright");
let browser;
for (const channel of ["msedge", "chrome", undefined]) {
  try {
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    break;
  } catch { /* next */ }
}
if (!browser) { console.error("[lib-smoke] no chromium-based browser available"); process.exit(2); }

const base = `http://127.0.0.1:${PORT}`;
const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "laptop-1180", width: 1180, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
];

const failures = [];
// A request the smoke holds open must arrive; if it never does, fail by name
// instead of waiting forever (closing the browser would not end this process).
const arrives = (promise, label, ms = 20000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s waiting for ${label}`)), ms).unref()),
]);

async function runViewport(vp) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  const loadRequests = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/build/load")) loadRequests.push(req.url());
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });
  // The lazy dashboard chunk renders skeleton rows first; wait for the real ones.
  await page.waitForFunction(() => document.querySelector("#dashboard-repertoires .lib-row[data-repertoire-id]") && !document.querySelector("#dashboard-repertoires .lib-row.is-skeleton"), null, { timeout: 30_000 });

  const check = (ok, label) => { if (!ok) failures.push(`${vp.name}: ${label}`); };

  // Optional review screenshot (UI_V2_SHOTS=<dir> UI_V2_TAG=before|after).
  if (process.env.UI_V2_SHOTS) {
    await page.mouse.move(vp.width - 4, vp.height - 4); // park the pointer so the hover-expand rail is collapsed
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(process.env.UI_V2_SHOTS, `library-${process.env.UI_V2_TAG || "after"}-${vp.name}.png`) });
  }

  // Table renders the real fixture rows.
  const rowCount = await page.locator("#dashboard-repertoires .lib-row").count();
  check(rowCount === 3, `expected 3 lib rows, got ${rowCount}`);

  // Today card shows the real streak/queue from the fixture.
  const todayVisible = await page.locator("#dashboard-today:not([hidden])").count();
  check(todayVisible === 1, "today card should be visible");
  const todayText = await page.locator("#dashboard-today").textContent().catch(() => "");
  check(todayText.includes("5"), "today card should show streak 5");
  check(todayText.includes("9"), "today card should show 9 due");

  // Prototype composition: one Today strip, the table with its column header,
  // the Get started setup card — and none of the legacy list-item rows / metric cards.
  check((await page.locator("#dashboard-today .today-streak").count()) === 1, "today strip should carry the streak");
  check((await page.locator("#dashboard-today #dashboard-train-now").count()) === 1, "Train button should live in the today strip");
  // "Get started" is the 3-step setup checklist ticked from real state — the
  // fixture has a repertoire + a training session done, Lichess unlinked.
  // Recommendations never render here; the Today strip owns due/weak.
  check((await page.locator("#dashboard-steps:not([hidden]) .step").count()) === 3, "Get started card should list all 3 setup steps");
  check((await page.locator("#dashboard-steps .step.is-done").count()) === 2, "fixture state should tick 2 of the 3 setup steps");
  check(((await page.locator("#dashboard-steps .setup-count").textContent().catch(() => "")) || "").includes("2 of 3 done"), "setup progress should read 2 of 3 done");
  check((await page.locator("#dashboard-repertoires .list-item").count()) === 0, "rows must not use the legacy list-item card");
  // The lifetime counts are one quiet line, not the old tile row.
  check((await page.locator("#dashboard-today .metric").count()) === 0, "today strip should not keep the metric tiles");
  const countsShown = await page.locator("#dashboard-today .today-counts").isVisible();
  check(countsShown === (vp.width > 760), `today counts visible=${countsShown} at ${vp.width}px`);
  if (vp.width > 760) {
    const counts = (await page.locator("#dashboard-today .today-counts").textContent()) || "";
    check(counts.includes("12") && counts.includes("3") && counts.includes("7"), `counts should carry games/repertoires/sessions, got "${counts}"`);
  }
  const colsShown = await page.locator("#lib-cols").isVisible();
  check(colsShown === (vp.width > 760), `column header visible=${colsShown} at ${vp.width}px`);

  // The Today strip is one band: the queue leads at the strip's reading size,
  // the rest of the queue is one quieter line under it, and the week's history
  // has its own cell at the right. Read as four equal 13px lines, the queue was
  // the third thing the eye found.
  const queueFirst = await page.evaluate(() => {
    const body = document.querySelector("#dashboard-today .today-body");
    if (!body) return false;
    const kids = [...body.children];
    return kids.length > 0 && kids[0].classList.contains("today-queue");
  });
  check(queueFirst, "the queue must be the first line of the Today body");
  const queueSize = await page.evaluate(() => {
    const q = document.querySelector("#dashboard-today .today-queue");
    // The streak warning takes the second line when midnight is near.
    const more = document.querySelector("#dashboard-today :is(.today-more, .today-warning)");
    if (!q || !more) return null;
    return { q: parseFloat(getComputedStyle(q).fontSize), more: parseFloat(getComputedStyle(more).fontSize) };
  });
  // Round 5: the phone type scale is Lichess-measured (14px body, 15px lead),
  // so on a phone the lead is 15px and must not grow back past 16px; wider
  // viewports keep the 16px lead. Either way it outranks the line under it.
  const phone = vp.width <= 760;
  const leadOk = queueSize && (phone ? queueSize.q >= 15 && queueSize.q <= 16 : queueSize.q >= 16);
  check(leadOk && queueSize.more < queueSize.q,
    `the queue must be the strip's loudest line, got ${JSON.stringify(queueSize)}`);
  const countsInAside = await page.evaluate(() => {
    const aside = document.querySelector("#dashboard-today .today-aside");
    return !!aside && !!aside.querySelector(".today-counts");
  });
  check(countsInAside, "the lifetime counts must sit in the Today aside");

  // Phone: the card head's actions are hidden and the page head carries them.
  // Its + opens a sheet with New repertoire and Import PGN (a phone once had no
  // route to import at all); its magnifier opens the search field, so the list
  // starts under one row of filters.
  if (vp.width <= 760) {
    check(!(await page.locator("#dashboard-import-pgn").isVisible()), "the card head's Import PGN is folded into the + sheet on a phone");
    check(!(await page.locator("#lib-filter-search").isVisible()), "search waits behind the page head's magnifier on a phone");
    await page.locator("#library-add").click();
    await page.waitForTimeout(250);
    const sheet = await page.locator("#library-add-menu [role=menuitem]").allTextContents();
    check(sheet.join("|") === "New repertoire|Import PGN", `the + sheet should offer New repertoire and Import PGN, got ${JSON.stringify(sheet)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.locator("#library-search-toggle").click();
    await page.waitForTimeout(250);
    check(await page.locator("#lib-filter-search").isVisible(), "the magnifier opens the search field");
    check(await page.evaluate(() => document.activeElement?.id === "lib-filter-search"), "the opened search field takes focus");
    await page.locator("#lib-search-cancel").click();
    await page.waitForTimeout(250);
    check(!(await page.locator("#lib-filter-search").isVisible()), "Cancel folds the search field away");
    // The mastery figure is the row's trailing value on a phone: the desktop
    // has a Mastery column header, a phone has none, so the number is named.
    const phoneMastery = page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-1"] .lib-cell-mastery');
    check(await phoneMastery.isVisible(), "the mastery figure must be visible on a phone");
    const phoneMasteryText = (await phoneMastery.textContent()) || "";
    check(/50%/.test(phoneMasteryText) && /mastered/.test(phoneMasteryText),
      `the phone mastery figure should read "50% mastered", got "${phoneMasteryText}"`);
    // The phone checklist hides the finished steps, so a step number would
    // point at a list the phone never drew.
    const phoneStepBadge = page.locator("#dashboard-steps .step:not(.is-done) .step-n");
    check((await phoneStepBadge.count()) === 0 || !(await phoneStepBadge.first().isVisible()),
      "the phone checklist must not show a step number");
  }

  // No preview pane: the table takes the full width and a row click opens.
  check((await page.locator("#lib-preview").count()) === 0, "the library should not render a preview pane");
  // The list must actually fill its column. A two-column track leaking into the
  // phone breakpoint squeezed this to ~70px, and `overflow: hidden` on the list
  // hid the clipped text from the document-level overflow check below - only a
  // measured width catches it. The Library is one column at every width now, so
  // every viewport must fill.
  if (vp.width <= 1020) {
    const listWidth = await page.locator("#dashboard-repertoires").evaluate((el) => el.getBoundingClientRect().width);
    check(listWidth >= vp.width - 60, `library list should fill the single column, got ${Math.round(listWidth)}px at ${vp.width}px`);
  }

  // The Library card ends at its last row. It used to be told to take the
  // height it was given, so three repertoires sat in a card running to the
  // bottom of the window with about 70% of it empty white.
  if (vp.width >= 1021) {
    const listBox = await page.locator("#view-dashboard .lib-list").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const rows = el.querySelector("#dashboard-repertoires");
      const lastRow = rows && rows.lastElementChild;
      return { top: r.top, bottom: r.bottom, width: r.width, height: r.height, lastRowBottom: lastRow ? lastRow.getBoundingClientRect().bottom : null };
    });
    const stepsBox = await page.locator("#dashboard-steps").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    });
    // The card hugs the table: no more than the card's own padding under the
    // last row (the list's bottom padding is 0; the card's is 0 here).
    check(listBox.bottom - listBox.lastRowBottom <= 4,
      `the Library card should end at its last row, ${Math.round(listBox.bottom - listBox.lastRowBottom)}px of card under it`);
    check(vp.height - listBox.bottom > 120,
      `the Library card should not stretch to the bottom of the window, ${Math.round(vp.height - listBox.bottom)}px short`);
    // The checklist is a band under the table, not a short card floating at the
    // right of it with nothing beneath: it starts below the table's last row and
    // runs the same width.
    check(stepsBox.top >= listBox.bottom - 1,
      `the checklist should sit under the table, ${Math.round(listBox.bottom - stepsBox.top)}px of overlap`);
    check(Math.abs(stepsBox.width - listBox.width) <= 4,
      `the checklist should run the table's width, ${Math.round(listBox.width)}px vs ${Math.round(stepsBox.width)}px`);
  }

  // Mastery bar carries the health pct.
  const barWidth = await page.locator("#dashboard-repertoires .lib-row:first-child .lib-mbar i.is-mastered").getAttribute("style");
  check(/width:\s*50%/.test(barWidth || ""), `first row mastery bar should be 50%, got "${barWidth}"`);

  const row2 = page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-2"]');
  // A click (or tap) on a row opens the workspace directly.
  await row2.click();
  await page.waitForFunction(() => document.getElementById("view-build").classList.contains("is-active") &&
    document.getElementById("view-build").getAttribute("aria-busy") === "false");
  check(loadRequests.some((u) => u.includes("rep-2")), "clicking a row should open the workspace (/api/build/load)");
  check(/London System/.test(await page.locator("#build-rep-name").textContent().catch(() => "")), "the clicked repertoire must be hydrated");

  // Hold the refresh so keyboard focus is acquired before the fresh listing
  // lands. Waiting for a quiet list hid the real focus-loss regression.
  let releaseRefresh, markRefreshStarted;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  await page.route("**/api/repertoires", async (route) => {
    markRefreshStarted();
    await refreshGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE_REPS) });
  });
  // Return to the visible Library before exercising its keyboard path.
  await page.evaluate(() => document.querySelector('[data-testid="nav-dashboard"]').click());
  await arrives(refreshStarted, "the Library refresh (/api/repertoires)");
  const loadsBeforeKeyboard = loadRequests.length;
  // Watch the row the refresh paints over: the same repertoire arriving again
  // must not replace it (a replaced node is what replayed the row entrance and
  // dropped focus, the "fades in twice" report).
  await page.evaluate(() => {
    window.__focusedLibraryRow = document.activeElement;
    window.__entrancesBefore = 0;
    document.addEventListener("animationstart", (event) => {
      if (event.animationName !== "row-enter") return;
      if (event.target.closest("#dashboard-repertoires")) window.__entrancesBefore += 1;
    }, true);
  });
  // The route swap lands inside a View Transition, a frame after the click: a
  // row in a still-hidden view cannot take focus.
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-2"]').waitFor({ state: "visible" });
  await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-2"]').focus();
  await page.evaluate(() => {
    window.__focusedLibraryRow = document.activeElement;
    window.__nodeOfRep2 = document.activeElement;
  });
  releaseRefresh();
  // The refresh has landed when the list stops being the one it started as; the
  // rows themselves may (correctly) survive it, so wait on the node we hold
  // plus a settled frame rather than on it being disconnected.
  await page.waitForFunction(() => {
    const row = document.querySelector('#dashboard-repertoires .lib-row[data-repertoire-id="rep-2"]');
    return !!row && row === window.__nodeOfRep2;
  }, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  const keptNode = await page.evaluate(() => {
    const row = document.querySelector('#dashboard-repertoires .lib-row[data-repertoire-id="rep-2"]');
    return { same: row === window.__nodeOfRep2, entrances: window.__entrancesBefore };
  });
  check(keptNode.same, "an identical Library refresh must keep the row's DOM node (no re-render)");
  check(keptNode.entrances === 0, `an identical Library refresh must not replay the row entrance, saw ${keptNode.entrances}`);
  const focusRetained = await page.evaluate(() => document.activeElement?.dataset?.repertoireId === "rep-2");
  check(focusRetained, "a background Library refresh must retain keyboard focus on the repertoire row");
  // Continue the other checks even if focus retention failed.
  if (!focusRetained) await page.locator('#dashboard-repertoires .lib-row[data-repertoire-id="rep-2"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("view-build").getAttribute("aria-busy") === "false" &&
    document.getElementById("view-build").classList.contains("is-active"));
  check(loadRequests.length === loadsBeforeKeyboard + 1, "Enter on the visible row must load its repertoire once");

  // Overflow check.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `horizontal overflow of ${overflow}px`);

  // Console errors (filter network 4xx noise the fixture stack intentionally lacks).
  const realErrors = consoleErrors.filter((t) => !/Failed to load resource/.test(t));
  check(realErrors.length === 0, `console errors: ${realErrors.join(" | ")}`);

  await page.close();
}

try {
  for (const vp of VIEWPORTS) await runViewport(vp);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("[lib-smoke] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[lib-smoke] ok — all three viewports render the Library from real fixture state with no overflow and no console errors.");
