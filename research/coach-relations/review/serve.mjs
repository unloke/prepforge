// Local review server for the move-reason set (set.json, from build_set.py).
//
//   node research/coach-relations/review/serve.mjs [--port 5207] [--round 2]
//
// The reviewer first writes their own reason for each position, then rates the enumerator's
// candidates. Every change is saved to LABELS.json next to this file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { boardKit } from "../../coach-ab-review/board-kit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const webSrc = join(repo, "web-src");
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const port = Number(arg("--port") || 5207);
const suffix = arg("--round") === "2" ? "-r2" : "";
const setBytes = readFileSync(join(here, `set${suffix}.json`));
const setSha = createHash("sha256").update(setBytes).digest("hex");
const positions = JSON.parse(setBytes.toString("utf8"));
const labelsPath = join(here, `LABELS${suffix}.json`);

function readJson(req) {
  return new Promise((ok, fail) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4e6) fail(new Error("too large")); });
    req.on("end", () => { try { ok(JSON.parse(body)); } catch (e) { fail(e); } });
  });
}

function send(res, code, value) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

const ids = new Set(positions.map((p) => p.pos_id));
const valid = (doc) => doc?.schema === "reason-review/1" && doc.set_sha256 === setSha &&
  Array.isArray(doc.reviews) && doc.reviews.every((r) => ids.has(r.pos_id));

// Windows refuses the rename while another program (an editor, antivirus, the indexer) has
// LABELS.json open; that lock is brief, so retry a few times before reporting the failure.
async function save(text) {
  writeFileSync(labelsPath + ".tmp", text);
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(labelsPath + ".tmp", labelsPath);
    } catch (e) {
      if (e.code !== "EPERM" && e.code !== "EBUSY" || attempt === 9) throw e;
      await new Promise((ok) => setTimeout(ok, 100));
    }
  }
}

const api = {
  name: "reason-review-api",
  resolveId: (id) => (id === "virtual:board-kit" ? "\0board-kit" : undefined),
  load: (id) => (id === "\0board-kit" ? boardKit(webSrc) : undefined),
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = (req.url || "").split("?")[0];
      if (url === "/api/session" && req.method === "GET") {
        const labels = existsSync(labelsPath) ? JSON.parse(readFileSync(labelsPath, "utf8")) : null;
        return send(res, 200, { set_sha256: setSha, positions, labels });
      }
      if (url === "/api/labels" && req.method === "PUT") {
        let doc;
        try { doc = await readJson(req); } catch { return send(res, 400, { error: "Bad JSON." }); }
        if (!valid(doc)) return send(res, 400, { error: "Labels do not match this set." });
        try {
          await save(JSON.stringify(doc, null, 1) + "\n");
        } catch (e) {
          return send(res, 500, { error: e.code || e.message });
        }
        return send(res, 200, { saved: doc.reviews.length });
      }
      next();
    });
  },
};

const server = await createServer({
  configFile: false,
  root: here,
  logLevel: "warn",
  plugins: [api],
  publicDir: join(webSrc, "public"), // Stockfish under /engine/
  server: {
    host: "127.0.0.1", port, strictPort: true,
    // Threaded Stockfish needs cross-origin isolation, as in the app.
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
    fs: { strict: true, allow: [here, join(repo, "research/coach-ab-review"), webSrc, join(repo, "node_modules")] },
  },
});
await server.listen();
console.log(`Reason review: http://127.0.0.1:${port}/  (${positions.length} positions)`);
console.log(`Labels: ${labelsPath}`);
