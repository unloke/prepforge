import { html } from "./html.js";
import { openPopover } from "./core/dialog.js";
// The one picker every Train row uses: Due queue scope, the repertoire to
// rehearse, the practice opponent and the repertoires it draws from. A
// [popover] under its chip on desktop, a bottom sheet on a phone; Escape, a
// press outside and a second press on the chip are the popover's own.

const isTrainable = (rep) => !(rep.health && Number(rep.health.trainable) === 0);

// Own active repertoires, then "Shared with you". A repertoire with nothing to
// train is listed but cannot be picked.
export function trainRepertoireItems(state, { shared = true } = {}) {
  const pending = state.pendingRepDeletes || new Set();
  const item = (rep, group) => ({
    id: String(rep.id),
    label: rep.name || "Untitled repertoire",
    color: rep.color === "black" ? "black" : "white",
    sub: isTrainable(rep) ? "" : "0 to train",
    disabled: !isTrainable(rep),
    group,
  });
  const own = (state.repertoireList || [])
    .filter((rep) => rep.is_active !== false && !pending.has(String(rep.id)))
    .map((rep) => item(rep, ""));
  const others = shared ? (state.sharedRepertoireList || []).map((rep) => item(rep, "Shared with you")) : [];
  return [...own, ...others];
}

let open = null;

export function closeTrainPicker() {
  open?.close();
}

function optionHtml(item, selected, multi) {
  const on = selected.has(item.id);
  return html`<button type="button" class="train-pick${on ? " is-on" : ""}" role="option" aria-selected="${String(on)}" data-id="${item.id}" ${item.disabled ? "disabled" : ""}>
    ${multi ? html`<span class="train-pick-box" aria-hidden="true"></span>` : ""}
    ${item.color ? html`<span class="color-dot ${item.color}"></span>` : ""}
    <span class="train-pick-label">${item.label}</span>
    ${item.sub ? html`<span class="train-pick-sub">${item.sub}</span>` : ""}
  </button>`;
}

// items: [{ id, label, sub?, color?, disabled?, group? }]; selected: ids.
// Single choice closes on pick; multi keeps the list open and reports each change.
export function openTrainPicker(anchor, { label, items, selected = [], multi = false, onChange }) {
  closeTrainPicker();
  const picked = new Set(selected.map(String));
  const el = document.createElement("div");
  el.className = "train-picker";
  el.setAttribute("role", "listbox");
  el.setAttribute("aria-label", label);
  if (multi) el.setAttribute("aria-multiselectable", "true");
  const paint = () => {
    const groups = [];
    for (const item of items) {
      const group = groups.find((g) => g.name === (item.group || ""));
      if (group) group.items.push(item);
      else groups.push({ name: item.group || "", items: [item] });
    }
    el.innerHTML = html`<div class="train-picker-head">${label}</div>${groups.map((g) => html`${g.name ? html`<div class="train-picker-group">${g.name}</div>` : ""}${g.items.map((item) => optionHtml(item, picked, multi))}`)}`;
  };
  paint();
  el.addEventListener("click", (event) => {
    const button = event.target.closest(".train-pick");
    if (!button || button.disabled) return;
    const id = button.dataset.id;
    if (!multi) {
      closeTrainPicker();
      onChange([id]);
      anchor.focus();
      return;
    }
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    paint();
    el.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
    onChange([...picked]);
  });
  const entry = {};
  entry.close = openPopover(el, {
    opener: anchor,
    onClose: () => {
      if (open === entry) open = null;
      el.remove();
    },
  });
  open = entry;
  const rect = anchor.getBoundingClientRect();
  // Under the chip, or above it when the list would run off a short screen.
  const height = el.offsetHeight;
  const below = rect.bottom + 6;
  const top = below + height <= window.innerHeight - 8 || rect.top - 6 - height < 8
    ? Math.min(below, window.innerHeight - height - 8) : rect.top - 6 - height;
  el.style.setProperty("--pick-top", `${Math.round(Math.max(8, top))}px`);
  el.style.setProperty("--pick-left", `${Math.round(Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`);
  (el.querySelector(".train-pick.is-on:not(:disabled)") || el.querySelector(".train-pick:not(:disabled)"))?.focus();
}
