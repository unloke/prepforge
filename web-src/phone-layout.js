// The More sheet is the phone bar's overflow menu. The bar is hidden above the
// phone breakpoint, so a sheet left open when the window widens must close:
// otherwise it survives as a full-width bottom sheet over the desktop board.
export const PHONE_QUERY = "(max-width: 760px)";

export function closeSheetOffPhone(close, matchMedia = globalThis.matchMedia) {
  const media = matchMedia?.(PHONE_QUERY);
  if (!media?.addEventListener) return () => {};
  const onChange = (event) => {
    if (!event.matches) close();
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
