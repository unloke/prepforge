import { html } from "../html.js";
import { menuKeys, openPopover } from "./dialog.js";

// The ⋯ menu, one implementation for every row and header that has more
// actions than it shows. On a desktop it drops under its opener (right edges
// aligned) or opens at the cursor for a right-click; on a phone phone-kit.css
// turns the same popover into an action sheet at the thumb, headed by `title`
// (the object it acts on, as the Chess.com and Lichess apps do).
//
// items: [{ action, label, danger?, group? }]. A change of `group` draws a
// separator, so a destructive action sits apart from the rest.
export function overflowMenuHtml({ title = "", items = [], data = {} }) {
  const attrs = Object.entries(data).map(([key, value]) => html` data-${key}="${value}"`);
  let group = items[0]?.group;
  return html`${title ? html`<div class="menu-title" aria-hidden="true">${title}</div>` : ""}${items.map((item) => {
    const sep = item.group !== group ? html`<div class="menu-sep" role="separator"></div>` : "";
    group = item.group;
    return html`${sep}<button type="button" role="menuitem" tabindex="-1" class="${item.danger ? "is-danger" : ""}" data-action="${item.action}"${attrs}>${item.label}</button>`;
  })}`;
}

export function openOverflowMenu(menu, { event, title = "", items, data = {}, onPick }) {
  event?.preventDefault?.();
  const opener = event?.type === "contextmenu" ? null : event?.currentTarget || null;
  menu.innerHTML = overflowMenuHtml({ title, items, data });
  const close = openPopover(menu, { opener: opener || event?.currentTarget || null });
  const rect = menu.getBoundingClientRect();
  const anchor = opener?.getBoundingClientRect?.();
  const wantLeft = anchor ? anchor.right - rect.width : event?.clientX || 8;
  const wantTop = anchor ? anchor.bottom + 4 : event?.clientY || 8;
  menu.style.left = `${Math.max(8, Math.min(wantLeft, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(wantTop, window.innerHeight - rect.height - 8))}px`;
  menu.querySelectorAll('[role="menuitem"]').forEach((button) => {
    button.addEventListener("click", () => onPick?.(button.dataset.action, button));
  });
  menuKeys(menu, close);
  menu.querySelector('[role="menuitem"]')?.focus();
  return close;
}
