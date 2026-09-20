// Shared Source Composer selection model — one selection system for Games and
// Scout ("pick recipients like an email"), identical on both pages. The only
// page difference is what happens AFTER picking: Games fetches recent games
// for prep review, Scout streams opponent games. The picker itself — model,
// popover, chips, rows, Add flow, keyboard/ARIA, positioning, persistence —
// is one shared implementation; `allowExternal` exists only as a legacy flag
// and is now always honored (both pages accept arbitrary Lichess usernames).
//
// Explicit linked-source state (no implicit inference):
//   { linkedMode: "all" | "subset" | "none", accountIds: string[], external: string[] }
// where accountIds are linked Lichess account ids and external are arbitrary
// Lichess usernames. Pure + storage-free so both pages — and unit tests —
// share the exact semantics:
//
// - "all"    = Self, the group of ALL linked personal accounts.
// - "subset" = exactly the listed linked account ids.
// - "none"   = no linked accounts at all.
// - external rides alongside independently (may be empty).
// Expressible states: Self only · Self + external · external only (none +
// names) · partial linked + external · partial linked only · no sources.
//
// Legacy storage (prepforge.games_source / prepforge.scout_source ids,
// prepforge.scout_external names, prepforge.scout_self on/off, "__none__"
// marker) is migrated on read so reload keeps the same selection.

