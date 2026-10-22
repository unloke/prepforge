// A job card spends its run as a spinner, then becomes a tick (or a cross) the
// moment the work lands. The swap used to be silent: the ring that had been
// turning simply read as a check, and a full-game analysis finishing — the
// payoff of the whole screen — looked like nothing had happened.
//
// The mark lands once, in place. The spinner stays the one looping animation,
// and it only runs while the job does.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector, from = 0) {
  const start = css.indexOf(`${selector} {`, from);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

describe("a finished job's notice", () => {
  it("lands its mark once on success", () => {
    expect(rule('.notice[data-state="done"] .notice-icon')).toMatch(/animation:\s*notice-land var\(--dur-slow\) var\(--ease-emphasis\)/);
    const frames = /@keyframes notice-land \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).toContain("scale(0.6)");
    // One gesture, not a loop.
    expect(frames).not.toMatch(/infinite/);
  });

  it("gives a failure its own, quicker landing", () => {
    expect(rule('.notice[data-state="failed"] .notice-icon')).toMatch(/animation:\s*notice-land 200ms/);
  });

  it("keeps the spinner as the only looping animation", () => {
    expect(rule('.notice[data-state="running"] .notice-icon')).toMatch(/animation:\s*spin 900ms linear infinite/);
    // The landed states never animate forever.
    expect(rule('.notice[data-state="done"] .notice-icon')).not.toMatch(/infinite/);
    expect(rule('.notice[data-state="failed"] .notice-icon')).not.toMatch(/infinite/);
  });

  it("moves only transform", () => {
    const frames = /@keyframes notice-land \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).not.toMatch(/width|height|top:|left:|margin|padding|opacity/);
  });

  it("is collapsed by the global reduced-motion rule", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: 0\.001ms !important/);
  });
});
