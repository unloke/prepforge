// Viewport-safe popover + keyboard handling for the 1–5 engine line picker.

export function createLinesPicker({ trigger, menu, onPick }) {
  if (!trigger || !menu) return { close() {} };

  const position = () => {
    if (typeof window === "undefined") return;
    const btn = trigger.getBoundingClientRect?.();
    const box = menu.getBoundingClientRect?.();
    if (!btn || !box || !btn.width) return;
    const pad = 8;
    const gap = 6;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    let top = btn.bottom + gap;
    if (vh && top + box.height > vh - pad) top = Math.max(pad, btn.top - gap - box.height);
    let left = btn.right - box.width;
    if (left < pad) left = btn.left;
    if (vw) left = Math.max(pad, Math.min(vw - box.width - pad, left));
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  };

  const setOpen = (open, { focus = false } = {}) => {
    trigger.setAttribute("aria-expanded", String(open));
    menu.classList.toggle("is-open", open);
    if (open) {
      position();
      if (focus) {
        (menu.querySelector?.('[aria-checked="true"]') || menu.querySelector?.("[data-n]"))?.focus?.();
      }
    } else if (menu.style) {
      menu.style.top = "";
      menu.style.left = "";
    }
  };

  const isOpen = () => menu.classList.contains("is-open");

  menu.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-n]");
    if (!btn) return;
    onPick(Number(btn.dataset.n));
    setOpen(false);
    if (event.detail === 0) trigger.focus?.();
  });

  trigger.addEventListener("click", () => setOpen(!isOpen()));
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(true, { focus: true });
  });

  menu.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const btns = [...(menu.querySelectorAll?.("[data-n]") || [])];
    const idx = btns.indexOf(event.target.closest?.("[data-n]"));
    if (idx < 0 || !btns.length) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? btns.length - 1
        : (idx + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
    btns[next]?.focus?.();
  });

  menu.parentElement?.addEventListener("focusout", (event) => {
    if (!isOpen()) return;
    const next = event.relatedTarget;
    if (next && menu.parentElement?.contains?.(next)) return;
    setOpen(false);
  });

  globalThis.document?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    trigger.focus?.();
  });

  globalThis.document?.addEventListener("pointerdown", (event) => {
    if (isOpen() && !event.target.closest?.(".engine-head-tools")) setOpen(false);
  });

  globalThis.window?.addEventListener?.("resize", () => { if (isOpen()) position(); });

  return { close: () => setOpen(false) };
}
