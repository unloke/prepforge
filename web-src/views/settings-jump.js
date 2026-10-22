// Settings: a jump from the section strip to its card.
// Scroll a card to just under the sticky strip (measured, so the phone's
// taller strip and the desktop's both clear it), then mark it landed once
// the scroll has settled. `done` runs when the jump is over.
let landTimer = 0;
export function jumpToSection(target, done = () => {}) {
  const reduceMotion = Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  const nav = document.querySelector(".settings-nav");
  const navStyle = nav && globalThis.getComputedStyle?.(nav);
  if (navStyle?.position === "sticky") {
    const offset = (parseFloat(navStyle.top) || 0) + nav.offsetHeight + 12;
    target.style.scrollMarginTop = `${Math.round(offset)}px`;
  }
  let moved = false;
  let finished = false;
  // Only the scroller carrying the card counts: the strip scrolls sideways
  // to its open link at the same moment and must not end the jump.
  const carries = (event) => event.target === document || event.target?.contains?.(target);
  const onScroll = (event) => { if (carries(event)) moved = true; };
  const onEnd = (event) => { if (carries(event)) finish(); };
  const finish = () => {
    if (finished) return;
    finished = true;
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("scrollend", onEnd, true);
    if (!reduceMotion) land(target, false);
    done();
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  // A jump without travel lands at once; the scroll lock still waits for the
  // jump's own scroll event to pass.
  if (reduceMotion) land(target, true);
  // Already in place (no scroll started within a few frames): land now.
  // Otherwise when the scroll ends, capped for browsers without scrollend.
  document.addEventListener("scrollend", onEnd, true);
  setTimeout(() => { if (!moved) finish(); }, 120);
  setTimeout(finish, 1000);
}

function land(target, reduceMotion) {
  document.querySelectorAll(".settings-content > .set.is-landed").forEach((card) => card.classList.remove("is-landed"));
  void target.offsetWidth; // restart when the same card is picked twice
  target.classList.add("is-landed");
  clearTimeout(landTimer);
  landTimer = setTimeout(() => target.classList.remove("is-landed"), reduceMotion ? 900 : 1400);
}
