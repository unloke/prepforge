// Shared Source Composer selection model — one selection system for Games and
// Scout ("pick recipients like an email"). A selection is:
//   { accountIds: string[], external: string[] }
// where accountIds are linked Lichess account ids and external are arbitrary
// Lichess usernames (Scout only). Pure + storage-free so both pages — and unit
// tests — share the exact semantics:
//
// - Self is the group of ALL linked personal accounts.
// - Selecting Self selects every linked account id.
// - Deselecting Self removes every linked account id.
// - All linked selected  -> collapsed "Self · N" chip.
// - Partially selected   -> mixed state; chips show the actual accounts.
// - Linked and external selections coexist (Games ignores external).

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
  const accountIds = uniqueStrings(
    Array.isArray(selection?.accountIds) ? selection.accountIds : []
  );
  const external = uniqueStrings(
    (Array.isArray(selection?.external) ? selection.external : [])
      .map(normalizeUsername)
      .filter(Boolean)
  );
  return { accountIds, external };
}

export function isSelectionEmpty(selection) {
  const sel = normalizeSelection(selection);
  return sel.accountIds.length === 0 && sel.external.length === 0;
}

// Self-group state against the CURRENT linked accounts:
//   "all"   — every linked account selected, or the implicit Self default
//             (empty selection). Callers that need an explicit "none"
//             (popovers mid-deselect) pass { _selfOff: true } alongside.
//   "mixed" — some (not all) linked accounts selected
//   "none"  — explicit empty: no ids selected with _selfOff set
export function selfGroupState(selection, linkedAccounts) {
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  if (!linked.length) return "all";
  const sel = normalizeSelection(selection);
  if (sel.accountIds.length === 0) return selection?._selfOff ? "none" : "all";
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
  const ids = uniqueStrings([
    ...sel.accountIds,
    ...(Array.isArray(linkedAccounts) ? linkedAccounts : []).map((a) => a.id),
  ]);
  return { accountIds: ids, external: sel.external };
}

export function deselectSelf(selection, linkedAccounts) {
  const sel = normalizeSelection(selection);
  const linkedIds = new Set(
    (Array.isArray(linkedAccounts) ? linkedAccounts : []).map((a) => a.id)
  );
  const accountIds = sel.accountIds.filter((id) => !linkedIds.has(id));
  return { accountIds, external: sel.external };
}

export function toggleAccount(selection, accountId) {
  const sel = normalizeSelection(selection);
  const id = String(accountId);
  const has = sel.accountIds.includes(id);
  const accountIds = has ? sel.accountIds.filter((x) => x !== id) : [...sel.accountIds, id];
  return { accountIds, external: sel.external };
}

export function addExternal(selection, username) {
  const sel = normalizeSelection(selection);
  const name = normalizeUsername(username);
  if (!name) return sel;
  const dupe = sel.external.some((x) => x.toLowerCase() === name.toLowerCase());
  if (dupe) return sel;
  return { accountIds: sel.accountIds, external: [...sel.external, name] };
}

export function removeExternal(selection, username) {
  const sel = normalizeSelection(selection);
  const name = normalizeUsername(username).toLowerCase();
  return {
    accountIds: sel.accountIds,
    external: sel.external.filter((x) => x.toLowerCase() !== name),
  };
}

// Chips for the collapsed composer row. Full-Self collapses to one chip;
// Self + external keeps the collapsed Self chip alongside the external chips
// (one union, matching the fetch); partial self shows the actual account
// chips (mixed group state); explicit "none" (popover _selfOff) shows no
// chips; external usernames always show as their own chips.
export function selectionChips(selection, linkedAccounts) {
  const sel = normalizeSelection(selection);
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  const state =
    sel.accountIds.length === 0 && selection?._selfOff ? "none" : selfGroupState(sel, linked);
  const chips = [];
  if (state === "all" && linked.length) {
    // Full Self collapses to one chip; Self + external keeps the collapsed
    // Self chip alongside the external chips so the tray reads as one union,
    // matching the fetch.
    chips.push({ kind: "self", label: `Self · ${linked.length}`, count: linked.length });
  } else {
    const byId = new Map(linked.map((a) => [a.id, a]));
    for (const id of sel.accountIds) {
      const account = byId.get(id);
      chips.push({
        kind: "account",
        id,
        label: account ? account.username : id,
        primary: !!account?.is_primary,
      });
    }
  }
  for (const name of sel.external) {
    chips.push({ kind: "external", id: name, label: name });
  }
  return { chips, selfState: state };
}

