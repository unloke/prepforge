// One implementation of "a fresh list arrives item by item". The CSS
// (.list-enter) does the animating; this only numbers the rows so each one
// waits its turn, and re-arms the class so a later render plays again.
const CAP = 8;

export function staggerRows(container) {
  if (!container?.children) return;
  [...container.children].forEach((row, i) => {
    row.style.setProperty("--i", String(Math.min(i, CAP)));
  });
}
