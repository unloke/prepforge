import "../../web-src/styles.css";
import "./review.css";
import { createBoardController } from "../../web-src/board/board-controller.js";
import { classBadgeSymbol } from "../../web-src/move-grades.js";
import { applyTheme } from "../../web-src/theme.js";
import { html } from "../../web-src/html.js";
import { files, PIECE_SETS, parseFenBoard, pieceLabel, renderAnnotations } from "virtual:board-kit";

const ISSUES = [
  { key: "factual_error", label: "Factual error", tip: "Contradicts the given facts (numbers, direction, side, phase)" },
  { key: "missed_key_point", label: "Missed key point", tip: "Leaves out the most important fact, e.g. a mate or the big drop" },
  { key: "hallucination", label: "Hallucination", tip: "Asserts a move, piece, threat or plan that is not in the facts" },
  { key: "unnatural", label: "Unnatural", tip: "Awkward, bloated, robotic or unclear coaching prose" },
];
const ISSUE_KEYS = { A: ["Digit1", "Digit2", "Digit3", "Digit4"], B: ["Digit7", "Digit8", "Digit9", "Digit0"] };
const VERDICT_KEYS = { KeyA: "A", KeyB: "B", KeyT: "tie", KeyX: "both_bad" };
// Spot-check sets carry one answer per position (no B): OK / Bad instead of A vs B.
const SINGLE_KEYS = { KeyG: "ok", KeyX: "bad" };

const $ = (id) => document.getElementById(id);
const state = { pairs: [], reviews: new Map(), index: 0, view: "after", locked: false, sha: "", experiment: "", single: false };
const slots = () => (state.single ? ["A"] : ["A", "B"]);
let animateNext = false;

applyTheme("system");

// PrepForge's board, view-only: no legal moves, no sounds.
const PREFS = { coordinates: true, lastMovePulse: false, flipAnim: false };
const pieceSvg = (piece) => {
  const color = piece === piece.toUpperCase() ? "piece-white" : "piece-black";
  return html`<svg class="piece ${color}" viewBox="0 0 45 45" aria-hidden="true"><g>${PIECE_SETS.berlin[piece.toLowerCase()]}</g></svg>`;
};
const BoardController = createBoardController({
  pref: (name) => (name === "moveAnim" ? animateNext : !!PREFS[name]),
  renderAnnotations, files, parseFenBoard, pieceLabel, pieceSvg,
  playSound: () => {},
  isPromotionMove: () => false,
  resolveBoardMove: () => {},
  legalMoveFor: () => null,
  legalTargetsFrom: () => [],
});
const board = new BoardController({ boardId: "abr-board", overlayId: "abr-annotations", onMove: () => {} });
board.applyCoordinates();

// ---- ledger ---------------------------------------------------------------

const backupKey = () => `coach-ab-review:${state.sha}`;
const pair = () => state.pairs[state.index];
const reviewOf = (p) => state.reviews.get(p.pair_id);
const isDone = (p) => !!reviewOf(p)?.verdict;
const doneCount = () => state.pairs.filter(isDone).length;

function ensureReview(p) {
  let r = state.reviews.get(p.pair_id);
  if (!r) {
    r = {
      pair_id: p.pair_id,
      verdict: null,
      issues: { A: [], B: [] },
      note: "",
      content_sha256: { A: p.A.content_sha256, B: p.B?.content_sha256 ?? null },
      updated_at: null,
    };
    state.reviews.set(p.pair_id, r);
  }
  return r;
}

function ledger() {
  return {
    schema: "coach-ab-human-review/1",
    experiment: state.experiment,
    blind_data_sha256: state.sha,
    pairs_total: state.pairs.length,
    completed: doneCount(),
    updated_at: new Date().toISOString(),
    reviews: state.pairs.filter((p) => state.reviews.has(p.pair_id)).map((p) => state.reviews.get(p.pair_id)),
  };
}

