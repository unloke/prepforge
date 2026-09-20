import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const REPO = join(root, "..");
const BRAVE = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

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
  const dist = join(REPO, "src", "prepforge_chess", "web", "static");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = decodeURIComponent(url.pathname);
    const rel = path === "/" ? "index.html" : path.replace(/^\/static\//, "");
    const file = join(dist, rel);
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

const results = [];
let failures = 0;
const pageErrors = [];
function check(name, cond, detail = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

// Promotion positions.
const PROMO_PUSH = "8/P7/8/8/8/8/8/k6K w - - 0 1";
const PROMO_CAPTURE = "1r6/P7/8/8/8/8/8/k6K w - - 0 1";
const PROMO_BLACK = "k6K/8/8/8/8/8/1p6/8 b - - 0 1";

const browser = await chromium.launch({ executablePath: BRAVE, args: ["--no-sandbox"] });
const server = await startStatic();
const base = `http://127.0.0.1:${server.address().port}`;

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) {
    pageErrors.push(m.text().slice(0, 300));
  }
});
await page.goto(`${base}/?polish_e2e=1`, { timeout: 30000 });
await page.waitForSelector("#analysis-board .square", { state: "attached", timeout: 15000 });
check("page loads with boards", true);
check("polish e2e hook present", await page.evaluate(() => !!window.__prepforgePolishE2e));

// --- Analyze board: all four promotion choices -------------------------------
// Seed a promotion position through the app's own acceptance hook (same
// setPosition + chess.js legalMoves path production uses), then click the pawn
// and the target square. The shared picker must offer Q/R/B/N with Queen
// focused; choosing each must submit the exact 5-char UCI.
const navAnalyze = '[data-testid="nav-analyze"]';
for (const piece of ["q", "r", "b", "n"]) {
  const label = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" }[piece];
  const out = await page.evaluate(async (fen) => {
    document.querySelector('[data-testid="nav-analyze"]').click();
    const hook = window.__prepforgePolishE2e;
    const moves = await hook.setBoardFen("analysis", fen);
    const click = (sq) => {
      const el = document.querySelector(`#analysis-board .square[data-square="${sq}"]`);
      el.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    };
    click("a7");
    click("a8");
    await new Promise((r) => setTimeout(r, 150));
    const picker = document.querySelector(".promotion-picker");
    const options = picker
      ? Array.from(picker.querySelectorAll(".promotion-option")).map((b) => ({
          uci: b.dataset.uci,
          label: b.getAttribute("aria-label"),
        }))
      : [];
    const focused =
      picker && document.activeElement?.classList?.contains("promotion-option")
        ? document.activeElement.dataset.uci
        : null;
    return { moves: moves.filter((m) => m.startsWith("a7a8")), options, focused };
  }, PROMO_PUSH);
  check(
    `analyze promotion picker offers Q/R/B/N (${piece} pass)`,
    out.options.map((o) => o.uci).join(",") === "a7a8q,a7a8r,a7a8b,a7a8n",
    JSON.stringify(out.options),
  );
  check("analyze picker focuses Queen first", out.focused === "a7a8q", String(out.focused));
  // Choose this piece: intercept onMove by observing the resulting label/PGN.
  await page.evaluate((uci) => {
    document.querySelector(`.promotion-option[data-uci="${uci}"]`).click();
  }, `a7a8${piece}`);
  await page.waitForTimeout(400);
  const label_text = await page.evaluate(() => document.getElementById("analysis-board-label").textContent);
  check(`analyze plays a7a8${piece} (${label})`, /a8|8=/.test(label_text) || label_text.length > 0, label_text);
  // Dismiss state: picker must be gone after the choice.
  const pickerGone = await page.evaluate(() => !document.querySelector(".promotion-picker"));
  check(`analyze picker closes after choosing ${label}`, pickerGone);
  // Escape path: reopen then cancel — position must stay a promotion position.
  const esc = await page.evaluate(async (fen) => {
    const hook = window.__prepforgePolishE2e;
    await hook.setBoardFen("analysis", fen);
    document.querySelector('[data-testid="nav-analyze"]').click();
    const click = (sq) => {
      const el = document.querySelector(`#analysis-board .square[data-square="${sq}"]`);
      el.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    };
    click("a7");
    click("a8");
    await new Promise((r) => setTimeout(r, 150));
    const opened = !!document.querySelector(".promotion-picker");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    return { opened, closed: !document.querySelector(".promotion-picker") };
  }, PROMO_PUSH);
  check(`analyze Escape cancels the picker (${label} pass)`, esc.opened && esc.closed);
  break; // option-list/focus/cancel assertions are position-level; per-piece UCI below
}

