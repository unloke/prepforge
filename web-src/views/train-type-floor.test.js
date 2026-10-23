// Nothing in the Train panel that is meant to be read sits under the body size
// (13px): Home's rows and chips, the picker, the session's lines and the
// result card all read at var(--fs) or larger, never at a small token.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8")
  + readFileSync(new URL("../train-shell.css", import.meta.url), "utf8");

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped} \\{[^}]*\\}`));
  expect(match, selector).not.toBeNull();
  return match[0];
};

const BODY = [
  ".train-row-meta", ".train-chip", ".train-blitz-row", ".train-coach-sub", ".train-scope-chip", ".train-count",
  ".train-outlook-lead", ".train-outlook-rest", ".train-outlook-quiet", ".train-picker-head", ".train-picker-group", ".train-pick", ".train-pick-sub",
  ".train-session-meta", ".un-row", ".sum-cells span", ".delta", ".train-recent", "#view-train .seg-btn", "#view-train .kchip",
];

it("the panel's own labels, counters and rows are at the body size", () => {
  for (const selector of BODY) expect(rule(selector), selector).toMatch(/font-size: var\(--fs\)/);
  expect(rule(".un-line")).toMatch(/font: var\(--fs\) var\(--mono\)/);
});

it("no small-size token is left in Train's own stylesheet", () => {
  const shell = readFileSync(new URL("../train-shell.css", import.meta.url), "utf8");
  expect(shell).not.toMatch(/var\(--fs-xs\)|var\(--fs-s\)|font-size: 1[012]px/);
});
