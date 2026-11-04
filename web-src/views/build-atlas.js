import { html } from "../html.js";
import { modalDialog, openModal } from "../core/dialog.js";
import { startAtlasPreparation } from "../atlas-preparation-client.js";

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

// Own-side training only; disabled ancestors exclude their entire subtree.
export function atlasAnalysis(nodes, color) {
  const children = indexTree(nodes), ids = new Set(nodes.map((n) => n.id));
  const counts = { mastered: 0, learning: 0, due: 0, weak: 0, untrained: 0 }, enabled = [], leaves = [];
  const stack = nodes.filter((n) => !ids.has(n.parent_id));
  while (stack.length) {
    const node = stack.pop();
    if (node.is_enabled === false) continue;
    enabled.push(node);
    const kids = (children.get(node.id) || []).filter((n) => n.is_enabled !== false);
    if (node.parent_id && !kids.length) leaves.push(node);
    stack.push(...kids);
    if (node.parent_id && node.move_side === color) counts[Object.hasOwn(counts, node.mastery) ? node.mastery : "untrained"]++;
  }
  const trainable = Object.values(counts).reduce((a, b) => a + b, 0), trained = trainable - counts.untrained;
  const depths = new Map();
  for (const node of leaves) { const move = Math.ceil(node.ply / 2); depths.set(move, (depths.get(move) || 0) + 1); }
  return { counts, trainable, trained, score: trained ? Math.round(counts.mastered / trainable * 100) : null,
    review: counts.due + counts.weak, nodes: enabled, leaves, depths,
    forks: enabled.filter((n) => (children.get(n.id) || []).filter((c) => c.is_enabled !== false).length > 1).length,
    deepest: Math.max(0, ...depths.keys()) };
}

const numerals = ["I", "II", "III", "IV", "V"];

export function profileGlyph(scores) {
  const point = (i, scale) => {
    const angle = (i * 360 / scores.length - 90) * Math.PI / 180;
    return `${(150 + Math.cos(angle) * 100 * scale).toFixed(2)},${(150 + Math.sin(angle) * 100 * scale).toFixed(2)}`;
  };
  const known = scores.map((value, i) => value == null ? null : { i, value }).filter(Boolean);
  return html`<svg class="atlas-fingerprint" viewBox="0 0 300 300" aria-hidden="true"><circle class="atlas-orbit" cx="150" cy="150" r="126"/>${[0.25, 0.5, 0.75, 1].map((s) => html`<polygon class="atlas-grid" points="${scores.map((_, i) => point(i, s)).join(" ")}"/>`)}<path class="atlas-axis" d="${scores.map((_, i) => `M150,150L${point(i, 1.26)}`).join("")}"/>${known.length >= 3 ? html`<polygon class="atlas-envelope" points="${known.map(({ i, value }) => point(i, value / 100)).join(" ")}"/>` : ""}${known.map(({ i, value }) => { const [cx, cy] = point(i, value / 100).split(","); return html`<circle class="atlas-vertex" cx="${cx}" cy="${cy}" r="3"/>`; })}${scores.map((_, i) => { const [x, y] = point(i, 1.4).split(","); return html`<text x="${x}" y="${Number(y) + 4}" text-anchor="middle">${numerals[i]}</text>`; })}</svg>`;
}

const percent = (value) => value == null ? "—" : String(Math.round(value));

export function atlasScoreText(result) {
  return result?.score == null ? "—" : percent(result.score);
}

