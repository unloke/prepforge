import { html } from "../html.js";
import { countOf } from "../plural.js";
import { moveTextHtml, plyOfFen } from "../move-text.js";
// Build tab tree/header rendering (lazy-loaded from app.js).

// A trained move's status, said the way a person says it. The tree paints only
// the two that ask for something (due, weak) — a bar under every own move made
// the list a heatmap nobody could read — and this is what the tooltip and the
// screen-reader label carry for every status.
const MASTERY_WORDS = {
  due: "Due for review",
  weak: "Weak — missed often",
  learning: "Learning",
  mastered: "Mastered",
  untrained: "Not trained yet",
};

// A fork in a wide repertoire can hold thirty continuations (a generated tree
// leaves one chip per reply). Painted whole it took six rows of the panel and
// pushed the move tree to its 90px floor at 1024x768. The bar now paints a
// window of chips that always contains the pick (↑/↓ slides the window with
// it) and opens the full list on request — inside a capped, scrolling block,
// so even then the tree keeps its floor. A phone's chips are wider (a thumb's
// target), so its window is shorter: two rows above the line, not three.
const FORK_WINDOW = 8;
const FORK_WINDOW_PHONE = 6;

function forkWindowSize() {
  try {
    return window.matchMedia?.("(max-width: 760px)")?.matches ? FORK_WINDOW_PHONE : FORK_WINDOW;
  } catch {
    return FORK_WINDOW;
  }
}

// The slice to paint: the pick stays inside, and the window only slides far
// enough for it (the first option keeps the left edge until the pick passes the
// middle of the window).
function forkWindow(list, pickedIndex, size) {
  if (list.length <= size) return list;
  const start = Math.max(0, Math.min(pickedIndex - Math.floor(size / 2), list.length - size));
  return list.slice(start, start + size);
}

