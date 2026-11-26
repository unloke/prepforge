// Import-graph check for web-src: lists every strongly connected component with
// more than one module (or a module importing itself) and exits non-zero when
// there is one.
//
// The graph is the one Vite builds. The check runs Vite's build with every
// web-src page and module as an entry, reads each module's importedIds and
// dynamicallyImportedIds once the graph is complete, and stops before any chunk
// is generated or written. So an edge is exactly what Vite resolves: extensions
// it fills in, directory index files, template-literal import(), TypeScript,
// and a ?raw or ?url import as its own leaf module, not as code. A lazy import()
// that closes a loop is still a loop in the dependency direction even though it
// is split into its own chunk. Test files and fixtures are not entries.
//
// It runs with Vite's own resolver and plugins and none of vite.config.js's
// plugins: those serve dev-only files or trim the deploy output, and none of
// them resolves a module. Nothing here touches the production build.
//
// The E2E build flags are on, so the graph also holds the imports that only the
// E2E builds keep (Vite drops a branch behind a false import.meta.env flag
// before the graph is complete). Each flag only adds code, so this graph is a
// superset of the production one.
//
//   node scripts/import-cycles.mjs          # fail on any cycle
//   node scripts/import-cycles.mjs --stats  # also print module / edge counts and time
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web-src");
const SKIP_DIRS = new Set(["public", "node_modules"]);
const MODULE_EXT = /\.(mjs|js|mts|ts|jsx|tsx|html)$/;
const isTest = (file) => /\.(test|spec|fixture)\.(mjs|js|mts|ts|jsx|tsx)$/.test(file);
const GRAPH_READ = "import-cycles: graph read";
const E2E_FLAGS = ["VITE_ENABLE_SCOUT_E2E", "VITE_ENABLE_POLISH_E2E"];

function listEntries(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) listEntries(path, out);
    } else if (MODULE_EXT.test(name) && !isTest(name)) {
      out.push(path);
    }
  }
  return out;
}

// Vite ids use "/" on every platform; the file system paths do not on Windows.
const posix = (path) => path.split(sep).join("/").replaceAll("\\", "/");

// A module's name for the report: its path under `root` with "/" separators,
// query kept (a?raw is not a), on Windows as on POSIX.
export function moduleName(root, id, pathApi = { relative, sep }) {
  const [file, query] = id.split(/(?=\?)/);
  const rel = pathApi.relative(root, file).split(pathApi.sep).join("/").replaceAll("\\", "/");
  return query ? rel + query : rel;
}

// Map of module id -> Set of ids it imports, for modules under `root` only
// (Vite's own helpers and packages are left out; they cannot import web-src back).
export async function importGraph(root = SRC) {
  // Windows paths are case-insensitive, and the drive letter's case can differ.
  const fold = process.platform === "win32" ? (path) => posix(path).toLowerCase() : posix;
  const inside = fold(root).replace(/\/?$/, "/");
  const own = (id) => !id.startsWith("\0") && fold(id).startsWith(inside);
  const input = Object.fromEntries(listEntries(root).map((file, i) => [`m${i}`, file]));
  let graph = null;
  const collect = {
    name: "import-cycles-collect",
    buildEnd(error) {
      if (error) return;
      graph = new Map();
      for (const id of this.getModuleIds()) {
        if (!own(id)) continue;
        const info = this.getModuleInfo(id);
        const deps = [...(info?.importedIds || []), ...(info?.dynamicallyImportedIds || [])];
        graph.set(posix(id), new Set(deps.filter(own).map(posix)));
      }
      // Stop here: the graph is all this check needs, so nothing is rendered or written.
      throw new Error(GRAPH_READ);
    },
  };
  try {
    await build({
      configFile: false, root, logLevel: "silent", clearScreen: false,
      publicDir: false, plugins: [collect], worker: { format: "es", plugins: () => [] },
      define: Object.fromEntries(E2E_FLAGS.map((flag) => [`import.meta.env.${flag}`, JSON.stringify("1")])),
      build: {
        write: false, emptyOutDir: false, minify: false, reportCompressedSize: false,
        outDir: join(tmpdir(), "prepforge-import-cycles"),
        rollupOptions: { input, onwarn: () => {} },
      },
    });
  } catch (error) {
    if (!graph) throw error;
  }
  if (!graph) throw new Error("import-cycles: Vite finished without reporting its module graph");
  return graph;
}

// Tarjan's algorithm, iterative so a deep import chain cannot overflow.
export function stronglyConnected(graph) {
  let index = 0;
  const indexOf = new Map(), low = new Map(), onStack = new Set(), stack = [], out = [];
  for (const start of graph.keys()) {
    if (indexOf.has(start)) continue;
    const work = [[start, [...graph.get(start)], 0]];
    indexOf.set(start, index); low.set(start, index); index += 1;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, deps] = frame;
      if (frame[2] < deps.length) {
        const next = deps[frame[2]++];
        if (!graph.has(next)) continue;
        if (!indexOf.has(next)) {
          indexOf.set(next, index); low.set(next, index); index += 1;
          stack.push(next); onStack.add(next);
          work.push([next, [...graph.get(next)], 0]);
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node), indexOf.get(next)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === indexOf.get(node)) {
        const component = [];
        let member;
        do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== node);
        const selfLoop = component.length === 1 && graph.get(node).has(node);
        if (component.length > 1 || selfLoop) out.push(component);
      }
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = performance.now();
  const graph = await importGraph();
  const cycles = stronglyConnected(graph);
  const name = (id) => moduleName(ROOT, id);
  if (process.argv.includes("--stats")) {
    const edges = [...graph.values()].reduce((sum, deps) => sum + deps.size, 0);
    console.log(`${graph.size} modules, ${edges} internal import edges, ${Math.round(performance.now() - started)} ms`);
  }
  if (!cycles.length) {
    console.log("import-cycles: no circular imports in web-src");
  } else {
    console.error(`import-cycles: ${cycles.length} circular import group(s) in web-src`);
    for (const component of cycles) {
      const members = new Set(component);
      console.error(`\n  ${component.length} modules:`);
      for (const id of component.sort()) {
        const inside = [...graph.get(id)].filter((dep) => members.has(dep)).map(name);
        console.error(`    ${name(id)} -> ${inside.join(", ")}`);
      }
    }
    process.exitCode = 1;
  }
}
