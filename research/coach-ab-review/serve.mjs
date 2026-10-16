// Local blind A/B review server for a Coach SFT experiment directory.
//
//   node research/coach-ab-review/serve.mjs [experiment-dir] [--port 5199]
//
// Serves only the anonymised pairs (run-output/BLINDED.jsonl) and the reviewer's own
// ledger (human-review/HUMAN-REVIEW.json). The blind key, the earlier review ledger and
// every unblinded output stay outside the server's file allowlist, so nothing in the
// browser can reach them. unblind.mjs freezes the ledger, and the server then refuses
// writes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { boardKit } from "./board-kit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const webSrc = join(repo, "web-src");
const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args.splice(portAt, 2)[1]) : 5199;
const expDir = resolve(args[0] || join(repo, "research/sft/experiment/next-499-20261010"));
const blindPath = join(expDir, "run-output/BLINDED.jsonl");
const reviewDir = join(expDir, "human-review");
const reviewPath = join(reviewDir, "HUMAN-REVIEW.json");
const freezePath = join(reviewDir, "HUMAN-REVIEW-FREEZE.json");

// Three prompt shapes: the original "Verified facts:" bullet list, the compact-v2
// "Evidence by ID" JSON object (one line per evidence id, long values shortened), and the
// coach-v3 fact card (one instruction line, then one fact per line).
function factLines(prompt) {
  if (prompt.includes("Verified facts:")) {
    return prompt.split("Verified facts:")[1].trim().split("\n").map((l) => l.replace(/^- /, ""));
  }
  const marker = prompt.indexOf("Evidence by ID");
  if (marker < 0) {
    return prompt.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^- /, ""));
  }
  const evidence = JSON.parse(prompt.slice(prompt.indexOf("{", marker)));
  return Object.entries(evidence).map(([id, v]) => {
    const body = JSON.stringify(v);
    return `${id}: ${body.length > 240 ? body.slice(0, 237) + "..." : body}`;
  });
}

const blindBytes = readFileSync(blindPath);
const blindSha = createHash("sha256").update(blindBytes).digest("hex");
const pairs = blindBytes.toString("utf8").split("\n").filter(Boolean).map((line) => {
  const r = JSON.parse(line);
  const f = r.facts;
  const slot = (s) => ({ response: s.response, finished: s.finish.finished, content_sha256: s.content_sha256 });
  return {
    pair_id: r.pair_id,
    // The exact fact lines the model saw: the grounding reference.
    facts_text: factLines(r.prompt),
    // The best move is only "in the facts" when the prompt names it.
    best_in_prompt: r.prompt.includes(f.best_san),
    // Lines are the cut lines the judge saw (a set without them walks just the two moves);
    // scores are White's view; the game, when the set carries it, is moves, scores and grades.
    board: {
      fen_before: f.fen_before, side: f.side, move_number: f.move_number,
      played_uci: f.played_uci, played_san: f.played_san, best_uci: f.best_uci, best_san: f.best_san,
      is_best: f.is_best, grade: f.grade,
      played_pv: f.played_pv || [f.played_uci], best_pv: f.best_pv || [f.best_uci],
      before: f.before || null, after: f.after || null, game: f.game || null,
    },
    A: r.A ? slot(r.A) : null,
    // Spot-check sets have one answer per position: no B, verdict ok / bad.
    B: r.B ? slot(r.B) : null,
    // Pick sets (the reason selector's spot check) have candidates: pick one by index or "none".
    candidates: r.candidates ? r.candidates.map(slot) : null,
  };
});

function readJson(req) {
  return new Promise((ok, fail) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) fail(new Error("too large")); });
    req.on("end", () => { try { ok(JSON.parse(body)); } catch (e) { fail(e); } });
  });
}

const ISSUES = new Set(["factual_error", "missed_key_point", "hallucination", "unnatural"]);
const VERDICTS = new Set(["A", "B", "tie", "both_bad", "ok", "bad"]);
const byId = new Map(pairs.map((p) => [p.pair_id, p]));

function validLedger(doc) {
  if (doc?.schema !== "coach-ab-human-review/1" || doc.blind_data_sha256 !== blindSha) return false;
  if (!Array.isArray(doc.reviews)) return false;
  return doc.reviews.every((r) => {
    const p = byId.get(r.pair_id);
    if (p?.candidates) {
      return (r.verdict === null || r.verdict === "none" || p.candidates[Number(r.verdict)] !== undefined) &&
        typeof r.note === "string" && Array.isArray(r.content_sha256) &&
        r.content_sha256.length === p.candidates.length && p.candidates.every((c, i) => c.content_sha256 === r.content_sha256[i]);
    }
    return p && (r.verdict === null || VERDICTS.has(r.verdict)) && typeof r.note === "string" &&
      r.content_sha256?.A === p.A.content_sha256 && r.content_sha256?.B === (p.B?.content_sha256 ?? null) &&
      ["A", "B"].every((s) => Array.isArray(r.issues?.[s]) && r.issues[s].every((t) => ISSUES.has(t)));
  });
}

function send(res, code, value) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

const api = {
  name: "coach-ab-review-api",
  resolveId: (id) => (id === "virtual:board-kit" ? "\0board-kit" : undefined),
  load: (id) => (id === "\0board-kit" ? boardKit(webSrc) : undefined),
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = (req.url || "").split("?")[0];
      if (url === "/api/session" && req.method === "GET") {
        const ledger = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, "utf8")) : null;
        return send(res, 200, {
          experiment: expDir.split(/[\\/]/).pop(),
          blind_data_sha256: blindSha,
          locked: existsSync(freezePath),
          pairs,
          ledger,
        });
      }
      if (url === "/api/review" && req.method === "PUT") {
        if (existsSync(freezePath)) return send(res, 409, { error: "Review is frozen." });
        let doc;
        try { doc = await readJson(req); } catch { return send(res, 400, { error: "Bad JSON." }); }
        if (!validLedger(doc)) return send(res, 400, { error: "Ledger does not match this blind set." });
        mkdirSync(reviewDir, { recursive: true });
        writeFileSync(reviewPath + ".tmp", JSON.stringify(doc, null, 2) + "\n");
        renameSync(reviewPath + ".tmp", reviewPath);
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
  // Only the tool, the PrepForge sources it imports and node_modules are servable.
  server: { host: "127.0.0.1", port, strictPort: true, fs: { strict: true, allow: [here, webSrc, join(repo, "node_modules")] } },
});
await server.listen();
console.log(`Coach A/B review: http://127.0.0.1:${port}/  (${pairs.length} pairs, ${expDir})`);
console.log(`Ledger: ${reviewPath}`);
