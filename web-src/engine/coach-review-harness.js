// Coach review harness — a DEV/CI-only tool (never shipped in the deploy build) for
// rating the coach's prose at scale. It pulls your recent Lichess games (or a pasted PGN),
// replays every move through the SAME pipeline the live Analyze coach uses — browser
// Stockfish (MultiPV) for the eval, Maia for intuition + the brilliant check, then
// buildMoveFeatures → buildCommentary — and shows "position + the coach's real output"
// one move at a time with ✓/✗ buttons and a notes field. Ratings export to
// coach-review-ratings.json (or POST to a save endpoint when one is available).
//
// This is the rebuilt successor to the earlier throwaway harness: same purpose, but the
// orchestration is a thin mirror of app.js's PositionCoach._run so what you rate here is
// exactly what users see.
import { Chess } from "chess.js";
import { createEngineProvider, isBrowserEngineAvailable } from "./stockfish-provider.js";
import { getSharedMaia3Provider } from "./maia3-provider.js";
import {
  buildMoveFeatures,
  buildCommentary,
  attachIntuition,
  isBrilliantByMaia,
  markBrilliant,
  moverWinChanceAfter,
  BRILLIANT_MAX_HUMAN_PROB,
  BRILLIANT_MIN_WIN_GAP,
} from "../coach/bundle.js";

const PIECE_GLYPH = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// PGN → per-move records (fenBefore, fenAfter, uci, san, ply, mover, players).
// ---------------------------------------------------------------------------
export function splitPgnGames(text) {
  // Games in a multi-game PGN are separated by a blank line before the next [Event ...].
  const trimmed = (text || "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\n\s*\n(?=\[Event )/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function gameToMoves(pgn) {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { sloppy: true });
  } catch (_) {
    return null;
  }
  const headers = chess.header() || {};
  const verbose = chess.history({ verbose: true });
  const replay = new Chess();
  const moves = [];
  let ply = 0;
  for (const m of verbose) {
    const fenBefore = replay.fen();
    const applied = replay.move(m.san);
    if (!applied) break;
    const fenAfter = replay.fen();
    ply += 1;
    moves.push({
      ply,
      san: applied.san,
      uci: applied.from + applied.to + (applied.promotion || ""),
      fenBefore,
      fenAfter,
      mover: applied.color === "w" ? "white" : "black",
    });
  }
  return { headers, moves };
}

// ---------------------------------------------------------------------------
// Lichess game fetch (public games, no token needed). PGN over CORS.
// ---------------------------------------------------------------------------
async function fetchLichessPgn(username, max) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${max}&clocks=false&evals=false&opening=false`;
  const res = await fetch(url, { headers: { Accept: "application/x-chess-pgn" } });
  if (!res.ok) throw new Error(`Lichess returned ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Stockfish eval — a MultiPV read returning the line[] shape buildMoveFeatures wants,
// mirroring app.js PositionCoach._eval.
// ---------------------------------------------------------------------------
function isGameOver(fen) {
  try {
    return new Chess(fen).isGameOver();
  } catch (_) {
    return false;
  }
}

async function evalPosition(provider, fen, depth, multipv) {
  if (!fen || isGameOver(fen)) return null;
  await provider.open({ fen, multipv });
  const deadline = Date.now() + 4000;
  let snap = provider.snapshot();
  while (Date.now() < deadline) {
    await sleep(120);
    snap = provider.snapshot();
    if (snap.error) throw new Error(snap.error);
    const ready = snap && snap.pvs && snap.pvs.length && snap.pvs[0].pv_uci && snap.pvs[0].pv_uci.length;
    if (ready && (snap.running === false || snap.current_depth >= depth)) break;
  }
  const lines = (snap.pvs || [])
    .filter((pv) => pv.pv_uci && pv.pv_uci.length)
    .map((pv) => ({
      uci: pv.pv_uci[0],
      san: (pv.pv_san && pv.pv_san[0]) || pv.pv_uci[0],
      cp: pv.score_cp ?? null,
      mate: pv.mate_in ?? null,
      pvUci: pv.pv_uci.slice(),
      pvSan: (pv.pv_san || []).slice(),
    }));
  return lines.length ? { lines } : null;
}