let saveTimer = null;
function setSave(text, error = false) {
  $("abr-save").textContent = text;
  $("abr-save").classList.toggle("is-error", error);
}
function scheduleSave() {
  const doc = ledger();
  try { localStorage.setItem(backupKey(), JSON.stringify(doc)); } catch (_) { /* server copy is primary */ }
  setSave("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(), 300);
}
async function flush({ keepalive = false } = {}) {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const res = await fetch("/api/review", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ledger()),
      keepalive,
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    setSave("Saved");
  } catch (e) {
    setSave(`Not saved to disk (${e.message}) — kept in this browser`, true);
  }
}
window.addEventListener("pagehide", () => flush({ keepalive: true }));

function touch(mutate) {
  if (state.locked) return;
  const r = ensureReview(pair());
  mutate(r);
  r.updated_at = new Date().toISOString();
  scheduleSave();
  render();
}

// ---- rendering ------------------------------------------------------------

function buildIssueChips() {
  document.querySelectorAll(".abr-answer").forEach((card) => {
    const slot = card.dataset.slot;
    card.querySelector(".abr-issues").innerHTML = ISSUES.map((issue, i) => {
      const key = ISSUE_KEYS[slot][i].replace("Digit", "");
      return html`<button type="button" class="abr-issue" data-issue="${issue.key}" aria-pressed="false" title="${issue.tip}"><kbd>${key}</kbd>${issue.label}</button>`;
    }).join("");
    card.querySelectorAll(".abr-issue").forEach((btn) =>
      btn.addEventListener("click", () => toggleIssue(slot, btn.dataset.issue)));
  });
}

function buildMap() {
  $("abr-map").innerHTML = state.pairs
    .map((p, i) => html`<li><button type="button" data-i="${i}" title="${p.pair_id}" aria-label="${p.pair_id}"></button></li>`)
    .join("");
  $("abr-map").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-i]");
    if (btn) go(Number(btn.dataset.i));
  });
}

function renderBoard() {
  const b = pair().board;
  const better = b.is_best ? null : b.best_uci;
  if (state.view === "before") {
    board.setPosition({ fen: b.fen_before, lastMove: null });
    board.setMoveBadge(null);
    board.setAnnotations([b.played_uci], []);
  } else {
    board.setPosition({ fen: b.fen_after, lastMove: b.played_uci });
    const glyph = classBadgeSymbol(b.grade);
    board.setMoveBadge(glyph ? b.played_uci.slice(2, 4) : null, b.grade, glyph);
    board.setAnnotations([], []);
  }
  board.setBetterArrow(better);
  animateNext = false;
  document.querySelectorAll("[data-view]").forEach((btn) => {
    const on = btn.dataset.view === state.view;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
}

function render() {
  const p = pair();
  const r = reviewOf(p);
  const b = p.board;
  const done = doneCount();
  const total = state.pairs.length;

  $("abr-count").textContent = `${done} / ${total}`;
  $("abr-fill").style.width = `${(100 * done) / total}%`;
  $("abr-export").disabled = done < total;
  $("abr-pair").textContent = `${p.pair_id} · ${state.index + 1} of ${total}`;
  const moveNo = `${b.move_number}${b.side === "black" ? "…" : "."}`;
  // The engine move is drawn on the board even when the model was not told it (best tier).
  const hidden = !b.is_best && !p.best_in_prompt;
  $("abr-move").innerHTML = html`${moveNo} <span class="san">${b.played_san}</span><span class="abr-grade g-${b.grade}">${b.grade}</span>${
    hidden ? html`<span class="abr-engine" title="Engine move, not in the model's facts">engine ${b.best_san}</span>` : ""}`;
  $("abr-facts").innerHTML = p.facts_text
    .map((line) => html`<li class="${/^(Played move|Better move|Grade|Move:|Played:|Best:|White |Black )/.test(line) ? "is-key" : ""}">${line}</li>`)
    .join("");

  for (const slot of slots()) {
    const card = document.querySelector(`.abr-answer[data-slot="${slot}"]`);
    card.querySelector(".abr-text").textContent = p[slot].response;
    card.querySelector(".abr-unfinished").hidden = p[slot].finished;
    const issues = r?.issues[slot] || [];
    card.querySelectorAll(".abr-issue").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(issues.includes(btn.dataset.issue)));
      btn.disabled = state.locked;
    });
    card.classList.toggle("is-preferred", r?.verdict === slot);
    card.classList.toggle("is-bad", r?.verdict === "both_bad" || r?.verdict === "bad");
  }
  document.querySelectorAll("[data-verdict]").forEach((btn) => {
    btn.setAttribute("aria-checked", String(r?.verdict === btn.dataset.verdict));
    btn.disabled = state.locked;
  });
  const note = $("abr-note");
  if (document.activeElement !== note) note.value = r?.note || "";
  note.disabled = state.locked;

  $("abr-prev").disabled = state.index === 0;
  $("abr-next").disabled = state.index === total - 1;
  $("abr-next-open").disabled = done === total;
  $("abr-map").querySelectorAll("button").forEach((btn, i) => {
    const rr = reviewOf(state.pairs[i]);
    const bad = rr?.verdict === "both_bad" || rr?.verdict === "bad";
    btn.classList.toggle("is-done", !!rr?.verdict && !bad);
    btn.classList.toggle("is-bad", bad);
    btn.classList.toggle("is-current", i === state.index);
  });
}