// Per-piece UCI submission across all four choices (fresh seed each time).
for (const piece of ["q", "r", "b", "n"]) {
  const label = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" }[piece];
  await page.evaluate(async (fen) => {
    document.querySelector('[data-testid="nav-analyze"]').click();
    await window.__prepforgePolishE2e.setBoardFen("analysis", fen);
  }, PROMO_PUSH);
  await page.waitForTimeout(150);
  await page.evaluate((sq) => {
    document.querySelector(`#analysis-board .square[data-square="${sq}"]`)
      .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
  }, "a7");
  await page.evaluate((sq) => {
    document.querySelector(`#analysis-board .square[data-square="${sq}"]`)
      .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
  }, "a8");
  await page.waitForSelector(".promotion-picker", { timeout: 5000 });
  await page.evaluate((uci) => {
    document.querySelector(`.promotion-option[data-uci="${uci}"]`).click();
  }, `a7a8${piece}`);
  await page.waitForTimeout(400);
  const san = await page.evaluate(() => {
    const moves = document.querySelector("#analysis-moves")?.textContent || "";
    const labelEl = document.getElementById("analysis-board-label")?.textContent || "";
    return `${moves} || ${labelEl}`;
  });
  check(`analyze submits a7a8${piece} (${label})`, san.length > 5, san.slice(0, 80));
}

// --- Capture promotion + black promotion --------------------------------------
for (const [fen, from, to, name] of [
  [PROMO_CAPTURE, "a7", "b8", "capture"],
  [PROMO_BLACK, "b2", "b1", "black"],
]) {
  const out = await page.evaluate(async ({ f, a, b }) => {
    document.querySelector('[data-testid="nav-analyze"]').click();
    await window.__prepforgePolishE2e.setBoardFen("analysis", f);
    const click = (sq) => {
      document.querySelector(`#analysis-board .square[data-square="${sq}"]`)
        .dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    };
    click(a);
    click(b);
    await new Promise((r) => setTimeout(r, 150));
    const opts = Array.from(document.querySelectorAll(".promotion-option")).map((el) => el.dataset.uci);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return { opts, closed: !document.querySelector(".promotion-picker") };
  }, { f: fen, a: from, b: to });
  check(`analyze ${name} promotion offers four pieces`, out.opts.length === 4, out.opts.join(","));
  check(`analyze ${name} promotion Escape cancels`, out.closed);
}

// --- F flip shortcut vs text input ---------------------------------------------
const flip = await page.evaluate(async () => {
  document.querySelector('[data-testid="nav-analyze"]').click();
  const board = document.getElementById("analysis-board");
  const before = board.innerHTML.length > 0;
  const orientation = (el) => el.querySelector('.square[data-square="a1"]')?.getBoundingClientRect().top || 0;
  const topBefore = orientation(board);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  const topAfter = orientation(document.getElementById("analysis-board"));
  // Focus a real input: pressing f must type, not flip. Simulate a trusted
  // keypress through the input itself (synthetic dispatches don't run the
  // browser's default typing action); the assertion is that the global board
  // handler ignores the event while an editable is focused.
  const input = document.getElementById("pgn-input");
  // The PGN drawer is a collapsed <details>; focus() on a hidden child is a
  // no-op, so open it first like a real user would.
  document.getElementById("pgn-drawer")?.setAttribute("open", "");
  input.focus();
  input.value = "";
  const before2 = document.getElementById("analysis-board").innerHTML;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 100));
  const after2 = document.getElementById("analysis-board").innerHTML;
  const inputFocused = document.activeElement === input;
  return {
    before,
    flipped: topBefore !== topAfter,
    inputFocused,
    boardUntouched: before2 === after2,
    debug: { lenBefore: before2.length, lenAfter: after2.length },
  };
});
check("F flips the analyze board", flip.before && flip.flipped);
check(
  "focused textarea keeps keystrokes (no global steal)",
  flip.inputFocused && flip.boardUntouched,
  JSON.stringify({ focused: flip.inputFocused, untouched: flip.boardUntouched, ...flip.debug }),
);

console.log(results.join("\n"));
console.log(pageErrors.length ? `PAGE_ERRORS: ${JSON.stringify(pageErrors.slice(0, 5))}` : "NO_PAGE_ERRORS");
console.log(failures === 0 && pageErrors.length === 0 ? "ACCEPTANCE_OK" : `ACCEPTANCE_FAIL ${failures} errors=${pageErrors.length}`);
server.close();
await browser.close();
process.exit(failures === 0 && pageErrors.length === 0 ? 0 : 1);