export function normalizeUsername(name) {
  return String(name || "").trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function normalizeSelection(selection) {
  const external = uniqueStrings(
    (Array.isArray(selection?.external) ? selection.external : [])
      .map(normalizeUsername)
      .filter(Boolean)
  );
  const rawMode = selection?.linkedMode;
  const linkedMode = rawMode === "subset" || rawMode === "none" ? rawMode : "all";
  if (linkedMode === "all") return { linkedMode, accountIds: [], external };
  if (linkedMode === "none") return { linkedMode, accountIds: [], external };
  const accountIds = uniqueStrings(
    Array.isArray(selection?.accountIds) ? selection.accountIds : []
  );
  return { linkedMode, accountIds, external };
}

export function isSelectionEmpty(selection) {
  const sel = normalizeSelection(selection);
  return sel.linkedMode === "none" && sel.external.length === 0;
}

// Self-group state against the CURRENT linked accounts, derived from the
// explicit linkedMode (no implicit empty-means-Self inference):
//   "all"   — linkedMode "all" (Self = every linked account)
//   "mixed" — linkedMode "subset" with some (not all) linked accounts picked
//   "none"  — linkedMode "none", or a subset matching zero linked accounts
export function selfGroupState(selection, linkedAccounts) {
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  const sel = normalizeSelection(selection);
  if (sel.linkedMode === "none") return "none";
  if (!linked.length) return "all";
  if (sel.linkedMode === "all") return "all";
  const selected = new Set(sel.accountIds);
  let count = 0;
  for (const account of linked) {
    if (selected.has(account.id)) count += 1;
  }
  if (count === 0) return "none";
  if (count === linked.length) return "all";
  return "mixed";
}

export function selectSelf(selection, linkedAccounts) {
  const sel = normalizeSelection(selection);
  void linkedAccounts;
  return { linkedMode: "all", accountIds: [], external: sel.external };
}

export function deselectSelf(selection, linkedAccounts) {
  const sel = normalizeSelection(selection);
  void linkedAccounts;
  return { linkedMode: "none", accountIds: [], external: sel.external };
}

export function toggleAccount(selection, accountId) {
  const sel = normalizeSelection(selection);
  const id = String(accountId);
  if (sel.linkedMode !== "subset") {
    return { linkedMode: "subset", accountIds: [id], external: sel.external };
  }
  const has = sel.accountIds.includes(id);
  return {
    linkedMode: "subset",
    accountIds: has ? sel.accountIds.filter((x) => x !== id) : [...sel.accountIds, id],
    external: sel.external,
  };
}

export function addExternal(selection, username) {
  const sel = normalizeSelection(selection);
  const name = normalizeUsername(username);
  if (!name) return sel;
  const dupe = sel.external.some((x) => x.toLowerCase() === name.toLowerCase());
  if (dupe) return sel;
  return { linkedMode: sel.linkedMode, accountIds: sel.accountIds, external: [...sel.external, name] };
}

export function removeExternal(selection, username) {
  const sel = normalizeSelection(selection);
  const name = normalizeUsername(username).toLowerCase();
  return {
    linkedMode: sel.linkedMode,
    accountIds: sel.accountIds,
    external: sel.external.filter((x) => x.toLowerCase() !== name),
  };
}

// Chips for the collapsed composer row. Full-Self collapses to one chip;
// Self + external keeps the collapsed Self chip alongside the external chips
// (one union, matching the fetch); partial self shows the actual account
// chips (subset group state); explicit "none" shows no linked chips;
// external usernames always show as their own chips.
export function selectionChips(selection, linkedAccounts) {
  const sel = normalizeSelection(selection);
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  const state = selfGroupState(sel, linked);
  const chips = [];
  if (state === "all" && linked.length) {
    // Full Self collapses to one chip; Self + external keeps the collapsed
    // Self chip alongside the external chips so the tray reads as one union,
    // matching the fetch.
    chips.push({ kind: "self", label: `Self · ${linked.length}`, count: linked.length });
  } else if (state === "mixed") {
    const byId = new Map(linked.map((a) => [a.id, a]));
    for (const id of sel.accountIds) {
      const account = byId.get(id);
      if (!account) continue;
      chips.push({
        kind: "account",
        id,
        label: account.username,
        primary: !!account.is_primary,
      });
    }
  } else if (sel.linkedMode === "subset") {
    const byId = new Map(linked.map((a) => [a.id, a]));
    for (const id of sel.accountIds) {
      const account = byId.get(id);
      if (!account) continue;
      chips.push({
        kind: "account",
        id,
        label: account.username,
        primary: !!account.is_primary,
      });
    }
  }
  for (const name of sel.external) {
    chips.push({ kind: "external", id: name, label: name });
  }
  return { chips, selfState: state };
}

// Shared Source Composer popover — one surface both Games and Scout open from
// their collapsed chip row. Renders into document.body as an anchored popover
// (not a modal) with a single source list:
//
//   Sources
//   Self · N
//   ─────────
//   accountA       Primary
//   accountB
//   hikaru         External
//   ─────────
//   Add Lichess username…   Add
//   Done
//
// Linked accounts and external usernames are sibling rows of the same list:
// an added external becomes a first-class source row (checkbox + remove),
// rendered with the same row/chip language as a linked account, and the
// collapsed toolbar shows it as a compact chip. Games and Scout share this
// exact component, spacing, positioning, and selection rendering —
// `allowExternal` is a legacy flag, always honored.
//
// Positioning: viewport-based (the overlay is position: fixed), recomputed
// after EVERY render via one positionPopover() so selection changes never move
// the anchor; clamped to viewport edges; re-run on resize/scroll.
//
// Keyboard / focus / ARIA: Enter/Space toggle rows natively (checkboxes +
// buttons), Esc closes, focus returns to the opener, the Self checkbox uses
// aria-checked="mixed" for partial selection, and every chip-remove button
// carries an accessible label.
const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;
const POPOVER_MAX_WIDTH = 320;

export function positionPopover({ anchor, popover, viewport } = {}) {
  if (!popover) return null;
  const rect = anchor?.getBoundingClientRect?.();
  const vw =
    viewport?.width ?? globalThis.innerWidth ?? 800;
  const vh = viewport?.height ?? globalThis.innerHeight ?? 600;
  // Anchor identity, not live geometry: the trigger can reflow when the tray
  // repaints (chips change → toolbar wraps → the Add button's own rect moves).
  // Cache the anchor rect on first placement so every later render, resize,
  // and scroll re-applies the same origin instead of chasing the button.
  if (rect && popover.__srcAnchorRect == null) {
    popover.__srcAnchorRect = {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      right: rect.right,
    };
  }
  const origin = popover.__srcAnchorRect || rect;
  const pw = popover.offsetWidth || Math.min(POPOVER_MAX_WIDTH, vw - POPOVER_MARGIN * 2);
  const ph = popover.offsetHeight || 0;
  let left = origin ? origin.left : Math.max(POPOVER_MARGIN, (vw - pw) / 2);
  left = Math.max(POPOVER_MARGIN, Math.min(left, vw - pw - POPOVER_MARGIN));
  let top = origin ? origin.bottom + POPOVER_GAP : POPOVER_MARGIN;
  if (origin && ph > 0 && top + ph > vh - POPOVER_MARGIN) {
    const above = origin.top - POPOVER_GAP - ph;
    if (above >= POPOVER_MARGIN) top = above;
    else top = Math.max(POPOVER_MARGIN, vh - ph - POPOVER_MARGIN);
  }
  popover.style.position = "fixed";
  popover.style.top = `${Math.round(top)}px`;
  popover.style.left = `${Math.round(left)}px`;
  return { top: Math.round(top), left: Math.round(left) };
}

export function openSourceComposer({
  document: doc = globalThis.document,
  anchor,
  selection,
  linkedAccounts = [],
  allowExternal = true,
  externalPlaceholder = "Add Lichess username…",
  title = "Sources",
  onChange,
  onClose,
  escapeHtml = (s) => String(s ?? ""),
}) {
  void allowExternal;
  const sel0 = normalizeSelection(selection);
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  let sel = sel0;
  const selfState = () => selfGroupState(sel, linked);
  const prevFocus = doc.activeElement;
  const opener = anchor && typeof anchor.focus === "function" ? anchor : prevFocus;

  const overlay = doc.createElement("div");
  overlay.className = "src-composer-overlay";
  const linkedCount = linked.length;

  let popoverEl = null;
  const place = () => positionPopover({ anchor: opener, popover: popoverEl });

  const render = () => {
    const state = selfState();
    const checkedIds = new Set(sel.linkedMode === "subset" ? sel.accountIds : []);
    const selfChecked = linkedCount > 0 && state !== "none";
    const linkedRows = linked
      .map((account) => {
        const checked = sel.linkedMode === "all" || checkedIds.has(account.id);
        return (
          `<label class="src-row" data-src-account="${escapeHtml(account.id)}">` +
          `<input type="checkbox" data-testid="src-account-checkbox" data-src-checkbox="${escapeHtml(account.id)}"${checked ? " checked" : ""} />` +
          `<span class="src-name">${escapeHtml(account.username)}` +
          (account.is_primary ? ' <span class="conn-primary">Primary</span>' : "") +
          `</span></label>`
        );
      })
      .join("");
    const externalRows = sel.external
      .map(
        (name) =>
          `<label class="src-row is-external" data-src-external="${escapeHtml(name)}">` +
          `<input type="checkbox" data-testid="src-external-checkbox" data-src-external-checkbox="${escapeHtml(name)}" checked />` +
          `<span class="src-name">${escapeHtml(name)} <span class="src-kind">External</span></span>` +
          `<button type="button" class="src-chip-x" data-src-remove-external="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button></label>`
      )
      .join("");
    const listBody =
      linkedRows + externalRows ||
      (!linked.length && !sel.external.length
        ? '<p class="muted">No sources yet — add a Lichess username below.</p>'
        : "");
    overlay.innerHTML =
      `<div class="src-popover" role="dialog" aria-modal="false" aria-label="${escapeHtml(title)}">` +
      `<div class="src-head"><span class="src-title">${escapeHtml(title)}</span>` +
      `<span class="src-count">${linkedCount} account${linkedCount === 1 ? "" : "s"}</span></div>` +
      `<label class="src-row is-self" data-src-self>` +
      `<input type="checkbox" data-testid="src-self-checkbox" data-src-self-checkbox${selfChecked ? " checked" : ""}${
        state === "mixed" ? ' aria-checked="mixed"' : ""
      } />` +
      `<span class="src-name">Self` +
      (linkedCount && state !== "none"
        ? state === "mixed"
          ? ` <span class="src-self-count is-mixed">partial</span>`
          : ` <span class="src-self-count">${linkedCount}</span>`
        : "") +
      `</span></label>` +
      `<div class="src-divider"></div>` +
      `<div class="src-rows" role="group" aria-label="Sources">${listBody}</div>` +
      `<div class="src-divider"></div>` +
      `<div class="src-add-row">` +
      `<input type="text" class="src-add-input" data-testid="src-add-input" data-src-add placeholder="${escapeHtml(externalPlaceholder)}" aria-label="${escapeHtml(externalPlaceholder)}" />` +
      `<button type="button" class="btn ghost" data-testid="src-add-btn" data-src-add-btn>Add</button>` +
      `</div>` +
      `<div class="src-foot"><button type="button" class="btn primary" data-testid="src-done" data-src-done>Done</button></div>` +
      `</div>`;
    popoverEl = overlay.querySelector(".src-popover");
    const selfBox = overlay.querySelector("[data-src-self-checkbox]");
    if (selfBox && state === "mixed") selfBox.indeterminate = true;
    place();
  };

  const emit = () => {
    render();
    if (typeof onChange === "function") onChange({ ...sel }, { selfState: selfState() });
  };

  render();
  doc.body.appendChild(overlay);
  popoverEl = overlay.querySelector(".src-popover");
  place();

  doc.addEventListener?.("keydown", onDocKeydown, true);
  function onDocKeydown(event) {
    if (event.key === "Escape" && doc.body.contains?.(overlay)) {
      event.preventDefault();
      event.stopPropagation?.();
      close(true);
    }
  }

  const close = (result) => {
    if (overlay.dataset.closed === "1") return;
    overlay.dataset.closed = "1";
    try {
      doc.removeEventListener?.("keydown", onDocKeydown, true);
    } catch {
      /* ignore */
    }
    try {
      globalThis.removeEventListener?.("resize", place);
      globalThis.removeEventListener?.("scroll", place, true);
    } catch {
      /* ignore */
    }
    overlay.remove();
    const target =
      opener && typeof opener.focus === "function"
        ? opener
        : prevFocus && typeof prevFocus.focus === "function"
          ? prevFocus
          : null;
    if (target) {
      try {
        target.focus();
      } catch {
        /* ignore */
      }
    }
    if (typeof onClose === "function") onClose(result ? { ...sel } : null);
  };

  const commitExternalFromInput = () => {
    const input = overlay.querySelector("[data-src-add]");
    if (!input) return;
    const next = addExternal(sel, input.value);
    if (next !== sel) {
      sel = next;
      emit();
    }
    input.value = "";
    input.focus();
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close(true);
      return;
    }
    if (event.target.closest("[data-src-done]")) {
      close(true);
      return;
    }
    const removeBtn = event.target.closest("[data-src-remove-external]");
    if (removeBtn) {
      sel = removeExternal(sel, removeBtn.dataset.srcRemoveExternal);
      emit();
      return;
    }
    // Rows are <label>s wrapping their checkbox: a click on the label
    // natively flips the checkbox AND fires change — never toggle here or the
    // row flips twice. State syncs on change; a DIRECT input click (incl.
    // Playwright .click(), which fires click before change) syncs here only
    // when the box actually disagrees with the model (the trailing change
    // from the same activation then no-ops).
    const selfInput = event.target.closest?.("[data-src-self-checkbox]");
    if (selfInput) {
      const modelChecked = selfState() !== "none";
      if (!!selfInput.checked === modelChecked) return;
      if (!selfInput.checked) {
        sel = deselectSelf(sel, linked);
        emit();
      } else {
        sel = selectSelf(sel, linked);
        emit();
      }
      return;
    }
    if (event.target.closest("[data-src-self]")) {
      return;
    }
    const extInput = event.target.closest?.("[data-src-external-checkbox]");
    if (extInput) {
      // Unchecking an external row removes that source (same language as
      // unpicking a linked account); external rows render checked.
      if (!extInput.checked) {
        sel = removeExternal(sel, extInput.dataset.srcExternalCheckbox);
        emit();
      }
      return;
    }
    const box = event.target.closest?.("[data-src-checkbox]");
    if (box) {
      const id = box.dataset.srcCheckbox;
      const want = !!box.checked;
      const cur = normalizeSelection(sel);
      const has = cur.linkedMode === "subset" && cur.accountIds.includes(id);
      const modelChecked = cur.linkedMode === "all" || has;
      if (want === modelChecked) return;
      if (cur.linkedMode === "all" && !want) {
        const rest = linked.map((a) => a.id).filter((x) => x !== id);
        sel = { linkedMode: "subset", accountIds: rest, external: cur.external };
      } else if (want && !has) {
        sel = { linkedMode: "subset", accountIds: [...cur.accountIds, id], external: cur.external };
      } else if (!want && has) {
        sel = {
          linkedMode: "subset",
          accountIds: cur.accountIds.filter((x) => x !== id),
          external: cur.external,
        };
      } else {
        return;
      }
      emit();
      return;
    }
    const addBtn = event.target.closest("[data-src-add-btn]");
    if (addBtn) {
      commitExternalFromInput();
      return;
    }
  });

  overlay.addEventListener("change", (event) => {
    const selfBox = event.target.closest("[data-src-self-checkbox]");
    if (selfBox) {
      const modelChecked = selfState() !== "none";
      if (selfBox.checked === modelChecked) return;
      if (!selfBox.checked) {
        sel = deselectSelf(sel, linked);
      } else {
        sel = selectSelf(sel, linked);
      }
      emit();
      return;
    }
    const extBox = event.target.closest("[data-src-external-checkbox]");
    if (extBox) {
      if (!extBox.checked) {
        sel = removeExternal(sel, extBox.dataset.srcExternalCheckbox);
        emit();
      }
      return;
    }
    const box = event.target.closest("[data-src-checkbox]");
    if (!box) return;
    const id = box.dataset.srcCheckbox;
    const want = !!box.checked;
    const cur = normalizeSelection(sel);
    const has = cur.linkedMode === "subset" && cur.accountIds.includes(id);
    if (cur.linkedMode === "all" && !want) {
      const rest = linked.map((a) => a.id).filter((x) => x !== id);
      sel = { linkedMode: "subset", accountIds: rest, external: cur.external };
    } else if (cur.linkedMode === "all" && want) {
      sel = { linkedMode: "all", accountIds: [], external: cur.external };
    } else if (want && !has) {
      sel = { linkedMode: "subset", accountIds: [...cur.accountIds, id], external: cur.external };
    } else if (!want && has) {
      sel = {
        linkedMode: "subset",
        accountIds: cur.accountIds.filter((x) => x !== id),
        external: cur.external,
      };
    } else {
      return;
    }
    emit();
  });

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Enter" && event.target?.matches?.("[data-src-add]")) {
      event.preventDefault();
      commitExternalFromInput();
    }
  });

  try {
    globalThis.addEventListener?.("resize", place);
    globalThis.addEventListener?.("scroll", place, true);
  } catch {
    /* non-DOM test doubles may not support globals */
  }

  overlay.querySelector("[data-src-self-checkbox]")?.focus();
  return { close, getSelection: () => ({ ...sel }) };
}

