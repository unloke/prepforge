# Coach A/B blind review

Human blind review of a Coach SFT experiment's anonymised base/SFT pairs, on PrepForge's
own board and styles. Review only: it reads `run-output/BLINDED.jsonl` and never changes
the experiment's outputs, the earlier ledger or production Coach.

```
node research/coach-ab-review/serve.mjs [experiment-dir] [--port 5199]
node research/coach-ab-review/unblind.mjs [experiment-dir] [--ledger exported.json]
```

The experiment directory defaults to `research/sft/experiment/next-499-20261010`.

## Blinding

- The server returns only pair id, the fact lines from the model prompt, the board
  fields and the two answers. Vite's file allowlist covers only this folder, `web-src/`
  and `node_modules/`, so `BLIND-KEY.json`, `BLINDED-REVIEW.jsonl`, `review-output/` and
  `RESULTS.json` are not reachable from the page.
- Every change is written to `<experiment>/human-review/HUMAN-REVIEW.json` (with a
  browser copy as backup). Export is enabled at 80/80.
- `unblind.mjs` refuses an incomplete ledger or one whose content hashes do not match
  `BLINDED.jsonl`, writes `HUMAN-REVIEW-FREEZE.json` before opening the key, then writes
  `HUMAN-REVIEW-RESULTS.json` and `human-unblinded-pairs.jsonl`. After the freeze the
  server rejects edits and the page is read-only.
- On best-tier rows where the played move is not the engine move, the board still draws
  the engine move and labels it as absent from the model's facts.

## Ledger

```json
{ "schema": "coach-ab-human-review/1", "blind_data_sha256": "…", "reviews": [
  { "pair_id": "pair-001", "verdict": "A | B | tie | both_bad",
    "issues": { "A": ["factual_error"], "B": [] }, "note": "",
    "content_sha256": { "A": "…", "B": "…" }, "updated_at": "…" } ] }
```

Issue tags: `factual_error` (contradicts the facts), `missed_key_point`, `hallucination`
(asserts something absent from the facts), `unnatural`.

## Results

Preference counts are reported with an exact binomial test on decisive pairs. An answer
counts as clean if it has no issue tags and its pair is not `both_bad`, and paired clean
discordance gets an exact McNemar test. Issue counts and a per-grade breakdown are also
reported, along with agreement against the earlier frozen blinded ledger in A/B/tie
space. This is one reviewer: it does not replace the protocol's per-answer
grounded/clear/useful acceptance.
