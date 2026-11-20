import { openOverflowMenu } from "../core/overflow-menu.js";

const guardedMenus = new WeakSet();

export function openBuildOverflowMenu(menu, options) {
  if (!guardedMenus.has(menu)) {
    guardedMenus.add(menu);
    let dismissing = false;
    const consume = (event) => {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", () => { dismissing = false; }, true);
    document.addEventListener("pointerdown", (event) => {
      dismissing = false;
      if (!document.getElementById("view-build")?.classList.contains("is-active")
        || !menu.matches(":popover-open") || menu.contains(event.target)) return;
      dismissing = true;
      consume(event);
      menu.hidePopover();
    }, true);
    for (const type of ["pointerup", "pointercancel", "mousedown", "mouseup", "click", "touchstart", "touchmove", "touchend", "touchcancel"]) {
      document.addEventListener(type, (event) => {
        if (dismissing) consume(event);
      }, { capture: true, passive: false });
    }
  }
  return openOverflowMenu(menu, options);
}
