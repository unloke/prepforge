import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const REPO = join(root, "..");
const BRAVE = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
// Polish E2E build: the acceptance bundle enables VITE_ENABLE_POLISH_E2E so the
// ?polish_e2e=1 hook installs (mirrors the Scout VITE_ENABLE_SCOUT_E2E gate).
// Production builds never set it, so window.__prepforgePolishE2e stays absent.
const VIEWPORTS = [
  { width: 1280, height: 800, label: "laptop" },
  { width: 800, height: 900, label: "narrow" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

function startStatic() {
  // Serve the BUILT app (src/prepforge_chess/web/static): index.html at /
  // and assets under /static/, mirroring the Python static server layout.
  const dist = join(REPO, "src", "prepforge_chess", "web", "static");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = decodeURIComponent(url.pathname);
    // The built index references /static/*; the file on disk is index.html.
    const rel = path === "/" ? "index.html" : path.replace(/^\/static\//, "");
    const file = join(dist, rel);
    console.log("[serve]", path, "->", rel, existsSync(file) ? "OK" : "MISS");
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const LONG_PROSE = "Coach read. ".repeat(120);
// Real longest guidance: the longest phase-coach tip is 117 chars
// ("Players at your rating almost never play that; they choose e4. ..."),
// and book-departure lines are one sentence + one chip. Acceptance renders the
// true longest tip plus the longest bookline so the footer proves fully
// visible with real content — no clamping, no synthetic long text.
const LONG_HUMAN =
  "Players at your rating almost never play that; they choose e4. Activate the king, push pawns, and don't rush tactics.";
const LONG_BOOKLINE =
  "You've left your prep: My Caro-Kann Repertoire calls for c6 in this position.";
const LONG_HINT =
  "How much of real human play (at your strength, across every plausible reply and sideline the opponent might try in this sharp middlegame) does this repertoire answer? ".repeat(
    4,
  );

const results = [];
let failures = 0;
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const browser = await chromium.launch({ executablePath: BRAVE, args: ["--no-sandbox"] });
const server = await startStatic();
const base = `http://127.0.0.1:${server.address().port}`;

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  page.on("console", (m) => console.log("[page]", m.type(), m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  page.on("requestfailed", (r) => console.log("[reqfail]", r.url().slice(0, 120), r.failure()?.errorText));
  page.on("response", (r) => {
    if (r.status() >= 400) console.log("[http]", r.status(), r.url().slice(0, 140));
  });
  await page.goto(`${base}/?polish_e2e=1`, { timeout: 30000 });
  await page.waitForSelector("#analysis-explain", { state: "attached", timeout: 15000 });

  // The gated hook must exist on the E2E page (prod pages never expose it —
  // asserted structurally in ui-layout tests).
  const hookPresent = await page.evaluate(() => !!window.__prepforgePolishE2e);
  check(`[${vp.label}] polish e2e hook gated on`, hookPresent);

  // --- Coach: long explanation + real longest guidance ----------------------
  // The footer is a fixed, non-scrolling row: its box must sit inside the card
  // and every visible descendant must sit inside the FOOTER box. Guidance is
  // the true longest tip + longest bookline (no clamping anywhere), so this
  // proves real content fits beside the explanation scroll region.
  const coach = await page.evaluate(
    ({ prose, human, bookline }) => {
      document.querySelector('[data-testid="nav-analyze"]').click();
      document.getElementById("coach-prose").textContent = prose;
      const maia = document.getElementById("coach-maia");
      maia.hidden = false;
      maia.textContent = human;
      const book = document.getElementById("coach-bookline");
      book.hidden = false;
      book.textContent = bookline;
      const card = document.getElementById("analysis-explain");
      const scroll = document.getElementById("coach-scroll");
      const footer = document.getElementById("coach-footer");
      const head = card.querySelector(".explain-head");
      const h0 = card.getBoundingClientRect().height;
      scroll.scrollTop = 99999;
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, height: b.height };
      };
      const cardR = card.getBoundingClientRect();
      const scrollR = r(scroll);
      const footR = r(footer);
      const headR = r(head);
      const styles = getComputedStyle(scroll);
      const footStyles = getComputedStyle(footer);
      const out = [];
      footer.querySelectorAll("*").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.height <= 0 || b.width <= 0) return;
        if (b.top < footR.top - 1.5 || b.bottom > footR.bottom + 1.5) {
          out.push(`${el.id || el.className}@${Math.round(b.top)}-${Math.round(b.bottom)}`);
        }
      });
      return {
        cardH0: h0,
        cardH: cardR.height,
        headVisible: headR.top >= cardR.top - 1 && headR.bottom <= cardR.bottom + 1,
        scrollScrollable: scroll.scrollHeight > scroll.clientHeight + 2,
        scrollTop: scroll.scrollTop,
        footerInside:
          footR.top >= cardR.top - 1 &&
          footR.bottom <= cardR.bottom + 1 &&
          footR.height > 0,
        footerVisible: footStyles.visibility !== "hidden" && footStyles.display !== "none",
        footerBox: footR,
        footerEscapees: out,
        footerScroll: footStyles.overflowY,
        scrollOverflowX: styles.overflowX,
      };
    },
    { prose: LONG_PROSE, human: LONG_HUMAN, bookline: LONG_BOOKLINE },
  );
  check(`[${vp.label}] coach card height stable`, Math.abs(coach.cardH - coach.cardH0) < 1, `${coach.cardH0}px`);
  check(`[${vp.label}] coach header visible`, coach.headVisible);
  check(`[${vp.label}] coach explanation scrolls`, coach.scrollScrollable && coach.scrollTop > 0);
  check(`[${vp.label}] coach footer fully inside card`, coach.footerInside, JSON.stringify(coach.footerBox));
  check(`[${vp.label}] coach footer descendants contained`, coach.footerEscapees.length === 0, coach.footerEscapees.join(","));
  check(`[${vp.label}] coach footer never scrolls itself`, coach.footerScroll !== "auto" && coach.footerScroll !== "scroll", coach.footerScroll);
  check(`[${vp.label}] coach no horizontal scroll`, coach.scrollOverflowX === "hidden" || coach.scrollOverflowX === "clip");

  // --- Coach: empty footer consumes no space --------------------------------
  const empty = await page.evaluate(() => {
    document.getElementById("coach-maia").hidden = true;
    document.getElementById("coach-bookline").hidden = true;
    const foot = document.getElementById("coach-footer");
    return foot.getBoundingClientRect().height;
  });
  check(`[${vp.label}] coach empty footer collapses`, empty < 4, `${empty}px`);

  // --- Build Inspector: compact header + content height -----------------------
  // The inspector is one compact header row (title + segmented + ⓘ + scan) with
  // rows-only panels. Assert: (a) long content stays inside, (b) the header is
  // a single row, (c) the ⓘ popover explains scope on demand, (d) the panel
  // owns scroll and offers materially more content height than before.
  const insp = await page.evaluate(
    ({ hint }) => {
      document.querySelector('[data-testid="nav-build"]').click();
      document.getElementById("build-tool-coverage").click();
      const head = document.querySelector(".build-inspector-head");
      const headH = head.getBoundingClientRect().height;
      const infoBtn = document.getElementById("inspector-info");
      infoBtn.click();
      const pop = document.getElementById("inspector-info-pop");
      const popText = pop ? pop.textContent : "";
      if (pop) pop.remove();
      const scanBtn = document.getElementById("coverage-run");
      const scanVisible = scanBtn && getComputedStyle(scanBtn).display !== "none";
      const gaps = document.getElementById("coverage-gaps");
      gaps.innerHTML = Array.from(
        { length: 12 },
        (_, i) =>
          `<div class="coverage-gap"><input type="checkbox" class="coverage-gap-check"/><span class="coverage-gap-body"><span class="coverage-gap-move">Nf3+</span><span class="coverage-gap-meta">87% play it here at this extremely long and wordy meta line number ${i} that must wrap inside the available width without escaping the inspector border at all</span></span></div>`,
      ).join("");
      const inspector = document.getElementById("build-inspector");
      const panel = document.getElementById("coverage-drawer");
      const ir = inspector.getBoundingClientRect();
      // inner scroll width can exceed the border by the scrollbar gutter; compare
      // against the inspector's padding box instead.
      const pad = (el) => {
        const s = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return {
          left: b.left + parseFloat(s.paddingLeft || 0),
          right: b.right - parseFloat(s.paddingRight || 0),
          bottom: b.bottom - parseFloat(s.paddingBottom || 0),
        };
      };
      const box = pad(inspector);
      const bad = [];
      panel.querySelectorAll("*").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) return;
        if (b.left < box.left - 1 || b.right > box.right + 1) {
          bad.push(`${el.className}@${Math.round(b.left)},${Math.round(b.right)}`);
        }
      });
      const ps = getComputedStyle(panel);
      // explorer rows
      document.getElementById("build-tool-explorer").click();
      const rows = document.getElementById("explorer-rows");
      rows.innerHTML = Array.from(
        { length: 10 },
        (_, i) =>
          `<button type="button" class="explorer-row"><span class="explorer-san">Nf3+${i}</span><span class="explorer-games">12.5k</span><span class="explorer-bar"><span class="explorer-bar-w" style="width:40%"></span></span></button>`,
      ).join("");
      const panel2 = document.getElementById("explorer-drawer");
      const ps2 = getComputedStyle(panel2);
      const box2 = pad(inspector);
      const bad2 = [];
      panel2.querySelectorAll("*").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) return;
        if (b.left < box2.left - 1 || b.right > box2.right + 1) {
          bad2.push(`${el.className}@${Math.round(b.left)},${Math.round(b.right)}`);
        }
      });
      return {
        coverageBad: bad.slice(0, 5),
        explorerBad: bad2.slice(0, 5),
        panelScroll: ps.overflowY,
        headH,
        popText,
        scanVisible,
        // Measure the VISIBLE explorer panel (coverage is hidden after the
        // switch, so its clientHeight reads 0 by design).
        panelMaxH: ps2.maxHeight,
        panelClientH: panel2.clientHeight,
      };
    },
    { hint: LONG_HINT },
  );
  check(`[${vp.label}] coverage content inside inspector`, insp.coverageBad.length === 0, insp.coverageBad.join(" | "));
  check(`[${vp.label}] explorer content inside inspector`, insp.explorerBad.length === 0, insp.explorerBad.join(" | "));
  check(`[${vp.label}] inspector panel owns scroll`, insp.panelScroll === "auto" || insp.panelScroll === "scroll");
  check(`[${vp.label}] inspector header is one compact row`, insp.headH <= 44, `${insp.headH}px`);
  check(
    `[${vp.label}] inspector info popover explains scope`,
    /human play|Master games|Players near/.test(insp.popText || ""),
    (insp.popText || "").slice(0, 100),
  );
  check(`[${vp.label}] coverage scan lives in the header`, !!insp.scanVisible);
  // max-height resolves to px in computed style: laptop 352px (was 272px at
  // 34vh), narrow 380px (was 300px). Either way the budget grows ~30%.
  const maxPx = parseFloat(insp.panelMaxH || "0");
  check(
    `[${vp.label}] inspector panel offers more content height`,
    maxPx > 300,
    `max ${insp.panelMaxH || ""}, ${insp.panelClientH}px showing 10 rows`,
  );
  // No nested competing scroll regions: the inner content containers must not
  // themselves scroll (checked structurally in ui-layout tests; the panel is
  // the single scroll owner).

  // --- My last game: two accounts → no chooser, newest wins ---------------
  // Seed two linked identities, stub /api/lichess/latest with per-account
  // games (B's game is newer), click My last game, assert NO chooser appears,
  // the request carries NO account_id (self aggregation is server-side), the
  // newer game loads into the PGN box, and the source account is shown.
  const selfFlow = await page.evaluate(async () => {
    const seen = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/lichess/latest")) {
        seen.push(u);
        return new Response(
          JSON.stringify({
            has_game: true,
            lichess_id: "newer002",
            white: "account_b",
            black: "Opponent",
            result: "1-0",
            is_new: true,
            finished_at: "2026-06-08T00:00:00Z",
            source_account: "account_b",
            pgn: '[White "account_b"]\n\n1. e4 e5 *\n',
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return realFetch(url, opts);
    };
    const hook = window.__prepforgePolishE2e;
    if (!hook) return { skipped: true };
    hook.setLichessAccounts([
      { id: "acc-a", username: "account_a", is_primary: true },
      { id: "acc-b", username: "account_b", is_primary: false },
    ]);
    document.querySelector('[data-testid="nav-analyze"]').click();
    document.getElementById("fetch-my-game").click();
    await new Promise((r) => setTimeout(r, 600));
    const overlay = document.querySelector(".modal-overlay .account-chooser");
    const status = document.getElementById("app-status")?.textContent || "";
    const pgn = document.getElementById("pgn-input")?.value || "";
    const accounts = hook.getLichessAccounts();
    const primaryStillA = (accounts.find((a) => a.is_primary) || {}).id === "acc-a";
    window.fetch = realFetch;
    return {
      chooserOpened: !!overlay,
      latestCalls: seen,
      status,
      pgnLoaded: pgn.includes("account_b"),
      primaryStillA,
    };
  });
  check(`[${vp.label}] my-last-game shows no chooser for two accounts`, !selfFlow.chooserOpened);
  check(
    `[${vp.label}] my-last-game aggregates without account_id`,
    (selfFlow.latestCalls || []).length >= 1 &&
      (selfFlow.latestCalls || []).every((u) => !u.includes("account_id")),
    (selfFlow.latestCalls || []).join(","),
  );
  check(
    `[${vp.label}] my-last-game loads newest game + source`,
    !!selfFlow.pgnLoaded && /account_b/.test(selfFlow.status || ""),
    (selfFlow.status || "").slice(0, 120),
  );
  check(`[${vp.label}] primary still A afterwards`, !!selfFlow.primaryStillA);

  // --- Games self aggregation: no chooser, both accounts fetched ------------
  // Seed two linked identities, click Check my games, assert NO chooser opens,
  // the compare POST carries NO account narrowing (self = server-side fan-out),
  // and the Self chip + source picker chrome is present.
  const compareFlow = await page.evaluate(async () => {
    const hook = window.__prepforgePolishE2e;
    await hook.setLichessAccounts([
      { id: "acc-a", username: "account_a", is_primary: true },
      { id: "acc-b", username: "account_b", is_primary: false },
    ]);
    try {
      localStorage.removeItem("prepforge.games_source");
    } catch (_) {}
    document.querySelector('[data-testid="nav-replay"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const btn = document.getElementById("lichess-compare-btn");
    const tray = document.getElementById("games-source-chips");
    const addBtn = document.getElementById("games-source-add");
    // NOTE: postJson() awaits getCsrfToken() → GET /api/csrf first; the stub
    // below answers /api/csrf + /api/lichess/compare and passes the rest
    // through, so the full handler chain runs deterministically.
    const bodies = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/csrf")) {
        return new Response(JSON.stringify({ csrf_token: "test-csrf" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/api/lichess/compare")) {
        bodies.push(opts?.body ? String(opts.body) : "");
        return new Response(
          JSON.stringify({
            username: "self",
            count: 2,
            misses_recorded: 0,
            sources: ["account_a", "account_b"],
            games: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return realFetch(url, opts);
    };
    btn.click();
    await new Promise((r) => setTimeout(r, 1500));
    const overlay = document.querySelector(".modal-overlay .account-chooser");
    const status = document.getElementById("app-status")?.textContent || "";
    window.fetch = realFetch;
    return {
      chooserOpened: !!overlay,
      bodies,
      status,
      selfChipOn: !!tray?.textContent?.includes("Self"),
      chipLabel: tray?.textContent || "",
      pickPresent: !!addBtn,
    };
  });
  check(`[${vp.label}] games self shows no chooser for two accounts`, !compareFlow.chooserOpened);
  check(
    `[${vp.label}] games self aggregates without account narrowing`,
    (compareFlow.bodies || []).length >= 1 &&
      (compareFlow.bodies || []).every((b) => !b.includes("account_id")),
    `bodies=${JSON.stringify(compareFlow.bodies)}`,
  );
  check(`[${vp.label}] games self chip on + picker present`, !!compareFlow.selfChipOn && !!compareFlow.pickPresent, `chip=${compareFlow.chipLabel || ""}`);
  check(
    `[${vp.label}] games self status names self`,
    /self/.test(compareFlow.status || ""),
    (compareFlow.status || "").slice(0, 100),
  );

  // --- Scout composer: one chips tray + single Add trigger ------------------
  // Scout defaults to implicit Self (all linked): the tray shows the collapsed
  // Self chip claiming the linked accounts, and the composer (only) carries
  // the external-username input. No standalone Self/Sources buttons, no
  // standalone username textbox.
  const scoutFlow = await page.evaluate(async () => {
    const hook = window.__prepforgePolishE2e;
    await hook.setLichessAccounts([
      { id: "acc-a", username: "account_a", is_primary: true },
      { id: "acc-b", username: "account_b", is_primary: false },
    ]);
    document.querySelector('[data-testid="nav-scout"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const tray = document.getElementById("scout-source-chips");
    const addBtn = document.getElementById("scout-source-add");
    return {
      trayPresent: !!tray,
      trayLabel: tray?.textContent || "",
      addPresent: !!addBtn,
      selfBtnGone: !document.getElementById("scout-source-self"),
      pickBtnGone: !document.getElementById("scout-source-pick"),
      inputGone: !document.getElementById("scout-username"),
    };
  });
  check(`[${vp.label}] scout composer tray + add present`, !!scoutFlow.trayPresent && !!scoutFlow.addPresent);
  check(
    `[${vp.label}] scout tray claims linked Self`,
    /2 linked|all linked|Self · 2/.test(scoutFlow.trayLabel || ""),
    scoutFlow.trayLabel || "",
  );
  check(`[${vp.label}] scout standalone source chrome gone`, !!scoutFlow.selfBtnGone && !!scoutFlow.pickBtnGone && !!scoutFlow.inputGone);

  // --- Source Composer parity: one shared surface on Games AND Scout -----
  // Both pages render [chips] [+ Add]; the popover shows one source list:
  // Self, linked rows, external rows, Add username, Done. Interactions drive
  // every checkbox, external add/remove, chip remove, Done, and Esc on both
  // pages; the popover must not move while interacting (viewport-anchored).
  const composerFlow = await page.evaluate(async () => {
    const hook = window.__prepforgePolishE2e;
    await hook.setLichessAccounts([
      { id: "acc-a", username: "account_a", is_primary: true },
      { id: "acc-b", username: "account_b", is_primary: false },
    ]);
    try {
      localStorage.removeItem("prepforge.games_source");
      localStorage.removeItem("prepforge.games_external");
      localStorage.removeItem("prepforge.scout_source");
      localStorage.removeItem("prepforge.scout_external");
    } catch (_) {}
    const box = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        left: Math.round(r.left),
        w: Math.round(r.width),
        h: Math.round(r.height),
        cssTop: cs.top,
        cssLeft: cs.left,
      };
    };
    // Anchor stability = the composer's CSS position doesn't move (top/left
    // set once by positionPopover and re-applied identically after every
    // render). The cached anchor rect makes this exact; keep the painted-box
    // comparison as a sanity net with tolerance for sub-pixel layout jitter.
    const near = (a, b) => {
      if (!!a && !!b && a.cssTop === b.cssTop && a.cssLeft === b.cssLeft) return true;
      return !!a && !!b && Math.abs(a.top - b.top) <= 12 && Math.abs(a.left - b.left) <= 12;
    };
    const out = { pages: {} };
    for (const page of [
      { nav: "nav-replay", add: "games-source-add", tray: "games-source-chips", key: "games" },
      { nav: "nav-scout", add: "scout-source-add", tray: "scout-source-chips", key: "scout" },
    ]) {
      document.querySelector(`[data-testid="${page.nav}"]`).click();
      await new Promise((r) => setTimeout(r, 200));
      const R = { trayLabel: document.getElementById(page.tray)?.textContent || "" };
      R.addPresent = !!document.getElementById(page.add);
      R.noReplayAccount = !document.getElementById("replay-account");
      document.getElementById(page.add).click();
      await new Promise((r) => setTimeout(r, 200));
      const pop = () => document.querySelector(".src-popover");
      R.popOpen = !!pop();
      R.hasSelf = !!pop()?.textContent?.includes("Self");
      R.hasAccounts =
        !!pop()?.textContent?.includes("account_a") && !!pop()?.textContent?.includes("account_b");
      R.hasAddRow = !!pop()?.querySelector("[data-src-add]");
      R.hasDone = !!pop()?.querySelector("[data-src-done]");
      R.pos0 = box(pop());
      R.fixedPos = pop() ? getComputedStyle(pop()).position === "fixed" : false;
      const selfBox = pop()?.querySelector('[data-testid="src-self-checkbox"]');
      if (selfBox) {
        selfBox.click();
        await new Promise((r) => setTimeout(r, 250));
      }
      R.afterSelf = document.getElementById(page.tray)?.textContent || "";
      R.selfStable = near(R.pos0, box(pop()));
      const accBox = pop()?.querySelector('[data-src-checkbox="acc-a"]');
      if (accBox) {
        // Direct checkbox clicks are synced on the click path (Playwright
        // .click() fires click before change); the trailing change no-ops.
        accBox.click();
        await new Promise((r) => setTimeout(r, 250));
      }
      R.afterAccount = document.getElementById(page.tray)?.textContent || "";
      R.accountStable = near(R.pos0, box(pop()));
      const addInput = pop()?.querySelector("[data-src-add]");
      if (addInput) {
        addInput.value = "Hikaru";
        addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
      }
      R.afterExternal = document.getElementById(page.tray)?.textContent || "";
      R.externalRow = !!pop()?.querySelector('[data-src-external="Hikaru"]');
      R.externalStable = near(R.pos0, box(pop()));
      const uncheck = pop()?.querySelector('[data-src-external-checkbox]');
      if (uncheck) {
        uncheck.click();
        await new Promise((r) => setTimeout(r, 200));
      }
      R.afterRemove = document.getElementById(page.tray)?.textContent || "";
      R.removeStable = near(R.pos0, box(pop()));
      pop()?.querySelector("[data-src-done]")?.click();
      await new Promise((r) => setTimeout(r, 150));
      R.doneCloses = !document.querySelector(".src-popover");
      document.getElementById(page.add).click();
      await new Promise((r) => setTimeout(r, 200));
      R.reopenTray = document.getElementById(page.tray)?.textContent || "";
      R.reopenStable = near(R.pos0, box(pop()));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 100));
      R.escCloses = !document.querySelector(".src-popover");
      R.focusReturned =
        document.activeElement?.id === page.add ||
        !!document.activeElement?.closest?.(".replay-toolbar");
      out.pages[page.key] = R;
    }
    return out;
  });
  for (const key of ["games", "scout"]) {
    const R = composerFlow.pages[key];
    const tag = key === "games" ? "games" : "scout";
    check(`[${vp.label}] ${tag} tray defaults to collapsed Self`, /Self · 2/.test(R.trayLabel || ""), R.trayLabel || "");
    check(`[${vp.label}] ${tag} chips + add, no duplicate summary`, !!R.addPresent && !!R.noReplayAccount);
    check(`[${vp.label}] ${tag} popover one list (Self+accounts+Add+Done)`, !!R.popOpen && !!R.hasSelf && !!R.hasAccounts && !!R.hasAddRow && !!R.hasDone);
    check(`[${vp.label}] ${tag} popover viewport-fixed`, !!R.fixedPos, JSON.stringify(R.pos0 || {}));
    check(`[${vp.label}] ${tag} self toggle keeps anchor`, !!R.selfStable, R.afterSelf || "");
    check(`[${vp.label}] ${tag} account toggle keeps anchor`, !!R.accountStable, R.afterAccount || "");
    check(`[${vp.label}] ${tag} external add renders row+chip, keeps anchor`, !!R.externalRow && /Hikaru/.test(R.afterExternal || "") && !!R.externalStable, R.afterExternal || "");
    check(`[${vp.label}] ${tag} external remove keeps anchor`, !!R.removeStable, R.afterRemove || "");
    check(`[${vp.label}] ${tag} done closes, reopen keeps state+anchor`, !!R.doneCloses && !!R.reopenStable, R.reopenTray || "");
    check(`[${vp.label}] ${tag} esc closes + focus returns`, !!R.escCloses && !!R.focusReturned);
  }

  // --- Connections: compact rows + overflow menu ------------------------------
  const connFlow = await page.evaluate(async () => {
    const hook = window.__prepforgePolishE2e;
    await hook.setLichessAccounts([
      { id: "acc-a", username: "account_a", is_primary: true },
      { id: "acc-b", username: "account_b", is_primary: false },
    ]);
    const settingsTab = document.querySelector('.tab[data-view="settings"]');
    if (settingsTab) settingsTab.click();
    await new Promise((r) => setTimeout(r, 400));
    const list = document.getElementById("settings-lichess-accounts");
    const rows = list ? [...list.querySelectorAll(".conn-row")] : [];
    const primaryChip = list?.querySelector(".conn-primary");
    const narrow = (() => {
      const w = document.documentElement.clientWidth;
      return { width: w };
    })();
    const firstMenu = rows[1]?.querySelector('[data-conn-action="menu"]');
    firstMenu?.click();
    await new Promise((r) => setTimeout(r, 100));
    const menuOpen = !rows[1]?.querySelector(".conn-menu")?.hidden;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    return {
      rowCount: rows.length,
      primaryChip: !!primaryChip && /Primary/.test(primaryChip.textContent || ""),
      linkCta: !!document.getElementById("settings-link-lichess"),
      menuOpen,
      viewport: narrow.width,
    };
  });
  check(`[${vp.label}] connections rows compact with primary chip`, connFlow.rowCount === 2 && !!connFlow.primaryChip);
  check(`[${vp.label}] connections link CTA present`, !!connFlow.linkCta);
  check(`[${vp.label}] connections overflow menu opens`, !!connFlow.menuOpen);

  // --- Maia health: independent status + retry/reset --------------------------
  const maiaFlow = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 300));
    const model = document.getElementById("settings-maia-model")?.textContent || "";
    const retry = !!document.getElementById("settings-maia-retry");
    const reset = !!document.getElementById("settings-maia-reset");
    return { model, retry, reset };
  });
  check(
    `[${vp.label}] maia health shows a real runtime status`,
    /Ready|Available on demand|Loading|Cache missing|Unavailable|Error/.test(maiaFlow.model || ""),
    maiaFlow.model || "",
  );
  check(`[${vp.label}] maia retry + reset always available`, !!maiaFlow.retry && !!maiaFlow.reset);

  // --- Theme contrast: light + dark, interactive states --------------------
  // Semantic tokens carry every text state: replay result/preview/detail,
  // segmented selected/unselected/hover/disabled, shared switches. Measure
  // real contrast in both themes, including hover/selected/disabled.
  const contrastFlow = await page.evaluate(async () => {
    const lum = (s) => {
      const m = s.match(/[\d.]+/g).map(Number);
      const [r, g, b] = m.slice(0, 3).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const probe = (root, sel, bgEl) => {
      const el = root.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      let bg = cs.backgroundColor;
      if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") {
        bg = getComputedStyle(bgEl || root).backgroundColor;
      }
      return { color: cs.color, bg, c: contrast(bg, cs.color) };
    };
    const out = {};
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      await new Promise((r) => setTimeout(r, 60));
      const row = document.createElement("div");
      row.className = "replay-row";
      row.innerHTML =
        '<button class="replay-row-head"><span class="players">a vs b</span>' +
        '<span class="replay-result">1-0</span><span class="replay-preview">1. e4 e5</span>' +
        '<span class="replay-badge">prep</span></button>' +
        '<div class="replay-detail">detail <strong>strong</strong></div>';
      row.style.position = "absolute";
      row.style.left = "-9999px";
      row.style.top = "0";
      row.style.background = "var(--panel)";
      document.body.appendChild(row);
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.innerHTML =
        '<button class="seg-btn">A</button><button class="seg-btn is-active">B</button>' +
        '<button class="seg-btn" disabled>C</button>';
      seg.style.position = "absolute";
      seg.style.left = "-9999px";
      seg.style.top = "0";
      seg.style.background = "var(--panel)";
      document.body.appendChild(seg);
      const sw = document.createElement("button");
      sw.className = "pf-switch is-on";
      sw.innerHTML = '<span class="pf-knob"></span>';
      sw.style.position = "absolute";
      sw.style.left = "-9999px";
      sw.style.top = "0";
      document.body.appendChild(sw);
      const cs = (el, p) => getComputedStyle(el)[p];
      const head = row.querySelector(".replay-row-head");
      head.style.background = "var(--panel)";
      out[theme] = {
        result: probe(row, ".replay-result", head),
        preview: probe(row, ".replay-preview", head),
        detail: probe(row, ".replay-detail", row),
        strong: probe(row, ".replay-detail strong", row),
        seg: probe(seg, ".seg-btn:not(.is-active):not([disabled])", seg),
        segActive: probe(seg, ".seg-btn.is-active", seg),
        segDisabled: probe(seg, ".seg-btn[disabled]", seg),
        knobOnBg: cs(sw, "backgroundColor"),
        knobOnFg: cs(sw.querySelector(".pf-knob"), "backgroundColor"),
        knobContrast: contrast(cs(sw, "backgroundColor"), cs(sw.querySelector(".pf-knob"), "backgroundColor")),
      };
      row.remove();
      seg.remove();
      sw.remove();
    }
    document.documentElement.dataset.theme = "light";
    return out;
  });
  for (const theme of ["light", "dark"]) {
    const c = contrastFlow[theme];
    check(`[${vp.label}] ${theme} games result contrast >= 4.5`, (c.result?.c || 0) >= 4.5, `${(c.result?.c || 0).toFixed(2)}`);
    check(`[${vp.label}] ${theme} games preview contrast >= 4.5`, (c.preview?.c || 0) >= 4.5, `${(c.preview?.c || 0).toFixed(2)}`);
    check(`[${vp.label}] ${theme} games detail contrast >= 4.5`, (c.detail?.c || 0) >= 4.5, `${(c.detail?.c || 0).toFixed(2)}`);
    check(`[${vp.label}] ${theme} seg unselected contrast >= 4.5`, (c.seg?.c || 0) >= 4.5, `${(c.seg?.c || 0).toFixed(2)}`);
    check(`[${vp.label}] ${theme} seg selected contrast >= 4.5`, (c.segActive?.c || 0) >= 4.5, `${(c.segActive?.c || 0).toFixed(2)}`);
    check(`[${vp.label}] ${theme} seg disabled contrast >= 3`, (c.segDisabled?.c || 0) >= 3, `${(c.segDisabled?.c || 0).toFixed(2)}`);
    check(`[${vp.label}] ${theme} switch on knob contrast >= 3`, (c.knobContrast || 0) >= 3, `${(c.knobContrast || 0).toFixed(2)}`);
  }

  // --- Scroll ownership: content width stable, one scroll owner --------------
  const scrollFlow = await page.evaluate(async () => {
    const out = { views: {} };
    const widthOf = (el) => (el ? Math.round(el.getBoundingClientRect().width * 10) / 10 : null);
    for (const [nav, view] of [
      ["nav-dashboard", "view-dashboard"],
      ["nav-analyze", "view-analyze"],
      ["nav-build", "view-build"],
      ["nav-replay", "view-replay"],
      ["nav-teams", "view-teams"],
    ]) {
      document.querySelector(`[data-testid="${nav}"]`)?.click();
      await new Promise((r) => setTimeout(r, 150));
      const root = document.getElementById(view);
      out.views[view] = { w: widthOf(root), nested: 0 };
      if (root) {
        const walk = root.querySelectorAll("*");
        let nested = 0;
        walk.forEach((el) => {
          const cs = getComputedStyle(el);
          if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 2) {
            nested += 1;
          }
        });
        out.views[view].nested = nested;
      }
    }
    document.querySelector('[data-testid="nav-replay"]')?.click();
    await new Promise((r) => setTimeout(r, 150));
    out.replayW = widthOf(document.getElementById("view-replay"));
    return out;
  });
  check(`[${vp.label}] views render without width collapse`, Object.values(scrollFlow.views).every((v) => (v.w || 0) > 200), JSON.stringify(scrollFlow.views));
  check(`[${vp.label}] replay width stable across nav`, Math.abs((scrollFlow.replayW || 0) - (scrollFlow.views["view-replay"]?.w || 0)) < 2, `${scrollFlow.views["view-replay"]?.w} vs ${scrollFlow.replayW}`);

  // --- Games external fetch: usernames flow to compare ---------------------
  // Games resolves like Scout (linked + arbitrary Lichess users) and POSTs
  // the resolved usernames so externals actually fetch.
  const gamesExtFlow = await page.evaluate(async () => {
    const hook = window.__prepforgePolishE2e;
    await hook.setLichessAccounts([
      { id: "acc-a", username: "account_a", is_primary: true },
      { id: "acc-b", username: "account_b", is_primary: false },
    ]);
    try {
      localStorage.removeItem("prepforge.games_source");
      localStorage.removeItem("prepforge.games_external");
    } catch (_) {}
    document.querySelector('[data-testid="nav-replay"]').click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById("games-source-add").click();
    await new Promise((r) => setTimeout(r, 200));
    const pop = document.querySelector(".src-popover");
    const addInput = pop?.querySelector("[data-src-add]");
    if (addInput) {
      addInput.value = "Hikaru";
      addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    }
    pop?.querySelector("[data-src-done]")?.click();
    await new Promise((r) => setTimeout(r, 150));
    const tray = document.getElementById("games-source-chips")?.textContent || "";
    const bodies = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/csrf")) {
        return new Response(JSON.stringify({ csrf_token: "test-csrf" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/api/lichess/compare")) {
        bodies.push(opts?.body ? String(opts.body) : "");
        return new Response(
          JSON.stringify({ username: "self", count: 1, misses_recorded: 0, sources: ["account_a", "Hikaru"], games: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return realFetch(url, opts);
    };
    document.getElementById("lichess-compare-btn").click();
    await new Promise((r) => setTimeout(r, 1500));
    window.fetch = realFetch;
    return { tray, bodies };
  });
  check(`[${vp.label}] games tray shows Self + external`, /Self/.test(gamesExtFlow.tray || "") && /Hikaru/.test(gamesExtFlow.tray || ""), gamesExtFlow.tray || "");
  check(
    `[${vp.label}] games compare posts resolved usernames`,
    (gamesExtFlow.bodies || []).length >= 1 &&
      (gamesExtFlow.bodies || []).every((b) => b.includes("Hikaru") && b.includes("usernames")),
    JSON.stringify(gamesExtFlow.bodies || []),
  );

  // --- Dropdown theme: dark menu chrome -------------------------------------
  const theme = await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    const menu = document.getElementById("account-menu");
    menu.hidden = false;
    menu.innerHTML =
      '<div class="context-section">Signed in as tester</div><button type="button" data-action="settings">Settings</button><button type="button" data-action="signout">Sign out</button>';
    const cs = (el, p) => getComputedStyle(el)[p];
    const btn = menu.querySelector('[data-action="settings"]');
    const signout = menu.querySelector('[data-action="signout"]');
    const bg = cs(menu, "backgroundColor");
    const fg = cs(btn, "color");
    const so = cs(signout, "color");
    const lum = (s) => {
      const m = s.match(/[\d.]+/g).map(Number);
      const [r, g, b] = m.slice(0, 3).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    return { bg, fg, so, cMenu: contrast(bg, fg), cSign: contrast(bg, so) };
  });
  check(`[${vp.label}] dark menu contrast >= 4.5`, theme.cMenu >= 4.5, `${theme.cMenu.toFixed(2)} (bg ${theme.bg} fg ${theme.fg})`);
  check(`[${vp.label}] dark signout contrast >= 3`, theme.cSign >= 3, `${theme.cSign.toFixed(2)}`);
  await page.close();
}

console.log(results.join("\n"));
console.log(failures === 0 ? "ACCEPTANCE_OK" : `ACCEPTANCE_FAIL ${failures}`);
server.close();
await browser.close();
process.exit(failures === 0 ? 0 : 1);
