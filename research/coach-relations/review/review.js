import "../../../web-src/styles.css";
import "../../coach-ab-review/review.css";
import "./review.css";
import { createBoardController } from "../../../web-src/board/board-controller.js";
import { classBadgeSymbol } from "../../../web-src/move-grades.js";
import { applyTheme } from "../../../web-src/theme.js";
import { localBoardAfterMove, localBoardInfo } from "../../../web-src/chess-local.js";
import { createStockfishWasmProvider } from "../../../web-src/engine/stockfish-provider.js";
import { formatEngineEval } from "../../../web-src/engine-eval.js";
import { html } from "../../../web-src/html.js";
import { files, PIECE_SETS, parseFenBoard, pieceLabel, renderAnnotations } from "virtual:board-kit";

const KINDS = [
  ["mate", "將殺／防殺"], ["material", "子力得失"], ["king_safety", "王的安全"], ["pawns", "兵形"],
  ["activity", "子力活動"], ["development", "出子"], ["space", "空間"], ["trade", "換子決策"],
  ["draw", "和棋資源"], ["endgame", "殘局技術"], ["other", "其他"], ["unclear", "看不出來"],
];
const WHERE = [["played", "實戰的問題"], ["best", "最佳的好處"], ["both", "兩者"]];
const RATES = [["key", "關鍵"], ["minor", "次要"], ["irrelevant", "存在但不重要"], ["wrong", "錯誤"]];
const LINE_NAME = { played: "實戰", best: "最佳", explore: "分析" };
const PIECE_NAME = { k: "王", q: "后", r: "車", b: "象", n: "馬", p: "兵" };

const $ = (id) => document.getElementById(id);
// `explore` is the reviewer's own line, branched from a node of the played or best line.
const state = { positions: [], labels: new Map(), index: 0, line: "played", ply: 0, focus: 0, sha: "", explore: null };
let animateNext = false;

applyTheme("system");
const PREFS = { coordinates: true, lastMovePulse: false, flipAnim: false };
const pieceSvg = (piece) => {
  const color = piece === piece.toUpperCase() ? "piece-white" : "piece-black";
  return html`<svg class="piece ${color}" viewBox="0 0 45 45" aria-hidden="true"><g>${PIECE_SETS.berlin[piece.toLowerCase()]}</g></svg>`;
};
const BoardController = createBoardController({
  pref: (name) => (name === "moveAnim" ? animateNext : !!PREFS[name]),
  renderAnnotations, files, parseFenBoard, pieceLabel, pieceSvg,
  playSound: () => {},
  isPromotionMove: () => false, // promotions are always to a queen here
  legalMoveFor: (from, to, moves) => moves.find((m) => m === from + to || m === `${from}${to}q`),
  resolveBoardMove: ({ from, to, moves, play }) => {
    const m = moves.find((u) => u === from + to || u === `${from}${to}q`);
    if (m) play(m);
  },
  legalTargetsFrom: (square, moves) => moves.filter((m) => m.startsWith(square)).map((m) => m.slice(2, 4)),
});
const board = new BoardController({ boardId: "rr-board", overlayId: "rr-annotations", onMove: (uci) => play([uci]), onAnnotate });
board.applyCoordinates();

// ---- labels ---------------------------------------------------------------

const pos = () => state.positions[state.index];
const labelOf = (p) => state.labels.get(p.pos_id);
const isDone = (p) => {
  const l = labelOf(p);
  return !!l?.submitted_at && p.candidates.every((_, i) => l.ratings[i]);
};
const doneCount = () => state.positions.filter(isDone).length;
const nodeKey = () => `${state.line}:${state.ply}`;

function ensureLabel(p) {
  let l = state.labels.get(p.pos_id);
  if (!l) {
    l = { pos_id: p.pos_id, kind: null, secondary: [], where: null, marks: {}, note: "", submitted_at: null, ratings: {}, updated_at: null };
    state.labels.set(p.pos_id, l);
  }
  return l;
}

const doc = () => ({
  schema: "reason-review/1", set_sha256: state.sha, completed: doneCount(), updated_at: new Date().toISOString(),
  reviews: state.positions.filter((p) => state.labels.has(p.pos_id)).map((p) => state.labels.get(p.pos_id)),
});