export function createBuildView({
  appState,
  boards,
  getMoveTreeRenderer,
  ensureMoveTreeRenderer,
  selectBuildNode,
  openNodeContextMenu,
  buildBranchContext,
  isReadOnly = () => false,
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

  // ONE rule decides the head's Generate button, and only this function reads it:
  // it applies when a writable repertoire is loaded, its current position is
  // settled, and either it is the start position (generating there grows the
  // whole repertoire, so the button never leaves the place every visit
  // begins) or no move of your own already answers it there. A position that
  // owns the reply (or a read-only share, or a tree still loading) has nothing
  // for the button to do, so it stays out of the head. The move menu reaches
  // Generate at any position, so hiding it here never removes the capability.
  function generateAppliesHere() {
    if (isReadOnly()) return false;
    if (appState.buildLoading) return false;
    if (!appState.build || !appState.buildCurrentNodeId) return false;
    if (!appState.buildNodeById.get(appState.buildCurrentNodeId)?.parent_id) return true;
    const own = appState.build.color === "black" ? "black" : "white";
    return !appState.build.nodes.some(
      (n) => n.parent_id === appState.buildCurrentNodeId && n.depth > 0 && n.move_side === own
    );
  }

  // The attribute alone carries visibility — no CSS state may override it (the
  // head row used to force the button back with a :hover/:focus rule, which
  // made it appear exactly where it did not apply).
  function paintGenerateVisibility() {
    const btn = document.getElementById("build-generate-node");
    if (!btn) return;
    btn.hidden = !generateAppliesHere();
  }

  function renderBuildRepHeader() {
    const nameEl = document.getElementById("build-rep-name");
    if (!nameEl) return;
    paintGenerateVisibility();
    if (!appState.build) {
      nameEl.textContent = "No repertoire open";
      return;
    }
    nameEl.innerHTML =
      html`<span class="color-dot ${appState.build.color}"></span><b>${appState.build.name}</b><span class="rep-color-sub"> · ${appState.build.color}</span>`;
  }

  // Position trail: Start › 1.e4 › c6 › … — every crumb jumps to that node.
  function renderBuildBreadcrumb() {
    const root = appState.build && appState.build.nodes.find((n) => n.depth === 0);
    const path = buildPath(appState.buildCurrentNodeId).filter((n) => n.depth > 0);
    const start = root
      ? html`<button class="mtree-crumb${path.length ? "" : " is-current"}" data-node-id="${String(root.id)}">Start</button>`
      : html`<span class="crumb-empty">Start</span>`;
    const inner = path
      .map((node, i) => {
        const prev = i > 0 ? path[i - 1] : null;
        const isWhite = node.move_side === "white";
        const needNumber = i === 0 || isWhite || !prev || prev.move_side !== "white";
        const numberHtml = needNumber
          ? html`<span class="mtree-num">${node.move_number}${isWhite ? "." : "…"}</span>`
          : "";
        const cur = node.id === appState.buildCurrentNodeId ? " is-current" : "";
        return (
          html`<span class="crumb-sep" aria-hidden="true">›</span>${numberHtml}<button class="mtree-crumb${cur}" data-node-id="${node.id}">${node.san}</button>`
        );
      });
    return html`<nav class="crumbs" aria-label="Position">${start}${inner}</nav>`;
  }

  // Which fork is showing its whole list. Opening it is a request for this
  // position only: stepping to another line closes it again, because the reason
  // to look at all thirty moves is the position you are standing on.
  let forkExpandedFor = null;
  // Notes opened past their first line, by node id.
  const openNotes = new Set();

  function renderBuildBranchBar() {
    const bar = document.getElementById("build-branchbar");
    if (!bar) return;
    const ctx = buildBranchContext();
    if (!ctx) {
      bar.hidden = true;
      bar.innerHTML = "";
      forkExpandedFor = null;
      if (boards.build) boards.build.setBranchArrows([]);
      return;
    }
    const picked = ctx.options.find((n) => n.id === ctx.choiceId) || ctx.options[0];
    const pickedIndex = ctx.options.indexOf(picked);
    const size = forkWindowSize();
    const expanded = forkExpandedFor === appState.buildCurrentNodeId && ctx.options.length > size;
    const shown = expanded ? ctx.options : forkWindow(ctx.options, pickedIndex, size);
    const chips = shown
      .map((n) => {
        const isWhite = n.move_side === "white";
        const num = `${n.move_number}${isWhite ? "." : "…"}`;
        const cls = [
          "fork-chip",
          n.id === picked.id ? "is-active" : "",
          n.is_mainline ? "is-main" : "",
        ]
          .filter(Boolean)
          .join(" ");
        // Mainline is a weight, as it is in the tree — not a glyph. The star
        // that used to sit here was an emoji and borrowed the "due" mastery
        // colour, so the chip read as a training prompt it was not.
        // Practical share: the server's real Maia probability for this move
        // (human-likeness at the repertoire's rating). Manual/imported moves have
        // none — show nothing rather than a made-up number.
        const share =
          typeof n.maia_probability === "number" && n.maia_probability > 0
            ? html`<small>${Math.round(n.maia_probability * 100)}%</small>`
            : "";
        const title = n.is_mainline ? `Play ${n.san} — main line` : `Play ${n.san}`;
        return (
          html`<button class="${cls}" type="button" data-node-id="${String(n.id)}" title="${title}"><span class="mtree-num">${num}</span>${n.san}${share}</button>`
        );
      });
    // Over the window, "Show all" opens the whole list (and caps it again).
    const more =
      ctx.options.length > size
        ? html`<button class="fork-more" type="button" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "Show fewer" : "Show all"}</button>`
        : "";
    bar.hidden = false;
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Fork — pick the next move");
    bar.innerHTML =
      html`<div class="fork-head" title="↑/↓ pick · → play · ← back"><b>Next move</b><span class="count">${countOf(ctx.options.length, "option")}</span>${more}</div><div class="fork-chips${expanded ? " is-all" : ""}">${chips}</div>`;
    // The disclosure: opens the whole list for this position, closes it again.
    const moreBtn = bar.querySelector(".fork-more");
    if (moreBtn) {
      moreBtn.addEventListener("click", () => {
        forkExpandedFor = expanded ? null : appState.buildCurrentNodeId;
        renderBuildBranchBar();
        document.querySelector("#build-branchbar .fork-more")?.focus();
      });
    }
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

  // A note's moves are read from the note's own position, and a numbered move
  // ("4.Nc3" on move 9) from that ply on the path that led here.
  function noteHtml(node) {
    const path = buildPath(node.id);
    return moveTextHtml(node.comment, { fen: node.fen, at: (ply) => path.find((n) => plyOfFen(n.fen) === ply)?.fen });
  }

  // The named opening of the shown line: the deepest position on the path the
  // Explorer has named ("B20 Sicilian Defense"), so stepping past the last
  // named move keeps the name instead of blanking it.
  function openingName() {
    const named = appState.buildOpeningByFen;
    const path = buildPath(appState.buildCurrentNodeId);
    for (let i = path.length - 1; i >= 0; i -= 1) {
      const name = named.get(String(path[i].fen || "").split(" ").slice(0, 4).join(" "));
      if (name) return name;
    }
    return "";
  }

  function nameOpening(fen, name) {
    appState.buildOpeningByFen.set(String(fen).split(" ").slice(0, 4).join(" "), name);
    renderBuildOpening();
  }

  function renderBuildOpening() {
    const el = document.getElementById("build-opening");
    if (!el) return;
    const name = appState.build ? openingName() : "";
    el.hidden = !name;
    el.textContent = name;
    el.title = name;
  }

  function renderTreeMeta() {
    const meta = document.getElementById("build-tree-meta");
    if (!meta) return;
    meta.hidden = !appState.build;
    meta.innerHTML = appState.build
      ? html`${renderBuildBreadcrumb()}<span class="build-opening" id="build-opening" hidden></span>`
      : "";
    renderBuildOpening();
    meta.querySelectorAll(".mtree-crumb[data-node-id]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        void selectBuildNode(btn.dataset.nodeId).catch(() => {});
        event.currentTarget.blur();
      });
    });
  }

  function renderBuilderTree() {
    // The rule above reads the tree, so every re-render — including the ones
    // that bail before the tree renderer runs — repaints the head. Otherwise the
    // no-repertoire and root-only branches leave the previous visibility.
    paintGenerateVisibility();
    const container = document.getElementById("builder-tree");
    const branchBar = document.getElementById("build-branchbar");
    if (!appState.build) {
      renderTreeMeta();
      container.innerHTML =
        html`<div class="tree-empty">No repertoire open. Pick one from the Library, or play a move to start.</div>`;
      if (branchBar) branchBar.hidden = true;
      if (boards.build) boards.build.setBranchArrows([]);
      onTreeRendered();
      return;
    }
    const root = buildNormalizedTree();
    if (!root || !root.children.length) {
      renderTreeMeta();
      container.innerHTML = html`<div class="tree-empty">Play a move to add it to this line.</div>`;
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
    const treeHtml = moveTreeRenderer.renderMoveTree(root, {
      currentId: appState.buildCurrentNodeId,
      collapsible: true,
      isCollapsed: (node) => collapsed.has(node.id),
      decorate: (node) => {
        const b = node.raw;
        const classes = [];
        if (b.mastery) classes.push(`m-${b.mastery}`);
        if (!b.is_enabled) classes.push("is-disabled");
        if (b.move_side !== appState.build.color) classes.push("is-opp");
        // The move this session just made: one rise, once, so a line the user
        // added is distinguishable from the seventy already there.
        if (b.id === appState.buildJustAddedId) classes.push("is-added");
        // One quiet mark per move and one sentence behind it. The tree used to
        // carry four signals at once — a mastery bar, a "prepared" underline,
        // the accent fill on every move of the path, and a bold mainline — so
        // every token was decorated and the eye had nowhere to rest. The tree
        // now paints only the two states that ask for something (due, weak);
        // every own move names its real status in the tooltip, which is where
        // detail belongs, and the path is read from the trail above.
        const status = MASTERY_WORDS[b.mastery] || "";
        // A note reads under its move, one line until it is opened.
        const open = openNotes.has(String(b.id)) ? " is-open" : "";
        return {
          classes,
          title: [status, "Right-click for move options"].filter(Boolean).join(" · "),
          ...(status ? { label: status } : {}),
          after: b.comment
            ? html`<div class="mtree-comment${open}" data-note-for="${String(b.id)}">${noteHtml(b)}</div>`
            : "",
        };
      },
      moveMenu: !isReadOnly(),
    });
    renderTreeMeta();
    container.innerHTML = treeHtml;
    // The arrival is over once the token has landed: drop the flag now so no
    // later render replays it, and drop the class on animationend so nothing
    // is left carrying an entrance that already happened.
    appState.buildJustAddedId = null;
    container.querySelectorAll(".mtree-move.is-added").forEach((el) => {
      el.addEventListener("animationend", () => el.classList.remove("is-added"), { once: true });
    });
    container.querySelectorAll(".mtree-comment[data-note-for]").forEach((note) => {
      note.addEventListener("click", (event) => {
        if (event.target.closest("[data-mt]")) return;
        const id = note.dataset.noteFor;
        if (openNotes.has(id)) openNotes.delete(id);
        else openNotes.add(id);
        note.classList.toggle("is-open", openNotes.has(id));
      });
    });
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
    paintGenerateVisibility();
  }

  return {
    renderBuildRepHeader,
    renderBuilderTree,
    renderBuildBreadcrumb,
    renderBuildBranchBar,
    renderBuildOpening,
    nameOpening,
    paintGenerateVisibility,
  };
}
