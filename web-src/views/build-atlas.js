import { html } from "../html.js";
import { modalDialog, openModal } from "../core/dialog.js";

export function indexTree(nodes) {
  const children = new Map();
  for (const node of nodes) {
    const list = children.get(node.parent_id) || [];
    list.push(node);
    children.set(node.parent_id, list);
  }
  for (const list of children.values()) list.sort((a, b) => Number(b.is_mainline) - Number(a.is_mainline));
  return children;
}

export function subtreeNodes(root, children) {
  const result = [], stack = [root];
  while (stack.length) {
    const node = stack.pop();
    result.push(node);
    stack.push(...(children.get(node.id) || []).slice().reverse());
  }
  return result;
}

// One combined path per ink colour keeps even a large tree a small SVG DOM.
export function routeGlyph(nodes, rootId, currentId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = byId.get(rootId);
  if (!root) return "";
  const children = indexTree(nodes), positions = new Map(), path = new Set();
  let current = byId.get(currentId), leaf = 0, deepest = 1;
  while (current) { path.add(current.id); current = byId.get(current.parent_id); }
  const place = (node, depth) => {
    const kids = children.get(node.id) || [];
    const ys = kids.map((kid) => place(kid, depth + 1));
    const y = ys.length ? ys.reduce((sum, value) => sum + value, 0) / ys.length : leaf++;
    deepest = Math.max(deepest, depth);
    positions.set(node.id, { x: depth, y });
    return y;
  };
  place(root, 0);
  const at = (id) => {
    const p = positions.get(id);
    return { x: Number((10 + p.x / deepest * 300).toFixed(2)), y: Number((10 + (leaf > 1 ? p.y / (leaf - 1) : 0.5) * 76).toFixed(2)) };
  };
  const ordinary = [], active = [], ordinaryDots = [], activeDots = [];
  for (const [id] of positions) {
    const node = byId.get(id), p = at(id);
    if (positions.has(node.parent_id)) {
      const parent = at(node.parent_id);
      (path.has(id) ? active : ordinary).push(`M${parent.x},${parent.y}C${(parent.x + p.x) / 2},${parent.y} ${(parent.x + p.x) / 2},${p.y} ${p.x},${p.y}`);
    }
    if ((children.get(id)?.length || 0) !== 1 || id === currentId) {
      const radius = id === currentId ? 3.2 : 1.8;
      (path.has(id) ? activeDots : ordinaryDots).push(`M${p.x - radius},${p.y}a${radius},${radius} 0 1,0 ${radius * 2},0a${radius},${radius} 0 1,0 -${radius * 2},0Z`);
    }
  }
  return html`<svg class="route-glyph" viewBox="0 0 320 96" aria-hidden="true"><path d="${ordinary.join("")}"/><path class="route-active" d="${active.join("")}"/><path class="route-dots" d="${ordinaryDots.join("")}"/><path class="route-dots route-active" d="${activeDots.join("")}"/></svg>`;
}

export function positionThumbnail(fen, orientation, renderers) {
  if (!renderers) return "";
  const pieces = renderers.parseFenBoard(fen), squares = [];
  const ranks = orientation === "black" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = orientation === "black" ? "hgfedcba" : "abcdefgh";
  for (const rank of ranks) for (const file of files) {
    const piece = pieces[`${file}${rank}`];
    squares.push(html`<span class="${(rank + "abcdefgh".indexOf(file)) % 2 === 1 ? "dark" : "light"}">${piece ? renderers.pieceSvg(piece) : ""}</span>`);
  }
  return html`<div class="position-thumbnail" aria-hidden="true">${squares}</div>`;
}

