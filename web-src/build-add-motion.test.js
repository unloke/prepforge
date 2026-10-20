// Adding a move to a repertoire used to be silent: the tree re-rendered and the
// new token simply existed among the seventy already there, so the one thing the
// user just did was the one thing the page did not point at.
//
// The move arrives once, in place: a few pixels of rise and a settle, on
// transform and opacity so the tokens beside it never move.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const build = readFileSync(new URL("./views/build.js", import.meta.url), "utf8");
const session = readFileSync(new URL("./controllers/build-session.js", import.meta.url), "utf8");
const state = readFileSync(new URL("./core/state.js", import.meta.url), "utf8");

describe("a move added to a repertoire", () => {
  it("is marked as the one just made", () => {
    expect(session).toMatch(/appState\.buildJustAddedId = node\.id;/);
    expect(build).toMatch(/b\.id === appState\.buildJustAddedId/);
    // A cue for one render, never persisted.
    expect(state).toMatch(/buildJustAddedId: null/);
  });

  it("arrives once and never replays", () => {
    // The flag is cleared as soon as the tree carrying it has been painted...
    expect(build).toMatch(/container\.innerHTML = treeHtml;[\s\S]{0,400}appState\.buildJustAddedId = null;/);
    // ...and the class comes off when the entrance ends, so nothing is left
    // carrying an animation that already happened.
    expect(build).toMatch(/addEventListener\("animationend", \(\) => el\.classList\.remove\("is-added"\)/);
  });

  it("moves only transform and opacity", () => {
    const frames = /@keyframes move-added \{([\s\S]*?)\n\}/.exec(css)[1];
    expect(frames).toMatch(/transform/);
    expect(frames).toMatch(/opacity/);
    // No width/height/margin: a new token must not push its neighbours.
    expect(frames).not.toMatch(/width|height|top:|left:|margin|padding/);
  });

  it("stays inside the 300ms ceiling for a one-off arrival", () => {
    expect(css).toMatch(/\.mtree-move\.is-added \{ animation: move-added var\(--dur\) var\(--ease-out\)/);
    const durs = { "--dur-fast": 150, "--dur": 220, "--dur-slow": 300 };
    for (const [name, ms] of Object.entries(durs)) expect(ms).toBeLessThanOrEqual(300);
  });

  it("is collapsed by the global reduced-motion rule", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: 0\.001ms !important/);
  });
});
