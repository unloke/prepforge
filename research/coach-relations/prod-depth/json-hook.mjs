// Node loader hook: lets production's `import("./deepening-router-model.json")` (bundled in the
// browser) load under plain Node. Registered by analyze-games.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function load(url, context, next) {
  if (url.endsWith(".json")) {
    return { format: "module", shortCircuit: true, source: `export default ${readFileSync(fileURLToPath(url), "utf8")};` };
  }
  return next(url, context);
}
