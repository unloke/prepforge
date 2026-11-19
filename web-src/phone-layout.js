// The More sheet is the phone bar's overflow menu. The bar is hidden above the
// phone breakpoint, so a sheet left open when the window widens must close:
// otherwise it survives as a full-width bottom sheet over the desktop board.
export const PHONE_QUERY = "(max-width: 760px), (max-width: 960px) and (max-height: 520px) and (orientation: landscape)";

export function closeSheetOffPhone(close, matchMedia = globalThis.matchMedia) {
  const media = matchMedia?.(PHONE_QUERY);
  if (!media?.addEventListener) return () => {};
  const onChange = (event) => {
    if (!event.matches) close();
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

// Fixed study screens and top-layer sheets must fit above the software keyboard.
export function trackVisualViewport(win = window, root = document.documentElement) {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  let frame = null;
  let last = "";
  const update = () => {
    frame = null;
    // Pinch zoom must magnify the existing layout, not shrink it to the lens.
    if (viewport.scale !== 1) return;
    const height = Math.round(viewport.height);
    const top = Math.round(viewport.offsetTop);
    if (height <= 0) return;
    const bottom = Math.max(0, Math.round(win.innerHeight - viewport.height - viewport.offsetTop));
    const key = `${height}/${top}/${bottom}`;
    if (key === last) return;
    last = key;
    root.style.setProperty("--viewport-height", `${height}px`);
    root.style.setProperty("--viewport-top", `${top}px`);
    root.style.setProperty("--viewport-bottom", `${bottom}px`);
  };
  const schedule = () => { frame ??= win.requestAnimationFrame(update); };
  viewport.addEventListener("resize", schedule, { passive: true });
  viewport.addEventListener("scroll", schedule, { passive: true });
  win.addEventListener("resize", schedule, { passive: true });
  update();
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    for (const name of ["--viewport-height", "--viewport-top", "--viewport-bottom"]) root.style.removeProperty(name);
  };
}
