// Freeze a completed human A/B ledger, then unblind it with the experiment's key.
//
//   node research/coach-ab-review/unblind.mjs [experiment-dir] [--ledger exported.json]
//
// Order matters: every check and the freeze hash are written before BLIND-KEY.json is
// opened. A frozen ledger cannot be re-frozen or edited through serve.mjs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const partial = args.includes("--partial");
args.splice(args.indexOf("--partial"), partial ? 1 : 0);
const ledgerAt = args.indexOf("--ledger");
const ledgerArg = ledgerAt >= 0 ? args.splice(ledgerAt, 2)[1] : null;
const expDir = resolve(args[0] || join(repo, "research/sft/experiment/next-499-20261010"));
const outDir = join(expDir, "human-review");
const ledgerPath = resolve(ledgerArg || join(outDir, "HUMAN-REVIEW.json"));
const freezePath = join(outDir, "HUMAN-REVIEW-FREEZE.json");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fail = (msg) => { console.error(msg); process.exit(1); };

// ---- verify and freeze (key still unread) -----------------------------------
if (existsSync(freezePath)) fail(`Already frozen: ${freezePath}`);
const blindPath = join(expDir, "run-output/BLINDED.jsonl");
const blindSha = sha(readFileSync(blindPath));
const blind = new Map(jsonl(blindPath).map((r) => [r.pair_id, r]));
const ledgerBytes = readFileSync(ledgerPath);
const ledger = JSON.parse(ledgerBytes);
if (ledger.schema !== "coach-ab-human-review/1") fail("Unknown ledger schema.");
if (ledger.blind_data_sha256 !== blindSha) fail("Ledger was made for a different BLINDED.jsonl.");
const reviews = new Map(ledger.reviews.map((r) => [r.pair_id, r]));
if (reviews.size !== ledger.reviews.length) fail("Duplicate pair ids in ledger.");
const missing = [...blind.keys()].filter((id) => !reviews.get(id)?.verdict);
if (missing.length && !partial) fail(`${missing.length} pairs have no verdict (first: ${missing[0]}). Finish the review first, or pass --partial.`);
// --partial unblinds only the pairs with a verdict. The report says so; nothing else changes.
const done = [...reviews].filter(([id, r]) => r.verdict && blind.has(id));
for (const [id, r] of done) {
  const b = blind.get(id);
  if (!b) fail(`Unknown pair ${id}.`);
  if (r.content_sha256.A !== b.A.content_sha256 || r.content_sha256.B !== b.B.content_sha256) fail(`Content hash mismatch on ${id}.`);
}
mkdirSync(outDir, { recursive: true });
const freeze = {
  review_sha256: sha(ledgerBytes),
  ledger_path: ledgerPath,
  blind_data_sha256: blindSha,
  completed_pairs: done.length,
  total_pairs: blind.size,
  partial,
  key_not_read_before_freeze: true,
  frozen_at: new Date().toISOString(),
};
writeFileSync(freezePath, JSON.stringify(freeze, null, 2) + "\n");

// ---- unblind ----------------------------------------------------------------
const key = JSON.parse(readFileSync(join(expDir, "run-output/BLIND-KEY.json"), "utf8"));
const keyPairs = key.pairs ?? key; // BLIND-KEY.json is either {pair_id: map} or {seed_hex, pairs}
const [X, Y] = [...new Set(Object.values(keyPairs).flatMap((m) => [m.A, m.B]))].sort();
const ISSUES = ["factual_error", "missed_key_point", "hallucination", "unnatural"];
const exactP = (a, b) => {
  const n = a + b;
  if (!n) return 1;
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let k = 0; k <= Math.min(a, b); k++) { tail += c; c = (c * (n - k)) / (k + 1); }
  return Math.min(1, (2 * tail) / 2 ** n);
};

