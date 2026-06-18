// Shared move-tree HTML renderer (lazy-loaded from app.js for Build; static import
// from analyze.js). Pure render + click binding — no appState or navigation.

export function createMoveTreeRenderer({ escapeHtml }) {
  function renderMoveToken(node, opts, forceNumber) {
    const isWhite = node.side === "white";
    const numHtml =
      isWhite || forceNumber
        ? `<span class="mtree-num">${node.moveNumber}${isWhite ? "." : "…"}</span>`
        : "";
    const deco = (opts.decorate && opts.decorate(node)) || {};
    const classes = ["mtree-move"];
    if (deco.classes) classes.push(...deco.classes);
    if (node.id === opts.currentId) classes.push("is-current");
    else if (opts.pathIds && opts.pathIds.has(node.id)) classes.push("on-path");
    const title = deco.title ? ` title="${escapeHtml(String(deco.title))}"` : "";
    return (
      `${numHtml}<button class="${classes.join(" ")}" data-node-id="${escapeHtml(
        String(node.id)
      )}"${title}><span class="mtree-san">${escapeHtml(node.san)}</span>${
        deco.suffix || ""
      }</button>`
    );
  }

  function renderMoveLine(startNode, opts) {
    let html = "";
    let cur = startNode;
    let forceNumber = true;
    while (cur) {
      html += renderMoveToken(cur, opts, forceNumber);
      forceNumber = false;
      const kids = cur.children || [];
      const main = kids[0] || null;
      for (let i = 1; i < kids.length; i += 1) {
        html += renderMoveVariation(kids[i], opts);
        forceNumber = true;
      }
      cur = main;
    }
    return html;
  }

  function renderMoveVariation(firstNode, opts) {
    const collapsed =
      opts.collapsible && opts.isCollapsed && opts.isCollapsed(firstNode);
    const toggle = opts.collapsible
      ? `<button class="mtree-collapse" type="button" data-collapse-id="${escapeHtml(
          String(firstNode.id)
        )}" title="${collapsed ? "Expand" : "Collapse"} variation">${
          collapsed ? "▸" : "▾"
        }</button>`
      : "";
    const inner = collapsed
      ? '<span class="mtree-collapsed">…</span>'
      : renderMoveLine(firstNode, opts);
    return `<div class="mtree-var">${toggle}${inner}</div>`;
  }

  function renderMoveTree(root, opts) {
    const kids = root.children || [];
    if (!kids.length) {
      return (
        '<div class="mtree"><div class="empty-state">' +
        escapeHtml(opts.emptyText || "No moves yet.") +
        "</div></div>"
      );
    }
    const main = kids[0];
    const alts = kids.slice(1);
    let body = renderMoveLine(main, opts);
    for (const alt of alts) body += renderMoveVariation(alt, opts);
    return `<div class="mtree"><div class="mtree-line is-main">${body}</div></div>`;
  }

  function scrollIntoViewWithin(container, el) {
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const overTop = eRect.top - cRect.top;
    const overBottom = eRect.bottom - cRect.bottom;
    if (overTop >= 0 && overBottom <= 0) return;
    if (overTop < 0 && overBottom > 0) return;
    container.scrollTop += overTop < 0 ? overTop : overBottom;
  }

  function bindMoveTreeClicks(container, onSelect, onContext) {
    container.querySelectorAll(".mtree-move[data-node-id]").forEach((button) => {
      button.addEventListener("click", (event) => {
        onSelect(button.dataset.nodeId);
        event.currentTarget.blur();
      });
      if (onContext) {
        button.addEventListener("contextmenu", (event) =>
          onContext(event, button.dataset.nodeId)
        );
      }
    });
  }

  return { renderMoveTree, scrollIntoViewWithin, bindMoveTreeClicks };
}