// Bundle both installed threaded builds under content-hashed browser URLs.
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
// Lite: 128 MiB initial, 256 MiB maximum. Big: Node smoke (stockfish-heap-smoke.cjs)
// on 2026-10-18, default Hash=16 / Threads=1, start/middlegame/rook endgame at
// depth 16 with carried hash: peak memory.buffer.byteLength=340525056 (~325 MiB).
// Repeated at 6144 pages (384 MiB), all passed; ~59 MiB (18%) growth headroom.
export const MAX_HEAP_PAGES = { lite: 4096, big: 6144 };
const UPSTREAM_MEMORY = "maximum:32768,shared:!0";

export function capSharedHeap(script, net) {
  if (!script.includes(UPSTREAM_MEMORY)) fail("shared WebAssembly.Memory declaration changed upstream");
  return script.replace(UPSTREAM_MEMORY, `maximum:${MAX_HEAP_PAGES[net]},shared:!0`);
}

// Browser workers receive a compiled module and a separately reserved heap.
// Keep the upstream pthread path, including its module forwarding, intact.
export function injectSharedHeap(script) {
  const anchors = [
    ['function i(t){var r,a;function o(e,s){return fetch(e).then(function(e){var a,o,t,n,r,i=Date.now();if(e.ok)return a=l,o=0,t=e.body.getReader(),n=new ReadableStream({start:function(r){!function n(){t.read().then(function(e){var t=e.done,e=e.value;t?(s(i,a,a),r.close()):(o+=e.byteLength,s(i,o,a),r.enqueue(e),n())}).catch(function e(t){r.error(t),e(t)})}()}}),r=new Headers(e.headers),new Response(n,{status:e.status,statusText:e.statusText,headers:r});throw new Error("HTTP "+e.status+": "+e.statusText)})}function i(){return function(e,t,n){c&&(t=m(t,n,e),a=t,r=r||setTimeout(function(){r=null,c.postMessage(a),1<=a.percent&&(c.close(),c=null)},4))}}',
      'function i(t){'],
    ['f={locateFile:function(e){return-1<e.indexOf(".wasm")?-1<e.indexOf(".wasm.map")?u+".map":t||u:',
      'f={wasmModule:f.wasmModule,wasmMemory:f.wasmMemory,locateFile:function(e){return-1<e.indexOf(".wasm")?-1<e.indexOf(".wasm.map")?u+".map":t||u:'],
    ['i(),onmessage=onmessage||function(e){if(',
      'onmessage=onmessage||function(e){if(e.data.wasmModule&&e.data.wasmMemory){f.wasmModule=e.data.wasmModule;f.wasmMemory=e.data.wasmMemory;i();return}if('],
    ['instantiateWasm:function(t,n){var e=i();return o(u,e).then(function(e){return WebAssembly.instantiateStreaming(e,t)}).then(function(e){return n(e.instance,e.module),e.instance.exports}).catch(function(e){throw console.error("WASM streaming failed:",e),e})}',
      'instantiateWasm:function(t,n){var e=new WebAssembly.Instance(f.wasmModule,t);return n(e,f.wasmModule),e.exports}'],
  ];
  for (const [anchor, replacement] of anchors) {
    if (script.split(anchor).length !== 2) fail(`worker initialization anchor changed upstream: ${anchor}`);
    script = script.replace(anchor, replacement);
  }
  return script;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function discoverStockfishBuild({ packageJson, files, net }) {
  const buildVersion = String(packageJson.buildVersion || "").trim();
  if (!packageJson.version || !buildVersion) {
    fail("installed package metadata must include version and buildVersion");
  }
  const suffix = net === "big" ? "" : "-lite";
  const candidates = files.filter((name) => new RegExp(`^stockfish-[^-]+${suffix}\\.js$`).test(name));
  if (candidates.length !== 1) {
    fail(`expected exactly one threaded ${net} JS build, found: ${candidates.join(", ") || "none"}`);
  }
  const sourceJs = candidates[0];
  const sourceWasm = sourceJs.replace(/\.js$/, ".wasm");
  if (!files.includes(sourceWasm)) fail(`missing WASM pair for ${sourceJs}`);
  const filenameVersion = sourceJs.match(/^stockfish-([^-]+)(?:-lite)?\.js$/)?.[1];
  if (filenameVersion !== buildVersion) {
    fail(`package buildVersion ${buildVersion} does not match ${sourceJs}`);
  }
  return { sourceJs, sourceWasm, buildVersion };
}

// The browser's engine: the capped script and its wasm, and the engine's identity
// "sf<build>@<package version>+<wasm sha8>/<net>". npm can ship a new build under the same
// version, so the identity names the wasm itself and the net embedded in it.
export function stockfishBuild(net) {
  if (!existsSync(packageJsonPath) || !existsSync(srcDir)) {
    fail("stockfish package is not installed; run `npm ci` first");
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const { sourceJs, sourceWasm, buildVersion } = discoverStockfishBuild({
    packageJson,
    files: readdirSync(srcDir),
    net,
  });
  const upstream = readFileSync(join(srcDir, sourceJs), "utf8");
  const initialBytes = upstream.match(/p=c.INITIAL_MEMORY\|\|(\d+),d\)g=c.wasmMemory/);
  if (!initialBytes) fail("initial heap declaration changed upstream");
  const initialHeapPages = Number(initialBytes[1]) / 65536;
  const script = injectSharedHeap(capSharedHeap(upstream, net));
  const wasm = readFileSync(join(srcDir, sourceWasm));
  const nets = [...new Set(wasm.toString("latin1").match(/nn-[0-9a-f]{12}/g) || [])];
  if (!nets.length) fail("no embedded net identity found");
  nets.sort();
  return {
    packageVersion: packageJson.version,
    engineVersion: buildVersion,
    nets,
    initialHeapPages,
    maxHeapPages: MAX_HEAP_PAGES[net],
    bytes: wasm.byteLength,
    id: `sf${buildVersion}@${packageJson.version}+${sha256(wasm).slice(0, 8)}/${nets.join("+")}`,
    // Both files sit in a folder named by their joint hash: the wasm is cached as immutable,
    // and Emscripten's pthread workers find it next to the script's own URL.
    dir: createHash("sha256").update(script).update(wasm).digest("hex").slice(0, 8),
    files: { script: { source: sourceJs, data: script }, wasm: { source: sourceWasm, data: wasm } },
  };
}

// Embed the same exact WASM byte count as the manifest; no runtime manifest fetch
// or Content-Length header is needed for download progress.
export function stockfishIdentity() {
  return Object.fromEntries(["big", "lite"].map(net => {
    const { packageVersion, id, dir, initialHeapPages, maxHeapPages, bytes } = stockfishBuild(net);
    return [net, { packageVersion, id, dir, initialHeapPages, maxHeapPages, bytes }];
  }));
}

export function syncStockfish() {
  const builds = Object.fromEntries(["big", "lite"].map(net => [net, stockfishBuild(net)]));
  mkdirSync(dstDir, { recursive: true });
  const keep = new Set(Object.values(builds).map(b => b.dir));
  for (const name of readdirSync(dstDir)) {
    if (/^[0-9a-f]{8}$/.test(name) && !keep.has(name)) rmSync(join(dstDir, name), { recursive: true });
  }
  const engines = {};
  for (const [net, build] of Object.entries(builds)) {
    const folder = join(dstDir, build.dir);
    mkdirSync(folder, { recursive: true });
    for (const name of readdirSync(folder)) {
      if (!["stockfish.js", "stockfish.wasm"].includes(name)) rmSync(join(folder, name));
    }
    const files = {};
    for (const [kind, { source, data }] of Object.entries(build.files)) {
      const bundled = `${build.dir}/stockfish.${kind === "script" ? "js" : "wasm"}`;
      const destination = join(dstDir, bundled);
      writeFileSync(destination, data);
      chmodSync(destination, 0o644);
      files[kind] = { bundled, source, sha256: sha256(data) };
    }
    const { packageVersion, engineVersion, nets, id, dir, initialHeapPages, maxHeapPages, bytes } = build;
    engines[net] = { packageVersion, engineVersion, nets, id, dir, initialHeapPages, maxHeapPages, bytes, files };
    console.log(`[sync-stockfish] bundled ${net}: ${id} in engine/${dir}/`);
  }
  const manifest = { package: "stockfish", engines };
  writeFileSync(join(dstDir, "stockfish.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