let saveTimer = null;
function scheduleSave() {
  try { localStorage.setItem(`reason-review:${state.sha}`, JSON.stringify(doc())); } catch (_) { /* server copy is primary */ }
  $("rr-save").textContent = "儲存中…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}
async function flush({ keepalive = false } = {}) {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const res = await fetch("/api/labels", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc()), keepalive });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    $("rr-save").textContent = "已儲存";
    $("rr-save").classList.remove("is-error");
  } catch (e) {
    $("rr-save").textContent = `未存到磁碟（${e.message}），已留在瀏覽器`;
    $("rr-save").classList.add("is-error");
  }
}
window.addEventListener("pagehide", () => flush({ keepalive: true }));

function touch(mutate) {
  const l = ensureLabel(pos());
  mutate(l);
  l.updated_at = new Date().toISOString();
  scheduleSave();
  render();
}

// The reviewer's own arrows and circles belong to the node they were drawn on.
// Marks on the reviewer's own line are scratch and are not saved.
function onAnnotate(arrows, circles) {
  if (state.line === "explore") {
    state.explore.marks[state.ply] = { arrows, circles };
    return;
  }
  if (labelOf(pos())?.submitted_at) return;
  touch((r) => {
    if (arrows.length || circles.length) r.marks[nodeKey()] = { arrows, circles };
    else delete r.marks[nodeKey()];
  });
}

// ---- board ----------------------------------------------------------------

const movesOf = (line) => (line === "explore" ? state.explore.moves : pos().lines[line]);
const linesShown = () => (state.explore ? ["played", "best", "explore"] : ["played", "best"]);

function fenAt(line, ply) {
  if (line === "explore") return ply === 0 ? fenAt(state.explore.from.line, state.explore.from.ply) : state.explore.moves[ply - 1].fen;
  return ply === 0 ? pos().fen : pos().lines[line][ply - 1].fen;
}

// Play moves from the current node: follow the line when it already has them, else branch.
function play(ucis) {
  let { line, ply } = state;
  for (const uci of ucis) {
    if (movesOf(line)[ply]?.uci === uci) { ply += 1; continue; }
    const { move } = localBoardAfterMove(fenAt(line, ply), uci);
    const step = { san: move.san, uci: move.uci, fen: move.fen_after };
    if (line === "explore") state.explore.moves.splice(ply, Infinity, step);
    else state.explore = { from: { line, ply }, moves: [step], marks: {} };
    for (const k of Object.keys(state.explore.marks)) if (Number(k) > ply) delete state.explore.marks[k];
    line = "explore";
    ply += 1;
  }
  setNode(line, ply);
}

// ---- engine ---------------------------------------------------------------

const engine = { on: true, provider: null, fen: null, timer: null };
const gameOver = (fen) => !localBoardInfo(fen).legal_moves.length;

function engineFollow() {
  const fen = fenAt(state.line, state.ply);
  if (!engine.on || engine.fen === fen) return renderEngine();
  engine.fen = fen;
  engine.provider ||= createStockfishWasmProvider({
    maxDepth: 40, maxMultipv: 3, createWorker: () => new Worker("/engine/stockfish-lite.js"),
  });
  if (gameOver(fen)) engine.provider.stopSearch();
  else engine.provider.update({ fen, multipv: 3 }).catch(showEngineError);
  clearInterval(engine.timer);
  engine.timer = setInterval(renderEngine, 250);
  renderEngine();
}

function showEngineError(e) {
  $("rr-engine-lines").innerHTML = html`<li class="rr-engine-error">${e.message}</li>`;
}

function toggleEngine() {
  engine.on = !engine.on;
  if (!engine.on) {
    engine.provider?.stopSearch();
    engine.fen = null;
    clearInterval(engine.timer);
  }
  engineFollow();
}

function renderEngine() {
  $("rr-engine-btn").setAttribute("aria-pressed", String(engine.on));
  const box = $("rr-engine-lines");
  const snap = engine.on && engine.provider?.snapshot();
  if (!snap || snap.fen !== engine.fen) {
    $("rr-engine-depth").textContent = "";
    box.innerHTML = engine.on && engine.fen && gameOver(engine.fen) ? html`<li class="rr-engine-error">對局結束</li>` : "";
    return;
  }
  if (snap.error) return showEngineError(new Error(snap.error));
  if (!snap.running) clearInterval(engine.timer);
  $("rr-engine-depth").textContent = snap.current_depth ? `深度 ${snap.current_depth}${snap.running ? "" : " ✓"}` : "";
  box.innerHTML = snap.pvs.filter((pv) => pv.pv_uci.length).map((pv, i) => html`<li data-pv="${i}">
    <span class="rr-engine-eval">${formatEngineEval(pv.score_cp, pv.mate_in)}</span>
    <span class="rr-engine-pv">${pv.pv_san.slice(0, 12).map((san, k) => html`<button type="button" data-k="${k}">${san}</button>`)}</span>
  </li>`).join("");
}

