// Analyze tab rendering (lazy-loaded from app.js). Classification bars, eval chart,
// move tree, and results orchestration.

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
        blunder: "!",
        missed: "x",
      }[group] || "."
    );
  }

  const EVAL_MARKER_COLORS = {
    brilliant: "#2f7fe0",
    inaccuracy: "#cda04b",
    mistake: "#c98439",
    blunder: "#c4524d",
    missed: "#8a6db5",
  };

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
    const points = appState.evalChartPoints || [];
    if (!points.length) {
      marker.setAttribute("x1", "-10");
      marker.setAttribute("x2", "-10");
      return;
    }
    const ply = appState.analysisPly;
    const idx = points.findIndex((p) => p.ply === ply);
    if (idx < 0) {
      marker.setAttribute("x1", "-10");
      marker.setAttribute("x2", "-10");
      return;
    }
    const width = 640;
    const x = points.length === 1 ? width / 2 : (idx / (points.length - 1)) * width;
    marker.setAttribute("x1", String(x));
    marker.setAttribute("x2", String(x));
  }

  function renderEvalChart(points) {
    const chart = document.getElementById("eval-chart");
    chart.innerHTML = "";
    appState.evalChartPoints = points || [];
    const width = 640;
    const height = 96;
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    chart.setAttribute("preserveAspectRatio", "none");
    chart.setAttribute("aria-label", "Evaluation trend by move");
    chart.style.cursor = points && points.length ? "pointer" : "default";

    const axis = document.createElementNS("http://www.w3.org/2000/svg", "line");
    axis.setAttribute("x1", "0");
    axis.setAttribute("x2", String(width));
    axis.setAttribute("y1", String(height / 2));
    axis.setAttribute("y2", String(height / 2));
    axis.setAttribute("stroke", "#d6d2cb");
    axis.setAttribute("stroke-dasharray", "4 4");
    chart.appendChild(axis);
    if (!points || !points.length) return;

    const coords = points.map((point, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height / 2 - (point.bounded_score_cp / 1000) * (height / 2 - 8);
      return { x, y, ply: point.ply, classification: point.classification };
    });

    const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    const areaPoints = [
      `0,${height / 2}`,
      ...coords.map((c) => `${c.x},${c.y}`),
      `${width},${height / 2}`,
    ].join(" ");
    area.setAttribute("points", areaPoints);
    area.setAttribute("fill", "rgba(209, 139, 63, 0.18)");
    chart.appendChild(area);

    const svgNS = "http://www.w3.org/2000/svg";
    const polyline = document.createElementNS(svgNS, "polyline");
    polyline.setAttribute("points", coords.map((c) => `${c.x},${c.y}`).join(" "));
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", "#b9722a");
    polyline.setAttribute("stroke-width", "2");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    chart.appendChild(polyline);

    coords.forEach((c) => {
      const raw = String(c.classification || "").toLowerCase();
      const cls = CLASS_GROUP_OF[raw] || raw;
      const color = EVAL_MARKER_COLORS[cls];
      if (!color) return;
      const dot = document.createElementNS(svgNS, "ellipse");
      dot.classList.add("eval-marker");
      dot.setAttribute("cx", String(c.x));
      dot.setAttribute("cy", String(c.y));
      dot.setAttribute("fill", color);
      dot.setAttribute("stroke", "#fff");
      dot.setAttribute("stroke-width", "1.5");
      dot.setAttribute("vector-effect", "non-scaling-stroke");
      dot.setAttribute("data-ply", String(c.ply));
      dot.dataset.baseR = "4.5";
      dot.style.cursor = "pointer";
      const title = document.createElementNS(svgNS, "title");
      title.textContent = cls.charAt(0).toUpperCase() + cls.slice(1);
      dot.appendChild(title);
      dot.addEventListener("click", (event) => {
        event.stopPropagation();
        showAnalysisPly(c.ply);
      });
      chart.appendChild(dot);
    });
    rescaleEvalMarkers();

    const marker = document.createElementNS("http://www.w3.org/2000/svg", "line");
    marker.setAttribute("id", "eval-chart-cursor");
    marker.setAttribute("y1", "0");
    marker.setAttribute("y2", String(height));
    marker.setAttribute("stroke", "#b9722a");
    marker.setAttribute("stroke-width", "1.5");
    marker.setAttribute("stroke-dasharray", "3 3");
    marker.setAttribute("x1", "-10");
    marker.setAttribute("x2", "-10");
    chart.appendChild(marker);

    updateEvalChartCursor();
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
    renderMoveTree,
    bindMoveTreeClicks,
    scrollIntoViewWithin,
  };
}