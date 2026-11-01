// CSS guard: no stylesheet over MAX_LINES lines, and no !important outside the
// allowlist. Each allowed rule beats something a cascade cannot: an inline style
// set by JS, or every other rule by design ([hidden], reduced motion).
// Run by `npm run lint:js` (CI) and on its own as `npm run lint:css`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 1500;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// "file|selector" (selector with whitespace collapsed).
const ALLOWED = new Set([
  "web-src/styles/base.css|[hidden]",
  "web-src/styles/reduced-motion.css|*, *::before, *::after, *::backdrop",
  "web-src/engine-unlock.css|.unlock-bar.is-busy i", // inline width from engine-unlock.js
  "web-src/views/settings.css|.dl-bar.is-busy i", // inline width from settings-downloads.js
  "web-src/views/build.css|.dock.is-folded", // inline flex-basis / min-height from the dock fit and drag
  "web-src/views/build.css|.dock", // stacked layout, same inline flex-basis
  "web-src/phone/pages.css|#view-settings .conn-menu", // inline top/left from account.js
  "web-src/phone/study.css|.context-menu:not(.account-menu)", // inline top/left from menu openers
]);

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : cssFiles(path);
    return e.name.endsWith(".css") ? [path] : [];
  });
}

// The selector of every declaration block holding an !important declaration.
function importantRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const found = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      stack.push(text.slice(start, i).trim().replace(/\s+/g, " "));
      start = i + 1;
    } else if (ch === "}" || ch === ";") {
      const chunk = text.slice(start, i);
      if (/!\s*important/i.test(chunk) && stack.length) {
        found.push({ selector: stack.at(-1), line: text.slice(0, i).split("\n").length });
      }
      if (ch === "}") stack.pop();
      start = i + 1;
    }
  }
  return found;
}

const errors = [];
let kept = 0;
for (const file of cssFiles(join(root, "web-src"))) {
  const rel = relative(root, file).split("\\").join("/");
  const css = readFileSync(file, "utf8");
  const lines = css.split("\n").length;
  if (lines > MAX_LINES) errors.push(`${rel}: ${lines} lines (max ${MAX_LINES}); split it by view or component`);
  for (const { selector, line } of importantRules(css)) {
    if (ALLOWED.has(`${rel}|${selector}`)) kept += 1;
    else errors.push(`${rel}:${line}: !important in "${selector}" is not allowlisted; raise the selector's specificity instead`);
  }
}

if (errors.length) {
  console.error(`css-guard: ${errors.length} problem(s)\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
console.log(`css-guard: ok (${kept} allowlisted !important, max ${MAX_LINES} lines)`);