// ---- Persistence bridge (shared by Games + Scout) --------------------------
// New storage shape per key: { linkedMode, accountIds, external } — ids holds
// null (Self default), ["__none__"] (no linked sources), or the explicit
// subset list; external names always persist alongside in the companion key.
// Legacy shapes migrate on read (reload keeps the same selection):
//   null/absent            -> { linkedMode: "all", ... } (Self default)
//   ["__none__"]            -> { linkedMode: "none", ... } (no sources)
//   ["id", ...]             -> { linkedMode: "subset", accountIds: [...] }
//   scout_self=off + empty  -> { linkedMode: "none", ... }
// External names always merge from the companion external key.

export function selectionFromStorage({ ids = null, external = null, selfOff = false } = {}) {
  const externals = uniqueStrings(
    (Array.isArray(external) ? external : []).map(normalizeUsername).filter(Boolean)
  );
  if (Array.isArray(ids) && ids.includes("__none__")) {
    return { linkedMode: "none", accountIds: [], external: externals };
  }
  if (!Array.isArray(ids) || !ids.length) {
    if (selfOff) return { linkedMode: "none", accountIds: [], external: externals };
    return { linkedMode: "all", accountIds: [], external: externals };
  }
  return {
    linkedMode: "subset",
    accountIds: uniqueStrings(ids.map((id) => String(id)).filter((id) => id && id !== "__none__")),
    external: externals,
  };
}