function pieceName(fen, square) {
  const rows = fen.split(" ")[0].split("/");
  const file = square.charCodeAt(0) - 97;
  let col = 0;
  for (const ch of rows[8 - Number(square[1])]) {
    if (/\d/.test(ch)) col += Number(ch);
    else if (col++ === file) return `${ch === ch.toUpperCase() ? "白" : "黑"}${PIECE_NAME[ch.toLowerCase()]} ${square}`;
  }
  return square;
}

function candText(c) {
  const fens = [fenAt(c.line, c.ply), fenAt(c.line, Math.max(0, c.ply - 1))];
  const name = (sq) => (sq ? fens.map((f) => pieceName(f, sq)).find((n) => n !== sq) || sq : "?");
  const [piece, other] = [name(c.at[0]), name(c.at[1])];
  const pieces = (list) => list.map((p) => (p[0] === "=" ? `升${PIECE_NAME[p[1]]}` : PIECE_NAME[p])).join("、");
  switch (c.type) {
    case "mate": return `${piece} 將殺`;
    case "forced_mate": return `這條變化之後${(c.n > 0) === (pos().side === "white") ? "白方" : "黑方"}有 ${Math.abs(c.n)} 步殺`;
    case "mate_threat": return `${piece} 之後威脅在 ${c.square} 將殺`;
    case "material": return `${c.at.length ? "這串交換" : "變化結束後續吃，"}${c.side === "white" ? "白方" : "黑方"}淨賺 ${c.net} 分：得 ${pieces(c.won)}${c.lost.length ? `，失 ${pieces(c.lost)}` : ""}`;
    case "fork": return `${piece} 同時攻擊 ${c.targets.map(name).join("、")}`;
    case "king_exposed": return `${piece} 周圍比另一條變化平均多 ${c.fewer} 格受攻擊`;
    case "shield": return `${other} 前的兵盾 ${piece} ${c.how === "taken" ? "被吃" : "前進"}`;
    case "open_file": return `${c.side === "white" ? "白方" : "黑方"}佔住開放的 ${c.file} 線（${piece}），對方沒有重子在線上`;
    case "trades": {
      // the pieces this line trades beyond the other line, as "white pieces 換 black pieces"
      const extra = [...c.gone];
      for (const p of c.other_gone) if (extra.includes(p)) extra.splice(extra.indexOf(p), 1);
      const side = (white) => extra.filter((p) => (p === p.toUpperCase()) === white).map((p) => PIECE_NAME[p.toLowerCase()]).join("");
      const [w, b] = [side(true), side(false)];
      const what = w && b ? `白${w}換黑${b}` : `${w ? "白" : "黑"}${w || b}離開棋盤`;
      // the material lead from the mover's side: trading down when behind, or simplifying when ahead
      const mover = pos().side === "white" ? "白方" : "黑方";
      const lead = pos().side === "white" ? c.lead : -c.lead;
      const why = !lead ? "" : c.line === "played" && lead < 0 ? `；${mover}落後 ${-lead} 分還換子`
        : c.line === "best" && lead > 0 ? `；${mover}領先 ${lead} 分，換子簡化` : `；${mover}${lead > 0 ? "領先" : "落後"} ${Math.abs(lead)} 分`;
      return `多換子：${what}${why}`;
    }
    case "outpost": case "piece_harassed": case "pawn_weakness": case "draw_risk": return c.text_zh;
    case "enter": return `${piece} 進入 ${c.square}`;
    default: return c.type;
  }
}

