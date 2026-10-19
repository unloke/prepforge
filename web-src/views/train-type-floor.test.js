// Nothing in the Train panel that is meant to be read sits under the body size
// (13px). The queue preview, the counters' labels, the up-next rows and the
// result card's cells were 11-12px, under the floor the house style sets, and
// the panel read as mush: six sizes within six pixels.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, "styles.css"), "utf8");

const at = (pattern) => {
  const match = css.match(pattern);
  expect(match, pattern.source).not.toBeNull();
  return match[0];
};

it("the panel's own labels, counters and rows are at the body size", () => {
  for (const pattern of [
    /\.train-session-preview \{[^}]*font-size: var\(--fs\)/,
    /\.train-picker-label \{[^}]*font-size: var\(--fs\)/,
    /\.train-blitz-row \{[^}]*font-size: var\(--fs\)/,
    /\.train-coach-sub \{[^}]*font-size: var\(--fs\)/,
    /\.train-mode-name \{[^}]*font-size: var\(--fs\)/,
    /\.stat span \{[^}]*font-size: var\(--fs\)/,
    /\.trail \{[^}]*font-size: var\(--fs\)/,
    /\.trail-empty \{[^}]*font-size: var\(--fs\)/,
    /\.un-row \{[^}]*font-size: var\(--fs\)/,
    /\.un-line \{[^}]*font: var\(--fs\) var\(--mono\)/,
    /\.sum-cells span \{[^}]*font-size: var\(--fs\)/,
    /\.tsum-row \{[^}]*font-size: var\(--fs\)/,
    /#view-train \.tcard p,\n#view-train \.note \{ font-size: var\(--fs\); \}/,
    /#view-train \.seg-btn \{[^}]*font-size: var\(--fs\)/,
  ]) at(pattern);
});

it("no small-size token is left in the panel's own labels", () => {
  for (const selector of [".train-session-preview", ".train-picker-label", ".stat span", ".trail", ".un-row", ".sum-cells span", ".tsum-row"]) {
    const rule = css.match(new RegExp(`\\${selector} \\{[^}]*\\}`));
    expect(rule, selector).not.toBeNull();
    expect(rule[0], selector).not.toMatch(/var\(--fs-xs\)|var\(--fs-s\)|font-size: 1[12]px/);
  }
});
