import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Run after the production build. Include new output files as well as tracked
// changes: diff alone misses an untracked generated chunk.
export function checkStaticFreshness(cwd = root) {
  const scope = "src/prepforge_chess/web/static";
  const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", scope],
    { cwd, encoding: "utf8" }).trim();
  if (changes) {
    const summary = execFileSync("git", ["diff", "--summary", "--", scope],
      { cwd, encoding: "utf8" }).trim();
    const textDiff = execFileSync("git", ["diff", "--", `${scope}/maia3/maia3.manifest.json`],
      { cwd, encoding: "utf8" }).trim();
    throw new Error([
      "Production static output is stale. Run npm run build and commit its output.",
      changes,
      summary && `Git diff summary:\n${summary}`,
      textDiff && `Manifest diff:\n${textDiff}`,
    ].filter(Boolean).join("\n"));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    checkStaticFreshness();
    console.log("Committed production static output matches the build.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