function renderBoard() {
  const p = pos();
  const l = labelOf(p);
  const step = state.ply ? movesOf(state.line)[state.ply - 1] : null;
  const fen = fenAt(state.line, state.ply);
  board.setPosition({ fen, legalMoves: localBoardInfo(fen).legal_moves, lastMove: step?.uci || null });
  board.setMoveBadge(null);
  board.setBetterArrow(state.line !== "explore" && state.ply === 0 ? p.lines.best[0].uci : null);
  if (state.line === "explore") {
    const m = state.explore.marks[state.ply];
    board.setAnnotations(m?.arrows || [], m?.circles || []);
  } else if (l?.submitted_at && p.candidates.length) {
    const c = p.candidates[state.focus];
    const here = c.line === state.line && c.ply === state.ply;
    board.setAnnotations([], here ? c.at.filter(Boolean) : []);
  } else {
    const m = l?.marks[nodeKey()];
    board.setAnnotations(m?.arrows || [], m?.circles || []);
  }
  animateNext = false;
  $("rr-lines").innerHTML = ["played", "best"].map((line) => html`<div class="rr-line">
    <span class="rr-line-name">${LINE_NAME[line]}</span>
    <button type="button" class="rr-ply ${state.line === line && state.ply === 0 ? "is-current" : ""}" data-line="${line}" data-ply="0">起始</button>
    ${p.lines[line].map((s, i) => html`<button type="button" class="rr-ply ${state.line === line && state.ply === i + 1 ? "is-current" : ""} ${l?.marks[`${line}:${i + 1}`] ? "has-marks" : ""}" data-line="${line}" data-ply="${i + 1}">${s.san}</button>`)}
  </div>`).join("") + (state.explore ? html`<div class="rr-line">
    <span class="rr-line-name">${LINE_NAME.explore}</span>
    <button type="button" class="rr-ply ${state.line === "explore" && state.ply === 0 ? "is-current" : ""}" data-line="explore" data-ply="0" title="分支點">${state.explore.from.ply ? `${LINE_NAME[state.explore.from.line]} ${p.lines[state.explore.from.line][state.explore.from.ply - 1].san}` : "起始"}</button>
    ${state.explore.moves.map((s, i) => html`<button type="button" class="rr-ply ${state.line === "explore" && state.ply === i + 1 ? "is-current" : ""}" data-line="explore" data-ply="${i + 1}">${s.san}</button>`)}
    <button type="button" class="rr-ply rr-drop" id="rr-drop" title="刪除分析線 (Backspace)" aria-label="刪除分析線">×</button>
  </div>` : "");
  engineFollow();
  const marks = Object.keys(l?.marks || {});
  $("rr-marks").textContent = marks.length
    ? `標記：${marks.map((k) => { const [ln, ply] = k.split(":"); return `${LINE_NAME[ln]} ${ply === "0" ? "起始" : p.lines[ln][ply - 1].san}`; }).join("、")}`
    : "";
}

function render() {
  const p = pos();
  const l = labelOf(p);
  const done = doneCount();
  const total = state.positions.length;
  const locked = !!l?.submitted_at;
  $("rr-count").textContent = `${done} / ${total}`;
  $("rr-fill").style.width = `${(100 * done) / total}%`;
  $("rr-pos").textContent = `${p.pos_id} · ${state.index + 1} / ${total}`;
  const glyph = classBadgeSymbol(p.grade);
  $("rr-move").innerHTML = html`${p.move_number}${p.side === "black" ? "…" : "."} <span class="san">${p.lines.played[0].san}</span><span class="abr-grade g-${p.grade}">${glyph || ""} ${p.grade}</span><span class="abr-engine">最佳 ${p.lines.best[0].san}</span>`;

  $("rr-mine").classList.toggle("is-locked", locked);
  for (const [box, on] of [["rr-kinds", (v) => v === l?.kind], ["rr-where", (v) => v === l?.where],
    ["rr-secondary", (v) => !!l?.secondary?.includes(v)]]) {
    $(box).querySelectorAll(".rr-chip").forEach((b) => {
      b.setAttribute("aria-checked", String(on(b.dataset.value)));
      b.disabled = locked || (box === "rr-secondary" && b.dataset.value === l?.kind);
    });
  }
  const note = $("rr-note");
  if (document.activeElement !== note) note.value = l?.note || "";
  $("rr-submit").disabled = locked || !l?.kind || (l.kind !== "unclear" && !l.where);
  $("rr-submit").hidden = locked;

  $("rr-cands").hidden = !locked;
  if (locked) {
    $("rr-cand-list").innerHTML = p.candidates.length
      ? p.candidates.map((c, i) => html`<li class="rr-cand ${i === state.focus ? "is-focus" : ""}" data-i="${i}">
      <div class="rr-cand-text"><span class="rr-cand-where">${LINE_NAME[c.line]} ${c.ply ? p.lines[c.line][c.ply - 1].san : ""}</span>${candText(c)}</div>
      <div class="rr-rate">${RATES.map(([k, label], n) => html`<button type="button" class="rr-chip" data-rate="${k}" aria-checked="${String(l.ratings[i] === k)}"><kbd>${n + 1}</kbd> ${label}</button>`)}</div>
    </li>`).join("")
      : html`<li class="rr-marks">沒有候選。</li>`;
  }

  $("rr-prev").disabled = state.index === 0;
  $("rr-next").disabled = state.index === total - 1;
  $("rr-map").querySelectorAll("button").forEach((b, i) => {
    b.classList.toggle("is-done", isDone(state.positions[i]));
    b.classList.toggle("is-current", i === state.index);
  });
  renderBoard();
}

