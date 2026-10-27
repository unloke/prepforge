// Measures a control's real tap target on the page: the box elementFromPoint
// still resolves to the control (or something inside it), probed outwards
// from its centre. Round 5 draws 36px controls with a transparent 44px band
// round them (phone.css), so the drawn box is not the target; this is.
// Runs inside page.evaluate: pass hitAreaSource and call it there.
export const hitAreaSource = `(el) => {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { w: 0, h: 0 };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const owns = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  };
  const reach = (dx, dy) => {
    let n = 0;
    const max = 40;
    while (n < max && owns(cx + dx * (n + 1), cy + dy * (n + 1))) n += 1;
    return n;
  };
  if (!owns(cx, cy)) return { w: 0, h: 0, covered: true };
  return { w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1, drawnW: r.width, drawnH: r.height };
}`;
