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

  // --- Build Inspector: long coverage + explorer content --------------------
  const insp = await page.evaluate(
    ({ hint }) => {
      document.querySelector('[data-testid="nav-build"]').click();
      document.getElementById("build-tool-coverage").click();
      document.querySelector(".coverage-hint").textContent = hint;
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
      };
    },
    { hint: LONG_HINT },
  );
  check(`[${vp.label}] coverage content inside inspector`, insp.coverageBad.length === 0, insp.coverageBad.join(" | "));
  check(`[${vp.label}] explorer content inside inspector`, insp.explorerBad.length === 0, insp.explorerBad.join(" | "));
  check(`[${vp.label}] inspector panel owns scroll`, insp.panelScroll === "auto" || insp.panelScroll === "scroll");
  // No nested competing scroll regions: the inner content containers must not
  // themselves scroll (checked structurally in ui-layout tests; the panel is
  // the single scroll owner).

  // --- Account chooser: two accounts → chooser, primary default -------------
  // Drive the REAL flow: seed two linked identities via the polish hook, stub
  // /api/lichess/latest, click My last game, assert the chooser appears with
  // Primary highlighted, choose B, assert the request carries account_id=B,
  // the chooser closes, and primary is still A afterwards.
  const chooserFlow = await page.evaluate(async () => {
    const seen = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/lichess/latest")) {
        seen.push(u);
        return new Response(JSON.stringify({ has_game: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
    await new Promise((r) => setTimeout(r, 300));
    const overlay = document.querySelector(".modal-overlay .account-chooser");
    const opened = !!overlay;
    const choices = overlay
      ? Array.from(overlay.querySelectorAll("[data-account-id]")).map((b) => ({
          id: b.dataset.accountId,
          text: b.textContent.trim(),
          primary: b.classList.contains("is-primary"),
          focused: document.activeElement === b,
        }))
      : [];
    const primaryChoice = choices.find((c) => c.id === "acc-a");
    // Choose B.
    overlay?.querySelector('[data-account-id="acc-b"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const closed = !document.querySelector(".modal-overlay .account-chooser");
    const accounts = hook.getLichessAccounts();
    const primaryStillA = (accounts.find((a) => a.is_primary) || {}).id === "acc-a";
    window.fetch = realFetch;
    return {
      opened,
      choices,
      primaryHighlighted: !!primaryChoice?.primary,
      primaryFocused: !!primaryChoice?.focused,
      primaryLabel: primaryChoice?.text || "",
      latestCalls: seen,
      closed,
      primaryStillA,
    };
  });
  check(`[${vp.label}] chooser opens for two accounts`, !!chooserFlow.opened);
  check(
    `[${vp.label}] chooser lists both with primary marked`,
    chooserFlow.choices?.length === 2 && chooserFlow.primaryHighlighted && /Primary/.test(chooserFlow.primaryLabel || ""),
    JSON.stringify(chooserFlow.choices),
  );
  check(`[${vp.label}] chooser defaults focus to primary`, !!chooserFlow.primaryFocused);
  check(
    `[${vp.label}] choosing B sends account_id=B`,
    (chooserFlow.latestCalls || []).some((u) => u.includes("account_id=acc-b")),
    (chooserFlow.latestCalls || []).join(","),
  );
  check(`[${vp.label}] chooser closes after selection`, !!chooserFlow.closed);
  check(`[${vp.label}] primary still A afterwards`, !!chooserFlow.primaryStillA);

  // --- Compare flow: choosing B sends account_id in compare body -------------
  const compareFlow = await page.evaluate(async () => {
    const hook = window.__prepforgePolishE2e;
    hook.setLichessAccounts([
      { id: "acc-a", username: "account_a", is_primary: true },
      { id: "acc-b", username: "account_b", is_primary: false },
    ]);
    document.querySelector('[data-testid="nav-replay"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const btn = document.getElementById("lichess-compare-btn");
    const enabled = !btn.disabled;
    // Install the fetch observer AFTER seeding/enabling but BEFORE the click,
    // so the compare POST is captured (the chooser resolves async after click).
    // NOTE: postJson() awaits getCsrfToken() → GET /api/csrf first; the stub
    // below answers /api/csrf + /api/lichess/compare and passes the rest
    // through, so the full handler chain runs deterministically.
    const bodies = [];
    const seen = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const u = String(url);
      seen.push(`${opts?.method || "GET"} ${u}`);
      if (u.includes("/api/csrf")) {
        return new Response(JSON.stringify({ csrf_token: "test-csrf" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/api/lichess/compare")) {
        bodies.push(opts?.body ? String(opts.body) : "");
        return new Response(
          JSON.stringify({ username: "account_b", count: 0, misses_recorded: 0, games: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return realFetch(url, opts);
    };
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    const overlay = document.querySelector(".modal-overlay .account-chooser");
    const opened = !!overlay;
    overlay?.querySelector('[data-account-id="acc-b"]')?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const closed = !document.querySelector(".modal-overlay .account-chooser");
    window.fetch = realFetch;
    return { opened, bodies, seen, closed, enabled };
  });
  check(`[${vp.label}] compare opens chooser for two accounts`, !!compareFlow.opened);
  check(
    `[${vp.label}] compare sends account_id=B`,
    (compareFlow.bodies || []).some((b) => b.includes("acc-b")),
    `bodies=${JSON.stringify(compareFlow.bodies)} seen=${JSON.stringify((compareFlow.seen || []).filter((u) => u.includes("lichess")).slice(0, 6))}`,
  );
  check(`[${vp.label}] compare chooser closes after selection`, !!compareFlow.closed);

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