// Shared Source Composer popover — the PrepForge-style picker both Games and
// Scout open from their collapsed chip row. Renders into document.body as a
// positioned popover (not a modal): Self group row with mixed-state checkbox,
// one row per linked account, an external-username input (Scout) or a linked
// note (Games), and a Done action.
//
// Keyboard / focus / ARIA: Enter/Space toggle rows natively (checkboxes +
// buttons), Esc closes, focus returns to the opener, the Self checkbox uses
// aria-checked="mixed" for partial selection, and every chip-remove button
// carries an accessible label.
export function openSourceComposer({
  document: doc = globalThis.document,
  anchor,
  selection,
  linkedAccounts = [],
  allowExternal = false,
  externalPlaceholder = "Add Lichess username…",
  title = "Sources",
  onChange,
  onClose,
  escapeHtml = (s) => String(s ?? ""),
}) {
  const sel0 = normalizeSelection(selection);
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  let sel = sel0;
  // Popover-local "Self off": while the composer is open, an explicit empty
  // (user unchecked Self) must read as "none" rather than collapsing back to
  // the implicit Self default — without leaking a marker into the model.
  let selfOff = false;
  const selfState = () => {
    if (selfOff && normalizeSelection(sel).accountIds.length === 0) return "none";
    return selfGroupState(sel, linked);
  };
  const prevFocus = doc.activeElement;
  // Anchor first: the composer opens from a chip/Add button, and focus must
  // return there on close even when the previously-focused element is body.
  const opener = anchor && typeof anchor.focus === "function" ? anchor : prevFocus;

  const overlay = doc.createElement("div");
  overlay.className = "src-composer-overlay";
  const linkedCount = linked.length;

  const render = () => {
    const state = selfState();
    // Empty selection means Self (all linked): the group box renders checked
    // so unchecking it is a real "deselect Self" gesture.
    const selfChecked = linkedCount > 0 && state !== "none";
    const rows = linked
      .map((account) => {
        const checked = sel.accountIds.includes(account.id);
        return (
          `<label class="src-row" data-src-account="${escapeHtml(account.id)}">` +
          `<input type="checkbox" data-src-checkbox="${escapeHtml(account.id)}"${checked ? " checked" : ""} />` +
          `<span class="src-name">${escapeHtml(account.username)}` +
          (account.is_primary ? ' <span class="conn-primary">Primary</span>' : "") +
          `</span></label>`
        );
      })
      .join("");
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
      `<div class="src-rows">${rows || '<p class="muted">No linked accounts yet.</p>'}</div>` +
      (allowExternal
        ? `<div class="src-divider"></div>` +
          `<div class="src-add-row">` +
          `<input type="text" class="src-add-input" data-src-add placeholder="${escapeHtml(externalPlaceholder)}" aria-label="${escapeHtml(externalPlaceholder)}" />` +
          `<button type="button" class="btn ghost" data-src-add-btn>Add</button>` +
          `</div>` +
          (sel.external.length
            ? `<div class="src-external">${sel.external
                .map(
                  (name) =>
                    `<span class="src-chip" data-src-external="${escapeHtml(name)}">${escapeHtml(name)}` +
                    `<button type="button" class="src-chip-x" data-src-remove-external="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button></span>`
                )
                .join("")}</div>`
            : "")
        : "") +
      `<div class="src-foot"><button type="button" class="btn primary" data-src-done>Done</button></div>` +
      `</div>`;
    const selfBox = overlay.querySelector("[data-src-self-checkbox]");
    if (selfBox && state === "mixed") selfBox.indeterminate = true;
  };

  const emit = () => {
    render();
    if (typeof onChange === "function") onChange({ ...sel }, { selfState: selfState() });
  };

  render();
  doc.body.appendChild(overlay);
  const popover = overlay.querySelector(".src-popover");
  try {
    const rect = opener?.getBoundingClientRect?.();
    if (rect && popover) {
      popover.style.position = "absolute";
      popover.style.top = `${rect.bottom + 6 + (globalThis.scrollY || 0)}px`;
      popover.style.left = `${Math.max(8, Math.min(rect.left, (globalThis.innerWidth || 800) - 300))}px`;
    }
  } catch {
    /* static fallback: CSS centers the popover */
  }

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
    // The Self row is a <label> wrapping its checkbox: a click on the label
    // natively flips the checkbox AND fires change — never toggle here or the
    // group flips twice (the deselect-then-reselect bug). State syncs on change.
    // Playwright's .click() on the input fires click but not always change, so
    // a DIRECT input click syncs here; label-driven flips still land on change
    // (guarded by comparing against the already-synced state).
    const selfInput = event.target.closest?.("[data-src-self-checkbox]");
    if (selfInput) {
      // Direct input clicks (incl. Playwright .click(), which fires click
      // BEFORE the native flip): the pre-flip state is still "selected", so
      // decide from the model, not the box. A real label-driven activation
      // lands on change afterwards, where the guard compares post-flip state
      // against the already-synced model and no-ops.
      if (selfState() !== "none") {
        selfOff = true;
        sel = deselectSelf(sel, linked);
        emit();
      } else {
        selfOff = false;
        sel = selectSelf(sel, linked);
        emit();
      }
      return;
    }
    if (event.target.closest("[data-src-self]")) {
      return;
    }
    const addBtn = event.target.closest("[data-src-add-btn]");
    if (addBtn) {
      commitExternalFromInput();
      return;
    }
    const removeBtn = event.target.closest("[data-src-remove-external]");
    if (removeBtn) {
      sel = removeExternal(sel, removeBtn.dataset.srcRemoveExternal);
      emit();
      return;
    }
  });

  overlay.addEventListener("change", (event) => {
    const selfBox = event.target.closest("[data-src-self-checkbox]");
    if (selfBox) {
      // Change-driven sync (real user label/input activations). The direct
      // click handler above already synced Playwright-style input clicks, so
      // only act when the box state actually disagrees with the model.
      const modelChecked = selfState() !== "none";
      if (selfBox.checked === modelChecked) return;
      if (!selfBox.checked) {
        selfOff = true;
        sel = deselectSelf(sel, linked);
      } else {
        selfOff = false;
        sel = selectSelf(sel, linked);
      }
      emit();
      return;
    }
    const box = event.target.closest("[data-src-checkbox]");
    if (!box) return;
    // Account rows are <label>s too: the change event already carries the
    // final checked state — sync to it instead of blind-toggling (a label
    // click + change double-fires otherwise).
    sel = normalizeSelection(sel);
    const id = box.dataset.srcCheckbox;
    const want = !!box.checked;
    const has = sel.accountIds.includes(id);
    if (want && !has) sel = { accountIds: [...sel.accountIds, id], external: sel.external };
    else if (!want && has) sel = { accountIds: sel.accountIds.filter((x) => x !== id), external: sel.external };
    if (normalizeSelection(sel).accountIds.length > 0) selfOff = false;
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

  overlay.querySelector("[data-src-self-checkbox]")?.focus();
  return { close, getSelection: () => ({ ...sel }) };
}

// Back-compat bridge: the legacy Games/Scout persistence stores only linked
// account ids (null = Self default). An empty selection means Self.

export function legacyIdsToSelection(ids) {
  if (!Array.isArray(ids) || !ids.length) return { accountIds: [], external: [] };
  return normalizeSelection({ accountIds: ids });
}

export function selectionToLegacyIds(selection, linkedAccounts) {
  const sel = normalizeSelection(selection);
  // Explicit Self-off (empty + _selfOff) persists as a real marker so UI
  // chips and fetch stay "no sources" across reload instead of collapsing
  // back to the implicit Self default.
  if (selection?._selfOff && !sel.accountIds.length && !sel.external.length) {
    return ["__none__"];
  }
  const state = selfGroupState(sel, linkedAccounts);
  // Full Self (and empty) persist as null = Self default; partial + external
  // linked ids persist explicitly. External usernames live in their own key.
  if (state === "all") return null;
  return sel.accountIds.length ? [...sel.accountIds] : null;
}

// Resolve the usernames a page should actually fetch. Linked picks and
// external names always union: implicit Self (empty accountIds) means ALL
// linked, so Self + external fetches every linked username plus every external
// name. Explicit _selfOff (empty + marker) means no sources. Games passes
// includeExternal: false to ignore external; Scout passes true.
export function resolveFetchUsernames({ selection, linkedAccounts, external = [], includeExternal = false }) {
  // Explicit Self-off (empty + marker) fetches nothing — not even external.
  if (selection?._selfOff) return [];
  const sel = normalizeSelection(selection);
  const linked = Array.isArray(linkedAccounts) ? linkedAccounts : [];
  const idSet = new Set(sel.accountIds);
  const idToName = new Map(linked.map((a) => [a.id, a.username]));
  const knownPicked = [...idSet].map((id) => idToName.get(id)).filter(Boolean);
  const unknownPicked = [...idSet].filter((id) => !idToName.has(id));
  const legacyExtra = (Array.isArray(external) ? external : []).map(normalizeUsername).filter(Boolean);
  const externals = includeExternal ? uniqueStrings([...sel.external, ...legacyExtra]) : [];
  if (knownPicked.length || unknownPicked.length) {
    // Any explicit linked pick narrows the linked side to exactly those ids
    // (unknown ids resolve to nothing); external names still union in.
    return uniqueStrings([...knownPicked, ...externals]);
  }
  const all = linked.map((a) => a.username).filter(Boolean);
  if (all.length) {
    // Implicit Self (empty accountIds): ALL linked union external.
    if (includeExternal) return uniqueStrings([...all, ...externals]);
    return uniqueStrings(all);
  }
  if (includeExternal) return uniqueStrings(externals);
  return [];
}
