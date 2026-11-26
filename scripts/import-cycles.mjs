// Static import-graph check for web-src: lists every strongly connected
// component with more than one module (or a module importing itself) and exits
// non-zero when there is one. Static imports, re-exports and dynamic import()
// with a literal specifier all count as edges; a lazy import() that closes a
// loop is still a loop in the dependency direction even though it is split into
// its own chunk. Specifiers resolve the way Vite resolves them (see
// resolveSpecifier), so an import that leaves off the extension or names a
// directory is an edge too. Test files and test fixtures are not part of the graph.
//
//   node scripts/import-cycles.mjs          # fail on any cycle
//   node scripts/import-cycles.mjs --stats  # also print module / edge counts
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";
import { KEYS } from "eslint-visitor-keys";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web-src");
const SKIP_DIRS = new Set(["public", "node_modules"]);
// Vite's default resolve.extensions, in its order (vite.config.js sets none).
// .json resolves but imports nothing, so it is not a node of the graph.
const EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const MODULE_EXT = /\.(mjs|js|mts|ts|jsx|tsx)$/;
const isTest = (file) => /\.(test|spec|fixture)\.(mjs|js|mts|ts|jsx|tsx)$/.test(file);
const isFile = (path) => existsSync(path) && statSync(path).isFile();

function listModules(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) listModules(path, out);
    } else if (MODULE_EXT.test(name) && !isTest(name)) {
      out.push(path);
    }
  }
  return out;
}

function specifiers(source) {
  const ast = espree.parse(source, { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } });
  const found = [];
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration"
      || node.type === "ExportNamedDeclaration") && node.source) {
      found.push(node.source.value);
    }
    if (node.type === "ImportExpression" && node.source.type === "Literal") {
      found.push(node.source.value);
    }
    for (const key of KEYS[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(ast);
  return found;
}

// Mirrors Vite's file resolution for relative and root-absolute ("/x", from
// the Vite root) specifiers: the path itself, then each default extension, then
// a directory's package.json entry or index file. Query strings and hashes
// (?url, ?worker, #x) are dropped. Packages and URLs are not edges.
function resolveFile(path) {
  if (isFile(path)) return path;
  for (const ext of EXTENSIONS) if (isFile(path + ext)) return path + ext;
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  const pkgPath = join(path, "package.json");
  if (isFile(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* not a package entry */ }
    for (const entry of [pkg.module, pkg.main]) {
      if (typeof entry !== "string") continue;
      const found = resolveFile(resolve(path, entry));
      if (found) return found;
    }
  }
  for (const ext of EXTENSIONS) if (isFile(join(path, "index" + ext))) return join(path, "index" + ext);
  return null;
}

export function resolveSpecifier(from, spec, root = SRC) {
  const bare = spec.split(/[?#]/)[0];
  let path;
  if (bare.startsWith("./") || bare.startsWith("../") || bare === "." || bare === "..") path = resolve(dirname(from), bare);
  else if (bare.startsWith("/") && !bare.startsWith("//")) path = join(root, bare);
  else return null; // packages, URLs, data: and the like
  const found = resolveFile(path);
  return found && MODULE_EXT.test(found) && !isTest(found) ? found : null;
}

export function importGraph(root = SRC) {
  const modules = listModules(root);
  const graph = new Map();
  for (const file of modules) {
    const deps = new Set();
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      const target = resolveSpecifier(file, spec, root);
      if (target) deps.add(target);
    }
    graph.set(file, deps);
  }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const graph = importGraph();
  const cycles = stronglyConnected(graph);
  const name = (path) => relative(ROOT, path);
  if (process.argv.includes("--stats")) {
    const edges = [...graph.values()].reduce((sum, deps) => sum + deps.size, 0);
    console.log(`${graph.size} modules, ${edges} internal import edges`);
  }
  if (!cycles.length) {
    console.log("import-cycles: no circular imports in web-src");
  } else {
    console.error(`import-cycles: ${cycles.length} circular import group(s) in web-src`);
    for (const component of cycles) {
      const members = new Set(component);
      console.error(`\n  ${component.length} modules:`);
      for (const file of component.sort()) {
        const inside = [...graph.get(file)].filter((dep) => members.has(dep)).map(name);
        console.error(`    ${name(file)} -> ${inside.join(", ")}`);
      }
    }
    process.exitCode = 1;
  }
}
