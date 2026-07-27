# ORCBR-B1 — Frozen Research-Only Protocol

**Status:** FROZEN — research-only protocol (not product; not confirmatory)
**Date frozen:** 2026-07-27
**Candidate:** `orcbr-b1` — Opponent-Recurrent Conditional Black Response Rules, generation 1
**Protocol ID:** `scout-orcbr-b1-v1`
**Study role:** TRAIN-only structural + prequential preflight / package construction
**Product:** `productAuthorization: false` · `productVerdict: preserve-v2`
**Module A:** `CLOSED_NOT_REOPENED`
**Scout production:** v2 default unmodified

> This document freezes the ORCBR-B1 research contract. It does **not** authorize
> CAL/TEST access, network acquisition, human study, Module A reopen, or shipping.
> First executable work under this protocol is **G0 dual-parse custody** on **local**
> raw/capped bytes only. If G0 fails, emit `STOP_SCHEMA_UNAVAILABLE` and stop.

---

## 0. Locks (immutable for this identity)

| Field | Frozen value |
|---|---|
| `kind` | `scout-orcbr-b1-protocol` |
| `version` | `1` |
| `protocolId` | `scout-orcbr-b1-v1` |
| `candidateId` | `orcbr-b1` |
| `researchOnly` | `true` |
| `trainOnly` | `true` |
| `outcomeBlind` | `true` |
| `nonConfirmatory` | `true` |
| `productAuthorization` | **`false`** |
| `productVerdict` | **`preserve-v2`** |
| `moduleAStatus` | `CLOSED_NOT_REOPENED` |
| `unitContract` | **`preparation-unit-v2`** |
| `packageSlotBudget` | **`12`** |
| `coverageCostDomain` | `{1, 2, 3}` |
| `ourColor` | `black` |
| `calAllowed` | **`false`** |
| `testAllowed` | **`false`** |
| `networkEnabled` | **`false`** |
| `humanAuthorization` | **`false`** |

Any protocol snapshot, report, gate receipt, or CLI status with
`productAuthorization !== false` or `productVerdict !== "preserve-v2"` is **`INVALID`**.

### Claim boundary

| Establishes (if gates pass) | Forbids |
|---|---|
| Whether ORCBR-B1 packages are **structurally runnable** on local TRAIN under frozen gates | Product or card authorization |
| Whether pseudonymous opponent identity is available from **local raw** dual-parse | Human study authorization |
| Whether prequential within-TRAIN future-match feasibility is non-degenerate | v2 replacement claims |
| Custody hashes for a later, separately registered confirmatory protocol | CAL/TEST algorithm inputs under this identity |
| | Network acquisition / fresh panel top-up |
| | Reinterpretation of Module A, SHPFA, robust-y, or burned holdouts as confirmation |

---

## 1. Scientific intent

ORCBR-B1 prepares **conditional Black response rules** conditioned on **recurring
opponent-specific White opening states**, using only games chronologically prior to
each cutoff.

It is **content generation / conditioning**, not reweighting of global subject atoms:

| Family | Mechanism | Why ORCBR-B1 differs |
|---|---|---|
| Frequency / recency / ranking | Rank subject (or opponent) lines by count/time | No conditional **our-Black response rules** |
| Cover / retention / set-union | Maximize path coverage of subject moves | Still exact-atom grain; no identity-conditioned matcher |
| Engine novelty | SF/Maia rare weapons | Not opponent-repertoire causal |
| PPAG / peer generation | Peer or model peers | Not longitudinal per-opponent chronology |
| Module A exact atoms | `triggerEpd + subjectUci` | Exact grain; no generalized matcher or coverage cost |
| RPU position-union | Union exact atoms by `fenAfter` | Not opponent-keyed; not response-rule units |

**Unit content** = conditional rule: *IF* game enters opponent-keyed family *F*,
*THEN* prepare Black reply *r*.
**Conditioning evidence** = opponent *O*’s White TRAIN games only (strict no-lookahead).

---

## 2. Pseudonymous opponent identity

### 2.1 Upstream availability (evidence basis)