// ---- actions --------------------------------------------------------------

function go(i) {
  if (i < 0 || i >= state.pairs.length) return;
  const changed = i !== state.index;
  state.index = i;
  try { sessionStorage.setItem(`${backupKey()}:index`, String(i)); } catch (_) { /* optional */ }
  if (changed) board.setOrientation(pair().board.side);
  renderBoard();
  render();
}

function nextOpen() {
  const n = state.pairs.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.index + k) % n;
    if (!isDone(state.pairs[i])) return go(i);
  }
  showDone(true);
}

function setVerdict(v) {
  const wasComplete = doneCount() === state.pairs.length;
  touch((r) => { r.verdict = v; });
  if (!wasComplete && doneCount() === state.pairs.length) {
    flush();
    showDone(true);
  }
}

function toggleIssue(slot, key) {
  touch((r) => {
    const list = r.issues[slot];
    r.issues[slot] = list.includes(key) ? list.filter((k) => k !== key) : [...list, key].sort(
      (a, b) => ISSUES.findIndex((x) => x.key === a) - ISSUES.findIndex((x) => x.key === b));
  });
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  animateNext = true;
  renderBoard();
}

function exportJson() {
  if (doneCount() < state.pairs.length) return;
  const blob = new Blob([JSON.stringify(ledger(), null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `HUMAN-REVIEW-${state.experiment}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function showDone(on) {
  $("abr-main").hidden = on;
  $("abr-done").hidden = !on;
  if (!on) return;
  $("abr-done").innerHTML = state.locked
    ? html`<h2>Review frozen</h2><p>This ledger was frozen and unblinded; it is read-only.</p>
        <button class="btn primary" type="button" data-act="export">Export JSON</button>
        <button class="btn" type="button" data-act="back">View pairs</button>`
    : state.single
    ? html`<h2>All ${state.pairs.length} answers checked</h2><p>Saved to human-review/HUMAN-REVIEW.json.</p>`
    : html`<h2>All ${state.pairs.length} pairs reviewed</h2><p>Saved to human-review/HUMAN-REVIEW.json. Unblinding freezes it.</p>
        <code>node research/coach-ab-review/unblind.mjs</code>
        <button class="btn primary" type="button" data-act="export">Export JSON</button>
        <button class="btn" type="button" data-act="back">Keep reviewing</button>`;
  $("abr-done").querySelector('[data-act="export"]').addEventListener("click", exportJson);
  $("abr-done").querySelector('[data-act="back"]').addEventListener("click", () => showDone(false));
}

function bind() {
  document.querySelectorAll("[data-verdict]").forEach((btn) =>
    btn.addEventListener("click", () => setVerdict(btn.dataset.verdict)));
  document.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => setView(btn.dataset.view)));
  $("abr-flip").addEventListener("click", () => board.flip());
  $("abr-prev").addEventListener("click", () => go(state.index - 1));
  $("abr-next").addEventListener("click", () => go(state.index + 1));
  $("abr-next-open").addEventListener("click", nextOpen);
  $("abr-export").addEventListener("click", exportJson);
  $("abr-note").addEventListener("input", (e) => touch((r) => { r.note = e.target.value; }));
  const help = $("abr-help");
  $("abr-help-btn").addEventListener("click", () => {
    help.hidden = !help.hidden;
    $("abr-help-btn").setAttribute("aria-expanded", String(!help.hidden));
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("textarea, input")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (!$("abr-done").hidden) {
      if (e.key === "Escape") showDone(false);
      return;
    }
    if (e.key === "Escape" && !help.hidden) { help.hidden = true; return; }
    const slotIssue = slots().map((s) => [s, ISSUE_KEYS[s].indexOf(e.code)]).find(([, i]) => i >= 0);
    const verdictKeys = state.single ? SINGLE_KEYS : VERDICT_KEYS;
    let handled = true;
    if (verdictKeys[e.code]) setVerdict(verdictKeys[e.code]);
    else if (slotIssue) toggleIssue(slotIssue[0], ISSUES[slotIssue[1]].key);
    else if (e.key === "ArrowLeft" || e.code === "KeyK") go(state.index - 1);
    else if (e.key === "ArrowRight" || e.code === "KeyJ") go(state.index + 1);
    else if (e.key === "Enter") nextOpen();
    else if (e.code === "KeyV") setView(state.view === "after" ? "before" : "after");
    else if (e.code === "KeyF") board.flip();
    else if (e.code === "KeyN") $("abr-note").focus();
    else if (e.key === "?") $("abr-help-btn").click();
    else handled = false;
    if (handled) e.preventDefault();
  });
}

async function start() {
  const res = await fetch("/api/session");
  if (!res.ok) throw new Error(`Cannot load pairs (${res.status}). Is serve.mjs running?`);
  const session = await res.json();
  Object.assign(state, { pairs: session.pairs, sha: session.blind_data_sha256, locked: session.locked, experiment: session.experiment });
  $("abr-exp").textContent = session.experiment;
  state.single = state.pairs.every((p) => !p.B);
  document.body.classList.toggle("is-single", state.single);
  document.querySelector('.abr-answer[data-slot="B"]').hidden = state.single;
  document.querySelectorAll("[data-verdict]").forEach((btn) => {
    btn.hidden = state.single !== ["ok", "bad"].includes(btn.dataset.verdict);
  });
  if (state.single) {
    document.title = "Coach spot check";
    document.querySelector(".abr-title strong").textContent = "Coach spot check";
    document.querySelector('.abr-answer[data-slot="A"] .abr-slot').textContent = "✎";
    $("abr-help").querySelector("dl").innerHTML = html`<dt><kbd>G</kbd> <kbd>X</kbd></dt><dd>OK · Bad</dd>
      <dt><kbd>1</kbd>–<kbd>4</kbd></dt><dd>Issue</dd><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Previous · next</dd>
      <dt><kbd>Enter</kbd></dt><dd>Next unchecked</dd><dt><kbd>V</kbd></dt><dd>Before / after the move</dd>
      <dt><kbd>F</kbd></dt><dd>Flip board</dd><dt><kbd>N</kbd></dt><dd>Note · <kbd>Esc</kbd> leaves it</dd>`;
  }

  let doc = session.ledger;
  if (!doc) {
    try { doc = JSON.parse(localStorage.getItem(backupKey()) || "null"); } catch (_) { doc = null; }
  }
  if (doc && doc.blind_data_sha256 === state.sha) {
    for (const r of doc.reviews) state.reviews.set(r.pair_id, r);
    if (!session.ledger && !state.locked) { saveTimer = 0; flush(); }
  }
  setSave(state.locked ? "Frozen" : session.ledger ? "Saved" : "");

  buildIssueChips();
  buildMap();
  bind();
  $("abr-main").hidden = false;
  let i = Number.NaN;
  try { i = Number(sessionStorage.getItem(`${backupKey()}:index`)); } catch (_) { /* optional */ }
  if (!Number.isInteger(i) || i < 0 || i >= state.pairs.length) {
    i = Math.max(0, state.pairs.findIndex((p) => !isDone(p)));
  }
  state.index = i;
  board.setOrientation(pair().board.side);
  renderBoard();
  render();
  if (state.locked || doneCount() === state.pairs.length) showDone(true);
}

start().catch((e) => {
  $("abr-error").hidden = false;
  $("abr-error").textContent = e.message;
});
