// A stylesheet as one text, its @imports inlined in cascade order the way Vite
// bundles it. Tests that read CSS read this, so moving a rule between the split
// files of one sheet doesn't change what they find.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export function cssSource(file) {
  const dir = dirname(file);
  return readFileSync(join(root, file), "utf8")
    .replace(/^@import "\.\/(.+)";$/gm, (_, path) => cssSource(join(dir, path)));
}

export const eagerCss = cssSource("styles.css");
