import { html, raw } from "./html.js";
import { nodeMenuHeading } from "./node-menu.js";
// Command palette (Ctrl/Cmd+K). Pure ranking lives here so vitest can drive
// it without the DOM; createCommandPalette wires the overlay.

// Single naming table shared with the rail/tabbar (index.html), listed in the
// rail's order so the empty-query palette reads like the sidebar: the label is
// what the nav shows, and `keywords` keeps older/alternate names searchable as
// aliases so nobody has to remember a second set of names. `section` narrows
// Replay's two sections (Games vs Scout) into explicit entries.
export const PALETTE_VIEWS = [
  { id: "dashboard", label: "Library", keywords: ["library", "dashboard", "home", "repertoires"] },
  { id: "build", label: "Repertoire", keywords: ["repertoire", "build", "builder", "opening", "tree", "prep"] },
  { id: "analyze", label: "Analyze", keywords: ["analyze", "analyse", "analysis", "game", "pgn", "report", "engine"] },
  { id: "train", label: "Train", keywords: ["train", "practice", "review", "drill", "srs"] },
  { id: "replay", section: "games", label: "Games", keywords: ["games", "replay", "review", "my games"] },
  { id: "replay", section: "scout", label: "Scout", keywords: ["scout", "opponent", "prepare", "scouting"] },
  { id: "teams", label: "Teams", keywords: ["teams", "team", "share", "sharing"] },
  { id: "settings", label: "Settings", keywords: ["settings", "preferences", "account", "profile"] },
];

export const PALETTE_ACTIONS = [
  { id: "new-repertoire", label: "New repertoire", keywords: ["create", "new", "repertoire"] },
  { id: "import-pgn", label: "Import PGN", keywords: ["import", "pgn", "upload", "file", "repertoire"] },
  { id: "start-training", label: "Start training", keywords: ["train", "practice", "start"] },
  { id: "play-human", label: "Practice game", keywords: ["play", "opponent", "human", "maia"] },
  { id: "feeling-lucky", label: "Random position", keywords: ["lucky", "random", "key", "position"] },
  { id: "toggle-theme", label: "Toggle light / dark theme", keywords: ["theme", "dark", "light", "mode", "appearance"] },
];

// The shown Repertoire move's note, offered while one is on screen.
function noteItem(node) {
  const move = nodeMenuHeading(node);
  return {
    kind: "action",
    id: "action:add-note",
    action: "add-note",
    label: `${node.comment ? "Edit note on" : "Add note to"} ${move}`,
    keywords: ["note", "comment", "annotate", "annotation"],
    group: "Actions",
  };
}

export function buildPaletteItems({ repertoires = [], noteMove = null } = {}) {
  const views = PALETTE_VIEWS.map((view) => ({
    kind: "view",
    id: `view:${view.id}${view.section ? `:${view.section}` : ""}`,
    view: view.id,
    section: view.section || null,
    label: view.label,
    keywords: [view.id, view.label, ...(view.keywords || [])],
    group: "Views",
  }));
  const actions = PALETTE_ACTIONS.map((action) => ({
    kind: "action",
    id: `action:${action.id}`,
    action: action.id,
    label: action.label,
    keywords: action.keywords,
    group: "Actions",
  }));
  const reps = (repertoires || []).map((rep) => ({
    kind: "repertoire",
    id: `rep:${rep.id}`,
    repertoireId: rep.id,
    label: rep.name || "Repertoire",
    keywords: [rep.name, rep.color].filter(Boolean),
    group: "Repertoires",
  }));
  return [...views, ...(noteMove ? [noteItem(noteMove)] : []), ...actions, ...reps];
}

function haystack(item) {
  return [item.label, ...(item.keywords || [])]
    .filter(Boolean)
    .map((part) => String(part).toLowerCase());
}

export function scorePaletteItem(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 1;
  // A visible destination label outranks an alias on another destination.
  const label = String(item.label || "").toLowerCase();
  if (label === q) return 300;
  if (label.startsWith(q)) return 250;
  if (label.includes(q)) return 200;
  const fields = haystack(item);
  let best = 0;
  for (const field of fields) {
    if (field === q) best = Math.max(best, 100);
    else if (field.startsWith(q)) best = Math.max(best, 80);
    else if (field.includes(q)) best = Math.max(best, 50);
  }
  return best;
}

