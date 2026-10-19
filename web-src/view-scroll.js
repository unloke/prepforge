// A page change starts with the page's first row, not wherever the last one
// was scrolled to. Views keep their scroll offset only while their page is in
// the layout; Settings is shorter than Games, so leaving Games at 1500px made
// the next page open at the browser's clamped offset with its header
// off-screen. A bar that fits the screen already sits at 0, so a top click
// keeps the page still.
export function resetViewScroll(target = globalThis) {
  const doc = target.document;
  if (!doc) return 0;
  const top = doc.scrollingElement || doc.documentElement;
  if (!top) return 0;
  const offset = Number(top.scrollTop) || 0;
  if (offset) top.scrollTop = 0;
  return offset;
}
