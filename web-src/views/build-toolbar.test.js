// The Build panel over the tree: the next move's candidates, then the tree
// itself (its current move is the "you are here"; there is no separate trail).
// A folded dock keeps no height from an earlier fit, so the tree gets the panel.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const session = readFileSync(new URL("../controllers/build-session.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

it("the candidates sit over the tree, with no position trail", () => {
  const above = html.slice(html.indexOf('id="build-empty"'), html.indexOf('class="tree-wrap"'));
  expect(above).toMatch(/id="build-branchbar"/);
  expect(html).not.toMatch(/build-tree-meta|class="crumbs"/);
});

it("the dock's tools share the row with its tabs", () => {
  const head = html.slice(html.indexOf('<div class="dock-head">'), html.indexOf('<div class="dock-body">'));
  expect(head).toMatch(/class="dock-tabs"/);
  expect(head).toMatch(/id="build-dock-tools"/);
  expect(head).toMatch(/id="build-dock-fold"/);
});

it("a dragged inspector holds its height; the tree takes the rest", () => {
  expect(css).toMatch(/\.dock\[data-dock-pinned="1"\] \{[^}]*flex-grow:\s*0/);
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

it("a phone's Explorer or Coverage pane opens the dock, which the user may have folded", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  expect(app).toMatch(/if \(pane !== "moves"\) setBuildDockFolded\(false, \{ remember: false \}\);/);
});

it("the opening name rides the repertoire title's row", () => {
  const head = html.slice(html.indexOf('id="build-rep-header"'), html.indexOf('<div class="panel-body">'));
  expect(head).toMatch(/<div class="rep-title">\s*<h1 class="rep-name" id="build-rep-name"[\s\S]*?<span class="build-opening" id="build-opening"/);
  expect(css).toMatch(/\.rep-title \{[^}]*align-items: baseline;/);
});