// ---- actions --------------------------------------------------------------

function go(i) {
  if (i < 0 || i >= state.positions.length) return;
  state.index = i;
  state.line = "played";
  state.ply = 0;
  state.focus = 0;
  state.explore = null;
  try { sessionStorage.setItem(`reason-review:${state.sha}:index`, String(i)); } catch (_) { /* optional */ }
  board.setOrientation(pos().side);
  render();
}

function nextOpen() {
  const n = state.positions.length;
  for (let k = 1; k <= n; k++) {
    const i = (state.index + k) % n;
    if (!isDone(state.positions[i])) return go(i);
  }
  $("rr-main").hidden = true;
  $("rr-done").hidden = false;
  $("rr-done").innerHTML = html`<h2>${n} 個局面全部完成</h2><p>已存到 research/coach-relations/review/LABELS.json。</p>`;
}

function setNode(line, ply) {
  ply = Math.max(0, Math.min(movesOf(line).length, ply));
  animateNext = line === state.line && Math.abs(ply - state.ply) === 1;
  state.line = line;
  state.ply = ply;
  renderBoard();
}

function dropExplore() {
  if (!state.explore) return;
  const { from } = state.explore;
  const inside = state.line === "explore";
  state.explore = null;
  if (inside) setNode(from.line, from.ply);
  else renderBoard();
}

function switchLine(dir) {
  const lines = linesShown();
  const line = lines[(lines.indexOf(state.line) + dir + lines.length) % lines.length];
  if (line === "explore") setNode(line, state.explore.moves.length);
  else if (state.line === "explore" && state.explore.from.line === line) setNode(line, state.explore.from.ply);
  else setNode(line, state.ply);
}

