// Build tab tree/header rendering (lazy-loaded from app.js).

export function createBuildView({
  appState,
  escapeHtml,
  boards,
  getMoveTreeRenderer,
  ensureMoveTreeRenderer,
  selectBuildNode,
  openNodeContextMenu,
  buildBranchContext,
  onTreeRendered = () => {},
}) {
  function buildPath(nodeId) {
    const path = [];
    let current = appState.buildNodeById.get(nodeId);
    while (current) {
      path.push(current);
      current = current.parent_id ? appState.buildNodeById.get(current.parent_id) : null;
    }
    return path.reverse();
  }

  function buildNormalizedTree() {
    if (!appState.build) return null;
    const childrenByParent = new Map();
    let rootNode = null;
    for (const node of appState.build.nodes) {
      if (node.depth === 0) {
        rootNode = node;
        continue;
      }
      if (!childrenByParent.has(node.parent_id)) childrenByParent.set(node.parent_id, []);
      childrenByParent.get(node.parent_id).push(node);
    }
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
    }
    if (!rootNode) return null;
    const make = (bnode) => ({
      id: bnode.id,
      san: bnode.san,
      moveNumber: bnode.move_number,
      side: bnode.move_side,
      raw: bnode,
      children: (childrenByParent.get(bnode.id) || []).map(make),
    });
    return make(rootNode);
  }

  function renderBuildRepHeader() {
    const nameEl = document.getElementById("build-rep-name");
    if (!nameEl) return;
    if (!appState.build) {
      nameEl.textContent = "No repertoire open";
      return;
    }
    nameEl.innerHTML =
      `<span class="color-dot ${escapeHtml(appState.build.color)}"></span>` +
      `<b>${escapeHtml(appState.build.name)}</b>` +
      `<span class="rep-color-sub"> · ${escapeHtml(appState.build.color)}</span>`;
  }

  // Position trail: Start › 1.e4 › c6 › … — every crumb jumps to that node.
  function renderBuildBreadcrumb() {
    const root = appState.build && appState.build.nodes.find((n) => n.depth === 0);
    const path = buildPath(appState.buildCurrentNodeId).filter((n) => n.depth > 0);
    const start = root
      ? `<button class="mtree-crumb${path.length ? "" : " is-current"}" data-node-id="${escapeHtml(String(root.id))}">Start</button>`
      : '<span class="crumb-empty">Start</span>';
    const inner = path
      .map((node, i) => {
        const prev = i > 0 ? path[i - 1] : null;
        const isWhite = node.move_side === "white";
        const needNumber = i === 0 || isWhite || !prev || prev.move_side !== "white";
        const numberHtml = needNumber
          ? `<span class="mtree-num">${node.move_number}${isWhite ? "." : "…"}</span>`
          : "";
        const cur = node.id === appState.buildCurrentNodeId ? " is-current" : "";
        return (
          '<span class="crumb-sep" aria-hidden="true">›</span>' +
          numberHtml +
          `<button class="mtree-crumb${cur}" data-node-id="${escapeHtml(node.id)}">` +
          `${escapeHtml(node.san)}</button>`
        );
      })
      .join("");
    return `<nav class="crumbs" aria-label="Position">${start}${inner}</nav>`;
  }

  function renderBuildBranchBar() {
    const bar = document.getElementById("build-branchbar");
    if (!bar) return;
    const ctx = buildBranchContext();
    if (!ctx) {
      bar.hidden = true;
      bar.innerHTML = "";
      if (boards.build) boards.build.setBranchArrows([]);
      return;
    }
    const picked = ctx.options.find((n) => n.id === ctx.choiceId);
    const chips = ctx.options
      .map((n) => {
        const isWhite = n.move_side === "white";
        const num = `${n.move_number}${isWhite ? "." : "…"}`;
        const cls = [
          "fork-chip",
          n.id === ctx.choiceId ? "is-active" : "",
          n.is_mainline ? "is-main" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const mainMark = n.is_mainline ? '<i title="Mainline">★</i>' : "";
        // Practical share: the server's real Maia probability for this move
        // (human-likeness at the repertoire's rating). Manual/imported moves have
        // none — show nothing rather than a made-up number.
        const share =
          typeof n.maia_probability === "number" && n.maia_probability > 0
            ? `<small>${Math.round(n.maia_probability * 100)}%</small>`
            : "";
        return (
          `<button class="${cls}" type="button" data-node-id="${escapeHtml(String(n.id))}" ` +
          `title="Play ${escapeHtml(n.san)}"><span class="mtree-num">${num}</span>` +
          `${escapeHtml(n.san)}${mainMark}${share}</button>`
        );
      })
      .join("");
    bar.hidden = false;
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Fork — pick the next move");
    bar.innerHTML =
      `<div class="fork-head"><b>Fork — pick the next move</b>` +
      `<span class="count">${ctx.options.length}</span>` +
      `<span class="keys"><kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>→</kbd> play · <kbd>←</kbd> back</span></div>` +
      `<div class="fork-chips">${chips}</div>`;
    bar.querySelectorAll(".fork-chip[data-node-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        void selectBuildNode(btn.dataset.nodeId).catch(() => {});
        btn.blur();
      });
    });
    if (boards.build) {
      boards.build.setBranchArrows(
        ctx.options.map((n) => n.uci).filter(Boolean),
        picked ? picked.uci : null
      );
    }
  }

  // Mastery legend beside the breadcrumbs: mirrors the heatmap classes the tree
  // actually paints (see .mtree-move.m-* below). Only shown when the repertoire
  // has at least one trained own-side node — never a decorative always-on row.
  function renderMasteryLegend() {
    const kinds = ["mastered", "learning", "due", "weak"];
    const present = new Set(
      (appState.build ? appState.build.nodes : [])
        .filter((n) => n.depth > 0 && n.is_enabled && n.mastery)
        .map((n) => n.mastery),
    );
    const items = kinds.filter((k) => present.has(k));
    if (!items.length) return "";
    return (
      '<div class="legend" aria-label="Mastery legend">' +
      items.map((k) => `<span><i class="k-${k}"></i>${k}</span>`).join("") +
      "</div>"
    );
  }

  function renderTreeMeta(withLegend) {
    const meta = document.getElementById("build-tree-meta");
    if (!meta) return;
    meta.hidden = !appState.build;
    meta.innerHTML = appState.build
      ? renderBuildBreadcrumb() + (withLegend ? renderMasteryLegend() : "")
      : "";
    meta.querySelectorAll(".mtree-crumb[data-node-id]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        void selectBuildNode(btn.dataset.nodeId).catch(() => {});
        event.currentTarget.blur();
      });
    });
  }

  function renderBuilderTree() {
    const container = document.getElementById("builder-tree");
    const branchBar = document.getElementById("build-branchbar");
    if (!appState.build) {
      renderTreeMeta(false);
      container.innerHTML =
        '<div class="tree-empty">No repertoire open. Pick one from the Library, or play a move to start.</div>';
      if (branchBar) branchBar.hidden = true;
      if (boards.build) boards.build.setBranchArrows([]);
      onTreeRendered();
      return;
    }
    const root = buildNormalizedTree();
    if (!root || !root.children.length) {
      renderTreeMeta(false);
      container.innerHTML = '<div class="tree-empty">Play a move to add it to this line.</div>';
      if (branchBar) branchBar.hidden = true;
      if (boards.build) boards.build.setBranchArrows([]);
      onTreeRendered();
      return;
    }
    const moveTreeRenderer = getMoveTreeRenderer();
    if (!moveTreeRenderer) {
      void ensureMoveTreeRenderer()
        .then(() => renderBuilderTree())
        .catch(() => {});
      return;
    }
    const collapsed = appState.buildCollapsed || (appState.buildCollapsed = new Set());
    const pathIds = new Set(buildPath(appState.buildCurrentNodeId).map((n) => n.id));
    const treeHtml = moveTreeRenderer.renderMoveTree(root, {
      currentId: appState.buildCurrentNodeId,
      pathIds,
      collapsible: true,
      isCollapsed: (node) => collapsed.has(node.id),
      decorate: (node) => {
        const b = node.raw;
        const classes = [];
        if (b.mastery) classes.push(`m-${b.mastery}`);
        if (!b.is_enabled) classes.push("is-disabled");
        if (b.is_mainline) classes.push("is-main");
        if (b.move_side !== appState.build.color) classes.push("is-opp");
        if (b.is_prepared) classes.push("is-prep");
        return { classes };
      },
    });
    renderTreeMeta(true);
    container.innerHTML = treeHtml;
    container.querySelectorAll(".mtree-collapse[data-collapse-id]").forEach((toggle) => {
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = toggle.dataset.collapseId;
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        renderBuilderTree();
      });
    });
    moveTreeRenderer.bindMoveTreeClicks(
      container,
      (id) => void selectBuildNode(id).catch(() => {}),
      (event, id) => openNodeContextMenu(event, id)
    );
    const focusBtn = container.querySelector(".mtree .mtree-move.is-current");
    if (focusBtn) moveTreeRenderer.scrollIntoViewWithin(container, focusBtn);
    renderBuildBranchBar();
    onTreeRendered();
  }

  return {
    renderBuildRepHeader,
    renderBuilderTree,
    renderBuildBreadcrumb,
    renderBuildBranchBar,
  };
}