Raw Lichess NDJSON carries `players.white.user.id` / `players.black.user.id`
(and names). PGN headers carry `White` / `Black`. Production Scout parse
(`web-src/scout.js` `parseGameBlock` / `parseGameFromJson`) decides subject color
then **drops** counterparty identity from sealed scout game records.

### 2.2 Research record fields (additive; not production default)

```text
ScoutGameRecordResearchV2 {
  // existing scout fields unchanged when present
  gameId
  color                  // subject color for this record
  datestamp              // YYYY.MM.DD or normalized day
  createdAtMs            // preferred chronology (NDJSON createdAt when present)
  ucis, sans, ...

  // research-only identity (pseudonymous)
  subjectKey             // "opp_" + sha256_hex(normalize(id) + studySalt)[0:16]
  opponentKey            // same scheme for counterparty; null if unavailable
  identitySource         // "ndjson.players.user.id" | "pgn.header" | "missing"
  identityConfidence     // "id" | "name-lower" | "none"
  dayKey                 // "YYYY-MM-DD" UTC
}
```

### 2.3 Pseudonymization rules

1. Prefer Lichess `user.id` over display name.
2. `normalize(id)` = trim + lowercase ASCII (id preferred; name-lower fallback only).
3. `subjectKey` / `opponentKey` = `"opp_" + first 16 hex chars of HMAC-SHA256(researchSalt, normalized)`.
   Caller supplies the research salt as the HMAC key; never concatenate salt into the message.
4. Research salt is caller-supplied and study-scoped; salt rotation **must** invalidate keys (tested).
5. **Never** emit raw opponent names/ids in gate reports, packages, or shared receipts.
6. Anonymous / AI / missing user → `opponentKey = null`, `identityConfidence = "none"`.
7. Name-lower fallback is **weak**: counts against identity coverage; may not satisfy G1 alone at scale.
8. No cross-subject pooling of keys; no global opponent graph for unit identity.

### 2.4 Dual-parse custody (G0)

| Step | Rule |
|---|---|
| Input | **Local** raw and/or capped NDJSON/PGN bytes only |
| Hash | SHA-256 of raw bytes + SHA-256 of capped bytes |
| Parse | Production-shaped parse (identity-free) **and** research parse (with keys) |
| Success | Eligible share with non-missing identity meets threshold **and** receipts self-hash |
| Failure | **`STOP_SCHEMA_UNAVAILABLE`** — no CAL/TEST, no network, no invented ids |

If sealed scout dumps lack identity **and** local raw cannot restore it for the
pinned gameIds, G0 fails closed. Do not acquire new games under this protocol.

---

## 3. Preparation-unit-v2 contract (budget 12 + coverageCost)

### 3.1 Coexistence with exact-atom v1

| Contract | Kind string | Use |
|---|---|---|
| Exact-atom v1 | `exact-atom@1` / Module A grain | Closed metrics; **never** score ORCBR units here |
| Preparation-unit-v2 | **`preparation-unit-v2`** | ORCBR-B1 and future generalized Black units |

Hard rules:

- Reports declare `unitContract: "preparation-unit-v2"`.
- Exact-atom scorers **reject** non-exact contracts.
- Generalized scorers **reject** exact atoms.
- No silent rewrite of a broad unit into a bag of exact atoms for old metrics.

### 3.2 Unit identity

```jsonc
{
  "unitContract": "preparation-unit-v2",
  "unitId": "sha256(canonicalJson(identityPayload))",
  "identityPayload": {
    "kind": "conditional_response_rule",
    "ourColor": "black",
    "opponentKey": "opp_…",
    "matcher": {
      "type": "prefix_or_epd_family",
      "familyEpds": ["…"],       // canonical sorted; size bounded
      "maxPly": 12
    },
    "response": {
      "replyUci": "…",           // Black reply at decision ply
      "replySource": "pinned-shared-Y-or-frozen-rule"
    },
    "coverageCost": 1,           // ∈ {1,2,3}; frozen with unit
    "contractVersion": 2
  }
}
```