// ---------------------------------------------------------------------------
// The full coach read for ONE move — the exact pipeline of app.js _run, in order:
// before/after eval → features → commentary → (Maia) intuition + brilliant.
// ---------------------------------------------------------------------------
async function coachOneMove(engine, rec, opts) {
  const before = await evalPosition(engine, rec.fenBefore, opts.depth, 2);
  if (!before || !before.lines.length) return null;

  // The "after" read (or a synthesized terminal eval for a mating/stalemating move).
  let top;
  const afterOver = (() => {
    try {
      return new Chess(rec.fenAfter);
    } catch (_) {
      return null;
    }
  })();
  if (afterOver && afterOver.isCheckmate()) {
    top = { cp: null, mate: rec.mover === "white" ? 1 : -1, pvUci: [], pvSan: [] };
  } else if (afterOver && (afterOver.isStalemate() || afterOver.isInsufficientMaterial())) {
    top = { cp: 0, mate: null, pvUci: [], pvSan: [] };
  } else {
    const after = await evalPosition(engine, rec.fenAfter, opts.depth, 1);
    top = (after && after.lines[0]) || {};
  }

  const features = buildMoveFeatures({
    ply: rec.ply,
    moveNumber: Number(rec.fenBefore.split(" ")[5]) || null,
    mover: rec.mover,
    uci: rec.uci,
    san: rec.san,
    fenBefore: rec.fenBefore,
    fenAfter: rec.fenAfter,
    beforeEval: { lines: before.lines },
    afterEval: { cp: top.cp ?? null, mate: top.mate ?? null, pvUci: top.pvUci || [], pvSan: top.pvSan || [] },
  });

  if (opts.useMaia) {
    await enrichWithMaia(engine, features, rec, opts.rating);
  }
  return features;
}

// Maia layers, best-effort (mirrors _checkIntuition + _checkBrilliant + _trapGap).
async function enrichWithMaia(engine, features, rec, rating) {
  const provider = getSharedMaia3Provider();
  // Intuition (texture/sharpness).
  try {
    const read = await provider.positionRead({ fen: rec.fenBefore, rating });
    if (read) attachIntuition(features, read);
  } catch (_) {
    /* Maia unavailable → no texture note */
  }
  // Brilliant — only for an eligible candidate, cheapest layers first.
  if (!features.brilliantCandidate) return;
  try {
    const a = await provider.moveAssessment({ fen: rec.fenBefore, moveUci: rec.uci, rating });
    if (!a) return;
    if (!(a.humanProbability <= BRILLIANT_MAX_HUMAN_PROB)) return;
    if (features.winAfterMover - a.winChanceAfter * 100 < BRILLIANT_MIN_WIN_GAP) return;
    const trapGap = await computeTrapGap(engine, provider, features, rec, rating);
    if (isBrilliantByMaia(features, { maiaHumanProb: a.humanProbability, maiaWinAfter: a.winChanceAfter, trapGap })) {
      markBrilliant(features, { humanProb: a.humanProbability, winChanceAfter: a.winChanceAfter });
    }
  } catch (_) {
    /* Maia unavailable → engine read stands */
  }
}

