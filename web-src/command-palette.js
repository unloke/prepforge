// Command palette (Ctrl/Cmd+K). Pure ranking lives here so vitest can drive
// it without the DOM; createCommandPalette wires the overlay.

// Single naming table shared with the rail/tabbar (index.html): the label is
// what the nav shows, and `keywords` keeps older/alternate names searchable as
// aliases so nobody has to remember a second set of names. `section` narrows
// Replay's two sections (Games vs Scout) into explicit entries.
export const PALETTE_VIEWS = [
  { id: "dashboard", label: "Library", keywords: ["library", "dashboard", "home", "repertoires"] },
  { id: "analyze", label: "Analyze", keywords: ["analyze", "analysis", "game", "pgn", "report"] },
  { id: "build", label: "Repertoire", keywords: ["repertoire", "build", "builder", "opening", "tree", "prep"] },
  { id: "train", label: "Train", keywords: ["train", "practice", "review", "drill", "srs"] },
  { id: "replay", section: "games", label: "Games", keywords: ["games", "replay", "review", "my games"] },
  { id: "replay", section: "scout", label: "Scout", keywords: ["scout", "opponent", "prepare", "scouting"] },
  { id: "teams", label: "Teams", keywords: ["teams", "team", "share", "sharing"] },
  { id: "settings", label: "Settings", keywords: ["settings", "preferences", "account", "profile"] },
];

export const PALETTE_ACTIONS = [
  { id: "new-repertoire", label: "New repertoire", keywords: ["create", "new", "repertoire"] },
  { id: "start-training", label: "Start training", keywords: ["train", "practice", "start"] },
  { id: "play-human", label: "Play vs human", keywords: ["play", "opponent", "human", "maia"] },
  { id: "feeling-lucky", label: "I'm Feeling Lucky", keywords: ["lucky", "key", "position"] },
  { id: "analyze", label: "Analyze", keywords: ["game", "pgn", "engine", "analyse"] },
];

export function buildPaletteItems({ repertoires = [] } = {}) {
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
  return [...views, ...actions, ...reps];
}

function haystack(item) {
  return [item.label, ...(item.keywords || [])]
    .filter(Boolean)
    .map((part) => String(part).toLowerCase());
}

export function scorePaletteItem(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 1;
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

export function renderPaletteItems(items, activeIndex = 0) {
  if (!items.length) {
    return '<div class="empty-state">No matching commands</div>';
  }
  return items
    .map((item, index) => {
      const active = index === activeIndex ? " is-active" : "";
      const hint = item.kind === "repertoire" ? "Open in Build" : item.group;
      return (
        `<button type="button" role="option" id="palette-option-${index}" aria-selected="${index === activeIndex}" class="palette-item${active}" data-palette-id="${item.id}" data-index="${index}">` +
        `<span class="palette-item-label">${escapePalette(item.label)}</span>` +
        `<span class="palette-item-hint">${escapePalette(hint)}</span>` +
        `</button>`
      );
    })
    .join("");
}

function escapePalette(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
