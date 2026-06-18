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
      `${escapeHtml(appState.build.name)}` +
      `<span class="rep-color-sub"> · ${escapeHtml(appState.build.color)}</span>`;
  }

  function renderBuildBreadcrumb() {
    const path = buildPath(appState.buildCurrentNodeId).filter((n) => n.depth > 0);
    if (!path.length) {
      return (
        '<div class="build-breadcrumb">' +
        '<span class="crumb-empty">Start position - play a move or pick a line below</span>' +
        "</div>"
      );
    }
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
          numberHtml +
          `<button class="mtree-crumb${cur}" data-node-id="${escapeHtml(node.id)}">` +
          `${escapeHtml(node.san)}</button>`
        );
      })
      .join("");
    return `<div class="build-breadcrumb">${inner}</div>`;
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
          "branch-chip",
          n.id === ctx.choiceId ? "is-active" : "",
          n.is_mainline ? "is-main" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const mainMark = n.is_mainline
          ? '<span class="branch-main-mark" title="Mainline">★</span>'
          : "";
        return (
          `<button class="${cls}" type="button" data-node-id="${escapeHtml(String(n.id))}" ` +
          `title="Play ${escapeHtml(n.san)}"><span class="branch-num">${num}</span>` +
          `<span class="branch-san">${escapeHtml(n.san)}</span>${mainMark}</button>`
        );
      })
      .join("");
    bar.hidden = false;
    bar.innerHTML =
      `<div class="branchbar-head"><span class="branchbar-label">Fork — pick the next move</span>` +
      `<span class="branchbar-count">${ctx.options.length}</span>` +
      `<span class="branchbar-hint">↑ ↓ pick · → play · ← back</span></div>` +
      `<div class="branchbar-chips">${chips}</div>`;
    bar.querySelectorAll(".branch-chip[data-node-id]").forEach((btn) => {
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

  function renderBuilderTree() {
    const container = document.getElementById("builder-tree");
    const branchBar = document.getElementById("build-branchbar");
    if (!appState.build) {
      container.innerHTML =
        '<div class="empty-state">No repertoire open. Play a move on the board to start one, ' +
        'use the <b>⋯</b> menu above, or open one from the Dashboard.</div>';
      if (branchBar) branchBar.hidden = true;
      if (boards.build) boards.build.setBranchArrows([]);
      return;
    }
    const root = buildNormalizedTree();
    if (!root || !root.children.length) {
      container.innerHTML =
        renderBuildBreadcrumb() +
        '<div class="empty-state">Play a move on the board to add it to the repertoire.</div>';
      if (branchBar) branchBar.hidden = true;
      if (boards.build) boards.build.setBranchArrows([]);
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
        if (b.is_prepared) classes.push("is-prep");
        return { classes };
      },
    });
    container.innerHTML = renderBuildBreadcrumb() + treeHtml;
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
    container.querySelectorAll(".mtree-crumb[data-node-id]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        void selectBuildNode(btn.dataset.nodeId).catch(() => {});
        event.currentTarget.blur();
      });
    });
    const focusBtn = container.querySelector(".mtree .mtree-move.is-current");
    if (focusBtn) moveTreeRenderer.scrollIntoViewWithin(container, focusBtn);
    renderBuildBranchBar();
  }

  return {
    renderBuildRepHeader,
    renderBuilderTree,
    renderBuildBreadcrumb,
    renderBuildBranchBar,
  };
}