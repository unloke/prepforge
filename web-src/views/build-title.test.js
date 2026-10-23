// The Build screen's one h1 is the repertoire's name (or "No repertoire open").
// A hidden `.view-title` h1 kept the inspector quiet while a visible one
// returned a "Build" band above every repertoire; the name is the title now, so
// there is one heading and no band.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const build = html.slice(html.indexOf('id="view-build"'), html.indexOf('id="view-train"'));
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

it("the Build view's only h1 is the repertoire name", () => {
  const h1s = [...build.matchAll(/<h1\b[^>]*>/g)];
  expect(h1s).toHaveLength(1);
  expect(build).toMatch(/<h1 class="rep-name" id="build-rep-name"/);
  expect(build).not.toMatch(/view-title/);
});

it("no hidden title rule is left in the stylesheet", () => {
  expect(css).not.toMatch(/\.view-title\s*\{/);
});

it("the .study grid rule closes before its max-width and margin", () => {
  // Commit 80fb4d8f split this rule with `.view-title {}`, leaving two
  // declarations outside any selector.
  const rule = /\n\.study \{([^}]*)\}/.exec(css);
  expect(rule, "the .study layout rule").not.toBeNull();
  expect(rule[1]).toMatch(/width:\s*100%/);
  expect(rule[1]).toMatch(/max-width:\s*none/);
  expect(rule[1]).toMatch(/margin:\s*0/);
});