Display payload (title, SAN sketch, notes) is **non-identity** and must not change `unitId`.

### 3.3 Matching semantics

| Predicate | Definition |
|---|---|
| Game eligible for unit | Subject plays **Black** vs same `opponentKey` |
| Match | Opening of game enters matcher family (prefix / canonical EPD set) at ply ≤ `maxPly` |
| Contribution | **At most one** contribution per game per unit |
| Freeze | Matcher + `coverageCost` + `unitId` frozen on TRAIN before any future scan |

### 3.4 Slot budget and coverageCost

Problem: a broad matcher can monopolize coverage per “slot.”

**Frozen solution:**

```text
PACKAGE_SLOT_BUDGET = 12
coverageCost ∈ {1, 2, 3}     // fixed at unit freeze; never recomputed on future data
sum_i coverageCost_i ≤ 12    // exact fill preferred; honest underfill only if protocol allows vacant
effectiveSlotUse = coverageCost
```

| Cost | Allowed matcher breadth (frozen caps) |
|---|---|
| **1** | Narrow: ≤ 4 family EPDs **or** exact ≤ 6-ply sequence, no wildcards |
| **2** | Medium: ≤ 8 family EPDs **or** one bounded wildcard ply |
| **3** | Broad: ≤ 12 family EPDs **or** ≤ 2 wildcards — **hard max** |

Rules:

- Cost must be **monotone non-decreasing** in matcher breadth (G4).
- Malformed / over-broad matchers → fail closed (`STOP_COST_GAMING` or unit rejection).
- A cost-3 unit consumes three of twelve budget units.
- Primary package accounting metric (diagnostic / later eval only):