async function computeTrapGap(engine, provider, features, rec, rating) {
  try {
    const preds = await provider.predictions({ fen: rec.fenBefore, rating });
    const naturalUci = preds && preds.length ? preds[0].move_uci : null;
    if (!naturalUci) return null;
    if (naturalUci.toLowerCase() === String(rec.uci).toLowerCase()) return 0;
    const probe = new Chess(rec.fenBefore);
    const mv = probe.move({ from: naturalUci.slice(0, 2), to: naturalUci.slice(2, 4), promotion: naturalUci[4] });
    if (!mv) return null;
    const read = await evalPosition(engine, probe.fen(), features ? 12 : 12, 1);
    if (!read || !read.lines.length) return null;
    const line = read.lines[0];
    const humanWc = moverWinChanceAfter({ cp: line.cp ?? null, mate: line.mate ?? null }, features.mover);
    return features.winAfterMover / 100 - humanWc;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Board render (lightweight, dependency-free) — pieces + last-move highlight.
// ---------------------------------------------------------------------------
export function renderBoard(fen, fromSq, toSq) {
  const rows = (fen.split(" ")[0] || "").split("/");
  const cells = [];
  for (let r = 0; r < 8; r++) {
    const rankNum = 8 - r;
    let file = 0;
    for (const ch of rows[r] || "") {
      if (/\d/.test(ch)) {
        for (let k = 0; k < Number(ch); k++) cells.push(cell(file++, rankNum, ""));
      } else {
        cells.push(cell(file++, rankNum, PIECE_GLYPH[ch] || ""));
      }
    }
    while (file < 8) cells.push(cell(file++, rankNum, ""));
  }
  return `<div class="cr-board">${cells.join("")}</div>`;

  function cell(fileIdx, rankNum, glyph) {
    const sq = String.fromCharCode(97 + fileIdx) + rankNum;
    const dark = (fileIdx + rankNum) % 2 === 0;
    const hl = sq === fromSq || sq === toSq ? " cr-hl" : "";
    return `<div class="cr-sq ${dark ? "cr-dark" : "cr-light"}${hl}">${glyph}</div>`;
  }
}

// ---------------------------------------------------------------------------
// The UI controller — wires the static page (by id) to the orchestration.
// ---------------------------------------------------------------------------
export function mountCoachReview(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const els = {
    user: $("cr-user"),
    games: $("cr-games"),
    depth: $("cr-depth"),
    rating: $("cr-rating"),
    onlyMine: $("cr-only-mine"),
    skipGood: $("cr-skip-good"),
    useMaia: $("cr-use-maia"),
    pgn: $("cr-pgn"),
    start: $("cr-start"),
    status: $("cr-status"),
    env: $("cr-env"),
    bar: $("cr-bar"),
    log: $("cr-log"),
    cards: $("cr-cards"),
    exportBtn: $("cr-export"),
  };

  const ratings = new Map(); // key -> { ...record, rating, note }
  let queue = [];
  let running = false;

  const keyOf = (rec) => `${rec.fenBefore}|${rec.uci}`;
  const counts = () => {
    let ok = 0;
    let bad = 0;
    for (const v of ratings.values()) {
      if (v.rating === "ok") ok++;
      else if (v.rating === "bad") bad++;
    }
    return { ok, bad, rated: ok + bad };
  };

  function setEnv(extra = "") {
    const coi = typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : false;
    const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || "?";
    const { ok, bad, rated } = counts();
    els.env.textContent =
      `${extra}crossOriginIsolated: ${coi} · cores: ${cores}\nrated: ${rated}/${queue.length} · ✓ ${ok} · ✗ ${bad}`;
  }
  function log(msg) {
    els.log.textContent = `${els.log.textContent ? els.log.textContent + "\n" : ""}${msg}`;
  }
  function setBar(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    els.bar.style.width = `${pct}%`;
  }

  async function loadQueue() {
    const pasted = els.pgn.value.trim();
    let pgnText = pasted;
    let fetchedNote = "";
    if (!pgnText) {
      const username = els.user.value.trim();
      const max = Math.max(1, Number(els.games.value) || 1);
      log(`fetching ${max} game(s) for ${username}…`);
      pgnText = await fetchLichessPgn(username, max);
      fetchedNote = `fetched game(s) for ${username}`;
    }
    const games = splitPgnGames(pgnText);
    const username = els.user.value.trim().toLowerCase();
    const records = [];
    for (const pgn of games) {
      const parsed = gameToMoves(pgn);
      if (!parsed) continue;
      const white = (parsed.headers.White || "").toLowerCase();
      const black = (parsed.headers.Black || "").toLowerCase();
      const myColor = username && white === username ? "white" : username && black === username ? "black" : null;
      for (const m of parsed.moves) {
        if (els.onlyMine.checked && myColor && m.mover !== myColor) continue;
        records.push({ ...m, white: parsed.headers.White || "?", black: parsed.headers.Black || "?" });
      }
    }
    queue = records;
    log(`${fetchedNote ? fetchedNote + ", " : ""}queued ${queue.length} positions`);
  }

  function renderCard(rec, features) {
    const c = buildCommentary(features);
    const card = doc.createElement("div");
    card.className = `cr-card cr-tone-${c.tone}`;
    const key = keyOf(rec);
    const existing = ratings.get(key);
    const moveNo = Math.ceil(rec.ply / 2);
    const dots = rec.mover === "white" ? "." : "...";
    card.innerHTML = `
      <div class="cr-board-wrap">
        ${renderBoard(rec.fenAfter, rec.uci.slice(0, 2), rec.uci.slice(2, 4))}
        <div class="cr-ply">#${rec.ply}</div>
      </div>
      <div class="cr-body">
        <div class="cr-head">
          <span class="cr-badge cr-badge-${c.tone}">${escapeHtml(c.grade || "—")}</span>
          <span class="cr-move">${moveNo}${dots} ${escapeHtml(rec.san)}</span>
          <span class="cr-players">${escapeHtml(rec.white)} vs ${escapeHtml(rec.black)}</span>
        </div>
        <div class="cr-prose cr-${c.tone}">${escapeHtml(c.prose)}</div>
        <div class="cr-actions">
          <button class="cr-ok${existing && existing.rating === "ok" ? " cr-on" : ""}">✓ OK</button>
          <button class="cr-bad${existing && existing.rating === "bad" ? " cr-on" : ""}">✗ 不合格</button>
          <input class="cr-note" placeholder="哪裡不對 / 該怎麼說 (optional)" value="${existing ? escapeHtml(existing.note || "") : ""}" />
        </div>
      </div>`;
    const base = {
      white: rec.white, black: rec.black, ply: rec.ply, mover: rec.mover,
      fen: rec.fenAfter, fenBefore: rec.fenBefore, uci: rec.uci, san: rec.san,
      grade: c.grade, prose: c.prose,
    };
    const okBtn = card.querySelector(".cr-ok");
    const badBtn = card.querySelector(".cr-bad");
    const note = card.querySelector(".cr-note");
    const rate = (rating) => {
      const prev = ratings.get(key) || base;
      ratings.set(key, { ...prev, ...base, rating, note: note.value });
      okBtn.classList.toggle("cr-on", rating === "ok");
      badBtn.classList.toggle("cr-on", rating === "bad");
      setEnv();
    };
    okBtn.addEventListener("click", () => rate("ok"));
    badBtn.addEventListener("click", () => rate("bad"));
    note.addEventListener("input", () => {
      if (ratings.has(key)) ratings.get(key).note = note.value;
    });
    els.cards.appendChild(card);
  }

  async function run() {
    if (running) return;
    running = true;
    els.start.disabled = true;
    els.cards.innerHTML = "";
    els.log.textContent = "";
    ratings.clear();
    try {
      if (!isBrowserEngineAvailable()) throw new Error("Browser engine unavailable (needs crossOriginIsolated).");
      await loadQueue();
      setEnv();
      const depth = Math.max(6, Number(els.depth.value) || 16);
      const rating = Math.max(1100, Number(els.rating.value) || 1500);
      const useMaia = els.useMaia.checked;
      const skipGood = els.skipGood.checked;
      const engine = createEngineProvider({ maxDepth: depth });
      try {
        let done = 0;
        for (const rec of queue) {
          let features = null;
          try {
            features = await coachOneMove(engine, rec, { depth, rating, useMaia });
          } catch (err) {
            log(`#${rec.ply} ${rec.san}: ${err.message}`);
          }
          done += 1;
          setBar(done, queue.length);
          if (!features) continue;
          const code = features.classification.code;
          if (skipGood && (code === "best" || code === "good" || code === "forced")) continue;
          renderCard(rec, features);
          setEnv();
        }
        log("done.");
      } finally {
        try {
          await engine.close();
        } catch (_) {
          /* ignore teardown */
        }
      }
    } catch (err) {
      els.status.textContent = `error: ${err.message}`;
      log(`FATAL: ${err.message}`);
    } finally {
      running = false;
      els.start.disabled = false;
    }
  }

  async function exportRatings() {
    const payload = [...ratings.values()];
    // Write straight to coach-review-ratings.json via the dev server (vite middleware);
    // fall back to a browser download if that endpoint isn't there (e.g. `vite preview`).
    let saved = false;
    try {
      const res = await fetch("/__save-coach-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      saved = res.ok;
    } catch (_) {
      saved = false;
    }
    if (saved) {
      setEnv(`saved ${payload.length} rating(s) → coach-review-ratings.json\n`);
      return;
    }
    setEnv("save endpoint unavailable — using download\n");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = doc.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "coach-review-ratings.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  els.start.addEventListener("click", run);
  els.exportBtn.addEventListener("click", exportRatings);
  setEnv();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
