// Every overlay in the app is a native one. A modal is a <dialog> opened with
// showModal(): the browser puts it in the top layer, makes the page behind it
// inert, keeps Tab inside it, closes it on Escape and dims the page with its
// ::backdrop. A menu or a picker is a [popover="auto"]: the browser closes it on
// Escape and on a press outside it. What is left here is what the platform does
// not do: name the dialog after its heading, close on a backdrop press, hand
// focus back to the control that opened it, and leave the DOM once the exit
// transition has played.

// A dialog to fill: `modalDialog("share-modal")` → <dialog class="modal share-modal">.
// On a phone every .modal is a bottom sheet (phone.css); `sheet` names the More
// sheet's own look.
export function modalDialog(className = "", attrs = {}) {
  const dialog = document.createElement("dialog");
  dialog.className = `modal ${className}`.trim();
  for (const [name, value] of Object.entries(attrs)) dialog.setAttribute(name, value);
  return dialog;
}

let headingIds = 0;
function labelByHeading(dialog) {
  if (dialog.hasAttribute("aria-label") || dialog.hasAttribute("aria-labelledby")) return;
  const heading = dialog.querySelector(".modal-title, h1, h2, h3");
  if (!heading) return;
  heading.id ||= `dialog-title-${++headingIds}`;
  dialog.setAttribute("aria-labelledby", heading.id);
}

const inside = (rect, event) =>
  event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;

// After the exit transition (display/overlay allow-discrete), or at once when
// there is none (reduced motion).
function afterExit(el, done) {
  const running = el.getAnimations?.() || [];
  if (!running.length) return done();
  Promise.allSettled(running.map((animation) => animation.finished)).then(done);
}

function restore(opener) {
  if (opener?.isConnected && opener !== document.body && opener.getClientRects().length) opener.focus({ preventScroll: true });
}

// Opens `dialog` modally and returns close(). Escape and a backdrop press call
// `onDismiss` (default: close). `keep` leaves a static dialog in the document.
export function openModal(dialog, { initialFocus = null, onDismiss = null, keep = false } = {}) {
  if (!dialog.isConnected) document.body.append(dialog);
  labelByHeading(dialog);
  const opener = document.activeElement;
  let done = false;
  const dismiss = () => (onDismiss ? onDismiss() : close());
  // Backdrop: a press that both starts and ends outside the box, so a text
  // selection dragged out of a field never closes the dialog.
  let pressedOutside = false;
  const outside = (event) => event.target === dialog && !inside(dialog.getBoundingClientRect(), event);
  const onPointerDown = (event) => { pressedOutside = outside(event); };
  const onClick = (event) => {
    if (pressedOutside && outside(event)) dismiss();
    pressedOutside = false;
  };
  const finish = ({ restoreFocus }) => {
    if (done) return false;
    done = true;
    dialog.removeEventListener("pointerdown", onPointerDown);
    dialog.removeEventListener("click", onClick);
    dialog.removeEventListener("close", onNativeClose);
    if (restoreFocus) restore(opener);
    if (!keep) afterExit(dialog, () => { if (!dialog.open) dialog.remove(); });
    return true;
  };
  // Escape closes a modal natively (the browser may refuse a cancelled
  // `cancel`), so the native close is the dismissal.
  const onNativeClose = () => { if (finish({ restoreFocus: true })) onDismiss?.(); };
  dialog.addEventListener("pointerdown", onPointerDown);
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("close", onNativeClose);
  dialog.showModal();
  const focus = typeof initialFocus === "function" ? initialFocus() : initialFocus;
  focus?.focus({ preventScroll: true });
  function close({ restoreFocus = true } = {}) {
    if (!finish({ restoreFocus: false })) return;
    if (dialog.open) dialog.close();
    if (restoreFocus) restore(opener);
  }
  close.dialog = dialog;
  return close;
}

// Shows a [popover] menu or picker and returns close(); the caller places it.
// `onClose` runs once however it closed (Escape, a press outside, close()).
// The opener is the popover's source, so pressing it again toggles instead of
// light-dismissing and reopening.
export function openPopover(el, { opener = null, onClose = null } = {}) {
  if (!el.hasAttribute("popover")) el.setAttribute("popover", "auto");
  if (el.matches(":popover-open")) el.hidePopover();
  // A modal makes everything outside it inert, so a menu opened from inside
  // one (the account menu from the More sheet) has to live inside it.
  const host = opener?.closest?.("dialog[open]") || null;
  if (host ? !host.contains(el) : !el.isConnected || el.closest("dialog:not([open])")) (host || document.body).append(el);
  opener?.setAttribute?.("aria-expanded", "true");
  let done = false;
  const onToggle = (event) => {
    if (event.newState !== "closed" || done) return;
    done = true;
    el.removeEventListener("toggle", onToggle);
    opener?.setAttribute?.("aria-expanded", "false");
    // Escape (or Tab out) leaves focus nowhere: give it back to the opener.
    // A press outside already put it where the press landed.
    const active = document.activeElement;
    if (!active || active === document.body || el.contains(active)) restore(opener);
    onClose?.();
  };
  el.addEventListener("toggle", onToggle);
  try {
    el.showPopover(opener ? { source: opener } : undefined);
  } catch {
    el.showPopover();
  }
  return function close() {
    if (el.matches(":popover-open")) el.hidePopover();
  };
}

export const isPopoverOpen = (el) => !!el?.matches?.(":popover-open");

// Arrow keys walk a menu's items, Home/End jump, Tab leaves (closing it).
// Escape is the popover's own.
export function menuKeys(menu, close) {
  const items = () => [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')];
  menu.onkeydown = (event) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const list = items();
      const index = list.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (event.key === "Tab") {
      close();
    }
  };
}
