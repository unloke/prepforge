import { html } from "../html.js";
import { menuKeys, openPopover } from "./dialog.js";

// The ⋯ menu, one implementation for every row and header that has more
// actions than it shows. On a desktop it drops under its opener (right edges
// aligned) or opens at the cursor for a right-click; on a phone phone-kit.css
// turns the same popover into an action sheet at the thumb, headed by `title`
// (the object it acts on, as the Chess.com and Lichess apps do).
//
// items: [{ action, label, danger?, group?, children? }]. A change of `group` draws a
// separator, so a destructive action sits apart from the rest.
export function overflowMenuHtml({ title = "", items = [], data = {} }) {
  const attrs = Object.entries(data).map(([key, value]) => html` data-${key}="${value}"`);
  let group = items[0]?.group;
  return html`${title ? html`<div class="menu-title" aria-hidden="true">${title}</div>` : ""}${items.map((item) => {
    const sep = item.group !== group ? html`<div class="menu-sep" role="separator"></div>` : "";
    group = item.group;
    return html`${sep}<button type="button" role="menuitem" tabindex="-1" class="${item.danger ? "is-danger" : ""}" data-action="${item.action}"${item.children ? html` aria-haspopup="menu"` : ""}${attrs}>${item.label}${item.children ? html`<span class="menu-forward" aria-hidden="true">›</span>` : ""}</button>`;
  })}`;
}

export function openOverflowMenu(menu, { event, title = "", items, data = {}, onPick }) {
  event?.preventDefault?.();
  const opener = event?.type === "contextmenu" ? null : event?.currentTarget || null;
  menu.innerHTML = overflowMenuHtml({ title, items, data });
  const close = openPopover(menu, { opener: opener || event?.currentTarget || null });
  const stack = [];
  function paint(current, heading, focusAction) {
    menu.innerHTML = overflowMenuHtml({ title: stack.length ? "" : heading, items: [
      ...(stack.length ? [{ action: "menu-back", label: `← ${heading}`, group: -1 }] : []), ...current,
    ], data });
    position();
    menu.querySelectorAll('[role="menuitem"]').forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.action === "menu-back") return back();
        const item = current.find((item) => item.action === button.dataset.action);
        if (item?.children) {
          stack.push({ items: current, heading, action: item.action });
          paint(item.children, item.label);
        } else onPick?.(button.dataset.action, button);
      });
    });
    menuKeys(menu, close);
    const walk = menu.onkeydown;
    menu.onkeydown = (event) => {
      if (event.key === "ArrowLeft" && stack.length) { event.preventDefault(); event.stopPropagation(); back(); }
      else if (event.key === "ArrowRight" && current.find((item) => item.action === document.activeElement?.dataset.action)?.children) {
        event.preventDefault(); event.stopPropagation(); document.activeElement.click();
      } else walk(event);
    };
    const buttons = [...menu.querySelectorAll('[role="menuitem"]')];
    (buttons.find((button) => button.dataset.action === focusAction) || buttons[0])?.focus();
  }
  function back() {
    const previous = stack.pop();
    paint(previous.items, previous.heading, previous.action);
  }
  function position() {
    const rect = menu.getBoundingClientRect();
    const anchor = opener?.getBoundingClientRect?.();
    const wantLeft = anchor ? anchor.right - rect.width : event?.clientX || 8;
    const wantTop = anchor ? anchor.bottom + 4 : event?.clientY || 8;
    menu.style.left = `${Math.max(8, Math.min(wantLeft, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(wantTop, window.innerHeight - rect.height - 8))}px`;
  }
  paint(items, title);
  return close;
}
