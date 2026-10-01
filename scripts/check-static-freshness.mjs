import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Run after the production build. Include new output files as well as tracked
// changes: diff alone misses an untracked generated chunk.
export function checkStaticFreshness(cwd = root) {
  const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--",
    "src/prepforge_chess/web/static"], { cwd, encoding: "utf8" }).trim();
  if (changes) {
    throw new Error(`Production static output is stale. Run npm run build and commit its output.\n${changes}`);
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
