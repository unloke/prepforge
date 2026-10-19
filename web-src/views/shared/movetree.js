import { html } from "../../html.js";
// Shared move-tree HTML renderer (lazy-loaded from app.js for Build; static import
// from analyze.js). Pure render + click binding — no appState or navigation.

let lastPointer = "mouse";
const swallowClick = (event) => {
  event.stopPropagation();
  event.preventDefault();
};

export function createMoveTreeRenderer() {
  // Screen readers get the SAN alone ("e4"), which no one can act on. Name the
  // button the way a person reads the line: move number and side, the SAN, and
  // the grade (or "variation") when the view decorates one.
  function moveTokenLabel(node, deco) {
    const num = node.moveNumber == null ? "" : `${node.moveNumber}${node.side === "black" ? "..." : "."}`;
    const side = node.side === "black" ? "Black" : "White";
    return [`${num} ${node.san}`, side, deco.label].filter(Boolean).join(", ");
  }

  function renderMoveToken(node, opts, forceNumber) {
    const isWhite = node.side === "white";
    const numHtml =
      isWhite || forceNumber
        ? html`<span class="mtree-num">${node.moveNumber}${isWhite ? "." : "…"}</span>`
        : "";
    const deco = (opts.decorate && opts.decorate(node)) || {};
    const classes = ["mtree-move"];
    if (deco.classes) classes.push(...deco.classes);
    if (node.id === opts.currentId) classes.push("is-current");
    else if (opts.pathIds && opts.pathIds.has(node.id)) classes.push("on-path");
    const title = deco.title ? html` title="${String(deco.title)}"` : "";
    const label = moveTokenLabel(node, deco);
    return (
      html`${numHtml}<button class="${classes.join(" ")}" data-node-id="${String(node.id)}" aria-label="${label}"${title}><span class="mtree-san">${node.san}</span>${deco.suffix || ""}</button>`
    );
  }

  // Walk the line from startNode, emitting its alternatives beside it. A
  // variation (renderMoveVariation) starts on the branch's own first move: its
  // next move continues just that branch, so it is never interleaved with the
  // parent line's other branches.
  function renderMoveLine(startNode, opts) {
    const markup = [];
    let cur = startNode;
    let forceNumber = true;
    while (cur) {
      markup.push(renderMoveToken(cur, opts, forceNumber));
      forceNumber = false;
      // The mainline is the continuation the repertoire marks as main
      // (is_mainline), not whichever sibling the flat node list happens to
      // list first: Build's fork bar and the server both call 3...Bf5 the
      // mainline even when 3...Na6 arrives earlier in the payload. A child
      // without the flag (Analyze's variation tree) falls back to array order.
      const kids = mainlineFirst(cur.children || []);
      for (const alt of kids.slice(1)) {
        markup.push(renderMoveVariation(alt, opts));
        forceNumber = true;
      }
      cur = kids[0] || null;
    }
    return html`${markup}`;
  }

  function renderMoveVariation(firstNode, opts) {
    const collapsed =
      opts.collapsible && opts.isCollapsed && opts.isCollapsed(firstNode);
    const toggle = opts.collapsible
      ? html`<button class="mtree-collapse" type="button" data-collapse-id="${String(firstNode.id)}" title="${collapsed ? "Expand" : "Collapse"} variation">${collapsed ? "▸" : "▾"}</button>`
      : "";
    const inner = collapsed
      ? html`<span class="mtree-collapsed">…</span>`
      : renderMoveLine(firstNode, opts);
    return html`<div class="mtree-var">${toggle}${inner}</div>`;
  }

  // Build's flat payload arrives in arbitrary order (see the test next door).
  function mainlineFirst(kids) {
    const index = kids.findIndex((kid) => kid && kid.raw && kid.raw.is_mainline);
    if (index <= 0) return kids;
    return [kids[index], ...kids.slice(0, index), ...kids.slice(index + 1)];
  }

  function renderMoveTree(root, opts) {
    const kids = root.children || [];
    if (!kids.length) {
      return (
        html`<div class="mtree"><div class="empty-state">${opts.emptyText || "No moves yet."}</div></div>`
      );
    }
    const ordered = mainlineFirst(kids);
    const main = ordered[0];
    const alts = ordered.slice(1);
    const body = [renderMoveLine(main, opts), ...alts.map((alt) => renderMoveVariation(alt, opts))];
    return html`<div class="mtree"><div class="mtree-line is-main">${body}</div></div>`;
  }

  // Brings el into view inside the nearest box that scrolls: the container itself, or
  // (when the container grows with its content, as the phone layout lets it) the panel
  // around it. A one-line strip (the phone's sticky move strip) only centres el.
  function scrollIntoViewWithin(container, el) {
    if (!container || !el) return;
    if (container.scrollWidth > container.clientWidth + 1) {
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      container.scrollLeft += eRect.left + eRect.width / 2 - (cRect.left + cRect.width / 2);
      return;
    }
    const scrolls = (b) =>
      b.scrollHeight > b.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(b).overflowY);
    let box = container;
    while (box && !scrolls(box)) box = box.parentElement;
    if (!box || box === document.body || box === document.documentElement) return;
    const cRect = box.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const overTop = eRect.top - cRect.top;
    const overBottom = eRect.bottom - cRect.bottom;
    if (overTop >= 0 && overBottom <= 0) return;
    if (overTop < 0 && overBottom > 0) return;
    box.scrollTop += overTop < 0 ? overTop : overBottom;
  }

  // Touch screens have no right-click (iOS fires no contextmenu at all), so a
  // long press, or a tap on the move already shown, opens the move menu there.
  function bindMoveTreeClicks(container, onSelect, onContext) {
    container.querySelectorAll(".mtree-move[data-node-id]").forEach((button) => {
      const id = button.dataset.nodeId;
      let press = 0;
      let pressed = false;
      let start = null;
      button.addEventListener("click", (event) => {
        if (onContext && lastPointer === "touch" && button.classList.contains("is-current")) {
          // The menu's outside-click close listens on document; keep this tap off it.
          event.stopPropagation();
          onContext(event, id);
          return;
        }
        onSelect(id);
        event.currentTarget.blur();
      });
      if (!onContext) return;
      // The move menu has no visible button; the tooltip says where it is.
      if (!button.title) button.title = "Right-click for move options";
      button.addEventListener("contextmenu", (event) => {
        if (pressed) event.preventDefault();
        else onContext(event, id);
      });
      button.addEventListener("pointerdown", (event) => {
        lastPointer = event.pointerType;
        pressed = false;
        if (event.pointerType !== "touch") return;
        clearTimeout(press);
        start = event;
        press = setTimeout(() => {
          pressed = true;
          // Letting go clicks wherever the finger is (the tree may have
          // redrawn under it); that click must not close the menu it opened.
          document.addEventListener("click", swallowClick, { capture: true, once: true });
          setTimeout(() => document.removeEventListener("click", swallowClick, true), 1000);
          onContext(start, id);
        }, 450);
      });
      for (const type of ["pointerup", "pointercancel", "pointermove"]) {
        button.addEventListener(type, (event) => {
          if (type === "pointermove" && start && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 8) return;
          clearTimeout(press);
        });
      }
    });
  }

  return { renderMoveTree, scrollIntoViewWithin, bindMoveTreeClicks };
}
