// Discover the installed Stockfish threaded-lite build, copy it behind stable
// browser URLs, and emit metadata describing the exact bundled engine.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "node_modules", "stockfish");
const packageJsonPath = join(packageRoot, "package.json");
const srcDir = join(packageRoot, "bin");
const dstDir = join(repoRoot, "web-src", "public", "engine");

function fail(message) {
  throw new Error(`[sync-stockfish] ${message}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function discoverStockfishBuild({ packageJson, files }) {
  const buildVersion = String(packageJson.buildVersion || "").trim();
  if (!packageJson.version || !buildVersion) {
    fail("installed package metadata must include version and buildVersion");
  }
  const candidates = files.filter((name) => /^stockfish-[^-]+-lite\.js$/.test(name));
  if (candidates.length !== 1) {
    fail(`expected exactly one threaded lite JS build, found: ${candidates.join(", ") || "none"}`);
  }
  const sourceJs = candidates[0];
  const sourceWasm = sourceJs.replace(/\.js$/, ".wasm");
  if (!files.includes(sourceWasm)) fail(`missing WASM pair for ${sourceJs}`);
  const filenameVersion = sourceJs.match(/^stockfish-([^-]+)-lite\.js$/)?.[1];
  if (filenameVersion !== buildVersion) {
    fail(`package buildVersion ${buildVersion} does not match ${sourceJs}`);
  }
  return { sourceJs, sourceWasm, buildVersion };
}

export function syncStockfish() {
  if (!existsSync(packageJsonPath) || !existsSync(srcDir)) {
    fail("stockfish package is not installed; run `npm ci` first");
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const { sourceJs, sourceWasm, buildVersion } = discoverStockfishBuild({
    packageJson,
    files: readdirSync(srcDir),
  });
  const outputs = [
    { source: sourceJs, bundled: "stockfish-lite.js" },
    { source: sourceWasm, bundled: "stockfish-lite.wasm" },
  ];
  mkdirSync(dstDir, { recursive: true });
  for (const output of outputs) {
    copyFileSync(join(srcDir, output.source), join(dstDir, output.bundled));
    console.log(`[sync-stockfish] copied ${output.source} -> ${output.bundled}`);
  }
  const manifest = {
    package: "stockfish",
    packageVersion: packageJson.version,
    engineVersion: buildVersion,
    variant: "lite-threaded",
    files: Object.fromEntries(
      outputs.map(({ source, bundled }) => [
        bundled.endsWith(".js") ? "script" : "wasm",
        { bundled, source, sha256: sha256(join(dstDir, bundled)) },
      ]),
    ),
  };
  writeFileSync(
    join(dstDir, "stockfish.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(`[sync-stockfish] bundled Stockfish ${packageJson.version}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    syncStockfish();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
