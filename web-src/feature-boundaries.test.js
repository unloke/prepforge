import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Train and Build reach other features only through the shell's contracts
// (core/app-context.js) and the handoff records (handoff-context.js), never by
// importing another feature's modules. Identity (account-entry.js), shared
// state and services (core/, board/, engine/) and chess utilities are not
// features. A file belongs to the feature its name starts with, in web-src,
// controllers/ or views/.
const ROOT = dirname(fileURLToPath(import.meta.url));
const FEATURES = ["train", "build", "coverage", "analyze", "scout", "games", "library", "teams", "settings"];
// Coverage is the Build inspector's own tool.
const OWNER = { coverage: "build" };
// Modules named after a feature that are shared utilities rather than that
// feature: the PGN parser is used by Account, Build and Analyze alike.
const SHARED = new Set(["analyze-pgn.js"]);

function featureOf(path) {
  if (SHARED.has(path)) return null;
  const name = path.replace(/^(controllers|views)\//, "");
  const feature = FEATURES.find((prefix) => name.startsWith(prefix));
  return feature ? OWNER[feature] || feature : null;
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.js$/.test(entry.name) && !/\.test\.js$|fixture/.test(entry.name) ? [path] : [];
  });
}

function crossFeatureImports(feature) {
  const found = [];
  for (const file of sources(ROOT)) {
    const from = relative(ROOT, file).split(sep).join("/");
    if (featureOf(from) !== feature) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const to = posix.normalize(posix.join(posix.dirname(from), match[1]));
      const owner = featureOf(to);
      if (owner && owner !== feature) found.push(`${from} -> ${to}`);
    }
  }
  return found;
}

describe("feature boundaries", () => {
  it.each(["train", "build"])("%s imports no other feature's modules", (feature) => {
    expect(crossFeatureImports(feature)).toEqual([]);
  });
});
