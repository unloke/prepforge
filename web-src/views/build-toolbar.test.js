// The Build panel's header is one toolbar row: the position trail and the
// candidates share a band. The inspector starts folded, and a folded dock
// keeps no height from an earlier fit, so the tree gets the panel.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const session = readFileSync(new URL("../controllers/build-session.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

it("the trail and the candidates sit in one toolbar", () => {
  const toolbar = /<div class="build-toolbar">([\s\S]*?)<\/div>\s*\n\s*<div class="tree-wrap"/.exec(html);
  expect(toolbar, "the build-toolbar wrapper").not.toBeNull();
  expect(toolbar[1]).toMatch(/id="build-tree-meta"/);
  expect(toolbar[1]).toMatch(/id="build-branchbar"/);
});

it("the inspector is open unless the user folded it, and remembers the choice", () => {
  expect(session).toMatch(/readDockStore\(BUILD_DOCK_FOLDED_KEY\) === "1"/);
  expect(session).toMatch(/folded \? "1" : "0"/);
});

it("a folded dock keeps no height from an earlier fit", () => {
  const fit = session.slice(session.indexOf("function fitBuildDock()"), session.indexOf("// `pinned` is a height"));
  expect(fit).toMatch(/is-folded/);
  expect(fit.indexOf("is-folded")).toBeLessThan(fit.indexOf("buildDockMaxHeight()"));
});

it("the toolbar stacks only in a narrow panel", () => {
  expect(css).toMatch(/@container build-panel \(max-width: 440px\)/);
});

it("on a phone the toolbar stacks by viewport: the panel is display: contents there", () => {
  expect(css).toMatch(/@media \(max-width: 760px\) \{\s*\.build-toolbar \{ flex-wrap: wrap; \}/);
});

it("a phone's Explorer or Coverage pane opens the dock, which the user may have folded", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  expect(app).toMatch(/if \(pane !== "moves"\) setBuildDockFolded\(false, \{ remember: false \}\);/);
});

it("the opening name sits under the repertoire title, not in the toolbar row", () => {
  const head = html.slice(html.indexOf('id="build-rep-header"'), html.indexOf('<div class="panel-body">'));
  expect(head).toMatch(/<div class="rep-title">\s*<h1 class="rep-name" id="build-rep-name"[\s\S]*?<span class="build-opening" id="build-opening"/);
  const toolbar = html.slice(html.indexOf('class="build-toolbar"'), html.indexOf('class="tree-wrap"'));
  expect(toolbar).not.toMatch(/build-opening/);
});
