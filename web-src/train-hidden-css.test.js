// Regression for the 2026-10-01 walkthrough: the queue composition bar was set
// `hidden` by views/train.js, but `.qbar { display: flex }` beat the UA [hidden]
// rule and left an empty grey strip in the Train panel. Every element the Train
// view hides must actually disappear.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(root, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(join(root, "index.html"), "utf8");
const trainView = readFileSync(join(root, "views", "train.js"), "utf8");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rules whose whole selector list contains exactly `selector`.
function declarationsFor(selector) {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

const displayOf = (decls) => {
  let value = null;
  for (const d of decls) {
    const hit = d.match(/(?:^|;)\s*display\s*:\s*([^;!]+)/);
    if (hit) value = hit[1].trim();
  }
  return value;
};

// Does an element with these classes still render while `hidden`?
function visibleWhileHidden(classes) {
  const overridden = classes.filter((c) => {
    const shown = displayOf(declarationsFor(`.${c}`));
    return shown && shown !== "none";
  });
  return overridden.filter((c) => displayOf(declarationsFor(`.${c}[hidden]`)) !== "none");
}

function hiddenToggledIds() {
  const ids = new Set();
  const re = /const (\w+) = document\.getElementById\("([\w-]+)"\);[\s\S]*?\1\.hidden = true/g;
  let m;
  while ((m = re.exec(trainView))) ids.add(m[2]);
  return [...ids];
}

function classesOf(id) {
  const tag = html.match(new RegExp(`<[^>]*\\bid="${escapeRe(id)}"[^>]*>`));
  if (!tag) return null;
  const cls = tag[0].match(/\bclass="([^"]*)"/);
  return cls ? cls[1].split(/\s+/).filter(Boolean) : [];
}

describe("Train view hidden elements", () => {
  it("finds the queue bar among the elements the view hides", () => {
    expect(hiddenToggledIds()).toContain("train-queue-bar");
  });

  it("the queue composition bar is gone when hidden", () => {
    expect(visibleWhileHidden(classesOf("train-queue-bar"))).toEqual([]);
  });

  it("no element the Train view hides is kept visible by a class display rule", () => {
    const leaks = hiddenToggledIds()
      .map((id) => ({ id, classes: classesOf(id) }))
      .filter((e) => e.classes)
      .map((e) => ({ id: e.id, leaks: visibleWhileHidden(e.classes) }))
      .filter((e) => e.leaks.length);
    expect(leaks).toEqual([]);
  });
});