export function openBuildAtlas({ appState }) {
  const build = appState.build;
  if (!build) return;
  const root = build.nodes.find((node) => !node.parent_id);
  if (!root) return;
  const dialog = modalDialog("lineage-modal atlas-modal");
  dialog.innerHTML = html`<header class="modal-header"><h2 class="modal-title">Repertoire atlas</h2><button type="button" class="btn icon" data-close aria-label="Close">×</button></header><div class="lineage-body"></div>`;
  let cancelCalculation = () => {};
  dialog.addEventListener("close", () => cancelCalculation(), { once: true });
  const close = openModal(dialog);
  dialog.querySelector("[data-close]").onclick = () => close();
  const body = dialog.querySelector(".lineage-body");
  const children = indexTree(build.nodes);
  const selected = atlasAnalysis(build.nodes, build.color).nodes.find((node) => node.id === appState.buildCurrentNodeId);
  const personal = !appState.sharedToken && !build.shared;
  body.innerHTML = html`<div class="atlas-identity"><h3>${build.name}</h3><span class="atlas-side"><i class="${build.color === "black" ? "is-black" : ""}"></i>${build.color === "black" ? "Black" : "White"}</span></div>
    <div class="atlas-tools"><label>Scope <select data-scope aria-label="Atlas scope"><option value="${root.id}">Whole repertoire</option>${selected && selected.id !== root.id ? html`<option value="${selected.id}">Current position · ${selected.san || "Position"}</option>` : ""}</select></label></div>
    <div data-atlas-content></div>`;
  const paint = () => {
    cancelCalculation();
    const scope = body.querySelector("[data-scope]").value;
    const start = build.nodes.find((node) => node.id === scope);
    const scoped = subtreeNodes(start, children);
    const data = atlasAnalysis(scoped, build.color);
    const moveCount = data.nodes.filter((node) => node.id !== scope).length;
    const content = body.querySelector("[data-atlas-content]");
    const render = (result, error = null) => {
      const pending = !result && !error;
      const profile = result || { score: null, facets: ["Replies", "Reach", "Depth", "Consistency", "Ease"].map((label) => ({ label, value: null, numerator: 0, denominator: 0, definition: error || "Calculating" })) };
      content.setAttribute("aria-busy", String(pending));
      content.innerHTML = html`<div class="atlas-portrait"><section class="atlas-index" aria-label="Atlas preparation index" title="${error || "Calibrated estimate of supported opponent plans and opening handover, based on move-content review of 38 studies. Consistency and Ease describe learning load. Unrecorded moves and author intent remain unknown; this is not engine strength."}"><span class="atlas-kicker" role="status">${pending ? "Calculating…" : error ? "Unavailable" : "Preparation"}</span><div class="atlas-index-number"><strong>${atlasScoreText(profile)}</strong><span>/ 100</span></div><div class="atlas-index-rule"><i style="--value:${profile.score ?? 0}%"></i></div></section>
      <div class="atlas-seal">${profileGlyph(profile.facets.map((facet) => facet.value))}</div>
      <section class="atlas-facets" aria-label="Preparation profile">${profile.facets.map((facet, i) => html`<div class="atlas-facet" title="${facet.definition}"><span class="atlas-facet-id">${numerals[i]}</span><span>${facet.label}</span><b>${percent(facet.value)}</b><div class="atlas-facet-track"><i style="--value:${facet.value ?? 0}%;--delay:${i * 70}ms"></i></div></div>`)}</section></div>
      <section class="atlas-map" aria-label="Repertoire routes"><div class="atlas-section-head"><h4>Lineage</h4><span>${String(data.leaves.length).padStart(2, "0")} ${data.leaves.length === 1 ? "route" : "routes"}</span></div>${routeGlyph(data.nodes, scope, appState.buildCurrentNodeId)}</section>
      <footer class="atlas-foot"><span><b>${moveCount}</b> moves</span><span><b>${data.forks}</b> forks</span><span><b>${data.deepest}</b> depth</span>${personal ? html`<span class="atlas-imprint" title="Personal training imprint"><span>Imprint</span><b>${data.score ?? "—"}</b></span>` : ""}</footer>`;
    };
    render(null);
    cancelCalculation = startAtlasPreparation({ nodes: build.nodes, myColor: build.color, rootNodeId: scope }, {
      onResult: (result) => { if (dialog.open) render(result); },
      onError: (error) => { if (dialog.open) render(null, `${error.message}. Reopen Atlas to retry.`); },
    });
  };
  body.querySelector("[data-scope]").onchange = paint;
  paint();
}
