// The Train banner answers an answer. It used to wobble the same way for a
// right and a wrong move, so the verdict was carried by colour alone, and a
// hint produced no response at all even though that is the moment the user
// asked the app for help.
//
// The motion is one gesture per change: a right answer pops its tick, a wrong
// one gives a single short nudge (never a shake loop), and a hint or an
// opponent reply only brings its line in, because it is news and not a verdict.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");

const body = (selector) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
};

describe("the Train judge", () => {
  it("pops the tick for a right answer", () => {
    expect(css).toContain('#train-banner[data-state="correct"].flash .train-coach-icon {');
    expect(body('#train-banner[data-state="correct"].flash .train-coach-icon')).toMatch(/animation:\s*judge-mark/);
    const frames = /@keyframes judge-mark \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).toContain("scale(0.5)");
  });

  it("nudges once for a wrong answer, with no loop", () => {
    expect(body('#train-banner[data-state="wrong"].flash .train-coach-icon')).toMatch(/animation:\s*judge-nudge/);
    const frames = /@keyframes judge-nudge \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).toMatch(/translateX/);
    expect(frames).not.toMatch(/rotate|infinite/);
  });

  it("brings a hint's line in without gesturing", () => {
    // Every change animates the line; only a verdict animates the mark.
    expect(body("#train-banner.flash .train-coach-text")).toMatch(/animation:\s*judge-line/);
    expect(css).not.toMatch(/#train-banner\[data-state="move"\]\.flash \.train-coach-icon/);
  });

  it("replays on every answer and cleans up after itself", () => {
    // The class is removed and re-added on the next frame, so a second answer
    // is a second gesture; it comes off on animationend, so nothing is left
    // animating and a repeat is not swallowed.
    expect(app).toMatch(/banner\.classList\.remove\("flash"\)/);
    expect(app).toMatch(/requestAnimationFrame\(\(\) => banner\.classList\.add\("flash"\)\)/);
    expect(app).toMatch(/querySelector\("\.train-coach-text"\)\.addEventListener\("animationend", \(\) => banner\.classList\.remove\("flash"\)/);
    // No forced reflow: the old code flushed with `void banner.offsetWidth`.
    expect(app.slice(app.indexOf("function setTrainBanner"))).not.toMatch(/offsetWidth/);
  });

  it("moves only transform and opacity", () => {
    for (const name of ["judge-mark", "judge-nudge", "judge-line"]) {
      const frames = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css)[1];
      expect(frames).not.toMatch(/width|height|top:|left:|margin|padding/);
    }
  });

  it("is collapsed by the global reduced-motion rule", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: 0\.001ms !important/);
  });
});
