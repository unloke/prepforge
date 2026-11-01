// The eager stylesheet as one text: styles.css with its @imports inlined in
// cascade order, the way Vite bundles it. Tests that read the shared CSS read
// this, so moving a rule between the split files doesn't change what they find.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const inline = (file) =>
  readFileSync(join(root, file), "utf8").replace(/^@import "\.\/(.+)";$/gm, (_, path) => inline(path));

export const eagerCss = inline("styles.css");
