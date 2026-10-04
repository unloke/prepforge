// Analyze tab rendering (lazy-loaded from app.js). Classification bars, eval chart,
// move tree, and results orchestration.

import { CLASS_GROUPS, CLASS_GROUP_OF, classBadgeSymbol } from "../move-grades.js";
import "./analyze-chart.css";
import { createMoveTreeRenderer } from "./shared/movetree.js";
import { treeToMovetext } from "../analyze-pgn.js";

export function createAnalyzeView({
  appState,
  escapeHtml,
  START_FEN,
  showAnalysisPly,
  selectAnalysisNode,
  revealAnalysisResults,
  onEvalChartRendered = () => {},
}) {
  const { renderMoveTree, scrollIntoViewWithin, bindMoveTreeClicks } =
    createMoveTreeRenderer({ escapeHtml });

  // Chart colours come from CSS theme tokens (styles.css, .eval-chart rules), so
  // the graph follows light/dark like the rest of the app — no hardcoded hex in
  // JS. The class suffixes mirror the classification-bar palette (.seg-*).
  const EVAL_MARKER_CLASS = {
    brilliant: "eval-m-brilliant",
    great: "eval-m-great",
    inaccuracy: "eval-m-inaccuracy",
    mistake: "eval-m-mistake",
    blunder: "eval-m-blunder",
    missed: "eval-m-missed",
  };

  // Chart geometry (SVG user units). The SVG stretches with the container via
  // preserveAspectRatio="none"; stroke widths are pinned with
  // vector-effect="non-scaling-stroke" and marker radii are rescaled by
  // rescaleEvalMarkers so nothing distorts.
  const EVAL_CHART_W = 640;
  const EVAL_CHART_H = 96;
  // Checkmate-on-board sentinel (game-analyzer terminalEval / engine.py mate_score).
  const CHECKMATE_CP = 10000;

  // Plot inset, in screen pixels, top and bottom only: a marker at either extreme
  // stays wholly inside the frame. The plies run edge to edge, so the first/last
  // ply's ring and markers overhang the side borders (the SVG is overflow: visible).
  // The SVG stretches, so the inset becomes user units per measured height
  // (fallback for a hidden chart).
  const EVAL_CHART_INSET_PX = 9;
  let plotPadY = (EVAL_CHART_INSET_PX * EVAL_CHART_H) / 64;

  function measurePlotPads(svg) {
    const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    const padY = rect && rect.height > 0 ? (EVAL_CHART_INSET_PX * EVAL_CHART_H) / rect.height : plotPadY;
    const changed = Math.abs(padY - plotPadY) > 0.5;
    plotPadY = Math.min(padY, EVAL_CHART_H / 4);
    return changed;
  }

  function evalChartXOf(idx, count) {
    if (count <= 1) return EVAL_CHART_W / 2;
    return (idx / (count - 1)) * EVAL_CHART_W;
  }

  // The pointer's position as a 0..1 ratio along the plotted plies.
  function evalChartRatioAt(chart, clientX) {
    const rect = chart.getBoundingClientRect();
    if (!(rect.width > 0)) return 0;
    return (clientX - rect.left) / rect.width;
  }

  function evalChartYOf(winPct) {
    const usable = EVAL_CHART_H - 2 * plotPadY;
    return plotPadY + (1 - winPct / 100) * usable;
  }

  // Nearest point index for a horizontal ratio (0..1) across the chart.
  function evalChartNearestIndex(points, ratio) {
    if (!points || !points.length) return -1;
    const clamped = Math.max(0, Math.min(1, ratio));
    return Math.round(clamped * (points.length - 1));
  }

  // Engine evaluation as players read it: "+1.4" / "−0.3" in pawns (White's
  // point of view), "#3" / "#-2" for forced mates, "1-0" / "0-1" once the
  // board itself is checkmate.
  function formatPointEval(point) {
    if (point.mate_in != null && point.mate_in !== 0) {
      return point.mate_in > 0 ? `#${point.mate_in}` : `#-${Math.abs(point.mate_in)}`;
    }
    // A position that IS checkmate is stored as score_cp = ±100000 (no line to
    // search); reading that as pawns printed "+1000.0".
    if (point.score_cp != null && Math.abs(point.score_cp) >= CHECKMATE_CP) {
      return point.score_cp > 0 ? "1-0" : "0-1";
    }
    // Older reports carry mate only as score_cp = null with bounded_score_cp = ±1000.
    if (point.score_cp == null && Math.abs(point.bounded_score_cp || 0) >= 1000) {
      return point.bounded_score_cp > 0 ? "+M" : "−M";
    }
    const cp = point.score_cp != null ? point.score_cp : point.bounded_score_cp;
    if (cp === null || cp === undefined) return "0.00";
    const pawns = cp / 100;
    return `${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(2)}`;
  }

  // Tooltip body for one ply — move, evaluation, and classification as TEXT
  // (plus the class glyph), so the readout never depends on colour alone.
  function evalChartTooltipHtml(point, { isCurrent = false } = {}) {
    if (!point) return "";
    const raw = String(point.classification || "").toLowerCase();
    const label = raw ? raw.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "";
    const glyph = raw ? classBadgeSymbol(point.classification) : "";
    const san = escapeHtml(String(point.san || "?"));
    const moveNo = point.ply > 0 ? `${Math.ceil(point.ply / 2)}${point.ply % 2 ? "." : "…"} ` : "";
    return (
      `${moveNo}<b>${san}</b> · ${formatPointEval(point)}` +
      (label ? ` · ${glyph} ${escapeHtml(label)}` : "") +
      (isCurrent ? " · current" : "")
    );
  }

  function jumpToClassGroup(side, groupKey) {
    const moves = appState.analysis ? appState.analysis.moves : [];
    const current = Number(appState.analysisPly) || 0;
    const matches = (move) =>
      (move.side === "black" ? "black" : "white") === side &&
      CLASS_GROUP_OF[move.classification] === groupKey;
    const match =
      moves.find((m) => Number(m.ply) > current && matches(m)) ||
      moves.find((m) => Number(m.ply) <= current && matches(m));
    if (match) showAnalysisPly(Number(match.ply));
  }

  function renderClassificationBars(moves) {
    const host = document.getElementById("analysis-summary");
    if (!host) return;
    if (!moves || !moves.length) {
      host.innerHTML = "";
      return;
    }
    const tally = { white: {}, black: {} };
    moves.forEach((move) => {
      const side = move.side === "black" ? "black" : "white";
      const group = CLASS_GROUP_OF[move.classification];
      if (!group) return;
      tally[side][group] = (tally[side][group] || 0) + 1;
    });

    const rowHtml = (side, label) => {
      const counts = tally[side];
      const total = CLASS_GROUPS.reduce((sum, g) => sum + (counts[g.key] || 0), 0);
      const segs = CLASS_GROUPS.filter((g) => counts[g.key] > 0)
        .map((g) => {
          const n = counts[g.key];
          return (
            `<button class="cbar-seg seg-${g.key}" style="flex:${n}" ` +
            `data-side="${side}" data-group="${g.key}" ` +
            `title="${g.label}: ${n}" aria-label="${label} ${g.label}: ${n}">` +
            `<span class="cbar-seg-n">${n}</span></button>`
          );
        })
        .join("");
      const track = total ? segs : '<span class="cbar-empty">no scored moves</span>';
      return (
        `<div class="cbar-row">` +
        `<span class="cbar-side">${label}</span>` +
        `<span class="cbar-track">${track}</span>` +
        `</div>`
      );
    };

    host.innerHTML =
      `<div class="class-bars">` +
      rowHtml("white", "White") +
      rowHtml("black", "Black") +
      `</div>`;

    host.querySelectorAll(".cbar-seg").forEach((seg) => {
      seg.addEventListener("click", () => {
        jumpToClassGroup(seg.dataset.side, seg.dataset.group);
        seg.blur();
      });
    });
  }

  function buildAnalysisTree(moves) {
    const startFen = (moves && moves[0] && moves[0].fen_before) || START_FEN;
    const root = {
      id: "root",
      san: null,
      fenAfter: startFen,
      ply: 0,
      isMainline: true,
      isVariation: false,
      parent: null,
      children: [],
    };
    const byId = new Map([["root", root]]);
    let prev = root;
    (moves || []).forEach((move) => {
      const node = {
        id: `m${move.ply}`,
        ply: Number(move.ply),
        san: move.san,
        uci: move.uci,
        fenBefore: move.fen_before,
        fenAfter: move.fen_after,
        moveNumber: move.move_number,
        side: move.side,
        classification: move.classification,
        isMainline: true,
        isVariation: false,
        parent: prev,
        children: [],
      };
      byId.set(node.id, node);
      prev.children.push(node);
      prev = node;
    });
    const pending = Array.from(appState.analysisVarNodes.values()).sort(
      (a, b) => a.seq - b.seq
    );
    for (const v of pending) {
      const parent = byId.get(v.parentId);
      if (!parent) continue;
      const node = {
        id: v.id,
        ply: -1,
        san: v.san,
        uci: v.uci,
        fenBefore: v.fenBefore,
        fenAfter: v.fenAfter,
        moveNumber: v.moveNumber,
        side: v.side,
        classification: null,
        isMainline: false,
        isVariation: true,
        parent,
        children: [],
      };
      byId.set(node.id, node);
      parent.children.push(node);
    }
    return { root, byId };
  }

  // Flatten the parser's generic tree (root → children, children[0] = mainline,
  // children[1..] = variations) into the two structures the Analyze view renders
  // from: a flat `moves` array (the mainline) and an `analysisVarNodes` map keyed by
  // `v<seq>` whose `parentId` points at the node a variation branches from. Mirrors
  // the ids buildAnalysisTree() expects (`m<ply>` on the mainline, `root` at start).
  function adaptParsedTree(root) {
    const moves = [];
    const varNodes = new Map();
    let seq = 0;
    function walk(node, parentId, onMainline, ply) {
      let id;
      if (onMainline) {
        id = `m${ply}`;
        moves.push({
          ply,
          san: node.san,
          uci: node.uci,
          fen_before: node.fenBefore,
          fen_after: node.fenAfter,
          move_number: node.moveNumber,
          side: node.side,
          classification: null,
        });
      } else {
        seq += 1;
        id = `v${seq}`;
        varNodes.set(id, {
          id,
          seq,
          parentId,
          uci: node.uci,
          san: node.san,
          fenBefore: node.fenBefore,
          fenAfter: node.fenAfter,
          moveNumber: node.moveNumber,
          side: node.side,
        });
      }
      const kids = node.children || [];
      if (kids[0]) walk(kids[0], id, onMainline, onMainline ? ply + 1 : 0);
      for (let i = 1; i < kids.length; i += 1) walk(kids[i], id, false, 0);
    }
    const top = root.children || [];
    if (top[0]) walk(top[0], "root", true, 1);
    for (let i = 1; i < top.length; i += 1) walk(top[i], "root", false, 0);
    return { moves, varNodes };
  }

  function serializeAnalysisPgn(sourcePgn) {
    const analysis = appState.analysis;
    const moves = analysis?.moves || [];
    const movetext = treeToMovetext(buildAnalysisTree(moves).root);
    if (!movetext) return "";
    let headers = String(sourcePgn || "")
      .split(/\r?\n/)
      .filter((line) => /^\s*\[[^\]]*\]\s*$/.test(line))
      .join("\n")
      .trim();
    if (!headers && analysis?.game_id) {
      // A recall has no source PGN. Keep its known tags and starting FEN so
      // copying or re-analyzing it reproduces the same game.
      const safe = (s) => String(s || "?").replace(/["\r\n]/g, "'");
      const tags = [
        `[White "${safe(analysis.white)}"]`,
        `[Black "${safe(analysis.black)}"]`,
        `[Result "${safe(analysis.result || "*")}"]`,
      ];
      const fen = moves[0]?.fen_before;
      if (fen && fen !== START_FEN) tags.push('[SetUp "1"]', `[FEN "${safe(fen)}"]`);
      headers = tags.join("\n");
    }
    return headers ? `${headers}\n\n${movetext}` : movetext;
  }

  function analysisPathIds(nodeId, tree) {
    const set = new Set();
    let node = tree.byId.get(nodeId || "root");
    while (node) {
      set.add(node.id);
      node = node.parent;
    }
    return set;
  }

  function renderAnalysisTree(movesArg) {
    const container = document.getElementById("analysis-moves");
    if (!container) return;
    const moves = movesArg || (appState.analysis ? appState.analysis.moves : []);
    const tree = buildAnalysisTree(moves);
    appState.analysisTree = tree;
    const hasContent = (tree.root.children || []).length > 0;
    if (!hasContent) {
      container.innerHTML =
        '<div class="empty-state">Play on the board, or analyze a PGN.</div>';
      return;
    }
    const panel = document.getElementById("analysis-results");
    if (panel && panel.hidden) revealAnalysisResults();
    const pathIds = analysisPathIds(appState.analysisCurrentNodeId, tree);
    container.innerHTML = renderMoveTree(tree.root, {
      currentId: appState.analysisCurrentNodeId,
      pathIds,
      decorate: (node) => {
        if (node.isVariation) {
          return { classes: ["is-variation"], title: "variation" };
        }
        const cls = String(node.classification || "unknown");
        const group = CLASS_GROUP_OF[cls.toLowerCase()];
        const glyph = group ? classBadgeSymbol(cls) : "";
        return {
          classes: [`cls-${cls}`, node.side === "black" ? "is-black" : "is-white"],
          suffix: glyph ? `<i class="mtree-glyph">${glyph}</i>` : "",
          title: cls,
        };
      },
    });
    bindMoveTreeClicks(container, (id) => void selectAnalysisNode(id).catch(() => {}));
    const focus = container.querySelector(".mtree-move.is-current");
    if (focus) scrollIntoViewWithin(container, focus);
  }

  function renderMovePairs(moves) {
    renderAnalysisTree(moves);
  }

  function rescaleEvalMarkers() {
    const chart = document.getElementById("eval-chart");
    if (!chart) return;
    // A new chart size changes the insets in user units: redraw at the new geometry.
    if (measurePlotPads(chart) && (appState.evalChartPoints || []).length) {
      renderEvalChart(appState.evalChartPoints);
      return;
    }
    const markers = chart.querySelectorAll(".eval-marker");
    if (!markers.length) return;
    const viewWidth = 640;
    const viewHeight = 96;
    const rect = chart.getBoundingClientRect();
    const xScale = rect.width > 0 ? viewWidth / rect.width : 1;
    const yScale = rect.height > 0 ? viewHeight / rect.height : 1;
    markers.forEach((dot) => {
      const baseR = Number(dot.dataset.baseR) || 4;
      dot.setAttribute("rx", String(baseR * xScale));
      dot.setAttribute("ry", String(baseR * yScale));
    });
  }

  // ---- Evaluation head: one chip + win meter -------------------------------
  // With the engine on, the chip and meter follow the live search (the docked
  // engine's own eval chip and bar, which the card hides); otherwise the analysed
  // game's point for the current ply. Empty when neither has a number.
  let chartPoint = null;
  function paintEvalHead() {
    const chip = document.getElementById("analysis-chart-caption");
    if (!chip) return;
    let text = "";
    let side = "even";
    let pct = NaN;
    if (document.getElementById("analysis-eval-card")?.classList.contains("is-engine")) {
      const head = document.getElementById("engine-head-eval");
      const live = (head?.textContent || "").trim();
      if (/\d|#|M/.test(live)) {
        text = live;
        side = head.dataset.side || "even";
        pct = parseFloat(document.getElementById("engine-eval-bar-white")?.style.height);
      }
    }
    if (!text && chartPoint) {
      text = formatPointEval(chartPoint);
      pct = pointWinPct(chartPoint);
      side = pct > 52 ? "white" : pct < 48 ? "black" : "even";
    }
    chip.textContent = text;
    chip.dataset.side = side;
    chip.parentElement?.classList.toggle("has-eval", !!text);
    const fill = document.querySelector("#analysis-eval-meter > i");
    if (fill) fill.style.width = `${Number.isFinite(pct) ? Math.round(pct) : 50}%`;
  }

  // "12 / 16" -> a ring filled to 12/16 showing "12"; the full text is the tooltip.
  function paintDepthRing() {
    const el = document.getElementById("engine-window-depth-readout");
    if (!el) return;
    const m = /(\d+)\s*\/\s*(\d+)/.exec(el.textContent || "");
    el.dataset.d = m ? m[1] : "";
    el.style.setProperty("--p", m && Number(m[2]) ? String(Math.min(1, Number(m[1]) / Number(m[2]))) : "0");
    el.title = m ? `Depth ${m[1]} of ${m[2]}` : "";
  }

  const watch = (id, fn, options) => {
    const el = globalThis.document?.getElementById(id);
    if (el && typeof MutationObserver === "function") new MutationObserver(fn).observe(el, options);
  };
  const TEXT_CHANGES = { childList: true, characterData: true, subtree: true };
  watch("engine-head-eval", paintEvalHead, { ...TEXT_CHANGES, attributes: true });
  watch("analysis-eval-card", paintEvalHead, { attributes: true, attributeFilter: ["class"] });
  watch("engine-window-depth-readout", paintDepthRing, TEXT_CHANGES);

  function updateChartCaption(point) {
    chartPoint = point || null;
    paintEvalHead();
  }

  // Whole-game progress: returns onResult(fen, ev) for the Stockfish pass, which
  // plots each White-POV result at its position's x as it lands, so the graph
  // draws itself while the job runs (the job dock carries the count and Stop).
  // onResult.phase(name, done, total) then animates the later passes on the same
  // graph: "maia-load" (the model is loading: the curve breathes), "maia" (Maia
  // reads the game move by move: a sweep recolours the curve up to its front)
  // and "saving". It takes the job's own phase names.
  function liveEvalChart(positions) {
    const svg = document.getElementById("eval-chart-live");
    const host = document.getElementById("analysis-eval-live");
    const list = Array.isArray(positions) ? positions : [];
    const slots = new Map();
    list.forEach((fen, i) => slots.set(fen, [...(slots.get(fen) || []), i]));
    const wins = new Array(list.length).fill(null);
    const span = Math.max(1, list.length - 1);
    const xOf = (i) => ((i / span) * EVAL_CHART_W).toFixed(1);
    const line = (cls, x1, y1, x2, y2) =>
      `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" vector-effect="non-scaling-stroke"/>`;
    const poly = (cls, pts) =>
      pts.length > 1 ? `<polyline class="${cls}" points="${pts.join(" ")}" vector-effect="non-scaling-stroke"/>` : "";
    let phase = "stockfish";
    let ratio = 0;
    let frame = 0;
    // Clear the analysed game's reading: until this run lands, it describes another game.
    updateChartCaption(null);
    const draw = () => {
      frame = 0;
      if (!svg) return;
      if (host) host.dataset.phase = phase;
      const centerY = evalChartYOf(50);
      const pts = [];
      let front = -1;
      wins.forEach((w, i) => {
        if (w === null) return;
        pts.push(`${xOf(i)},${evalChartYOf(w).toFixed(1)}`);
        front = i;
      });
      let overlay = "";
      if (phase === "stockfish") {
        if (front >= 0) overlay = line("eval-front", xOf(front), 0, xOf(front), EVAL_CHART_H);
      } else if (phase === "maia") {
        const x = ratio * EVAL_CHART_W;
        const read = pts.filter((p) => Number(p.split(",")[0]) <= x + 0.05);
        overlay =
          poly("eval-maia-line", read) +
          `<rect class="eval-maia-band" x="${Math.max(0, x - 48).toFixed(1)}" y="0" width="${Math.min(48, x).toFixed(1)}" height="${EVAL_CHART_H}"/>` +
          line("eval-maia-front", x.toFixed(1), 0, x.toFixed(1), EVAL_CHART_H);
      }
      svg.innerHTML =
        `<defs><linearGradient id="eval-maia-glow" x1="0" x2="1" y1="0" y2="0">` +
        `<stop offset="0" stop-color="currentColor" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="currentColor" stop-opacity="0.35"/></linearGradient></defs>` +
        line("eval-axis", 0, centerY, EVAL_CHART_W, centerY) +
        poly("eval-line", pts) +
        overlay;
    };
    const schedule = () => {
      if (!frame) frame = (globalThis.requestAnimationFrame || setTimeout)(draw);
    };
    draw();
    const onResult = (fen, ev) => {
      const at = slots.get(fen);
      if (!at || !ev) return;
      const cp = ev.mate_in ? Math.sign(ev.mate_in) * 1500 : ev.score_cp;
      const win = pointWinPct({ score_cp: Number.isFinite(cp) ? cp : 0 });
      at.forEach((i) => (wins[i] = win));
      schedule();
    };
    // Job phases → graph states (the job reports maia-inference / maia-traps /
    // classifying; the graph only needs to know which animation to run).
    const PHASE_OF = { "maia-inference": "maia", "maia-traps": "maia", classifying: "saving" };
    onResult.phase = (name, done = 0, total = 0) => {
      phase = PHASE_OF[name] || name || phase;
      ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
      schedule();
    };
    return onResult;
  }

  function updateEvalChartCursor() {
    const marker = document.getElementById("eval-chart-cursor");
    if (!marker) return;
    const dot = document.getElementById("eval-chart-cursor-dot");
    const points = appState.evalChartPoints || [];
    const ply = appState.analysisPly;
    const idx = points.findIndex((p) => p.ply === ply);
    const hidden = !points.length || idx < 0;
    const x = hidden ? -10 : evalChartXOf(idx, points.length);
    marker.setAttribute("x1", String(x));
    marker.setAttribute("x2", String(x));
    updateChartCaption(hidden ? null : points[idx]);
    if (!dot) return;
    // Ring on the curve at the current ply: a SHAPE cue on top of the dashed
    // line (and the tooltip's "current" text), so the position indicator never
    // relies on colour alone.
    if (hidden) {
      dot.setAttribute("visibility", "hidden");
      return;
    }
    dot.setAttribute("visibility", "visible");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(evalChartYOf(pointWinPct(points[idx]))));
  }

  // White-POV win chance (0..100) from an eval-graph point, via the Lichess sigmoid —
  // identical to cpToWin (web-src/explain.js) and the server's cp_to_win_chance so the
  // chart, the classifier, and the Coach all read from the same win% scale. score_cp is
  // preferred; bounded_score_cp is the fallback (it already encodes mate as ±1000 and
  // clamps extremes). Plotting win% instead of raw centipawns is the whole point: the
  // sigmoid expands the decisive ±1–2 pawn band (where games are actually won and lost)
  // and flattens the meaningless +5↔+9 range, so a bad move reads as a real drop.
  function pointWinPct(point) {
    const cp = point.score_cp != null ? point.score_cp : point.bounded_score_cp;
    if (cp === null || cp === undefined) return 50;
    const c = Math.max(-1500, Math.min(1500, cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
  }

  // Keyboard/hover focus ply within the chart (-1 = none). Arrows move it, Enter
  // commits it — the same call a mouse click makes.
  let evalChartFocusIdx = -1;

  function showEvalChartTooltip(idx) {
    const tooltip = document.getElementById("eval-chart-tooltip");
    const chart = document.getElementById("eval-chart");
    const points = appState.evalChartPoints || [];
    if (!tooltip || !chart) return;
    if (idx < 0 || idx >= points.length) {
      hideEvalChartTooltip();
      return;
    }
    const point = points[idx];
    const x = evalChartXOf(idx, points.length);
    tooltip.innerHTML = evalChartTooltipHtml(point, {
      isCurrent: point.ply === appState.analysisPly,
    });
    tooltip.hidden = false;
    // Anchor under the hovered ply: the SVG maps its width onto the wrap box.
    const rect = chart.getBoundingClientRect();
    const px = rect.width > 0 ? (x / EVAL_CHART_W) * rect.width : 0;
    // Clamp the centred box so its edges stay inside the chart (it used to spill
    // past the panel's right edge on the last plies).
    const half = (tooltip.offsetWidth || 0) / 2;
    const left = rect.width > 2 * half ? Math.max(half, Math.min(px, rect.width - half)) : rect.width / 2;
    tooltip.style.left = `${left}px`;
    const hover = document.getElementById("eval-chart-hover");
    if (hover) {
      hover.setAttribute("x1", String(x));
      hover.setAttribute("x2", String(x));
      hover.setAttribute("visibility", "visible");
    }
  }

  function hideEvalChartTooltip() {
    const tooltip = document.getElementById("eval-chart-tooltip");
    if (tooltip) tooltip.hidden = true;
    const hover = document.getElementById("eval-chart-hover");
    if (hover) hover.setAttribute("visibility", "hidden");
  }

  function selectEvalChartIdx(idx) {
    const points = appState.evalChartPoints || [];
    if (idx < 0 || idx >= points.length) return;
    evalChartFocusIdx = idx;
    showAnalysisPly(points[idx].ply);
  }

  // Click/hover/keyboard live with the chart, bound once per SVG element.
  function bindEvalChartInteractions() {
    const chart = document.getElementById("eval-chart");
    if (!chart || chart.dataset.evalChartBound === "1") return;
    chart.dataset.evalChartBound = "1";

    chart.addEventListener("click", (event) => {
      const points = appState.evalChartPoints || [];
      if (!points.length) return;
      selectEvalChartIdx(evalChartNearestIndex(points, evalChartRatioAt(chart, event.clientX)));
    });

    chart.addEventListener("mousemove", (event) => {
      const points = appState.evalChartPoints || [];
      if (!points.length) return;
      evalChartFocusIdx = evalChartNearestIndex(points, evalChartRatioAt(chart, event.clientX));
      showEvalChartTooltip(evalChartFocusIdx);
    });

    // Pointer focus would pin the tooltip after the mouse leaves; keyboard
    // users step moves with the arrow keys (global) and read the move list.
    chart.addEventListener("mousedown", (event) => event.preventDefault());

    chart.addEventListener("mouseleave", () => {
      evalChartFocusIdx = -1;
      hideEvalChartTooltip();
    });
  }

  function renderEvalChart(points) {
    const chart = document.getElementById("eval-chart");
    const svgNS = "http://www.w3.org/2000/svg";
    measurePlotPads(chart);
    chart.innerHTML = "";
    appState.evalChartPoints = points || [];
    onEvalChartRendered();
    const width = EVAL_CHART_W;
    const height = EVAL_CHART_H;
    // Win% → y. Up = White winning (standard advantage-graph convention, matching
    // Lichess/chess.com). A generic analyzed PGN has no single "player" whose POV to
    // adopt, so White-POV keeps it unambiguous; the per-move error colouring below is
    // what tells you which side blundered.
    const yOf = evalChartYOf;
    const centerY = yOf(50);
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    chart.setAttribute("preserveAspectRatio", "none");
    chart.setAttribute(
      "aria-label",
      "Evaluation by move: above the centre line White is better, below it Black. Click a point to open that move.",
    );
    chart.removeAttribute("tabindex");
    chart.style.cursor = points && points.length ? "pointer" : "default";

    const axis = document.createElementNS(svgNS, "line");
    axis.setAttribute("class", "eval-axis");
    axis.setAttribute("x1", "0");
    axis.setAttribute("x2", String(width));
    axis.setAttribute("y1", String(centerY));
    axis.setAttribute("y2", String(centerY));
    axis.setAttribute("vector-effect", "non-scaling-stroke");
    chart.appendChild(axis);

    // Hover/focus indicator (hidden until the pointer or keyboard asks).
    const hover = document.createElementNS(svgNS, "line");
    hover.setAttribute("id", "eval-chart-hover");
    hover.setAttribute("class", "eval-hover");
    hover.setAttribute("y1", "0");
    hover.setAttribute("y2", String(height));
    hover.setAttribute("x1", "-10");
    hover.setAttribute("x2", "-10");
    hover.setAttribute("visibility", "hidden");
    hover.setAttribute("vector-effect", "non-scaling-stroke");
    chart.appendChild(hover);

    if (!points || !points.length) {
      hideEvalChartTooltip();
      updateEvalChartCursor();
      bindEvalChartInteractions();
      return;
    }

    const coords = points.map((point, index) => {
      const x = evalChartXOf(index, points.length);
      const y = yOf(pointWinPct(point));
      return { x, y, ply: point.ply, classification: point.classification };
    });

    // One straight segment per move. The area between the curve and the centre
    // line is drawn twice and clipped to each half: light where White is better
    // (above), dark where Black is (below) - the standard advantage graph, so
    // the fill always means "who is ahead, and by how much".
    const stepStr = coords.map((c) => `${c.x},${c.y}`).join(" ");
    const areaPoints =
      `${coords[0].x},${centerY} ${stepStr} ${coords[coords.length - 1].x},${centerY}`;
    const defs = document.createElementNS(svgNS, "defs");
    [["white", 0, centerY], ["black", centerY, height - centerY]].forEach(([side, y, h]) => {
      const clip = document.createElementNS(svgNS, "clipPath");
      clip.setAttribute("id", `eval-clip-${side}`);
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", "0");
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(width));
      rect.setAttribute("height", String(h));
      clip.appendChild(rect);
      defs.appendChild(clip);
    });
    chart.appendChild(defs);
    ["white", "black"].forEach((side) => {
      const area = document.createElementNS(svgNS, "polygon");
      area.setAttribute("class", `eval-area eval-area-${side}`);
      area.setAttribute("points", areaPoints);
      area.setAttribute("clip-path", `url(#eval-clip-${side})`);
      chart.appendChild(area);
    });

    // Main line: non-scaling stroke so the stretched SVG never thickens it.
    const polyline = document.createElementNS(svgNS, "polyline");
    polyline.setAttribute("class", "eval-line");
    polyline.setAttribute("points", stepStr);
    polyline.setAttribute("vector-effect", "non-scaling-stroke");
    chart.appendChild(polyline);

    // Colour the vertical cliff at each error/brilliant move so bad moves are unmissable.
    coords.forEach((c, i) => {
      if (i === 0) return;
      const raw = String(c.classification || "").toLowerCase();
      const cls = CLASS_GROUP_OF[raw] || raw;
      const markerClass = EVAL_MARKER_CLASS[cls];
      if (!markerClass) return;
      const cliff = document.createElementNS(svgNS, "line");
      cliff.setAttribute("class", `eval-cliff ${markerClass}`);
      cliff.setAttribute("x1", String(c.x));
      cliff.setAttribute("x2", String(c.x));
      cliff.setAttribute("y1", String(coords[i - 1].y));
      cliff.setAttribute("y2", String(c.y));
      cliff.setAttribute("vector-effect", "non-scaling-stroke");
      chart.appendChild(cliff);
    });

    coords.forEach((c) => {
      const raw = String(c.classification || "").toLowerCase();
      const cls = CLASS_GROUP_OF[raw] || raw;
      const markerClass = EVAL_MARKER_CLASS[cls];
      if (!markerClass) return;
      const dot = document.createElementNS(svgNS, "ellipse");
      dot.classList.add("eval-marker", "eval-dot", markerClass);
      dot.setAttribute("cx", String(c.x));
      dot.setAttribute("cy", String(c.y));
      dot.setAttribute("data-ply", String(c.ply));
      dot.dataset.baseR = "4.5";
      dot.style.cursor = "pointer";
      dot.addEventListener("click", (event) => {
        event.stopPropagation();
        showAnalysisPly(c.ply);
      });
      chart.appendChild(dot);
    });
    rescaleEvalMarkers();

    // Current-ply position: dashed vertical line + a ring on the curve (shape,
    // not colour) above everything else.
    const marker = document.createElementNS(svgNS, "line");
    marker.setAttribute("id", "eval-chart-cursor");
    marker.setAttribute("class", "eval-cursor");
    marker.setAttribute("y1", "0");
    marker.setAttribute("y2", String(height));
    marker.setAttribute("stroke-dasharray", "3 3");
    marker.setAttribute("x1", "-10");
    marker.setAttribute("x2", "-10");
    marker.setAttribute("vector-effect", "non-scaling-stroke");
    chart.appendChild(marker);

    const ring = document.createElementNS(svgNS, "ellipse");
    ring.setAttribute("id", "eval-chart-cursor-dot");
    ring.classList.add("eval-marker", "eval-cursor-dot");
    ring.setAttribute("cx", "-10");
    ring.setAttribute("cy", "-10");
    ring.setAttribute("visibility", "hidden");
    ring.dataset.baseR = "6.5";
    chart.appendChild(ring);

    updateEvalChartCursor();
    bindEvalChartInteractions();
  }

  function renderAnalysis(payload) {
    renderMovePairs(payload.moves);
    renderEvalChart(payload.eval_graph);
    renderClassificationBars(payload.moves);
  }

  return {
    renderAnalysis,
    liveEvalChart,
    paintEvalHead,
    renderClassificationBars,
    renderEvalChart,
    renderAnalysisTree,
    buildAnalysisTree,
    serializeAnalysisPgn,
    adaptParsedTree,
    classBadgeSymbol,
    updateEvalChartCursor,
    rescaleEvalMarkers,
    bindEvalChartInteractions,
    evalChartNearestIndex,
    evalChartTooltipHtml,
    renderMoveTree,
    bindMoveTreeClicks,
    scrollIntoViewWithin,
  };
}
