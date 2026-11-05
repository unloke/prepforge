// What a Blitz card's clock shows: the bar over the board shrinking through the
// budget, and the whole seconds left beside it.
let tick = null;

export function hideBlitzClock(doc = globalThis.document) {
  if (tick) {
    globalThis.clearInterval(tick);
    tick = null;
  }
  const secs = doc?.getElementById("train-blitz-secs");
  if (secs) secs.hidden = true;
  const fill = doc?.getElementById("train-blitz-fill");
  if (fill) {
    fill.style.transition = "none";
    fill.style.width = "0%";
  }
}

export function showBlitzClock(seconds, doc = globalThis.document) {
  hideBlitzClock(doc);
  const fill = doc?.getElementById("train-blitz-fill");
  if (fill) {
    // Restart the shrink from full: kill the transition, snap to 100%, reflow,
    // then let one linear transition spend the whole budget.
    fill.style.width = "100%";
    void fill.offsetWidth;
    fill.style.transition = `width ${seconds}s linear`;
    fill.style.width = "0%";
  }
  const secs = doc?.getElementById("train-blitz-secs");
  if (!secs) return;
  const endsAt = performance.now() + seconds * 1000;
  const paint = () => {
    const left = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
    secs.textContent = String(left);
    secs.classList.toggle("is-low", left <= 3);
  };
  paint();
  secs.hidden = false;
  tick = globalThis.setInterval(paint, 250);
}