\[
U = \frac{\#\{\text{games with }\ge 1\text{ unit contribution}\}}{\sum_i \mathrm{coverageCost}_i}
\]

Slot-normalized comparisons to a 12-atom exact baseline are allowed **only** under matched budget 12; grain still differs — never mix into exact-atom v1 tables.

### 3.5 Package construction (TRAIN only)

Per subject playing Black, using **only** chronologically prior TRAIN games:

1. Enumerate repeat `opponentKey` values with sufficient White-as-opponent history (G2).
2. For each key, build recurring opening families from that opponent’s White TRAIN states only.
3. Emit conditional Black response rules; assign frozen `coverageCost`.
4. Rank deterministically (see §5 tie-breaks); pack until budget 12 without exceeding caps.
5. No peer sharing, no outcomes, no engine novelty ranking as primary score, no global opponent pooling, no cross-subject contamination.

---

## 4. Strict TRAIN chronology (no-lookahead)

1. Order games by `(createdAtMs || datestamp, String(gameId))` ascending.
2. At cutoff index / timestamp \(t\): **TRAIN** = games **strictly before** \(t\).
3. Families, replies, costs, and package contents are functions of TRAIN only.
4. Nested prequential folds (§6 G6) use later **TRAIN** games as labels only — **not** CAL, **not** TEST.
5. Forbidden under this protocol:
   - Reading CAL or TEST game bodies, outcomes, or sealed TEST IDs for algorithm input
   - Using post-\(t\) moves of opponent \(O\) to choose family \(F\) or reply \(r\)
   - Network fetch to “repair” identity or fill packages
6. Any detected leakage → **`INVALID`** (custody), not a scientific kill.

---

## 5. Deterministic ranking and frozen thresholds

### 5.1 Unit ranking (TRAIN diagnostics; fixed before run)

Primary sort keys (descending unless noted):

1. Distinct TRAIN games supporting the family (multi-game recurrence)
2. Distinct `dayKey` span supporting the family
3. Inverse breadth (prefer lower `coverageCost` when scores tie)
4. Lexicographic `unitId` ascending

No data-dependent repair branch after seeing gate failures.

### 5.2 Frozen numeric pins (do not tune on evaluation data)

```text
c1_identity_coverage_min     = 0.85
n_o_min_opponent_keys        = 1          # single-subject scout; raise only under new protocol
g_min_white_games_per_key    = 30
d_min_distinct_days_per_key  = 10
J_max_v2_path_jaccard        = 0.50
p_min_prequential_hit        = 0.10
p_max_prequential_hit        = 0.90
PACKAGE_SLOT_BUDGET          = 12
coverageCost                 ∈ {1, 2, 3}
max_family_epds_cost_3       = 12
max_ply                      = 12
```

---

## 6. Structural and prequential gates (no CAL/TEST)

All gates consume **local raw + TRAIN-only** material. Ordered fail-closed.

| Gate | Name | Pass criterion | Fail verdict |
|---|---|---|---|
| **G0** | Schema availability / custody | Dual-parse local raw/capped yields usable identity share; raw+capped hashes; receipt self-hash | **`STOP_SCHEMA_UNAVAILABLE`** |
| **G1** | Identity coverage | ≥ `c1` of eligible games have non-null key with `identityConfidence` ≠ `none` as required; anonymous/AI tallied separately | `STOP_IDENTITY_SPARSE` |
| **G2** | Longitudinal opponent recurrence | ≥ `n_o` opponent keys with ≥ `g_min` White games spanning ≥ `d_min` distinct days | `STOP_NO_LONGITUDINAL_RECURRENCE` |
| **G3** | Package fill | Emit package with \(\sum\) `coverageCost` = 12 (or honest documented underfill policy) and ≥ 1 valid unit | `STOP_PACKAGE_EMPTY` |
| **G4** | Unit breadth / cost | All costs ∈ {1,2,3}; family size caps; cost monotone in breadth; no free broad coverage | `STOP_COST_GAMING` |
| **G5** | Divergence from v2 | Path Jaccard with v2 top plans ≤ `J_max` **or** ≥ *k* units outside v2 terminal set (read-only v2 on same TRAIN) | `STOP_NOT_DISTINCT_FROM_V2` |
| **G6** | Prequential future-match (TRAIN only) | Nested TRAIN cutoffs; hit proxy ∈ [`p_min`, `p_max`] | `STOP_PREQUENTIAL_INFEASIBLE` |
| **G7** | Freeze receipt | Protocol/code/data hashes; `productAuthorization === false`; Module A untouched; Scout v2 default unchanged | `INVALID` |

### G0 detail (first executable work)

```text
inputs:  local raw NDJSON/PGN path(s) only
action:  hash → dual-parse → identity coverage probe → custody receipt
on fail: STOP_SCHEMA_UNAVAILABLE
         do not open CAL/TEST
         do not network-acquire
         do not invent opponent identities
```

### G6 detail (prequential, still TRAIN-only)

- Cutoffs inside TRAIN chronology only (e.g. after 40%, 50%, 60%, 70%, 80% of ordered TRAIN, deduped).
- Fit = games before cut; label window = later TRAIN games only.
- Hit = label game matches ≥ 1 frozen unit from fit (one contribution per unit per game).
- Panel / subject aggregate must land in `[0.10, 0.90]` to avoid trivial zero or saturated one.
- **Not** a TEST estimand; not preparation-utility confirmation.

### Terminal gate verdicts (exact strings)

```text
READY_FOR_GATES
STOP_SCHEMA_UNAVAILABLE
STOP_IDENTITY_SPARSE
STOP_NO_LONGITUDINAL_RECURRENCE
STOP_PACKAGE_EMPTY
STOP_COST_GAMING
STOP_NOT_DISTINCT_FROM_V2
STOP_PREQUENTIAL_INFEASIBLE
GATES_PASSED_EVAL_NOT_RUN
INVALID
```

Scientific three-way (`KILLED` / `CONFIRMED_RESEARCH_ONLY` / `INCONCLUSIVE`) is **out of scope** for this protocol identity. Custody/harness failures must not be laundered into scientific kills.

---

## 7. Explicit prohibitions (this identity)

| Prohibited | Rationale |
|---|---|
| CAL game content / outcomes as algorithm input | `calAllowed: false` |
| TEST game content / outcomes / sealed open | `testAllowed: false` |
| Network acquisition / top-up | `networkEnabled: false` |
| Product ship / default Scout swap | `productAuthorization: false`, `preserve-v2` |
| Module A reopen or exact-atom metric mutation | `CLOSED_NOT_REOPENED` |
| Inventing opponent ids when schema missing | G0 → `STOP_SCHEMA_UNAVAILABLE` |
| Cross-subject contamination / global opponent pool | unit identity is per-key |
| Retuning thresholds after seeing gate outcomes under same identity | freeze-before-run |
| Reusing burned Module A / SHPFA / robust-y labeled futures as confirmation | claim boundary |
| Emitting raw usernames in reports | privacy |

---

## 8. Later untouched evaluation (define only — do not execute)

After `GATES_PASSED_EVAL_NOT_RUN`, any confirmatory work requires a **new** protocol identity and preregistration. Sketch only:

1. Fresh holdout not on Module A burned sets, not on already-labeled robust-y futures.
2. Arms: 12-budget exact/v2 baseline vs ORCBR-B1 preparation-unit-v2 package.
3. Primary: slot-normalized coverage \(U\) on held-out Black-vs-`opponentKey` games.
4. Secondary: reply soundness of pinned-Y; hierarchical bootstrap by `opponentKey`.
5. Product remains `preserve-v2`; research confirmation never upgrades authorization.

**This protocol must not open that stage.**

---

## 9. Implementation plan — files, CLI, tests, receipts

### 9.1 Planned layout (research-only)

```text
docs/scout-orcbr-b1-protocol.md              # this frozen protocol (normative)

research/scout-orcbr-b1/
  orcbr-b1.protocol.json                     # machine pins (snapshot of §0–§6)
  orcbr-b1-schema.js                         # dual-parse, HMAC pseudonym keys, chronology
  orcbr-b1-units.js                          # preparation-unit-v2, coverageCost, match
  orcbr-b1-generate.js                       # TRAIN-only package builder (budget 12)
  orcbr-b1-gates.js                          # G0–G7
  orcbr-b1-schema.test.js
  orcbr-b1-units.test.js
  orcbr-b1-generate.test.js
  orcbr-b1-gates.test.js

scripts/scout-orcbr-b1.mjs                   # CLI entry (freeze / g0 / gates / package / status / verify)

tmp/scout-orcbr-b1/                          # study root (gitignored)
  protocol.snapshot.json
  custody/raw.sha256
  custody/capped.sha256
  custody/parse-receipt.json
  gates/g0.json … g7.json
  train/package.json
  train/units/*.json
  report.json                                # reportSha256 last
```

Production `web-src/scout.js` parse shape for UI remains v1 unless a separate product RFC.
Research parse is additive: `parseGameBlockResearch` / dual-parse helpers only.

### 9.2 CLI plan

```text
node scripts/scout-orcbr-b1.mjs freeze
node scripts/scout-orcbr-b1.mjs g0 --raw <local.ndjson> [--capped <path>]
node scripts/scout-orcbr-b1.mjs gates --through g7
node scripts/scout-orcbr-b1.mjs package --train-only
node scripts/scout-orcbr-b1.mjs status
node scripts/scout-orcbr-b1.mjs verify
```

| Command | Behavior |
|---|---|
| `freeze` | Snapshot protocol JSON + pins; refuse if already frozen with different bytes |
| `g0` | Dual-parse custody; emit G0 receipt or `STOP_SCHEMA_UNAVAILABLE` |
| `gates` | Run G1–G7 in order; stop at first fail-closed verdict |
| `package` | TRAIN-only package under budget 12; refuse if CAL/TEST paths supplied |
| `status` | Print latest verdict + product flags (`false` / `preserve-v2`) |
| `verify` | Rehash artifacts; reject tamper / productAuthorization true |

CLI must refuse `--cal`, `--test`, network flags, and any path that would mutate production Scout defaults.

### 9.3 Required tests

| Suite | Assertions |
|---|---|
| Identity / pseudonym | id present; name-only weak; anonymous/AI null; salt rotation invalidates; **no raw leakage** in reports |
| Legacy compatibility | Production parse shape unchanged without research option |
| Chronology | Sort by `createdAtMs`/`datestamp`+`gameId`; no-lookahead: freeze at \(t\) ignores post-\(t\) |
| Unit contract | `preparation-unit-v2` validation; cost ∈ {1,2,3}; sum ≤ 12; breadth caps; malformed fail-closed |
| Package determinism | Stable ties; identical TRAIN → identical package hash |
| Contamination | Units never bind foreign `opponentKey`; no cross-subject state mix |
| Outcomes blind | Outcome/result/winner fields ignored if present; stripping enforced |
| Gates | G0 fail → `STOP_SCHEMA_UNAVAILABLE`; each stop string exact; all-subject fail-closed policy |
| Product invariants | `productAuthorization === false`; `productVerdict === "preserve-v2"`; tamper → `INVALID` |
| Receipts | Self-hashes; protocol bind; final report last |
| CLI smoke | freeze → g0 on fixture → status (offline fixtures only) |

### 9.4 Receipts and hashing

- Every written artifact: SHA-256 of raw file bytes.
- Reports: canonical pretty JSON (2-space); `reportSha256` omitted from hash input (robust-y convention).
- Protocol snapshot at freeze; subsequent runs bind to snapshot hash.
- Gate receipts chain: each binds prior gate receipt hash.
- Final report written **last**.

### 9.5 Registering the candidate

Register `orcbr-b1` only if the candidate registry allows a **design / structural** status without implying scientific admission or product readiness. Default posture:

```text
status: structural-protocol-frozen
admission: not-run
productAuthorization: false
```

---

## 10. Hostile risks (frozen mitigations)

| Risk | Mitigation under this protocol |
|---|---|
| Missing opponent IDs in sealed dumps | G0 local dual-parse only → `STOP_SCHEMA_UNAVAILABLE` |
| Renamed display names | Prefer `user.id`; weak name-lower penalized in G1 |
| Privacy leakage | Pseudonyms only in artifacts; no raw names in reports |
| Sparse repeat opponents | G2 longitudinal floors |
| Broad matcher gaming | Fixed `coverageCost` + family caps + G4 |
| Cross-subject contamination | Per-`opponentKey` unit identity |
| Product leakage | `productAuthorization: false`; research CLI only; preserve-v2 |
| Old holdout reuse | Explicit forbid list; later eval needs new protocol |

---

## 11. Operator checklist (scan-friendly)

- [ ] Protocol identity `scout-orcbr-b1-v1` / `orcbr-b1` not reused after material amendment
- [ ] `productAuthorization: false`, `productVerdict: preserve-v2`
- [ ] `unitContract: preparation-unit-v2`, budget **12**, `coverageCost` ∈ {1,2,3}
- [ ] Local raw only for G0; no network
- [ ] No CAL/TEST paths in package or gate inputs
- [ ] Strict TRAIN chronology; nested prequential labels stay inside TRAIN
- [ ] G0 failure stops with **`STOP_SCHEMA_UNAVAILABLE`**
- [ ] Gates G1–G7 fail-closed with exact verdict strings
- [ ] Tests cover identity, cost, chronology, contamination, product flags, receipts
- [ ] CLI freeze / g0 / gates / status / verify offline
- [ ] Later evaluation **not** executed under this identity

---

## 12. Document control

| Item | Value |
|---|---|
| Normative protocol path | `docs/scout-orcbr-b1-protocol.md` |
| Machine companion (planned) | `research/scout-orcbr-b1/orcbr-b1.protocol.json` |
| Supersession | Any change → new `protocolId` / version; do not edit sealed snapshots in place |
| Architecture lineage | Module B Black opponent-repertoire design (READY_FOR_IMPLEMENTATION); this file freezes the executable research contract |

**First command after implementation lands:**

```bash
node scripts/scout-orcbr-b1.mjs g0 --raw <local-raw.ndjson>
```

If identity cannot be recovered from local bytes: stop with `STOP_SCHEMA_UNAVAILABLE`.
Product remains Scout v2. `productAuthorization` remains false.