function focusCand(i) {
  const c = pos().candidates[i];
  if (!c) return;
  state.focus = i;
  state.line = c.line;
  state.ply = c.ply;
  render();
  document.querySelector(`.rr-cand[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
}

function rate(i, value) {
  touch((l) => { l.ratings[i] = value; });
  const p = pos();
  const next = p.candidates.findIndex((_, j) => j > i && !labelOf(p).ratings[j]);
  if (next >= 0) focusCand(next);
}

// The reviewer rates most candidates "present but unimportant"; one key fills in the rest.
function rateRest() {
  const p = pos();
  if (!labelOf(p)?.submitted_at) return;
  touch((l) => { p.candidates.forEach((_, i) => { l.ratings[i] ||= "irrelevant"; }); });
}

function submit() {
  const l = labelOf(pos());
  if (!l?.kind || l.submitted_at || (l.kind !== "unclear" && !l.where)) return;
  touch((r) => { r.submitted_at = new Date().toISOString(); });
  if (pos().candidates.length) focusCand(0);
}

function bind() {
  const chips = (box, list, field) => {
    const multi = field === "secondary";
    $(box).innerHTML = list.map(([k, label]) => html`<button type="button" role="${multi ? "checkbox" : "radio"}" class="rr-chip" data-value="${k}">${label}</button>`).join("");
    $(box).addEventListener("click", (e) => {
      const b = e.target.closest(".rr-chip");
      if (!b || b.disabled) return;
      const v = b.dataset.value;
      touch((l) => {
        if (!multi) {
          l[field] = v;
          l.secondary = (l.secondary || []).filter((s) => s !== l.kind);
        } else {
          const set = new Set(l.secondary || []);
          set.has(v) ? set.delete(v) : set.add(v);
          l.secondary = [...set];
        }
      });
    });
  };
  chips("rr-where", WHERE, "where");
  chips("rr-kinds", KINDS, "kind");
  chips("rr-secondary", KINDS.filter(([k]) => k !== "unclear"), "secondary");
  $("rr-map").innerHTML = state.positions.map((p, i) => html`<li><button type="button" data-i="${i}" title="${p.pos_id}" aria-label="${p.pos_id}"></button></li>`).join("");
  $("rr-map").addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) go(Number(b.dataset.i)); });
  $("rr-lines").addEventListener("click", (e) => {
    const b = e.target.closest(".rr-ply");
    if (b?.id === "rr-drop") dropExplore();
    else if (b) setNode(b.dataset.line, Number(b.dataset.ply));
  });
  $("rr-engine-btn").addEventListener("click", toggleEngine);
  $("rr-engine-lines").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]");
    const pv = engine.provider?.snapshot().pvs[Number(e.target.closest("li[data-pv]")?.dataset.pv)];
    if (pv) play(pv.pv_uci.slice(0, b ? Number(b.dataset.k) + 1 : 1));
  });
  $("rr-cand-list").addEventListener("click", (e) => {
    const li = e.target.closest(".rr-cand");
    if (!li) return;
    const b = e.target.closest(".rr-chip");
    if (b) rate(Number(li.dataset.i), b.dataset.rate);
    else focusCand(Number(li.dataset.i));
  });
  $("rr-submit").addEventListener("click", submit);
  $("rr-rest").addEventListener("click", rateRest);
  $("rr-note").addEventListener("input", (e) => touch((l) => { l.note = e.target.value; }));
  $("rr-flip").addEventListener("click", () => board.flip());
  $("rr-prev").addEventListener("click", () => go(state.index - 1));
  $("rr-next").addEventListener("click", () => go(state.index + 1));
  $("rr-next-open").addEventListener("click", nextOpen);
  const help = $("rr-help");
  $("rr-help-btn").addEventListener("click", () => {
    help.hidden = !help.hidden;
    $("rr-help-btn").setAttribute("aria-expanded", String(!help.hidden));
  });

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.("textarea, input")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    const l = labelOf(pos());
    const digit = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(e.code);
    let handled = true;
    if (e.key === "ArrowLeft") setNode(state.line, state.ply - 1);
    else if (e.key === "ArrowRight") setNode(state.line, state.ply + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") switchLine(e.key === "ArrowUp" ? -1 : 1);
    else if (e.key === "Home") setNode(state.line, 0);
    else if (e.key === "End") setNode(state.line, movesOf(state.line).length);
    else if (e.key === "Backspace") dropExplore();
    else if (e.code === "KeyL") toggleEngine();
    else if (digit >= 0 && l?.submitted_at && pos().candidates.length) rate(state.focus, RATES[digit][0]);
    else if (e.code === "Digit0") rateRest();
    else if (e.key === "Enter") (l?.submitted_at ? nextOpen() : submit());
    else if (e.code === "KeyF") board.flip();
    else if (e.code === "KeyN") $("rr-note").focus();
    else if (e.key === "Escape" && !help.hidden) help.hidden = true;
    else handled = false;
    if (handled) e.preventDefault();
  });
}

async function start() {
  const res = await fetch("/api/session");
  if (!res.ok) throw new Error(`讀不到題目（${res.status}），serve.mjs 有在跑嗎？`);
  const session = await res.json();
  state.positions = session.positions;
  state.sha = session.set_sha256;
  // Keep the newer copy of each review: the browser copy is ahead when a save to disk failed.
  let local = null;
  try { local = JSON.parse(localStorage.getItem(`reason-review:${state.sha}`) || "null"); } catch (_) { /* none */ }
  let ahead = false;
  for (const saved of [session.labels, local]) {
    if (saved?.set_sha256 !== state.sha) continue;
    for (const r of saved.reviews) {
      const have = state.labels.get(r.pos_id);
      if (have && (have.updated_at || "") >= (r.updated_at || "")) continue;
      ahead ||= !!have || saved === local;
      state.labels.set(r.pos_id, r);
    }
  }
  $("rr-save").textContent = session.labels ? "已儲存" : "";
  if (ahead) scheduleSave();
  bind();
  $("rr-main").hidden = false;
  let i = Number.NaN;
  try { i = Number(sessionStorage.getItem(`reason-review:${state.sha}:index`)); } catch (_) { /* optional */ }
  if (!Number.isInteger(i) || i < 0 || i >= state.positions.length) i = Math.max(0, state.positions.findIndex((p) => !isDone(p)));
  go(i);
}

start().catch((e) => {
  $("rr-error").hidden = false;
  $("rr-error").textContent = e.message;
});