export function openBuildAtlas({ appState, miniBoard, focusLine, selectBuildNode }) {
  const build = appState.build;
  if (!build) return;
  const children = indexTree(build.nodes), byId = appState.buildNodeById;
  const root = build.nodes.find((node) => !node.parent_id);
  if (!root) return;
  const dialog = modalDialog("lineage-modal atlas-modal");
  dialog.innerHTML = html`<header class="modal-header"><h2 class="modal-title">Repertoire atlas</h2><button type="button" class="btn icon" data-close aria-label="Close">×</button></header><div class="lineage-body"></div>`;
  const close = openModal(dialog);
  dialog.querySelector("[data-close]").onclick = () => close();
  const body = dialog.querySelector(".lineage-body");
  const moveLabel = (node) => node.parent_id ? `${node.move_number}${node.move_side === "black" ? "…" : "."} ${node.san}` : "All lines";
  const pathLabel = (node) => {
    const moves = [];
    while (node?.parent_id) { moves.push(node.san); node = byId.get(node.parent_id); }
    return moves.reverse().join(" ");
  };
  const stats = (nodes) => {
    const leaves = nodes.filter((node) => !(children.get(node.id)?.length)).length;
    const due = nodes.filter((node) => node.mastery === "due" || node.mastery === "weak").length;
    return html`<span>${leaves} ${leaves === 1 ? "line" : "lines"}</span><span>${nodes.length} moves</span>${due ? html`<span class="atlas-due">${due} to review</span>` : ""}`;
  };
  const showFamilies = () => {
    const families = children.get(root.id) || [];
    body.innerHTML = html`<div class="atlas-identity"><h3>${build.name}</h3><span>${build.color === "black" ? "Black" : "White"}</span></div><div class="atlas-summary">${stats(build.nodes.filter((node) => node.parent_id))}</div><div class="atlas-families">${families.map((family, i) => {
      const nodes = subtreeNodes(family, children);
      let named = family, title = "";
      while (named) {
        title = appState.buildOpeningByFen?.get(String(named.fen).split(" ").slice(0, 4).join(" ")) || title;
        const kids = children.get(named.id) || [];
        named = kids.length === 1 ? kids[0] : null;
      }
      return html`<button type="button" class="atlas-family" data-family="${family.id}"><span class="atlas-serial">${String(i + 1).padStart(2, "0")}</span><h4>${title || moveLabel(family)}</h4>${routeGlyph(nodes, family.id, appState.buildCurrentNodeId)}<span class="atlas-stats">${stats(nodes)}</span><span class="atlas-enter" aria-hidden="true">↗</span></button>`;
    })}</div>`;
    body.querySelectorAll("[data-family]").forEach((button) => { button.onclick = () => showForks(byId.get(button.dataset.family)); });
  };
  const showForks = (family, page = 0) => {
    const nodes = subtreeNodes(family, children);
    const forks = nodes.filter((node) => (children.get(node.id)?.length || 0) > 1);
    const places = forks.length ? forks : [family];
    // A page of boards is navigable on a phone too; the full tree stays available.
    const pageSize = 6, shown = places.slice(page * pageSize, (page + 1) * pageSize);
    body.innerHTML = html`<nav class="atlas-crumbs" aria-label="Atlas location"><button type="button" class="btn ghost sm" data-all>All lines</button><span>›</span><b>${moveLabel(family)}</b><button type="button" class="btn sm" data-focus="${family.id}">Open line →</button></nav><div class="atlas-fork-grid">${shown.map((position) => html`<article class="atlas-fork">${miniBoard(position.fen)}<div><h4 title="${pathLabel(position)}">${pathLabel(position)}</h4><div class="atlas-replies">${(children.get(position.id) || []).map((reply) => html`<button type="button" class="btn sm" data-focus="${reply.id}">${moveLabel(reply)}</button>`)}</div><button type="button" class="btn sm ghost" data-focus="${position.id}">Moves →</button></div></article>`)}</div>${places.length > pageSize ? html`<div class="atlas-pagination"><button type="button" class="btn sm" data-prev ${page === 0 ? html`disabled` : ""}>Previous</button><span>${page * pageSize + 1}–${Math.min(places.length, (page + 1) * pageSize)} / ${places.length}</span><button type="button" class="btn sm" data-next ${(page + 1) * pageSize >= places.length ? html`disabled` : ""}>Next</button></div>` : ""}`;
    body.querySelector("[data-all]").onclick = showFamilies;
    body.querySelector("[data-prev]")?.addEventListener("click", () => showForks(family, page - 1));
    body.querySelector("[data-next]")?.addEventListener("click", () => showForks(family, page + 1));
    body.querySelectorAll("[data-focus]").forEach((button) => { button.onclick = () => {
      close();
      const target = byId.get(button.dataset.focus);
      focusLine(children.get(target.id)?.length ? target.id : target.parent_id);
      void selectBuildNode(target.id);
    }; });
  };
  showFamilies();
}
