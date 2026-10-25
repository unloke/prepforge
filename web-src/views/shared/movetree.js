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

  function renderMoveToken(node, opts, forceNumber, inVar) {
    const isWhite = node.side === "white";
    const numHtml =
      isWhite || forceNumber
        ? html`<span class="mtree-num">${node.moveNumber}${isWhite ? "." : "…"}</span>`
        : "";
    const deco = (opts.decorate && opts.decorate(node)) || {};
    // The side places the move in its column where a view sets the main line
    // as a score sheet (Build).
    const classes = ["mtree-move", isWhite ? "is-w" : "is-b"];
    if (deco.classes) classes.push(...deco.classes);
    const isCurrent = node.id === opts.currentId;
    if (isCurrent) classes.push("is-current");
    else if (opts.pathIds && opts.pathIds.has(node.id)) classes.push("on-path");
    const title = deco.title ? html` title="${String(deco.title)}"` : "";
    const label = moveTokenLabel(node, deco);
    // A pointer's way to the move menu: a ⋯ that shows while the move is
    // hovered. Keyboards reach the same menu with the context-menu key.
    const more = opts.moveMenu ? html`<span class="mtree-more" aria-hidden="true">⋯</span>` : "";
    const button = html`<button class="${classes.join(" ")}" data-node-id="${String(node.id)}" aria-label="${label}"${title}${isCurrent ? html` aria-current="true"` : ""}><span class="mtree-san">${node.san}</span>${deco.suffix || ""}${more}</button>`;
    // In a flowing variation a line could break between "8." and its move; the main
    // line keeps them apart as its score sheet's grid cells.
    const token = inVar && numHtml ? html`<span class="mtree-tok">${numHtml}${button}</span>` : html`${numHtml}${button}`;
    return html`${token}${deco.after || ""}`;
  }

  // Walk the line from startNode, emitting each move's alternatives right after
  // it, as PGN does: "5. Be2 c5 (5... Nd7)". `alts` are startNode's own
  // siblings. A variation (renderMoveVariation) starts on the branch's own
  // first move: its next move continues just that branch, so it is never
  // interleaved with the parent line's other branches.
  function renderMoveLine(startNode, opts, alts = [], inVar = false) {
    const markup = [];
    let cur = startNode;
    let pending = alts;
    let forceNumber = true;
    while (cur) {
      markup.push(renderMoveToken(cur, opts, forceNumber, inVar));
      forceNumber = false;
      for (const alt of pending) {
        markup.push(renderMoveVariation(alt, opts));
        forceNumber = true;
      }
      // The mainline is the continuation the repertoire marks as main
      // (is_mainline), not whichever sibling the flat node list happens to
      // list first: Build's fork bar and the server both call 3...Bf5 the
      // mainline even when 3...Na6 arrives earlier in the payload. A child
      // without the flag (Analyze's variation tree) falls back to array order.
      const kids = mainlineFirst(cur.children || []);
      pending = kids.slice(1);
      cur = kids[0] || null;
    }
    return html`${markup}`;
  }

  function renderMoveVariation(firstNode, opts) {
    const collapsed =
      opts.collapsible && opts.isCollapsed && opts.isCollapsed(firstNode);
    // The variation that leads to the shown move carries the accent rail. It is
    // decided here, while the node's place in the line is known: asking CSS
    // instead (`:has(> .mtree-move.is-current)`) made every class change on a
    // move re-evaluate a subtree selector over the whole tree — 96 ms per
    // navigation at 10,000 moves, against 0.4 ms with the rule gone.
    const onPath = opts.pathIds && opts.pathIds.has(firstNode.id);
    const leads = firstNode.id === opts.currentId || onPath;
    const toggle = opts.collapsible
      ? html`<button class="mtree-collapse" type="button" data-collapse-id="${String(firstNode.id)}" title="${collapsed ? "Expand" : "Collapse"} variation">${collapsed ? "▸" : "▾"}</button>`
      : "";
    const inner = collapsed
      ? html`<span class="mtree-collapsed">…</span>`
      : renderMoveLine(firstNode, opts, [], true);
    return html`<div class="mtree-var${leads ? " is-on-path" : ""}">${toggle}${inner}</div>`;
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
    const [main, ...alts] = mainlineFirst(kids);
    return html`<div class="mtree"><div class="mtree-line is-main">${renderMoveLine(main, opts, alts)}</div></div>`;
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
  //
  // One set of listeners on the container, not six closures per move button: the
  // tree is re-rendered on every structural change and used to bind 6N listeners
  // each time (60,000 on a 10,000-move tree). Handlers read the move from
  // event.target, so a re-render needs no new bindings at all.
  const delegated = new WeakSet();
  function bindMoveTreeClicks(container, onSelect, onContext) {
    // A full render keeps the container element, so a second call for the same
    // container would stack a second handler and fire every action twice.
    if (delegated.has(container)) return;
    delegated.add(container);
    let pressTimer = null;
    let pressedId = null;
    let pointerStart = null;

    const moveOf = (event) => event.target?.closest?.(".mtree-move[data-node-id]") || null;
    const endPress = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
      pointerStart = null;
    };

    container.addEventListener("click", (event) => {
      const button = moveOf(event);
      if (!button) return;
      const id = button.dataset.nodeId;
      if (onContext && event.target.closest(".mtree-more")) {
        event.stopPropagation();
        onContext(event, id);
        return;
      }
      if (onContext && lastPointer === "touch" && button.classList.contains("is-current")) {
        // The menu's outside-click close listens on document; keep this tap off it.
        event.stopPropagation();
        onContext(event, id);
        return;
      }
      onSelect(id);
      button.blur();
    });

    if (!onContext) return;

    container.addEventListener("contextmenu", (event) => {
      const button = moveOf(event);
      if (!button) return;
      if (pressedId === button.dataset.nodeId) event.preventDefault();
      else onContext(event, button.dataset.nodeId);
    });

    container.addEventListener("pointerdown", (event) => {
      const button = moveOf(event);
      if (!button) return;
      lastPointer = event.pointerType;
      pressedId = null;
      if (event.pointerType !== "touch") return;
      endPress();
      pointerStart = event;
      const id = button.dataset.nodeId;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        pressedId = id;
        // Letting go clicks wherever the finger is (the tree may have
        // redrawn under it); that click must not close the menu it opened.
        document.addEventListener("click", swallowClick, { capture: true, once: true });
        setTimeout(() => document.removeEventListener("click", swallowClick, true), 1000);
        onContext(pointerStart, id);
      }, 450);
    });

    // The 8px rule: a finger that slides further than that is scrolling the
    // tree, not pressing a move, so the long press is cancelled.
    container.addEventListener("pointermove", (event) => {
      if (!pointerStart || !moveOf(event)) return;
      if (Math.hypot(event.clientX - pointerStart.clientX, event.clientY - pointerStart.clientY) < 8) return;
      endPress();
    });
    container.addEventListener("pointerup", endPress);
    container.addEventListener("pointercancel", endPress);
  }

  // Selection-only update: the old and new current move, the on-path trail and
  // the variation rails. The nodes are the ones already in the DOM, so no markup
  // is rebuilt and no listener is bound. Structure changes still go through
  // renderMoveTree.
  //
  // Returns false when the wanted move is not on screen (a collapsed branch, or
  // a tree that was never painted): the caller then renders, because there is
  // nothing here to move the mark onto. `currentId: null` means no move is
  // current (the start position) and clears the mark.
  function updateMoveTreeSelection(container, { currentId, pathIds = null }) {
    if (!container) return false;
    const previous = container.querySelector(".mtree-move.is-current");
    const want = currentId == null ? null : String(currentId);
    const moves = container.querySelectorAll(".mtree-move[data-node-id]");
    let next = null;
    for (const el of moves) {
      if (el.dataset.nodeId === want) {
        next = el;
        break;
      }
    }
    if (!next && want !== null) return false;
    if (previous === next && !pathIds) return true;
    if (previous && previous !== next) {
      previous.classList.remove("is-current");
      previous.removeAttribute("aria-current");
    }
    if (next) {
      next.classList.add("is-current");
      next.setAttribute("aria-current", "true");
    }
    // The trail is the new ancestor chain (Analyze); Build passes none and marks
    // only the shown move. A variation's rail follows the rule the render uses:
    // it is on while the variation's own first move is current or on the trail.
    // `moves` is in document order, so the first move met inside a variation is
    // that variation's first move — one pass, and nothing searched per variation.
    const rails = new Map();
    for (const el of moves) {
      const on = el !== next && !!pathIds && pathIds.has(el.dataset.nodeId);
      if (on !== el.classList.contains("on-path")) el.classList.toggle("on-path", on);
      const parent = el.parentElement;
      if (parent && parent.classList.contains("mtree-var") && !rails.has(parent)) {
        rails.set(parent, el.classList.contains("is-current") || el.classList.contains("on-path"));
      }
    }
    for (const [variation, leads] of rails) {
      if (leads !== variation.classList.contains("is-on-path")) {
        variation.classList.toggle("is-on-path", leads);
      }
    }
    return true;
  }

  return { renderMoveTree, scrollIntoViewWithin, bindMoveTreeClicks, updateMoveTreeSelection };
}