export function filterPaletteItems(items, query) {
  const q = String(query || "").trim();
  if (!q) return items.slice();
  return items
    .map((item) => ({ item, score: scorePaletteItem(item, q) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .map((row) => row.item);
}

// The active row is kept on screen: a clamped index just out of sight would
// leave the palette highlighting a row the user cannot see (the 13-item list
// already overflows a 390x660 phone and a 900-tall desktop). Pure so vitest
// can drive it; the caller does the DOM work.
export function paletteScrollTop({ boxTop, boxHeight, itemTop, itemHeight, scrollTop }) {
  if (![boxTop, boxHeight, itemTop, itemHeight].every((n) => Number.isFinite(n))) return scrollTop;
  const top = Number(scrollTop) || 0;
  const itemBottom = itemTop + itemHeight;
  const boxBottom = boxTop + boxHeight;
  if (itemTop < boxTop) return Math.max(0, top + (itemTop - boxTop));
  if (itemBottom > boxBottom) return Math.max(0, top + (itemBottom - boxBottom));
  return top;
}

// Native 16px stroke icons matching the left rail.
const PALETTE_ICONS = {
  "view:dashboard": '<path d="M4 5h16M4 10h16M4 15h10M4 20h10"/>',
  "view:build": '<path d="M5 18V6m0 6h7m0-4h7M12 16h7M12 8v8"/>',
  "view:analyze": '<path d="M4 17l5-6 4 3 7-9"/><circle cx="20" cy="5" r="1.4"/>',
  "view:train": '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  "view:replay:games": '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
  "view:replay:scout": '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.2-4.2M11 8v6M8 11h6"/>',
  "view:teams": '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14c2.4 0 4 1.4 4.5 4"/>',
  "view:settings": '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  "action:new-repertoire": '<path d="M12 5v14M5 12h14"/>',
  "action:import-pgn": '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>',
  "action:start-training": '<polygon points="7 5 19 12 7 19 7 5"/>',
  "action:play-human": '<circle cx="12" cy="8" r="3.5"/><path d="M5 19.5c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5"/>',
  "action:feeling-lucky": '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9" cy="15" r="1.2"/>',
  "action:toggle-theme": '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  "action:add-note": '<path d="M5 19h14M15.5 4.5l4 4L9 19H5v-4z"/>',
};

function paletteIconHtml(item) {
  if (item.kind === "repertoire") {
    const color = item.keywords?.includes("black") ? "black" : "white";
    return html`<span class="palette-dot color-dot ${color}" aria-hidden="true"></span>`;
  }
  const path = PALETTE_ICONS[item.id] || '<circle cx="12" cy="12" r="3"/>';
  // eslint-disable-next-line local/trusted-raw -- PALETTE_ICONS holds this module's own static SVG paths.
  return html`<svg class="palette-ic" viewBox="0 0 24 24" aria-hidden="true">${raw(path)}</svg>`;
}

export function renderPaletteItems(items, activeIndex = 0) {
  if (!items.length) {
    return html`<div class="empty-state">No matching commands</div>`;
  }
  let currentGroup = null;
  const parts = [];
  items.forEach((item, index) => {
    const group = item.group || (item.kind === "repertoire" ? "Repertoires" : "Commands");
    if (group !== currentGroup) {
      currentGroup = group;
      parts.push(html`<div class="palette-group" role="presentation">${group}</div>`);
    }
    const isActive = index === activeIndex;
    const active = isActive ? " is-active" : "";
    parts.push(
      html`<button type="button" role="option" id="palette-option-${index}" aria-selected="${isActive}" class="palette-item${active}" data-palette-id="${item.id}" data-index="${index}"><span class="palette-item-main">${paletteIconHtml(item)}<span class="palette-item-label">${item.label}</span></span><span class="palette-item-enter" aria-hidden="true">↵</span></button>`,
    );
  });
  return html`${parts}`;
}
