// Every proven point the production Coach could make about each coach-prod-v2 position,
// one per detector instead of the first in its cascade, tagged with the concept it names.
// Run from the repo root: node research/concept-coach/candidates.mjs all  ("all" is read by run.mjs)
import { readFileSync, writeFileSync } from "node:fs";
import { features } from "../coach-prod-v2/run.mjs";
import { describeMove, lineOutcome, netFor, netValue, gainPhrase, tradePhrase } from "../../web-src/coach/move-facts.js";
import { soundReason, replyReason, costReason, betterReason, reasonPhrase } from "../../web-src/coach/reasons.js";
import { motifPhrase } from "../../web-src/coach/motifs.js";
import { concept } from "./concepts.mjs";

const ERRORS = new Set(["inaccuracy", "mistake", "blunder"]);

function candidates(f) {
  const out = [];
  const add = (side, phrase) => phrase && out.push({ side, phrase, concept: concept(phrase) });
  if (f.hasMateAfter && Number.isFinite(f.mateAfter) && !ERRORS.has(f.classification.code)) add("played", "forces mate");
  if (!ERRORS.has(f.classification.code)) {
    // A capture is worded by its material outcome below, not "takes the X".
    for (const part of describeMove(f.fenBefore, f.uci, f.san).split(/, | and (?=[a-z]+s )/)) if (!/^takes the (?!centre|open)/.test(part)) add("played", part);
    const own = lineOutcome(f.fenBefore, f.playedPvUci || [], { maxPlies: 6, first: /x/.test(f.san || "") });
    if (own && own.quiet) {
      const net = netFor(own, f.mover === "white" ? "w" : "b");
      if (netValue(net) >= 1) add("played", `wins ${gainPhrase(net)}`);
      else if (netValue(net) === 0) add("played", tradePhrase(own, f.mover === "white" ? "w" : "b"));
      else if (/x/.test(f.san || "")) add("played", `gives up ${gainPhrase(Object.fromEntries(Object.entries(net).map(([k, v]) => [k, -v])))}`);
    }
    add("played", motifPhrase(f.fenBefore, f.uci, f.san));
    add("played", reasonPhrase(soundReason(f)));
  } else {
    add("played", reasonPhrase(replyReason(f)));
    add("played", reasonPhrase(costReason(f)));
    if (f.replyUci) add("played", motifPhrase(f.fenAfter, f.replyUci, f.replySan));
    add("best", reasonPhrase(betterReason(f)));
    if (f.bestUci) add("best", motifPhrase(f.fenBefore, f.bestUci, f.bestSan));
  }
  const seen = new Set();
  return out.filter((c) => !seen.has(c.side + c.concept) && seen.add(c.side + c.concept));
}

const rows = readFileSync("research/coach-prod-v2/after.jsonl", "utf8").trim().split(/\r?\n/).map(JSON.parse);
const lines = rows.map((r) => {
  const f = features(r.id);
  return JSON.stringify({ id: r.id, code: f.classification.code, prose: r.prose, candidates: candidates(f) });
});
writeFileSync("research/concept-coach/candidates.jsonl", lines.join("\n") + "\n");