export function selectionToStorage(selection) {
  const sel = normalizeSelection(selection);
  let ids;
  if (sel.linkedMode === "all") ids = null;
  else if (sel.linkedMode === "none") ids = ["__none__"];
  else ids = [...sel.accountIds];
  return {
    ids,
    external: [...sel.external],
  };
}

// Back-compat bridge: the legacy Games/Scout persistence stores only linked
// account ids (null = Self default). An empty selection means Self.

export function legacyIdsToSelection(ids) {
  if (!Array.isArray(ids) || !ids.length) return selectionFromStorage({ ids: null });
  return selectionFromStorage({ ids });
}

export function selectionToLegacyIds(selection, linkedAccounts) {
  const sel = normalizeSelection(selection);
  void linkedAccounts;
  if (sel.linkedMode === "all") return null;
  if (sel.linkedMode === "none" && !sel.external.length) return ["__none__"];
  if (sel.linkedMode === "none") return null;
  return sel.accountIds.length ? [...sel.accountIds] : null;
}

// Resolve the usernames a page should actually fetch. Linked state is explicit:
// "all" contributes every linked username; "subset" contributes exactly the
// listed ids; "none" contributes none. External names always union in. Both
// Games and Scout resolve through this one path (Games no longer ignores
// external — arbitrary Lichess usernames fetch the same way everywhere).
export function resolveFetchUsernames({ selection, linkedAccounts, external = [], includeExternal = true }) {
  const sel = normalizeSelection(selection);
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  const idToName = new Map(linked.map((a) => [a.id, a.username]));
  const legacyExtra = (Array.isArray(external) ? external : []).map(normalizeUsername).filter(Boolean);
  const externals = includeExternal ? uniqueStrings([...sel.external, ...legacyExtra]) : [];
  let linkedNames = [];
  if (sel.linkedMode === "all") {
    linkedNames = linked.map((a) => a.username).filter(Boolean);
  } else if (sel.linkedMode === "subset") {
    const seen = new Set();
    for (const id of sel.accountIds) {
      const name = idToName.get(id);
      if (name && !seen.has(name)) {
        seen.add(name);
        linkedNames.push(name);
      }
    }
  }
  return uniqueStrings([...linkedNames, ...externals]);
}
