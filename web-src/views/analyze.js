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
  onEvalChartRendered = () => {},
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
  // Checkmate-on-board sentinel (game-analyzer terminalEval / engine.py mate_score).
  const CHECKMATE_CP = 10000;

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
    if (cp === null || cp === undefined) return "0.0";
    const pawns = cp / 100;
    return `${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(1)}`;
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

  // The server's completeness codes ("complete" | "partial-shallow,no-maia" ...) as
  // human copy — the raw codes ("— no-maia") must never reach the page.
  const COVERAGE_COPY = {
    complete: "complete",
    "partial-shallow": "some positions searched below the target depth",
    "no-maia": "no human-move model (Maia)",
  };
  function coverageCopy(completeness) {
    const codes = String(completeness || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!codes.length) return "partial";
    return codes.map((c) => COVERAGE_COPY[c] || c.replace(/-/g, " ")).join("; ");
  }

  // A-05: one short "what this run covered" line — complete vs partial-shallow
  // vs no-Maia — with the raw metadata tucked into a disclosure. A report must
  // never imply uniform full-depth coverage it did not have.
  function qualitySummaryHtml() {
    const quality = appState.analysis && appState.analysis.quality;
    if (!quality) return "";
    const parts = [];
    if (quality.search === "full") {
      parts.push(`Stockfish depth ${quality.actual_depth_max}`);
    } else if (quality.search === "partial-shallow") {
      parts.push(
        `partial search (${quality.shallow_positions} positions below depth ${quality.target_depth})`,
      );
    }
    parts.push(quality.maia && quality.maia.available ? "Maia on" : "no Maia");
    const complete = quality.completeness === "complete";
    const rows = [
      ["coverage", coverageCopy(quality.completeness)],
      ["target depth", quality.target_depth],
      ["actual depth", `${quality.actual_depth_min}–${quality.actual_depth_max} (avg ${quality.actual_depth_avg})`],
      ["shallow positions", quality.shallow_positions],
      ["terminal positions", quality.terminal_positions],
      ["Maia", quality.maia?.available ? `maia3${quality.maia.rating ? ` @ ${quality.maia.rating}` : ""}` : "not run"],
      ["engine", quality.engine],
      ["classification", quality.classification_version],
      ["explanation", quality.explanation_version],
    ]
      .map(([k, v]) => `<div><b>${escapeHtml(String(k))}</b> ${escapeHtml(String(v))}</div>`)
      .join("");
    return (
      `<details class="quality-note">` +
      `<summary>${complete ? "✓" : "△"} Analysis quality: ${escapeHtml(parts.join(" · "))}</summary>` +
      `<div class="quality-rows">${rows}</div>` +
      `</details>`
    );
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
      (g) =>
        `<span class="cbar-key"><i class="seg-${g.key}"></i>${classBadgeSymbol(g.members[0])} ${g.label}</span>`
    ).join("");

    host.innerHTML =
      `<div class="class-bars">` +
      rowHtml("white", "White") +
      rowHtml("black", "Black") +
      `<div class="cbar-legend">${legend}</div>` +
      `</div>` +
      qualitySummaryHtml();

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

  // Current position's evaluation beside the chart title: one short number
  // ("+1.4"), not a sentence — the hover tooltip carries the detail.
  function updateChartCaption(point) {
    const el = document.getElementById("analysis-chart-caption");
    if (!el) return;
    el.textContent = point ? formatPointEval(point) : "";
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
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
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
