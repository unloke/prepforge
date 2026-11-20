import { html, raw } from "../../html.js";
// Shared move-tree HTML renderer (lazy-loaded from app.js for Build; static import
// from analyze.js). Pure render + click binding — no appState or navigation.

const SafeHtml = html``.constructor;
const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const HTML_UNSAFE = /[&<>"']/;
const HTML_MATCHES = /[&<>"']/g;

function escapeHtml(value) {
  const str = String(value ?? "");
  return HTML_UNSAFE.test(str) ? str.replace(HTML_MATCHES, (c) => HTML_ENTITIES[c]) : str;
}

function pushHtmlValue(chunks, value) {
  if (!value) return;
  if (value instanceof SafeHtml) {
    chunks.push(value.value);
    return;
  }
  chunks.push(escapeHtml(value));
}

let lastPointer = "mouse";
const swallowClick = (event) => {
  event.stopPropagation();
  event.preventDefault();
};

export function createMoveTreeRenderer() {
  // Screen readers get the SAN alone ("e4"), which no one can act on. Name the
  // button the way a person reads the line: move number and side, the SAN, and
  // the grade (or "variation") when the view decorates one.
  function moveTokenLabel(san, moveNumber, side, decoration) {
    const num = moveNumber == null ? "" : `${moveNumber}${side === "black" ? "..." : "."}`;
    return [`${num} ${san}`, side === "black" ? "Black" : "White", decoration].filter(Boolean).join(", ");
  }

  function pushMoveToken(chunks, node, opts, forceNumber, inVar) {
    const side = opts.sideOf ? opts.sideOf(node) : node.side;
    const moveNumber = opts.moveNumberOf ? opts.moveNumberOf(node) : node.moveNumber;
    const isWhite = side === "white";
    const showNum = isWhite || forceNumber;
    const deco = (opts.decorate && opts.decorate(node)) || {};
    // The side places the move in its column where a view sets the main line
    // as a score sheet (Build).
    const classes = ["mtree-move", isWhite ? "is-w" : "is-b"];
    if (deco.classes) classes.push(...deco.classes);
    const isCurrent = node.id === opts.currentId;
    if (isCurrent) classes.push("is-current");
    else if (opts.pathIds && opts.pathIds.has(node.id)) classes.push("on-path");
    const label = moveTokenLabel(node.san, moveNumber, side, deco.label);
    const wrapTok = inVar && showNum;
    if (wrapTok) chunks.push(`<span class="mtree-tok">`);
    if (showNum) {
      chunks.push(`<span class="mtree-num">${escapeHtml(moveNumber)}${isWhite ? "." : "…"}</span>`);
    }
    chunks.push(
      `<button class="${escapeHtml(classes.join(" "))}" data-node-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(label)}"`,
    );
    if (deco.title) chunks.push(` title="${escapeHtml(deco.title)}"`);
    if (deco.disabled) chunks.push(` disabled`);
    if (isCurrent) chunks.push(` aria-current="true"`);
    chunks.push(`><span class="mtree-san">${escapeHtml(node.san)}</span>`);
    pushHtmlValue(chunks, deco.suffix);
    // A pointer's way to the move menu: a ⋯ that shows while the move is
    // hovered. Keyboards reach the same menu with the context-menu key.
    if (opts.moveMenu && !deco.disabled) chunks.push(`<span class="mtree-more" aria-hidden="true">⋯</span>`);
    chunks.push(`</button>`);
    if (wrapTok) chunks.push(`</span>`);
    pushHtmlValue(chunks, deco.after);
  }

  // Walk the line from startNode, emitting each move's alternatives right after
  // it, as PGN does: "5. Be2 c5 (5... Nd7)". `alts` are startNode's own
  // siblings. A variation (pushMoveVariation) starts on the branch's own
  // first move: its next move continues just that branch, so it is never
  // interleaved with the parent line's other branches.
  function pushMoveLine(chunks, startNode, opts, alts = [], inVar = false) {
    let cur = startNode;
    let pending = alts;
    let forceNumber = true;
    while (cur) {
      pushMoveToken(chunks, cur, opts, forceNumber, inVar);
      forceNumber = false;
      for (const alt of pending) {
        pushMoveVariation(chunks, alt, opts);
        forceNumber = true;
      }
      // The mainline is the continuation the repertoire marks as main
      // (is_mainline), not whichever sibling the flat node list happens to
      // list first: Build's fork bar and the server both call 3...Bf5 the
      // mainline even when 3...Na6 arrives earlier in the payload. A child
      // without the flag (Analyze's variation tree) falls back to array order.
      const kids = childrenOf(cur, opts);
      pending = kids.length > 1 ? kids.slice(1) : [];
      cur = kids[0] || null;
    }
  }

  function pushMoveVariation(chunks, firstNode, opts) {
    const collapsed =
      opts.collapsible && opts.isCollapsed && opts.isCollapsed(firstNode);
    // The variation that leads to the shown move carries the accent rail. It is
    // decided here, while the node's place in the line is known: asking CSS
    // instead (`:has(> .mtree-move.is-current)`) made every class change on a
    // move re-evaluate a subtree selector over the whole tree — 96 ms per
    // navigation at 10,000 moves, against 0.4 ms with the rule gone.
    const onPath = opts.pathIds && opts.pathIds.has(firstNode.id);
    const leads = firstNode.id === opts.currentId || onPath;
    chunks.push(`<div class="mtree-var${leads ? " is-on-path" : ""}">`);
    if (opts.collapsible) {
      chunks.push(
        `<button class="mtree-collapse" type="button" data-collapse-id="${escapeHtml(firstNode.id)}" title="${collapsed ? "Expand" : "Collapse"} variation">${collapsed ? "▸" : "▾"}</button>`,
      );
    }
    if (collapsed) {
      chunks.push(`<span class="mtree-collapsed">…</span>`);
    } else {
      pushMoveLine(chunks, firstNode, opts, [], true);
    }
    chunks.push(`</div>`);
  }

  function renderMoveVariation(firstNode, opts) {
    const chunks = [];
    pushMoveVariation(chunks, firstNode, opts);
    // eslint-disable-next-line local/trusted-raw -- built from static markup and escapeHtml/SafeHtml values
    return raw(chunks.join(""));
  }

  // Build's flat payload arrives in arbitrary order (see the test next door).
  function mainlineFirst(kids) {
    const index = kids.findIndex((kid) => kid && kid.raw && kid.raw.is_mainline);
    if (index <= 0) return kids;
    return [kids[index], ...kids.slice(0, index), ...kids.slice(index + 1)];
  }

  function childrenOf(node, opts) {
    return opts.orderedChildren ? opts.orderedChildren(node) : mainlineFirst(node.children || []);
  }

  function renderMoveTree(root, opts) {
    const kids = childrenOf(root, opts);
    const chunks = [`<div class="mtree">`];
    if (!kids.length) {
      chunks.push(`<div class="empty-state">${escapeHtml(opts.emptyText || "No moves yet.")}</div></div>`);
    } else {
      const [main, ...alts] = kids;
      chunks.push(`<div class="mtree-line is-main">`);
      pushMoveLine(chunks, main, opts, alts);
      chunks.push(`</div></div>`);
    }
    // eslint-disable-next-line local/trusted-raw -- built from static markup and escapeHtml/SafeHtml values
    return raw(chunks.join(""));
  }

  // Brings el into view inside the nearest box that scrolls: the container itself, or
  // (when the container grows with its content, as the phone layout lets it) the panel
  // around it. A one-line strip (the phone's sticky move strip) only centres el.
  function scrollIntoViewWithin(container, el) {
    if (!container || !el) return;
    if (container.scrollWidth > container.clientWidth + 1) {
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      // Centre the move, then snap back to the start of the token that would
      // sit cut at the left edge, so a strip never opens on half a move
      // ("6??" sliced by the screen edge).
      const toContent = container.scrollLeft - cRect.left;
      let target = eRect.left + eRect.width / 2 - (cRect.left + cRect.width / 2) + container.scrollLeft;
      // Near the end the browser would clamp the centring scroll and leave
      // whatever it lands on cut; clamp first so the snap below sees it.
      target = Math.min(target, container.scrollWidth - container.clientWidth);
      for (const tok of container.querySelectorAll(".mtree-num, .mtree-move")) {
        const r = tok.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right + toContent > target + 0.5) {
          if (r.left + toContent < target) target = r.left + toContent;
          break;
        }
      }
      container.scrollLeft = Math.max(0, target);
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

    container.addEventListener("touchend", (event) => {
      if (pressedId === null) return;
      // Suppress compatibility mouse events before they light-dismiss the popover.
      event.preventDefault();
      pressedId = null;
      document.removeEventListener("click", swallowClick, true);
    }, { passive: false });

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

  return {
    renderMoveTree,
    renderMoveVariation,
    scrollIntoViewWithin,
    bindMoveTreeClicks,
    updateMoveTreeSelection,
  };
}
