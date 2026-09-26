// Analyze tab rendering (lazy-loaded from app.js). Classification bars, eval chart,
// move tree, and results orchestration.

import "./analyze-chart.css";
import { createMoveTreeRenderer } from "./shared/movetree.js";

export function createAnalyzeView({
  appState,
  escapeHtml,
  START_FEN,
  showAnalysisPly,
  selectAnalysisNode,
  revealAnalysisResults,
}) {
  const { renderMoveTree, scrollIntoViewWithin, bindMoveTreeClicks } =
    createMoveTreeRenderer({ escapeHtml });

  const CLASS_GROUPS = [
    { key: "brilliant", label: "Brilliant", members: ["brilliant"] },
    { key: "good", label: "Good", members: ["best", "excellent", "good", "book"] },
    { key: "inaccuracy", label: "Inaccuracy", members: ["inaccuracy"] },
    { key: "mistake", label: "Mistake", members: ["mistake"] },
    { key: "blunder", label: "Blunder", members: ["blunder"] },
    { key: "missed", label: "Missed", members: ["missed_win", "missed_tactic"] },
  ];
  const CLASS_GROUP_OF = (() => {
    const map = {};
    CLASS_GROUPS.forEach((g) => g.members.forEach((m) => (map[m] = g.key)));
    return map;
  })();

  function classBadgeSymbol(classification) {
    const group = CLASS_GROUP_OF[String(classification || "").toLowerCase()];
    return (
      {
        brilliant: "!!",
        good: "+",
        inaccuracy: "?!",
        mistake: "?",
        blunder: "??",
        missed: "x",
      }[group] || "."
    );
  }

  // Chart colours come from CSS theme tokens (styles.css, .eval-chart rules), so
  // the graph follows light/dark like the rest of the app — no hardcoded hex in
  // JS. The class suffixes mirror the classification-bar palette (.seg-*).
  const EVAL_MARKER_CLASS = {
    brilliant: "eval-m-brilliant",
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
  const EVAL_CHART_PAD = 10;

  function evalChartYOf(winPct) {
    const usable = EVAL_CHART_H - 2 * EVAL_CHART_PAD;
    return EVAL_CHART_PAD + (1 - winPct / 100) * usable;
  }

  // Nearest point index for a horizontal ratio (0..1) across the chart.
  function evalChartNearestIndex(points, ratio) {
    if (!points || !points.length) return -1;
    const clamped = Math.max(0, Math.min(1, ratio));
    return Math.round(clamped * (points.length - 1));
  }

  // Tooltip body for one ply — SAN, win chance, and classification as TEXT (plus
  // the class glyph), so the readout never depends on colour alone. "current"
  // marks the position indicator's ply the same way.
  function evalChartTooltipHtml(point, { isCurrent = false } = {}) {
    if (!point) return "";
    const raw = String(point.classification || "").toLowerCase();
    const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Unclassified";
    const glyph = classBadgeSymbol(point.classification);
    const pct = Math.round(pointWinPct(point));
    const san = escapeHtml(String(point.san || "?"));
    return (
      `<b>${san}</b> · ${pct}% win chance · ${glyph} ${label}` +
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
          const pct = Math.round((n / total) * 100);
          return (
            `<button class="cbar-seg seg-${g.key}" style="flex:${n}" ` +
            `data-side="${side}" data-group="${g.key}" ` +
            `title="${g.label}: ${n}" aria-label="${label} ${g.label}: ${n}">` +
            `<span class="cbar-seg-n">${pct >= 10 ? n : ""}</span></button>`
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

    const legend = CLASS_GROUPS.map(
      (g) => `<span class="cbar-key"><i class="seg-${g.key}"></i>${g.label}</span>`
    ).join("");

    host.innerHTML =
      `<div class="class-bars">` +
      rowHtml("white", "White") +
      rowHtml("black", "Black") +
      `<div class="cbar-legend">${legend}</div>` +
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
        '<div class="empty-state">Play moves on the board to branch into study lines, ' +
        "or load a PGN and click Analyze for a full review.</div>";
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
        return {
          classes: [`cls-${cls}`],
          suffix: '<span class="mtree-dot"></span>',
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

  function updateEvalChartCursor() {
    const marker = document.getElementById("eval-chart-cursor");
    if (!marker) return;
    const dot = document.getElementById("eval-chart-cursor-dot");
    const points = appState.evalChartPoints || [];
    const ply = appState.analysisPly;
    const idx = points.findIndex((p) => p.ply === ply);
    const hidden = !points.length || idx < 0;
    const width = EVAL_CHART_W;
    const x = hidden ? -10 : points.length === 1 ? width / 2 : (idx / (points.length - 1)) * width;
    marker.setAttribute("x1", String(x));
    marker.setAttribute("x2", String(x));
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
    const x = points.length === 1 ? EVAL_CHART_W / 2 : (idx / (points.length - 1)) * EVAL_CHART_W;
    tooltip.innerHTML = evalChartTooltipHtml(point, {
      isCurrent: point.ply === appState.analysisPly,
    });
    tooltip.hidden = false;
    // Anchor under the hovered ply: the SVG maps its width onto the wrap box.
    const rect = chart.getBoundingClientRect();
    const px = rect.width > 0 ? (x / EVAL_CHART_W) * rect.width : 0;
    tooltip.style.left = `${Math.max(0, Math.min(px, rect.width))}px`;
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
      const rect = chart.getBoundingClientRect();
      const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      selectEvalChartIdx(evalChartNearestIndex(points, ratio));
    });

    chart.addEventListener("mousemove", (event) => {
      const points = appState.evalChartPoints || [];
      if (!points.length) return;
      const rect = chart.getBoundingClientRect();
      const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      evalChartFocusIdx = evalChartNearestIndex(points, ratio);
      showEvalChartTooltip(evalChartFocusIdx);
    });

    chart.addEventListener("mouseleave", () => {
      if (document.activeElement !== chart) {
        evalChartFocusIdx = -1;
        hideEvalChartTooltip();
      }
    });

    chart.addEventListener("focus", () => {
      const points = appState.evalChartPoints || [];
      if (!points.length) return;
      const current = points.findIndex((p) => p.ply === appState.analysisPly);
      evalChartFocusIdx = current >= 0 ? current : 0;
      showEvalChartTooltip(evalChartFocusIdx);
    });

    chart.addEventListener("blur", () => {
      evalChartFocusIdx = -1;
      hideEvalChartTooltip();
    });

    chart.addEventListener("keydown", (event) => {
      const points = appState.evalChartPoints || [];
      if (!points.length) return;
      const current = points.findIndex((p) => p.ply === appState.analysisPly);
      const startIdx = evalChartFocusIdx >= 0 ? evalChartFocusIdx : Math.max(0, current);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.key === "ArrowRight" ? 1 : -1;
        evalChartFocusIdx = Math.max(0, Math.min(points.length - 1, startIdx + step));
        showEvalChartTooltip(evalChartFocusIdx);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        // Enter behaves exactly like a mouse click on the indicated ply.
        selectEvalChartIdx(startIdx);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        evalChartFocusIdx = event.key === "Home" ? 0 : points.length - 1;
        showEvalChartTooltip(evalChartFocusIdx);
      }
    });
  }

  function renderEvalChart(points) {
    const chart = document.getElementById("eval-chart");
    const svgNS = "http://www.w3.org/2000/svg";
    chart.innerHTML = "";
    appState.evalChartPoints = points || [];
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
      "Win chance by move (up = White). Left and right arrows step through moves, Enter opens a move.",
    );
    chart.style.cursor = points && points.length ? "pointer" : "default";
    // Keyboard focus only earns its keep once there is a ply to step through.
    if (points && points.length) {
      chart.setAttribute("tabindex", "0");
    } else {
      chart.removeAttribute("tabindex");
    }

    // Subtle "roughly equal" band (≈45–55% win chance) so small wobbles near the middle
    // don't look dramatic while genuine swings still stand out.
    const band = document.createElementNS(svgNS, "rect");
    band.setAttribute("class", "eval-band");
    band.setAttribute("x", "0");
    band.setAttribute("y", String(yOf(55)));
    band.setAttribute("width", String(width));
    band.setAttribute("height", String(yOf(45) - yOf(55)));
    chart.appendChild(band);

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
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = yOf(pointWinPct(point));
      return { x, y, ply: point.ply, classification: point.classification };
    });

    // Step-after path: hold each eval flat to the next move's x, then drop/rise vertically
    // to the new win%. Every move's change becomes a vertical segment, so a blunder shows
    // up as a literal cliff rather than a gentle slope.
    const stepPts = [];
    coords.forEach((c, i) => {
      if (i > 0) stepPts.push([c.x, coords[i - 1].y]);
      stepPts.push([c.x, c.y]);
    });
    const stepStr = stepPts.map((p) => `${p[0]},${p[1]}`).join(" ");

    const area = document.createElementNS(svgNS, "polygon");
    area.setAttribute("class", "eval-area");
    area.setAttribute(
      "points",
      `${coords[0].x},${centerY} ${stepStr} ${coords[coords.length - 1].x},${centerY}`,
    );
    chart.appendChild(area);

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
    renderClassificationBars,
    renderEvalChart,
    renderAnalysisTree,
    buildAnalysisTree,
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
