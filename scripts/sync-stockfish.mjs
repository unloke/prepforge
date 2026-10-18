// Discover the installed Stockfish threaded-lite build, copy it behind stable
// browser URLs, and emit metadata describing the exact bundled engine.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
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

// The upstream script asks for a shared WASM heap with a 2 GB maximum. WebKit reserves a
// shared memory's whole maximum up front, so on iOS three or four engines (analysis pool plus
// the live board) exhaust the address space and abort with "OOM" on a phone with RAM to spare.
// The lite engine runs in its 128 MB initial heap; 256 MB leaves room to grow.
const MAX_HEAP_PAGES = 4096;
const UPSTREAM_MEMORY = "maximum:32768,shared:!0";

export function capSharedHeap(script) {
  if (!script.includes(UPSTREAM_MEMORY)) fail("shared WebAssembly.Memory declaration changed upstream");
  return script.replace(UPSTREAM_MEMORY, `maximum:${MAX_HEAP_PAGES},shared:!0`);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
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

// The browser's engine: the capped script and its wasm, and the engine's identity
// "sf<build>@<package version>+<wasm sha8>/<net>". npm can ship a new build under the same
// version, so the identity names the wasm itself and the net embedded in it.
export function stockfishBuild() {
  if (!existsSync(packageJsonPath) || !existsSync(srcDir)) {
    fail("stockfish package is not installed; run `npm ci` first");
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const { sourceJs, sourceWasm, buildVersion } = discoverStockfishBuild({
    packageJson,
    files: readdirSync(srcDir),
  });
  const script = capSharedHeap(readFileSync(join(srcDir, sourceJs), "utf8"));
  const wasm = readFileSync(join(srcDir, sourceWasm));
  const nets = [...new Set(wasm.toString("latin1").match(/nn-[0-9a-f]{12}/g) || [])];
  if (nets.length !== 1) fail(`expected one embedded net, found: ${nets.join(", ") || "none"}`);
  return {
    packageVersion: packageJson.version,
    engineVersion: buildVersion,
    net: nets[0],
    id: `sf${buildVersion}@${packageJson.version}+${sha256(wasm).slice(0, 8)}/${nets[0]}`,
    // Both files sit in a folder named by their joint hash: the wasm is cached as immutable,
    // and Emscripten's pthread workers find it next to the script's own URL.
    dir: createHash("sha256").update(script).update(wasm).digest("hex").slice(0, 8),
    files: { script: { source: sourceJs, data: script }, wasm: { source: sourceWasm, data: wasm } },
  };
}

// What the app is built against: the engine's folder and identity (vite define).
export function stockfishIdentity() {
  const { packageVersion, id, dir } = stockfishBuild();
  return { packageVersion, id, dir };
}

export function syncStockfish() {
  const build = stockfishBuild();
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(dstDir)) {
    if (/^[0-9a-f]{8}$/.test(name) && name !== build.dir) rmSync(join(dstDir, name), { recursive: true });
  }
  mkdirSync(join(dstDir, build.dir), { recursive: true });
  const files = {};
  for (const [kind, { source, data }] of Object.entries(build.files)) {
    const bundled = `${build.dir}/stockfish-lite.${kind === "script" ? "js" : "wasm"}`;
    const destination = join(dstDir, bundled);
    writeFileSync(destination, data);
    // npm preserves executable bits for some package files on Linux. Browser
    // assets are data, so keep their committed permissions platform-independent.
    chmodSync(destination, 0o644);
    files[kind] = { bundled, source, sha256: sha256(data) };
  }
  const { packageVersion, engineVersion, net, id, dir } = build;
  const manifest = { package: "stockfish", packageVersion, engineVersion, variant: "lite-threaded", id, net, dir, files };
  writeFileSync(join(dstDir, "stockfish.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[sync-stockfish] bundled ${id} in engine/${dir}/`);
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