// Labels X and Y are the two arms (sorted), so the same code serves any pair of arms.
const outcome = { [X]: 0, [Y]: 0, tie: 0, both_bad: 0 };
const issues = Object.fromEntries([X, Y].map((m) => [m, Object.fromEntries(ISSUES.map((t) => [t, 0]))]));
const flagged = { [X]: 0, [Y]: 0 };
const clean = { [`${X}_only`]: 0, [`${Y}_only`]: 0, both: 0, neither: 0 };
const byGrade = {};
const rows = [];
for (const [id, r] of done) {
  const map = keyPairs[id];
  const winner = r.verdict === "A" || r.verdict === "B" ? map[r.verdict] : r.verdict;
  outcome[winner] += 1;
  const grade = blind.get(id).facts.grade;
  byGrade[grade] ??= { [X]: 0, [Y]: 0, tie: 0, both_bad: 0 };
  byGrade[grade][winner] += 1;
  const ok = {};
  const perSlot = {};
  for (const slot of ["A", "B"]) {
    const arm = map[slot];
    r.issues[slot].forEach((t) => { issues[arm][t] += 1; });
    if (r.issues[slot].length) flagged[arm] += 1;
    ok[arm] = r.verdict !== "both_bad" && r.issues[slot].length === 0;
    perSlot[arm] = r.issues[slot];
  }
  clean[ok[X] && ok[Y] ? "both" : ok[X] ? `${X}_only` : ok[Y] ? `${Y}_only` : "neither"] += 1;
  rows.push({
    pair_id: id, id: map.id, grade, verdict: r.verdict, preferred: winner,
    issues: perSlot, note: r.note,
  });
}

// Agreement with the frozen earlier blinded review, compared in blinded A/B/tie space.
let agreement = null;
const priorPath = join(expDir, "BLINDED-REVIEW.jsonl");
if (existsSync(priorPath)) {
  const prior = new Map(jsonl(priorPath).map((r) => [r.pair_id, r.preference]));
  const cells = {};
  let same = 0, compared = 0;
  for (const [id, r] of done) {
    const p = prior.get(id);
    if (!p) continue;
    cells[`${r.verdict}|${p}`] = (cells[`${r.verdict}|${p}`] || 0) + 1;
    if (r.verdict === "both_bad") continue;
    compared += 1;
    if (r.verdict === p) same += 1;
  }
  agreement = { compared_excluding_both_bad: compared, same_preference: same, rate: compared ? same / compared : null, human_vs_prior: cells };
}

const report = {
  arms: [X, Y],
  pairs: done.length,
  total_pairs: blind.size,
  partial,
  preferred: outcome,
  preference_exact_binomial_p: exactP(outcome[X], outcome[Y]),
  issue_counts: issues,
  answers_with_any_issue: flagged,
  clean_paired: { ...clean, exact_mcnemar_p: exactP(clean[`${X}_only`], clean[`${Y}_only`]) },
  by_grade: byGrade,
  agreement_with_prior_blinded_review: agreement,
  review_freeze: freeze,
  single_reviewer: true,
};
writeFileSync(join(outDir, "HUMAN-REVIEW-RESULTS.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(outDir, "human-unblinded-pairs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const pct = (n) => `${n} (${((100 * n) / done.length).toFixed(1)}%)`;
console.log(`Frozen ${freeze.review_sha256.slice(0, 12)}…, unblinded ${done.length} of ${blind.size} pairs${partial ? " (PARTIAL)" : ""}.\n`);
console.log(`Preferred   ${X} ${pct(outcome[X])}  ${Y} ${pct(outcome[Y])}  tie ${pct(outcome.tie)}  both bad ${pct(outcome.both_bad)}`);
console.log(`            exact binomial p (decisive only) = ${report.preference_exact_binomial_p.toPrecision(3)}`);
console.log(`Clean       ${X}-only ${clean[`${X}_only`]}  ${Y}-only ${clean[`${Y}_only`]}  both ${clean.both}  neither ${clean.neither}  McNemar p = ${report.clean_paired.exact_mcnemar_p.toPrecision(3)}`);
console.log(`Issues      ${ISSUES.map((t) => `${t} ${issues[X][t]}→${issues[Y][t]}`).join("  ")}  (${X}→${Y})`);
for (const [g, c] of Object.entries(byGrade)) console.log(`  ${g.padEnd(11)} ${X} ${c[X]}  ${Y} ${c[Y]}  tie ${c.tie}  both bad ${c.both_bad}`);
if (agreement) console.log(`Agreement with prior blinded review: ${agreement.same_preference}/${agreement.compared_excluding_both_bad}`);
console.log(`\nWrote ${join(outDir, "HUMAN-REVIEW-RESULTS.json")}`);
